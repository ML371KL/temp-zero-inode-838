// Тесты боевого решения по набору v3: замок контракта, сборка записи из вида движка, проверка
// воспроизводимости, состояние режима по фиксам, причина смены режима.
// Запускаются из policy-suite-lock-test.mjs (он в `npm run check`) и отдельно. Сети и часов нет.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { EXECUTION_POLICY_V1 } from "../docs/execution-policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { POLICY_SUITE_V3, POLICY_SUITE_V3_DECISION_RECORD, policySuiteContractV3, policySuiteMetadataV3 } from "../docs/policy-suite-v3.mjs";
import { POLICY_V3_CANDIDATE, allocationDecisionV3, evaluateShadowVariantsV1, evaluateV3Inputs } from "../docs/policy-v3-candidate.mjs";
import { buildDecisionRecordV1, policySuiteDigestV1, sha256 } from "./forward-monitor-v1.mjs";
import { runShadowVariantsV1 } from "./monitor-lines-v1.mjs";
import { KNOWN_SUITE_HASHES, LIVE_REGIMES_V3, LIVE_SUITE_ID_V3, buildLiveDecisionV3, fixDiffV3, fixSnapshotV3, liveInputsV3, liveRegimeBirthV3, liveRegimeMetaV3, policySuiteDigestV3, reproduceDecisionV3 } from "./live-decision-v3.mjs";

const DAY=86_400_000,HOUR=3_600_000,MIN=60_000;
const T0=Date.parse("2026-11-02T00:00:00.000Z")+(Number(process.env.MONITOR_TEST_DAY_SHIFT)||0)*DAY;
const at=(day,hour=0,minute=0)=>T0+day*DAY+hour*HOUR+minute*MIN;
const iso=t=>new Date(t).toISOString(),clone=x=>JSON.parse(JSON.stringify(x));

// ================= 1. Контракт набора =================
{
  assert.equal(POLICY_SUITE_V3.id,"btc-decision-suite-v3");assert.equal(LIVE_SUITE_ID_V3,POLICY_SUITE_V3.id);
  assert.equal(policySuiteDigestV3(),POLICY_SUITE_V3.contract_sha256,"контракт боевого набора изменился: это новый набор, а не правка v3");
  assert.equal(policySuiteDigestV1(),POLICY_SUITE_V1.contract_sha256,"прежний набор не тронут");
  const engine=readFileSync(new URL("../docs/policy-v3-candidate.mjs",import.meta.url),"utf8").replace(/\r\n/g,"\n");
  assert.equal(sha256(engine),POLICY_SUITE_V3.engine_module_sha256,"текст движка изменился: набор обязывается на движок целиком");
  assert.deepEqual([POLICY_SUITE_V3.decision_engine_id,POLICY_SUITE_V3.decision_engine_revision,POLICY_SUITE_V3.supersedes],[POLICY_V3_CANDIDATE.id,POLICY_V3_CANDIDATE.revision,POLICY_SUITE_V1.id]);
  const contract=policySuiteContractV3();
  assert.deepEqual([contract.engine,contract.model,contract.execution,contract.decision_record],[POLICY_V3_CANDIDATE,MODEL_POLICY_V1,EXECUTION_POLICY_V1,POLICY_SUITE_V3_DECISION_RECORD]);
  assert.equal(contract.engine_code.allocationDecisionV3,allocationDecisionV3.toString().replace(/\r\n/g,"\n"));
  assert.equal(contract.suite.engine_module_sha256,POLICY_SUITE_V3.engine_module_sha256,"хэш модуля движка входит в дайджест набора");
  assert.ok(Object.isFrozen(POLICY_SUITE_V3)&&Object.isFrozen(POLICY_SUITE_V3_DECISION_RECORD)&&Object.isFrozen(POLICY_SUITE_V3_DECISION_RECORD.waived_criteria[0]));
  assert.equal(POLICY_SUITE_V3_DECISION_RECORD.approved_by,"owner");
  assert.match(POLICY_SUITE_V3_DECISION_RECORD.waived_criteria[0].criterion,/180/,"снятый критерий назван прямо");
  assert.deepEqual(KNOWN_SUITE_HASHES,{[POLICY_SUITE_V1.id]:POLICY_SUITE_V1.contract_sha256,[POLICY_SUITE_V3.id]:POLICY_SUITE_V3.contract_sha256});
  assert.deepEqual(policySuiteMetadataV3(),{...POLICY_SUITE_V3});
}

// ---------- синтетические входы движка (по образцу policy-v3-candidate-test.mjs) ----------
const daily=(lastT,n,fn)=>Array.from({length:n},(_,i)=>({t:lastT-(n-1-i)*DAY,v:fn(i,n)}));
// price: "up" — выше всех средних (тренд +2); "below200w" — ниже 200-недельной (тренд −2).
function seriesFor(now,{deep=50,price="up"}={}){
  const today=Math.floor(now/DAY)*DAY,closes=daily(today-DAY,1500,price==="up"?i=>50_000+20*i:(i,n)=>(i===n-1?95_000:100_000));
  return{hashrate:daily(today,200,()=>9e20),difficulty:Array.from({length:20},(_,i)=>({t:today-2*DAY-(19-i)*14*DAY,v:1.3e14})),exchange_supply:daily(today-DAY,1700,()=>2_700_000),
    price_daily:[...closes,{t:today,v:closes.at(-1).v}],mvrv:daily(today-DAY,10,()=>1.5),mvrv_deep:daily(today-DAY,2400,(i,n)=>(i===n-1?1+deep/100+0.001:1+(i%200)/200))};
}
const PRESET={transition:{macro:[0,0,0],demand:[0,0]},deteriorating:{macro:[0,0,0],demand:[-1,-1]},defensive:{macro:[-2,-1,0],demand:[-1,-1]},constructive:{macro:[0,0,0],demand:[1,1]}};
const familiesOf=(preset,{macro={},demand={},cycle={}}={})=>{const p=PRESET[preset];return{macro:{liquidity:p.macro[0],conditions:p.macro[1],stress:p.macro[2],...macro},demand:{etf:p.demand[0],stablecoins:p.demand[1],exchange_supply:0,institutional:0,...demand},cycle:{valuation:0,network:0,activity:0,miners:0,trend:2,...cycle}};};
function mk(now,o={}){
  const cand=o.cand??"transition",state=o.state??cand,families=o.families??familiesOf(LIVE_REGIMES_V3.includes(cand)?cand:"transition",o.fam);
  const v1={state,candidate:cand,critical_ok:o.critical??cand!=="insufficient",recovery_state:o.recovery??"calm",macro_shock_state:o.shock??"calm",distribution_state:"calm",mvrv_percentile:o.mvrv===undefined?50:o.mvrv,valuation_score:families.cycle.valuation};
  v1.target_pct=allocationDecisionV1({strategic:state,recoveryState:v1.recovery_state,macroShockState:v1.macro_shock_state,mvrvPercentile:v1.mvrv_percentile}).target_pct;
  const yesterday=iso(Math.floor(now/DAY)*DAY-DAY);
  return{price:80_000,hard_override:o.hard??false,v1,families,series:seriesFor(now,o.s),observed_at:{mvrv:yesterday,coinmetrics:yesterday,etf:yesterday,network:iso(Math.floor(now/DAY)*DAY),market:iso(Math.floor(now/DAY)*DAY)}};
}
// Запись решения v1 на этом прогоне — источник качества и краткосрочного режима.
const VINTAGES={mode:"as_collected",captured_at:null,sources:{},contract_sha256:sha256({})};
const v1Record=(t,{strategic="transition",coverage=true,stale=0}={})=>{
  const vintages=stale?{...VINTAGES,sources:{etf:{state:"stale"}}}:VINTAGES;
  return buildDecisionRecordV1({generatedAt:iso(t),regime:{strategic,tactical:"balanced"},regimeMeta:{},metrics:[{id:"mvrv_cycle",vote:true,score:0,value_num:50,observed_at:iso(t),source:"fixture"}],blocks:{},detectors:[{id:"recovery",state:"calm"},{id:"macro_shock",state:"calm"}],scores:{strategic:0,tactical:0,critical_coverage_ok:coverage},sourceVintages:vintages,revisionAlerts:[]}).decision;
};
// Прогон последовательности снимков настоящим движком через ту же обёртку, что в сборщике.
function drive(steps,state=null){
  const outs=[];let meta=null,birth=null;
  for(const [now,o,extra={}] of steps){
    const inputs=mk(now,o),run=runShadowVariantsV1({engine:evaluateShadowVariantsV1,now,inputs,state:clone(state)});
    assert.equal(run.ok,true,run.error);state=run.state;
    const view=run.published.policy_v3_shadow,decision=buildLiveDecisionV3({generatedAt:iso(now),v1Decision:v1Record(now,extra.v1),view});
    const newFix=view.fix_at===iso(now),calc=newFix?evaluateV3Inputs({now,inputs}):null,previousMeta=meta;
    meta=liveRegimeMetaV3({decision,view,previousMeta,now,calc});
    birth=liveRegimeBirthV3({previousBirth:birth,previousMeta,meta,metrics:METRICS,now,price:inputs.price});
    assert.deepEqual(clone(meta),JSON.parse(JSON.stringify(meta)),"состояние режима переживает JSON");
    outs.push({view,decision,meta:clone(meta),birth:clone(birth),inputs});
  }
  return{outs,state};
}
const METRICS=[["macro","liquidity","liquidity_regime","Режим чистой долларовой ликвидности"],["macro","conditions","financial_conditions","Реальные ставки и доллар"],["macro","stress","system_stress","Кредит и системный стресс"],["demand","etf","etf_regime","US spot-ETF · режим потоков"],["demand","stablecoins","stablecoin_regime","Стейблкоин-ликвидность"],["demand","exchange_supply","exchange_supply","Биржевое предложение BTC"],["demand","institutional","institutional_quality","Качество институционального спроса"],["cycle","valuation","mvrv_cycle","MVRV · динамический цикл"],["cycle","trend","trend_regime","Старший ценовой тренд"]].map(([block,family,id,name])=>({id,name,block,family,vote:true,strategic:true,score:0}));
const core=d=>[d.status,d.strategic,d.base_target_pct,d.target_pct,d.binding_overlays];
const verify=d=>{const copy={...d};delete copy.decision_hash;assert.equal(d.decision_hash,sha256(copy),"decision_hash покрывает запись");const r=reproduceDecisionV3(d);assert.equal(r.ok,true,`запись не воспроизводится: ${r.reason} ${JSON.stringify(core(d))}`);return r.reason;};

// ================= 2. Запись решения из вида движка =================
{
  // Холодный старт: линия наследует режим и цель v1; до первого фикса правило набора цель не выводит.
  const{outs,state}=drive([[at(0,3),{cand:"transition"}],[at(0,6),{cand:"transition"}],[at(0,6,15),{cand:"deteriorating"}],[at(1,6),{cand:"deteriorating"}],[at(2,6),{cand:"transition"}],[at(2,9),{cand:"transition"}],[at(3,6),{cand:"transition"}]]);
  const [cold,fix1,between,down,pending,held,up]=outs.map(o=>o.decision);
  assert.deepEqual(core(cold),["actionable","transition",45,45,[]]);
  assert.deepEqual([cold.inputs.reproducible,verify(cold)],[false,"inherited_before_first_fix"]);
  assert.deepEqual([cold.policy_id,cold.policy_hash,cold.schema,cold.tactical,cold.quality.status],[POLICY_SUITE_V3.id,POLICY_SUITE_V3.contract_sha256,1,"balanced","good"]);
  assert.deepEqual([fix1.inputs.reproducible,verify(fix1),fix1.inputs.fix_at,fix1.inputs.next_fix_at],[true,"v3_allocation",iso(at(0,6)),iso(at(1,6))]);
  // Между фиксами ухудшение кандидата v1 цель не меняет: решение ждёт фикса.
  assert.deepEqual(core(between),core(fix1));assert.equal(between.state_hash,fix1.state_hash);assert.ok(between.reason_codes.includes("between_fixes"));
  // Понижение — на первом же фиксе.
  assert.deepEqual(core(down),["actionable","deteriorating",20,20,[]]);assert.notEqual(down.state_hash,fix1.state_hash);verify(down);
  // Повышение ждёт второго фикса подряд: режим прежний, ожидание записано.
  assert.deepEqual(core(pending),["actionable","deteriorating",20,20,[]]);
  assert.deepEqual([pending.inputs.candidate,pending.inputs.pending],["transition",{candidate:"transition",fixes:1,need:2}]);
  assert.ok(pending.reason_codes.includes("upgrade_pending:transition:1/2"));verify(pending);
  assert.deepEqual(core(held),core(pending));
  assert.deepEqual(core(up),["actionable","transition",45,45,[]]);assert.equal(up.inputs.pending,null);verify(up);
  assert.deepEqual(up.regime_targets_pct,{emergency:0,defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100});
  // Состояние режима по фиксам.
  const metas=outs.map(o=>o.meta);
  assert.deepEqual([metas[0].count,metas[0].since,metas[0].fix_at],[1,iso(at(0,3)),iso(at(0,3))]);
  assert.deepEqual([metas[1].count,metas[1].candidate,metas[1].hold_until],[2,"transition",undefined],"тот же кандидат на новом фиксе — счёт растёт");
  assert.deepEqual([metas[2].count,metas[2].fix_at],[2,iso(at(0,6))],"между фиксами счёт стоит");
  assert.deepEqual([metas[3].state,metas[3].candidate,metas[3].count,metas[3].since],["deteriorating","deteriorating",1,iso(at(1,6))]);
  assert.deepEqual([metas[4].state,metas[4].candidate,metas[4].count,metas[4].hold_until,metas[4].pending],["deteriorating","transition",1,iso(at(3,6)),{candidate:"transition",fixes:1,need:2}],"пока повышение ждёт, hold_until — время следующего фикса");
  assert.deepEqual([metas[5].hold_until,metas[5].count],[iso(at(3,6)),1]);
  assert.deepEqual([metas[6].state,metas[6].count,metas[6].hold_until,metas[6].since],["transition",2,undefined,iso(at(2,6))]);
  for(const m of metas)assert.deepEqual([m.downStreak,m.anchor],[0,m.state]);
  assert.equal(state.v3.s,"transition");
  // Причина понижения: спрос ушёл в неблагоприятную полосу, семьи названы карточками.
  const birth=outs[3].birth;
  assert.deepEqual([birth.t,birth.candidate,birth.from_candidate,birth.note],[iso(at(1,6)),"deteriorating","transition",null]);
  assert.deepEqual(birth.blocks,{demand:{from:0,to:-25,band_from:"neutral",band_to:"adverse"}});
  assert.deepEqual(birth.families.map(f=>[f.block,f.family,f.id,f.from,f.to]),[["demand","etf","etf_regime",0,-1],["demand","stablecoins","stablecoin_regime",0,-1]]);
  assert.deepEqual(outs[2].birth,outs[1].birth,"между фиксами запись о рождении переносится");
  assert.deepEqual([outs[4].birth.candidate,outs[4].birth.from_candidate,outs[4].birth.t],["transition","deteriorating",iso(at(2,6))],"рождение кандидата повышения — на фиксе, где он появился");
  assert.deepEqual(outs[6].birth,outs[4].birth,"принятие кандидата новой записи не создаёт");
}

// ================= 3. Полы: ступени восстановления и согласие двух окон =================
{
  // Дёшево в обоих окнах, тренд и потоки не против: детектор «восстановление» подтверждён.
  const cheapGood={cand:"defensive",mvrv:20,s:{deep:20}},steps=[[at(0,3),{cand:"defensive"}]];
  for(let d=0;d<4;d++)steps.push([at(d,6),cheapGood]);
  const d=drive(steps).outs.map(o=>o.decision);
  assert.deepEqual(core(d[1]),["actionable","defensive",5,40,["recovery_floor"]],"первая ступень пола; повышение режима ждёт второго фикса");
  assert.deepEqual([d[1].inputs.floor_closes,d[1].inputs.recovery_state,d[1].regime_targets_pct.defensive,d[1].regime_targets_pct.transition],[1,"good",40,45]);
  assert.deepEqual(core(d[2]),["actionable","transition",45,60,["recovery_floor"]]);
  assert.deepEqual(core(d[3]),["actionable","transition",45,80,["recovery_floor"]]);
  assert.deepEqual(core(d[4]),core(d[3]),"ступеней три");
  d.slice(1).forEach(verify);
  // Пол капитуляции: только при согласии окна четырёх лет и всей истории.
  const both=drive([[at(0,3),{cand:"defensive"}],[at(0,6),{cand:"defensive",mvrv:8,s:{deep:8,price:"below200w"}}]]).outs[1].decision;
  assert.deepEqual([core(both),both.inputs.cheap,both.inputs.mvrv_percentile,both.inputs.deep_window_used],[["actionable","defensive",5,40,["capitulation_floor"]],true,8,true]);verify(both);
  const oneWindow=drive([[at(0,3),{cand:"defensive"}],[at(0,6),{cand:"defensive",mvrv:8,s:{deep:19,price:"below200w"}}]]).outs[1].decision;
  assert.deepEqual([core(oneWindow),oneWindow.inputs.cheap],[["actionable","defensive",5,5,[]],false],"одно четырёхлетнее окно пол не включает");verify(oneWindow);
  assert.equal(oneWindow.regime_targets_pct.defensive,5);assert.equal(both.regime_targets_pct.defensive,40);
}

// ================= 4. Паузы, авария, качество =================
{
  const now=at(0,6),v1=v1Record(now);
  const none=buildLiveDecisionV3({generatedAt:iso(now),v1Decision:v1,view:null}),failed=buildLiveDecisionV3({generatedAt:iso(now),v1Decision:v1,view:null,engineError:"engine_threw"});
  assert.deepEqual([core(none),none.reason_codes[0],none.quality.status],[["paused","insufficient",null,null,[]],"live_engine_not_run","paused"]);
  assert.equal(failed.reason_codes[0],"live_engine_failed");verify(none);verify(failed);
  // До первого режима v1 линия ждёт.
  const waiting=drive([[at(0,3),{cand:"insufficient",state:"insufficient"}]]).outs[0].decision;
  assert.deepEqual([core(waiting),waiting.reason_codes[0]],[["paused","insufficient",null,null,[]],"waiting_first_regime"]);verify(waiting);
  // Фикс без данных: цель держится прежняя, решение на паузе.
  const blind=drive([[at(0,3),{cand:"transition"}],[at(0,6),{cand:"transition"}],[at(1,6),{cand:"insufficient",state:"transition",critical:false}]]).outs[2];
  assert.deepEqual([core(blind.decision),blind.decision.reason_codes[0],blind.view.target_pct],[["paused","transition",null,null,[]],"no_target_on_fix",null]);verify(blind.decision);
  assert.deepEqual(blind.decision.regime_targets_pct.transition,45,"цели по режимам публикуются и на паузе");
  // Авария.
  const hard=drive([[at(0,3),{cand:"transition"}],[at(0,6),{cand:"transition"}],[at(0,7),{cand:"emergency",state:"emergency",hard:true}]]).outs[2].decision;
  assert.deepEqual(core(hard),["actionable","emergency",0,0,["emergency_override"]]);assert.equal(verify(hard),"emergency");assert.equal(hard.inputs.reproducible,false);
  // Качество: нет критического покрытия — пауза при конечной цели; несвежий источник — degraded.
  const ok=drive([[at(0,3),{}],[at(0,6),{}]]).outs[1];
  const uncovered=buildLiveDecisionV3({generatedAt:iso(at(0,6)),v1Decision:v1Record(at(0,6),{coverage:false}),view:ok.view}),stale=buildLiveDecisionV3({generatedAt:iso(at(0,6)),v1Decision:v1Record(at(0,6),{stale:1}),view:ok.view});
  assert.deepEqual([uncovered.status,uncovered.target_pct,uncovered.quality.status,uncovered.quality.critical_coverage_ok],["actionable",45,"paused",false]);
  assert.deepEqual([stale.quality.status,stale.quality.stale_or_partial_sources],["degraded",1]);verify(uncovered);verify(stale);
  // Мусор вместо вида линии цели не даёт.
  for(const view of ["строка",[],{state:"transition",target_pct:"45"},{state:"transition",target_pct:140},{state:"странный",target_pct:45},{target_pct:45}])assert.equal(buildLiveDecisionV3({generatedAt:iso(now),v1Decision:v1,view}).status,"paused",JSON.stringify(view));
}

// ================= 5. Проверка записи: что она ловит =================
{
  const good=drive([[at(0,3),{cand:"defensive"}],[at(0,6),{cand:"defensive",mvrv:8,s:{deep:8,price:"below200w"}}]]).outs[1].decision;
  const tamper=fn=>{const d=clone(good);fn(d);return reproduceDecisionV3(d);};
  assert.deepEqual([tamper(d=>{d.target_pct=5;}).ok,tamper(d=>{d.binding_overlays=[];}).ok,tamper(d=>{d.base_target_pct=20;}).ok,tamper(d=>{d.inputs.cheap=false;}).ok,tamper(d=>{d.inputs.floor_closes=3;}).ok,tamper(d=>{d.strategic="transition";}).ok,tamper(d=>{d.regime_targets_pct.constructive=50;}).ok],[false,false,false,false,false,false,false]);
  assert.deepEqual([tamper(d=>{d.policy_hash="0".repeat(64);}).reason,tamper(d=>{d.policy_id="btc-decision-suite-v9";}).reason,reproduceDecisionV3(null).reason,tamper(d=>{d.status="странный";}).ok],["unknown_suite_or_hash","unknown_suite_or_hash","decision_missing",false]);
  assert.equal(tamper(d=>{d.status="paused";}).ok,false,"пауза с конечной целью не проходит");
  // Запись прежнего набора проверяется его правилом: журнал и стартовый снимок выпуска остаются проверяемыми.
  const old=v1Record(at(0,6),{strategic:"defensive"});
  assert.deepEqual(reproduceDecisionV3(old),{ok:true,suite:POLICY_SUITE_V1.id,reason:"v1_allocation"});
  assert.equal(reproduceDecisionV3({...old,target_pct:80}).ok,false);
  // Хэш состояния меняется вместе с набором: первая запись выпуска — событие решения.
  const live=buildLiveDecisionV3({generatedAt:old.decided_at,v1Decision:old,view:{state:"defensive",candidate:"defensive",target_pct:5,base_target_pct:5,binding_overlays:[],floor:{closes:0},reason_codes:["between_fixes"],inputs:{families:{valuation:{v3:0}}}}});
  assert.deepEqual(core(live),core(old));assert.notEqual(live.state_hash,old.state_hash);assert.notEqual(live.policy_hash,old.policy_hash);
}

// ================= 6. Разница фиксов и рождение кандидата: края =================
{
  const calc=(families,extra={})=>({families,blocks:{macro:0,demand:-25,cycle:10},recovery:{state:"watch"},macro_shock_state:"calm",valuation:{cheap:false},record:{mvrv_percentile:31.239,mvrv_percentile_deep:28},...extra});
  const a=fixSnapshotV3(calc(familiesOf("transition")),{floor:{closes:0}}),b=fixSnapshotV3(calc(familiesOf("transition",{cycle:{trend:-1},demand:{exchange_supply:0.5}}),{recovery:{state:"good"},record:{mvrv_percentile:24.5,mvrv_percentile_deep:22}}),{floor:{closes:1}});
  assert.deepEqual([a.mvrv_percentile,a.floor_closes,a.cheap,b.floor_closes,b.recovery_state],[31.24,0,false,1,"good"]);
  const diff=fixDiffV3(a,b,METRICS);
  assert.deepEqual(diff.families.map(f=>[f.id,f.name,f.from,f.to]).sort(),[["exchange_supply","Биржевое предложение BTC",0,0.5],["trend_regime","Старший ценовой тренд",2,-1]]);
  assert.deepEqual([diff.detectors,diff.mvrv_percentile,diff.source],[[{id:"recovery",from:"watch",to:"good"}],{from:31.24,to:24.5},"fix"]);
  assert.deepEqual([fixDiffV3(null,b,METRICS),fixDiffV3(a,null,METRICS),fixSnapshotV3(null,{}),fixSnapshotV3({},{})],[null,null,null,null]);
  assert.deepEqual(fixDiffV3(a,a,METRICS),{families:[],detectors:[],source:"fix"});
  // Прежнее состояние формы v1 (без fix_at) — старт счёта заново, рождение не выдумывается.
  const v1Meta={state:"defensive",candidate:"defensive",count:735,since:"2026-10-12T11:39:36.337Z",downStreak:0,anchor:"defensive"};
  const view={state:"defensive",candidate:"defensive",target_pct:5,fix_at:iso(at(0,6)),next_fix_at:iso(at(1,6)),floor:{closes:0,level_pct:null},pending:null};
  const first=liveRegimeMetaV3({decision:{strategic:"defensive"},view,previousMeta:v1Meta,now:at(0,6,15),calc:calc(familiesOf("defensive"))});
  assert.deepEqual([first.count,first.since,first.fix_at,first.fix?.blocks?.demand],[1,iso(at(0,6)),iso(at(0,6)),-25]);
  const priorBirth={t:"2026-10-12T11:39:36.337Z",candidate:"defensive"};
  assert.equal(liveRegimeBirthV3({previousBirth:priorBirth,previousMeta:v1Meta,meta:first,metrics:METRICS,now:at(0,6,15),price:1}),priorBirth);
  assert.equal(liveRegimeBirthV3({previousBirth:priorBirth,previousMeta:first,meta:null,metrics:METRICS,now:at(0,7),price:1}),priorBirth);
  // Смена кандидата без снимка прежнего фикса: запись есть, причина честно пустая.
  const noFix={...first,fix:null},next=liveRegimeMetaV3({decision:{strategic:"defensive"},view:{...view,candidate:"deteriorating",fix_at:iso(at(1,6)),next_fix_at:iso(at(2,6)),pending:{candidate:"deteriorating",fixes:1,need:2}},previousMeta:noFix,now:at(1,6),calc:calc(familiesOf("deteriorating"))});
  const blank=liveRegimeBirthV3({previousBirth:priorBirth,previousMeta:noFix,meta:next,metrics:METRICS,now:at(1,6),price:70_000});
  assert.deepEqual([blank.candidate,blank.from_candidate,blank.note,blank.families,blank.price],["deteriorating","defensive","no_previous_fix",[],70_000]);
  // Запись о другом кандидате и запись из будущего не переносятся.
  assert.equal(liveRegimeBirthV3({previousBirth:{t:"2026-10-12T11:39:36.337Z",candidate:"transition"},previousMeta:v1Meta,meta:first,metrics:METRICS,now:at(0,6,15),price:1}),null);
  assert.equal(liveRegimeBirthV3({previousBirth:{t:iso(at(5)),candidate:"defensive"},previousMeta:v1Meta,meta:first,metrics:METRICS,now:at(0,6,15),price:1}),null);
  // Что боевое правило читает на прогоне: настоящий расчёт движка на синтетических входах.
  const now=at(2,9),inputs=mk(now,{cand:"defensive",mvrv:8,s:{deep:19,price:"below200w"}}),live=liveInputsV3(evaluateV3Inputs({now,inputs}),iso(now));
  assert.deepEqual([live.at,live.candidate,live.cheap,live.mvrv_percentile,live.deep_window_used,live.recovery.anchor,live.families.cycle.trend,live.families.cycle.valuation,live.bands.macro,live.bands.demand,live.closed_day],[iso(now),"defensive",false,8,true,true,-2,0,"adverse","adverse",iso(at(1)).slice(0,10)]);
  assert.ok(live.mvrv_percentile_deep>10&&live.mvrv_percentile_deep<25&&JSON.stringify(live).length<900,JSON.stringify(live).length+" Б");
  assert.equal(liveInputsV3(null,iso(now)),null);
  // Без вида движка состояние остаётся читаемым.
  const bare=liveRegimeMetaV3({decision:{strategic:"insufficient"},view:null,previousMeta:first,now:at(1,7)});
  assert.deepEqual([bare.state,bare.candidate,bare.fix_at,bare.count,bare.fix],["insufficient","insufficient",null,1,first.fix]);
}

console.log(`Live decision v3 OK: ${POLICY_SUITE_V3.id} ${POLICY_SUITE_V3.contract_sha256.slice(0,12)} — suite lock, decision record from the engine view, reproduction, daily-fix regime state, cause of regime change`);
