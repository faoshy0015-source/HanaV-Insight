"""News Center page, routed by the authenticated HanaV Insight entrypoint."""
import os
import re
from collections import Counter
from datetime import datetime

import pandas as pd
import streamlit as st

from news_center_engine import KST, THEMES, WATCH, candidates, collect, now, telegram

def setting(name):
    try:
        value=st.secrets.get(name,"")
        if value: return str(value).strip()
    except Exception:
        pass
    return os.getenv(name,"").strip()

@st.cache_data(ttl=60,show_spinner=False,max_entries=12)
def latest(key,media,licensed,days):
    return collect(key,media,licensed,days)

@st.cache_data(ttl=3600,show_spinner=False)
def listing():
    from data_sources import get_listing,seed_listing
    data=get_listing()
    return data if not data.empty else seed_listing()

@st.cache_data(ttl=90,show_spinner=False,max_entries=64)
def stock_context(code,market,key,secret):
    from data_sources import get_kis_access_token,get_kis_quote,get_prices,get_investor_flows
    quote={}; price_source=""; price_date=""
    if key and secret:
        try:
            token=get_kis_access_token(key,secret)
            quote=get_kis_quote(code,key,secret,token)
            if quote:
                price_source="KIS REST 조회값"
                price_date=now().strftime("%m/%d %H:%M 조회")
        except Exception: pass
    if not quote:
        try:
            hist,_,source,_=get_prices(code,market)
            if not hist.empty:
                close=hist["Close"].dropna()
                if len(close)>=2:
                    quote={"price":float(close.iloc[-1]),"delta":float((close.iloc[-1]/close.iloc[-2]-1)*100)}
                    price_source=source
                    price_date=str(close.index[-1].date())
        except Exception: pass
    try:
        flow,_=get_investor_flows(code,days=15)
        flow=flow.dropna(how="all")
    except Exception: flow=pd.DataFrame()
    return quote,price_source,price_date,flow

def show_time(row):
    if row["stamp"] is not None:
        return datetime.fromtimestamp(row["stamp"],KST).strftime("%m/%d %H:%M")
    d=row["date"]
    return d[4:6]+"/"+d[6:8]+" (일자)" if len(d)==8 else "미제공"

def related(row):
    if row["name"] and row["code"]: return row["name"]+" ("+row["code"]+")"
    title=row["title"].lower()
    return ", ".join(name+" ("+code+")" for name,code in WATCH.items() if name.lower() in title)

def frame(rows):
    return pd.DataFrame([{"발행(KST)":show_time(r),"분류":r["category"],
        "중요":("🔴" if r["score"]>=4 else "🟠" if r["score"]==3 else ""),
        "제목":r["title"],"출처":r["source"],"관련 종목":related(r),
        "테마":", ".join(r["themes"]),"유사":r["duplicates"]-1,"원문":r["link"]} for r in rows],
        columns=["발행(KST)","분류","중요","제목","출처","관련 종목","테마","유사","원문"])

st.title("📰 실시간 뉴스센터")
st.caption("HanaV Insight NEWS CENTER V2.1 · 제목 기반 정보 탐지 · HTS 전용 속보망과 동일한 속도/범위는 아님")
key=setting("DART_API_KEY")
licensed=setting("NEWS_LICENSED_RSS_JSON")
bot=setting("NEWS_TELEGRAM_BOT_TOKEN") or setting("RADAR_TELEGRAM_BOT_TOKEN")
chat=setting("NEWS_TELEGRAM_CHAT_ID") or setting("RADAR_TELEGRAM_CHAT_ID")
with st.expander("뉴스 데이터 및 자동 알림 설정",expanded=False):
    media=st.checkbox("언론사 RSS 제목·원문 보기 (개인 열람 또는 이용권한 확보 시)",value=setting("NEWS_MEDIA_ENABLED").lower() in ("1","true","yes"),key="news_media")
    st.caption("한국경제·매일경제 공개 RSS는 제목/원문 열람용입니다. 언론사 기사는 텔레그램 재전송 대상에서 제외합니다. 업무용 이용조건과 사내 정책을 확인하세요.")
    auto=st.checkbox("뉴스센터가 열린 동안 자동 갱신",value=True,key="news_auto_refresh")
    interval=st.selectbox("갱신 주기",["30초","60초","120초"],index=1)
    min_score=st.slider("알림 중요도 기준 (키워드 점수)",3,5,4)
    watch=st.text_input("알림 관심 종목·키워드 (쉼표 구분, 비우면 전체)",key="news_alert_watch")
    st.write("OpenDART: "+("키 등록됨" if key else "DART_API_KEY 미설정")+" | Telegram: "+("설정됨" if bot and chat else "미설정"))
    send=st.checkbox("이 화면을 열어 둔 동안 공식 공시·허가 피드의 새 중요 알림 전송",value=False,disabled=not(bool(bot and chat)),key="news_alert_enable")
    st.caption("첫 조회는 기준점만 저장하고 과거 뉴스는 보내지 않습니다. 화면을 닫으면 화면 기반 알림은 멈춥니다. 별도 워커는 GitHub Actions 또는 PC에서 구동할 수 있습니다. 중복 방지를 위해 둘 중 하나만 사용하세요.")
    if st.button("텔레그램 연결 테스트",disabled=not(bool(bot and chat))):
        ok=telegram(bot,chat,{"source":"테스트","events":["연결 확인"],"title":"HanaV 뉴스센터 연결 테스트","link":""})
        if ok: st.success("테스트 메시지 발송 성공")
        else: st.error("전송 실패 · 토큰/채팅 ID/네트워크 확인")
    if not send:
        st.session_state.pop("news_alert_seen",None)

a,b,c,d=st.columns([2.4,1.4,1.3,1])
with a: query=st.text_input("종목명·코드·키워드",placeholder="예: 삼성전자, 005930, 특별배당")
with b: category=st.selectbox("분류",["전체","속보","특징주","공시","증권","산업·테마","경제·정책","해외증시","증권사 리포트"])
with c: theme=st.selectbox("테마",["전체"]+list(THEMES))
with d: days=st.selectbox("조회 범위",[1,3,7],index=1,format_func=lambda x:f"최근 {x}일")
e,f,g=st.columns([1,1,1])
with e: only=st.checkbox("중요 뉴스만",value=False)
with f: source_filter=st.selectbox("출처 유형",["전체","언론","공시","공식","허가"])
with g:
    if st.button("↻ 새로고침",use_container_width=True): latest.clear()

def render():
    rows,status=latest(key,media,licensed,days)
    selected=[]
    q=query.strip().lower()
    for r in rows:
        terms=" ".join([r["title"],r["source"],r["name"],r["code"],related(r)," ".join(r["themes"])," ".join(r["events"])]).lower()
        if q and q not in terms: continue
        if category!="전체" and r["category"]!=category: continue
        if theme!="전체" and theme not in r["themes"]: continue
        if source_filter!="전체" and r["kind"]!=source_filter: continue
        if only and r["score"]<4: continue
        selected.append(r)
    current=now()
    halfhour=[r for r in rows if r["stamp"] is not None and 0<=current.timestamp()-r["stamp"]<=1800]
    counts=Counter(t for r in halfhour for t in r["themes"])
    m1,m2,m3,m4=st.columns(4)
    m1.metric("수집 제목",len(rows))
    m2.metric("중요 키워드",sum(r["score"]>=4 for r in rows))
    m3.metric("공시",sum(r["kind"]=="공시" for r in rows))
    m4.metric("최근 30분",len(halfhour))
    st.caption(f"화면 갱신 {current:%m/%d %H:%M:%S} KST · 원본 RSS 지연 가능 · 공시 접수일만 제공 시 시각 미표시")
    if not media: st.info("언론사 RSS는 설정에서 활성화할 수 있습니다. 현재 공식기관·공시·허가 피드만 조회합니다.")
    if not key: st.warning("DART_API_KEY 미설정: 공시가 표시되지 않습니다.")
    bad=[name for name,ok,_ in status if not ok]
    if bad: st.warning("미수신/미설정: "+", ".join(bad))
    tabs=st.tabs(["전체 뉴스 피드","30분 테마 동향","공시","중요 시그널","데이터 상태"])
    config={"원문":st.column_config.LinkColumn("원문",display_text="열기"),"제목":st.column_config.TextColumn("제목",width="large")}
    def table(data):
        if not data: st.info("조건에 맞는 항목이 없습니다.")
        else: st.dataframe(frame(data[:500]),hide_index=True,use_container_width=True,height=560,column_config=config)
        if len(data)>500: st.caption("최신순 500개 표시 · 검색 조건으로 범위를 좁힐 수 있습니다.")
    with tabs[0]:
        st.caption(f"검색 결과 {len(selected)}건 · 유사 제목은 묶음 수로 표시")
        table(selected)
    with tabs[1]:
        st.caption("최근 30분의 발행시각이 확인된 제목에서 테마별 키워드 등장 횟수를 집계합니다. 주가 상승 예측이나 실제 수급은 아닙니다.")
        if counts:
            st.bar_chart(pd.DataFrame(counts.most_common(),columns=["테마","건수"]).set_index("테마"))
        else: st.info("최근 30분 내 테마 분류된 뉴스가 없습니다.")
    with tabs[2]: table([r for r in selected if r["kind"]=="공시"])
    with tabs[3]:
        st.caption("공급계약, 주주환원, 거래정지, 기술수출 등 제목 키워드 기준이며 호재·악재를 확정하지 않습니다.")
        table([r for r in selected if r["score"]>=min_score])
    with tabs[4]:
        st.dataframe(pd.DataFrame(status,columns=["출처","수신 성공","수신 건수"]),hide_index=True,use_container_width=True)
        st.caption("피드별 최신 100개 / DART 시장별 최대 500개 조회; 전체 언론사·전체 공시의 완전한 수집을 보장하지 않습니다.")
    if send and bot and chat:
        eligible=candidates(rows,min_score,watch)
        signature=(min_score,watch,days,licensed)
        if st.session_state.get("news_alert_signature")!=signature or "news_alert_seen" not in st.session_state:
            st.session_state["news_alert_seen"]={r["id"] for r in eligible}
            st.session_state["news_alert_signature"]=signature
            st.caption("알림 기준점 초기화 완료 · 기존 항목은 발송하지 않습니다.")
        else:
            seen=st.session_state["news_alert_seen"]
            pending=[r for r in eligible if r["id"] not in seen]
            sent=0
            for r in pending[:3]:
                if telegram(bot,chat,r): seen.add(r["id"]); sent+=1
                else: st.warning("뉴스 알림 전송 실패 · 다음 갱신 시 재시도")
            if sent: st.success(f"새 중요 시그널 {sent}건 발송")
    st.caption("원문 확인 필수 · 뉴스/공시 키워드 점수는 기존 Analyze 정량 평가에 반영하지 않습니다.")

if auto:
    st.fragment(run_every=interval.replace("초","s"))(render)()
else:
    render()

st.divider()
st.subheader("관련 종목 시세·수급 확인")
st.caption("위 뉴스 제목·공시의 종목을 선택하여 조회합니다. 뉴스 발생 전후의 인과관계나 실시간 수급을 확정하지 않습니다.")
with st.form("news_stock_context"):
    stock_query=st.text_input("종목명 또는 6자리 종목코드",value=query if query else "")
    submit=st.form_submit_button("시세·수급 조회")
if submit and stock_query.strip():
    s=stock_query.strip()
    data=listing()
    match=data[(data["code"].astype(str)==s)|(data["name"].astype(str).str.casefold()==s.casefold())]
    if match.empty:
        match=data[data["name"].astype(str).str.contains(s,case=False,regex=False)].head(10)
    if match.empty: st.warning("종목을 찾지 못했습니다. 정확한 종목명 또는 코드를 입력하세요.")
    else: st.session_state["news_stock_matches"]=match.to_dict("records")
matches=st.session_state.get("news_stock_matches",[])
if matches:
    labels=[str(x["name"])+" ("+str(x["code"])+")" for x in matches]
    choice=st.selectbox("관련 종목",labels)
    x=matches[labels.index(choice)]
    q,src,date,flow=stock_context(str(x["code"]),str(x["market"]),setting("KIS_APP_KEY"),setting("KIS_APP_SECRET"))
    l,r=st.columns(2)
    with l:
        if q and q.get("price") is not None:
            delta=q.get("delta")
            st.metric(choice,f'{q["price"]:,.0f}원',f'{delta:+.2f}%' if delta is not None else None)
            st.caption(src+" · "+date)
        else: st.info("시세 데이터 미수신")
        if st.button("Analyze에서 종목 분석",key="news_open_analyze"):
            st.session_state["query"]=str(x["code"])
            st.switch_page("stock_analyze.py")
    with r:
        if not flow.empty:
            st.caption("KRX 최근 제공 일별 순매수 · 억원 · 기준 "+str(flow.index[-1].date()))
            st.dataframe((flow.tail(5)/1e8).round(1),use_container_width=True)
        else: st.info("KRX 수급 미수신")
