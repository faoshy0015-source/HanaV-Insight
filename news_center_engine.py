"""HanaV News Center v2.1: headline reader, official disclosures, opt-in alerts."""
import calendar
import hashlib
import html
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from urllib.parse import urlparse

import feedparser
import requests

KST = timezone(timedelta(hours=9))
MEDIA = [
    ("매일경제 증권", "https://www.mk.co.kr/rss/50200011/", "증권"),
    ("매일경제 경제", "https://www.mk.co.kr/rss/30100041/", "경제·정책"),
    ("매일경제 국제", "https://www.mk.co.kr/rss/30300018/", "해외증시"),
    ("한국경제 증권", "https://www.hankyung.com/feed/finance", "증권"),
    ("한국경제 경제", "https://www.hankyung.com/feed/economy", "경제·정책"),
    ("한국경제 IT", "https://www.hankyung.com/feed/it", "산업·테마"),
    ("한국경제 국제", "https://www.hankyung.com/feed/international", "해외증시"),
]
OFFICIAL = [
    ("한국은행 통화정책", "https://www.bok.or.kr/portal/bbs/P0000559/news.rss?", "경제·정책"),
    ("한국은행 경제통계", "https://www.bok.or.kr/portal/bbs/B0000501/news.rss?", "경제·정책"),
    ("금융위원회", "https://www.fsc.go.kr/about/fsc_bbs_rss/?fid=0111", "경제·정책"),
    ("미 연준", "https://www.federalreserve.gov/feeds/press_all.xml", "해외증시"),
]
THEMES = {
    "반도체": ("반도체","hbm","dram","낸드","삼성전자","sk하이닉스","엔비디아","nvidia","마이크론"),
    "로봇": ("로봇","휴머노이드","레인보우로보틱스","두산로보틱스"),
    "2차전지": ("2차전지","이차전지","배터리","양극재","음극재","전고체","에코프로","lg에너지솔루션"),
    "바이오": ("바이오","제약","임상","기술수출","신약","셀트리온","삼성바이오로직스"),
    "조선": ("조선","선박","lng선","한화오션","hd현대중공업"),
    "방산": ("방산","방위산업","미사일","한화에어로스페이스","현대로템","l ig넥스원","lig넥스원"),
    "전력·원전": ("원전","전력망","변압기","전력기기","원자력","두산에너빌리티","효성중공업"),
    "자동차": ("자동차","현대차","기아","자율주행","전기차","테슬라"),
    "화장품": ("화장품","뷰티","아모레퍼시픽","코스맥스","한국콜마"),
    "AI·SW": ("인공지능","챗gpt","클라우드","데이터센터","소프트웨어","ai "," ai","openai"),
    "금융": ("은행","증권사","보험","금융지주","금융위원회"),
    "건설": ("건설","부동산","주택","시멘트"),
    "철강·화학": ("철강","석유화학","정유","포스코","석유"),
    "인터넷·게임": ("게임","네이버","카카오","크래프톤"),
    "거시경제": ("기준금리","fomc","금리","환율","관세","물가","연준","federal reserve","interest rate"),
}
EVENTS = {
    "속보": (4, ("[속보]","[긴급]","긴급속보")),
    "계약·수주": (4, ("단일판매","공급계약","수주","공급 계약")),
    "주주환원": (4, ("특별배당","자기주식소각","자사주 소각","자사주소각","주식소각","자기주식취득")),
    "실적": (3, ("잠정실적","영업(잠정)실적","어닝서프라이즈","실적 발표","매출액또는손익구조")),
    "바이오 이벤트": (4, ("기술수출","임상 3상","임상3상","품목허가","fda 승인")),
    "자본·M&A": (4, ("유상증자","전환사채","신주인수권","합병","공개매수","영업양수","인수합병")),
    "리스크": (5, ("거래정지","상장폐지","횡령","배임","부도","회생절차","감사의견")),
    "정책·거시": (3, ("기준금리","통화정책방향","fomc","관세","interest rate","monetary policy")),
}
WATCH = {"삼성전자":"005930","SK하이닉스":"000660","현대차":"005380","기아":"000270",
         "한화오션":"042660","한화에어로스페이스":"012450","현대로템":"064350","두산로보틱스":"454910",
         "레인보우로보틱스":"277810","LG에너지솔루션":"373220","에코프로":"086520",
         "셀트리온":"068270","삼성바이오로직스":"207940","코스맥스":"192820",
         "한국콜마":"161890","아모레퍼시픽":"090430","두산에너빌리티":"034020","NAVER":"035420",
         "카카오":"035720","크래프톤":"259960"}
def now():
    return datetime.now(KST)

def clean(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", str(value or "")))).strip()

def safe_link(url):
    try:
        p=urlparse(str(url))
        return str(url) if p.scheme in ("https","http") and p.netloc and not p.username and not p.password else ""
    except ValueError:
        return ""

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]

def norm(value):
    return re.sub(r"[^0-9a-z가-힣]", "", re.sub(r"\[(속보|특징주|단독|공시)\]", "", value.lower()))

def classify(row):
    t=row["title"].lower()
    row["themes"]=[name for name, words in THEMES.items() if any(w.lower() in t for w in words)]
    events=[(name, weight) for name,(weight,words) in EVENTS.items() if any(w.lower() in t for w in words)]
    row["events"]=[name for name,_ in events]
    row["score"]=max((weight for _,weight in events),default=0)
    if row["kind"]=="공시" and "[정정]" in row["title"]:
        row["events"].append("정정")
    if row["kind"] not in ("공시","공식"):
        if "[속보]" in t or "[긴급]" in t: row["category"]="속보"
        elif "특징주" in t: row["category"]="특징주"
        elif any(w in t for w in ("목표주가","투자의견","증권사 리포트","목표가")): row["category"]="증권사 리포트"
        elif row["themes"] and row["category"]=="증권": row["category"]="산업·테마"
    return row

def item(title, link, source, category, kind, stamp=None, date="", name="", code=""):
    return classify(dict(id=digest(link or source+title+date), title=title, link=link,
        source=source, category=category, kind=kind, stamp=stamp, date=date,
        name=name, code=code, duplicates=1))

def feed_rows(source):
    name,url,category,kind=source
    try:
        response=requests.get(url,timeout=(4,9),headers={"User-Agent":"HanaV-Insight RSS reader/2.1"})
        response.raise_for_status()
        parsed=feedparser.parse(response.content)
        if not parsed.entries and not parsed.version:
            raise ValueError("invalid RSS")
        rows=[]
        for e in parsed.entries[:100]:
            title=clean(e.get("title"))
            link=safe_link(e.get("link"))
            if not title or not link: continue
            date_tuple=e.get("published_parsed") or e.get("updated_parsed")
            stamp=calendar.timegm(date_tuple) if date_tuple else None
            date=datetime.fromtimestamp(stamp,KST).strftime("%Y%m%d") if stamp is not None else ""
            rows.append(item(title,link,name,category,kind,stamp,date))
        return rows, (name, True, len(rows))
    except Exception:
        return [], (name, False, 0)

def dart_rows(key, days=3):
    if not key: return [],("OpenDART (키 미설정)",False,0)
    rows=[]
    try:
        for market in ("Y","K"):
            for page in range(1,6):
                res=requests.get("https://opendart.fss.or.kr/api/list.json",params={
                    "crtfc_key":key,"bgn_de":(now()-timedelta(days=days-1)).strftime("%Y%m%d"),
                    "end_de":now().strftime("%Y%m%d"),"corp_cls":market,"page_no":page,
                    "page_count":100,"sort":"date","sort_mth":"desc"},timeout=(4,10))
                res.raise_for_status()
                data=res.json()
                if data.get("status")=="013": break
                if data.get("status")!="000": raise ValueError("DART status")
                for d in data.get("list",[]):
                    no=str(d.get("rcept_no",""))
                    if not no.isdigit(): continue
                    name=clean(d.get("corp_name"))
                    report=clean(d.get("report_nm"))
                    rows.append(item(name+" · "+report,"https://dart.fss.or.kr/dsaf001/main.do?rcpNo="+no,
                        "OpenDART","공시","공시",date=str(d.get("rcept_dt","")),name=name,code=str(d.get("stock_code",""))))
                if page>=int(data.get("total_page",1)): break
        return rows,("OpenDART",True,len(rows))
    except Exception:
        return rows,("OpenDART (일부 조회 실패)",False,len(rows))

def sort_key(r):
    # Date-only filings are not given invented intraday timestamps.
    if r["stamp"] is not None: return r["stamp"]
    try: return datetime.strptime(r["date"],"%Y%m%d").replace(tzinfo=KST).timestamp()
    except ValueError: return 0

def dedup(rows):
    out=[]; seen=set(); recent={}
    for r in sorted(rows,key=sort_key,reverse=True):
        if r["id"] in seen: continue
        seen.add(r["id"])
        if r["kind"]!="공시":
            n=norm(r["title"])
            key=(r["kind"],r["date"])
            bucket=recent.setdefault(key,[])
            match=next((old for s,old in bucket if n==s or
                (min(len(n),len(s))>=18 and abs(len(n)-len(s))<=12 and SequenceMatcher(None,n,s,autojunk=False).ratio()>=.9)),None)
            if match is not None:
                match["duplicates"]+=1
                continue
            bucket.append((n,r))
        out.append(r)
    return out

def collect(key="", media=False, licensed="", days=3):
    sources=[(*s,"공식") for s in OFFICIAL]
    if media: sources += [(*s,"언론") for s in MEDIA]
    # Operator-supplied feeds only where classification and redistribution are permitted.
    try:
        extra=json.loads(licensed or "[]")
        for s in extra[:15]:
            if safe_link(s["url"]): sources.append((str(s["name"]),s["url"],str(s.get("category","증권")),"허가"))
    except (ValueError, TypeError, KeyError): pass
    rows=[]; status=[]
    with ThreadPoolExecutor(max_workers=10) as pool:
        jobs=[pool.submit(feed_rows,s) for s in sources]+[pool.submit(dart_rows,key,days)]
        for job in jobs:
            result, state=job.result(); rows+=result; status.append(state)
    cutoff=now()-timedelta(days=days)
    rows=[r for r in rows if not r["date"] or r["date"]>=cutoff.strftime("%Y%m%d")]
    return dedup(rows),status

def candidates(rows, minimum=4, watch="", minutes=90):
    current=now()
    words=[w.strip().lower() for w in watch.split(",") if w.strip()]
    out=[]
    for r in rows:
        # No media title redistribution. Official sources / explicitly licensed feeds only.
        if r["kind"] not in ("공시","공식","허가") or r["score"]<minimum: continue
        if r["stamp"] is None:
            if r["date"]!=current.strftime("%Y%m%d"): continue
        elif not (0<=current.timestamp()-r["stamp"]<=minutes*60): continue
        if words and not any(w in (r["title"]+" "+r["code"]).lower() for w in words): continue
        out.append(r)
    return sorted(out,key=lambda r:(r["score"],sort_key(r)),reverse=True)

def telegram(bot,chat,row):
    msg="🔔 HanaV 뉴스 시그널\n"+row["source"]+" | "+", ".join(row["events"])+"\n"+row["title"]+"\n"+row["link"]+"\n키워드 탐지 · 투자판단 전 원문 확인"
    try:
        response=requests.post("https://api.telegram.org/bot"+bot+"/sendMessage",
            json={"chat_id":chat,"text":msg[:3800],"link_preview_options":{"is_disabled":True}},timeout=10)
        return response.ok and response.json().get("ok") is True
    except Exception:
        return False

def run_worker():
    """One poll; first run sets baseline, subsequent polls send unseen alerts."""
    from pathlib import Path
    state=Path(os.environ.get("NEWS_STATE_FILE",".news-state.json"))
    bot=os.getenv("NEWS_TELEGRAM_BOT_TOKEN") or os.getenv("RADAR_TELEGRAM_BOT_TOKEN","")
    chat=os.getenv("NEWS_TELEGRAM_CHAT_ID") or os.getenv("RADAR_TELEGRAM_CHAT_ID","")
    if not bot or not chat:
        print("Telegram not configured"); return
    rows,status=collect(os.getenv("DART_API_KEY",""),False,os.getenv("NEWS_LICENSED_RSS_JSON",""))
    if not any(ok for _,ok,_ in status):
        raise SystemExit("All sources unavailable")
    eligible=candidates(rows,int(os.getenv("NEWS_MIN_SCORE","4")),os.getenv("NEWS_WATCH",""))
    try: seen=json.loads(state.read_text())
    except FileNotFoundError: seen=None
    except (ValueError,OSError): raise SystemExit("Invalid alert state")
    ts=time.time()
    if seen is None:
        seen={r["id"]:ts for r in eligible}
        print("Alert baseline initialized; no historical messages sent")
    else:
        seen={k:v for k,v in seen.items() if ts-v<7*86400}
        new=[r for r in eligible if r["id"] not in seen]
        failed=False
        for row in new[:5]:
            if telegram(bot,chat,row): seen[row["id"]]=ts
            else: failed=True
        print("Eligible:",len(eligible),"New:",len(new))
        if failed: print("At least one delivery failed; unsent IDs remain eligible")
    state.parent.mkdir(parents=True,exist_ok=True)
    temp=state.with_suffix(".tmp")
    temp.write_text(json.dumps(seen))
    temp.replace(state)

if __name__=="__main__":
    run_worker()
