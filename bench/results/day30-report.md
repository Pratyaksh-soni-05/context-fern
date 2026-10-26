# Day-30 gate report — Stage 2 (local LLM escalation)

Branch: `feat/router-stage2`. Data: `bench/data/scrubbed/streams.jsonl` (spliced/synthetic, not natural). Model: `qwen3:8b` via Ollama, local, free, `think:false`. All numbers below are real measurements from this branch's runs, not projections, except where explicitly marked ESTIMATE.

## 1. Ceiling check (120 rows, Claude as blind judge)

`bench/ts/ceiling-sample.ts` sampled 60 `new` and 60 `continue` rows from `streams.jsonl`, blind (no truth label). Claude judged each row "topic switch" vs "continue" with no access to `action_truth`. Scored against `bench/results/ceiling-answer-key.json`.

| | predicted new | predicted continue |
|---|---|---|
| **truth new** (n=60) | 52 | 8 |
| **truth continue** (n=60) | 13 | 47 |

- Claude ceiling: **F1(new) = 0.832**, accuracy = 0.825
- Stage 0 (router) on the identical 120 rows: **F1(new) = 0.395**, accuracy = 0.617
- Gap (ceiling − Stage 0): **+0.437 F1**

This bounds how much of the `new`-detection gap is unfixable label ambiguity vs. router weakness: most of it is router weakness. A human-equivalent judge gets 0.83; Stage 0 alone gets 0.40. The task is learnable — the current router isn't close to the data's own ceiling.

## 2. Stage 2 sample (500 rows, stratified by variant and action_truth)

### 2.1 Always-escalate vs Stage 0 alone, same 500 rows

| system | n | F1 new | F1 return | F1 stray | escalation rate |
|---|---|---|---|---|---|
| Stage 0 alone | 471 | 0.615 | 0.398 | 0.484 | 0% |
| Always-escalate (qwen3:8b forced on all) | 471 | 0.357 | 0.388 | 0.526 | 100% |

qwen3:8b alone, with no gating, is **worse than Stage 0 alone on `new`** (0.357 vs 0.615) and about the same on `return`. It only helps on `stray` (0.526 vs 0.484).

Latency/cost (always-escalate): Stage 0 p50/p95 = 0.0/0.0 ms (embedding-cache hit); Stage 2 p50/p95 = 2745.8/6215.6 ms. Journal: 500 real calls, avg input tokens = 1333, avg output tokens = 55.

### 2.2 Escalation-band simulation (ESTIMATE)

Each row's `stage0_confidence`/`stage0_predicted_action` (Stage 0's own pre-escalation call, preserved on every row regardless of band) is sliced to simulate a gated run at any confidence band, from the single always-escalate pass. This assumes Stage 2's choices don't change the router's state trajectory for later turns — not true in a real run — so every number in this table is an **estimate**, not a measurement of an actual gated run.

| band | escalation rate | F1 new | F1 return | F1 stray |
|---|---|---|---|---|
| [0.0, 1.0] (= always-escalate) | 100.0% | 0.357 | 0.388 | 0.526 |
| [0.25, 0.5] | 42.2% | 0.638 | 0.394 | 0.516 |
| **[0.0, 0.3] (best)** | **22.4%** | **0.643** | 0.404 | 0.515 |
| [0.3, 0.6] | 52.6% | 0.627 | 0.406 | 0.508 |
| [0.4, 0.7] | 42.4% | 0.629 | 0.374 | 0.484 |
| [0.5, 0.8] | 19.2% | 0.598 | 0.398 | 0.476 |

No band in this sweep clears both literal spec §16 bars (F1 new ≥ 0.85, F1 stray ≥ 0.80).

### 2.3 Day-30 gate verdict

This data is spliced/synthetic, not natural. Per `docs/decisions.md`, the gate on spliced data is "within 0.05 F1 of the measured ceiling," not the literal spec §16 numbers (those apply to natural, hand-labelled data, which doesn't exist yet).

- Ceiling: F1(new) = 0.832 → bar = 0.832 − 0.05 = **0.782**
- Best achieved (hybrid, band [0.0, 0.3]): F1(new) = **0.643**
- **Result: FAIL.** 0.643 is 0.139 below the ceiling-relative bar, and the gap to the literal spec bar (0.85) is even larger.

## 3. Precision-first analysis (same 500 rows)

Two-tier score per row: `confidence` if the system's own predicted action equals the target class, else 0. "base" = the system's unthresholded categorical decision (its real recall/precision with no further filtering). Raising the threshold can only trade recall away from that base point, never add recall the categorical decision didn't already have. Hybrid = Stage 0 outside confidence band (0.0, 0.3), qwen3:8b's own call inside it (the empirically best band from §2.2).

### 3.1 Cue phrases alone (no model, no router — exact `hasAnyCue()` substring match)

| class | precision | recall | tp | fp | fn | tn |
|---|---|---|---|---|---|---|
| new | 0.438 | 0.048 | 7 | 9 | 138 | 317 |
| stray | 0.000 | 0.000 | 0 | 17 | 30 | 424 |

Cue phrases alone catch almost nothing (recall 0.048 for `new`, 0.000 for `stray`) — they are not usable as a standalone detector.

### 3.2 Stage 0 alone

**new:**

| tau | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| base | 0.758 | 0.517 | 75 | 24 | 70 |
| 0.880 | 0.870 | 0.414 | 60 | 9 | 85 |
| 0.915 | 1.000 | 0.372 | 54 | 0 | 91 |
| 1.000 | 1.000 | 0.345 | 50 | 0 | 95 |

Smallest tau with precision ≥ 0.85: **tau = 0.880, precision = 0.870, recall = 0.414.**

**stray:**

| tau | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| base | 0.469 | 0.500 | 15 | 17 | 15 |
| 0.203 | 0.556 | 0.500 | 15 | 12 | 15 |
| 0.350 | 0.652 | 0.500 | 15 | 8 | 15 |
| 0.464 | 0.750 | 0.500 | 15 | 5 | 15 |
| 0.603 | 0.882 | 0.500 | 15 | 2 | 15 |
| 0.885 | 1.000 | 0.500 | 15 | 0 | 15 |
| 1.000 | 1.000 | 0.100 | 3 | 0 | 27 |

Smallest tau with precision ≥ 0.85: **tau = 0.603, precision = 0.882, recall = 0.500.**

### 3.3 Hybrid (Stage 0 + qwen3:8b in confidence band [0.0, 0.3])

**new:**

| tau | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| base | 0.667 | 0.621 | 90 | 45 | 55 |
| 0.854 | 0.750 | 0.497 | 72 | 24 | 73 |
| 0.902 | 0.903 | 0.386 | 56 | 6 | 89 |
| 0.915 | 0.982 | 0.372 | 54 | 1 | 91 |
| 1.000 | 1.000 | 0.345 | 50 | 0 | 95 |

Smallest tau with precision ≥ 0.85: **tau = 0.902, precision = 0.903, recall = 0.386.**

**stray:**

| tau | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| base | 0.472 | 0.567 | 17 | 19 | 13 |
| 0.603 | 0.586 | 0.567 | 17 | 12 | 13 |
| 0.938 | 0.412 | 0.233 | 7 | 10 | 23 |
| 0.978 | 0.778 | 0.233 | 7 | 2 | 23 |
| 1.000 | 0.714 | 0.167 | 5 | 2 | 25 |

**No threshold reaches precision ≥ 0.85** for `stray` with the hybrid system (best observed: 0.778).

### 3.4 Precision-first summary

| system | class | best tau for precision≥0.85 | precision | recall |
|---|---|---|---|---|
| Stage 0 alone | new | 0.880 | 0.870 | 0.414 |
| Stage 0 alone | stray | 0.603 | 0.882 | 0.500 |
| Hybrid (+qwen3:8b) | new | 0.902 | 0.903 | 0.386 |
| Hybrid (+qwen3:8b) | stray | — | — (best 0.778) | — |

Stage 0 alone reaches precision ≥ 0.85 for both classes at a real but partial recall (41–50%). Adding qwen3:8b in its best band does not improve on this: it reaches precision ≥ 0.85 for `new` at slightly lower recall (0.386 vs 0.414) than Stage 0 alone, and never reaches 0.85 for `stray` at all.

## 4. Decision

Day-30 gate failed with free local models; Claude ceiling 0.83 shows the task is learnable. Default becomes manual fronds + cue phrases + high-precision suggestions. Auto mode deferred as an optional strong-model path.

- Stage 0 alone, thresholded for precision ≥ 0.85, is the only system in this report that is viable as a **suggestion** source today (not an auto-router): tau=0.880 for `new` (recall 0.414), tau=0.603 for `stray` (recall 0.500).
- qwen3:8b (local, free, 8B) does not clear the gate alone or gated with Stage 0, and does not beat a precision-thresholded Stage 0 alone. It is not a free path to the day-30 gate.
- Cue phrases alone are not a usable detector (recall ≈ 0 on both classes) — useful only as a human-facing hint, not a signal to route on.
- Context Fern's default behaviour moves to manual-first: explicit frond commands and cue-phrase hints, with the router only surfacing suggestions above the measured precision threshold. Stage 2 (LLM escalation) becomes an optional, off-by-default path for users who point it at a stronger model than what ran in this report.
