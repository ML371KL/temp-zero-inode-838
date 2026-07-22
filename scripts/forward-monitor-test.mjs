import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, graftForwardMonitorV1, previousPolicyTargetV1, sha256, sourceRevisionAlertsV1, treasuryBillDiscountToEffectiveAnnualPct, updateForwardMonitorV1, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";
import { monitorResetIssues, validatePublishedAssetsV1, validateSnapshotV1 } from "./monitor-live.mjs";

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
assert.deepEqual(Object.keys(monitor.strategies).sort(),["buy_and_hold","cash","fixed_50","policy_v1","policy_v2_shadow","previous_policy_shadow","static_theta","trend_vol_25"].sort(),"v2 shadow and static-theta strategies must be tracked alongside the frozen set");
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
  "https://example.test/dashboard/policy-v2-candidate.mjs":readFileSync(new URL("../docs/policy-v2-candidate.mjs",import.meta.url),"utf8"),
};
const fetchAssets=async url=>new Response(remoteAssets[String(url)]??"",{status:String(url) in remoteAssets?200:404});
assert.deepEqual((await validatePublishedAssetsV1("https://example.test/dashboard/snapshot.json",fetchAssets)).issues,[],"matching published HTML/modules must pass");
const brokenFetch=async url=>new Response(String(url).endsWith("index.html")?"broken":remoteAssets[String(url)]??"",{status:200});
assert.ok((await validatePublishedAssetsV1("https://example.test/dashboard/snapshot.json",brokenFetch)).issues.some(x=>x.startsWith("asset_content_mismatch:index.html")),"a broken published frontend must trip the external monitor");

// Shadow v0: оверлеи не применяются в emergency (замороженная семантика v0, backtest/patch6.py).
assert.equal(previousPolicyTargetV1({strategic:"emergency",recoveryState:"good",macroShockState:"calm",mvrvPercentile:5}),0,"v0 shadow must not lift emergency with recovery/capitulation floors");
assert.equal(previousPolicyTargetV1({strategic:"defensive",recoveryState:"good",macroShockState:"calm",mvrvPercentile:50}),70,"v0 recovery floor outside emergency must stay intact");
assert.equal(previousPolicyTargetV1({strategic:"insufficient",recoveryState:"calm",macroShockState:"calm",mvrvPercentile:50}),null);

// input_hash обязан воспроизводиться из ОПУБЛИКОВАННОЙ формы даже при hold_until:undefined в метаданных.
const holdMeta={strategic:{state:"defensive",candidate:"transition",count:3,since:generatedAt,hold_until:undefined},tactical:{state:"balanced",candidate:"balanced",count:9,since:generatedAt,hold_until:undefined}};
const holdBuilt=buildDecisionRecordV1({generatedAt,regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:holdMeta,metrics,blocks,detectors:[],scores,sourceVintages:vintages,revisionAlerts:[]});
const publishedForm=JSON.parse(JSON.stringify({generated_at:generatedAt,regime:{strategic:"defensive",tactical:"balanced"},regime_meta:holdMeta,allocation_inputs:holdBuilt.decision.inputs,input_summary:holdBuilt.inputSummary}));
assert.equal(holdBuilt.decision.input_hash,sha256(publishedForm),"input_hash must be reproducible from the published (JSON-serialized) snapshot fields");

// Полная верификация цепи: переписывание/обрыв прошлого обязаны детектироваться.
const chainOk=verifyDecisionLogChainV1(monitor.decision_log);
assert.equal(chainOk.ok,true,"untouched log must verify");
const tamperedPast=structuredClone(monitor.decision_log);tamperedPast[0].target_pct=99;
assert.ok(!verifyDecisionLogChainV1(tamperedPast).ok,"rewriting an old record must fail full-chain verification");
const rehashedPast=structuredClone(monitor.decision_log);rehashedPast[1].target_pct=99;{const c={...rehashedPast[1]};delete c.log_hash;rehashedPast[1].log_hash=sha256(c);}
assert.ok(!verifyDecisionLogChainV1(rehashedPast).ok,"re-hashing a rewritten record must break linkage downstream");
const tamperedSnapshot=structuredClone(snapshot);tamperedSnapshot.monitoring.decision_log[0].target_pct=99;
assert.ok(validateSnapshotV1(tamperedSnapshot,targetAt+60_000).issues.some(x=>x.startsWith("decision_log_chain_invalid")),"external monitor must walk the whole retained chain");

// Hysteresis-телеметрия в записи леджера.
const metaTick=updateForwardMonitorV1({previousMonitor:monitor,now:targetAt+3_600_000,price:110,decision:targetBuilt.decision,inputSummary:targetBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:targetAt,v:110}],regimeMeta:{strategic:{state:"deteriorating",candidate:"transition",count:5,since:generatedAt,hold_until:"2026-07-24T00:00:00.000Z"},tactical:{state:"demand_break",candidate:"demand_break",count:2,since:generatedAt}}});
const metaEntry=metaTick.decision_log.at(-1);
assert.equal(metaEntry.hysteresis.strategic_candidate,"transition");
assert.equal(metaEntry.hysteresis.strategic_hold_until,"2026-07-24T00:00:00.000Z");
assert.equal(metaEntry.hysteresis.tactical_hold_until,null,"absent hold must serialize as explicit null, never undefined");
{const c={...metaEntry};delete c.log_hash;assert.equal(metaEntry.log_hash,sha256(c),"hysteresis block must be content-addressed with the record");}

// Теневые счётчики гистерезиса накапливаются и не влияют на решение.
let shadowTick=updateForwardMonitorV1({previousMonitor:metaTick,now:targetAt+2*3_600_000,price:110,decision:targetBuilt.decision,inputSummary:targetBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:targetAt,v:110}],shadowHysteresis:{upgrade_hold_reset_by_degraded:1,risk_off_confirmed_under_30m:0}});
shadowTick=updateForwardMonitorV1({previousMonitor:shadowTick,now:targetAt+3*3_600_000,price:110,decision:targetBuilt.decision,inputSummary:targetBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries:[...priceSeries,{t:targetAt,v:110}],shadowHysteresis:{upgrade_hold_reset_by_degraded:0,risk_off_confirmed_under_30m:1}});
assert.deepEqual([shadowTick.shadow_hysteresis.upgrade_hold_resets_by_degraded,shadowTick.shadow_hysteresis.risk_off_confirmed_under_30m],[1,1]);
assert.equal(shadowTick.strategies.policy_v1.current_target_pct,metaTick.strategies.policy_v1.current_target_pct,"shadow counters must not move the allocation");

// Молчаливый генезис при живом previous обязан оставлять reset-событие (класс инцидента 2026-07-21).
const resetMonitor=updateForwardMonitorV1({now:targetAt+5*3_600_000,price:110,decision:targetBuilt.decision,inputSummary:targetBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:null,priceSeries,previousSnapshotPresent:true});
assert.equal(resetMonitor.reset_events?.length,1);
assert.equal(resetMonitor.reset_events[0].reason,"previous_snapshot_without_monitoring");
assert.ok(monitorResetIssues(resetMonitor,monitor).some(x=>x.startsWith("monitor_state_reset:")),"younger genesis against the committed reference must raise an incident");
assert.ok(monitorResetIssues(null,monitor).includes("monitor_state_lost"));
assert.ok(monitorResetIssues(structuredClone(monitor),{...structuredClone(monitor),decision_log:[...monitor.decision_log.slice(0,-1),{...monitor.decision_log.at(-1),log_hash:"beef".repeat(16)}]}).some(x=>x.startsWith("decision_log_history_rewritten")),"a reference head missing from the live chain must be reported");
assert.deepEqual(monitorResetIssues(structuredClone(monitor),structuredClone(monitor)),[],"an identical chain must not alarm");

// Графт: восстановление доинцидентной цепи после молчаливого генезиса.
let archiveMonitor=updateForwardMonitorV1({now:Date.parse(generatedAt),price:100,decision,inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries});
archiveMonitor=updateForwardMonitorV1({previousMonitor:archiveMonitor,now:Date.parse("2026-07-20T00:00:00.000Z"),price:104,decision:nextBuilt.decision,inputSummary:nextBuilt.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries});
const eraAt=Date.parse("2026-07-20T02:00:00.000Z");
const eraDecision=buildDecisionRecordV1({generatedAt:new Date(eraAt).toISOString(),regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics,blocks,detectors:[],scores,sourceVintages:vintages,revisionAlerts:[]});
let eraMonitor=updateForwardMonitorV1({now:eraAt,price:105,decision:eraDecision.decision,inputSummary:eraDecision.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries,previousSnapshotPresent:true});
eraMonitor=updateForwardMonitorV1({previousMonitor:eraMonitor,now:eraAt+3_600_000,price:106,decision:eraDecision.decision,inputSummary:eraDecision.inputSummary,sourceVintages:vintages,cashQuotePct:4,priceSeries});
const graftPack={
  schema:1,reason:"test_restore",invalid_window:["2026-07-20T01:00:00Z","2026-07-20T02:00:00Z"],
  orphaned_genesis_log_hashes:[eraMonitor.decision_log[0].log_hash],
  archive:{source_commit:"fixture",monitor:archiveMonitor},
  era:{started_at:eraMonitor.started_at,price:105,strategies:Object.fromEntries(Object.entries(eraMonitor.strategies).map(([k,v])=>[k,{initial_target_pct:v.current_target_pct,initial_nav:1-Math.abs(v.current_target_pct)/100*(10/10_000),initial_turnover_pct:Math.abs(v.current_target_pct),initial_cost_pct:Math.abs(v.current_target_pct)/100*(10/10_000)*100}])),},
};
const grafted=graftForwardMonitorV1(eraMonitor,graftPack);
assert.equal(grafted.started_at,archiveMonitor.started_at,"graft must restore the pre-incident start");
assert.equal(grafted.decision_log.length,archiveMonitor.decision_log.length+eraMonitor.decision_log.length);
assert.equal(verifyDecisionLogChainV1(grafted.decision_log).ok,true,"grafted chain must verify end-to-end");
assert.equal(grafted.decision_log.at(-1).original_log_hash,eraMonitor.decision_log.at(-1).log_hash,"restatement must keep the original hash as evidence");
assert.deepEqual(grafted.decision_log[archiveMonitor.decision_log.length].graft.orphaned_genesis_log_hashes,graftPack.orphaned_genesis_log_hashes);
assert.ok(Math.abs(grafted.strategies.buy_and_hold.nav-archiveMonitor.strategies.buy_and_hold.nav*(105/104)*(106/105))<1e-9,"NAV must be continuous across the graft (bridge by prior target, no double entry cost)");
assert.equal(graftForwardMonitorV1(grafted,graftPack),grafted,"graft must be idempotent on a continuous chain");
assert.equal(graftForwardMonitorV1(archiveMonitor,graftPack),archiveMonitor,"an already continuous monitor must pass through untouched");
const foreignEra={...structuredClone(eraMonitor),started_at:"2026-07-21T00:00:00.000Z"};
assert.ok(graftForwardMonitorV1(foreignEra,graftPack).graft_skipped,"an unexpected genesis must be skipped, not blindly merged");
assert.equal(graftForwardMonitorV1(null,graftPack).started_at,archiveMonitor.started_at,"absent previous must adopt the archive");

console.log("Forward monitor scenarios OK: server decision, costs, shadows, vintages, hash chain, graft, reset alarm, live alarm");
