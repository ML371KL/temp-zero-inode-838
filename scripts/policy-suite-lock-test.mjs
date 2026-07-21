import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { EXECUTION_POLICY_V1 } from "../docs/execution-policy-v1.mjs";
import { POLICY_SUITE_V1, policySuiteContractV1 } from "../docs/policy-suite-v1.mjs";
import { buildDecisionRecordV1, compactDecisionInputsV1, policySuiteDigestV1, previousPolicyTargetV1, sha256 } from "./forward-monitor-v1.mjs";

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

// Пин СБОРКИ РЕШЕНИЯ (закрытие дыры пиннинга, аудит 2026-07-21): слой детекторы→входы аллокации,
// quality и v0-shadow экономически значим, но не входит в замороженный policy_suite hash — мутация
// recoveryState="calm" (отключение recovery-пола 80%) проходила ВСЕ защитные тесты. Пин живёт здесь,
// НЕ в замороженном контракте: policy_hash d9fd80de… не меняется. Осознанная правка сборки решения
// обновляет этот digest в паре с ревью экономической значимости.
const normalizedFn=f=>f.toString().replace(/\r\n/g,"\n");
assert.equal(
  sha256(normalizedFn(buildDecisionRecordV1)+normalizedFn(compactDecisionInputsV1)+normalizedFn(previousPolicyTargetV1)),
  "62845bca9c88637cbaa4e4b77447a014d46bf37ba38d24de03cf49b5a458747e",
  "decision-assembly layer changed: review economic materiality, then update this digest deliberately",
);

// Независимый поведенческий эталон (захардкожен, НЕ выведен из самой функции): подтверждённое
// восстановление обязано поднимать defensive до пола 80%, а сработавший макрошок — блокировать это.
const assemblyMetrics=[{id:"mvrv_cycle",vote:true,score:0,value_num:50,observed_at:"2026-01-01T00:00:00.000Z",source:"fixture"}];
const assemblyScores={strategic:0,tactical:0,critical_coverage_ok:true};
const assemblyVintages={mode:"as_collected",captured_at:null,sources:{},contract_sha256:sha256({})};
const assemble=detectors=>buildDecisionRecordV1({generatedAt:"2026-01-01T00:00:00.000Z",regime:{strategic:"defensive",tactical:"balanced"},regimeMeta:{},metrics:assemblyMetrics,blocks:{},detectors,scores:assemblyScores,sourceVintages:assemblyVintages,revisionAlerts:[]}).decision;
const recovered=assemble([{id:"recovery",state:"good"},{id:"macro_shock",state:"calm"}]);
assert.equal(recovered.target_pct,80,"detector wiring severed: recovery=good must lift defensive to the 80% floor");
assert.equal(recovered.inputs.recovery_state,"good","decision inputs must carry the real detector state");
assert.deepEqual(recovered.binding_overlays,["recovery_floor"]);
const shocked=assemble([{id:"recovery",state:"good"},{id:"macro_shock",state:"fired"}]);
assert.equal(shocked.target_pct,5,"macro shock must block the recovery floor through the assembly layer");
assert.equal(shocked.inputs.macro_shock_state,"fired");

console.log(`Policy suite lock OK: ${POLICY_SUITE_V1.id} ${POLICY_SUITE_V1.contract_sha256.slice(0,12)}`);
