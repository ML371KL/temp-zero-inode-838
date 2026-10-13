import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The base snapshot for these tests is ALWAYS generated in isolation.
// It must never be docs/snapshot.json: in the workflow that file has already been overwritten with
// a LIVE snapshot by the collector, so `expectFail("mock live")` would see mock:false, self-test
// would legitimately pass, and the negative suite would fail on every successful production run —
// silently blocking the publish step forever. The mock base keeps these guards environment-independent.
const generatedBasePath=join(tmpdir(),`btc21m-negative-base-${process.pid}.json`),generatedStatePath=join(tmpdir(),`btc21m-negative-base-state-${process.pid}.json`);
const built=spawnSync(process.execPath,[fileURLToPath(new URL("./fetch-snapshot.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,MOCK:"1",OUT:generatedBasePath,STATE:generatedStatePath}});
if(built.status!==0)throw new Error(`could not create isolated mock state for negative tests:\n${built.stdout||""}${built.stderr||""}`);
const base=JSON.parse(readFileSync(generatedBasePath,"utf8"));
const stateBase=JSON.parse(readFileSync(generatedStatePath,"utf8"));

const path=join(tmpdir(),`btc21m-negative-${process.pid}.json`),statePath=join(tmpdir(),`btc21m-negative-state-${process.pid}.json`);
function expectFail(name,mutate,pattern,live=false){
  const x=structuredClone(base),state=structuredClone(stateBase);mutate(x,state);writeFileSync(path,JSON.stringify(x));writeFileSync(statePath,JSON.stringify(state));
  const r=spawnSync(process.execPath,[fileURLToPath(new URL("./self-test.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,OUT:path,STATE:statePath,...(live?{REQUIRE_LIVE:"1"}:{})}});
  const text=(r.stdout||"")+(r.stderr||"");
  if(r.status===0||!pattern.test(text))throw new Error(`${name} was not rejected as expected:\n${text}`);
}
try{
  expectFail("mock live",x=>{},/mock snapshot/i,true);
  expectFail("missing price",x=>{x.mock=false;x.price=null},/no valid BTC price/i,true);
  expectFail("double insufficiency",x=>{x.mock=false;x.regime.strategic="insufficient";x.regime.tactical="insufficient";x.verdict="НЕДОСТАТОЧНО ДАННЫХ"},/both live regimes are insufficient/i,true);
  {
    const x=structuredClone(base),state=structuredClone(stateBase);x.mock=false;x.regime.strategic="insufficient";x.verdict="НЕДОСТАТОЧНО ДАННЫХ";writeFileSync(path,JSON.stringify(x));writeFileSync(statePath,JSON.stringify(state));
    const r=spawnSync(process.execPath,[fileURLToPath(new URL("./self-test.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,OUT:path,STATE:statePath,REQUIRE_LIVE:"1",REQUIRE_COMPLETE:"1"}});
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

  // НЕОБЯЗАТЕЛЬНЫЕ ПОЛЯ (правки аудита 10.10.2026). Для живого кандидата порча поля — отказ: его
  // писал этот же код и этим же контрактом уже проверил. Для ранее опубликованного снимка —
  // предупреждение: проверка закоммиченного снимка стоит перед сбором и не имеет права остановить
  // конвейер из-за справочного поля. Снимок прежней формы (без полей) обязан проходить.
  {
    const live=(name,mutate,pattern)=>expectFail(name,(x,state)=>{x.mock=false;mutate(x,state);},pattern,true);
    live("malformed regime_birth",x=>{x.regime_birth={strategic:{t:"вчера",candidate:"undefined"}};},/optional field invalid: regime_birth/i);
    live("malformed tick_diff",x=>{x.tick_diff={families:"x",detectors:[]};},/optional field invalid: tick_diff/i);
    live("malformed valuation_levels",x=>{x.valuation_levels={...x.valuation_levels,levels:[]};},/optional field invalid: valuation_levels/i);
    live("malformed data_warnings",x=>{x.data_warnings=[{code:"x"}];},/optional field invalid: data_warnings/i);
    live("malformed diagnostics",x=>{x.diagnostics=[{scope:"x"}];},/optional field invalid: diagnostics/i);
    live("malformed ETF legs",x=>{x.sources.etf.legs=[{name:"The Block",state:"maybe"}];},/optional field invalid: sources\.etf\.legs/i);
    live("regime_birth about another candidate",x=>{const now=x.regime_meta.strategic.candidate,other=now==="defensive"?"transition":"defensive";x.regime_birth={strategic:{t:x.generated_at,candidate:other,from_candidate:now,price:1,blocks:{},families:[],detectors:[],note:"coverage"},tactical:null};},/regime_birth\.strategic describes candidate/i);
    live("data warning about an unknown metric",x=>{x.data_warnings=[{source:"x",code:"y",text:"z",affects:["нет_такой_карточки"]}];},/points at an unknown metric/i);
    live("valuation level contradicting the MVRV card",x=>{const m=x.metrics.find(y=>y.id==="mvrv_cycle");m.value_num=m.value_num<50?99:1;},/contradicts the MVRV card/i);

    const expectPass=(name,mutate,pattern=null)=>{
      const x=structuredClone(base),state=structuredClone(stateBase);mutate(x,state);writeFileSync(path,JSON.stringify(x));writeFileSync(statePath,JSON.stringify(state));
      const r=spawnSync(process.execPath,[fileURLToPath(new URL("./self-test.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,OUT:path,STATE:statePath}});
      const text=(r.stdout||"")+(r.stderr||"");
      if(r.status!==0||(pattern&&!pattern.test(text)))throw new Error(`${name} must pass the published-snapshot check${pattern?" with a warning":""}:\n${text}`);
    };
    expectPass("mock snapshot with the new fields",()=>{});
    expectPass("old-form snapshot without optional fields",x=>{for(const key of ["regime_birth","tick_diff","valuation_levels","data_warnings","diagnostics"])delete x[key];delete x.sources.etf.legs;});
    expectPass("cold-start snapshot",x=>{x.regime_birth=null;x.tick_diff=null;x.valuation_levels=null;x.data_warnings=[];});
    expectPass("malformed optional field in a published snapshot",x=>{x.tick_diff="мусор";},/optional field invalid: tick_diff[^\n]*heals on next collection/i);
    expectPass("failed optional calculation is reported",x=>{x.regime_birth=null;x.diagnostics=[{scope:"regime_birth",error:"TypeError: boom"}];},/optional calculations failed: regime_birth: TypeError: boom/i);
  }
} finally {try{unlinkSync(path)}catch{}try{unlinkSync(statePath)}catch{}try{unlinkSync(generatedBasePath)}catch{}try{unlinkSync(generatedStatePath)}catch{}}

// stabilize(): a stale optimistic anchor must never outrank today's candidate. Craft a previous
// state that sat in an outage with anchor=constructive while the mock candidate is defensive:
// the published regime must follow the candidate (risk-off is fast), not the resurrected anchor.
{
  const prevPath=join(tmpdir(),`btc21m-anchor-prev-${process.pid}.json`),outPath=join(tmpdir(),`btc21m-anchor-out-${process.pid}.json`),statePath2=join(tmpdir(),`btc21m-anchor-state-${process.pid}.json`);
  const old=new Date(Date.now()-3*3600e3).toISOString();
  writeFileSync(prevPath,JSON.stringify({mock:false,version:"0.0.0",generated_at:old,regime:{strategic:"insufficient",tactical:"insufficient"},regime_meta:{strategic:{candidate:"insufficient",count:3,since:old,anchor:"constructive",downStreak:0},tactical:{candidate:"insufficient",count:3,since:old,anchor:"balanced",downStreak:0}},history:[]}));
  const r=spawnSync(process.execPath,[fileURLToPath(new URL("./fetch-snapshot.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,MOCK:"1",OUT:outPath,STATE:statePath2,PREVIOUS_STATE:prevPath,PREVIOUS_PUBLIC:prevPath}});
  if(r.status!==0)throw new Error(`anchor scenario build failed:\n${r.stdout||""}${r.stderr||""}`);
  const snap=JSON.parse(readFileSync(outPath,"utf8"));
  if(snap.regime.strategic==="constructive")throw new Error(`stale optimistic anchor resurrected: published ${snap.regime.strategic} while candidate was ${snap.regime_meta.strategic.candidate}`);
  try{unlinkSync(prevPath)}catch{}try{unlinkSync(outPath)}catch{}try{unlinkSync(statePath2)}catch{}
}
console.log("Negative validation tests OK");
