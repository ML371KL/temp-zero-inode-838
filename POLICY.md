# BTC allocation policy governance

## Live policy

`btc-allocation-policy-v1` is **frozen as of 2026-07-19**.

- Base ladder: `0 / 5 / 20 / 45 / 95 / 100` percent of the user-defined BTC limit `B`.
- Confirmed recovery floor: `80%`, blocked by a fired macro-shock detector.
- Capitulation floor: `40%` at MVRV percentile `≤10`.
- Euphoria cap: `60%` at MVRV percentile `≥95`.
- Emergency overrides every floor; insufficient data produces no target.

The executable source of truth is [`docs/policy-v1.mjs`](docs/policy-v1.mjs). Both the snapshot engine
and the browser import that module. `scripts/policy-lock-test.mjs` pins the complete contract and a
behaviour matrix in CI.

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
