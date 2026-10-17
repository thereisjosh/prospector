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

## Memory eval

**Status: run twice on S1 (2026-10-15).** First run FAIL (old quote gate), rerun PASS (gate fixed in 43e44ae). Results below; the harness, the report and a $0 dry run are tested in `eval/memory-eval.test.ts`.

**Question.** Does what the agent remembers from run A change what run B finds, and is the change good? Workspace memory (`src/agent/memory.ts`) carries three things into the next run through `recall()`: every company already seen (the gate rejects them and `lookup_company` skips the paid lookup), the user's feedback, and the agent's own `remember` notes. This eval measures the first and third; there is no user feedback in it.

**Design.** Three agent cells (Opus agent, scenario S1, $1.00 cap each), run in this order by `eval/memory-eval.ts`:

| Cell | Rep | Workspace | Memory at start |
|---|---|---|---|
| A | 1 | `mem-eval-<set>-S1` | empty (cleared first) |
| B | 2 | `mem-eval-<set>-S1` | what A left behind (seen companies, A's self-notes) |
| B' (control) | 3 | `mem-eval-<set>-S1-control` | empty (cleared first) |

B' exists because B is a second run of the same scenario, and a second run differs from the first even with no memory. B' is a fresh run, so B vs B' isolates memory; A vs B alone would not. The cells go through `runCell` with the new `workspaceId` option (`--workspace` on `eval/harness/run-cell.ts`): the cell loads the workspace's memory, builds its run with `recall()` exactly as `eval/run-agent.ts` does, and the loop appends to the memory at stop. `run.json` records `workspaceId`, `memoryBefore` (the memory file as the run saw it) and `memoryRecalled` (the `memory_recalled` event summary). Each cell is Exa-recorded under `eval/recordings/<set>/<rep>` and written to Langfuse as an experiment item in `<set>`. Workspace ids must start `mem-eval-` or `eval-` or the cell refuses to run, so the eval cannot touch a real (UUID-named) workspace; they live in `WORKSPACES_DIR` (default `./workspaces`).

After the cells, the leads are pooled blind and judged with the existing judge, which reuses any verdict already keyed by company and signal URL, so only new (company, signal) pairs are paid for. `eval/results/<set>/report.md` has one row per cell:

| Metric | How it is computed |
|---|---|
| leads, good (judged) | leads in `run.json`; good = the judge's verdict (Q1 and Q3 yes, Q2 not no). A lead with no verdict is counted as unjudged, never as bad |
| new vs A | B leads whose company A did not deliver |
| lookups skipped | `lookup_company` events carrying `seen` |
| Exa $ saved | lookups skipped x $0.009 (`COST_ESTIMATE.companyLookup`, list price) |
| notes written / recalled | successful `remember` calls / notes in the `memory_recalled` event's included set |
| dead-query overlap | distinct normalised queries of the run that A ran and that returned no accepted lead (a query counts as productive when an accepted company is named in its result line) |
| spend, cost per good lead | `run.json` spend (Claude + Exa) and spend / good. Judge spend is reported beside the table |

The memory file after A and after B is written next to the report (`memory-after-A.json`, `memory-after-B.json`).

**Pass rule.** PASS if B skipped at least 2 lookups AND every B lead is new vs A AND good(B) >= good(B') - 2. Otherwise FAIL, and the report names which clause failed. Two additions the rule does not state, both failing safe: B with zero leads fails (nothing to be new or good), and any B or B' lead without a verdict fails (good cannot be compared). The 2 is the pilot's noise: S1 good-lead counts across three reps of the same agent were 9, 7 and 6, so a difference of 2 is inside run-to-run variation and cannot count as memory hurting. By the same token a PASS on one S1 triple shows the mechanism works (memory is recalled, skips happen, B finds new companies); it does not show that B is better, because n = 1 per cell cannot resolve a difference smaller than the noise.

**Cost.** Up to $3 of cells (3 x the $1.00 cap; the pilot's agent cells ran $0.52 to $0.87) plus the judge at about $0.19 to $0.34 per new (company, signal), so roughly 8 to 25 leads cost $2 to $8 to judge. `--max-dollars` (default 4) guards the cells only: before each cell, if spend so far plus that cell's cap would pass the limit, the eval stops there (exit code 2) and writes no report; the cells already run stay on disk.

**Commands.**

```
# $0: the real loop, recall and memory code against a scripted model, canned Exa and a canned judge.
# Writes to a temp directory only; API and Langfuse keys are blanked.
npx tsx eval/memory-eval.ts --set memory-eval-2026-10-15 --scenario S1 --dry-run

# Paid:
npx tsx eval/memory-eval.ts --set memory-eval-2026-10-15 --scenario S1 --max-dollars 4
```

A single cell in a workspace, for debugging: `npm run eval:cell -- --set <id> --scenario S1 --arm B --rep 1 --workspace mem-eval-<id>-S1`.
### Results (2026-10-15, scenario S1)

**Run 1, `memory-eval-2026-10-15` (old gate): FAIL.** `eval/results/memory-eval-2026-10-15/report.md`.

| run | leads | good (judged) | new vs A | lookups skipped | Exa $ saved | notes written | notes recalled | dead-query overlap | cache share | spend | $ / good lead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5 | 5 | - | 0 | $0.0000 | 1 | 0 | - | 0.88 | $0.7984 | $0.1597 |
| B | 1 | 1 | 1/1 | 2 | $0.0180 | 1 | 1 | 0/12 | 0.91 | $0.8043 | $0.8043 |
| B' (control) | 8 | 8 | 4/8 (info) | 0 | $0.0000 | 0 | 0 | 0/13 | 0.90 | $0.8596 | $0.1074 |

good(B) = 1 is more than 2 below good(B') = 8. The cause was not memory: B lost 5 lookups to `quote_not_in_page` and 7 to `fetch failed`, so it had little to submit (FAILURES #25, `eval/results/quote-replay-2026-10-15.md`). B did skip 2 lookups, and its one lead was new, and it recalled A's note. B' repeated 4 of A's companies (Wagner Logistics, FreezPak Logistics, ColdTrack, RGL Logistics), which is what an empty workspace does and what memory is meant to prevent. Judge spend $4.1088.

**Run 2, `memory-eval-2026-10-15b` (gate fixed in 43e44ae): PASS.** `eval/results/memory-eval-2026-10-15b/report.md`.

| run | leads | good (judged) | new vs A | lookups skipped | Exa $ saved | notes written | notes recalled | dead-query overlap | cache share | spend | $ / good lead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 7 | 3 | - | 0 | $0.0000 | 0 | 0 | - | 0.89 | $0.8796 | $0.2932 |
| B | 8 | 8 | 8/8 | 2 | $0.0180 | 1 | 0 | 0/11 | 0.91 | $0.8542 | $0.1068 |
| B' (control) | 6 | 6 | 4/6 (info) | 0 | $0.0000 | 1 | 0 | 0/11 | 0.92 | $0.8453 | $0.1409 |

PASS: B skipped 2 lookups, 8 of 8 B leads are new vs A, good(B) 8 vs good(B') 6. The fix mattered: retries recovered 5 network errors and 1 quote reject across the three runs.

**Reading.**

- The mechanism works: B is told what A saw, skips 2 paid lookups, and every one of its 8 leads is a company A did not deliver, while the control B', which has no memory, repeats 2 of A's 6 (4/6 new). Cost per good lead is $0.107 for B against $0.141 for B'.
- It does not show that B is better than a fresh run. n = 1 per cell, and the pass rule tolerates a 2-lead difference because that is the pilot's run-to-run noise (S1 good counts 9, 7, 6). 8 vs 6 is inside it.
- Notes recalled is 0 in the rerun because A wrote no note (below), so the self-note path was exercised in run 1 only (B recalled 1), not in the PASS run. What B's 8/8 rests on is the seen-company list, not A's lessons.
- Run A's 3 good of 7 is a precision problem, not a memory result. The 4 bad leads all failed Q3: three were job-board listings (NXTPoint Logistics on snaprecruit.com, Fetch Package on jobs.capitalfactory.com, Port City Logistics on jobtarget.com) and one was Constellation Cold Logistics, whose BBC article of 2026-08-27 reports a council approval the judge dated to early June 2026, before the window opened on 2026-07-15. The job-board hole was fixed after this run (a URL-shape rule plus three domains, FAILURES #26) and replayed on every judged lead ($0, 3 bad caught, 1 good lost: Jay Group, a single thejobsmap.com post that the rubric would not count, `eval/results/gate-replay-2026-10-15.md`); it has not been re-measured live. Constellation is not caught by any deterministic rule.

**Spend.** Cells: $2.46 (run 1) and $2.58 (run 2). Judge: $4.1088 for run 1 as the report states. For run 2 the report's $5.8616 counts every verdict file attached to the pooled leads, including verdicts reused from run 1; the 7 verdicts written in the rerun (judgedAt 2026-10-15T11:xx in `eval/truth`) sum to $2.7223 in `costDollars`, which is the rerun's new judge spend (the earlier $2.38 was an estimate).

**Why run A wrote no self-note.** The `remember` offer is not in the loop. It lives in the `finish` tool handler (`src/agent/tools.ts`, the `tool.name === "finish"` branch): the first `finish` call with no notes yet and at least one lead (or a handback) is answered "Not finished yet ... save it now with `remember`", sets `state.rememberNudged`, and the run continues; the second `finish` ends it. A run that stops on a limit never calls `finish`. `src/agent/loop.ts` `limitReason()` stops on budget (spend plus the handback reserve reaching the cap), max turns, active time, no progress or target, and `finishRun()` then builds the handback itself (`handback()` or `codeHandback()`); none of those paths touches the nudge. Run A of the rerun stopped on `budget` with no `remember` call and `rememberNudged` unset in its `state.json`, so the nudge never had a chance to fire. In the same set B also stopped on budget, and wrote a note on its own initiative (1 `remember` call, nudge unset); B' stopped on `finish` and also holds one note with the nudge unset (it saved one before finishing, so the nudge condition was already false). In run 1, B' stopped on budget with no note; A and B finished with a note. So a budget-stopped run leaves a lesson only if the model volunteers it. This is documented, not changed: the loop is not part of this change. The effect on the eval is that a budget-stopped A starves B's recall of notes.


## Contact eval (2026-10-16)

Step 2 of the contacts build order (docs/RESEARCH-contacts-and-graph.md §6): measure contact precision. Runner `eval/contact-eval.ts`, judge `eval/harness/judge-contacts.ts`, cases `eval/datasets/contact-cases.jsonl`, results `eval/results/contact-eval-2026-10-16/`, Exa recordings `eval/recordings/contact-eval-2026-10-16/`.

**Design.** Company set: every distinct company judged GOOD in eval/truth/S1 and S2 (lead = company + signal_url), company URL taken from a recorded enrichment (`state.json` `caches.enrichmentByName[squash(company)].url`, any run under eval/results or eval/recordings). Capped at 25, companies with a URL first, alternating S1/S2 (S1 alone has 22 URL-bearing good companies and would fill the cap; S2 would get 3). Buyer roles: S1 = VP of Operations, COO, Head of Warehousing, Director of Logistics; S2 = Head of Sales, VP of Revenue, Founder, COO (the S2 contract is funded B2B, so the buyer is a revenue leader or the founder). Each company runs `findContacts` under one shared `CostGuard(1.00)` (`input.guard`); the run stops cleanly when the guard refuses. Every contact is appended to contact-cases.jsonl with `label: null` (the judge or a human fills it; the case schema now allows null).

**Run summary** (25 companies run, 0 errors, guard never refused):

| companies run | skipped | contacts | verified | inferred | Exa spend | per company | p50 latency |
|---|---|---|---|---|---|---|---|
| 25 (13 S1, 12 S2) | 11 (1 no URL: Reo.Dev; 10 over cap) | 72 | 45 | 27 | $0.475 | $0.019 | 14.4 s |

Companies with zero contacts: Hollingsworth Logistics. Companies with only inferred: King of Freight, Monk.

**Judge, one contact.** The judge asks "is <name> currently <title> at <company>?" with web_search (max 3) and web_fetch (max 2), may reason first, and its verdict is the LAST JSON block of the reply (FAILURES #8). It never sees the tier. Each verdict records cost, searches, fetches, `judgedAt` and the masked raw reply. Run `--tier verified --limit 1`: Karim Fofana, "Chief Operating Officer", Capacity LLC (tier verified) -> `current: yes`, source https://www.capacityllc.com/the-capacity-difference/team/ (company team page; press page and ZoomInfo agree), cost $0.1447 (2 searches, 0 fetches). Verdict: `eval/results/contact-eval-2026-10-16/contacts-v1-2026-10-16T12-52-10-257Z.jsonl`. Nothing else was judged.

**Projected judge cost** (one measured call, $0.1447): all 45 verified contacts about $6.51; all 72 contacts about $10.42. One call is a thin sample (it used no fetch and 2 of 3 searches), so treat as +/-40%.

## Smallest model per job (2026-10-16)

Question: which model is the smallest that does each job well enough? Measured where it was cheap to measure, and marked "not evaluated" where it was not. Defaults were unchanged (Opus 5.5 everywhere) until the 3-rep confirmation below; **the agent loop default became Sonnet 5.5 on 2026-10-17** (DECISIONS #26). Every number below comes from the file named next to it.

### Agent loop: Sonnet 5.5 vs Opus 5.5 vs Kimi K2.6

Set `kimi-vs-sonnet-2026-10-16` (S1 and S2, arms C_agent_sonnet and D_agent_kimi, **n = 1 per cell**, $1.00 cap; report `eval/results/kimi-vs-sonnet-2026-10-16/report.md`, cells `.../{S1,S2}/{C_agent_sonnet,D_agent_kimi}/1/run.json`). The 20 new leads were judged blind by the Opus judge on 2026-10-16 (verdicts in `eval/truth/{S1,S2}/*.json` with `judgedAt` after 14:00Z).

| Scenario | Model | Source | n | Leads | Good | Precision | $/good | p50 ms | Spend (Exa + Claude) | Stop |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Sonnet 5.5 | kimi-vs-sonnet | 1 | 8 | 7 | 0.88 | $0.126 | 212,883 | $0.881 ($0.621 + $0.260) | budget |
| S1 | Kimi K2.6 | kimi-vs-sonnet | 1 | 4 | 3 | 0.75 | $0.186 | 374,886 | $0.559 ($0.427 + $0.132) | max_active_ms |
| S1 | Opus 5.5 | pilot-2026-10-12 | 3 | 7 to 10 | 7.33 mean (9, 7, 6) | 0.88 | $0.118 | 132,147 | $0.81 to $0.85 per rep | target / budget / finish |
| S1 | Opus 5.5 | live-quotes-2026-10-14 | 2 | 4, 6 | 4.5 mean (4, 5) | 0.92 | $0.194 | 275,128 | $0.85 to $0.87 per rep | finish, finish |
| S2 | Sonnet 5.5 | kimi-vs-sonnet | 1 | **10 of 10** | **9** | 0.90 | $0.068 | 157,569 | $0.609 ($0.454 + $0.155) | target_leads |
| S2 | Kimi K2.6 | kimi-vs-sonnet | 1 | 6 | 5 | 0.83 | $0.122 | 386,361 | $0.610 ($0.486 + $0.124) | max_active_ms |
| S2 | Opus 5.5 | pilot-2026-10-12 | 3 | 10, 10, 10 | 8.00 mean (8, 8, 8) | 0.80 | $0.090 | 102,122 | $0.52 to $0.85 per rep | target_leads x3 |
| S2 | Opus 5.5 | live-quotes-2026-10-14 | 2 | 0, 3 | 1.5 mean (0, 3) | 0.50 mean (rep 2: 1.00) | n/a (rep 1 had 0 good) | 176,536 | $0.57, $0.82 | finish, finish |

Opus rows are medians (p50) and means from `eval/results/pilot-2026-10-12/report.md` and `eval/results/live-quotes-2026-10-14/report.md`; Opus leads counts are from the README's per-rep tables (pilot) and the live-quotes table. Memory-eval S1 first runs on Opus (set `memory-eval-2026-10-15b`, runs A and B'): 3 good of 7 ($0.293/good) and 6 of 6 ($0.141/good).

**What the cells say.**

- **Sonnet is at least as good as Opus on these two scenarios, at the same or lower cost.** S2: 10 leads, 9 good, stopped on `target_leads` at $0.61 and 157 s. S1: 8 leads, 7 good, stopped on the budget guard ($0.88 of the $1.00 cap). Both are inside the pilot Opus range (S1 9 / 7 / 6 good, S2 8 / 8 / 8) and above the post-gate Opus runs (S1 4 and 5, S2 0 and 3). **That comparison is confounded:** the pilot Opus runs predate the evidence-required gates, the live-quotes Opus runs ran under them (one rep before the quote-matcher fix), and the Sonnet runs ran under the final gates. n = 1 per Sonnet cell, so a single cell does not show Sonnet beats Opus; it shows Sonnet is not obviously worse.
- **Kimi hit the 6-minute wall (`max_active_ms`) in both cells.** It delivered 4 and 6 leads against Sonnet's 8 and 10. Its model calls are slow: median 14.5 s (S1) and 21.7 s (S2) per call against Sonnet's 4.2 s and 4.0 s (`latencyMs` of `model_call` events in each cell's `events.jsonl`). Total model time was 253 s and 278 s of the 375 s and 386 s runs. So Kimi was **penalised by latency, not shown to be a worse reasoner**: its precision (0.75, 0.83) rests on 4 and 6 leads and cannot be told from Sonnet's.
- **Neither Kimi cell passed.** Both fail the good-lead bar (3 and 5 good). S1 also failed the code grader `cost_reconciles` (`report.json`); the cause was not investigated (Kimi has no `count_tokens`, so its context sizes are estimated at 4 characters per token, and its cache-write price is an assumption in `docs/RESEARCH-kimi.md` §1; either could be the reason, neither is shown). S2 had a model call that ended in `stop_reason: max_tokens` (K2.6's thinking counts against the 8,000-token turn cap, the risk named in `docs/RESEARCH-kimi.md` §2).
- **Kimi's Claude-side cost is lower, its total is not.** Claude-side spend was $0.132 and $0.124 against Sonnet's $0.260 and $0.155, but Exa spend was similar, so spend per good lead was higher for Kimi ($0.186 and $0.122 against $0.126 and $0.068) because it delivered fewer leads for the same Exa bill.
- **Kimi smoke run (not judged):** `eval/recordings/kimi-smoke-2026-10-16/agent/` (ICP 1, `kimi-k2.6`), 13 turns, 14 model calls, $0.655 ($0.492 + $0.163), `stopReason: max_active_ms`. `events.jsonl` has 8 `submit_verdict` events with `code: accepted` and 1 `quote_not_in_page`. The commit message for the recording says "2 leads"; the file says 8 accepted. Use the file.
- Judge cost for the 20 new leads: $6.7566 (`costDollars` summed over the 20 verdict files), $0.34 per lead.

**Recommendation: agent loop to Sonnet, pending a 3-rep confirmation.** The evidence is one cell per scenario; it is enough to say Sonnet is worth confirming, not enough to switch (reversible, so the cost of waiting is low; a wrong switch that quietly lowers precision on a 98% product bar is not). Kimi is not recommended on this evidence: it does not finish inside the 6-minute limit at the account tier used, and the cost advantage disappears per good lead. Whether Kimi's slowness is the model or the Moonshot tier (Tier0 is 3 RPM, concurrency 1 per `docs/RESEARCH-kimi.md` §1) is **unknown**: the account's tier was not checked.

### Agent loop: 3-rep confirmation of Sonnet 5.5 (2026-10-17)

Set `sonnet-confirm-2026-10-17` (reps 2 and 3 of arm C_agent_sonnet, S1 and S2, $1.00 cap; report `eval/results/sonnet-confirm-2026-10-17/report.md`) plus rep 1 from `kimi-vs-sonnet-2026-10-16`. Same gates as rep 1; leads judged blind by the Opus judge (18 new verdicts, $5.66 judge spend).

| Scenario | Rep | Leads | Good | Precision | $/good | Spend (Exa + Claude) | Stop | Passes 6-good bar |
|---|---|---|---|---|---|---|---|---|
| S1 | 1 | 8 | 7 | 0.88 | $0.126 | $0.881 ($0.621 + $0.260) | budget | yes |
| S1 | 2 | 9 | 8 | 0.89 | $0.109 | $0.875 ($0.614 + $0.261) | budget | yes |
| S1 | 3 | 6 | **5** | 0.83 | $0.176 | $0.879 ($0.629 + $0.250) | budget | **no** |
| S2 | 1 | 10 | 9 | 0.90 | $0.068 | $0.609 ($0.454 + $0.155) | target_leads | yes |
| S2 | 2 | 10 | 9 | 0.90 | $0.048 | $0.432 ($0.332 + $0.100) | target_leads | yes |
| S2 | 3 | 10 | 9 | 0.90 | $0.060 | $0.542 ($0.411 + $0.131) | target_leads | yes |

- **S1: good 7, 8, 5; pass^3 = 0.** Rep 3 delivered 5 good (6 leads), under the 6-good bar, and S1 stopped on the budget guard in all three reps. Precision stayed at or above 0.83. **S2: good 9, 9, 9; pass^3 = 1**, precision 0.90, target reached 3 of 3, $0.05 to $0.07 per good lead.
- **Comparison, same gates, this week (Opus):** S1 4/4, 5/6 (live-quotes), 3/7, 8/8, 6/6 (memory-eval 15b A/B/B'); S2 0/0, 3/3 (live-quotes). Pilot Opus (pre-gates): S1 9 / 7 / 6, S2 8 / 8 / 8. The sets differ in gates and, for the memory-eval runs, in workspace memory, so this is indicative, not a controlled A/B. Sonnet is not worse on S1 than Opus under the current gates, and it is better on S2, but it does not clear pass^3 on S1.
- **Cost:** Claude spend per Sonnet run was $0.25 to $0.26 (S1) and $0.100 to $0.155 (S2) against $0.21 to $0.42 for Opus pilot runs (`state.json` spend). The six recorded Sonnet runs reprice exactly from their `model_call` token counts at the Sonnet table in `src/agent/config.ts` (`eval/graders.test.ts`), and `cost_reconciles` passes on all six. Exa is still 70 to 77% of a run.
- **Latency:** model call p50 about 4 s for Sonnet against about 6 s for Opus.
- **Decision:** agent loop default = Sonnet 5.5 (DECISIONS #26); Opus selectable; the offline lead judge stays Opus; online judges are on Jev (#25).
- **Not shown:** S3/S4; whether S1's rep-3 shortfall is variance or a Sonnet-specific recall limit (n = 3, one miss).

### Offline lead judge (web_search + web_fetch)

**Not re-evaluated; stays Opus 5.5.** The planned Kimi agreement check (`npm run eval:judge -- --set live-quotes-2026-10-14 --scenario S1 --model kimi --limit 3`, `docs/RESEARCH-kimi.md` §4c) **was not run**: no `judge-agreement-kimi.json` exists under `eval/results/`. No Sonnet judge comparison exists either (DECISIONS #14 still stands: Sonnet judge was an alternative considered, not measured). The judge is the ground truth for every number in this file, so it is the last job to downgrade.

### Online evidence-only judges (`judge_q1..q3`, 10 labelled items each)

Calibration against the human labels in the `judge-calibration/*` Langfuse datasets (10 items per question, 30 total), all four models answering from the same lead evidence, no browsing. Files: `eval/results/calibration/2026-10-16/judge_q{1,2,3}.evidence-{kimi-k2.6,claude-sonnet-5-5}.json` and `judge_q{1,2,3}.json` (model field `jev-1.13.0`).

| Model | Q1 | Q2 | Q3 | Cost for the 30 items | Source |
|---|---|---|---|---|---|
| Opus 5.5 | 7/10 | 8/10 | 8/10 | $0.81 | commit messages `bfc452d` and `ccf6980` only |
| Sonnet 5.5 | 7/10 | 8/10 | 8/10 | $0.39 ($0.135 + $0.112 + $0.140) | `.evidence-claude-sonnet-5-5.json` |
| Kimi K2.6 | 7/10 | 8/10 | 9/10 | $0.18 ($0.075 + $0.039 + $0.068) | `.evidence-kimi-k2.6.json` |
| Jev 1.13.0 | 6/10 | 8/10 | 8/10 | $0.002 ($0.00062 + $0.00062 + $0.00066) | `judge_q{1,2,3}.json` |

The Opus round's per-item files are **not on disk**: the Jev run wrote the same `judge_q{1,2,3}.json` paths on the same date and overwrote them (git history has them only as the Jev versions). The Opus scores and cost are quoted from the commit messages. 10 items per question means one item is 10 points; the differences between rows (one item) are noise.

**Where they miss (same 10 items every time).**

- Hollingsworth Logistics is wrong for **every model on every question** where it appears (Q1, Q2, Q3), always as `cannot_verify` where the human label is `yes`. The human label came from fetching the page (SPOT-CHECKS #4); an evidence-only judge cannot. That is a safe-direction miss, and a ceiling on all four.
- Sybill Q1 (`no`): Kimi and Sonnet say `cannot_verify`; Jev says `cannot_verify`. Miter Q1 (`no`): Sonnet `cannot_verify`, Kimi produced no verdict (`invalid`: the turn hit `max_tokens`; 1 of 30 Kimi items), Jev said `yes` at confidence 0.30.
- Unsafe-direction misses are rarer: Jev Q1 Miter `yes` (truth `no`, confidence 0.30), Jev Q2 Capacity LLC `yes` (truth `cannot_verify`, confidence 0.97), Jev and Sonnet Q3 Miter `no` (truth `yes`, Jev confidence 0.72). Kimi and Sonnet also say `yes` on Q2 Capacity LLC.

**Jev confidence threshold.** Jev reports a `confidence` per answer (concentration of its probabilities, not correctness; `docs/RESEARCH-jev.md`). On these 30 items a 0.4 floor drops 2 items, both wrong (Q1 Miter 0.30, Q1 Away Team 0.33), and no right answer. It keeps 8 of 10 Q1 answers, 10 of 10 Q2 and 10 of 10 Q3. **It does not remove the confident misses**: Hollingsworth is wrong at 0.98 (Q1, Q2) and 0.77 (Q3), Capacity Q2 at 0.97. A threshold is a filter on uncertainty, not a guarantee of correctness. Tuned on the set it is evaluated on, with n = 30, so 0.4 is a starting point, not a calibrated value.

**Recommendation: online judges to Jev with a 0.4 confidence threshold** (items below it become `cannot_verify`, i.e. not auto-accepted). Accuracy is within one item of Opus on each question at about 1/400 of the cost ($0.002 against $0.81). Kimi (7/8/9, $0.18) is not needed if Jev holds; Sonnet is the fallback if Jev is unavailable. Risk: Jev is early access, retention terms and rate limits are unpublished, and its "jaggedness" page (known weak spots) has not been read.

### Contact judge ("is this person currently this title at this company")

| Judge | n | Verdicts | Cost | Notes |
|---|---|---|---|---|
| Opus 5.5 + web_search/web_fetch | 1 | Capacity LLC / Karim Fofana: yes | $0.1447 | `eval/results/contact-eval-2026-10-16/contacts-v1-2026-10-16T12-52-10-257Z.jsonl` (2 searches, 0 fetches) |
| Jev 1.13.0, evidence only | 45 | 36 yes, 9 cannot_verify | $0.0033 (about $0.00007 each) | `eval/results/contacts/jev-contacts-2026-10-16T13-50-12-202Z.jsonl`; a `--limit 1` first call is in `...T13-49-30-400Z.jsonl` |

Agreement with Opus: **1 of 1** (Capacity LLC: both yes; Jev `pFound` 0.83 and 0.84 across the two runs). That is the only overlap; the other 44 have **no second opinion and no human label**, so the 36 yes are unverified. Jev's `pFound` separates cleanly in this run: the 9 `cannot_verify` span 0.42 to 0.73, the 36 yes span 0.81 to 0.97. That is a feature of this set, not a calibrated threshold (the 0.8 / 0.2 values in the adapter are the docs' placeholders). A Jev yes means "this page text shows the person in the role", narrower than the Opus judge, which searches the web. Cost at 45 contacts: Jev $0.0033 against about $6.51 projected for Opus (`docs/EVAL-DETAIL.md`, Contact eval).

**Recommendation: contact judge to Jev evidence-only, with Opus spot checks** on a sample of Jev yes verdicts and all cannot_verify that a user would otherwise see. Jev cannot find a changed role; it only reads what the gate already fetched.

### Planner

**Not evaluated.** No planner run used Sonnet or Kimi. The planner stays on its current model. (It generates structured plans, so Jev cannot do it.)

### Spend ledger for 2026-10-16 model evals

| Item | Dollars | Source |
|---|---|---|
| 4 agent cells (Sonnet S1 + S2, Kimi S1 + S2) | $2.66 | `run.json` spend.total: 0.881 + 0.559 + 0.609 + 0.610 |
| Opus judging of the 20 new leads | $6.76 | `eval/truth/*/*.json` `costDollars` where `judgedAt` is after 14:00Z (20 files, $6.7566) |
| Evidence-judge calibrations (Sonnet $0.387, Kimi $0.181) | $0.57 | `calibration/2026-10-16/*.evidence-*.json` |
| Jev (calibration $0.0019 + Sybill single item $0.0001 + 45 contacts $0.0033) | $0.005 | `calibration/2026-10-16/judge_q*.json`, `contacts/jev-contacts-*.jsonl` |
| Kimi smoke run | $0.66 | `eval/recordings/kimi-smoke-2026-10-16/agent/state.json` spend.total $0.655 |
| Accidental Kimi calibration round (killed after about 2 minutes) | about $0.21 | upper bound from `docs/RESEARCH-kimi.md`; the platform.kimi.ai usage page was not checked |
| **Total** | **about $10.85** | sum of the unrounded values |

Not in the list above: the Opus contact verdict ($0.1447, 12:51Z) and the earlier Opus evidence round ($0.81, date not recorded).
