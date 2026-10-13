// Форвард-счёт для того, что панель показывает, но ничем не проверяет (аудит 2026-10-10, раздел 7):
// краткосрочный вердикт и восемь теневых карточек. Монитор только считает: дни, завершённые
// наблюдения и форвардную доходность BTC по группам. Вывода из счёта не делает никто, кроме владельца.
// Счёт идёт по ЗАКРЫТЫМ суткам: день входит в него после смены даты UTC, форвардная цена — цена
// закрытия дня через горизонт. Поэтому числа меняются раз в сутки, а не каждый прогон.

import { SHADOW_CARD_IDS_V1, SHADOW_HYPOTHESES_V1, shadowConditionStateV1 } from "../docs/shadow-hypotheses-v1.mjs";

const DAY=86_400_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const round=(x,d=2)=>finite(x)?Number(Number(x).toFixed(d))+0:null;
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const dayNumber=date=>Math.round(Date.parse(`${date}T00:00:00.000Z`)/DAY);
export const TACTICAL_FORWARD_HORIZON_DAYS=7;

// Значения теневых карточек для дневной строки: шесть значащих цифр — точности порогов хватает
// с запасом, а строка хранится 370 суток. Нефинитное значение записывается как null.
export function shadowRowValuesV1(shadowValues){
  if(!shadowValues||typeof shadowValues!=="object")return null;
  return Object.fromEntries(SHADOW_CARD_IDS_V1.map(id=>[id,finite(shadowValues[id])?Number(Number(shadowValues[id]).toPrecision(6)):null]));
}

// Форвардная доходность по дневным закрытиям: цена дня через horizon суток (ровно та дата).
function forwardReturns(rows,horizon){
  const byDay=new Map(rows.map(row=>[dayNumber(row.date),row]));
  return rows.map(row=>{const next=byDay.get(dayNumber(row.date)+horizon);return next&&finite(row.price)&&finite(next.price)&&Number(row.price)>0?(Number(next.price)/Number(row.price)-1)*100:null;});
}
const groupStats=(days,returns,extended=false)=>({
  days,completed:returns.length,mean_fwd_pct:round(mean(returns)),
  ...(extended?{median_fwd_pct:round(median(returns))}:{}),
  hit_rate:returns.length?round(returns.filter(x=>x>0).length/returns.length,2):null,
});
// Сколько непересекающихся окон длиной в горизонт укладывается в завершённые наблюдения: столько
// в счёте независимых доходностей, остальные — перекрытие тех же самых дней.
function independentBlocks(dayNumbers,horizon){
  let blocks=0,next=-Infinity;
  for(const day of [...dayNumbers].sort((a,b)=>a-b))if(day>=next){blocks++;next=day+horizon;}
  return blocks;
}

// Доходность BTC за 7 дней вперёд по краткосрочным состояниям.
export function tacticalForwardV1(daily,{date,horizonDays=TACTICAL_FORWARD_HORIZON_DAYS}={}){
  const rows=(daily||[]).filter(row=>row.date<date&&typeof row.tactical==="string"&&finite(row.price)),forward=forwardReturns(rows,horizonDays),byState={};
  rows.forEach((row,i)=>{const s=byState[row.tactical]||(byState[row.tactical]={days:0,returns:[]});s.days++;if(forward[i]!==null)s.returns.push(forward[i]);});
  return{horizon_days:horizonDays,by_state:Object.fromEntries(Object.entries(byState).map(([state,s])=>[state,groupStats(s.days,s.returns,true)]))};
}

// Счёт объявленных утверждений теневого слоя: только дни не раньше даты объявления.
export function shadowEvidenceV1(daily,{date}={}){
  const declared=SHADOW_HYPOTHESES_V1.declared_at;
  const rows=(daily||[]).filter(row=>row.date<date&&row.date>=declared&&row.shadow&&finite(row.price)),cards={};
  for(const [id,hypothesis] of Object.entries(SHADOW_HYPOTHESES_V1.cards)){
    const series=rows.map(row=>({date:row.date,value:row.shadow[id]??null})),observed=series.filter(x=>finite(x.value)).length;
    if(!hypothesis.statement){cards[id]={statement:null,horizon_days:null,expected_sign:null,observed_days:observed};continue;}
    const forward=forwardReturns(rows,hypothesis.horizon_days),on={days:0,returns:[],completed:[]},off={days:0,returns:[],completed:[]};
    series.forEach((point,i)=>{
      const state=shadowConditionStateV1(hypothesis.condition,series,i);if(state===null)return;
      const group=state?on:off;group.days++;
      if(forward[i]!==null){group.returns.push(forward[i]);group.completed.push(dayNumber(point.date));}
    });
    cards[id]={
      statement:hypothesis.statement,horizon_days:hypothesis.horizon_days,expected_sign:hypothesis.expected_sign,observed_days:observed,
      on:groupStats(on.days,on.returns),off:groupStats(off.days,off.returns),
      blocks_independent:independentBlocks([...on.completed,...off.completed],hypothesis.horizon_days),
    };
  }
  return{id:SHADOW_HYPOTHESES_V1.id,version:SHADOW_HYPOTHESES_V1.version,declared_at:declared,cards};
}
