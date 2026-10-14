# Eval detail

Detail moved out of the README. Every number comes from the file named next to it, or is marked "author's log".

## Pre-pilot smoke run

`eval/recordings/agent-icp1-2026-10-12/agent/` (ICP-1 logistics, arm B, one run, before the pilot).

| Turns | Tool calls | Spend (Exa + Claude) | Accepted | Good (author's manual read against the rubric, not the blind judge) | Lookups skipped | Query rewrites | Verification reads |
|---|---|---|---|---|---|---|---|
| 12 | 43 | $0.87 ($0.455 + $0.417) | 6 | 5 | 41 | 2 | 0 |

The author's read is not stored per lead in a file.

## What the agent did that the workflow could not

From the smoke run's `events.jsonl`:

1. **Strategy before spend.** At turn 1 it proposed three angles and wrote its own first queries, for example *"UK 3PL logistics company opens new distribution centre warehouse"*, with an estimate of $0.95. Actual spend: $0.87.
2. **Skipped lookups.** On turn 3 it skipped 15 names before any lookup, including *Walmart, Maersk, XPO, CEVA Logistics, A. Duie Pyle*. The S1 workflow accepted A. Duie Pyle in rep 2 on an unverified size estimate.
3. **One rewrite after trouble.** After the first batch surfaced mostly large firms, it searched *"independent family-owned 3PL warehousing company opens new warehouse, hiring dozens of workers"*, then looked up *Metropolitan Warehouse and Delivery* (541 staff, quoted), accepted at turn 5. Its todo recorded *"hiring ads (mostly giant firms)"*.

## S2 agent misses (6 non-good slots across 3 reps)

From `eval/truth/S2/`:

- **Q1 no, wrong stage (2):** Miter (rep 1) and Sybill (rep 2) passed the "recently raised seed or Series A" gate, but the judge found later-stage funding.
- **Q2 (3):** Scaffold (rep 3) is outside 30–200 staff. SubBase (reps 1 and 3) was the run's second "cannot verify" on size; the rubric tolerates one per run, and OuterSignal (all 3 reps) used it.
- **Q3 not verifiable (1):** Henry AI (rep 2). The judge's fetch of the signal page failed and it found no corroborating source.

No agent lead failed Q3 for an out-of-window event. All 5 pooled S2 workflow leads cite a LinkedIn URL, and the 4 not-good ones fail Q3; one agent miss (Sybill) is LinkedIn-hosted and failed on Q1.

Next iteration, not built:
1. Make the funding round a quoted fact checked in code, as size already needs its quoted source (`size_basis`).
2. Exclude `linkedin.com` as a signal host.

## Judging history

- Judge: Opus 5.5 with web search (max 3) and web fetch (max 2) (`eval/harness/judge.ts`).
- The first, search-only version (v2) could not open signal pages and scored S1 8/22 and S2 10/23 good. Re-judging its Q3 "cannot verify" verdicts with fetch (8 in S1, 6 flipped to good; 9 in S2, 5 flipped) gave 14/22 and 15/23. Superseded verdicts are kept as `*.prev.json` (FAILURES #10, RUBRIC change log).
- Human spot-checks: 10 of 45 verdicts (22%), `eval/truth/SPOT-CHECKS.md`. All 10 agree with the final verdicts; the one that disagreed with v2 (RGL Logistics) triggered the fetch fix.

## What the build cost

About $40 in total:
- **Exa ≈ $14** (author's log). Files back $11.22: $7.68 for the 12 pilot cells (`run.json`), $1.89 for three recordings (`icp1-2026-10-11` $0.887, `icp1-2026-10-11b` $0.55, the smoke run's Exa $0.455), and at least $1.64 for the three crashed S2 workflow cells ($0.548 each in their error text, FAILURES #7).
- **Claude agent and planner ≈ $8** (author's log). Files back $2.38: $1.96 for the pilot and $0.42 for the smoke run.
- **Judging: $14.39 recorded.** Search-only pass $8.64 (`S1/judge-cost.json` $4.08 + `S2/judge-cost.json` $4.56); fetch re-judges $5.75 (sum of `costDollars` over the 17 `v3-fetch` verdicts).
- **≈ $3.50 lost** to the first judge run, which parsed 0 of 22 verdicts and left no record (author's log, FAILURES #8).
- Live walkthroughs after that: deposco.com $0.73 (`eval/recordings/live-deposco-2026-10-13/state.json`), public smoke $0.83 run / $0.88 ledger (`eval/recordings/public-smoke-2026-10-13.txt`).

## Live quote gates run (2026-10-14)

`eval/results/live-quotes-2026-10-14/` (report `report.md`, cells under `S1|S2/B_agent_opus/{1,2}`), recordings in `eval/recordings/live-quotes-2026-10-14/`. Agent arm only (Opus 5.5), S1 and S2, 2 reps each, $1.00 cap, after the evidence-required gates (`522252a`). Rep 1 ran before the quote-matcher fix (`5e88d4f`), rep 2 after it. Not a pilot repeat: no workflow arm, 2 reps, so no pass^3.

| Scen. | Rep | Leads | Good | Precision | Spend (Exa + Claude) | Time | Stop | Skips / rewrites / verification reads |
|---|---|---|---|---|---|---|---|---|
| S1 | 1 | 4 | 4 | 1.00 | $0.872 ($0.456 + $0.416) | 275 s | finish | 60 / 9 / 2 |
| S1 | 2 | 6 | 5 | 0.83 | $0.853 ($0.483 + $0.370) | 319 s | finish | 47 / 9 / 0 |
| S2 | 1 | 0 | 0 | n/a | $0.565 ($0.314 + $0.251) | 177 s | finish | 12 / 2 / 2 |
| S2 | 2 | 3 | 3 | 1.00 | $0.820 ($0.475 + $0.345) | 281 s | finish | 21 / 5 / 1 |

Run spend total $3.11. Counters from each `run.json` `adaptive` field; verification reads are 2, 0, 2, 1, against 0 in 8 of the 9 earlier recorded runs (README §2 flaw 1). Cells fail the pilot pass bar (6 good leads) in all four: `pass` is "no" in `report.md`.

**Judge.** Opus 5.5 with web search and fetch (`v3-fetch`, same as the pilot's final pass). Verdicts are keyed by company and signal URL, so a lead already judged is not judged again. Of the 13 lead-reps, 6 (Wagner x2, Hollingsworth x2, RBW, Clueso) came from 4 verdicts written on 2026-10-14, which cost $1.38 together (sum of `costDollars`). The other 7 reuse verdicts written on 2026-10-13 (Metropolitan, FreezPak, RGL, RK, Verst, Avarra, Agave): same company and signal URL, but the judge's date reference was 2026-10-12. The ≈ $3.02 judge spend quoted in the session is not traceable to files; only $1.38 is.

**Per-lead verdicts** (`eval/truth/S1/`, `eval/truth/S2/`). Q1 fit, Q2 size, Q3 signal. Good = Q1 yes, Q3 yes, Q2 not no (RUBRIC §1; one Q2 cannot-verify per run is tolerated).

| Scen. | Rep | Company | Signal host | Q1 | Q2 | Q3 | Good |
|---|---|---|---|---|---|---|---|
| S1 | 1 | Metropolitan Warehouse and Delivery | re-nj.com | yes | yes | yes | yes |
| S1 | 1 | Wagner Logistics | www.prnewswire.com | yes | yes | yes | yes |
| S1 | 1 | Hollingsworth Logistics | northatlantastar.com | yes | yes | yes | yes |
| S1 | 1 | FreezPak Logistics | www.refrigeratedfrozenfood.com | yes | cannot_verify | yes | yes (the run's one tolerated Q2 cannot-verify) |
| S1 | 2 | Wagner Logistics | www.prnewswire.com | yes | yes | yes | yes |
| S1 | 2 | Hollingsworth Logistics | northatlantastar.com | yes | yes | yes | yes |
| S1 | 2 | RGL Logistics | thebusinessnews.com | yes | yes | yes | yes |
| S1 | 2 | RK Logistics Group | www.einpresswire.com | yes | yes | yes | yes |
| S1 | 2 | RBW Logistics | rbwlogistics.com | yes | yes | yes | yes |
| S1 | 2 | Verst Logistics | www.lanereport.com | yes | **no** | yes | **no** |
| S2 | 2 | Clueso | www.unite.ai | yes | yes | yes | yes |
| S2 | 2 | Avarra.ai | www.prnewswire.com | yes | yes | yes | yes |
| S2 | 2 | Agave | www.businesswire.com | yes | yes | yes | yes |

S2 rep 1 accepted no lead, so it has no rows. Total 12 good of 13 (0.92). n = 13 cannot test a 98% bar: even 13 of 13 gives a 95% Wilson lower bound of 0.77.

**The miss: Verst Logistics, Q2.** The gate accepted it on a size quote "Employees: 507" copied from Exa's company profile (`evidence.company_lookup.employee_estimate_source` in S1 rep 2's `run.json`); the S1 range is 100–1000. The judge's Q2 is "no", with source `builtin.com/company/verst-logistics`. The verdict file stores no reasoning or number, so what the right headcount is cannot be read from the repo. The same signal URL was accepted in all 3 pilot agent reps, so Verst is a known size miss that the quote gates did not catch (FAILURES #23).

**Recall.** 0 to 6 leads per run (0 to 5 good), against 7 to 10 accepted (6 to 9 good) per pilot agent run. Lookups now fetch page text and a quote that is rejected costs a turn. S2 rep 1's handback lists 11 rejections for "funding round or business type couldn't be confirmed from the company's public profile"; rep 1 predates the matcher fix, so some of those are the matcher, not the pages.

## Why signal-first (kept from v1)

Exa's `category: "company"` search rejects `startPublishedDate`, so a company search cannot be date-filtered (probed on the live API). Freshness is what the buyer needs, so both arms search dated news and job pages for the **trigger**, then look up the named company for size, HQ and type. Claude decides what to ask; every fact in the output comes from Exa (SPEC-v2 §1).

## Langfuse

Offline evals live in Langfuse Datasets and Experiments (project "My Project", environment `eval`). The repo is the source of truth, and Langfuse is the view. How it works: [SPEC-observability §4](SPEC-observability.md#4-offline-evals-langfuse-datasets-and-experiments-l1).

| What | Where | Count |
|---|---|---|
| Dataset `prospector-scenarios` | [cloud.langfuse.com/…/datasets/cmv7hfwfm00x2ad0j9e5fpycl](https://cloud.langfuse.com/project/cmv6skia0015xad0efzgcpwzz/datasets/cmv7hfwfm00x2ad0j9e5fpycl) · `eval/datasets/prospector-scenarios.jsonl` | 2 (S1, S2; kind task-outcome) |
| Dataset `prospector-cases` | [cloud.langfuse.com/…/datasets/cmv7hfxbd012tad0ea9y2wfx3](https://cloud.langfuse.com/project/cmv6skia0015xad0efzgcpwzz/datasets/cmv7hfxbd012tad0ea9y2wfx3) · `eval/datasets/prospector-cases.jsonl` | 30: reliability 12, policy 3, safety-adversarial 3, tool-use 2, quality 5, escalation 2, cost 2, task-outcome 1 |
| Pilot experiment runs | [cloud.langfuse.com/…/experiments](https://cloud.langfuse.com/project/cmv6skia0015xad0efzgcpwzz/experiments): `pilot-2026-10-12:<arm>:r<rep>` | 6 runs (A_workflow, B_agent_opus × r1–r3) × 2 items (S1, S2) = 12 items |
| Agent turn traces of the pilot | Sessions in environment `eval`, one per agent run id (backfilled from `events.jsonl`) | 6 sessions, 77 turn traces |

**Scores on each item:** `good_leads`, `precision`, `cost_per_good_lead` (left out for the two S2 workflow reps with 0 good leads), `pass`, `stop_reason` and `workflow_shaped`. The agent items also get the 8–9 applicable code graders (`caps_respected`, `approval_before_spend`, `tool_order`, …), and all of them pass. Every one of the 55 accepted agent leads has `judge_q1`/`judge_q2`/`judge_q3`/`judge_good` on its `tool:submit_lead` observation, next to the existing `gate_verdict`. `judge_good` is the raw verdict: 48 of 55. The run-level `good_leads` applies RUBRIC §1's "one Q2 cannot-verify per run" rule, which turns SubBase (S2 reps 1 and 3) into not-good, so the 6 agent runs total 46. The two numbers measure different things and are both correct.

**Why 6 runs and not one run with 12 items.** Langfuse assumes each dataset item appears once per experiment run (no repetitions). So one run = one arm × one rep. To see the workflow and the agent side by side per scenario, open the Experiments page and Compare, e.g. `:A_workflow:r1` against `:B_agent_opus:r1`.

**Reproduce ($0):**

```
npx tsx eval/langfuse-sync.ts                  # datasets; a second run: created 0 · updated 0
npx tsx eval/langfuse-import-pilot.ts          # re-score (must equal report.json), backfill, runs; a second run: 0 written
```

Future paid evals land there directly: `npm run eval:cell -- … --langfuse-experiment <set>` writes each cell's item as it finishes, and `npm run eval:score -- --set <set> --langfuse-experiment <set>` adds the judged scores.
