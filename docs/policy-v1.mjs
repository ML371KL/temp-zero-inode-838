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

export function allocationTargetV1({strategic,recoveryState,macroShockState,mvrvPercentile}){
  if(strategic==="insufficient")return null;
  if(strategic==="emergency")return POLICY_V1.ladder.emergency;
  const base=POLICY_V1.ladder[strategic];
  if(!Number.isFinite(base))return null;
  const overlays=POLICY_V1.allocation_overlays;
  let target=base;
  if(
    recoveryState===overlays.recovery_detector_state&&
    macroShockState!==overlays.recovery_blocked_by_macro_shock_state&&
    target<overlays.recovery_floor_pct
  )target=overlays.recovery_floor_pct;
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile<=overlays.capitulation_max_mvrv_percentile&&target<overlays.capitulation_floor_pct)target=overlays.capitulation_floor_pct;
  if(Number.isFinite(mvrvPercentile)&&mvrvPercentile>=overlays.euphoria_min_mvrv_percentile&&target>overlays.euphoria_cap_pct)target=overlays.euphoria_cap_pct;
  return target;
}

export function policyMetadataV1(){
  const {id,version,status,frozen_at,historical_recalibration}=POLICY_V1;
  return {id,version,status,frozen_at,historical_recalibration};
}
