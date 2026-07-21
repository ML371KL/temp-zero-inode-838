/* Existing generic execution guidance, versioned without adding personalisation. */

const deepFreeze=value=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
};

export const EXECUTION_POLICY_V1=deepFreeze({
  id:"btc-execution-policy-v1",
  version:1,
  status:"frozen",
  frozen_at:"2026-07-19",
  historical_recalibration:"disabled",
  rebalance_on_step_change:true,
  off_cycle_rebalance_drift_pp:15,
  upgrades:"tranches_from_next_session",
  downgrades:"immediate",
  leverage:"prohibited",
  unallocated_cash:"income_instrument",
  personalisation:"out_of_scope",
});

export function executionPolicyMetadataV1(){
  const {id,version,status,frozen_at,historical_recalibration}=EXECUTION_POLICY_V1;
  return{id,version,status,frozen_at,historical_recalibration};
}
