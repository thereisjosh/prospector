# Failures found in this build

Per failure: symptom · layer · root cause · fix (commit, test) · before → after · what would have caught it earlier. **[measured]** = before → after taken from files.

## 1. Wrong-year event dates [measured]

- **Symptom:** the 2026-10-11 ICP-1 workflow run dropped 14 candidates as stale (`eval/recordings/icp1-2026-10-11/run.json`); Exa returned "2023-10-05" for an article published 2026-10-05.
- **Layer:** tool (Exa extraction). **Root cause:** extraction slips the year, and freshness was judged on that date alone.
- **Fix:** use the publish date only for a year-slip (another year, within ±90 days) (8e50801, e17043f). Test: `year-slips (RGL / FST / G10) still fall back to the publish date`.
- **Before → after:** 14 → 1 drops on the same recording (`run.replay.json`).
- **Earlier:** the T0 probe already showed it (SPEC-v2 §8 A2).

## 2. Cost-tier mis-estimate broke the budget

- **Symptom:** at 50 results a search cost $0.094, not the probe's $0.007 base (SPEC-v2 §8). The 2026-10-11 run spent $0.887, enriched 15 of 130 candidates, returned 1 row.
- **Layer:** harness. **Root cause:** the estimator assumed one price; Exa prices by result-count tier.
- **Fix:** observed tiers + 25% margin; a CostGuard reserves the worst case per call and settles actuals (8e50801). Test: `cost guard › estimates conservatively`.
- **Before → after:** at 25 results and a $0.60 cap (`icp1-2026-10-11b/run.json`) the guard stopped at lookup 27, $0.55 spent, 6 rows. Not a controlled comparison.
- **Earlier:** assert estimate ≥ recorded cost for every recorded call.

## 3. Strict tool-schema rejections

- **Symptom:** the API rejected `minimum`/`maximum` and an untyped `{}` in strict tools. Cost: $0.
- **Layer:** tool. **Root cause:** schemas written for full JSON Schema.
- **Fix:** keywords removed; scope-change values became JSON strings decoded in code; `eval/check-tool-schemas.ts` validates via `count_tokens` for free (9ff1b21). Test: `finish schema's handback is a strict-compatible object`.
- **Before → after:** caught by the preflight, not on a paid turn.
- **Earlier:** the preflight in CI.

## 4. Parallel Exa cost double-counted in events [measured]

- **Symptom:** in the smoke run's `events.jsonl`, `exaCost` sums to $1.292 against $0.455 in `state.json` (2.8×).
- **Layer:** harness (observability). **Root cause:** parallel tools share one CostGuard per turn; each event logged its running total.
- **Fix:** per-call cost on each event (e17043f). Test: `F1.4 reports per-call Exa costs and records handback model calls`.
- **Before → after:** 2.8× → 1.0×: the pilot S1 agent rep 2 (now the demo replay) sums to $0.504 of Exa in events, equal to its `state.json`.
- **Earlier:** Σ event costs = state spend, checked per recorded run.

## 5. Lookup enriched the wrong company

- **Symptom:** the smoke run's lookup of UK "AUKLogis" returned Australia's AUK Logistics; the HQ gate rejected it, by luck.
- **Layer:** tool. **Root cause:** the lookup trusted Exa's top company hit.
- **Fix:** entity check on lookups (e17043f). Test: `F1.8 lookup_company rejects mismatched entities and accepts clear matches`.
- **Before → after:** no number.
- **Earlier:** log the queried name next to the matched name and domain.

## 6. Handback returned as prose [measured]

- **Symptom:** the smoke run's `finish.handback` was markdown; the fallback stored `enterprise: 1` and an un-actionable `scope` suggestion.
- **Layer:** tool (output schema) and policy. **Root cause:** a free-string handback; the fallback counted only submit-stage rejections.
- **Fix:** strict handback object; lookup-stage screening merged into counts; data-driven suggestions (8f33f2b). Tests: `malformed handbacks … are rejected -> fallback`, `never emits field 'scope'`.
- **Before → after:** "1 enterprise" → pilot S1 agent rep 2: `size 13, enterprise 3`, suggesting 50–1,000 staff because "11 of 13" were under 100 (`eval/demo/run/state.json`). Residual: rep 3's `code` fields hold prose.
- **Earlier:** render the handback from a recorded trace before going live.

## 7. Workflow threw on budget mid-run (S2) [measured]

- **Symptom:** all 3 S2 workflow cells errored, "budget cap $1.000 would be exceeded (spent $0.548 …)": 0 leads, $0 recorded.
- **Layer:** harness. **Root cause:** the guard's refusal escaped the pipeline; failed cells lost their spend.
- **Fix:** skip remaining lookups, still score, record failed-cell spend (f2bd783). Test: `a guard that refuses mid-way (tight cap) …`.
- **Before → after:** 3/3 crashes → 3/3 `budget` stops with 4 accepted leads and $0.90 recorded each (re-run, `S2/A_workflow/*/run.json`).
- **Earlier:** a tight-cap test for each arm before the pilot.

## 8. Judge parsed nothing on its first run [measured]

- **Symptom:** the first pass over 22 pooled S1 leads produced 0 verdicts and ≈ $3.50 of spend with no record (author's run log; failure files were consumed on replay).
- **Layer:** eval. **Root cause:** with web search on, the JSON arrives in the last text block; the parser read the first.
- **Fix:** last valid JSON across all blocks, failure files, cost recorded per verdict (173ce64). Test: `reads ALL text blocks and takes the LAST valid JSON object`.
- **Before → after:** 0/22 parsed → 22/22 (S1) and 23/23 (S2) verdicts in `eval/truth/`.
- **Earlier:** `--dry-run` / `--limit 1` before a full pass.

## 9. "Cannot verify" spelled several ways [measured]

- **Symptom:** after #8, the first lead still failed on a non-exact `cannot_verify`.
- **Layer:** eval. **Root cause:** answers matched exactly.
- **Fix:** answer normalisation, contract in the prompt, free `--replay-failures` (4bb5629). Test: `normalises answer spellings, case and whitespace`.
- **Before → after:** 0/1 → 1/1 recovered from the saved response at $0 (Away Team, `eval/truth/S1/`; it used 6 searches against a cap of 3).

## 10. Search-only judge under-verified Q3 [measured]

- **Symptom:** the v2 judge (web search only) scored S1 8/22 and S2 10/23 good, with many Q3 `cannot_verify`. Spot-check #1 (RGL Logistics) fetched the signal page and found the event, dated and specific (`eval/truth/SPOT-CHECKS.md`).
- **Layer:** eval. **Root cause:** the judge could not open the signal URL, so Q3 defaulted to "cannot verify".
- **Fix:** judge v3: `web_fetch` for the signal URL (max 2 fetches, 3 searches), a corroboration rule for blocked pages, `q3_basis` recorded, `--rejudge-cannot-verify` keeping the old verdict as `*.prev.json` (a1e0b0b; RUBRIC change log 2026-10-13).
- **Before → after:** S1 8 → 14 good (8 re-judged, 6 flipped); S2 10 → 15 (9 re-judged, 5 flipped). Two S2 re-judges still ended `q3_basis: none`. Re-judge cost $5.75, ≈ 1.8× a v2 verdict.
- **Earlier:** spot-check a handful of "cannot verify" verdicts before the full pass.

## 11. Scorer missed judged leads after a name-normalisation change [measured]

- **Symptom:** `report.md` scored the S2 agent 6/6/6 good; its verdict files give 8/8/8.
- **Layer:** eval. **Root cause:** 41c272b made `squashName` strip domain suffixes ("Avarra.ai" → `avarra`, "Reo.Dev" → `reo`), but the verdicts were keyed `avarraai__…` and `reodev__…`. Unfound, 2 judged-good leads per rep scored not good.
- **Fix:** truth lookup falls back to the URL hash plus the stored URL; old keys migrated (`eval/harness/migrate-truth-keys.ts`); re-scored (0a60098). Tests: `a verdict saved under an older squash is still found (URL hash + stored URL), never by hash alone`, `the scorer's result is unchanged by migrating old-squash truth files, and migration is idempotent`.
- **Before → after:** S2 agent 6/6/6 → 8/8/8, precision 0.60 → 0.80, pass^3 0 → 1.
- **Earlier:** fail the scorer on a lead with no verdict (still not done).

## 12. Unanchored `.gitignore` hid the API routes

- **Symptom:** `app/api/runs/**` and `app/api/workspaces/**` were missing from every commit before d8248dc.
- **Layer:** harness (repo). **Root cause:** `runs/` and `workspaces/` (data dirs) also matched the route folders.
- **Fix:** anchored `/runs/` and `/workspaces/` (d8248dc). No test.
- **Earlier:** a clean-clone `npm run build` in CI (added in 41c272b).

Exa 429s under parallel load (aac0a20) were fixed with ≤ 4 in flight and a jittered retry (test: `30 concurrent calls never exceed 4 in flight`); no before/after number.

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
| Exa 429/retry count; p95 turn time vs the 60 s route limit | Load and hosting | — |
| Judge parse failures; share of "cannot verify" and `q3_basis: none`; pooled leads with no verdict | Eval health | 8–11 |
| Runs with 0 verification reads (all 7 agent runs so far) | The agent is not verifying | — |
