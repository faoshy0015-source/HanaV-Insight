"""Read-only, dynamic domestic equity ETF theme pulse shared by both HanaV screens.

Universe is the ETF Finder theme taxonomy plus any additional themes stored in
the ETF theme-map DB; it is not a claim to cover all KRX listed industries.
Quotes are never estimated or replaced by zero when missing.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo
import os
import re
import sqlite3
import tempfile

import pandas as pd
import requests
import streamlit as st

ROOT = Path(__file__).resolve().parent
DB_FILE = ROOT / "data" / "etf_finder.db"
BASE_THEMES = (
    "반도체", "2차전지", "AI", "로봇", "자동차·모빌리티",
    "전력·전기기기", "원전·에너지", "방산·우주항공",
    "조선·해운", "바이오·헬스케어", "인터넷·플랫폼",
    "게임·콘텐츠", "금융", "소비재", "건설·인프라",
    "산업재·기계", "화학·소재", "운송·물류",
    "농업·식품", "친환경·ESG", "국내 대표지수",
    "배당·가치", "중소형·스타일",
    # Sector slices from the former ETF heatmap are retained alongside all parent themes.
    "전력기기", "방산", "조선", "자동차", "인터넷", "게임",
    "바이오", "금융·은행", "화장품",
)
# Same broad vocabulary used by ETF Finder, with keywords only as a fallback
# when the database's separate theme_map has not been built.
KEYWORDS = {
    "반도체": ("반도체", "HBM", "파운드리", "메모리"),
    "2차전지": ("2차전지", "배터리", "이차전지"),
    "AI": ("인공지능", "AI", "데이터센터"),
    "로봇": ("로봇", "휴머노이드"),
    "자동차·모빌리티": ("자동차", "모빌리티", "자율주행", "전기차"),
    "전력·전기기기": ("전력", "변압기", "그리드", "전선"),
    "원전·에너지": ("원전", "원자력", "우라늄", "신재생", "태양광", "풍력", "수소"),
    "방산·우주항공": ("방산", "방위산업", "우주항공", "우주", "K방산"),
    "조선·해운": ("조선", "해운", "LNG선"),
    "바이오·헬스케어": ("바이오", "헬스케어", "제약", "의료기기"),
    "인터넷·플랫폼": ("인터넷", "플랫폼", "이커머스"),
    "게임·콘텐츠": ("게임", "엔터", "콘텐츠", "KPOP", "K-POP", "웹툰"),
    "금융": ("금융", "은행", "증권", "보험"),
    "소비재": ("화장품", "K뷰티", "K-뷰티", "소비재", "음식료", "의류", "유통", "면세", "여행"),
    "건설·인프라": ("건설", "인프라", "시멘트"),
    "산업재·기계": ("산업재", "기계", "스마트팩토리", "자동화"),
    "화학·소재": ("화학", "소재", "철강", "희토류"),
    "운송·물류": ("운송", "물류", "항공", "철도"),
    "농업·식품": ("농업", "농산물", "식품", "사료", "비료"),
    "친환경·ESG": ("ESG", "친환경", "탄소중립", "클린"),
    "국내 대표지수": ("코스피", "코스닥", "KRX300"),
    "배당·가치": ("배당", "가치주", "밸류업"),
    "중소형·스타일": ("중소형", "모멘텀", "퀄리티", "성장주"),
    "전력기기": ("전력기기", "변압기", "전력설비"),
    "방산": ("방산", "방위산업", "K방산"),
    "조선": ("조선", "조선기자재"),
    "자동차": ("자동차", "완성차", "모빌리티"),
    "인터넷": ("인터넷", "플랫폼"),
    "게임": ("게임", "e스포츠"),
    "바이오": ("바이오", "헬스케어"),
    "금융·은행": ("금융", "은행"),
    "화장품": ("화장품", "K뷰티", "K-뷰티"),
}
EXCLUDED = re.compile(r"인버스|레버리지|커버드콜|2X|3X|선물|채권|단기채|금리|머니마켓", re.I)
FOREIGN = re.compile(r"미국|차이나|중국|일본|인도|베트남|유럽|나스닥|NASDAQ|S&P500|글로벌|월드|해외|독일|대만|홍콩|러셀", re.I)
QUOTE_URL = "https://polling.finance.naver.com/api/realtime"
QUOTE_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/",
                 "Accept": "application/json, text/plain, */*"}


def _setting(name, default=""):
    try:
        val = st.secrets.get(name)
        if isinstance(val, str) and val.strip():
            return val.strip()
    except Exception:
        pass
    return str(os.environ.get(name, default) or default).strip()


@st.cache_data(ttl=900, show_spinner=False)
def _cloud_sqlite():
    """Read authenticated snapshot only; never write or override live ETF DB."""
    endpoint = _setting("SUPABASE_URL").rstrip("/")
    key = _setting("SUPABASE_SERVICE_ROLE_KEY")
    bucket = _setting("SUPABASE_BUCKET", "hanav-finder-db")
    if not (endpoint.startswith("https://") and endpoint.endswith(".supabase.co")
            and key and bucket and "/" not in bucket):
        return b""
    path = quote(bucket, safe="") + "/etf/etf_finder.db"
    url = endpoint + "/storage/v1/object/authenticated/" + path
    try:
        r = requests.get(url, headers={"apikey": key, "Authorization": "Bearer " + key},
                         timeout=(5, 35))
        if r.status_code == 200 and r.content.startswith(b"SQLite format 3\\x00".decode("unicode_escape").encode("latin1")):
            return r.content
    except requests.RequestException:
        pass
    return b""


@st.cache_data(ttl=600, show_spinner=False)
def load_theme_catalog(_db_mtime):
    """Return ETF-theme membership from DB; remote snapshot used on cold boot."""
    frames = []
    from_where = ""
    if DB_FILE.is_file():
        from_where = "로컬 ETF DB"
        db_path = str(DB_FILE)
    else:
        raw = _cloud_sqlite()
        if not raw:
            return pd.DataFrame(), "ETF DB를 불러올 수 없음"
        from_where = "Supabase ETF DB 백업"
        tmp = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        try:
            tmp.write(raw)
            tmp.close()
            db_path = tmp.name
            frames = _read_db_tables(db_path)
        except (sqlite3.Error, ValueError, OSError):
            frames = []
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
        return _catalog_from_tables(frames), from_where

    try:
        frames = _read_db_tables(db_path)
    except (sqlite3.Error, ValueError, OSError):
        return pd.DataFrame(), "ETF DB 읽기 실패"
    return _catalog_from_tables(frames), from_where


def _read_db_tables(db_path):
    with sqlite3.connect("file:" + quote(str(db_path), safe="/") + "?mode=ro", uri=True, timeout=10) as c:
        tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "etf_master" not in tables:
            return []
        master = pd.read_sql_query(
            "SELECT etf_code, etf_name, asset_region, asset_class, sector, aum, turnover FROM etf_master", c
        )
        theme_map = pd.DataFrame()
        if "etf_theme_map" in tables:
            theme_map = pd.read_sql_query(
                "SELECT DISTINCT etf_code, sector FROM etf_theme_map "
                "WHERE region='국내자산' AND asset_class='주식' AND subsector='전체'", c
            )
        return [master, theme_map]


def _catalog_from_tables(frames):
    columns = ["업종", "티커", "대표 ETF", "규모"]
    if not frames:
        return pd.DataFrame(columns=columns)
    master, theme_map = frames
    if master.empty:
        return pd.DataFrame(columns=columns)
    m = master.copy()
    m["etf_code"] = m["etf_code"].astype(str).str.strip().str.zfill(6)
    m = m[m["etf_code"].str.fullmatch(r"\d{6}")].drop_duplicates("etf_code")
    m["etf_name"] = m["etf_name"].fillna("").astype(str)
    m = m[(m["etf_name"] != "") & ~m["etf_name"].str.contains(EXCLUDED)]
    m["규모"] = pd.to_numeric(m["aum"], errors="coerce").fillna(0.0).clip(lower=0)
    m["규모"] += pd.to_numeric(m["turnover"], errors="coerce").fillna(0.0).clip(lower=0) * .01
    # Theme-map is the authoritative region filter when available.
    if not theme_map.empty:
        theme_map = theme_map.copy()
        theme_map["etf_code"] = theme_map["etf_code"].astype(str).str.zfill(6)
        merged = theme_map.merge(m, on="etf_code", how="inner", suffixes=("_theme", ""))
        found = merged.rename(columns={"sector_theme": "업종", "etf_code": "티커",
                                       "etf_name": "대표 ETF"})
        if "업종" not in found and "sector" in found:
            found["업종"] = found["sector"]
        found = found[["업종", "티커", "대표 ETF", "규모"]].copy()
    else:
        # No map generated: inspect every ETF name instead of assuming the old 12 names.
        # Exclude clearly overseas-facing ETFs to avoid mixing foreign returns.
        domestic = m[~m["etf_name"].str.contains(FOREIGN)].copy()
        mapping = []
        for row in domestic.itertuples(index=False):
            for theme, words in KEYWORDS.items():
                if any(word.casefold() in row.etf_name.casefold() for word in words):
                    mapping.append({"업종": theme, "티커": row.etf_code,
                                    "대표 ETF": row.etf_name, "규모": row.규모})
        found = pd.DataFrame(mapping, columns=columns)
    # Add name-matched subthemes even when the DB contains only parent theme rows.
    # This prevents cosmetics (a subtheme of consumer goods) from disappearing.
    domestic = m[~m["etf_name"].str.contains(FOREIGN)].copy()
    special = []
    for row in domestic.itertuples(index=False):
        for theme, words in KEYWORDS.items():
            if any(word.casefold() in row.etf_name.casefold() for word in words):
                special.append({"업종": theme, "티커": row.etf_code,
                                "대표 ETF": row.etf_name, "규모": row.규모})
    if special:
        found = pd.concat([found, pd.DataFrame(special)], ignore_index=True)
    if found.empty:
        return pd.DataFrame(columns=columns)
    found = found.dropna(subset=["업종", "티커"]).copy()
    found["업종"] = found["업종"].astype(str).str.strip()
    found = found[found["업종"] != ""]
    found["티커"] = found["티커"].astype(str).str.zfill(6)
    return found.sort_values(["업종", "규모"], ascending=[True, False]).drop_duplicates(["업종", "티커"])


def _quote_batch(codes):
    try:
        r = requests.get(QUOTE_URL, params={"query": "SERVICE_ITEM:" + ",".join(codes)},
                         headers=QUOTE_HEADERS, timeout=(3, 7))
        r.raise_for_status()
        found = {}
        for area in r.json().get("result", {}).get("areas", []):
            for row in area.get("datas", []):
                if isinstance(row, dict) and row.get("cd"):
                    ticker = str(row["cd"]).strip().zfill(6)
                    if ticker in codes:
                        found[ticker] = row
        return found
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return {}


@st.cache_data(ttl=120, show_spinner=False)
def _prices(codes):
    # Bounded parallel requests; no single theme can monopolize requests.
    codes = list(dict.fromkeys(codes))
    details = {}
    batches = [codes[i:i+8] for i in range(0, len(codes), 8)]
    with ThreadPoolExecutor(max_workers=7) as pool:
        for part in pool.map(_quote_batch, batches):
            details.update(part)
    missing = [c for c in codes if c not in details]
    if missing:
        with ThreadPoolExecutor(max_workers=7) as pool:
            for code, q in zip(missing, pool.map(_quote_batch, [[c] for c in missing])):
                if code in q:
                    details[code] = q[code]
    results = []
    for code, q in details.items():
        try:
            price = float(str(q.get("nv", "")).replace(",", ""))
            change = float(str(q.get("cr", "")).replace(",", ""))
            if price <= 0 or abs(change) > 100:
                continue
            sign = str(q.get("rf", ""))
            if sign in ("4", "5"):
                change = -abs(change)
            elif sign in ("1", "2"):
                change = abs(change)
            else:
                continue  # Do not infer direction from an ambiguous quote.
            results.append({"티커": code, "현재가(원)": price, "등락률(%)": round(change, 2)})
        except (TypeError, ValueError):
            continue
    return pd.DataFrame(results, columns=["티커", "현재가(원)", "등락률(%)"])


def get_domestic_sector_pulse():
    """Summary includes all registered themes, including no-match/no-quote themes."""
    try:
        token = DB_FILE.stat().st_mtime_ns
    except OSError:
        token = 0
    catalog, catalog_origin = load_theme_catalog(token)
    detected = set(catalog["업종"]) if not catalog.empty else set()
    theme_names = list(dict.fromkeys([*BASE_THEMES, *sorted(detected)]))
    registered = pd.DataFrame({"업종": theme_names})
    if catalog.empty:
        registered["ETF수"] = 0
        registered["시세확인 ETF"] = 0
        registered["등락률(%)"] = float("nan")
        registered["상태"] = "분류·시세 미확인"
        return {"summary": registered, "instruments": pd.DataFrame(),
                "source": catalog_origin, "error": "ETF 분류 DB에 접근할 수 없거나 매핑된 ETF가 없습니다.",
                "requested": 0, "retrieved": 0}
    # Top 12 per theme by observable DB scale; every theme is included.
    chosen = catalog.groupby("업종", group_keys=False, sort=False).head(12)
    codes = tuple(dict.fromkeys(chosen["티커"].astype(str).tolist()))
    quote_rows = _prices(codes)
    if quote_rows.empty:
        merged = chosen.copy()
        merged["등락률(%)"] = float("nan")
        merged["현재가(원)"] = float("nan")
    else:
        merged = chosen.merge(quote_rows, on="티커", how="left")
    counts = (merged.groupby("업종", as_index=False)
              .agg(ETF수=("티커", "nunique"),
                   **{"시세확인 ETF": ("등락률(%)", "count"),
                      "등락률(%)": ("등락률(%)", "mean")}))
    summary = registered.merge(counts, on="업종", how="left")
    summary["ETF수"] = summary["ETF수"].fillna(0).astype(int)
    summary["시세확인 ETF"] = summary["시세확인 ETF"].fillna(0).astype(int)
    summary["등락률(%)"] = summary["등락률(%)"].round(2)
    summary["상태"] = summary.apply(
        lambda r: "ETF 없음" if not r["ETF수"] else (
            "시세 미확인" if not r["시세확인 ETF"] else (
                "일부 확인" if r["시세확인 ETF"] < r["ETF수"] else "확인"
            )
        ), axis=1
    )
    return {"summary": summary, "instruments": merged,
            "source": catalog_origin + " · 네이버 금융 공개 시세(지연 가능)",
            "error": "", "requested": len(codes),
            "retrieved": len(quote_rows)}
