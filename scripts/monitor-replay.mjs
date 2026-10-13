// Прогон форвард-монитора по реальной истории снимков из git (приёмочная проверка, в `npm run check`
// не входит: нужна история репозитория). Берёт последовательные версии docs/snapshot.json, стартует
// от ОПУБЛИКОВАННОГО состояния монитора первого снимка и на каждом следующем вызывает текущий
// updateForwardMonitorV1 с входами, восстановленными из самого снимка. Сверяет с опубликованным:
// NAV, цели и оборот прежних линий, счётчики, события решения, дневные строки; проверяет
// непрерывность собственной hash-цепи и то, что новые поля появляются и не дрожат.
//
//   node scripts/monitor-replay.mjs [--from ISO] [--to ISO] [--count N] [--engine mirror] [--series файл] [--out файл] [--every N] [--trace]
//
// --from/--to — границы по generated_at; --count — сколько последних снимков диапазона взять;
// --engine mirror — учебный движок вариантов вместо docs/policy-v3-candidate.mjs (линии v3 рождаются
// и ведутся; суточный фикс 06:00 UTC у кандидата и v1_daily_close, остальные повторяют v1);
// --series — JSON с рядами первоисточников {hashrate, difficulty, exchange_supply, mvrv, mvrv_deep,
// price_daily} в форме [{t, v}]: движку они подаются срезанными «как были известны» по отметкам
// наблюдения карточек снимка, а дневные закрытия price_daily достраивают ряд цены только в прошлое —
// раньше первого дня, известного из снимков. Без файла ряды берутся из самих карточек (180 точек):
// кандидату v3 этого мало — семьи по остатку бирж не посчитать, 200-дневная средняя появляется
// через двадцать дней ленты, 200-недельная никогда — и он держит цель холодного старта. Числа
// линии кандидата без полного файла — проверка учёта, а не оценка правила;
// --out — куда записать итоговое состояние монитора; --every — печатать строку прогресса раз в N прогонов.
//
// Разрыв цепи в git (прогон есть в журнале, а снимка нет — так было 07.10.2026 15:08 и 16:53 UTC) не
// воспроизводим: сегмент закрывается, следующий стартует от опубликованного состояния после разрыва.
// Вилки (два снимка от одной головы) разрешаются так же, как в бою: выживает тот, кого продолжили.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { compactDecisionInputsV1, stableStringify, updateForwardMonitorV1, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";
import { SHADOW_CARD_IDS_V1 } from "../docs/shadow-hypotheses-v1.mjs";

const DAY=86_400_000,HOUR=3_600_000;
const args=process.argv.slice(2),arg=(name,fallback=null)=>{const i=args.indexOf(`--${name}`);return i>=0?args[i+1]:fallback;};
const repo=fileURLToPath(new URL("..",import.meta.url)),FROM=arg("from"),TO=arg("to"),COUNT=arg("count")?Number(arg("count")):null,ENGINE=arg("engine"),OUT=arg("out"),EVERY=Number(arg("every",500));
const RAW=arg("series")?JSON.parse(readFileSync(arg("series"),"utf8")):null,rawCuts=new Map();
// Срез ряда «как было известно»: точки не позже отметки наблюдения карточки. Отметок за окно — десятки, срезы кэшируются.
const rawUntil=(name,observedAt)=>{
  const limit=Date.parse(observedAt||""),series=RAW?.[name];
  if(!Array.isArray(series)||!Number.isFinite(limit))return null;
  const key=`${name}|${limit}`;
  if(!rawCuts.has(key)){let n=series.length;while(n>0&&series[n-1].t>limit)n--;rawCuts.set(key,series.slice(0,n));}
  return rawCuts.get(key);
};
const OLD_LINES=["policy_v1","previous_policy_shadow","buy_and_hold","fixed_50","cash","trend_vol_25","policy_v2_shadow","static_theta"],TRACE=args.includes("--trace");
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));

// Учебный движок вариантов: только чтобы линии v3 рождались и вели учёт до прихода настоящего.
function mirrorEngine({now,inputs,state}){
  const s={fix_day:state.fix_day??null,fixed:state.fixed??null},day=Math.floor(now/DAY),target=inputs?.v1?.target_pct;
  const due=now>=day*DAY+6*HOUR&&s.fix_day!==day;
  if(inputs?.hard_override){s.fixed=0;}
  else if(Number.isFinite(target)&&(due||s.fixed===null)){s.fixed=target;if(due)s.fix_day=day;}
  const fixAt=s.fix_day===null?null:new Date(s.fix_day*DAY+6*HOUR).toISOString(),live=Number.isFinite(target)?target:null;
  return{state:s,variants:{
    policy_v3_shadow:{target_pct:s.fixed,base_target_pct:s.fixed,state:inputs?.v1?.state??null,candidate:inputs?.v1?.candidate??null,fix_at:fixAt,next_fix_at:new Date((day+1)*DAY+6*HOUR).toISOString(),floor:{active:false,rung:null,closes:0},binding_overlays:[],inputs:{mvrv_percentile:inputs?.v1?.mvrv_percentile??null}},
    v1_daily_close:{target_pct:s.fixed,state:inputs?.v1?.state??null,fix_at:fixAt},
    v1_floor_handoff:{target_pct:live,carry:false},
    v1_no_cftc:{target_pct:live,state:inputs?.v1?.state??null,candidate:inputs?.v1?.candidate??null},
  }};
}

const commits=execFileSync("git",["-C",repo,"log","--format=%H","--reverse","--","docs/snapshot.json"],{encoding:"utf8",maxBuffer:1<<28}).trim().split("\n");
async function* snapshots(list){
  const cat=spawn("git",["-C",repo,"cat-file","--batch"],{stdio:["pipe","pipe","inherit"]});
  for(const c of list)cat.stdin.write(`${c}:docs/snapshot.json\n`);cat.stdin.end();
  let buf=Buffer.alloc(0),need=null,index=0;
  for await(const chunk of cat.stdout){
    buf=buf.length?Buffer.concat([buf,chunk]):chunk;
    for(;;){
      if(need===null){const nl=buf.indexOf(10);if(nl<0)break;const parts=buf.subarray(0,nl).toString("utf8").split(" ");buf=buf.subarray(nl+1);if(parts[1]==="missing"){index++;continue;}need=Number(parts[2]);}
      if(buf.length<need+1)break;
      const body=buf.subarray(0,need).toString("utf8");buf=buf.subarray(need+1);need=null;
      let snapshot=null;try{snapshot=JSON.parse(body);}catch{}
      yield{commit:list[index++],snapshot};
    }
  }
}

// Диапазон коммитов по времени снимка: бинарный поиск по generated_at (коммиты идут по времени).
const generatedAt=commit=>{try{return execFileSync("git",["-C",repo,"show",`${commit}:docs/snapshot.json`],{encoding:"utf8",maxBuffer:1<<28,stdio:["ignore","pipe","ignore"]}).match(/"generated_at":"([^"]+)"/)?.[1]??null;}catch{return null;}};
const lowerBound=iso=>{let lo=0,hi=commits.length;while(lo<hi){const mid=(lo+hi)>>1,t=generatedAt(commits[mid]);if(t!==null&&t<iso)lo=mid+1;else hi=mid;}return lo;};
let first=FROM?lowerBound(FROM):0,last=TO?lowerBound(TO):commits.length;
if(COUNT)first=Math.max(first,last-COUNT);
const selected=commits.slice(first,last);
// Закрытые дни цены, которых нет в 180-дневном ряду карточки тренда: берутся из самого раннего
// снимка с этой карточкой (закрытые дни задним числом не меняются — проверено аудитом).
const priceByDay=new Map();
const absorbPrice=snapshot=>{for(const point of snapshot?.metrics?.find(m=>m.id==="trend_regime")?.series||[])if(finite(point.t)&&finite(point.v))priceByDay.set(Number(point.t),Number(point.v));};
for(const commit of commits.slice(0,400)){const text=(()=>{try{return execFileSync("git",["-C",repo,"show",`${commit}:docs/snapshot.json`],{encoding:"utf8",maxBuffer:1<<28,stdio:["ignore","pipe","ignore"]});}catch{return null;}})();if(!text)continue;const s=JSON.parse(text);if(s.mock||!s.monitoring)continue;absorbPrice(s);break;}
// Глубина ряда цены. Карточка несёт 180 закрытий, сборщик же подаёт движку всю историю свечей: без неё
// кандидат v3 не считает 200-дневную и 200-недельную средние и держит цель холодного старта (на ленте —
// 80 % с 22.07 по 08.08, средняя доля 45 % вместо 28 %). Свечи из --series — тот же источник, закрытые
// сутки совпадают с карточкой до цента; берутся только дни раньше первого известного из снимков,
// поэтому заглядывания вперёд нет.
if(Array.isArray(RAW?.price_daily)&&priceByDay.size){const firstKnown=Math.min(...priceByDay.keys());for(const point of RAW.price_daily)if(finite(point?.t)&&finite(point?.v)&&Number(point.t)<firstKnown)priceByDay.set(Number(point.t),Number(point.v));}

const BLOCKS=["macro","demand","cycle"],band=s=>s==null?"unknown":s>=20?"supportive":s<=-20?"adverse":"neutral";
function snapshotDiff(a,b){
  const families=[],detectors=[],blocks={};
  for(const key of BLOCKS){
    const sa=a.blocks?.[key]?.strategic?.score??null,sb=b.blocks?.[key]?.strategic?.score??null;
    if(sa!==sb)blocks[key]={from:sa,to:sb,band_from:band(sa),band_to:band(sb)};
    const fa=a.blocks?.[key]?.strategic?.families||{},fb=b.blocks?.[key]?.strategic?.families||{};
    for(const family of new Set([...Object.keys(fa),...Object.keys(fb)]))if((fa[family]??null)!==(fb[family]??null)){const card=b.metrics.find(m=>m.vote&&m.strategic&&m.block===key&&m.family===family);families.push({block:key,family,id:card?.id??null,name:card?.name??null,from:fa[family]??null,to:fb[family]??null});}
  }
  for(const d of b.detectors||[]){const before=a.detectors?.find(x=>x.id===d.id)?.state;if(before!==undefined&&before!==d.state)detectors.push({id:d.id,from:before,to:d.state});}
  const ma=a.decision?.inputs?.mvrv_percentile,mb=b.decision?.inputs?.mvrv_percentile;
  return{blocks,families,detectors,...(finite(ma)&&finite(mb)&&ma!==mb?{mvrv_percentile:{from:ma,to:mb}}:{})};
}
// Входы движка вариантов из снимка — в той форме, в какой их строит сборщик (SPEC 1.4). critical_ok —
// среднесрочное покрытие (тактическое линии не касается); price_daily — дневной ряд карточки тренда,
// последняя точка — незакрытые сутки.
function variantInputsOf(s,priceSeries){
  const state=id=>s.detectors?.find(d=>d.id===id)?.state??null,metric=id=>s.metrics?.find(m=>m.id===id)||{};
  const families=Object.fromEntries(BLOCKS.map(key=>[key,{...(s.blocks?.[key]?.strategic?.families||{})}]));
  const criticalOk=BLOCKS.every(key=>(s.blocks?.[key]?.strategic?.coverage??0)>=MODEL_POLICY_V1.critical_min[key])&&!(s.scores?.critical_missing?.strategic||[]).length;
  const own=id=>(metric(id).series||[]).filter(p=>finite(p?.t)&&finite(p?.v)).map(p=>({t:Number(p.t),v:Number(p.v)}));
  return{
    price:s.price,hard_override:!!s.override,
    v1:{state:s.regime?.strategic??null,candidate:s.regime_meta?.strategic?.candidate??s.regime?.strategic??null,critical_ok:criticalOk,target_pct:s.decision?.target_pct??null,recovery_state:state("recovery"),macro_shock_state:state("macro_shock"),distribution_state:state("distribution"),mvrv_percentile:s.decision?.inputs?.mvrv_percentile??null,valuation_score:metric("mvrv_cycle").score??null},
    families,
    series:{
      hashrate:rawUntil("hashrate",metric("network_security").observed_at)??own("network_security"),
      difficulty:rawUntil("difficulty",metric("network_security").observed_at)??[],
      exchange_supply:rawUntil("exchange_supply",metric("exchange_supply").observed_at)??own("exchange_supply"),
      price_daily:priceSeries,
      mvrv:rawUntil("mvrv",metric("mvrv_cycle").observed_at)??own("mvrv_cycle"),
      mvrv_deep:rawUntil("mvrv_deep",metric("mvrv_cycle").observed_at),
    },
    observed_at:{mvrv:metric("mvrv_cycle").observed_at??null,coinmetrics:metric("exchange_supply").observed_at??null,etf:metric("etf_regime").observed_at??null,network:metric("network_security").observed_at??null,market:metric("trend_regime").observed_at??null},
  };
}

const head=snapshot=>snapshot?.monitoring?.decision_log?.at(-1)||null;
const segments=[];let segment=null,monitor=null,previous=null,pending=[],regimeBirth=null,processed=0,chainChecks=0,chainBroken=0,forks=0;
const maxAbs=(stat,key,value,t)=>{if(!(key in stat)||Math.abs(value)>Math.abs(stat[key].v))stat[key]={v:value,t};};
function open(snapshot,commit,reason){
  segment={start:snapshot.generated_at,start_commit:commit.slice(0,10),reason,ticks:0,nav:{},turnover:{},target_mismatch:0,counter_mismatch:0,event_mismatch:0,daily_mismatch:0,input_summary_mismatch:0,v2_mismatch:0,hysteresis_mismatch:0,intraday_jitter:0,timing_step_max:0,log_field_mismatch:0,first_fields:null,end:null};
  segments.push(segment);monitor=structuredClone(snapshot.monitoring);previous=snapshot;regimeBirth=null;
}
function step(snapshot,commit){
  const now=Date.parse(snapshot.generated_at),published=snapshot.monitoring;
  absorbPrice(snapshot);
  const priceSeries=[...priceByDay.entries()].sort((a,b)=>a[0]-b[0]).map(([t,v])=>({t,v}));
  const inputSummary=compactDecisionInputsV1({metrics:snapshot.metrics,blocks:snapshot.blocks,detectors:snapshot.detectors,scores:snapshot.scores,sourceVintages:snapshot.source_vintages});
  const diff=snapshotDiff(previous,snapshot),prevMeta=previous.regime_meta?.strategic||{},meta=snapshot.regime_meta?.strategic||{};
  if(!regimeBirth||meta.candidate!==prevMeta.candidate)regimeBirth={strategic:{t:snapshot.generated_at,candidate:meta.candidate??null,from_candidate:prevMeta.candidate??null,price:snapshot.price,blocks:diff.blocks,families:diff.families,detectors:diff.detectors,note:Object.keys(diff.blocks).length||diff.families.length||diff.detectors.length?null:"coverage"}};
  const ph=published.shadow_hysteresis||{},pp=previous.monitoring.shadow_hysteresis||{};
  const before=monitor;
  monitor=updateForwardMonitorV1({
    previousMonitor:monitor,now,price:snapshot.price,decision:snapshot.decision,inputSummary,sourceVintages:snapshot.source_vintages,revisionAlerts:snapshot.source_revision_alerts||[],
    cashQuotePct:published.last_cash_quote_pct,cashQuoteBasis:published.last_cash_quote_basis,priceSeries,previousSnapshotPresent:true,regimeMeta:snapshot.regime_meta,
    shadowHysteresis:{upgrade_hold_reset_by_degraded:(ph.upgrade_hold_resets_by_degraded||0)-(pp.upgrade_hold_resets_by_degraded||0),risk_off_confirmed_under_min_interval:(ph.risk_off_confirmed_under_min_interval||0)-(pp.risk_off_confirmed_under_min_interval||0)},
    v2Inputs:{mvrv_percentile_deep:published.v2_candidate?.inputs?.mvrv_percentile_deep??null},
    variantInputs:variantInputsOf(snapshot,priceSeries),shadowValues:Object.fromEntries(SHADOW_CARD_IDS_V1.map(id=>[id,snapshot.metrics?.find(m=>m.id===id)?.value_num??null])),
    regimeBirth,tickDiff:{families:diff.families,detectors:diff.detectors,...(diff.mvrv_percentile?{mvrv_percentile:diff.mvrv_percentile}:{})},
    ...(ENGINE==="mirror"?{variantEngine:mirrorEngine}:{}),
  });
  segment.ticks++;processed++;segment.end=snapshot.generated_at;
  for(const name of OLD_LINES){
    const mine=monitor.strategies[name],theirs=published.strategies?.[name];if(!mine||!theirs)continue;
    maxAbs(segment.nav,name,mine.nav-theirs.nav,snapshot.generated_at);maxAbs(segment.turnover,name,mine.turnover_pct-theirs.turnover_pct,snapshot.generated_at);
    if(Math.abs(mine.current_target_pct-theirs.current_target_pct)>1e-9)segment.target_mismatch++;
  }
  if(monitor.state_changes!==published.state_changes||monitor.target_changes!==published.target_changes)segment.counter_mismatch++;
  if(stableStringify(monitor.decision_events)!==stableStringify(published.decision_events))segment.event_mismatch++;
  const mineRow=monitor.daily.at(-1),theirRow=published.daily.at(-1);
  if(mineRow.date!==theirRow.date||mineRow.price!==theirRow.price||mineRow.decision_hash!==theirRow.decision_hash||monitor.daily.length!==published.daily.length)segment.daily_mismatch++;
  if(stableStringify(mineRow.input_summary)!==stableStringify(theirRow.input_summary))segment.input_summary_mismatch++;
  if(monitor.v2_candidate.target_pct!==published.v2_candidate?.target_pct||monitor.v2_candidate.recovery_closes!==published.v2_candidate?.recovery_closes)segment.v2_mismatch++;
  // Счётчик быстрых понижений монитор теперь ведёт сам; до 28.07.2026 ключ назывался risk_off_confirmed_under_30m.
  const publishedFast=ph.risk_off_confirmed_under_min_interval??ph.risk_off_confirmed_under_30m;
  if(publishedFast!==undefined&&(monitor.shadow_hysteresis?.risk_off_confirmed_under_min_interval!==publishedFast||monitor.shadow_hysteresis?.upgrade_hold_resets_by_degraded!==ph.upgrade_hold_resets_by_degraded)){
    segment.hysteresis_mismatch++;
    if(TRACE&&segment.hysteresis_mismatch<=5)console.error(`счётчик гистерезиса ${snapshot.generated_at}: мой ${JSON.stringify(monitor.shadow_hysteresis)} опубликован ${JSON.stringify(ph)}`);
  }
  // Запись журнала: все прежние поля равны опубликованным; хэши свои (в записи есть новый блок v3).
  const mineLog=monitor.decision_log.at(-1),theirLog=published.decision_log.at(-1);
  for(const key of Object.keys(theirLog))if(!["log_hash","previous_log_hash","original_log_hash","graft"].includes(key)&&stableStringify(mineLog[key])!==stableStringify(theirLog[key]))segment.log_field_mismatch++;
  // «Не дрожат»: всё, что считается по закрытым суткам, внутри одних суток UTC обязано стоять.
  if(before.updated_at?.slice(0,10)===monitor.updated_at.slice(0,10)&&before.performance&&before.comparisons){
    const frozen=m=>stableStringify({s:Object.fromEntries(Object.entries(m.performance).map(([k,v])=>[k,[v.sharpe_excess,v.annualized_volatility_pct]])),c:Object.fromEntries(Object.entries(m.comparisons).map(([k,v])=>[k,[v.sharpe_gap,v.closed_days]])),t:m.tactical_forward,e:m.shadow_evidence??null,n:m.health?.performance_numbers?.sharpe_gap_vs_best_simple_benchmark??null});
    if(frozen(before)!==frozen(monitor))segment.intraday_jitter++;
    const a=before.timing_null?.since_start,b=monitor.timing_null?.since_start;
    if(a&&b){const move=Math.abs(snapshot.price/previous.price-1)*100;segment.timing_step_max=Math.max(segment.timing_step_max,Math.abs(b.timing_pp-a.timing_pp)-move);}
  }
  // Собственная цепь: первые записи — опубликованные, дальше свои; обход всей хранимой цепи раз в 50 прогонов.
  if(segment.ticks%50===1){chainChecks++;if(!verifyDecisionLogChainV1(monitor.decision_log).ok)chainBroken++;}
  segment.variant_errors=(monitor.variant_errors||[]).length;segment.optional_errors=(monitor.optional_errors||[]).length;
  if(!segment.first_fields)segment.first_fields=["strategy_meta","timing_null","comparisons","target_change_log","tactical_forward","shadow_evidence","v3_candidate","variants","variants_state","corrections","tranche_state"].filter(key=>monitor[key]!==undefined);
  if(processed%EVERY===0)console.error(`${processed} прогонов · ${snapshot.generated_at} · max|ΔNAV policy_v1| ${Math.abs(segment.nav.policy_v1?.v??0).toExponential(2)}`);
  previous=snapshot;
}

let lastSnapshot=null;
for await(const {commit,snapshot} of snapshots(selected)){
  if(!snapshot||snapshot.mock||!head(snapshot)||!snapshot.decision)continue;
  lastSnapshot=snapshot;
  if(!segment){open(snapshot,commit,"старт");continue;}
  const accepted=head(previous).log_hash,parent=head(snapshot).previous_log_hash,mine=head(snapshot).log_hash;
  // Потомки принятой головы ждут продолжения: при вилке (два прогона от одного состояния) выживает
  // тот, кого продолжил следующий снимок, — в каком бы порядке они ни были закоммичены.
  const continued=pending.find(x=>head(x.snapshot).log_hash===parent);
  if(continued){step(continued.snapshot,continued.commit);forks+=pending.length-1;pending=[{snapshot,commit}];}
  else if(parent===accepted){if(!pending.some(x=>head(x.snapshot).log_hash===mine))pending.push({snapshot,commit});}
  else if(mine===accepted||pending.some(x=>head(x.snapshot).log_hash===mine))continue;      // тот же прогон, перекоммичен
  else{if(pending.length)step(pending.at(-1).snapshot,pending.at(-1).commit);pending=[];open(snapshot,commit,"разрыв цепи в git");}
}
if(pending.length){forks+=pending.length-1;step(pending.at(-1).snapshot,pending.at(-1).commit);}

const chain=verifyDecisionLogChainV1(monitor.decision_log);
const report={repo_head:commits.at(-1).slice(0,10),selected:selected.length,processed,forks_resolved:forks,engine:ENGINE||"docs/policy-v3-candidate.mjs",series:RAW?"первоисточники":"карточки снимка",segments:segments.map(s=>({...s,nav_max_abs:Object.fromEntries(Object.entries(s.nav).map(([k,x])=>[k,Number(Math.abs(x.v).toExponential(2))])),nav:undefined,turnover_max_abs:Object.fromEntries(Object.entries(s.turnover).map(([k,x])=>[k,Number(Math.abs(x.v).toExponential(2))])),turnover:undefined})),final:{updated_at:monitor.updated_at,chain_ok:chain.ok,chain_issues:chain.issues.slice(0,3),chain_records:chain.records,chain_checks:chainChecks,strategies:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,[Number(v.nav.toFixed(9)),v.current_target_pct]])),variant_errors:(monitor.variant_errors||[]).length,optional_errors:(monitor.optional_errors||[]).length,variants_state_bytes:Buffer.byteLength(JSON.stringify(monitor.variants_state??null)),v3_candidate_bytes:Buffer.byteLength(JSON.stringify(monitor.v3_candidate??null)),log_record_bytes:Buffer.byteLength(JSON.stringify(monitor.decision_log.at(-1))),daily_row_bytes:Buffer.byteLength(JSON.stringify(monitor.daily.at(-2)??monitor.daily.at(-1))),monitoring_bytes:Buffer.byteLength(JSON.stringify(monitor)),published_monitoring_bytes:Buffer.byteLength(JSON.stringify(lastSnapshot.monitoring))}};
console.log(JSON.stringify(report,null,1));
if(OUT)writeFileSync(OUT,JSON.stringify(monitor));
const worst=Math.max(0,...segments.flatMap(s=>Object.values(s.nav).map(x=>Math.abs(x.v))));
const failed=!chain.ok||chainBroken>0||worst>1e-9||segments.some(s=>s.variant_errors||s.optional_errors)||segments.some(s=>s.target_mismatch||s.counter_mismatch||s.event_mismatch||s.daily_mismatch||s.v2_mismatch||s.hysteresis_mismatch||s.intraday_jitter||s.log_field_mismatch);
console.error(failed?"РАСХОЖДЕНИЯ ЕСТЬ":"Сверка пройдена: NAV прежних линий совпадает с опубликованным до 1e-9, цепь непрерывна, новые поля внутри суток не дрожат");
process.exitCode=failed?1:0;
