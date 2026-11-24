"""HanaV Futures Radar Streamlit page (read-only)."""
import os
import time
import threading
import hashlib
from datetime import datetime
import pandas as pd
import streamlit as st
from futures_radar_engine import (KST, now, parse_contracts, token, get_contract,
                                  analyze, fresh, append_history, news_candidates, load_front_contracts, telegram)
from trading_sidebar import render_trading_sidebar

render_trading_sidebar()

st.markdown("""<div style="padding:18px 24px;border-radius:13px;background:linear-gradient(110deg,#006b55,#06866d);color:white">
<div style="font-size:12px;font-weight:700;letter-spacing:1px">DERIVATIVES · MARKET SIGNALS</div>
<div style="font-size:29px;font-weight:850">HanaV Futures Radar</div>
<div>지수선물 · 주식선물 장중 이상징후 탐지</div></div>""",unsafe_allow_html=True)
st.caption("KIS REST 조회 기반 · 실시간 체결 스트리밍 아님 · 주문 기능 없음 · 주간장 감시용")

def setting(name):
    try:
        val=st.secrets.get(name,"")
        if isinstance(val,str) and val.strip(): return val.strip()
    except Exception: pass
    return os.getenv(name,"").strip()

@st.cache_data(ttl=72000,show_spinner=False)
def access_token(key,secret):
    return token(key,secret)

@st.cache_data(ttl=55,show_spinner=False)
def collect(key,secret,contracts):
    try:
        access=access_token(key,secret)
    except Exception:
        return [],[(None,"KIS 인증 실패: Secrets 및 API 권한 확인")]
    values=[]; errors=[]
    for c in contracts:
        try:
            values.append(get_contract(key,secret,access,c))
        except Exception as e:
            errors.append((c[2]+" ("+c[1]+")",str(e) if isinstance(e,ValueError) else type(e).__name__))
    return values,errors

@st.cache_data(ttl=120,show_spinner=False)
def headlines(queries):
    return news_candidates(queries)

@st.cache_data(ttl=1800,show_spinner=False)
def contract_master():
    return load_front_contracts()

key=setting("KIS_APP_KEY")
secret=setting("KIS_APP_SECRET")
with st.expander("⚙ 감시 대상 및 시그널 조건",expanded=not bool(st.session_state.get("radar_contracts") or setting("FUTURES_CONTRACTS"))):
    st.caption("KIS 공식 종목마스터에서 최근월물만 조회합니다. 직접 입력값이 있으면 우선 사용합니다. 연결선물·옵션·스프레드는 제외합니다.")
    master,master_errors=contract_master()
    for err in master_errors: st.caption(err)
    options=[(a,b,c,d) for a,b,c,d in master]
    defaults=[]
    import re
    for target in ("KOSPI200","KOSDAQ150","삼성전자","SK하이닉스","현대차"):
        aliases={"KOSPI200":("KOSPI200","코스피200"),"KOSDAQ150":("KOSDAQ150","코스닥150")}.get(target,(target,))
        for item in options:
            underlying=re.sub(r"\s+","",item[3]).upper()
            if underlying in aliases and (item[0]=="JF" or not any(x in item[2].upper() for x in ("미니","MINI"))):
                defaults.append(item); break
    selected=st.multiselect("최근월물 선택",options,default=defaults,format_func=lambda x:x[3]+" · "+x[2]+" ("+x[1]+")",max_selections=12,key="radar_master_selection")
    if not options: st.caption("마스터 조회 불가: 아래에 실제 월물코드를 직접 입력하세요.")
    raw=st.text_area("감시 월물 (한 줄에 시장구분,단축코드,표시명)",value=setting("FUTURES_CONTRACTS"),placeholder="F,실제월물코드,KOSPI200 선물\nJF,실제월물코드,삼성전자 선물",height=125,key="radar_contracts")
    a,b,c=st.columns(3)
    threshold=a.number_input("5분 변동률 (%)",.10,5.0,.35,.05, key="radar_pct")
    vol_threshold=b.number_input("거래량 급증 배수",1.5,10.0,3.0,.5,key="radar_vol")
    basis_threshold=c.number_input("베이시스 5분 변화 (pt)",.1,5.0,.5,.1,key="radar_basis")
    watch_news=st.text_input("추가 뉴스 관심 키워드 (쉼표 구분)",placeholder="삼성전자, SK하이닉스, 로봇",key="radar_news")
try:
    contracts=tuple(parse_contracts(raw)) if raw.strip() else tuple((a,b,c) for a,b,c,d in selected)
except ValueError as e:
    st.error(str(e)); contracts=()
if not key or not secret:
    st.warning("KIS_APP_KEY 및 KIS_APP_SECRET이 미설정입니다. 선물 시세는 연결 전까지 표시하지 않습니다.")
elif not contracts:
    st.info("감시할 실제 선물 월물코드를 등록하세요. 현재 뉴스 후보 감지는 이용할 수 있습니다.")
st.caption("외국인·기관 선물 순매수 및 프로그램 매매는 전용 데이터 연결 대기 상태입니다. 호가나 거래량을 투자자 수급으로 대체하지 않습니다.")
@st.cache_resource
def alert_registry():
    # Shared across browser sessions in this server process; resets on restart.
    return threading.Lock(), {}

def deliver(bot,chat,event,cooldown=600):
    lock,sent=alert_registry()
    ident=hashlib.sha256((bot+"|"+chat+"|"+event["key"]).encode()).hexdigest()
    with lock:
        t=time.time()
        for k,v in list(sent.items()):
            if t-v>86400: sent.pop(k,None)
        if t-sent.get(ident,0)<cooldown: return "duplicate"
        try:
            telegram(bot,chat,event)
        except Exception:
            # Never show or log exception URLs, which may contain the bot token.
            return "failed"
        sent[ident]=t
        return "sent"

bot=setting("RADAR_TELEGRAM_BOT_TOKEN")
chat=setting("RADAR_TELEGRAM_CHAT_ID")
ready=bool(bot and chat)
with st.expander("🔔 휴대폰 알림 · 텔레그램",expanded=True):
    st.caption("본인 또는 승인된 수신자에게만 전송하세요. 시세 이용권한 및 사내 외부 메신저 사용 규정 확인 필요.")
    st.write("설정 상태: "+("🟢 토큰·채팅 ID 등록됨 (전송 테스트 필요)" if ready else "⚪ 미설정 · Streamlit Secrets 등록 필요"))
    alert_on=st.toggle("주요 시그널 자동 전송",value=False,disabled=not ready,key="radar_phone_on")
    min_score=st.slider("최소 중요도",min_value=80,max_value=95,value=80,step=1,key="radar_phone_score")
    alert_news=st.toggle("신규 주요 뉴스 후보도 전송",value=False,disabled=not ready,key="radar_phone_news")
    st.caption("가격 신호는 동일 계약·유형별 10분 중복 제한. 뉴스는 별도 선택 시에만 전송. 이 페이지가 열린 동안 감시합니다.")
    if st.button("📲 휴대폰 테스트 알림 보내기",disabled=not ready,key="radar_phone_test"):
        e={"key":"manual-test","title":"알림 연결 테스트","message":"HanaV Futures Radar의 테스트 메시지입니다. 실제 시장 신호가 아닙니다.","point":"휴대폰에서 알림 수신 여부 확인","time":now().isoformat(),"source":"시스템 테스트"}
        status=deliver(bot,chat,e,30)
        if status=="sent": st.success("텔레그램 API 전송 성공. 휴대폰 알림을 확인하세요.")
        elif status=="duplicate": st.info("테스트는 30초 후 다시 가능합니다.")
        else: st.error("전송 실패: 봇 토큰, 채팅 ID, 봇 대화 시작 여부를 확인하세요.")

auto=st.toggle("60초 자동 갱신 (이 페이지 열려 있을 때)",value=True,key="radar_auto")
if st.button("🔄 최신 시세·뉴스 새로고침",key="radar_refresh"):
    collect.clear(); headlines.clear()
    st.rerun()

def fmt(v,spec=".2f"):
    return "미확인" if v is None else format(v,spec)

@st.fragment(run_every="60s" if auto else None)
def monitor():
    t=now()
    values=[]; errors=[]
    if key and secret and contracts:
        with st.spinner("선물 시세 확인 중..."):
            values,errors=collect(key,secret,contracts)
    t=now()  # Evaluate freshness after the network request completes.
    history=st.session_state.get("radar_history",[])
    log=st.session_state.get("radar_log",[])
    seen=st.session_state.get("radar_seen",{})
    # A new trading date resets local observations, not an exchange holiday calendar.
    log=[x for x in log if x["time"][:10]==t.date().isoformat()]
    seen={k:v for k,v in seen.items() if t.timestamp()-v<86400}
    events=[]; rows=[]
    for s in values:
        ev,stats=analyze(s,history,threshold,vol_threshold,basis_threshold,t)
        if fresh(s,t): history=append_history(history,s)
        events.extend(ev)
        rows.append({"선물 월물":s["label"],"코드":s["code"],"현재가":fmt(s["price"],",.2f"),"전일비":fmt(s["day_pct"],"+.2f")+"%" if s["day_pct"] is not None else "미확인",
                     "1분(%)":stats.get("1분"),"3분(%)":stats.get("3분"),"5분(%)":stats.get("5분"),
                     "거래량 배수":stats.get("거래량 배수"),"베이시스":s["basis"],"미결제약정":s["oi"],
                     "시세 시각":datetime.fromtimestamp(s["ts"],KST).strftime("%H:%M:%S") if s["ts"] else "미확인",
                     "상태":"감시 중" if fresh(s,t) else "지연·장외·시각 미확인","출처":s["source"]})
    for e in sorted(events,key=lambda x:x["score"],reverse=True):
        if t.timestamp()-seen.get(e["key"],0)>=600:
            log.append(e); seen[e["key"]]=t.timestamp()
    if ready and alert_on:
        results=[deliver(bot,chat,e) for e in events if e["score"]>=min_score]
        if "failed" in results: st.warning("휴대폰 알림 전송 실패. 텔레그램 설정 및 네트워크 확인 필요.")
        if "sent" in results:
            st.session_state["radar_phone_last"]=now().strftime("%H:%M:%S")+" · "+str(results.count("sent"))+"건"
        if st.session_state.get("radar_phone_last"):
            st.caption("최근 시그널 전송 성공: "+st.session_state["radar_phone_last"])
    st.session_state["radar_history"]=history
    st.session_state["radar_log"]=log[-150:]
    st.session_state["radar_seen"]=seen
    cols=st.columns(4)
    cols[0].metric("감시 계약",len(contracts))
    cols[1].metric("유효 시세",sum(fresh(s,t) for s in values))
    cols[2].metric("현재 감지",len(events))
    cols[3].metric("오늘 감지 이력",len(log))
    st.caption("조회 "+t.strftime("%Y-%m-%d %H:%M:%S KST")+" · 기준 시세 120초 초과 시 신규 가격 신호 차단")
    for name,err in errors:
        st.warning((name+" · " if name else "")+err)
    st.subheader("📡 지수·주식선물 모니터링")
    if rows:
        st.dataframe(pd.DataFrame(rows),use_container_width=True,hide_index=True,column_config={
            n:st.column_config.NumberColumn(format="%.2f") for n in ["1분(%)","3분(%)","5분(%)","거래량 배수","베이시스"]})
        st.caption("지수선물 분봉 우선. 주식선물은 시세호가 스냅샷 누적 비교로 초기 5~10분 준비 필요. 미결제약정 등 미제공 값은 공란.")
    else:
        st.info("확인된 선물 시세 없음")
    st.subheader("🚨 주요 시그널")
    if not log:
        st.caption("감지 이력이 없습니다. 미연결/준비 중에는 이상징후가 없다는 뜻이 아닙니다.")
    for e in reversed(log[-15:]):
        with st.container(border=True):
            st.markdown("**"+e["title"]+"**")
            st.write(e["message"])
            st.caption(e["time"][11:19]+" · 중요도 "+str(e["score"])+" / 100 · "+e["source"])
            st.write("체크 포인트: "+e["point"])
            st.code("HanaV 장중 시황 | "+e["title"]+"\n"+e["message"]+"\n"+e["point"]+"\n기준 "+e["time"]+" / "+e["source"],language=None)
    st.subheader("📰 신규 주요 뉴스 후보")
    queries=("코스피 선물 외국인","한국 증시 속보","한국은행 금리 환율","미국 증시 선물")+tuple(x.strip() for x in watch_news.split(",") if x.strip())[:4]
    news,ok=headlines(queries)
    st.caption(f"최근 1시간 키워드 일치 · 검색 {ok}/{len(set(queries))}건 응답 · 뉴스의 시장 영향은 원문과 시세를 대조해야 합니다.")
    if not news:
        st.info("검색된 뉴스 후보 없음" if ok else "뉴스 제공처 연결 실패")
    if ready and alert_on and alert_news and t.weekday()<5 and 845<=t.hour*100+t.minute<=1545:
        # Only new candidates after activation, not the pre-existing RSS backlog.
        started=st.session_state.setdefault("radar_news_alert_start",now().timestamp())
        candidates=[e for e in news if datetime.fromisoformat(e["time"]).timestamp()>=started]
        results=[deliver(bot,chat,e,86400) for e in candidates[:5]]
        if "failed" in results: st.warning("뉴스 후보 알림 전송 실패")
    else:
        st.session_state.pop("radar_news_alert_start",None)
    for item in news[:12]:
        st.markdown("**"+item["title"]+"**")
        st.caption(item["time"][11:19]+" · "+item["source"])
        st.link_button("기사 확인",item["link"])
    st.caption("휴대폰 알림은 텔레그램 설정 및 자동 전송 활성화 시 작동합니다. 독립 서버를 실행하지 않으면 앱을 닫을 때 감시가 중단됩니다.")

monitor()
