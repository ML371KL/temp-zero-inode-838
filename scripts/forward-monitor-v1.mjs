import { createHash } from "node:crypto";
import { allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1, policySuiteContractV1 } from "../docs/policy-suite-v1.mjs";

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

function strategyStats(strategy,daily,name){
  const rows=daily.filter(x=>finite(x.nav?.[name])&&finite(x.nav?.cash)&&finite(Date.parse(x.t)));
  const returns=[],cashReturns=[],dtDays=[];
  for(let i=1;i<rows.length;i++){
    const nav0=Number(rows[i-1].nav[name]),cash0=Number(rows[i-1].nav.cash);
    if(nav0>0&&cash0>0){
      returns.push(Number(rows[i].nav[name])/nav0-1);
      cashReturns.push(Number(rows[i].nav.cash)/cash0-1);
      dtDays.push(Math.max(1,(Date.parse(rows[i].t)-Date.parse(rows[i-1].t))/DAY));
    }
  }
  const excess=returns.map((x,i)=>x-cashReturns[i]);
  // Sharpe по определению POLICY.md — ИЗБЫТОЧНАЯ доходность: и числитель, и знаменатель по excess.
  // Годовая шкала — по фактическому среднему шагу точек (календарные дыры не должны завышать
  // волатильность, как это делал жёсткий sqrt(365) по «соседним» точкам).
  const sd=stdev(returns),sdExcess=stdev(excess);
  const perYear=dtDays.length?365/Math.max(1,mean(dtDays)):365;
  // Тождественно нулевой excess (стратегия шла в ногу с cash — в т.ч. сам cash и полный кэш policy
  // в затяжном emergency) — это НУЛЕВОЙ excess-Sharpe, а не «неопределённость»: null здесь
  // превращался в -Infinity в evaluateHealth и давал ложный investigate ровно в кризисном режиме.
  const sharpeExcess=excess.length>=2?(sdExcess?mean(excess)/sdExcess*Math.sqrt(perYear):(mean(excess)===0?0:null)):null;
  return{
    nav:Number(strategy.nav),net_return_pct:(Number(strategy.nav)-1)*100,max_drawdown_pct:Number(strategy.max_drawdown_pct||0),
    annualized_volatility_pct:sd==null?null:sd*Math.sqrt(perYear)*100,
    sharpe_excess:sharpeExcess,
    turnover_pct:Number(strategy.turnover_pct||0),transaction_cost_pct:Number(strategy.transaction_cost_pct||0),current_target_pct:Number(strategy.current_target_pct),
  };
}

function evaluateHealth(monitor,decision){
  const cfg=MODEL_POLICY_V1.forward_monitoring,days=monitor.days_elapsed,changes=monitor.target_changes;
  const operationalIssues=[];
  if(decision.policy_hash!==POLICY_SUITE_V1.contract_sha256)operationalIssues.push("policy_hash_mismatch");
  if(decision.status==="actionable"&&!finite(decision.target_pct))operationalIssues.push("missing_target_for_actionable_regime");
  if(decision.quality.status==="paused")operationalIssues.push("decision_paused");
  let performanceStatus="collecting",performanceReasons=[];
  const p=monitor.performance?.policy_v1,fixed=monitor.performance?.fixed_50;
  // POLICY.md перечисляет простые бенчмарки как buy & hold / fixed 50% / cash / trend. Excess-Sharpe
  // самого cash тождественно равен нулю (excess против самого себя) — участвует он именно нулём:
  // в медвежьем окне, где рисковые бенчмарки отрицательны, планку best-simple задаёт cash с 0.
  const simple=["buy_and_hold","fixed_50","cash","trend_vol_25"].map(k=>monitor.performance?.[k]).filter(Boolean),bestSharpe=Math.max(...simple.map(x=>finite(x.sharpe_excess)?Number(x.sharpe_excess):-Infinity));
  if(days>=180&&p&&fixed&&Number.isFinite(bestSharpe)){
    // Недоступный Sharpe политики — «сравнение невозможно», а не -Infinity: coercion давал
    // sharpeGap=+Infinity и ложный investigate/retire-триггер. Ветка returnGap работает сама.
    const sharpeGap=finite(p.sharpe_excess)?bestSharpe-Number(p.sharpe_excess):-Infinity,returnGap=Number(fixed.net_return_pct)-Number(p.net_return_pct),ddWorse=Math.abs(Number(p.max_drawdown_pct))-Math.abs(Number(fixed.max_drawdown_pct));
    if(sharpeGap>=cfg.investigation_rules.sharpe_gap_vs_best_simple_benchmark||returnGap>=cfg.investigation_rules.net_return_gap_vs_fixed_50_pct_points){performanceStatus="investigate";performanceReasons.push("forward_underperformance_threshold");}
    if(days>=cfg.minimum_retirement_days&&changes>=cfg.minimum_target_changes&&sharpeGap>=cfg.retirement_requires_all.sharpe_gap_vs_best_simple_benchmark&&ddWorse>=cfg.retirement_requires_all.max_drawdown_worse_than_fixed_50_pct_points&&returnGap>=cfg.retirement_requires_all.net_return_gap_vs_fixed_50_pct_points){performanceStatus="retire_candidate";performanceReasons=["all_predeclared_retirement_conditions_met"];}
    else if(performanceStatus==="collecting"&&days>=365)performanceStatus="first_meaningful_review";
    else if(performanceStatus==="collecting")performanceStatus="preliminary";
  }else if(days>=90)performanceStatus="operational_only";
  return{operational_status:operationalIssues.length?"paused":"healthy",operational_issues:operationalIssues,performance_status:performanceStatus,performance_reasons:performanceReasons,automatic_recalibration:false,owner_approval_required_for_policy_v2:true};
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
  const scaledDaily=(live.daily||[]).map(row=>({...row,nav:Object.fromEntries(Object.entries(row.nav||{}).map(([name,value])=>[name,Number(value)*(scale[name]??1)]))}));
  merged.daily=[...merged.daily.filter(row=>!liveDates.has(row.date)),...scaledDaily].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  merged.updated_at=live.updated_at;merged.last_at=live.last_at;merged.last_price=live.last_price;
  merged.last_cash_quote_pct=live.last_cash_quote_pct;merged.last_cash_quote_basis=live.last_cash_quote_basis;
  merged.counter_semantics_version=2;
  merged.revision_alerts=[...(merged.revision_alerts||[]),...(live.revision_alerts||[])].slice(-100);
  merged.reset_events=[...(merged.reset_events||[]),...(live.reset_events||[])].slice(-10);
  merged.graft={applied_at:live.updated_at,reason:pack.reason,invalid_window:pack.invalid_window,orphaned_genesis_log_hashes:pack.orphaned_genesis_log_hashes,archive_source_commit:pack.archive.source_commit||null};
  return merged;
}

export function updateForwardMonitorV1({previousMonitor,now,price,decision,inputSummary,sourceVintages,revisionAlerts=[],cashQuotePct=null,cashQuoteBasis="treasury_bill_discount",priceSeries=[],previousSnapshotPresent=false,regimeMeta=null,shadowHysteresis=null}){
  if(!finite(price)||Number(price)<=0)throw new Error("forward monitor requires a positive price");
  const cfg=MODEL_POLICY_V1.forward_monitoring,at=new Date(now).toISOString(),date=at.slice(0,10),simple=simpleTargets(priceSeries);
  const desired={
    policy_v1:decision.target_pct,
    previous_policy_shadow:previousPolicyTargetV1({strategic:decision.strategic,recoveryState:decision.inputs.recovery_state,macroShockState:decision.inputs.macro_shock_state,mvrvPercentile:decision.inputs.mvrv_percentile}),
    buy_and_hold:simple.buy_and_hold,fixed_50:simple.fixed_50,cash:simple.cash,trend_vol_25:simple.trend_vol_25,
  };
  const monitor=previousMonitor?.schema===1?structuredClone(previousMonitor):{
    schema:1,id:cfg.id,started_at:at,updated_at:at,last_price:Number(price),last_at:at,last_cash_quote_pct:finite(cashQuotePct)?Number(cashQuotePct):null,last_cash_quote_basis:cashQuoteBasis,
    strategies:{},daily:[],decision_events:[],decision_log:[],counter_semantics_version:2,state_changes:0,target_changes:0,revision_alerts:[],assumptions:{transaction_cost_bps_per_full_turnover:cfg.transaction_cost_bps_per_full_turnover,cash_yield_source:"FRED DTB3, discount basis converted to effective annual yield (91-day convention)",cash_yield_basis:"3-month Treasury bill discount quote; ACT/360 price conversion, effective ACT/365.25 annualization",timezone:cfg.timezone,observation_mode:cfg.observation_mode},
  };
  // Генезис при живом предыдущем снимке = потеря состояния монитора (инцидент 2026-07-21: молчаливый
  // сброс уничтожил 58-записный журнал). Сброс обязан оставлять СЛЕД в самом мониторе; внешний
  // сторож дополнительно ловит регресс started_at против HEAD репозитория.
  if(previousMonitor?.schema!==1&&previousSnapshotPresent)
    monitor.reset_events=[...(previousMonitor?.reset_events||[]),{t:at,reason:"previous_snapshot_without_monitoring"}].slice(-10);
  const costRate=cfg.transaction_cost_bps_per_full_turnover/10_000;
  const priorPrice=Number(monitor.last_price),dt=Math.max(0,now-Date.parse(monitor.last_at||at)),btcReturn=priorPrice>0?Number(price)/priorPrice-1:0;
  const legacyCashQuote=finite(monitor.last_cash_annual_pct)?Number(monitor.last_cash_annual_pct):null;
  const priorCashQuote=finite(monitor.last_cash_quote_pct)?Number(monitor.last_cash_quote_pct):legacyCashQuote;
  const priorCashBasis=monitor.last_cash_quote_basis||"treasury_bill_discount";
  const priorCashEffective=priorCashBasis==="treasury_bill_discount"?treasuryBillDiscountToEffectiveAnnualPct(priorCashQuote):finite(priorCashQuote)?Number(priorCashQuote):0;
  const cashReturn=(1+(finite(priorCashEffective)?Number(priorCashEffective):0)/100)**(dt/(YEAR_DAYS*DAY))-1;
  for(const [name,rawTarget] of Object.entries(desired)){
    const existing=monitor.strategies[name];
    const target=finite(rawTarget)?clamp(Number(rawTarget),0,100):(existing?.current_target_pct??0);
    if(!existing){const turnover=Math.abs(target),cost=turnover/100*costRate,nav=1*(1-cost);monitor.strategies[name]={nav,peak_nav:Math.max(1,nav),max_drawdown_pct:(nav/Math.max(1,nav)-1)*100,turnover_pct:turnover,transaction_cost_pct:cost*100,current_target_pct:target};continue;}
    const prevTarget=Number(existing.current_target_pct),gross=prevTarget/100*btcReturn+(1-prevTarget/100)*cashReturn,preCost=Number(existing.nav)*(1+gross),turnover=Math.abs(target-prevTarget),cost=turnover/100*costRate,nav=preCost*(1-cost),peak=Math.max(Number(existing.peak_nav),nav),dd=(nav/peak-1)*100;
    Object.assign(existing,{nav,peak_nav:peak,max_drawdown_pct:Math.min(Number(existing.max_drawdown_pct||0),dd),turnover_pct:Number(existing.turnover_pct||0)+turnover,transaction_cost_pct:Number(existing.transaction_cost_pct||0)+cost*100,current_target_pct:target});
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
  const logEntry={t:at,previous_log_hash:priorLogHash,policy_hash:decision.policy_hash,decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,status:decision.status,strategic:decision.strategic,tactical:decision.tactical,base_target_pct:decision.base_target_pct,target_pct:decision.target_pct,binding_overlays:decision.binding_overlays,quality:decision.quality.status,source_vintages_sha256:sourceVintages?.contract_sha256||null,hysteresis};
  logEntry.log_hash=sha256(logEntry);
  monitor.decision_log.push(logEntry);
  monitor.decision_log=monitor.decision_log.slice(-cfg.observation_log_limit);
  const dailyRow={t:at,date,price:Number(price),decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,policy_target_pct:decision.target_pct,targets:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.current_target_pct])),nav:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.nav])),quality:decision.quality.status,input_summary:ledgerInputs(inputSummary),source_vintages_sha256:sourceVintages?.contract_sha256||null};
  const sameDay=monitor.daily.findIndex(x=>x.date===date);if(sameDay>=0)monitor.daily[sameDay]=dailyRow;else monitor.daily.push(dailyRow);
  monitor.daily=monitor.daily.filter(x=>now-Date.parse(x.t)<=cfg.daily_history_days*DAY).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  monitor.updated_at=at;monitor.last_at=at;monitor.last_price=Number(price);monitor.last_cash_quote_pct=finite(cashQuotePct)?Number(cashQuotePct):null;monitor.last_cash_quote_basis=cashQuoteBasis;delete monitor.last_cash_annual_pct;monitor.cash_yield_available=finite(cashQuotePct);
  monitor.assumptions={...(monitor.assumptions||{}),transaction_cost_bps_per_full_turnover:cfg.transaction_cost_bps_per_full_turnover,cash_yield_source:"FRED DTB3, discount basis converted to effective annual yield (91-day convention)",cash_yield_basis:"3-month Treasury bill discount quote; ACT/360 price conversion, effective ACT/365.25 annualization",timezone:cfg.timezone,observation_mode:cfg.observation_mode};
  monitor.days_elapsed=Math.max(0,Math.floor((now-Date.parse(monitor.started_at))/DAY));monitor.observation_days=monitor.daily.length;monitor.review_schedule_days=cfg.review_days;monitor.next_review_day=cfg.review_days.find(x=>x>monitor.days_elapsed)??null;monitor.trend_vol_context=simple.trend_vol_context;
  monitor.revision_alerts=[...(monitor.revision_alerts||[]),...revisionAlerts.map(x=>({...x,detected_at:at}))].slice(-100);
  // Теневые счётчики кандидатов policy v2 (аудит 2026-07-21). Решение они НЕ меняют — только
  // накапливают форвард-доказательства: как часто одиночный degraded-снимок обнулил бы 48ч-удержание
  // повышения и как часто risk-off подтверждался парой снимков с разносом меньше 30 минут.
  if(shadowHysteresis){
    const prior=monitor.shadow_hysteresis||{};
    const resets=(Number(prior.upgrade_hold_resets_by_degraded)||0)+(Number(shadowHysteresis.upgrade_hold_reset_by_degraded)||0);
    const fastConfirms=(Number(prior.risk_off_confirmed_under_30m)||0)+(Number(shadowHysteresis.risk_off_confirmed_under_30m)||0);
    const bumped=resets>(Number(prior.upgrade_hold_resets_by_degraded)||0)||fastConfirms>(Number(prior.risk_off_confirmed_under_30m)||0);
    monitor.shadow_hysteresis={upgrade_hold_resets_by_degraded:resets,risk_off_confirmed_under_30m:fastConfirms,last_event_t:bumped?at:prior.last_event_t??null};
  }
  monitor.performance=Object.fromEntries(Object.entries(monitor.strategies).map(([name,strategy])=>[name,strategyStats(strategy,monitor.daily,name)]));
  monitor.health=evaluateHealth(monitor,decision);
  return monitor;
}
