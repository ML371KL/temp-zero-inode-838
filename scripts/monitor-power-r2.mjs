// Мощность R2 на истории: отличает ли критерий исправную политику от политики с уничтоженным таймингом.
// Считает НАСТОЯЩИМ кодом триады (evaluateReviewV2 из docs/policy-v2-candidate.mjs), а не его пересказом.
//
// Постановка — из аудита 2026-10-10 (отчёт «монитор», 3.3): дневная реконструкция policy v1 на истории
// 2014–2026 по исследовательскому архиву (backtest/out/timeline.json; дерево гейтов, гейт оценки,
// детекторы, гистерезис «вниз сразу, вверх на втором дне», лестница и оверлеи v1; исполнение на
// следующий день, 10 б.п. на оборот). Монитор запускается с NAV = 1 в датах с шагом --step дней и
// ведётся 730 дней. Варианты: healthy — как есть; const — постоянная доля, равная средней доле
// healthy за запуск (тайминга нет); shift180 — тот же путь долей с опозданием на 180 дней (тайминг
// уничтожен); inverted — 100 минус цель. Архив только читается и ничего не настраивает.
//
//   node scripts/monitor-power-r2.mjs [--step 7]
//
// Ориентир аудита для честного нуля на шаге 7: исправная 22 %, shift180 63 %, inverted 72 %, const 0 %.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateReviewV2 } from "../docs/policy-v2-candidate.mjs";

const DAY=86_400_000,COST=0.001,HORIZON=730;
const finite=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
export const R2_POWER_VARIANTS=Object.freeze(["healthy","const","shift180","inverted"]);

// Реконструкция пути цели policy v1 по архиву (приближение живой политики на дневном шаге).
export function reconstructPolicyHistoryV1(){
  const timelineUrl=new URL("../backtest/out/timeline.json",import.meta.url),cashUrl=new URL("../backtest/data/fred_DTB3.json",import.meta.url);
  if(!existsSync(timelineUrl)||!existsSync(cashUrl))return null;
  const rows=JSON.parse(readFileSync(timelineUrl,"utf8")),dtb3=JSON.parse(readFileSync(cashUrl,"utf8"));
  const effective=d=>(1/(1-d/100*91/360))**(365.25/91)-1,cash=new Array(rows.length);
  for(let i=0,j=0;i<rows.length;i++){while(j+1<dtb3.length&&dtb3[j+1].t<=rows[i].t)j++;cash[i]=(1+effective(Math.max(0,dtb3[j].v)))**(1/365.25)-1;}
  const FAMILIES={macro:["liquidity","conditions","stress"],demand:["etf","stablecoins","exchange_supply","institutional"],cycle:["valuation","network","activity","miners","trend"]};
  const SEVERITY={constructive:2,unconfirmed_positive:1,transition:0,deteriorating:-1,defensive:-2,insufficient:0},LADDER={emergency:0,defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100};
  const score=(r,f)=>{let s=r.families[f];
    if(f==="valuation"&&finite(r.families.mvrvPct)){const p=r.families.mvrvPct;s=p>=95?-2:p>=82?-1:p<=10?1:0;}
    if(f==="stress"&&finite(r.families.stress28))s=r.families.stress28;
    if(f==="exchange_supply"&&finite(r.families.exchange_supply28))s=r.families.exchange_supply28;
    return finite(s)?s:null;};
  const candidate=r=>{
    if(r.insufficientEra)return"insufficient";
    const band={};for(const [block,families] of Object.entries(FAMILIES)){const a=families.map(f=>score(r,f)).filter(finite),s=a.length?mean(a)/2*100:null;band[block]=s===null?"unknown":s>=20?"supportive":s<=-20?"adverse":"neutral";}
    const {macro:M,demand:D,cycle:C}=band,adverse=[M,D,C].filter(x=>x==="adverse").length;let s="transition";
    if(adverse>=2)s="defensive";else if(D==="adverse")s="deteriorating";else if(adverse>=1)s="transition";
    else if(D==="supportive"&&C==="supportive"&&M!=="adverse")s="constructive";else if(D==="supportive"&&M==="supportive")s="constructive";else if(M==="supportive"&&C==="supportive"&&D==="neutral")s="unconfirmed_positive";
    const valuation=score(r,"valuation");
    if((!finite(valuation)||valuation<=-1)&&["constructive","unconfirmed_positive"].includes(s))s="transition";
    if(r.detectors.macro_shock==="fired"&&["constructive","unconfirmed_positive","transition"].includes(s))s="deteriorating";
    if(r.detectors.recovery==="good"&&r.detectors.macro_shock!=="fired"&&["defensive","deteriorating"].includes(s))s="transition";
    return s;};
  const target=new Array(rows.length).fill(null);
  let state=null,seen=null,count=0,previous=null;
  rows.forEach((r,i)=>{
    const c=candidate(r);if(c===seen)count++;else{seen=c;count=1;}
    if(state===null)state=c;else if(SEVERITY[c]<SEVERITY[state])state=c;else if(SEVERITY[c]>SEVERITY[state]&&count>=2)state=c;
    let t=LADDER[state];
    if(t===undefined)t=previous;else{
      if(r.detectors.recovery==="good"&&r.detectors.macro_shock!=="fired")t=Math.max(t,80);
      if(finite(r.families.mvrvPct)&&r.families.mvrvPct<=10)t=Math.max(t,40);
      if(finite(r.families.mvrvPct)&&r.families.mvrvPct>=95)t=Math.min(t,60);}
    target[i]=t;previous=t;
  });
  return{rows,cash,target,first:rows.findIndex(r=>r.date>="2014-01-01")};
}

// Дневные строки монитора для одного запуска и варианта: цель дня держится до закрытия следующего.
function monitorRowsOf(history,start,variant){
  const {rows,cash,target}=history,base=d=>target[start+d-1]??50;
  let average=0;for(let d=0;d<=HORIZON;d++)average+=base(d);average=Math.round(average/(HORIZON+1)*10)/10;
  const weight=d=>variant==="healthy"?base(d):variant==="const"?average:variant==="shift180"?(target[start+d-1-180]??50):100-base(d);
  const out=[];let nav=1,gross=1,exposure=0,hodl=1-COST,cashNav=1,held=null;
  for(let d=0;d<=HORIZON;d++){
    const i=start+d,w=weight(d);
    if(held===null)nav*=1-w/100*COST;
    else{const r=rows[i].price/rows[i-1].price-1,g=held/100*r+(1-held/100)*cash[i];nav*=(1+g)*(1-Math.abs(w-held)/100*COST);gross*=1+g;exposure+=held;hodl*=1+r;cashNav*=1+cash[i];}
    held=w;
    out.push({t:new Date(rows[i].t+23*3_600_000).toISOString(),price:rows[i].price,targets:{policy_v1:w},nav:{policy_v1:nav,buy_and_hold:hodl,cash:cashNav},path:{policy_v1:[exposure,gross]}});
  }
  return out;
}

// Доля запусков, в которых R2 дошёл до investigate за 730 дней, по вариантам.
export function r2PowerOnHistoryV1({step=7,starts=null,variants=R2_POWER_VARIANTS,history=reconstructPolicyHistoryV1()}={}){
  if(!history)return null;
  const list=starts||(()=>{const a=[];for(let s=history.first;s+HORIZON<=history.rows.length-1;s+=step)a.push(s);return a;})();
  const fired=Object.fromEntries(variants.map(v=>[v,0]));
  for(const start of list)for(const variant of variants){
    const rows=monitorRowsOf(history,start,variant);let review=null;
    // Все окна триады не длиннее 365 суток: старше 370 строк ей не нужны (столько же хранит монитор).
    for(let d=290;d<=HORIZON;d++){review=evaluateReviewV2(rows.slice(Math.max(0,d-370),d+1),review);if(review.r2_timing.status==="investigate"){fired[variant]++;break;}}
  }
  return{runs:list.length,first:history.rows[list[0]].date,last:history.rows[list.at(-1)].date,fired,share_pct:Object.fromEntries(variants.map(v=>[v,Number((100*fired[v]/list.length).toFixed(1))]))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const i=process.argv.indexOf("--step"),step=i>=0?Number(process.argv[i+1]):7,started=Date.now();
  const result=r2PowerOnHistoryV1({step});
  if(!result){console.error("нет архива backtest/out/timeline.json");process.exit(1);}
  console.log(`R2 против честного нуля, код триады как есть. Запусков ${result.runs} (шаг ${step} дн., ${result.first} … ${result.last}), горизонт ${HORIZON} дн.`);
  console.log("Доля запусков с investigate к 730-му дню, %:");
  for(const v of R2_POWER_VARIANTS)console.log(`  ${v.padEnd(10)} ${String(result.share_pct[v]).padStart(5)}   (${result.fired[v]} из ${result.runs})`);
  console.log(`Время счёта ${((Date.now()-started)/1000).toFixed(0)} с.`);
}
