import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, sha256, sourceRevisionAlertsV1, treasuryBillDiscountToEffectiveAnnualPct, updateForwardMonitorV1 } from "./forward-monitor-v1.mjs";
import { validatePublishedAssetsV1, validateSnapshotV1 } from "./monitor-live.mjs";

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
assert.equal(allocationDecisionV1({strategic:"constructive",recoveryState:"good",macroShockState:"calm",mvrvPercentile:99}).target_pct,60,"combined recovery/euphoria boundary must stay capped");
assert.equal(allocationDecisionV1({strategic:"emergency",recoveryState:"good",macroShockState:"calm",mvrvPercentile:1}).target_pct,0);
assert.equal(allocationDecisionV1({strategic:"insufficient",recoveryState:"calm",macroShockState:"calm",mvrvPercentile:null}).target_pct,null);

const {decision,inputSummary}=makeDecision();
assert.equal(decision.target_pct,5);
assert.equal(decision.regime_targets_pct.constructive,100);
assert.equal(decision.policy_hash,POLICY_SUITE_V1.contract_sha256);
const decisionCopy={...decision};delete decisionCopy.decision_hash;
assert.equal(decision.decision_hash,sha256(decisionCopy),"decision must be content-addressed");
const pausedBuilt=buildDecisionRecordV1({generatedAt,regime:{strategic:"defensive",tactical:"insufficient"},regimeMeta:{},metrics,blocks,detectors:[],scores:{...scores,critical_coverage_ok:false},sourceVintages:vintages,revisionAlerts:[]});
assert.equal(pausedBuilt.decision.status,"actionable","strategic allocation may still be computable while tactical coverage is incomplete");
assert.equal(pausedBuilt.decision.quality.status,"paused","critical coverage loss must pause the displayed action");

// Point-in-time revision detector: the same observed vintage may not change silently.
const rewritten=buildSourceVintagesV1({market:{source:"fixture",observed_at:generatedAt,fetched_at:"2026-07-19T01:00:00.000Z",data:[{t:1,v:101}]}},sourceStates);
const revision=sourceRevisionAlertsV1(vintages,rewritten);
assert.ok(revision.some(x=>x.type==="same_vintage_rewritten"));
assert.notEqual(vintages.contract_sha256,rewritten.contract_sha256);
const appendedAt="2026-07-20T00:00:00.000Z",previousDataset={market:{data:[{t:1,v:100}]}};
const appendedDataset={market:{data:[{t:1,v:999},{t:2,v:102}]}};
const appended=buildSourceVintagesV1({market:{source:"fixture",observed_at:appendedAt,fetched_at:appendedAt,data:appendedDataset.market.data}},{market:{...sourceStates.market,observed_at:appendedAt,fetched_at:appendedAt}});
const backfill=sourceRevisionAlertsV1(vintages,appended,previousDataset,appendedDataset);
assert.ok(backfill.some(x=>x.type==="historical_overlap_rewritten"&&x.changed_rows===1),"an appended point must not hide a rewrite in the overlapping history");

// The current UTC-day row is an open partition, not immutable history. Market,
// network, stablecoin and daily-volatility providers legitimately update it intraday.
const sourcePacket=(observedAt,fetchedAt,data)=>{
  const datasets={market:{source:"fixture",observed_at:observedAt,fetched_at:fetchedAt,data}};
  const states={market:{state:"ok",source:"fixture",observed_at:observedAt,fetched_at:fetchedAt}};
  return{datasets,vintages:buildSourceVintagesV1(datasets,states)};
};
const openPrevious=sourcePacket("2026-07-19T00:00:00.000Z","2026-07-19T12:00:00.000Z",[{t:"2026-07-18T00:00:00.000Z",v:100},{t:"2026-07-19T00:00:00.000Z",v:101}]);
const openCurrent=sourcePacket("2026-07-19T00:00:00.000Z","2026-07-19T13:00:00.000Z",[{t:"2026-07-18T00:00:00.000Z",v:100},{t:"2026-07-19T00:00:00.000Z",v:102}]);
const openUpdates=sourceRevisionAlertsV1(openPrevious.vintages,openCurrent.vintages,openPrevious.datasets,openCurrent.datasets);
assert.deepEqual(openUpdates,[],"a normal update to today's open row must not degrade data quality");
const openDecision=buildDecisionRecordV1({generatedAt,regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:openCurrent.vintages,revisionAlerts:openUpdates});
assert.equal(openDecision.decision.quality.status,"good","an open-period update alone must keep a healthy decision at good quality");

const closedRewrite=sourcePacket("2026-07-19T00:00:00.000Z","2026-07-19T13:00:00.000Z",[{t:"2026-07-18T00:00:00.000Z",v:999},{t:"2026-07-19T00:00:00.000Z",v:102}]);
const closedAlerts=sourceRevisionAlertsV1(openPrevious.vintages,closedRewrite.vintages,openPrevious.datasets,closedRewrite.datasets);
assert.ok(closedAlerts.some(x=>x.type==="same_vintage_rewritten"&&x.changed_rows===1&&x.quality_impact==="audit"),"a rewrite to a closed row must remain visible in the audit log");
const closedDecision=buildDecisionRecordV1({generatedAt,regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:closedRewrite.vintages,revisionAlerts:closedAlerts});
assert.equal(closedDecision.decision.quality.status,"good","a historical time-series restatement alone must not mislabel current operational data");
assert.equal(closedDecision.decision.quality.audit_revision_alerts,1);
assert.equal(closedDecision.decision.quality.quality_affecting_revision_alerts,0);

const scalarPrevious=sourcePacket("2026-07-19T00:00:00.000Z","2026-07-19T12:00:00.000Z",{value:100});
const scalarCurrent=sourcePacket("2026-07-19T00:00:00.000Z","2026-07-19T13:00:00.000Z",{value:101});
const scalarAlerts=sourceRevisionAlertsV1(scalarPrevious.vintages,scalarCurrent.vintages,scalarPrevious.datasets,scalarCurrent.datasets);
assert.ok(scalarAlerts.some(x=>x.quality_impact==="degraded"),"a non-temporal same-vintage rewrite must remain quality-affecting");
const scalarDecision=buildDecisionRecordV1({generatedAt,regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:scalarCurrent.vintages,revisionAlerts:scalarAlerts});
assert.equal(scalarDecision.decision.quality.status,"degraded");
const advancingPrevious=sourcePacket("2026-07-19T12:00:00.000Z","2026-07-19T12:00:00.000Z",openPrevious.datasets.market.data);
const advancingCurrent=sourcePacket("2026-07-19T13:00:00.000Z","2026-07-19T13:00:00.000Z",openCurrent.datasets.market.data);
assert.deepEqual(sourceRevisionAlertsV1(advancingPrevious.vintages,advancingCurrent.vintages,advancingPrevious.datasets,advancingCurrent.datasets),[],"an advancing intraday vintage must ignore changes confined to today's open row");

const priceSeries=Array.from({length:250},(_,i)=>({t:Date.UTC(2025,10,12+i),v:80+i*.08}));
let monitor=updateForwardMonitorV1({now:Date.parse(generatedAt),price:100,decision,inputSummary,sourceVintages:vintages,cashQuotePct:null,priceSeries});
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
monitor=updateForwardMonitorV1({previousMonitor:monitor,now:nextAt,price:110,decision:nextBuilt.decision,inputSummary:nextBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:nextAt,v:110}]});
assert.ok(Math.abs(monitor.strategies.policy_v1.nav-firstNav*1.005)<1e-10,"prior target must earn the next interval return");
assert.equal(monitor.daily.length,2);
assert.equal(monitor.decision_events.length,1,"unchanged state must not create a false target-change event");
assert.equal(monitor.decision_log.length,2,"every observation must enter the exact append-only decision log");
assert.equal(monitor.decision_log[1].previous_log_hash,monitor.decision_log[0].log_hash);
assert.equal(monitor.target_changes,0);
assert.equal(monitor.state_changes,0);
assert.equal(monitor.health.operational_status,"healthy");
assert.equal(monitor.health.performance_status,"collecting");

const tacticalAt=Date.parse("2026-07-21T00:00:00.000Z");
const tacticalBuilt=buildDecisionRecordV1({generatedAt:new Date(tacticalAt).toISOString(),regime:{strategic:"defensive",tactical:"demand_break"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:vintages,revisionAlerts:[]});
monitor=updateForwardMonitorV1({previousMonitor:monitor,now:tacticalAt,price:110,decision:tacticalBuilt.decision,inputSummary:tacticalBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:tacticalAt,v:110}]});
assert.equal(monitor.state_changes,1,"a tactical-only transition is a state change");
assert.equal(monitor.target_changes,0,"a tactical-only transition must not count as a target change");
const effectiveCash=treasuryBillDiscountToEffectiveAnnualPct(4),expectedCashNav=(1+effectiveCash/100)**(1/365.25);
assert.ok(Math.abs(monitor.strategies.cash.nav-expectedCashNav)<1e-12,"DTB3 discount quote must be converted before cash compounding");
const legacyMonitor=structuredClone(monitor);delete legacyMonitor.counter_semantics_version;delete legacyMonitor.state_changes;legacyMonitor.target_changes=99;
const migratedMonitor=updateForwardMonitorV1({previousMonitor:legacyMonitor,now:tacticalAt+3_600_000,price:110,decision:tacticalBuilt.decision,inputSummary:tacticalBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:tacticalAt,v:110}]});
assert.equal(migratedMonitor.counter_semantics_version,2);
assert.equal(migratedMonitor.state_changes,1);
assert.equal(migratedMonitor.target_changes,0,"legacy state-change counts must be rebuilt from retained target percentages");

const targetAt=Date.parse("2026-07-22T00:00:00.000Z");
const targetBuilt=buildDecisionRecordV1({generatedAt:new Date(targetAt).toISOString(),regime:{strategic:"deteriorating",tactical:"demand_break"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:vintages,revisionAlerts:[]});
monitor=updateForwardMonitorV1({previousMonitor:monitor,now:targetAt,price:110,decision:targetBuilt.decision,inputSummary:targetBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:targetAt,v:110}]});
assert.equal(monitor.state_changes,2);
assert.equal(monitor.target_changes,1,"only a changed target percentage increments target_changes");

const packageVersion=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version;
const snapshot={schema:3,version:packageVersion,generated_at:new Date(targetAt).toISOString(),policy_suite:{...POLICY_SUITE_V1},decision:targetBuilt.decision,source_vintages:vintages,monitoring:monitor};
assert.equal(validateSnapshotV1(snapshot,targetAt+60_000).ok,true,"healthy assembled snapshot must pass the external monitor");
assert.ok(validateSnapshotV1(snapshot,targetAt+4*36e5).issues.some(x=>x.startsWith("snapshot_stale")),"stale live page must trip the external monitor");
assert.ok(validateSnapshotV1(snapshot,targetAt-16*60_000).issues.includes("generated_at_in_future"),"a snapshot beyond the future-time tolerance must trip the external monitor");
const noHealth=structuredClone(snapshot);delete noHealth.monitoring.health;
assert.ok(validateSnapshotV1(noHealth,targetAt+60_000).issues.some(x=>x.startsWith("forward_monitor_not_healthy")),"missing monitor health must fail closed");
const noQuality=structuredClone(snapshot);delete noQuality.decision.quality.status;
assert.ok(validateSnapshotV1(noQuality,targetAt+60_000).issues.includes("decision_quality_not_actionable"),"missing decision quality must fail closed");
const pausedDecision=structuredClone(snapshot);pausedDecision.decision.status="paused";
assert.ok(validateSnapshotV1(pausedDecision,targetAt+60_000).issues.includes("decision_not_actionable"),"a paused decision must fail closed");
const tampered=structuredClone(snapshot);tampered.decision.target_pct=95;
assert.ok(validateSnapshotV1(tampered,targetAt+60_000).issues.includes("decision_hash_mismatch"));

const remoteAssets={
  "https://example.test/dashboard/index.html":readFileSync(new URL("../docs/index.html",import.meta.url),"utf8"),
  "https://example.test/dashboard/policy-v1.mjs":readFileSync(new URL("../docs/policy-v1.mjs",import.meta.url),"utf8"),
  "https://example.test/dashboard/model-policy-v1.mjs":readFileSync(new URL("../docs/model-policy-v1.mjs",import.meta.url),"utf8"),
  "https://example.test/dashboard/execution-policy-v1.mjs":readFileSync(new URL("../docs/execution-policy-v1.mjs",import.meta.url),"utf8"),
  "https://example.test/dashboard/policy-suite-v1.mjs":readFileSync(new URL("../docs/policy-suite-v1.mjs",import.meta.url),"utf8"),
  "https://example.test/dashboard/action-gate-v1.mjs":readFileSync(new URL("../docs/action-gate-v1.mjs",import.meta.url),"utf8"),
};
const fetchAssets=async url=>new Response(remoteAssets[String(url)]??"",{status:String(url) in remoteAssets?200:404});
assert.deepEqual((await validatePublishedAssetsV1("https://example.test/dashboard/snapshot.json",fetchAssets)).issues,[],"matching published HTML/modules must pass");
const brokenFetch=async url=>new Response(String(url).endsWith("index.html")?"broken":remoteAssets[String(url)]??"",{status:200});
assert.ok((await validatePublishedAssetsV1("https://example.test/dashboard/snapshot.json",brokenFetch)).issues.some(x=>x.startsWith("asset_content_mismatch:index.html")),"a broken published frontend must trip the external monitor");

console.log("Forward monitor scenarios OK: server decision, costs, shadows, vintages, hash chain, live alarm");
