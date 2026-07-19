import { POLICY_V1 } from "./policy-v1.mjs";
import { MODEL_POLICY_V1 } from "./model-policy-v1.mjs";
import { EXECUTION_POLICY_V1 } from "./execution-policy-v1.mjs";

export const POLICY_SUITE_V1=Object.freeze({
  id:"btc-decision-suite-v1",
  version:1,
  status:"frozen",
  frozen_at:"2026-07-19",
  historical_recalibration:"disabled",
  allocation_policy_id:POLICY_V1.id,
  model_policy_id:MODEL_POLICY_V1.id,
  execution_policy_id:EXECUTION_POLICY_V1.id,
  contract_sha256:"963a1681bdde169231734e3f488cbfcc791fa5adbca00ae8b8b6ce62f5fb5de9",
});

export function policySuiteContractV1(){
  return{allocation:POLICY_V1,model:MODEL_POLICY_V1,execution:EXECUTION_POLICY_V1};
}

export function policySuiteMetadataV1(){return{...POLICY_SUITE_V1};}
