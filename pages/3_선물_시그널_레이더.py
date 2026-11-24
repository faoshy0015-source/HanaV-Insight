"""HanaV Futures Radar Streamlit page (read-only)."""
import os
from datetime import datetime
import pandas as pd
import streamlit as st
from futures_radar_engine import (KST, now, parse_contracts, token, get_contract,
                                  analyze, fresh, append_history, news_candidates)
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

key=setting("KIS_APP_KEY")
secret=setting("KIS_APP_SECRET")
with st.expander("⚙ 감시 대상 및 시그널 조건",expanded=not bool(st.session_state.get("radar_contracts") or setting("FUTURES_CONTRACTS"))):
    st.caption("HTS/공식 선물 종목 마스터에 표시되는 실제 월물 단축코드를 입력하세요. F=지수선물, JF=주식선물. 만기 때 변경 필요. 현물 6자리 종목코드로 대체하지 않습니다.")
    raw=st.text_area("감시 월물 (한 줄에 시장구분,단축코드,표시명)",value=setting("FUTURES_CONTRACTS"),placeholder="F,실제월물코드,KOSPI200 선물\nJF,실제월물코드,삼성전자 선물",height=125,key="radar_contracts")
    a,b,c=st.columns(3)
    threshold=a.number_input("5분 변동률 (%)",.10,5.0,.35,.05, key="radar_pct")
    vol_threshold=b.number_input("거래량 급증 배수",1.5,10.0,3.0,.5,key="radar_vol")
    basis_threshold=c.number_input("베이시스 5분 변화 (pt)",.1,5.0,.5,.1,key="radar_basis")
    watch_news=st.text_input("추가 뉴스 관심 키워드 (쉼표 구분)",placeholder="삼성전자, SK하이닉스, 로봇",key="radar_news")
try:
    contracts=tuple(parse_contracts(raw))
except ValueError as e:
    st.error(str(e)); contracts=()
if not key or not secret:
    st.warning("KIS_APP_KEY 및 KIS_APP_SECRET이 미설정입니다. 선물 시세는 연결 전까지 표시하지 않습니다.")
elif not contracts:
    st.info("감시할 실제 선물 월물코드를 등록하세요. 현재 뉴스 후보 감지는 이용할 수 있습니다.")
st.caption("외국인·기관 선물 순매수 및 프로그램 매매는 전용 데이터 연결 대기 상태입니다. 호가나 거래량을 투자자 수급으로 대체하지 않습니다.")
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
    for item in news[:12]:
        st.markdown("**"+item["title"]+"**")
        st.caption(item["time"][11:19]+" · "+item["source"])
        st.link_button("기사 확인",item["link"])
    st.caption("알림은 현재 화면 내부 감지 이력입니다. 독립 서버 및 승인된 메신저 설정 전에는 앱을 닫으면 감시가 중단됩니다.")

monitor()
