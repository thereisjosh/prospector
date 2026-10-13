# Failures found in this build

Per failure: symptom (from a trace or eval) · layer (prompt / tool / policy / context / model / harness / eval) · root cause · fix (commit, test) · before → after · what would have caught it earlier. "No number" means the repo has none.

## 1. Wrong-year event dates

- **Symptom:** the 2026-10-11 ICP-1 workflow run dropped 14 candidates as stale or unparseable (`eval/recordings/icp1-2026-10-11/run.json`). Exa returned "2023-10-05" for an article published 2026-10-05.
- **Layer:** tool (Exa extraction). **Root cause:** extraction slips the year, and freshness was judged on that date alone.
- **Fix:** use the publish date only for a year-slip (another year, within ±90 days of the publish month/day; the FST/G10 cases were 43–81 days off) (8e50801, e17043f). Test: `year-slips (RGL / FST / G10) still fall back to the publish date`.
- **Before → after:** 14 → 1 drops on the same recording (`run.replay.json`).
- **Earlier:** the T0 probe already showed an event date before the window (SPEC-v2 §8 A2).

## 2. Cost-tier mis-estimate broke the budget

- **Symptom:** at 50 results, a search cost $0.094 ($0.044 search + $0.05 summaries), not the probe's $0.007 base (SPEC-v2 §8). The 2026-10-11 run spent $0.887, enriched 15 of 130 candidates and returned 1 row.
- **Layer:** harness. **Root cause:** the estimator assumed one search price, but Exa prices by result-count tier.
- **Fix:** observed tiers + 25% margin; a CostGuard reserves the worst case per call and settles actuals (8e50801). Test: `cost guard › estimates conservatively`.
- **Before → after:** at 25 results and a $0.60 cap (`icp1-2026-10-11b/run.json`), the guard stopped at lookup 27 with $0.55 spent; 6 rows. Different config, not a controlled comparison.
- **Earlier:** assert estimate ≥ recorded cost for every recorded call (the test checks only the 50 tier).

## 3. Strict tool-schema rejections

- **Symptom:** the API rejected the tool definitions: `minimum`/`maximum` and an untyped `{}` value are unsupported with strict tools. Cost: $0.
- **Layer:** tool. **Root cause:** schemas were written for full JSON Schema.
- **Fix:** keywords removed; scope-change values became JSON strings decoded in code; `eval/check-tool-schemas.ts` validates prompt + tools via `count_tokens` for free (9ff1b21). Test: `finish schema's handback is a strict-compatible object`.
- **Before → after:** caught by the preflight, not on a paid turn.
- **Earlier:** the preflight in CI (none yet).

## 4. Parallel Exa cost double-counted in events

- **Symptom:** in the smoke run's `events.jsonl`, `exaCost` sums to $1.292, against $0.455 in `state.json` (2.8×). Three parallel searches logged 0.024 → 0.048 → 0.062.
- **Layer:** harness (observability). **Root cause:** parallel tools share one CostGuard per turn; each event logged its running total.
- **Fix:** per-call cost on each event (e17043f). Test: `F1.4 reports per-call Exa costs and records handback model calls`.
- **Before → after:** 2.8× → fixed in tests. **The demo replay is pre-fix:** it reports up to $1.67 mid-run, $0.87 at the end.
- **Earlier:** Σ event costs = state spend, checked per recorded run.

## 5. Lookup enriched the wrong company

- **Symptom:** the smoke run's lookup of "AUKLogis" (signal: *"AUKLogis takes first dedicated UK warehouse"*) returned Australia's AUK Logistics (auklogistics.com). The HQ gate rejected it, by luck.
- **Layer:** tool. **Root cause:** the lookup trusted Exa's top company hit.
- **Fix:** an entity check on lookups (e17043f). Test: `F1.8 lookup_company rejects mismatched entities and accepts clear matches`.
- **Before → after:** no number.
- **Earlier:** log the queried name next to the matched name and domain.

## 6. Handback returned as prose

- **Symptom:** the smoke run's `finish.handback` was markdown ("Too small (10) … Too big (about 20) …"). The parser rejected it; the code fallback stored `enterprise: 1` and an un-actionable `scope` suggestion, so the UI said "1 enterprise".
- **Layer:** tool (output schema) and policy. **Root cause:** a free-string handback; the fallback counted only submit-stage rejections.
- **Fix:** strict handback object; lookup-stage screening merged into counts; data-driven suggestions (8f33f2b). Tests: `malformed handbacks … are rejected -> fallback`, `never emits field 'scope'`.
- **Before → after:** "1 enterprise" → pilot S1 rep 2: `size 13, enterprise 3`, suggesting 50–1,000 staff because 11 of 13 were under 100. Residual: rep 3's `code` fields contain prose, which the schema allows.
- **Earlier:** render the handback from a recorded trace before going live.

## 7. Workflow threw on budget mid-run (S2)

- **Symptom:** all 3 S2 workflow cells errored, "budget cap $1.000 would be exceeded (spent $0.548 …)": 0 leads, $0 recorded (`eval/results/pilot-2026-10-12/S2/A_workflow/*/run.json`).
- **Layer:** harness. **Root cause:** the guard's refusal escaped the pipeline instead of ending the stage; failed cells lost their spend.
- **Fix:** skip remaining lookups, still score, record failed-cell spend (f2bd783). Test: `a guard that refuses mid-way (tight cap) skips lookups/follow-ups, records them, and still scores`.
- **Before → after:** 3/3 crashes → a graceful stop in tests. **Not re-run.**
- **Earlier:** a tight-cap test for each arm before the pilot.

## 8. Judge parsed nothing

- **Symptom:** the first judge pass over 22 pooled S1 leads (`S1/blind.json`) produced 0 verdicts. With web search on, the JSON comes in the last text block, and "cannot verify" was spelled several ways. 0/22 is from the author's run log (failure files were consumed on replay).
- **Layer:** eval. **Root cause:** the parser read the first text block, and answers were matched exactly.
- **Fix:** last valid JSON across all blocks, failure files (173ce64); answer normalisation, contract in the prompt, free `--replay-failures` (4bb5629). Tests: `reads ALL text blocks and takes the LAST valid JSON object`, `normalises answer spellings, case and whitespace`.
- **Before → after:** 0/22 → 1 verdict recovered (`eval/truth/S1/`: $0.27, 6 web searches, so the cap of 3 was exceeded).
- **Earlier:** `--dry-run` / `--limit 1` before a full pass.

## 9. Exa 429 under parallel load

- **Symptom:** parallel calls hit Exa 429s and a failed cell aborted the matrix (aac0a20; responses not checked in).
- **Layer:** tool (client). **Root cause:** no concurrency limit and no retry.
- **Fix:** ≤4 requests in flight, jittered 429/5xx retry honouring `retry-after`, matrix survives a failed cell. Test: `30 concurrent calls never exceed 4 in flight (429 above that) and all succeed`.
- **Before → after:** no number.
- **Earlier:** a burst test at the planned parallelism.

## 10. Unanchored `.gitignore` hid the API routes

- **Symptom:** `app/api/runs/**` and `app/api/workspaces/**` were missing from every commit before d8248dc; 066eee5 lists them but contains none.
- **Layer:** harness (repo). **Root cause:** `runs/` and `workspaces/` (data dirs) also matched the route folders.
- **Fix:** anchored `/runs/` and `/workspaces/` (d8248dc). No test.
- **Earlier:** a clean-clone `npm run build` in CI.

## What we would monitor weekly

Extends the SPEC-agent §14 weekly review; a breach rolls back one stage.

| Metric | Why | Failure |
|---|---|---|
| Cost per good lead (judged sample) vs arm A | §14 ramp criterion | 2 |
| Handback rate; good leads added by re-running with suggestion #1 | §14 | 6 |
| Approval decline rate, strategy vs scope change | §14 | — |
| 👎 reasons, grouped; recurring ones become eval cases | §14 | — |
| Σ event costs vs state spend; share of runs stopped on budget | Spend anomaly = kill-switch trigger | 2, 4, 7 |
| Share of leads dated by `published_fallback`; stale drops | Year-slip drift | 1 |
| Lookup entity mismatches; `hq` rejections after lookup | Wrong-company enrichment | 5 |
| Exa 429/retry count; p95 turn time vs the 60 s route limit | Load and hosting | 9 |
| Judge parse failures; share of "cannot verify" | Eval health | 8 |
| Runs with 0 verification reads (all 7 agent runs so far) | The agent is not verifying | — |
