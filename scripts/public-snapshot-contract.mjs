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

// Forecast the largest public file allowed by all retention settings, using the most
// recent row of each log as a conservative size sample. Static audit calls this on the
// compacted representation, including while migrating an older un-compacted snapshot.
export function projectedPublicSnapshotBytesV1({ snapshotBytes, snapshot, dailyLimit, decisionLogLimit, historyMaxRows = HISTORY_MAX_ROWS }) {
  const daily = snapshot?.monitoring?.daily || [];
  const decisions = snapshot?.monitoring?.decision_log || [];
  const history = snapshot?.history || [];
  const addedBytes = (rows, limit) => rows.length ? Math.max(0, limit - rows.length) * jsonBytesV1(rows.at(-1)) : 0;
  return snapshotBytes +
    addedBytes(daily, dailyLimit) +
    addedBytes(decisions, decisionLogLimit) +
    addedBytes(history, historyMaxRows);
}
