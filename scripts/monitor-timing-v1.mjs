// Сравнения линий монитора на общих окнах и честный ноль тайминга (аудит 2026-10-10, отчёт 2.2, 2.4, 3.4).
//
// Три правила, ради которых модуль существует:
//  1. Линии, рождённые в разные дни, сравниваются только на ОБЩЕМ окне — от более позднего старта.
//     Тень v2 родилась на трое суток позже v1, и её Sharpe и доходность стояли рядом с числами v1
//     так, будто окна одинаковы.
//  2. Оба портфеля открываются в начале окна и платят вход со своей стартовой доли: иначе линия,
//     родившаяся в окне, платит вход, а старшая — нет.
//  3. Sharpe и волатильность — только по закрытым суткам: текущая неполная дневная строка
//     считалась целыми сутками, и числа менялись внутри дня.

import { excessSharpeV2, timingNullV2 } from "../docs/policy-v2-candidate.mjs";

const DAY=86_400_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
// Отрицательный ноль не публикуется: «−0» читается как знак, которого нет.
const round=(x,d=4)=>finite(x)?Number(Number(x).toFixed(d))+0:null;
export const TIMING_NULL_WINDOWS_DAYS=Object.freeze([90,180,365]);

// Закрытые сутки: дневные строки раньше текущей даты UTC.
export const closedRowsV1=(daily,date)=>(daily||[]).filter(row=>row.date<date);
export function sharpeOfRowsV1(rows,name){
  return excessSharpeV2(rows.filter(row=>finite(row.nav?.[name])&&finite(row.nav?.cash)&&finite(Date.parse(row.t))).map(row=>({t:Date.parse(row.t),nav:Number(row.nav[name]),cash:Number(row.nav.cash)})));
}

// Виртуальная строка рождения линии для timingNullV2: момент, цена и NAV кэша старта, NAV линии
// сразу после входа, нулевой путь. Нужна, потому что генезис не совпадает с дневной строкой.
function birthPoint(monitor,name,costRate){
  const meta=monitor.strategy_meta?.[name];
  if(!meta||!finite(meta.start_price)||!finite(meta.start_target_pct))return null;
  const cashNav=meta.base?meta.base.cash_nav:meta.started_at===monitor.started_at?1:null;
  if(!finite(cashNav))return null;
  return{t:meta.started_at,price:meta.start_price,cash_nav:cashNav,nav:1-Math.abs(Number(meta.start_target_pct))/100*costRate,target_pct:meta.start_target_pct,w_days:0,gross:1};
}
// policy_v1 на момент рождения другой линии — опорная точка общего окна.
function policyPointAt(monitor,name,costRate){
  const meta=monitor.strategy_meta?.[name],own=birthPoint(monitor,"policy_v1",costRate);
  if(!meta)return null;
  if(!meta.base)return meta.started_at===monitor.strategy_meta?.policy_v1?.started_at?own:null;
  const b=meta.base;
  if(!finite(b.policy_v1_nav)||!finite(meta.start_price)||!finite(b.cash_nav))return null;
  return{t:meta.started_at,price:meta.start_price,cash_nav:b.cash_nav,nav:b.policy_v1_nav,target_pct:b.policy_v1_target_pct,w_days:b.policy_v1_w_days,gross:b.policy_v1_gross};
}
const currentPoint=strategy=>({nav:strategy.nav,w_days:strategy.exposure_pct_days,gross:strategy.gross_nav});
const publishWindow=tn=>tn?{
  from:tn.from,to:tn.to,days:round(tn.days,2),share_pct:round(tn.share_pct,2),share_source:tn.share_source,
  policy_net_return_pct:round(tn.policy_net_return_pct),null_net_return_pct:round(tn.null_net_return_pct),hodl_net_return_pct:round(tn.hodl_net_return_pct),
  vs_null_pp:round(tn.vs_null_pp),level_pp:round(tn.level_pp),timing_pp:round(tn.timing_pp),costs_pp:round(tn.costs_pp),capture_ratio:round(tn.capture_ratio),
}:null;

// Честный ноль тайминга политики: с начала и скользящие окна, когда данных хватает.
// Окно «с начала» требует, чтобы дневные строки ещё покрывали генезис (хранится 370 суток); после
// этого его сменяет окно 365 дней. Скользящее окно начинается с закрытой дневной строки не моложе
// N суток и требует точного пути политики в этой строке.
export function timingNullBlockV1(monitor,{now,date,costRate}){
  const daily=monitor.daily||[],policy=monitor.strategies?.policy_v1,out={since_start:null};
  for(const days of TIMING_NULL_WINDOWS_DAYS)out[`d${days}`]=null;
  if(!policy||!finite(policy.gross_nav)||!daily.length)return out;
  const end=currentPoint(policy),start=birthPoint(monitor,"policy_v1",costRate);
  if(start&&Date.parse(daily[0].t)-Date.parse(start.t)<=1.5*DAY)out.since_start=publishWindow(timingNullV2(daily,{name:"policy_v1",start,end,costRate}));
  for(const days of TIMING_NULL_WINDOWS_DAYS){
    const from=closedRowsV1(daily,date).filter(row=>Date.parse(row.t)<=now-days*DAY&&Array.isArray(row.path?.policy_v1)).at(-1);
    if(from)out[`d${days}`]=publishWindow(timingNullV2(daily.filter(row=>Date.parse(row.t)>=Date.parse(from.t)),{name:"policy_v1",end,costRate}));
  }
  return out;
}

// Разложение линии на её собственном окне (с рождения) и policy_v1 на том же окне. Нужен точный
// путь обеих: линии, рождённые до версии с учётом пути, его не имеют.
export function lineTimingV1(monitor,name,{costRate}){
  const daily=monitor.daily||[],line=monitor.strategies?.[name],policy=monitor.strategies?.policy_v1;
  if(!line||!policy||!finite(line.gross_nav)||!finite(policy.gross_nav))return null;
  const lineStart=birthPoint(monitor,name,costRate),policyStart=policyPointAt(monitor,name,costRate);
  if(!lineStart||!policyStart||!finite(policyStart.gross))return null;
  const own=timingNullV2(daily,{name,start:lineStart,end:currentPoint(line),costRate}),base=timingNullV2(daily,{name:"policy_v1",start:policyStart,end:currentPoint(policy),costRate});
  return own&&base?{line:own,policy_v1:base}:null;
}

// Максимальная просадка по дневным закрытиям окна — одна линейка для обеих линий сравнения.
export function closeDrawdownPctV1(daily,name,fromMs,startNav=null){
  let peak=finite(startNav)?Number(startNav):null,worst=0;
  for(const row of daily||[]){
    if(Date.parse(row.t)<fromMs||!finite(row.nav?.[name]))continue;
    const nav=Number(row.nav[name]);peak=peak===null?nav:Math.max(peak,nav);worst=Math.min(worst,(nav/peak-1)*100);
  }
  return peak===null?null:worst;
}

// Сравнение каждой линии с policy_v1 на общем окне: разница доходностей (обе открыты в начале
// окна) и разрыв Sharpe по закрытым суткам, где есть обе линии.
export function comparisonsV1(monitor,{now,date,costRate}){
  const daily=monitor.daily||[],policy=monitor.strategies?.policy_v1,out={};
  if(!policy)return out;
  const closed=closedRowsV1(daily,date);
  for(const [name,line] of Object.entries(monitor.strategies||{})){
    if(name==="policy_v1")continue;
    const meta=monitor.strategy_meta?.[name],base=policyPointAt(monitor,name,costRate);
    const common=closed.filter(row=>finite(row.nav?.[name])&&finite(row.nav?.policy_v1));
    const lineSharpe=sharpeOfRowsV1(common,name).sharpe_excess,policySharpe=sharpeOfRowsV1(common,"policy_v1").sharpe_excess;
    let from=null,gap=null,basis=null;
    if(meta&&base&&finite(base.nav)&&Number(base.nav)>0){
      // Линия с рождения несёт свой вход в NAV; policy_v1 на том же окне открывается заново.
      const policyNet=Number(policy.nav)/Number(base.nav)*(1-Math.abs(Number(base.target_pct)||0)/100*costRate)-1;
      from=meta.started_at;gap=(Number(line.nav)-1-policyNet)*100;basis="birth";
    }else{
      // Старт линии известен только с точностью до дневной строки: отношение NAV от первой общей строки.
      const first=daily.find(row=>finite(row.nav?.[name])&&finite(row.nav?.policy_v1));
      if(first&&Number(first.nav[name])>0&&Number(first.nav.policy_v1)>0){from=first.t;gap=(Number(line.nav)/Number(first.nav[name])-Number(policy.nav)/Number(first.nav.policy_v1))*100;basis="daily_row";}
    }
    if(from===null)continue;
    // Тайминг линии и policy_v1 на том же окне — когда у обеих есть точный путь.
    const timing=lineTimingV1(monitor,name,{costRate}),timed=timing&&finite(timing.line.timing_pp)&&finite(timing.policy_v1.timing_pp);
    out[name]={vs:"policy_v1",from,days:round((now-Date.parse(from))/DAY,2),basis,net_return_gap_pp:round(gap),sharpe_gap:finite(lineSharpe)&&finite(policySharpe)?round(lineSharpe-policySharpe):null,closed_days:Math.max(0,common.length-1),
      // timing_pp — чистый тайминг (до издержек); vs_null_pp — линия против своей постоянной доли с
      // издержками (так «тайминг» определён в критериях приёмки кандидата v3).
      ...(timed?{share_pct:round(timing.line.share_pct,2),policy_share_pct:round(timing.policy_v1.share_pct,2),timing_pp:round(timing.line.timing_pp),policy_timing_pp:round(timing.policy_v1.timing_pp),timing_gap_pp:round(timing.line.timing_pp-timing.policy_v1.timing_pp),vs_null_pp:round(timing.line.vs_null_pp),policy_vs_null_pp:round(timing.policy_v1.vs_null_pp),vs_null_gap_pp:round(timing.line.vs_null_pp-timing.policy_v1.vs_null_pp)}:{})};
  }
  return out;
}
