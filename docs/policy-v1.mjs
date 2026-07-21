/*
 * BTC allocation policy v1.
 *
 * FROZEN on 2026-07-19. Live code may consume this contract, but historical
 * research must never rewrite it. Any future recalibration creates a new
 * policy-vN module and leaves this file unchanged for reproducibility.
 */

const deepFreeze=value=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
};

export const POLICY_V1=deepFreeze({
  id:"btc-allocation-policy-v1",
  version:1,
  status:"frozen",
  frozen_at:"2026-07-19",
  historical_recalibration:"disabled",
  strategic_order:["emergency","defensive","deteriorating","transition","unconfirmed_positive","constructive"],
  ladder:{
    emergency:0,
    defensive:5,
    deteriorating:20,
    transition:45,
    unconfirmed_positive:95,
    constructive:100,
  },
  allocation_overlays:{
    recovery_floor_pct:80,
    recovery_detector_state:"good",
    recovery_blocked_by_macro_shock_state:"fired",
    capitulation_floor_pct:40,
    capitulation_max_mvrv_percentile:10,
    euphoria_cap_pct:60,
    euphoria_min_mvrv_percentile:95,
  },
  verdict_overlays:{
    adverse_detector_cap_regime:"deteriorating",
    recovery_lift_from:["defensive","deteriorating"],
    recovery_lift_regime:"transition",
  },
});

export function applyStrategicDetectorPolicyV1({strategic,macroShockState,distributionState,recoveryState}){
  let result=strategic;
  const optimistic=["constructive","unconfirmed_positive","transition"];
  if(macroShockState==="fired"&&optimistic.includes(result))result=POLICY_V1.verdict_overlays.adverse_detector_cap_regime;
  if(distributionState==="fired"&&optimistic.includes(result))result=POLICY_V1.verdict_overlays.adverse_detector_cap_regime;
  if(
    recoveryState===POLICY_V1.allocation_overlays.recovery_detector_state&&
    macroShockState!==POLICY_V1.allocation_overlays.recovery_blocked_by_macro_shock_state&&
    POLICY_V1.verdict_overlays.recovery_lift_from.includes(result)
  )result=POLICY_V1.verdict_overlays.recovery_lift_regime;
  return result;
}

export function allocationDecisionV1({strategic,recoveryState,macroShockState,mvrvPercentile}){
  const inputs={strategic,recovery_state:recoveryState??"calm",macro_shock_state:macroShockState??"calm",mvrv_percentile:Number.isFinite(mvrvPercentile)?Number(mvrvPercentile):null};
  if(strategic==="insufficient")return{status:"paused",base_target_pct:null,target_pct:null,binding_overlays:[],reason_codes:["insufficient_data"],inputs};
  if(strategic==="emergency")return{status:"actionable",base_target_pct:POLICY_V1.ladder.emergency,target_pct:POLICY_V1.ladder.emergency,binding_overlays:["emergency_override"],reason_codes:["base:emergency","emergency_override"],inputs};
  const base=POLICY_V1.ladder[strategic];
  if(!Number.isFinite(base))return{status:"paused",base_target_pct:null,target_pct:null,binding_overlays:[],reason_codes:["unknown_strategic_regime"],inputs};
  const overlays=POLICY_V1.allocation_overlays;
  let target=base,binding=[];
  if(
    recoveryState===overlays.recovery_detector_state&&
    macroShockState!==overlays.recovery_blocked_by_macro_shock_state&&
    target<overlays.recovery_floor_pct
  ){target=overlays.recovery_floor_pct;binding.push("recovery_floor");}
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile<=overlays.capitulation_max_mvrv_percentile&&target<overlays.capitulation_floor_pct){target=overlays.capitulation_floor_pct;binding.push("capitulation_floor");}
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile>=overlays.euphoria_min_mvrv_percentile&&target>overlays.euphoria_cap_pct){target=overlays.euphoria_cap_pct;binding.push("euphoria_safety_cap");}
  return{status:"actionable",base_target_pct:base,target_pct:target,binding_overlays:binding,reason_codes:[`base:${strategic}`,...binding],inputs};
}

export function allocationTargetV1(input){
  return allocationDecisionV1(input).target_pct;
}

export function policyMetadataV1(){
  const {id,version,status,frozen_at,historical_recalibration}=POLICY_V1;
  return {id,version,status,frozen_at,historical_recalibration};
}
