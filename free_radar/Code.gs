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
  // Hyundai Motor is excluded from this customer's contract radar even if the old property remains.
  c.contracts=c.contracts.filter(([market,code,label])=>market!=='JF'||(code.toUpperCase()!=='A16612'&&!/^(현대차|현대자동차|HYUNDAIMOTOR)/i.test(label.replace(/\s+/g,''))));
  if(!c.contracts.length)throw Error('No monitored contracts remain');
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
  const rawDiff=n(o.futs_prdy_vrss);
  const dayDiff=rawDiff===null?null:['4','5'].includes(sign)?-Math.abs(rawDiff):['1','2'].includes(sign)?Math.abs(rawDiff):sign==='3'&&rawDiff===0?0:null;
  return {t:stamp,p:price,dayPct,dayDiff,v:n(o.acml_vol),b:market==='F'?n(o.basis):null,oi:n(o.hts_otst_stpl_qty),label:String(o.hts_kor_isnm||label)};
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
  let res;
  try{res=UrlFetchApp.fetch(BASE+path+'?'+query,{headers:{authorization:'Bearer '+a,appkey:c.KIS_APP_KEY,appsecret:c.KIS_APP_SECRET,tr_id:tr,custtype:'P','content-type':'application/json; charset=utf-8',tr_cont:''},muteHttpExceptions:true,followRedirects:false});}catch(e){throw Error('KIS market data network failure');}
  let j;try{j=JSON.parse(res.getContentText());}catch(e){}
  const msg=String(j&&j.msg_cd||'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24);
  if(res.getResponseCode()!==200)throw Error('KIS market data HTTP '+res.getResponseCode()+' code '+msg);
  if(!j)throw Error('KIS market data invalid JSON');
  if(String(j.rt_cd)!=='0')throw Error('KIS market data rejected: '+msg);
  return j;
}
function onlyRow(value){
  if(Array.isArray(value)){if(value.length!==1)throw Error('Ambiguous or missing API rows');value=value[0];}
  if(!value||typeof value!=='object')throw Error('Missing API row');
  return value;
}
// HTS 0403 net amounts and net quantities must not be mixed.
function flowFields(o,prefix,isCash){
  const key=prefix+(isCash?'_ntby_tr_pbmn':'_ntby_qty');
  const buy=marketNum(o[prefix+(isCash?'_shnu_tr_pbmn':'_shnu_vol')]);
  const sell=marketNum(o[prefix+(isCash?'_seln_tr_pbmn':'_seln_vol')]);
  const raw=marketNum(o[key]), tolerance=isCash?1:0;
  const valid=raw!==null&&(isCash||Number.isInteger(raw))&&
    (buy===null||sell===null||Math.abs(raw-(buy-sell))<=tolerance);
  return {raw,buy,sell,value:valid?raw:null};
}
function marketFlow(c,a,m){
  const j=kisMarketGet(c,a,'/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market','FHPTJ04030000',{FID_INPUT_ISCD:m[1],FID_INPUT_ISCD_2:m[2]});
  const o=onlyRow(j.output);
  const qty=FLOW_PEOPLE.map(x=>flowFields(o,x[1],false)), money=FLOW_PEOPLE.map(x=>flowFields(o,x[1],true));
  const q=qty.map(x=>x.value),amount=money.map(x=>x.value);
  const relevant=m[2]==='0001'?amount:q;
  if(relevant.every(x=>x===null))throw Error('Incomplete or inconsistent net-buy fields');
  return {name:m[0],id:m[2],q,amount,at:Date.now(),audit:m[2]==='0001'?money:qty};
}
function flowAmountConfig(){
  const divisor=marketNum(prop().getProperty('FLOW_AMOUNT_DIVISOR'));
  // KIS 0403's public field description does not explicitly declare the monetary scale.
  // Use the conventional million-KRW scale provisionally, visibly mark it until HTS verified.
  return Number.isFinite(divisor)&&divisor>0?{divisor,verified:true}:{divisor:100,verified:false};
}
// Official KIS FFCODE_TBL: 223 bytes, including a 50-byte Korean name.
// Parse ASCII fields from bytes, never from decoded Korean character offsets.
function parseNqMaster(bytes){
  const rows=[];let from=0;
  function field(line,a,b){return String.fromCharCode(...line.slice(a,b).map(x=>x&255)).trim();}
  for(let i=0;i<=bytes.length;i++){
    if(i<bytes.length&&(bytes[i]&255)!==10)continue;
    let line=bytes.slice(from,i);from=i+1;
    if(line.length&&(line[line.length-1]&255)===13)line=line.slice(0,-1);
    if(line.length!==223)continue;
    const code=field(line,0,32),exchange=field(line,132,142),product=field(line,142,152);
    if(!/^NQ[HMUZ]\d{2}$/.test(code)||product!=='NQ')continue;
    const calc=marketNum(field(line,160,165)),front=field(line,218,219),spread=field(line,219,220),active=field(line,217,218);
    if(!Number.isInteger(calc)||calc< -6||calc>3||spread==='1'||spread==='Y')continue;
    rows.push({code,exchange,product,calc,front,active,spread});
  }
  return rows;
}
function nqApproxExpiry(code){
  const month={H:2,M:5,U:8,Z:11}[code[2]],year=2000+Number(code.slice(3));
  const first=new Date(Date.UTC(year,month,1)).getUTCDay(),day=1+(5-first+7)%7+14;
  return String(year)+String(month+1).padStart(2,'0')+String(day).padStart(2,'0');
}
function chooseNqMaster(rows,override,date){
  const live=[...new Map(rows.filter(x=>nqApproxExpiry(x.code)>=date).map(x=>[x.code,x])).values()].sort((a,b)=>nqApproxExpiry(a.code).localeCompare(nqApproxExpiry(b.code)));
  if(override)return live.find(x=>x.code===override)||null;
  const near=live.filter(x=>x.front==='1');
  return near.length===1?near[0]:live[0]||null;
}
function nasdaqMaster(){
  const p=prop(),date=localTime(new Date(),'yyyyMMdd');
  const override=(p.getProperty('NASDAQ_FUTURES_CODE')||'').trim().toUpperCase();
  if(override&&!/^NQ[HMUZ]\d{2}$/.test(override))throw Error('NQ master: invalid override');
  const cache=JSON.parse(p.getProperty('_NQ_MASTER_R6')||'null');
  if(cache&&cache.date===date&&cache.override===override)return cache.row;
  const url='https://new.real.download.dws.co.kr/common/master/ffcode.mst.zip';
  let res;try{res=UrlFetchApp.fetch(url,{muteHttpExceptions:true});}catch(e){throw Error('NQ master: network failure');}
  if(res.getResponseCode()!==200)throw Error('NQ master: HTTP '+res.getResponseCode());
  const files=Utilities.unzip(res.getBlob().setContentType('application/zip'));
  const file=files.find(x=>/ffcode\.mst$/i.test(x.getName()));
  if(!file)throw Error('NQ master: file missing');
  const rows=parseNqMaster(file.getBytes());
  console.log('NQ master candidates: '+(rows.map(x=>x.code+' near='+x.front+' scale='+x.calc).join('; ')||'none'));
  const row=chooseNqMaster(rows,override,date);
  if(!row)throw Error('NQ master: no unique front contract');
  p.setProperty('_NQ_MASTER_R6',JSON.stringify({date,override,row}));
  console.log('NQ master verified: '+row.code+' / '+row.exchange+' / scale '+row.calc);
  return row;
}
function nasdaqQuote(c,a){
  const master=nasdaqMaster(),code=master.code;
  const j=kisMarketGet(c,a,'/uapi/overseas-futureoption/v1/quotations/inquire-price','HHDFC55010000',{SRS_CD:code});
  const o=onlyRow(j.output1),scale=Math.pow(10,master.calc),priceRaw=marketNum(o.last_price),prevRaw=marketNum(o.prev_price);
  const price=priceRaw===null?null:priceRaw*scale,prev=prevRaw===null?null:prevRaw*scale;
  const expiry=String(o.trd_to_date||o.expr_date||'');
  if(!/^\d{8}$/.test(expiry)||expiry<localTime(new Date(),'yyyyMMdd'))throw Error('NQ expiry missing or expired');
  if(!(price>0))throw Error('Invalid NQ quote');
  const date=String(o.proc_date||''),time=String(o.proc_time||'');
  if(!/^\d{8}$/.test(date)||!/^\d{6}$/.test(time))throw Error('NQ timestamp missing');
  const today=localTime(new Date(),'yyyyMMdd'),yesterday=localTime(new Date(Date.now()-86400000),'yyyyMMdd');
  if(date!==today&&date!==yesterday)throw Error('NQ stale date');
  const pct=prev>0?(price/prev-1)*100:null;
  return {code,price,pct,diff:prev>0?price-prev:null,stamp:date+' '+time,expiry};
}
function signedNum(v,d=0){return v===null||!Number.isFinite(v)?'미확인':(v>0?'+':'')+v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function currentReport(c,a,quotes,flows,nq){
  const p=prop(), now=new Date();
  const {divisor,verified:amountVerified}=flowAmountConfig();
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
      out.push(m[0]+' 순매수대금'+(amountVerified?'(억원)':'(억원* · 잠정 환산)'));
      out.push('  '+f.amount.map(v=>signedNum(v===null?null:v/divisor,0)).join(' / '));
    }else{
      out.push(m[0]+' (계약 수량 필드)');
      out.push('  '+f.q.map(v=>signedNum(v)).join(' / '));
    }
  }
  out.push('','+ 순매수 / − 순매도 · 장중 집계는 변동 가능');
  if(!amountVerified)out.push('* 현물 API 원값 ÷100 잠정 환산 · HTS 대조 필요');
  out.push('출처: 한국투자증권 Open API · 투자자별 포지션·매매방향 추정 아님');
  return out.join('\n');
}
function readFlows(c,a){
  const flows=[];
  for(const m of FLOW_MARKETS){try{flows.push(marketFlow(c,a,m));}catch(e){console.warn(m[0]+' flow unavailable');}Utilities.sleep(200);}
  return flows;
}
function readNasdaq(c,a){
  try{return nasdaqQuote(c,a);}catch(e){
    const msg=String(e.message||'');
    const safe=/^(KIS market data (rejected: [a-zA-Z0-9_-]+|HTTP \d+ code [a-zA-Z0-9_-]+|network failure|invalid JSON)|NQ master: (invalid override|network failure|HTTP \d+|file missing|no unique front contract)|Ambiguous or missing API rows|Missing API row|NQ expiry missing or expired|Invalid NQ quote|NQ timestamp missing|NQ stale date)$/.test(msg)?msg:'unknown response issue';
    console.warn('Nasdaq quote unavailable: '+safe);return null;
  }
}
// Run manually during the market to compare against the same-time HTS 0403 screen.
// No credentials, account information or URLs are printed.
function testFlowUnits(){
  if(!active(new Date()))throw Error('Run during weekday 08:45–15:45 KST');
  const c=cfg(),a=access(c),flows=readFlows(c,a),ac=flowAmountConfig();
  console.log('HTS comparison '+localTime(new Date(),'yyyy-MM-dd HH:mm:ss')+' KST; cash divisor '+ac.divisor+'; '+(ac.verified?'configured':'provisional'));
  for(const f of flows){
    console.log(f.name+' | 외국인 / 기관 / 개인 | raw '+f.audit.map(x=>String(x.raw)).join(' / '));
    console.log(f.name+' | buy '+f.audit.map(x=>String(x.buy)).join(' / ')+' | sell '+f.audit.map(x=>String(x.sell)).join(' / '));
    console.log(f.name+' | display '+(f.id==='0001'?f.amount.map(v=>signedNum(v===null?null:v/ac.divisor,0)):f.q.map(v=>signedNum(v,0))).join(' / '));
  }
  const nq=readNasdaq(c,a);console.log('Nasdaq data '+(nq?'available '+nq.code:'unavailable; CME API subscription may be required'));
}
function flowEvents(c,flows){
  const p=prop(),date=localTime(new Date(),'yyyyMMdd'), prior=JSON.parse(p.getProperty('_FLOW_PREV')||'{}');
  // Default only significant foreign KOSPI200 futures net-buy changes.
  // No price/position inferred from option activity.
  const limit=marketNum(p.getProperty('FLOW_FUTURES_CHANGE_THRESHOLD'))||1000;
  for(const f of flows){
    const prev=prior[f.id], elapsed=prev?(f.at-prev.at)/60000:0;
    if(f.id==='F001'&&prev&&prev.date===date&&elapsed>=3&&elapsed<=12&&Number.isFinite(f.q[0])&&Number.isFinite(prev.q[0])){
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

// Private Google Slides canvas -> PNG -> Telegram. No external chart rendering.
// Enable the Google Slides API advanced service (identifier Slides) once.
function setupBriefCanvas(){
  const p=prop();
  if(p.getProperty('BRIEF_CANVAS_ID')){
    console.log('Canvas already exists: https://docs.google.com/presentation/d/'+p.getProperty('BRIEF_CANVAS_ID')+'/edit');
    return;
  }
  if(typeof Slides==='undefined')throw Error('Enable Google Slides API in Services first');
  const deck=Slides.Presentations.create({title:'HanaV Brief Canvas (private)'});
  const id=deck.presentationId, doc=Slides.Presentations.get(id);
  let page;
  if(!doc.slides||!doc.slides.length){
    page='hanav_brief_page';
    Slides.Presentations.batchUpdate({requests:[{createSlide:{objectId:page,slideLayoutReference:{predefinedLayout:'BLANK'}}}]},id);
  }else{
    page=doc.slides[0].objectId;
    const requests=(doc.slides[0].pageElements||[]).map(e=>({deleteObject:{objectId:e.objectId}}));
    if(requests.length)Slides.Presentations.batchUpdate({requests},id);
  }
  p.setProperties({BRIEF_CANVAS_ID:id,BRIEF_CANVAS_PAGE:page});
  console.log('Private canvas: https://docs.google.com/presentation/d/'+id+'/edit');
  console.log('Page setup is automatic; no manual Slides editing required.');
}
function briefColor(v){return v===null||!Number.isFinite(v)||v===0?'#64748B':v>0?'#CF2639':'#2056C7';}
function rgbBrief(h){return {red:parseInt(h.slice(1,3),16)/255,green:parseInt(h.slice(3,5),16)/255,blue:parseInt(h.slice(5,7),16)/255};}
function briefSigned(v,dec=0){return v===null||!Number.isFinite(v)?'미확인':signedNum(v,dec);}
function briefPrice(v,dec){return v===null||!Number.isFinite(v)?'미확인':v.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});}
function briefHistory(row){
  if(!row||!row.s)return [];
  const market=row.market||(/KOSPI/i.test(row.label)?'F':'JF');
  const state=JSON.parse(prop().getProperty('_H_'+market+'_'+row.code.toUpperCase())||'{}');
  const cur=row.s.t;
  const items=(state.history||[]).filter(x=>Number.isFinite(x.p)&&x.p>0&&Number.isFinite(x.t)&&x.t<=cur&&x.t>=cur-1800000);
  items.push({t:cur,p:row.s.p});
  return [...new Map(items.map(x=>[x.t,x])).values()].sort((a,b)=>a.t-b.t);
}
function briefSummary(quotes,flows,nq){
  const f=flows.find(x=>x.id==='F001'), cash=flows.find(x=>x.id==='0001');
  const direction=v=>!Number.isFinite(v)?'미확인':v>0?'순매수':v<0?'순매도':'보합';
  const lines=[];
  if(f&&cash)lines.push('외국인: 현물 '+direction(cash.amount[0])+' · 지수선물 '+direction(f.q[0]));
  else if(f)lines.push('외국인 지수선물 '+direction(f.q[0])+' '+briefSigned(f.q[0])+'계약');
  else lines.push('외국인 지수선물 수급 미확인');
  const chip=quotes.filter(r=>/삼성전자|SK하이닉스/i.test(r.label)&&r.s&&Number.isFinite(r.s.dayPct));
  if(chip.length)lines.push(chip.map(r=>r.label.replace(/\s*선물.*/,'')+' '+briefSigned(r.s.dayPct,2)+'%').join('  /  '));
  else lines.push('반도체 선물 등락률 미확인');
  if(nq&&Number.isFinite(nq.pct))lines.push('나스닥100 선물 '+briefSigned(nq.pct,2)+'% · 지연 여부 미확인');
  else lines.push('나스닥100 선물 시세 미확인');
  return lines;
}
function renderBriefImage(quotes,flows,nq,isTest){
  const p=prop(), id=p.getProperty('BRIEF_CANVAS_ID'), page=p.getProperty('BRIEF_CANVAS_PAGE');
  if(!id||!page||typeof Slides==='undefined')throw Error('Run setupBriefCanvas and enable Google Slides API');
  const doc=Slides.Presentations.get(id);
  if(doc.title!=='HanaV Brief Canvas (private)'||!doc.slides||doc.slides.length!==1||doc.slides[0].objectId!==page)throw Error('Use only dedicated one-slide HanaV canvas');
  const toPt=d=>d.unit==='PT'?d.magnitude:d.unit==='EMU'?d.magnitude/12700:NaN;
  const W=toPt(doc.pageSize.width),H=toPt(doc.pageSize.height);
  if(!(W>0&&H>0))throw Error('Invalid canvas size');
  // Fit the portrait content onto the existing canvas without changing its page size.
  const sf=Math.min(W/600,H/788),sx=sf,sy=sf;
  const contentW=600*sx,contentH=788*sy,offX=(W-contentW)/2,offY=(H-contentH)/2;
  const now=new Date(), tag='hb_'+Date.now().toString(36)+'_',requests=[];
  let seq=0;
  for(const e of doc.slides[0].pageElements||[]){
    if(!/^hb_/.test(e.objectId))throw Error('Canvas contains non-HanaV elements; use dedicated blank page');
    requests.push({deleteObject:{objectId:e.objectId}});
  }
  const newId=()=>tag+(++seq);
  const dim=m=>({magnitude:m,unit:'PT'});
  const rgb=h=>({rgbColor:rgbBrief(h)});
  const NAVY='#102D4F',INK='#172638',TEAL='#087C78',MUTED='#64748B',BORDER='#DCE4ED';
  requests.push({updatePageProperties:{objectId:page,pageProperties:{pageBackgroundFill:{solidFill:{color:rgb('#FFFFFF'),alpha:1}}},fields:'pageBackgroundFill'}});
  function box(x,y,w,h,fill,outline=null,angle=0){
    const oid=newId(),co=Math.cos(angle),si=Math.sin(angle);
    requests.push({createShape:{objectId:oid,shapeType:'RECTANGLE',elementProperties:{pageObjectId:page,size:{width:dim(w*sx),height:dim(h*sy)},transform:{scaleX:co,scaleY:co,shearX:-si* sx/sy,shearY:si*sy/sx,translateX:offX+x*sx,translateY:offY+y*sy,unit:'PT'}}}});
    const shapeProperties={shapeBackgroundFill:{solidFill:{color:rgb(fill),alpha:1}},outline:outline?{outlineFill:{solidFill:{color:rgb(outline),alpha:1}},weight:dim(0.8*sf),dashStyle:'SOLID'}:{propertyState:'NOT_RENDERED'}};
    requests.push({updateShapeProperties:{objectId:oid,shapeProperties,fields:'shapeBackgroundFill,outline'}});
    return oid;
  }
  function txt(s,x,y,w,h,size=14,color=INK,bold=false,align='START'){
    const oid=newId();
    requests.push({createShape:{objectId:oid,shapeType:'TEXT_BOX',elementProperties:{pageObjectId:page,size:{width:dim((w+8)*sx),height:dim((h+8)*sy)},transform:{scaleX:1,scaleY:1,translateX:offX+(x-4)*sx,translateY:offY+(y-4)*sy,unit:'PT'}}}});
    // Text boxes use native defaults; no shape-property update on text.
    requests.push({insertText:{objectId:oid,text:String(s)}});
    requests.push({updateTextStyle:{objectId:oid,textRange:{type:'ALL'},style:{fontFamily:'Noto Sans KR',fontSize:dim(size*sf),bold,foregroundColor:{opaqueColor:rgb(color)}},fields:'fontFamily,fontSize,bold,foregroundColor'}});
    requests.push({updateParagraphStyle:{objectId:oid,textRange:{type:'ALL'},style:{alignment:align,spaceAbove:dim(0),spaceBelow:dim(0),lineSpacing:100},fields:'alignment,spaceAbove,spaceBelow,lineSpacing'}});
  }
  function line(x1,y1,x2,y2,color){
    const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);
    if(len>0.01)box(x1,y1,len,1.7,color,null,Math.atan2(dy,dx));
  }
  function spark(points,x,y,w,h){
    if(points.length<3){txt('추세 데이터 대기',x,y,w,h,9,MUTED,false,'CENTER');return;}
    const lo=Math.min(...points.map(v=>v.p)),hi=Math.max(...points.map(v=>v.p));
    const last=points[points.length-1],first=points[0], span=last.t-first.t;
    if(span<=0){txt('추세 데이터 대기',x,y,w,h,9,MUTED,false,'CENTER');return;}
    const color=briefColor(last.p-first.p);
    const coords=points.map(v=>[x+w*(v.t-first.t)/span,y+h*(hi===lo?0.5:1-(v.p-lo)/(hi-lo))]);
    for(let i=1;i<coords.length;i++)if(points[i].t-points[i-1].t<=8*60000)line(...coords[i-1],...coords[i],color);
    txt('최근 '+Math.round(span/60000)+'분 · '+points.length+'회',x,y+h+3,w,14,8.5,MUTED,false,'CENTER');
  }
  box(0,0,600,96,NAVY);box(21,20,5,54,'#1CD7BF');
  txt('HanaV Futures Brief',36,12,360,23,15,'#BDEAE5',true);
  txt('장중 선물·수급 브리핑',36,34,525,38,27,'#FFFFFF',true);
  txt((isTest?'연동 테스트  |  ':'')+localTime(now,'yyyy.MM.dd HH:mm:ss')+' KST 조회',36,72,530,18,11,'#DDEAF3');
  txt('01   주요 선물 시세',23,106,550,27,19,NAVY,true);
  const wanted=[
    {label:'KOSPI200 선물',row:quotes.find(r=>/KOSPI\s*200/i.test(r.label)),dec:2},
    {label:'삼성전자 선물',row:quotes.find(r=>/삼성전자/.test(r.label)),dec:0},
    {label:'SK하이닉스 선물',row:quotes.find(r=>/SK하이닉스/i.test(r.label)),dec:0},
    {label:'나스닥100 선물',row:null,dec:2,overseas:true}
  ];
  wanted.forEach((m,i)=>{
    const x=23+(i%2)*282,y=140+Math.floor(i/2)*112,w=272,h=102;
    box(x,y,w,h,'#F8FAFC',BORDER);
    txt(m.label,x+12,y+8,w-24,19,15,NAVY,true);
    const s=m.overseas?nq:m.row&&m.row.s;
    const price=s?(m.overseas?s.price:s.p):null,pct=s?(m.overseas?s.pct:s.dayPct):null;
    const change=s?(m.overseas?s.diff:s.dayDiff):null;
    txt(briefPrice(price,m.dec),x+12,y+28,164,34,price===null?19:25,INK,true);
    txt((Number.isFinite(change)?briefSigned(change,m.dec)+'  ':'')+(Number.isFinite(pct)?'('+briefSigned(pct,2)+'%)':'등락률 미확인'),x+12,y+62,w-24,19,13,briefColor(pct),true);
    if(m.overseas){
      txt(s?'처리 '+String(s.stamp).replace(/[^0-9 :\-]/g,'').slice(0,22)+' · 지연 미확인':'CME API 시세 권한 확인 필요',x+12,y+82,w-24,15,9,MUTED);
    }else{
      if(s)spark(briefHistory(m.row),x+181,y+30,79,26);
      txt(s?m.row.code+'  |  '+localTime(new Date(s.t),'HH:mm:ss'):'시세 조회 실패',x+12,y+82,w-24,15,9,MUTED);
    }
  });
  txt('02   투자주체별 당일 순매수',23,364,550,28,19,NAVY,true);
  const {divisor,verified:amountVerified}=flowAmountConfig();
  const xs=[23,202,327,452],ws=[179,125,125,125],top=400,rh=39;
  ['구분','외국인','기관','개인'].forEach((label,i)=>{box(xs[i],top,ws[i],34,NAVY);txt(label,xs[i]+4,top+4,ws[i]-8,26,15,'#FFFFFF',true,'CENTER');});
  FLOW_MARKETS.forEach((m,i)=>{
    const y=top+34+i*rh,f=flows.find(v=>v.id===m[2]),cash=m[2]==='0001';
    const name=cash?'코스피 현물':m[2]==='F001'?'코스피200 선물':m[0];
    const unit=cash?(amountVerified?'억원':'억원*'):'계약';
    box(xs[0],y,ws[0],rh,i%2?'#F2F6FA':'#F8FAFC',BORDER);
    txt(name,xs[0]+9,y+3,ws[0]-18,20,13.5,INK,true);
    txt(unit,xs[0]+9,y+22,ws[0]-18,13,9,MUTED);
    for(let j=0;j<3;j++){
      const val=f?(cash?(f.amount[j]===null?null:f.amount[j]/divisor):f.q[j]):null;
      box(xs[j+1],y,ws[j+1],rh,i%2?'#F2F6FA':'#FFFFFF',BORDER);
      const value=briefSigned(val,0);
      txt(value,xs[j+1]+3,y+4,ws[j+1]-6,rh-8,value.length>12?10.5:value.length>9?13:17,briefColor(val),true,'END');
    }
  });
  txt('03   핵심 시황',23,638,554,25,19,NAVY,true);
  box(23,668,554,69,'#E8F5F3');
  briefSummary(quotes,flows,nq).forEach((s,i)=>{box(34,679+i*19,5,5,TEAL);txt(s,48,671+i*19,515,19,12,INK,true);});
  txt('출처: KIS Open API  |  수급 집계 기준시각 미제공 · 조회값 기준',23,744,554,16,10,MUTED);
  txt(amountVerified?'장중 수치는 변동 가능 · 투자자별 포지션 추정 아님':'* 현물 원값 ÷100 잠정 환산 · HTS 대조 필요 · 지연 가능',23,761,554,15,9,MUTED);
  // Send the exact field masks as JSON, without advanced-service serialization.
  const result=UrlFetchApp.fetch('https://slides.googleapis.com/v1/presentations/'+encodeURIComponent(id)+':batchUpdate',{
    method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},
    payload:JSON.stringify({requests,writeControl:{requiredRevisionId:doc.revisionId}}),muteHttpExceptions:true});
  if(result.getResponseCode()!==200){
    let detail='';try{detail=String(JSON.parse(result.getContentText()).error.message||'').slice(0,350);}catch(e){}
    throw Error('Slides batch HTTP '+result.getResponseCode()+': '+detail);
  }
  console.log('R6: Slides drawing complete');
  const thumbnail=Slides.Presentations.Pages.getThumbnail(id,page,{'thumbnailProperties.mimeType':'PNG','thumbnailProperties.thumbnailSize':'LARGE'});
  if(!thumbnail.contentUrl)throw Error('Brief thumbnail missing');
  const image=UrlFetchApp.fetch(thumbnail.contentUrl,{muteHttpExceptions:true});
  if(image.getResponseCode()!==200)throw Error('Brief thumbnail fetch failed');
  const blob=image.getBlob();
  if(!/^image\/png/i.test(blob.getContentType()))throw Error('Brief thumbnail is not PNG');
  const cropped=hanavPngCrop(blob.getBytes(),offX/W,offY/H,contentW/W,contentH/H);
  return Utilities.newBlob(Array.from(cropped,v=>v>127?v-256:v),'image/png','HanaV_Futures_Brief.png');
}
function sendBriefImage(c,quotes,flows,nq,isTest){
  const photo=renderBriefImage(quotes,flows,nq,isTest);
  let res;
  try{
    res=UrlFetchApp.fetch('https://api.telegram.org/bot'+c.RADAR_TELEGRAM_BOT_TOKEN+'/sendPhoto',{method:'post',payload:{chat_id:c.RADAR_TELEGRAM_CHAT_ID,photo,caption:(isTest?'[연동 테스트] ':'')+'HanaV 장중 선물·수급 브리핑 | '+localTime(new Date(),'MM/dd HH:mm')+' KST'+(nq?'':'\n나스닥 선물 지연시세 직접 확인: https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.quotes.html')},muteHttpExceptions:true});
  }catch(e){throw Error('Telegram image network failure');}
  if(res.getResponseCode()!==200)throw Error('Telegram image HTTP '+res.getResponseCode());
  let body;try{body=JSON.parse(res.getContentText());}catch(e){throw Error('Telegram image response invalid');}
  if(!body.ok)throw Error('Telegram image rejected');
}
// Enable only after testMarketBrief successfully sends an image.
function enableMarketBrief(){
  const p=prop();
  if(!p.getProperty('BRIEF_CANVAS_ID')||p.getProperty('_BRIEF_IMAGE_TEST_OK')!=='true')throw Error('Complete image test first');
  p.setProperty('MARKET_BRIEF_ENABLED','true');
  console.log('30-minute image briefing enabled; existing radar trigger unchanged');
}
function disableMarketBrief(){
  prop().setProperty('MARKET_BRIEF_ENABLED','false');
  console.log('Periodic image briefing disabled; radar stays active');
}

function testMarketBrief(){
  console.log('HanaV image build: 2026-11-25-R6');
  if(!active(new Date()))throw Error('Run during weekday 08:45–15:45 KST');
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('Radar is already running; retry');
  try{
    const c=cfg(),a=access(c),contracts=frontContracts(c);
    const quotes=contracts.map(x=>{let s=null;try{s=quote(c,a,x);}catch(e){console.warn(x[2]+' quote unavailable');}return {market:x[0],label:x[2],code:x[1],s};});
    const flows=readFlows(c,a),nq=readNasdaq(c,a);
    console.log('Verified responses: domestic '+quotes.filter(x=>x.s).length+'/'+quotes.length+', investor flows '+flows.length+'/5, Nasdaq '+(nq?'1/1':'0/1'));
    prop().deleteProperty('_BRIEF_IMAGE_TEST_OK');
    sendBriefImage(c,quotes,flows,nq,true);
    prop().setProperty('_BRIEF_IMAGE_TEST_OK','true');
    console.log('Telegram briefing PNG delivered');
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
      quotes.push({market:contract[0],label:contract[2],code:contract[1],s});
      if(s)try{checkContract(c,a,contract,s);}catch(e){console.warn('Contract event delivery failed');}
      Utilities.sleep(200);
    }
    if((prop().getProperty('MARKET_BRIEF_ENABLED')||'false').toLowerCase()==='true'){
      const flows=readFlows(c,a);
      try{flowEvents(c,flows);}catch(e){console.warn('Flow event delivery failed');}
      const slot=reportDue(new Date());
      if(slot){const nq=readNasdaq(c,a);try{sendBriefImage(c,quotes,flows,nq,false);}catch(e){console.warn('Image unavailable; delivering text fallback');telegram(c,'[이미지 생성 실패 · 텍스트 대체]\n'+currentReport(c,a,quotes,flows,nq));}prop().setProperty('_REPORT_SLOT',slot);}
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


// Crop the private Slides thumbnail locally in Apps Script. No external renderer.
// PNG 8-bit non-interlaced grayscale/RGB/indexed/alpha; also packed palette samples.
function hanavPngCrop(bytes,left,top,width,height){
  const b=Uint8Array.from(bytes,v=>v&255);
  const sig=[137,80,78,71,13,10,26,10];
  if(!sig.every((v,i)=>b[i]===v))throw Error('Invalid PNG signature');
  const read=(a,i)=>((a[i]*16777216)+(a[i+1]<<16)+(a[i+2]<<8)+a[i+3])>>>0;
  const be=n=>Uint8Array.of(n>>>24,n>>>16,n>>>8,n);
  const join=parts=>{const a=new Uint8Array(parts.reduce((n,v)=>n+v.length,0));let p=0;for(const v of parts){a.set(v,p);p+=v.length;}return a;};
  let W,H,depth,type,interlace,plte=null,trns=null;const data=[];
  for(let p=8;p+12<=b.length;){
    const n=read(b,p),tag=String.fromCharCode(...b.subarray(p+4,p+8));
    if(p+12+n>b.length)throw Error('Truncated PNG');
    const v=b.subarray(p+8,p+8+n);
    if(tag==='IHDR'){W=read(v,0);H=read(v,4);depth=v[8];type=v[9];interlace=v[12];}
    if(tag==='PLTE')plte=v;if(tag==='tRNS')trns=v;
    if(tag==='IDAT')data.push(v);
    p+=n+12;if(tag==='IEND')break;
  }
  const channels={0:1,2:3,3:1,4:2,6:4}[type];
  if(!(W>0&&H>0&&W*H<=6000000&&channels&&interlace===0&&data.length))throw Error('Unsupported PNG layout');
  if(!(depth===8||((type===0||type===3)&&[1,2,4].includes(depth))))throw Error('Unsupported PNG depth');
  if(type===3&&(!plte||plte.length%3!==0))throw Error('PNG palette missing');
  // Coordinates are ratios, so dimensions work for every Slides thumbnail size.
  const x0=Math.max(0,Math.min(W-1,Math.round(left*W)));
  const y0=Math.max(0,Math.min(H-1,Math.round(top*H)));
  const w=Math.max(1,Math.min(W-x0,Math.round(width*W)));
  const h=Math.max(1,Math.min(H-y0,Math.round(height*H)));
  const stride=Math.ceil(W*channels*depth/8),bpp=Math.max(1,Math.ceil(channels*depth/8));
  const raw=HanaVPako.inflate(join(data));
  if(raw.length!==H*(stride+1))throw Error('PNG scanline length mismatch');
  const out=new Uint8Array(h*(1+w*3));let prev=new Uint8Array(stride),cur=new Uint8Array(stride);
  function paeth(a,b,c){const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;}
  for(let y=0;y<H;y++){
    const start=y*(stride+1),filter=raw[start];
    if(filter>4)throw Error('Unsupported PNG filter');
    for(let j=0;j<stride;j++){
      const a=j>=bpp?cur[j-bpp]:0,up=prev[j],ul=j>=bpp?prev[j-bpp]:0;
      const pred=filter===0?0:filter===1?a:filter===2?up:filter===3?((a+up)>>1):paeth(a,up,ul);
      cur[j]=(raw[start+1+j]+pred)&255;
    }
    if(y>=y0&&y<y0+h){
      let dst=(y-y0)*(1+w*3)+1;
      for(let x=x0;x<x0+w;x++){
        let R,G,B,A=255;
        if(type===0||type===3){
          const mask=(1<<depth)-1,bit=x*depth,v=(cur[bit>>3]>>(8-depth-(bit%8)))&mask;
          if(type===3){R=plte[v*3];G=plte[v*3+1];B=plte[v*3+2];A=trns&&v<trns.length?trns[v]:255;}
          else{R=G=B=Math.round(v*255/mask);if(trns&&v===((trns[0]<<8)|trns[1]))A=0;}
        }else if(type===2){R=cur[x*3];G=cur[x*3+1];B=cur[x*3+2];if(trns&&R===((trns[0]<<8)|trns[1])&&G===((trns[2]<<8)|trns[3])&&B===((trns[4]<<8)|trns[5]))A=0;}
        else if(type===4){R=G=B=cur[x*2];A=cur[x*2+1];}
        else{R=cur[x*4];G=cur[x*4+1];B=cur[x*4+2];A=cur[x*4+3];}
        out[dst++]=Math.round((R*A+255*(255-A))/255);
        out[dst++]=Math.round((G*A+255*(255-A))/255);
        out[dst++]=Math.round((B*A+255*(255-A))/255);
      }
    }
    const swap=prev;prev=cur;cur=swap;
  }
  return hanavEncodePng(w,h,out);
}
function hanavEncodePng(w,h,raw){
  const be=n=>Uint8Array.of(n>>>24,n>>>16,n>>>8,n);
  const join=parts=>{const a=new Uint8Array(parts.reduce((n,v)=>n+v.length,0));let p=0;for(const v of parts){a.set(v,p);p+=v.length;}return a;};
  const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);return c>>>0;});
  const chunk=(tag,v)=>{const d=join([Uint8Array.from(tag,s=>s.charCodeAt(0)),v]);let crc=0xffffffff;for(const x of d)crc=crcTable[(crc^x)&255]^(crc>>>8);return join([be(v.length),d,be((crc^0xffffffff)>>>0)]);};
  return join([Uint8Array.of(137,80,78,71,13,10,26,10),chunk('IHDR',join([be(w),be(h),Uint8Array.of(8,2,0,0,0)])),chunk('IDAT',HanaVPako.deflate(raw,{level:3})),chunk('IEND',new Uint8Array(0))]);
}

/* Bundled pako 2.1.0, MIT AND Zlib.
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
var HanaVPako=(function(){var exports={},module={exports:exports};
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t="undefined"!=typeof globalThis?globalThis:t||self).pako={})}(this,(function(t){"use strict";function e(t){let e=t.length;for(;--e>=0;)t[e]=0}const a=256,i=286,n=30,s=15,r=new Uint8Array([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]),o=new Uint8Array([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]),l=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7]),h=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),d=new Array(576);e(d);const _=new Array(60);e(_);const f=new Array(512);e(f);const c=new Array(256);e(c);const u=new Array(29);e(u);const w=new Array(n);function m(t,e,a,i,n){this.static_tree=t,this.extra_bits=e,this.extra_base=a,this.elems=i,this.max_length=n,this.has_stree=t&&t.length}let b,g,p;function k(t,e){this.dyn_tree=t,this.max_code=0,this.stat_desc=e}e(w);const v=t=>t<256?f[t]:f[256+(t>>>7)],y=(t,e)=>{t.pending_buf[t.pending++]=255&e,t.pending_buf[t.pending++]=e>>>8&255},x=(t,e,a)=>{t.bi_valid>16-a?(t.bi_buf|=e<<t.bi_valid&65535,y(t,t.bi_buf),t.bi_buf=e>>16-t.bi_valid,t.bi_valid+=a-16):(t.bi_buf|=e<<t.bi_valid&65535,t.bi_valid+=a)},z=(t,e,a)=>{x(t,a[2*e],a[2*e+1])},A=(t,e)=>{let a=0;do{a|=1&t,t>>>=1,a<<=1}while(--e>0);return a>>>1},E=(t,e,a)=>{const i=new Array(16);let n,r,o=0;for(n=1;n<=s;n++)o=o+a[n-1]<<1,i[n]=o;for(r=0;r<=e;r++){let e=t[2*r+1];0!==e&&(t[2*r]=A(i[e]++,e))}},R=t=>{let e;for(e=0;e<i;e++)t.dyn_ltree[2*e]=0;for(e=0;e<n;e++)t.dyn_dtree[2*e]=0;for(e=0;e<19;e++)t.bl_tree[2*e]=0;t.dyn_ltree[512]=1,t.opt_len=t.static_len=0,t.sym_next=t.matches=0},Z=t=>{t.bi_valid>8?y(t,t.bi_buf):t.bi_valid>0&&(t.pending_buf[t.pending++]=t.bi_buf),t.bi_buf=0,t.bi_valid=0},U=(t,e,a,i)=>{const n=2*e,s=2*a;return t[n]<t[s]||t[n]===t[s]&&i[e]<=i[a]},S=(t,e,a)=>{const i=t.heap[a];let n=a<<1;for(;n<=t.heap_len&&(n<t.heap_len&&U(e,t.heap[n+1],t.heap[n],t.depth)&&n++,!U(e,i,t.heap[n],t.depth));)t.heap[a]=t.heap[n],a=n,n<<=1;t.heap[a]=i},D=(t,e,i)=>{let n,s,l,h,d=0;if(0!==t.sym_next)do{n=255&t.pending_buf[t.sym_buf+d++],n+=(255&t.pending_buf[t.sym_buf+d++])<<8,s=t.pending_buf[t.sym_buf+d++],0===n?z(t,s,e):(l=c[s],z(t,l+a+1,e),h=r[l],0!==h&&(s-=u[l],x(t,s,h)),n--,l=v(n),z(t,l,i),h=o[l],0!==h&&(n-=w[l],x(t,n,h)))}while(d<t.sym_next);z(t,256,e)},T=(t,e)=>{const a=e.dyn_tree,i=e.stat_desc.static_tree,n=e.stat_desc.has_stree,r=e.stat_desc.elems;let o,l,h,d=-1;for(t.heap_len=0,t.heap_max=573,o=0;o<r;o++)0!==a[2*o]?(t.heap[++t.heap_len]=d=o,t.depth[o]=0):a[2*o+1]=0;for(;t.heap_len<2;)h=t.heap[++t.heap_len]=d<2?++d:0,a[2*h]=1,t.depth[h]=0,t.opt_len--,n&&(t.static_len-=i[2*h+1]);for(e.max_code=d,o=t.heap_len>>1;o>=1;o--)S(t,a,o);h=r;do{o=t.heap[1],t.heap[1]=t.heap[t.heap_len--],S(t,a,1),l=t.heap[1],t.heap[--t.heap_max]=o,t.heap[--t.heap_max]=l,a[2*h]=a[2*o]+a[2*l],t.depth[h]=(t.depth[o]>=t.depth[l]?t.depth[o]:t.depth[l])+1,a[2*o+1]=a[2*l+1]=h,t.heap[1]=h++,S(t,a,1)}while(t.heap_len>=2);t.heap[--t.heap_max]=t.heap[1],((t,e)=>{const a=e.dyn_tree,i=e.max_code,n=e.stat_desc.static_tree,r=e.stat_desc.has_stree,o=e.stat_desc.extra_bits,l=e.stat_desc.extra_base,h=e.stat_desc.max_length;let d,_,f,c,u,w,m=0;for(c=0;c<=s;c++)t.bl_count[c]=0;for(a[2*t.heap[t.heap_max]+1]=0,d=t.heap_max+1;d<573;d++)_=t.heap[d],c=a[2*a[2*_+1]+1]+1,c>h&&(c=h,m++),a[2*_+1]=c,_>i||(t.bl_count[c]++,u=0,_>=l&&(u=o[_-l]),w=a[2*_],t.opt_len+=w*(c+u),r&&(t.static_len+=w*(n[2*_+1]+u)));if(0!==m){do{for(c=h-1;0===t.bl_count[c];)c--;t.bl_count[c]--,t.bl_count[c+1]+=2,t.bl_count[h]--,m-=2}while(m>0);for(c=h;0!==c;c--)for(_=t.bl_count[c];0!==_;)f=t.heap[--d],f>i||(a[2*f+1]!==c&&(t.opt_len+=(c-a[2*f+1])*a[2*f],a[2*f+1]=c),_--)}})(t,e),E(a,d,t.bl_count)},O=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),e[2*(a+1)+1]=65535,i=0;i<=a;i++)n=r,r=e[2*(i+1)+1],++o<l&&n===r||(o<h?t.bl_tree[2*n]+=o:0!==n?(n!==s&&t.bl_tree[2*n]++,t.bl_tree[32]++):o<=10?t.bl_tree[34]++:t.bl_tree[36]++,o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4))},I=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),i=0;i<=a;i++)if(n=r,r=e[2*(i+1)+1],!(++o<l&&n===r)){if(o<h)do{z(t,n,t.bl_tree)}while(0!=--o);else 0!==n?(n!==s&&(z(t,n,t.bl_tree),o--),z(t,16,t.bl_tree),x(t,o-3,2)):o<=10?(z(t,17,t.bl_tree),x(t,o-3,3)):(z(t,18,t.bl_tree),x(t,o-11,7));o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4)}};let F=!1;const L=(t,e,a,i)=>{x(t,0+(i?1:0),3),Z(t),y(t,a),y(t,~a),a&&t.pending_buf.set(t.window.subarray(e,e+a),t.pending),t.pending+=a};var N=(t,e,i,n)=>{let s,r,o=0;t.level>0?(2===t.strm.data_type&&(t.strm.data_type=(t=>{let e,i=4093624447;for(e=0;e<=31;e++,i>>>=1)if(1&i&&0!==t.dyn_ltree[2*e])return 0;if(0!==t.dyn_ltree[18]||0!==t.dyn_ltree[20]||0!==t.dyn_ltree[26])return 1;for(e=32;e<a;e++)if(0!==t.dyn_ltree[2*e])return 1;return 0})(t)),T(t,t.l_desc),T(t,t.d_desc),o=(t=>{let e;for(O(t,t.dyn_ltree,t.l_desc.max_code),O(t,t.dyn_dtree,t.d_desc.max_code),T(t,t.bl_desc),e=18;e>=3&&0===t.bl_tree[2*h[e]+1];e--);return t.opt_len+=3*(e+1)+5+5+4,e})(t),s=t.opt_len+3+7>>>3,r=t.static_len+3+7>>>3,r<=s&&(s=r)):s=r=i+5,i+4<=s&&-1!==e?L(t,e,i,n):4===t.strategy||r===s?(x(t,2+(n?1:0),3),D(t,d,_)):(x(t,4+(n?1:0),3),((t,e,a,i)=>{let n;for(x(t,e-257,5),x(t,a-1,5),x(t,i-4,4),n=0;n<i;n++)x(t,t.bl_tree[2*h[n]+1],3);I(t,t.dyn_ltree,e-1),I(t,t.dyn_dtree,a-1)})(t,t.l_desc.max_code+1,t.d_desc.max_code+1,o+1),D(t,t.dyn_ltree,t.dyn_dtree)),R(t),n&&Z(t)},B={_tr_init:t=>{F||((()=>{let t,e,a,h,k;const v=new Array(16);for(a=0,h=0;h<28;h++)for(u[h]=a,t=0;t<1<<r[h];t++)c[a++]=h;for(c[a-1]=h,k=0,h=0;h<16;h++)for(w[h]=k,t=0;t<1<<o[h];t++)f[k++]=h;for(k>>=7;h<n;h++)for(w[h]=k<<7,t=0;t<1<<o[h]-7;t++)f[256+k++]=h;for(e=0;e<=s;e++)v[e]=0;for(t=0;t<=143;)d[2*t+1]=8,t++,v[8]++;for(;t<=255;)d[2*t+1]=9,t++,v[9]++;for(;t<=279;)d[2*t+1]=7,t++,v[7]++;for(;t<=287;)d[2*t+1]=8,t++,v[8]++;for(E(d,287,v),t=0;t<n;t++)_[2*t+1]=5,_[2*t]=A(t,5);b=new m(d,r,257,i,s),g=new m(_,o,0,n,s),p=new m(new Array(0),l,0,19,7)})(),F=!0),t.l_desc=new k(t.dyn_ltree,b),t.d_desc=new k(t.dyn_dtree,g),t.bl_desc=new k(t.bl_tree,p),t.bi_buf=0,t.bi_valid=0,R(t)},_tr_stored_block:L,_tr_flush_block:N,_tr_tally:(t,e,i)=>(t.pending_buf[t.sym_buf+t.sym_next++]=e,t.pending_buf[t.sym_buf+t.sym_next++]=e>>8,t.pending_buf[t.sym_buf+t.sym_next++]=i,0===e?t.dyn_ltree[2*i]++:(t.matches++,e--,t.dyn_ltree[2*(c[i]+a+1)]++,t.dyn_dtree[2*v(e)]++),t.sym_next===t.sym_end),_tr_align:t=>{x(t,2,3),z(t,256,d),(t=>{16===t.bi_valid?(y(t,t.bi_buf),t.bi_buf=0,t.bi_valid=0):t.bi_valid>=8&&(t.pending_buf[t.pending++]=255&t.bi_buf,t.bi_buf>>=8,t.bi_valid-=8)})(t)}};var C=(t,e,a,i)=>{let n=65535&t|0,s=t>>>16&65535|0,r=0;for(;0!==a;){r=a>2e3?2e3:a,a-=r;do{n=n+e[i++]|0,s=s+n|0}while(--r);n%=65521,s%=65521}return n|s<<16|0};const M=new Uint32Array((()=>{let t,e=[];for(var a=0;a<256;a++){t=a;for(var i=0;i<8;i++)t=1&t?3988292384^t>>>1:t>>>1;e[a]=t}return e})());var H=(t,e,a,i)=>{const n=M,s=i+a;t^=-1;for(let a=i;a<s;a++)t=t>>>8^n[255&(t^e[a])];return-1^t},j={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"},K={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_MEM_ERROR:-4,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8};const{_tr_init:P,_tr_stored_block:Y,_tr_flush_block:G,_tr_tally:X,_tr_align:W}=B,{Z_NO_FLUSH:q,Z_PARTIAL_FLUSH:J,Z_FULL_FLUSH:Q,Z_FINISH:V,Z_BLOCK:$,Z_OK:tt,Z_STREAM_END:et,Z_STREAM_ERROR:at,Z_DATA_ERROR:it,Z_BUF_ERROR:nt,Z_DEFAULT_COMPRESSION:st,Z_FILTERED:rt,Z_HUFFMAN_ONLY:ot,Z_RLE:lt,Z_FIXED:ht,Z_DEFAULT_STRATEGY:dt,Z_UNKNOWN:_t,Z_DEFLATED:ft}=K,ct=258,ut=262,wt=42,mt=113,bt=666,gt=(t,e)=>(t.msg=j[e],e),pt=t=>2*t-(t>4?9:0),kt=t=>{let e=t.length;for(;--e>=0;)t[e]=0},vt=t=>{let e,a,i,n=t.w_size;e=t.hash_size,i=e;do{a=t.head[--i],t.head[i]=a>=n?a-n:0}while(--e);e=n,i=e;do{a=t.prev[--i],t.prev[i]=a>=n?a-n:0}while(--e)};let yt=(t,e,a)=>(e<<t.hash_shift^a)&t.hash_mask;const xt=t=>{const e=t.state;let a=e.pending;a>t.avail_out&&(a=t.avail_out),0!==a&&(t.output.set(e.pending_buf.subarray(e.pending_out,e.pending_out+a),t.next_out),t.next_out+=a,e.pending_out+=a,t.total_out+=a,t.avail_out-=a,e.pending-=a,0===e.pending&&(e.pending_out=0))},zt=(t,e)=>{G(t,t.block_start>=0?t.block_start:-1,t.strstart-t.block_start,e),t.block_start=t.strstart,xt(t.strm)},At=(t,e)=>{t.pending_buf[t.pending++]=e},Et=(t,e)=>{t.pending_buf[t.pending++]=e>>>8&255,t.pending_buf[t.pending++]=255&e},Rt=(t,e,a,i)=>{let n=t.avail_in;return n>i&&(n=i),0===n?0:(t.avail_in-=n,e.set(t.input.subarray(t.next_in,t.next_in+n),a),1===t.state.wrap?t.adler=C(t.adler,e,n,a):2===t.state.wrap&&(t.adler=H(t.adler,e,n,a)),t.next_in+=n,t.total_in+=n,n)},Zt=(t,e)=>{let a,i,n=t.max_chain_length,s=t.strstart,r=t.prev_length,o=t.nice_match;const l=t.strstart>t.w_size-ut?t.strstart-(t.w_size-ut):0,h=t.window,d=t.w_mask,_=t.prev,f=t.strstart+ct;let c=h[s+r-1],u=h[s+r];t.prev_length>=t.good_match&&(n>>=2),o>t.lookahead&&(o=t.lookahead);do{if(a=e,h[a+r]===u&&h[a+r-1]===c&&h[a]===h[s]&&h[++a]===h[s+1]){s+=2,a++;do{}while(h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&s<f);if(i=ct-(f-s),s=f-ct,i>r){if(t.match_start=e,r=i,i>=o)break;c=h[s+r-1],u=h[s+r]}}}while((e=_[e&d])>l&&0!=--n);return r<=t.lookahead?r:t.lookahead},Ut=t=>{const e=t.w_size;let a,i,n;do{if(i=t.window_size-t.lookahead-t.strstart,t.strstart>=e+(e-ut)&&(t.window.set(t.window.subarray(e,e+e-i),0),t.match_start-=e,t.strstart-=e,t.block_start-=e,t.insert>t.strstart&&(t.insert=t.strstart),vt(t),i+=e),0===t.strm.avail_in)break;if(a=Rt(t.strm,t.window,t.strstart+t.lookahead,i),t.lookahead+=a,t.lookahead+t.insert>=3)for(n=t.strstart-t.insert,t.ins_h=t.window[n],t.ins_h=yt(t,t.ins_h,t.window[n+1]);t.insert&&(t.ins_h=yt(t,t.ins_h,t.window[n+3-1]),t.prev[n&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=n,n++,t.insert--,!(t.lookahead+t.insert<3)););}while(t.lookahead<ut&&0!==t.strm.avail_in)},St=(t,e)=>{let a,i,n,s=t.pending_buf_size-5>t.w_size?t.w_size:t.pending_buf_size-5,r=0,o=t.strm.avail_in;do{if(a=65535,n=t.bi_valid+42>>3,t.strm.avail_out<n)break;if(n=t.strm.avail_out-n,i=t.strstart-t.block_start,a>i+t.strm.avail_in&&(a=i+t.strm.avail_in),a>n&&(a=n),a<s&&(0===a&&e!==V||e===q||a!==i+t.strm.avail_in))break;r=e===V&&a===i+t.strm.avail_in?1:0,Y(t,0,0,r),t.pending_buf[t.pending-4]=a,t.pending_buf[t.pending-3]=a>>8,t.pending_buf[t.pending-2]=~a,t.pending_buf[t.pending-1]=~a>>8,xt(t.strm),i&&(i>a&&(i=a),t.strm.output.set(t.window.subarray(t.block_start,t.block_start+i),t.strm.next_out),t.strm.next_out+=i,t.strm.avail_out-=i,t.strm.total_out+=i,t.block_start+=i,a-=i),a&&(Rt(t.strm,t.strm.output,t.strm.next_out,a),t.strm.next_out+=a,t.strm.avail_out-=a,t.strm.total_out+=a)}while(0===r);return o-=t.strm.avail_in,o&&(o>=t.w_size?(t.matches=2,t.window.set(t.strm.input.subarray(t.strm.next_in-t.w_size,t.strm.next_in),0),t.strstart=t.w_size,t.insert=t.strstart):(t.window_size-t.strstart<=o&&(t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,t.insert>t.strstart&&(t.insert=t.strstart)),t.window.set(t.strm.input.subarray(t.strm.next_in-o,t.strm.next_in),t.strstart),t.strstart+=o,t.insert+=o>t.w_size-t.insert?t.w_size-t.insert:o),t.block_start=t.strstart),t.high_water<t.strstart&&(t.high_water=t.strstart),r?4:e!==q&&e!==V&&0===t.strm.avail_in&&t.strstart===t.block_start?2:(n=t.window_size-t.strstart,t.strm.avail_in>n&&t.block_start>=t.w_size&&(t.block_start-=t.w_size,t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,n+=t.w_size,t.insert>t.strstart&&(t.insert=t.strstart)),n>t.strm.avail_in&&(n=t.strm.avail_in),n&&(Rt(t.strm,t.window,t.strstart,n),t.strstart+=n,t.insert+=n>t.w_size-t.insert?t.w_size-t.insert:n),t.high_water<t.strstart&&(t.high_water=t.strstart),n=t.bi_valid+42>>3,n=t.pending_buf_size-n>65535?65535:t.pending_buf_size-n,s=n>t.w_size?t.w_size:n,i=t.strstart-t.block_start,(i>=s||(i||e===V)&&e!==q&&0===t.strm.avail_in&&i<=n)&&(a=i>n?n:i,r=e===V&&0===t.strm.avail_in&&a===i?1:0,Y(t,t.block_start,a,r),t.block_start+=a,xt(t.strm)),r?3:1)},Dt=(t,e)=>{let a,i;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),0!==a&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a)),t.match_length>=3)if(i=X(t,t.strstart-t.match_start,t.match_length-3),t.lookahead-=t.match_length,t.match_length<=t.max_lazy_match&&t.lookahead>=3){t.match_length--;do{t.strstart++,t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart}while(0!=--t.match_length);t.strstart++}else t.strstart+=t.match_length,t.match_length=0,t.ins_h=t.window[t.strstart],t.ins_h=yt(t,t.ins_h,t.window[t.strstart+1]);else i=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++;if(i&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2},Tt=(t,e)=>{let a,i,n;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),t.prev_length=t.match_length,t.prev_match=t.match_start,t.match_length=2,0!==a&&t.prev_length<t.max_lazy_match&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a),t.match_length<=5&&(t.strategy===rt||3===t.match_length&&t.strstart-t.match_start>4096)&&(t.match_length=2)),t.prev_length>=3&&t.match_length<=t.prev_length){n=t.strstart+t.lookahead-3,i=X(t,t.strstart-1-t.prev_match,t.prev_length-3),t.lookahead-=t.prev_length-1,t.prev_length-=2;do{++t.strstart<=n&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart)}while(0!=--t.prev_length);if(t.match_available=0,t.match_length=2,t.strstart++,i&&(zt(t,!1),0===t.strm.avail_out))return 1}else if(t.match_available){if(i=X(t,0,t.window[t.strstart-1]),i&&zt(t,!1),t.strstart++,t.lookahead--,0===t.strm.avail_out)return 1}else t.match_available=1,t.strstart++,t.lookahead--}return t.match_available&&(i=X(t,0,t.window[t.strstart-1]),t.match_available=0),t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2};function Ot(t,e,a,i,n){this.good_length=t,this.max_lazy=e,this.nice_length=a,this.max_chain=i,this.func=n}const It=[new Ot(0,0,0,0,St),new Ot(4,4,8,4,Dt),new Ot(4,5,16,8,Dt),new Ot(4,6,32,32,Dt),new Ot(4,4,16,16,Tt),new Ot(8,16,32,32,Tt),new Ot(8,16,128,128,Tt),new Ot(8,32,128,256,Tt),new Ot(32,128,258,1024,Tt),new Ot(32,258,258,4096,Tt)];function Ft(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=ft,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new Uint16Array(1146),this.dyn_dtree=new Uint16Array(122),this.bl_tree=new Uint16Array(78),kt(this.dyn_ltree),kt(this.dyn_dtree),kt(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new Uint16Array(16),this.heap=new Uint16Array(573),kt(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new Uint16Array(573),kt(this.depth),this.sym_buf=0,this.lit_bufsize=0,this.sym_next=0,this.sym_end=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0}const Lt=t=>{if(!t)return 1;const e=t.state;return!e||e.strm!==t||e.status!==wt&&57!==e.status&&69!==e.status&&73!==e.status&&91!==e.status&&103!==e.status&&e.status!==mt&&e.status!==bt?1:0},Nt=t=>{if(Lt(t))return gt(t,at);t.total_in=t.total_out=0,t.data_type=_t;const e=t.state;return e.pending=0,e.pending_out=0,e.wrap<0&&(e.wrap=-e.wrap),e.status=2===e.wrap?57:e.wrap?wt:mt,t.adler=2===e.wrap?0:1,e.last_flush=-2,P(e),tt},Bt=t=>{const e=Nt(t);var a;return e===tt&&((a=t.state).window_size=2*a.w_size,kt(a.head),a.max_lazy_match=It[a.level].max_lazy,a.good_match=It[a.level].good_length,a.nice_match=It[a.level].nice_length,a.max_chain_length=It[a.level].max_chain,a.strstart=0,a.block_start=0,a.lookahead=0,a.insert=0,a.match_length=a.prev_length=2,a.match_available=0,a.ins_h=0),e},Ct=(t,e,a,i,n,s)=>{if(!t)return at;let r=1;if(e===st&&(e=6),i<0?(r=0,i=-i):i>15&&(r=2,i-=16),n<1||n>9||a!==ft||i<8||i>15||e<0||e>9||s<0||s>ht||8===i&&1!==r)return gt(t,at);8===i&&(i=9);const o=new Ft;return t.state=o,o.strm=t,o.status=wt,o.wrap=r,o.gzhead=null,o.w_bits=i,o.w_size=1<<o.w_bits,o.w_mask=o.w_size-1,o.hash_bits=n+7,o.hash_size=1<<o.hash_bits,o.hash_mask=o.hash_size-1,o.hash_shift=~~((o.hash_bits+3-1)/3),o.window=new Uint8Array(2*o.w_size),o.head=new Uint16Array(o.hash_size),o.prev=new Uint16Array(o.w_size),o.lit_bufsize=1<<n+6,o.pending_buf_size=4*o.lit_bufsize,o.pending_buf=new Uint8Array(o.pending_buf_size),o.sym_buf=o.lit_bufsize,o.sym_end=3*(o.lit_bufsize-1),o.level=e,o.strategy=s,o.method=a,Bt(t)};var Mt={deflateInit:(t,e)=>Ct(t,e,ft,15,8,dt),deflateInit2:Ct,deflateReset:Bt,deflateResetKeep:Nt,deflateSetHeader:(t,e)=>Lt(t)||2!==t.state.wrap?at:(t.state.gzhead=e,tt),deflate:(t,e)=>{if(Lt(t)||e>$||e<0)return t?gt(t,at):at;const a=t.state;if(!t.output||0!==t.avail_in&&!t.input||a.status===bt&&e!==V)return gt(t,0===t.avail_out?nt:at);const i=a.last_flush;if(a.last_flush=e,0!==a.pending){if(xt(t),0===t.avail_out)return a.last_flush=-1,tt}else if(0===t.avail_in&&pt(e)<=pt(i)&&e!==V)return gt(t,nt);if(a.status===bt&&0!==t.avail_in)return gt(t,nt);if(a.status===wt&&0===a.wrap&&(a.status=mt),a.status===wt){let e=ft+(a.w_bits-8<<4)<<8,i=-1;if(i=a.strategy>=ot||a.level<2?0:a.level<6?1:6===a.level?2:3,e|=i<<6,0!==a.strstart&&(e|=32),e+=31-e%31,Et(a,e),0!==a.strstart&&(Et(a,t.adler>>>16),Et(a,65535&t.adler)),t.adler=1,a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(57===a.status)if(t.adler=0,At(a,31),At(a,139),At(a,8),a.gzhead)At(a,(a.gzhead.text?1:0)+(a.gzhead.hcrc?2:0)+(a.gzhead.extra?4:0)+(a.gzhead.name?8:0)+(a.gzhead.comment?16:0)),At(a,255&a.gzhead.time),At(a,a.gzhead.time>>8&255),At(a,a.gzhead.time>>16&255),At(a,a.gzhead.time>>24&255),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,255&a.gzhead.os),a.gzhead.extra&&a.gzhead.extra.length&&(At(a,255&a.gzhead.extra.length),At(a,a.gzhead.extra.length>>8&255)),a.gzhead.hcrc&&(t.adler=H(t.adler,a.pending_buf,a.pending,0)),a.gzindex=0,a.status=69;else if(At(a,0),At(a,0),At(a,0),At(a,0),At(a,0),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,3),a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt;if(69===a.status){if(a.gzhead.extra){let e=a.pending,i=(65535&a.gzhead.extra.length)-a.gzindex;for(;a.pending+i>a.pending_buf_size;){let n=a.pending_buf_size-a.pending;if(a.pending_buf.set(a.gzhead.extra.subarray(a.gzindex,a.gzindex+n),a.pending),a.pending=a.pending_buf_size,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex+=n,xt(t),0!==a.pending)return a.last_flush=-1,tt;e=0,i-=n}let n=new Uint8Array(a.gzhead.extra);a.pending_buf.set(n.subarray(a.gzindex,a.gzindex+i),a.pending),a.pending+=i,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex=0}a.status=73}if(73===a.status){if(a.gzhead.name){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0}e=a.gzindex<a.gzhead.name.length?255&a.gzhead.name.charCodeAt(a.gzindex++):0,At(a,e)}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),a.gzindex=0}a.status=91}if(91===a.status){if(a.gzhead.comment){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0}e=a.gzindex<a.gzhead.comment.length?255&a.gzhead.comment.charCodeAt(a.gzindex++):0,At(a,e)}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i))}a.status=103}if(103===a.status){if(a.gzhead.hcrc){if(a.pending+2>a.pending_buf_size&&(xt(t),0!==a.pending))return a.last_flush=-1,tt;At(a,255&t.adler),At(a,t.adler>>8&255),t.adler=0}if(a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(0!==t.avail_in||0!==a.lookahead||e!==q&&a.status!==bt){let i=0===a.level?St(a,e):a.strategy===ot?((t,e)=>{let a;for(;;){if(0===t.lookahead&&(Ut(t),0===t.lookahead)){if(e===q)return 1;break}if(t.match_length=0,a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++,a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):a.strategy===lt?((t,e)=>{let a,i,n,s;const r=t.window;for(;;){if(t.lookahead<=ct){if(Ut(t),t.lookahead<=ct&&e===q)return 1;if(0===t.lookahead)break}if(t.match_length=0,t.lookahead>=3&&t.strstart>0&&(n=t.strstart-1,i=r[n],i===r[++n]&&i===r[++n]&&i===r[++n])){s=t.strstart+ct;do{}while(i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&n<s);t.match_length=ct-(s-n),t.match_length>t.lookahead&&(t.match_length=t.lookahead)}if(t.match_length>=3?(a=X(t,1,t.match_length-3),t.lookahead-=t.match_length,t.strstart+=t.match_length,t.match_length=0):(a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++),a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):It[a.level].func(a,e);if(3!==i&&4!==i||(a.status=bt),1===i||3===i)return 0===t.avail_out&&(a.last_flush=-1),tt;if(2===i&&(e===J?W(a):e!==$&&(Y(a,0,0,!1),e===Q&&(kt(a.head),0===a.lookahead&&(a.strstart=0,a.block_start=0,a.insert=0))),xt(t),0===t.avail_out))return a.last_flush=-1,tt}return e!==V?tt:a.wrap<=0?et:(2===a.wrap?(At(a,255&t.adler),At(a,t.adler>>8&255),At(a,t.adler>>16&255),At(a,t.adler>>24&255),At(a,255&t.total_in),At(a,t.total_in>>8&255),At(a,t.total_in>>16&255),At(a,t.total_in>>24&255)):(Et(a,t.adler>>>16),Et(a,65535&t.adler)),xt(t),a.wrap>0&&(a.wrap=-a.wrap),0!==a.pending?tt:et)},deflateEnd:t=>{if(Lt(t))return at;const e=t.state.status;return t.state=null,e===mt?gt(t,it):tt},deflateSetDictionary:(t,e)=>{let a=e.length;if(Lt(t))return at;const i=t.state,n=i.wrap;if(2===n||1===n&&i.status!==wt||i.lookahead)return at;if(1===n&&(t.adler=C(t.adler,e,a,0)),i.wrap=0,a>=i.w_size){0===n&&(kt(i.head),i.strstart=0,i.block_start=0,i.insert=0);let t=new Uint8Array(i.w_size);t.set(e.subarray(a-i.w_size,a),0),e=t,a=i.w_size}const s=t.avail_in,r=t.next_in,o=t.input;for(t.avail_in=a,t.next_in=0,t.input=e,Ut(i);i.lookahead>=3;){let t=i.strstart,e=i.lookahead-2;do{i.ins_h=yt(i,i.ins_h,i.window[t+3-1]),i.prev[t&i.w_mask]=i.head[i.ins_h],i.head[i.ins_h]=t,t++}while(--e);i.strstart=t,i.lookahead=2,Ut(i)}return i.strstart+=i.lookahead,i.block_start=i.strstart,i.insert=i.lookahead,i.lookahead=0,i.match_length=i.prev_length=2,i.match_available=0,t.next_in=r,t.input=o,t.avail_in=s,i.wrap=n,tt},deflateInfo:"pako deflate (from Nodeca project)"};const Ht=(t,e)=>Object.prototype.hasOwnProperty.call(t,e);var jt=function(t){const e=Array.prototype.slice.call(arguments,1);for(;e.length;){const a=e.shift();if(a){if("object"!=typeof a)throw new TypeError(a+"must be non-object");for(const e in a)Ht(a,e)&&(t[e]=a[e])}}return t},Kt=t=>{let e=0;for(let a=0,i=t.length;a<i;a++)e+=t[a].length;const a=new Uint8Array(e);for(let e=0,i=0,n=t.length;e<n;e++){let n=t[e];a.set(n,i),i+=n.length}return a};let Pt=!0;try{String.fromCharCode.apply(null,new Uint8Array(1))}catch(t){Pt=!1}const Yt=new Uint8Array(256);for(let t=0;t<256;t++)Yt[t]=t>=252?6:t>=248?5:t>=240?4:t>=224?3:t>=192?2:1;Yt[254]=Yt[254]=1;var Gt=t=>{if("function"==typeof TextEncoder&&TextEncoder.prototype.encode)return(new TextEncoder).encode(t);let e,a,i,n,s,r=t.length,o=0;for(n=0;n<r;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),o+=a<128?1:a<2048?2:a<65536?3:4;for(e=new Uint8Array(o),s=0,n=0;s<o;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),a<128?e[s++]=a:a<2048?(e[s++]=192|a>>>6,e[s++]=128|63&a):a<65536?(e[s++]=224|a>>>12,e[s++]=128|a>>>6&63,e[s++]=128|63&a):(e[s++]=240|a>>>18,e[s++]=128|a>>>12&63,e[s++]=128|a>>>6&63,e[s++]=128|63&a);return e},Xt=(t,e)=>{const a=e||t.length;if("function"==typeof TextDecoder&&TextDecoder.prototype.decode)return(new TextDecoder).decode(t.subarray(0,e));let i,n;const s=new Array(2*a);for(n=0,i=0;i<a;){let e=t[i++];if(e<128){s[n++]=e;continue}let r=Yt[e];if(r>4)s[n++]=65533,i+=r-1;else{for(e&=2===r?31:3===r?15:7;r>1&&i<a;)e=e<<6|63&t[i++],r--;r>1?s[n++]=65533:e<65536?s[n++]=e:(e-=65536,s[n++]=55296|e>>10&1023,s[n++]=56320|1023&e)}}return((t,e)=>{if(e<65534&&t.subarray&&Pt)return String.fromCharCode.apply(null,t.length===e?t:t.subarray(0,e));let a="";for(let i=0;i<e;i++)a+=String.fromCharCode(t[i]);return a})(s,n)},Wt=(t,e)=>{(e=e||t.length)>t.length&&(e=t.length);let a=e-1;for(;a>=0&&128==(192&t[a]);)a--;return a<0||0===a?e:a+Yt[t[a]]>e?a:e};var qt=function(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0};const Jt=Object.prototype.toString,{Z_NO_FLUSH:Qt,Z_SYNC_FLUSH:Vt,Z_FULL_FLUSH:$t,Z_FINISH:te,Z_OK:ee,Z_STREAM_END:ae,Z_DEFAULT_COMPRESSION:ie,Z_DEFAULT_STRATEGY:ne,Z_DEFLATED:se}=K;function re(t){this.options=jt({level:ie,method:se,chunkSize:16384,windowBits:15,memLevel:8,strategy:ne},t||{});let e=this.options;e.raw&&e.windowBits>0?e.windowBits=-e.windowBits:e.gzip&&e.windowBits>0&&e.windowBits<16&&(e.windowBits+=16),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=Mt.deflateInit2(this.strm,e.level,e.method,e.windowBits,e.memLevel,e.strategy);if(a!==ee)throw new Error(j[a]);if(e.header&&Mt.deflateSetHeader(this.strm,e.header),e.dictionary){let t;if(t="string"==typeof e.dictionary?Gt(e.dictionary):"[object ArrayBuffer]"===Jt.call(e.dictionary)?new Uint8Array(e.dictionary):e.dictionary,a=Mt.deflateSetDictionary(this.strm,t),a!==ee)throw new Error(j[a]);this._dict_set=!0}}function oe(t,e){const a=new re(e);if(a.push(t,!0),a.err)throw a.msg||j[a.err];return a.result}re.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize;let n,s;if(this.ended)return!1;for(s=e===~~e?e:!0===e?te:Qt,"string"==typeof t?a.input=Gt(t):"[object ArrayBuffer]"===Jt.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;)if(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),(s===Vt||s===$t)&&a.avail_out<=6)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else{if(n=Mt.deflate(a,s),n===ae)return a.next_out>0&&this.onData(a.output.subarray(0,a.next_out)),n=Mt.deflateEnd(this.strm),this.onEnd(n),this.ended=!0,n===ee;if(0!==a.avail_out){if(s>0&&a.next_out>0)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else if(0===a.avail_in)break}else this.onData(a.output)}return!0},re.prototype.onData=function(t){this.chunks.push(t)},re.prototype.onEnd=function(t){t===ee&&(this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg};var le={Deflate:re,deflate:oe,deflateRaw:function(t,e){return(e=e||{}).raw=!0,oe(t,e)},gzip:function(t,e){return(e=e||{}).gzip=!0,oe(t,e)},constants:K};const he=16209;var de=function(t,e){let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z,A;const E=t.state;a=t.next_in,z=t.input,i=a+(t.avail_in-5),n=t.next_out,A=t.output,s=n-(e-t.avail_out),r=n+(t.avail_out-257),o=E.dmax,l=E.wsize,h=E.whave,d=E.wnext,_=E.window,f=E.hold,c=E.bits,u=E.lencode,w=E.distcode,m=(1<<E.lenbits)-1,b=(1<<E.distbits)-1;t:do{c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=u[f&m];e:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,0===p)A[n++]=65535&g;else{if(!(16&p)){if(0==(64&p)){g=u[(65535&g)+(f&(1<<p)-1)];continue e}if(32&p){E.mode=16191;break t}t.msg="invalid literal/length code",E.mode=he;break t}k=65535&g,p&=15,p&&(c<p&&(f+=z[a++]<<c,c+=8),k+=f&(1<<p)-1,f>>>=p,c-=p),c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=w[f&b];a:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,!(16&p)){if(0==(64&p)){g=w[(65535&g)+(f&(1<<p)-1)];continue a}t.msg="invalid distance code",E.mode=he;break t}if(v=65535&g,p&=15,c<p&&(f+=z[a++]<<c,c+=8,c<p&&(f+=z[a++]<<c,c+=8)),v+=f&(1<<p)-1,v>o){t.msg="invalid distance too far back",E.mode=he;break t}if(f>>>=p,c-=p,p=n-s,v>p){if(p=v-p,p>h&&E.sane){t.msg="invalid distance too far back",E.mode=he;break t}if(y=0,x=_,0===d){if(y+=l-p,p<k){k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}}else if(d<p){if(y+=l+d-p,p-=d,p<k){k-=p;do{A[n++]=_[y++]}while(--p);if(y=0,d<k){p=d,k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}}}else if(y+=d-p,p<k){k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}for(;k>2;)A[n++]=x[y++],A[n++]=x[y++],A[n++]=x[y++],k-=3;k&&(A[n++]=x[y++],k>1&&(A[n++]=x[y++]))}else{y=n-v;do{A[n++]=A[y++],A[n++]=A[y++],A[n++]=A[y++],k-=3}while(k>2);k&&(A[n++]=A[y++],k>1&&(A[n++]=A[y++]))}break}}break}}while(a<i&&n<r);k=c>>3,a-=k,c-=k<<3,f&=(1<<c)-1,t.next_in=a,t.next_out=n,t.avail_in=a<i?i-a+5:5-(a-i),t.avail_out=n<r?r-n+257:257-(n-r),E.hold=f,E.bits=c};const _e=15,fe=new Uint16Array([3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0]),ce=new Uint8Array([16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78]),ue=new Uint16Array([1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0]),we=new Uint8Array([16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64]);var me=(t,e,a,i,n,s,r,o)=>{const l=o.bits;let h,d,_,f,c,u,w=0,m=0,b=0,g=0,p=0,k=0,v=0,y=0,x=0,z=0,A=null;const E=new Uint16Array(16),R=new Uint16Array(16);let Z,U,S,D=null;for(w=0;w<=_e;w++)E[w]=0;for(m=0;m<i;m++)E[e[a+m]]++;for(p=l,g=_e;g>=1&&0===E[g];g--);if(p>g&&(p=g),0===g)return n[s++]=20971520,n[s++]=20971520,o.bits=1,0;for(b=1;b<g&&0===E[b];b++);for(p<b&&(p=b),y=1,w=1;w<=_e;w++)if(y<<=1,y-=E[w],y<0)return-1;if(y>0&&(0===t||1!==g))return-1;for(R[1]=0,w=1;w<_e;w++)R[w+1]=R[w]+E[w];for(m=0;m<i;m++)0!==e[a+m]&&(r[R[e[a+m]]++]=m);if(0===t?(A=D=r,u=20):1===t?(A=fe,D=ce,u=257):(A=ue,D=we,u=0),z=0,m=0,w=b,c=s,k=p,v=0,_=-1,x=1<<p,f=x-1,1===t&&x>852||2===t&&x>592)return 1;for(;;){Z=w-v,r[m]+1<u?(U=0,S=r[m]):r[m]>=u?(U=D[r[m]-u],S=A[r[m]-u]):(U=96,S=0),h=1<<w-v,d=1<<k,b=d;do{d-=h,n[c+(z>>v)+d]=Z<<24|U<<16|S|0}while(0!==d);for(h=1<<w-1;z&h;)h>>=1;if(0!==h?(z&=h-1,z+=h):z=0,m++,0==--E[w]){if(w===g)break;w=e[a+r[m]]}if(w>p&&(z&f)!==_){for(0===v&&(v=p),c+=b,k=w-v,y=1<<k;k+v<g&&(y-=E[k+v],!(y<=0));)k++,y<<=1;if(x+=1<<k,1===t&&x>852||2===t&&x>592)return 1;_=z&f,n[_]=p<<24|k<<16|c-s|0}}return 0!==z&&(n[c+z]=w-v<<24|64<<16|0),o.bits=p,0};const{Z_FINISH:be,Z_BLOCK:ge,Z_TREES:pe,Z_OK:ke,Z_STREAM_END:ve,Z_NEED_DICT:ye,Z_STREAM_ERROR:xe,Z_DATA_ERROR:ze,Z_MEM_ERROR:Ae,Z_BUF_ERROR:Ee,Z_DEFLATED:Re}=K,Ze=16180,Ue=16190,Se=16191,De=16192,Te=16194,Oe=16199,Ie=16200,Fe=16206,Le=16209,Ne=t=>(t>>>24&255)+(t>>>8&65280)+((65280&t)<<8)+((255&t)<<24);function Be(){this.strm=null,this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new Uint16Array(320),this.work=new Uint16Array(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}const Ce=t=>{if(!t)return 1;const e=t.state;return!e||e.strm!==t||e.mode<Ze||e.mode>16211?1:0},Me=t=>{if(Ce(t))return xe;const e=t.state;return t.total_in=t.total_out=e.total=0,t.msg="",e.wrap&&(t.adler=1&e.wrap),e.mode=Ze,e.last=0,e.havedict=0,e.flags=-1,e.dmax=32768,e.head=null,e.hold=0,e.bits=0,e.lencode=e.lendyn=new Int32Array(852),e.distcode=e.distdyn=new Int32Array(592),e.sane=1,e.back=-1,ke},He=t=>{if(Ce(t))return xe;const e=t.state;return e.wsize=0,e.whave=0,e.wnext=0,Me(t)},je=(t,e)=>{let a;if(Ce(t))return xe;const i=t.state;return e<0?(a=0,e=-e):(a=5+(e>>4),e<48&&(e&=15)),e&&(e<8||e>15)?xe:(null!==i.window&&i.wbits!==e&&(i.window=null),i.wrap=a,i.wbits=e,He(t))},Ke=(t,e)=>{if(!t)return xe;const a=new Be;t.state=a,a.strm=t,a.window=null,a.mode=Ze;const i=je(t,e);return i!==ke&&(t.state=null),i};let Pe,Ye,Ge=!0;const Xe=t=>{if(Ge){Pe=new Int32Array(512),Ye=new Int32Array(32);let e=0;for(;e<144;)t.lens[e++]=8;for(;e<256;)t.lens[e++]=9;for(;e<280;)t.lens[e++]=7;for(;e<288;)t.lens[e++]=8;for(me(1,t.lens,0,288,Pe,0,t.work,{bits:9}),e=0;e<32;)t.lens[e++]=5;me(2,t.lens,0,32,Ye,0,t.work,{bits:5}),Ge=!1}t.lencode=Pe,t.lenbits=9,t.distcode=Ye,t.distbits=5},We=(t,e,a,i)=>{let n;const s=t.state;return null===s.window&&(s.wsize=1<<s.wbits,s.wnext=0,s.whave=0,s.window=new Uint8Array(s.wsize)),i>=s.wsize?(s.window.set(e.subarray(a-s.wsize,a),0),s.wnext=0,s.whave=s.wsize):(n=s.wsize-s.wnext,n>i&&(n=i),s.window.set(e.subarray(a-i,a-i+n),s.wnext),(i-=n)?(s.window.set(e.subarray(a-i,a),0),s.wnext=i,s.whave=s.wsize):(s.wnext+=n,s.wnext===s.wsize&&(s.wnext=0),s.whave<s.wsize&&(s.whave+=n))),0};var qe={inflateReset:He,inflateReset2:je,inflateResetKeep:Me,inflateInit:t=>Ke(t,15),inflateInit2:Ke,inflate:(t,e)=>{let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z=0;const A=new Uint8Array(4);let E,R;const Z=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]);if(Ce(t)||!t.output||!t.input&&0!==t.avail_in)return xe;a=t.state,a.mode===Se&&(a.mode=De),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,_=o,f=l,x=ke;t:for(;;)switch(a.mode){case Ze:if(0===a.wrap){a.mode=De;break}for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(2&a.wrap&&35615===h){0===a.wbits&&(a.wbits=15),a.check=0,A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0),h=0,d=0,a.mode=16181;break}if(a.head&&(a.head.done=!1),!(1&a.wrap)||(((255&h)<<8)+(h>>8))%31){t.msg="incorrect header check",a.mode=Le;break}if((15&h)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(h>>>=4,d-=4,y=8+(15&h),0===a.wbits&&(a.wbits=y),y>15||y>a.wbits){t.msg="invalid window size",a.mode=Le;break}a.dmax=1<<a.wbits,a.flags=0,t.adler=a.check=1,a.mode=512&h?16189:Se,h=0,d=0;break;case 16181:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(a.flags=h,(255&a.flags)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(57344&a.flags){t.msg="unknown header flags set",a.mode=Le;break}a.head&&(a.head.text=h>>8&1),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16182;case 16182:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.head&&(a.head.time=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,A[2]=h>>>16&255,A[3]=h>>>24&255,a.check=H(a.check,A,4,0)),h=0,d=0,a.mode=16183;case 16183:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.head&&(a.head.xflags=255&h,a.head.os=h>>8),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16184;case 16184:if(1024&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.length=h,a.head&&(a.head.extra_len=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0}else a.head&&(a.head.extra=null);a.mode=16185;case 16185:if(1024&a.flags&&(c=a.length,c>o&&(c=o),c&&(a.head&&(y=a.head.extra_len-a.length,a.head.extra||(a.head.extra=new Uint8Array(a.head.extra_len)),a.head.extra.set(i.subarray(s,s+c),y)),512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,a.length-=c),a.length))break t;a.length=0,a.mode=16186;case 16186:if(2048&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.name+=String.fromCharCode(y))}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.name=null);a.length=0,a.mode=16187;case 16187:if(4096&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.comment+=String.fromCharCode(y))}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.comment=null);a.mode=16188;case 16188:if(512&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(4&a.wrap&&h!==(65535&a.check)){t.msg="header crc mismatch",a.mode=Le;break}h=0,d=0}a.head&&(a.head.hcrc=a.flags>>9&1,a.head.done=!0),t.adler=a.check=0,a.mode=Se;break;case 16189:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}t.adler=a.check=Ne(h),h=0,d=0,a.mode=Ue;case Ue:if(0===a.havedict)return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,ye;t.adler=a.check=1,a.mode=Se;case Se:if(e===ge||e===pe)break t;case De:if(a.last){h>>>=7&d,d-=7&d,a.mode=Fe;break}for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}switch(a.last=1&h,h>>>=1,d-=1,3&h){case 0:a.mode=16193;break;case 1:if(Xe(a),a.mode=Oe,e===pe){h>>>=2,d-=2;break t}break;case 2:a.mode=16196;break;case 3:t.msg="invalid block type",a.mode=Le}h>>>=2,d-=2;break;case 16193:for(h>>>=7&d,d-=7&d;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if((65535&h)!=(h>>>16^65535)){t.msg="invalid stored block lengths",a.mode=Le;break}if(a.length=65535&h,h=0,d=0,a.mode=Te,e===pe)break t;case Te:a.mode=16195;case 16195:if(c=a.length,c){if(c>o&&(c=o),c>l&&(c=l),0===c)break t;n.set(i.subarray(s,s+c),r),o-=c,s+=c,l-=c,r+=c,a.length-=c;break}a.mode=Se;break;case 16196:for(;d<14;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(a.nlen=257+(31&h),h>>>=5,d-=5,a.ndist=1+(31&h),h>>>=5,d-=5,a.ncode=4+(15&h),h>>>=4,d-=4,a.nlen>286||a.ndist>30){t.msg="too many length or distance symbols",a.mode=Le;break}a.have=0,a.mode=16197;case 16197:for(;a.have<a.ncode;){for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.lens[Z[a.have++]]=7&h,h>>>=3,d-=3}for(;a.have<19;)a.lens[Z[a.have++]]=0;if(a.lencode=a.lendyn,a.lenbits=7,E={bits:a.lenbits},x=me(0,a.lens,0,19,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid code lengths set",a.mode=Le;break}a.have=0,a.mode=16198;case 16198:for(;a.have<a.nlen+a.ndist;){for(;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(g<16)h>>>=m,d-=m,a.lens[a.have++]=g;else{if(16===g){for(R=m+2;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(h>>>=m,d-=m,0===a.have){t.msg="invalid bit length repeat",a.mode=Le;break}y=a.lens[a.have-1],c=3+(3&h),h>>>=2,d-=2}else if(17===g){for(R=m+3;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=m,d-=m,y=0,c=3+(7&h),h>>>=3,d-=3}else{for(R=m+7;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=m,d-=m,y=0,c=11+(127&h),h>>>=7,d-=7}if(a.have+c>a.nlen+a.ndist){t.msg="invalid bit length repeat",a.mode=Le;break}for(;c--;)a.lens[a.have++]=y}}if(a.mode===Le)break;if(0===a.lens[256]){t.msg="invalid code -- missing end-of-block",a.mode=Le;break}if(a.lenbits=9,E={bits:a.lenbits},x=me(1,a.lens,0,a.nlen,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid literal/lengths set",a.mode=Le;break}if(a.distbits=6,a.distcode=a.distdyn,E={bits:a.distbits},x=me(2,a.lens,a.nlen,a.ndist,a.distcode,0,a.work,E),a.distbits=E.bits,x){t.msg="invalid distances set",a.mode=Le;break}if(a.mode=Oe,e===pe)break t;case Oe:a.mode=Ie;case Ie:if(o>=6&&l>=258){t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,de(t,f),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,a.mode===Se&&(a.back=-1);break}for(a.back=0;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(b&&0==(240&b)){for(p=m,k=b,v=g;z=a.lencode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=p,d-=p,a.back+=p}if(h>>>=m,d-=m,a.back+=m,a.length=g,0===b){a.mode=16205;break}if(32&b){a.back=-1,a.mode=Se;break}if(64&b){t.msg="invalid literal/length code",a.mode=Le;break}a.extra=15&b,a.mode=16201;case 16201:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.length+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra}a.was=a.length,a.mode=16202;case 16202:for(;z=a.distcode[h&(1<<a.distbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(0==(240&b)){for(p=m,k=b,v=g;z=a.distcode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=p,d-=p,a.back+=p}if(h>>>=m,d-=m,a.back+=m,64&b){t.msg="invalid distance code",a.mode=Le;break}a.offset=g,a.extra=15&b,a.mode=16203;case 16203:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.offset+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra}if(a.offset>a.dmax){t.msg="invalid distance too far back",a.mode=Le;break}a.mode=16204;case 16204:if(0===l)break t;if(c=f-l,a.offset>c){if(c=a.offset-c,c>a.whave&&a.sane){t.msg="invalid distance too far back",a.mode=Le;break}c>a.wnext?(c-=a.wnext,u=a.wsize-c):u=a.wnext-c,c>a.length&&(c=a.length),w=a.window}else w=n,u=r-a.offset,c=a.length;c>l&&(c=l),l-=c,a.length-=c;do{n[r++]=w[u++]}while(--c);0===a.length&&(a.mode=Ie);break;case 16205:if(0===l)break t;n[r++]=a.length,l--,a.mode=Ie;break;case Fe:if(a.wrap){for(;d<32;){if(0===o)break t;o--,h|=i[s++]<<d,d+=8}if(f-=l,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,r-f):C(a.check,n,f,r-f)),f=l,4&a.wrap&&(a.flags?h:Ne(h))!==a.check){t.msg="incorrect data check",a.mode=Le;break}h=0,d=0}a.mode=16207;case 16207:if(a.wrap&&a.flags){for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(4&a.wrap&&h!==(4294967295&a.total)){t.msg="incorrect length check",a.mode=Le;break}h=0,d=0}a.mode=16208;case 16208:x=ve;break t;case Le:x=ze;break t;case 16210:return Ae;default:return xe}return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,(a.wsize||f!==t.avail_out&&a.mode<Le&&(a.mode<Fe||e!==be))&&We(t,t.output,t.next_out,f-t.avail_out),_-=t.avail_in,f-=t.avail_out,t.total_in+=_,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,t.next_out-f):C(a.check,n,f,t.next_out-f)),t.data_type=a.bits+(a.last?64:0)+(a.mode===Se?128:0)+(a.mode===Oe||a.mode===Te?256:0),(0===_&&0===f||e===be)&&x===ke&&(x=Ee),x},inflateEnd:t=>{if(Ce(t))return xe;let e=t.state;return e.window&&(e.window=null),t.state=null,ke},inflateGetHeader:(t,e)=>{if(Ce(t))return xe;const a=t.state;return 0==(2&a.wrap)?xe:(a.head=e,e.done=!1,ke)},inflateSetDictionary:(t,e)=>{const a=e.length;let i,n,s;return Ce(t)?xe:(i=t.state,0!==i.wrap&&i.mode!==Ue?xe:i.mode===Ue&&(n=1,n=C(n,e,a,0),n!==i.check)?ze:(s=We(t,e,a,a),s?(i.mode=16210,Ae):(i.havedict=1,ke)))},inflateInfo:"pako inflate (from Nodeca project)"};var Je=function(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1};const Qe=Object.prototype.toString,{Z_NO_FLUSH:Ve,Z_FINISH:$e,Z_OK:ta,Z_STREAM_END:ea,Z_NEED_DICT:aa,Z_STREAM_ERROR:ia,Z_DATA_ERROR:na,Z_MEM_ERROR:sa}=K;function ra(t){this.options=jt({chunkSize:65536,windowBits:15,to:""},t||{});const e=this.options;e.raw&&e.windowBits>=0&&e.windowBits<16&&(e.windowBits=-e.windowBits,0===e.windowBits&&(e.windowBits=-15)),!(e.windowBits>=0&&e.windowBits<16)||t&&t.windowBits||(e.windowBits+=32),e.windowBits>15&&e.windowBits<48&&0==(15&e.windowBits)&&(e.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=qe.inflateInit2(this.strm,e.windowBits);if(a!==ta)throw new Error(j[a]);if(this.header=new Je,qe.inflateGetHeader(this.strm,this.header),e.dictionary&&("string"==typeof e.dictionary?e.dictionary=Gt(e.dictionary):"[object ArrayBuffer]"===Qe.call(e.dictionary)&&(e.dictionary=new Uint8Array(e.dictionary)),e.raw&&(a=qe.inflateSetDictionary(this.strm,e.dictionary),a!==ta)))throw new Error(j[a])}function oa(t,e){const a=new ra(e);if(a.push(t),a.err)throw a.msg||j[a.err];return a.result}ra.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize,n=this.options.dictionary;let s,r,o;if(this.ended)return!1;for(r=e===~~e?e:!0===e?$e:Ve,"[object ArrayBuffer]"===Qe.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;){for(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),s=qe.inflate(a,r),s===aa&&n&&(s=qe.inflateSetDictionary(a,n),s===ta?s=qe.inflate(a,r):s===na&&(s=aa));a.avail_in>0&&s===ea&&a.state.wrap>0&&0!==t[a.next_in];)qe.inflateReset(a),s=qe.inflate(a,r);switch(s){case ia:case na:case aa:case sa:return this.onEnd(s),this.ended=!0,!1}if(o=a.avail_out,a.next_out&&(0===a.avail_out||s===ea))if("string"===this.options.to){let t=Wt(a.output,a.next_out),e=a.next_out-t,n=Xt(a.output,t);a.next_out=e,a.avail_out=i-e,e&&a.output.set(a.output.subarray(t,t+e),0),this.onData(n)}else this.onData(a.output.length===a.next_out?a.output:a.output.subarray(0,a.next_out));if(s!==ta||0!==o){if(s===ea)return s=qe.inflateEnd(this.strm),this.onEnd(s),this.ended=!0,!0;if(0===a.avail_in)break}}return!0},ra.prototype.onData=function(t){this.chunks.push(t)},ra.prototype.onEnd=function(t){t===ta&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg};var la={Inflate:ra,inflate:oa,inflateRaw:function(t,e){return(e=e||{}).raw=!0,oa(t,e)},ungzip:oa,constants:K};const{Deflate:ha,deflate:da,deflateRaw:_a,gzip:fa}=le,{Inflate:ca,inflate:ua,inflateRaw:wa,ungzip:ma}=la;var ba=ha,ga=da,pa=_a,ka=fa,va=ca,ya=ua,xa=wa,za=ma,Aa=K,Ea={Deflate:ba,deflate:ga,deflateRaw:pa,gzip:ka,Inflate:va,inflate:ya,inflateRaw:xa,ungzip:za,constants:Aa};t.Deflate=ba,t.Inflate=va,t.constants=Aa,t.default=Ea,t.deflate=ga,t.deflateRaw=pa,t.gzip=ka,t.inflate=ya,t.inflateRaw=xa,t.ungzip=za,Object.defineProperty(t,"__esModule",{value:!0})}));

return module.exports;})();
