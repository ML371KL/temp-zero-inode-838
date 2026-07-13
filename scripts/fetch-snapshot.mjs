/*
  Сейсмостанция «21M» v2 — консервативный сборщик режимного снимка Bitcoin.
  Node.js 24+, без npm-зависимостей.

  Принципы:
  - только бесплатные, публичные и воспроизводимые источники;
  - никакой подмены платных labelled-метрик сомнительными прокси;
  - динамические пороги для циклических рядов, механические — только там,
    где у показателя есть экономический ноль/паритет;
  - вердикт задаёт иерархия гейтов, числовые баллы вторичны;
  - переход обычного режима требует двух последовательных снимков;
  - аварийный override применяется сразу.
*/
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION = "2.7.0";
const OUT = process.env.OUT || "docs/snapshot.json";
const STATE = process.env.STATE || ".state/cache.json";
// The live candidate is written to temporary paths and only copied into docs/ after it passes
// verification. `previous` is therefore read from explicit paths rather than from the output paths.
const PREVIOUS_STATE = process.env.PREVIOUS_STATE || STATE;
const PREVIOUS_PUBLIC = process.env.PREVIOUS_PUBLIC || "docs/snapshot.json";
const FRED_KEY = process.env.FRED_KEY || "";
const CM_KEY = process.env.CM_API_KEY || "";
const MOCK = process.env.MOCK === "1";
const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;

const THESIS = "Глобальная ликвидность и маржинальный спот-спрос должны поглощать доступное предложение Bitcoin быстрее, чем его возвращают биржевые притоки, майнерский стресс и принудительный делеверидж.";

const SOURCE_URLS = {
  fred: "https://fred.stlouisfed.org/docs/api/fred/series_observations.html",
  coingecko: "https://docs.coingecko.com/docs/keyless-public-api",
  mempool: "https://mempool.space/docs/api/rest",
  bitstamp: "https://www.bitstamp.net/api/",
  farside: "https://farside.co.uk/bitcoin-etf-flow-all-data/",
  defillama: "https://defillama.com/stablecoins",
  coinmetrics: "https://docs.coinmetrics.io/api",
  cftc: "https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if",
  deribit: "https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency",
  bybit: "https://bybit-exchange.github.io/docs/v5/market/tickers",
  okx: "https://www.okx.com/docs-v5/en/",
  coinbase: "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker",
  kraken: "https://docs.kraken.com/api-reference/market-data/get-ticker-information",
  kraken_futures: "https://docs.kraken.com/api/docs/futures-api/trading/get-tickers/",
  gemini: "https://developer.gemini.com/trading/rest-api/market-data/get-ticker",
  blockchain: "https://www.blockchain.com/explorer/api/charts_api",
  blockstream: "https://github.com/Blockstream/esplora/blob/master/API.md",
};
const SOURCE_URL_GROUPS = {
  derivatives: [SOURCE_URLS.deribit, SOURCE_URLS.kraken_futures, SOURCE_URLS.bybit, SOURCE_URLS.okx],
  spot: [SOURCE_URLS.coinbase, SOURCE_URLS.kraken, SOURCE_URLS.bitstamp, SOURCE_URLS.gemini, SOURCE_URLS.okx, SOURCE_URLS.bybit],
};
// Venues are grouped by quote currency. USD and USDT are never mixed. Each group carries
// redundant venues so that a single geo-blocked exchange cannot erase an entire quote group.
const SPOT_QUOTE_GROUPS = {
  USD: ["coinbase", "kraken", "bitstamp", "gemini"],
  USDT: ["okx", "bybit", "kraken_usdt", "coinbase_usdt"],
};
const uniqueHttps = values => [...new Set((values||[]).filter(x=>typeof x==="string"&&/^https:\/\//.test(x)))];
const fredSeriesUrl = id => `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`;
const fredSeriesUrls = ids => ids.map(fredSeriesUrl);

const BLOCKS = {
  macro: { roman: "I", title: "Глобальный режим", subtitle: "ликвидность · ставки · доллар · кредит", strategicWeight: 30, tacticalWeight: 10 },
  demand: { roman: "II", title: "Маржинальный спрос и доступное предложение", subtitle: "ETF · стейблкоины · биржевые потоки · CFTC", strategicWeight: 40, tacticalWeight: 25 },
  cycle: { roman: "III", title: "Цикл, сеть и майнеры", subtitle: "MVRV · активность · экономика майнинга · тренд", strategicWeight: 30, tacticalWeight: 10 },
  leverage: { roman: "IV", title: "Плечо и волатильность", subtitle: "funding · OI · basis · DVOL · skew", strategicWeight: 0, tacticalWeight: 45 },
  market: { roman: "V", title: "Качество цены", subtitle: "премия США · синхронность площадок · объём", strategicWeight: 0, tacticalWeight: 10 },
};

// Cycle drops to 0.40 because two of its five families (valuation, activity) and part of a third
// (miners) come from Coin Metrics, which is now optional. The two vendor-independent legs —
// network security and price trend — are instead made explicitly REQUIRED below, so a low coverage
// number can never mean "we lost the reliable half". Leverage and market thresholds are only used
// for display: the tactical gate no longer depends on the leverage block at all.
const CRITICAL_MIN = { macro: 0.60, demand: 0.60, cycle: 0.40, leverage: 0.25, market: 0.50 };

const FRED_SERIES = {
  WALCL: { limit: 260, ttl: 14 * DAY },
  WTREGEN: { limit: 260, ttl: 14 * DAY },
  RRPONTSYD: { limit: 1800, ttl: 7 * DAY },
  DFII10: { limit: 1200, ttl: 7 * DAY },
  DGS2: { limit: 1200, ttl: 7 * DAY },
  DGS10: { limit: 1200, ttl: 7 * DAY },
  DTWEXBGS: { limit: 1200, ttl: 7 * DAY },
  BAMLH0A0HYM2: { limit: 1200, ttl: 7 * DAY },
  VIXCLS: { limit: 1200, ttl: 7 * DAY },
  VXVCLS: { limit: 1200, ttl: 7 * DAY },
  NASDAQ100: { limit: 1200, ttl: 7 * DAY },
};

const CM_METRICS = [
  "CapMVRVCur", "FlowInExNtv", "FlowOutExNtv", "SplyExNtv",
  "IssTotUSD", "FeeTotNtv", "AdrActCnt", "TxCnt", "TxTfrCnt"
];

// Coin Metrics is now a pure ENRICHMENT layer with zero required series. Price, volume and market
// cap come from `market` (Coinbase + CoinGecko); hashrate and difficulty come from `network`
// (mempool.space). Coin Metrics only adds what nothing else provides for free: realized-cap MVRV,
// exchange-labelled flows, address/transaction activity and miner revenue. If the free tier stops
// serving them, those cards lose their vote and nothing else in the model breaks.
const CM_REQUIRED_METRICS = [];
const CM_OPTIONAL_METRICS = [...CM_METRICS];

// Deterministic Bitcoin issuance schedule used to construct a transparent market-cap series from
// the independent daily price history. It never substitutes for realised cap, MVRV or labelled
// on-chain data. The dashboard uses market cap only for context, not as a unique causal signal.
const HALVING_T = Date.UTC(2024, 3, 20), HALVING_SUPPLY = 19_687_500;
const estimatedSupply = t => { const d = (Number(t) - HALVING_T) / 86_400_000; return d >= 0 ? HALVING_SUPPLY + 450 * d : HALVING_SUPPLY + 900 * d; };

// Canonical units for every provider path. A provider is rejected rather than silently rescaled
// when its latest observation cannot be mapped unambiguously into a physically plausible band.
const SERIES_CONTRACT = {
  price:           { unit:"USD/BTC",        lo:1e3,   hi:1e7,   scales:[1] },
  volume:          { unit:"USD/day",        lo:1e6,   hi:1e13,  scales:[1] },
  marketCap:       { unit:"USD",            lo:1e11,  hi:1e14,  scales:[1] },
  mvrv:            { unit:"ratio",          lo:.3,    hi:8,     scales:[1] },
  hashrate:        { unit:"H/s",            lo:2e20,  hi:5e21,  scales:[1,1e3,1e6,1e9,1e12,1e18], historyLo:5e19 },
  difficulty:      { unit:"dimensionless",  lo:1e13,  hi:1e16,  scales:[1,1e12], historyLo:1e12 },
  minerRevenue:    { unit:"USD/day",        lo:1e6,   hi:1e10,  scales:[1] },
  activeAddresses: { unit:"count/day",      lo:1e4,   hi:5e6,   scales:[1] },
  txCount:         { unit:"count/day",      lo:1e4,   hi:5e6,   scales:[1] },
  exchangeSupply:  { unit:"BTC",            lo:1e5,   hi:6e6,   scales:[1] },
  pegPrice:        { unit:"USD/token",       lo:.01,   hi:5,     scales:[1] },
};
function normalizeToContract(name,rows){
  const c=SERIES_CONTRACT[name];if(!c)throw new Error(`no dimension contract for ${name}`);
  const clean=(rows||[]).map(r=>({t:Number(r.t),v:Number(r.v)})).filter(r=>Number.isFinite(r.t)&&Number.isFinite(r.v)&&r.v!==0).sort((a,b)=>a.t-b.t);
  if(!clean.length)throw new Error(`${name}: empty series`);
  const latest=clean.at(-1).v,fits=c.scales.filter(k=>latest*k>=c.lo&&latest*k<=c.hi);
  if(fits.length!==1)throw new Error(`${name}: ${fits.length?"ambiguous":"invalid"} scale for ${latest} ${c.unit}`);
  const scale=fits[0],floor=(c.historyLo??c.lo)*.2,ceil=c.hi*5,out=clean.map(r=>({t:r.t,v:r.v*scale})),bad=out.filter(r=>r.v<floor||r.v>ceil);
  if(bad.length>out.length*.02)throw new Error(`${name}: ${bad.length}/${out.length} points outside physical band`);
  return{rows:out.filter(r=>r.v>=floor&&r.v<=ceil),scale,unit:c.unit};
}
function safeContract(name,rows,errors,{required=false}={}){
  try{return normalizeToContract(name,rows).rows;}catch(e){errors?.push(`${name}: ${String(e?.message||e)}`);if(required)throw e;return[];}
}
function crossCheck(name,a,b,tolerance){if(!finite(a)||!finite(b))return null;const d=Math.abs(Number(a)/Number(b)-1);return d<=tolerance?null:`${name}: providers differ by ${(d*100).toFixed(1)}%`;}

const finite = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const num = v => finite(v) ? Number(v) : null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roundSym = v => Number(v)>=0 ? Math.floor(Number(v)+0.5) : Math.ceil(Number(v)-0.5);
const sanePrice = v => finite(v) && Number(v)>1_000 && Number(v)<10_000_000;
const mean = a => a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null;
const sum = a => a.filter(finite).reduce((s, v) => s + Number(v), 0);
const sumOrNull = a => { const x=(a||[]).filter(finite).map(Number); return x.length?x.reduce((s,v)=>s+v,0):null; };
const median = a => { const x=a.filter(finite).map(Number).sort((a,b)=>a-b); if(!x.length)return null; const m=Math.floor(x.length/2); return x.length%2?x[m]:(x[m-1]+x[m])/2; };
const stdev = a => { if(a.length<2)return null; const m=mean(a); return Math.sqrt(mean(a.map(v=>(v-m)**2))); };
const last = a => a?.length ? a[a.length-1] : null;
const pct = (a,b) => finite(a)&&finite(b)&&Number(b)!==0 ? (Number(a)/Number(b)-1)*100 : null;
const iso = t => new Date(t).toISOString();
const dayKey = t => new Date(t).toISOString().slice(0,10);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const formatCompact = (v,d=1) => { if(!finite(v))return "—"; const n=Number(v),a=Math.abs(n); if(a>=1e12)return (n/1e12).toFixed(d)+" трлн"; if(a>=1e9)return (n/1e9).toFixed(d)+" млрд"; if(a>=1e6)return (n/1e6).toFixed(d)+" млн"; if(a>=1e3)return (n/1e3).toFixed(d)+" тыс."; return n.toFixed(d); };

function series(rows){ return (rows||[]).map(r=>({t:new Date(r.t??r.time??r.date).getTime(),v:Number(r.v??r.value)})).filter(p=>finite(p.t)&&finite(p.v)).sort((a,b)=>a.t-b.t); }
function priorByDays(s,days){ if(!s?.length)return null; const target=last(s).t-days*DAY; let best=null; for(const p of s){if(p.t<=target)best=p;else break;} return best; }
function sliceDays(s,days){ if(!s?.length)return[]; const cut=last(s).t-days*DAY; return s.filter(p=>p.t>=cut); }
function returns(s){ return s.slice(1).map((p,i)=>({t:p.t,v:Math.log(p.v/s[i].v)})).filter(p=>finite(p.v)); }
function corr(a,b){ const n=Math.min(a.length,b.length); if(n<20)return null; const x=a.slice(-n),y=b.slice(-n),mx=mean(x),my=mean(y),sx=stdev(x),sy=stdev(y); return sx&&sy?mean(x.map((v,i)=>(v-mx)*(y[i]-my)))/(sx*sy):null; }
function percentileRank(values,value){ const x=values.filter(finite).map(Number); if(x.length<30||!finite(value))return null; const y=Number(value),less=x.filter(v=>v<y).length,equal=x.filter(v=>v===y).length; return (less+0.5*equal)/x.length*100; }
function annualizedVol(s,days=30){ const r=returns(s).slice(-days).map(x=>x.v),sd=stdev(r); return sd==null?null:sd*Math.sqrt(365)*100; }
function rollingSum(s,n){ const out=[]; for(let i=n-1;i<s.length;i++){const v=sumOrNull(s.slice(i-n+1,i+1).map(x=>x.v));if(finite(v))out.push({t:s[i].t,v});} return out; }
function rollingMean(s,n){ const out=[]; for(let i=n-1;i<s.length;i++){const v=mean(s.slice(i-n+1,i+1).map(x=>x.v).filter(finite));if(finite(v))out.push({t:s[i].t,v});} return out; }
function convertDailyUsdFlowsToBtc(flows,prices){const byDay=new Map(prices.map(x=>[dayKey(x.t),x.v]));return flows.map(row=>{const p=byDay.get(dayKey(row.t))??nearestAtOrBefore(prices,row.t)?.v;return finite(p)&&Number(p)>0?{t:row.t,v:row.v/Number(p)}:null;}).filter(Boolean);}
function changeOfAverageSeries(s,recent=30,previous=90){const out=[];for(let i=recent+previous-1;i<s.length;i++){const r=mean(s.slice(i-recent+1,i+1).map(x=>x.v).filter(finite));const b=mean(s.slice(i-recent-previous+1,i-recent+1).map(x=>x.v).filter(finite));const v=pct(r,b);if(finite(v))out.push({t:s[i].t,v});}return out;}
function trailingChangeSeries(s,days,{difference=false,scale=1}={}){const out=[];for(let i=1,j=0;i<s.length;i++){const target=s[i].t-days*DAY;while(j+1<i&&s[j+1].t<=target)j++;const prev=s[j];if(!prev||prev.t>target||!finite(prev.v)||!finite(s[i].v))continue;const v=difference?(s[i].v-prev.v)*scale:pct(s[i].v,prev.v);if(finite(v))out.push({t:s[i].t,v});}return out;}
function changeOfAverage(s,recent=30,previous=30){ const a=s.map(x=>x.v).filter(finite); if(a.length<recent+previous)return null; return pct(mean(a.slice(-recent)),mean(a.slice(-recent-previous,-recent))); }
function nearestAtOrBefore(s,t){ let found=null; for(const p of s){ if(p.t<=t)found=p; else break; } return found; }
function customScore(v,bands){ if(!finite(v))return null; for(const [test,score] of bands)if(test(Number(v)))return score; return 0; }
function percentChangeCommonVenues(current,prior,minVenues=2){if(!current||!prior)return null;const venues=Object.keys(current).filter(k=>finite(current[k])&&finite(prior[k]));if(venues.length<minVenues)return null;return pct(sum(venues.map(k=>current[k])),sum(venues.map(k=>prior[k])));}
function classifyIntegrity({peg,disp,majorDevs=[],usdSpread=null,usdtSpread=null}){const catastrophicPeg=majorDevs.some(x=>finite(x)&&Number(x)>=10),extremePeg=majorDevs.some(x=>finite(x)&&Number(x)>=5),doublePeg=majorDevs.length===2&&majorDevs.every(x=>finite(x)&&Number(x)>=1),doubleDisp=finite(usdSpread)&&finite(usdtSpread)&&Number(usdSpread)>=100&&Number(usdtSpread)>=100,extremeDisp=[usdSpread,usdtSpread].filter(finite).some(x=>Number(x)>=300),marketConfirm=doubleDisp||extremeDisp||(finite(disp)&&Number(disp)>=50),confirmed=catastrophicPeg||((extremePeg||doublePeg)&&marketConfirm)||doubleDisp||extremeDisp;return confirmed?"fired":((extremePeg||doublePeg)||(finite(peg)&&Number(peg)>=.5)||(finite(disp)&&Number(disp)>=50)?"watch":"calm");}

let previous=null;
for(const path of [PREVIOUS_STATE,PREVIOUS_PUBLIC]){
  try{if(path&&existsSync(path)){previous=JSON.parse(readFileSync(path,"utf8"));break;}}catch{}
}

function retryAfterMs(value,now=Date.now()){
  if(value==null||value==="")return null;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.min(30_000,seconds*1000);
  const at=Date.parse(String(value));
  return Number.isFinite(at)?Math.max(0,Math.min(30_000,at-now)):null;
}
async function request(url,{text=false,tries=3,headers={}}={}){
  let err;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{"User-Agent":"btc-21m-dashboard/2.6","Accept":text?"text/plain,text/html,*/*":"application/json,*/*",...headers},signal:AbortSignal.timeout(25_000)});
      if(!r.ok){
        const wait=(r.status===429||r.status>=500)?retryAfterMs(r.headers.get("retry-after")):null;
        if(wait!==null&&wait>0)await sleep(wait);
        throw new Error(`HTTP ${r.status}`);
      }
      const body=text?await r.text():await r.json();
      if(body==null)throw new Error("empty response");
      return body;
    }catch(e){
      err=e;
      if(i<tries-1){const base=900*(2**i),jitter=Math.floor(Math.random()*250);await sleep(Math.min(5_000,base+jitter));}
    }
  }
  throw err;
}
async function settled(label,fn){try{return{ok:true,label,value:await fn()};}catch(error){return{ok:false,label,error:String(error?.message||error)}}}
async function deribitRequest(url){const j=await request(url);if(j?.error)throw new Error(`Deribit ${j.error.code??""} ${j.error.message||"API error"}`.trim());return j;}
async function bybitRequest(url){const j=await request(url);if(j?.retCode!==undefined&&Number(j.retCode)!==0)throw new Error(`Bybit ${j.retCode}: ${j.retMsg||"API error"}`);return j;}
async function okxRequest(url){
  const candidates=[
    String(url).replace("https://www.okx.com","https://openapi.okx.com"),
    String(url).replace("https://openapi.okx.com","https://www.okx.com"),
  ].filter((x,i,a)=>x&&a.indexOf(x)===i);
  let lastError=null;
  for(const candidate of candidates){
    try{
      const j=await request(candidate);
      if(j?.code!==undefined&&String(j.code)!=="0")throw new Error(`OKX ${j.code}: ${j.msg||"API error"}`);
      return j;
    }catch(error){lastError=error;}
  }
  throw lastError||new Error("OKX request failed");
}
async function krakenRequest(url){const j=await request(url);if(Array.isArray(j?.error)&&j.error.length)throw new Error(`Kraken: ${j.error.join(", ")}`);return j;}

const datasets={};
const sourceStates={};
function observationAge(packet){const t=Date.parse(packet?.observed_at||"");return Number.isFinite(t)?NOW-t:Infinity;}
function validObservationAge(packet,maxObservedAge){const age=observationAge(packet);return Number.isFinite(age)&&age>=-HOUR&&age<=maxObservedAge;}
function oldDataset(key,ttl,maxObservedAge=ttl){
  if(previous?.mock&&!MOCK)return null;
  const old=previous?.datasets?.[key];
  if(!old)return null;
  const fetched=new Date(old.fetched_at||previous.generated_at||0).getTime();
  return NOW-fetched<=ttl&&validObservationAge(old,maxObservedAge)?old:null;
}
async function loadDataset(key,source,ttl,loader,validator=v=>v!=null,{maxObservedAge=ttl}={}){
  try{
    const payload=await loader();
    const packet=payload?.data!==undefined&&payload?.observed_at?payload:{data:payload,observed_at:iso(NOW)};
    if(!validator(packet.data))throw new Error("validation failed");
    const age=observationAge(packet);
    if(age < -HOUR)throw new Error(`upstream observation is in the future: ${Math.round(-age/HOUR)}h`);
    if(age>maxObservedAge)throw new Error(`upstream observation stale: ${Math.round(age/HOUR)}h`);
    const sourceId=packet.source||source,sourceUrl=packet.source_url||SOURCE_URLS[sourceId]||SOURCE_URLS[source];
    const sourceUrls=uniqueHttps(packet.source_urls?.length?packet.source_urls:[sourceUrl]);
    datasets[key]={...packet,fetched_at:iso(NOW),source:sourceId,source_url:sourceUrl,source_urls:sourceUrls};
    const state=packet.partial?"partial":"ok";
    sourceStates[key]={state,source:sourceId,url:sourceUrl,urls:sourceUrls,observed_at:packet.observed_at,fetched_at:iso(NOW),error:packet.errors?.join("; ")||null};
  }catch(e){
    const old=oldDataset(key,ttl,maxObservedAge);
    if(old){const u=old.source_url||SOURCE_URLS[source],urls=uniqueHttps(old.source_urls?.length?old.source_urls:[u]);datasets[key]=old;sourceStates[key]={state:"stale",source:old.source||source,url:u,urls,observed_at:old.observed_at,fetched_at:old.fetched_at,error:String(e.message||e)};}
    else {const u=SOURCE_URLS[source];sourceStates[key]={state:"fail",source,url:u,urls:uniqueHttps([u]),observed_at:null,fetched_at:null,error:String(e.message||e)};}
  }
}
function data(key){return datasets[key]?.data;}
function obs(key){return datasets[key]?.observed_at||null;}
function stale(key){return ["stale","partial"].includes(sourceStates[key]?.state);}
function sourceMetaMany(keys){const packets=(keys||[]).map(k=>({state:sourceStates[k],dataset:datasets[k]})).filter(x=>x.state);const dates=packets.map(x=>Date.parse(x.dataset?.observed_at||"")).filter(Number.isFinite);return{observed_at:dates.length?iso(Math.min(...dates)):null,stale:packets.some(x=>["stale","partial","fail"].includes(x.state.state))};}
function quoteGroupPrices(spot,group){return (SPOT_QUOTE_GROUPS[group]||[]).map(k=>spot?.[k]).filter(sanePrice).map(Number);}
function quoteDispersion(spot,group){const v=quoteGroupPrices(spot,group);return v.length>=2?(Math.max(...v)/Math.min(...v)-1)*10000:null;}
function referencePrice(){const packet=datasets.spot,s=packet?.data||{};if(packet&&validObservationAge(packet,6*HOUR)){for(const group of ["USD","USDT"]){const v=quoteGroupPrices(s,group);if(v.length>=2)return median(v);}}const daily=series(datasets.market?.data?.price||[]);return last(daily)?.v??null;}

function parseFred(j){return (j?.observations||[]).filter(o=>o.value!=="."&&finite(o.value)).map(o=>({t:Date.parse(o.date+"T00:00:00Z"),v:Number(o.value)})).sort((a,b)=>a.t-b.t);}
function parseFredCsv(text){
  // Position-based parse. The keyless endpoint (fredgraph.csv?id=…) now returns the header
  // "observation_date,<SERIES>"; matching the value column by name (≠"DATE") silently selects the
  // date column against that header and drops every row — a stale-mock trap. Read the date from
  // column 0 and the value from column 1 regardless of the header labels.
  const lines=String(text||"").trim().split(/\r?\n/);
  if(lines.length<2)throw new Error("FRED CSV: no rows");
  const head=lines[0].split(",").map(x=>x.trim().toLowerCase());
  if(head.length<2||!/date/.test(head[0]))throw new Error(`FRED CSV: unexpected header "${lines[0]}"`);
  const out=[];
  for(const line of lines.slice(1)){
    const cells=line.split(",");
    const t=Date.parse(String(cells[0]||"").trim()+"T00:00:00Z");
    const v=Number(String(cells[1]||"").trim());   // FRED writes "." for a missing value -> NaN -> dropped
    if(Number.isFinite(t)&&Number.isFinite(v))out.push({t,v});
  }
  return out.sort((a,b)=>a.t-b.t);
}
async function fetchFredSeries(id,cfg){let apiError=null;try{if(!FRED_KEY)throw new Error("нет FRED_KEY");const u=`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${cfg.limit}`,a=parseFred(await request(u));if(a.length<20)throw new Error("FRED API history too short");return{data:a,observed_at:iso(last(a).t),source:"FRED API",source_url:fredSeriesUrl(id),source_urls:[fredSeriesUrl(id),SOURCE_URLS.fred]};}catch(e){apiError=e;}
  const csv=await request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`,{text:true,tries:2}),a=parseFredCsv(csv,id);if(a.length<20)throw new Error(`FRED API failed (${apiError?.message}); CSV fallback too short`);return{data:a.slice(-Math.max(cfg.limit,20)),observed_at:iso(last(a).t),source:"FRED CSV fallback",source_url:fredSeriesUrl(id),source_urls:[fredSeriesUrl(id),SOURCE_URLS.fred],partial:true,errors:[`FRED API: ${apiError?.message}`]};}
function stripHtml(s){return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&minus;|&#8722;/gi,"-").replace(/\s+/g," ").trim();}
function parseFlowNumber(s){const t=stripHtml(s).replace(/[$,%*]/g,"").replace(/,/g,"").trim();if(!t||/^[-—–]$/.test(t))return 0;const neg=/^\(.*\)$/.test(t),n=Number(t.replace(/[()]/g,""));return finite(n)?(neg?-n:n):null;}
function parseFarside(html){const rows=[];for(const row of html.match(/<tr[\s\S]*?<\/tr>/gi)||[]){const cells=(row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi)||[]).map(stripHtml);if(cells.length<3||!/^\d{1,2}\s+[A-Za-z]{3}\s+20\d{2}$/.test(cells[0]))continue;const fundCells=cells.slice(1,-1),allDash=fundCells.length>0&&fundCells.every(x=>!x||/^[-—–]$/.test(x.trim()));const v=parseFlowNumber(cells[cells.length-1]),t=Date.parse(cells[0]+" 00:00:00 UTC");if(allDash&&Number(v)===0)continue;if(finite(v)&&finite(t))rows.push({t,v:Number(v)*1e6});}return [...new Map(rows.map(x=>[x.t,x])).values()].sort((a,b)=>a.t-b.t);}
function validateEtfSeries(rows,maxAge=5*DAY){
  if(!Array.isArray(rows)||rows.length<100)return false;
  let prev=-Infinity;
  for(const row of rows){
    const t=Number(row?.t),v=Number(row?.v);
    if(!Number.isFinite(t)||!Number.isFinite(v)||t<=prev||t>NOW+HOUR||Math.abs(v)>10_000_000_000)return false;
    prev=t;
  }
  const latest=Number(last(rows)?.t);
  if(!Number.isFinite(latest)||NOW-latest>maxAge)return false;
  // US spot-ETF data must be trading-day data. Weekend rows signal that the HTML layout/parser changed.
  return rows.slice(-80).every(x=>![0,6].includes(new Date(Number(x.t)).getUTCDay()));
}
function parseCsv(text){const lines=String(text).trim().split(/\r?\n/);if(lines.length<2)return[];const h=lines[0].split(",");return lines.slice(1).map(line=>{const c=line.split(","),o={};h.forEach((k,i)=>o[k]=c[i]);return o;});}
function normalizeCoinMetricsRows(rows){const by={};CM_METRICS.forEach(k=>by[k]=[]);for(const r of rows){const t=Date.parse(String(r.time).slice(0,10)+"T00:00:00Z");if(!finite(t))continue;for(const k of CM_METRICS)if(finite(r[k]))by[k].push({t,v:Number(r[k])});}for(const k of CM_METRICS)by[k].sort((a,b)=>a.t-b.t);return by;}
function validateCoinMetricsData(by,maxAge=4*DAY){
  const latest=[],errors=[];
  for(const k of CM_REQUIRED_METRICS){
    const a=by?.[k];
    if(!Array.isArray(a)||a.length<500)throw new Error(`Coin Metrics required series missing: ${k}`);
    const t=Number(last(a)?.t),age=NOW-t;
    if(!Number.isFinite(t)||age < -HOUR)throw new Error(`Coin Metrics future/invalid observation: ${k}`);
    if(age>maxAge)throw new Error(`Coin Metrics required series stale: ${k} · ${Math.round(age/HOUR)}h`);
    latest.push(t);
  }
  for(const k of CM_OPTIONAL_METRICS){
    const a=by?.[k],t=Number(last(a)?.t),age=NOW-t;
    if(!Array.isArray(a)||a.length<180){by[k]=[];errors.push(`optional series unavailable: ${k}`);continue;}
    if(!Number.isFinite(t)||age < -HOUR||age>maxAge){by[k]=[];errors.push(`optional series stale/invalid: ${k}`);continue;}
    latest.push(t);
  }
  // With no hard-required series left, the packet timestamp is the oldest surviving observation.
  return {observed_at:latest.length?iso(Math.min(...latest)):iso(NOW),partial:errors.length>0,errors};
}
function normalizeStableHistory(j){const arr=Array.isArray(j)?j:j?.data||[];return arr.map(r=>{const raw=r.date??r.timestamp??r.time,n=Number(raw),t=Number.isFinite(n)?(n<1e12?n*1000:n):Date.parse(raw);const v=r.totalCirculating?.peggedUSD??r.totalCirculatingUSD?.peggedUSD??r.totalCirculatingUSD??r.totalCirculating??r.total;return{t,v:Number(v)};}).filter(x=>finite(x.t)&&finite(x.v)&&x.v>1e9).sort((a,b)=>a.t-b.t);}
function parseCftc(rows){return (rows||[]).map(r=>({
  t:Date.parse(r.report_date_as_yyyy_mm_dd),
  oi:num(r.open_interest_all),
  assetLong:num(r.asset_mgr_positions_long??r.asset_mgr_positions_long_all),
  assetShort:num(r.asset_mgr_positions_short??r.asset_mgr_positions_short_all),
  levLong:num(r.lev_money_positions_long??r.lev_money_positions_long_all),
  levShort:num(r.lev_money_positions_short??r.lev_money_positions_short_all),
})).filter(r=>finite(r.t)&&finite(r.oi)).sort((a,b)=>a.t-b.t);}
function parseBlockchainChart(j,{scale=1,minPoints=30,expectedUnit=null}={}){if(j?.status&&j.status!=="ok")throw new Error(`Blockchain chart status ${j.status}`);if(expectedUnit&&j?.unit&&String(j.unit).toLowerCase()!==String(expectedUnit).toLowerCase())throw new Error(`Blockchain chart unit ${j.unit}, expected ${expectedUnit}`);const a=(j?.values||[]).map(x=>({t:Number(x.x)*1000,v:Number(x.y)*scale})).filter(x=>finite(x.t)&&finite(x.v)).sort((x,y)=>x.t-y.t);if(a.length<minPoints)throw new Error(`Blockchain chart too short: ${a.length}`);return a;}
async function fetchBlockchainChart(name,timespan,{scale=1,minPoints=30,expectedUnit=null}={}){const u=`https://api.blockchain.info/charts/${name}?timespan=${encodeURIComponent(timespan)}&format=json&sampled=false`;return parseBlockchainChart(await request(u,{tries:2}),{scale,minPoints,expectedUnit});}
function validateBlockchainOnchainData(data,maxAge=4*DAY){const errors=[],dates=[];for(const[k,a]of Object.entries(data||{})){const t=Number(last(a)?.t),age=NOW-t;if(!Array.isArray(a)||a.length<180||!Number.isFinite(t)||age< -HOUR||age>maxAge){data[k]=[];errors.push(`series unavailable/stale: ${k}`);}else dates.push(t);}if(!dates.length)throw new Error(errors.join("; ")||"no Blockchain on-chain series");return{observed_at:iso(Math.min(...dates)),partial:errors.length>0,errors};}
async function fetchBlockchainOnchain(){const tasks=await Promise.all([
  settled("mvrv",()=>fetchBlockchainChart("mvrv","5years",{minPoints:500})),
  settled("addresses",()=>fetchBlockchainChart("n-unique-addresses","5years",{minPoints:500})),
  settled("transactions",()=>fetchBlockchainChart("n-transactions","5years",{minPoints:500})),
  settled("miner revenue",()=>fetchBlockchainChart("miners-revenue","5years",{minPoints:500,expectedUnit:"USD"})),
]);const by=Object.fromEntries(tasks.filter(x=>x.ok).map(x=>[x.label,x.value])),errors=tasks.filter(x=>!x.ok).map(x=>`${x.label}: ${x.error}`),data={MVRV:safeContract("mvrv",by.mvrv||[],errors),AdrActCnt:safeContract("activeAddresses",by.addresses||[],errors),TxCnt:safeContract("txCount",by.transactions||[],errors),MinerRevUSD:safeContract("minerRevenue",by["miner revenue"]||[],errors)};const q=validateBlockchainOnchainData(data);errors.push(...q.errors);return{data,observed_at:q.observed_at,source:"Blockchain.com Charts",source_url:SOURCE_URLS.blockchain,source_urls:[SOURCE_URLS.blockchain],partial:errors.length>0,errors};}

function mockWalk(days,start,drift,vol,seed=1){let x=start,s=seed>>>0,out=[];for(let i=days-1;i>=0;i--){s=(1664525*s+1013904223)>>>0;const u=s/4294967296-.5;x=Math.max(.0001,x*(1+drift+u*vol));out.push({t:NOW-i*DAY,v:x});}return out;}
function makeMock(){
  const price=mockWalk(1500,26000,.0010,.035,11),mcap=price.map(p=>({t:p.t,v:p.v*19_800_000}));
  const cm={PriceUSD:price,CapMrktCurUSD:mcap,CapMVRVCur:mockWalk(1500,1.05,.0007,.018,12),FlowInExNtv:mockWalk(1500,18000,0,.22,13),FlowOutExNtv:mockWalk(1500,18500,0,.22,14),SplyExNtv:mockWalk(1500,2_900_000,-.00012,.004,15),HashRate:mockWalk(1500,6e8,.0008,.025,16),IssTotUSD:price.map(p=>({t:p.t,v:p.v*450})),FeeTotNtv:mockWalk(1500,18,0,.35,17),AdrActCnt:mockWalk(1500,700000,.0001,.12,18),TxCnt:mockWalk(1500,420000,.0001,.10,19),TxTfrCnt:mockWalk(1500,850000,.0001,.12,20),volume_reported_spot_usd_1d:mockWalk(1500,7e9,.0001,.28,21),SplyCur:price.map((p,i)=>({t:p.t,v:19_700_000+i*450}))};
  const fred={};
  fred.WALCL=mockWalk(900,7.2e6,.00002,.001,31);fred.WTREGEN=mockWalk(900,650000,.0001,.08,32);fred.RRPONTSYD=mockWalk(900,120,-.001,.15,33);fred.DFII10=mockWalk(900,1.7,0,.025,34);fred.DGS2=mockWalk(900,4.0,0,.018,35);fred.DGS10=mockWalk(900,4.2,0,.015,36);fred.DTWEXBGS=mockWalk(900,123,0,.006,37);fred.BAMLH0A0HYM2=mockWalk(900,3.3,0,.025,38);fred.VIXCLS=mockWalk(900,17,0,.12,39);fred.VXVCLS=mockWalk(900,19,0,.07,40);fred.NASDAQ100=mockWalk(900,18000,.0006,.018,41);
  for(const [k,v] of Object.entries(fred)){datasets["fred_"+k]={data:v,observed_at:iso(last(v).t),fetched_at:iso(NOW),source:"fred",source_url:SOURCE_URLS.fred};sourceStates["fred_"+k]={state:"mock",source:"fred",url:SOURCE_URLS.fred,observed_at:iso(last(v).t),fetched_at:iso(NOW)};}
  datasets.coinmetrics={data:cm,observed_at:iso(last(price).t),fetched_at:iso(NOW),source:"coinmetrics",source_url:SOURCE_URLS.coinmetrics};sourceStates.coinmetrics={state:"mock",source:"coinmetrics",url:SOURCE_URLS.coinmetrics,observed_at:iso(last(price).t),fetched_at:iso(NOW)};
  const bc={MVRV:cm.CapMVRVCur,AdrActCnt:cm.AdrActCnt,TxCnt:cm.TxCnt,MinerRevUSD:cm.IssTotUSD.map((x,i)=>({t:x.t,v:x.v+(cm.FeeTotNtv[i]?.v||0)*price[i].v}))};datasets.blockchain_onchain={data:bc,observed_at:iso(last(price).t),fetched_at:iso(NOW),source:"blockchain",source_url:SOURCE_URLS.blockchain};sourceStates.blockchain_onchain={state:"mock",source:"blockchain",url:SOURCE_URLS.blockchain,observed_at:iso(last(price).t),fetched_at:iso(NOW)};
  const mkt={price,volume:price.map((p,i)=>({t:p.t,v:p.v*(6000+((i*7919)%4000))})),marketCap:price.map(p=>({t:p.t,v:p.v*estimatedSupply(p.t)})),ath:Math.max(...price.map(x=>x.v))*1.08,athSource:"coingecko",supplyModelled:true};
  datasets.market={data:mkt,observed_at:iso(last(price).t),fetched_at:iso(NOW),source:"coinbase",source_url:SOURCE_URLS.coinbase,source_urls:[SOURCE_URLS.coinbase,SOURCE_URLS.coingecko]};sourceStates.market={state:"mock",source:"coinbase",url:SOURCE_URLS.coinbase,urls:[SOURCE_URLS.coinbase,SOURCE_URLS.coingecko],observed_at:iso(last(price).t),fetched_at:iso(NOW)};
  const nw={hashrate:mockWalk(1100,6e20,.0008,.02,61),difficulty:mockWalk(1100,8e13,.0008,.012,62),difficultyChange:2.4,fees:{fastest:12,halfHour:8,hour:5}};
  datasets.network={data:nw,observed_at:iso(last(nw.hashrate).t),fetched_at:iso(NOW),source:"mempool",source_url:SOURCE_URLS.mempool};sourceStates.network={state:"mock",source:"mempool",url:SOURCE_URLS.mempool,observed_at:iso(last(nw.hashrate).t),fetched_at:iso(NOW)};
  const etf=Array.from({length:900},(_,i)=>({t:NOW-(899-i)*DAY,v:(Math.sin(i/11)*120+40+(i%17===0?-260:0))*1e6})).filter(x=>![0,6].includes(new Date(x.t).getUTCDay()));datasets.etf={data:etf,observed_at:iso(last(etf).t),fetched_at:iso(NOW),source:"farside",source_url:SOURCE_URLS.farside};sourceStates.etf={state:"mock",source:"farside",url:SOURCE_URLS.farside,observed_at:iso(last(etf).t),fetched_at:iso(NOW)};
  const stable=mockWalk(1200,145e9,.0005,.003,51);datasets.stablecoins={data:stable,observed_at:iso(last(stable).t),fetched_at:iso(NOW),source:"defillama",source_url:SOURCE_URLS.defillama};sourceStates.stablecoins={state:"mock",source:"defillama",url:SOURCE_URLS.defillama,observed_at:iso(last(stable).t),fetched_at:iso(NOW)};
  datasets.pegs={data:{USDT:0.9997,USDC:1.0002},observed_at:iso(NOW),fetched_at:iso(NOW),source:"defillama",source_url:SOURCE_URLS.defillama};sourceStates.pegs={state:"mock",source:"defillama",url:SOURCE_URLS.defillama,observed_at:iso(NOW),fetched_at:iso(NOW)};
  const cot=Array.from({length:160},(_,i)=>({t:NOW-(159-i)*7*DAY,oi:25000+i*20,assetLong:7500+i*8,assetShort:1800+i*2,levLong:2500+i*3,levShort:11000+i*11}));datasets.cftc={data:cot,observed_at:iso(last(cot).t),fetched_at:iso(NOW),source:"cftc",source_url:SOURCE_URLS.cftc};sourceStates.cftc={state:"mock",source:"cftc",url:SOURCE_URLS.cftc,observed_at:iso(last(cot).t),fetched_at:iso(NOW)};
  datasets.derivatives={data:{funding:[{venue:"Deribit",rate8h:.00011,oiUsd:1.1e9},{venue:"Bybit",rate8h:.00013,oiUsd:4.8e9},{venue:"OKX",rate8h:.00009,oiUsd:3.1e9}],basis:9.2,dvol:55,dvolSeries:mockWalk(730,52,0,.025,61),skew:4.5,optionExpiry:iso(NOW+35*DAY)},observed_at:iso(NOW),fetched_at:iso(NOW),source:"Deribit · Kraken Futures · Bybit · OKX",source_url:SOURCE_URLS.deribit,source_urls:SOURCE_URL_GROUPS.derivatives};sourceStates.derivatives={state:"mock",source:"Deribit · Kraken Futures · Bybit · OKX",url:SOURCE_URLS.deribit,urls:SOURCE_URL_GROUPS.derivatives,observed_at:iso(NOW),fetched_at:iso(NOW)};
  datasets.spot={data:{coinbase:last(price).v*1.0003,kraken:last(price).v,bitstamp:last(price).v*.9998,okx:last(price).v*.9998,bybit:last(price).v*1.0001,kraken_usdt:last(price).v*.9999,coinbase_usdt:last(price).v*1.0002},observed_at:iso(NOW),fetched_at:iso(NOW),source:"Coinbase · Kraken · Bitstamp · OKX · Bybit",source_url:SOURCE_URLS.coinbase,source_urls:SOURCE_URL_GROUPS.spot};sourceStates.spot={state:"mock",source:"Coinbase · Kraken · Bitstamp · OKX · Bybit",url:SOURCE_URLS.coinbase,urls:SOURCE_URL_GROUPS.spot,observed_at:iso(NOW),fetched_at:iso(NOW)};
  for(const [k,d] of Object.entries(datasets)){
    const urls=uniqueHttps(d.source_urls?.length?d.source_urls:[d.source_url]);
    d.source_urls=urls;
    if(sourceStates[k])sourceStates[k].urls=urls;
  }
}

// ---------------------------------------------------------------------------------------------
// MARKET: price, volume and market capitalisation.
//
// Coinbase daily candles are the PRIMARY history, not a fallback: they are keyless, unlimited and
// reachable from US datacentre ranges. CoinGecko's keyless market_chart is deliberately NOT used
// for history — its public plan is capped at 365 days, so any request for multi-year data can never
// return enough points and would make the primary source permanently "broken".
//
// CoinGecko IS used for one thing it alone provides for free: the true all-time high and current
// market cap, via a single /coins/markets call that carries no history restriction. If that call is
// rate-limited (its keyless tier throttles cloud IPs), the ATH honestly degrades to the observed
// window maximum and the card says so.
// ---------------------------------------------------------------------------------------------
function parseCoinbaseCandles(rows){
  return (rows||[]).map(r=>({t:Number(r?.[0])*1000,v:Number(r?.[4]),volume:Number(r?.[5])}))
    .filter(x=>finite(x.t)&&sanePrice(x.v))
    .map(x=>({t:Date.parse(dayKey(x.t)+"T00:00:00Z"),v:x.v,volume:finite(x.volume)?x.volume:null}))
    .filter(x=>finite(x.t));
}
async function fetchCoinbaseHistory(days=1825){
  const byDay=new Map(),chunk=280*DAY;
  for(let a=NOW-days*DAY;a<NOW;a+=chunk){
    const b=Math.min(NOW,a+chunk);
    const u=`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${encodeURIComponent(iso(a))}&end=${encodeURIComponent(iso(b))}`;
    for(const row of parseCoinbaseCandles(await request(u,{tries:2})))byDay.set(row.t,row);
    await sleep(200);
  }
  return [...byDay.values()].sort((a,b)=>a.t-b.t);
}
function parseBitstampOhlc(j){return (j?.data?.ohlc||[]).map(r=>({t:Number(r?.timestamp)*1000,v:Number(r?.close),volume:Number(r?.volume)})).filter(x=>finite(x.t)&&sanePrice(x.v)).map(x=>({t:Date.parse(dayKey(x.t)+"T00:00:00Z"),v:x.v,volume:finite(x.volume)?x.volume:null})).filter(x=>finite(x.t));}
async function fetchBitstampHistory(days=1825){const byDay=new Map(),chunk=900*DAY;for(let a=NOW-days*DAY;a<NOW;a+=chunk){const b=Math.min(NOW,a+chunk),u=`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${Math.floor(a/1000)}&end=${Math.floor(b/1000)}`;for(const row of parseBitstampOhlc(await request(u,{tries:2})))byDay.set(row.t,row);await sleep(200);}return[...byDay.values()].sort((a,b)=>a.t-b.t);}
function validateMarket(d){
  return Array.isArray(d?.price)&&d.price.length>=1200&&finite(last(d.price)?.v)&&NOW-last(d.price).t<=4*DAY;
}
async function fetchMarket(){
  const errors=[];let candles=null,historySource="coinbase",historyUrl=SOURCE_URLS.coinbase;
  for(const candidate of [
    {name:"coinbase",url:SOURCE_URLS.coinbase,load:()=>fetchCoinbaseHistory()},
    {name:"bitstamp",url:SOURCE_URLS.bitstamp,load:()=>fetchBitstampHistory()},
  ]){
    try{const rows=await candidate.load();if(rows.length<1200)throw new Error(`${candidate.name} history too short: ${rows.length}`);candles=rows;historySource=candidate.name;historyUrl=candidate.url;break;}
    catch(e){errors.push(`${candidate.name} history: ${String(e.message||e)}`);}
  }
  if(!candles){const [priceFallback,volumeFallback]=await Promise.all([
    fetchBlockchainChart("market-price","5years",{minPoints:1200,expectedUnit:"USD"}),
    settled("Blockchain trade volume",()=>fetchBlockchainChart("trade-volume","5years",{minPoints:1200,expectedUnit:"USD"})),
  ]);const volumeMap=new Map((volumeFallback.ok?volumeFallback.value:[]).map(x=>[dayKey(x.t),x.v]));candles=priceFallback.map(x=>({t:x.t,v:x.v,quoteVolume:volumeMap.get(dayKey(x.t))??null}));if(!volumeFallback.ok)errors.push(`Blockchain trade volume: ${volumeFallback.error}`);historySource="blockchain";historyUrl=SOURCE_URLS.blockchain;}
  const price=normalizeToContract("price",candles.map(x=>({t:x.t,v:x.v}))).rows;
  const rawVolume=candles.map(x=>({t:x.t,v:finite(x.quoteVolume)?x.quoteVolume:(finite(x.volume)?x.volume*x.v:null)})).filter(x=>finite(x.v));
  const volume=safeContract("volume",rawVolume,errors);
  const marketCap=normalizeToContract("marketCap",price.map(p=>({t:p.t,v:p.v*estimatedSupply(p.t)}))).rows;
  let ath=null,athSource="window";const cg=await settled("coingecko markets",()=>request("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false",{tries:1}));
  if(cg.ok&&sanePrice(cg.value?.[0]?.ath)){ath=Number(cg.value[0].ath);athSource="coingecko";}else{errors.push(`CoinGecko ATH: ${cg.ok?"no ath field":cg.error}`);const all=await settled("blockchain all-time price",()=>fetchBlockchainChart("market-price","all",{minPoints:1200,expectedUnit:"USD"}));if(all.ok){ath=Math.max(...all.value.map(x=>x.v));athSource="blockchain";}else errors.push(`Blockchain ATH: ${all.error}`);}
  if(!finite(ath))ath=Math.max(...price.map(x=>x.v));
  const data={price,volume,marketCap,ath,athSource,supplyModelled:true,historySource};if(!validateMarket(data))throw new Error("market price history invalid");
  return{data,observed_at:iso(last(price).t),source:historySource==="coinbase"?"Coinbase":historySource==="bitstamp"?"Bitstamp":"Blockchain.com price fallback",source_url:historyUrl,source_urls:uniqueHttps([SOURCE_URLS.coinbase,SOURCE_URLS.bitstamp,SOURCE_URLS.blockchain,SOURCE_URLS.coingecko]),partial:errors.length>0,errors};
}

// ---------------------------------------------------------------------------------------------
// NETWORK: hashrate, difficulty and fee pressure from mempool.space (keyless, US-reachable).
// This replaces the Coin Metrics hashrate dependency and gives the cycle block a second leg that
// does not rely on any single commercial vendor.
// ---------------------------------------------------------------------------------------------
function parseMempoolHashrate(j){
  const h=(j?.hashrates||[]).map(x=>({t:Number(x.timestamp??x.time)*1000,v:Number(x.avgHashrate??x.hashrate)})).filter(x=>finite(x.t)&&finite(x.v)&&x.v>0).sort((a,b)=>a.t-b.t);
  const d=(j?.difficulty||[]).map(x=>({t:Number(x.time??x.timestamp)*1000,v:Number(x.difficulty)})).filter(x=>finite(x.t)&&finite(x.v)&&x.v>0).sort((a,b)=>a.t-b.t);
  return {hashrate:h,difficulty:d};
}
async function fetchNetwork(){
  const errors=[];let base=null,source="mempool.space",sourceUrl=SOURCE_URLS.mempool;
  const hr=await settled("mempool hashrate",()=>request("https://mempool.space/api/v1/mining/hashrate/3y"));if(hr.ok){base=parseMempoolHashrate(hr.value);if(base.hashrate.length<300){errors.push("mempool history too short");base=null;}}else errors.push(`mempool hashrate: ${hr.error}`);
  if(!base){const [h,d]=await Promise.all([fetchBlockchainChart("hash-rate","3years",{minPoints:300}),fetchBlockchainChart("difficulty","3years",{minPoints:60})]);base={hashrate:h,difficulty:d};source="Blockchain.com network fallback";sourceUrl=SOURCE_URLS.blockchain;}
  else if(base.difficulty.length<60){const d=await settled("Blockchain difficulty",()=>fetchBlockchainChart("difficulty","3years",{minPoints:60}));if(d.ok){base.difficulty=d.value;source="mempool.space · Blockchain.com difficulty fallback";}else errors.push(`Blockchain difficulty: ${d.error}`);}
  const hashrateNorm=normalizeToContract("hashrate",base.hashrate),difficultyNorm=safeContract("difficulty",base.difficulty,errors);
  const adj=await settled("mempool difficulty adjustment",()=>request("https://mempool.space/api/v1/difficulty-adjustment"));if(!adj.ok)errors.push(`difficulty adjustment: ${adj.error}`);
  let fees=null;const mf=await settled("mempool fees",()=>request("https://mempool.space/api/v1/fees/recommended"));if(mf.ok)fees={fastest:num(mf.value.fastestFee),halfHour:num(mf.value.halfHourFee),hour:num(mf.value.hourFee)};else{errors.push(`mempool fees: ${mf.error}`);const bf=await settled("Blockstream fees",()=>request("https://blockstream.info/api/fee-estimates",{tries:2}));if(bf.ok)fees={fastest:num(bf.value?.["1"]),halfHour:num(bf.value?.["3"]),hour:num(bf.value?.["6"])};else errors.push(`Blockstream fees: ${bf.error}`);}
  return{data:{hashrate:hashrateNorm.rows,difficulty:difficultyNorm,hashrateScale:hashrateNorm.scale,difficultyChange:num(adj.value?.difficultyChange),fees:fees||{}},observed_at:iso(last(hashrateNorm.rows).t),source,source_url:sourceUrl,source_urls:uniqueHttps([SOURCE_URLS.mempool,SOURCE_URLS.blockchain,SOURCE_URLS.blockstream]),partial:errors.length>0,errors};
}

// ---------------------------------------------------------------------------------------------
// COIN METRICS: optional enrichment. Cascade over the documented root (with an optional free key)
// and the legacy community host. The frozen GitHub CSV archive is never used: that repository
// stopped receiving commits on 2026-05-24 and could never satisfy the freshness rule.
// A total failure here costs MVRV, exchange flows, activity and miner revenue — and nothing else.
// ---------------------------------------------------------------------------------------------
const CM_HOSTS = CM_KEY
  ? [{ root: "https://api.coinmetrics.io/v4", useKey: true }, { root: "https://community-api.coinmetrics.io/v4", useKey: false }]
  : [{ root: "https://community-api.coinmetrics.io/v4", useKey: false }];
async function fetchCoinMetrics(){
  const start=new Date(NOW-5*365*DAY).toISOString().slice(0,10),errors=[];
  for(const {root,useKey} of CM_HOSTS){
    const q=new URLSearchParams({assets:"btc",metrics:CM_METRICS.join(","),frequency:"1d",start_time:start,page_size:"10000",sort:"asc",ignore_forbidden_errors:"true",ignore_unsupported_errors:"true"});
    if(useKey&&CM_KEY)q.set("api_key",CM_KEY);
    try{
      const j=await request(`${root}/timeseries/asset-metrics?${q}`);
      const by=normalizeCoinMetricsRows(j?.data||[]),quality=validateCoinMetricsData(by),contractErrors=[];
      const contractMap={CapMVRVCur:"mvrv",AdrActCnt:"activeAddresses",TxCnt:"txCount",TxTfrCnt:"txCount",SplyExNtv:"exchangeSupply",IssTotUSD:"minerRevenue"};
      for(const [metric,contract] of Object.entries(contractMap))if(by[metric]?.length)by[metric]=safeContract(contract,by[metric],contractErrors);
      if(!CM_METRICS.some(k=>by[k]?.length))throw new Error("no usable series returned");
      const allErrors=[...quality.errors,...contractErrors];
      return {data:by,observed_at:quality.observed_at,source:"coinmetrics",source_url:SOURCE_URLS.coinmetrics,
        source_urls:[SOURCE_URLS.coinmetrics],partial:allErrors.length>0,errors:allErrors};
    }catch(e){
      // The key is never echoed: only the hostname and the transport error are recorded.
      errors.push(`${new URL(root).host}: ${String(e?.message||e)}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function fetchPegs(){
  const out={},errors=[],urls=[SOURCE_URLS.defillama,SOURCE_URLS.coinbase,SOURCE_URLS.kraken,SOURCE_URLS.gemini];let fallbackUsed=false;const dl=await settled("DefiLlama pegs",()=>request("https://stablecoins.llama.fi/stablecoins?includePrices=true"));
  if(dl.ok){for(const r of dl.value?.peggedAssets||dl.value?.data||[]){const sym=String(r.symbol||"").toUpperCase(),px=Number(r.price);if(["USDT","USDC"].includes(sym)&&px>.01&&px<5)out[sym]=px;}}else errors.push(`DefiLlama: ${dl.error}`);
  async function exchangePeg(sym){const tasks=await Promise.all([settled("Coinbase",()=>request(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`,{tries:1})),settled("Kraken",()=>krakenRequest(`https://api.kraken.com/0/public/Ticker?pair=${sym}USD`)),settled("Gemini",()=>request(`https://api.gemini.com/v1/pubticker/${sym}USD`,{tries:1}))]),vals=[];for(const x of tasks){if(!x.ok){errors.push(`${sym} ${x.label}: ${x.error}`);continue;}let px=null;if(x.label==="Coinbase")px=num(x.value?.price);else if(x.label==="Gemini")px=num(x.value?.last);else px=num(Object.values(x.value?.result||{})[0]?.c?.[0]);if(finite(px)&&px>.01&&px<5)vals.push(px);else errors.push(`${sym} ${x.label}: invalid price`);}return vals.length?median(vals):null;}
  for(const sym of ["USDT","USDC"])if(!finite(out[sym])){fallbackUsed=true;const px=await exchangePeg(sym);if(finite(px))out[sym]=px;}
  for(const sym of ["USDT","USDC"]){if(!finite(out[sym]))errors.push(`${sym}: unavailable from DefiLlama and exchanges`);else{try{out[sym]=normalizeToContract("pegPrice",[{t:NOW,v:out[sym]}]).rows[0].v;}catch(e){errors.push(`${sym}: ${String(e.message||e)}`);delete out[sym];}}}
  return{data:out,observed_at:iso(NOW),source:"DefiLlama · exchange peg fallback",source_url:SOURCE_URLS.defillama,source_urls:urls,partial:fallbackUsed||errors.length>0,errors};
}

// Socrata returns HTTP 400 for the whole request if a single $select column is unknown. The two
// TFF naming conventions are therefore tried separately instead of being merged into one $select.
const CFTC_FIELD_SETS=[
  ["open_interest_all","asset_mgr_positions_long","asset_mgr_positions_short","lev_money_positions_long","lev_money_positions_short"],
  ["open_interest_all","asset_mgr_positions_long_all","asset_mgr_positions_short_all","lev_money_positions_long_all","lev_money_positions_short_all"],
];
async function fetchCftc(){
  const where="market_and_exchange_names='BITCOIN - CHICAGO MERCANTILE EXCHANGE'",errors=[];
  for(const fields of CFTC_FIELD_SETS){
    try{
      const select=["report_date_as_yyyy_mm_dd",...fields].join(",");
      const params=new URLSearchParams({"$select":select,"$limit":"260","$where":where,"$order":"report_date_as_yyyy_mm_dd desc"}),base="https://publicreporting.cftc.gov/resource/gpe5-46if",jsonUrl=`${base}.json?${params}`,csvUrl=`${base}.csv?${params}`;
      let rows,transport="JSON";try{rows=await request(jsonUrl);}catch(jsonError){transport="CSV";rows=parseCsv(await request(csvUrl,{text:true,tries:2}));errors.push(`CFTC JSON: ${jsonError.message||jsonError}`);}
      const parsed=parseCftc(rows),cur=last(parsed);if(parsed.length<20||![cur?.assetLong,cur?.assetShort,cur?.levLong,cur?.levShort].every(finite))throw new Error("missing current positioning fields");
      return {data:parsed,observed_at:iso(cur.t),source:`CFTC Socrata ${transport}`,source_url:SOURCE_URLS.cftc,source_urls:[SOURCE_URLS.cftc],partial:transport!=="JSON",errors:transport!=="JSON"?errors:[]};
    }catch(e){errors.push(String(e?.message||e));}
  }
  throw new Error(`CFTC unavailable (${errors.join("; ")})`);
}

function expiryFromName(name){const m=String(name).match(/BTC-(\d{1,2})([A-Z]{3})(\d{2})/);if(!m)return null;const mo={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};return Date.UTC(2000+Number(m[3]),mo[m[2]],Number(m[1]));}
async function fetchDerivatives(){
  const start=NOW-730*DAY;
  const tasks=await Promise.all([
    settled("deribit futures",()=>deribitRequest("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future")),
    settled("deribit options",()=>deribitRequest("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option")),
    settled("deribit dvol",()=>deribitRequest(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${NOW}&resolution=1D`)),
    settled("deribit perpetual",()=>deribitRequest("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL")),
    settled("bybit ticker",()=>bybitRequest("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT")),
    settled("okx funding",()=>okxRequest("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP")),
    settled("okx oi",()=>okxRequest("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP")),
    settled("kraken futures",()=>request("https://futures.kraken.com/derivatives/api/v3/tickers/PI_XBTUSD",{tries:2})),
    settled("kraken dated futures",()=>request("https://futures.kraken.com/derivatives/api/v3/tickers?contractType=futures_inverse",{tries:2})),
  ]);
  const byLabel=Object.fromEntries(tasks.filter(x=>x.ok).map(x=>[x.label,x.value])),errors=tasks.filter(x=>!x.ok).map(x=>`${x.label}: ${x.error}`);
  const futures=byLabel["deribit futures"]?.result||[],options=byLabel["deribit options"]?.result||[],der=byLabel["deribit perpetual"]?.result||{};
  const by=byLabel["bybit ticker"]?.result?.list?.[0]||{},okf=byLabel["okx funding"]?.data?.[0]||{},oko=byLabel["okx oi"]?.data?.[0]||{},kf=byLabel["kraken futures"]||{};
  if(byLabel["kraken futures"]&&kf.result!=="success")errors.push(`kraken futures: ${kf.error||kf.result||"business error"}`);
  const byHours=finite(by.fundingIntervalHour)&&Number(by.fundingIntervalHour)>0?Number(by.fundingIntervalHour):8;
  const okHours=finite(okf.fundingTime)&&finite(okf.nextFundingTime)&&Number(okf.nextFundingTime)>Number(okf.fundingTime)?(Number(okf.nextFundingTime)-Number(okf.fundingTime))/HOUR:8;
  const funding=[
    {venue:"Deribit",rate8h:num(der.funding_8h),oiUsd:num(der.open_interest),intervalHours:8},
    {venue:"Bybit",rate8h:finite(by.fundingRate)?Number(by.fundingRate)*8/byHours:null,oiUsd:num(by.openInterestValue),intervalHours:byHours},
    {venue:"OKX",rate8h:finite(okf.fundingRate)?Number(okf.fundingRate)*8/okHours:null,oiUsd:num(oko.oiUsd),intervalHours:okHours},
    // Kraken PI_XBTUSD fundingRate is hourly; the inverse contract is quoted in $1 contracts,
    // therefore openInterest is directly comparable to USD notional from the other venues.
    {venue:"Kraken Futures",rate8h:kf.result==="success"&&finite(kf.ticker?.fundingRate)?Number(kf.ticker.fundingRate)*8:null,oiUsd:kf.result==="success"?num(kf.ticker?.openInterest):null,intervalHours:1},
  ].filter(x=>finite(x.rate8h)&&Math.abs(Number(x.rate8h))<.05&&(!finite(x.oiUsd)||(Number(x.oiUsd)>1e6&&Number(x.oiUsd)<1e12)));
  const dated=futures.map(x=>({...x,expiry:expiryFromName(x.instrument_name),oiUsd:num(x.open_interest),volumeUsd:num(x.volume_usd)})).filter(x=>x.expiry>NOW+20*DAY&&x.expiry<NOW+100*DAY&&finite(x.mark_price)).sort((a,b)=>a.expiry-b.expiry);
  const liquid=dated.filter(x=>(x.oiUsd||0)>=50e6||(x.volumeUsd||0)>=1e6),q=(liquid.length?liquid:dated)[0];
  const ref=num(q?.estimated_delivery_price)||num(der.index_price);let basis=q&&ref?(Number(q.mark_price)/ref-1)*365/((q.expiry-NOW)/DAY)*100:null,basisSource=finite(basis)?"Deribit":null;
  if(!finite(basis)){
    const kt=byLabel["kraken dated futures"]?.tickers||[],candidates=kt.map(x=>{const m=String(x.symbol||"").match(/^FI_XBTUSD_(\d{2})(\d{2})(\d{2})$/i),expiry=m?Date.UTC(2000+Number(m[1]),Number(m[2])-1,Number(m[3])):null;return{...x,expiry};}).filter(x=>x.expiry>NOW+20*DAY&&x.expiry<NOW+100*DAY&&finite(x.markPrice)&&finite(x.indexPrice)).sort((a,b)=>a.expiry-b.expiry),kq=candidates[0];
    if(kq){basis=(Number(kq.markPrice)/Number(kq.indexPrice)-1)*365/((kq.expiry-NOW)/DAY)*100;basisSource="Kraken Futures";}
  }
  const dvolSeries=(byLabel["deribit dvol"]?.result?.data||[]).map(r=>({t:Number(r[0]),v:Number(r[4])})).filter(x=>finite(x.t)&&finite(x.v));
  const opt=options.map(x=>{const p=String(x.instrument_name||"").split("-");return{...x,expiry:expiryFromName("BTC-"+p[1]),strike:Number(p[2]),type:p[3]};}).filter(x=>x.expiry>NOW+14*DAY&&x.expiry<NOW+75*DAY&&finite(x.mark_iv)&&finite(x.underlying_price)&&(num(x.open_interest)||0)>=5);
  const ex=opt.length?Math.min(...opt.map(x=>x.expiry)):null,near=opt.filter(x=>x.expiry===ex),under=median(near.map(x=>x.underlying_price));
  const pIv=under?median(near.filter(x=>x.type==="P"&&x.strike/under>.84&&x.strike/under<.94).map(x=>x.mark_iv)):null;
  const cIv=under?median(near.filter(x=>x.type==="C"&&x.strike/under>1.06&&x.strike/under<1.16).map(x=>x.mark_iv)):null;
  const times=[der.timestamp,byLabel["bybit ticker"]?.time,okf.ts,oko.ts,Date.parse(kf.serverTime||"")].map(Number).filter(t=>Number.isFinite(t)&&t>Date.UTC(2020,0,1)&&t<NOW+HOUR);
  const observedAt=times.length?iso(Math.min(...times)):iso(NOW);
  return {data:{funding,basis,basisSource,dvol:last(dvolSeries)?.v??null,dvolSeries,skew:finite(pIv)&&finite(cIv)?pIv-cIv:null,optionExpiry:ex?iso(ex):null,components:tasks.map(x=>({name:x.label,ok:x.ok}))},observed_at:observedAt,source:"Deribit · Kraken Futures · Bybit · OKX",source_url:SOURCE_URLS.deribit,source_urls:SOURCE_URL_GROUPS.derivatives,partial:errors.length>0,errors};
}
async function fetchSpot(){
  const tasks=await Promise.all([
    settled("coinbase",()=>request("https://api.exchange.coinbase.com/products/BTC-USD/ticker")),
    settled("kraken",()=>krakenRequest("https://api.kraken.com/0/public/Ticker?pair=XBTUSD")),
    settled("bitstamp",()=>request("https://www.bitstamp.net/api/v2/ticker/btcusd/")),
    settled("gemini",()=>request("https://api.gemini.com/v1/pubticker/BTCUSD",{tries:2})),
    settled("okx",()=>okxRequest("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")),
    settled("bybit",()=>bybitRequest("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT")),
    // OKX and Bybit are unreachable from most US datacentre ranges. Kraken and Coinbase both list a
    // USDT book, so the USDT quote group keeps two independent venues even when the offshore
    // exchanges are geo-blocked. Their failure is free: they are settled tasks like any other.
    settled("kraken_usdt",()=>krakenRequest("https://api.kraken.com/0/public/Ticker?pair=XBTUSDT")),
    settled("coinbase_usdt",()=>request("https://api.exchange.coinbase.com/products/BTC-USDT/ticker")),
  ]);
  const r=Object.fromEntries(tasks.filter(x=>x.ok).map(x=>[x.label,x.value]));
  const krRow=Object.values(r.kraken?.result||{})[0]||{},krUsdtRow=Object.values(r.kraken_usdt?.result||{})[0]||{};
  const raw={
    coinbase:num(r.coinbase?.price),
    kraken:num(krRow?.c?.[0]),
    bitstamp:num(r.bitstamp?.last),
    gemini:num(r.gemini?.last),
    okx:num(r.okx?.data?.[0]?.last),
    bybit:num(r.bybit?.result?.list?.[0]?.lastPrice),
    kraken_usdt:num(krUsdtRow?.c?.[0]),
    coinbase_usdt:num(r.coinbase_usdt?.price),
  };
  const data={},errors=tasks.filter(x=>!x.ok).map(x=>`${x.label}: ${x.error}`);
  for(const [venue,value] of Object.entries(raw)){
    if(sanePrice(value))data[venue]=Number(value);
    else{data[venue]=null;if(tasks.some(x=>x.label===venue&&x.ok))errors.push(`${venue}: invalid price ${value}`);}
  }
  const times=[];
  if(sanePrice(data.coinbase)){const t=Date.parse(r.coinbase?.time||"");if(Number.isFinite(t))times.push(t);}
  if(sanePrice(data.coinbase_usdt)){const t=Date.parse(r.coinbase_usdt?.time||"");if(Number.isFinite(t))times.push(t);}
  if(sanePrice(data.okx)){const t=Number(r.okx?.data?.[0]?.ts);if(Number.isFinite(t))times.push(t);}
  if(sanePrice(data.bybit)){const t=Number(r.bybit?.time);if(Number.isFinite(t))times.push(t);}
  if(sanePrice(data.gemini)){const t=Number(r.gemini?.timestampms||r.gemini?.timestamp);if(Number.isFinite(t))times.push(t<1e12?t*1000:t);}
  const validTimes=times.filter(t=>t>Date.UTC(2020,0,1)&&t<NOW+HOUR);
  return {data,observed_at:validTimes.length?iso(Math.min(...validTimes)):iso(NOW),source:"Coinbase · Kraken · Bitstamp · Gemini · OKX · Bybit",source_url:SOURCE_URLS.coinbase,source_urls:SOURCE_URL_GROUPS.spot,partial:errors.length>0,errors};
}
async function collect(){
  if(MOCK){makeMock();return;}
  const fredEntries=Object.entries(FRED_SERIES);
  for(let i=0;i<fredEntries.length;i+=4){
    await Promise.all(fredEntries.slice(i,i+4).map(async([id,cfg])=>{
      await loadDataset("fred_"+id,"fred",cfg.ttl,()=>fetchFredSeries(id,cfg),x=>x?.length>20,{maxObservedAge:cfg.ttl});
    }));
  }
  await Promise.all([
    // Market and network are the two reliable, vendor-independent legs of the model.
    loadDataset("market","coinbase",4*DAY,fetchMarket,validateMarket,{maxObservedAge:4*DAY}),
    loadDataset("network","mempool",4*DAY,fetchNetwork,x=>x?.hashrate?.length>300,{maxObservedAge:4*DAY}),
    // Coin Metrics is enrichment only: any surviving series is accepted, total failure costs
    // MVRV/flows/activity/miners and nothing else.
    loadDataset("coinmetrics","coinmetrics",4*DAY,fetchCoinMetrics,x=>CM_METRICS.some(k=>x?.[k]?.length>=180),{maxObservedAge:4*DAY}),
    loadDataset("blockchain_onchain","blockchain",4*DAY,fetchBlockchainOnchain,x=>Object.values(x||{}).some(a=>a?.length>=180),{maxObservedAge:4*DAY}),
    loadDataset("etf","farside",5*DAY,async()=>{const s=parseFarside(await request("https://farside.co.uk/bitcoin-etf-flow-all-data/",{text:true}));return{data:s,observed_at:s.length?iso(last(s).t):iso(NOW),source:"farside",source_url:SOURCE_URLS.farside,source_urls:[SOURCE_URLS.farside]};},x=>validateEtfSeries(x,5*DAY),{maxObservedAge:5*DAY}),
    loadDataset("stablecoins","defillama",4*DAY,async()=>{const s=normalizeStableHistory(await request("https://stablecoins.llama.fi/stablecoincharts/all"));return{data:s,observed_at:s.length?iso(last(s).t):iso(NOW)};},x=>x?.length>100,{maxObservedAge:4*DAY}),
    loadDataset("pegs","defillama",18*HOUR,fetchPegs,x=>[x?.USDT,x?.USDC].some(v=>finite(v)&&Number(v)>.01&&Number(v)<5),{maxObservedAge:18*HOUR}),
    loadDataset("cftc","cftc",15*DAY,fetchCftc,x=>x?.length>20,{maxObservedAge:15*DAY}),
    loadDataset("derivatives","deribit",18*HOUR,fetchDerivatives,x=>x?.funding?.length>=1&&x.funding.filter(r=>finite(r.oiUsd)&&Number(r.oiUsd)>1e6&&Number(r.oiUsd)<1e12&&Math.abs(Number(r.rate8h))<.05).length>=1,{maxObservedAge:18*HOUR}),
    loadDataset("spot","coinbase",18*HOUR,fetchSpot,x=>["USD","USDT"].some(g=>quoteGroupPrices(x,g).length>=2),{maxObservedAge:18*HOUR}),
  ]);
}

function metric(def){return{
  id:def.id,block:def.block,family:def.family,name:def.name,horizon:def.horizon||"medium",role:def.role||"confirming",method:def.method||"derived",
  strategic:def.strategic!==false,tactical:!!def.tactical,vote:def.vote!==false,value_num:finite(def.value_num)?Number(def.value_num):null,
  value:def.value??(finite(def.value_num)?String(def.value_num):"—"),unit:def.unit||"",delta:def.delta||"",note:def.note||"",score:finite(def.score)?clamp(roundSym(def.score),-2,2):null,
  source:def.source||"",source_url:def.source_url||SOURCE_URLS[def.source]||"",source_urls:uniqueHttps(def.source_urls?.length?def.source_urls:[def.source_url||SOURCE_URLS[def.source]]),observed_at:def.observed_at||null,stale:!!def.stale,series:(def.series||[]).slice(-180)
};}
function cmSeries(id){return series(data("coinmetrics")?.[id]||[]);}
function bcSeries(id){return series(data("blockchain_onchain")?.[id]||[]);}
function chooseWholeSeries(cmId,bcId){const c=cmSeries(cmId);if(c.length>=180)return{series:c,source:"Coin Metrics",keys:["coinmetrics"],urls:[SOURCE_URLS.coinmetrics]};const b=bcSeries(bcId);return b.length>=180?{series:b,source:"Blockchain.com",keys:["blockchain_onchain"],urls:[SOURCE_URLS.blockchain]}:{series:[],source:"",keys:["coinmetrics","blockchain_onchain"],urls:[SOURCE_URLS.coinmetrics,SOURCE_URLS.blockchain]};}
function marketSeries(k){return series(data("market")?.[k]||[]);}
function netSeries(k){return series(data("network")?.[k]||[]);}
function fred(id){return series(data("fred_"+id)||[]);}
function sourceMeta(key){return{observed_at:obs(key),stale:stale(key)};}
function datasetSource(key,fallback=""){return datasets[key]?.source||sourceStates[key]?.source||fallback;}
function datasetUrls(key,...fallback){return uniqueHttps(datasets[key]?.source_urls?.length?datasets[key].source_urls:fallback.flat());}
function links(...values){return uniqueHttps(values.flat());}
function componentScore(parts){const a=parts.filter(finite).map(Number);return a.length?clamp(roundSym(mean(a)),-2,2):null;}
function highGood(p){return !finite(p)?null:p>=90?2:p>=65?1:p>=35?0:p>=10?-1:-2;}
function lowGood(p){return !finite(p)?null:p<=10?2:p<=35?1:p<=65?0:p<=90?-1:-2;}

function buildMetrics(){
  const m=[],add=d=>m.push(metric(d));
  const price=marketSeries("price"),marketCap=marketSeries("marketCap"),priceLast=referencePrice();
  const p30=price.length&&finite(priceLast)?pct(priceLast,priorByDays(price,30)?.v):null,p7=price.length&&finite(priceLast)?pct(priceLast,priorByDays(price,7)?.v):null;

  // I. Глобальный режим
  const walcl=fred("WALCL"),tga=fred("WTREGEN"),rrp=fred("RRPONTSYD"),net=[];
  for(const p of walcl){const a=nearestAtOrBefore(tga,p.t),b=nearestAtOrBefore(rrp,p.t);if(a&&b)net.push({t:p.t,v:p.v/1000-a.v/1000-b.v});}
  const net4Series=trailingChangeSeries(net,28),net13Series=trailingChangeSeries(net,91),net4=last(net4Series)?.v,net13=last(net13Series)?.v;
  const net4Pct=percentileRank(net4Series.slice(-260).map(x=>x.v),net4),net13Pct=percentileRank(net13Series.slice(-260).map(x=>x.v),net13);
  const liqScore=componentScore([highGood(net4Pct),highGood(net13Pct)]);
  add({id:"liquidity_regime",block:"macro",family:"liquidity",name:"Режим чистой долларовой ликвидности",horizon:"medium",role:"leading",method:"dynamic",tactical:true,value_num:liqScore,value:finite(liqScore)?(liqScore>=1?"расширение":liqScore<=-1?"сжатие":"нейтрально"):"—",delta:finite(net4)&&finite(net13)?`4н ${net4.toFixed(1)}% · 13н ${net13.toFixed(1)}%`:"",note:"WALCL − TGA − ON RRP. 4- и 13-недельные импульсы сравниваются с собственной историей; это прокси направления ликвидности, а не точная мера денег, доступных BTC.",score:liqScore,source:"FRED",source_url:fredSeriesUrl("WALCL"),source_urls:fredSeriesUrls(["WALCL","WTREGEN","RRPONTSYD"]),...sourceMetaMany(["fred_WALCL","fred_WTREGEN","fred_RRPONTSYD"]),series:net});
  add({id:"netliq_4w",block:"macro",family:"liquidity",name:"Net Liquidity · 4 недели",horizon:"short",role:"component",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:net4,value:finite(net4)?`${net4>=0?"+":""}${net4.toFixed(1)}%`:"—",delta:finite(net4Pct)?`${net4Pct.toFixed(0)}-й перцентиль`:"",note:"Компонент семейства; отдельного голоса не получает.",score:null,source:"fred",...sourceMeta("fred_WALCL"),series:net4Series});
  add({id:"netliq_13w",block:"macro",family:"liquidity",name:"Net Liquidity · 13 недель",horizon:"medium",role:"component",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:net13,value:finite(net13)?`${net13>=0?"+":""}${net13.toFixed(1)}%`:"—",delta:finite(net13Pct)?`${net13Pct.toFixed(0)}-й перцентиль`:"",note:"Среднесрочный импульс того же семейства.",score:null,source:"fred",...sourceMeta("fred_WALCL"),series:net13Series});

  const real=fred("DFII10"),usd=fred("DTWEXBGS"),two=fred("DGS2");
  const real4Series=trailingChangeSeries(real,28,{difference:true,scale:100}),usd4Series=trailingChangeSeries(usd,28),real4=last(real4Series)?.v,usd4=last(usd4Series)?.v,two4=two.length?(last(two).v-priorByDays(two,28)?.v)*100:null;
  const real4Pct=percentileRank(real4Series.slice(-750).map(x=>x.v),real4),usd4Pct=percentileRank(usd4Series.slice(-750).map(x=>x.v),usd4);
  const conditionsScore=componentScore([lowGood(real4Pct),lowGood(usd4Pct)]);
  add({id:"financial_conditions",block:"macro",family:"conditions",name:"Реальные ставки и доллар",horizon:"medium",role:"leading",method:"dynamic",tactical:true,value_num:conditionsScore,value:finite(conditionsScore)?(conditionsScore>=1?"смягчение":conditionsScore<=-1?"ужесточение":"смешанно"):"—",delta:finite(real4)&&finite(usd4)?`TIPS ${real4.toFixed(0)} б.п. · USD ${usd4.toFixed(1)}%`:"",note:"4-недельные изменения реальной доходности и широкого доллара нормируются на собственную историю. Их рост повышает альтернативную стоимость BTC и сжимает глобальные условия.",score:conditionsScore,source:"FRED",source_url:fredSeriesUrl("DFII10"),source_urls:fredSeriesUrls(["DFII10","DTWEXBGS"]),...sourceMetaMany(["fred_DFII10","fred_DTWEXBGS"]),series:real4Series});
  add({id:"two_year",block:"macro",family:"conditions",name:"2Y UST · репрайсинг 4 недели",horizon:"short",role:"context",method:"mechanical",strategic:false,tactical:false,vote:false,value_num:two4,value:finite(two4)?`${two4>=0?"+":""}${two4.toFixed(0)} б.п.`:"—",delta:two.length?`${last(two).v.toFixed(2)}%`:"",note:"Контекст ожиданий политики. Резкое падение доходности может означать как смягчение, так и страх рецессии, поэтому не голосует отдельно.",score:null,source:"fred",...sourceMeta("fred_DGS2"),series:two});

  const hy=fred("BAMLH0A0HYM2"),vix=fred("VIXCLS"),vxv=fred("VXVCLS"),dgs10=fred("DGS10");
  const hy4Series=trailingChangeSeries(hy,28,{difference:true,scale:100}),hy4=last(hy4Series)?.v,hy4Pct=percentileRank(hy4Series.slice(-750).map(x=>x.v),hy4);
  const vixCommonT=vix.length&&vxv.length?Math.min(last(vix).t,last(vxv).t):null,vixPoint=finite(vixCommonT)?nearestAtOrBefore(vix,vixCommonT):null,vxvPoint=finite(vixCommonT)?nearestAtOrBefore(vxv,vixCommonT):null,vixRatio=vixPoint&&vxvPoint?vixPoint.v/vxvPoint.v:null;
  const absMoves=dgs10.slice(1).map((p,i)=>({t:p.t,v:Math.abs(p.v-dgs10[i].v)*100}));const rateVolSeries=rollingMean(absMoves,20),rateVol=last(rateVolSeries)?.v,rateVolPct=percentileRank(rateVolSeries.slice(-750).map(x=>x.v),rateVol);
  const stressScore=componentScore([lowGood(hy4Pct),customScore(vixRatio,[[v=>v<.90,1],[v=>v<1,0],[v=>v<1.10,-1],[()=>true,-2]]),finite(rateVolPct)?lowGood(rateVolPct):null]);
  add({id:"system_stress",block:"macro",family:"stress",name:"Кредит и системный стресс",horizon:"short",role:"leading",method:"mixed",tactical:true,value_num:stressScore,value:finite(stressScore)?(stressScore>=1?"спокойно":stressScore<=-1?"напряжение":"нейтрально"):"—",delta:finite(hy4)&&finite(vixRatio)?`HY ${hy4.toFixed(0)} б.п. · VIX/VIX3M ${vixRatio.toFixed(2)}`:"",note:"Семейный вывод из импульса HY, термструктуры VIX и реализованной волатильности 10Y UST. Последняя — прозрачная бесплатная замена MOVE, но не сам MOVE.",score:stressScore,source:"FRED",source_url:fredSeriesUrl("BAMLH0A0HYM2"),source_urls:fredSeriesUrls(["BAMLH0A0HYM2","VIXCLS","VXVCLS","DGS10"]),...sourceMetaMany(["fred_BAMLH0A0HYM2","fred_VIXCLS","fred_VXVCLS","fred_DGS10"]),series:hy});

  const ndx=fred("NASDAQ100"),btcByDay=new Map(price.map(x=>[dayKey(x.t),x.v])),commonNdx=ndx.map(x=>({t:x.t,n:x.v,b:btcByDay.get(dayKey(x.t))})).filter(x=>finite(x.b)),btcCommonR=commonNdx.slice(1).map((x,i)=>Math.log(x.b/commonNdx[i].b)),ndxCommonR=commonNdx.slice(1).map((x,i)=>Math.log(x.n/commonNdx[i].n)),c60=corr(btcCommonR.slice(-60),ndxCommonR.slice(-60));
  const ndx30=ndx.length?pct(last(ndx).v,priorByDays(ndx,30)?.v):null,rel=finite(p30)&&finite(ndx30)?p30-ndx30:null;
  add({id:"macro_lens",block:"macro",family:"macro_lens",name:"BTC ↔ Nasdaq · режим корреляции",horizon:"medium",role:"context",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:c60,value:finite(c60)?c60.toFixed(2):"—",delta:finite(rel)?`относительная сила 30д ${rel>=0?"+":""}${rel.toFixed(1)} п.п.`:"",note:"Не голосует. Высокая корреляция повышает значимость макроблока; низкая указывает на криптоспецифические потоки.",score:null,source:`FRED · ${datasetSource("market","market price")}`,source_url:fredSeriesUrl("NASDAQ100"),source_urls:links(fredSeriesUrl("NASDAQ100"),datasetUrls("market",SOURCE_URLS.coinbase,SOURCE_URLS.blockchain)),...sourceMetaMany(["fred_NASDAQ100","market"])});

  // II. Спрос и предложение
  const etf=series(data("etf")||[]),etf1=last(etf)?.v,etf5s=rollingSum(etf,5),etf20s=rollingSum(etf,20),etf5=last(etf5s)?.v,etf20=last(etf20s)?.v;
  // Convert EACH daily USD flow at that day's BTC price before summing the trading-day windows.
  // Dividing a multi-day USD sum by only the final-day price biases the BTC amount when price moves.
  const dailyBtc=convertDailyUsdFlowsToBtc(etf,price);
  const f5Btc=rollingSum(dailyBtc,5),f20Btc=rollingSum(dailyBtc,20);
  const p5=percentileRank(f5Btc.map(x=>x.v),last(f5Btc)?.v),p20=percentileRank(f20Btc.map(x=>x.v),last(f20Btc)?.v);
  const etf5Btc=last(f5Btc)?.v,etf20Btc=last(f20Btc)?.v;
  const etfScore=componentScore([finite(etf5Btc)?highGood(p5):null,finite(etf20Btc)?highGood(p20):null]);
  add({id:"etf_regime",block:"demand",family:"etf",name:"US spot-ETF · режим потоков",horizon:"medium",role:"leading",method:"dynamic",tactical:true,value_num:etfScore,value:finite(etfScore)?(etfScore>=1?"устойчивый приток":etfScore<=-1?"устойчивый отток":"смешанно"):"—",delta:finite(etf5Btc)&&finite(etf20Btc)?`5д ${formatCompact(etf5Btc,0)} BTC · 20д ${formatCompact(etf20Btc,0)} BTC`:"",note:"Потоки переводятся в BTC по цене дня и сравниваются с собственным историческим распределением. В BTC они напрямую сопоставимы с эмиссией (~450 BTC/день). Это основной наблюдаемый маржинальный спрос.",score:etfScore,source:`Farside · ${datasetSource("market","market price")}`,source_url:SOURCE_URLS.farside,source_urls:links(SOURCE_URLS.farside,datasetUrls("market",SOURCE_URLS.coinbase,SOURCE_URLS.blockchain)),...sourceMetaMany(["etf","market"]),series:f20Btc});
  add({id:"etf_1d",block:"demand",family:"etf",name:"ETF · последний день",horizon:"short",role:"component",method:"mechanical",strategic:false,tactical:false,vote:false,value_num:etf1,value:finite(etf1)?`${etf1>=0?"+":""}${formatCompact(etf1,0)} $`:"—",note:"Событийный компонент; один день не меняет среднесрочный режим.",score:null,source:"farside",...sourceMeta("etf"),series:etf});
  add({id:"etf_5d",block:"demand",family:"etf",name:"ETF · 5 торговых дней",horizon:"short",role:"component",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:etf5,value:finite(etf5)?`${etf5>=0?"+":""}${formatCompact(etf5,0)} $`:"—",delta:finite(p5)?`${p5.toFixed(0)}-й перцентиль`:"",note:"Быстрый компонент семейства.",score:null,source:"farside",...sourceMeta("etf"),series:etf5s});
  add({id:"etf_20d",block:"demand",family:"etf",name:"ETF · 20 торговых дней",horizon:"medium",role:"component",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:etf20,value:finite(etf20)?`${etf20>=0?"+":""}${formatCompact(etf20,0)} $`:"—",delta:finite(p20)?`${p20.toFixed(0)}-й перцентиль`:"",note:"Среднесрочный компонент семейства.",score:null,source:"farside",...sourceMeta("etf"),series:etf20s});

  const stable=series(data("stablecoins")||[]),st30Series=trailingChangeSeries(stable,30),st90Series=trailingChangeSeries(stable,90),st30=last(st30Series)?.v,st90=last(st90Series)?.v;
  const st30Pct=percentileRank(st30Series.slice(-1460).map(x=>x.v),st30),st90Pct=percentileRank(st90Series.slice(-1460).map(x=>x.v),st90),stableScore=componentScore([highGood(st30Pct),highGood(st90Pct)]);
  add({id:"stablecoin_regime",block:"demand",family:"stablecoins",name:"Стейблкоин-ликвидность",horizon:"medium",role:"leading",method:"dynamic",tactical:true,value_num:stableScore,value:finite(stableScore)?(stableScore>=1?"расширение":stableScore<=-1?"сжатие":"стабильно"):"—",delta:finite(st30)&&finite(st90)?`30д ${st30.toFixed(1)}% · 90д ${st90.toFixed(1)}%`:"",note:"30- и 90-дневное изменение совокупного предложения сравнивается с собственной историей. Это доступная внутренняя ликвидность, а не немедленный bid.",score:stableScore,source:"defillama",...sourceMeta("stablecoins"),series:stable});

  const inflow=cmSeries("FlowInExNtv"),outflow=cmSeries("FlowOutExNtv"),reserve=cmSeries("SplyExNtv"),netflow=[];
  const outMap=new Map(outflow.map(x=>[dayKey(x.t),x.v]));for(const p of inflow)if(finite(outMap.get(dayKey(p.t))))netflow.push({t:p.t,v:p.v-outMap.get(dayKey(p.t))});
  const nf7=last(rollingSum(netflow,7))?.v,nf30=last(rollingSum(netflow,30))?.v,res90=reserve.length?pct(last(reserve).v,priorByDays(reserve,90)?.v):null;
  const nfHist=rollingSum(netflow,7),nfPct=percentileRank(nfHist.slice(-1460).map(x=>x.v),nf7),res90Series=trailingChangeSeries(reserve,90),resPct=percentileRank(res90Series.slice(-1460).map(x=>x.v),res90);
  const exchangeScore=componentScore([finite(nfPct)?lowGood(nfPct):null,finite(resPct)?lowGood(resPct):null]);
  add({id:"exchange_supply",block:"demand",family:"exchange_supply",name:"Биржевое предложение BTC",horizon:"medium",role:"leading",method:"dynamic",tactical:true,value_num:exchangeScore,value:finite(exchangeScore)?(exchangeScore>=1?"сокращается":exchangeScore<=-1?"растёт":"сбалансировано"):"—",delta:finite(nf7)&&finite(res90)?`netflow 7д ${nf7>=0?"+":""}${formatCompact(nf7,0)} BTC · резерв 90д ${res90.toFixed(1)}%`:"",note:"Бесплатные exchange-метрики Coin Metrics. Адресная классификация может пересматриваться; показатель используется только как семейный режим, а не точный прогноз продаж.",score:exchangeScore,source:"coinmetrics",...sourceMeta("coinmetrics"),series:reserve});
  add({id:"exchange_netflow_30d",block:"demand",family:"exchange_supply",name:"Exchange netflow · 30 дней",horizon:"medium",role:"component",method:"dynamic",strategic:false,tactical:false,vote:false,value_num:nf30,value:finite(nf30)?`${nf30>=0?"+":""}${formatCompact(nf30,0)} BTC`:"—",note:"Положительное значение означает чистый приток на размеченные биржевые адреса.",score:null,source:"coinmetrics",...sourceMeta("coinmetrics"),series:rollingSum(netflow,30)});

  const cotRaw=data("cftc")||[],cot=series(cotRaw.map(x=>({t:x.t,v:x.oi?(x.assetLong-x.assetShort)/x.oi*100:null}))),cLast=last(cotRaw),c4=cotRaw.length>4?cotRaw[cotRaw.length-5]:null;
  const assetNet=cLast&&cLast.oi?(cLast.assetLong-cLast.assetShort)/cLast.oi*100:null,levShort=cLast&&cLast.oi?(cLast.levShort-cLast.levLong)/cLast.oi*100:null;
  const asset4=cLast&&c4&&cLast.oi&&c4.oi?assetNet-(c4.assetLong-c4.assetShort)/c4.oi*100:null,lev4=cLast&&c4&&cLast.oi&&c4.oi?levShort-(c4.levShort-c4.levLong)/c4.oi*100:null;
  let qualityScore=null,qualityText="—";
  if(finite(asset4)&&finite(lev4)){qualityScore=asset4>1&&lev4<1?1:lev4>3&&finite(etf20)&&etf20>0?-1:asset4<-2?-1:0;qualityText=qualityScore>0?"направленный спрос подтверждён":qualityScore<0?"ETF-поток частично похож на basis trade":"смешанное позиционирование";}
  add({id:"institutional_quality",block:"demand",family:"institutional",name:"Качество институционального спроса",horizon:"medium",role:"confirming",method:"derived",tactical:false,value_num:qualityScore,value:qualityText,delta:finite(assetNet)&&finite(levShort)?`asset mgr ${assetNet.toFixed(1)}% OI · lev. net short ${levShort.toFixed(1)}% OI`:"",note:"CFTC CME futures-only. Рост шортов leveraged funds при ETF-притоках понижает уверенность: часть спроса может быть cash-and-carry, а не направленной ставкой.",score:qualityScore,source:"CFTC · Farside",source_url:SOURCE_URLS.cftc,source_urls:links(SOURCE_URLS.cftc,SOURCE_URLS.farside),...sourceMetaMany(["cftc","etf"]),series:cot});

  const spot=data("spot")||{},cb=num(spot.coinbase),comparisonUsd=[spot.kraken,spot.bitstamp,spot.gemini].filter(sanePrice).map(Number),usdRef=median(comparisonUsd),premium=cb&&usdRef?(cb/usdRef-1)*10000:null;
  const premiumScore=customScore(premium,[[v=>v>35,2],[v=>v>8,1],[v=>v>-8,0],[v=>v>-35,-1],[()=>true,-2]]);
  add({id:"us_spot_premium",block:"demand",family:"us_spot",name:"Премия американского спота",horizon:"short",role:"confirming",method:"mechanical",strategic:false,tactical:true,value_num:premium,value:finite(premium)?`${premium>=0?"+":""}${premium.toFixed(0)} б.п.`:"—",delta:`Coinbase против медианы USD-площадок (${comparisonUsd.length})`,note:"Синхронная бесплатная прокси американского bid. Kraken, Bitstamp и Gemini взаимозаменяемы в знаменателе; USD и USDT никогда не смешиваются.",score:premiumScore,source:"Coinbase · Kraken · Bitstamp · Gemini",source_url:SOURCE_URLS.coinbase,source_urls:links(SOURCE_URLS.coinbase,SOURCE_URLS.kraken,SOURCE_URLS.bitstamp,SOURCE_URLS.gemini),...sourceMeta("spot")});

  // III. Цикл, сеть, майнеры
  // Valuation (MVRV) uses Coin Metrics when available and a dimensionally equivalent Blockchain.com ratio fallback. It is
  // therefore an OPTIONAL family: its absence must not break the panel — but it must also never be
  // allowed to manufacture optimism (see the valuation gate in candidateRegimes).
  const mvrvChoice=chooseWholeSeries("CapMVRVCur","MVRV"),mvrv=mvrvChoice.series,mvrvNow=last(mvrv)?.v,mvrvPct=percentileRank(sliceDays(mvrv,4*365).map(x=>x.v),mvrvNow),mvrv90=mvrv.length?pct(last(mvrv).v,priorByDays(mvrv,90)?.v):null;
  const ma200=price.length>=200?mean(price.slice(-200).map(x=>x.v)):null,trendAbove=priceLast&&ma200?priceLast>ma200:false;
  let mvrvScore=null;if(finite(mvrvPct)){mvrvScore=mvrvPct>=95?-2:mvrvPct>=82?-1:mvrvPct<=10?(trendAbove?1:0):mvrvPct<=70?1:0;}
  add({id:"mvrv_cycle",block:"cycle",family:"valuation",name:"MVRV · динамический цикл",horizon:"medium",role:"confirming",method:"dynamic",tactical:false,value_num:mvrvPct,value:finite(mvrvPct)?`${mvrvPct.toFixed(0)}-й перцентиль 4 лет`:"нет данных оценки",delta:finite(mvrvNow)&&finite(mvrv90)?`MVRV ${mvrvNow.toFixed(2)} · Δ90д ${mvrv90.toFixed(1)}%`:"",note:"Статические пороги прошлых циклов не используются. Верхние перцентили означают большую накопленную прибыль и риск дистрибуции; низкие требуют подтверждения трендом. Coin Metrics используется первым; Blockchain.com даёт открытый MVRV ratio fallback. Истории разных методологий не сшиваются и каждая оценивается по собственным перцентилям.",score:mvrvScore,source:mvrvChoice.source||"Coin Metrics / Blockchain.com",source_url:mvrvChoice.urls[0],source_urls:mvrvChoice.urls,...sourceMetaMany(mvrvChoice.keys),series:mvrv});

  // Network security uses mempool.space first and Blockchain.com hashrate/difficulty as an independent fallback:
  // US-reachable and independent of any commercial vendor. It is the always-available cycle leg.
  const hash=netSeries("hashrate"),diff=netSeries("difficulty"),netData=data("network")||{};
  const h90=hash.length?pct(last(hash).v,priorByDays(hash,90)?.v):null,d90=diff.length?pct(last(diff).v,priorByDays(diff,90)?.v):null,dAdj=num(netData.difficultyChange);
  const nsScore=componentScore([customScore(h90,[[v=>v>12,1],[v=>v>-5,0],[v=>v>-15,-1],[()=>true,-2]]),customScore(d90,[[v=>v>10,1],[v=>v>-5,0],[v=>v>-15,-1],[()=>true,-2]])]);
  add({id:"network_security",block:"cycle",family:"network",name:"Безопасность сети",horizon:"medium",role:"confirming",method:"dynamic",tactical:false,value_num:nsScore,value:finite(nsScore)?(nsScore>=1?"усиливается":nsScore<=-1?"ослабевает":"стабильна"):"—",delta:finite(h90)&&finite(d90)?`hashrate 90д ${h90.toFixed(1)}% · difficulty 90д ${d90.toFixed(1)}%`:"",note:"Хешрейт и сложность за 90 дней. Устойчивое падение обоих означает капитуляцию майнеров и вынужденные продажи; рост означает, что сеть переваривает текущую цену.",score:nsScore,source:datasetSource("network","network data"),source_url:datasets.network?.source_url||SOURCE_URLS.mempool,source_urls:datasetUrls("network",SOURCE_URLS.mempool,SOURCE_URLS.blockchain),...sourceMeta("network"),series:hash});
  add({id:"fee_pressure",block:"cycle",family:"fees",name:"Комиссии и загрузка блоков",horizon:"fast",role:"context",method:"mechanical",strategic:false,tactical:false,vote:false,value_num:num(netData.fees?.fastest),value:finite(netData.fees?.fastest)?`${Number(netData.fees.fastest).toFixed(0)} sat/vB`:"—",delta:finite(dAdj)?`следующий ретаргет ${dAdj>=0?"+":""}${dAdj.toFixed(1)}%`:"",note:"Контекст спроса на блочное пространство. Не голосует: комиссии сильно зависят от разовых волн ordinals/inscriptions.",score:null,source:datasetSource("network","network data"),source_url:datasets.network?.source_url||SOURCE_URLS.mempool,source_urls:datasetUrls("network",SOURCE_URLS.mempool,SOURCE_URLS.blockchain,SOURCE_URLS.blockstream),...sourceMeta("network")});

  const cmAddr=cmSeries("AdrActCnt"),cmTx=cmSeries("TxCnt"),cmTfr=cmSeries("TxTfrCnt"),bcAddr=bcSeries("AdrActCnt"),bcTx=bcSeries("TxCnt");
  // Activity is selected as one coherent provider bundle. Address and transaction definitions differ
  // between Coin Metrics and Blockchain.com, therefore the two providers are never mixed inside one vote.
  const activityCm=cmAddr.length>=180&&cmTx.length>=180,addr=activityCm?cmAddr:bcAddr,tx=activityCm?cmTx:bcTx,tfr=activityCm&&cmTfr.length>=180?cmTfr:[];
  const addrSeries=changeOfAverageSeries(addr,30,90),txSeries=changeOfAverageSeries(tx,30,90),tfrSeries=changeOfAverageSeries(tfr,30,90),addrCh=last(addrSeries)?.v,txCh=last(txSeries)?.v,tfrCh=last(tfrSeries)?.v;
  const activityScore=componentScore([highGood(percentileRank(addrSeries.slice(-1460).map(x=>x.v),addrCh)),highGood(percentileRank(txSeries.slice(-1460).map(x=>x.v),txCh)),tfrSeries.length?highGood(percentileRank(tfrSeries.slice(-1460).map(x=>x.v),tfrCh)):null]);
  const activityKeys=[activityCm?"coinmetrics":"blockchain_onchain"],activityUrls=activityCm?[SOURCE_URLS.coinmetrics]:[SOURCE_URLS.blockchain],activitySource=activityCm?"Coin Metrics":"Blockchain.com";
  add({id:"network_activity",block:"cycle",family:"activity",name:"Сетевая активность",horizon:"medium",role:"confirming",method:"dynamic",tactical:false,value_num:activityScore,value:finite(activityScore)?(activityScore>=1?"расширяется":activityScore<=-1?"сжимается":"стабильна"):"—",delta:finite(addrCh)&&finite(txCh)?`адреса ${addrCh.toFixed(1)}% · tx ${txCh.toFixed(1)}%`:"",note:"Адреса и транзакции всегда берутся одним пакетом от одного провайдера. Coin Metrics и Blockchain.com имеют разные правила подсчёта, поэтому их ряды не смешиваются и нормируются только на собственную историю.",score:activityScore,source:activitySource,source_url:activityUrls[0],source_urls:activityUrls,...sourceMetaMany(activityKeys),series:addr});

  // Miner economics: Coin Metrics issuance revenue over the mempool.space hashrate. Hashrate trend
  // alone is deliberately NOT used here — it already votes through network_security, and reusing it
  // would double-count the same observation across two families.
  const iss=cmSeries("IssTotUSD"),feeN=cmSeries("FeeTotNtv"),bcRevenue=bcSeries("MinerRevUSD"),priceMap=new Map(price.map(x=>[dayKey(x.t),x.v])),hashMap=new Map(hash.map(x=>[dayKey(x.t),x.v])),feeMap=new Map(feeN.map(x=>[dayKey(x.t),x.v])),revenue=[],minerCm=iss.length>=180&&feeN.length>=180;
  // Coin Metrics is used only when both issuance revenue and fees are present, because Blockchain.com's
  // miners-revenue is a total-revenue series. This keeps both paths dimensionally equivalent (USD/day).
  if(minerCm){for(const r of iss){const p=priceMap.get(dayKey(r.t)),f=feeMap.get(dayKey(r.t));if(finite(r.v)&&finite(f)&&finite(p))revenue.push({t:r.t,v:r.v+f*p});}}else revenue.push(...bcRevenue);
  const revHash=[];for(const r of revenue){const h=hashMap.get(dayKey(r.t));if(finite(h)&&h>0)revHash.push({t:r.t,v:r.v/h});}
  const hpCh=changeOfAverage(revHash,30,30),minerScore=customScore(hpCh,[[v=>v>15,1],[v=>v>-10,0],[v=>v>-30,-1],[()=>true,-2]]);
  add({id:"miner_regime",block:"cycle",family:"miners",name:"Экономика майнинга",horizon:"medium",role:"confirming",method:"derived",tactical:false,value_num:minerScore,value:finite(minerScore)?(minerScore>=1?"устойчива":minerScore<=-1?"стресс":"нейтрально"):"—",delta:finite(hpCh)?`revenue/hash 30д ${hpCh.toFixed(1)}%`:"",note:"Числитель — совокупный доход майнеров в USD: Coin Metrics issuance+fees либо Blockchain.com miners revenue. Знаменатель — независимый hashrate. Размерность обоих путей одинакова (USD на H/s), но исторические ряды не сшиваются.",score:minerScore,source:minerCm?"Coin Metrics · network":"Blockchain.com · network",source_url:minerCm?SOURCE_URLS.coinmetrics:SOURCE_URLS.blockchain,source_urls:links(minerCm?SOURCE_URLS.coinmetrics:SOURCE_URLS.blockchain,SOURCE_URLS.mempool,SOURCE_URLS.blockchain),...sourceMetaMany([minerCm?"coinmetrics":"blockchain_onchain","network"]),series:revHash});

  const ma140=price.length>=140?mean(price.slice(-140).map(x=>x.v)):null,ma1400=price.length>=1400?mean(price.slice(-1400).map(x=>x.v)):null;
  let trendScore=null,trendText="—";if(priceLast&&ma200&&ma140){if(priceLast>ma200&&priceLast>ma140){trendScore=2;trendText="выше 20W и 200D";}else if(priceLast>ma200||priceLast>ma140){trendScore=0;trendText="смешанный тренд";}else if(!ma1400||priceLast>ma1400){trendScore=-1;trendText="ниже среднесрочных опор";}else{trendScore=-2;trendText="ниже 200W";}}
  add({id:"trend_regime",block:"cycle",family:"trend",name:"Старший ценовой тренд",horizon:"medium",role:"confirming",method:"mechanical",tactical:true,value_num:trendScore,value:trendText,delta:priceLast&&ma200?`цена к 200D ${pct(priceLast,ma200).toFixed(1)}%`:"",note:"Рефлексивная, но воспроизводимая проверка 20-недельной, 200-дневной и 200-недельной средних. Не используется как оценка справедливой стоимости.",score:trendScore,source:datasetSource("market","market price"),source_url:datasets.market?.source_url||SOURCE_URLS.coinbase,source_urls:datasetUrls("market",SOURCE_URLS.coinbase,SOURCE_URLS.blockchain),...sourceMeta("market"),series:price});
  const athVal=num(data("market")?.ath),athSource=data("market")?.athSource,dd=priceLast&&athVal?pct(priceLast,athVal):null;
  add({id:"drawdown",block:"cycle",family:"trend",name:"Просадка от исторического максимума",horizon:"short",role:"context",method:"mechanical",strategic:false,tactical:false,vote:false,value_num:dd,value:finite(dd)?`${dd.toFixed(1)}%`:"—",delta:athSource==="coingecko"?"ATH: CoinGecko":athSource==="blockchain"?"ATH: Blockchain.com all-time":"ATH: максимум наблюдаемого окна",note:"Контекст стадии рынка; сама по себе не является сигналом дешёвой или дорогой цены. Источник ATH подписан явно: при недоступности CoinGecko используется максимум пятилетнего окна, а не выдуманное значение.",score:null,source:"CoinGecko · Coinbase",source_url:SOURCE_URLS.coingecko,source_urls:links(SOURCE_URLS.coingecko,SOURCE_URLS.coinbase),...sourceMeta("market"),series:price});

  // IV. Плечо и волатильность
  const der=data("derivatives")||{},fund=der.funding||[],weightedRows=fund.filter(x=>finite(x.rate8h)&&finite(x.oiUsd)&&Number(x.oiUsd)>0),oiTotal=sumOrNull(weightedRows.map(x=>x.oiUsd)),weightedFunding=oiTotal?sum(weightedRows.map(x=>x.rate8h*x.oiUsd))/oiTotal:median(fund.map(x=>x.rate8h)),fundPct=finite(weightedFunding)?weightedFunding*100:null,basis=num(der.basis);
  const carryScore=componentScore([customScore(fundPct,[[v=>v>.05,-2],[v=>v>.02,-1],[v=>v>-.02,1],[v=>v>-.05,0],[()=>true,-1]]),customScore(basis,[[v=>v<0,-1],[v=>v<3,0],[v=>v<12,1],[v=>v<20,0],[v=>v<30,-1],[()=>true,-2]])]);
  add({id:"carry_regime",block:"leverage",family:"carry",name:"Funding и фьючерсный carry",horizon:"short",role:"leading",method:"mechanical",strategic:false,tactical:true,value_num:carryScore,value:finite(carryScore)?(carryScore>=1?"сбалансировано":carryScore<=-1?"перегрето / стресс":"смешанно"):"—",delta:finite(fundPct)&&finite(basis)?`funding ${fundPct>=0?"+":""}${fundPct.toFixed(3)}%/8ч · basis ${basis.toFixed(1)}% (${der.basisSource||"—"})`:"",note:"Funding нормируется к 8 часам и агрегируется с весом USD OI. Annualized basis берётся с ближайшего сопоставимого датированного фьючерса Deribit, а при его отсутствии — Kraken Futures. Умеренное контанго нормально.",score:carryScore,source:"Deribit · Kraken Futures · Bybit · OKX",source_url:SOURCE_URLS.deribit,source_urls:SOURCE_URL_GROUPS.derivatives,...sourceMeta("derivatives")});
  add({id:"funding",block:"leverage",family:"carry",name:"Агрегированный funding",horizon:"short",role:"component",method:"mechanical",strategic:false,tactical:false,vote:false,value_num:fundPct,value:finite(fundPct)?`${fundPct>=0?"+":""}${fundPct.toFixed(3)}% / 8ч`:"—",delta:`площадки ${fund.length}`,note:"Компонент семейства. Отрицательный экстремум — не автоматически бычий сигнал, а потенциальное топливо short squeeze.",score:null,source:"Deribit · Kraken Futures · Bybit · OKX",source_url:SOURCE_URLS.deribit,source_urls:SOURCE_URL_GROUPS.derivatives,...sourceMeta("derivatives")});

  const currentOiByVenue=Object.fromEntries(weightedRows.map(x=>[x.venue,Number(x.oiUsd)])),currentVenues=Object.keys(currentOiByVenue),hist=(previous?.history||[]).slice().sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)),oiSeries=hist.map(h=>{const t=Date.parse(h.t),by=h.raw?.oi_by_venue,vals=currentVenues.map(k=>by?.[k]);return currentVenues.length>=2&&vals.every(finite)?{t,v:sum(vals)}:null;}).filter(Boolean);if(finite(oiTotal))oiSeries.push({t:NOW,v:oiTotal});
  const priorOi=(days)=>{const target=NOW-days*DAY;let found=null;for(const h of hist){const t=Date.parse(h.t);if(t<=target&&h.raw?.oi_by_venue)found=h;else if(t>target)break;}return found?.raw?.oi_by_venue||null;};
  const oi7=percentChangeCommonVenues(currentOiByVenue,priorOi(7));
  let oiScore=null,oiText="история накапливается";if(finite(oi7)&&finite(p7)){if(p7<-5&&oi7>3){oiScore=-2;oiText="цена ↓, OI ↑";}else if(p7>3&&oi7>15){oiScore=-1;oiText="рост на быстром наборе OI";}else if(p7<-5&&oi7<-8){oiScore=1;oiText="очистка OI на падении";}else if(Math.abs(oi7)<8){oiScore=1;oiText="OI стабилен";}else{oiScore=0;oiText="смешанная динамика";}}
  add({id:"oi_quality",block:"leverage",family:"oi",name:"Качество движения · цена × OI",horizon:"short",role:"leading",method:"derived",strategic:false,tactical:true,value_num:oiScore,value:oiText,delta:finite(oi7)&&finite(p7)?`цена 7д ${p7.toFixed(1)}% · OI ${oi7.toFixed(1)}%`:finite(oiTotal)?`OI ${formatCompact(oiTotal,1)} $`:"",note:"История OI накапливается самим проектом. Падение со сбросом OI — очистка; падение с ростом OI — наращивание риска.",score:oiScore,source:"Deribit · Kraken Futures · Bybit · OKX",source_url:SOURCE_URLS.deribit,source_urls:SOURCE_URL_GROUPS.derivatives,...sourceMeta("derivatives"),series:oiSeries});

  // Realized volatility is derived from the price series alone. It is the one leverage-block input
  // that cannot be removed by a geo-block, and it therefore anchors the tactical gate instead of
  // carry_regime — which dies the moment every derivatives venue is unreachable from the runner.
  const rv30=annualizedVol(price,30),rv30Series=[];
  for(let i=30;i<price.length;i++){const w=price.slice(i-30,i+1),v=annualizedVol(w,30);if(finite(v))rv30Series.push({t:price[i].t,v});}
  const rvPct=percentileRank(rv30Series.slice(-730).map(x=>x.v),rv30);
  const rvScore=!finite(rvPct)?null:rvPct>=95?-2:rvPct>=85?-1:rvPct<=8?-1:1;
  add({id:"realized_volatility",block:"leverage",family:"realized_vol",name:"Реализованная волатильность · 30 дней",horizon:"short",role:"leading",method:"dynamic",strategic:false,tactical:true,value_num:rv30,value:finite(rv30)?`${rv30.toFixed(1)}%`:"—",delta:finite(rvPct)?`${rvPct.toFixed(0)}-й перцентиль 2 лет`:"",note:"Годовая реализованная волатильность по дневным ценам. Считается из собственного ценового ряда и потому доступна даже когда все биржи деривативов недоступны с IP раннера — это опора тактического гейта. Экстремумы в обе стороны означают хрупкость: перегрев или сжатую пружину.",score:rvScore,source:datasetSource("market","market price"),source_url:datasets.market?.source_url||SOURCE_URLS.coinbase,source_urls:datasetUrls("market",SOURCE_URLS.coinbase,SOURCE_URLS.blockchain),...sourceMeta("market"),series:rv30Series});

  const dvolS=series(der.dvolSeries||[]),dvol=num(der.dvol),dvolPct=percentileRank(sliceDays(dvolS,2*365).map(x=>x.v),dvol),skew=num(der.skew),vrp=finite(dvol)&&finite(rv30)?dvol-rv30:null;
  // Skew no longer hands out a free +1 for "normal": an ordinary put-call spread is not evidence of
  // health, it is merely the absence of evidence. Only genuine put stress or an unusual call bid
  // moves the score.
  const volScore=componentScore([finite(dvolPct)?(dvolPct>=95?-2:dvolPct>=85?-1:dvolPct<=8?-1:1):null,customScore(skew,[[v=>v>20,-2],[v=>v>10,-1],[v=>v>-8,0],[()=>true,-1]])]);
  add({id:"options_vol",block:"leverage",family:"volatility",name:"Опционная волатильность и skew",horizon:"short",role:"leading",method:"dynamic",strategic:false,tactical:true,value_num:volScore,value:finite(volScore)?(volScore>=1?"сбалансировано":volScore<=-1?"напряжение / сжатая пружина":"смешанно"):"—",delta:finite(dvol)&&finite(skew)?`DVOL ${dvol.toFixed(1)} · put-call IV ${skew>=0?"+":""}${skew.toFixed(1)}`:"",note:"DVOL оценивается по двухлетнему перцентилю. Skew — прозрачная OTM put-call IV-прокси близкой экспирации, не dealer GEX и не точный 25-delta risk reversal.",score:volScore,source:"deribit",...sourceMeta("derivatives"),series:dvolS});
  add({id:"vol_risk_premium",block:"leverage",family:"volatility",name:"IV − реализованная волатильность",horizon:"short",role:"context",method:"derived",strategic:false,tactical:false,vote:false,value_num:vrp,value:finite(vrp)?`${vrp>=0?"+":""}${vrp.toFixed(1)} vol`:"—",delta:finite(rv30)?`RV30 ${rv30.toFixed(1)}`:"",note:"Контекст цены страховки; не получает отдельный голос.",score:null,source:"deribit",...sourceMeta("derivatives")});

  // V. Качество цены
  const usdDisp=quoteDispersion(spot,"USD"),usdtDisp=quoteDispersion(spot,"USDT"),spreads=[usdDisp,usdtDisp].filter(finite),disp=spreads.length?Math.max(...spreads):null,completeSpotPairs=finite(usdDisp)&&finite(usdtDisp);
  const integrityScore=completeSpotPairs?customScore(disp,[[v=>v<20,1],[v=>v<50,0],[v=>v<100,-1],[()=>true,-2]]):customScore(disp,[[v=>v<50,null],[v=>v<100,-1],[()=>true,-2]]);
  add({id:"spot_integrity",block:"market",family:"integrity",name:"Синхронность спотовых площадок",horizon:"fast",role:"leading",method:"mechanical",strategic:false,tactical:true,value_num:disp,value:finite(disp)?`${disp.toFixed(0)} б.п.`:"—",delta:`USD ${finite(usdDisp)?usdDisp.toFixed(0):"—"} · USDT ${finite(usdtDisp)?usdtDisp.toFixed(0):"—"} б.п.`,note:"USD-площадки (Coinbase/Kraken/Bitstamp/Gemini) и USDT-площадки (OKX/Bybit) сравниваются только внутри одинаковой валюты котирования. Положительный голос требует обеих полных пар; одна доступная группа может только предупредить о расхождении.",score:integrityScore,source:"Coinbase · Kraken · Bitstamp · Gemini · OKX · Bybit",source_url:SOURCE_URLS.coinbase,source_urls:SOURCE_URL_GROUPS.spot,...sourceMeta("spot")});

  const vol=marketSeries("volume"),volCh=changeOfAverage(vol,30,30);let volumeScore=null,volumeText="—";
  if(finite(volCh)&&finite(p30)){if(p30>5&&volCh>10){volumeScore=1;volumeText="рост подтверждён объёмом";}else if(p30<-5&&volCh>15){volumeScore=-1;volumeText="продажи подтверждены объёмом";}else if(Math.abs(p30)<5){volumeScore=0;volumeText="боковой режим";}else{volumeScore=0;volumeText="движение без сильного подтверждения";}}
  add({id:"volume_confirmation",block:"market",family:"volume",name:"Подтверждение движения спот-объёмом",horizon:"short",role:"confirming",method:"derived",strategic:false,tactical:true,value_num:volumeScore,value:volumeText,delta:finite(p30)&&finite(volCh)?`цена 30д ${p30.toFixed(1)}% · объём ${volCh.toFixed(1)}%`:"",note:"Primary — дневной Coinbase BTC-USD volume в USD; fallback — Blockchain.com exchange trade volume, также USD/day, но с иным набором площадок. Выбирается целая история одного источника. Это не CVD и не попытка определить агрессора сделки.",score:volumeScore,source:datasetSource("market","market price"),source_url:datasets.market?.source_url||SOURCE_URLS.coinbase,source_urls:datasetUrls("market",SOURCE_URLS.coinbase,SOURCE_URLS.blockchain),...sourceMeta("market"),series:vol});

  const pegs=data("pegs")||{},completePeg=["USDT","USDC"].every(k=>finite(pegs[k]));
  const pegValues=["USDT","USDC"].filter(k=>finite(pegs[k])).map(k=>Math.abs(Number(pegs[k])-1)*100),pegDev=completePeg?Math.max(...pegValues):null;
  add({id:"stablecoin_peg",block:"market",family:"stablecoin_integrity",name:"Целостность крупных стейблкоинов",horizon:"fast",role:"leading",method:"mechanical",strategic:false,tactical:true,value_num:pegDev,value:finite(pegDev)?`${pegDev.toFixed(2)}% max deviation`:"неполное покрытие",delta:["USDT","USDC"].filter(k=>finite(pegs[k])).map(k=>`${k} ${Number(pegs[k]).toFixed(4)}`).join(" · "),note:"Здоровый голос требует одновременно валидных USDT и USDC. Одиночный доступный экстремальный депег всё ещё виден аварийному детектору, но отсутствие второй монеты не оценивается как нормальный паритет.",score:customScore(pegDev,[[v=>v<.2,1],[v=>v<.5,0],[v=>v<1,-1],[()=>true,-2]]),source:"DefiLlama · exchange fallback",source_url:SOURCE_URLS.defillama,source_urls:links(SOURCE_URLS.defillama,SOURCE_URLS.coinbase,SOURCE_URLS.kraken,SOURCE_URLS.gemini),...sourceMeta("pegs")});

  return m;
}

function familyStats(metrics,block,horizon){
  const eligible=metrics.filter(x=>x.block===block&&x.vote&&x.score!=null&&(horizon==="strategic"?x.strategic:x.tactical));
  const expected=[...new Set(metrics.filter(x=>x.block===block&&x.vote&&(horizon==="strategic"?x.strategic:x.tactical)).map(x=>x.family))];
  const groups={};for(const x of eligible)(groups[x.family]??=[]).push(x.score);
  const fam=Object.fromEntries(Object.entries(groups).map(([k,a])=>[k,mean(a)]));
  return{score:Object.keys(fam).length?mean(Object.values(fam))/2*100:null,coverage:expected.length?Object.keys(fam).length/expected.length:1,families:fam,expected};
}
function band(score){return score==null?"unknown":score>=20?"supportive":score<=-20?"adverse":"neutral";}
function fastDemand(metrics){const ids=["etf_regime","stablecoin_regime","exchange_supply","us_spot_premium"];const a=metrics.filter(x=>ids.includes(x.id)&&x.score!=null).map(x=>x.score);return a.length?mean(a)/2*100:null;}
function detectorState(hit,total,good=false){if(hit>=Math.max(3,total-1))return good?"good":"fired";if(hit>=2)return"watch";return"calm";}
function getM(metrics,id){return metrics.find(x=>x.id===id);}

function buildDetectors(metrics){
  const v=id=>getM(metrics,id)?.value_num,s=id=>getM(metrics,id)?.score;
  const out=[],ge=(id,x)=>finite(s(id))&&Number(s(id))>=x,le=(id,x)=>finite(s(id))&&Number(s(id))<=x;
  const peg=v("stablecoin_peg"),disp=v("spot_integrity"),pegData=data("pegs")||{},majorDevs=["USDT","USDC"].map(k=>finite(pegData[k])?Math.abs(Number(pegData[k])-1)*100:null).filter(finite),spotData=data("spot")||{};let hard=null;
  const usdSpread=quoteDispersion(spotData,"USD"),usdtSpread=quoteDispersion(spotData,"USDT");
  let state=classifyIntegrity({peg,disp,majorDevs,usdSpread,usdtSpread});
  if(state==="fired")hard="НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА";
  out.push({id:"integrity",name:"Нарушение целостности рынка",state,strategic_points:state==="fired"?-20:0,tactical_points:state==="fired"?-45:state==="watch"?-10:0,inputs:`peg ${finite(peg)?peg.toFixed(2)+"%":"—"} · spread ${finite(disp)?disp.toFixed(0)+" б.п.":"—"}`,logic:"Hard override требует независимого подтверждения для депега 5–10%; катастрофическое отклонение ≥10% срабатывает самостоятельно. Также override включается при экстремальной фрагментации сразу в двух quote-группах или ≥300 б.п. в одной. Более слабая одиночная аномалия остаётся наблюдением."});
  const levHits=[le("carry_regime",-1),le("oi_quality",-1),le("options_vol",-1)].filter(Boolean).length;
  out.push({id:"leverage",name:"Перегрев / каскад плеча",state:detectorState(levHits,3),strategic_points:0,tactical_points:levHits>=3?-25:levHits>=2?-10:0,inputs:`условий ${levHits}/3`,logic:"Конвергенция дорогого carry, ухудшения цена×OI и напряжения опционов. Один funding не считается каскадом."});
  const demandHits=[le("etf_regime",-1),le("stablecoin_regime",-1),le("exchange_supply",-1),le("us_spot_premium",-1)].filter(Boolean).length;
  out.push({id:"demand_break",name:"Слом маржинального спроса",state:detectorState(demandHits,4),strategic_points:demandHits>=3?-15:demandHits>=2?-5:0,tactical_points:demandHits>=3?-15:demandHits>=2?-5:0,inputs:`условий ${demandHits}/4`,logic:"ETF, стейблкоины, биржевое предложение и американский спот должны ухудшаться совместно."});
  const macroHits=[le("liquidity_regime",-1),le("financial_conditions",-1),le("system_stress",-1)].filter(Boolean).length;
  out.push({id:"macro_shock",name:"Макрошок ликвидности",state:detectorState(macroHits,3),strategic_points:macroHits>=3?-12:macroHits>=2?-5:0,tactical_points:macroHits>=3?-10:macroHits>=2?-5:0,inputs:`условий ${macroHits}/3`,logic:"Сжатие Net Liquidity, ужесточение ставок/доллара и кредитный стресс должны подтвердить друг друга."});
  const distHits=[le("mvrv_cycle",-1),le("exchange_supply",-1),le("trend_regime",-1)].filter(Boolean).length;
  out.push({id:"distribution",name:"Дистрибуция и потеря тренда",state:detectorState(distHits,3),strategic_points:distHits>=3?-12:distHits>=2?-5:0,tactical_points:distHits>=3?-5:0,inputs:`условий ${distHits}/3`,logic:"Высокая накопленная прибыль опасна только вместе с ростом биржевого предложения и потерей ценовых опор."});
  const squeezeHits=[finite(v("funding"))&&v("funding")<-.03,ge("us_spot_premium",0),ge("etf_regime",0),le("oi_quality",0)].filter(Boolean).length;
  out.push({id:"short_squeeze",name:"Условия short squeeze",state:detectorState(squeezeHits,4,true),strategic_points:0,tactical_points:squeezeHits>=3?8:0,inputs:`условий ${squeezeHits}/4`,logic:"Отрицательный funding при стабилизации спот-спроса создаёт топливо отскока, но не меняет среднесрочный режим."});
  const recoveryHits=[finite(v("mvrv_cycle"))&&v("mvrv_cycle")<25,ge("trend_regime",0),ge("etf_regime",0),ge("exchange_supply",0)].filter(Boolean).length;
  out.push({id:"recovery",name:"Капитуляция → восстановление",state:detectorState(recoveryHits,4,true),strategic_points:recoveryHits>=3?8:0,tactical_points:recoveryHits>=3?8:0,inputs:`условий ${recoveryHits}/4`,logic:"Низкая циклическая оценка полезна только после стабилизации тренда, потоков ETF и биржевого предложения."});
  return{detectors:out,hardOverride:hard};
}

function candidateRegimes(blocks,metrics,detectors,hardOverride){
  const present=id=>getM(metrics,id)?.score!=null;
  const strategicRequired=[
    ["liquidity_regime"],["financial_conditions"],["etf_regime"],
    ["stablecoin_regime","exchange_supply"],["trend_regime"],["network_security"]
  ];
  // carry_regime is NOT required: every derivatives venue can be geo-blocked from a US runner at
  // once, and a permanently "insufficient" tactical verdict is worse than an honest one computed
  // without leverage. realized_volatility replaces it — it is derived from price and always exists.
  const tacticalRequired=[["spot_integrity"],["stablecoin_peg"],["realized_volatility"],["etf_regime","us_spot_premium","stablecoin_regime"]];
  const missingS=strategicRequired.filter(group=>!group.some(present)).map(group=>group.join(" | "));
  const missingT=tacticalRequired.filter(group=>!group.some(present)).map(group=>group.join(" | "));
  const criticalStrategic=["macro","demand","cycle"].every(k=>blocks[k].strategic.coverage>=CRITICAL_MIN[k])&&!missingS.length;
  const criticalTactical=["demand","market"].every(k=>blocks[k].tactical.coverage>=CRITICAL_MIN[k])&&!missingT.length;
  if(hardOverride)return{strategic:"emergency",tactical:"emergency",criticalStrategic,criticalTactical,missingS,missingT};
  const M=band(blocks.macro.strategic.score),D=band(blocks.demand.strategic.score),C=band(blocks.cycle.strategic.score);
  let strategic="transition";
  if(!criticalStrategic)strategic="insufficient";
  else if((D==="adverse"&&C==="adverse")||(M==="adverse"&&D==="adverse"))strategic="defensive";
  else if([M,D,C].filter(x=>x==="adverse").length>=1)strategic="deteriorating";
  else if(D==="supportive"&&C==="supportive"&&M!=="adverse")strategic="constructive";
  else if(D==="supportive"&&M==="supportive")strategic="constructive";
  else if(M==="supportive"&&C==="supportive"&&D==="neutral")strategic="unconfirmed_positive";

  // VALUATION GATE (asymmetric).
  // MVRV is the only cycle input with no free substitute, so it cannot be a hard requirement — a
  // single vendor would otherwise be able to switch the whole panel off. But its absence must not
  // be silently treated as "nothing to worry about": a trend-and-flows-only picture is exactly the
  // reflexive trap the model exists to avoid ("price is up, therefore it is good").
  // Therefore: missing valuation can never CREATE optimism, but it never SUPPRESSES a warning.
  const valuationAvailable=present("mvrv_cycle");
  if(!valuationAvailable&&["constructive","unconfirmed_positive"].includes(strategic))strategic="transition";

  const L=blocks.leverage.tactical.score,Q=fastDemand(metrics),K=blocks.market.tactical.score;
  const levDet=detectors.find(x=>x.id==="leverage")?.state,demandDet=detectors.find(x=>x.id==="demand_break")?.state;
  let tactical="balanced";
  if(!criticalTactical)tactical="insufficient";
  else if(levDet==="fired"&&demandDet==="fired")tactical="deleveraging";
  else if(L!=null&&L<=-35&&Q!=null&&Q<=-15)tactical="fragile";
  else if(L!=null&&L<=-35&&Q!=null&&Q>0)tactical="overheated_supported";
  else if(L!=null&&L>=15&&Q!=null&&Q>=15&&K>=-20)tactical="spot_led";
  else if(detectors.find(x=>x.id==="short_squeeze")?.state==="good")tactical="short_squeeze";
  return{strategic,tactical,criticalStrategic,criticalTactical,missingS,missingT,valuationAvailable};
}

const STRATEGIC_TEXT={constructive:"КОНСТРУКТИВНЫЙ СРЕДНЕСРОЧНЫЙ РЕЖИМ",unconfirmed_positive:"ПОЛОЖИТЕЛЬНО, НО СПРОС НЕ ПОДТВЕРДИЛ",transition:"ПЕРЕХОДНЫЙ СРЕДНЕСРОЧНЫЙ РЕЖИМ",deteriorating:"СРЕДНЕСРОЧНЫЙ РЕЖИМ УХУДШАЕТСЯ",defensive:"ЗАЩИТНЫЙ СРЕДНЕСРОЧНЫЙ РЕЖИМ",insufficient:"НЕДОСТАТОЧНО ДАННЫХ",emergency:"АВАРИЙНЫЙ РЕЖИМ"};
const TACTICAL_TEXT={spot_led:"СПОТ-ВЕДОМАЯ КРАТКОСРОЧНАЯ СТРУКТУРА",balanced:"СБАЛАНСИРОВАННАЯ КРАТКОСРОЧНАЯ СТРУКТУРА",overheated_supported:"БЫЧИЙ ФОН, НО ПЛЕЧО ПЕРЕГРЕТО",fragile:"ХРУПКАЯ КРАТКОСРОЧНАЯ СТРУКТУРА",deleveraging:"ДЕЛЕВЕРИДЖ · ТАКТИЧЕСКАЯ ЗАЩИТА",short_squeeze:"УСЛОВИЯ ДЛЯ SHORT SQUEEZE",insufficient:"НЕДОСТАТОЧНО ДАННЫХ",emergency:"АВАРИЙНЫЙ РЕЖИМ"};
function severity(x){return{constructive:2,unconfirmed_positive:1,transition:0,deteriorating:-1,defensive:-2,spot_led:2,balanced:0,overheated_supported:-1,fragile:-1,deleveraging:-2,short_squeeze:1,insufficient:0,emergency:-3}[x]??0;}
function stabilize(candidate,type,hard){
  if(hard||candidate==="insufficient"||candidate==="emergency"||!previous||previous.mock||previous.regime?.[type]==="insufficient")return{state:candidate,candidate,count:1};
  const meta=previous.regime_meta?.[type]||{},count=meta.candidate===candidate?(meta.count||0)+1:1,prev=previous.regime?.[type]||candidate;
  return{state:count>=2?candidate:prev,candidate,count};
}
function behaviors(s,t){
  const medium={constructive:"Базовая экспозиция режимно оправдана; добавления лучше делать ступенчато и не игнорировать тактический перегрев.",unconfirmed_positive:"Не наращивать экспозицию агрессивно: макро и цикл поддерживают рынок, но реальный маржинальный спрос недостаточен.",transition:"Сохранять умеренную экспозицию и ждать согласования потоков, макро и структуры предложения.",deteriorating:"Сократить риск новых добавлений, повысить запас ликвидности и требовать восстановления спроса перед увеличением позиции.",defensive:"Приоритет — сохранение капитала; увеличение экспозиции только после разворота потоков и восстановления ценовых опор.",insufficient:"Не делать вывод из панели: критические блоки покрыты недостаточно.",emergency:"Приоритет — контроль контрагентского и ликвидностного риска; обычный скоринг временно недействителен."}[s];
  const short={spot_led:"Краткосрочные добавления допустимы после обычных откатов, пока ETF/спот и чистое плечо подтверждают движение.",balanced:"Не форсировать вход: структура нейтральна, решения лучше привязывать к среднесрочному режиму.",overheated_supported:"Среднесрочную позицию не путать с новым входом: избегать погони за ценой и ждать очистки funding/OI.",fragile:"Новые добавления отложить; рынок уязвим к каскаду даже без изменения среднесрочной картины.",deleveraging:"Тактически защитный режим: дождаться сброса OI, стабилизации funding и возвращения спот-поддержки.",short_squeeze:"Возможен резкий отскок, но он не является подтверждением нового среднесрочного бычьего режима.",insufficient:"Краткосрочный вывод недоступен из-за неполных данных.",emergency:"Не полагаться на обычные котировки и сигналы до восстановления паритета и синхронности площадок."}[t];
  return{medium,short};
}
function phase(s,t){if(s==="emergency"||t==="emergency")return"Аварийная фаза · обычный режимный скоринг временно недействителен";if(s==="insufficient"||t==="insufficient")return"Фаза не определена · недостаточно критических данных";if(s==="constructive"&&t==="spot_led")return"Фаза 1 · спот-ведомое расширение";if(s==="constructive"&&["overheated_supported","fragile"].includes(t))return"Фаза 2 · конструктивный цикл, накопление тактической хрупкости";if(["deteriorating","transition"].includes(s)&&["fragile","deleveraging"].includes(t))return"Фаза 3 · дистрибуция / переход";if(s==="defensive")return"Фаза 4 · защитный режим";if(t==="short_squeeze")return"Фаза 0 · попытка восстановления / squeeze";return"Фаза перехода · сигналы не согласованы";}

function compute(){
  const metrics=buildMetrics(),blocks={};
  for(const [k,b] of Object.entries(BLOCKS))blocks[k]={...b,strategic:familyStats(metrics,k,"strategic"),tactical:familyStats(metrics,k,"tactical")};
  const {detectors,hardOverride}=buildDetectors(metrics);
  let strategicRaw=0,sw=0,tacticalRaw=0,tw=0;
  for(const [k,b] of Object.entries(blocks)){if(b.strategic.score!=null&&b.strategicWeight){const w=b.strategicWeight*b.strategic.coverage;strategicRaw+=b.strategic.score*w;sw+=w;}if(b.tactical.score!=null&&b.tacticalWeight){const w=b.tacticalWeight*b.tactical.coverage;tacticalRaw+=b.tactical.score*w;tw+=w;}}
  strategicRaw=sw?strategicRaw/sw:null;tacticalRaw=tw?tacticalRaw/tw:null;
  const adjS=sum(detectors.map(x=>x.strategic_points)),adjT=sum(detectors.map(x=>x.tactical_points));
  const scores={strategic:finite(strategicRaw)?clamp(strategicRaw+adjS,-100,100):null,tactical:finite(tacticalRaw)?clamp(tacticalRaw+adjT,-100,100):null,strategic_raw:strategicRaw,tactical_raw:tacticalRaw,strategic_adjustment:adjS,tactical_adjustment:adjT};
  const candidates=candidateRegimes(blocks,metrics,detectors,hardOverride),stableS=stabilize(candidates.strategic,"strategic",hardOverride),stableT=stabilize(candidates.tactical,"tactical",hardOverride);
  const regime={strategic:stableS.state,tactical:stableT.state};scores.critical_coverage_ok=candidates.criticalStrategic&&candidates.criticalTactical;scores.critical_missing={strategic:candidates.missingS||[],tactical:candidates.missingT||[]};scores.valuation_available=!!candidates.valuationAvailable;scores.coverage_strategic=mean([blocks.macro.strategic.coverage,blocks.demand.strategic.coverage,blocks.cycle.strategic.coverage]);scores.coverage_tactical=mean([blocks.demand.tactical.coverage,blocks.leverage.tactical.coverage,blocks.market.tactical.coverage]);
  const onchainIds=["mvrv_cycle","exchange_supply","network_activity","miner_regime"],onchainAvailable=onchainIds.filter(id=>getM(metrics,id)?.score!=null).length;
  scores.onchain_coverage=onchainAvailable/onchainIds.length;scores.onchain_status=onchainAvailable===4?"full":onchainAvailable>=2?"partial":"minimal";
  const factors={strategic:metrics.filter(x=>x.vote&&x.strategic&&x.score!=null).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,8).map(x=>({id:x.id,name:x.name,score:x.score,value:x.value})),tactical:metrics.filter(x=>x.vote&&x.tactical&&x.score!=null).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,8).map(x=>({id:x.id,name:x.name,score:x.score,value:x.value}))};
  const price=referencePrice(),history=(previous?.history||[]).filter(h=>NOW-Date.parse(h.t)<730*DAY);
  const oiByVenue=Object.fromEntries((data("derivatives")?.funding||[]).filter(x=>finite(x.oiUsd)).map(x=>[x.venue,Number(x.oiUsd)]));
  const raw={oi_usd:sumOrNull(Object.values(oiByVenue)),oi_by_venue:oiByVenue,premium_bps:getM(metrics,"us_spot_premium")?.value_num,stable_supply:last(series(data("stablecoins")||[]))?.v,etf_20d:getM(metrics,"etf_20d")?.value_num};
  history.push({t:iso(NOW),strategic:scores.strategic,tactical:scores.tactical,price,phase:phase(regime.strategic,regime.tactical),regime,raw});
  const behavior=behaviors(regime.strategic,regime.tactical);
  return{
    schema:2,version:VERSION,generated_at:iso(NOW),mock:MOCK,thesis:THESIS,price,price_observed_at:validObservationAge(datasets.spot,6*HOUR)?obs("spot"):obs("market"),
    verdict:`${STRATEGIC_TEXT[regime.strategic]} · ${TACTICAL_TEXT[regime.tactical]}`,
    regime,regime_meta:{strategic:stableS,tactical:stableT},phase:phase(regime.strategic,regime.tactical),override:hardOverride,behavior,scores,blocks,metrics,detectors,factors,
    sources:sourceStates,history,datasets,
    methodology:{
      indicator_scale:"−2…+2; числовые баллы вторичны относительно гейтов",
      dynamic_metrics:"MVRV, ETF rolling flows, rate volatility and network activity use rolling percentiles or relative changes",
      mechanical_metrics:"stablecoin peg, funding, basis, spreads and price-to-moving-average relations use economic/mechanical thresholds",
      regime_logic:"strategic = Macro × Demand × Cycle; tactical = Leverage × Fast demand × Market integrity",
      hysteresis:"ordinary transition requires two consecutive snapshots; hard override is immediate",
      exclusions:["STH/LTH cost basis and SOPR","NUPL and labelled cohort metrics","liquidation heatmaps and aggregated liquidations","dealer GEX and max pain","cross-exchange CVD and order-book microstructure","social sentiment, app rankings and Google Trends","corporate and sovereign labelled wallets","seasonality, Fibonacci, CME gaps and halving-cycle timing"],
      strategic_weights:Object.fromEntries(Object.entries(BLOCKS).map(([k,v])=>[k,v.strategicWeight])),
      tactical_weights:Object.fromEntries(Object.entries(BLOCKS).map(([k,v])=>[k,v.tacticalWeight])),
    }
  };
}

export { quoteDispersion, quoteGroupPrices, convertDailyUsdFlowsToBtc, estimatedSupply, normalizeToContract, crossCheck, SERIES_CONTRACT, validateMarket, parseCoinbaseCandles, parseBitstampOhlc, parseMempoolHashrate, parseFredCsv, parseBlockchainChart, validateBlockchainOnchainData, fetchBlockchainChart, fetchBlockchainOnchain, fetchFredSeries, fetchMarket, fetchNetwork, parseFred, parseFarside, parseFlowNumber, validateEtfSeries, retryAfterMs, priorByDays, rollingMean, percentileRank, normalizeCoinMetricsRows, validateCoinMetricsData, normalizeStableHistory, observationAge, validObservationAge, roundSym, percentChangeCommonVenues, referencePrice, fetchCftc, fetchDerivatives, fetchSpot, fetchPegs, classifyIntegrity };

function atomicJson(path,value){
  mkdirSync(path.split("/").slice(0,-1).join("/")||".",{recursive:true});
  const temp=`${path}.tmp-${process.pid}`;
  writeFileSync(temp,JSON.stringify(value));
  renameSync(temp,path);
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  await collect();
  const snapshot=compute();
  const publicSnapshot={...snapshot,history:(snapshot.history||[]).map(({raw,...h})=>h)};
  delete publicSnapshot.datasets;
  atomicJson(STATE,snapshot);
  atomicJson(OUT,publicSnapshot);
  console.log(JSON.stringify({out:OUT,state:STATE,version:VERSION,mock:MOCK,verdict:snapshot.verdict,metrics:snapshot.metrics.length,sources:Object.values(sourceStates).reduce((a,x)=>(a[x.state]=(a[x.state]||0)+1,a),{})},null,2));
}
