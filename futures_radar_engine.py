"""Read-only futures monitoring, KIS REST + public headline candidates.
No order endpoints, no client data, no fabricated quotes.
"""
from __future__ import annotations
import os, re, math, time, json, hashlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from email.utils import parsedate_to_datetime
from statistics import median
from xml.etree import ElementTree as ET
import requests

KST = ZoneInfo("Asia/Seoul")
BASE = "https://openapi.koreainvestment.com:9443"
DEFAULT_NEWS = ("코스피 선물 외국인", "한국 증시 속보", "한국은행 금리 환율", "미국 증시 선물")
NEWS_TERMS = re.compile(r"긴급|속보|금리|환율|관세|제재|거래정지|실적|공시|수출|선물|외국인|프로그램|지정학|반도체|로봇|중앙은행|FOMC", re.I)

def now():
    return datetime.now(KST)

def num(x):
    try:
        n=float(str(x).replace(",",""))
        return n if math.isfinite(n) else None
    except (ValueError,TypeError):
        return None

def parse_contracts(value):
    result=[]
    for line in str(value or "").splitlines():
        if not line.strip(): continue
        parts=[x.strip() for x in line.split(",")]
        if len(parts)!=3 or parts[0] not in ("F","JF") or not re.fullmatch(r"[A-Za-z0-9]{5,12}",parts[1]) or not parts[2]:
            raise ValueError("각 줄을 F 또는 JF, 선물 단축코드, 표시명 형식으로 입력하세요.")
        key=(parts[0],parts[1].upper())
        if key not in [(a,b) for a,b,_ in result]:
            result.append((*key,parts[2][:70]))
    if len(result)>12: raise ValueError("최대 12개 계약을 등록할 수 있습니다.")
    return result

def token(key,secret):
    r=requests.post(BASE+"/oauth2/tokenP",json={"grant_type":"client_credentials","appkey":key,"appsecret":secret},timeout=12)
    r.raise_for_status()
    t=r.json().get("access_token")
    if not t: raise ValueError("KIS 인증 실패")
    return t

def get_json(key,secret,access,path,tr,params):
    r=requests.get(BASE+path,headers={"authorization":"Bearer "+access,"appkey":key,"appsecret":secret,"tr_id":tr,"custtype":"P"},params=params,timeout=10)
    r.raise_for_status()
    j=r.json()
    if str(j.get("rt_cd"))!="0":
        raise ValueError("KIS 조회 실패 ("+str(j.get("msg_cd","미확인"))[:30]+")")
    return j

def get_contract(key,secret,access,contract):
    market,code,label=contract
    t=now()
    common={"FID_COND_MRKT_DIV_CODE":market,"FID_INPUT_ISCD":code}
    # The chart endpoint documents F; JF support is not assumed.
    path="/uapi/domestic-futureoption/v1/quotations/"
    if market=="F":
        try:
            j=get_json(key,secret,access,path+"inquire-time-fuopchartprice","FHKIF03020200",{
                **common,"FID_HOUR_CLS_CODE":"60","FID_PW_DATA_INCU_YN":"N",
                "FID_FAKE_TICK_INCU_YN":"N","FID_INPUT_DATE_1":t.strftime("%Y%m%d"),
                "FID_INPUT_HOUR_1":t.strftime("%H%M%S")})
            o=j.get("output1") or {}
            if isinstance(o,list): o=o[0] if o else {}
            bars=[]
            for b in j.get("output2") or []:
                try:
                    ts=datetime.strptime(str(b["stck_bsop_date"])+str(b["stck_cntg_hour"]).zfill(6),"%Y%m%d%H%M%S").replace(tzinfo=KST)
                    p=num(b.get("futs_prpr")); v=num(b.get("cntg_vol"))
                    if ts.date()==t.date() and 0<= (t-ts).total_seconds() and p is not None and p>0:
                        bars.append({"ts":ts.timestamp(),"price":p,"volume":v})
                except (KeyError,TypeError,ValueError): continue
            bars=sorted({b["ts"]:b for b in bars}.values(),key=lambda b:b["ts"])
            if num(o.get("futs_prpr")) and bars:
                return snapshot(contract,o,bars,t,"KIS 선물 분봉",bars[-1]["ts"])
        except (requests.RequestException,ValueError,TypeError,KeyError): pass
    j=get_json(key,secret,access,path+"inquire-asking-price","FHMIF10010000",common)
    o=j.get("output1") or {}
    q=j.get("output2") or {}
    if isinstance(o,list): o=o[0] if o else {}
    if isinstance(q,list): q=q[0] if q else {}
    if not num(o.get("futs_prpr")): raise ValueError("유효한 선물 가격 없음")
    # Quote timestamp lacks business date. Require a fresh same-day clock during
    # regular session; never call it verified execution time.
    qt=str(q.get("aspr_acpt_hour") or o.get("aspr_acpt_hour") or "").zfill(6)
    stamp=None
    try:
        dt=datetime.strptime(t.strftime("%Y%m%d")+qt,"%Y%m%d%H%M%S").replace(tzinfo=KST)
        if 0<=(t-dt).total_seconds()<=120: stamp=dt.timestamp()
    except ValueError: pass
    return snapshot(contract,{**q,**o},[],t,"KIS 선물 시세호가",stamp)

def snapshot(contract,o,bars,t,source,stamp):
    market,code,label=contract
    returned=str(o.get("futs_shrn_iscd") or "").strip()
    if returned and returned.upper()!=code.upper(): raise ValueError("응답 월물코드 불일치")
    d=num(o.get("futs_prdy_ctrt"))
    sign=str(o.get("prdy_vrss_sign") or "")
    if d is not None:
        if sign in ("4","5"): d=-abs(d)
        elif sign in ("1","2"): d=abs(d)
        elif sign!="3" or d!=0: d=None
    return {"id":market+":"+code,"label":str(o.get("hts_kor_isnm") or label),"code":code,
            "price":num(o.get("futs_prpr")),"day_pct":d,"volume":num(o.get("acml_vol")),
            "basis":num(o.get("basis")) if market=="F" else None,
            "oi":num(o.get("hts_otst_stpl_qty")),"strength":num(o.get("tday_rltv")),
            "bid":num(o.get("total_bidp_rsqn")),"ask":num(o.get("total_askp_rsqn")),
            "ts":stamp,"retrieved":t.timestamp(),"source":source,"bars":bars}

def fresh(s,t):
    return s.get("ts") is not None and 0<=t.timestamp()-s["ts"]<=120 and t.weekday()<5 and 845<=t.hour*100+t.minute<=1545

def delta(a,b):
    return a-b if a is not None and b is not None else None

def pct(a,b):
    return (a/b-1)*100 if a is not None and b is not None and b>0 else None

def analyze(s,history,threshold=.35,vol_threshold=3.0,basis_threshold=.5,t=None):
    t=t or now()
    if not fresh(s,t): return [],{}
    ts=s["ts"]
    h=[x for x in history if x.get("ts") is not None and x.get("id")==s["id"] and x["ts"]<ts and datetime.fromtimestamp(x["ts"],KST).date()==t.date()]
    h.sort(key=lambda x:x["ts"])
    def previous(seconds):
        candidates=[x for x in h if abs(ts-x["ts"]-seconds)<=75]
        return min(candidates,key=lambda x:abs(ts-x["ts"]-seconds)) if candidates else {}
    old=previous(300)
    bars=s.get("bars",[])
    # Use completed minute observations, never a partial bar's volume.
    complete=[b for b in bars if b["ts"]<=t.replace(second=0,microsecond=0).timestamp()-60]
    changes={}
    for mins in (1,3,5):
        prior=previous(mins*60)
        value=pct(s["price"],prior.get("price"))
        if len(complete)>mins and abs(complete[-1]["ts"]-complete[-1-mins]["ts"]-mins*60)<=1:
            value=pct(complete[-1]["price"],complete[-1-mins]["price"])
        changes[mins]=value
    five=changes[5]
    ratio=None
    if len(complete)>=21:
        recent=[b["volume"] for b in complete[-3:]]
        baseline=[b["volume"] for b in complete[-21:-3]]
        if all(x is not None and x>=0 for x in recent+baseline) and median(baseline)>0 and complete[-1]["ts"]-complete[-21]["ts"]==1200:
            ratio=(sum(recent)/3)/median(baseline)
    # Stock-futures snapshots: compare non-overlapping approximately 5-minute cumulative volume windows.
    if ratio is None and old and s.get("volume") is not None and old.get("volume") is not None:
        earlier=previous(600)
        v1=delta(s["volume"],old.get("volume")); v0=delta(old.get("volume"),earlier.get("volume"))
        if v1 is not None and v0 is not None and v1>=0 and v0>0 and old["ts"]>earlier.get("ts",old["ts"]):
            ratio=(v1/(ts-old["ts"]))/(v0/(old["ts"]-earlier["ts"]))
    bd=delta(s.get("basis"),old.get("basis"))
    oi=delta(s.get("oi"),old.get("oi"))
    events=[]
    def add(kind,score,message,point):
        events.append({"key":s["id"]+":"+kind,"score":score,"title":s["label"]+" · "+kind,
                       "message":message,"point":point,"time":datetime.fromtimestamp(ts,KST).isoformat(),"source":s["source"]})
    if five is not None and abs(five)>=threshold:
        score=80+min(12,int(abs(five)/threshold*4))+(5 if ratio is not None and ratio>=vol_threshold else 0)
        add("5분 급등" if five>0 else "5분 급락",min(score,99),f"5분 변동 {five:+.2f}% / 현재가 {s['price']:,.2f}","현물 동조 및 미결제약정 변화 확인")
    if ratio is not None and ratio>=vol_threshold:
        add("거래량 급증",82,f"최근 거래량 속도 기준 대비 {ratio:.1f}배","가격 방향·호가와 함께 확인; 거래량만으로 매수 주체 판단 불가")
    if bd is not None and abs(bd)>=basis_threshold:
        add("베이시스 급변",82,f"5분 베이시스 {bd:+.2f}pt 변화","현선물 괴리 및 차익거래 여건 확인")
    if oi is not None and old.get("oi") and abs(oi/old["oi"])>=.01:
        add("미결제약정 급변",82,f"5분 미결제약정 {oi:+,.0f}계약 변화","신규 포지션·청산 가능성 점검; 투자자별 방향은 미확인")
    return events,{"1분":changes[1],"3분":changes[3],"5분":five,"거래량 배수":ratio,"베이시스 변화":bd,"미결제 변화":oi}

def news_candidates(queries=DEFAULT_NEWS):
    t=now(); rows={}; successes=0
    for query in dict.fromkeys(queries):
        try:
            r=requests.get("https://news.google.com/rss/search",params={"q":query+" when:1d","hl":"ko","gl":"KR","ceid":"KR:ko"},timeout=8)
            r.raise_for_status()
            root=ET.fromstring(r.content); successes+=1
            for item in root.findall(".//item")[:25]:
                title=item.findtext("title","").strip(); link=item.findtext("link","").strip()
                pub=parsedate_to_datetime(item.findtext("pubDate","")).astimezone(KST)
                if not title or not link.startswith("https://") or not 0<=(t-pub).total_seconds()<=3600 or not NEWS_TERMS.search(title): continue
                normalized=re.sub(r"\W+","",title.rsplit(" - ",1)[0]).lower()
                ident=hashlib.sha256(normalized.encode()).hexdigest()[:24]
                rows[ident]={"key":"news:"+ident,"title":title,"time":pub.isoformat(),"source":item.findtext("source","뉴스 RSS"),"link":link,"score":None,"message":"최근 1시간 주요 키워드 일치 기사 (영향력 미검증)","point":"기사 원문 및 실제 시세 반응 확인"}
        except (requests.RequestException,ET.ParseError,ValueError,TypeError,AttributeError): continue
    return sorted(rows.values(),key=lambda x:x["time"],reverse=True)[:25],successes

def append_history(history,s):
    if s.get("ts") is None: return history
    recent=[x for x in history if x["ts"]>=s["ts"]-3600 and (x["id"],x["ts"])!=(s["id"],s["ts"])]
    recent.append({k:v for k,v in s.items() if k!="bars"})
    return recent[-2500:]

def telegram(bot,chat,event):
    msg="HanaV Futures Radar\n"+event["title"]+"\n"+event["message"]+"\n체크: "+event["point"]+"\n"+event["time"]+"\n"+event["source"]
    r=requests.post("https://api.telegram.org/bot"+bot+"/sendMessage",json={"chat_id":chat,"text":msg[:3800]},timeout=10)
    if not r.ok or not r.json().get("ok"): raise RuntimeError("알림 전송 실패")

def worker():
    """Standalone process on an approved always-on host. Env only. No auto-order."""
    key=os.getenv("KIS_APP_KEY",""); secret=os.getenv("KIS_APP_SECRET","")
    contracts=parse_contracts(os.getenv("FUTURES_CONTRACTS",""))
    bot=os.getenv("RADAR_TELEGRAM_BOT_TOKEN",""); chat=os.getenv("RADAR_TELEGRAM_CHAT_ID","")
    if not all((key,secret,contracts,bot,chat)): raise SystemExit("KIS credentials, contracts and approved alert settings required")
    access=""; issued=0; history=[]; sent={}
    while True:
        t=now()
        if t.weekday()<5 and 845<=t.hour*100+t.minute<=1545:
            try:
                if not access or time.monotonic()-issued>20*3600:
                    access=token(key,secret); issued=time.monotonic()
                for c in contracts:
                    try:
                        s=get_contract(key,secret,access,c)
                        events,_=analyze(s,history,t=now())
                        if fresh(s,now()): history=append_history(history,s)
                        for e in events:
                            if time.time()-sent.get(e["key"],0)>=600:
                                telegram(bot,chat,e); sent[e["key"]]=time.time()
                    except Exception as e: print("contract check failed",c[1],type(e).__name__,flush=True)
            except Exception as e: print("radar check failed",type(e).__name__,flush=True)
        time.sleep(60)

if __name__=="__main__":
    worker()
