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
    };
  }
  return{mode:"as_collected",captured_at:null,sources,contract_sha256:sha256(sources)};
}

export function sourceRevisionAlertsV1(previousVintages,currentVintages){
  const alerts=[];
  for(const [key,current] of Object.entries(currentVintages?.sources||{})){
    const prior=previousVintages?.sources?.[key];
    if(!prior)continue;
    if(current.observed_at&&current.observed_at===prior.observed_at&&current.data_sha256&&prior.data_sha256&&current.data_sha256!==prior.data_sha256)
      alerts.push({source:key,type:"same_vintage_rewritten",observed_at:current.observed_at,previous_data_sha256:prior.data_sha256,current_data_sha256:current.data_sha256});
    if(current.schema_sha256&&prior.schema_sha256&&current.schema_sha256!==prior.schema_sha256)
      alerts.push({source:key,type:"schema_changed",previous_schema_sha256:prior.schema_sha256,current_schema_sha256:current.schema_sha256});
  }
  return alerts;
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
  const inputPayload={generated_at:generatedAt,regime,regime_meta:regimeMeta,allocation_inputs:allocation.inputs,input_summary:inputSummary};
  const inputHash=sha256(inputPayload),policyHash=policySuiteDigestV1();
  const staleSources=Object.values(sourceVintages?.sources||{}).filter(x=>["stale","partial","fail"].includes(x.state)).length;
  const quality=!scores.critical_coverage_ok||allocation.status==="paused"?"paused":staleSources||revisionAlerts.length?"degraded":"good";
  const statePayload={policy_hash:policyHash,status:allocation.status,strategic:regime.strategic,tactical:regime.tactical,base_target_pct:allocation.base_target_pct,target_pct:allocation.target_pct,binding_overlays:allocation.binding_overlays};
  const stateHash=sha256(statePayload);
  const decision={
    schema:1,decided_at:generatedAt,policy_id:POLICY_SUITE_V1.id,policy_hash:policyHash,input_hash:inputHash,state_hash:stateHash,
    status:allocation.status,strategic:regime.strategic,tactical:regime.tactical,base_target_pct:allocation.base_target_pct,target_pct:allocation.target_pct,
    regime_targets_pct:regimeTargets,binding_overlays:allocation.binding_overlays,reason_codes:allocation.reason_codes,inputs:allocation.inputs,
    quality:{status:quality,critical_coverage_ok:!!scores.critical_coverage_ok,stale_or_partial_sources:staleSources,revision_alerts:revisionAlerts.length},
  };
  decision.decision_hash=sha256(decision);
  return{decision,inputSummary};
}

export function previousPolicyTargetV1({strategic,recoveryState,macroShockState,mvrvPercentile}){
  if(strategic==="insufficient")return null;
  const p=MODEL_POLICY_V1.forward_monitoring.previous_policy_shadow;
  let target=p.ladder[strategic];
  if(!finite(target))return null;
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
  const navs=daily.map(x=>x.nav?.[name]).filter(finite).map(Number),cashNavs=daily.map(x=>x.nav?.cash).filter(finite).map(Number),returns=[];
  for(let i=1;i<navs.length;i++)if(navs[i-1]>0)returns.push(navs[i]/navs[i-1]-1);
  const cashReturns=[];for(let i=1;i<cashNavs.length;i++)if(cashNavs[i-1]>0)cashReturns.push(cashNavs[i]/cashNavs[i-1]-1);
  const sd=stdev(returns),n=Math.min(returns.length,cashReturns.length),excess=n?returns.slice(-n).map((x,i)=>x-cashReturns.slice(-n)[i]):[];
  return{
    nav:Number(strategy.nav),net_return_pct:(Number(strategy.nav)-1)*100,max_drawdown_pct:Number(strategy.max_drawdown_pct||0),
    annualized_volatility_pct:sd==null?null:sd*Math.sqrt(365)*100,
    sharpe_excess:sd&&excess.length?mean(excess)/sd*Math.sqrt(365):null,
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
  const simple=["buy_and_hold","fixed_50","trend_vol_25"].map(k=>monitor.performance?.[k]).filter(Boolean),bestSharpe=Math.max(...simple.map(x=>finite(x.sharpe_excess)?Number(x.sharpe_excess):-Infinity));
  if(days>=180&&p&&fixed&&Number.isFinite(bestSharpe)){
    const sharpeGap=bestSharpe-(finite(p.sharpe_excess)?Number(p.sharpe_excess):-Infinity),returnGap=Number(fixed.net_return_pct)-Number(p.net_return_pct),ddWorse=Math.abs(Number(p.max_drawdown_pct))-Math.abs(Number(fixed.max_drawdown_pct));
    if(sharpeGap>=cfg.investigation_rules.sharpe_gap_vs_best_simple_benchmark||returnGap>=cfg.investigation_rules.net_return_gap_vs_fixed_50_pct_points){performanceStatus="investigate";performanceReasons.push("forward_underperformance_threshold");}
    if(days>=cfg.minimum_retirement_days&&changes>=cfg.minimum_target_changes&&sharpeGap>=cfg.retirement_requires_all.sharpe_gap_vs_best_simple_benchmark&&ddWorse>=cfg.retirement_requires_all.max_drawdown_worse_than_fixed_50_pct_points&&returnGap>=cfg.retirement_requires_all.net_return_gap_vs_fixed_50_pct_points){performanceStatus="retire_candidate";performanceReasons=["all_predeclared_retirement_conditions_met"];}
    else if(performanceStatus==="collecting"&&days>=365)performanceStatus="first_meaningful_review";
    else if(performanceStatus==="collecting")performanceStatus="preliminary";
  }else if(days>=90)performanceStatus="operational_only";
  return{operational_status:operationalIssues.length?"paused":"healthy",operational_issues:operationalIssues,performance_status:performanceStatus,performance_reasons:performanceReasons,automatic_recalibration:false,owner_approval_required_for_policy_v2:true};
}

export function updateForwardMonitorV1({previousMonitor,now,price,decision,inputSummary,sourceVintages,revisionAlerts=[],cashAnnualPct=null,priceSeries=[]}){
  if(!finite(price)||Number(price)<=0)throw new Error("forward monitor requires a positive price");
  const cfg=MODEL_POLICY_V1.forward_monitoring,at=new Date(now).toISOString(),date=at.slice(0,10),simple=simpleTargets(priceSeries);
  const desired={
    policy_v1:decision.target_pct,
    previous_policy_shadow:previousPolicyTargetV1({strategic:decision.strategic,recoveryState:decision.inputs.recovery_state,macroShockState:decision.inputs.macro_shock_state,mvrvPercentile:decision.inputs.mvrv_percentile}),
    buy_and_hold:simple.buy_and_hold,fixed_50:simple.fixed_50,cash:simple.cash,trend_vol_25:simple.trend_vol_25,
  };
  const monitor=previousMonitor?.schema===1?structuredClone(previousMonitor):{
    schema:1,id:cfg.id,started_at:at,updated_at:at,last_price:Number(price),last_at:at,last_cash_annual_pct:finite(cashAnnualPct)?Number(cashAnnualPct):null,
    strategies:{},daily:[],decision_events:[],decision_log:[],target_changes:0,revision_alerts:[],assumptions:{transaction_cost_bps_per_full_turnover:cfg.transaction_cost_bps_per_full_turnover,cash_yield_source:"FRED DTB3; zero only when unavailable",timezone:cfg.timezone,observation_mode:cfg.observation_mode},
  };
  const costRate=cfg.transaction_cost_bps_per_full_turnover/10_000;
  const priorPrice=Number(monitor.last_price),dt=Math.max(0,now-Date.parse(monitor.last_at||at)),btcReturn=priorPrice>0?Number(price)/priorPrice-1:0;
  const priorCashRate=finite(monitor.last_cash_annual_pct)?Number(monitor.last_cash_annual_pct):0,cashReturn=(1+priorCashRate/100)**(dt/(YEAR_DAYS*DAY))-1;
  for(const [name,rawTarget] of Object.entries(desired)){
    const existing=monitor.strategies[name];
    const target=finite(rawTarget)?clamp(Number(rawTarget),0,100):(existing?.current_target_pct??0);
    if(!existing){const turnover=Math.abs(target),cost=turnover/100*costRate,nav=1*(1-cost);monitor.strategies[name]={nav,peak_nav:Math.max(1,nav),max_drawdown_pct:(nav/Math.max(1,nav)-1)*100,turnover_pct:turnover,transaction_cost_pct:cost*100,current_target_pct:target};continue;}
    const prevTarget=Number(existing.current_target_pct),gross=prevTarget/100*btcReturn+(1-prevTarget/100)*cashReturn,preCost=Number(existing.nav)*(1+gross),turnover=Math.abs(target-prevTarget),cost=turnover/100*costRate,nav=preCost*(1-cost),peak=Math.max(Number(existing.peak_nav),nav),dd=(nav/peak-1)*100;
    Object.assign(existing,{nav,peak_nav:peak,max_drawdown_pct:Math.min(Number(existing.max_drawdown_pct||0),dd),turnover_pct:Number(existing.turnover_pct||0)+turnover,transaction_cost_pct:Number(existing.transaction_cost_pct||0)+cost*100,current_target_pct:target});
  }
  if(monitor.decision_events.at(-1)?.state_hash!==decision.state_hash){
    if(monitor.decision_events.length)monitor.target_changes++;
    monitor.decision_events.push({t:at,state_hash:decision.state_hash,decision_hash:decision.decision_hash,strategic:decision.strategic,tactical:decision.tactical,target_pct:decision.target_pct,binding_overlays:decision.binding_overlays,input_hash:decision.input_hash});
  }
  monitor.decision_events=monitor.decision_events.slice(-cfg.decision_event_limit);
  monitor.decision_log=monitor.decision_log||[];
  const priorLogHash=monitor.decision_log.at(-1)?.log_hash||null;
  const logEntry={t:at,previous_log_hash:priorLogHash,policy_hash:decision.policy_hash,decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,status:decision.status,strategic:decision.strategic,tactical:decision.tactical,base_target_pct:decision.base_target_pct,target_pct:decision.target_pct,binding_overlays:decision.binding_overlays,quality:decision.quality.status,source_vintages_sha256:sourceVintages?.contract_sha256||null};
  logEntry.log_hash=sha256(logEntry);
  monitor.decision_log.push(logEntry);
  monitor.decision_log=monitor.decision_log.slice(-cfg.observation_log_limit);
  const dailyRow={t:at,date,price:Number(price),decision_hash:decision.decision_hash,state_hash:decision.state_hash,input_hash:decision.input_hash,policy_target_pct:decision.target_pct,targets:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.current_target_pct])),nav:Object.fromEntries(Object.entries(monitor.strategies).map(([k,v])=>[k,v.nav])),quality:decision.quality.status,input_summary:ledgerInputs(inputSummary),source_vintages_sha256:sourceVintages?.contract_sha256||null};
  const sameDay=monitor.daily.findIndex(x=>x.date===date);if(sameDay>=0)monitor.daily[sameDay]=dailyRow;else monitor.daily.push(dailyRow);
  monitor.daily=monitor.daily.filter(x=>now-Date.parse(x.t)<=cfg.daily_history_days*DAY).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  monitor.updated_at=at;monitor.last_at=at;monitor.last_price=Number(price);monitor.last_cash_annual_pct=finite(cashAnnualPct)?Number(cashAnnualPct):null;monitor.cash_yield_available=finite(cashAnnualPct);
  monitor.days_elapsed=Math.max(0,Math.floor((now-Date.parse(monitor.started_at))/DAY));monitor.observation_days=monitor.daily.length;monitor.review_schedule_days=cfg.review_days;monitor.next_review_day=cfg.review_days.find(x=>x>monitor.days_elapsed)??null;monitor.trend_vol_context=simple.trend_vol_context;
  monitor.revision_alerts=[...(monitor.revision_alerts||[]),...revisionAlerts.map(x=>({...x,detected_at:at}))].slice(-100);
  monitor.performance=Object.fromEntries(Object.entries(monitor.strategies).map(([name,strategy])=>[name,strategyStats(strategy,monitor.daily,name)]));
  monitor.health=evaluateHealth(monitor,decision);
  return monitor;
}
