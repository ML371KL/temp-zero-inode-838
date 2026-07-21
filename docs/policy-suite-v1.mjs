import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "./policy-v1.mjs";
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
  contract_sha256:"d9fd80de6edeb737656a24f4deef5475dc7cda674f836123d5d9cb6f522d4947",
});

export function policySuiteContractV1(){
  return{
    allocation:POLICY_V1,
    allocation_engine:{
      applyStrategicDetectorPolicyV1:applyStrategicDetectorPolicyV1.toString().replace(/\r\n/g,"\n"),
      allocationDecisionV1:allocationDecisionV1.toString().replace(/\r\n/g,"\n"),
    },
    model:MODEL_POLICY_V1,
    execution:EXECUTION_POLICY_V1,
  };
}

export function policySuiteMetadataV1(){return{...POLICY_SUITE_V1};}
