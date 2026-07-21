import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationTargetV1, applyStrategicDetectorPolicyV1, policyMetadataV1 } from "../docs/policy-v1.mjs";

const expected={
  id:"btc-allocation-policy-v1",
  version:1,
  status:"frozen",
  frozen_at:"2026-07-19",
  historical_recalibration:"disabled",
  strategic_order:["emergency","defensive","deteriorating","transition","unconfirmed_positive","constructive"],
  ladder:{emergency:0,defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100},
  allocation_overlays:{
    recovery_floor_pct:80,
    recovery_detector_state:"good",
    recovery_blocked_by_macro_shock_state:"fired",
    capitulation_floor_pct:40,
    capitulation_max_mvrv_percentile:10,
    euphoria_cap_pct:60,
    euphoria_min_mvrv_percentile:95,
  },
  verdict_overlays:{
    adverse_detector_cap_regime:"deteriorating",
    recovery_lift_from:["defensive","deteriorating"],
    recovery_lift_regime:"transition",
  },
};

assert.deepEqual(POLICY_V1,expected,"policy-v1 contract changed: create policy-v2 instead of recalibrating v1");
assert.ok(Object.isFrozen(POLICY_V1)&&Object.isFrozen(POLICY_V1.ladder)&&Object.isFrozen(POLICY_V1.allocation_overlays),"policy-v1 must be deeply frozen at runtime");
assert.deepEqual(policyMetadataV1(),{id:"btc-allocation-policy-v1",version:1,status:"frozen",frozen_at:"2026-07-19",historical_recalibration:"disabled"});

const target=(strategic,extra={})=>allocationTargetV1({strategic,recoveryState:"calm",macroShockState:"calm",mvrvPercentile:50,...extra});
for(const [regime,pct] of Object.entries(expected.ladder))assert.equal(target(regime),pct,`base allocation drifted: ${regime}`);
assert.equal(target("insufficient"),null);
assert.equal(target("defensive",{recoveryState:"good"}),80,"recovery floor drifted");
assert.equal(target("transition",{recoveryState:"good"}),80,"recovery floor must also lift transition allocation");
assert.equal(target("unconfirmed_positive",{recoveryState:"good"}),95,"recovery must not lower a higher base target");
assert.equal(target("defensive",{recoveryState:"good",macroShockState:"fired"}),5,"macro shock must block recovery");
assert.equal(target("defensive",{mvrvPercentile:10}),40,"capitulation floor drifted");
assert.equal(target("constructive",{mvrvPercentile:95}),60,"euphoria cap drifted");
assert.equal(target("constructive",{recoveryState:"good",mvrvPercentile:95}),60,"euphoria cap must remain binding after a recovery signal");
assert.equal(target("emergency",{recoveryState:"good",mvrvPercentile:1}),0,"emergency must override every floor");

// Exhaustive boundary matrix. The expected result is calculated independently from the
// implementation so an uncovered interaction cannot change while the published examples stay green.
const recoveryStates=["calm","good"],macroStates=["calm","fired"],mvrvValues=[null,9.999,10,10.001,50,94.999,95,95.001];
function expectedTarget(strategic,recoveryState,macroShockState,mvrvPercentile){
  if(strategic==="insufficient")return null;
  if(strategic==="emergency")return 0;
  let value=expected.ladder[strategic];
  if(recoveryState==="good"&&macroShockState!=="fired"&&value<80)value=80;
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile<=10&&value<40)value=40;
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile>=95&&value>60)value=60;
  return value;
}
for(const strategic of [...expected.strategic_order,"insufficient"]){
  for(const recoveryState of recoveryStates)for(const macroShockState of macroStates)for(const mvrvPercentile of mvrvValues){
    const actual=target(strategic,{recoveryState,macroShockState,mvrvPercentile});
    assert.equal(actual,expectedTarget(strategic,recoveryState,macroShockState,mvrvPercentile),`allocation boundary drifted: ${strategic}/${recoveryState}/${macroShockState}/${mvrvPercentile}`);
  }
}

const verdict=(strategic,extra={})=>applyStrategicDetectorPolicyV1({strategic,macroShockState:"calm",distributionState:"calm",recoveryState:"calm",...extra});
assert.equal(verdict("constructive",{macroShockState:"fired"}),"deteriorating");
assert.equal(verdict("constructive",{distributionState:"fired"}),"deteriorating");
assert.equal(verdict("defensive",{recoveryState:"good"}),"transition");
assert.equal(verdict("defensive",{recoveryState:"good",macroShockState:"fired"}),"defensive");

const collector=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
assert.match(collector,/from "\.\.\/docs\/policy-v1\.mjs"/,"snapshot engine must consume policy-v1 directly");
assert.match(html,/from "\.\/policy-v1\.mjs"/,"frontend must consume policy-v1 directly");
assert.doesNotMatch(collector,/from\s+["'][^"']*backtest|readFileSync\([^)]*backtest[\\/]out/i,"live engine must never consume backtest output");
assert.doesNotMatch(html,/fetch\([^)]*backtest[\\/]out|from\s+["'][^"']*backtest/i,"live frontend must never consume backtest output");

console.log("Policy lock OK: btc-allocation-policy-v1 is frozen; historical recalibration is disabled");
