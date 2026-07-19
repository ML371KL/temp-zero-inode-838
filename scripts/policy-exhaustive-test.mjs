import assert from "node:assert/strict";
import { ACTION_GATE_V1, evaluateActionGateV1 } from "../docs/action-gate-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "../docs/policy-v1.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, sha256, sourceRevisionAlertsV1, treasuryBillDiscountToEffectiveAnnualPct, updateForwardMonitorV1 } from "./forward-monitor-v1.mjs";
import { severity, stabilizeCore } from "./fetch-snapshot.mjs";

const HOUR=3_600_000,T0=Date.parse("2026-07-19T00:00:00.000Z");
let scenarios=0;
const same=(actual,expected,message)=>{scenarios++;assert.deepEqual(actual,expected,message);};
const ok=(condition,message)=>{scenarios++;assert.ok(condition,message);};
const tacticalStates=["spot_led","balanced","demand_break","overheated_supported","fragile","deleveraging","short_squeeze","insufficient","emergency"];
const strategicStates=[...POLICY_V1.strategic_order,"insufficient","unknown"];

// 1. Every discrete allocation state and every continuous threshold equivalence class.
const recoveryStates=[undefined,"calm","watch","good"],macroStates=[undefined,"calm","watch","fired"];
const mvrvValues=[null,NaN,-Infinity,-100,0,9.999,10,10.001,50,94.999,95,95.001,100,200,Infinity];
function referenceAllocation(strategic,recoveryState,macroShockState,mvrvPercentile){
  const inputs={strategic,recovery_state:recoveryState??"calm",macro_shock_state:macroShockState??"calm",mvrv_percentile:Number.isFinite(mvrvPercentile)?Number(mvrvPercentile):null};
  if(strategic==="insufficient")return{status:"paused",base_target_pct:null,target_pct:null,binding_overlays:[],reason_codes:["insufficient_data"],inputs};
  if(strategic==="emergency")return{status:"actionable",base_target_pct:0,target_pct:0,binding_overlays:["emergency_override"],reason_codes:["base:emergency","emergency_override"],inputs};
  const base=POLICY_V1.ladder[strategic];
  if(!Number.isFinite(base))return{status:"paused",base_target_pct:null,target_pct:null,binding_overlays:[],reason_codes:["unknown_strategic_regime"],inputs};
  let target=base;const binding=[];
  if(recoveryState==="good"&&macroShockState!=="fired"&&target<80){target=80;binding.push("recovery_floor");}
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile<=10&&target<40){target=40;binding.push("capitulation_floor");}
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile>=95&&target>60){target=60;binding.push("euphoria_safety_cap");}
  return{status:"actionable",base_target_pct:base,target_pct:target,binding_overlays:binding,reason_codes:[`base:${strategic}`,...binding],inputs};
}
for(const strategic of strategicStates)for(const recoveryState of recoveryStates)for(const macroShockState of macroStates)for(const mvrvPercentile of mvrvValues){
  same(allocationDecisionV1({strategic,recoveryState,macroShockState,mvrvPercentile}),referenceAllocation(strategic,recoveryState,macroShockState,mvrvPercentile),`allocation mismatch: ${strategic}/${recoveryState}/${macroShockState}/${mvrvPercentile}`);
}

// 2. All detector-overlay combinations. The reference follows the frozen precedence explicitly.
const detectorStates=["calm","watch","fired"],recoveryDetectorStates=["calm","watch","good"];
for(const strategic of strategicStates)for(const macroShockState of detectorStates)for(const distributionState of detectorStates)for(const recoveryState of recoveryDetectorStates){
  let expected=strategic;
  const optimistic=["constructive","unconfirmed_positive","transition"];
  if(macroShockState==="fired"&&optimistic.includes(expected))expected="deteriorating";
  if(distributionState==="fired"&&optimistic.includes(expected))expected="deteriorating";
  if(recoveryState==="good"&&macroShockState!=="fired"&&["defensive","deteriorating"].includes(expected))expected="transition";
  same(applyStrategicDetectorPolicyV1({strategic,macroShockState,distributionState,recoveryState}),expected,`verdict overlay mismatch: ${strategic}/${macroShockState}/${distributionState}/${recoveryState}`);
}

const generatedAt=new Date(T0).toISOString();
const datasets={market:{source:"fixture",observed_at:generatedAt,fetched_at:generatedAt,data:[{t:T0,v:100}]}};
const makeVintages=state=>{const value=buildSourceVintagesV1(datasets,{market:{state,source:"fixture",observed_at:generatedAt,fetched_at:generatedAt}});value.captured_at=generatedAt;return value;};
const goodVintages=makeVintages("ok");
const blocks={macro:{strategic:{score:0,coverage:1},tactical:{score:null,coverage:0}},demand:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},cycle:{strategic:{score:0,coverage:1},tactical:{score:null,coverage:0}},leverage:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}},market:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}}};
function makeDecision({at=generatedAt,strategic="transition",tactical="balanced",recovery="calm",macro="calm",mvrv=50,critical=true,sourceState="ok",revision=false}={}){
  const sourceVintages=sourceState==="ok"?goodVintages:makeVintages(sourceState);
  return buildDecisionRecordV1({generatedAt:at,regime:{strategic,tactical},regimeMeta:{},metrics:[{id:"mvrv_cycle",vote:true,score:0,value_num:mvrv,observed_at:at,source:"fixture"}],blocks,detectors:[{id:"recovery",state:recovery},{id:"macro_shock",state:macro}],scores:{strategic:0,tactical:0,critical_coverage_ok:critical},sourceVintages,revisionAlerts:revision?[{source:"market",type:"fixture_revision"}]:[]});
}

// 3. Full quality/status matrix plus content-addressed hashes.
for(const strategic of [...POLICY_V1.strategic_order,"insufficient"])for(const tactical of tacticalStates)for(const critical of [false,true])for(const sourceState of ["ok","stale","partial","fail"])for(const revision of [false,true]){
  const {decision}=makeDecision({strategic,tactical,critical,sourceState,revision});
  const expectedStatus=strategic==="insufficient"?"paused":"actionable";
  const expectedQuality=!critical||expectedStatus==="paused"?"paused":sourceState!=="ok"||revision?"degraded":"good";
  same(decision.status,expectedStatus,`decision status mismatch: ${strategic}/${tactical}`);
  same(decision.quality.status,expectedQuality,`quality mismatch: ${strategic}/${tactical}/${critical}/${sourceState}/${revision}`);
  const copy={...decision};delete copy.decision_hash;
  same(decision.decision_hash,sha256(copy),"decision content hash mismatch");
}

// 4. Browser/external-monitor action gate: every finite combination of time, decision, quality and health.
const staleLimit=MODEL_POLICY_V1.forward_monitoring.operational_pause.snapshot_stale_hours;
const timeCases=[
  ["invalid","not-a-time","time_invalid"],
  ["future",new Date(T0+(ACTION_GATE_V1.future_tolerance_hours+.01)*HOUR).toISOString(),"snapshot_in_future"],
  ["fresh",generatedAt,null],
  ["stale",new Date(T0-(staleLimit+.01)*HOUR).toISOString(),"snapshot_stale"],
];
const decisionCases=[null,{status:"actionable",quality:{status:"good"}},{status:"actionable",quality:{status:"degraded"}},{status:"actionable",quality:{status:"paused"}},{status:"actionable",quality:{}},{status:"paused",quality:{status:"good"}}];
for(const [timeName,time,timeCode] of timeCases)for(const decision of decisionCases)for(const operationalStatus of ["healthy","paused",undefined]){
  let expected=timeCode;
  if(!expected&&!decision)expected="decision_missing";
  if(!expected&&decision.status!=="actionable")expected="decision_not_actionable";
  if(!expected&&!ACTION_GATE_V1.accepted_quality_states.includes(decision.quality?.status))expected="decision_quality_not_actionable";
  if(!expected&&operationalStatus!=="healthy")expected="operational_status_not_healthy";
  const result=evaluateActionGateV1({generatedAt:time,now:T0,staleLimitHours:staleLimit,decision,operationalStatus});
  same(result.code,expected,`action gate mismatch: ${timeName}/${decision?.status}/${decision?.quality?.status}/${operationalStatus}`);
  same(result.actionable,expected===null,"action gate boolean mismatch");
}
same(evaluateActionGateV1({generatedAt:new Date(T0+ACTION_GATE_V1.future_tolerance_hours*HOUR).toISOString(),now:T0,staleLimitHours:staleLimit,decision:decisionCases[1],operationalStatus:"healthy"}).actionable,true,"future tolerance boundary must be inclusive");

// 5. Hysteresis across every pair of published strategic and tactical states.
const publishedStates=[...new Set([...POLICY_V1.strategic_order,...tacticalStates])];
const meta=(candidate,count,since=T0,downStreak=0,anchor=candidate)=>({state:candidate,candidate,count,since:new Date(since).toISOString(),downStreak,anchor});
for(const prev of publishedStates)for(const candidate of publishedStates){
  const degraded=["insufficient","emergency"].includes(candidate);
  const previousMeta=meta(prev,5,T0,0,["insufficient","emergency"].includes(prev)?null:prev);
  const first=stabilizeCore(candidate,prev,previousMeta,T0+HOUR);
  if(degraded)same(first.state,candidate,`degraded state must be immediate: ${prev}->${candidate}`);
  else if(!["insufficient","emergency"].includes(prev)&&severity(candidate)>severity(prev)){
    same(first.state,prev,`upgrade must be held initially: ${prev}->${candidate}`);
    const beforeCount=stabilizeCore(candidate,prev,meta(candidate,10,T0),T0+49*HOUR);
    same(beforeCount.state,prev,`upgrade needs twelve observations: ${prev}->${candidate}`);
    const beforeTime=stabilizeCore(candidate,prev,meta(candidate,20,T0),T0+47*HOUR);
    same(beforeTime.state,prev,`upgrade needs 48 hours: ${prev}->${candidate}`);
    const confirmed=stabilizeCore(candidate,prev,meta(candidate,11,T0),T0+48*HOUR);
    same(confirmed.state,candidate,`confirmed upgrade must publish: ${prev}->${candidate}`);
  }else if(candidate!==prev){
    same(first.state,prev,`first non-upgrade observation must be held: ${prev}->${candidate}`);
    const second=stabilizeCore(candidate,first.state,first,T0+2*HOUR);
    same(second.state,candidate,`second non-upgrade observation must publish: ${prev}->${candidate}`);
  }else same(first.state,prev,`stable state changed unexpectedly: ${prev}`);
  same(stabilizeCore(candidate,prev,previousMeta,T0+HOUR,{hard:true}).state,candidate,`hard override must be immediate: ${prev}->${candidate}`);
  same(stabilizeCore(candidate,prev,previousMeta,T0+HOUR,{fresh:true}).state,candidate,`fresh start must be immediate: ${prev}->${candidate}`);
  same(stabilizeCore(candidate,prev,previousMeta,T0+HOUR,{mock:true}).state,candidate,`mock isolation must be immediate: ${prev}->${candidate}`);
}

// 6. Revision equivalence classes: unchanged, append, rolling window, rewrite, schema and nested identities.
function revisionFixture(observed,data){const packets={x:{source:"fixture",observed_at:observed,fetched_at:observed,data}};return{datasets:packets,vintages:buildSourceVintagesV1(packets,{x:{state:"ok",source:"fixture",observed_at:observed,fetched_at:observed}})}}
const r0=revisionFixture("2026-07-19T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:1},{t:"2026-07-19T00:00:00Z",v:2}]);
const unchanged=revisionFixture("2026-07-19T00:00:00Z",structuredClone(r0.datasets.x.data));
same(sourceRevisionAlertsV1(r0.vintages,unchanged.vintages,r0.datasets,unchanged.datasets),[],"unchanged vintage raised an alert");
const sameVintageRewrite=revisionFixture("2026-07-19T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:9},{t:"2026-07-19T00:00:00Z",v:2}]);
ok(sourceRevisionAlertsV1(r0.vintages,sameVintageRewrite.vintages,r0.datasets,sameVintageRewrite.datasets).some(x=>x.type==="same_vintage_rewritten"),"same-vintage rewrite was missed");
const appended=revisionFixture("2026-07-20T00:00:00Z",[...r0.datasets.x.data,{t:"2026-07-20T00:00:00Z",v:3}]);
same(sourceRevisionAlertsV1(r0.vintages,appended.vintages,r0.datasets,appended.datasets),[],"clean append raised a revision alert");
const rolling=revisionFixture("2026-07-20T00:00:00Z",[{t:"2026-07-19T00:00:00Z",v:2},{t:"2026-07-20T00:00:00Z",v:3}]);
same(sourceRevisionAlertsV1(r0.vintages,rolling.vintages,r0.datasets,rolling.datasets),[],"clean rolling window raised a revision alert");
const overlapRewrite=revisionFixture("2026-07-20T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:9},{t:"2026-07-19T00:00:00Z",v:2},{t:"2026-07-20T00:00:00Z",v:3}]);
ok(sourceRevisionAlertsV1(r0.vintages,overlapRewrite.vintages,r0.datasets,overlapRewrite.datasets).some(x=>x.type==="historical_overlap_rewritten"&&x.changed_rows===1),"historical overlap rewrite was missed");
const schemaChange=revisionFixture("2026-07-20T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:1,unit:"usd"}]);
ok(sourceRevisionAlertsV1(r0.vintages,schemaChange.vintages,r0.datasets,schemaChange.datasets).some(x=>x.type==="schema_changed"),"schema change was missed");
const nested0=revisionFixture("2026-07-19T00:00:00Z",{a:[{t:"2026-07-19T00:00:00Z",venue:"A",v:1}],b:[{t:"2026-07-19T00:00:00Z",venue:"B",v:2}]});
const nested1=revisionFixture("2026-07-20T00:00:00Z",{a:[{t:"2026-07-19T00:00:00Z",venue:"A",v:1}],b:[{t:"2026-07-19T00:00:00Z",venue:"B",v:9}]});
ok(sourceRevisionAlertsV1(nested0.vintages,nested1.vintages,nested0.datasets,nested1.datasets).some(x=>x.type==="historical_overlap_rewritten"&&x.changed_rows===1),"nested path/identity rewrite was missed");
const open0=revisionFixture("2026-07-19T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:1},{t:"2026-07-19T00:00:00Z",v:2}]);
const open1=revisionFixture("2026-07-19T00:00:00Z",[{t:"2026-07-18T00:00:00Z",v:1},{t:"2026-07-19T00:00:00Z",v:9}]);
same(sourceRevisionAlertsV1(open0.vintages,open1.vintages,open0.datasets,open1.datasets),[],"today's still-open row was misclassified as a historical rewrite");

// 7. Cash conversion for all economic boundary classes and invalid inputs.
for(const discountPct of [-5,0,0.001,1,5,20,100,300])for(const days of [1,30,91,182,365]){
  const price=1-discountPct/100*days/360;
  const expected=price<=0?null:((1/price)**(365.25/days)-1)*100;
  const actual=treasuryBillDiscountToEffectiveAnnualPct(discountPct,days);
  if(expected===null)same(actual,null,`non-positive bill price must reject: ${discountPct}/${days}`);
  else ok(Math.abs(actual-expected)<1e-10,`cash conversion mismatch: ${discountPct}/${days}`);
}
for(const [rate,days] of [[null,91],[undefined,91],[NaN,91],[Infinity,91],[5,0],[5,-1],[5,NaN]])same(treasuryBillDiscountToEffectiveAnnualPct(rate,days),null,`invalid cash quote accepted: ${rate}/${days}`);

// 8. Every pair of allocation states and every tactical-only transition: exact state/target counters.
const allocationVariants=[];
for(const strategic of [...POLICY_V1.strategic_order,"insufficient"])for(const recovery of ["calm","good"])for(const macro of ["calm","fired"])for(const mvrv of [5,50,99])allocationVariants.push({strategic,recovery,macro,mvrv,tactical:"balanced"});
const at1=new Date(T0+HOUR).toISOString();
const runTransition=(a,b)=>{
  const first=makeDecision({...a,at:generatedAt}),second=makeDecision({...b,at:at1});
  let monitor=updateForwardMonitorV1({now:T0,price:100,decision:first.decision,inputSummary:first.inputSummary,sourceVintages:goodVintages,cashQuotePct:0});
  monitor=updateForwardMonitorV1({previousMonitor:monitor,now:T0+HOUR,price:100,decision:second.decision,inputSummary:second.inputSummary,sourceVintages:goodVintages,cashQuotePct:0});
  const stateChanged=first.decision.state_hash!==second.decision.state_hash;
  same(monitor.state_changes,stateChanged?1:0,`state counter mismatch: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  same(monitor.target_changes,stateChanged&&first.decision.target_pct!==second.decision.target_pct?1:0,`target counter mismatch: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
};
for(const a of allocationVariants)for(const b of allocationVariants)runTransition(a,b);
for(const tacticalA of tacticalStates)for(const tacticalB of tacticalStates)runTransition({strategic:"transition",recovery:"calm",macro:"calm",mvrv:50,tactical:tacticalA},{strategic:"transition",recovery:"calm",macro:"calm",mvrv:50,tactical:tacticalB});

console.log(`Exhaustive policy simulation OK: ${scenarios.toLocaleString("en-US")} assertions across allocation, detector, quality, action-gate, hysteresis, revision, cash and transition state spaces`);
