import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  parseFarside, validateEtfSeries, retryAfterMs, priorByDays, rollingMean, percentileRank,
  normalizeCoinMetricsRows, validateCoinMetricsData, normalizeStableHistory,
  validObservationAge, percentChangeCommonVenues, classifyIntegrity, FRED_SERIES, ETF_BLOCK_MIRRORS, componentScore,
  quoteDispersion, convertDailyUsdFlowsToBtc, estimatedSupply, normalizeToContract, crossCheck, SERIES_CONTRACT, validateMarket, parseCoinbaseCandles, parseBitstampOhlc, parseMempoolHashrate, parseFredCsv, request
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
// Permanent 4xx errors must fail immediately instead of multiplying latency and rate-limit pressure.
const originalFetch=globalThis.fetch;let permanentCalls=0;
try{
  globalThis.fetch=async()=>{permanentCalls++;return new Response("not found",{status:404});};
  await assert.rejects(()=>request("https://example.invalid/permanent",{tries:3}),/HTTP 404/);
  eq(permanentCalls,1,"non-retryable 4xx requested once");
}finally{globalThis.fetch=originalFetch;}
eq(retryAfterMs("not-a-date",1_000),null,"invalid Retry-After ignored");

const base=Date.UTC(2026,0,10),points=[0,1,2].map(i=>({t:base+i*864e5,v:i+1}));
eq(priorByDays(points,10),null,"priorByDays must not use a newer first point");
eq(priorByDays(points,1)?.v,2,"priorByDays normal lookup");
eq(rollingMean(points,2).map(x=>x.v),[1.5,2.5],"rolling mean");
const converted=convertDailyUsdFlowsToBtc([{t:base,v:100},{t:base+864e5,v:100}],[{t:base,v:10},{t:base+864e5,v:20}]);eq(converted.map(x=>x.v),[10,5],"ETF USD flows converted at each day's price before rolling sum");

const pr=percentileRank([1,2,3,4,5,...Array.from({length:30},(_,i)=>i+6)],18);
ok(pr>45&&pr<55,"percentile rank sanity");
eq(percentileRank(Array(40).fill(5),5),50,"percentile ties use mid-rank");


// Canonical-unit contracts: equivalent providers must land in the same unit and impossible values are rejected.
const DAY=864e5,NOW=Date.now(),ser=(n,v)=>Array.from({length:n},(_,i)=>({t:NOW-(n-1-i)*DAY,v}));
eq(normalizeToContract("hashrate",ser(400,7e20)).scale,1,"mempool H/s stays unchanged");
eq(normalizeToContract("hashrate",ser(400,7e8)).scale,1e12,"Blockchain/Coin Metrics TH/s converts to H/s");
eq(normalizeToContract("mvrv",ser(500,1.4)).scale,1,"MVRV ratio stays dimensionless");
let rejected=false;try{normalizeToContract("mvrv",ser(500,140))}catch{rejected=true}ok(rejected,"MVRV percentage must be rejected, not guessed");
rejected=false;try{normalizeToContract("price",ser(500,95))}catch{rejected=true}ok(rejected,"price quoted in thousands must be rejected");
ok(Object.values(SERIES_CONTRACT).every(x=>x.unit&&x.lo<x.hi&&x.scales.length),"every series contract declares unit and band");
eq(crossCheck("price",100000,100300,.01),null,"close providers pass cross-check tolerance");
ok(crossCheck("price",100000,120000,.01)?.includes("differ"),"large provider disagreement is surfaced");
const bs=parseBitstampOhlc({data:{ohlc:[{timestamp:"1750000000",close:"100000",volume:"1234"}]}});eq(bs[0]?.v,100000,"Bitstamp OHLC close parsed");eq(bs[0]?.volume,1234,"Bitstamp OHLC base volume parsed");

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
// Coinbase returns newest-first; ordering is normalized upstream (fetchCoinbaseHistory). The
// parser contract is DAY-ALIGNMENT: every timestamp lands exactly on a UTC midnight.
ok(candles.every(c=>c.t%864e5===0),"candles are aligned to UTC midnights");
eq(parseCoinbaseCandles([[1750000000,1,2,3,4,5]]).length,0,"implausible candle close rejected");
const mp=parseMempoolHashrate({hashrates:[{timestamp:1749913600,avgHashrate:6e20},{timestamp:1750000000,avgHashrate:6.1e20}],difficulty:[{time:1750000000,difficulty:8e13}]});
eq(mp.hashrate.length,2,"mempool hashrate parsed");
eq(mp.difficulty.length,1,"mempool difficulty parsed");
ok(validateMarket({price:Array.from({length:1300},(_,i)=>({t:Date.now()-(1299-i)*864e5,v:90000}))}),"5-year market history accepted");
ok(!validateMarket({price:Array.from({length:365},(_,i)=>({t:Date.now()-(364-i)*864e5,v:90000}))}),"CoinGecko keyless 365-day window is not enough history and must be rejected");

// FRED keyless CSV parser. The live keyless endpoint (fredgraph.csv?id=…) returns the header
// "observation_date,<SERIES>"; a name-based value lookup silently drops every row against it, which
// would collapse the whole macro layer while a stale "DATE,…" mock kept passing. Parse by position.
eq(parseFredCsv("observation_date,WALCL\n2026-01-02,7000000").length,1,"live `observation_date` header parsed");
eq(parseFredCsv("observation_date,WALCL\n2026-01-02,7000000")[0].v,7000000,"value column read by position, not by name");
eq(parseFredCsv("DATE,WALCL\n2026-01-02,7000000").length,1,"legacy `DATE` header still parsed");
eq(parseFredCsv("observation_date,DGS10\n2026-01-02,.").length,0,"FRED writes `.` for a missing value; it must be dropped");
eq(parseFredCsv("observation_date,DGS10\n2026-01-02,").length,0,"blank FRED cells must not become numeric zero");
eq(parseFredCsv("observation_date,X\n2026-01-03,2\n2026-01-02,1").map(r=>r.v),[1,2],"CSV sorted ascending by date");
let fredCsvThrew=false;try{parseFredCsv("garbage")}catch{fredCsvThrew=true}
ok(fredCsvThrew,"a malformed FRED CSV must throw, not silently return an empty series");

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
// The issuance epoch must step down at the (estimated) 2028 halving instead of drifting at 2x.
{const d0=estimatedSupply(Date.UTC(2028,3,18))-estimatedSupply(Date.UTC(2028,3,17));ok(Math.abs(d0-225)<1,"post-2028 issuance is 225 BTC/day");}
{const d1=estimatedSupply(Date.UTC(2027,0,2))-estimatedSupply(Date.UTC(2027,0,1));ok(Math.abs(d1-450)<1,"pre-2028 issuance is 450 BTC/day");}

const src=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
const selfSrc=readFileSync(new URL("./self-test.mjs",import.meta.url),"utf8");
ok(src.includes("sort_order=desc"),"FRED must request newest observations");
ok(!src.includes("sort_order=asc&limit"),"unsafe FRED asc+limit pattern present");
ok(!src.includes("https://docs.coinmetrics.io/api/v4/"),"obsolete Coin Metrics docs URL present");
ok(!src.includes("coinmetrics-io/data"),"redirecting legacy Coin Metrics repository URL present");
ok(!src.includes("raw.githubusercontent.com/coinmetrics"),"the coinmetrics/data CSV archive froze on 2026-05-24 and can never pass the freshness rule; it must not be used as a fallback");
ok(src.includes("api.coinmetrics.io/v4"),"documented Coin Metrics root endpoint missing");
ok(!src.includes('sort:"time"'),"unnecessary Coin Metrics time-sort increases query cost for a single asset");
ok(src.includes("const CM_HOSTS = CM_KEY"),"paid Coin Metrics host must be conditional on CM_API_KEY");
ok(src.includes("api.exchange.coinbase.com/products/BTC-USD/candles"),"independent price history missing");
ok(src.includes("get-product-candles"),"Coinbase history must link to candle documentation");
// The UA must be derived from VERSION, not a hand-updated literal that silently goes stale.
ok(src.includes('User-Agent":"btc-21m-dashboard/"+VERSION'),"collector User-Agent must derive from VERSION");
ok(!/btc-21m-dashboard\/\d/.test(src),"no hardcoded UA version literal");
ok(src.includes("nonRetryable"),"permanent 4xx retry guard missing");
ok(src.includes("Fast demand × Market integrity × Realized volatility"),"methodology text does not match tactical gate");
ok(src.includes("mempool.space/api/v1/mining/hashrate"),"vendor-independent hashrate source missing");
ok(src.includes("fetchBlockchainChart(\"hash-rate\""),"hashrate fallback missing");
ok(src.includes("fredgraph.csv"),"official FRED CSV fallback missing");
ok(src.includes("blockstream.info/api/fee-estimates"),"fee fallback missing");
ok(src.includes("futures.kraken.com/derivatives/api/v3/tickers/PI_XBTUSD"),"Kraken Futures fallback missing");
ok(src.includes("contractType=futures_inverse"),"Kraken dated-futures basis fallback missing");
ok(src.includes("api.gemini.com/v1/pubticker/BTCUSD"),"Gemini USD quote missing");
ok(selfSrc.includes('["coingecko","blockchain","window"]'),"self-test must accept declared Blockchain ATH fallback");
ok(selfSrc.includes('["coinbase","kraken","bitstamp","gemini"]'),"self-test headline USD median must include Gemini");
ok(src.includes('obs("market")'),"price timestamp must fall back to market dataset, not Coin Metrics");
ok(src.includes('quoteGroupPrices(s,"USD").length>=2'),"reference price must require two USD venues");
ok(!src.includes('for(const group of ["USD","USDT"])'),"USDT quotes must never be treated as USD/BTC reference price");
ok(src.includes('referencePriceUsesSpot()?obs("spot"):obs("market")'),"price timestamp must follow the actual USD reference source");
ok(!/coins\/bitcoin\/market_chart/.test(src),"CoinGecko keyless market_chart is capped at 365 days and must not be used for multi-year history");
ok(src.includes("CM_REQUIRED_METRICS = [];")||/CM_REQUIRED_METRICS\s*=\s*\[\s*\]/.test(src),"Coin Metrics must not be a hard dependency");
ok(src.includes("valuationAvailable"),"asymmetric valuation gate missing");
ok(src.includes('activityCm=cmAddr.length>=180&&cmTx.length>=180'),"activity address/transaction bundle must use one provider");
ok(src.includes('minerCm=iss.length>=180&&feeN.length>=180'),"Coin Metrics miner path must require issuance and fee series");
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


// ---- Политика свежести: календарь публикации ↔ порог ↔ гейт публикации ----
// Баг v2.8.4: DTWEXBGS (дневные точки, НЕДЕЛЬНЫЙ пакет H.10) стоял с дневным порогом 7 дней и
// краснел 57% времени. Обе таблицы при этом согласовывались друг с другом — поэтому проверять надо
// не только их совпадение, но и связь порога с реальным календарём публикации.
const DAY_H=24;
for(const [id,cfg] of Object.entries(FRED_SERIES)){
  ok(["daily","weekly-batch"].includes(cfg.release),`FRED ${id}: не объявлен календарь публикации (release)`);
  const ttlH=cfg.ttl/36e5;
  if(cfg.release==="daily")ok(ttlH<=7*DAY_H,`FRED ${id}: дневной релиз, порог ${ttlH/24}д — должен быть ≤7д`);
  // weekly-batch: последняя точка штатно доживает до 11д20ч (праздничный перенос) → нужен ≥12д,
  // но не более 21д, иначе тихо замёрзший ряд будет считаться валидным больше трёх недель.
  if(cfg.release==="weekly-batch")ok(ttlH>=12*DAY_H&&ttlH<=21*DAY_H,`FRED ${id}: недельный пакет, порог ${ttlH/24}д — должен быть 12–21д`);
}
// Пороги коллектора и гейта публикации обязаны совпадать по ВСЕМ источникам.
{
  const st=readFileSync(new URL("./self-test.mjs",import.meta.url),"utf8");
  const src=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
  const toH=(n,u)=>Number(n)*(u==="DAY"?24:1);
  const coll={};
  for(const [id,cfg] of Object.entries(FRED_SERIES))coll["fred_"+id]=cfg.ttl/36e5;
  const re=/loadDataset\("(\w+)","[^"]+",\s*([\d.]+)\s*\*\s*(DAY|HOUR)/g;let m;
  while((m=re.exec(src))){
    const tail=src.slice(m.index,m.index+600),mo=tail.match(/maxObservedAge:\s*([\d.]+)\s*\*\s*(DAY|HOUR)/);
    coll[m[1]]=mo?toH(mo[1],mo[2]):toH(m[2],m[3]);
  }
  const block=st.match(/const sourceMaxAgeH=\{([\s\S]*?)\n\};/)[1],gate={};
  for(const g of block.matchAll(/(\w+):\s*(\d+)\s*\*\s*(\d+)/g))gate[g[1]]=Number(g[2])*Number(g[3]);
  for(const g of block.matchAll(/(\w+):\s*(\d+)(?!\s*\*)/g))if(!(g[1] in gate))gate[g[1]]=Number(g[2]);
  ok(Object.keys(coll).length>=20,`матрица порогов не разобрана: ${Object.keys(coll).length} источников`);
  for(const [k,c] of Object.entries(coll)){
    ok(gate[k]!==undefined,`источник ${k} есть в коллекторе, но не в sourceMaxAgeH — проверка возраста не сработает`);
    if(gate[k]!==undefined)ok(c<=gate[k],`РАССИНХРОН ${k}: коллектор ${c}ч > гейт ${gate[k]}ч → кандидат будет отвергнут, сайт замрёт`);
  }
}
// ---- Неполная семья предупреждает, но не поддерживает ----
eq(componentScore([2,0]),1,"полная семья считается как прежде");
eq(componentScore([2,null]),0,"1 из 2 ног: положительный голос срезается до 0");
eq(componentScore([-2,null]),-2,"предупреждение неполной семьи сохраняется полностью");
eq(componentScore([2,null,0]),1,"2 из 3 ног — потеряна не половина, кэпа нет");
eq(componentScore([2,null,null]),0,"1 из 3 ног: положительный голос срезается");
eq(componentScore([-1,null,null]),-1,"1 из 3 ног: предупреждение проходит");
eq(componentScore([null,null]),null,"нет ни одной ноги — нет голоса, а не 0");
eq(componentScore([2,2]),2,"полная семья: максимум достижим");

// ---- ETF: выбор свежайшего зеркала одного провайдера ----
// Оба эндпоинта обязаны принадлежать The Block: сравнение свежести законно только внутри одного
// провайдера, иначе это скрытое сшивание рядов (запрещено правилом канонических единиц).
ok(ETF_BLOCK_MIRRORS.length===2,"зеркал The Block должно быть ровно два");
ok(ETF_BLOCK_MIRRORS.every(m=>/theblock\.co|tbstat\.com/.test(m.url)),"в списке зеркал The Block оказался чужой провайдер");
ok(ETF_BLOCK_MIRRORS[0].url.includes("theblock.co"),"канонический chart-API должен быть первым (тай-брейк при равной свежести)");
{
  const src=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
  const fn=src.slice(src.indexOf("async function fetchEtfFlows"),src.indexOf("function parseCsv"));
  ok(/validateEtfSeries\(series\)/.test(fn),"кандидат обязан проходить ETF-контракт ДО сравнения свежести");
  ok(/b\.latest>a\.latest/.test(fn),"пропал выбор по максимальной свежести");
  ok(fn.indexOf("farside.co.uk")>fn.indexOf("candidates.length"),"Farside обязан оставаться последним резервом, а не участником сравнения");
  ok(/зеркала The Block разошлись/.test(fn),"пропала сверка зеркал на пересечении: испорченная свежая копия попала бы в публикацию");
}

// Разведка SosoValue (шаг 1) обязана оставаться ВНЕ сборщика снимка: пока интеграция не принята,
// коллектор не должен ни читать ключ, ни ходить в этот API.
{
  const collector=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
  ok(!/SOSO_API_KEY|sosovalue/i.test(collector),"сборщик снимка не должен знать о SosoValue до принятия интеграции");
}

if(fail.length){console.error("Unit tests failed:\n- "+fail.join("\n- "));process.exit(1)}

// Observation freshness rejects future-dated data as well as stale data.
assert.equal(validObservationAge({observed_at:new Date(Date.now()+2*3600000).toISOString()},24*3600000),false,"future observation rejected");
assert.equal(validObservationAge({observed_at:new Date(Date.now()-2*3600000).toISOString()},24*3600000),true,"fresh observation accepted");

console.log("Unit tests OK");
