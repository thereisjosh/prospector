# Failures found in this build

Per failure: symptom · layer · cause · fix · before → after or evidence · what would have caught it earlier. **[measured]** = from files.

## 1. Wrong-year event dates [measured]

- **Symptom:** the 2026-10-11 ICP-1 workflow run dropped 14 candidates as stale (`eval/recordings/icp1-2026-10-11/run.json`).
- **Layer:** tool (Exa extraction). **Cause:** freshness judged on a year-slipped date.
- **Fix:** publish date used only for a year-slip within ±90 days (8e50801, e17043f). Test: `year-slips (RGL / FST / G10) still fall back to the publish date`.
- **Before → after:** 14 → 1 drops on the same recording.

## 2. Cost-tier mis-estimate broke the budget

- **Symptom:** at 50 results a search cost $0.094, not the probe's $0.007 (SPEC-v2 §8). The 2026-10-11 run spent $0.887, enriched 15 of 130, returned 1 row.
- **Layer:** harness. **Cause:** one assumed price; Exa prices by result-count tier.
- **Fix:** observed tiers + 25% margin; CostGuard reserves the worst case and settles actuals (8e50801). Test: `cost guard › estimates conservatively`.
- **Before → after:** $0.60 cap (`icp1-2026-10-11b/run.json`): stopped at lookup 27, $0.55 spent, 6 rows.

## 3. Strict tool-schema rejections

- **Symptom:** the API rejected `minimum`/`maximum` and an untyped `{}` in strict tools.
- **Layer:** tool. **Cause:** schemas written for full JSON Schema.
- **Fix:** keywords removed; free `count_tokens` preflight. Test: `finish schema's handback is a strict-compatible object`.
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

- **Symptom:** smoke `finish.handback` was markdown; the fallback stored `enterprise: 1` and a `scope` suggestion.
- **Layer:** tool (schema). **Cause:** free-string handback.
- **Fix:** strict object, lookup-stage counts, data-driven suggestions (8f33f2b). Tests: `malformed handbacks … are rejected -> fallback`, `never emits field 'scope'`.
- **Before → after:** "1 enterprise" → pilot S1 agent rep 2: `size 13, enterprise 3` (`eval/demo/run/state.json`).

## 7. Workflow threw on budget mid-run (S2) [measured]

- **Symptom:** all 3 S2 workflow cells errored, "budget cap $1.000 would be exceeded (spent $0.548 …)": 0 leads, $0 recorded.
- **Layer:** harness. **Cause:** the guard's refusal escaped the pipeline.
- **Fix:** skip remaining lookups, score, record spend (f2bd783). Test: `a guard that refuses mid-way (tight cap) …`.
- **Before → after:** 3/3 crashes → 3/3 `budget` stops, 4 accepted, $0.90 each (`S2/A_workflow/*/run.json`).

## 8. Judge parsed nothing on its first run [measured]

- **Symptom:** the first pass over 22 S1 leads: 0 verdicts, ≈ $3.50 spent, no record (author's log).
- **Layer:** eval. **Cause:** with web search on, the JSON is in the last text block; the parser read the first.
- **Fix:** last valid JSON across blocks; failure files (173ce64). Test: `reads ALL text blocks and takes the LAST valid JSON object`.
- **Before → after:** 0/22 → 22/22 (S1) and 23/23 (S2) verdicts in `eval/truth/`.
- **Earlier:** `--dry-run` / `--limit 1` before a full pass.

## 9. "Cannot verify" spelled several ways [measured]

- **Symptom:** after #8, the first lead still failed on a non-exact `cannot_verify`. **Layer:** eval. **Cause:** exact matching.
- **Fix:** answer normalisation, contract in the prompt, free `--replay-failures` (4bb5629). Test: `normalises answer spellings, case and whitespace`.
- **Before → after:** 0/1 → 1/1, recovered at $0 (Away Team).

## 10. Search-only judge under-verified Q3 [measured]

- **Symptom:** the v2 judge scored S1 8/22 and S2 10/23 good, with many Q3 `cannot_verify`; spot-check #1 (RGL) found the event on the page (`eval/truth/SPOT-CHECKS.md`).
- **Layer:** eval. **Cause:** the judge could not open signal URLs.
- **Fix:** v3: `web_fetch` (max 2, plus 3 searches), corroboration rule for blocked pages, `q3_basis`, `--rejudge-cannot-verify` keeping `*.prev.json` (a1e0b0b; RUBRIC change log).
- **Before → after:** S1 8 → 14 good (8 re-judged, 6 flipped); S2 10 → 15 (9 re-judged, 5 flipped). Re-judge cost $5.75.

## 11. Scorer missed judged leads after a name-normalisation change [measured]

- **Symptom:** `report.md` scored the S2 agent 6/6/6 good; its verdicts give 8/8/8.
- **Layer:** eval. **Cause:** 41c272b made `squashName` strip ".ai"/".dev"; verdicts were keyed `avarraai__…`, `reodev__…`, so 2 judged-good leads per rep went unfound.
- **Fix:** lookup falls back to URL hash + stored URL; keys migrated; re-scored (0a60098). Tests: `a verdict saved under an older squash is still found …`, `the scorer's result is unchanged by migrating old-squash truth files …`.
- **Before → after:** 6/6/6 → 8/8/8, precision 0.60 → 0.80, pass^3 0 → 1.
- **Earlier:** fail the scorer on a lead with no verdict (done since, a095bc9).

## 12. Planner rejected a valid stage

- **Symptom:** first live walkthrough (deposco.com): `POST /api/planner/cards` 500 in 41,137 ms; dev log `stage must be any, seed, …`.
- **Layer:** harness (validation). **Cause:** a "growth"-style stage; the enum was enforced in code, never stated in the prompt.
- **Fix:** enum in the prompt; unknown stage coerced to `any` (413b66b). **Evidence:** the dev-log 500; no test.

## 13. Planner rejected descriptor and signal types

- **Symptom:** next attempts: 500 in 34,221 ms, then 30,573 ms. Empty `who.descriptor`; signal types like "New facility" or digit-leading "3pl_…".
- **Layer:** harness (validation). **Cause:** strict format checks on unambiguous model output.
- **Fix:** snake_case normalisation (leading digit allowed); descriptor falls back to industry (413b66b). **Evidence:** third attempt 200 in 30,842 ms; no test.

## 14. UI omitted the workspace id

- **Symptom:** live planner routes require the visitor workspace id (bc082af); the UI never sent it, so they would have refused.
- **Layer:** harness (client). **Cause:** a new required field added on the server only.
- **Fix:** `x-workspace-id` header in the shared `api()` helper (`app/ui/types.ts`, 413b66b). **Evidence:** no failing request recorded; no test.

## 15. Approval returned 409

- **Symptom:** `POST /api/runs/…/decision 409` on strategy approval.
- **Layer:** harness (client). **Cause:** the route binds a decision to the pending `toolUseId` (review fix F1.5); the UI sent `{approve}` only.
- **Fix:** the UI sends `snapshot.pendingApproval.toolUseId` (413b66b). **Evidence:** 409 → 200; the run finished with 10 leads for $0.73.

**#12–15, shared cause:** a server contract change (stricter validation, a new required field) never reached the client: server and UI were built separately against the spec, and mocked tests passed on both sides. **Earlier:** a contract test driving the real routes from the UI's own request builders, and a live `--limit 1` walkthrough (as in #8).

## 16. Last permitted run stopped at its first spend

- **Symptom:** production run `10665d83…` (a visitor's second live run) stopped at turn 2 with $0.08 spent and `remainingDollars` 1.63; empty handback (`top_reasons: []`).
- **Layer:** harness / policy. **Cause:** run creation had already taken the second slot (`liveRuns` 2 = limit); the post-step check used `allowanceExhausted` (runs OR dollars), so it fired on any spend.
- **Fix:** `dollarsExhausted` for both mid-run checks; `allowanceExhausted` only at creation. The handback now names the reason (`allowanceHandback`). Test: `eval/allowance.test.ts › second of two runs keeps stepping while dollars remain…`.
- **Earlier:** an allowance test on the LAST permitted run, not the first.

## 17. Planner routes gated on run count; 402 shown as a card problem

- **Symptom:** production `POST /api/planner/plan 402 37ms` for a visitor with `remainingRuns` 0 and `remainingDollars` 1.63; the UI said "We couldn't turn these cards into a plan. Try again, or loosen a card."
- **Layer:** policy + UI copy. **Cause:** (a) the three planner routes used `allowanceExhausted` (runs OR dollars), although planner calls never take a run slot; (b) every planner `catch` in the UI printed its validation-style message whatever the status, so a 402 read as a card problem.
- **Fix:** planner routes gate on `dollarsExhausted` only (daily cap kept); only `POST /api/runs` gates on runs. The UI maps 402 (allowance), 503 `daily_budget_reached`, 429 to specific messages (`httpErrorMessage`, `app/ui/copy.ts`; `HttpError` now carries the body's error code), keeping generic copy for real 5xx. The Approve step shows "Free runs left on this site: X · $Y" from `GET /api/status` before Run.
- **Tests:** `eval/allowance.test.ts › a visitor with 0 runs left but dollars remaining can call all three planner routes (200) and gets 402 only at run creation`; `eval/ui-copy.test.ts › HTTP error copy` (402 planner/run, 503, 429, 5xx unchanged, every documented status has a message).
- **Earlier:** an allowance test for the planner routes with 0 runs left (#16's test covered only run creation); a UI test that every 4xx/503 the API documents has its own message.

Also fixed: Exa 429s under load (aac0a20: ≤ 4 in flight, jittered retry); an unanchored `.gitignore` hid `app/api/runs/**` and `app/api/workspaces/**` until d8248dc.

## 18. Calibration run: forced tool_choice rejected by claude-opus-5-5 [measured]

- **Symptom:** 2026-10-14 calibration run: 400 × 10 (`tool_choice: type "tool" and "any" are not supported for this model`); $0 spent because 400s do not bill; the runner swallowed the errors and reported 0/0.
- **Layer:** eval. **Cause:** `judgeOnce` forced `tool_choice: {type:"tool", name:"verdict"}`; `dataset.runExperiment` catches a throwing task, logs "Skipping item" and drops it, so nothing failed loudly. `src/agent/loop.ts` already avoided forced tool choice for this model.
- **Fix:** no forced tool_choice; the prompt ends "Answer by calling the `verdict` tool exactly once."; no `tool_use` block gives `score: "invalid"` (no text parsing). The task is wrapped to log item id + message and count errors; summary prints `N/M correct, K errors` and exits non-zero when K > 0. Tests: `eval/online-judge.test.ts`.
- **Earlier:** `--limit 1` with raw-output inspection before a full paid pass.

## 19. Online judge given claims without evidence; calibration 4/10 and 2/10 [measured]

- **Symptom:** 2026-10-14 calibration round 1 ($0.43, Opus 5.5, prompt v2): judge_q1 4/10, judge_q2 2/10. The managed judge answered cannot_verify to nearly every lead, including the two the human labelled "no"; one verdict came back "invalid" with empty reasoning.
- **Layer:** eval. **Cause:** the judge payload carried only the agent's claim (company, signal_url, why_now, event_date, size_basis "quoted"/"unverified"). The managed evaluator has no web tools, so it had nothing to check the claim against; cannot_verify was the correct answer. The offline judge had passed on the same leads because it could fetch and search. The "invalid" verdict was most likely the tool-call JSON truncated at the 600-token output budget (adaptive thinking is always on for Opus 5.5 and shares that budget). The cost estimate was also low ($0.21 vs $0.236 for Q1): 3.2 chars/token under-counted the input.
- **Fix:** the payload's new `evidence` carries what `checkLead` accepted the lead on: signal title, Exa date, a ≤ 1,500-char excerpt around the company's mention and the event (`src/evidence.ts`), the company lookup and the gate result. It is stored on the accepted lead at submit time (`AcceptedLead.evidence`) and built the same way for the workflow arm (`score.ts` → `ProspectRun.evidence`). The online prompts (v3) answer from the evidence and say cannot_verify only when it is silent. The calibration sets were rebuilt from the pilot's state files and recordings (one item, Hollingsworth, has no recoverable evidence). Output budget 1,000; estimate 2.2 chars/token + 500 tokens per call. Tests: `eval/judge-evidence.test.ts`, `eval/online-judge.test.ts`.
- **Earlier:** look at one compiled calibration input before a paid round and ask "could a judge with no tools answer this from what is here?".

## 20. Calibration experiment runs never reached Langfuse Experiments; reasoning truncated [measured]

- **Symptom:** 2026-10-14: four paid `calibrate-judge.ts --run` rounds printed a results link, but dataset `judge-calibration/judge_q3` → Experiments showed "No experiments in view" and `api.experiments.list({datasetId, fromStartTime})` returned `{data: []}`. The first run printed `[Langfuse SDK] [WARN] OpenTelemetry has not been set up. Traces will not be sent to Langfuse.` The mismatch table cut `reasoning` to 200 chars and nothing else was written locally.
- **Layer:** eval. **Cause:** the script called `setLangfuseTracerProvider(provider)` (spans did export: the 60 `experiment-item-run` root observations of today's rounds are in the v2 Observations API, environment `sdk-experiment`, with full verdicts as output) but registered no OpenTelemetry context manager. The Experiments SDK (`@langfuse/client` 5.13.1, `ExperimentManager.runItem`) opens the item's root span with `startActiveObservation` and then sets `langfuse.experiment.id`, `.name`, `.item.id`, `.item.root_observation_id` and `.dataset_id` through `propagateAttributes`, which writes them on `trace.getActiveSpan()`. With the OTel API's default no-op context manager there is no active span, so the attributes landed nowhere and Langfuse ingested plain traces, not experiment items. The warning was a separate false signal: `isOtelRegistered()` checks only the global tracer provider. `src/agent/trace.ts` registers an `AsyncLocalStorageContextManager`; the pilot import (`eval/langfuse/otel.ts`) sets the experiment attributes on its spans directly, so neither path hit this.
- **Fix:** `startSdkTracing()` (`eval/langfuse/otel.ts`) registers an `AsyncLocalStorageContextManager` and the provider (global and via `setLangfuseTracerProvider`), as the docs' `NodeSDK` setup does, and `shutdown()` flushes, then unregisters both. After the run the script waits until `api.experiments.list` lists the run with every item, and fails otherwise. Every verdict (company, signal_url, expected, actual, full reasoning, cost, trace id) goes to `eval/results/calibration/<date>/<judge>.json`; mismatches print their full reasoning under the table. `--item <substring>` re-runs one verdict, `--dry-run` runs the SDK path with a stub verdict ($0), `--list-runs <judge>` reads runs back from the Experiments API ($0). Test: `eval/calibration-run.test.ts`.
- **Evidence:** `--dry-run --judge judge_q3` → run `dry-run · judge_q3 prompt v3 · 2026-10-14T08:09` listed by `api.experiments.list` with 10 items and the `judge_q3-judge-output-correct` scores; the same SDK call without the context manager emits a root span with no `langfuse.experiment.*` id attributes (test).
- **Earlier:** a $0 dry run of the experiment path, confirmed through the read API, before the first paid round; and treat "Traces will not be sent" as a bug to explain, not noise.

## 21. Gate booleans were accepted without page evidence [measured]

- **Symptom:** pilot leads passed required fit gates on Exa summary booleans alone; Sybill and Miter were marked `recently_funded_seed_or_series_a: true` though the judge found that false.
- **Layer:** gate/schema. **Cause:** `buildCompanySchema` required every plan gate as a non-null boolean, with no supporting quote, so the summariser had to guess from sparse pages.
- **Fix:** each plan gate is now `boolean|null` plus `<key>_quote`, and the lookup also returns `hq_quote`. A required gate that is `null`, or `true` with an empty quote, returns `unquoted_gate` with `tier: "candidate"` (never an accepted lead); an HQ with no `hq_quote` is the same. A quote that is present but not a substring of the captured lookup text (after case, whitespace, smart-quote and HTML-entity normalisation) is a hard `quote_not_in_page`. Optional unquoted gates add no multiplier. Tests: `eval/gates.test.ts`, `eval/agent.test.ts`.
- **Before -> after (replay, `eval/results/gate-replay-2026-10-14.md`):** not measurable as a precision change. Pilot summaries predate quotes and lookup page text was not recorded, so the replay can only count what would now need evidence: 75 of 75 rules-passing lead-reps (agent and workflow arms) have no `signal_quote`, and all 55 agent-arm lead-reps also rest on unquoted required gates; 53 of the 75 are good leads that would be demoted to candidates until a quote-enabled run shows whether their pages state the fact, 22 are bad leads the quote rule would stop. Unproven on live Exa until a paid run.

## 22. Non-event pages counted as why-now signals [measured]

- **Symptom:** job boards, personal profiles and profile/newsletter pages were accepted as signals: snagajob, tealhq, ihirelogistics, single-job Ashby pages, LinkedIn profiles and a "Should you join Miter" profile.
- **Layer:** gate/source filtering. **Cause:** exclusions depended on the planner's per-plan list; code only checked the company name and date, not whether the page described an event.
- **Fix:** (1) a built-in job/career-board domain list (`BUILTIN_EXCLUDED_SIGNAL_DOMAINS`, SPEC-agent section 5) gives `exclude_domain`; (2) a LinkedIn `/in/<name>` personal-profile URL gives `non_event_page`; (3) a signal with no `signal_quote` is `unquoted_signal` (candidate tier), and a quote not on the page is `quote_not_in_page`; (4) `weak_hiring_signal` when a hiring signal is on neither the company's own registrable domain nor names two distinct roles. Hiring detection (`isHiringSignal`) keys on a hiring `signal_type` token (hire/hiring/job/role/career/recruit...) or an explicit job-post shape (job/careers path, or a title that is itself a hiring notice), not on incidental words: a facility or lease article that mentions "jobs" is not a hiring signal. Tests: `eval/gates.test.ts`.
- **Before -> after (deterministic rules only, no quotes):** 11 bad lead-reps newly rejected, 0 good lost: `exclude_domain` x5 (S1 workflow: Spreetail x2, Away Team (Spreetail), HIVED, Diakonlogistics), `non_event_page` x5 (S2 workflow: Avarra x3, Clueso x2), `weak_hiring_signal` x1 (S2 agent: Miter). Projected precision S1 workflow 6/19 -> 6/14, S2 workflow 1/12 -> 1/7, S2 agent 24/30 -> 24/29 (0.80 -> 0.83); S1 agent unchanged at 22/25 (0.88). That is below the 98% bar on every arm: these rules alone do not get there, the evidence rules are the remaining lever (see #21). Workflow-arm rows ran only the signal-only rules (their run files hold no summary or page text).
- **Not reproduced:** the "Metropolitan Warehouse and Delivery" lease article reported as a false `weak_hiring_signal` does not match the old keyword check on any recorded summary (S1 agent reps 1 and 3, live-deposco, demo, agent-icp1); it is accepted before and after. The same failure shape does exist in recorded data: a King of Freight facility summary ("plans to hire 100 employees") matched the old keywords, and a demo Interstate Capital cold-storage article ("could bring up to 225 jobs") does too. Both are `new_facility` signals and are no longer flagged.

## 23. A verbatim quote proves provenance, not truth (Verst, 507 employees) [measured, OPEN]

- **Symptom:** 2026-10-14 live run (S1 rep 2): Verst Logistics was accepted as a lead and the blind web judge scored it Q2 "no" (size). It is the only miss in 13 accepted leads (12/13 = 0.92).
- **Layer:** gate/source. **Cause:** the size gate requires a verbatim quote and code verifies the quote is on the captured page. The quote "Employees: 507" is on the page: Exa's company profile says Verst "employs 507 people". The quote check therefore passes, but it only shows the summariser did not invent the figure; the profile page itself disagrees with the judge's source (`builtin.com`). One aggregator page is the only evidence for the size, and the S1 plan allows 100 to 1000, so a wrong headcount inside the range is accepted. The verdict file stores no reasoning or number (`eval/truth/S1/verstlogistics__f8f7b70ca5.json`), so the true headcount is not in the repo.
- **Fix:** none yet. Candidates, neither built nor tested: (a) a second-source headcount check, where an independent page must agree within a tolerance or the lead stays a candidate (costs a lookup per lead and lowers recall further); (b) the online judge with the evidence payload, routing a disagreement or cannot_verify to the review queue (not yet calibrated, SPEC-observability "To go live").
- **Evidence:** Verst is on the same signal URL in all 3 pilot agent reps and in this run; the quote gates were new and did not change the outcome. 1 of 13 leads, so the rate is unmeasured (n too small for the 98% bar).
- **Earlier:** a check that a quoted size is corroborated by a second source, run at submit time, would have flagged this lead. A replay cannot show it: the recorded lookups hold one source per company.

## What we would monitor weekly

Extends SPEC-agent §14; a breach rolls back one stage.

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
| Judge parse failures; share of "cannot verify"; leads with no verdict | Eval health | 8–11 |
| Runs with 0 verification reads  | The agent is not verifying | — |
| Planner 5xx and decision 409 rates | Client/server contract drift | 12–15 |
