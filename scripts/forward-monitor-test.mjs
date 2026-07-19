import assert from "node:assert/strict";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, sha256, sourceRevisionAlertsV1, updateForwardMonitorV1 } from "./forward-monitor-v1.mjs";
import { validateSnapshotV1 } from "./monitor-live.mjs";

const generatedAt="2026-07-19T00:00:00.000Z";
const sourceStates={market:{state:"ok",source:"fixture",observed_at:generatedAt,fetched_at:generatedAt}};
const vintages=buildSourceVintagesV1({market:{source:"fixture",observed_at:generatedAt,fetched_at:generatedAt,data:[{t:1,v:100}]}},sourceStates);
vintages.captured_at=generatedAt;
const metrics=[{id:"mvrv_cycle",vote:true,score:-1,value_num:50,observed_at:generatedAt,source:"fixture"}];
const blocks={macro:{strategic:{score:0,coverage:1},tactical:{score:null,coverage:0}},demand:{strategic:{score:-1,coverage:1},tactical:{score:-1,coverage:1}},cycle:{strategic:{score:0,coverage:1},tactical:{score:null,coverage:0}},leverage:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}},market:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}}};
const scores={strategic:-20,tactical:-10,critical_coverage_ok:true};
const makeDecision=(strategic="defensive",extra={})=>buildDecisionRecordV1({generatedAt,regime:{strategic,tactical:"balanced"},regimeMeta:{},metrics:extra.metrics||metrics,blocks,detectors:extra.detectors||[],scores,sourceVintages:vintages,revisionAlerts:[]});

// Full server-side ladder and overlay scenarios.
for(const [strategic,target] of Object.entries(POLICY_V1.ladder))assert.equal(allocationDecisionV1({strategic,recoveryState:"calm",macroShockState:"calm",mvrvPercentile:50}).target_pct,target);
assert.deepEqual(allocationDecisionV1({strategic:"defensive",recoveryState:"good",macroShockState:"calm",mvrvPercentile:50}).binding_overlays,["recovery_floor"]);
assert.equal(allocationDecisionV1({strategic:"defensive",recoveryState:"good",macroShockState:"calm",mvrvPercentile:50}).target_pct,80);
assert.equal(allocationDecisionV1({strategic:"defensive",recoveryState:"good",macroShockState:"fired",mvrvPercentile:50}).target_pct,5);
assert.equal(allocationDecisionV1({strategic:"defensive",recoveryState:"calm",macroShockState:"calm",mvrvPercentile:5}).target_pct,40);
assert.deepEqual(allocationDecisionV1({strategic:"constructive",recoveryState:"calm",macroShockState:"calm",mvrvPercentile:99}).binding_overlays,["euphoria_safety_cap"]);
assert.equal(allocationDecisionV1({strategic:"emergency",recoveryState:"good",macroShockState:"calm",mvrvPercentile:1}).target_pct,0);
assert.equal(allocationDecisionV1({strategic:"insufficient",recoveryState:"calm",macroShockState:"calm",mvrvPercentile:null}).target_pct,null);

const {decision,inputSummary}=makeDecision();
assert.equal(decision.target_pct,5);
assert.equal(decision.regime_targets_pct.constructive,100);
assert.equal(decision.policy_hash,POLICY_SUITE_V1.contract_sha256);
const decisionCopy={...decision};delete decisionCopy.decision_hash;
assert.equal(decision.decision_hash,sha256(decisionCopy),"decision must be content-addressed");

// Point-in-time revision detector: the same observed vintage may not change silently.
const rewritten=buildSourceVintagesV1({market:{source:"fixture",observed_at:generatedAt,fetched_at:"2026-07-19T01:00:00.000Z",data:[{t:1,v:101}]}},sourceStates);
const revision=sourceRevisionAlertsV1(vintages,rewritten);
assert.ok(revision.some(x=>x.type==="same_vintage_rewritten"));
assert.notEqual(vintages.contract_sha256,rewritten.contract_sha256);

const priceSeries=Array.from({length:250},(_,i)=>({t:Date.UTC(2025,10,12+i),v:80+i*.08}));
let monitor=updateForwardMonitorV1({now:Date.parse(generatedAt),price:100,decision,inputSummary,sourceVintages:vintages,cashAnnualPct:null,priceSeries});
assert.equal(monitor.cash_yield_available,false,"missing cash yield must be disclosed, not presented as a real 0% quote");
assert.deepEqual(Object.keys(monitor.strategies).sort(),["buy_and_hold","cash","fixed_50","policy_v1","previous_policy_shadow","trend_vol_25"].sort());
assert.equal(monitor.strategies.policy_v1.current_target_pct,5);
assert.equal(monitor.strategies.previous_policy_shadow.current_target_pct,10);
assert.equal(monitor.decision_log.length,1);
assert.equal(monitor.decision_log[0].decision_hash,decision.decision_hash);
const firstNav=1-(5/100)*(10/10_000);
assert.ok(Math.abs(monitor.strategies.policy_v1.nav-firstNav)<1e-12,"initial policy turnover cost incorrect");

const nextAt=Date.parse("2026-07-20T00:00:00.000Z");
const nextBuilt=buildDecisionRecordV1({generatedAt:new Date(nextAt).toISOString(),regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:vintages,revisionAlerts:[]});
monitor=updateForwardMonitorV1({previousMonitor:monitor,now:nextAt,price:110,decision:nextBuilt.decision,inputSummary:nextBuilt.inputSummary,sourceVintages:vintages,cashAnnualPct:4,priceSeries:[...priceSeries,{t:nextAt,v:110}]});
assert.ok(Math.abs(monitor.strategies.policy_v1.nav-firstNav*1.005)<1e-10,"prior target must earn the next interval return");
assert.equal(monitor.daily.length,2);
assert.equal(monitor.decision_events.length,1,"unchanged state must not create a false target-change event");
assert.equal(monitor.decision_log.length,2,"every observation must enter the exact append-only decision log");
assert.equal(monitor.decision_log[1].previous_log_hash,monitor.decision_log[0].log_hash);
assert.equal(monitor.target_changes,0);
assert.equal(monitor.health.operational_status,"healthy");
assert.equal(monitor.health.performance_status,"collecting");

const snapshot={schema:3,generated_at:new Date(nextAt).toISOString(),policy_suite:{...POLICY_SUITE_V1},decision:nextBuilt.decision,source_vintages:vintages,monitoring:monitor};
assert.equal(validateSnapshotV1(snapshot,nextAt+60_000).ok,true,"healthy assembled snapshot must pass the external monitor");
assert.ok(validateSnapshotV1(snapshot,nextAt+4*36e5).issues.some(x=>x.startsWith("snapshot_stale")),"stale live page must trip the external monitor");
const tampered=structuredClone(snapshot);tampered.decision.target_pct=95;
assert.ok(validateSnapshotV1(tampered,nextAt+60_000).issues.includes("decision_hash_mismatch"));

console.log("Forward monitor scenarios OK: server decision, costs, shadows, vintages, hash chain, live alarm");
