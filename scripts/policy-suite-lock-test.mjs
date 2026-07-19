import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { EXECUTION_POLICY_V1 } from "../docs/execution-policy-v1.mjs";
import { POLICY_SUITE_V1, policySuiteContractV1 } from "../docs/policy-suite-v1.mjs";
import { policySuiteDigestV1, sha256 } from "./forward-monitor-v1.mjs";

const collector=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8").replace(/\r\n/g,"\n");
const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
const locked=name=>{
  const start=`// POLICY-LOCK:${name}:START`,end=`// POLICY-LOCK:${name}:END`;
  const a=collector.indexOf(start),b=collector.indexOf(end);
  assert.ok(a>=0&&b>a,`locked section markers missing: ${name}`);
  return collector.slice(a+start.length,b).replace(/^\n/,"").replace(/\s+$/,"");
};

for(const [name,expected] of Object.entries(MODEL_POLICY_V1.locked_sections)){
  assert.match(expected,/^[a-f0-9]{64}$/,`model-policy digest is not frozen: ${name}`);
  assert.equal(sha256(locked(name)),expected,`policy v1 model section changed: ${name}; create policy v2 instead`);
}
assert.equal(policySuiteDigestV1(),POLICY_SUITE_V1.contract_sha256,"full policy-suite contract drifted; create policy v2 instead");
assert.deepEqual(policySuiteContractV1().allocation,POLICY_V1);
assert.deepEqual(policySuiteContractV1().allocation_engine,{
  applyStrategicDetectorPolicyV1:applyStrategicDetectorPolicyV1.toString().replace(/\r\n/g,"\n"),
  allocationDecisionV1:allocationDecisionV1.toString().replace(/\r\n/g,"\n"),
},"the suite commitment must include the executable allocation engine");
assert.deepEqual(policySuiteContractV1().model,MODEL_POLICY_V1);
assert.deepEqual(policySuiteContractV1().execution,EXECUTION_POLICY_V1);
assert.ok(Object.isFrozen(MODEL_POLICY_V1)&&Object.isFrozen(MODEL_POLICY_V1.blocks)&&Object.isFrozen(EXECUTION_POLICY_V1),"policy suite must be deeply frozen");
assert.equal(MODEL_POLICY_V1.historical_recalibration,"disabled");
assert.equal(EXECUTION_POLICY_V1.personalisation,"out_of_scope","generic execution contract must not silently add personalisation");
assert.doesNotMatch(html,/allocationTargetV1|allocationDecisionV1/,"browser must not recompute the final allocation");
assert.match(html,/const target=Number\.isFinite\(D\.target_pct\)/,"browser must render the server decision");
assert.match(collector,/buildDecisionRecordV1\(/,"collector must build a server-side decision record");
assert.doesNotMatch(collector,/from\s+["'][^"']*backtest|readFileSync\([^)]*backtest[\\/]out/i,"live engine must not consume research output");

console.log(`Policy suite lock OK: ${POLICY_SUITE_V1.id} ${POLICY_SUITE_V1.contract_sha256.slice(0,12)}`);
