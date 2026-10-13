// Журнал смен цели живой политики (аудит 2026-10-10): каждая смена `target_pct` получает запись с ценой,
// направлением, режимом и оверлеями до/после и ПРИЧИНОЙ. Причина смены режима возникает не в снимке
// смены, а в снимке рождения принятого кандидата — за 48 часов до повышения; сравнение двух соседних
// снимков её не видит (9 смен по гистерезису из 9 пришли читателю без причины). Поэтому причина
// режима берётся из `regime_birth.strategic`, причина оверлея — из `tick_diff` этого же снимка.
// Модуль ничего не решает: он только записывает, что уже решила замороженная политика.

const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
export const TARGET_CHANGE_LOG_LIMIT=60;

const REGIME={emergency:"аварийный",defensive:"защитный",deteriorating:"ухудшается",transition:"переходный",unconfirmed_positive:"спрос не подтвердил",constructive:"конструктивный",insufficient:"нет данных"};
const BLOCK={macro:"Макро",demand:"Спрос",cycle:"Цикл",leverage:"Плечо",market:"Качество цены"};
const DETECTOR={recovery:"Восстановление",macro_shock:"Макрошок",distribution:"Дистрибуция",integrity:"Целостность рынка",leverage:"Плечо",demand_break:"Слом спроса",short_squeeze:"Short squeeze"};
const DETECTOR_STATE={calm:"спокойно",watch:"наблюдение",good:"подтверждён",fired:"сработал"};
// Имена оверлеев — те же, что в уведомлениях и на витрине: одно решение не должно называться двумя именами.
const OVERLAY={recovery_floor:"пол восстановления",capitulation_floor:"пол капитуляции",euphoria_safety_cap:"потолок эйфории",emergency_override:"аварийный режим"};
// Детекторы с правом на вердикт и семьи-подтверждения recovery: только они могут быть причиной.
const VERDICT_DETECTORS=["recovery","macro_shock","distribution","integrity"];
const RECOVERY_LEGS=["trend_regime","etf_regime","exchange_supply"];

const num=x=>finite(x)?String(Number(Number(x).toFixed(2))).replace("-","−").replace(".",","):"—";
// «Биржевое предложение BTC» → «биржевое предложение BTC»; аббревиатуры в начале (MVRV, US) не трогаются.
const lower=name=>{const s=String(name??"");return s.length>1&&/[А-ЯЁ]/.test(s[0])&&s[1]===s[1].toLowerCase()?s[0].toLowerCase()+s.slice(1):s;};
// Текст причины уходит владельцу дословно (витрина, уведомления). Имена карточек приходят готовыми;
// два заголовка, которые читаются как внутренние («US spot-ETF · режим потоков», «MVRV ·
// динамический цикл»), в тексте заменены человеческими. В `cause.families` имя остаётся как пришло.
const DISPLAY_NAME={etf_regime:"потоки спотовых ETF",mvrv_cycle:"оценка по MVRV"};
const familyText=f=>`${DISPLAY_NAME[f.id]||lower(f.name||f.id||f.family)} ${num(f.from)} → ${num(f.to)}`;
const detectorText=d=>`детектор «${DETECTOR[d.id]||d.id}»: ${DETECTOR_STATE[d.from]||d.from} → ${DETECTOR_STATE[d.to]||d.to}`;
function blockText(key,b){
  const name=`блок «${BLOCK[key]||key}»`,from=b?.band_from,to=b?.band_to;
  if(!from||!to||from===to)return null;
  if(from==="adverse"&&to==="neutral")return`${name} вышел из неблагоприятной полосы`;
  if(from==="neutral"&&to==="adverse")return`${name} ушёл в неблагоприятную полосу`;
  if(from==="neutral"&&to==="supportive")return`${name} вошёл в благоприятную полосу`;
  if(from==="supportive"&&to==="neutral")return`${name} вышел из благоприятной полосы`;
  return`${name} перешёл из ${from==="adverse"?"неблагоприятной":"благоприятной"} полосы в ${to==="adverse"?"неблагоприятную":"благоприятную"}`;
}
const compactFamily=f=>({block:f.block??null,family:f.family??null,id:f.id??null,name:f.name??null,from:f.from??null,to:f.to??null});
const compactDetector=d=>({id:d.id??null,from:d.from??null,to:d.to??null});

function regimeCause(birth,from,to){
  const crossed=Object.entries(birth?.blocks||{}).map(([key,b])=>[key,blockText(key,b)]).filter(([,text])=>text);
  const allFamilies=Array.isArray(birth?.families)?birth.families:[];
  const families=(crossed.length?allFamilies.filter(f=>crossed.some(([key])=>key===f.block)):allFamilies).slice(0,4);
  const detectors=(Array.isArray(birth?.detectors)?birth.detectors:[]).filter(d=>VERDICT_DETECTORS.includes(d.id));
  const parts=[];
  if(crossed.length)parts.push(crossed.map(([,text])=>text).join(", ")+(families.length?`: ${families.map(familyText).join(", ")}`:""));
  else if(families.length&&!detectors.length)parts.push(families.map(familyText).join(", "));
  if(detectors.length)parts.push(detectors.map(detectorText).join(", "));
  if(!parts.length)parts.push(birth?.note==="coverage"?"изменилось покрытие данных":`режим «${REGIME[from]||from}» → «${REGIME[to]||to}»`);
  return{text:parts.join("; "),families:crossed.length||!detectors.length?families:[],detectors};
}

function overlayCause(diff,overlaysFrom,overlaysTo){
  const added=overlaysTo.filter(o=>!overlaysFrom.includes(o)),removed=overlaysFrom.filter(o=>!overlaysTo.includes(o));
  const head=[...added.map(o=>`${OVERLAY[o]||o} включён`),...removed.map(o=>`${OVERLAY[o]||o} снят`)].join(", ");
  // Семьи бывают причиной только у пола recovery — это его три подтверждения. Полы капитуляции и
  // эйфории включает перцентиль MVRV, аварийный режим — детектор: случайно совпавшая по времени
  // смена балла посторонней карточки причиной не называется.
  const recovery=[...added,...removed].includes("recovery_floor");
  const allFamilies=Array.isArray(diff?.families)?diff.families:[];
  const families=recovery?allFamilies.filter(f=>RECOVERY_LEGS.includes(f.id)).slice(0,4):[];
  const detectors=(Array.isArray(diff?.detectors)?diff.detectors:[]).filter(d=>VERDICT_DETECTORS.includes(d.id));
  const mvrv=diff?.mvrv_percentile&&finite(diff.mvrv_percentile.from)&&finite(diff.mvrv_percentile.to)?`перцентиль MVRV ${num(Number(diff.mvrv_percentile.from).toFixed(1))} → ${num(Number(diff.mvrv_percentile.to).toFixed(1))}`:null;
  // Якорь «оценка низкая» (перцентиль MVRV через порог) называется, только когда семьи-подтверждения
  // не менялись: иначе причина — в них, а суточный сдвиг перцентиля — фон.
  const reasons=[...families.map(familyText),...(mvrv&&!families.length?[mvrv]:[])];
  if(!reasons.length)reasons.push(...detectors.map(detectorText));
  return{text:head+(reasons.length?`: ${reasons.join(", ")}`:""),families,detectors};
}

// Причина смены. `regimeBirth` годится, только если это рождение ИМЕННО принятого кандидата.
export function targetChangeCauseV1({kind,strategicFrom,strategicTo,overlaysFrom=[],overlaysTo=[],regimeBirth=null,tickDiff=null,candidateSince=null}={}){
  const birth=regimeBirth?.strategic&&regimeBirth.strategic.candidate===strategicTo?regimeBirth.strategic:null;
  const regime=kind==="overlay"?null:regimeCause(birth,strategicFrom,strategicTo);
  const overlay=kind==="regime"?null:overlayCause(tickDiff,overlaysFrom,overlaysTo);
  const blocks=[overlay,regime].filter(Boolean);
  return{
    text:blocks.map(x=>x.text).join("; "),
    families:blocks.flatMap(x=>x.families).slice(0,4).map(compactFamily),
    detectors:blocks.flatMap(x=>x.detectors).slice(0,4).map(compactDetector),
    candidate_since:kind==="overlay"?null:(birth?.t??candidateSince??null),
  };
}

// Запись о смене цели либо null, если цель не менялась. `previous` — состояние до этого прогона:
// последняя известная конечная цель, режим и оверлеи предыдущей записи журнала решений.
export function targetChangeRecordV1({at,price,previous,decision,regimeBirth=null,tickDiff=null,candidateSince=null,gateOpen=true}={}){
  const to=decision?.target_pct,from=previous?.target_pct;
  if(!finite(to)||(finite(from)&&Number(from)===Number(to)))return null;
  const overlaysFrom=Array.isArray(previous?.binding_overlays)?previous.binding_overlays:[],overlaysTo=Array.isArray(decision.binding_overlays)?decision.binding_overlays:[];
  const strategicFrom=previous?.strategic??null,strategicTo=decision.strategic??null;
  const start=!finite(from);
  const regimeChanged=strategicFrom!==strategicTo,overlayChanged=JSON.stringify(overlaysFrom)!==JSON.stringify(overlaysTo);
  const kind=start?"start":regimeChanged&&overlayChanged?"both":overlayChanged?"overlay":"regime";
  const cause=start
    ?{text:`старт наблюдения: режим «${REGIME[strategicTo]||strategicTo}»`,families:[],detectors:[],candidate_since:null}
    :targetChangeCauseV1({kind,strategicFrom,strategicTo,overlaysFrom,overlaysTo,regimeBirth,tickDiff,candidateSince});
  return{
    t:at,from_pct:start?null:Number(from),to_pct:Number(to),direction:start?"start":Number(to)>Number(from)?"up":"down",price:finite(price)?Number(price):null,
    strategic_from:strategicFrom,strategic_to:strategicTo,overlays_from:overlaysFrom,overlays_to:overlaysTo,kind,cause,
    // Смена при закрытом гейте витрины записывается, но помечается: панель цель не показывала, монитор её не исполнял.
    ...(gateOpen?{}:{gate:"closed"}),
  };
}

// Запасной `tick_diff` из собственных входов монитора: баллы голосующих карточек и состояния
// детекторов предыдущего и текущего прогона (форма `input_summary` дневной строки). Имён карточек
// в этой форме нет — в текст попадает идентификатор. Нужен, когда сборщик `tick_diff` не передал.
export function tickDiffFromInputSummariesV1(previousLedger,currentLedger){
  if(!previousLedger||!currentLedger)return null;
  const before=new Map((previousLedger.metrics||[]).map(row=>[row[0],row])),families=[],detectors=[];
  for(const row of currentLedger.metrics||[]){const old=before.get(row[0]);if(old&&finite(old[1])&&finite(row[1])&&Number(old[1])!==Number(row[1]))families.push({block:null,family:null,id:row[0],name:null,from:Number(old[1]),to:Number(row[1])});}
  const states=new Map((previousLedger.detectors||[]).map(row=>[row[0],row[1]]));
  for(const [id,state] of currentLedger.detectors||[])if(states.has(id)&&states.get(id)!==state)detectors.push({id,from:states.get(id),to:state});
  const mvrvBefore=before.get("mvrv_cycle")?.[2],mvrvNow=(currentLedger.metrics||[]).find(row=>row[0]==="mvrv_cycle")?.[2];
  return{families,detectors,...(finite(mvrvBefore)&&finite(mvrvNow)&&Number(mvrvBefore)!==Number(mvrvNow)?{mvrv_percentile:{from:Number(mvrvBefore),to:Number(mvrvNow)}}:{}),source:"monitor"};
}
