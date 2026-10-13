// Теневые линии форвард-монитора (аудит 2026-10-10): кандидат v3, три линии «v1 с одной правкой» и
// исполнение по правилу панели. Цели первых четырёх даёт движок вариантов docs/policy-v3-candidate.mjs;
// модуль только вызывает его и ведёт учёт. Живое решение v1 и его качество отсюда недостижимы:
// отказ движка оставляет след в `variant_errors`, линии держат прежнюю цель, сбор продолжается.

import { EXECUTION_POLICY_V1 } from "../docs/execution-policy-v1.mjs";
// Модуль кандидата импортируется целиком: часть его экспортов появляется только в наполненном
// модуле (определение эпизодов расхождения), а именованный импорт отсутствующего экспорта ронял бы
// загрузку монитора — и с ним сбор.
import * as V3 from "../docs/policy-v3-candidate.mjs";

const { POLICY_V3_CANDIDATE, evaluateShadowVariantsV1, policyV3CandidateMetadata } = V3;

const DAY=86_400_000,HOUR=3_600_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const isObject=x=>!!x&&typeof x==="object"&&!Array.isArray(x);
const bytes=x=>Buffer.byteLength(JSON.stringify(x));

export const VARIANT_LINES_V1=Object.freeze(["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc"]);
export const TRANCHED_LINE_V1="policy_v1_tranched";
// Состояние движка публикуется вместе с монитором. Потолок защищает публикацию: снимок, выросший
// сверх бюджета, блокирует сбор целиком, а состояние теневого расчёта этого не стоит.
// 48 000 → 12 000 (ревью 13.10.2026, Н8): потолок входит в проекцию размера «все лимиты разом», и
// каждый его килобайт вычитается из запаса снимка. Состояние настоящего движка — 1,7 КБ на боевых
// входах (четыре линии, запись входов последнего фикса кандидата); 12 КБ — семикратный запас.
export const VARIANTS_STATE_MAX_BYTES=12_000;
// Потолок блока одной линии в снимке (поля движка как он их отдал).
export const VARIANT_PUBLIC_MAX_BYTES=4_000;
const LEDGER_INPUTS_MAX_BYTES=600;

// Цель линии из ответа движка. Исполняется только число: typeof "number", конечное, в 0…100; null и
// отсутствие поля — законное «держать прежнюю цель». Всё остальное — тоже «держать», но с кодом
// причины: приведение типов исполняло бы мусор как цель (true → 1 %, "80" и [80] → 80 %, false, []
// и " " → 0 %), а число вне 0…100 — признак сломанного расчёта, а не повод встать в край лестницы.
export function acceptLineTargetV1(value){
  if(value===null||value===undefined)return{target:null,rejected:null};
  if(typeof value!=="number")return{target:null,rejected:"target_not_number"};
  if(!Number.isFinite(value))return{target:null,rejected:"target_not_finite"};
  if(value<0||value>100)return{target:null,rejected:"target_out_of_range"};
  return{target:value+0,rejected:null};
}

// Вызов движка вариантов. Возвращает цели линий (number либо null — «держать прежнюю»), новое
// состояние, блоки для публикации и коды причин, по которым цель линии не принята (`rejected`).
// Отказ движка целиком — error и прежнее состояние; отказ одной линии остальных не трогает.
// Функция не бросает исключений: ответ движка читается внутри try — геттер, бросающий на чтении
// поля, такой же отказ, как исключение в вызове. Иначе исключение уходило в сборщик, и тот
// повторял прогон без всего теневого слоя.
export function runShadowVariantsV1({engine=evaluateShadowVariantsV1,now,inputs,state}={}){
  const previousState=isObject(state)?state:{},hold=()=>Object.fromEntries(VARIANT_LINES_V1.map(name=>[name,null]));
  const fail=message=>({ran:true,ok:false,error:String(message).slice(0,300),state:previousState,targets:hold(),published:{},rejected:{}});
  if(!isObject(inputs))return{ran:false,ok:true,error:null,state:previousState,targets:hold(),published:{},rejected:{}};
  let result,variants,rawState;
  try{result=engine({now,inputs,state:structuredClone(previousState)});}
  catch(error){return fail(`engine_threw: ${error?.message||error}`);}
  try{variants=isObject(result)?result.variants:null;rawState=isObject(result)?result.state:null;}
  catch(error){return fail(`engine_result_unreadable: ${error?.message||error}`);}
  if(!isObject(variants))return fail("engine_result_invalid");
  // Состояние и цели движка — одно целое: если состояние не принято, цели этого прогона тоже.
  let nextState;
  try{
    if(!isObject(rawState))return fail("engine_state_invalid");
    if(bytes(rawState)>VARIANTS_STATE_MAX_BYTES)return fail(`engine_state_too_large: ${bytes(rawState)} > ${VARIANTS_STATE_MAX_BYTES}`);
    nextState=JSON.parse(JSON.stringify(rawState));
  }catch(e){return fail(`engine_state_not_serializable: ${e?.message||e}`);}
  const targets=hold(),published={},rejected={};
  for(const name of VARIANT_LINES_V1){
    try{
      const variant=variants[name];
      if(variant===undefined||variant===null)continue;
      if(!isObject(variant)){rejected[name]="line_not_object";published[name]={target_pct:null,target_rejected:rejected[name]};continue;}
      const accepted=acceptLineTargetV1(variant.target_pct);
      let copy;
      try{copy=JSON.parse(JSON.stringify(variant));if(!isObject(copy)||bytes(copy)>VARIANT_PUBLIC_MAX_BYTES)copy={target_pct:accepted.target,truncated:true};}
      catch{copy={target_pct:accepted.target,truncated:true};}
      // В блоке линии — принятая цель, а не то, что прислал движок: `target_pct: true` в снимке
      // прочитали бы как число. Почему цели нет, говорит target_rejected.
      if(accepted.rejected){rejected[name]=accepted.rejected;copy={...copy,target_pct:null,target_rejected:accepted.rejected};}
      targets[name]=accepted.target;published[name]=copy;
    }catch{targets[name]=null;rejected[name]="line_unreadable";published[name]={target_pct:null,target_rejected:rejected[name]};}
  }
  return{ran:true,ok:true,error:null,state:nextState,targets,published,rejected};
}

// Блок кандидата v3 для записи hash-журнала: цель и входы хэшируются вместе с решением v1, как
// блок `v2`. Все значения явно ??null — undefined-ключ невоспроизводим из публикации. Запись
// хранится 400 штук, поэтому блок короткий: входы кандидата — как их отдал движок, а если они
// длиннее 600 байт — их sha256 (сами входы тогда остаются в `v3_candidate.inputs` снимка).
// Поля читаются тем же строгим правилом, что и цель: число — только number, метка — только
// короткая строка. Иначе ответ движка с длинной строкой на месте метки режима раздувал бы каждую
// из 400 записей журнала на килобайты, и через сто часов снимок упёрся бы в кап публикации.
const LEDGER_LABEL_MAX_CHARS=40;
export function variantLedgerV1(run,sha256){
  const v3=run.published.policy_v3_shadow||{},targets=run.targets,inputs=isObject(v3.inputs)?v3.inputs:null;
  const number=x=>typeof x==="number"&&Number.isFinite(x)?x:null,label=x=>typeof x==="string"&&x.length<=LEDGER_LABEL_MAX_CHARS?x:null;
  return{
    target_pct:targets.policy_v3_shadow??null,base_target_pct:number(v3.base_target_pct),
    state:label(v3.state),candidate:label(v3.candidate),fix_at:label(v3.fix_at),floor_rung:number(v3.floor?.rung),
    inputs:inputs===null?null:bytes(inputs)<=LEDGER_INPUTS_MAX_BYTES?inputs:{sha256:sha256(inputs)},
    lines:{v1_daily_close:targets.v1_daily_close??null,v1_floor_handoff:targets.v1_floor_handoff??null,v1_no_cftc:targets.v1_no_cftc??null},
  };
}

// ИСПОЛНЕНИЕ ПО ПРАВИЛУ ПАНЕЛИ. Замороженный EXECUTION_POLICY_V1 говорит: понижения сразу,
// повышения траншами со следующей сессии. Числа траншей контракт не задаёт; чтобы линию можно было
// вести, зафиксировано соглашение ИЗМЕРЕНИЯ (не правило политики): три равных транша, по одному в
// сутки UTC, первый — на первом снимке не раньше 06:00 UTC следующих суток; понижение исполняется
// сразу и отменяет неисполненные транши; новая цель выше позиции начинает план заново.
export const TRANCHE_CONVENTION_V1=Object.freeze({
  source:EXECUTION_POLICY_V1.id,upgrades:EXECUTION_POLICY_V1.upgrades,downgrades:EXECUTION_POLICY_V1.downgrades,
  tranches:3,per:"utc_day",first_not_before_utc_hour:6,
  text:"Исполнение по правилу панели: понижения сразу; повышения тремя равными траншами, по одному в сутки, первый — на первом снимке не раньше 06:00 UTC следующих суток; понижение отменяет неисполненные транши; новая цель выше текущей доли начинает план заново.",
});
// position — текущая доля линии (null при рождении), target — конечная цель политики этого прогона.
export function updateTrancheStateV1(previous,{now,target,position}){
  const nextSession=()=>new Date((Math.floor(now/DAY)+1)*DAY+TRANCHE_CONVENTION_V1.first_not_before_utc_hour*HOUR).toISOString();
  const goal=Number(target);
  // Рождение линии: читатель уже стоит в цели панели. Понижение и достигнутая цель — сразу.
  if(!finite(position)||goal<=Number(position))return{state:null,position:goal};
  const plan=isObject(previous)&&Number(previous.goal_pct)===goal&&Number(previous.left)>0&&finite(Date.parse(previous.next_at))?previous:null;
  if(!plan)return{state:{goal_pct:goal,tranche_pct:(goal-Number(position))/TRANCHE_CONVENTION_V1.tranches,left:TRANCHE_CONVENTION_V1.tranches,next_at:nextSession(),since:new Date(now).toISOString()},position:Number(position)};
  if(now<Date.parse(plan.next_at))return{state:plan,position:Number(position)};
  const left=Number(plan.left)-1;
  // Последний транш ставит ровно цель: сумма трёх делений в плавающей точке её не гарантирует.
  return left===0?{state:null,position:goal}:{state:{...plan,left,next_at:nextSession()},position:Number(position)+Number(plan.tranche_pct)};
}

// Эпизоды расхождения целей линии и базы по дневным строкам монитора. Определение принадлежит
// контракту кандидата (countTargetDivergenceEpisodesV3: непрерывная серия дневных строк с разными
// целями считается один раз; счёт по снимкам не годится — суточная линия отстаёт от каждой
// внутридневной смены цели v1 на часы, и порог набирался бы за трое суток одной задержкой фикса).
// База по умолчанию — policy_v1 (так считаются сравнения comparisons.*); приёмка кандидата v3 считает
// против линии с теми же часами (acceptance_criteria.divergence_base).
// Пока в модуле кандидата определения нет (заглушка), счёта нет вовсе — null, а не свой вариант.
export function divergenceEpisodesV3(daily,line="policy_v3_shadow",counter=V3.countTargetDivergenceEpisodesV3,base="policy_v1"){
  if(typeof counter!=="function")return null;
  const counted=counter(daily,{candidate:line,base});
  return finite(counted?.episodes)?{episodes:Number(counted.episodes),days:finite(counted.days)?Number(counted.days):null}:null;
}

// Машинная приёмка кандидата v3. Критерии и их определения — в контракте кандидата
// (decision_record.acceptance_criteria и acceptance_definitions); монитор только считает. Пока хотя
// бы одного ключа нет (контракт не наполнен) — статус collecting, числа всё равно публикуются.
//  shadow_days_min — полные сутки от старта линии; min_divergence_episodes — эпизоды расхождения
//  цели с линией divergence_base — правилами v1 на тех же часах (с самой policy_v1 суточная линия
//  расходится на каждой внутридневной смене цели, и порог набирал бы один такт без смены правил;
//  без определения в модуле критерий не оценён, статус collecting);
//  timing_pp_not_worse_than_v1 — тайминг по определению контракта: чистая доходность линии минус
//  чистая доходность её собственной постоянной доли, против того же числа у v1 на общем окне (true
//  — не хуже; число — допуск в п.п.); max_drawdown_worse_pp_max — насколько глубже просадка по
//  дневным закрытиям общего окна; falsify_net_return_gap_pp на окне не короче falsify_min_days —
//  отклонение (знак порога не важен: отклоняет отставание больше его модуля).
//  window — окно, на котором монитор посчитал эпизоды, тайминг, просадку и разницу доходностей
//  ({basis, from, days} блока comparisons.policy_v3_shadow): с рождения кандидата, а после 370 суток
//  его жизни — скользящее (basis: rolling). Публикуется как есть: числа приёмки не имеют права
//  сменить окно молча. Теневые сутки от окна не зависят — это возраст линии.
const ACCEPTANCE_KEYS_V3=["shadow_days_min","divergence_base","min_divergence_episodes","timing_pp_not_worse_than_v1","max_drawdown_worse_pp_max","falsify_net_return_gap_pp","falsify_min_days"];
export const acceptanceCriteriaV3=()=>POLICY_V3_CANDIDATE?.decision_record?.acceptance_criteria??null;
export function evaluateAcceptanceV3({criteria=acceptanceCriteriaV3(),shadowDays=null,window=null,divergence=null,timingGapPp=null,drawdownWorsePp=null,netReturnGapPp=null}={}){
  const round=x=>finite(x)?Number(Number(x).toFixed(4))+0:null;
  const numbers={shadow_days:finite(shadowDays)?Number(shadowDays):null,window:isObject(window)?{basis:window.basis??null,from:window.from??null,days:finite(window.days)?Number(window.days):null}:null,divergence_base:typeof criteria?.divergence_base==="string"?criteria.divergence_base:null,divergence_episodes:finite(divergence?.episodes)?Number(divergence.episodes):null,divergence_days:finite(divergence?.days)?Number(divergence.days):null,timing_gap_pp_vs_v1:round(timingGapPp),max_drawdown_worse_pp:round(drawdownWorsePp),net_return_gap_pp_vs_v1:round(netReturnGapPp)};
  const missing=ACCEPTANCE_KEYS_V3.filter(key=>!isObject(criteria)||criteria[key]===undefined||criteria[key]===null);
  if(missing.length)return{...numbers,falsified:false,meets:null,status:"collecting",missing_criteria:missing};
  const timingRule=criteria.timing_pp_not_worse_than_v1,timingFloor=timingRule===true?0:finite(timingRule)&&typeof timingRule!=="boolean"?-Math.abs(Number(timingRule)):null;
  const days=numbers.shadow_days??0;
  const meets={
    shadow_days:days>=Number(criteria.shadow_days_min),
    divergence:numbers.divergence_episodes===null?null:numbers.divergence_episodes>=Number(criteria.min_divergence_episodes),
    timing:timingFloor===null?true:finite(timingGapPp)?Number(timingGapPp)>=timingFloor:null,
    drawdown:finite(drawdownWorsePp)?Number(drawdownWorsePp)<=Number(criteria.max_drawdown_worse_pp_max):null,
  };
  const falsified=finite(netReturnGapPp)&&Number(netReturnGapPp)<-Math.abs(Number(criteria.falsify_net_return_gap_pp))&&days>=Number(criteria.falsify_min_days);
  const ready=meets.shadow_days&&meets.divergence===true&&meets.timing===true&&meets.drawdown===true;
  return{...numbers,falsified,meets,status:falsified?"falsified":ready?"switch_ready_pending_owner":"collecting"};
}
export { policyV3CandidateMetadata };
