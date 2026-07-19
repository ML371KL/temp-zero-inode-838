/*
 * Fail-closed action gate shared by the browser and the external live monitor.
 * This module does not calculate an allocation: it only decides whether an
 * already signed server decision is safe to display as actionable.
 */

export const ACTION_GATE_V1=Object.freeze({
  future_tolerance_hours:0.25,
  accepted_quality_states:Object.freeze(["good","degraded"]),
  required_operational_status:"healthy",
});

export function evaluateActionGateV1({generatedAt,now=Date.now(),staleLimitHours,decision,operationalStatus}){
  const generated=Date.parse(String(generatedAt??""));
  const at=Number(now),limit=Number(staleLimitHours);
  const ageHours=Number.isFinite(generated)&&Number.isFinite(at)?(at-generated)/3_600_000:null;
  let code=null;
  if(!Number.isFinite(generated)||!Number.isFinite(at)||!Number.isFinite(limit)||limit<0)code="time_invalid";
  else if(ageHours<-ACTION_GATE_V1.future_tolerance_hours)code="snapshot_in_future";
  else if(ageHours>limit)code="snapshot_stale";
  else if(!decision)code="decision_missing";
  else if(decision.status!=="actionable")code="decision_not_actionable";
  else if(!ACTION_GATE_V1.accepted_quality_states.includes(decision.quality?.status))code="decision_quality_not_actionable";
  else if(operationalStatus!==ACTION_GATE_V1.required_operational_status)code="operational_status_not_healthy";
  return{actionable:code===null,code,age_hours:ageHours};
}
