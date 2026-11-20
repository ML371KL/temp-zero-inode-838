/*
 * Теневые трендовые линии форвард-монитора (объявлены 2026-11-20, аудит 2026-11-20).
 *
 * Две линии, обе — только наблюдение: живое решение, его качество и журнал решений они не читают
 * и не меняют.
 *
 *   trend_ma3        — ориентир: доля BTC равна доле скользящих средних 50, 100 и 200 дней,
 *                      которые последнее закрытие дня превышает (0, ⅓, ⅔ или 1).
 *   trend_demand_b1  — кандидат Б1: та же доля, умноженная на тормоз спроса; когда блоки
 *                      «Макро» и «Спрос» оба в неблагоприятной полосе — ещё на 0,25.
 *
 * Зачем. На реконструкции 2013–2026 политика v1 по Sharpe неотличима от trend_ma3, а тормоз спроса
 * улучшает trend_ma3 в обоих окнах истории при любом наборе средних (числа — в объявлении ниже).
 * Это найдено на той же истории, на которой искалось, поэтому проверяется только вперёд: линии
 * копят собственный след на тех же ценах, издержках и часах, что и остальные линии монитора.
 *
 * Часы. Одно решение в сутки — на первом прогоне не раньше 06:00 UTC, по закрытым дневным свечам
 * (тот же фикс, что у кандидата v3). Между фиксами цель держится.
 *
 * Баллы семей берутся готовыми — те, что уже посчитал замороженный контур v1 на этом прогоне
 * (variant_inputs.families). Своего скоринга у линий нет.
 */

import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";

const deepFreeze=value=>{if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};
const DAY=86_400_000,HOUR=3_600_000;
const finite=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v));
const isNum=v=>typeof v==="number"&&Number.isFinite(v);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round=(v,d=2)=>{if(!isNum(v))return null;const r=Math.round(v*10**d)/10**d;return r===0?0:r;};
const iso=t=>new Date(t).toISOString();

export const TREND_LINES_V1=deepFreeze({
  id:"btc-trend-lines-v1",
  version:1,
  status:"shadow",
  declared_at:"2026-11-20",
  lines:{
    trend_ma3:{role:"benchmark",rule:"доля = доля средних 50/100/200 дней, которые закрытие дня превышает"},
    trend_demand_b1:{role:"candidate",rule:"доля = тренд × тормоз спроса; × 0,25, когда «Макро» и «Спрос» оба не выше −20"},
  },
  moving_averages_days:[50,100,200],
  daily_fix:{hour_utc:6,price:"last closed UTC daily candle"},
  // Тормоз: балл блока спроса 0 и выше — 1; на границе неблагоприятной полосы и ниже — floor; между ними линейно.
  demand_brake:{families:["etf","stablecoins","exchange_supply"],full_at_score:0,floor_at_score:MODEL_POLICY_V1.regime_bands.adverse_max,floor:0.5},
  double_adverse:{blocks:["macro","demand"],at_or_below_score:MODEL_POLICY_V1.regime_bands.adverse_max,multiplier:0.25},
  macro_families:["liquidity","conditions","stress"],
  // Числа объявления: реконструкция до 19.11.2026, решение по закрытию дня, сделка на следующем
  // закрытии, 10 б.п. на оборот. Годовых / Sharpe сверх кэша / макс. просадка.
  declared_evidence:{
    method:"та же реконструкция 2013–2026, на которой правило искалось; описывает, не доказывает",
    since_2018_06:{trend_ma3:[43.1,1.01,-46.4],trend_demand_b1:[46.7,1.22,-42.5],policy_v1:[32.2,1.12,-40.8],buy_and_hold:[28.3,0.67,-76.7]},
    y2013_to_2018_05:{trend_ma3:[229.3,1.95,-70.6],trend_demand_b1:[174.3,2.2,-47.8],policy_v1:[58.2,1.7,-39.9],buy_and_hold:[220.7,1.72,-84.9]},
    etf_era_2024_03:{trend_ma3:[7.6,0.25,-32.8],trend_demand_b1:[13.4,0.44,-22],policy_v1:[15.8,0.68,-15.5],buy_and_hold:[0.4,0.15,-53.1]},
    known_weaknesses:["второй день задержки исполнения стоит кандидату около 9 п.п. годовых","оборот около 1 660 % в год","в падающие годы кандидат слабее v1: в среднем −11 % против −4 %"],
  },
  statement:"На общем окне не короче 365 суток trend_demand_b1 имеет Sharpe не ниже trend_ma3 и просадку не глубже.",
});
export const TREND_LINE_NAMES_V1=Object.freeze(Object.keys(TREND_LINES_V1.lines));
export const TREND_LINES_STATE_VERSION=1;

const MAS=TREND_LINES_V1.moving_averages_days,FIX_HOUR=TREND_LINES_V1.daily_fix.hour_utc,BRAKE=TREND_LINES_V1.demand_brake,BEAR=TREND_LINES_V1.double_adverse;

// Балл блока по шкале панели (−100…+100) из баллов семей; семья без балла в среднее не входит.
export function blockScoreV1(families,names){
  const a=names.map(f=>families?.[f]).filter(isNum);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length/2*100:null;
}
// Доля средних, которые последнее закрытие превышает. Нужна вся длина самой длинной средней.
export function trendShareV1(closes){
  const need=Math.max(...MAS);
  if(!Array.isArray(closes)||closes.length<need)return null;
  const lastClose=closes.at(-1),averages=MAS.map(n=>{let s=0;for(let i=closes.length-n;i<closes.length;i++)s+=closes[i];return s/n;});
  return{share:averages.filter(a=>lastClose>=a).length/MAS.length,close:lastClose,averages};
}
export function demandBrakeV1(demandScore){
  if(!isNum(demandScore))return 1;
  return BRAKE.floor+(1-BRAKE.floor)*clamp((demandScore-BRAKE.floor_at_score)/(BRAKE.full_at_score-BRAKE.floor_at_score),0,1);
}
export function trendTargetsV1({closes,families}){
  const trend=trendShareV1(closes);
  if(!trend)return null;
  const demand=blockScoreV1(families?.demand,BRAKE.families),macro=blockScoreV1(families?.macro,TREND_LINES_V1.macro_families);
  const brake=demandBrakeV1(demand),doubleAdverse=isNum(macro)&&isNum(demand)&&macro<=BEAR.at_or_below_score&&demand<=BEAR.at_or_below_score;
  const base=100*trend.share;
  return{
    trend_ma3:{target_pct:round(base),trend_share:round(trend.share,4),close:round(trend.close,2),averages:trend.averages.map(a=>round(a,2))},
    trend_demand_b1:{target_pct:round(base*brake*(doubleAdverse?BEAR.multiplier:1)),trend_share:round(trend.share,4),demand_block:round(demand),macro_block:round(macro),brake:round(brake,4),double_adverse:doubleAdverse},
  };
}

// Закрытые дневные свечи: всё, что раньше начала текущих суток UTC; годен ряд, чей последний день — вчера.
function closedCloses(rows,now){
  const open=Math.floor(now/DAY)*DAY,byDay=new Map();
  for(const r of Array.isArray(rows)?rows:[]){const t=Number(r?.t),v=Number(r?.v);if(Number.isFinite(t)&&t<open&&Number.isFinite(v)&&v>0)byDay.set(Math.floor(t/DAY),v);}
  const days=[...byDay.keys()].sort((a,b)=>a-b);
  if(!days.length||days.at(-1)!==Math.floor(open/DAY)-1)return null;
  return days.map(d=>byDay.get(d));
}
const validState=(s,now)=>!!s&&typeof s==="object"&&s.v===TREND_LINES_STATE_VERSION&&Number.isInteger(s.d)&&s.d<=Math.floor(now/DAY)&&s.lines&&typeof s.lines==="object"&&TREND_LINE_NAMES_V1.every(n=>isNum(s.lines[n]?.target_pct)&&s.lines[n].target_pct>=0&&s.lines[n].target_pct<=100);
const targetsOf=state=>Object.fromEntries(TREND_LINE_NAMES_V1.map(n=>[n,state?state.lines[n].target_pct:null]));

/*
 * Шаг линий. Чистая функция: (время, входы вариантов, прежнее состояние) → (состояние, цели).
 * Фикс не состоялся (нет вчерашней свечи, нет 200 закрытых дней, нет входов) — прежние цели
 * держатся, день фикса не тратится: следующий прогон попробует снова.
 */
export function evaluateTrendLinesV1({now,inputs,state}={}){
  const t=now instanceof Date?now.getTime():typeof now==="string"?Date.parse(now):now;
  if(!isNum(t))throw new Error("trend lines: bad time");
  const prev=validState(state,t)?state:null,fixDay=Math.floor((t-FIX_HOUR*HOUR)/DAY);
  const hold=note=>({state:prev,targets:targetsOf(prev),fixed:false,note});
  if(prev&&prev.d>=fixDay)return hold("between_fixes");
  if(!inputs||typeof inputs!=="object")return hold("no_inputs");
  const closes=closedCloses(inputs.series?.price_daily,t);
  if(!closes)return hold("closed_day_not_ready");
  const lines=trendTargetsV1({closes,families:inputs.families});
  if(!lines)return hold("price_history_short");
  const next={v:TREND_LINES_STATE_VERSION,d:fixDay,fix_at:iso(t),lines};
  return{state:next,targets:targetsOf(next),fixed:true,note:prev?"fix":"cold_start"};
}

// Публичный блок: объявление и последнее решение линий.
export function trendLinesPublicV1(state,at){
  const{id,version,status,declared_at,statement}=TREND_LINES_V1;
  return{id,version,status,declared_at,statement,fix_at:state?.fix_at??null,evaluated_at:at,lines:state?.lines??null};
}
