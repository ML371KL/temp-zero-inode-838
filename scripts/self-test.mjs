import { readFileSync, statSync, existsSync } from "node:fs";

const path=process.env.OUT||"docs/snapshot.json";
const statePath=process.env.STATE||".state/cache.json";
const s=JSON.parse(readFileSync(path,"utf8"));
const pkg=JSON.parse(readFileSync("package.json","utf8"));
const internalRaw=existsSync(statePath)?JSON.parse(readFileSync(statePath,"utf8")):null;
// A state cache written by ANOTHER engine version is stale by definition: right after a version
// bump the first CI run restores the previous release's cache while docs/snapshot.json already
// carries the new release. Deep cross-checks between artifacts of two different engines are
// meaningless — treat this exactly like an absent cache (skip deep checks, warn), instead of
// failing "out of sync" and making every release un-shippable on its first run. The candidate
// verification step (step 5 of the workflow) is unaffected: there OUT and STATE always come from
// the same build.
const snapshotForSync=JSON.parse(readFileSync(path,"utf8"));
// Any version/timestamp desync between the state cache and the snapshot means the pair is not from
// one build (interrupted commit step, cache re-save from a failed run, manual release). Deep
// cross-checks between mismatched builds are meaningless AND must not brick the hourly pipeline:
// treat the cache as stale (skip deep checks, warn). Under REQUIRE_LIVE the candidate pair is
// always written by the same build, so a desync there still fails hard below.
const staleInternal=internalRaw&&(String(internalRaw.version||"")!==String(pkg.version||"")||internalRaw.generated_at!==snapshotForSync.generated_at)&&process.env.REQUIRE_LIVE!=="1";
const hasInternal=!!internalRaw&&!staleInternal;
const internal=hasInternal?internalRaw:null;
const fail=[],warn=[];
const strictFinite=x=>x!==null&&x!==undefined&&x!==""&&Number.isFinite(Number(x));
const isDate=x=>typeof x==="string"&&!Number.isNaN(Date.parse(x));
const ageHours=x=>(Date.now()-Date.parse(x))/36e5;
const sorted=a=>(a||[]).every((x,i)=>i===0||Number(x.t)>=Number(a[i-1].t));
const last=a=>a?.length?a[a.length-1]:null;
const requiredBlocks=["macro","demand","cycle","leverage","market"];
const allowedSourceStates=new Set(["ok","partial","stale","fail","mock"]);
// ВНИМАНИЕ: пороги обязаны совпадать с FRED_SERIES[*].ttl в коллекторе — unit-test это проверяет.
// Рассинхрон не «мягкая» ошибка: коллектор примет наблюдение, self-test под REQUIRE_LIVE отвергнет
// кандидата, и сайт замрёт на прошлом снимке до конца недели.
const sourceMaxAgeH={
  fred_WALCL:24*14,fred_WTREGEN:24*14,fred_RRPONTSYD:24*7,fred_DFII10:24*7,
  fred_DGS2:24*7,fred_DGS10:24*7,fred_DTWEXBGS:24*14,fred_BAMLH0A0HYM2:24*7,
  fred_VIXCLS:24*7,fred_VXVCLS:24*7,fred_NASDAQ100:24*7,
  coinmetrics:24*4,blockchain_onchain:24*4,market:24*4,network:24*4,etf:24*7,stablecoins:24*4,pegs:18,cftc:24*15,derivatives:18,spot:18,
};

if(s.schema!==2)fail.push("schema must be 2");
if(String(s.version||"")!==String(pkg.version||""))fail.push(`snapshot/package version mismatch:${s.version}/${pkg.version}`);
if(!isDate(s.generated_at))fail.push("generated_at invalid");
if(!isDate(s.price_observed_at))fail.push("price_observed_at invalid");
if(process.env.REQUIRE_LIVE==="1"&&s.mock)fail.push("workflow produced mock snapshot");
if(process.env.REQUIRE_LIVE==="1"&&!strictFinite(s.price))fail.push("live snapshot has no valid BTC price");
if(process.env.REQUIRE_LIVE==="1"&&s.regime?.strategic==="insufficient"&&s.regime?.tactical==="insufficient")fail.push("both live regimes are insufficient; preserve previous published snapshot");
if(process.env.REQUIRE_COMPLETE==="1"&&[s.regime?.strategic,s.regime?.tactical].includes("insufficient"))fail.push("live candidate has an insufficient regime; preserve previous published snapshot");
if(!s.thesis||String(s.thesis).length<40)fail.push("thesis missing");
if(!s.verdict||!s.behavior)fail.push("verdict/behavior missing");
if(!s.regime?.strategic||!s.regime?.tactical)fail.push("regime missing");
if(!s.scores||!(strictFinite(s.scores.strategic)||s.regime?.strategic==="insufficient")||!(strictFinite(s.scores.tactical)||s.regime?.tactical==="insufficient"))fail.push("scores invalid/inconsistent");
if(!strictFinite(s.scores?.onchain_coverage)||Number(s.scores.onchain_coverage)<0||Number(s.scores.onchain_coverage)>1)fail.push("onchain coverage invalid");
if(!["full","partial","minimal"].includes(s.scores?.onchain_status))fail.push("onchain status invalid");
if(!Array.isArray(s.metrics)||s.metrics.length<25)fail.push("metrics<25");
if(!Array.isArray(s.detectors)||s.detectors.length<6)fail.push("detectors<6");
if(!s.blocks||Object.keys(s.blocks).length!==5)fail.push("five blocks required");
if(!s.sources||!Object.keys(s.sources).length)fail.push("source states missing");
if(s.datasets!==undefined)fail.push("public snapshot must not contain raw datasets");
if(hasInternal&&(!internal.datasets||typeof internal.datasets!=="object"))fail.push("internal datasets missing");
if(hasInternal&&(internal.generated_at!==s.generated_at||internal.version!==s.version))fail.push("public snapshot and internal state are out of sync");
if(!Array.isArray(s.history))fail.push("history missing");
else {
  const ht=s.history.map(h=>Date.parse(h?.t));
  if(ht.some(t=>!Number.isFinite(t)||t>Date.now()+3600000))fail.push("history contains invalid/future timestamp");
  if(ht.some((t,i)=>i>0&&t<ht[i-1]))fail.push("history is not chronological");
  if(s.history.length>5000)fail.push("history unexpectedly large");
}

for(const b of requiredBlocks){
  const block=s.blocks?.[b];
  if(!block){fail.push(`block missing:${b}`);continue;}
  for(const h of ["strategic","tactical"]){
    const x=block[h],weight=Number(block[`${h}Weight`]||0);
    if(!x||!strictFinite(x.coverage)){fail.push(`bad block coverage:${b}.${h}`);continue;}
    if(Number(x.coverage)<0||Number(x.coverage)>1)fail.push(`coverage range:${b}.${h}`);
    if(weight>0&&Number(x.coverage)>0&&!strictFinite(x.score))fail.push(`missing weighted block score:${b}.${h}`);
    if(weight===0&&x.score!==null&&!strictFinite(x.score))fail.push(`bad unweighted score:${b}.${h}`);
  }
}

const forbidden=/\b(NUPL|SOPR|STH|LTH|GEX|max pain|liquidation heatmap|CVD|Fear\s*&\s*Greed|Google Trends|Pi Cycle|Stock-to-Flow|Fibonacci|CME gap)\b/i;
const ids=new Set(),families=new Set();
for(const m of s.metrics||[]){
  if(!m||typeof m!=="object"){fail.push("non-object metric");continue;}
  const mot=Date.parse(m.observed_at||"");
  if(Number.isFinite(mot)&&mot>Date.now()+3600000)fail.push(`metric observed_at in future:${m.id}`);
  if(!m.id||ids.has(m.id))fail.push(`duplicate/bad id:${m.id}`);else ids.add(m.id);
  if(!requiredBlocks.includes(m.block))fail.push(`bad block:${m.id}`);
  if(!m.family||!m.name||!m.source)fail.push(`metadata missing:${m.id}`);
  if(!["dynamic","mechanical","derived","mixed"].includes(m.method))fail.push(`bad method:${m.id}`);
  if(m.vote){
    families.add(`${m.block}:${m.family}`);
    if(m.score!==null&&(!strictFinite(m.score)||Number(m.score)<-2||Number(m.score)>2))fail.push(`bad vote score:${m.id}`);
    if(m.score===null)warn.push(`voting metric unavailable:${m.id}`);
    if(m.stale===true)warn.push(`voting metric stale/partial:${m.id}`);
  }
  if(forbidden.test(`${m.id} ${m.name}`))fail.push(`forbidden/research metric:${m.id}`);
  if(m.observed_at&&!isDate(m.observed_at))fail.push(`bad observed_at:${m.id}`);
  if(m.source_url&&!/^https:\/\//.test(m.source_url))fail.push(`non-https source:${m.id}`);
  if(!Array.isArray(m.source_urls)||!m.source_urls.length||m.source_urls.some(u=>!/^https:\/\//.test(u)))fail.push(`bad source_urls:${m.id}`);
  else if(m.source_url&&!m.source_urls.includes(m.source_url))fail.push(`primary source missing from source_urls:${m.id}`);
  if(Array.isArray(m.series)&&!sorted(m.series))fail.push(`unsorted metric series:${m.id}`);
}
if(families.size!==20)fail.push(`voting families must be 20:${families.size}`);

for(const d of s.detectors||[]){
  if(!d.id||!d.name||!["calm","watch","fired","good"].includes(d.state))fail.push(`bad detector:${d.id}`);
}

for(const [k,state] of Object.entries(s.sources||{})){
  const sot=Date.parse(state?.observed_at||"");
  const sft=Date.parse(state?.fetched_at||"");
  if(Number.isFinite(sot)&&sot>Date.now()+3600000)fail.push(`source observed_at in future:${k}`);
  if(Number.isFinite(sft)&&sft>Date.now()+3600000)fail.push(`source fetched_at in future:${k}`);
  if(!allowedSourceStates.has(state?.state))fail.push(`bad source state:${k}`);
  if(state?.url&&!/^https:\/\//.test(state.url))fail.push(`bad source url:${k}`);
  if(!Array.isArray(state?.urls)||!state.urls.length||state.urls.some(u=>!/^https:\/\//.test(u)))fail.push(`bad source urls:${k}`);
  else if(state?.url&&!state.urls.includes(state.url))fail.push(`primary source absent from urls:${k}`);
  if(/docs\.coinmetrics\.io\/api\/v4/i.test(state?.url||""))fail.push(`obsolete Coin Metrics documentation url:${k}`);
  if(/coinmetrics-io\/data/i.test(state?.url||""))fail.push(`legacy Coin Metrics repository url:${k}`);
  if(state?.observed_at&&!isDate(state.observed_at))fail.push(`bad source observed_at:${k}`);
  if(!s.mock&&["ok","partial","stale"].includes(state?.state)){
    const limit=sourceMaxAgeH[k];
    if(limit&&(!state.observed_at||ageHours(state.observed_at)>limit+1)){
      // Freshness is a hard gate only for the live candidate. For the previously published snapshot
      // it is a warning: a publishing gap must heal on the next successful collection, not brick
      // every subsequent run before it can even collect.
      if(process.env.REQUIRE_LIVE==="1")fail.push(`source observation too old:${k}:${state.observed_at}`);
      else warn.push(`published source aged beyond limit (heals on next collection):${k}:${state.observed_at}`);
    }
  }
}


if((s.sources?.derivatives?.urls||[]).length<3)fail.push("derivatives source state must expose three documentation links");
if((s.sources?.spot?.urls||[]).length<5)fail.push("spot source state must expose five documentation links");

const requiredSourceKeys=["fred_WALCL","fred_WTREGEN","fred_RRPONTSYD","fred_DFII10","market","network","etf","stablecoins","pegs","cftc","derivatives","spot"];
for(const k of requiredSourceKeys)if(!s.sources?.[k])fail.push(`critical source state absent:${k}`);

if(!hasInternal){
  warn.push(staleInternal?`internal cache is from engine v${internalRaw.version} (current v${pkg.version}); deep dataset checks skipped until the next collector run`:"internal cache absent; deep dataset checks skipped");
}else{
  for(const [k,d] of Object.entries(internal.datasets||{})){
    const dot=Date.parse(d?.observed_at||"");
    const dft=Date.parse(d?.fetched_at||"");
    if(Number.isFinite(dot)&&dot>Date.now()+3600000)fail.push(`dataset observed_at in future:${k}`);
    if(Number.isFinite(dft)&&dft>Date.now()+3600000)fail.push(`dataset fetched_at in future:${k}`);
    if(!d||!isDate(d.observed_at)||!isDate(d.fetched_at))fail.push(`bad dataset metadata:${k}`);
    if(d?.source_url&&!/^https:\/\//.test(d.source_url))fail.push(`bad dataset source_url:${k}`);
    if(!Array.isArray(d?.source_urls)||!d.source_urls.length||d.source_urls.some(u=>!/^https:\/\//.test(u)))fail.push(`bad dataset source_urls:${k}`);
    if(Array.isArray(d?.data)&&d.data.length&&d.data[0]?.t!==undefined&&!sorted(d.data))fail.push(`unsorted dataset:${k}`);
  }

  for(const id of ["WALCL","WTREGEN","RRPONTSYD","DFII10","DGS2","DGS10","DTWEXBGS","BAMLH0A0HYM2","VIXCLS","VXVCLS","NASDAQ100"]){
    const d=internal.datasets?.[`fred_${id}`];
    if(d?.data?.length){
      const latest=d.data[d.data.length-1]?.t;
      if(!strictFinite(latest)||Math.abs(Date.parse(d.observed_at)-Number(latest))>36e5)fail.push(`FRED observed/latest mismatch:${id}`);
    }
  }

  const cm=internal.datasets?.coinmetrics?.data;
  // Coin Metrics is an enrichment layer: no series is required. Anything present must still be
  // fresh and sorted — a stale series silently kept alive is worse than an absent one.
  const cmRequired=[];
  const cmOptional=["CapMVRVCur","FlowInExNtv","FlowOutExNtv","SplyExNtv","IssTotUSD","FeeTotNtv","AdrActCnt","TxCnt","TxTfrCnt"];
  for(const k of cmRequired){
    if(!Array.isArray(cm?.[k])||cm[k].length<500)fail.push(`Coin Metrics critical series missing:${k}`);
    else {if(!sorted(cm[k]))fail.push(`Coin Metrics series unsorted:${k}`);const age=Date.now()-Number(cm[k][cm[k].length-1]?.t);if(age>4*864e5+36e5)fail.push(`Coin Metrics critical series stale:${k}`);}
  }
  for(const k of cmOptional){
    if(Array.isArray(cm?.[k])&&cm[k].length){if(cm[k].length<180)fail.push(`Coin Metrics optional series too short:${k}`);if(!sorted(cm[k]))fail.push(`Coin Metrics optional series unsorted:${k}`);const age=Date.now()-Number(cm[k][cm[k].length-1]?.t);if(age>4*864e5+36e5)fail.push(`Coin Metrics optional series retained while stale:${k}`);}
  }

  // The two vendor-independent legs must always be real.
  const mkt=internal.datasets?.market?.data;
  if(!Array.isArray(mkt?.price)||mkt.price.length<1200)fail.push("market price history missing or too short");
  else{if(!sorted(mkt.price))fail.push("market price series unsorted");const age=Date.now()-Number(last(mkt.price)?.t);if(age>4*864e5+36e5)fail.push("market price series stale");}
  if(mkt&&!["coingecko","blockchain","window"].includes(mkt.athSource))fail.push("ATH provenance must be declared");
  const nw=internal.datasets?.network?.data;
  if(!Array.isArray(nw?.hashrate)||nw.hashrate.length<300)fail.push("network hashrate history missing or too short");
  else if(!sorted(nw.hashrate))fail.push("network hashrate series unsorted");
  // A constructive verdict without valuation data is exactly the reflexive trap the model exists to
  // avoid: trend and flows alone must never produce optimism.
  if(s.scores?.valuation_available===false&&["constructive","unconfirmed_positive"].includes(s.regime?.strategic))fail.push("optimistic verdict issued without valuation data");

  const pegData=internal.datasets?.pegs?.data||{},pegMetric=(s.metrics||[]).find(x=>x.id==="stablecoin_peg");
  const completePeg=["USDT","USDC"].every(k=>strictFinite(pegData[k])&&Number(pegData[k])>.01&&Number(pegData[k])<5);
  if(!completePeg&&pegMetric?.score!==null)fail.push("incomplete peg coverage must not receive a score");
  for(const k of ["USDT","USDC"])if(strictFinite(pegData[k])&&(Number(pegData[k])<=.01||Number(pegData[k])>=5))fail.push(`invalid peg value:${k}`);
  const spotData=internal.datasets?.spot?.data||{};
  for(const [venue,value] of Object.entries(spotData))if(strictFinite(value)&&(Number(value)<=1_000||Number(value)>=10_000_000))fail.push(`invalid spot value:${venue}`);
  const spotObserved=Date.parse(internal.datasets?.spot?.observed_at||"");
  // The headline price must be the median of the live USD quote group — never a stale daily close
  // and never a USD/USDT blend.
  const usdGroup=["coinbase","kraken","bitstamp","gemini"].map(k=>spotData[k]).filter(strictFinite).map(Number).sort((a,b)=>a-b);
  if(usdGroup.length>=2){const mid=Math.floor(usdGroup.length/2),med=usdGroup.length%2?usdGroup[mid]:(usdGroup[mid-1]+usdGroup[mid])/2;
    if(!strictFinite(s.price)||Math.abs(Number(s.price)/med-1)>.02)fail.push("headline price must use the live USD quote group median");
    if(Number.isFinite(spotObserved)&&Date.now()-spotObserved<=6*36e5&&Math.abs(Date.parse(s.price_observed_at)-spotObserved)>1000)fail.push("price_observed_at must follow fresh spot packet");}
  const spotMetric=(s.metrics||[]).find(x=>x.id==="spot_integrity");
  const quoteGroups={USD:["coinbase","kraken","bitstamp","gemini"],USDT:["okx","kraken_usdt","coinbase_usdt"]};
  const aliveInGroup=g=>quoteGroups[g].filter(k=>strictFinite(spotData[k])).length;
  const bothSpotPairs=["USD","USDT"].every(g=>aliveInGroup(g)>=2);
  if(!bothSpotPairs&&Number(spotMetric?.score)>0)fail.push("incomplete spot quote groups must not receive a positive integrity score");

  const etf=internal.datasets?.etf?.data;
  if(Array.isArray(etf)){
    if(!sorted(etf))fail.push("ETF series unsorted");
    if(!s.mock){
      if(etf.some(x=>[0,6].includes(new Date(Number(x.t)).getUTCDay())))fail.push("ETF series contains weekend row");
      if(etf.some(x=>!strictFinite(x?.v)||Math.abs(Number(x.v))>10_000_000_000))fail.push("ETF series contains implausible flow");
      const latest=Number(etf[etf.length-1]?.t);if(!strictFinite(latest)||Date.now()-latest>7*864e5+36e5)fail.push("ETF series stale");
    }
  }

  if(s.regime?.strategic==="insufficient"&&!/НЕДОСТАТОЧНО ДАННЫХ/i.test(s.verdict||""))fail.push("strategic insufficiency not visible in verdict");
  if(s.regime?.tactical==="insufficient"&&!/НЕДОСТАТОЧНО ДАННЫХ/i.test(s.verdict||""))fail.push("tactical insufficiency not visible in verdict");
  if(s.scores?.critical_coverage_ok===false&&!/недостаточ|данн|покрыт/i.test(`${s.verdict} ${s.behavior?.short} ${s.behavior?.medium}`))fail.push("verdict ignores critical coverage");


  const latestHistory=Array.isArray(internal.history)&&internal.history.length?internal.history[internal.history.length-1]:null;
  if(s.sources?.derivatives&&["ok","partial","stale","mock"].includes(s.sources.derivatives.state)){
    const by=latestHistory?.raw?.oi_by_venue;
    if(!by||Object.values(by).filter(strictFinite).length<2)warn.push("latest history has fewer than two venue-specific OI values");
  }

}

if(Array.isArray(s.history)){
  if(s.history.length>5000)fail.push("history too large");
  if(!s.history.every((x,i)=>isDate(x.t)&&(i===0||Date.parse(x.t)>=Date.parse(s.history[i-1].t))))fail.push("history not chronological");
}

if(!s.mock){
  const age=ageHours(s.generated_at);
  if(age>12)warn.push(`snapshot age ${age.toFixed(1)}h`);
  if(Object.values(s.sources).every(x=>x.state==="fail"))fail.push("all live sources failed");
}
const bytes=statSync(path).size;
if(bytes>2_500_000)warn.push(`snapshot is large: ${(bytes/1e6).toFixed(2)} MB`);

if(fail.length){console.error("Snapshot validation failed:\n- "+fail.join("\n- "));process.exit(1);}
console.log(`Snapshot OK: ${s.metrics.length} metrics, ${families.size} voting families, ${s.detectors.length} detectors, ${Object.keys(s.sources||{}).length} source states, ${(bytes/1e6).toFixed(2)} MB`);
if(warn.length)console.warn("Warnings:\n- "+warn.join("\n- "));
