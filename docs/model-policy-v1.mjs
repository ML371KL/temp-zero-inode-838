/*
 * BTC model policy v1.
 *
 * This contract freezes the economically material path that turns validated
 * source data into strategic/tactical regimes. The detailed scoring code is
 * protected by the section digests below; source adapters may evolve outside
 * those locked sections without silently recalibrating the model.
 */

const deepFreeze=value=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
};

export const MODEL_POLICY_V1=deepFreeze({
  id:"btc-model-policy-v1",
  version:1,
  status:"frozen",
  frozen_at:"2026-07-19",
  historical_recalibration:"disabled",
  blocks:{
    macro:{roman:"I",title:"Глобальный режим",subtitle:"ликвидность · ставки · доллар · кредит",strategicWeight:30,tacticalWeight:10},
    demand:{roman:"II",title:"Маржинальный спрос и доступное предложение",subtitle:"ETF · стейблкоины · биржевые потоки · CFTC",strategicWeight:40,tacticalWeight:25},
    cycle:{roman:"III",title:"Цикл, сеть и майнеры",subtitle:"MVRV · активность · экономика майнинга · тренд",strategicWeight:30,tacticalWeight:10},
    leverage:{roman:"IV",title:"Плечо и волатильность",subtitle:"funding · OI · basis · DVOL · skew",strategicWeight:0,tacticalWeight:45},
    market:{roman:"V",title:"Качество цены",subtitle:"премия США · синхронность площадок · объём",strategicWeight:0,tacticalWeight:10},
  },
  critical_min:{macro:0.60,demand:0.60,cycle:0.40,leverage:0.25,market:0.50},
  regime_bands:{supportive_min:20,adverse_max:-20},
  detector_state:{watch_min_hits:2,fired_min_hits:3,fired_all_but_one_min:3},
  hysteresis:{
    risk_off_confirm_snapshots:2,
    risk_on_hold_hours:48,
    risk_on_min_snapshots:12,
    emergency_immediate:true,
    insufficient_immediate:true,
  },
  forward_monitoring:{
    id:"btc-policy-v1-forward-monitor",
    started_at:"2026-07-19T00:00:00.000Z",
    timezone:"UTC",
    observation_mode:"as-collected; prior target earns the next interval return",
    transaction_cost_bps_per_full_turnover:10,
    daily_history_days:370,
    decision_event_limit:1000,
    observation_log_limit:400,
    review_days:[90,180,365],
    minimum_retirement_days:365,
    minimum_target_changes:2,
    investigation_rules:{
      sharpe_gap_vs_best_simple_benchmark:0.25,
      net_return_gap_vs_fixed_50_pct_points:10,
    },
    retirement_requires_all:{
      sharpe_gap_vs_best_simple_benchmark:0.25,
      max_drawdown_worse_than_fixed_50_pct_points:5,
      net_return_gap_vs_fixed_50_pct_points:10,
    },
    operational_pause:{
      snapshot_stale_hours:3,
      policy_hash_mismatch:true,
      decision_reproduction_failure:true,
      missing_target_for_actionable_regime:true,
    },
    previous_policy_shadow:{
      id:"btc-allocation-policy-v0-rebased-shadow",
      ladder:{emergency:0,defensive:10,deteriorating:20,transition:55,unconfirmed_positive:90,constructive:100},
      recovery_floor_pct:70,
      capitulation_floor_pct:40,
      capitulation_max_mvrv_percentile:10,
      euphoria_cap_pct:60,
      euphoria_min_mvrv_percentile:95,
      recovery_blocked_by_macro_shock_state:"fired",
    },
    simple_benchmarks:["buy_and_hold","fixed_50","cash","trend_vol_25"],
  },
  locked_sections:{
    market_integrity_v1:"d4cbb03f4f1adebd60cb99eb2dfde79a02cea26249cf297da367e4775c0911d1",
    scoring_and_regimes_v1:"86bd94500c17dbc5182d3bab3019a2dbab5a2bcd529f9f349231bff21f35fa6b",
    hysteresis_v1:"153e3f14fe5801ebd5bda2fc3d650a223b9ffe2938d3d3429fb7e90918dc08a6",
  },
});

export function modelPolicyMetadataV1(){
  const {id,version,status,frozen_at,historical_recalibration,locked_sections}=MODEL_POLICY_V1;
  return{id,version,status,frozen_at,historical_recalibration,locked_sections};
}
