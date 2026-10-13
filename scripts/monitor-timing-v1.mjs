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
//  4. Окно «с рождения» живёт, пока дневные строки покрывают рождение линии. Строки хранятся 370
//     суток; когда строка суток рождения ушла, сетка с рождения обрезана: ноль тайминга проходил
//     ушедшие сутки одним шагом, просадка и эпизоды расхождения теряли ранние дни, и числа без
//     пометки уходили от пересчёта по полной сетке (на 430-й день жизни линии — на 0,25 п.п.).
//     Тогда окно «с рождения» закрывается, а сравнение ведётся на скользящем окне 365 суток — тем
//     же правилом, каким окно `since_start` честного нуля политики сменяется окном `d365`.

import { excessSharpeV2, timingNullV2 } from "../docs/policy-v2-candidate.mjs";

const DAY=86_400_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
// Отрицательный ноль не публикуется: «−0» читается как знак, которого нет.
const round=(x,d=4)=>finite(x)?Number(Number(x).toFixed(d))+0:null;
export const TIMING_NULL_WINDOWS_DAYS=Object.freeze([90,180,365]);
// Длина скользящего окна сравнения линии с policy_v1, когда окно «с рождения» закрыто.
export const COMPARISON_ROLLING_DAYS=365;
// Линии, чей точный путь [накопленная доля, %·сутки; валовой NAV] пишется в КАЖДУЮ дневную строку:
// без него средняя по времени доля на окне, начатом с дневной строки, неизвестна — в строке есть
// только цель закрытия дня. Путь нужен политике (окна d90…d365 честного нуля) и кандидату v3 (его
// приёмка сравнивает тайминг с policy_v1, и после 370 суток жизни — на скользящем окне). Остальным
// линиям он стоил бы 44 байта на линию в каждой из 370 строк: их сравнение на скользящем окне
// обходится доходностью, Sharpe и эпизодами расхождения, а тайминг не публикуется.
export const ROW_PATH_LINES_V1=Object.freeze(["policy_v1","policy_v3_shadow"]);
export function rowPathV1(strategies){
  const path={};
  for(const name of ROW_PATH_LINES_V1){
    const line=strategies?.[name];
    if(finite(line?.gross_nav)&&finite(line?.exposure_pct_days))path[name]=[Number(Number(line.exposure_pct_days).toFixed(4)),Number(Number(line.gross_nav).toFixed(9))];
  }
  return Object.keys(path).length?path:null;
}

// Закрытые сутки: дневные строки раньше текущей даты UTC.
export const closedRowsV1=(daily,date)=>(daily||[]).filter(row=>row.date<date);
// Дневные строки окна: не раньше его начала (строка начала входит — она точка отсчёта).
export const rowsFromV1=(daily,from)=>{const t=Date.parse(from);return finite(t)?(daily||[]).filter(row=>Date.parse(row.t)>=t):(daily||[]);};
// Покрывают ли дневные строки рождение линии: хранится ли ещё строка суток её рождения. С её уходом
// из окна «с рождения» пропадает первая дневная точка: первый шаг нуля тайминга растягивается,
// Sharpe теряет первую дневную доходность, счёт эпизодов — первый день. Одно правило для линий и
// для окна «с начала» честного нуля политики.
export function birthInRowsV1(daily,name,startedAt){
  const first=(daily||[]).find(row=>finite(row.nav?.[name])),born=Date.parse(startedAt);
  return!!first&&finite(born)&&first.date===new Date(born).toISOString().slice(0,10);
}
export function sharpeOfRowsV1(rows,name){
  // Время строки разбирается один раз: разбор ISO-отметки дороже всей остальной арифметики прохода.
  const points=[];
  for(const row of rows){
    if(!finite(row.nav?.[name])||!finite(row.nav?.cash))continue;
    const t=Date.parse(row.t);
    if(finite(t))points.push({t,nav:Number(row.nav[name]),cash:Number(row.nav.cash)});
  }
  return excessSharpeV2(points);
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
// Окно «с начала» требует, чтобы дневные строки ещё покрывали генезис — хранилась строка его суток
// (строки живут 370 суток); после этого его сменяет окно 365 дней. Скользящее окно начинается с закрытой дневной строки не моложе
// N суток и требует точного пути политики в этой строке.
export function timingNullBlockV1(monitor,{now,date,costRate}){
  const daily=monitor.daily||[],policy=monitor.strategies?.policy_v1,out={since_start:null};
  for(const days of TIMING_NULL_WINDOWS_DAYS)out[`d${days}`]=null;
  if(!policy||!finite(policy.gross_nav)||!daily.length)return out;
  const end=currentPoint(policy),start=birthPoint(monitor,"policy_v1",costRate);
  if(start&&birthInRowsV1(daily,"policy_v1",start.t))out.since_start=publishWindow(timingNullV2(daily,{name:"policy_v1",start,end,costRate}));
  for(const days of TIMING_NULL_WINDOWS_DAYS){
    const from=closedRowsV1(daily,date).filter(row=>Date.parse(row.t)<=now-days*DAY&&Array.isArray(row.path?.policy_v1)).at(-1);
    if(from)out[`d${days}`]=publishWindow(timingNullV2(daily.filter(row=>Date.parse(row.t)>=Date.parse(from.t)),{name:"policy_v1",end,costRate}));
  }
  return out;
}

// Разложение линии и policy_v1 на одном окне. Нужен точный путь обеих: линии, рождённые до версии
// с учётом пути, его не имеют.
//  Без `from` — окно с рождения линии, и только пока дневные строки покрывают рождение: по
//  обрезанной сетке окно не считается вовсе (null), а не считается приблизительно.
//  С `from` (закрытая дневная строка) — скользящее окно от неё: нужен путь обеих линий в этой строке.
export function lineTimingV1(monitor,name,{costRate,from=null}){
  const daily=monitor.daily||[],line=monitor.strategies?.[name],policy=monitor.strategies?.policy_v1;
  if(!line||!policy||!finite(line.gross_nav)||!finite(policy.gross_nav))return null;
  let own,base;
  if(from){
    if(!Array.isArray(from.path?.[name])||!Array.isArray(from.path?.policy_v1))return null;
    const rows=rowsFromV1(daily,from.t);
    own=timingNullV2(rows,{name,end:currentPoint(line),costRate});base=timingNullV2(rows,{name:"policy_v1",end:currentPoint(policy),costRate});
  }else{
    const lineStart=birthPoint(monitor,name,costRate),policyStart=policyPointAt(monitor,name,costRate);
    if(!lineStart||!policyStart||!finite(policyStart.gross)||!birthInRowsV1(daily,name,lineStart.t))return null;
    own=timingNullV2(daily,{name,start:lineStart,end:currentPoint(line),costRate});base=timingNullV2(daily,{name:"policy_v1",start:policyStart,end:currentPoint(policy),costRate});
  }
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
// окна) и разрыв Sharpe по закрытым суткам, где есть обе линии. Все числа блока — на ОДНОМ окне
// [from, сейчас]; чем задано его начало, говорит `basis`:
//  birth — рождением линии: старт известен точно, дневные строки покрывают его;
//  daily_row — первой общей дневной строкой: старт линии прежней формы известен только до строки;
//  rolling — рождение ушло из дневных строк (линия старше 370 суток): окно «с рождения» закрыто
//    (`since_birth: null`), сравнение ведётся от закрытой строки не моложе 365 суток, обе линии
//    открыты в ней заново и платят вход со своей доли в этой строке.
export function comparisonsV1(monitor,{now,date,costRate}){
  const daily=monitor.daily||[],policy=monitor.strategies?.policy_v1,out={};
  if(!policy)return out;
  const closed=closedRowsV1(daily,date),closedAt=closed.map(row=>Date.parse(row.t)),entry=target=>finite(target)?1-Math.abs(Number(target))/100*costRate:1;
  for(const [name,line] of Object.entries(monitor.strategies||{})){
    if(name==="policy_v1")continue;
    const meta=monitor.strategy_meta?.[name],base=policyPointAt(monitor,name,costRate),both=row=>finite(row.nav?.[name])&&finite(row.nav?.policy_v1);
    let from=null,gap=null,basis=null,timing=null;
    if(meta&&base&&finite(base.nav)&&Number(base.nav)>0){
      if(birthInRowsV1(daily,name,meta.started_at)){
        // Линия с рождения несёт свой вход в NAV; policy_v1 на том же окне открывается заново.
        const policyNet=Number(policy.nav)/Number(base.nav)*(1-Math.abs(Number(base.target_pct)||0)/100*costRate)-1;
        from=meta.started_at;gap=(Number(line.nav)-1-policyNet)*100;basis="birth";
        timing=lineTimingV1(monitor,name,{costRate});
      }else{
        // Строка не моложе 365 суток есть всегда, кроме дыры в сборе ровно на её месте: тогда окно
        // начинается с самой старой общей строки и честно короче (его длина — в `days`).
        const start=closed.filter((row,i)=>closedAt[i]<=now-COMPARISON_ROLLING_DAYS*DAY&&both(row)).at(-1)??closed.find(both);
        if(start&&Number(start.nav[name])>0&&Number(start.nav.policy_v1)>0){
          from=start.t;basis="rolling";
          gap=(Number(line.nav)/Number(start.nav[name])*entry(start.targets?.[name])-Number(policy.nav)/Number(start.nav.policy_v1)*entry(start.targets?.policy_v1))*100;
          timing=lineTimingV1(monitor,name,{costRate,from:start});
        }
      }
    }else{
      // Старт линии известен только с точностью до дневной строки: отношение NAV от первой общей строки.
      const first=daily.find(both);
      if(first&&Number(first.nav[name])>0&&Number(first.nav.policy_v1)>0){from=first.t;gap=(Number(line.nav)/Number(first.nav[name])-Number(policy.nav)/Number(first.nav.policy_v1))*100;basis="daily_row";}
    }
    if(from===null)continue;
    const fromMs=Date.parse(from),common=closed.filter((row,i)=>closedAt[i]>=fromMs&&both(row));
    const lineSharpe=sharpeOfRowsV1(common,name).sharpe_excess,policySharpe=sharpeOfRowsV1(common,"policy_v1").sharpe_excess;
    // Тайминг линии и policy_v1 на том же окне — когда у обеих есть точный путь.
    const timed=timing&&finite(timing.line.timing_pp)&&finite(timing.policy_v1.timing_pp);
    out[name]={vs:"policy_v1",from,days:round((now-fromMs)/DAY,2),basis,...(basis==="rolling"?{window_days:COMPARISON_ROLLING_DAYS,since_birth:null}:{}),net_return_gap_pp:round(gap),sharpe_gap:finite(lineSharpe)&&finite(policySharpe)?round(lineSharpe-policySharpe):null,closed_days:Math.max(0,common.length-1),
      // timing_pp — чистый тайминг (до издержек); vs_null_pp — линия против своей постоянной доли с
      // издержками (так «тайминг» определён в критериях приёмки кандидата v3).
      ...(timed?{share_pct:round(timing.line.share_pct,2),policy_share_pct:round(timing.policy_v1.share_pct,2),timing_pp:round(timing.line.timing_pp),policy_timing_pp:round(timing.policy_v1.timing_pp),timing_gap_pp:round(timing.line.timing_pp-timing.policy_v1.timing_pp),vs_null_pp:round(timing.line.vs_null_pp),policy_vs_null_pp:round(timing.policy_v1.vs_null_pp),vs_null_gap_pp:round(timing.line.vs_null_pp-timing.policy_v1.vs_null_pp)}:{})};
  }
  return out;
}
