# Eval rubric — frozen 2026-10-12, before any scored run

This file defines what "good lead" means and how runs are scored. It is frozen: any change after the first scored run gets a dated note at the bottom and the affected runs are re-scored.

## 1. Unit of judgment: one lead

A lead = (company, signal URL, why-now claim) accepted by `checkLead`. Each is scored on three questions, each **yes / no / cannot verify**:

| Q | Question | Yes requires |
|---|---|---|
| Q1 Fit | Is the company the kind the contract asked for? | A cited source (the company's own site, LinkedIn page, or a press page) that confirms the required gate(s). For ICP 1: provides logistics services to other businesses as its primary activity; a brand/retailer running its own warehouses is **no**. |
| Q2 Size | Is the company inside the size band? | A cited source with a headcount or employee range inside the band, or within 25% of a boundary. |
| Q3 Signal | Is the why-now real, specific and inside the window? | The signal URL loads, names this company, describes the claimed event (facility / funding / hiring wave / launch), and the **event** date is inside the recency window. A job post counts only if it is on the company's own site or names ≥2 roles. |

**Good lead = Q1 yes AND Q3 yes AND Q2 ≠ no.** (Q2 "cannot verify" is tolerated once per run; a second unverifiable size in the same run is scored as no.)

Every verdict records the source URL used. Verdicts without a source are invalid.

## 2. Run-level metrics

| Metric | Definition |
|---|---|
| good_leads | count of good leads |
| precision | good_leads / accepted leads |
| cost_per_good_lead | (Exa + Claude spend) / good_leads; ∞ if 0 |
| latency | wall-clock active time, p50 and p95 across runs |
| stop_reason | target / budget / turns / time / no_progress / finish / error |
| adaptive_actions | query rewrites + lookups skipped + verification reads (agent arms only) |
| handback_quality | if a handback was issued: did applying suggestion #1 and re-running yield ≥1 more good lead? |

## 3. Pass criterion and pass^k

A run **passes** if `good_leads ≥ 6` AND `precision ≥ 0.8` AND `spend ≤ maxCostDollars`.

Each scenario × arm runs k = 3 times with the same contract. Report:
- `pass@1` = passes / 3
- `pass^3` = 1 if all 3 pass, else 0 (the headline: a user needs it to work every time)
- plus the mean of each run-level metric

## 4. Arms and scenarios

Arms: **A** workflow (`runProspecting`), **B** agent on `claude-opus-5-5`, **C** agent on `claude-sonnet-5-5`. Same contract, same budget cap, same day.

Scenarios: S1 ICP-1 logistics (fixture), S2 ICP-3 funded B2B + first ops hire (fixture), S3 and S4 generated from two real seller sites via the card flow (chosen before the pilot; recorded in `eval/truth/scenarios.md`).

## 5. Judging procedure

1. Accepted leads from all arms of a scenario are pooled, shuffled, and stripped of arm labels (`eval/judge/blind.ts`).
2. An Opus judge scores each lead on Q1–Q3 with this rubric and must cite a URL per answer; "cannot verify" is allowed.
3. I spot-check ≥ 20% of verdicts (and every "cannot verify") against the sources; disagreements are resolved by the source, and the judge's prompt is fixed if the error is systematic.
4. Verdicts are written to `eval/truth/<scenario>/<company>.json` so re-runs reuse them.

## 6. Agency check (agent arms only)

An agent run with `adaptive_actions = 0` is flagged **workflow-shaped**. It still counts toward pass^k, but the README must report the share of flagged runs.

## 7. Known limits of this rubric

- n = 3 per cell is small; it detects "fails sometimes", not fine-grained rates.
- Judging relies on public pages; private companies with no headcount online will often be "cannot verify" on Q2.
- Scenarios S3/S4 depend on the planner; a bad plan lowers every arm equally, which is the point of sharing the contract.

## Change log

- 2026-10-12: frozen.
- 2026-10-12: judging unit clarified as (company, signal_url); verdict reuse limited to the same window
