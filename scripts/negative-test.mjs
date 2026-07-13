import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
// The base snapshot for these tests is ALWAYS generated in isolation.
// It must never be docs/snapshot.json: in the workflow that file has already been overwritten with
// a LIVE snapshot by the collector, so `expectFail("mock live")` would see mock:false, self-test
// would legitimately pass, and the negative suite would fail on every successful production run —
// silently blocking the publish step forever. The mock base keeps these guards environment-independent.
const generatedBasePath=`/tmp/btc21m-negative-base-${process.pid}.json`,generatedStatePath=`/tmp/btc21m-negative-base-state-${process.pid}.json`;
const built=spawnSync(process.execPath,[new URL("./fetch-snapshot.mjs",import.meta.url).pathname],{encoding:"utf8",env:{...process.env,MOCK:"1",OUT:generatedBasePath,STATE:generatedStatePath}});
if(built.status!==0)throw new Error(`could not create isolated mock state for negative tests:\n${built.stdout||""}${built.stderr||""}`);
const base=JSON.parse(readFileSync(generatedBasePath,"utf8"));
const stateBase=JSON.parse(readFileSync(generatedStatePath,"utf8"));

const path=`/tmp/btc21m-negative-${process.pid}.json`,statePath=`/tmp/btc21m-negative-state-${process.pid}.json`;
function expectFail(name,mutate,pattern,live=false){
  const x=structuredClone(base),state=structuredClone(stateBase);mutate(x,state);writeFileSync(path,JSON.stringify(x));writeFileSync(statePath,JSON.stringify(state));
  const r=spawnSync(process.execPath,[new URL("./self-test.mjs",import.meta.url).pathname],{encoding:"utf8",env:{...process.env,OUT:path,STATE:statePath,...(live?{REQUIRE_LIVE:"1"}:{})}});
  const text=(r.stdout||"")+(r.stderr||"");
  if(r.status===0||!pattern.test(text))throw new Error(`${name} was not rejected as expected:\n${text}`);
}
try{
  expectFail("mock live",x=>{},/mock snapshot/i,true);
  expectFail("missing price",x=>{x.mock=false;x.price=null},/no valid BTC price/i,true);
  expectFail("double insufficiency",x=>{x.mock=false;x.regime.strategic="insufficient";x.regime.tactical="insufficient";x.verdict="НЕДОСТАТОЧНО ДАННЫХ"},/both live regimes are insufficient/i,true);
  {
    const x=structuredClone(base),state=structuredClone(stateBase);x.mock=false;x.regime.strategic="insufficient";x.verdict="НЕДОСТАТОЧНО ДАННЫХ";writeFileSync(path,JSON.stringify(x));writeFileSync(statePath,JSON.stringify(state));
    const r=spawnSync(process.execPath,[new URL("./self-test.mjs",import.meta.url).pathname],{encoding:"utf8",env:{...process.env,OUT:path,STATE:statePath,REQUIRE_LIVE:"1",REQUIRE_COMPLETE:"1"}});
    const text=(r.stdout||"")+(r.stderr||"");if(r.status===0||!/insufficient regime/i.test(text))throw new Error(`single insufficient regime was not rejected:\n${text}`);
  }
  expectFail("future source",x=>{x.sources.spot.observed_at=new Date(Date.now()+2*3600e3).toISOString()},/source observed_at in future:spot/i);
  expectFail("insecure URL",x=>{x.metrics[0].source_url="http://example.com"},/non-https source/i);
  expectFail("insecure source URL array",x=>{x.metrics[0].source_urls=["https://example.com","http://example.com"]},/bad source_urls/i);
  expectFail("missing source URL array",x=>{x.sources.spot.urls=[]},/bad source urls:spot/i);
  expectFail("duplicate metric",x=>{x.metrics[1].id=x.metrics[0].id},/duplicate\/bad id/i);
  expectFail("incomplete peg scored healthy",(x,state)=>{delete state.datasets.pegs.data.USDC;const m=x.metrics.find(y=>y.id==="stablecoin_peg");m.score=1},/incomplete peg coverage/i);
  expectFail("invalid secondary spot quote",(x,state)=>{state.datasets.spot.data.okx=100},/invalid spot value:okx/i);
  expectFail("incomplete spot scored healthy",(x,state)=>{for(const k of ["okx","bybit","kraken_usdt","coinbase_usdt"])state.datasets.spot.data[k]=null;const m=x.metrics.find(y=>y.id==="spot_integrity");m.score=1},/incomplete spot quote groups/i);
  expectFail("stale market price series",(x,state)=>{const a=state.datasets.market.data.price;a[a.length-1].t=Date.now()-10*864e5},/market price series stale/i);
  expectFail("undeclared ATH provenance",(x,state)=>{state.datasets.market.data.athSource="guess"},/ATH provenance must be declared/i);
  expectFail("optimism without valuation",(x,state)=>{x.scores.valuation_available=false;x.regime.strategic="constructive"},/optimistic verdict issued without valuation/i);
  expectFail("stale optional Coin Metrics series retained",(x,state)=>{const a=state.datasets.coinmetrics.data.CapMVRVCur;a[a.length-1].t=Date.now()-10*864e5},/Coin Metrics optional series retained while stale:CapMVRVCur/i);
} finally {try{unlinkSync(path)}catch{}try{unlinkSync(statePath)}catch{}try{unlinkSync(generatedBasePath)}catch{}try{unlinkSync(generatedStatePath)}catch{}}
console.log("Negative validation tests OK");
