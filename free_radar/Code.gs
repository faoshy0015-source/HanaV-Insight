// HanaV free scheduled radar. Paste into a private Google Apps Script project.
// All credentials and monitoring state stay in private Script Properties.
const BASE = 'https://openapi.koreainvestment.com:9443';
const TZ = 'Asia/Seoul';
function prop(){return PropertiesService.getScriptProperties();}
function cfg(){
  const p=prop(), required=['KIS_APP_KEY','KIS_APP_SECRET','FUTURES_CONTRACTS','RADAR_TELEGRAM_BOT_TOKEN','RADAR_TELEGRAM_CHAT_ID'];
  const c={}; required.forEach(k=>{c[k]=(p.getProperty(k)||'').trim();if(!c[k])throw Error('Missing property: '+k);});
  c.contracts=c.FUTURES_CONTRACTS.split(/\r?\n/).filter(x=>x.trim()).map(x=>x.split(',').map(y=>y.trim()));
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
  return {t:stamp,p:price,v:n(o.acml_vol),b:market==='F'?n(o.basis):null,oi:n(o.hts_otst_stpl_qty),label:String(o.hts_kor_isnm||label)};
}
function checkContract(c,a,contract){
  const p=prop(), key='_H_'+contract[0]+'_'+contract[1].toUpperCase(), s=quote(c,a,contract);
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
function radarTick(){
  if(!active(new Date()))return;
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try{
    const c=cfg(),a=access(c);let ok=0,failed=0;
    for(const contract of c.contracts){
      try{checkContract(c,a,contract);ok++;}catch(e){failed++;console.warn('Contract check failed (no secret values logged)');}
      Utilities.sleep(200);
    }
    if(c.news)try{news(c);}catch(e){console.warn('News check failed');}
    console.log('Radar: '+ok+' fresh quotes; '+failed+' failed');
    if(!ok)throw Error('No fresh KIS quotes');
  }finally{lock.releaseLock();}
}
// Run manually to verify Telegram and KIS connectivity without placing orders.
// Test sends only a diagnostic, no quote details.
function testRadar(){
  const c=cfg();access(c);
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
