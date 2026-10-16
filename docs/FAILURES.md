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
- **Before → after:** "1 enterprise" → pilot S1 agent rep 2: `size 13, enterprise 3` (`eval/results/pilot-2026-10-12/S1/B_agent_opus/2/state.json`).

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

## 24. Quota lock timed out under 20 concurrent writers on a slow CI runner (fixed deadline, no backoff) [measured]

- **Symptom:** 2026-10-15 GitHub Actions (ubuntu, vitest): `eval/quota-lock.test.ts > 20 concurrent addVisitorSpend` failed with `LockTimeoutError` after 2100 ms. Green on the developer's Mac.
- **Layer:** infra/concurrency. **Cause:** `withFileLock` had a fixed 2 s deadline, a flat 5-25 ms random poll (no backoff), and every in-process waiter polled the disk (open + stat) through the shared 4-thread libuv pool. Under load the pollers queued ahead of the holder's own release `rm`, so each hand-off cost far more than the ~6 fs ops of the critical section, and waiters were unordered so one could starve. Worst case: 20 holders x (6 ops x t_op + poll gap ~17 ms mean) must fit in 2 s; at 10x slower fs (t_op ~3 ms) that is 20 x ~35 ms = 0.7 s on paper, but the contended pool pushed hand-off to ~100 ms (2100 ms / 20), so the deadline was exceeded. Stale detection (10 s by mtime alone) could also have reclaimed a slow but live holder.
- **Fix:** in-process FIFO queue per lock path (waiters no longer touch the disk); disk lock records pid+timestamp+token, waits with exponential backoff and jitter (5 to 100 ms), default deadline 10 s (quota passes 15 s explicitly), stale only when older than 30 s AND the pid is dead, release only if the token is still ours, always in finally.
- **Test:** `eval/quota-lock.test.ts` (20 concurrent spend with no `LockTimeoutError`; 50 writers x 50 ms past the old deadline; 50 writers behind an external holder; dead/alive/fresh stale cases; backoff bounds).
- **Earlier:** a stress test with an artificially slowed critical section would have exceeded the 2 s deadline on any machine.

## 25. Lookup-stage quote rejections are nondeterministic; 5 3PLs screened in one run, 7 lookups lost to `fetch failed` [measured]

- **Symptom:** 2026-10-15 memory eval, S1 arm B (three reps of the same run, same plan): rep 2 screened five lookups `quote_not_in_page` (A. Duie Pyle, Spartan Logistics, Cleveland Group, King of Freight, Hollingsworth Logistics Group); reps 1 and 3 screened two each (rep 1 Spartan + Southern AG Carriers, rep 3 XDP + Spartan). Hollingsworth was accepted in rep 3 with a different quote. Separately 7 lookups (3 + 2 + 2, Davidson twice) returned `error: fetch failed`. The brief said "6 in rep 2" and "2 fetch failures"; the events show 5 and 7.
- **Layer:** gate/source (quote matcher), Exa summariser, transport. **Cause:** replayed every one of the 9 screened lookups against its recorded Exa response (`npx tsx eval/replay-quotes.ts`, `eval/results/quote-replay-2026-10-15.md`). One is a matcher bug; the other eight are quotes that are not page text. None is truncation (longest page 16,980 < 20,000) and none is quoted from `results[1]`.
  - **Matcher bug (XDP, 1):** the quote has an explicit ellipsis ("...+11 people) ... with offices in Tamworth"). `quoteClauses` merged the short piece "+11 people)" forward across the ellipsis into "11people" + "withofficesin..." which exists nowhere on the page. Both halves are contiguous page text.
  - **Not verbatim (8, correct rejects):** bare figure "281" / "679" for `employee_estimate_source` (3 chars; the page has "Employees: 281"); "281 employees" (label and value reversed); summariser commentary instead of a quote (Cleveland "it does not state ... third-party logistics", whose gate value is also `no`; Hollingsworth "listed under capabilities and services; company described as ..."); Southern AG with words silently dropped ("They offer", "are"); A. Duie Pyle `signal_quote` with the appositive "(Pyle), a premier ... solutions," silently deleted (a signal-side quote, and the company has 1,560 employees against the S1 band of 100 to 1000, so it was out anyway); Spartan rep 3 joined two real sentences 717 stripped chars apart with "..." (window is 600).
  - The same summariser prompt produced a passing quote for the same page in another rep, so which rejects occur is run-to-run noise, not a property of the company.
  - **`fetch failed`:** Node `fetch` rejects with a bare `TypeError: fetch failed` (the reason is in `error.cause`) when no HTTP response arrives. `fetchWithRetry` retried only 429/5xx, so a connection error escaped on the first attempt with no cause in the message, and the model treated the company as a dead end. It is Exa transport; `lookup_company` fetches no page itself.
- **Fix:** (1) `quoteClauses` cuts at an explicit ellipsis before merging short pieces, so a piece never crosses an elision; a part still under the clause floor is `too_short`. Floors (12-char clauses, 6 for headcount/hq/dates), order and the 600-char window are unchanged. (2) `lookup_company` retries the Exa lookup once when a REQUIRED gate that the lookup claims true fails its quote (not size, hq, enterprise, a false/null gate, or a truncated page, and only when that quote is what blocks the known signals): the summary query gets "Copy each quote as ONE contiguous span of at most 200 characters exactly as it appears on the page." plus a `[quote retry 1]` marker, so the request and its record/replay hash differ. Both calls go through `CostGuard`. The better of the two is kept by gate verdict (accepted > candidate > rejected; ties keep the first). A `lookup_retry` event records company, key, before, after, outcome and the retry cost. (3) A network failure (`ExaNetworkError`, message names `error.cause.code` and the host) is retried once under the same cap: at most one automatic retry per company per run, whichever kind comes first (`RunState.lookupRetries`).
- **Before -> after (replay, $0):** 0 of 9 screened lookups passed the quote check; 1 of 9 (XDP) passes now. Across all recorded quote fields (live-quotes-2026-10-14 + this eval, 2,966 fields) the ellipsis change gained 2 (XDP, Stord) and lost 0 at the matcher's own floors. The retry is expected to recover Southern AG, Hollingsworth and Spartan rep 3 (3 of the 8; unmeasured until a live run).
- **Size quotes:** `headcountQuoteInText` (used for `employee_estimate_source` only, before the general matcher) accepts a bare number N, "N employees" or "N staff" when the lookup page has N (not part of a larger number) within 40 characters of an employee word; "Employees: 281" supports "281", "281 trucks" does not. `details.size_quote_match` records `phrase` or `number_adjacent`. Replay: Spartan (rep 1 and 2) and King of Freight now pass, so 4 of the 9 screened lookups pass (XDP + 3). Summary queries (`src/plan.ts`) now ask for the phrase containing the number as written ("Employees: 281") and for the page's own words with no commentary on every gate quote ("" and null when not stated); that instruction change cannot be replayed and is unmeasured.
- **Not covered:** signal-side quotes (A. Duie Pyle) and the remaining non-verbatim gate quotes (Southern AG, Cleveland, Hollingsworth, Spartan rep 3), which only the retry and the instruction can help. No live run has exercised the retry: the effect on the 98% bar is unmeasured.
- **Test:** `eval/gates.test.ts` (XDP ellipsis join; ellipsis still rejects reordering, absent text and distance; short part is `too_short`; the not-verbatim cases stay rejected) and `eval/lookup-retry.test.ts` (fails then passes; fails both; no retry for false gate / truncated / size / hq; budget; real `lookupCompany` path with the CostGuard and a different request hash; network error named, retried once, cap shared; `lookup_retry` event).
- **Earlier:** replaying the three recordings against the matcher the day the memory eval finished would have shown the XDP join immediately; counting `fetch failed` per run in the trace summary would have shown that 7 lookups were lost to transport.

## 26. Job-board company pages pass the 2-roles rule; 3 of the 4 bad leads in one memory-eval run were listings [measured]

- **Symptom:** 2026-10-15 memory eval rerun (`memory-eval-2026-10-15b`, S1, run A): 7 leads delivered, 3 good. The 4 bad ones all failed Q3 (signal): NXTPoint Logistics (`snaprecruit.com/job/operations-supervisor-1st-jessup...`), Fetch Package (`jobs.capitalfactory.com/companies/fetch-package/jobs/...`), Port City Logistics Inc (`jobtarget.com/jobs/jt-h76triz8qz/manager-warehouse-operations-savannah-georgia`) and Constellation Cold Logistics (`bbc.co.uk/news/articles/c74kl803n1yo`).
- **Layer:** gate/source filtering (reopens #22). **Cause:** (1) `BUILTIN_EXCLUDED_SIGNAL_DOMAINS` is a list of known boards and did not hold snaprecruit, jobtarget or the Capital Factory jobs host. (2) The `weak_hiring_signal` fallback passes a hiring signal that names at least two distinct roles unless the page is on the company's own domain. That rule was meant for a company's own careers page. A third-party board's company page (`.../companies/fetch-package/jobs`) lists several roles by construction, so it passes. The three listings were all typed `ops_hiring_wave` / `ops_hire`. (3) Constellation is a different failure and no URL rule can catch it: the BBC article (2026-08-27) reports a council approval of an 80m GBP Wolverhampton cold store; the judge fetched Place Midlands and Express & Star and found the approval happened in late May to early June 2026, before the window opens on 2026-07-15 (verdict note, `eval/truth/S1/constellationcoldlogistics__f20417d01f.json`; the judge could not fetch the BBC URL itself, `url_not_allowed`). The summary's event date was inside the window; the event was not. Open.
- **Fix:** (1) `checkLead` rejects `non_event_page` ("job listing on a third-party site") when the signal URL is listing-shaped (host starts `jobs.`, `careers.`, `career.`, `apply.` or `boards.`, or a path segment is `job`, `jobs`, `career(s)`, `vacancy/vacancies`, `position(s)`, `opening(s)`) AND its registrable domain differs from the lookup URL's, or there is no lookup URL (unknown counts as third-party). Plan-independent; own-domain careers pages are not caught by it. (2) Domain list gains `snaprecruit.com`, `jobtarget.com`, `jobs.capitalfactory.com`; no other `q3 = no` verdict in `eval/truth` had a listing URL that was not already covered (snagajob, ihirelogistics, tealhq, jobs.ashbyhq.com are listed; the Updike LinkedIn `/posts/` URL is a post, not a listing). (3) `weak_hiring_signal` is unchanged: it still runs on whatever the listing rule lets through (own-domain pages pass it automatically, as before; third-party pages that are not listing-shaped, such as a news item about hiring, still need two roles).
- **One good lead is lost, by design:** Jay Group (`thejobsmap.com/job/...`, a single VP of Operations post that mentions a new 250k sq ft Houston facility) was judged good, but only because the aggregator's "More jobs at Jay Group" list supplied a second role, and the verdict carried a spot-check flag. The rubric counts a job post only on the company's own site or with at least two named roles, so the rule rejects it. An earlier draft exempted pages whose summary declared a non-hiring `signal_type`; that was removed because the rule must not trust the summariser's label.
- **Before -> after (replay, $0, deterministic rules only, `evidenceMode: "skip-quotes"`; `eval/results/gate-replay-2026-10-15.md`):** across every judged lead in the pilot and the three later sets, 3 bad lead-reps newly rejected (NXTPoint, Fetch Package, Port City, all in `memory-eval-2026-10-15b` run A), 1 good lost (Jay Group, `memory-eval-2026-10-15` run 3, reason above). They are caught by the new domain entries first; the URL-shape rule alone catches those three plus Jay Group. Run A of that set projects from 3 good of 7 to 3 good of 4 (the remaining bad lead is Constellation); over the set's three runs 17 of 18. The pilot and live-quotes numbers are unchanged. Not re-measured live.
- **Test:** `eval/gates.test.ts` ("third-party job listings": snaprecruit-shaped path, `jobs.` and `careers.` subdomain, unknown company domain treated as third-party, own-domain careers page still allowed, slug words such as "jobs-per-shift" not matched, any declared `signal_type` still rejected (Jay Group shape), the three new domains).
- **Earlier:** a replay of every judged lead against a URL-shape rule when #22 was fixed would have shown that the domain list alone was a blocklist of known boards, and that the two-role fallback was a loophole for any board with a company page.

## 27. Facebook page URL profiled facebook.com; every non-website input shape was misread [measured]

- **Symptom:** 2026-10-16, observed live: input `https://www.facebook.com/SASairconditioning/` came back "Tell us in one sentence". Related shapes failed the same way unobserved: a bare company name ("SAS Airconditioning") was taken verbatim as the offering sentence; a Linktree, Shopee shop or Google Maps link was profiled at its host.
- **Layer:** planner input resolution (`src/planner/resolve.ts`, `profile.ts`). **Cause:** `classifyInput` knew two shapes besides text: an Instagram handle (resolved through Exa to the seller's own site) and "anything URL-like". The second went to `normalizeOrigin`, which dropped the path and fetched `https://facebook.com`, `/about`, `/about-us`, `/pricing`: the platform's pages, which describe no seller, so `offering` was empty and the fallback fired. Facebook was in `SOCIAL_HOSTS`, but that set only filtered Instagram candidates. A bare name matched neither URL test, so it fell through to `text`.
- **Fix:** one pipeline, `classifyInput` then `resolveToSite`, for every shape (contract: SPEC-v2 section 2 [0]): website and carrd/pop.site pages are profiled directly; social profiles, bio links, map links and bare company names are searched once on Exa (`facebook.com/<handle> official website`, `<name> official website`), filtered through `SOCIAL_HOSTS` + `MARKETPLACE_HOSTS` + `MAPS_HOSTS` + `BIOLINK_HOSTS`, and shown as "Is this your website? We found it from your Facebook page."; marketplace storefronts are profiled at their own URL with `profile.channel = "marketplace:<platform>"`; contact links get a specific refusal. `normalizeOrigin` is replaced by `profileTarget`, which throws `ProfileTargetError` for any social, bio-link, maps, name, text or contact input, so no caller can collapse a platform URL to its host again.
- **Before -> after:** the reported URL: profiled `facebook.com` (empty offering) -> Exa query containing `facebook.com/SASairconditioning`, candidates with facebook/instagram/yelp/shopee removed, the chosen domain profiled. Not re-measured live.
- **Test:** `eval/planner-resolve.test.ts` (one classify case per input shape incl. the exact URL; resolve per shape; `profileTarget` throws for platform URLs; route response shapes, CostGuard(0.10), demo fixtures; the candidate heading names the platform).
- **Not covered:** how often the right domain is among the top 5 for these shapes is unmeasured (the only evidence is the 3/3 Instagram probe, SPEC-v2 section 8 A3). The bio-link path reads the page's text for URLs and has not been run against a live Linktree. Link-in-bio pages whose links are click-tracked redirects (`l.instagram.com/...`) yield no outbound domain and fall back to the handle search.
- **Earlier:** feeding one URL per platform through `classifyInput` and asserting the pages that would be fetched. The tests only exercised the Instagram handle and a plain site.

## 28. Run routes accepted any caller who knew the run id [measured]

- **Symptom:** 2026-10-16, found while adding the event stream: `GET /api/runs/:id/events` checked that the caller's workspace owns the run, but `GET /api/runs/:id`, `POST step`, `POST stop` and `POST decision` did not. Anyone holding a run id could read the run, drive it, approve or decline its pending approval, or stop it, and every step spent the owner's visitor allowance and the daily budget. Not exploited; run ids are UUIDv4, so a leak (a shared link, a log, a screenshot) was the only path.
- **Layer:** API routes (`app/api/runs/[id]/*`). **Cause:** ownership was checked inline in the one route written last; the older routes predate workspaces being the access boundary and nothing made the check shared, so adding a route meant remembering it.
- **Fix:** one helper, `requireRunOwner(request, runId, { allowQuery? })` in `app/api/_shared.ts`, used by all five run routes (the events route's check moved into it): 400 without a valid `x-workspace-id` (the `?workspaceId=` query is read only when `allowQuery` is set, which only the events route does because EventSource cannot send headers), 404 for an unknown run, 403 for another workspace's run, checked after the rate limit and before any state load, lock, spend or policy line. Demo runs go through the same check (their session's workspace), so `POST /api/runs` with `mode: "demo"` now needs a `workspaceId` (400 otherwise) instead of minting a random one that nobody could reach.
- **Before -> after:** a stranger's GET/step/stop/decision on a known id: 200 and acted -> 403, state version and spend unchanged.
- **Test:** `eval/api-controls.test.ts` ("run routes check that the caller's workspace owns the run": 400/403/404 on every route, the stranger changes nothing, query not accepted, owner 200, demo run ownership); `eval/live-stream.test.ts` still covers the events route.
- **Not covered:** the workspace id is a bearer secret kept in the visitor's localStorage, not an account; anyone who learns both ids has the run. The route-level `rate_limit` policy line (step) is still written for a run id before the owner check; it is throttled to one line per minute per run.
- **Earlier:** a test per route listing the access matrix (no workspace, other workspace, unknown run, owner) when the events route was written would have shown four routes without it.

## 29. Aggregator mirror page verified a contact; stale press release counted as current [measured]

- **Symptom:** 2026-10-16, first live `find_contacts` (Verst Logistics, $0.019, 11.7 s): `muraena.ai/profile/virgil_chandler_7a81e5b6`, a scraped-profile mirror, produced a VERIFIED contact ("VP of Warehousing"). A second verified contact, Todd Johnson "President and COO", rested on a PR Newswire release (id 300836065) from 2019: a seven-year-old "names X as new President and COO" is not proof of a current role.
- **Layer:** contact gate (`checkContact`, `src/gates.ts`). **Cause:** "not an aggregator" was a finite domain list, and mirrors are endless; and a page's age was never read, so any page that quoted a fitting title verified.
- **Fix:** a page verifies only if its registrable domain is the company's own, or it is press: not on the (extended) aggregator list, not shaped like a profile or directory (`/profile/`, `/person/`, `/people/`, `/employee/`, `/contact/`, `/in/`, `/pub/`, `/directory/`, `/company/<x>/people`, `?person=`), and with at least 200 characters of prose around the name and title (aggregators are field lists). Everything else is inferred. Evidence now carries `published` (Exa `publishedDate`, else a full date written within 400 characters of the quote, else none). Press older than 24 months verifies only if the people index lists the same person in a current approved role at the company; otherwise the contact is inferred (`contact_stale`), `why` is the quoted title, and the note reads "last confirmed 2019". Company-domain pages have no age rule but record their date. The lead line shows the date (muted) and the evidence row shows it next to the host.
- **Also found:** the probe passed the run guard through `deps`, which `findContacts` never read, so the guard showed spent 0 while the call cost $0.019. The run guard is `input.guard` (the tool passes it, and it was charged); `deps.guard` is now a type error and a thrown error instead of silently ignored.
- **Before -> after:** the muraena page: verified -> inferred (`contact_unverified`); the 2019 release alone: verified -> inferred "last confirmed 2019"; with a current people-index entry: verified, 2019 date shown.
- **Test:** `eval/contacts.test.ts` (muraena-like page, eleven aggregator URL shapes, prose rule, company domain verifies at any age, 2019 press with and without the index entry, the 24-month line, date from text, guard path); `app/ui/contacts-ssr.test.tsx` (date on the line and the evidence row).
- **Not covered:** an undated press page (no `publishedDate`, no date near the quote) has no age to judge and can still verify. The 200-character prose test is a heuristic: a long field list with sentence-like text would pass, and a short real bio (a one-paragraph conference page) would not. A recent press page proves the role at that date, not today. None of this is measured on more than the one live probe.
- **Earlier:** feeding the first live probe's three results through the gate before shipping would have shown both defects; the unit tests used one invented team page on the company's own domain.

## 30. Directory page, former role, duplicate person and lowercase name in one live contacts run [measured]

- **Symptom:** 2026-10-16, second live `find_contacts` run (6 leads, 12 contacts, $0.076, recorded at `eval/recordings/contacts-2026-10-16/S1/agent/`): (1) Donald Finney, "Operational Director And Mentor", VERIFIED on `visualvisitor.com/companies/5788692/bay_logistics_inc.`, a company-directory page; (2) Paul Taylor VERIFIED as COO from "Managing Director, stepping up from his previous role as Chief Operating Officer"; (3) "Neil Midgley" (verified) and "Neil Midgley FCILT" (inferred, LinkedIn) shown as two people; (4) "kurt cuncannan" shown lowercase.
- **Layer:** contact gate (`checkContact`, `src/gates.ts`) and `findContacts` (`src/contacts.ts`). **Cause:** (1) the host and the aggregator shapes were a floor FAILURES #29 had not reached (`/companies/<id>/<slug>` has none of the listed path segments; the page has 200+ characters of directory prose around the name); Finney's title matched "VP of Operations" legitimately on the function word (operational -> operations), so the title rule was not the defect. (2) the gate checked that a role-fitting title is on the page next to the name, never whether the page says it is over. (3) names were deduped on tokens that included the post-nominal. (4) the name was taken from the people index / summariser, not the page.
- **Fix:** (1) `/compan(y|ies)/<digits>` is an aggregator shape; visualvisitor, dnb, hoovers, buzzfile, manta, bizapedia, opencorporates, corporationwiki, growjo, tracxn, aeroleads, globaldatabase, kompass join the excluded hosts. (2) A former-role phrase (`former(ly)`, `previous/prior role|position|title`, `stepping/stepped up|down|aside`, `moved/promoted from`, `outgoing`, `retired/retiring`, `succeeded by`, `succeeds <this person>`, `ex-<title>`, `until <year>`, `was <title>`, `, now <Title>`) in the quote, or within 160 characters of the title inside its paragraph, means the matched role is not current: `contact_role_changed` (inferred, note "role changed", never verified, and the people-index listing does not rescue it). When the quote splits on the phrase, the part before it is the new title and must itself fit a role to verify. (3) `personNameTokens` drops trailing post-nominals (explicit list: FCILT, MBA, PhD, CPA, Jr, Sr, II-IV, ...); `dedupeContacts` keeps the higher tier and attaches the profile link. (4) `checkContact` returns the name as the evidence page writes it; an all-lowercase or all-uppercase name is title-cased (`properCaseName`), also for index-only contacts.
- **Before -> after (replay of the recording, `npx tsx eval/replay-contacts.ts`, $0):** Finney verified -> inferred (`contact_unverified`); Paul Taylor verified -> inferred (`contact_role_changed`, "role changed"); Neil Midgley + Neil Midgley FCILT -> one verified record with the profile link; "kurt cuncannan" -> "Kurt Cuncannan"; Spartan (3), RK James Bryant and Bay Jon Swart / Kurt stay verified.
- **Test:** `eval/contacts.test.ts` (the FAILURES #30 blocks: directory host and `/companies/<id>/` shape on an unknown host, phrase list, new-title-verifies, "previously" bio and next-paragraph neighbour not flagged, post-nominal and initial dedupe, casing); `eval/replay-contacts.ts` (manual, $0).
- **Not covered:** the former-role phrase list is English and finite ("stood down", "left the business" are not in it); a flagged neighbour inside the same paragraph as a current executive downgrades that executive (safe direction, but a miss on a dense press paragraph). "Operational Director" still fits "VP of Operations" (rank is not compared when the role names a function, by design since Director of Operations must verify); an "Operations Coordinator" would also fit. The post-nominal list is explicit, so an unlisted credential still makes a second person. Measured on one recording of four leads.
- **Earlier:** FAILURES #29 was verified against the three probe results it was found in, not against a second run; this run found four more gaps in the first twelve contacts.

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
| `lookup_retry` events by reason and outcome; lookups screened `quote_not_in_page` | Summariser noise; retries that did not help | 25 |
| Accepted leads whose signal URL is listing-shaped (`jobs.`, `/job/`, `/careers/`) or whose domain is a board; `non_event_page` rejects by reason | Job boards the list does not know yet | 22, 26 |
| Describe: share of profile requests ending in "Tell us in one sentence" by input shape (`kind` / `source`); candidates lists where nobody picks a domain | Input shapes the resolver misreads | 27 |
| Run-route 403s (a stranger holding a run id) | Leaked run ids or a client not sending the workspace header | 28 |
| Verified contacts by evidence host and age; `contact_stale`, `contact_role_changed` and prose-rule inferred counts | Aggregators the rules miss; press that is too old to trust; former roles | 29, 30 |
| Exa 429/retry count; p95 turn time vs the 60 s route limit | Load and hosting | — |
| Judge parse failures; share of "cannot verify"; leads with no verdict | Eval health | 8–11 |
| Runs with 0 verification reads  | The agent is not verifying | — |
| Planner 5xx and decision 409 rates | Client/server contract drift | 12–15 |
