// Storage contract for the public snapshot. This is deliberately separate from the
// allocation/model policies: changing the representation must never change a decision.
export const PUBLIC_SNAPSHOT_MAX_BYTES = 3_000_000;
export const HISTORY_RETENTION_DAYS = 730;
export const HISTORY_HOURLY_DAYS = 14;
export const HISTORY_MAX_ROWS = HISTORY_RETENTION_DAYS + HISTORY_HOURLY_DAYS * 24;

const HISTORY_DECISION_FIELDS = [
  "state_hash",
  "decision_hash",
  "status",
  "base_target_pct",
  "target_pct",
  "binding_overlays",
  "quality",
];

// history[].decision used to repeat policy_id, policy_hash and the whole target ladder
// on every hourly row. Those immutable values live at snapshot.policy/policy_components;
// the exact forward record and its hash chain live in monitoring.decision_log. Keep only
// the fields needed to explain and verify the historical decision shown by the dashboard.
export function compactHistoryEntryV1(entry) {
  if (!entry || typeof entry !== "object" || !entry.decision || typeof entry.decision !== "object") return entry;
  const decision = {};
  for (const key of HISTORY_DECISION_FIELDS) {
    if (entry.decision[key] !== undefined) decision[key] = entry.decision[key];
  }
  return { ...entry, decision };
}

export const jsonBytesV1 = value => Buffer.byteLength(JSON.stringify(value));

// Byte budget for the published history array. The row COUNT retention (days) cannot bound the
// file alone: individual rows grow as the schema evolves, and the steady-state projection then
// breaches the hard cap and deadlocks publication (the 02:50–04:50 2026-07-21 failures, same class
// c913472 fixed). The collector drops the OLDEST rows first — they are the least decision-relevant —
// until the published form fits, so retention becomes «N days OR the byte budget, whichever is smaller».
// Budget derivation against PUBLIC_SNAPSHOT_MAX_BYTES (3.0 MB), measured on the live snapshot
// 2026-07-21: monitoring.daily at limit 370×~3.1KB ≈ 1.15 MB + decision_log 400×~1.06KB ≈ 0.42 MB
// + non-history base ≈ 0.31 MB → ~1.88 MB steady-state without history. 1.0 MB history budget keeps
// ~0.1 MB of slack at every limit simultaneously; a larger budget re-opens the deadlock dead zone.
export const HISTORY_BYTE_BUDGET = 1_000_000;
export function boundedPublicHistoryV1(history, { budget = HISTORY_BYTE_BUDGET, minRows = 48 } = {}) {
  const rows = [...(history || [])];
  const rowBytes = rows.map(h => { const { raw, ...p } = h; return jsonBytesV1(p) + 1; });
  let total = rowBytes.reduce((a, b) => a + b, 1);
  let drop = 0;
  while (rows.length - drop > minRows && total > budget) { total -= rowBytes[drop]; drop++; }
  return { history: rows.slice(drop), trimmed: drop };
}

// Forecast the largest public file allowed by all retention settings, using the most
// recent row of each log as a conservative size sample. Static audit calls this on the
// compacted representation, including while migrating an older un-compacted snapshot.
export function projectedPublicSnapshotBytesV1({ snapshotBytes, snapshot, dailyLimit, decisionLogLimit, historyMaxRows = HISTORY_MAX_ROWS }) {
  const daily = snapshot?.monitoring?.daily || [];
  const decisions = snapshot?.monitoring?.decision_log || [];
  const history = snapshot?.history || [];
  const addedBytes = (rows, limit) => rows.length ? Math.max(0, limit - rows.length) * jsonBytesV1(rows.at(-1)) : 0;
  // History growth is bounded by the collector's byte budget, not by row count alone: future rows
  // beyond the remaining budget will be evicted oldest-first, so they cannot enlarge the file.
  const historyGrowth = Math.min(addedBytes(history, historyMaxRows), Math.max(0, HISTORY_BYTE_BUDGET - jsonBytesV1(history)));
  return snapshotBytes +
    addedBytes(daily, dailyLimit) +
    addedBytes(decisions, decisionLogLimit) +
    historyGrowth;
}
