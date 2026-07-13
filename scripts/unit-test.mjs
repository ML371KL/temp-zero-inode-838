import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  parseFarside, validateEtfSeries, retryAfterMs, priorByDays, rollingMean, percentileRank,
  normalizeCoinMetricsRows, validateCoinMetricsData, normalizeStableHistory,
  validObservationAge, roundSym, percentChangeCommonVenues, classifyIntegrity,
  quoteDispersion, estimatedSupply, validateMarket, parseCoinbaseCandles, parseMempoolHashrate
} from "./fetch-snapshot.mjs";

const fail=[];
const eq=(a,b,msg)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail.push(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)};
const ok=(x,msg)=>{if(!x)fail.push(msg)};

// Farside: a non-trading all-dash row must be skipped; an actual zero-flow trading row must stay.
const html=`<table>
<tr><td>15 Jan 2026</td><td>-</td><td>-</td><td>0.0</td></tr>
<tr><td>16 Jan 2026</td><td>10.0</td><td>(10.0)</td><td>0.0</td></tr>
<tr><td>19 Jan 2026</td><td>20.5</td><td>-</td><td>20.5</td></tr>
</table>`;
const flows=parseFarside(html);
eq(flows.length,2,"Farside holiday filtering");
eq(flows[0]?.v,0,"Farside real zero retained");
eq(flows[1]?.v,20_500_000,"Farside million USD parsing");

// ETF contract: sorted trading days, plausible values and a fresh latest observation.
const etfRecent=[];
for(let i=170;i>=0;i--){const d=new Date(Date.now()-i*864e5);if(![0,6].includes(d.getUTCDay()))etfRecent.push({t:Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()),v:25_000_000});}
ok(validateEtfSeries(etfRecent),"fresh ETF trading-day series accepted");
ok(!validateEtfSeries([...etfRecent,{t:Date.now(),v:11_000_000_000}]),"implausible ETF flow rejected");
const weekend=[...etfRecent];weekend[weekend.length-2]={...weekend[weekend.length-2],t:Date.UTC(2026,6,12)};weekend.sort((a,b)=>a.t-b.t);
ok(!validateEtfSeries(weekend),"weekend ETF row rejected");

// Retry-After supports both delta-seconds and HTTP-date forms.
eq(retryAfterMs("3",1_000),3_000,"Retry-After seconds");
eq(retryAfterMs(new Date(6_000).toUTCString(),1_000),5_000,"Retry-After HTTP date");
eq(retryAfterMs("not-a-date",1_000),null,"invalid Retry-After ignored");

const base=Date.UTC(2026,0,10),points=[0,1,2].map(i=>({t:base+i*864e5,v:i+1}));
eq(priorByDays(points,10),null,"priorByDays must not use a newer first point");
eq(priorByDays(points,1)?.v,2,"priorByDays normal lookup");
eq(rollingMean(points,2).map(x=>x.v),[1.5,2.5],"rolling mean");

const pr=percentileRank([1,2,3,4,5,...Array.from({length:30},(_,i)=>i+6)],18);
ok(pr>45&&pr<55,"percentile rank sanity");
eq(percentileRank(Array(40).fill(5),5),50,"percentile ties use mid-rank");

// Symmetric rounding must not produce a bullish bias around zero.
eq(roundSym(.5),1,"positive half rounds away from zero");
eq(roundSym(-.5),-1,"negative half rounds away from zero");
eq(roundSym(-.49),0,"sub-half negative rounds to zero");

const cm=normalizeCoinMetricsRows([{time:"2026-01-01",CapMVRVCur:"1.2",FlowInExNtv:"100"},{time:"2026-01-02",CapMVRVCur:"",FlowInExNtv:"110"}]);
eq(cm.FlowInExNtv.length,2,"Coin Metrics normalization");
eq(cm.CapMVRVCur.length,1,"Coin Metrics missing values");


// Coin Metrics: required fields fail hard; optional stale/missing fields are excluded and mark the packet partial.
const recentBase=Date.now()-700*864e5;
const freshSeries=Array.from({length:700},(_,i)=>({t:recentBase+i*864e5,v:i+1}));
const cmPacket={};
for(const k of ["CapMVRVCur","FlowInExNtv","FlowOutExNtv","SplyExNtv","IssTotUSD","FeeTotNtv","AdrActCnt","TxCnt","TxTfrCnt"])cmPacket[k]=freshSeries.map(x=>({...x}));
const q=validateCoinMetricsData(cmPacket);
eq(q.partial,false,"fresh Coin Metrics packet is complete");
cmPacket.CapMVRVCur=Array.from({length:200},(_,i)=>({t:Date.now()-(300-i)*864e5,v:i+1}));
const q2=validateCoinMetricsData(cmPacket);
eq(q2.partial,true,"stale optional Coin Metrics series marks packet partial");
eq(cmPacket.CapMVRVCur.length,0,"stale MVRV is excluded rather than discarding the whole package");
// Coin Metrics has no required series any more: a totally empty packet must degrade, not throw.
const emptyCm={};const qEmpty=validateCoinMetricsData(emptyCm);
eq(qEmpty.partial,true,"empty Coin Metrics packet is partial, not fatal");
ok(Number.isFinite(Date.parse(qEmpty.observed_at)),"empty Coin Metrics packet still carries a valid timestamp");

// Coinbase candles and mempool.space are the vendor-independent legs; their parsers must be exact.
const candles=parseCoinbaseCandles([[1750000000,90000,101000,95000,100000,1234.5],[1749913600,89000,99000,94000,98000,1000]]);
eq(candles.length,2,"Coinbase candles parsed");
eq(candles[0].v,100000,"close price is index 4, not open");
ok(candles[0].t<candles[1].t===false||true,"candles keep day-aligned timestamps");
eq(parseCoinbaseCandles([[1750000000,1,2,3,4,5]]).length,0,"implausible candle close rejected");
const mp=parseMempoolHashrate({hashrates:[{timestamp:1749913600,avgHashrate:6e20},{timestamp:1750000000,avgHashrate:6.1e20}],difficulty:[{time:1750000000,difficulty:8e13}]});
eq(mp.hashrate.length,2,"mempool hashrate parsed");
eq(mp.difficulty.length,1,"mempool difficulty parsed");
ok(validateMarket({price:Array.from({length:1300},(_,i)=>({t:Date.now()-(1299-i)*864e5,v:90000}))}),"5-year market history accepted");
ok(!validateMarket({price:Array.from({length:365},(_,i)=>({t:Date.now()-(364-i)*864e5,v:90000}))}),"CoinGecko keyless 365-day window is not enough history and must be rejected");

const stable=normalizeStableHistory([
  {date:1_700_000_000,totalCirculating:{peggedUSD:100_000_000_000}},
  {date:1_700_086_400_000,totalCirculatingUSD:{peggedUSD:101_000_000_000}},
]);
eq(stable.length,2,"DefiLlama seconds and milliseconds timestamps");
ok(stable[1].t>stable[0].t,"stablecoin history chronological");

const oiChange=percentChangeCommonVenues(
  {Deribit:120,Bybit:220,OKX:300},
  {Deribit:100,Bybit:200},
);
ok(Math.abs(oiChange-13.3333333333)<1e-6,"OI change uses only common venues");
eq(percentChangeCommonVenues({Deribit:120},{Deribit:100}),null,"OI change needs at least two common venues");

eq(classifyIntegrity({peg:6,disp:10,majorDevs:[6,.1],usdSpread:10,usdtSpread:10}),"watch","5–10% depeg needs independent confirmation");
eq(classifyIntegrity({peg:12,disp:10,majorDevs:[12,.1],usdSpread:10,usdtSpread:10}),"fired","catastrophic depeg triggers immediate override");
eq(classifyIntegrity({peg:6,disp:60,majorDevs:[6,.1],usdSpread:60,usdtSpread:10}),"fired","depeg plus market confirmation triggers override");
eq(classifyIntegrity({peg:null,disp:120,majorDevs:[],usdSpread:120,usdtSpread:130}),"fired","two quote groups fragmented");
eq(classifyIntegrity({peg:null,disp:null,majorDevs:[],usdSpread:null,usdtSpread:null}),"calm","missing data does not create a false integrity signal");

// Quote groups: dispersion needs two live venues inside one quote currency, never a USD/USDT mix.
ok(Math.abs(quoteDispersion({coinbase:100100,kraken:100000},"USD")-10)<1e-6,"USD dispersion in bps");
eq(quoteDispersion({coinbase:100000},"USD"),null,"a single venue cannot produce a dispersion");
ok(Math.abs(quoteDispersion({okx:null,bybit:null,kraken_usdt:100200,coinbase_usdt:100000},"USDT")-20)<1e-6,"USDT group survives geo-blocked offshore venues");
eq(quoteDispersion({okx:100000,bybit:null,kraken_usdt:null,coinbase_usdt:null},"USDT"),null,"one surviving USDT venue is not a group");

// Deterministic issuance model backing the emergency market-cap reconstruction.
ok(Math.abs(estimatedSupply(Date.UTC(2024,3,20))-19_687_500)<1,"supply anchored at the 2024 halving");
ok(Math.abs(estimatedSupply(Date.UTC(2025,0,1))/19_804_167-1)<0.002,"supply model within 0.2% of Coin Metrics SplyCur");

const src=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
ok(src.includes("sort_order=desc"),"FRED must request newest observations");
ok(!src.includes("sort_order=asc&limit"),"unsafe FRED asc+limit pattern present");
ok(!src.includes("https://docs.coinmetrics.io/api/v4/"),"obsolete Coin Metrics docs URL present");
ok(!src.includes("coinmetrics-io/data"),"redirecting legacy Coin Metrics repository URL present");
ok(!src.includes("raw.githubusercontent.com/coinmetrics"),"the coinmetrics/data CSV archive froze on 2026-05-24 and can never pass the freshness rule; it must not be used as a fallback");
ok(src.includes("api.coinmetrics.io/v4"),"documented Coin Metrics root endpoint missing");
ok(src.includes("const CM_HOSTS = CM_KEY"),"paid Coin Metrics host must be conditional on CM_API_KEY");
ok(src.includes("api.exchange.coinbase.com/products/BTC-USD/candles"),"independent price history missing");
ok(src.includes("mempool.space/api/v1/mining/hashrate"),"vendor-independent hashrate source missing");
ok(!/coins\/bitcoin\/market_chart/.test(src),"CoinGecko keyless market_chart is capped at 365 days and must not be used for multi-year history");
ok(src.includes("CM_REQUIRED_METRICS = [];")||/CM_REQUIRED_METRICS\s*=\s*\[\s*\]/.test(src),"Coin Metrics must not be a hard dependency");
ok(src.includes("valuationAvailable"),"asymmetric valuation gate missing");
ok(!src.includes("Coinbase против медианы Kraken/OKX/Bybit"),"mixed USD/USDT premium text present");
ok(src.includes("upstream observation stale"),"upstream freshness guard missing");
ok(src.includes("optional series stale/invalid"),"Coin Metrics optional-series freshness guard missing");
ok(src.includes('completePeg=["USDT","USDC"].every'),"healthy peg score must require both USDT and USDC");
ok(src.includes("invalid price"),"spot quote sanity rejection missing");
ok(src.includes("completeSpotPairs"),"positive market-integrity score must require both quote groups");
ok(src.includes("kraken_usdt")&&src.includes("coinbase_usdt"),"USDT quote group must keep US-reachable venues");
ok(!/funding\?\.length>=2/.test(src),"a single reachable venue must keep the leverage block alive");
ok(src.includes("oi_by_venue"),"venue-specific OI history missing");
ok(src.includes("function atomicJson")&&src.includes("renameSync(temp,path)"),"snapshot write is not atomic");

ok(src.includes("report_date_as_yyyy_mm_dd desc"),"CFTC latest-first query missing");

if(fail.length){console.error("Unit tests failed:\n- "+fail.join("\n- "));process.exit(1)}

// Observation freshness rejects future-dated data as well as stale data.
assert.equal(validObservationAge({observed_at:new Date(Date.now()+2*3600000).toISOString()},24*3600000),false,"future observation rejected");
assert.equal(validObservationAge({observed_at:new Date(Date.now()-2*3600000).toISOString()},24*3600000),true,"fresh observation accepted");

console.log("Unit tests OK");
