# BTC decision policy governance

## Live policy

`btc-decision-suite-v1` is **frozen as of 2026-07-19**. It contains three versioned contracts:

- `btc-model-policy-v1`: block weights, critical coverage, regime bands, detector thresholds and hysteresis;
- `btc-allocation-policy-v1`: the ladder and allocation overlays below;
- `btc-execution-policy-v1`: the existing generic rebalance, timing, cash and no-leverage rules.

- Base ladder: `0 / 5 / 20 / 45 / 95 / 100` percent of the user-defined BTC limit `B`.
- Confirmed recovery floor: `80%`, blocked by a fired macro-shock detector.
- Capitulation floor: `40%` at MVRV percentile `≤10`.
- Euphoria cap: `60%` at MVRV percentile `≥95`.
- Emergency overrides every floor; insufficient data produces no target.

The executable sources of truth are [`docs/model-policy-v1.mjs`](docs/model-policy-v1.mjs),
[`docs/policy-v1.mjs`](docs/policy-v1.mjs), and
[`docs/execution-policy-v1.mjs`](docs/execution-policy-v1.mjs). The collector makes the final
server-side decision. The browser never recalculates allocation; it displays the decision, its
quality status and a short decision hash. `scripts/policy-suite-lock-test.mjs` pins the full suite,
including the exact executable text of the allocation and detector functions plus SHA-256 digests
of the economically material scoring, regime and hysteresis code.

The euphoria cap is deliberately classified as a safety rule. It had no real triggers in the
audited historical window and must not be described as a validated alpha source until sufficient
forward observations exist.

## Historical recalibration is disabled

Files under `backtest/` are a frozen research archive. Their outputs may validate or monitor a live
policy, but they are not configuration and are never read by the live engine or frontend. Re-running
a backtest must not change live thresholds, weights, overlays, or allocation targets.

Do not edit `policy-v1` in response to new historical results. A future policy change requires:

1. a new immutable `policy-vN` contract, leaving every earlier contract reproducible;
2. a written decision record with the objective, risk budget and pre-declared acceptance metrics;
3. genuinely new out-of-sample or forward shadow evidence, not another optimization on 2013–2026;
4. explicit owner approval and a separately reviewable release.

Data-source repairs, schema validation and display fixes may continue without creating a new policy
when they do not alter the economic decision rule. Any change that can alter the target allocation
for the same valid input snapshot is a policy change.

## Forward/OOS evidence and pre-declared review

The live snapshot stores an append-only, hash-chained decision log and daily as-collected evidence.
Every input packet has an observed time, fetch time, data hash and schema hash. If a provider rewrites
the same vintage, changes overlapping historical rows while appending a new observation, or changes
schema, the event is recorded rather than silently treated as the value that was known earlier.
The current UTC-day partition is explicitly treated as open: its normal intraday updates are not
historical revisions. Once a row's UTC day has closed, a change to that row is retained as revision
evidence in the audit log. A time-series restatement alone does not lower the operational quality of
the current packet; schema changes and non-temporal same-vintage rewrites do.
Public hashes prove that recorded inputs did not change and reproduce the final allocation; full raw
provider payloads remain in the rolling internal cache and cannot be reconstructed from the public
snapshot alone.

Policy v1 is monitored prospectively against the previous policy in shadow mode plus buy & hold,
fixed 50% BTC, cash and a simple trend/25%-volatility benchmark. Results include FRED DTB3 converted
from Treasury-bill discount basis to an effective annual yield using a 91-day convention, 10 bps per
full turnover, turnover, net return, drawdown, volatility and excess Sharpe.
Formal reviews occur at 90, 180 and 365 days. Results before 90 days are collection evidence, not a
performance verdict.

Investigation begins after 180 days if policy v1 trails the best simple benchmark by at least 0.25
Sharpe or fixed 50% BTC by at least 10 percentage points of net return. A retirement candidate is
possible only after at least 365 days and two actual changes in `target_pct` (tactical/state-only
changes do not count), and only if all three conditions hold:

1. excess Sharpe trails the best simple benchmark by at least 0.25;
2. maximum drawdown is at least 5 percentage points worse than fixed 50% BTC;
3. net return trails fixed 50% BTC by at least 10 percentage points.

These conditions raise a review; they never auto-recalibrate thresholds or auto-install policy v2.
Operational failures—stale public snapshots, policy-hash mismatch, an unreproducible decision,
failed critical coverage, a missing actionable target, or drift/missing files in the published HTML
and policy modules—pause the displayed action and open/update a GitHub incident through the
independent two-hour monitor.

Personal position sizing remains outside this contract; percentages retain their existing meaning as
a share of the user-defined BTC risk limit `B`.

## Policy v2 candidate (shadow, 2026-07-22)

`btc-decision-suite-v2-candidate` ([`docs/policy-v2-candidate.mjs`](docs/policy-v2-candidate.mjs))
runs **in shadow only**: the live target is still produced by frozen v1; the candidate's target,
its graduation state, the R1/R2/R3 review triad and the divergence record are published under
`monitoring.v2_candidate` / `monitoring.v2_review`, and its NAV is tracked as the
`policy_v2_shadow` strategy next to a `static_theta` benchmark (the policy's own realized average
exposure — the honest null).

The candidate changes exactly three things, each backed by the adversarial policy challenge of
2026-07-22 (76 agents; every high-confidence claim verified by two independent lenses):

1. **Directional resolution rule.** Risk-on transitions (the recovery floor) must be confirmed by
   UTC daily closes — the resolution the backtests actually tested; risk-off stays instant, where
   the hourly/daily gap works toward safety. v1 executed the floor on a single hourly tick, a
   semantics no backtest ever covered.
2. **Time-graduated recovery floor 40/60/80** by consecutive daily closes with the detector good
   (statistically indistinguishable from the instant 80 floor, p≈0.76, while removing the +60pp
   single-tick jump). Rejected with measurements, do not resurrect: strict `>0` legs (misses
   2019-03, fwd90 +222%), leg-count graduation (top rung never occurred in 14 years),
   dwell filters ≥5 days (cut fwd30 from +10.2% to +0.5%).
3. **Review triad R1/R2/R3** replacing v1's investigate/retirement rules, whose measured
   diagnostic power was zero and inverted (a broken "always 100%" policy alarmed *less* often than
   the healthy one; 44.5% false-alarm days). R1 protection test: in any 180d window where HODL
   drawdown ≤ −25%, the policy drawdown must stay ≤ 0.7× (historically 0% false alarms, 100% catch
   of disabled protection); R2 timing vs `static_theta` over 365d (net-return gap ≥10pp AND excess
   Sharpe gap ≥0.35, both machine-evaluated); R3 upside capture in bull windows. Persistence is
   denominated in **review days** (UTC-day changes), never in collector invocations. Every
   criterion must pass a power test against broken variants — R1, R2 and R3 power tests are part
   of the candidate's test suite. `static_theta` runs as a trailing mean of the policy's own
   targets until the first formal review (day 90) and is then **frozen, re-fixed only at review
   boundaries** — a continuously drifting Θ would lag-copy the policy and lose R2's power.

The ladder, weights, gates and verdict hysteresis are unchanged; the mid-ladder values are hereby
documented as **ordinal, not optimal** (plateau: deteriorating 10–35 / transition 30–60 within
0.06 Sharpe in-sample) and must not be re-tuned on the same history. The capitulation floor in the
candidate additionally requires agreement of the 4-year and the **full available depth** MVRV
windows (no truncation; the deep window needs ≥1200 points and a last observation ≤5 days old —
otherwise it is honestly null and the floor falls back to the single 4-year window, i.e. v1
behavior, with `v2_candidate.inputs.deep_window_used` recording the state). The euphoria cap
stays single-window (a safety rule is not weakened). A day confirms the recovery detector only if
the detector is good at the day's **last observation and on the majority of its observations** —
a lone late-night tick cannot confirm a day. The candidate's target, graduation state and deep
percentile are hashed into every decision-log record (`v2` block), so shadow evidence is
reproducible from the ledger.

**Pre-declared acceptance (switch to v2 requires all):** ≥90 shadow days; shadow Sharpe ≥ v1 − 0.10;
≥1 recovery episode observed in shadow or ≥180 days elapsed; green tests and zero operational
incidents attributable to the candidate; explicit owner approval in a separate release.
**Falsified if** the shadow trails v1 by >0.25 Sharpe over ≥120 days — the candidate is then
rejected and the record kept. Shadow evidence never recalibrates v1.
