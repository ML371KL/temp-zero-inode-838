/*
 * BTC decision suite v3 — боевой набор правил с выпуска 2.15.0.
 *
 * Набор ничего не считает сам. Он называет, чем принимается боевое решение:
 *   - баллы семей и блоков — запертые разделы модели v1 (docs/model-policy-v1.mjs, locked_sections);
 *   - режим, полы и доля — движок docs/policy-v3-candidate.mjs ревизии 2, без единой правки
 *     (суточный фикс, хешрейт по 30-дневным средним, «дёшево» по согласию двух окон MVRV,
 *     тренд по закрытому дню, пол восстановления 40/60/80, без потолка эйфории и «Дистрибуции»);
 *   - исполнение — docs/execution-policy-v1.mjs.
 *
 * Прежний набор btc-decision-suite-v1 не изменён и продолжает считаться: он даёт баллы семей и
 * ведётся в мониторе отдельной линией. Любая правка движка или этого файла меняет contract_sha256;
 * правило, меняющее цель при тех же входах, — новый набор, а не правка этого.
 */

import { POLICY_V3_CANDIDATE, allocationDecisionV3, blockScoresV1Port, dailyHysteresisStepV3, fixClockV3, macroShockStateV1Port, mvrvDeepPercentileV3, recoveryStateV1Port, scoreExchangeSupplyV3, scoreNetworkV3, scoreTrendV3, scoreValuationV3, strategicCandidateV1Port, strategicCriticalV1Port } from "./policy-v3-candidate.mjs";
import { MODEL_POLICY_V1 } from "./model-policy-v1.mjs";
import { EXECUTION_POLICY_V1 } from "./execution-policy-v1.mjs";

const deepFreeze=value=>{if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};

// Запись решения (POLICY.md: смена правила требует письменной записи и явного согласия владельца).
export const POLICY_SUITE_V3_DECISION_RECORD=deepFreeze({
  approved_by:"owner",
  approved_at:"2026-11-20",
  objective:"Убрать из боевого решения измерительные артефакты v1: счёт гистерезиса в снимках при дневных данных, переключение полов на одном снимке, пороги «дёшево» по одному скользящему окну.",
  basis:"Аудит 2026-11-20. Порог пола капитуляции v1 (10-й перцентиль MVRV за четыре года) вырос с 0,95 в январе 2026 до 1,20 в ноябре: из окна вышло дно 2022 года. Все прежние срабатывания пола приходились на MVRV 0,77–0,98; 2026-11-19 он включился при 1,18. За 124 суток форварда 9 смен цели из 20 — включение и выключение полов.",
  what_is_installed:"Кандидат v3 ревизии 2 как объявлен 2026-10-10 и пересмотрен 2026-11-09. Ничего сверх него.",
  waived_criteria:[
    {criterion:"shadow_days >= 180",state_at_decision:"37 суток",reason:"Дефекты v1 логические и видны без статистики. Разброс разницы «политика минус постоянная доля» за 124 суток на реконструкции — от −14,7 до +16,0 п.п. (5-й и 95-й перцентили): форвард такой длины версии не различает."},
  ],
  not_installed:[
    "зазор пола капитуляции (вход на 10-м перцентиле, выход на 15–20-м): в кандидате его нет, в тени правило не жило",
    "удержание пола восстановления после ухода якоря оценки: проверено 2026-10-10, на истории без результата; ведётся линией v1_floor_handoff",
  ],
  expectation:"На истории кандидат не обгоняет правила v1: на одних часах отдаёт около 2 п.п. годовых и берёт просадку мельче на 5–6 п.п. Ожидаемый эффект — меньше смен цели без экономической причины, а не рост доходности.",
  review:"Прежний набор ведётся линией policy_v1_frozen; результат боевой линии сравнивается с ней, с «тремя средними» и с постоянной долей.",
});

export const POLICY_SUITE_V3=Object.freeze({
  id:"btc-decision-suite-v3",
  version:3,
  status:"live",
  approved_at:POLICY_SUITE_V3_DECISION_RECORD.approved_at,
  historical_recalibration:"disabled",
  supersedes:"btc-decision-suite-v1",
  decision_engine_id:POLICY_V3_CANDIDATE.id,
  decision_engine_revision:POLICY_V3_CANDIDATE.revision,
  // SHA-256 текста docs/policy-v3-candidate.mjs (переводы строк LF). Сверяется замок-тестом: движок
  // целиком, включая неэкспортируемый шаг линии, входит в обязательство набора.
  engine_module_sha256:"8a3f1aec058428a65065fff7b59bd2637c788bbf1cdc1434623040ac71ddd3c0",
  model_policy_id:MODEL_POLICY_V1.id,
  execution_policy_id:EXECUTION_POLICY_V1.id,
  contract_sha256:"8bee895487aece7561e2aa347f205b36b3800bf13fa82987b6ea29b084e422ab",
});

const source=fn=>fn.toString().replace(/\r\n/g,"\n");

export function policySuiteContractV3(){
  const{id,version,supersedes,decision_engine_id,decision_engine_revision,engine_module_sha256}=POLICY_SUITE_V3;
  return{
    suite:{id,version,supersedes,decision_engine_id,decision_engine_revision,engine_module_sha256},
    engine:POLICY_V3_CANDIDATE,
    engine_code:{
      allocationDecisionV3:source(allocationDecisionV3),
      dailyHysteresisStepV3:source(dailyHysteresisStepV3),
      fixClockV3:source(fixClockV3),
      scoreValuationV3:source(scoreValuationV3),
      mvrvDeepPercentileV3:source(mvrvDeepPercentileV3),
      scoreTrendV3:source(scoreTrendV3),
      scoreNetworkV3:source(scoreNetworkV3),
      scoreExchangeSupplyV3:source(scoreExchangeSupplyV3),
      strategicCandidateV1Port:source(strategicCandidateV1Port),
      strategicCriticalV1Port:source(strategicCriticalV1Port),
      blockScoresV1Port:source(blockScoresV1Port),
      recoveryStateV1Port:source(recoveryStateV1Port),
      macroShockStateV1Port:source(macroShockStateV1Port),
    },
    model:MODEL_POLICY_V1,
    execution:EXECUTION_POLICY_V1,
    decision_record:POLICY_SUITE_V3_DECISION_RECORD,
  };
}

export function policySuiteMetadataV3(){return{...POLICY_SUITE_V3};}
