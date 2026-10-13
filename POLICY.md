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
the current packet; schema changes and non-temporal same-vintage rewrites do — **unless the packet
merely bounced back to a state already seen within the last 24 hours**. A provider oscillating
between two values of the same vintage, or a schema returning to its pre-outage shape once the
provider recovers, is dither rather than a revision: the current packet is exactly as healthy as it
was before, so the event stays in the provenance log (`source_bounce: true`) but no longer degrades
the decision. The window is deliberately short — this answers "is the packet healthy *now*", unlike
the 90-day memory in the notification layer, which answers the different question "is this news to
the reader". Measured on 15 days of production: 2 of 31 degraded ticks reclassified, no genuine
revision suppressed.
Public hashes prove that recorded inputs did not change and reproduce the final allocation; full raw
provider payloads remain in the rolling internal cache and cannot be reconstructed from the public
snapshot alone.

Policy v1 is monitored prospectively against the previous policy in shadow mode plus buy & hold,
fixed 50% BTC, cash and a simple trend/25%-volatility benchmark. Results include FRED DTB3 converted
from Treasury-bill discount basis to an effective annual yield using a 91-day convention, 10 bps per
full turnover, turnover, net return, drawdown, volatility and excess Sharpe.

Since the 2026-10-10 audit the monitor executes a target only when the decision passes the same
display gate as the page: a paused decision holds the previous share. Volatility and Sharpe are
computed on closed UTC days. Lines born on different days are compared on their common window, both
opened at its start (`monitoring.comparisons`). The honest timing null is `monitoring.timing_null`:
a constant share equal to the policy's own time-weighted average exposure over the same window,
computed in retrospect, with the gap to buy & hold split exactly into exposure level, timing and
costs. One more line measures what a reader following the panel literally gets —
`policy_v1_tranched`: downgrades immediately, upgrades in three equal tranches, one per UTC day, the
first on the first snapshot at or after 06:00 UTC of the next day. The tranche count is a
measurement convention, not a policy rule.

Checkpoints occur at 90, 180 and 365 days. Day 90 is not a performance review: the code only freezes
`static_theta`, and the v2 acceptance window opens once the shadow itself is 90 days old. The v1
investigation rule is first evaluated on day 180; R1 needs about 150 days of data, R2 about 300.
Results before those dates are collection evidence, not a performance verdict.

Investigation begins after 180 days if policy v1 trails the best simple benchmark by at least 0.25
Sharpe or fixed 50% BTC by at least 10 percentage points of net return. A retirement candidate is
possible only after at least 365 days and two actual changes in `target_pct` (tactical/state-only
changes do not count), and only if all three conditions hold:

1. excess Sharpe trails the best simple benchmark by at least 0.25;
2. maximum drawdown is at least 5 percentage points worse than fixed 50% BTC;
3. net return trails fixed 50% BTC by at least 10 percentage points.

The investigation rule is part of the frozen contract and keeps being computed as written, but its
measured diagnostic power is nil: on the 2014–2026 reconstruction it fires on 56% of runs of the
healthy policy and on 47% of runs of an "always 100%" policy. The monitor therefore publishes the
numbers against the thresholds (`monitoring.health.performance_numbers`), and the page shows those
numbers rather than a bare status code.

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
`policy_v2_shadow` strategy next to `static_theta`, a trailing mean of the policy's daily targets
kept for continuity. The honest timing null is `monitoring.timing_null` (see above).

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
   of disabled protection); R2 timing vs the honest null — a constant share equal to the policy's
   own time-weighted average exposure over the same 365d window (net-return gap ≥10pp AND
   excess-Sharpe gap ≥0.35 on closed days, both machine-evaluated; on the 2014–2026 reconstruction
   it catches delayed timing in 63% and inverted timing in 76% of runs at 22% false alarms and
   never fires on a constant share); R3 upside capture is published as a reference number and sets
   no status — it fired on 57% of healthy runs. Persistence is denominated in **review days**
   (UTC-day changes), never in collector invocations. Every criterion must pass a power test
   against broken variants — the power tests are part of the candidate's test suite.
   Revision 2 (2026-10-10) no longer uses `static_theta` in R2: until day 90 it was a lagged copy
   of the policy (average exposure 26.6% against 32.9%), which showed the timing shortfall as
   4.4pp instead of 8.0pp.

4. **Minimum interval between risk-off confirmations** (pre-declared 2026-07-28 after the 15-day
   production audit). v1 counts downgrade confirmation in *snapshots* ("2 in a row") while the
   cadence is irregular: median 59.7 min, but 66 of 464 observed intervals were under 10 minutes
   (dual scheduler, manual runs, push+dispatch). On 2026-07-24 this materialised — the move to
   "defensive" was confirmed in 24 minutes instead of the ~2 hours a normal cadence implies. v2
   requires the confirming risk-off snapshot to be at least `risk_off_min_confirm_minutes` (30)
   later than the **first counter snapshot of the streak** (revision 2, 2026-10-10: since
   2026-08-07 the cadence is 15 minutes, so "apart from the previous snapshot" was true on every
   run and a downgrade could never be confirmed; measured from the first counter snapshot an
   hourly cadence is never delayed and a 15-minute cadence confirms one run later);
   45 was considered and rejected (same benefit, less headroom over the observed cadence). This
   rule is **not executed by the shadow and does not affect its NAV** — verdict hysteresis lives in
   the frozen v1 section and the shadow rides on v1's published regime. Until a switch it is only
   declared, while `monitoring.shadow_hysteresis` accumulates forward evidence (how many downgrades
   were confirmed faster than the minimum). The threshold has a single source of truth in the
   candidate contract; the monitor maintains the counter itself, by the same definition.

The ladder, weights, gates and verdict hysteresis are unchanged; the mid-ladder values are hereby
documented as **ordinal, not optimal** (plateau: deteriorating 10–35 / transition 30–60 within
0.06 Sharpe in-sample) and must not be re-tuned on the same history. The capitulation floor in the
candidate additionally requires agreement of the 4-year and the **full available depth** MVRV
windows (no truncation; the deep window needs ≥1200 points and a last observation ≤5 days old —
otherwise it is honestly null and the floor falls back to the single 4-year window, i.e. v1
behavior, with `v2_candidate.inputs.deep_window_used` recording the state). The euphoria cap
stays single-window (a safety rule is not weakened). A day confirms the recovery detector only if
the detector is good at the day's **last observation and on the majority of its observations**
(strictly more than half; exactly half does not confirm) — a lone late-night tick cannot confirm a
day. The candidate's target, graduation state and deep
percentile are hashed into every decision-log record (`v2` block), so shadow evidence is
reproducible from the ledger.

**Pre-declared acceptance (switch to v2 requires all):** ≥90 shadow days counted from the shadow's
own birth (2026-07-22 09:03:56 UTC); shadow Sharpe ≥ v1 − 0.10 on the common window (closed UTC
days where both lines exist); ≥1 recovery episode observed in shadow — a run of consecutive days on
which the graduated floor held the shadow target above its ladder rung — or ≥180 days elapsed;
green tests and zero operational incidents attributable to the candidate; explicit owner approval
in a separate release.
**Falsified if** the shadow trails v1 by >0.25 Sharpe over ≥120 days — the candidate is then
rejected and the record kept. Shadow evidence never recalibrates v1.

The 2026-10-10 audit found three defects in how these criteria were *computed* (not in the criteria
themselves) and they are fixed: the episode counter required the shadow target to exceed the v1
target, which is impossible by construction (0 episodes were published against two actual ones);
shadow days were counted from the monitor's start rather than the shadow's; the Sharpe gap compared
lines over different windows (+0.40 published, +0.36 on the common window). With the counter fixed
the machine status reaches `switch_ready_pending_owner` on 2026-10-20 instead of 2027-01-15. That
status means "the pre-declared criteria are met"; it installs nothing. What the owner should weigh
before acting on it: 61% of the shadow's advantage over v1 was earned in the 22–24 July episode the
candidate was designed after, only two episodes began after its creation, and the noise of a Sharpe
gap over 90 days is 0.19 — at a true difference of zero the −0.10 threshold fails in 30% of cases.

## Policy v3 candidate (shadow, 2026-10-10)

`btc-decision-suite-v3-candidate` ([`docs/policy-v3-candidate.mjs`](docs/policy-v3-candidate.mjs))
runs **in shadow only**, next to v2: the live target is still produced by frozen v1. It collects
what the 2026-10-10 audit showed to be measurement artifacts in the decision rule. The ladder
`0 / 5 / 20 / 45 / 95 / 100`, the ±20 block bands, the set of voting families, the gate tree with
the downgrade anchored on demand, the valuation gate, the macro-shock cap and the 40% capitulation
floor are unchanged.

| Rule | v1 | v3 candidate | Why |
|---|---|---|---|
| Clock | every snapshot (15 minutes since 2026-08-07): downgrade after 2 snapshots, upgrade after 48 hours and ≥12 snapshots without a single counter snapshot | once per UTC day, on the first snapshot at or after 06:00 UTC: worse — on that fix, better — on the second consecutive fix with the same candidate; emergency is immediate | the backtest evaluated the regime daily; in production the meaning of the hysteresis changed with the collector's cadence, and 12 one-or-two-snapshot flips in 83 days reset a running upgrade seven times |
| Hashrate leg | last daily point vs the point 90 days earlier | 30-day mean vs the 30-day mean ending 90 days earlier | one daily estimate carries 8% noise, a difference of two — 12% against a 10pp scale step |
| Exchange flow leg | FlowIn − FlowOut over 7 days | 7-day change of the exchange balance | since 2026-05-05 the provider's flows diverge from its own balance every day in one direction |
| "Cheap" valuation (+1 score, recovery anchor, capitulation floor) | one rolling 4-year window | agreement of the 4-year window and the full history since 2010; honest fallback to one window if the deep series is short or stale | the 2022 bottom leaves the 4-year window by January 2027 and the thresholds rise with no change in the market |
| Trend | live price against averages that include today's unclosed candle | last closed day — the same age as MVRV | the floor was switched on by inputs of different ages |
| Recovery floor | 80% on a single snapshot | 40 / 60 / 80 by consecutive fixes with the detector good (the v2 graduation) | one reading should not move the target by 60pp |
| Euphoria cap, distribution detector | present | removed | neither can fire by construction |

**What history says, and what it cannot say.** Evidence, as for every rule here, is the same
2013–2026 reconstruction the policy was calibrated on (10 bps per full turnover): it describes, it
does not prove. Two tables are kept, because they answer different questions; all numbers are annual
return / excess Sharpe / max drawdown.

*The archive's daily grid* (`backtest/eval6.mjs`: an observation is known on the day it is dated,
a decision trades on the next close) — since 2013, since 2018-06 and in the ETF era (2024-03+):
v1 — 43.0 / 1.39 / −40.8, 33.7 / 1.15 / −40.8, 17.5 / 0.74 / −15.5; the candidate —
43.0 / 1.41 / −40.4, 33.2 / 1.16 / −38.6, 17.4 / 0.75 / −15.5. On the convention v1 was fitted with,
the two are indistinguishable.

*The candidate's own clock* (`backtest/eval7.mjs`: the position changes at the 06:00 UTC fix by
hourly prices; macro inputs and the CFTC report become available when they are published, as in
production) — since 2018-06 and in the ETF era: v1's own rules on the same daily fix —
42.3 / 1.37 / −33.7 and 21.4 / 0.91 / −15.8; the candidate — 40.3 / 1.34 / −28.1 and
20.9 / 0.90 / −14.8. On the same clock the candidate gives up about 2pp a year since 2018 and takes
a drawdown shallower by 5.6pp; in the ETF era the difference is half a point. The cost is two-window
valuation (−2.5pp a year, drawdown −28.5 against −33.7) and the graduated floor (−0.9pp); the other
changes are neutral. The composition was chosen by the logic of measurement, not by the best
result: v1 was calibrated on this history, the candidate was not fitted to it. Its case is not past
return but that the rule stops depending on the collector's cadence, on the noise of one point, on
an inconsistent series and on a window that loses the 2022 bottom in 2027 — and that is testable
only forward. Most of the gap between the two tables' v1 rows (33.7 → 42.3) is execution time,
which a daily fix gives to any rule set; whether a daily clock beats v1's 15-minute clock cannot be
read from history at all — there is no intraday history of the inputs — and is measured only
forward, by `v1_daily_close`.

On the 83 live days (2026-07-19 … 10-10) the candidate would have returned +4.0% against +1.4% for
v1, with turnover 175% against 545%; the daily clock alone (`v1_daily_close`) gives +3.9%, so on
this window the rule changes add nothing on top of the clock. It met both large moves of
that window at a 20% share, as v1 did. The numbers are reproducible with `backtest/eval6.mjs`,
`backtest/eval7.mjs`, `scripts/variants-history.mjs` and `scripts/variants-replay.mjs`; the full
decision record lives in the contract module.

**Why 06:00 UTC, and what it reads.** By 06:00 UTC yesterday's MVRV, exchange balance and ETF flows
and the closed daily candle are in. Macro inputs on the fix are older than the closed day: daily
FRED series for a business day are published on the next business day (VIX and credit spreads in
the 14th–16th hour UTC, H.15 rates in the 21st; an hour later in winter), so on Sunday and Monday
the fix reads Thursday's values; the broad dollar index is published once a week, on Mondays, and
is 3–10 days old. The observation dates are published with every fix
(`monitoring.v3_candidate.inputs.observed`), and a stress input more than four days behind the
closed day is flagged. The hour was checked on history with hourly prices and the publication
calendar (candidate since 2018-06): fix at 06:00 — 40.3 / 1.34 / −28.1; at 12:00 —
39.3 / 1.32 / −28.4; at 18:00 — 34.4 / 1.18 / −36.9; at 23:00, after the rates are out, —
35.9 / 1.23 / −34.3. An early fix with older macro beats a late fix with fresher macro. Macro age
is not free: with macro known on its observation date the 06:00 fix would give 41.2 / 1.37 / −30.7,
and 24.6% a year against 20.9% in the ETF era; most of that is the weekly publication of the dollar
index. On the 83 live days the hour of the fix alone moved the result of `v1_daily_close` from
+0.1% to +9.2%: one window cannot rank fix hours.

Rejected with measurements, do not resurrect inside the candidate:

- **CFTC family not voting.** On the archive's daily grid the policy without the family is better
  in every window (40.9 / 1.37 against 33.7 / 1.15 since 2018-06) — but the archive dates the
  report by its cut-off day, and it is published three days later. On the candidate's clock with
  the report available after publication: 44.3 / 1.45 / −37.7 against 42.3 / 1.37 / −33.7 since
  2018-06, and 20.2 / 0.83 against 21.4 / 0.91 in the ETF era. Shifting the report by 0–14 days
  moves the result of v1's rules from 41.0% to 47.3% a year since 2018-06 and from 16.7% to 23.6%
  in the ETF era — more than the presence of the vote itself. History does not identify the
  family's contribution; in the candidate it votes as in v1, and the hypothesis runs as the
  separate line `v1_no_cftc`.
- Keeping the recovery floor after the valuation anchor is lost (Sharpe not higher in any window —
  it runs as the separate line `v1_floor_handoff`); requiring a strictly positive confirmation leg
  (no gain; loses March 2019); moving the downgrade anchor from demand to macro (Sharpe 1.07–1.16
  against 1.15).

Three **attribution lines** run beside the candidate, each changing exactly one rule of v1, so that
forward evidence shows what each change is worth on its own: `v1_daily_close` (the daily clock
only), `v1_floor_handoff` (the 80% floor stays while at least two confirmations hold and there is
no macro shock, even after valuation recovers), `v1_no_cftc` (CFTC not voting).

**Pre-declared acceptance (switch to v3 requires all):** ≥180 shadow days; ≥3 episodes in which the
candidate's target differed from `v1_daily_close` — v1's rules on the same clock (runs of daily
rows; against `policy_v1` itself a daily line diverges on every intraday change of v1's target, and
the clock alone would satisfy the count: on the 83 live days `v1_daily_close` diverged from v1 in
6 episodes without any rule change, the candidate diverged from `v1_daily_close` in 6); the
candidate's timing component against its own constant share not worse than v1's on the common
window; maximum drawdown deeper than v1's by no more than 5pp; green tests and zero operational
incidents attributable to the candidate; explicit owner approval in a separate release.
**Falsified if** the candidate's net return trails v1 by more than 10pp over a common window of
≥180 days. A Sharpe-gap criterion is deliberately absent (see the noise figure above).
v2 and v3 are alternatives, not stages: at most one of them replaces v1, and v3 already contains
the v2 floor graduation.

**Operational properties of the shadow lines.** The monitor executes a target only when the
decision passes the panel's display gate. This includes the emergency override: with decision
quality `paused` the panel shows the emergency strip together with "no new actions", and the
monitor holds the previous share — it tracks what the panel told the owner to do. Whether the
emergency override should bypass the quality gate is a rule of the frozen v1 action gate, not of
the monitor. A run of the previous release (a rollback) leaves a gap in the accounting of the
lines introduced with v2.14.0; on return they are restarted from that moment
(`monitoring.line_restarts`), and the candidate's 180 shadow days are counted anew.

## Shadow layer: declared statements

Each of the eight non-voting cards has one statement declared in advance
([`docs/shadow-hypotheses-v1.mjs`](docs/shadow-hypotheses-v1.mjs), 2026-10-10): a condition on the
card's value, a horizon and the expected sign of the difference in BTC forward return between days
when the condition holds and days when it does not. Card values are written into the monitor's
daily rows, and `monitoring.shadow_evidence` keeps the count — days, completed observations, mean
forward return for both groups, number of non-overlapping blocks. `gold_axis` has no directional
statement. The monitor only counts; no vote is granted or withdrawn by this tally. The short-term
verdict, which no backtest could reconstruct, is scored the same way: `monitoring.tactical_forward`
holds the 7-day forward return of BTC by tactical state.
