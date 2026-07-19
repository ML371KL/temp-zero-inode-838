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
