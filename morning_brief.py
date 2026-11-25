"""Daily public-market briefing; no customer data or trading endpoints."""
import argparse
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET
import math
import requests
import yfinance as yf
import pandas_market_calendars as mcal
from PIL import Image, ImageDraw, ImageFont

KST = ZoneInfo("Asia/Seoul")
INDICES = {"^DJI":"다우", "^GSPC":"S&P 500", "^IXIC":"나스닥", "^SOX":"필라델피아 반도체", "^VIX":"VIX"}
MACRO = {"^TNX":"미 10년물 금리(%)", "DX-Y.NYB":"달러인덱스", "KRW=X":"달러/원", "CL=F":"WTI 선물($)"}
SECTORS = {"XLK":"기술", "XLF":"금융", "XLE":"에너지", "XLV":"헬스케어", "XLY":"경기소비재", "XLP":"필수소비재", "XLI":"산업재", "XLB":"소재", "XLU":"유틸리티", "XLRE":"부동산", "XLC":"커뮤니케이션"}
STOCKS = {"NVDA":"엔비디아", "MU":"마이크론", "AMD":"AMD", "AVGO":"브로드컴", "TSLA":"테슬라", "AAPL":"애플", "MSFT":"마이크로소프트", "GOOGL":"알파벳", "AMZN":"아마존", "META":"메타"}
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

def session(now):
    cal = mcal.get_calendar("NYSE")
    schedule = cal.schedule(start_date=now.date()-timedelta(days=14), end_date=now.date())
    ended = schedule[schedule["market_close"] <= now]
    if ended.empty:
        raise RuntimeError("미국 거래일 확인 실패")
    return ended.index[-1].date(), ended.iloc[-1]["market_close"].to_pydatetime()

def collect(day):
    names = {**INDICES, **MACRO, **SECTORS, **STOCKS}
    df = yf.download(list(names), start=day-timedelta(days=14), end=day+timedelta(days=1),
                     auto_adjust=False, progress=False, threads=False, timeout=15)
    if df.empty:
        raise RuntimeError("시장 데이터 조회 실패")
    closes = df["Close"]
    result = {}
    for ticker in names:
        try:
            series = closes[ticker].dropna()
            series = series[series.index.date <= day]
            if len(series)<2:
                continue
            date = series.index[-1].date()
            if ticker not in MACRO and date != day:
                continue
            current, prev = map(float, series.iloc[-2:][::-1])
            if not all(map(math.isfinite,(current,prev))) or prev<=0 or current<=0:
                continue
            result[ticker] = (current, (current/prev-1)*100, date, current-prev)
        except (KeyError, ValueError, TypeError, IndexError):
            continue
    if not all(t in result for t in ("^DJI","^GSPC","^IXIC")):
        raise RuntimeError("최신 미국 3대 지수 종가 미확인: 브리핑 발송 중단")
    return result

def headlines(now, close):
    if now-close > timedelta(hours=36):
        return []
    try:
        res = requests.get("https://news.google.com/rss/search", params={"q":"미국 증시 뉴욕증시 마감 when:1d", "hl":"ko","gl":"KR","ceid":"KR:ko"},timeout=12)
        res.raise_for_status()
        output=[]
        seen=set()
        for node in ET.fromstring(res.content).findall(".//item"):
            try:
                title = node.findtext("title","").strip()
                source = node.findtext("source","").strip()
                link = node.findtext("link","").strip()
                pub = parsedate_to_datetime(node.findtext("pubDate",""))
                if not title or not link.startswith("https://") or title in seen or not timedelta(0)<=now-pub<=timedelta(hours=24):
                    continue
                seen.add(title)
                output.append((title,source,link))
                if len(output)==3:
                    break
            except (ValueError,TypeError):
                continue
        return output
    except (requests.RequestException,ET.ParseError):
        return []

def lines_for(now, day, close, data, news):
    rows = []
    def section(title):
        rows.append(("section",title))
    def line(s):
        rows.append(("line",s))
    def quote(t,name,price=True):
        if t not in data:
            line(name+"  |  미확인")
            return
        value,change,date,diff=data[t]
        delta = f"{diff*100:+.1f}bp" if t=="^TNX" else f"{change:+.2f}%"
        suffix = f" ({date:%m/%d})" if t in MACRO else ""
        line(f"{name}  |  {value:,.2f}  {delta}{suffix}" if price else f"{name}  {delta}")
    section(f"미국 정규장 마감 | {day:%Y-%m-%d} (미국 현지)")
    if now-close>timedelta(hours=36):
        line("새 정규장 마감 없음 · 최근 거래일 자료")
    section("주요 지수")
    for t,n in INDICES.items():
        quote(t,n)
    section("금리 · 환율 · 원자재 (각 지표 관측일)")
    for t,n in MACRO.items():
        quote(t,n)
    ranked=sorted((t for t in SECTORS if t in data),key=lambda t:data[t][1],reverse=True)
    section("미국 업종 ETF 등락률 (확인된 업종 전체)")
    for t in ranked:
        rows.append(("bar",SECTORS[t],data[t][1]))
    missing=[n for t,n in SECTORS.items() if t not in data]
    if missing:
        line("미확인: "+", ".join(missing))
    section("주요 관심 종목")
    for t in sorted((t for t in STOCKS if t in data),key=lambda t:abs(data[t][1]),reverse=True)[:5]:
        quote(t,STOCKS[t])
    section("주요 보도 헤드라인 (원문 확인 필요)")
    if news:
        for title,source,_ in news:
            line(title)
    else:
        line("최신 뉴스 미확인 또는 휴장")
    section("국내 증시 체크 포인트 (조건부 관찰)")
    if "^SOX" in data:
        ch=data["^SOX"][1]
        line(f"반도체지수 {ch:+.2f}% → 국내 반도체 장초반 동조 여부 확인")
    if "CL=F" in data:
        line("WTI 변동 → 정유·화학·운송 업종 원가 민감도 점검")
    if "^TNX" in data:
        line("미 국채금리 변동 → 성장주 밸류에이션 및 외국인 수급 점검")
    if ranked:
        line("미 업종 상대강도: "+SECTORS[ranked[0]]+" 상위 / "+SECTORS[ranked[-1]]+" 하위")
    line("국내 개장 전 환율·선물·기업별 뉴스 재확인")
    return rows

def render(rows, path, now):
    font=lambda size: ImageFont.truetype(FONT,size)
    normal,small,head=font(28),font(22),font(34)
    scratch=ImageDraw.Draw(Image.new("RGB",(1,1)))
    def wrap(s,f,width=960):
        out=[]; current=""
        for char in s:
            if current and scratch.textlength(current+char,font=f)>width:
                out.append(current.rstrip()); current=char.lstrip()
            else:
                current+=char
        if current:
            out.append(current)
        return out or [""]
    layout=[]; height=155
    for row in rows:
        kind,s,*rest=row
        if kind=="section":
            height+=66; layout.append((kind,s,[],height-54))
        elif kind=="bar":
            height+=46; layout.append((kind,s,rest,height-42))
        else:
            wrapped=wrap(s,normal)
            layout.append((kind,wrapped,[],height)); height+=39*len(wrapped)+9
    img=Image.new("RGB",(1080,height+80),"#FFFFFF"); draw=ImageDraw.Draw(img)
    draw.rectangle((0,0,1080,135),fill="#102D4F")
    draw.text((48,22),"HanaV Morning Brief",font=font(46),fill="white")
    draw.text((50,84),now.strftime("%Y.%m.%d  %H:%M KST")+"  |  미국 증시 마감 브리핑",font=small,fill="#DCE8F2")
    max_pct=max([abs(x[2]) for x in rows if x[0]=="bar"]+[0.5])
    for kind,s,rest,y in layout:
        if kind=="section":
            draw.rounded_rectangle((40,y,1040,y+49),radius=10,fill="#EDF3F8")
            draw.text((55,y+5),s,font=head,fill="#102D4F")
        elif kind=="bar":
            v=rest[0]; color="#15803D" if v>=0 else "#C0392B"
            draw.text((55,y+3),s,font=normal,fill="#172B3A")
            draw.line((610,y+3,610,y+35),fill="#B7C2CD",width=2)
            size=round(280*abs(v)/max_pct)
            if size:
                x1,x2=(610,610+size) if v>=0 else (610-size,610)
                draw.rectangle((x1,y+8,x2,y+30),fill=color)
            draw.text((1020,y+3),f"{v:+.2f}%",anchor="ra",font=normal,fill=color)
        else:
            for i,part in enumerate(s):
                draw.text((55,y+39*i),part,font=normal,fill="#172B3A")
    draw.text((50,height+20),"출처: Yahoo Finance · NYSE 거래일 캘린더 · Google News RSS",font=small,fill="#526574")
    img.save(path)

def send(method, fields, photo=None):
    token=os.environ.get("RADAR_TELEGRAM_BOT_TOKEN","").strip()
    chat=os.environ.get("RADAR_TELEGRAM_CHAT_ID","").strip()
    if not token or not chat:
        raise RuntimeError("Telegram Secrets 미등록")
    try:
        res=requests.post("https://api.telegram.org/bot"+token+"/"+method,data={"chat_id":chat,**fields},files=photo,timeout=45)
        if not res.ok or not res.json().get("ok"):
            raise RuntimeError("Telegram 전송 실패 (HTTP "+str(res.status_code)+")")
    except (requests.RequestException,ValueError):
        raise RuntimeError("Telegram 전송 응답 오류") from None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--preview",action="store_true")
    args=ap.parse_args()
    now=datetime.now(KST)
    day,close=session(now)
    data=collect(day)
    news=headlines(now,close)
    rows=lines_for(now,day,close,data,news)
    path="morning_brief.png"
    render(rows,path,now)
    text="🇺🇸 HanaV Morning Brief\n"+"\n".join(
        ("\n■ "+r[1]) if r[0]=="section" else (f"{r[1]} {r[2]:+.2f}%" if r[0]=="bar" else r[1])
        for r in rows)
    text+="\n\n출처: Yahoo Finance / Google News RSS\n"+"\n".join(n[2] for n in news)
    if not args.preview:
        with open(path,"rb") as f:
            send("sendPhoto",{"caption":f"HanaV Morning Brief | 미국 {day:%Y-%m-%d} 정규장 마감"}, {"photo":("morning_brief.png",f,"image/png")})
        send("sendMessage",{"text":text[:3800],"disable_web_page_preview":"true"})
    print("Morning Brief generated"+(" (preview)" if args.preview else " and delivered"),flush=True)

if __name__=="__main__":
    main()
