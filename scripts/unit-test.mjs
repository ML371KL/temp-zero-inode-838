import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  parseFarside, validateEtfSeries, retryAfterMs, priorByDays, rollingMean, percentileRank,
  normalizeCoinMetricsRows, validateCoinMetricsData, normalizeStableHistory,
  validObservationAge, percentChangeCommonVenues, classifyIntegrity, FRED_SERIES, ETF_BLOCK_MIRRORS, spliceFreshEtfDays, fetchSosoEtfDaily, etfDegradation, cachedEtfCanon, reviveSplicedDays, plausibleHistoryRecord, stabilizeCore, severity, componentScore,
  quoteDispersion, convertDailyUsdFlowsToBtc, estimatedSupply, normalizeToContract, crossCheck, SERIES_CONTRACT, validateMarket, parseCoinbaseCandles, parseBitstampOhlc, parseMempoolHashrate, parseFredCsv, request,
  closedDaysOnly, krakenDatedBasis, oiPurgeWindow,
  updateCanonRegistry, carryCanonDays, ETF_CANON_HOLD_TTL, ETF_CANON_HOLD_MAX_DAYS, ETF_CANON_REGISTRY_TTL, ETF_LEG_NAMES, parseEtfFlowJson,
  exchangeFlowSupplyCheck, exchangeFlowSupplyWarning, CM_FLOW_SUPPLY_TOLERANCE_BTC,
  buildRegimeBirthV1, buildTickDiffV1, buildValuationLevelsV1, mvrvLevelAt, buildDataWarningsV1, annotateEtfLegOutagesV1, ETF_REDUNDANCY_CONFIRM_MS, buildVariantInputsV1, VALUATION_LEVELS
} from "./fetch-snapshot.mjs";
import { boundedPublicHistoryV1, compactHistoryEntryV1, publicHistoryEntryV1, HISTORY_MAX_ROWS, jsonBytesV1, projectedPublicSnapshotBytesV1, PUBLIC_SNAPSHOT_MAX_BYTES,
  optionalFieldProblemsV1, optionalSnapshotProblemsV1, optionalSnapshotBytesV1, OPTIONAL_FIELD_MAX_BYTES } from "./public-snapshot-contract.mjs";

const fail=[];
const eq=(a,b,msg)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail.push(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)};
const ok=(x,msg)=>{if(!x)fail.push(msg)};

// Накопленный ряд OI обязан переживать смену машины.
//
// Это регрессия на потерю 7 августа: `oi_by_venue` — единственный ряд, который проект
// копит сам, а не перекачивает у провайдера, и он публиковался вырезанным. Жил он в
// .state/cache.json, который в .gitignore и между прогонами ехал кэшем Actions; переезд
// сбора на другую машину стёр семидневную базу и выбил голосующую карточку oi_quality.
// Проверяется поэтому не «функция что-то возвращает», а ровно то свойство, которого не
// хватило: опубликованного снимка ДОСТАТОЧНО, чтобы поднять ряд с нуля.
{
  const cut = Date.parse("2026-08-01T00:00:00.000Z");
  const byVenue = { Deribit: 723376140, OKX: 1952221508 };
  const fresh = { t:"2026-08-05T11:00:00.000Z", strategic:10, tactical:5, price:70000,
    raw:{ oi_usd:2675597648, oi_by_venue:byVenue, premium_bps:3, stable_supply:1e11, etf_20d:5e8 } };
  const old_  = { ...fresh, t:"2026-07-20T11:00:00.000Z" };

  const pubFresh = publicHistoryEntryV1(fresh, { hourlyCut: cut });
  // Первой — самая грубая проверка: OI вообще доехал. Без неё вырезанный raw роняет
  // прогон на `in` вместо того, чтобы назвать причину.
  ok(pubFresh.raw?.oi_by_venue, "OI не опубликован — накопленный ряд снова не переживёт смену машины");
  eq(pubFresh.raw, { oi_by_venue: byVenue }, "публикуется только oi_by_venue, остальное из raw режется");
  eq(pubFresh.price, 70000, "остальные поля строки не трогаются");
  ok(!("oi_usd" in (pubFresh.raw || {})), "внутренние входы не утекают в публикацию");

  // За почасовым окном строки прорежены до одной в сутки, и базы из них не считаются.
  ok(!("raw" in publicHistoryEntryV1(old_, { hourlyCut: cut })), "вне почасового окна OI не публикуется");
  ok("oi_by_venue" in fresh.raw, "публикация не мутирует вход");
  ok(!("raw" in publicHistoryEntryV1({ t:fresh.t, price:1 }, { hourlyCut: cut })), "строка без raw остаётся без него");

  // Учёт байтов и публикация — одна и та же форма. Разъедутся — бюджет начнёт считать не то,
  // что уезжает в файл, и жёсткий кап снова упрётся в дедлок публикации (падения 21.07).
  //
  // Проверка построена так, чтобы РАЗЪЕЗД был единственным способом её пройти: бюджет
  // выставлен ровно в размер строк БЕЗ OI. Учёт по публикуемой форме обязан увидеть
  // перебор и выбросить строки; учёт по урезанной форме решит, что всё влезло.
  const rows = [1, 2, 3, 4].map(i => ({ ...fresh, t: `2026-08-0${i}T11:00:00.000Z` }));
  const strippedTotal = rows.reduce((a, r) => a + jsonBytesV1((({ raw, ...p }) => p)(r)) + 1, 1);
  const publishedTotal = rows.reduce((a, r) => a + jsonBytesV1(publicHistoryEntryV1(r, { hourlyCut: cut })) + 1, 1);
  ok(publishedTotal > strippedTotal, "публикуемая строка обязана быть тяжелее урезанной — иначе проверка пуста");
  const tight = boundedPublicHistoryV1(rows, { budget: strippedTotal, minRows: 1, hourlyCut: cut });
  ok(tight.trimmed > 0, "бюджет считает не публикуемую форму: перебор не замечен");
  const roomy = boundedPublicHistoryV1(rows, { budget: publishedTotal, minRows: 1, hourlyCut: cut });
  eq(roomy.trimmed, 0, "при бюджете ровно в публикуемый размер выбрасывать нечего");
}

// Public history is a compact explanatory view. Immutable policy metadata belongs at the
// snapshot root, while the exact forward hash chain belongs in monitoring.decision_log.
{
  const legacy={t:"2026-07-21T00:00:00.000Z",decision:{policy_id:"btc-allocation-policy-v1",policy_hash:"policy",regime_targets_pct:{defensive:5},state_hash:"state",decision_hash:"decision",status:"actionable",base_target_pct:20,target_pct:20,binding_overlays:[],quality:{status:"good"}},raw:{oi_usd:123}};
  const compact=compactHistoryEntryV1(legacy);
  ok(!("policy_id" in compact.decision),"history compaction removes repeated policy id");
  ok(!("policy_hash" in compact.decision),"history compaction removes repeated policy hash");
  ok(!("regime_targets_pct" in compact.decision),"history compaction removes repeated target ladder");
  eq(compact.decision.decision_hash,"decision","history compaction preserves decision hash");
  eq(compact.decision.target_pct,20,"history compaction preserves target");
  eq(compact.raw.oi_usd,123,"history compaction preserves internal market history");
  ok("policy_id" in legacy.decision,"history compaction does not mutate its input");

  const daily=[{x:"d".repeat(30)}],decision_log=[{x:"l".repeat(20)}],history=[compact];
  const projected=projectedPublicSnapshotBytesV1({snapshotBytes:1000,snapshot:{monitoring:{daily,decision_log},history},dailyLimit:3,decisionLogLimit:4,historyMaxRows:5});
  // Рост daily считается по ТОЧНОМУ размеру заполненного массива (элементы + запятые + скобки),
  // а не «строк осталось × размер строки»: прежняя оценка занижала стационар на разделителях.
  const dailyAtLimit=jsonBytesV1([daily[0],daily[0],daily[0]]);
  const expected=1000+(dailyAtLimit-jsonBytesV1(daily))+3*jsonBytesV1(decision_log[0])+4*jsonBytesV1(history[0]);
  eq(projected,expected,"max-filled retention projection");
  ok(HISTORY_MAX_ROWS===1066,"history retention row ceiling remains explicit");
  ok(PUBLIC_SNAPSHOT_MAX_BYTES===3_000_000,"public snapshot byte ceiling remains explicit");
}

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
// Выходной день берётся ОТНОСИТЕЛЬНО окна ряда: зашитая календарная дата выпадает из окна, как
// только настоящий календарь уходит вперёд, и проверка начинает мерить не то, что задумано.
const weekend=[...etfRecent];
const friday=weekend.findLastIndex(x=>new Date(x.t).getUTCDay()===5);
weekend[friday]={...weekend[friday],t:weekend[friday].t+864e5}; // пятница -> суббота, порядок сохраняется
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
ok(src.includes("futures.kraken.com/derivatives/api/v3/tickers/PF_XBTUSD"),"Kraken Futures: линейный бессрочный PF_XBTUSD пропал из сборщика");
ok(src.includes("contractType=flexible_futures"),"Kraken Futures: резервный basis обязан идти с линейных датированных контрактов");
ok(!/tickers\/PI_XBTUSD|contractType=futures_inverse/.test(src),"мёртвые инверсные контракты Kraken (PI/FI) не имеют права возвращаться в тракт");
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
  ok(["daily","weekly-batch","monthly-batch"].includes(cfg.release),`FRED ${id}: не объявлен календарь публикации (release)`);
  const ttlH=cfg.ttl/36e5;
  if(cfg.release==="daily")ok(ttlH<=7*DAY_H,`FRED ${id}: дневной релиз, порог ${ttlH/24}д — должен быть ≤7д`);
  // weekly-batch: последняя точка штатно доживает до 11д20ч (праздничный перенос) → нужен ≥12д,
  // но не более 21д, иначе тихо замёрзший ряд будет считаться валидным больше трёх недель.
  if(cfg.release==="weekly-batch")ok(ttlH>=12*DAY_H&&ttlH<=21*DAY_H,`FRED ${id}: недельный пакет, порог ${ttlH/24}д — должен быть 12–21д`);
  // monthly-batch (JPNASSETS): точка датируется ПЕРВЫМ числом месяца и публикуется в начале
  // следующего — перед самым обновлением её штатная старость достигает ~62 дней (замерено вживую:
  // 2026-06-01 на 2026-07-21 = 50д). Порог 65–90д; дальше ряд считается замёрзшим.
  if(cfg.release==="monthly-batch")ok(ttlH>=65*DAY_H&&ttlH<=90*DAY_H,`FRED ${id}: месячный пакет, порог ${ttlH/24}д — должен быть 65–90д`);
}
// Ряды ОДНОГО релиза ФРС обязаны иметь один календарь публикации: H.10 (валютные курсы) выходит
// недельным пакетом по понедельникам целиком, поэтому DTWEXBGS и DEX* не могут расходиться в
// release/ttl. Этот класс ошибки ловился уже дважды вживую (v2.8.5 на DTWEXBGS, 2026-07-24 на
// DEXUSEU/DEXJPUS): объявленный "daily" порог 7д красит ряд бо́льшую часть недели.
{
  const H10=["DTWEXBGS","DEXUSEU","DEXJPUS"].filter(id=>FRED_SERIES[id]);
  const classes=[...new Set(H10.map(id=>FRED_SERIES[id].release))];
  ok(classes.length<=1,`ряды релиза H.10 разъехались по календарю публикации: ${H10.map(id=>id+"="+FRED_SERIES[id].release).join(", ")}`);
  const ttls=[...new Set(H10.map(id=>FRED_SERIES[id].ttl))];
  ok(ttls.length<=1,`ряды релиза H.10 разъехались по порогу свежести: ${H10.map(id=>id+"="+FRED_SERIES[id].ttl/DAY_H/36e5+"д").join(", ")}`);
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
// ---- Байтовый бюджет истории согласован с жёстким капом файла ----
{
  const {HISTORY_BYTE_BUDGET,boundedPublicHistoryV1,prunedDailyRowV1,pruneDailyInputSummaryV1,DAILY_INPUT_SUMMARY_DAYS}=await import("./public-snapshot-contract.mjs");
  const {MODEL_POLICY_V1}=await import("../docs/model-policy-v1.mjs");
  const snap=JSON.parse(readFileSync(new URL("../docs/snapshot.json",import.meta.url),"utf8"));
  const bytes=v=>Buffer.byteLength(JSON.stringify(v));
  // Страж считает проекцию ТОЙ ЖЕ функцией, что и static-audit: собственная арифметика здесь
  // разъехалась с политикой хранения (не знала о прореживании input_summary) и 30.07 заблокировала
  // публикацию ложным пробоем капа. Один источник правды — projectedPublicSnapshotBytesV1.
  if(snap.monitoring?.daily?.length&&snap.monitoring?.decision_log?.length&&snap.history?.length){
    const cfg=MODEL_POLICY_V1.forward_monitoring;
    const projected=projectedPublicSnapshotBytesV1({snapshotBytes:bytes(snap),snapshot:snap,dailyLimit:cfg.daily_history_days,decisionLogLimit:cfg.observation_log_limit,historyMaxRows:HISTORY_MAX_ROWS});
    ok(projected<PUBLIC_SNAPSHOT_MAX_BYTES,`проекция стационарного размера (${(projected/1e6).toFixed(2)}МБ) обязана помещаться в кап ${(PUBLIC_SNAPSHOT_MAX_BYTES/1e6).toFixed(1)}МБ — иначе мёртвая зона дедлока публикации возвращается`);
    ok(PUBLIC_SNAPSHOT_MAX_BYTES-projected>150_000,`запас до капа ${((PUBLIC_SNAPSHOT_MAX_BYTES-projected)/1e3).toFixed(0)}КБ слишком мал: ниже 150КБ добавление одного поля в строку снова упирает публикацию в кап`);
  }
  // Прореживание детальных входов: свежие строки полные, старые теряют input_summary, но сохраняют
  // проверяемость через input_hash; функция идемпотентна (повторный прогон ничего не ломает).
  {
    const now=Date.UTC(2026,7,1);
    const mk=(daysAgo,extra={})=>({t:new Date(now-daysAgo*86400000).toISOString(),date:"x",input_hash:"h"+daysAgo,input_summary:{metrics:[1,2,3]},...extra});
    const pruned=pruneDailyInputSummaryV1([mk(200),mk(31),mk(29),mk(0)],{now,keepDays:DAILY_INPUT_SUMMARY_DAYS});
    eq(pruned.map(r=>r.input_summary!==undefined),[false,false,true,true],"input_summary остаётся только в свежем окне");
    eq(pruned.map(r=>r.input_hash),["h200","h31","h29","h0"],"input_hash обязан сохраняться во всех строках — проверяемость не теряется");
    ok(pruned[0].input_summary_pruned===true,"урезание помечается явно, а не молча");
    eq(pruneDailyInputSummaryV1(pruned,{now,keepDays:DAILY_INPUT_SUMMARY_DAYS}),pruned,"идемпотентность");
    ok(bytes(prunedDailyRowV1(mk(0)))<bytes(mk(0)),"прореженная строка обязана быть меньше полной");
    eq(prunedDailyRowV1({t:"x",input_hash:"h"}),{t:"x",input_hash:"h"},"строка без input_summary не меняется");
    // Проекция обязана учитывать прореживание: иначе она завышает стационар на сотни КБ.
    const fakeSnap={monitoring:{daily:[mk(0)],decision_log:[{a:1}]},history:[{h:1}]};
    const withPrune=projectedPublicSnapshotBytesV1({snapshotBytes:1000,snapshot:fakeSnap,dailyLimit:370,decisionLogLimit:1,historyMaxRows:1,dailyInputSummaryDays:30});
    const noPrune=projectedPublicSnapshotBytesV1({snapshotBytes:1000,snapshot:fakeSnap,dailyLimit:370,decisionLogLimit:1,historyMaxRows:1,dailyInputSummaryDays:370});
    ok(withPrune<noPrune,"проекция с прореживанием обязана быть меньше проекции без него");
  }
  const rows=Array.from({length:200},(_,i)=>({t:new Date(Date.UTC(2026,0,1)+i*86400000).toISOString(),strategic:-10,tactical:0,price:60000,pad:"x".repeat(50)}));
  const bounded=boundedPublicHistoryV1(rows,{budget:bytes(rows.slice(100))+2,minRows:48});
  ok(bounded.trimmed>0&&bounded.history.length<rows.length,"бюджет обязан отбрасывать строки при переполнении");
  eq(bounded.history.at(-1).t,rows.at(-1).t,"отбрасываются САМЫЕ СТАРЫЕ строки, свежие сохраняются");
  const untouched=boundedPublicHistoryV1(rows,{budget:1e9,minRows:48});
  eq(untouched.trimmed,0,"при запасе бюджета история не режется");
  const floor=boundedPublicHistoryV1(rows,{budget:1,minRows:48});
  eq(floor.history.length,48,"минимум строк сохраняется даже при нулевом бюджете");
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
  // Резерв обязан стоять ПОСЛЕ выбора среди зеркал канона, а не участвовать в сравнении свежести:
  // он всегда свежее (у SosoValue быстрее агрегация) и иначе вытеснял бы канон каждый прогон,
  // превращая подмену источника в норму. Поведенчески это закрыто сценарием etf_both_dead.
  ok(fn.lastIndexOf("fetchSosoEtfDaily")>fn.indexOf("candidates.length"),"резервный источник обязан включаться только после провала обоих зеркал канона");
  ok(!/farside\.co\.uk|parseFarside\(/.test(fn),"Farside отдаёт 403 на каждом прогоне и не имеет права оставаться в тракте: мёртвый резерв — это отсутствие резерва");
  ok(/зеркала The Block разошлись/.test(fn),"пропала сверка зеркал на пересечении: испорченная свежая копия попала бы в публикацию");
}

// ---- Дополняющий слой свежих дат (SosoValue) ----
// The Block остаётся КАНОНОМ: слой добавляет только отсутствующие торговые дни и обязан молча
// отказываться при любом сомнении. Сшивка не имеет права ухудшить картину — только дополнить.
{
  const DAYMS=864e5;
  const weekdays=(count,endBack)=>{const out=[];let t=Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z");
    while(out.length<count+endBack){if(![0,6].includes(new Date(t).getUTCDay()))out.push(t);t-=DAYMS;}
    const asc=out.reverse();return asc.slice(0,asc.length-endBack);};
  const mk=(count,endBack,f=1)=>weekdays(count,endBack).map((t,i)=>({t,v:(1+(i%5))*1e8*f}));
  const canon=mk(200,2),fresh=mk(202,0);
  // Подтверждение вторым наблюдением: `seen` — то, что прогон часом раньше видел у провайдера.
  const seenOf=(c,f)=>Object.fromEntries(f.filter(x=>x.t>c.at(-1).t).map(x=>[new Date(x.t).toISOString().slice(0,10),x.v]));
  const seen=seenOf(canon,fresh);
  const r=spliceFreshEtfDays(canon,fresh,"The Block",{seen});
  eq(r.spliced,2,"два подтверждённых торговых дня обязаны быть дополнены");
  eq(r.source,"The Block + SosoValue","атрибуция должна честно называть оба источника");
  ok(r.series.slice(0,canon.length).every((x,i)=>x.v===canon[i].v),"канонические дни не должны переписываться дополняющим слоем");

  // ГЛАВНЫЙ КОНТРАКТ: без подтверждения слой отказывает В ЗАКРЫТУЮ. Полноту дня у провайдера
  // спросить нельзя — все фонды всегда несут одну дату публикации, а неотчитавшийся фонд выглядит
  // ровным нулём. Единственный наблюдаемый признак неполноты — что значение ещё меняется.
  eq(spliceFreshEtfDays(canon,fresh,"The Block").spliced,0,"без прошлых наблюдений сшивать нечего — обязан быть отказ, а не пропуск");
  ok(/не подтверждён/.test(spliceFreshEtfDays(canon,fresh,"The Block").note||""),"причина отказа обязана быть названа");
  const drifting={...seen};drifting[Object.keys(drifting)[0]]+=1e6;
  eq(spliceFreshEtfDays(canon,fresh,"The Block",{seen:drifting}).spliced,0,"значение изменилось между наблюдениями — день ещё дорастает и обязан быть придержан");
  // Подтверждён только первый из двух: сшивается непрерывный отрезок, разрыва в ряду быть не может.
  const partial={[Object.keys(seen)[0]]:seen[Object.keys(seen)[0]]};
  const rp=spliceFreshEtfDays(canon,fresh,"The Block",{seen:partial});
  eq(rp.spliced,1,"подтверждён один день — сшит должен быть ровно один");
  ok(rp.series.every((x,i,a)=>!i||x.t>a[i-1].t),"ряд обязан остаться строго возрастающим");
  // Память наблюдений возвращается ВСЕГДА, иначе подтверждать в следующий час будет нечем.
  eq(Object.keys(spliceFreshEtfDays(canon,fresh,"The Block").probe||{}).length,2,"наблюдения этого прогона обязаны быть возвращены даже при отказе");

  eq(spliceFreshEtfDays(fresh,fresh,"The Block",{seen}).spliced,0,"канон не отстаёт — сшивки быть не должно");
  eq(spliceFreshEtfDays(mk(202,0),mk(200,2),"The Block",{seen}).spliced,0,"провайдер позади канона — сшивки быть не должно");
  ok(/расхождение/.test(spliceFreshEtfDays(canon,mk(202,0,1.5),"The Block",{seen:seenOf(canon,mk(202,0,1.5))}).note||""),"расхождение провайдеров на общих днях обязано отменять сшивку");
  ok(/общих дней/.test(spliceFreshEtfDays(canon,fresh.slice(-4),"The Block",{seen}).note||""),"без достаточного пересечения сверять нечего — сшивка отменяется");
  eq(spliceFreshEtfDays(canon,mk(202,0).map(x=>({...x,v:x.v*1.02})),"The Block",{seen:seenOf(canon,mk(202,0).map(x=>({...x,v:x.v*1.02})))}).spliced,2,"обычный шум провайдеров не должен блокировать дополнение");
  eq(spliceFreshEtfDays(canon,mk(202,0).map((x,i)=>i>=200?{...x,v:2e10}:x),"The Block",{seen:seenOf(canon,mk(202,0).map((x,i)=>i>=200?{...x,v:2e10}:x))}).spliced,0,"точка вне физической полосы обязана отменять сшивку");

  // Предел опережения обязан считаться по СЫРОМУ опережению, до отсева по подтверждению. Иначе
  // мёртвый канон проходит: восемь дней урезаются подтверждением до трёх, лимит молчит, и слой
  // из дополнения превращается в подмену источника ровно тогда, когда сверить его не с чем.
  const farBehind=mk(200,8),far=mk(208,0);
  const onlyThree=Object.fromEntries(Object.entries(seenOf(farBehind,far)).slice(0,3));
  ok(/опережение/.test(spliceFreshEtfDays(farBehind,far,"The Block",{seen:seenOf(farBehind,far)}).note||""),"опережение сверх лимита обязано отменять сшивку (это подмена источника, а не дополнение)");
  ok(/опережение/.test(spliceFreshEtfDays(farBehind,far,"The Block",{seen:onlyThree}).note||""),"лимит опережения нельзя обходить, урезав список подтверждением");

  // Выравнивание меток: свежие дни обязаны жить в соглашении канона о времени суток, а день, чей
  // канонический момент ещё не наступил, — отбрасываться, а не подтягиваться к текущему моменту.
  const noon=canon.map(x=>({t:x.t+12*3600e3,v:x.v}));
  const rn=spliceFreshEtfDays(noon,fresh,"The Block",{seen});
  ok(rn.spliced===0||rn.series.slice(-rn.spliced).every(x=>x.t%DAYMS===12*3600e3),"сшитые дни обязаны жить в соглашении канона о времени суток");
  ok(rn.series.every(x=>x.t<=Date.now()),"день из будущего не имеет права попасть в ряд потоков");
  ok(rn.series.every(x=>![0,6].includes(new Date(x.t).getUTCDay())),"выравнивание не имеет права перенести день на выходной");

  // День, чей КАНОНИЧЕСКИЙ момент ещё не наступил, обязан быть отброшен, а не подтянут к текущему
  // моменту. Подтягивание (кламп к «сейчас минус час») впускало бы незакрытый торговый день в окна
  // потоков, обходя запрет ETF-контракта на точку из будущего, и делало бы возраст наблюдения
  // функцией времени прогона. Конструкция намеренно не зависит от дня недели: следующий торговый
  // день после последнего дня канона наступает в будущем всегда.
  const base=weekdays(200,0);
  const nextTrading=t=>{let x=t+DAYMS;while([0,6].includes(new Date(x).getUTCDay()))x+=DAYMS;return x;};
  const aheadT=nextTrading(base.at(-1));
  const canonNoon=base.map((t,i)=>({t:t+12*3600e3,v:(1+(i%5))*1e8}));
  const withFuture=[...base.map((t,i)=>({t,v:(1+(i%5))*1e8})),{t:aheadT,v:3e8}];
  const rf=spliceFreshEtfDays(canonNoon,withFuture,"The Block",{seen:{[new Date(aheadT).toISOString().slice(0,10)]:3e8}});
  eq(rf.spliced,0,"незакрытый торговый день обязан быть отброшен, а не подтянут к текущему моменту");
  ok(/канонический момент/.test(rf.note||""),"причина отказа обязана называть ненаступивший канонический момент, а не маскироваться под отказ контракта");
}
// Деградация ряда ETF между прогонами обязана быть ВИДНА, причём в обе стороны: и откат
// последнего дня, и усечение истории. Второй случай опаснее — он тихо гасит тревогу.
{
  const mk=n=>Array.from({length:n},(_,i)=>({t:Date.UTC(2026,0,1)+i*864e5,v:1e8}));
  const full=mk(600);
  eq(etfDegradation(full,full).degraded,false,'неизменившийся ряд не должен помечаться деградировавшим');
  eq(etfDegradation(full,mk(601)).degraded,false,'выросший ряд — норма, а не деградация');
  // Вытеснение: канон догнал и подменил значение сшитого дня. Длина и последний день те же.
  const displaced=full.map((x,i)=>i===full.length-1?{...x,v:9e7}:x);
  eq(etfDegradation(full,displaced).degraded,false,'вытеснение сшитого дня каноном не деградация: длина и последний день те же');
  eq(etfDegradation(full,mk(599)).degraded,true,'потеря последнего дня — это откат, он обязан помечаться');
  ok(etfDegradation(full,full.slice(0,-1).concat([{...full.at(-1)}])).degraded===false,'ряд той же длины и с тем же последним днём не деградация');
  ok(etfDegradation(full,mk(200)).degraded,'усечение истории обязано помечаться: оно меняет перцентили и гасит условие детектора');
  // Граница: пропал ОДИН день из глубины. Свежесть не пострадала, откат не сработает — поймать
  // это может только проверка длины, поэтому порог обязан быть строгим, а не «примерно столько же».
  ok(etfDegradation(full,full.slice(1)).degraded,'потеря даже одного дня глубины обязана помечаться');
  ok(/усечена/.test(etfDegradation(full,mk(200)).notes.join(' ')),'причина усечения обязана попасть в диагностику');
  ok(etfDegradation(full,full.slice(0,-3)).degraded,'откат последнего дня назад обязан помечаться');
  eq(etfDegradation(null,full).degraded,false,'первый прогон без прошлого снимка не деградация');
  eq(etfDegradation(full,[]).degraded,false,'пустой ряд обрабатывается выше по потоку, здесь не падаем');
}
// Лестница резерва ETF при смерти зеркал канона. Отказ эндпоинта не означает исчезновения истории:
// она лежит в состоянии, и терять половину глубины нельзя — перцентиль потоков считается по всему
// ряду, поэтому подмена 630 дней канона на 300 дней резерва сдвигает ранги и делает картину менее
// медвежьей. Проверяется решение о ВЫБОРЕ базы, сама сшивка покрыта выше.
{
  const wd=(count,endBack=0)=>{const out=[];let t=Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z");
    while(out.length<count+endBack){if(![0,6].includes(new Date(t).getUTCDay()))out.push(t);t-=864e5;}
    const asc=out.reverse();return asc.slice(0,asc.length-endBack);};
  const rows=n=>wd(n).map((t,i)=>({t,v:(1+(i%5))*1e8}));
  const fresh=rows(300);
  ok(cachedEtfCanon({source:"The Block",data:fresh})===fresh,"свежий кэш самого канона обязан годиться в основу");
  // ОТМЫВАНИЕ. Пакет со сшитым хвостом годится в каноны, только если он честно называет границу
  // истинного канона: иначе прогон берёт свой же прошлый вывод за основу, опережение снова равно
  // единице, и ни предел в 3 дня, ни недельный порог протухания не срабатывают НИКОГДА — оба
  // меряются по краю ряда, а край после сшивки всегда свежий.
  eq(cachedEtfCanon({source:"The Block + SosoValue",data:fresh}),null,"сшитый пакет без границы канона не имеет права стать каноном: так дни слоя отмываются в канон");
  eq(cachedEtfCanon({source:"The Block (кэш) + SosoValue",data:fresh}),null,"собственный резервный вывод без границы канона тем более не годится");
  {
    const edge=fresh.at(-3).t;
    const trimmed=cachedEtfCanon({source:"The Block + SosoValue",data:fresh,canon_last:new Date(edge).toISOString()});
    eq(trimmed?.length,fresh.length-2,"сшитый хвост обязан быть ОТРЕЗАН по границе истинного канона");
    eq(trimmed?.at(-1).t,edge,"канон обязан заканчиваться ровно на объявленной границе");
    // Протухание меряется по ИСТИННОМУ канону, а не по свежему сшитому хвосту.
    const stale=fresh.map((x,i)=>i<fresh.length-2?{...x,t:x.t-20*864e5}:x);
    eq(cachedEtfCanon({source:"The Block + SosoValue",data:stale,canon_last:new Date(stale.at(-3).t).toISOString()}),null,"мёртвый канон со свежим сшитым хвостом обязан отбраковываться");
  }
  eq(cachedEtfCanon({source:"SosoValue",data:fresh}),null,"прошлый РЕЗЕРВ не имеет права стать каноном: иначе однажды случившаяся подмена закрепится навсегда");
  eq(cachedEtfCanon({source:"Farside",data:fresh}),null,"чужой источник не имеет права стать каноном");
  eq(cachedEtfCanon(null),null,"первый запуск без состояния — не основание что-то выдумывать");
  eq(cachedEtfCanon({source:"The Block",data:[]}),null,"пустой кэш не годится");
  // Протухшая история хуже честного отсутствия: окна потоков считаются от её конца.
  const stale=wd(300,25).map((t,i)=>({t,v:(1+(i%5))*1e8}));
  eq(cachedEtfCanon({source:"The Block",data:stale}),null,"кэш старше недели обязан отбраковываться");
}
// КЭШ ПОДТВЕРЖДЁННОГО СШИТОГО ДНЯ. Разовый отказ провайдера не должен выбрасывать день из ряда:
// такой выброс — единственный подтверждённый в системе источник ОДИНОЧНОГО встречного снимка, а тот
// обнуляет 48-часовой отсчёт гистерезиса. Но кэш обязан оставаться кэшем, а не лазейкой мимо
// проверок: те же предел опережения, тот же контракт, обязательное вытеснение каноном.
{
  const wd=(count,endBack=0)=>{const out=[];let t=Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z");
    while(out.length<count+endBack){if(![0,6].includes(new Date(t).getUTCDay()))out.push(t);t-=864e5;}
    const asc=out.reverse();return asc.slice(0,asc.length-endBack);};
  const H=36e5, NOWMS=Date.now();
  const canon=wd(200,2).map((t,i)=>({t:t+12*H,v:(1+(i%5))*1e8}));
  const ahead=wd(200,0).slice(-2).map((t,i)=>({t:t+12*H,v:(2+i)*1e8})).filter(x=>x.t>canon.at(-1).t&&x.t<=NOWMS);
  const fresh={days:ahead,at:new Date(NOWMS-2*H).toISOString()};

  const nextTrading=t=>{let x=t+864e5;while([0,6].includes(new Date(x).getUTCDay()))x+=864e5;return x;};
  const r=reviveSplicedDays(canon,fresh);
  ok(r&&r.days===ahead.length,`свежий кэш обязан оживлять подтверждённые дни: ${JSON.stringify(r&&r.days)} против ${ahead.length}`);
  ok(r&&r.series.length===canon.length+ahead.length,"оживление не имеет права терять или дублировать точки");
  ok(r&&r.series.every((x,i,a)=>!i||x.t>a[i-1].t),"ряд обязан остаться строго возрастающим");

  eq(reviveSplicedDays(canon,{days:ahead,at:new Date(NOWMS-25*H).toISOString()}),null,"кэш старше суток обязан протухать: держать неперепроверенный день бесконечно нельзя");
  eq(reviveSplicedDays(canon,{days:ahead,at:new Date(NOWMS+2*H).toISOString()}),null,"кэш из будущего — испорченное состояние, доверять нельзя");
  // Канон догнал: день обязан быть ВЫТЕСНЕН, а не продублирован.
  eq(reviveSplicedDays([...canon,...ahead],fresh),null,"догнавший канон обязан вытеснять кэш");
  eq(reviveSplicedDays(canon,null),null,"без кэша оживлять нечего");
  eq(reviveSplicedDays(canon,{days:[],at:new Date(NOWMS).toISOString()}),null,"пустой кэш не годится");
  // Предел опережения действует и на кэш: иначе он стал бы обходом правила «дополнение, не подмена».
  // Дни строятся ОТ канона вперёд, а не «последние N торговых», иначе при коротком отставании канона
  // список окажется пустым и проверка молча пропустится, ничего не проверив.
  const short=wd(200,6).map((t,i)=>({t:t+12*H,v:(1+(i%5))*1e8}));
  const many=[];{let t=short.at(-1).t;for(let i=0;i<4;i++){t=nextTrading(t);many.push({t,v:1e8});}}
  eq(many.length,4,"фикстура обязана дать ровно 4 дня опережения, иначе проверка ничего не проверяет");
  eq(reviveSplicedDays(short,{days:many,at:new Date(NOWMS-H).toISOString()}),null,"кэш не имеет права обходить предел опережения в 3 дня");
  eq(reviveSplicedDays(short,{days:many.slice(0,3),at:new Date(NOWMS-H).toISOString()})?.days,3,"ровно на пределе кэш обязан работать");
  // Тот же ETF-контракт, что и для живых данных.
  eq(reviveSplicedDays(canon,{days:ahead.map(x=>({...x,v:2e10})),at:new Date(NOWMS-H).toISOString()}),null,"значение вне физической полосы обязано отбраковываться и в кэше");
  // «Будущий» день строится ОТ КОНЦА РЯДА ВПЕРЁД, а не сдвигом на трое суток: сдвиг пятницы на 3
  // дня даёт понедельник, который после полудня уже прошлое и валидный торговый день, — из-за чего
  // проверка превращалась в свою противоположность каждый понедельник с 12:00 UTC и роняла CI.
  const futureDay=[{t:nextTrading(ahead.at(-1).t-ahead.at(-1).t%864e5)+12*H,v:3e8}];
  ok(futureDay[0].t>NOWMS,"фикстура обязана дать день в БУДУЩЕМ, иначе проверка ничего не проверяет");
  eq(reviveSplicedDays(canon,{days:futureDay,at:new Date(NOWMS-H).toISOString()}),null,"день из будущего не имеет права оживать");
}
// ГИСТЕРЕЗИС РЕЖИМА. Это то, что решает, КОГДА панель меняет торговую рекомендацию, и до сих пор
// его семантику не защищал ни один тест: обе стороны асимметрии можно было сломать незаметно.
{
  const H=36e5, T0=Date.parse("2026-07-18T00:00:00Z");
  const meta=(candidate,count,sinceH=0,downStreak=0)=>({state:candidate,candidate,count,since:new Date(T0+sinceH*H).toISOString(),downStreak,anchor:candidate});
  const st=(cand,prev,m,atH,opts)=>stabilizeCore(cand,prev,m,T0+atH*H,opts);

  // Асимметрия — суть механизма: ухудшение принимается быстро, улучшение требует подтверждения.
  ok(severity("demand_break")<severity("balanced"),"выход из demand_break обязан считаться повышением, иначе вся асимметрия не применяется");
  // Ухудшение: два подряд снимка и не раньше. Счётчик наращивается ВНУТРИ функции, поэтому
  // «первый тревожный снимок» — это состояние, где прошлым кандидатом был ещё спокойный режим.
  eq(st("demand_break","balanced",meta("balanced",5),1).state,"balanced","одиночный тревожный снимок не имеет права менять режим");
  eq(st("demand_break","balanced",meta("demand_break",1,0,1),1).state,"demand_break","второй подряд тревожный снимок обязан приниматься");
  // Повышение: 48 часов И 12 снимков, оба условия обязательны.
  eq(st("balanced","demand_break",meta("balanced",10,0),49).state,"demand_break","повышение при 11 снимках обязано удерживаться: мало наблюдений");
  eq(st("balanced","demand_break",meta("balanced",30,0),47).state,"demand_break","повышение через 47 часов обязано удерживаться: рано");
  eq(st("balanced","demand_break",meta("balanced",30,0),49).state,"balanced","при 49 часах и 30 снимках повышение обязано состояться");
  // Переход равной тяжести — не повышение, ему хватает двух снимков.
  eq(st("fragile","demand_break",meta("fragile",1),1).state,"fragile","переход между состояниями равной тяжести не обязан ждать 48 часов");
  // Холодный старт: удерживать не от чего.
  eq(st("balanced",undefined,null,1,{fresh:true}).state,"balanced","первый запуск публикует кандидата как есть");
  eq(st("balanced","demand_break",meta("balanced",30,0),49,{mock:true}).state,"balanced","снимок на синтетике не имеет права наследовать боевую родословную");

  // ХРАПОВИК ОТСЧЁТА — ПОВЕДЕНИЕ ЗАКРЕПЛЕНО СОЗНАТЕЛЬНО, НЕ ЧИНИТЬ БЕЗ РЕШЕНИЯ ВЛАДЕЛЬЦА.
  // `since` обнуляется при ЛЮБОЙ смене кандидата, поэтому «48 часов» на практике означают «49 часов
  // подряд без единого встречного снимка». Симуляция: срыв даже раз в 49 часов — шире самого окна —
  // не отпускает удержание никогда.
  // Происхождение: это побочный эффект реализации, а не задумка. Двумя строками выше тот же
  // одиночный встречный снимок признан НЕдостаточным, чтобы менять режим (`downStreak>=2`); будь
  // храповик намеренным, отсчёт повышения фильтровал бы шум так же. Он не фильтрует.
  // Решение владельца панели (2026-07-18): ОСТАВИТЬ как есть. Обоснование — эффект консервативен в
  // ту же сторону, что и сам гистерезис (защита от преждевременных покупок на дёрганье), а с v2.9.6
  // удержание видно на панели: полоса пишет кандидата и границу снятия, так что застревание больше
  // не молчаливое. Если решение будут пересматривать — править ТОЛЬКО ветку повышения: ослабление
  // понижения сломает намеренное свойство «ухудшение принимается быстро».
  const afterBlip=st("balanced","demand_break",meta("demand_break",1,47),47.5);
  eq(afterBlip.count,1,"встречный снимок обнуляет счётчик наблюдений");
  eq(Date.parse(afterBlip.since),T0+47.5*H,"встречный снимок сбрасывает отсчёт 48 часов в ноль");
  eq(afterBlip.state,"demand_break","и режим при этом остаётся удерживаемым");
  // Испорченное состояние обязано ДЕГРАДИРОВАТЬ, а не ронять сборку: без этого одно битое поле
  // в кэше замораживает публикацию целиком (RangeError при печати границы удержания).
  for(const bad of ["abc","",null,undefined,12345,{}]){
    let r=null,threw=null;
    try{r=st("balanced","demand_break",{state:"demand_break",candidate:"balanced",count:30,since:bad,downStreak:0,anchor:"demand_break"},49);}catch(e){threw=e;}
    ok(!threw,"битая метка since="+JSON.stringify(bad)+" не имеет права ронять сборку: "+(threw&&threw.message));
    ok(r&&Number.isFinite(Date.parse(r.since)),"после деградации метка обязана стать валидной");
    ok(!r||!r.hold_until||Number.isFinite(Date.parse(r.hold_until)),"граница удержания обязана быть валидной датой или отсутствовать");
  }
  // Граница снятия публикуется ТОЛЬКО когда удержание реально действует, иначе панель
  // подписала бы удержанием обычный установившийся режим.
  const holding=st("balanced","demand_break",meta("balanced",5,0),3);
  ok(holding.hold_until,"при удержании повышения обязана публиковаться граница снятия");
  eq(Date.parse(holding.hold_until),Date.parse(holding.since)+48*H,"граница снятия = начало отсчёта плюс окно выдержки");
  ok(!st("defensive","defensive",meta("defensive",30,0),3).hold_until,"установившийся режим не должен подписываться удержанием");
}
// Повторы запроса проверяются ПОВЕДЕНИЕМ: разовый сбой слоя укорачивает ряд и двигает возраст
// наблюдения назад, а постоянную ошибку повторять бессмысленно.
{
  const realFetch=globalThis.fetch;
  const rows=Array.from({length:200},(_,i)=>({date:new Date(Date.UTC(2026,0,1)+i*864e5).toISOString().slice(0,10),totalNetInflow:1e8}))
    .filter(x=>![0,6].includes(new Date(x.date+"T00:00:00Z").getUTCDay()));
  let calls=0;
  try{
    globalThis.fetch=async()=>{calls++;return calls===1?new Response("",{status:503}):new Response(JSON.stringify({code:0,data:rows}),{status:200,headers:{"content-type":"application/json"}});};
    const got=await fetchSosoEtfDaily();
    eq(calls,2,"временный сбой обязан повторяться: без повтора ряд укоротится на ровном месте");
    ok(got.length>=100,"после повтора данные обязаны дойти");
    calls=0;
    globalThis.fetch=async()=>{calls++;return new Response("",{status:404});};
    await fetchSosoEtfDaily().then(()=>ok(false,"404 обязан оставаться ошибкой"),()=>{});
    eq(calls,1,"постоянную ошибку повторять бессмысленно: это лишний расход лимита маршрута");
  }finally{globalThis.fetch=realFetch;}
}
{
  const collector=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
  ok(!/SOSO-[A-Za-z0-9]{8}/.test(collector),"ключ SosoValue не должен быть зашит в сборщик");
  const fn=collector.slice(collector.indexOf("async function sosoPost"),collector.indexOf("function spliceFreshEtfDays"));
  ok(/process\.env\.SOSO_API_KEY/.test(fn),"ключ обязан читаться из окружения");
  ok(/key\?\{"x-soso-api-key"/.test(fn),"без ключа запрос всё равно должен уходить: маршрут публичный, панель не обязана зависеть от секрета");
}

// САНАЦИЯ ПЕРЕНОСИМОЙ ИСТОРИИ. Прогон теста однажды оставил в опубликованной истории записи с
// выдуманной ценой $131k; история переносится вперёд, поэтому мусор жил неделю и ИИ-разбор
// «объяснял» несуществовавший обвал. Эталон — независимый дневной ряд цены.
{
  const refP=new Map([["2026-07-13",62265],["2026-07-14",64989],["2026-07-15",64800]]);
  const recH=(o)=>({t:"2026-07-14T12:00:00.000Z",strategic:-13,tactical:-18,price:64500,phase:"Фаза 4 · защитный режим",...o});
  ok(plausibleHistoryRecord(recH({}),refP),"нормальная запись обязана проходить");
  ok(!plausibleHistoryRecord(recH({price:131330}),refP),"выдуманная цена 131k против эталона 65k обязана отбраковываться");
  ok(!plausibleHistoryRecord(recH({price:82432}),refP),"цена, расходящаяся с эталоном на треть, тоже мусор");
  ok(!plausibleHistoryRecord(recH({price:null,phase:"демо"}),refP),"демо-затравка без цены обязана отбраковываться");
  ok(!plausibleHistoryRecord(recH({phase:"демо"}),refP),"запись фазы «демо» обязана отбраковываться даже с валидной ценой");
  ok(!plausibleHistoryRecord(recH({strategic:null}),refP),"нефинитный стратегический балл — мусор");
  ok(!plausibleHistoryRecord(recH({t:"не дата"}),refP),"непарсящаяся метка — мусор");
  ok(plausibleHistoryRecord(recH({price:66000}),refP),"нормальный внутридневной разброс (2%) не должен отбраковываться");
  ok(plausibleHistoryRecord(recH({t:"2020-01-01T12:00:00.000Z",price:7200}),refP),"без эталона на день запись проходит по остальным признакам");
  const collectorSrc=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
  const sanRegion=collectorSrc.slice(collectorSrc.indexOf("САНАЦИЯ ПЕРЕНОСИМОЙ ИСТОРИИ"),collectorSrc.indexOf("buildMetrics(),blocks"));
  ok(/previous\.history=previous\.history\.filter\(h=>plausibleHistoryRecord\(h,priceByDay\)\)/.test(sanRegion),"санитайзер обязан применяться к previous.history ДО первого потребителя");
  ok(/series\(data\("market"\)\?\.price/.test(sanRegion),"эталон обязан браться из независимого дневного ряда цены");
}

// ===== Правки аудита 10.10.2026: слой данных =====
// CFTC: ДЕНЬ ОТЧЁТА НЕ ЗАВИСИТ ОТ ЧАСОВОГО ПОЯСА МАШИНЫ. Socrata отдаёт метку без зоны, и разбор
// «как есть» давал на машине в UTC+8 16:00 предыдущих суток: другой observed_at и другой хэш винтажа
// при тех же данных. Проверяется исполнением в дочерних процессах с разными TZ — к востоку и к
// западу от Гринвича; хэш пакета обязан совпасть во всех.
{
  const {execFileSync}=await import("node:child_process");
  const probe=`
process.env.PREVIOUS_STATE=".state/__test_absent__.json";process.env.PREVIOUS_PUBLIC=".state/__test_absent__.json";
const {parseCftc}=await import(process.env.MODULE_URL);
const {createHash}=await import("node:crypto");
const rows=[{report_date_as_yyyy_mm_dd:"2026-10-06T00:00:00.000",open_interest_all:"21432",asset_mgr_positions_long:"5174",asset_mgr_positions_short:"1642",lev_money_positions_long:"5731",lev_money_positions_short:"12583"},
  {report_date_as_yyyy_mm_dd:"2026-09-29T00:00:00.000",open_interest_all:"21000",asset_mgr_positions_long:"5000",asset_mgr_positions_short:"1600",lev_money_positions_long:"5700",lev_money_positions_short:"12500"}];
const parsed=parseCftc(rows);
console.log(JSON.stringify({t:parsed.map(x=>x.t),sha:createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}));`;
  const run=tz=>JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",probe],{encoding:"utf8",env:{...process.env,TZ:tz,MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href}}).trim().split("\n").at(-1));
  const utc=run("UTC");
  eq(utc.t,[Date.UTC(2026,8,29),Date.UTC(2026,9,6)],"CFTC: день отчёта — полночь UTC своей календарной даты");
  for(const tz of ["Asia/Singapore","America/Los_Angeles","Pacific/Kiritimati"]){
    const got=run(tz);
    eq(got.t,utc.t,`CFTC: в поясе ${tz} метки отчётов обязаны совпасть с UTC`);
    eq(got.sha,utc.sha,`CFTC: в поясе ${tz} хэш пакета обязан совпасть с UTC — иначе винтаж зависит от машины`);
  }
}
// РЕЗЕРВНЫЙ BASIS KRAKEN: контракт обязан быть линейным датированным, в окне 20–100 дней, не
// приостановленным и ЛИКВИДНЫМ (OI от 50 млн $ или оборот от 1 млн $ за сутки). Мёртвый контракт с
// mark = index давал ровно 0,0 % и голос «спокойно» — он обязан давать null.
{
  const D=864e5,t0=Date.UTC(2026,9,10,12),sym=days=>{const d=new Date(t0+days*D),p=n=>String(n).padStart(2,"0");return `FF_XBTUSD_${p(d.getUTCFullYear()%100)}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;};
  const row=(days,over={})=>({symbol:sym(days),markPrice:"101000",indexPrice:"100000",openInterest:"600",volumeQuote:"100000",suspended:false,...over});
  const got=krakenDatedBasis([row(45)],t0);
  ok(got&&got.symbol===sym(45),"ликвидный контракт в окне обязан выбираться");
  // До экспирации (полночь UTC её дня) от полудня 10.10 — 44,5 суток.
  ok(got&&Math.abs(got.basis-(101000/100000-1)*365/44.5*100)<1e-9,`формула: (mark/index−1)·365/дней·100, получено ${got?.basis}`);
  eq(krakenDatedBasis([row(45,{markPrice:"100000",openInterest:"0",volumeQuote:"0",vol24h:"0"})],t0),null,"мёртвый контракт (OI 0, оборот 0) не даёт basis");
  eq(krakenDatedBasis([row(45,{openInterest:"36",volumeQuote:"46000"})],t0),null,"тонкий контракт (3,6 млн $ OI, 46 тыс. $ оборота) порог не проходит");
  ok(krakenDatedBasis([row(45,{openInterest:"1",volumeQuote:"1000000"})],t0),"оборот ровно 1 млн $ — порог пройден");
  ok(krakenDatedBasis([row(45,{openInterest:"1",volumeQuote:undefined,vol24h:"12"})],t0),"без volumeQuote оборот считается из vol24h × mark");
  ok(krakenDatedBasis([row(45,{openInterest:"496",volumeQuote:"0"})],t0),"OI 496 BTC × 101 000 $ = 50,1 млн $ — порог пройден");
  eq(krakenDatedBasis([row(45,{openInterest:"495",volumeQuote:"0"})],t0),null,"OI 495 BTC × 101 000 $ = 49,995 млн $ — ниже порога");
  eq(krakenDatedBasis([row(45,{suspended:true})],t0),null,"приостановленный контракт не голосует");
  eq(krakenDatedBasis([row(19)],t0),null,"ближе 20 дней до экспирации — вне окна");
  eq(krakenDatedBasis([row(101)],t0),null,"дальше 100 дней — вне окна");
  eq(krakenDatedBasis([row(45,{indexPrice:"0"})],t0),null,"нулевой индекс не делится");
  eq(krakenDatedBasis([{...row(45),symbol:"FI_XBTUSD_"+sym(45).slice(-6)}],t0),null,"инверсные FI-контракты не рассматриваются вовсе");
  eq(krakenDatedBasis([row(80),row(45,{openInterest:"1",volumeQuote:"10"}),row(60)],t0)?.symbol,sym(60),"берётся ближайший ЛИКВИДНЫЙ: неликвидный ближний пропускается, а не выбирается");
  eq(krakenDatedBasis(null,t0),null,"пустой ответ площадки — null, а не исключение");
}
// РЕЕСТР КАНОНА И УДЕРЖАНИЕ ДНЯ (аудит 10.10.2026, C1): чистые функции. Сквозной путь — эпизод
// 20–21.09.2026 на настоящих данных и границы на синтетике — в fallback-test.
{
  const H=36e5,D=864e5,NOWMS=Date.now(),NOON=12*H;
  // Торговые дни от последнего дня, чей канонический момент (полдень UTC) уже наступил: набор не
  // зависит от дня недели и часа прогона.
  const trading=(count,lag=0)=>{const out=[];let idx=Math.floor((NOWMS-NOON)/D);for(let skipped=0;out.length<count;idx--){const t=idx*D;if([0,6].includes(new Date(t).getUTCDay()))continue;if(skipped<lag){skipped++;continue;}out.unshift(t+NOON);}return out;};
  const all=trading(300),val=t=>(1+(Math.floor(t/D)%5))*1e8,canon=lag=>all.slice(0,all.length-lag).map(t=>({t,v:val(t)}));
  const ago=h=>new Date(NOWMS-h*H).toISOString(),last=a=>a[a.length-1];
  const day0=last(all),day1=all[all.length-2],day2=all[all.length-3];

  // --- реестр ---
  const fresh=updateCanonRegistry(null,canon(0),"The Block (tbstat)");
  eq(fresh.map(x=>x.t),all.slice(-5),"в реестр идёт хвост живого канона — пять последних дней");
  ok(fresh.every(x=>x.from==="The Block (tbstat)"&&Math.abs(Date.parse(x.at)-NOWMS)<60_000),"первое принятие помечается текущим моментом и зеркалом");
  const seeded=fresh.map(x=>({...x,at:ago(50)}));
  const again=updateCanonRegistry(seeded,canon(0).map(x=>x.t===day0?{...x,v:9.9e8}:x),"The Block");
  eq(last(again).at,ago(50),"метка первого принятия не освежается повторным приходом дня");
  eq(last(again).from,"The Block (tbstat)","и зеркало первого принятия остаётся прежним");
  eq(last(again).v,9.9e8,"значение дня следует за живым каноном (канон вправе его пересмотреть)");
  // Живой канон стал короче на день: день за его краем остаётся в реестре со своей меткой.
  const shorter=updateCanonRegistry(seeded,canon(1),"The Block");
  eq(shorter.find(x=>x.t===day0),{t:day0,v:val(day0),at:ago(50),from:"The Block (tbstat)"},"день за краем живого канона переносится в реестре без изменений");
  eq(shorter.filter(x=>x.t>day1).length,1,"за краем живого канона — только действительно недостающий день");
  // Реестр забывает день, которого нет в живом каноне, через неделю после принятия.
  const old=d=>seeded.map(x=>x.t===day0?{...x,at:ago(d*24)}:x);
  ok(updateCanonRegistry(old(6.9),canon(1),"The Block").some(x=>x.t===day0),"шесть суток — реестр ещё помнит день");
  ok(!updateCanonRegistry(old(7.1),canon(1),"The Block").some(x=>x.t===day0),"больше недели — реестр обязан забыть день");
  // Зеркала не ответили: реестр только стареет, ничего не добавляется и не освежается.
  eq(updateCanonRegistry(seeded,null,null),seeded,"без живого канона реестр переносится как есть");
  eq(updateCanonRegistry(old(7.1),null,null).some(x=>x.t===day0),false,"и стареет по тому же правилу");
  // Метка принятия из будущего: в живом хвосте переставляется на «сейчас», за краем — запись выбрасывается.
  const future=seeded.map(x=>x.t===day0?{...x,at:new Date(NOWMS+5*H).toISOString()}:x);
  ok(Math.abs(Date.parse(last(updateCanonRegistry(future,canon(0),"The Block")).at)-NOWMS)<60_000,"метка из будущего в живом хвосте заменяется текущим моментом");
  ok(!updateCanonRegistry(future,canon(1),"The Block").some(x=>x.t===day0),"запись за краем канона с меткой из будущего — испорченное состояние");
  eq(updateCanonRegistry([{t:"x"},null,{t:day0,v:1e8}],canon(1),"The Block").filter(x=>x.t>day1),[],"мусор в прошлом реестре отбрасывается, а не роняет сборку");

  // --- удержание ---
  const held=carryCanonDays(canon(1),seeded);
  eq(held.days.map(x=>x.t),[day0],"день за краем живого канона обязан быть удержан");
  eq(last(held.series),{t:day0,v:val(day0)},"в ряд идут метка и значение из реестра");
  eq(held.series.length,canon(0).length,"ряд дорастает ровно до принятого");
  eq(carryCanonDays(canon(0),seeded).days,[],"канон не отстаёт — удерживать нечего");
  const whole=canon(0);
  ok(carryCanonDays(whole,seeded).series===whole&&carryCanonDays(whole,null).series===whole,"без удержания возвращается сам канон, без копии");
  // Догнавший канон вытесняет: день есть в живом каноне — значение реестра в ряд не попадает.
  const rivals=seeded.map(x=>x.t===day0?{...x,v:7.77e8}:x);
  eq(last(carryCanonDays(canon(0),rivals).series).v,val(day0),"значение дня, который канон несёт сам, берётся у канона");
  eq(last(carryCanonDays(canon(1),rivals).series).v,7.77e8,"а пока канон дня не несёт — из реестра");
  // Срок — от первого принятия.
  const at=h=>seeded.map(x=>x.t===day0?{...x,at:ago(h)}:x),ttlH=ETF_CANON_HOLD_TTL/H;
  eq(ttlH,120,"срок удержания — 120 часов");
  eq(carryCanonDays(canon(1),at(ttlH-1)).days.length,1,"за час до срока день удержан");
  eq(carryCanonDays(canon(1),at(ttlH+1)).days.length,0,"через час после срока — нет");
  ok(/срок удержания истёк/.test(carryCanonDays(canon(1),at(ttlH+1)).note||""),"истечение срока обязано быть названо");
  eq(carryCanonDays(canon(1),at(-1)).days.length,0,"метка принятия из будущего не удерживает день");
  ok(ETF_CANON_REGISTRY_TTL>ETF_CANON_HOLD_TTL,"реестр обязан помнить день дольше срока удержания — иначе пометка «ряд короче принятого» исчезнет вместе с удержанием");
  // Предел — по сырому отставанию.
  eq(ETF_CANON_HOLD_MAX_DAYS,3,"предел удержания — три дня");
  eq(carryCanonDays(canon(3),seeded).days.length,3,"ровно на пределе удержание работает");
  eq(carryCanonDays(canon(4),seeded).days.length,0,"за пределом — отменяется целиком, а не урезается до трёх");
  ok(/больше допустимых 3/.test(carryCanonDays(canon(4),seeded).note||""),"причина отмены обязана быть названа");
  // Истёк срок ПОСЛЕДНЕГО из четырёх дней: счёт по уже отсеянному списку дал бы три и пропустил бы перенос.
  eq(carryCanonDays(canon(4),seeded.map(x=>x.t===day0?{...x,at:ago(ttlH+1)}:x)).days.length,0,"предел считается ДО отсева по сроку: истёкший день не уменьшает отставание");
  // Непрерывность: истёкший день в середине обрывает перенос.
  const gap=carryCanonDays(canon(3),seeded.map(x=>x.t===day1?{...x,at:ago(ttlH+1)}:x));
  eq(gap.days.map(x=>x.t),[day2],"перенос обязан оборваться на дне с истёкшим сроком — дыр в ряду не бывает");
  // Тот же ETF-контракт, что у живых данных.
  eq(carryCanonDays(canon(1),seeded.map(x=>x.t===day0?{...x,v:2e10}:x)).days.length,0,"значение вне физической полосы не удерживается");
  ok(/ETF-контракт/.test(carryCanonDays(canon(1),seeded.map(x=>x.t===day0?{...x,v:2e10}:x)).note||""),"отказ контракта обязан быть назван");
  const nextDay=t=>{let x=t+D;while([0,6].includes(new Date(x).getUTCDay()))x+=D;return x;};
  // Послезавтрашний торговый день: в будущем при любом часе прогона (контракт терпит до часа вперёд).
  eq(carryCanonDays(canon(0),[...seeded,{t:nextDay(nextDay(day0)),v:1e8,at:ago(1),from:"The Block"}]).days.length,0,"день из будущего не удерживается");
  eq(carryCanonDays(canon(1),"мусор").days,[],"испорченный реестр не роняет сборку");
  eq(carryCanonDays([],seeded).days,[],"пустой канон — нечего удерживать");
  const frozen=JSON.stringify(seeded);carryCanonDays(canon(2),seeded);eq(JSON.stringify(seeded),frozen,"удержание не мутирует реестр");
  // Ревью 13.10.2026. Негодная метка времени в записи реестра — число вне диапазона Date, строка с
  // числом, выходной, день из будущего — роняла dayKey, а с ним весь адаптер потоков ETF на каждом такте.
  const SAT=(()=>{let t=day0;while(new Date(t).getUTCDay()!==6)t+=D;return t;})();
  for(const [bad,why] of [[1e300,"число вне диапазона Date"],[8.64e15+1,"за пределом Date"],[String(day0),"строка с числом"],[NaN,"NaN"],[Infinity,"бесконечность"],[null,"null"],[SAT-7*D,"суббота"],[NOWMS+2*H,"больше часа вперёд"]]){
    const poisoned=[...seeded.filter(x=>x.t!==day0),{t:bad,v:1e8,at:ago(1),from:"The Block"}];
    let carried,registry;
    try{carried=carryCanonDays(canon(1),poisoned);registry=updateCanonRegistry(poisoned,canon(1),"The Block");}catch(e){ok(false,`запись реестра «${why}» не имеет права ронять удержание: ${e.message}`);continue;}
    eq(carried.days,[],`запись реестра «${why}» не удерживается`);
    ok(registry.every(x=>typeof x.t==="number"&&x.t<=day1),`запись реестра «${why}» в новый реестр не переносится`);
  }
  // Зеркала ставят один и тот же день на разные метки времени (12:00 и 00:00 UTC): сравнение в
  // миллисекундах считало день реестра «за краем» того же дня канона и вписывало его в ряд дважды.
  const midnight=canon(0).map(x=>({t:x.t-NOON,v:x.v}));
  const sameDay=carryCanonDays(midnight,seeded);
  eq(sameDay.days,[],"день, который канон уже несёт под другой меткой времени, не удерживается вторым экземпляром");
  eq(sameDay.series.length,midnight.length,"и ряд не получает дубля дня");
  const lagMidnight=carryCanonDays(midnight.slice(0,-1),seeded);
  eq(lagMidnight.days.map(x=>x.t),[day0-NOON],"удержанный день встаёт на метку времени канона");
  eq(new Set(lagMidnight.series.map(x=>new Date(x.t).toISOString().slice(0,10))).size,lagMidnight.series.length,"в ряду с удержанным днём каждый день один раз");
  const mixed=updateCanonRegistry(seeded,midnight,"The Block");
  eq(mixed.length,5,"реестр при смене метки времени зеркала не раздваивает дни");
  eq(new Set(mixed.map(x=>new Date(x.t).toISOString().slice(0,10))).size,5,"один день — одна запись реестра");

  // --- общий предел хвоста: слой SosoValue получает только остаток ---
  const soso=all.map(t=>({t:t-NOON,v:val(t)})),seen=Object.fromEntries(soso.slice(-2).map(x=>[new Date(x.t).toISOString().slice(0,10),x.v]));
  eq(spliceFreshEtfDays(canon(2),soso,"The Block",{seen}).spliced,2,"без удержанных дней слой вправе добавить оба дня");
  const limited=spliceFreshEtfDays(canon(2),soso,"The Block",{seen,maxAhead:1});
  eq([limited.spliced,limited.reason],[0,"ahead_limit"],"остаток предела меньше опережения — сшивка отменяется целиком");
  ok(/опережение 2 дн больше допустимых 1/.test(limited.note||""),"в причине назван действующий предел, а не константа");
  eq(spliceFreshEtfDays(canon(2),soso,"The Block").reason,"unconfirmed","машинная причина: день не подтверждён");
  eq(spliceFreshEtfDays(canon(2),soso.map(x=>({...x,v:x.v*1.5})),"The Block",{seen:Object.fromEntries(soso.slice(-2).map(x=>[new Date(x.t).toISOString().slice(0,10),x.v*1.5]))}).reason,"drift","машинная причина: расхождение с каноном");
  eq(spliceFreshEtfDays(canon(0),soso,"The Block",{seen}).reason,null,"нечего добавлять — причины отказа нет");
  const cached={days:canon(0).slice(-2),at:ago(2)};
  eq(reviveSplicedDays(canon(2),cached)?.days,2,"кэш подтверждения оживляет оба дня");
  eq(reviveSplicedDays(canon(2),cached,{maxDays:1}),null,"и подчиняется тому же остатку предела");

  // --- ноги и разбор ответа The Block ---
  eq(ETF_LEG_NAMES,["The Block","The Block (tbstat)","SosoValue"],"ноги источника ETF публикуются в порядке резервов");
  const points=[{Timestamp:1791288000,Result:118800000},{Timestamp:1791374400,Result:-487100000}],jf={Frequency:"Daily",Series:{"Total Net Flow":{Data:points}}};
  const want=[{t:1791288000000,v:118800000},{t:1791374400000,v:-487100000}];
  eq(parseEtfFlowJson(JSON.stringify({ok:true,status:"success",message:"Success!",data:{chart:{id:274646,jsonFile:jf},meta:{}},error:""})),want,"новый конверт chart-API (/api/tbco/…) разбирается");
  eq(parseEtfFlowJson(JSON.stringify({chart:{jsonFile:jf}})),want,"прежний конверт chart-API разбирается");
  eq(parseEtfFlowJson(JSON.stringify(jf)),want,"сырой jsonFile зеркала tbstat разбирается");
  let wrapped=null;try{parseEtfFlowJson(JSON.stringify({ok:false,status:"error",error:"Internal error",data:null}));}catch(e){wrapped=e;}
  ok(wrapped&&/The Block API: Internal error/.test(wrapped.message),"отказ, упакованный в HTTP 200, обязан быть ошибкой, а не пустым рядом");
  let gone=null;try{parseEtfFlowJson(JSON.stringify({error:"gone",message:"This endpoint was retired."}));}catch(e){gone=e;}
  ok(gone&&/series not found/.test(gone.message),"тело ответа снятого эндпоинта не принимается за ряд");
  ok(/\/api\/tbco\/charts\/chart\/etfs\/bitcoin\/spot-bitcoin-etf-total-net-flow$/.test(ETF_BLOCK_MIRRORS[0].url),"канонический chart-API обязан стоять на действующем пути: прежний /api/charts/… отвечает HTTP 410");
}
// ===== Правки аудита 10.10.2026: сверка Coin Metrics и новые публикуемые поля =====
// СВЕРКА ПОТОКОВ И ОСТАТКА БИРЖ. Настоящие ряды Coin Metrics за 09.09–09.10.2026 (выгрузка аудита
// 10.10.2026, округление до 0,0001 BTC): приток, отток и остаток размеченных биржевых адресов.
// За 30 дней потоки дают −95,1 тыс. BTC при убыли остатка на 33,4 тыс. — разрыв −61,7 тыс. BTC.
{
  const real=[
    ["2026-09-09",16133.866,18244.1279,2706262.4612],
    ["2026-09-10",20312.3035,25386.1614,2705198.7489],
    ["2026-09-11",23384.4737,23681.5712,2708701.8528],
    ["2026-09-12",10591.2012,10300.7585,2710330.2251],
    ["2026-09-13",10704.6371,12892.1338,2708335.058],
    ["2026-09-14",16625.4325,19800.5635,2707442.1063],
    ["2026-09-15",30402.443,24869.8946,2717458.4078],
    ["2026-09-16",23005.0436,25111.9561,2715643.2525],
    ["2026-09-17",21766.3758,22768.2767,2717241.3493],
    ["2026-09-18",26956.7924,28008.101,2718781.1529],
    ["2026-09-19",13920.3011,15406.4918,2718047.4042],
    ["2026-09-20",12118.4491,12143.1472,2721135.9412],
    ["2026-09-21",39392.9339,43259.9138,2719494.2201],
    ["2026-09-22",26788.4588,43695.2723,2705076.0747],
    ["2026-09-23",22387.6464,32444.5436,2695208.7936],
    ["2026-09-24",19032.1372,26693.4863,2690688.9825],
    ["2026-09-25",22970.3381,30130.2919,2685118.6597],
    ["2026-09-26",11569.6596,17514.5844,2682220.887],
    ["2026-09-27",12578.7996,16041.3058,2682330.4366],
    ["2026-09-28",28047.1338,30287.6579,2683692.0886],
    ["2026-09-29",28302.3625,26433.3226,2686232.3669],
    ["2026-09-30",20094.339,24558.1971,2681920.4978],
    ["2026-10-01",25840.5164,30196.1974,2677736.4631],
    ["2026-10-02",29853.0067,33160.6276,2678292.1956],
    ["2026-10-03",11665.427,16605.9551,2673623.7909],
    ["2026-10-04",13724.1911,15887.1664,2675688.6724],
    ["2026-10-05",28848.8397,31831.5656,2674314.5782],
    ["2026-10-06",22456.818,36668.0087,2660207.4304],
    ["2026-10-07",30978.6367,28172.3452,2663366.6833],
    ["2026-10-08",28184.9344,27937.5964,2665392.0362],
    ["2026-10-09",27171.0752,22909.798,2672865.5577],
  ];
  const D=864e5,t=d=>Date.parse(d+"T00:00:00Z"),pack=rows=>({FlowInExNtv:rows.map(r=>({t:t(r[0]),v:r[1]})),FlowOutExNtv:rows.map(r=>({t:t(r[0]),v:r[2]})),SplyExNtv:rows.map(r=>({t:t(r[0]),v:r[3]}))});
  const got=exchangeFlowSupplyCheck(pack(real));
  eq([got.days,got.as_of],[30,"2026-10-09T00:00:00.000Z"],"окно сверки — 30 суток по последний общий день");
  ok(Math.abs(got.netflow_btc-(-95122.18))<0.01,`сумма потоков за 30 дней: ${got.netflow_btc}`);
  ok(Math.abs(got.supply_change_btc-(-33396.90))<0.01,`изменение остатка за те же 30 дней: ${got.supply_change_btc}`);
  ok(Math.abs(got.gap_btc-(-61725.28))<0.01,`разрыв: ${got.gap_btc}`);
  eq(exchangeFlowSupplyWarning(got),{source:"coinmetrics",code:"exchange_flow_supply_mismatch",value:-61725,threshold:5000,unit:"BTC за 30 дней",
    text:"Потоки бирж расходятся с остатком на 61,7 тыс. BTC за 30 дней",affects:["exchange_supply","exchange_netflow_30d"]},"предупреждение — ровно по контракту снимка");
  // Согласованные ряды (потоки равны изменению остатка) предупреждения не дают.
  const honest=real.map((r,i)=>i?[r[0],r[1],r[1]-(r[3]-real[i-1][3]),r[3]]:r);
  ok(Math.abs(exchangeFlowSupplyCheck(pack(honest)).gap_btc)<1e-6,"при выполненном тождестве разрыв равен нулю");
  eq(exchangeFlowSupplyWarning(exchangeFlowSupplyCheck(pack(honest))),null,"согласованные ряды не предупреждают");
  // Порог — строго больше 5 000 BTC, в обе стороны; знак разрыва сохраняется.
  eq(CM_FLOW_SUPPLY_TOLERANCE_BTC,5000,"допуск сверки — 5 000 BTC");
  const gap=g=>exchangeFlowSupplyWarning({days:30,gap_btc:g});
  eq([gap(5000),gap(-5000)],[null,null],"ровно на допуске предупреждения нет");
  eq([gap(5000.5)?.value,gap(-5000.5)?.value],[5001,-5001],"за допуском — предупреждение со знаком разрыва");
  eq(gap(5200)?.text,"Потоки бирж расходятся с остатком на 5,2 тыс. BTC за 30 дней","в тексте — модуль разрыва в тысячах с запятой");
  eq([gap(NaN),gap(null),exchangeFlowSupplyWarning(null)],[null,null,null],"без измерения предупреждения нет");
  // Метрики публикуются не одновременно: край окна — последний день, где есть все три ряда.
  const lagging=pack(real);lagging.FlowInExNtv=lagging.FlowInExNtv.slice(0,-1);
  eq(exchangeFlowSupplyCheck(lagging,{days:29}).as_of,"2026-10-08T00:00:00.000Z","край окна — последний общий день трёх рядов");
  eq(exchangeFlowSupplyCheck(lagging),null,"на полное окно не хватает базы — измерения нет, а не ложная тревога");
  // Дыра в потоках внутри окна — не расхождение.
  const holed=pack(real);holed.FlowOutExNtv=holed.FlowOutExNtv.filter(x=>x.t!==t("2026-09-25"));
  eq(exchangeFlowSupplyCheck(holed),null,"пропущенный день потока обнуляет сверку, а не превращается в разрыв");
  eq([exchangeFlowSupplyCheck(null),exchangeFlowSupplyCheck({}),exchangeFlowSupplyCheck({SplyExNtv:[]})],[null,null,null],"пустой пакет — нет измерения");
}

// УРОВНИ MVRV НА ПОРОГАХ ПРАВИЛ. Уровень — значение, при пересечении которого перцентиль текущей точки
// (тот самый percentileRank, что в карточке) пересекает порог правила. Проверяется перебором: чуть
// ниже уровня правило нижней стороны выполняется, чуть выше — нет; для верхней стороны наоборот.
{
  let seed=20261010;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  const rules={lte:(p,x)=>p<=x,lt:(p,x)=>p<x,gte:(p,x)=>p>=x};
  let checked=0;
  for(const n of [30,45,50,200,731,1460,1461]){
    const window=Array.from({length:n},()=>.4+rnd()*3);
    for(const [percentile,rule] of [[10,"lte"],[25,"lt"],[82,"gte"],[95,"gte"]]){
      const level=mvrvLevelAt(window,percentile,rule);
      ok(Number.isFinite(level),`уровень обязан находиться: n=${n}, p=${percentile}`);
      const at=v=>rules[rule](percentileRank([...window.slice(0,-1),v],v),percentile),eps=1e-9;
      if(rule==="gte"){ok(at(level+eps)&&!at(level-eps),`верхняя сторона: выше уровня правило ≥${percentile} выполняется, ниже — нет (n=${n})`);}
      else ok(at(level-eps)&&!at(level+eps),`нижняя сторона: ниже уровня правило ${rule==="lte"?"≤":"<"}${percentile} выполняется, выше — нет (n=${n})`);
      checked++;
    }
  }
  eq(checked,28,"перебор уровней выполнен на всех окнах");
  eq(mvrvLevelAt(Array(29).fill(1),10,"lte"),null,"короче 30 точек перцентиля нет — нет и уровня");
  eq(VALUATION_LEVELS.map(x=>[x.key,x.percentile,x.rule]),[["capitulation_floor",10,"lte"],["recovery_anchor",25,"lt"],["valuation_gate",82,"gte"],["euphoria",95,"gte"]],"пороги правил v1 по MVRV");

  // Сборка поля: окно — четыре года от последней точки (как у карточки), цена уровня — через
  // реализованную цену дня наблюдения MVRV.
  const D=864e5,end=Date.UTC(2026,9,9),days=1700;
  const mvrv=Array.from({length:days},(_,i)=>({t:end-(days-1-i)*D,v:i<200?.05+i*1e-4:.8+((i*7919)%1000)/500}));   // первые 200 точек — вне окна и абсурдно низкие
  mvrv[days-1].v=1.5343;
  const price=[{t:end-D,v:81690.49},{t:end,v:82545},{t:end+D,v:82766}];
  const levels=buildValuationLevelsV1({mvrvSeries:mvrv,priceSeries:price});
  eq([levels.as_of,levels.mvrv,levels.window_days],["2026-10-09T00:00:00.000Z",1.5343,1460],"дата и значение — последняя точка MVRV, окно — четыре года");
  eq(levels.realized_price_usd,Math.round(82545/1.5343),"реализованная цена = закрытие дня наблюдения MVRV / MVRV (не живая цена и не соседний день)");
  const inWindow=mvrv.slice(-1461).map(x=>x.v);
  eq(levels.levels.map(x=>x.mvrv),[[10,"lte"],[25,"lt"],[82,"gte"],[95,"gte"]].map(([p,r])=>Math.round(mvrvLevelAt(inWindow,p,r)*1e4)/1e4),"уровни считаются по окну карточки: точки старше четырёх лет в него не входят");
  ok(levels.levels.every(x=>x.price_usd===Math.round(mvrvLevelAt(inWindow,x.percentile,VALUATION_LEVELS.find(y=>y.key===x.key).rule)*(82545/1.5343))),"цена уровня = уровень MVRV × реализованная цена");
  ok(levels.levels[0].mvrv>.5,"абсурдно низкие точки вне окна на порог капитуляции не влияют");
  eq(optionalFieldProblemsV1("valuation_levels",levels),[],"поле проходит контракт публичного снимка");
  const noPrice=buildValuationLevelsV1({mvrvSeries:mvrv,priceSeries:price.filter(x=>x.t!==end)});
  eq([noPrice.realized_price_usd,noPrice.levels.map(x=>x.price_usd)],[null,[null,null,null,null]],"нет закрытия дня наблюдения — уровни MVRV есть, цен нет");
  ok(noPrice.levels.every(x=>Number.isFinite(x.mvrv)),"уровни MVRV от цены не зависят");
  eq(buildValuationLevelsV1({mvrvSeries:mvrv.slice(-20),priceSeries:price}),null,"слишком короткий ряд — поля нет");
  eq(buildValuationLevelsV1({mvrvSeries:[],priceSeries:price}),null,"нет ряда — поля нет");
}

// РОЖДЕНИЕ КАНДИДАТА И РАЗНИЦА СНИМКОВ.
{
  const card=(id,block,family,score,o={})=>({id,block,family,name:`карточка ${id}`,vote:true,strategic:true,tactical:false,score,value_num:score,...o});
  const metricsAt=(o={})=>[
    card("liquidity_regime","macro","liquidity",o.liquidity??0,{tactical:true}),
    card("etf_regime","demand","etf",o.etf??-.5,{tactical:true}),
    card("institutional_quality","demand","institutional",o.institutional??0),
    card("mvrv_cycle","cycle","valuation",0,{value_num:o.mvrv??42.4}),
    card("carry_regime","leverage","carry",o.carry??0,{strategic:false,tactical:true}),
    card("etf_20d","demand","etf",null,{vote:false}),
  ];
  const blocksAt=demand=>({macro:{strategic:{score:-8.333333333333332}},demand:{strategic:{score:demand}},cycle:{strategic:{score:30}}});
  const detectorsAt=(o={})=>["integrity","leverage","demand_break","macro_shock","distribution","short_squeeze","recovery"].map(id=>({id,state:o[id]||"calm"}));
  const meta=(s,t)=>({strategic:{candidate:s},tactical:{candidate:t}});
  const now=Date.parse("2026-09-18T19:38:51.492Z");
  // Снимок 18.09.2026 19:38: отчёт CFTC поднял семью institutional с −1 до 0, блок спроса вышел из
  // неблагоприятной полосы, кандидат сменился с «ухудшается» на «переходный» (пример из SPEC 1.1).
  const before={metrics:metricsAt({institutional:-1}),blocks:blocksAt(-31.25),detectors:detectorsAt({recovery:"watch"}),regime_meta:meta("deteriorating","balanced")};
  const args={previous:before,now,price:81092.7,regimeMeta:meta("transition","balanced"),metrics:metricsAt(),blocks:blocksAt(-18.75),detectors:detectorsAt({recovery:"good"})};
  const birth=buildRegimeBirthV1(args);
  eq(birth.strategic,{t:"2026-09-18T19:38:51.492Z",candidate:"transition",from_candidate:"deteriorating",price:81092.7,
    blocks:{demand:{from:-31.25,to:-18.75,band_from:"adverse",band_to:"neutral"}},
    families:[{block:"demand",family:"institutional",id:"institutional_quality",name:"карточка institutional_quality",from:-1,to:0}],
    detectors:[{id:"recovery",from:"watch",to:"good"}],note:null},"рождение среднесрочного кандидата: только изменившиеся блоки, семьи и детекторы");
  eq(birth.tactical,null,"краткосрочный кандидат не менялся и перенести нечего — null");
  eq(optionalFieldProblemsV1("regime_birth",birth),[],"запись проходит контракт публичного снимка");
  // Пока кандидат тот же, запись ПЕРЕНОСИТСЯ из прошлого снимка без изменений — что бы ни менялось вокруг.
  const later={...args,previous:{...before,metrics:metricsAt({etf:-1}),regime_meta:meta("transition","balanced"),regime_birth:birth},now:now+5*36e5,price:79000,metrics:metricsAt({etf:1}),blocks:blocksAt(-6.25)};
  eq(buildRegimeBirthV1(later).strategic,birth.strategic,"запись о рождении переносится, пока кандидат тот же");
  // Ревью 13.10.2026: запись с меткой позже такта (часы шагнули назад, испорченное состояние) не переносится —
  // самопроверка живого кандидата отвергала бы снимок на каждом такте до смены кандидата.
  eq(buildRegimeBirthV1({...later,previous:{...later.previous,regime_birth:{...later.previous.regime_birth,strategic:{...birth.strategic,t:new Date(later.now+60_000).toISOString()}}}}).strategic,null,"запись о рождении из будущего не переносится");
  eq(buildRegimeBirthV1({...later,previous:{...later.previous,regime_birth:{...later.previous.regime_birth,strategic:{...birth.strategic,t:new Date(later.now).toISOString()}}}}).strategic?.t,new Date(later.now).toISOString(),"запись с меткой ровно этого такта переносится");
  eq(buildRegimeBirthV1({...later,previous:{...later.previous,regime_birth:undefined}}).strategic,null,"прошлый снимок без записи (состояние прежней версии) — null до следующей смены кандидата");
  eq(buildRegimeBirthV1({...later,previous:{...later.previous,regime_birth:{strategic:{...birth.strategic,candidate:"defensive"}}}}).strategic,null,"перенесённая запись о ДРУГОМ кандидате не годится");
  // Краткосрочный горизонт: блоков нет, семьи — только краткосрочные голосующие, детекторы — только его.
  const tact=buildRegimeBirthV1({...args,previous:{...before,metrics:metricsAt({institutional:-1,carry:0,liquidity:1}),detectors:detectorsAt({leverage:"watch",recovery:"watch"}),regime_meta:meta("transition","balanced")},
    regimeMeta:meta("transition","fragile"),metrics:metricsAt({carry:-2}),detectors:detectorsAt({leverage:"fired",recovery:"good"})}).tactical;
  eq([tact.candidate,tact.from_candidate,"blocks" in tact],["fragile","balanced",false],"краткосрочная запись: без блоков");
  eq(tact.families.map(x=>[x.id,x.from,x.to]),[["liquidity_regime",1,0],["carry_regime",0,-2]],"в краткосрочную запись идут только краткосрочные голосующие карточки (institutional — нет)");
  eq(tact.detectors,[{id:"leverage",from:"watch",to:"fired"}],"и только детекторы краткосрочного контура (recovery — нет)");
  // Кандидат сменился, а баллы и детекторы — нет: покрытие или аварийный режим.
  const coverage=buildRegimeBirthV1({...args,previous:{...before,metrics:metricsAt(),blocks:blocksAt(-18.75),detectors:detectorsAt({recovery:"good"})},regimeMeta:meta("insufficient","balanced")}).strategic;
  eq([coverage.candidate,coverage.note,coverage.families,coverage.detectors,coverage.blocks],["insufficient","coverage",[],[],{}],"смена кандидата без изменения баллов помечается как покрытие");
  // Холодный старт и несравнимое прошлое.
  eq(buildRegimeBirthV1({...args,previous:null}),null,"холодный старт — null");
  eq(buildRegimeBirthV1({...args,previous:{regime_meta:meta("deteriorating","balanced")}}),null,"прошлый снимок без карточек — сравнивать не с чем");
  eq(buildRegimeBirthV1({...args,previous:{...before,mock:true}}),null,"прошлый снимок на синтетике с боевым не сравнивается");
  ok(buildRegimeBirthV1({...args,previous:{...before,mock:true},mock:true}),"синтетика с синтетикой — сравнивается");

  // Разница снимков: все голосующие семьи обоих горизонтов, все детекторы, перцентиль MVRV.
  const diff=buildTickDiffV1({previous:{metrics:metricsAt({institutional:-1,carry:-1,mvrv:19.5}),detectors:detectorsAt({leverage:"watch",recovery:"good"})},metrics:metricsAt({mvrv:27.2}),detectors:detectorsAt()});
  eq(diff.families.map(x=>[x.block,x.family,x.id,x.from,x.to]),[["demand","institutional","institutional_quality",-1,0],["leverage","carry","carry_regime",-1,0]],"изменившиеся семьи обоих горизонтов");
  eq(diff.detectors,[{id:"leverage",from:"watch",to:"calm"},{id:"recovery",from:"good",to:"calm"}],"изменившиеся детекторы");
  eq(diff.mvrv_percentile,{from:19.5,to:27.2},"перцентиль MVRV — когда изменился (20.08.2026 именно он снял пол 80 %)");
  eq(optionalFieldProblemsV1("tick_diff",diff),[],"разница проходит контракт публичного снимка");
  const quiet=buildTickDiffV1({previous:{metrics:metricsAt(),detectors:detectorsAt()},metrics:metricsAt(),detectors:detectorsAt()});
  eq(quiet,{families:[],detectors:[]},"ничего не изменилось — пустые списки и никакого перцентиля");
  eq(buildTickDiffV1({previous:null,metrics:metricsAt(),detectors:detectorsAt()}),null,"холодный старт — null");
  const vanished=buildTickDiffV1({previous:{metrics:metricsAt(),detectors:detectorsAt()},metrics:metricsAt().map(x=>x.id==="etf_regime"?{...x,score:null}:x),detectors:detectorsAt()});
  eq(vanished.families.map(x=>[x.id,x.from,x.to]),[["etf_regime",-.5,null]],"пропавший балл — тоже изменение: было число, стало null");
}

// ПРЕДУПРЕЖДЕНИЯ О ДАННЫХ.
{
  const T=Date.parse("2026-10-13T12:00:00.000Z"),MIN=60_000,ago=min=>new Date(T-min*MIN).toISOString();
  // Ноги: "ok" либо [код отказа, сколько минут нога уже лежит] (без второго числа — без метки since).
  const legs=(...states)=>["The Block","The Block (tbstat)","SosoValue"].slice(0,states.length).map((name,i)=>states[i]==="ok"?{name,state:"ok"}:{name,state:"fail",error:`HTTP ${[].concat(states[i])[0]}`,...([].concat(states[i])[1]===undefined?{}:{since:ago([].concat(states[i])[1])})});
  const warn=(etfLegs,o={})=>buildDataWarningsV1({etfLegs,now:T,...o});
  eq(ETF_REDUNDANCY_CONFIRM_MS,45*MIN,"резерв должен отсутствовать 45 минут подряд");
  eq(warn(legs([410,5000],"ok",[404,6000])),[{source:"etf",code:"redundancy_lost",alive:1,total:3,since:ago(5000),text:"Потоки ETF идут с одного источника из трёх",affects:["etf_regime"]}],"одна живая нога из трёх дольше порога — потеря резерва (положение 10.10.2026); резерва нет с момента ВТОРОГО отказа");
  eq(warn(legs("ok","ok",[404,6000])),[],"две живые ноги — резерв есть, предупреждения нет");
  eq(warn(legs("ok","ok","ok")),[]);
  // Ревью 13.10.2026: зеркало моргнуло на такт-два — предупреждение не ставится.
  eq(warn(legs([503,0],"ok",[404,6000])),[],"зеркало не ответило в этом такте — ещё не потеря резерва");
  eq(warn(legs([503,30],"ok",[404,6000])),[],"полчаса без резерва — ещё нет");
  eq(warn(legs([503,44],"ok",[404,6000])),[]);
  eq(warn(legs([503,45],"ok",[404,6000])).map(x=>[x.code,x.since]),[["redundancy_lost",ago(45)]],"ровно порог — предупреждение есть, и оно называет начало");
  eq(warn(legs([503,6000],"ok",[404,10])),[],"счёт идёт от отказа, ПОСЛЕ которого живая нога осталась одна, а не от самого давнего");
  eq(warn(legs([503],"ok",[404])),[],"ноги без метки начала считаются отказавшими только что");
  eq(warn(legs([503,-10],"ok",[404,6000])),[],"метка начала из будущего — серия считается начавшейся сейчас");
  eq(warn(legs([503,100],[503,60],[503,50]))[0].text,"Ни один из трёх источников потоков ETF не ответил");
  eq(warn(legs([503,100],[503,60],[503,50]))[0].since,ago(60),"без резерва — с отказа предпоследней ноги");
  eq(warn(legs("ok",[503,90]))[0].text,"Потоки ETF идут с одного источника из двух");
  eq(buildDataWarningsV1({}),[],"нет ног и нет сверки — нет предупреждений");
  // Метка начала серии переносится, пока нога лежит, и сбрасывается удачным ответом.
  const first=annotateEtfLegOutagesV1(legs([503],"ok",[404]),null,T);
  eq(first.map(x=>x.since),[ago(0),undefined,ago(0)],"первый отказ помечается текущим моментом; живая нога метки не несёт");
  const second=annotateEtfLegOutagesV1(legs([503],"ok",[404]),first,T+15*MIN);
  eq(second.map(x=>x.since),[ago(0),undefined,ago(0)],"нога лежит второй такт — начало серии прежнее");
  const healed=annotateEtfLegOutagesV1(legs("ok","ok",[404]),second,T+30*MIN);
  eq(healed.map(x=>x.since),[undefined,undefined,ago(0)],"ответившая нога метку теряет");
  eq(annotateEtfLegOutagesV1(legs([503],"ok",[404]),healed,T+45*MIN).map(x=>x.since),[ago(-45),undefined,ago(0)],"новый отказ — новая серия");
  eq(annotateEtfLegOutagesV1(legs([503]),[{name:"The Block",state:"fail",since:ago(-600)}],T)[0].since,ago(0),"метка из будущего в прошлом снимке заменяется текущим моментом");
  eq(annotateEtfLegOutagesV1(legs([503]),[{name:"The Block",state:"fail",since:"мусор"}],T)[0].since,ago(0));
  eq(annotateEtfLegOutagesV1(legs([503]),"мусор",T)[0].since,ago(0),"негодный прошлый список не роняет сборку");
  eq(annotateEtfLegOutagesV1(null,first,T),null);
  // Сквозная серия на такте 15 минут: моргание в один и два такта молчит, отказ дольше порога — нет.
  { let prev=null;const seen=[];for(const [i,state] of [[0,"ok"],[1,[503]],[2,"ok"],[3,[503]],[4,[503]],[5,"ok"],[6,[503]],[7,[503]],[8,[503]],[9,[503]],[10,"ok"]]){const now=T+i*15*MIN,cur=annotateEtfLegOutagesV1(legs(state,"ok",[404]),prev,now);seen.push(buildDataWarningsV1({etfLegs:cur,now}).length);prev=cur;}
    eq(seen,[0,0,0,0,0,0,0,0,0,1,0],"одиночный и двойной сбой зеркала предупреждения не дают; на четвёртом такте подряд оно появляется и снимается первым же ответом"); }
  const both=buildDataWarningsV1({etfLegs:legs([410,5000],"ok",[404,6000]),flowSupplyCheck:{days:30,gap_btc:-61725.28},now:T});
  eq(both.map(x=>x.code),["exchange_flow_supply_mismatch","redundancy_lost"],"порядок предупреждений постоянный");
  eq(optionalFieldProblemsV1("data_warnings",both),[],"предупреждения проходят контракт публичного снимка");
  eq(optionalFieldProblemsV1("etf_legs",legs([410,5000],"ok",[404])),[],"ноги проходят контракт публичного снимка");
  ok(optionalFieldProblemsV1("etf_legs",[{name:"The Block",state:"ok",since:ago(5)}]).length===1,"у живой ноги метки начала отказа не бывает");
  ok(optionalFieldProblemsV1("etf_legs",[{name:"The Block",state:"fail",error:"HTTP 503",since:"вчера"}]).length===1,"метка начала отказа — дата");
  ok(optionalFieldProblemsV1("data_warnings",[{source:"etf",code:"redundancy_lost",text:"т",affects:[],since:5}]).length===1,"начало условия в предупреждении — дата");
}

// ВХОДЫ ДВИЖКА ТЕНЕВЫХ ВАРИАНТОВ (SPEC 1.4): форма.
{
  const rows=[{t:1,v:2}];
  const got=buildVariantInputsV1({price:82766,hardOverride:null,regime:{strategic:"transition",tactical:"balanced"},regimeMeta:{strategic:{candidate:"transition"}},candidates:{criticalStrategic:true,criticalTactical:false},decision:{target_pct:45},
    metrics:[{id:"mvrv_cycle",value_num:42.4,score:0},{id:"liquidity_regime",observed_at:"l"},{id:"system_stress",observed_at:"s"}],detectors:[{id:"recovery",state:"watch"},{id:"macro_shock",state:"fired"}],
    blocks:{macro:{strategic:{expected:["liquidity","conditions","stress"],families:{liquidity:0,conditions:-2,stress:-.5}}},demand:{strategic:{expected:["etf","stablecoins","exchange_supply","institutional"],families:{etf:-.5,stablecoins:0,institutional:0}}},cycle:{strategic:{expected:["valuation","network","activity","miners","trend"],families:{valuation:0,network:0,activity:.5,miners:0,trend:2}}}},
    series:{hashrate:rows,difficulty:rows,exchange_supply:rows,price_daily:rows,mvrv:rows,mvrv_deep:[]},observedAt:{mvrv:"m",coinmetrics:"c",etf:"e",network:"n",market:"k"}});
  eq(got,{price:82766,hard_override:false,
    v1:{state:"transition",candidate:"transition",critical_ok:true,target_pct:45,recovery_state:"watch",macro_shock_state:"fired",distribution_state:"calm",mvrv_percentile:42.4,valuation_score:0},
    families:{macro:{liquidity:0,conditions:-2,stress:-.5},demand:{etf:-.5,stablecoins:0,exchange_supply:null,institutional:0},cycle:{valuation:0,network:0,activity:.5,miners:0,trend:2}},
    series:{hashrate:rows,difficulty:rows,exchange_supply:rows,price_daily:rows,mvrv:rows,mvrv_deep:null},
    observed_at:{mvrv:"m",coinmetrics:"c",etf:"e",network:"n",market:"k",mvrv_deep:null,macro_liquidity:"l",macro_conditions:null,macro_stress:"s"}},"входы вариантов — ровно по SPEC 1.4: семьи с null на месте отсутствующей, пустой глубокий ряд — null; даты макрокарточек — с самих карточек, отсутствующая — null");
  const bare=buildVariantInputsV1({});
  eq([bare.price,bare.hard_override,bare.v1.state,bare.v1.critical_ok,bare.v1.target_pct,bare.v1.recovery_state,bare.series.mvrv_deep,bare.families],[null,false,null,false,null,"calm",null,{macro:{},demand:{},cycle:{}}],"пустой вход не роняет сборку и не выдумывает значений");
  eq(buildVariantInputsV1({hardOverride:"НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА"}).hard_override,true,"аварийный режим передаётся флагом");
}

// КОНТРАКТ НЕОБЯЗАТЕЛЬНЫХ ПОЛЕЙ: отсутствие — законно, порча — нет.
{
  for(const name of ["regime_birth","tick_diff","valuation_levels","data_warnings","diagnostics","etf_legs"]){
    eq(optionalFieldProblemsV1(name,null),[],`${name}: null — законное «нет данных»`);
    eq(optionalFieldProblemsV1(name,undefined),[],`${name}: поля нет — претензий нет`);
    ok(optionalFieldProblemsV1(name,"мусор").length>0,`${name}: строка вместо структуры обязана отвергаться`);
  }
  eq(optionalSnapshotProblemsV1({}),[],"снимок прежней формы (без новых полей) проходит");
  eq(optionalSnapshotProblemsV1({regime_birth:null,tick_diff:null,valuation_levels:null,data_warnings:[],diagnostics:[],sources:{etf:{}}}),[],"холодный старт проходит");
  const bad=p=>p.join(" | ");
  ok(/candidate/.test(bad(optionalFieldProblemsV1("regime_birth",{strategic:{t:"2026-09-18T19:38:51.492Z",candidate:"undefined",from_candidate:"transition",price:1,blocks:{},families:[],detectors:[],note:null}}))),"неизвестная метка режима отвергается");
  ok(/from и to/.test(bad(optionalFieldProblemsV1("tick_diff",{families:[{block:"demand",family:"etf",id:"etf_regime",name:"x",from:0,to:0}],detectors:[]}))),"«изменение» без изменения отвергается");
  ok(/состояния детектора/.test(bad(optionalFieldProblemsV1("tick_diff",{families:[],detectors:[{id:"recovery",from:"calm",to:"хорошо"}]}))),"неизвестное состояние детектора отвергается");
  const good={as_of:"2026-10-09T00:00:00.000Z",mvrv:1.5343,realized_price_usd:53800,window_days:1460,levels:[{key:"capitulation_floor",percentile:10,mvrv:1.165,price_usd:62677},{key:"recovery_anchor",percentile:25,mvrv:1.331,price_usd:71608}]};
  eq(optionalFieldProblemsV1("valuation_levels",good),[]);
  ok(/не убывать/.test(bad(optionalFieldProblemsV1("valuation_levels",{...good,levels:[good.levels[0],{...good.levels[1],mvrv:1.1,price_usd:59180}]}))),"уровень на большем перцентиле ниже уровня на меньшем — отвергается");
  ok(/реализованная цена/.test(bad(optionalFieldProblemsV1("valuation_levels",{...good,levels:[{...good.levels[0],price_usd:70000}]}))),"цена, не равная уровню × реализованная цена, отвергается");
  ok(/source, code и text/.test(bad(optionalFieldProblemsV1("data_warnings",[{code:"x"}]))),"предупреждение без текста отвергается");
  ok(/ok или fail/.test(bad(optionalFieldProblemsV1("etf_legs",[{name:"The Block",state:"partial"}]))),"нога в неизвестном состоянии отвергается");
  ok(/причина/.test(bad(optionalFieldProblemsV1("etf_legs",[{name:"The Block",state:"fail"}]))),"отказавшая нога без причины отвергается");
  // Бюджет размера: поле, раздувшееся сверх потолка, не публикуется.
  const fat={families:Array.from({length:400},(_,i)=>({block:"demand",family:"etf",id:`m${i}`,name:"х".repeat(40),from:0,to:1})),detectors:[]};
  ok(/байт при бюджете/.test(bad(optionalFieldProblemsV1("tick_diff",fat))),"поле сверх бюджета размера отвергается");
  ok(Object.values(OPTIONAL_FIELD_MAX_BYTES).reduce((a,b)=>a+b,0)<=40_000,"сумма потолков необязательных полей — не больше 40 КБ из 3 МБ публичного снимка");
  const sized=optionalSnapshotBytesV1({regime_birth:null,tick_diff:{families:[],detectors:[]},data_warnings:[],sources:{etf:{legs:[{name:"The Block",state:"ok"}]}}});
  ok(sized.total===sized.regime_birth+sized.tick_diff+sized.data_warnings+sized.etf_legs&&sized.total>0,"учёт размера складывается из полей, которые есть в снимке");
}

// НАБОР mvrv_deep: проводка в collect(). Поведение загрузчика — в fallback-test; здесь закреплены три
// свойства вызова, без которых набор либо понижает качество решения, либо стучится в источник каждый
// такт: он не решающий, загрузчик получает кэш, между попытками — не меньше часа. И порядок: после
// основного пакета Coin Metrics, с которым загрузчик сверяется.
{
  const call=/loadDataset\("mvrv_deep"[^\n]*/.exec(src)?.[0]||"";
  ok(/,fetchMvrvDeep,/.test(call)&&/decisionRelevant:false/.test(call)&&/cacheAware:true/.test(call)&&/minFetchInterval:1\*HOUR/.test(call)&&/maxObservedAge:5\*DAY/.test(call),`вызов loadDataset("mvrv_deep") изменился: ${call}`);
  ok(src.indexOf('loadDataset("mvrv_deep"')>src.indexOf('loadDataset("coinmetrics"'),"mvrv_deep обязан грузиться после основного пакета Coin Metrics");
  ok(selfSrc.includes("mvrv_deep:24*5"),"гейт публикации обязан знать возраст набора mvrv_deep");
}
// ТЕНЕВАЯ КАРТОЧКА «OI · СУТОЧНЫЙ СБРОС»: ЦЕНА И OI ОТ ОДНОЙ БАЗЫ. Раньше OI сравнивался со снимком
// 22 часа назад, а цена — с полуночью UTC (в 09:53 это 9,9 часа) под общей подписью «24ч».
{
  const H=36e5,now=Date.UTC(2026,9,10,9,53),mk=(hoursAgo,over={})=>({t:new Date(now-hoursAgo*H).toISOString(),price:80000+hoursAgo*10,raw:{oi_by_venue:{Deribit:1e9+hoursAgo*1e6,OKX:2e9}},...over});
  // Такт 15 минут, записи от 30 до 20 часов назад: цена и OI у каждой свои, чтобы база была опознаваема.
  const hist=[];for(let m=30*60;m>=20*60;m-=15)hist.push(mk(m/60));
  const nowOi={Deribit:.9e9,OKX:2e9},args={oiNowByVenue:nowOi,priceNow:82766,now};
  const got=oiPurgeWindow(hist,args);
  eq(got.base_t,new Date(now-24*H).toISOString(),"база — снимок ровно сутки назад, а не самый свежий старше 22 часов");
  eq(got.label,"24ч","подпись окна — фактический возраст базы");
  ok(Math.abs(got.pricePct-(82766/(80000+240)-1)*100)<1e-9,`цена обязана сравниваться с ценой той же записи: ${got.pricePct}`);
  ok(Math.abs(got.oiPct-((.9e9+2e9)/(1e9+24e6+2e9)-1)*100)<1e-9,`OI обязан сравниваться с OI той же записи: ${got.oiPct}`);
  // Пауза публикации: ближайшая запись — 26 часов назад. Окно называется своим именем.
  const gap=oiPurgeWindow(hist.filter(h=>Date.parse(h.t)<=now-26*H),args);
  eq(gap.label,"26ч","после паузы подпись называет настоящее окно");
  ok(Math.abs(gap.pricePct-(82766/(80000+260)-1)*100)<1e-9,"и цена, и OI берутся от этой же записи");
  // Дальше трёх часов от суток базы нет: карточка пуста, а не меряет другое окно.
  const far=oiPurgeWindow(hist.filter(h=>Date.parse(h.t)<=now-27.25*H),args);
  eq([far.oiPct,far.pricePct,far.base_t],[null,null,null],"дальше ±3 часов от суток окна нет");
  eq(oiPurgeWindow(hist.filter(h=>Date.parse(h.t)>=now-20.75*H),args).oiPct,null,"слишком свежая запись тоже не база");
  // Запись без цены или без OI в базу не годится — берётся ближайшая полная.
  const holes=hist.map(h=>Date.parse(h.t)===now-24*H?{...h,price:null}:Date.parse(h.t)===now-24.25*H?{t:h.t,price:h.price}:h);
  eq(oiPurgeWindow(holes,args).base_t,new Date(now-23.75*H).toISOString(),"неполная запись пропускается, база — ближайшая полная");
  // Общих площадок меньше двух — изменения OI нет, но цена от той же базы остаётся.
  const single=oiPurgeWindow(hist,{...args,oiNowByVenue:{Deribit:1e9}});
  eq(single.oiPct,null,"одна общая площадка не даёт изменения OI");
  ok(Number.isFinite(single.pricePct),"цена при этом считается от той же базы");
  eq(oiPurgeWindow(null,args).label,"24ч","без истории окно пустое, подпись — номинальная");
}
// РЯД ОБЪЁМА — ТОЛЬКО ЗАКРЫТЫЕ СУТКИ. Граница — полночь UTC текущего дня; строка ровно на ней
// принадлежит идущим суткам. Момент «сейчас» задаётся явно, поэтому проверка не зависит от часа прогона.
{
  const D=864e5,midnight=Date.UTC(2026,9,10),rows=[midnight-2*D,midnight-D,midnight-1,midnight,midnight+5*36e5].map(t=>({t,v:1}));
  eq(closedDaysOnly(rows,midnight+9*36e5).map(x=>x.t),[midnight-2*D,midnight-D,midnight-1],"в ряду остаются только строки закрытых суток");
  eq(closedDaysOnly(rows,midnight).map(x=>x.t),[midnight-2*D,midnight-D,midnight-1],"ровно в полночь новые сутки уже открыты");
  eq(closedDaysOnly(rows,midnight-1).map(x=>x.t),[midnight-2*D],"за миллисекунду до полуночи вчерашние сутки ещё идут и в ряд не входят");
  eq(closedDaysOnly(null,midnight),[],"пустой вход не роняет разбор");
}

if(fail.length){console.error("Unit tests failed:\n- "+fail.join("\n- "));process.exit(1)}

// Observation freshness rejects future-dated data as well as stale data.
assert.equal(validObservationAge({observed_at:new Date(Date.now()+2*3600000).toISOString()},24*3600000),false,"future observation rejected");
assert.equal(validObservationAge({observed_at:new Date(Date.now()-2*3600000).toISOString()},24*3600000),true,"fresh observation accepted");

console.log("Unit tests OK");
