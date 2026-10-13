import { createHash } from "node:crypto";
import { evaluateActionGateV1 } from "../docs/action-gate-v1.mjs";
import { POLICY_V1, allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1, policySuiteContractV1 } from "../docs/policy-suite-v1.mjs";
import { POLICY_V2_CANDIDATE, allocationDecisionV2Candidate, evaluateAcceptanceV2, evaluateReviewV2, policyV2CandidateMetadata, riskOffConfirmationDeferredV2, updateV2ShadowState } from "../docs/policy-v2-candidate.mjs";
import { DAILY_INPUT_SUMMARY_DAYS, pruneDailyInputSummaryV1 } from "./public-snapshot-contract.mjs";
import { STRATEGY_REGISTRY_V1, applyMonitorBackfillV1 } from "./monitor-backfill-v1.mjs";
import { TARGET_CHANGE_LOG_LIMIT, targetChangeRecordV1, tickDiffFromInputSummariesV1 } from "./monitor-changes-v1.mjs";
import { shadowEvidenceV1, shadowRowValuesV1, tacticalForwardV1 } from "./monitor-evidence-v1.mjs";
import { TRANCHE_CONVENTION_V1, TRANCHED_LINE_V1, VARIANT_LINES_V1, acceptanceCriteriaV3, divergenceEpisodesV3, evaluateAcceptanceV3, policyV3CandidateMetadata, runShadowVariantsV1, updateTrancheStateV1, variantLedgerV1 } from "./monitor-lines-v1.mjs";
import { closeDrawdownPctV1, closedRowsV1, comparisonsV1, sharpeOfRowsV1, timingNullBlockV1 } from "./monitor-timing-v1.mjs";

const DAY=86_400_000,YEAR_DAYS=365.25;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const stdev=a=>{if(a.length<2)return null;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};

export function stableStringify(value){
  if(value===undefined)return "null";
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return`[${value.map(stableStringify).join(",")}]`;
  return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
export const sha256=value=>createHash("sha256").update(typeof value==="string"?value:stableStringify(value)).digest("hex");
export const policySuiteDigestV1=()=>sha256(policySuiteContractV1());

function normalizedTimestamp(value){
  if(typeof value==="number"&&Number.isFinite(value))return value<100_000_000_000?value*1000:value;
  const parsed=Date.parse(String(value??""));return Number.isFinite(parsed)?parsed:null;
}
function timedRowIndex(value,path="$",out=new Map()){
  if(Array.isArray(value)){
    for(const row of value){
      if(row&&typeof row==="object"&&!Array.isArray(row)){
        const timeKey=["t","time","date","timestamp","period"].find(k=>row[k]!==undefined),time=timeKey?normalizedTimestamp(row[timeKey]):null;
        if(time!==null){
          const identity=["id","venue","symbol","instrument","instrument_name","asset","name"].map(k=>row[k]).find(x=>x!==undefined&&x!==null)??"";
          out.set(`${path}|${time}|${identity}`,{time,sha256:sha256(row)});
        }else timedRowIndex(row,`${path}[]`,out);
      }
    }
  }else if(value&&typeof value==="object")for(const [key,child] of Object.entries(value))timedRowIndex(child,`${path}.${key}`,out);
  return out;
}

// Daily provider rows stamped at 00:00 UTC remain mutable until that UTC day closes.
// Treating their normal intraday updates as historical rewrites permanently degraded
// otherwise healthy live decisions. Rows before this boundary are immutable evidence;
// rows on/after it are the currently open partition and may evolve without an alert.
function openUtcDayStart(vintage){
  const reference=normalizedTimestamp(vintage?.fetched_at)??normalizedTimestamp(vintage?.observed_at);
  return reference===null?Infinity:Math.floor(reference/DAY)*DAY;
}

function timedRowDiff(previousData,currentData,mutableFrom=Infinity){
  const previousRows=timedRowIndex(previousData),currentRows=timedRowIndex(currentData);
  const changed=[],added=[],removed=[];
  for(const [rowKey,oldRow] of previousRows){
    if(oldRow.time>=mutableFrom)continue;
    const nextRow=currentRows.get(rowKey);
    if(!nextRow)removed.push(oldRow.time);
    else if(nextRow.sha256!==oldRow.sha256)changed.push(oldRow.time);
  }
  for(const [rowKey,nextRow] of currentRows)if(nextRow.time<mutableFrom&&!previousRows.has(rowKey))added.push(nextRow.time);
  return{has_timed_rows:previousRows.size>0||currentRows.size>0,changed,added,removed};
}

function revisionRange(times){
  const sorted=[...times].sort((a,b)=>a-b);
  return{first_changed_at:new Date(sorted[0]).toISOString(),last_changed_at:new Date(sorted.at(-1)).toISOString()};
}

function schemaShape(value,depth=0){
  if(value===null)return"null";
  if(Array.isArray(value))return{type:"array",item:value.length?schemaShape(value[0],depth+1):"empty"};
  if(typeof value!=="object"||depth>=3)return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,schemaShape(value[k],depth+1)]));
}

export function buildSourceVintagesV1(datasets={},sourceStates={}){
  const sources={};
  for(const key of [...new Set([...Object.keys(datasets),...Object.keys(sourceStates)])].sort()){
    const packet=datasets[key]||{},state=sourceStates[key]||{};
    sources[key]={
      state:state.state||"unknown",
      provider:packet.source||state.source||key,
      observed_at:packet.observed_at||state.observed_at||null,
      fetched_at:packet.fetched_at||state.fetched_at||null,
      data_sha256:packet.data===undefined?null:sha256(JSON.stringify(packet.data)),
      schema_sha256:packet.data===undefined?null:sha256(schemaShape(packet.data)),
      // Теневой (vote:false) источник помечается явно: его отказ и его ревизии — evidence, но не
      // деградация качества РЕШЕНИЯ, которое этот источник не читает.
      ...(state.decision_relevant===false?{decision_relevant:false}:{}),
    };
  }
  return{mode:"as_collected",captured_at:null,sources,contract_sha256:sha256(sources)};
}

export function sourceRevisionAlertsV1(previousVintages,currentVintages,previousDatasets={},currentDatasets={}){
  const alerts=[];
  for(const [key,current] of Object.entries(currentVintages?.sources||{})){
    const prior=previousVintages?.sources?.[key];
    if(!prior)continue;
    const dataChanged=current.data_sha256&&prior.data_sha256&&current.data_sha256!==prior.data_sha256;
    if(dataChanged&&current.observed_at&&prior.observed_at){
      const diff=timedRowDiff(previousDatasets?.[key]?.data,currentDatasets?.[key]?.data,openUtcDayStart(current));
      if(current.observed_at===prior.observed_at){
        const affected=[...diff.changed,...diff.added,...diff.removed];
        // Keep the legacy hash-only safeguard for scalar/non-temporal packets. For
        // time-series packets, alert only when an already closed row changed.
        if(!diff.has_timed_rows)alerts.push({source:key,type:"same_vintage_rewritten",quality_impact:"degraded",observed_at:current.observed_at,previous_data_sha256:prior.data_sha256,current_data_sha256:current.data_sha256});
        else if(affected.length)alerts.push({source:key,type:"same_vintage_rewritten",quality_impact:"audit",observed_at:current.observed_at,changed_rows:diff.changed.length,added_rows:diff.added.length,removed_rows:diff.removed.length,...revisionRange(affected),previous_data_sha256:prior.data_sha256,current_data_sha256:current.data_sha256});
      }else if(diff.changed.length){
        alerts.push({source:key,type:"historical_overlap_rewritten",quality_impact:"audit",changed_rows:diff.changed.length,...revisionRange(diff.changed),previous_data_sha256:prior.data_sha256,current_data_sha256:current.data_sha256});
      }
    }
    if(current.schema_sha256&&prior.schema_sha256&&current.schema_sha256!==prior.schema_sha256)
      alerts.push({source:key,type:"schema_changed",quality_impact:"degraded",previous_schema_sha256:prior.schema_sha256,current_schema_sha256:current.schema_sha256});
  }
  // Ревизии теневых источников остаются в журнале аудита, но не могут деградировать quality решения.
  return alerts.map(alert=>currentVintages?.sources?.[alert.source]?.decision_relevant===false?{...alert,quality_impact:"audit"}:alert);
}

// КАЧОК ИСТОЧНИКА (аудит 15 суток прода 2026-07-28). Провайдер, вернувшийся к УЖЕ ВИДЕННОМУ
// состоянию пакета (spot 24.07: котировки того же винтажа туда-обратно; blockchain_onchain 28.07:
// схема вернулась к прежней после восстановления), — это дребезг, а не пересмотр данных: текущий
// пакет ровно так же здоров, как был. Такие алерты понижаются до `audit` — остаются в журнале
// провенанса, но не переводят решение в `degraded`. Возврат к НОВОМУ, ранее не виденному значению
// качком не считается никогда. Окно памяти короткое (24 ч) сознательно: это вопрос «здоров ли
// пакет СЕЙЧАС», в отличие от 90-дневной памяти в уведомлениях, где вопрос другой — «новость ли
// это для читателя» (scripts/notify.mjs, rememberRevised). Ошибка в сторону сообщения о деградации.
const bounceKey=hash=>typeof hash==="string"?hash.slice(0,16):null;
export function applyRevisionBounceToleranceV1(alerts=[],{currentVintages,bounceState,now=Date.now(),ttlHours=24,keep=3}={}){
  const ttl=ttlHours*3_600_000,prior=bounceState&&typeof bounceState==="object"?bounceState:{};
  const fresh=key=>(Array.isArray(prior[key])?prior[key]:[]).filter(e=>Number.isFinite(Number(e?.at))&&now-Number(e.at)<=ttl);
  const next={};
  for(const [key,vintage] of Object.entries(currentVintages?.sources||{})){
    const history=fresh(key),d=bounceKey(vintage.data_sha256),s=bounceKey(vintage.schema_sha256),last=history.at(-1);
    if(!last||last.d!==d||last.s!==s)history.push({d,s,at:now});
    next[key]=history.slice(-keep);
  }
  const out=alerts.map(alert=>{
    if(!alert||alert.quality_impact==="audit")return alert;
    const vintage=currentVintages?.sources?.[alert.source];
    if(!vintage)return alert;
    // Сверяем с состоянием ДО этого прогона: прошлый винтаж — последняя запись, и он по условию
    // алерта отличается от текущего, поэтому совпадение может дать только более ранняя запись.
    const history=fresh(alert.source);
    const seen=alert.type==="schema_changed"
      ?history.some(e=>e.s&&e.s===bounceKey(vintage.schema_sha256))
      :history.some(e=>e.d&&e.d===bounceKey(vintage.data_sha256));
    return seen?{...alert,quality_impact:"audit",source_bounce:true}:alert;
  });
  return{alerts:out,bounceState:next};
}

export function treasuryBillDiscountToEffectiveAnnualPct(discountPct,days=91){
  if(!finite(discountPct)||!finite(days)||Number(days)<=0)return null;
  const discount=Number(discountPct)/100,term=Number(days),price=1-discount*term/360;
  if(price<=0)return null;
  return ((1/price)**(YEAR_DAYS/term)-1)*100;
}

export function compactDecisionInputsV1({metrics=[],blocks={},detectors=[],scores={},sourceVintages}){
  const keyMetrics=metrics.filter(x=>x.vote||["mvrv_cycle","stablecoin_peg","spot_integrity","funding"].includes(x.id)).map(x=>({
    id:x.id,score:finite(x.score)?Number(x.score):null,value_num:finite(x.value_num)?Number(x.value_num):null,
    observed_at:x.observed_at||null,stale:!!x.stale,source:x.source||null,
  }));
  const compactBlocks=Object.fromEntries(Object.entries(blocks).map(([k,b])=>[k,{
    strategic_score:finite(b?.strategic?.score)?Number(b.strategic.score):null,strategic_coverage:finite(b?.strategic?.coverage)?Number(b.strategic.coverage):null,
    tactical_score:finite(b?.tactical?.score)?Number(b.tactical.score):null,tactical_coverage:finite(b?.tactical?.coverage)?Number(b.tactical.coverage):null,
  }]));
  return{
    scores:{strategic:finite(scores.strategic)?Number(scores.strategic):null,tactical:finite(scores.tactical)?Number(scores.tactical):null,critical_coverage_ok:!!scores.critical_coverage_ok},
    blocks:compactBlocks,detectors:detectors.map(x=>({id:x.id,state:x.state})),metrics:keyMetrics,
    source_vintages_sha256:sourceVintages?.contract_sha256||null,
  };
}

function ledgerInputs(input){
  return{
    schema:1,
    scores:[input.scores.strategic,input.scores.tactical,input.scores.critical_coverage_ok],
    blocks:Object.entries(input.blocks).map(([id,b])=>[id,b.strategic_score,b.strategic_coverage,b.tactical_score,b.tactical_coverage]),
    detectors:input.detectors.map(x=>[x.id,x.state]),
    metrics:input.metrics.map(x=>[x.id,x.score,x.value_num,x.observed_at,x.stale,x.source]),
    source_vintages_sha256:input.source_vintages_sha256,
  };
}

export function buildDecisionRecordV1({generatedAt,regime,regimeMeta,metrics,blocks,detectors,scores,sourceVintages,revisionAlerts=[]}){
  const recoveryState=detectors.find(x=>x.id==="recovery")?.state||"calm";
  const macroShockState=detectors.find(x=>x.id==="macro_shock")?.state||"calm";
  const mvrv=metrics.find(x=>x.id==="mvrv_cycle")?.value_num;
  const allocation=allocationDecisionV1({strategic:regime.strategic,recoveryState,macroShockState,mvrvPercentile:finite(mvrv)?Number(mvrv):null});
  const regimeTargets=Object.fromEntries(["emergency","defensive","deteriorating","transition","unconfirmed_positive","constructive"].map(strategic=>[
    strategic,
    allocationDecisionV1({strategic,recoveryState,macroShockState,mvrvPercentile:finite(mvrv)?Number(mvrv):null}).target_pct,
  ]));
  const inputSummary=compactDecisionInputsV1({metrics,blocks,detectors,scores,sourceVintages});
  // JSON-нормализация ДО хэширования: stabilizeCore возвращает ключ hold_until со значением
  // undefined, stableStringify сериализовал его как null, а публикация ключ выбрасывала — внешний
  // аудитор не мог воспроизвести input_hash из опубликованного снимка. Хэшируем ровно ту форму,
  // которая публикуется. (Хэши до 2026-07-21 считались по старой схеме — см. README.)
  const inputPayload=JSON.parse(JSON.stringify({generated_at:generatedAt,regime,regime_meta:regimeMeta,allocation_inputs:allocation.inputs,input_summary:inputSummary}));
  const inputHash=sha256(inputPayload),policyHash=policySuiteDigestV1();
  // Теневые источники (decision_relevant:false) решением не читаются — их деградация не имеет
  // права переводить quality в degraded: это плата за право экспериментировать с новыми данными,
  // не размывая сигнал качества решающего контура.
  const staleSources=Object.values(sourceVintages?.sources||{}).filter(x=>["stale","partial","fail"].includes(x.state)&&x.decision_relevant!==false).length;
  // Historical time-series restatements are provenance evidence, not a failure of
  // the currently evaluated packet. They remain in the append-only audit log.
  // Schema changes and non-temporal same-vintage rewrites still lower quality;
  // unknown/legacy alert types fail conservatively as quality-affecting.
  const qualityAffectingRevisions=revisionAlerts.filter(x=>x?.quality_impact!=="audit").length;
  const auditRevisions=revisionAlerts.length-qualityAffectingRevisions;
  const quality=!scores.critical_coverage_ok||allocation.status==="paused"?"paused":staleSources||qualityAffectingRevisions?"degraded":"good";
  const statePayload={policy_hash:policyHash,status:allocation.status,strategic:regime.strategic,tactical:regime.tactical,base_target_pct:allocation.base_target_pct,target_pct:allocation.target_pct,binding_overlays:allocation.binding_overlays};
  const stateHash=sha256(statePayload);
  const decision={
    schema:1,decided_at:generatedAt,policy_id:POLICY_SUITE_V1.id,policy_hash:policyHash,input_hash:inputHash,state_hash:stateHash,
    status:allocation.status,strategic:regime.strategic,tactical:regime.tactical,base_target_pct:allocation.base_target_pct,target_pct:allocation.target_pct,
    regime_targets_pct:regimeTargets,binding_overlays:allocation.binding_overlays,reason_codes:allocation.reason_codes,inputs:allocation.inputs,
    quality:{status:quality,critical_coverage_ok:!!scores.critical_coverage_ok,stale_or_partial_sources:staleSources,revision_alerts:revisionAlerts.length,quality_affecting_revision_alerts:qualityAffectingRevisions,audit_revision_alerts:auditRevisions},
  };
  decision.decision_hash=sha256(decision);
  return{decision,inputSummary};
}

export function previousPolicyTargetV1({strategic,recoveryState,macroShockState,mvrvPercentile}){
  if(strategic==="insufficient")return null;
  const p=MODEL_POLICY_V1.forward_monitoring.previous_policy_shadow;
  let target=p.ladder[strategic];
  if(!finite(target))return null;
  // v0 задокументирован в замороженном архиве как «оверлеи не применяются в emergency/insufficient»
  // (backtest/patch6.py). Без раннего выхода shadow-бенчмарк держал бы 40–70% на дне кризиса
  // (emergency + MVRV≤10 — типичное сочетание) и искажал бы сравнение v1 против v0 там, где оно важнее всего.
  if(strategic==="emergency")return Number(target);
  if(recoveryState==="good"&&macroShockState!==p.recovery_blocked_by_macro_shock_state&&target<p.recovery_floor_pct)target=p.recovery_floor_pct;
  if(finite(mvrvPercentile)&&Number(mvrvPercentile)<=p.capitulation_max_mvrv_percentile&&target<p.capitulation_floor_pct)target=p.capitulation_floor_pct;
  if(finite(mvrvPercentile)&&Number(mvrvPercentile)>=p.euphoria_min_mvrv_percentile&&target>p.euphoria_cap_pct)target=p.euphoria_cap_pct;
  return target;
}

function simpleTargets(priceSeries=[]){
  const closes=priceSeries.map(x=>Number(x.v)).filter(x=>finite(x)&&x>0),price=closes.at(-1),sma200=closes.length>=200?mean(closes.slice(-200)):null;
  const logs=[];for(let i=Math.max(1,closes.length-60);i<closes.length;i++)if(closes[i-1]>0)logs.push(Math.log(closes[i]/closes[i-1]));
  const vol=logs.length>=30&&stdev(logs)?stdev(logs)*Math.sqrt(365)*100:null;
  const trendVol=finite(price)&&finite(sma200)&&finite(vol)&&price>=sma200?clamp(25/Number(vol)*100,0,100):0;
  return{buy_and_hold:100,fixed_50:50,cash:0,trend_vol_25:trendVol,trend_vol_context:{price,sma200,vol60_annualized_pct:vol}};
}

// Sharpe и волатильность — по ЗАКРЫТЫМ суткам (аудит 2026-10-10, 2.5): текущая дневная строка
// перезаписывается каждый прогон, а её неполный шаг (до 0,4 суток) поднимался до целых суток —
// Sharpe policy_v1 показывался 0,259 вместо 0,225 и менялся внутри дня. Формула — excessSharpeV2:
// избыточная доходность в числителе и знаменателе, годовая шкала по фактическому среднему шагу,
// тождественно нулевой excess даёт 0, а не пробел (иначе −Infinity в evaluateHealth и ложный
// investigate ровно в кризисном режиме).
function strategyStats(strategy,closedDaily,name){
  const stats=sharpeOfRowsV1(closedDaily,name);
  return{
    nav:Number(strategy.nav),net_return_pct:(Number(strategy.nav)-1)*100,max_drawdown_pct:Number(strategy.max_drawdown_pct||0),
    annualized_volatility_pct:stats.annualized_volatility_pct,
    sharpe_excess:stats.sharpe_excess,
    turnover_pct:Number(strategy.turnover_pct||0),transaction_cost_pct:Number(strategy.transaction_cost_pct||0),current_target_pct:Number(strategy.current_target_pct),
  };
}

function operationalIssuesV1(decision){
  const issues=[];
  if(decision.policy_hash!==POLICY_SUITE_V1.contract_sha256)issues.push("policy_hash_mismatch");
  if(decision.status==="actionable"&&!finite(decision.target_pct))issues.push("missing_target_for_actionable_regime");
  if(decision.quality?.status==="paused")issues.push("decision_paused");
  return issues;
}

// Проходит ли решение этого прогона гейт витрины (docs/action-gate-v1.mjs) в момент публикации.
// Монитор исполняет цель, только если панель её показывает: при паузе решения — в том числе из-за
// одного тактического покрытия, когда среднесрочная цель конечна и может меняться, — витрина цель
// скрывает, и читатель ничего не делает. Раньше монитор продолжал её исполнять, и NAV отражал бы
// действия, которых панель не показывала (аудит 2026-10-10, 2.6; на окне пауз не было).
export function decisionGateV1(decision,now){
  const cfg=MODEL_POLICY_V1.forward_monitoring;
  return evaluateActionGateV1({generatedAt:new Date(now).toISOString(),now,staleLimitHours:cfg.operational_pause.snapshot_stale_hours,decision,operationalStatus:operationalIssuesV1(decision).length?"paused":"healthy"});
}

function evaluateHealth(monitor,decision){
  const cfg=MODEL_POLICY_V1.forward_monitoring,days=monitor.days_elapsed,changes=monitor.target_changes;
  const operationalIssues=operationalIssuesV1(decision);
  let performanceStatus="collecting",performanceReasons=[];
  const p=monitor.performance?.policy_v1,fixed=monitor.performance?.fixed_50;
  // POLICY.md перечисляет простые бенчмарки как buy & hold / fixed 50% / cash / trend. Excess-Sharpe
  // самого cash тождественно равен нулю (excess против самого себя) — участвует он именно нулём:
  // в медвежьем окне, где рисковые бенчмарки отрицательны, планку best-simple задаёт cash с 0.
  const simple=["buy_and_hold","fixed_50","cash","trend_vol_25"].filter(k=>monitor.performance?.[k]).map(k=>[k,finite(monitor.performance[k].sharpe_excess)?Number(monitor.performance[k].sharpe_excess):-Infinity]),bestSharpe=Math.max(...simple.map(x=>x[1]));
  // Недоступный Sharpe политики — «сравнение невозможно», а не -Infinity: coercion давал
  // sharpeGap=+Infinity и ложный investigate/retire-триггер. Ветка returnGap работает сама.
  const comparable=Boolean(p&&fixed&&Number.isFinite(bestSharpe));
  const sharpeGap=comparable&&finite(p.sharpe_excess)?bestSharpe-Number(p.sharpe_excess):-Infinity,returnGap=p&&fixed?Number(fixed.net_return_pct)-Number(p.net_return_pct):null,ddWorse=p&&fixed?Math.abs(Number(p.max_drawdown_pct))-Math.abs(Number(fixed.max_drawdown_pct)):null;
  const investigationMet=comparable&&(sharpeGap>=cfg.investigation_rules.sharpe_gap_vs_best_simple_benchmark||returnGap>=cfg.investigation_rules.net_return_gap_vs_fixed_50_pct_points);
  const retirementMet=comparable&&sharpeGap>=cfg.retirement_requires_all.sharpe_gap_vs_best_simple_benchmark&&ddWorse>=cfg.retirement_requires_all.max_drawdown_worse_than_fixed_50_pct_points&&returnGap>=cfg.retirement_requires_all.net_return_gap_vs_fixed_50_pct_points;
  if(days>=180&&comparable){
    if(investigationMet){performanceStatus="investigate";performanceReasons.push("forward_underperformance_threshold");}
    if(days>=cfg.minimum_retirement_days&&changes>=cfg.minimum_target_changes&&retirementMet){performanceStatus="retire_candidate";performanceReasons=["all_predeclared_retirement_conditions_met"];}
    else if(performanceStatus==="collecting"&&days>=365)performanceStatus="first_meaningful_review";
    else if(performanceStatus==="collecting")performanceStatus="preliminary";
  }else if(days>=90)performanceStatus="operational_only";
  // Числа против порогов — рядом со статусом и с первого дня. Сам статус правила «расследование»
  // зашит в замороженный контракт v1 и вычисляется как был, но на реконструкции 2014–2026 он
  // срабатывает на исправной политике в 54–61 % запусков и на «всегда 100 %» — в 46–54 %: код
  // статуса ничего не говорит о политике, разрывы и пороги — говорят.
  const round=x=>Number.isFinite(x)?Number(x.toFixed(4))+0:null;
  const performanceNumbers={
    days_elapsed:days,target_changes:changes,
    best_simple_benchmark:comparable?simple.find(x=>x[1]===bestSharpe)?.[0]??null:null,
    sharpe_gap_vs_best_simple_benchmark:round(sharpeGap),
    net_return_gap_vs_fixed_50_pct_points:round(returnGap),
    max_drawdown_worse_than_fixed_50_pct_points:round(ddWorse),
    thresholds:{investigation:{min_days:180,...cfg.investigation_rules},retirement:{min_days:cfg.minimum_retirement_days,min_target_changes:cfg.minimum_target_changes,...cfg.retirement_requires_all}},
    investigation_numbers_met:comparable?!!investigationMet:null,retirement_numbers_met:comparable?!!retirementMet:null,
  };
  return{operational_status:operationalIssues.length?"paused":"healthy",operational_issues:operationalIssues,performance_status:performanceStatus,performance_reasons:performanceReasons,performance_numbers:performanceNumbers,automatic_recalibration:false,owner_approval_required_for_policy_v2:true};
}

// Полный обход hash-цепи журнала решений. Валидатор последней записи ловит только свежую порчу;
// переписывание/усечение прошлого он пропускает — append-only обязан проверяться по всей цепи.
export function verifyDecisionLogChainV1(log){
  const issues=[];
  if(!Array.isArray(log)||!log.length)return{ok:false,issues:["decision_log_empty"],records:0};
  let prior=null;
  log.forEach((record,index)=>{
    const copy={...record};delete copy.log_hash;
    if(record.log_hash!==sha256(copy))issues.push(`log_hash_mismatch:${index}:${record.t||"?"}`);
    // После усечения retained-окна первая запись легитимно ссылается на вытесненную; null допустим
    // только у настоящего генезиса. Различить их из самого лога нельзя, поэтому для первой записи
    // проверяется лишь СООТВЕТСТВИЕ типу (строка-хэш или null), для остальных — точная связность.
    if(index===0&&record.previous_log_hash!==null&&!/^[0-9a-f]{64}$/.test(String(record.previous_log_hash)))issues.push(`chain_root_invalid:${record.t||"?"}`);
    if(index>0&&record.previous_log_hash!==prior)issues.push(`chain_link_broken:${index}:${record.t||"?"}`);
    prior=record.log_hash;
  });
  return{ok:issues.length===0,issues,records:log.length};
}

// Одноразовый графт: склейка живой цепи монитора с доинцидентным архивом (см. docs/monitor-graft-v1.json).
// Молчаливый генезис 2026-07-21 уничтожил 58-записный журнал; архив криптографически провалидирован,
// а непрерывность NAV достигается мостом через разрыв по ПРЕЖНИМ целям и вычетом повторной цены входа
// новой эры. Перечейненные записи хранят original_log_hash — рестейтмент явный, а не молчаливый.
// Функция чистая и идемпотентная: на непрерывной или уже склеенной цепи возвращает вход без изменений.
export function graftForwardMonitorV1(liveMonitor,pack){
  if(!pack?.archive?.monitor?.decision_log?.length)return liveMonitor??null;
  // Битый пакет (archive без era) не имеет права ронять сборщик — это тот же класс дедлока
  // публикации, который этот релиз чинит. Fail open: пропуск без склейки.
  if(!pack.era?.started_at||!pack.era?.strategies)return liveMonitor??null;
  const archive=pack.archive.monitor;
  if(!liveMonitor||liveMonitor.schema!==1)return structuredClone(archive);
  if(!(Date.parse(liveMonitor.started_at)>Date.parse(archive.started_at)))return liveMonitor;
  if(pack.era?.started_at&&liveMonitor.started_at!==pack.era.started_at){
    // Чужой генезис (ещё один сброс после подготовки пакета): слепая склейка исказила бы NAV.
    if(liveMonitor.graft_skipped)return liveMonitor;
    const skipped=structuredClone(liveMonitor);
    skipped.graft_skipped={reason:"unexpected_genesis",expected:pack.era.started_at,found:liveMonitor.started_at};
    return skipped;
  }
  const cfg=MODEL_POLICY_V1.forward_monitoring,costRate=cfg.transaction_cost_bps_per_full_turnover/10_000;
  const merged=structuredClone(archive),live=structuredClone(liveMonitor);
  const gapDt=Math.max(0,Date.parse(pack.era.started_at)-Date.parse(archive.last_at));
  const btcReturn=Number(archive.last_price)>0&&Number(pack.era.price)>0?Number(pack.era.price)/Number(archive.last_price)-1:0;
  const cashEffective=treasuryBillDiscountToEffectiveAnnualPct(archive.last_cash_quote_pct);
  const cashReturn=(1+(Number.isFinite(cashEffective)?cashEffective:0)/100)**(gapDt/(YEAR_DAYS*DAY))-1;
  const scale={};
  for(const [name,liveStrategy] of Object.entries(live.strategies||{})){
    const base=merged.strategies[name],boot=pack.era.strategies?.[name];
    if(!base||!boot){merged.strategies[name]=liveStrategy;scale[name]=1;continue;}
    const baseTarget=Number(base.current_target_pct),bootTarget=Number(boot.initial_target_pct);
    const bridged=Number(base.nav)*(1+baseTarget/100*btcReturn+(1-baseTarget/100)*cashReturn);
    const switchTurnover=Math.abs(bootTarget-baseTarget),switchCost=switchTurnover/100*costRate;
    const bootNav=Number(boot.initial_nav)>0?Number(boot.initial_nav):1;
    const factor=bridged*(1-switchCost)/bootNav;
    scale[name]=factor;
    const nav=Number(liveStrategy.nav)*factor;
    // Пик и просадка после склейки: пики архива учтены его же peak_nav, дальше — по дневным точкам
    // новой эры и текущему NAV (внутричасовые экстремумы разрыва не наблюдались — задокументировано в пакете).
    let peak=Math.max(Number(base.peak_nav)||1,bridged),dd=Math.min(Number(base.max_drawdown_pct)||0,Number(liveStrategy.max_drawdown_pct)||0);
    for(const point of [...(live.daily||[]).map(row=>Number(row.nav?.[name])*factor),nav]){
      if(!Number.isFinite(point))continue;
      peak=Math.max(peak,point);dd=Math.min(dd,(point/peak-1)*100);
    }
    // Внутридневной пик живой эры есть в её состоянии и обязан пережить склейку: без него пик
    // оставался занижен, пока NAV не обновит максимум, и просадка в этом промежутке мерилась от
    // неверной вершины (графт 21.07.2026: −3,657 % вместо −3,708 %, аудит 2026-10-10, 1.2).
    // Берётся ПОСЛЕ прохода по дневным точкам: более ранние точки нельзя мерить от будущего пика.
    if(Number.isFinite(Number(liveStrategy.peak_nav)))peak=Math.max(peak,Number(liveStrategy.peak_nav)*factor);
    merged.strategies[name]={
      nav,peak_nav:peak,max_drawdown_pct:dd,
      turnover_pct:(Number(base.turnover_pct)||0)+switchTurnover+Math.max(0,(Number(liveStrategy.turnover_pct)||0)-(Number(boot.initial_turnover_pct)||0)),
      transaction_cost_pct:(Number(base.transaction_cost_pct)||0)+switchCost*100+Math.max(0,(Number(liveStrategy.transaction_cost_pct)||0)-(Number(boot.initial_cost_pct)||0)),
      current_target_pct:Number(liveStrategy.current_target_pct),
    };
  }
  let priorHash=merged.decision_log.at(-1)?.log_hash||null;
  const rechained=(live.decision_log||[]).map((record,index)=>{
    const entry={...record,original_log_hash:record.log_hash,previous_log_hash:priorHash};
    if(index===0)entry.graft={reason:pack.reason,invalid_window:pack.invalid_window,orphaned_genesis_log_hashes:pack.orphaned_genesis_log_hashes};
    delete entry.log_hash;
    entry.log_hash=sha256(entry);
    priorHash=entry.log_hash;
    return entry;
  });
  merged.decision_log=[...merged.decision_log,...rechained].slice(-cfg.observation_log_limit);
  const lastEvent=merged.decision_events.at(-1),liveEvents=live.decision_events||[];
  const duplicateFirstEvent=Boolean(liveEvents.length&&lastEvent&&liveEvents[0].state_hash===lastEvent.state_hash);
  merged.decision_events=[...merged.decision_events,...liveEvents.slice(duplicateFirstEvent?1:0)].slice(-cfg.decision_event_limit);
  merged.state_changes=(Number(merged.state_changes)||0)+(Number(live.state_changes)||0)+(liveEvents.length&&!duplicateFirstEvent?1:0);
  merged.target_changes=(Number(merged.target_changes)||0)+(Number(live.target_changes)||0)+(liveEvents.length&&!duplicateFirstEvent&&lastEvent&&liveEvents[0].target_pct!==lastEvent.target_pct?1:0);
  const liveDates=new Set((live.daily||[]).map(row=>row.date));
  // Путь политики в строках живой эры (`path`) посчитан в её шкале и от её генезиса — после склейки
  // он неверен; он отбрасывается, и засев пересчитывает его из полного списка событий.
  const scaledDaily=(live.daily||[]).map(({path,...row})=>({...row,nav:Object.fromEntries(Object.entries(row.nav||{}).map(([name,value])=>[name,Number(value)*(scale[name]??1)]))}));
  merged.daily=[...merged.daily.filter(row=>!liveDates.has(row.date)),...scaledDaily].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  merged.updated_at=live.updated_at;merged.last_at=live.last_at;merged.last_price=live.last_price;
  merged.last_cash_quote_pct=live.last_cash_quote_pct;merged.last_cash_quote_basis=live.last_cash_quote_basis;
  merged.counter_semantics_version=2;
  merged.revision_alerts=[...(merged.revision_alerts||[]),...(live.revision_alerts||[])].slice(-100);
  merged.reset_events=[...(merged.reset_events||[]),...(live.reset_events||[])].slice(-10);
  // Состояние тени v2 живёт у ЖИВОЙ линии (архив 5165340 его не знает): без переноса графт молча
  // обнулял бы идущую градуировку пола и стрики ревью — потеря acceptance-evidence (ревью 2026-07-22).
  for(const key of ["v2_shadow_state","v2_theta","v2_review","v2_candidate","variants_state","variant_errors","v3_candidate","variants","tranche_state"])if(live[key]!==undefined)merged[key]=live[key];
  // Старты линий: у линий архива — архивные; у рождённых в живой эре опорные числа policy_v1 и
  // кэша переводятся в склеенную шкалу, путь policy_v1 на момент их рождения пересчитает засев.
  if(live.strategy_meta||merged.strategy_meta){
    const liveOnly=Object.entries(live.strategy_meta||{}).filter(([name])=>!merged.strategy_meta?.[name]).map(([name,meta])=>[name,meta.base?{...meta,base:{cash_nav:Number.isFinite(Number(meta.base.cash_nav))?Number(meta.base.cash_nav)*(scale.cash??1):null,policy_v1_nav:Number.isFinite(Number(meta.base.policy_v1_nav))?Number(meta.base.policy_v1_nav)*(scale.policy_v1??1):null,policy_v1_target_pct:meta.base.policy_v1_target_pct??null}}:meta]);
    merged.strategy_meta={...(merged.strategy_meta||{}),...Object.fromEntries(liveOnly)};
  }
  // Журнал смен цели: если архив его ведёт — продолжается записями живой эры; если нет — засев
  // соберёт его заново из полного списка событий.
  if(Array.isArray(merged.target_change_log))merged.target_change_log=[...merged.target_change_log,...(live.target_change_log||[]).filter(x=>x.kind!=="start")];
  merged.graft={applied_at:live.updated_at,reason:pack.reason,invalid_window:pack.invalid_window,orphaned_genesis_log_hashes:pack.orphaned_genesis_log_hashes,archive_source_commit:pack.archive.source_commit||null};
  return merged;
}

// Порядок среднесрочных режимов от худшего к лучшему — из замороженного контракта v1. «Настоящий»
// режим — не аварийный и не «недостаточно данных»: их смена подтверждений не требует.
const strategicRank=state=>POLICY_V1.strategic_order.indexOf(state);
const realRegime=state=>strategicRank(state)>0;

// Новые параметры (все необязательные; вызов без них работает как в 2.13.0):
//  variantInputs — входы движка вариантов (null — движок не вызывается, линии держат прежнюю цель);
//  shadowValues — value_num восьми теневых карточек; regimeBirth, tickDiff — причины для журнала смен цели;
//  variantEngine — подмена движка вариантов в тестах.
export function updateForwardMonitorV1({previousMonitor,now,price,decision,inputSummary,sourceVintages,revisionAlerts=[],cashQuotePct=null,cashQuoteBasis="treasury_bill_discount",priceSeries=[],previousSnapshotPresent=false,regimeMeta=null,shadowHysteresis=null,v2Inputs=null,variantInputs=null,shadowValues=null,regimeBirth=null,tickDiff=null,variantEngine=undefined}){
  if(!finite(price)||Number(price)<=0)throw new Error("forward monitor requires a positive price");
  const cfg=MODEL_POLICY_V1.forward_monitoring,at=new Date(now).toISOString(),date=at.slice(0,10),simple=simpleTargets(priceSeries);
  const costRate=cfg.transaction_cost_bps_per_full_turnover/10_000;
  const monitor=previousMonitor?.schema===1?structuredClone(previousMonitor):{
    schema:1,id:cfg.id,started_at:at,updated_at:at,last_price:Number(price),last_at:at,last_cash_quote_pct:finite(cashQuotePct)?Number(cashQuotePct):null,last_cash_quote_basis:cashQuoteBasis,
    strategies:{},daily:[],decision_events:[],decision_log:[],counter_semantics_version:2,state_changes:0,target_changes:0,revision_alerts:[],strategy_meta:{},target_change_log:[],assumptions:{transaction_cost_bps_per_full_turnover:cfg.transaction_cost_bps_per_full_turnover,cash_yield_source:"FRED DTB3, discount basis converted to effective annual yield (91-day convention)",cash_yield_basis:"3-month Treasury bill discount quote; ACT/360 price conversion, effective ACT/365.25 annualization",timezone:cfg.timezone,observation_mode:cfg.observation_mode},
  };
  // Генезис при живом предыдущем снимке = потеря состояния монитора (инцидент 2026-07-21: молчаливый
  // сброс уничтожил 58-записный журнал). Сброс обязан оставлять СЛЕД в самом мониторе; внешний
  // сторож дополнительно ловит регресс started_at против HEAD репозитория.
  if(previousMonitor?.schema!==1&&previousSnapshotPresent)
    monitor.reset_events=[...(previousMonitor?.reset_events||[]),{t:at,reason:"previous_snapshot_without_monitoring"}].slice(-10);
  // Всё, что добавлено к учёту NAV и журналу решений (сравнения, честный ноль, журнал смен цели,
  // теневые линии, форвард-счёт), — необязательные расчёты: их отказ не имеет права остановить сбор
  // или тронуть решение. Отказ оставляет след в monitoring.optional_errors, расчёт даёт запасное значение.
  const optional=(part,compute,fallback)=>{
    try{return compute();}
    catch(error){monitor.optional_errors=[...(monitor.optional_errors||[]),{t:at,part,error:String(error?.message||error).slice(0,200)}].slice(-20);return fallback;}
  };
  // РАЗРЫВ УЧЁТА. Если предыдущий прогон выполнила прежняя версия (откат релиза), путь политики и
  // новые линии в нём не велись: их NAV простоял бы интервал без доходности, и сравнение с v1 было
  // бы испорчено молча. Признак — отметка учёта не равна времени последнего прогона. Тогда путь
  // политики отбрасывается (засев пересчитает его из событий), а новые линии рождаются заново с
  // записью о перезапуске: короткая честная история лучше длинной с дырой.
  if(previousMonitor?.schema===1&&monitor.accounting_at!==undefined&&monitor.accounting_at!==monitor.last_at)optional("accounting_gap",()=>{
    const restarted=[...VARIANT_LINES_V1,TRANCHED_LINE_V1].filter(name=>monitor.strategies[name]);
    for(const name of restarted){delete monitor.strategies[name];delete monitor.strategy_meta?.[name];for(const row of monitor.daily||[]){delete row.targets?.[name];delete row.nav?.[name];}}
    delete monitor.tranche_state;
    if(monitor.strategies.policy_v1){delete monitor.strategies.policy_v1.gross_nav;delete monitor.strategies.policy_v1.exposure_pct_days;}
    for(const meta of Object.values(monitor.strategy_meta||{}))if(meta.base){delete meta.base.policy_v1_gross;delete meta.base.policy_v1_w_days;}
    monitor.line_restarts=[...(monitor.line_restarts||[]),{t:at,reason:"run_without_line_accounting",accounted_until:monitor.accounting_at,last_run:monitor.last_at,lines:restarted}].slice(-10);
  });
  // Состояние прежней версии досевается на лету: старты линий, путь доли политики, журнал смен
  // цели, краткосрочное состояние в дневных строках (scripts/monitor-backfill-v1.mjs). Засев идемпотентен.
  if(previousMonitor?.schema===1)optional("backfill",()=>applyMonitorBackfillV1(monitor,{at,costRate}));
  monitor.strategy_meta=monitor.strategy_meta||{};
  const previousEntry=(monitor.decision_log||[]).at(-1)||null,previousRow=(monitor.daily||[]).at(-1)||null;
  // Цель исполняется, только если решение проходит гейт витрины: иначе все линии, выведенные из
  // решения, держат прежнюю долю (см. decisionGateV1). Простых ориентиров гейт не касается.
  const gate=decisionGateV1(decision,now),gateOpen=gate.actionable,shown=target=>gateOpen?target:null;
  // ТЕНЕВОЙ КАНДИДАТ v2 (см. docs/policy-v2-candidate.mjs): вычисляется параллельно, живое
  // решение НЕ трогает. Градуировка пола считается по дневным закрытиям UTC из переносимого
  // состояния. static_theta — прежний нуль R2: до 90-го дня скользящее среднее целей политики (то
  // есть её запаздывающая копия), с 90-го дня фиксируется и перефиксируется на ревью-границах.
  // Линия остаётся как история; R2 с ревизии 2 сравнивает политику с честным нулём на своём окне
  // (monitoring.timing_null). Цель округляется до 0.1пп: микрообороты от дрожащего среднего —
  // фиктивные издержки и лишние байты в каждой daily-строке.
  monitor.v2_shadow_state=updateV2ShadowState(monitor.v2_shadow_state,now,decision.inputs?.recovery_state==="good");
  const v2Decision=allocationDecisionV2Candidate({strategic:decision.strategic,recoveryState:decision.inputs?.recovery_state,macroShockState:decision.inputs?.macro_shock_state,mvrvPercentile:decision.inputs?.mvrv_percentile,mvrvPercentileDeep:v2Inputs?.mvrv_percentile_deep??null,recoveryCloses:monitor.v2_shadow_state.closes}),v2Target=v2Decision.target_pct;
  const daysElapsedNow=Math.max(0,Math.floor((now-Date.parse(monitor.started_at))/DAY));
  const trailingTheta=()=>{const rows=(monitor.daily||[]).slice(-370).map(x=>Number(x.targets?.policy_v1)).filter(finite);return rows.length?Math.round(mean(rows)*10)/10:(finite(decision.target_pct)?Number(decision.target_pct):0);};
  const thetaState=monitor.v2_theta&&typeof monitor.v2_theta==="object"?monitor.v2_theta:{pct:null,fixed_at_day:null};
  const reviewBoundaries=[...(cfg.review_days||[90,180,365])];
  const dueBoundary=reviewBoundaries.filter(d=>daysElapsedNow>=d).at(-1)??null;
  if(dueBoundary!==null&&(thetaState.fixed_at_day===null||dueBoundary>thetaState.fixed_at_day)){thetaState.pct=trailingTheta();thetaState.fixed_at_day=dueBoundary;}
  monitor.v2_theta=thetaState;
  // ТЕНЕВЫЕ ЛИНИИ v3 (scripts/monitor-lines-v1.mjs): цели даёт движок вариантов; отказ движка —
  // запись в variant_errors, линии держат прежнюю цель, решение и его качество не затронуты.
  const variantRun=runShadowVariantsV1({...(variantEngine?{engine:variantEngine}:{}),now,inputs:variantInputs,state:monitor.variants_state});
  if(variantRun.ran){
    monitor.variants_state=variantRun.state;
    if(variantRun.error)monitor.variant_errors=[...(monitor.variant_errors||[]),{t:at,error:variantRun.error}].slice(-10);
  }
  // Исполнение по правилу панели: понижения сразу, повышения траншами (соглашение — в assumptions).
  const tranchedLine=monitor.strategies[TRANCHED_LINE_V1];let tranchedTarget=null;
  if(gateOpen&&finite(decision.target_pct))optional("tranched_execution",()=>{
    const step=updateTrancheStateV1(monitor.tranche_state,{now,target:clamp(Number(decision.target_pct),0,100),position:tranchedLine?tranchedLine.current_target_pct:null});
    monitor.tranche_state=step.state;tranchedTarget=step.position;
  });
  const desired={
    policy_v1:shown(decision.target_pct),
    previous_policy_shadow:shown(previousPolicyTargetV1({strategic:decision.strategic,recoveryState:decision.inputs.recovery_state,macroShockState:decision.inputs.macro_shock_state,mvrvPercentile:decision.inputs.mvrv_percentile})),
    buy_and_hold:simple.buy_and_hold,fixed_50:simple.fixed_50,cash:simple.cash,trend_vol_25:simple.trend_vol_25,
    policy_v2_shadow:shown(v2Target),
    static_theta:finite(thetaState.pct)?thetaState.pct:trailingTheta(),
  };
  // Линия рождается, когда у неё появляется собственная цель: с NAV = 1 и записью старта.
  for(const name of VARIANT_LINES_V1){const target=shown(variantRun.targets[name]);if(finite(target)||monitor.strategies[name])desired[name]=target;}
  if(finite(tranchedTarget)||tranchedLine)desired[TRANCHED_LINE_V1]=tranchedTarget;
  const priorPrice=Number(monitor.last_price),dt=Math.max(0,now-Date.parse(monitor.last_at||at)),btcReturn=priorPrice>0?Number(price)/priorPrice-1:0;
  const legacyCashQuote=finite(monitor.last_cash_annual_pct)?Number(monitor.last_cash_annual_pct):null;
  const priorCashQuote=finite(monitor.last_cash_quote_pct)?Number(monitor.last_cash_quote_pct):legacyCashQuote;
  const priorCashBasis=monitor.last_cash_quote_basis||"treasury_bill_discount";
  const priorCashEffective=priorCashBasis==="treasury_bill_discount"?treasuryBillDiscountToEffectiveAnnualPct(priorCashQuote):finite(priorCashQuote)?Number(priorCashQuote):0;
  const cashReturn=(1+(finite(priorCashEffective)?Number(priorCashEffective):0)/100)**(dt/(YEAR_DAYS*DAY))-1;
  const born=[];
  for(const [name,rawTarget] of Object.entries(desired)){
    const existing=monitor.strategies[name];
    const target=finite(rawTarget)?clamp(Number(rawTarget),0,100):(existing?.current_target_pct??0);
    // Путь линии — валовой NAV (без издержек) и накопленная доля (доля·сутки) — ведётся с рождения:
    // из них считается средневзвешенная по времени доля и разложение «уровень / тайминг / издержки».
    if(!existing){const turnover=Math.abs(target),cost=turnover/100*costRate,nav=1*(1-cost);monitor.strategies[name]={nav,peak_nav:Math.max(1,nav),max_drawdown_pct:(nav/Math.max(1,nav)-1)*100,turnover_pct:turnover,transaction_cost_pct:cost*100,current_target_pct:target,gross_nav:1,exposure_pct_days:0};born.push(name);continue;}
    const prevTarget=Number(existing.current_target_pct),gross=prevTarget/100*btcReturn+(1-prevTarget/100)*cashReturn,preCost=Number(existing.nav)*(1+gross),turnover=Math.abs(target-prevTarget),cost=turnover/100*costRate,nav=preCost*(1-cost),peak=Math.max(Number(existing.peak_nav),nav),dd=(nav/peak-1)*100;
    Object.assign(existing,{nav,peak_nav:peak,max_drawdown_pct:Math.min(Number(existing.max_drawdown_pct||0),dd),turnover_pct:Number(existing.turnover_pct||0)+turnover,transaction_cost_pct:Number(existing.transaction_cost_pct||0)+cost*100,current_target_pct:target});
    if(existing.gross_nav!==undefined)Object.assign(existing,{gross_nav:Number(existing.gross_nav)*(1+gross),exposure_pct_days:Number(existing.exposure_pct_days)+prevTarget*dt/DAY});
  }
  // Запись старта. Линии, рождённой позже policy_v1, нужны её опорные числа на этот прогон:
  // сравнение идёт на общем окне, от более позднего старта.
  const policyLine=monitor.strategies.policy_v1;
  for(const name of born){
    const registry=STRATEGY_REGISTRY_V1[name]||{kind:"benchmark",label:name},withPolicy=name==="policy_v1"||monitor.strategy_meta.policy_v1?.started_at===at;
    monitor.strategy_meta[name]={started_at:at,kind:registry.kind,label:registry.label,start_price:Number(price),start_target_pct:monitor.strategies[name].current_target_pct,
      ...(withPolicy?{}:{base:{cash_nav:monitor.strategies.cash?.nav??null,policy_v1_nav:policyLine?.nav??null,policy_v1_target_pct:policyLine?.current_target_pct??null,policy_v1_w_days:policyLine?.exposure_pct_days??null,policy_v1_gross:policyLine?.gross_nav??null}})};
  }
  if(monitor.counter_semantics_version!==2){
    const events=monitor.decision_events||[];
    monitor.state_changes=Math.max(0,events.length-1);
    monitor.target_changes=events.slice(1).reduce((count,event,index)=>count+(events[index].target_pct!==event.target_pct?1:0),0);
    monitor.counter_semantics_version=2;
  }else{
    monitor.state_changes=Number.isFinite(Number(monitor.state_changes))?Number(monitor.state_changes):0;
    monitor.target_changes=Number.isFinite(Number(monitor.target_changes))?Number(monitor.target_changes):0;
  }
  if(monitor.decision_events.at(-1)?.state_hash!==decision.state_hash){
    const priorEvent=monitor.decision_events.at(-1);
    if(priorEvent){monitor.state_changes++;if(priorEvent.target_pct!==decision.target_pct)monitor.target_changes++;}
    monitor.decision_events.push({t:at,state_hash:decision.state_hash,decision_hash:decision.decision_hash,strategic:decision.strategic,tactical:decision.tactical,target_pct:decision.target_pct,binding_overlays:decision.binding_overlays,input_hash:decision.input_hash});
  }
  monitor.decision_events=monitor.decision_events.slice(-cfg.decision_event_limit);
  // ЖУРНАЛ СМЕН ЦЕЛИ (scripts/monitor-changes-v1.mjs). База сравнения — последняя известная конечная
  // цель: пауза решения её не стирает («45 → пауза → 20» записывается как 45 → 20).
  optional("target_change_log",()=>{
    const log=Array.isArray(monitor.target_change_log)?monitor.target_change_log:[];
    const lastKnown=log.length?log.at(-1).to_pct:[...(monitor.decision_log||[])].reverse().find(x=>finite(x.target_pct))?.target_pct??null;
    const diff=tickDiff??(inputSummary?tickDiffFromInputSummariesV1(previousRow?.input_summary,ledgerInputs(inputSummary)):null);
    const change=targetChangeRecordV1({at,price,previous:{target_pct:lastKnown,strategic:previousEntry?.strategic??null,binding_overlays:previousEntry?.binding_overlays??[]},decision,regimeBirth,tickDiff:diff,candidateSince:regimeMeta?.strategic?.since??null,gateOpen});
    monitor.target_change_log=(change?[...log,change]:log).slice(-TARGET_CHANGE_LOG_LIMIT);
  });
  monitor.decision_log=monitor.decision_log||[];
  const priorLogHash=monitor.decision_log.at(-1)?.log_hash||null;
  // Состояние гистерезиса в каждой записи: цена лагов решений (кандидат появился → цель сменилась)
  // должна измеряться из самого леджера, а не git-археологией. Все значения явно ??null —
  // undefined-ключ в хэшируемой записи невоспроизводим из публикации (класс input_hash-бага).
  const hysteresis=regimeMeta?{
    strategic_candidate:regimeMeta.strategic?.candidate??null,strategic_count:regimeMeta.strategic?.count??null,
    strategic_since:regimeMeta.strategic?.since??null,strategic_hold_until:regimeMeta.strategic?.hold_until??null,
    tactical_candidate:regimeMeta.tactical?.candidate??null,tactical_count:regimeMeta.tactical?.count??null,
    tactical_since:regimeMeta.tactical?.since??null,tactical_hold_until:regimeMeta.tactical?.hold_until??null,
  }:null;
  // Провенанс тени v2 в hash-цепи: цель кандидата, входы градуировки и глубокий перцентиль
  // хэшируются вместе с записью — доказательства для решения о переключении воспроизводимы из
  // леджера, а не из ничем не покрытого бокового поля. Все значения ??null (см. класс input_hash).
  // Кандидат v3 и его линии — отдельным блоком `v3`, только когда движок вариантов вызывался.
  const v2Ledger={target_pct:finite(v2Target)?Number(v2Target):null,recovery_closes:monitor.v2_shadow_state?.closes??null,mvrv_percentile_deep:v2Inputs?.mvrv_percentile_deep??null,theta_pct:finite(monitor.v2_theta?.pct)?Number(monitor.v2_theta.pct):null};
  const logEntry={t:at,previous_log_hash:priorLogHash,policy_hash:decision.policy_hash,decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,status:decision.status,strategic:decision.strategic,tactical:decision.tactical,base_target_pct:decision.base_target_pct,target_pct:decision.target_pct,binding_overlays:decision.binding_overlays,quality:decision.quality.status,source_vintages_sha256:sourceVintages?.contract_sha256||null,hysteresis,v2:v2Ledger,...(variantRun.ran?{v3:optional("v3_ledger",()=>variantLedgerV1(variantRun,sha256),null)}:{})};
  logEntry.log_hash=sha256(logEntry);
  monitor.decision_log.push(logEntry);
  monitor.decision_log=monitor.decision_log.slice(-cfg.observation_log_limit);
  // v2_diverged фиксируется из СЫРЫХ целей этого тика: клампованные carry-forward цели стратегий
  // во время insufficient расходились бы фиктивно и завышали days_diverged (ревью 2026-07-22).
  // Дополнения строки (аудит 2026-10-10): tactical — краткосрочное состояние; v2_floor — пол тени
  // держал её цель выше базовой ступени хотя бы на одном прогоне этих суток (основа счётчика
  // эпизодов); path — путь политики [накопленная доля, %·сутки; валовой NAV]; shadow — значения
  // восьми теневых карточек.
  const sameDay=monitor.daily.findIndex(x=>x.date===date);
  const floorToday=v2Decision.binding_overlays.includes("recovery_floor")||(sameDay>=0&&monitor.daily[sameDay].v2_floor===true),shadowRow=optional("shadow_values",()=>shadowRowValuesV1(shadowValues),null);
  const dailyRow={t:at,date,price:Number(price),decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,policy_target_pct:decision.target_pct,targets:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.current_target_pct])),nav:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.nav])),quality:decision.quality.status,v2_diverged:finite(v2Target)&&finite(decision.target_pct)&&Number(v2Target)!==Number(decision.target_pct),tactical:decision.tactical??null,...(floorToday?{v2_floor:true}:{}),...(finite(policyLine?.gross_nav)?{path:{policy_v1:[Number(Number(policyLine.exposure_pct_days).toFixed(4)),Number(Number(policyLine.gross_nav).toFixed(9))]}}:{}),...(shadowRow?{shadow:shadowRow}:{}),input_summary:ledgerInputs(inputSummary),source_vintages_sha256:sourceVintages?.contract_sha256||null};
  if(sameDay>=0)monitor.daily[sameDay]=dailyRow;else monitor.daily.push(dailyRow);
  monitor.daily=monitor.daily.filter(x=>now-Date.parse(x.t)<=cfg.daily_history_days*DAY).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  // Детальные входы держим только за свежее окно: NAV-серия обязана покрывать 365 дней, а
  // подробный input_summary каждого из 370 дней стоил бы ~0.87 МБ и пробивал кап публичного файла
  // (страж бюджета поймал это 30.07 до наступления дедлока). `input_hash` остаётся в каждой строке,
  // поэтому предъявленные входы по-прежнему проверяемы, а их долгосрочный якорь — git-история.
  monitor.daily=pruneDailyInputSummaryV1(monitor.daily,{now,keepDays:DAILY_INPUT_SUMMARY_DAYS});
  monitor.updated_at=at;monitor.last_at=at;monitor.last_price=Number(price);monitor.last_cash_quote_pct=finite(cashQuotePct)?Number(cashQuotePct):null;monitor.last_cash_quote_basis=cashQuoteBasis;delete monitor.last_cash_annual_pct;monitor.cash_yield_available=finite(cashQuotePct);
  monitor.assumptions={...(monitor.assumptions||{}),transaction_cost_bps_per_full_turnover:cfg.transaction_cost_bps_per_full_turnover,cash_yield_source:"FRED DTB3, discount basis converted to effective annual yield (91-day convention)",cash_yield_basis:"3-month Treasury bill discount quote; ACT/360 price conversion, effective ACT/365.25 annualization",timezone:cfg.timezone,observation_mode:cfg.observation_mode,
    execution_gate:"Цель исполняется, только если решение проходит гейт витрины; при паузе решения линии, выведенные из него, держат прежнюю долю.",
    tranched_execution:TRANCHE_CONVENTION_V1,
    comparison_windows:"Линии сравниваются на общем окне от более позднего старта; оба портфеля открываются в начале окна и платят вход со своей доли. Sharpe и волатильность — по закрытым суткам.",
  };
  monitor.days_elapsed=Math.max(0,Math.floor((now-Date.parse(monitor.started_at))/DAY));monitor.observation_days=monitor.daily.length;monitor.review_schedule_days=cfg.review_days;monitor.next_review_day=cfg.review_days.find(x=>x>monitor.days_elapsed)??null;monitor.trend_vol_context=simple.trend_vol_context;
  monitor.revision_alerts=[...(monitor.revision_alerts||[]),...revisionAlerts.map(x=>({...x,detected_at:at}))].slice(-100);
  // Теневые счётчики кандидатов policy v2 (аудит 2026-07-21). Решение они НЕ меняют — только
  // накапливают форвард-доказательства: как часто одиночный degraded-снимок обнулил бы 48ч-удержание
  // повышения и сколько понижений v1 подтвердил раньше, чем разрешило бы правило v2.
  // Ревизия 2 (аудит 2026-10-10): интервал отсчитывается от ПЕРВОГО встречного снимка серии, и
  // серию монитор ведёт сам — по опубликованному режиму и кандидату гистерезиса. Встречный снимок —
  // кандидат хуже удерживаемого режима; снимок без данных серию не прерывает (v1 сохраняет счётчик),
  // кандидат не хуже режима — прерывает. Аварийный режим и «недостаточно данных» подтверждений не
  // требуют и в счёт не идут. Без regimeMeta (прежний вызов) принимается флаг сборщика.
  if(shadowHysteresis||regimeMeta?.strategic)optional("shadow_hysteresis",()=>{
    const prior=monitor.shadow_hysteresis||{};
    const resets=(Number(prior.upgrade_hold_resets_by_degraded)||0)+(Number(shadowHysteresis?.upgrade_hold_reset_by_degraded)||0);
    // Ключ переименован из risk_off_confirmed_under_30m (порог перестал быть зашитым числом);
    // накопленное значение переносится, чтобы форвардная статистика не начиналась заново.
    const priorFast=Number(prior.risk_off_confirmed_under_min_interval??prior.risk_off_confirmed_under_30m)||0;
    let fast=0,reference=prior.risk_off_ref??null,firstCounterAt=prior.risk_off_first_counter_at??null;
    if(regimeMeta?.strategic){
      const candidate=regimeMeta.strategic.candidate,published=decision.strategic;
      if(!realRegime(reference))reference=realRegime(previousEntry?.strategic)?previousEntry.strategic:null;
      if(reference&&realRegime(candidate))firstCounterAt=strategicRank(candidate)<strategicRank(reference)?(firstCounterAt??at):null;
      if(reference&&realRegime(published)&&strategicRank(published)<strategicRank(reference)&&riskOffConfirmationDeferredV2({firstCounterSnapshotAt:firstCounterAt??at,now}))fast=1;
      if(realRegime(published)&&published!==reference){reference=published;firstCounterAt=null;}
    }else fast=Number(shadowHysteresis?.risk_off_confirmed_under_min_interval??shadowHysteresis?.risk_off_confirmed_under_30m)||0;
    const bumped=resets>(Number(prior.upgrade_hold_resets_by_degraded)||0)||fast>0;
    monitor.shadow_hysteresis={upgrade_hold_resets_by_degraded:resets,risk_off_confirmed_under_min_interval:priorFast+fast,min_interval_minutes:POLICY_V2_CANDIDATE.hysteresis.risk_off_min_confirm_minutes,reference:POLICY_V2_CANDIDATE.hysteresis.risk_off_confirm_reference,last_event_t:bumped?at:prior.last_event_t??null,risk_off_ref:reference,risk_off_first_counter_at:firstCounterAt};
  });
  const closedDaily=closedRowsV1(monitor.daily,date);
  monitor.performance=Object.fromEntries(Object.entries(monitor.strategies).map(([name,strategy])=>[name,strategyStats(strategy,closedDaily,name)]));
  // Сравнения на общем окне и честный ноль тайминга (scripts/monitor-timing-v1.mjs).
  // Для теневых линий рядом — эпизоды расхождения цели с policy_v1 по дневным строкам (определение
  // из контракта кандидата v3; пока его нет в модуле, поля нет).
  monitor.comparisons=optional("comparisons",()=>{
    const out=comparisonsV1(monitor,{now,date,costRate});
    for(const name of ["policy_v2_shadow",...VARIANT_LINES_V1,TRANCHED_LINE_V1]){const divergence=out[name]?divergenceEpisodesV3(monitor.daily,name):null;if(divergence)out[name].divergence=divergence;}
    return out;
  },{});
  monitor.timing_null=optional("timing_null",()=>timingNullBlockV1(monitor,{now,date,costRate}),null);
  monitor.health=evaluateHealth(monitor,decision);
  // Публичный блок кандидата v2: цель тени, состояние градуировки, ревью-триада, машинная оценка
  // критериев приёмки/фальсификации и расхождение с живой политикой — весь материал будущего
  // решения о переключении в одном месте.
  monitor.v2_review=optional("v2_review",()=>evaluateReviewV2(monitor.daily,monitor.v2_review,monitor.performance,{costRate}),monitor.v2_review??null);
  const divergedDays=(monitor.daily||[]).filter(x=>x.v2_diverged===true).length;
  // Recovery-эпизод тени — отрезок суток подряд, в которые градуированный пол держал её цель выше
  // базовой ступени. Прежнее условие «цель тени выше цели v1» невыполнимо по построению (пол тени
  // 40/60/80 не выше пола v1): опубликовано было 0 эпизодов при двух фактических. Теневые дни —
  // от рождения тени, разрыв Sharpe — на общем с v1 окне (аудит 2026-10-10, 3.4).
  const episodesObserved=(()=>{let n=0,inEpisode=false;for(const x of (monitor.daily||[])){const on=x.v2_floor===true;if(on&&!inEpisode)n++;inEpisode=on;}return n;})();
  const v2Born=Date.parse(monitor.strategy_meta.policy_v2_shadow?.started_at),v2ShadowDays=finite(v2Born)?Math.max(0,Math.floor((now-v2Born)/DAY)):monitor.days_elapsed;
  monitor.v2_candidate={...policyV2CandidateMetadata(),target_pct:finite(v2Target)?Number(v2Target):null,recovery_closes:monitor.v2_shadow_state.closes,inputs:{mvrv_percentile_deep:v2Inputs?.mvrv_percentile_deep??null,deep_window_used:finite(v2Inputs?.mvrv_percentile_deep),theta_pct:finite(monitor.v2_theta?.pct)?monitor.v2_theta.pct:null,theta_fixed_at_day:monitor.v2_theta?.fixed_at_day??null},diverges_now:finite(v2Target)&&v2Target!==decision.target_pct,days_diverged:divergedDays,acceptance:POLICY_V2_CANDIDATE.decision_record.acceptance_criteria,acceptance_status:evaluateAcceptanceV2({performance:monitor.performance,sharpeGap:monitor.comparisons?.policy_v2_shadow?.sharpe_gap??null,shadowDays:v2ShadowDays,recoveryEpisodesObserved:episodesObserved})};
  // Публичные блоки кандидата v3 и линий «v1 с одной правкой» — когда движок вариантов вызывался.
  // Поля движка публикуются как он их отдал; без свежего результата остаются прежние (evaluated_at
  // показывает их возраст). Приёмка v3 считается здесь, критерии — из контракта кандидата.
  if(variantRun.ran||monitor.v3_candidate)optional("v3_candidate",()=>{
    const fresh=variantRun.ok?variantRun.published:{},v3Line=monitor.strategies.policy_v3_shadow,v3Meta=monitor.strategy_meta.policy_v3_shadow,v3Born=Date.parse(v3Meta?.started_at);
    const numbers=v3Line&&finite(v3Born)?(()=>{
      const lineDd=closeDrawdownPctV1(monitor.daily,"policy_v3_shadow",v3Born,1-Math.abs(Number(v3Meta.start_target_pct)||0)/100*costRate),policyDd=closeDrawdownPctV1(monitor.daily,"policy_v1",v3Born,v3Meta.base?.policy_v1_nav??null),cmp=monitor.comparisons.policy_v3_shadow;
      // Эпизоды расхождения приёмки — против линии с теми же часами, а не против policy_v1 (см. контракт кандидата).
      const base=acceptanceCriteriaV3()?.divergence_base,divergence=typeof base==="string"&&monitor.strategies[base]?divergenceEpisodesV3(monitor.daily,"policy_v3_shadow",undefined,base):null;
      return{shadowDays:Math.max(0,Math.floor((now-v3Born)/DAY)),divergence,timingGapPp:cmp?.vs_null_gap_pp??null,drawdownWorsePp:finite(lineDd)&&finite(policyDd)?Math.abs(lineDd)-Math.abs(policyDd):null,netReturnGapPp:cmp?.net_return_gap_pp??null};
    })():{};
    monitor.v3_candidate={target_pct:null,evaluated_at:null,...(monitor.v3_candidate||{}),...policyV3CandidateMetadata(),...(fresh.policy_v3_shadow?{...fresh.policy_v3_shadow,evaluated_at:at}:{}),acceptance:acceptanceCriteriaV3(),acceptance_status:evaluateAcceptanceV3(numbers)};
    monitor.variants={...(monitor.variants||{}),...Object.fromEntries(VARIANT_LINES_V1.filter(name=>name!=="policy_v3_shadow"&&fresh[name]).map(name=>[name,{...fresh[name],evaluated_at:at}]))};
  });
  // Форвард-счёт краткосрочного вердикта и теневого слоя (scripts/monitor-evidence-v1.mjs).
  monitor.tactical_forward=optional("tactical_forward",()=>tacticalForwardV1(monitor.daily,{date}),monitor.tactical_forward??null);
  if(shadowRow||monitor.shadow_evidence)monitor.shadow_evidence=optional("shadow_evidence",()=>shadowEvidenceV1(monitor.daily,{date}),monitor.shadow_evidence??null);
  // Отметка учёта: путь политики и новые линии проведены через этот прогон (см. «разрыв учёта»).
  monitor.accounting_at=at;
  return monitor;
}
