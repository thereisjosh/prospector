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

## Why signal-first (kept from v1)

Exa's `category: "company"` search rejects `startPublishedDate`, so a company search cannot be date-filtered (probed on the live API). Freshness is what the buyer needs, so both arms search dated news and job pages for the **trigger**, then look up the named company for size, HQ and type. Claude decides what to ask; every fact in the output comes from Exa (SPEC-v2 §1).
