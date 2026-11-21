/*
 * Боевое решение по набору btc-decision-suite-v3 (выпуск 2.15.0).
 *
 * Модуль ничего не решает: решает движок docs/policy-v3-candidate.mjs, тот же, что с 13.10.2026
 * считал теневую линию policy_v3_shadow. Здесь его ответ («вид линии») превращается в запись
 * решения прежней формы — её читают витрина, уведомления, монитор и сторож, — и проверяется, что
 * запись воспроизводится правилом набора.
 *
 * Чистые функции, без сети и часов: время и входы передаются явно.
 */

import { createHash } from "node:crypto";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { POLICY_SUITE_V3, policySuiteContractV3 } from "../docs/policy-suite-v3.mjs";
import { POLICY_V3_CANDIDATE, allocationDecisionV3, policyV3CandidateMetadata } from "../docs/policy-v3-candidate.mjs";

// Тот же канонический вид и тот же хэш, что в forward-monitor-v1.mjs (импорт оттуда дал бы цикл).
function stableStringify(value){
  if(value===undefined)return "null";
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return`[${value.map(stableStringify).join(",")}]`;
  return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
const sha256=value=>createHash("sha256").update(typeof value==="string"?value:stableStringify(value)).digest("hex");
export const policySuiteDigestV3=()=>sha256(policySuiteContractV3());

const isObject=x=>!!x&&typeof x==="object"&&!Array.isArray(x);
const isNum=x=>typeof x==="number"&&Number.isFinite(x);
const num=x=>isNum(x)?x:null;
const str=x=>typeof x==="string"&&x?x:null;
const iso=t=>new Date(t).toISOString();
// Метаданные правила аллокации для снимка: движок кандидата, поставленный на бой набором v3.
// Сам модуль движка не правится (его статус там — «теневой кандидат»): боевым его делает набор.
export function liveAllocationMetadataV3(){return{...policyV3CandidateMetadata(),status:"live",live_suite:POLICY_SUITE_V3.id,live_approved_at:POLICY_SUITE_V3.approved_at};}
export const LIVE_REGIMES_V3=Object.freeze(["defensive","deteriorating","transition","unconfirmed_positive","constructive"]);
const EMERGENCY="emergency",CHEAP_SCORE=1;

// Наборы, решения которых эта версия кода умеет проверять. Боевой — один; прежний остаётся
// известным: его решения лежат в журнале, в опоре и в снимке, с которого стартует выпуск.
export const LIVE_SUITE_ID_V3=POLICY_SUITE_V3.id;
export const KNOWN_SUITE_HASHES=Object.freeze({[POLICY_SUITE_V1.id]:POLICY_SUITE_V1.contract_sha256,[POLICY_SUITE_V3.id]:POLICY_SUITE_V3.contract_sha256});

// Когда решение ПРЕЖНЕГО набора допустимо в проверяемом снимке. Боевой набор один — v3; снимок с
// решением набора v1 законен только как стартовый: он лежит в репозитории и на витрине до первого
// сбора новым кодом. strict — проверка, которая стартового снимка видеть не может: кандидат на
// публикацию (REQUIRE_LIVE=1) и снимок, переживший окно выпуска. Общее правило для гейта публикации
// и сторожа: разойдись они, сбор либо не стартовал бы после выпуска, либо пропускал бы откат.
export function acceptsSupersededSuiteV3(decision,{strict=false}={}){
  return strict!==true&&isObject(decision)&&decision.policy_id===POLICY_SUITE_V1.id;
}

// «Дёшево» движок решает сам (согласие двух окон MVRV) и записывает баллом оценки: +1 ставится
// только при cheap. Перцентили в записи округлены, поэтому признак берётся из балла, а не из них.
const cheapOf=record=>isObject(record)?record.families?.valuation?.v3===CHEAP_SCORE:null;

function regimeTargets(floorCloses,cheap){
  const out={[EMERGENCY]:POLICY_V1.ladder.emergency};
  for(const strategic of LIVE_REGIMES_V3)out[strategic]=allocationDecisionV3({strategic,floorCloses,cheap:cheap===true}).target_pct;
  return out;
}

/*
 * Запись боевого решения.
 *   v1Decision — запись решения прежнего набора на этом же прогоне: из неё берутся краткосрочный
 *                режим и оценка качества входов (покрытие, несвежие источники, пересмотры);
 *   view       — вид линии policy_v3_shadow из прогона движка вариантов; null — движок не ответил.
 * Цели нет (движок не ответил, фикс без данных, до первого режима v1) — решение на паузе: витрина
 * цель не показывает, монитор держит прежнюю долю.
 */
export function buildLiveDecisionV3({generatedAt,v1Decision,view=null,engineError=null}={}){
  const v=isObject(view)?view:null,policyHash=POLICY_SUITE_V3.contract_sha256;
  const state=str(v?.state),hard=state===EMERGENCY,known=hard||LIVE_REGIMES_V3.includes(state);
  const target=num(v?.target_pct),actionable=known&&target!==null&&target>=0&&target<=100;
  const strategic=known?state:"insufficient",tactical=v1Decision?.tactical??null;
  const record=isObject(v?.inputs)?v.inputs:null,floorCloses=Number.isInteger(v?.floor?.closes)&&v.floor.closes>=0?v.floor.closes:0,cheap=cheapOf(record);
  const overlays=hard?["emergency_override"]:Array.isArray(v?.binding_overlays)?v.binding_overlays.filter(x=>typeof x==="string"):[];
  const codes=(Array.isArray(v?.reason_codes)?v.reason_codes.filter(x=>typeof x==="string"):[]).slice(0,24);
  if(!actionable)codes.unshift(!v?(engineError?"live_engine_failed":"live_engine_not_run"):!known?"waiting_first_regime":"no_target_on_fix");
  const status=actionable?"actionable":"paused";
  const base=!actionable?null:hard?POLICY_V1.ladder.emergency:num(v.base_target_pct);
  const inputs={
    strategic,candidate:str(v?.candidate),floor_closes:floorCloses,cheap,
    // Воспроизводимо правилом набора всё, что решено на фиксе. До первого фикса линия держит цель,
    // унаследованную при рождении, — её правило набора не выводит.
    reproducible:actionable&&!hard&&record!==null,
    fix_at:str(v?.fix_at),next_fix_at:str(v?.next_fix_at),pending:isObject(v?.pending)?{candidate:str(v.pending.candidate),fixes:num(v.pending.fixes),need:num(v.pending.need)}:null,
    mvrv_percentile:num(record?.mvrv_percentile),mvrv_percentile_deep:num(record?.mvrv_percentile_deep),deep_window_used:typeof record?.deep_window_used==="boolean"?record.deep_window_used:null,
    recovery_state:str(record?.recovery?.state),macro_shock_state:str(record?.macro_shock_state),
  };
  const q=v1Decision?.quality||{},coverageOk=q.critical_coverage_ok===true;
  const quality={
    status:!coverageOk||!actionable?"paused":(Number(q.stale_or_partial_sources)||0)||(Number(q.quality_affecting_revision_alerts)||0)?"degraded":"good",
    critical_coverage_ok:coverageOk,stale_or_partial_sources:Number(q.stale_or_partial_sources)||0,revision_alerts:Number(q.revision_alerts)||0,
    quality_affecting_revision_alerts:Number(q.quality_affecting_revision_alerts)||0,audit_revision_alerts:Number(q.audit_revision_alerts)||0,
  };
  // Хэш входов: то, что прочитал движок на фиксе, плюс обязательства прежней записи (её input_hash
  // покрывает баллы всех карточек и винтажи источников этого прогона).
  const inputHash=sha256(JSON.parse(JSON.stringify({generated_at:generatedAt,regime:{strategic,tactical},live_inputs:inputs,engine_inputs_sha256:record?sha256(record):null,v1_input_hash:v1Decision?.input_hash??null})));
  const targetOut=actionable?target:null;
  const stateHash=sha256({policy_hash:policyHash,status,strategic,tactical,base_target_pct:base,target_pct:targetOut,binding_overlays:actionable?overlays:[]});
  const decision={
    schema:1,decided_at:generatedAt,policy_id:POLICY_SUITE_V3.id,policy_hash:policyHash,input_hash:inputHash,state_hash:stateHash,
    status,strategic,tactical,base_target_pct:base,target_pct:targetOut,
    regime_targets_pct:regimeTargets(floorCloses,cheap),binding_overlays:actionable?overlays:[],reason_codes:[...new Set(codes)],inputs,quality,
  };
  decision.decision_hash=sha256(decision);
  return decision;
}

// Проверка записи правилом набора, названного в ней самой. Возвращает {ok, suite, reason}.
// Набор v1 проверяется как раньше (allocationDecisionV1 от записанных входов), v3 — ниже.
export function reproduceDecisionV3(decision){
  const d=isObject(decision)?decision:null;
  if(!d)return{ok:false,suite:null,reason:"decision_missing"};
  if(KNOWN_SUITE_HASHES[d.policy_id]===undefined||KNOWN_SUITE_HASHES[d.policy_id]!==d.policy_hash)return{ok:false,suite:d.policy_id??null,reason:"unknown_suite_or_hash"};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(d.policy_id===POLICY_SUITE_V1.id){
    const r=allocationDecisionV1({strategic:d.inputs?.strategic,recoveryState:d.inputs?.recovery_state,macroShockState:d.inputs?.macro_shock_state,mvrvPercentile:d.inputs?.mvrv_percentile});
    return{ok:same([r.status,r.base_target_pct,r.target_pct,r.binding_overlays],[d.status,d.base_target_pct,d.target_pct,d.binding_overlays]),suite:d.policy_id,reason:"v1_allocation"};
  }
  if(d.status==="paused")return{ok:d.target_pct===null&&d.base_target_pct===null&&same(d.binding_overlays,[]),suite:d.policy_id,reason:"paused"};
  if(d.status!=="actionable")return{ok:false,suite:d.policy_id,reason:"unknown_status"};
  if(d.strategic===EMERGENCY)return{ok:d.target_pct===POLICY_V1.ladder.emergency&&d.base_target_pct===POLICY_V1.ladder.emergency&&same(d.binding_overlays,["emergency_override"]),suite:d.policy_id,reason:"emergency"};
  if(!LIVE_REGIMES_V3.includes(d.strategic)||d.inputs?.strategic!==d.strategic)return{ok:false,suite:d.policy_id,reason:"regime_mismatch"};
  if(d.inputs.reproducible!==true)return{ok:isNum(d.target_pct)&&d.target_pct>=0&&d.target_pct<=100&&d.base_target_pct===POLICY_V3_CANDIDATE.ladder[d.strategic],suite:d.policy_id,reason:"inherited_before_first_fix"};
  const r=allocationDecisionV3({strategic:d.inputs.strategic,floorCloses:d.inputs.floor_closes,cheap:d.inputs.cheap===true});
  const targets=regimeTargets(d.inputs.floor_closes,d.inputs.cheap);
  return{ok:same([r.base_target_pct,r.target_pct,r.binding_overlays],[d.base_target_pct,d.target_pct,d.binding_overlays])&&same(targets,d.regime_targets_pct),suite:d.policy_id,reason:"v3_allocation"};
}

// Карта «блок.семья → карточка» из голосующих среднесрочных карточек: имена для текста причин.
function familyCards(metrics){
  const map=new Map();
  for(const m of Array.isArray(metrics)?metrics:[])if(m?.vote&&m.strategic!==false&&m.block&&m.family&&m.score!==undefined&&!map.has(`${m.block}.${m.family}`))map.set(`${m.block}.${m.family}`,{id:m.id??null,name:m.name??null});
  return map;
}

// Снимок того, на чём принят фикс: баллы всех семей как их прочитал движок, блоки, детекторы,
// оценка, ступень пола. Хранится в состоянии режима и сравнивается со следующим фиксом.
export function fixSnapshotV3(calc,view){
  if(!isObject(calc)||!isObject(calc.families))return null;
  const round=x=>isNum(x)?Math.round(x*100)/100:null,families={};
  for(const [block,scores] of Object.entries(calc.families))families[block]=Object.fromEntries(Object.entries(scores||{}).map(([family,score])=>[family,num(score)]));
  return{
    families,blocks:Object.fromEntries(Object.entries(calc.blocks||{}).map(([k,v])=>[k,round(v)])),
    recovery_state:str(calc.recovery?.state),macro_shock_state:str(calc.macro_shock_state),
    mvrv_percentile:round(calc.record?.mvrv_percentile),mvrv_percentile_deep:round(calc.record?.mvrv_percentile_deep),
    floor_closes:Number.isInteger(view?.floor?.closes)?view.floor.closes:0,cheap:calc.valuation?.cheap===true,
  };
}

// Снимок фикса из записи движка (вид линии, поле inputs) — неполный: без баллов семей, которые
// движок берёт готовыми. Отмечен partial.
export function fixFromRecordV3(view){
  const r=isObject(view?.inputs)?view.inputs:null;
  if(!r||!isObject(r.blocks))return null;
  const own=key=>num(r.families?.[key]?.v3),pick=o=>Object.fromEntries(Object.entries(o).filter(([,x])=>x!==null));
  return{
    families:{demand:pick({exchange_supply:own("exchange_supply")}),cycle:pick({valuation:own("valuation"),network:own("network"),trend:own("trend")})},
    blocks:Object.fromEntries(Object.entries(r.blocks).map(([k,x])=>[k,num(x)])),
    recovery_state:str(r.recovery?.state),macro_shock_state:str(r.macro_shock_state),
    mvrv_percentile:num(r.mvrv_percentile),mvrv_percentile_deep:num(r.mvrv_percentile_deep),
    floor_closes:Number.isInteger(view?.floor?.closes)?view.floor.closes:0,cheap:cheapOf(r)===true,partial:true,
  };
}

/*
 * Состояние боевого среднесрочного режима в прежней форме regime_meta.strategic.
 *   count — сколько фиксов подряд движок видит этого кандидата; since — фикс, на котором он появился;
 *   hold_until — время следующего фикса, пока повышение ждёт подтверждения (нижняя граница, как и была);
 *   fix — снимок последнего состоявшегося фикса (для причин смены режима и оверлея).
 * `calc` передаётся только на прогоне, где фикс состоялся (evaluateV3Inputs на тех же входах).
 */
export function liveRegimeMetaV3({decision,view=null,previousMeta=null,now,calc=null,metrics=null}={}){
  const v=isObject(view)?view:null,prev=isObject(previousMeta)&&typeof previousMeta.fix_at==="string"?previousMeta:null;
  const state=decision?.strategic??"insufficient",candidate=str(v?.candidate)??state,fixAt=str(v?.fix_at);
  const newFix=fixAt!==null&&fixAt!==(prev?.fix_at??null),same=prev!==null&&prev.candidate===candidate;
  const count=same?(Number(prev.count)||1)+(newFix?1:0):1,since=same&&str(prev.since)?prev.since:fixAt??iso(now);
  const pending=isObject(v?.pending)?{candidate:str(v.pending.candidate),fixes:num(v.pending.fixes),need:num(v.pending.need)}:null;
  // Снимка прошлого фикса может не быть: первый прогон после выпуска (фикс делал прежний код) или
  // отказ расчёта на фиксе. Тогда берётся то, что движок сам записал о своём последнем фиксе, —
  // блоки, детекторы, оценка и четыре семьи, которые он считает сам; остальные семьи появятся на
  // следующем фиксе.
  const made=newFix&&calc?fixSnapshotV3(calc,v):null;
  const fix=made??prev?.fix??fixFromRecordV3(v);
  // РАЗНИЦА ДВУХ ПОСЛЕДНИХ ФИКСОВ (выпуск 2.15.1). Считается на прогоне, где фикс состоялся и есть оба
  // снимка — этого фикса и прошлого, — и переносится до следующего фикса: по ней уведомления называют,
  // какой вход сдвинулся, когда записи журнала смен цели об этом шаге нет (цель не менялась либо бот
  // пропустил прогон). null — разницу посчитать не из чего: фикс без расчёта, прошлого снимка нет.
  // Справочное поле не имеет права уронить состояние режима: отказ расчёта разницы — её отсутствие.
  let diff=null;
  try{diff=made&&prev?.fix?fixDiffV3(prev.fix,made,metrics):null;}catch{diff=null;}
  const carried=!newFix&&isObject(prev?.fix_diff)&&prev.fix_diff.at===fixAt?prev.fix_diff:null;
  const fixDiff=diff?{...diff,at:fixAt,from_at:str(prev.fix_at)}:carried;
  return{
    state,candidate,count,since,downStreak:0,anchor:state,
    ...(pending&&str(v?.next_fix_at)?{hold_until:v.next_fix_at}:{}),
    fix_at:fixAt,next_fix_at:str(v?.next_fix_at),pending,
    floor:{closes:Number.isInteger(v?.floor?.closes)?v.floor.closes:0,level_pct:num(v?.floor?.level_pct)},
    fix,fix_diff:fixDiff,
  };
}

// Сколько семей несёт разница фиксов: всего голосующих среднесрочных семей двенадцать, больше не бывает.
const FIX_DIFF_MAX_FAMILIES=12;
// Что изменилось между двумя фиксами — в форме tick_diff: семьи, детекторы, оба перцентиля MVRV.
export function fixDiffV3(previousFix,currentFix,metrics){
  if(!isObject(previousFix)||!isObject(currentFix))return null;
  const cards=familyCards(metrics),families=[],detectors=[];
  for(const [block,scores] of Object.entries(currentFix.families||{}))for(const [family,to] of Object.entries(scores||{})){
    const from=previousFix.families?.[block]?.[family];
    if(isNum(from)&&isNum(to)&&from!==to){const card=cards.get(`${block}.${family}`)||{};families.push({block,family,id:card.id??null,name:card.name??null,from,to});}
  }
  for(const [id,key] of [["recovery","recovery_state"],["macro_shock","macro_shock_state"]])if(str(previousFix[key])&&str(currentFix[key])&&previousFix[key]!==currentFix[key])detectors.push({id,from:previousFix[key],to:currentFix[key]});
  const moved=key=>isNum(previousFix[key])&&isNum(currentFix[key])&&previousFix[key]!==currentFix[key]?{[key]:{from:previousFix[key],to:currentFix[key]}}:{};
  // Прошлый снимок фикса может быть неполным (partial: первый фикс после выпуска — без баллов семей,
  // которые движок берёт готовыми): тогда семьи, которых в нём нет, в разницу не попадают, и это помечено.
  return{families:families.slice(0,FIX_DIFF_MAX_FAMILIES),detectors,...moved("mvrv_percentile"),...moved("mvrv_percentile_deep"),...(previousFix.partial===true?{partial:true}:{}),source:"fix"};
}

// КАРТОЧКИ ДЕТЕКТОРОВ ТАК, КАК ИХ ЧИТАЕТ БОЕВОЕ ПРАВИЛО (выпуск 2.15.1). Сборщик публикует detectors[] по
// методике v1 — её тексты лежат в запертом разделе модели и не правятся. Здесь, вне замка, для набора v3
// пишется то, что в них стало неверно: якорь «восстановления» — по двум окнам MVRV и его пол ступенями,
// у «Дистрибуции» права на режим нет (признак reference). Состояние — из расчёта движка на этом прогоне.
// Витрина берёт карточки отсюда и сама тексты больше не правит; роль детектора (пол ступенями, «справочный»)
// она печатает отдельной строкой, поэтому в тексте карточки роль не повторяется.
const ordinalPct=n=>`${n}-го перцентиля`;
export function liveDetectorCardsV3(calc){
  if(!isObject(calc)||!isObject(calc.recovery))return null;
  const P=POLICY_V3_CANDIDATE.scoring,anchorPct=P.valuation.recovery_anchor_below_percentile,need=P.recovery?.good_min_supports??2;
  const two=calc.record?.deep_window_used===true,anchor=calc.recovery.anchor===true,supports=num(calc.recovery.supports);
  return{
    recovery:{
      state:str(calc.recovery.state),
      inputs:`оценка ${anchor?"низкая":"не низкая"}${two?(anchor?" в обоих окнах MVRV":" хотя бы в одном окне MVRV"):""} · подтверждений ${supports??"—"}/3`,
      logic:`Низкая циклическая оценка (MVRV ниже ${ordinalPct(anchorPct)}${two?" и за 4 года, и по всей истории":" за 4 года; окна всей истории сейчас нет"}) — обязательный якорь; плюс минимум ${need===2?"два подтверждения":`${need} подтверждения`} стабилизации тренда/ETF/биржевого предложения. Положительный статус поднимает защитный/ухудшающийся вердикт до переходного (не действует при сработавшем макрошоке).`,
    },
    macro_shock:{state:str(calc.macro_shock_state)},
    distribution:{
      reference:true,
      logic:"Высокая накопленная прибыль (MVRV) — обязательный якорь. Оба подтверждения (рост биржевого предложения И потеря ценовых опор) — «сработал»; одно из двух — «наблюдение».",
    },
  };
}

// То, что боевое правило читает на ЭТОМ прогоне (решает оно на фиксе): баллы всех семей как их видит
// движок, блоки, полосы, кандидат, детекторы, оба перцентиля MVRV. Карточки снимка показывают баллы
// методики v1; для четырёх семей (сеть, биржи, оценка, тренд) движок считает свои — витрина и
// уведомления берут их отсюда.
export function liveInputsV3(calc,at){
  const snapshot=fixSnapshotV3(calc,null);
  if(!snapshot)return null;
  const{floor_closes,recovery_state,...rest}=snapshot;
  return{
    at:str(at),...rest,bands:Object.fromEntries(Object.entries(snapshot.blocks).map(([k,v])=>[k,BAND(v)])),candidate:str(calc.candidate),
    recovery:{state:recovery_state,anchor:calc.recovery?.anchor===true,supports:num(calc.recovery?.supports)},
    deep_window_used:calc.record?.deep_window_used===true,closed_day:str(calc.record?.observed?.closed_day),
    detectors:liveDetectorCardsV3(calc),
  };
}

const BAND=score=>!isNum(score)?"unknown":score>=20?"supportive":score<=-20?"adverse":"neutral";

/*
 * Рождение кандидата боевого режима — в форме regime_birth.strategic. Новая запись появляется на
 * фиксе, где кандидат сменился; причина — разница с предыдущим фиксом. В остальных прогонах
 * переносится прежняя запись.
 */
export function liveRegimeBirthV3({previousBirth=null,previousMeta=null,meta,metrics,now,price}={}){
  const prev=isObject(previousMeta)&&typeof previousMeta.fix_at==="string"?previousMeta:null;
  if(!isObject(meta))return previousBirth??null;
  const changed=prev!==null&&meta.fix_at!==prev.fix_at&&meta.candidate!==prev.candidate;
  // Переносится только запись о ТЕКУЩЕМ кандидате и не из будущего — как в buildRegimeBirthV1: запись о
  // другом кандидате (в том числе рождённая прежним набором правил) читателя обманула бы.
  const t=now instanceof Date?now.getTime():typeof now==="string"?Date.parse(now):now;
  const carried=isObject(previousBirth)&&previousBirth.candidate===meta.candidate&&!(Date.parse(previousBirth.t)>t)?previousBirth:null;
  if(!changed)return carried;
  const diff=fixDiffV3(prev.fix,meta.fix,metrics),blocks={};
  for(const key of Object.keys(meta.fix?.blocks||{})){
    const from=prev.fix?.blocks?.[key],to=meta.fix.blocks[key];
    // Как в buildRegimeBirthV1: блок записывается при любой смене балла; полосы — для текста причины.
    if(isNum(from)&&isNum(to)&&from!==to)blocks[key]={from,to,band_from:BAND(from),band_to:BAND(to)};
  }
  return{t:iso(now),candidate:meta.candidate,from_candidate:prev.candidate,price:num(price),blocks,families:(diff?.families||[]).slice(0,8),detectors:diff?.detectors||[],note:diff?null:"no_previous_fix"};
}
