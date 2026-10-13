# Failures found in this build

Per failure: symptom · layer · cause · fix · before → after or evidence · what would have caught it earlier. **[measured]** = from files.

## 1. Wrong-year event dates [measured]

- **Symptom:** the 2026-10-11 ICP-1 workflow run dropped 14 candidates as stale (`eval/recordings/icp1-2026-10-11/run.json`); Exa gave "2023-10-05" for a 2026-10-05 article.
- **Layer:** tool (Exa extraction). **Cause:** freshness judged on a year-slipped date.
- **Fix:** publish date used only for a year-slip within ±90 days (8e50801, e17043f). Test: `year-slips (RGL / FST / G10) still fall back to the publish date`.
- **Before → after:** 14 → 1 drops on the same recording (`run.replay.json`).

## 2. Cost-tier mis-estimate broke the budget

- **Symptom:** at 50 results a search cost $0.094, not the probe's $0.007 (SPEC-v2 §8). The 2026-10-11 run spent $0.887, enriched 15 of 130 candidates, returned 1 row.
- **Layer:** harness. **Cause:** one assumed price; Exa prices by result-count tier.
- **Fix:** observed tiers + 25% margin; CostGuard reserves the worst case and settles actuals (8e50801). Test: `cost guard › estimates conservatively`.
- **Before → after:** 25 results, $0.60 cap (`icp1-2026-10-11b/run.json`): stopped at lookup 27, $0.55 spent, 6 rows. Not controlled.
- **Earlier:** assert estimate ≥ recorded cost per call.

## 3. Strict tool-schema rejections

- **Symptom:** the API rejected `minimum`/`maximum` and an untyped `{}` in strict tools. Cost: $0.
- **Layer:** tool. **Cause:** schemas written for full JSON Schema.
- **Fix:** keywords removed; free `count_tokens` preflight (9ff1b21). Test: `finish schema's handback is a strict-compatible object`.
- **Before → after:** caught by the preflight, not a paid turn.

## 4. Parallel Exa cost double-counted in events [measured]

- **Symptom:** smoke `events.jsonl` summed `exaCost` to $1.292 against $0.455 in `state.json` (2.8×).
- **Layer:** harness. **Cause:** each parallel event logged the shared guard's running total.
- **Fix:** per-call cost per event (e17043f). Test: `F1.4 reports per-call Exa costs and records handback model calls`.
- **Before → after:** 2.8× → 1.0×: pilot S1 agent rep 2 events sum to $0.504 Exa, equal to its `state.json`.

## 5. Lookup enriched the wrong company

- **Symptom:** smoke lookup of UK "AUKLogis" returned Australia's AUK Logistics; the HQ gate rejected it, by luck.
- **Layer:** tool. **Cause:** trusted Exa's top hit. **Fix:** entity check (e17043f). Test: `F1.8 lookup_company rejects mismatched entities and accepts clear matches`.
- **Before → after:** no number.

## 6. Handback returned as prose [measured]

- **Symptom:** smoke `finish.handback` was markdown; the fallback stored `enterprise: 1` and an un-actionable `scope` suggestion.
- **Layer:** tool (schema). **Cause:** free-string handback.
- **Fix:** strict object, lookup-stage counts, data-driven suggestions (8f33f2b). Tests: `malformed handbacks … are rejected -> fallback`, `never emits field 'scope'`.
- **Before → after:** "1 enterprise" → pilot S1 agent rep 2: `size 13, enterprise 3`, suggesting 50–1,000 staff because "11 of 13" were under 100 (`eval/demo/run/state.json`). Residual: rep 3's `code` fields hold prose.

## 7. Workflow threw on budget mid-run (S2) [measured]

- **Symptom:** all 3 S2 workflow cells errored, "budget cap $1.000 would be exceeded (spent $0.548 …)": 0 leads, $0 recorded.
- **Layer:** harness. **Cause:** the guard's refusal escaped the pipeline.
- **Fix:** skip remaining lookups, score, record spend (f2bd783). Test: `a guard that refuses mid-way (tight cap) …`.
- **Before → after:** 3/3 crashes → 3/3 `budget` stops, 4 accepted and $0.90 recorded each (`S2/A_workflow/*/run.json`).

## 8. Judge parsed nothing on its first run [measured]

- **Symptom:** the first pass over 22 S1 leads: 0 verdicts, ≈ $3.50 spent, no record (author's log).
- **Layer:** eval. **Cause:** with web search on, the JSON is in the last text block; the parser read the first.
- **Fix:** last valid JSON across blocks; failure files (173ce64). Test: `reads ALL text blocks and takes the LAST valid JSON object`.
- **Before → after:** 0/22 → 22/22 (S1) and 23/23 (S2) verdicts in `eval/truth/`.
- **Earlier:** `--dry-run` / `--limit 1` before a full pass.

## 9. "Cannot verify" spelled several ways [measured]

- **Symptom:** after #8, the first lead still failed on a non-exact `cannot_verify`. **Layer:** eval. **Cause:** exact matching.
- **Fix:** answer normalisation, contract in the prompt, free `--replay-failures` (4bb5629). Test: `normalises answer spellings, case and whitespace`.
- **Before → after:** 0/1 → 1/1, recovered at $0 (Away Team; 6 searches against a cap of 3).

## 10. Search-only judge under-verified Q3 [measured]

- **Symptom:** the v2 judge scored S1 8/22 and S2 10/23 good, with many Q3 `cannot_verify`; spot-check #1 (RGL) fetched the page and found the event (`eval/truth/SPOT-CHECKS.md`).
- **Layer:** eval. **Cause:** the judge could not open signal URLs.
- **Fix:** v3: `web_fetch` (max 2, plus 3 searches), corroboration rule for blocked pages, `q3_basis`, `--rejudge-cannot-verify` keeping `*.prev.json` (a1e0b0b; RUBRIC change log).
- **Before → after:** S1 8 → 14 good (8 re-judged, 6 flipped); S2 10 → 15 (9 re-judged, 5 flipped). Two still `q3_basis: none`. Re-judge cost $5.75, ≈ 1.8× a v2 verdict.

## 11. Scorer missed judged leads after a name-normalisation change [measured]

- **Symptom:** `report.md` scored the S2 agent 6/6/6 good; its verdicts give 8/8/8.
- **Layer:** eval. **Cause:** 41c272b made `squashName` strip ".ai"/".dev"; verdicts were keyed `avarraai__…`, `reodev__…`, so 2 judged-good leads per rep went unfound.
- **Fix:** lookup falls back to URL hash + stored URL; keys migrated; re-scored (0a60098). Tests: `a verdict saved under an older squash is still found …`, `the scorer's result is unchanged by migrating old-squash truth files …`.
- **Before → after:** 6/6/6 → 8/8/8, precision 0.60 → 0.80, pass^3 0 → 1.
- **Earlier:** fail the scorer on a lead with no verdict (done since, a095bc9).

## 12. Planner rejected a valid stage

- **Symptom:** first live walkthrough (deposco.com): `POST /api/planner/cards` 500 in 41,137 ms after two 20-second attempts; dev log `stage must be any, seed, series_a, series_b_plus, or bootstrapped`.
- **Layer:** harness (validation). **Cause:** a "growth"-style stage; the enum was enforced in code, never stated in the prompt.
- **Fix:** enum in the prompt; unknown stage coerced to `any` (413b66b). **Evidence:** the dev-log 500; no test.

## 13. Planner rejected descriptor and signal types

- **Symptom:** the next attempts: 500 in 34,221 ms, then 30,573 ms. Empty `who.descriptor`; signal types like "New facility" or digit-leading "3pl_…".
- **Layer:** harness (validation). **Cause:** strict format checks on unambiguous model output.
- **Fix:** snake_case normalisation (leading digit allowed); descriptor falls back to industry (413b66b). **Evidence:** third attempt 200 in 30,842 ms; no test.

## 14. UI omitted the workspace id

- **Symptom:** live planner routes require the visitor workspace id (bc082af); the UI never sent it, so they would have refused.
- **Layer:** harness (client). **Cause:** a new required field added on the server only.
- **Fix:** `x-workspace-id` header in the shared `api()` helper (`app/ui/types.ts`, 413b66b). **Evidence:** no failing request recorded; no test.

## 15. Approval returned 409

- **Symptom:** `POST /api/runs/…/decision 409` on strategy approval.
- **Layer:** harness (client). **Cause:** the route binds a decision to the pending `toolUseId` (review fix F1.5); the UI sent `{approve}` only.
- **Fix:** the UI sends `snapshot.pendingApproval.toolUseId` (413b66b). **Evidence:** 409 → 200; the run finished with 10 leads for $0.73 (planner ≈ $0.11; day ledger $0.84, `spend-2026-10-13.json`).

**#12–15, shared cause:** a server contract change (stricter validation, a new required field) never reached the client: server and UI were built by different agents against the spec, not each other, and mocked tests passed on both sides. **Earlier:** a contract test driving the real routes from the UI's own request builders (no model), and a live `--limit 1` walkthrough before any batch, the same rule as for the judge (#8).

Also fixed, no number: Exa 429s under load (aac0a20: ≤ 4 in flight, jittered retry), and an unanchored `.gitignore` that hid `app/api/runs/**` and `app/api/workspaces/**` from every commit before d8248dc.

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
| Planner 5xx and decision 409 rates | Client/server contract drift | 12–15 |
