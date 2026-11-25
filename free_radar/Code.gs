// HanaV free scheduled radar. Paste into a private Google Apps Script project.
// All credentials and monitoring state stay in private Script Properties.
const BASE = 'https://openapi.koreainvestment.com:9443';
const TZ = 'Asia/Seoul';
function prop(){return PropertiesService.getScriptProperties();}
function cfg(){
  const p=prop(), required=['KIS_APP_KEY','KIS_APP_SECRET','FUTURES_CONTRACTS','RADAR_TELEGRAM_BOT_TOKEN','RADAR_TELEGRAM_CHAT_ID'];
  const c={}; required.forEach(k=>{c[k]=(p.getProperty(k)||'').trim();if(!c[k])throw Error('Missing property: '+k);});
  c.contracts=c.FUTURES_CONTRACTS.split(/[;\r\n]+/).filter(x=>x.trim()).map(x=>x.split(',').map(y=>y.trim()));
  if(c.contracts.length>12||c.contracts.some(x=>x.length!==3||!['F','JF'].includes(x[0])||!/^[A-Za-z0-9]{5,12}$/.test(x[1])||!x[2]))throw Error('Invalid FUTURES_CONTRACTS');
  c.contracts=[...new Map(c.contracts.map(x=>[x[0]+':'+x[1].toUpperCase(),x])).values()];
  c.news=(p.getProperty('RADAR_ALERT_NEWS')||'true').toLowerCase()==='true';
  return c;
}
function localTime(d,pattern){return Utilities.formatDate(d,TZ,pattern);}
function active(d){const day=Number(localTime(d,'u')),hm=Number(localTime(d,'HHmm'));return day<=5&&hm>=845&&hm<=1545;}
function req(url,options,label){
  let res;
  try{res=UrlFetchApp.fetch(url,{...options,muteHttpExceptions:true,followRedirects:false});}catch(e){throw Error(label+' network failure');}
  if(res.getResponseCode()!==200)throw Error(label+' HTTP '+res.getResponseCode());
  try{return JSON.parse(res.getContentText());}catch(e){throw Error(label+' invalid JSON');}
}
function access(c){
  const p=prop(), saved=JSON.parse(p.getProperty('_KIS_ACCESS')||'null');
  const finger=Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,c.KIS_APP_KEY+c.KIS_APP_SECRET));
  if(saved&&saved.finger===finger&&saved.exp>Date.now()+60000)return saved.token;
  const j=req(BASE+'/oauth2/tokenP',{method:'post',contentType:'application/json',payload:JSON.stringify({grant_type:'client_credentials',appkey:c.KIS_APP_KEY,appsecret:c.KIS_APP_SECRET})},'KIS authentication');
  if(!j.access_token)throw Error('KIS authentication rejected');
  p.setProperty('_KIS_ACCESS',JSON.stringify({finger,token:j.access_token,exp:Date.now()+Math.min(Number(j.expires_in)||72000,72000)*1000}));
  return j.access_token;
}
function telegram(c,text){
  const j=req('https://api.telegram.org/bot'+c.RADAR_TELEGRAM_BOT_TOKEN+'/sendMessage',{method:'post',contentType:'application/json',payload:JSON.stringify({chat_id:c.RADAR_TELEGRAM_CHAT_ID,text:text.slice(0,3800),disable_web_page_preview:true})},'Telegram');
  if(!j.ok)throw Error('Telegram rejected message');
}
function quote(c,a,contract){
  const [market,code,label]=contract;
  const j=req(BASE+'/uapi/domestic-futureoption/v1/quotations/inquire-asking-price?FID_COND_MRKT_DIV_CODE='+market+'&FID_INPUT_ISCD='+encodeURIComponent(code),
    {headers:{authorization:'Bearer '+a,appkey:c.KIS_APP_KEY,appsecret:c.KIS_APP_SECRET,tr_id:'FHMIF10010000',custtype:'P'}},'KIS quote');
  if(String(j.rt_cd)!=='0')throw Error('KIS quote rejected');
  const o=Array.isArray(j.output1)?j.output1[0]||{}:j.output1||{};
  const q=Array.isArray(j.output2)?j.output2[0]||{}:j.output2||{};
  if(o.futs_shrn_iscd&&String(o.futs_shrn_iscd).trim().toUpperCase()!==code.toUpperCase())throw Error('Contract mismatch');
  const d=new Date(),raw=String(q.aspr_acpt_hour||o.aspr_acpt_hour||'').padStart(6,'0');
  if(!/^\d{6}$/.test(raw))throw Error('Quote time unverified');
  const stamp=Date.parse(localTime(d,'yyyy-MM-dd')+'T'+raw.slice(0,2)+':'+raw.slice(2,4)+':'+raw.slice(4,6)+'+09:00');
  if(!active(d)||!Number.isFinite(stamp)||d.getTime()-stamp<0||d.getTime()-stamp>120000)throw Error('Quote stale or market closed');
  const n=x=>x===null||x===undefined||String(x).trim()===''?null:Number.isFinite(Number(String(x).replace(/,/g,'')))?Number(String(x).replace(/,/g,'')):null;
  const price=n(o.futs_prpr);
  if(!(price>0))throw Error('Invalid quote');
  const rawPct=n(o.futs_prdy_ctrt), sign=String(o.prdy_vrss_sign||'');
  const dayPct=rawPct===null?null:['4','5'].includes(sign)?-Math.abs(rawPct):['1','2'].includes(sign)?Math.abs(rawPct):sign==='3'&&rawPct===0?0:null;
  return {t:stamp,p:price,dayPct,v:n(o.acml_vol),b:market==='F'?n(o.basis):null,oi:n(o.hts_otst_stpl_qty),label:String(o.hts_kor_isnm||label)};
}
function checkContract(c,a,contract,s){
  const p=prop(), key='_H_'+contract[0]+'_'+contract[1].toUpperCase();
  s=s||quote(c,a,contract);
  let state=JSON.parse(p.getProperty(key)||'{"history":[],"sent":{}}');
  const date=localTime(new Date(s.t),'yyyyMMdd');
  if(state.date!==date)state={date,history:[],sent:{}};
  let h=state.history.filter(x=>s.t-x.t>0&&s.t-x.t<=1800000);
  const near=ms=>h.filter(x=>Math.abs(s.t-x.t-ms)<=75000).sort((x,y)=>Math.abs(s.t-x.t-ms)-Math.abs(s.t-y.t-ms))[0];
  const old=near(300000), earlier=near(600000), events=[];
  const finite=(...v)=>v.every(x=>typeof x==='number'&&Number.isFinite(x));
  if(old){
    const mins=((s.t-old.t)/60000).toFixed(1), ch=(s.p/old.p-1)*100;
    if(Math.abs(ch)>=0.35)events.push([ch>0?'급등':'급락',mins+'분 변동 '+ch.toFixed(2)+'% / 현재가 '+s.p]);
    if(finite(s.b,old.b)&&Math.abs(s.b-old.b)>=0.5)events.push(['베이시스 급변',mins+'분 변화 '+(s.b-old.b).toFixed(2)+'pt']);
    if(finite(s.oi,old.oi)&&old.oi>0&&Math.abs(s.oi/old.oi-1)>=0.01)events.push(['미결제약정 급변',mins+'분 변화 '+(s.oi-old.oi)+'계약 (투자자별 방향 미확인)']);
    if(earlier&&finite(s.v,old.v,earlier.v)&&old.t>earlier.t&&old.v>earlier.v&&s.v>=old.v){
      const ratio=((s.v-old.v)/(s.t-old.t))/((old.v-earlier.v)/(old.t-earlier.t));
      if(ratio>=3)events.push(['거래량 급증','이전 구간 대비 '+ratio.toFixed(1)+'배 (매수 주체 미확인)']);
    }
  }
  h.push({t:s.t,p:s.p,v:s.v,b:s.b,oi:s.oi});state.history=h.slice(-12);
  p.setProperty(key,JSON.stringify(state));
  for(const [kind,msg] of events){
    if(s.t-(state.sent[kind]||0)<600000)continue;
    telegram(c,'HanaV Futures Radar | 무료 예약 감시\n'+s.label+' · '+kind+'\n'+msg+'\n시세호가 '+localTime(new Date(s.t),'HH:mm:ss')+' KST\nKIS 시세 · 실제 체결 및 현물 동조 확인');
    state.sent[kind]=s.t;p.setProperty(key,JSON.stringify(state));
  }
  return Boolean(old);
}
function news(c){
  const p=prop(), now=Date.now(), sent=JSON.parse(p.getProperty('_NEWS_SENT')||'{}');
  Object.keys(sent).forEach(k=>{if(now-sent[k]>7200000)delete sent[k];});
  let r;
  try{r=UrlFetchApp.fetch('https://news.google.com/rss/search?q='+encodeURIComponent('한국 증시 선물 외국인 금리 환율 when:1d')+'&hl=ko&gl=KR&ceid=KR:ko',{muteHttpExceptions:true});}catch(e){throw Error('News network failure');}
  if(r.getResponseCode()!==200)throw Error('News HTTP '+r.getResponseCode());
  const items=XmlService.parse(r.getContentText()).getRootElement().getChild('channel').getChildren('item');
  let count=0;
  for(const item of items.slice(0,25)){
    const title=item.getChildText('title')||'',link=item.getChildText('link')||'',t=Date.parse(item.getChildText('pubDate'));
    if(!title||!link.startsWith('https://')||!(now-t>=0&&now-t<=1200000)||!/(속보|금리|환율|관세|선물|외국인|실적|공시|반도체)/.test(title))continue;
    const k=Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,title.replace(/\s+/g,''))).slice(0,22);
    if(sent[k])continue;
    telegram(c,'HanaV 뉴스 후보 · 영향력 미검증\n'+title+'\n'+link+'\n원문 및 실제 시세 반응 확인');
    sent[k]=now;p.setProperty('_NEWS_SENT',JSON.stringify(sent));
    if(++count>=3)break;
  }
}

// Resolve front month by stable master underlying ID AND product kind.
// Never guess a contract code or switch to another underlying.
function frontContracts(c){
  const p=prop(), date=localTime(new Date(),'yyyyMMdd');
  const signature=JSON.stringify(c.contracts);
  const cached=JSON.parse(p.getProperty('_FRONT_CACHE')||'null');
  if(cached&&cached.date===date&&cached.signature===signature)return cached.contracts;
  const ids=JSON.parse(p.getProperty('_FRONT_IDENTITIES')||'{}');
  const previous=JSON.parse(p.getProperty('_FRONT_LAST')||'{}');
  const masters={};
  for(const market of [...new Set(c.contracts.map(x=>x[0]))]){
    const filename=market==='F'?'fo_idx_code_mts':'fo_stk_code_mts';
    const kinds=market==='F'?['1','3','7','9','B']:['1','3'];
    const url='https://new.real.download.dws.co.kr/common/master/'+filename+'.mst.zip';
    let response;
    try{response=UrlFetchApp.fetch(url,{muteHttpExceptions:true});}catch(e){throw Error('KIS master network failure: '+market);}
    if(response.getResponseCode()!==200)throw Error('KIS master HTTP '+response.getResponseCode());
    const files=Utilities.unzip(response.getBlob().setContentType('application/zip'));
    const file=files.find(f=>/\.mst$/i.test(f.getName()));
    if(!file)throw Error('KIS master missing');
    let raw;
    try{raw=file.getDataAsString('MS949');}catch(e){raw=file.getDataAsString('EUC-KR');}
    masters[market]=raw.split(/\r?\n/).map(l=>l.split('|').map(v=>v.trim())).filter(f=>f.length===9&&kinds.includes(f[0])&&/^[A-Za-z0-9]{5,12}$/.test(f[1])&&f[7]);
    if(!masters[market].length)throw Error('KIS master format unverified: '+market);
  }
  const resolved=[], next={}, changes=[];
  for(const [market,seed,label] of c.contracts){
    const k=market+':'+seed.toUpperCase(), rows=masters[market];
    let id=ids[k];
    if(!id){
      const exact=rows.filter(f=>f[1].toUpperCase()===seed.toUpperCase());
      if(exact.length!==1)throw Error('Initial contract identity not found: '+market+':'+seed);
      id={kind:exact[0][0],under:exact[0][7]};
    }
    const match=rows.filter(f=>f[0]===id.kind&&f[7]===id.under&&f[6]==='1');
    const codes=[...new Set(match.map(f=>f[1].toUpperCase()))];
    if(codes.length!==1)throw Error('No unique front-month contract: '+market+':'+seed);
    const code=codes[0];
    ids[k]=id;next[k]=code;resolved.push([market,code,label]);
    const old=previous[k]||seed.toUpperCase();
    if(old!==code)changes.push(label+': '+old+' → '+code);
  }
  if(new Set(resolved.map(x=>x[0]+':'+x[1])).size!==resolved.length)throw Error('Duplicate resolved contracts');
  p.setProperty('_FRONT_IDENTITIES',JSON.stringify(ids));
  if(changes.length)telegram(c,'HanaV Futures Radar | 최근월물 변경 (KIS 종목마스터 기준)\n'+changes.join('\n'));
  p.setProperty('_FRONT_LAST',JSON.stringify(next));
  p.setProperty('_FRONT_CACHE',JSON.stringify({date,signature,contracts:resolved}));
  return resolved;
}
function testMaster(){
  const c=cfg(), contracts=frontContracts(c);
  console.log('KIS front-month master verified: '+contracts.map(x=>x.join(',')).join('; '));
}


// Market-level flow: KIS domestic stock-074 (not individual stock investor flows).
const FLOW_MARKETS=[
  ['KOSPI 현물','KSP','0001'],
  ['KOSPI200 선물','K2I','F001'],
  ['콜옵션','K2I','OC01'],
  ['풋옵션','K2I','OP01'],
  ['주식선물 전체','999','S001']
];
const FLOW_PEOPLE=[['외국인','frgn'],['기관','orgn'],['개인','prsn']];
function marketNum(x){if(x===null||x===undefined||String(x).trim()==='')return null;const n=Number(String(x).replace(/,/g,''));return Number.isFinite(n)?n:null;}
function kisMarketGet(c,a,path,tr,params){
  const query=Object.keys(params).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&');
  const j=req(BASE+path+'?'+query,{headers:{authorization:'Bearer '+a,appkey:c.KIS_APP_KEY,appsecret:c.KIS_APP_SECRET,tr_id:tr,custtype:'P'}},'KIS market data');
  if(String(j.rt_cd)!=='0')throw Error('KIS market data rejected: '+String(j.msg_cd||'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24));
  return j;
}
function onlyRow(value){
  if(Array.isArray(value)){if(value.length!==1)throw Error('Ambiguous or missing API rows');value=value[0];}
  if(!value||typeof value!=='object')throw Error('Missing API row');
  return value;
}
function marketFlow(c,a,m){
  const j=kisMarketGet(c,a,'/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market','FHPTJ04030000',{FID_INPUT_ISCD:m[1],FID_INPUT_ISCD_2:m[2]});
  const o=onlyRow(j.output);
  const q=FLOW_PEOPLE.map(x=>marketNum(o[x[1]+'_ntby_qty']));
  const amount=FLOW_PEOPLE.map(x=>marketNum(o[x[1]+'_ntby_tr_pbmn']));
  if(q.some(x=>x===null)||amount.some(x=>x===null))throw Error('Incomplete net-buy fields');
  return {name:m[0],id:m[2],q,amount,at:Date.now()};
}
function nasdaqQuote(c,a){
  const code=(prop().getProperty('NASDAQ_FUTURES_CODE')||'NQZ26').trim().toUpperCase();
  if(!/^NQ[HMUZ]\d{2}$/.test(code))throw Error('Set verified KIS Nasdaq100 E-mini contract code');
  const j=kisMarketGet(c,a,'/uapi/overseas-futureoption/v1/quotations/inquire-price','HHDFC55010000',{SRS_CD:code});
  const o=onlyRow(j.output1), price=marketNum(o.last_price), pct=marketNum(o.prev_diff_rate);
  const expiry=String(o.trd_to_date||o.expr_date||'');
  if(!/^\d{8}$/.test(expiry)||expiry<=localTime(new Date(),'yyyyMMdd'))throw Error('NQ expiry missing or expired; update NASDAQ_FUTURES_CODE');
  if(!(price>0))throw Error('Invalid NQ quote');
  const flag=String(o.prev_diff_flag||'');
  // Only use direction if previous close independently confirms the sign.
  const prev=marketNum(o.prev_price);
  const signed=pct===null||!(prev>0)?null:price===prev?0:Math.sign(price-prev)*Math.abs(pct);
  return {code,price,pct:signed,stamp:String(o.proc_date||'')+' '+String(o.proc_time||''),expiry};
}
function signedNum(v,d=0){return v===null||!Number.isFinite(v)?'미확인':(v>0?'+':'')+v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function currentReport(c,a,quotes,flows,nq){
  const p=prop(), now=new Date();
  // Until the provider's amount scale has been checked against HTS,
  // preserve the exact raw amounts without attaching a currency unit.
  const divisor=marketNum(p.getProperty('FLOW_AMOUNT_DIVISOR'));
  const amountVerified=divisor!==null&&divisor>0;
  const out=['📊 HanaV 장중 선물·수급 브리핑','조회 '+localTime(now,'MM/dd HH:mm:ss')+' KST','','■ 선물 현재가 / 전일대비'];
  for(const row of quotes){
    const s=row.s;
    out.push(row.label+' ('+row.code+') '+(s?s.p.toLocaleString('en-US')+' / '+signedNum(s.dayPct,2)+(s.dayPct===null?'':'%')+' · '+localTime(new Date(s.t),'HH:mm:ss'):'조회 실패/시세 지연'));
  }
  out.push('나스닥100 E-mini '+(nq?nq.code+' '+nq.price.toLocaleString('en-US')+' / '+signedNum(nq.pct,2)+(nq.pct===null?'':'%')+'\n  제공처 처리시각 '+nq.stamp+' (시간대·지연 미검증)':'조회 실패/권한 또는 월물 확인'));
  out.push('','■ 시장별 순매수 · 외국인 / 기관 / 개인','KIS 조회값 · 당일 집계 기준시각은 API 미제공');
  for(const m of FLOW_MARKETS){
    const f=flows.find(x=>x.id===m[2]);
    if(!f){out.push(m[0]+' : 조회 실패/미확인');continue;}
    if(m[2]==='0001'){
      out.push(m[0]+' 금액'+(amountVerified?'(억원)':'(API 원값, 단위 미검증)'));
      out.push('  '+f.amount.map(v=>signedNum(amountVerified?v/divisor:v,amountVerified?1:0)).join(' / '));
    }else{
      out.push(m[0]+' (계약 수량 필드)');
      out.push('  '+f.q.map(v=>signedNum(v)).join(' / '));
    }
  }
  out.push('','+ 순매수 / − 순매도 · 장중 집계는 변동 가능','출처: 한국투자증권 Open API · 투자자별 포지션·매매방향 추정 아님');
  return out.join('\n');
}
function readFlows(c,a){
  const flows=[];
  for(const m of FLOW_MARKETS){try{flows.push(marketFlow(c,a,m));}catch(e){console.warn(m[0]+' flow unavailable');}Utilities.sleep(200);}
  return flows;
}
function readNasdaq(c,a){try{return nasdaqQuote(c,a);}catch(e){console.warn('Nasdaq quote unavailable');return null;}}
function flowEvents(c,flows){
  const p=prop(),date=localTime(new Date(),'yyyyMMdd'), prior=JSON.parse(p.getProperty('_FLOW_PREV')||'{}');
  // Default only significant foreign KOSPI200 futures net-buy changes.
  // No price/position inferred from option activity.
  const limit=marketNum(p.getProperty('FLOW_FUTURES_CHANGE_THRESHOLD'))||1000;
  for(const f of flows){
    const prev=prior[f.id], elapsed=prev?(f.at-prev.at)/60000:0;
    if(f.id==='F001'&&prev&&prev.date===date&&elapsed>=3&&elapsed<=12){
      const diff=f.q[0]-prev.q[0], reversal=prev.q[0]*f.q[0]<0&&Math.abs(diff)>=limit/2;
      if((Math.abs(diff)>=limit||reversal)&&f.at-(prev.lastAlert||0)>=600000){
        telegram(c,'⚡ HanaV 외국인 KOSPI200 선물 수급 변화\n'+(reversal?'순매수/순매도 전환\n':'')+elapsed.toFixed(1)+'분 조회값 변화 '+signedNum(diff)+'계약\n당일 순매수 '+signedNum(f.q[0])+'계약\nKIS 조회 '+localTime(new Date(f.at),'HH:mm:ss')+' (집계 기준시각 미제공)');
        prev.lastAlert=f.at;
      }
    }
    prior[f.id]={date,at:f.at,q:f.q,lastAlert:prev&&prev.date===date?prev.lastAlert||0:0};
  }
  p.setProperty('_FLOW_PREV',JSON.stringify(prior));
}
function reportDue(now){
  const hm=Number(localTime(now,'HHmm')), min=Number(localTime(now,'mm'));
  if(hm<900||hm>1535||min%30>=10)return null;
  const slot=localTime(now,'yyyyMMddHH')+(min<30?'00':'30');
  return prop().getProperty('_REPORT_SLOT')===slot?null:slot;
}
// Manually send a full snapshot to the configured owner chat only.
function testMarketBrief(){
  if(!active(new Date()))throw Error('Run during weekday 08:45–15:45 KST');
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('Radar is already running; retry');
  try{
    const c=cfg(),a=access(c),contracts=frontContracts(c);
    const quotes=contracts.map(x=>{let s=null;try{s=quote(c,a,x);}catch(e){console.warn(x[2]+' quote unavailable');}return {label:x[2],code:x[1],s};});
    const flows=readFlows(c,a),nq=readNasdaq(c,a);
    console.log('Verified responses: domestic '+quotes.filter(x=>x.s).length+'/'+quotes.length+', investor flows '+flows.length+'/5, Nasdaq '+(nq?'1/1':'0/1'));
    telegram(c,'[연동 테스트 · 개인 확인용]\n'+currentReport(c,a,quotes,flows,nq));
  }finally{lock.releaseLock();}
}

function radarTick(){
  if(!active(new Date()))return;
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try{
    const c=cfg(), contracts=frontContracts(c),a=access(c);let ok=0,failed=0;const quotes=[];
    for(const contract of contracts){
      let s=null;
      try{s=quote(c,a,contract);ok++;}catch(e){failed++;console.warn('Contract check failed (no secret values logged)');}
      quotes.push({label:contract[2],code:contract[1],s});
      if(s)try{checkContract(c,a,contract,s);}catch(e){console.warn('Contract event delivery failed');}
      Utilities.sleep(200);
    }
    if((prop().getProperty('MARKET_BRIEF_ENABLED')||'false').toLowerCase()==='true'){
      const flows=readFlows(c,a);
      try{flowEvents(c,flows);}catch(e){console.warn('Flow event delivery failed');}
      const slot=reportDue(new Date());
      if(slot){const nq=readNasdaq(c,a);telegram(c,currentReport(c,a,quotes,flows,nq));prop().setProperty('_REPORT_SLOT',slot);}
    }
    if(c.news)try{news(c);}catch(e){console.warn('News check failed');}
    console.log('Radar: '+ok+' fresh quotes; '+failed+' failed');
    if(!ok)throw Error('No fresh KIS quotes');
  }finally{lock.releaseLock();}
}
// Run manually to verify Telegram and KIS connectivity without placing orders.
// Test sends only a diagnostic, no quote details.
function testRadar(){
  const c=cfg();frontContracts(c);access(c);
  telegram(c,'HanaV Futures Radar: Telegram 발송 및 KIS 인증 성공. 장중 시세 조회는 별도 확인 필요.');
  console.log('Telegram and KIS authentication verified');
}
// Run manually after testRadar succeeds. Existing radar triggers are replaced.
function installRadar(){
  cfg();ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='radarTick').forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('radarTick').timeBased().everyMinutes(5).create();
  console.log('Five-minute radar trigger created');
}
function stopRadar(){
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='radarTick').forEach(t=>ScriptApp.deleteTrigger(t));
}
