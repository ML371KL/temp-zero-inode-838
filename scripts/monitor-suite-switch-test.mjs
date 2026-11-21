// Тесты монитора и сторожа при смене боевого набора правил v1 → v3 (выпуск 2.15.0).
// Запускаются из forward-monitor-test.mjs (он в `npm run check`) и отдельно. Сети и часов нет.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1, policySuiteMetadataV1 } from "../docs/policy-suite-v1.mjs";
import { POLICY_SUITE_V3, policySuiteMetadataV3 } from "../docs/policy-suite-v3.mjs";
import { FROZEN_V1_LINE, buildDecisionRecordV1, buildSourceVintagesV1, sha256, updateForwardMonitorV1, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";
import { STRATEGY_REGISTRY_V1 } from "./monitor-backfill-v1.mjs";
import { targetChangeRecordV1 } from "./monitor-changes-v1.mjs";
import { buildLiveDecisionV3 } from "./live-decision-v3.mjs";
import { validateSnapshotV1 } from "./monitor-live.mjs";

const DAY=86_400_000,HOUR=3_600_000,MIN=60_000;
const iso=t=>new Date(t).toISOString(),near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
const T0=Date.parse("2027-03-01T00:30:00.000Z")+(Number(process.env.MONITOR_TEST_DAY_SHIFT)||0)*DAY;
const PACKAGE_VERSION=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version;

const vintagesAt=t=>{const v=buildSourceVintagesV1({market:{source:"fixture",observed_at:iso(t),fetched_at:iso(t),data:[{t:1,v:100}]}},{market:{state:"ok",source:"fixture",observed_at:iso(t),fetched_at:iso(t)}});v.captured_at=iso(t);return v;};
const VINTAGES=vintagesAt(T0);
const BLOCKS={macro:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},demand:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},cycle:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},leverage:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}},market:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}}};
// Запись решения прежнего набора v1.
function v1Record(t,{strategic="defensive",mvrv=8,recovery="calm",coverage=true}={}){
  const metrics=[{id:"mvrv_cycle",vote:true,score:0,value_num:mvrv,observed_at:iso(t),source:"fixture"}];
  return buildDecisionRecordV1({generatedAt:iso(t),regime:{strategic,tactical:"balanced"},regimeMeta:{},metrics,blocks:BLOCKS,detectors:[{id:"recovery",state:recovery},{id:"macro_shock",state:"calm"}],scores:{strategic:0,tactical:0,critical_coverage_ok:coverage},sourceVintages:VINTAGES,revisionAlerts:[]});
}
// Вид линии движка v3, каким его отдаёт движок: режим, цель, ступень пола, запись входов фикса.
const LADDER={defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100};
function view(t,{state="defensive",target,overlays=[],closes=0,cheap=false,pending=null}={}){
  const fix=Math.floor((t-6*HOUR)/DAY)*DAY+6*HOUR;
  return{state,candidate:pending?.candidate??state,target_pct:target===undefined?LADDER[state]:target,base_target_pct:LADDER[state],binding_overlays:overlays,fix_at:iso(fix),next_fix_at:iso(fix+DAY),
    floor:{active:closes>0,rung:closes||null,level_pct:closes?[40,60,80][closes-1]:null,closes},pending,reason_codes:["between_fixes",`base:${state}`,...overlays],
    inputs:{blocks:{macro:-25,demand:-50,cycle:-35},families:{valuation:{v3:cheap?1:0},network:{v3:0},exchange_supply:{v3:0},trend:{v3:-2}},mvrv_percentile:8,mvrv_percentile_deep:cheap?8:19,deep_window_used:true,recovery:{state:closes?"good":"watch"},macro_shock_state:"calm"}};
}
const live=(t,ref,o)=>buildLiveDecisionV3({generatedAt:iso(t),v1Decision:ref,view:view(t,o)});
// Прогон монитора: без опоры — как до выпуска (боевой набор v1); с опорой — как после.
function tick(monitor,t,price,{v1={},v3=null,extra={}}={}){
  const built=v1Record(t,v1),decision=v3?live(t,built.decision,v3===true?{}:v3):built.decision;
  return updateForwardMonitorV1({previousMonitor:monitor,now:t,price,decision,inputSummary:built.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],...(v3?{referenceDecision:built.decision}:{}),...extra});
}
const targets=m=>Object.fromEntries(Object.entries(m.strategies).map(([k,v])=>[k,v.current_target_pct]));

// ================= 1. Прогон смены набора =================
{
  // До выпуска: v1, защитный режим, MVRV 8-й перцентиль — пол капитуляции держит 40 %.
  let m=tick(null,T0,60_000);
  m=tick(m,T0+15*MIN,60_000);
  assert.deepEqual([m.strategies.policy_v1.current_target_pct,m.strategies[FROZEN_V1_LINE],m.decision_log.at(-1).policy_hash],[40,undefined,POLICY_SUITE_V1.contract_sha256]);
  const before=structuredClone(m);
  // Выпуск: боевое решение — набор v3 (пол капитуляции требует согласия двух окон — цель 5 %), опора — v1 (40 %).
  m=tick(m,T0+30*MIN,60_000,{v3:true,extra:{v2Inputs:{mvrv_percentile_deep:19}}});
  assert.deepEqual([m.strategies.policy_v1.current_target_pct,m.strategies[FROZEN_V1_LINE].current_target_pct],[5,40],"боевая линия исполняет решение v3, линия прежних правил — решение v1");
  assert.deepEqual([m.strategies.previous_policy_shadow.current_target_pct,m.strategies.policy_v2_shadow.current_target_pct],[40,5],"тени v0 и v2 считаются от опоры: v0 — пол капитуляции по одному окну, v2 — по двум");
  assert.equal(m.strategies.policy_v1_tranched.current_target_pct,5,"исполнение траншами следует за боевым решением: понижение сразу");
  assert.ok(near(m.strategies.policy_v1.turnover_pct,before.strategies.policy_v1.turnover_pct+35),"оборот боевой линии — 35 п.п.");
  // Запись о рождении линии прежних правил и её вход.
  const meta=m.strategy_meta[FROZEN_V1_LINE];
  assert.deepEqual([meta.kind,meta.label,meta.started_at,meta.start_target_pct],[STRATEGY_REGISTRY_V1[FROZEN_V1_LINE].kind,STRATEGY_REGISTRY_V1[FROZEN_V1_LINE].label,iso(T0+30*MIN),40]);
  assert.ok(near(m.strategies[FROZEN_V1_LINE].nav,1-0.4*0.001),"линия прежних правил рождается с NAV 1 за вычетом входа");
  assert.ok(Number.isFinite(meta.base.policy_v1_nav),"у позже рождённой линии есть опорные числа боевой");
  // Подписи линий — из реестра: боевая линия названа боевой.
  assert.deepEqual([m.strategy_meta.policy_v1.label,m.strategy_meta.policy_v1.kind],[STRATEGY_REGISTRY_V1.policy_v1.label,"live"]);
  assert.match(m.strategy_meta.policy_v1.label,/боевая/);
  // Подпись, записанная прежним выпуском, обновляется из реестра на первом же прогоне.
  {const old=structuredClone(before);old.strategy_meta.policy_v1.label="политика v1";old.strategy_meta.policy_v1_tranched.kind="benchmark";
   const fresh=tick(old,T0+30*MIN,60_000,{v3:true});
   assert.deepEqual([fresh.strategy_meta.policy_v1.label,fresh.strategy_meta.policy_v1_tranched.kind,fresh.strategy_meta.policy_v1.started_at],[STRATEGY_REGISTRY_V1.policy_v1.label,STRATEGY_REGISTRY_V1.policy_v1_tranched.kind,before.strategy_meta.policy_v1.started_at]);}
  // Журнал смен цели: причина — смена правил, а не рынок.
  const change=m.target_change_log.at(-1);
  assert.deepEqual([change.from_pct,change.to_pct,change.direction,change.kind,change.overlays_from,change.overlays_to],[40,5,"down","overlay",["capitulation_floor"],[]]);
  assert.deepEqual(change.policy_switch,{from:POLICY_SUITE_V1.id,to:POLICY_SUITE_V3.id});
  assert.deepEqual(change.cause,{text:"смена боевых правил v1 → v3; пол капитуляции снят",families:[],detectors:[],candidate_since:null});
  // Журнал решений: новая запись с хэшем набора v3, цепочка цела, событие решения записано.
  const entry=m.decision_log.at(-1);
  assert.deepEqual([entry.policy_hash,entry.strategic,entry.target_pct,entry.binding_overlays,entry.v1],[POLICY_SUITE_V3.contract_sha256,"defensive",5,[],undefined]);
  assert.equal(verifyDecisionLogChainV1(m.decision_log).ok,true);
  assert.deepEqual([m.decision_events.length,m.target_changes,m.state_changes],[before.decision_events.length+1,before.target_changes+1,before.state_changes+1]);
  assert.deepEqual([m.health.operational_status,m.health.operational_issues],["healthy",[]],"решение набора v3 — известный набор: монитор здоров");
  assert.deepEqual(m.reference_last,{strategic:"defensive",target_pct:40});
  assert.equal(m.daily.at(-1).policy_target_pct,5);assert.equal(m.daily.at(-1).targets[FROZEN_V1_LINE],40);
  assert.equal(m.daily.at(-1).v2_diverged,true,"расхождение тени v2 считается с прежними правилами (5 против 40)");
  // Дальше: цель не меняется — записей о смене и отметки смены набора нет.
  const changes=m.target_change_log.length;
  m=tick(m,T0+45*MIN,54_000,{v3:true,extra:{v2Inputs:{mvrv_percentile_deep:19}}});
  assert.equal(m.target_change_log.length,changes);
  // −10 % BTC: боевая линия прошла его с долей 5 %, прежние правила — с долей 40 %.
  const cash=m.strategies.cash.nav/before.strategies.cash.nav;
  assert.ok(m.strategies[FROZEN_V1_LINE].nav<0.965&&m.strategies[FROZEN_V1_LINE].nav>0.955,`прежние правила: −10 % × 40 % ≈ −4 %: ${m.strategies[FROZEN_V1_LINE].nav}`);
  assert.ok(cash>1);
  // Следующая смена цели объясняется обычным порядком, без отметки смены набора.
  m=tick(m,T0+DAY+6*HOUR,54_000,{v1:{strategic:"deteriorating",mvrv:30},v3:{state:"deteriorating"}});
  const next=m.target_change_log.at(-1);
  assert.deepEqual([next.from_pct,next.to_pct,next.kind,next.policy_switch],[5,20,"regime",undefined]);
  assert.doesNotMatch(next.cause.text,/смена боевых правил/);
}

// ================= 2. Запись о смене цели на прогоне смены набора: варианты =================
{
  const base={at:iso(T0),price:60_000,gateOpen:true,policySwitch:{from:POLICY_SUITE_V1.id,to:POLICY_SUITE_V3.id}};
  const both=targetChangeRecordV1({...base,previous:{target_pct:80,strategic:"deteriorating",binding_overlays:["recovery_floor"]},decision:{target_pct:40,strategic:"defensive",binding_overlays:["recovery_floor"]}});
  assert.deepEqual([both.kind,both.cause.text],["regime","смена боевых правил v1 → v3; режим «ухудшается» → «защитный»"]);
  const added=targetChangeRecordV1({...base,previous:{target_pct:5,strategic:"defensive",binding_overlays:[]},decision:{target_pct:40,strategic:"defensive",binding_overlays:["recovery_floor"]}});
  assert.equal(added.cause.text,"смена боевых правил v1 → v3; пол восстановления включён");
  assert.equal(targetChangeRecordV1({...base,previous:{target_pct:5,strategic:"defensive",binding_overlays:[]},decision:{target_pct:5,strategic:"defensive",binding_overlays:[]}}),null,"цель не изменилась — записи нет и при смене набора");
  const start=targetChangeRecordV1({...base,previous:{target_pct:null},decision:{target_pct:5,strategic:"defensive",binding_overlays:[]}});
  assert.deepEqual([start.kind,start.policy_switch],["start",undefined],"старт наблюдения сменой набора не называется");
  const unknown=targetChangeRecordV1({...base,policySwitch:{from:null,to:"что-то"},previous:{target_pct:40,strategic:"defensive",binding_overlays:[]},decision:{target_pct:5,strategic:"defensive",binding_overlays:[]}});
  assert.equal(unknown.cause.text,"смена боевых правил ? → ?");
}

// ================= 2а. Ступень пола восстановления: цель меняется без смены режима и набора оверлеев =================
{
  // Рождение текущего кандидата — давняя смена режима. Раньше шаг пола получал её причиной.
  const staleBirth={strategic:{t:iso(T0-9*DAY),candidate:"transition",from_candidate:"deteriorating",blocks:{demand:{from:-25,to:-15,band_from:"adverse",band_to:"neutral"}},families:[{block:"demand",family:"etf",id:"etf_regime",name:"US spot-ETF · режим потоков",from:-1,to:-0.5}],detectors:[]}};
  const base={at:iso(T0),price:60_000,gateOpen:true,regimeBirth:staleBirth,candidateSince:iso(T0-9*DAY)};
  const step=(from,to,closes,codes=[])=>targetChangeRecordV1({...base,previous:{target_pct:from,strategic:"transition",binding_overlays:["recovery_floor"]},decision:{target_pct:to,strategic:"transition",binding_overlays:["recovery_floor"],reason_codes:["fix","base:transition","recovery_floor",...codes],inputs:{floor_closes:closes}}});
  const second=step(45,60,2),third=step(60,80,3);
  assert.deepEqual([second.kind,second.direction,second.cause.text,second.cause.candidate_since],["overlay","up","пол восстановления: ступень 2 из 3 — детектор подтверждён на втором фиксе подряд",null]);
  assert.equal(third.cause.text,"пол восстановления: ступень 3 из 3 — детектор подтверждён на третьем фиксе подряд");
  for(const record of [second,third]){assert.doesNotMatch(record.cause.text,/Спрос|ETF|режим «/,"причина давней смены режима шагу пола не приписывается");assert.deepEqual([record.cause.families,record.cause.detectors],[[],[]]);}
  const reset=step(80,45,1,["missed_fix_reset"]);
  assert.deepEqual([reset.kind,reset.direction,reset.cause.text],["overlay","down","пол восстановления: ступень 1 из 3 — счёт фиксов начат заново после пропущенных суток"]);
  assert.equal(step(60,80,7).cause.text,"пол восстановления: ступень изменилась — детектор подтверждён ещё на одном фиксе подряд","ступень вне лестницы числом не называется");
  // Без пола в оверлеях прежнее поведение: смена режима — причина из рождения кандидата.
  const regime=targetChangeRecordV1({...base,previous:{target_pct:20,strategic:"deteriorating",binding_overlays:[]},decision:{target_pct:45,strategic:"transition",binding_overlays:[]}});
  assert.equal(regime.kind,"regime");assert.match(regime.cause.text,/блок «Спрос» вышел из неблагоприятной полосы/);
  // Смена набора оверлеев — прежняя запись «пол … включён / снят».
  const on=targetChangeRecordV1({...base,previous:{target_pct:20,strategic:"deteriorating",binding_overlays:[]},decision:{target_pct:40,strategic:"deteriorating",binding_overlays:["recovery_floor"],inputs:{floor_closes:1}}});
  assert.deepEqual([on.kind,on.cause.text.startsWith("пол восстановления включён")],["overlay",true]);
}

// ================= 3. Гейты линий: боевая — по боевому решению, прежние правила — по опоре =================
{
  let m=tick(null,T0,60_000,{v3:true});
  assert.deepEqual([m.strategies.policy_v1.current_target_pct,m.strategies[FROZEN_V1_LINE].current_target_pct],[5,40]);
  // Боевое решение на паузе (движок не дал цели), опора действует: боевая линия держит долю, прежние правила исполняются.
  const t=T0+15*MIN,ref=v1Record(t,{strategic:"transition",mvrv:50}),paused=buildLiveDecisionV3({generatedAt:iso(t),v1Decision:ref.decision,view:null});
  assert.equal(paused.status,"paused");
  m=updateForwardMonitorV1({previousMonitor:m,now:t,price:60_000,decision:paused,inputSummary:ref.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],referenceDecision:ref.decision});
  assert.deepEqual([m.strategies.policy_v1.current_target_pct,m.strategies[FROZEN_V1_LINE].current_target_pct,m.strategies.previous_policy_shadow.current_target_pct,m.strategies.policy_v2_shadow.current_target_pct],[5,45,55,45],"тени v0 и v2 идут за режимом опоры, а не за боевым решением на паузе");
  assert.equal(m.health.operational_status,"paused");
  // Опора без покрытия (v1 «нет данных»), боевое решение держит цель фикса, но качество — пауза: все линии держат.
  const t2=T0+30*MIN,blind=v1Record(t2,{strategic:"insufficient",coverage:false}),held=live(t2,blind.decision,{state:"deteriorating"});
  assert.deepEqual([held.status,held.target_pct,held.quality.status],["actionable",20,"paused"]);
  m=updateForwardMonitorV1({previousMonitor:m,now:t2,price:60_000,decision:held,inputSummary:blind.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],referenceDecision:blind.decision});
  assert.deepEqual([m.strategies.policy_v1.current_target_pct,m.strategies[FROZEN_V1_LINE].current_target_pct],[5,45],"при паузе качества ни одна линия не исполняется");
}

// ================= 4. Здоровье: известные наборы =================
{
  const healthy=d=>updateForwardMonitorV1({previousMonitor:null,now:T0,price:60_000,decision:d,inputSummary:v1Record(T0).inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[]}).health.operational_issues;
  const ref=v1Record(T0).decision,v3=live(T0,ref,{});
  assert.deepEqual([healthy(ref),healthy(v3)],[[],[]]);
  assert.deepEqual(healthy({...v3,policy_hash:POLICY_SUITE_V1.contract_sha256}),["policy_hash_mismatch"],"хэш обязан быть хэшем того набора, который назван в решении");
  assert.deepEqual(healthy({...ref,policy_id:"btc-decision-suite-v9"}),["policy_hash_mismatch"],"неизвестный набор");
  const legacy={...ref};delete legacy.policy_id;
  assert.deepEqual(healthy(legacy),[],"запись прежней формы без policy_id проверяется как набор v1");
  assert.deepEqual(healthy({...legacy,policy_hash:POLICY_SUITE_V3.contract_sha256}),["policy_hash_mismatch"]);
}

// ================= 5. Готовый прогон движка вариантов и счётчики гистерезиса v1 =================
{
  const engine=()=>{throw new Error("движок не должен вызываться: передан готовый прогон");};
  const run={ran:true,ok:true,error:null,state:{v:1,v3:{s:"defensive"},marker:7},targets:{policy_v3_shadow:5,v1_daily_close:40,v1_floor_handoff:null,v1_no_cftc:40},published:{policy_v3_shadow:{target_pct:5,state:"defensive"},v1_daily_close:{target_pct:40},v1_no_cftc:{target_pct:40}},rejected:{}};
  const m=tick(null,T0,60_000,{v3:true,extra:{variantRun:run,variantEngine:engine,variantInputs:{anything:1}}});
  assert.deepEqual([m.variants_state,m.strategies.policy_v3_shadow.current_target_pct,m.strategies.v1_daily_close.current_target_pct,m.variant_errors],[run.state,5,40,undefined],"состояние и цели линий — из готового прогона");
  assert.equal(m.v3_candidate.live_suite,POLICY_SUITE_V3.id,"блок кандидата помечен: его правила стоят на бою");
  assert.equal(m.decision_log.at(-1).v3.target_pct,5);
  // Счётчик быстрых понижений v1 ведётся по режиму опоры, а не по боевому режиму.
  const meta=(candidate,state)=>({strategic:{candidate,state,count:2,since:iso(T0)}});
  let h=tick(null,T0,60_000,{v1:{strategic:"transition",mvrv:50},v3:{state:"transition"},extra:{referenceRegimeMeta:meta("transition","transition"),regimeMeta:{strategic:{candidate:"transition",state:"transition",count:1,since:iso(T0)}}}});
  h=tick(h,T0+15*MIN,60_000,{v1:{strategic:"transition",mvrv:50},v3:{state:"transition"},extra:{referenceRegimeMeta:meta("deteriorating","transition"),regimeMeta:{strategic:{candidate:"transition",state:"transition",count:1,since:iso(T0)}}}});
  h=tick(h,T0+30*MIN,60_000,{v1:{strategic:"deteriorating",mvrv:50},v3:{state:"transition"},extra:{referenceRegimeMeta:meta("deteriorating","deteriorating"),regimeMeta:{strategic:{candidate:"transition",state:"transition",count:1,since:iso(T0)}}}});
  assert.deepEqual([h.shadow_hysteresis.risk_off_confirmed_under_min_interval,h.shadow_hysteresis.risk_off_ref,h.reference_last.strategic,h.decision_log.at(-1).strategic],[1,"deteriorating","deteriorating","transition"],"понижение v1 за 15 минут посчитано, хотя боевой режим не менялся");
  // То же понижение, подтверждённое через 45 минут после первого встречного кандидата v1, быстрым не считается:
  // встречный кандидат берётся из состояния опоры (у боевого режима его в этом сценарии нет вовсе).
  const liveMeta={strategic:{candidate:"transition",state:"transition",count:1,since:iso(T0)}},step=(mon,t,refState,refCandidate)=>tick(mon,t,60_000,{v1:{strategic:refState,mvrv:50},v3:{state:"transition"},extra:{referenceRegimeMeta:meta(refCandidate,refState),regimeMeta:liveMeta}});
  let slow=step(null,T0,"transition","transition");slow=step(slow,T0+15*MIN,"transition","deteriorating");slow=step(slow,T0+60*MIN,"deteriorating","deteriorating");
  assert.deepEqual([slow.shadow_hysteresis.risk_off_confirmed_under_min_interval,slow.shadow_hysteresis.risk_off_ref],[0,"deteriorating"]);
}

// ================= 6. Разрыв учёта: линия прежних правил перезапускается =================
{
  let m=tick(null,T0,60_000,{v3:true});
  m=tick(m,T0+HOUR,60_000,{v3:true});
  const gap=structuredClone(m);gap.last_at=iso(T0+2*HOUR);gap.updated_at=iso(T0+2*HOUR);
  const back=tick(gap,T0+3*HOUR,60_000,{v3:true});
  assert.ok(back.line_restarts.at(-1).lines.includes(FROZEN_V1_LINE));
  assert.equal(back.strategy_meta[FROZEN_V1_LINE].started_at,iso(T0+3*HOUR));
}

// ================= 7. Сторож: какой набор он принимает =================
{
  const snapshotOf=(t,{v3})=>{
    const ref=v1Record(t),decision=v3?live(t,ref.decision,{}):ref.decision;
    const monitoring=updateForwardMonitorV1({previousMonitor:null,now:t,price:60_000,decision,inputSummary:ref.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],...(v3?{referenceDecision:ref.decision}:{})});
    return{schema:3,version:PACKAGE_VERSION,generated_at:iso(t),decision,policy_suite:v3?policySuiteMetadataV3():policySuiteMetadataV1(),monitoring,source_vintages:VINTAGES};
  };
  const now=T0+10*MIN,v3=snapshotOf(T0,{v3:true}),v1=snapshotOf(T0,{v3:false});
  assert.deepEqual(validateSnapshotV1(v3,now).issues,[],"снимок боевого набора v3 проходит");
  assert.deepEqual(validateSnapshotV1(v1,now).issues,[],"свежий снимок прежнего набора — окно выпуска, не инцидент");
  const stale=validateSnapshotV1(v1,T0+2*HOUR).issues;
  assert.ok(stale.includes("decision_policy_mismatch")&&stale.includes("snapshot_policy_contract_mismatch"),`прежний набор через два часа после выпуска — отказ: ${stale}`);
  // Подделка цели с пересчитанным хэшем записи: правило набора её не воспроизводит.
  const forged=structuredClone(v3);forged.decision.target_pct=95;delete forged.decision.decision_hash;forged.decision.decision_hash=sha256(forged.decision);
  assert.ok(validateSnapshotV1(forged,now).issues.includes("decision_reproduction_failure"));
  // Решение v3 под видом набора v1 и наоборот.
  const mixed=structuredClone(v3);mixed.policy_suite=policySuiteMetadataV1();
  assert.ok(validateSnapshotV1(mixed,now).issues.includes("snapshot_policy_contract_mismatch"));
  const relabel=structuredClone(v1);relabel.decision.policy_id=POLICY_SUITE_V3.id;delete relabel.decision.decision_hash;relabel.decision.decision_hash=sha256(relabel.decision);
  assert.ok(validateSnapshotV1(relabel,now).issues.includes("decision_policy_mismatch"));
  assert.equal(MODEL_POLICY_V1.forward_monitoring.operational_pause.snapshot_stale_hours>=2,true,"фикстура: два часа — ещё не протухший снимок");
}

console.log("Monitor suite switch OK: live line on v3, frozen v1 line, shadows from the reference, policy-switch cause, known suites, precomputed engine run, external monitor matrix");
