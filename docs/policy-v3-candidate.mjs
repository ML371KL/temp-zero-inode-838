/*
 * BTC decision suite v3 — теневой кандидат (аудит 2026-10-10).
 *
 * ЗАГЛУШКА API: контракт и движок вариантов наполняет отдельный поток работ. Пока файл не наполнен,
 * движок возвращает пустой набор вариантов, и форвард-монитор держит у теневых линий прежнюю цель.
 * Живое решение v1 этот модуль не читает и изменить не может.
 */

const deepFreeze=value=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
};

export const POLICY_V3_CANDIDATE=deepFreeze({
  id:"btc-decision-suite-v3-candidate",
  version:1,
  status:"shadow_candidate",
  created:"2026-10-10",
  base_suite:"btc-decision-suite-v1",
});

export function policyV3CandidateMetadata(){
  const {id,version,status,created,base_suite}=POLICY_V3_CANDIDATE;
  return{id,version,status,created,base_suite};
}

// Чистая функция: никогда не бросает исключений. `variants` — ключи policy_v3_shadow, v1_daily_close,
// v1_floor_handoff, v1_no_cftc; у каждого target_pct (number|null; null — «держать прежнюю цель»).
export function evaluateShadowVariantsV1({now,inputs,state}={}){
  return{state:state&&typeof state==="object"?state:{},variants:{}};
}
