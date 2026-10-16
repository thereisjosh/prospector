# Prospector

Prospector finds B2B sales leads. A seller pastes their website and approves a short plan; an agent (Claude Opus 5.5 over the Exa search API) looks for companies with a recent, cited "why now" event such as a new warehouse, a funding round or an operations hire. Code, not the model, checks each company against the plan. The output is leads with source links, the companies turned down and why, up to three named people to reach at each lead (each marked verified or inferred), and a CSV. It is aimed at sellers whose buyers are mid-market companies with a public footprint (press, trade news, LinkedIn headcounts): logistics, SaaS, funded startups, manufacturers. The repo also holds a fixed-query workflow as a control arm.

**Result.** On 2 scenarios × 3 reps, judged blind, the agent passed every rep (pass^3 = 1) at $0.07–$0.14 per good lead. The workflow, with the same contract and the same $1.00 cap, passed none. The agent's S2 precision sits exactly on the 0.80 bar, and the agent has flaws the pass rate hides: it almost never checks pages (1 read in 9 runs), rarely changes tactics, and lets its checklist go stale. [§2](#2-whats-wrong-with-the-agent-observed) lists them with evidence. Everything built after the pilot (live streaming, the input resolver, search-scoped memory, the contacts step, the new visual system) has tests but no judged run: the pilot numbers above predate it, and [§9](#9-what-is-not-built) lists what is still missing.

| Document | What it is |
|---|---|
| [docs/FAILURES.md](docs/FAILURES.md) | 30 failures found in this build: symptom, layer, cause, fix, before → after |
| [docs/EVAL-DETAIL.md](docs/EVAL-DETAIL.md) | Pre-pilot smoke run, S2 miss breakdown, judge history, build cost |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 22 decisions with alternatives, evidence and what would change them |
| [docs/SPEC-agent.md](docs/SPEC-agent.md) | Agent spec: loop, tools, autonomy (§5a), guardrails, evals, rollout (§14) |
| [docs/prompts.md](docs/prompts.md) | System prompt and tool descriptions, verbatim, with the reason for each section |
| [eval/RUBRIC.md](eval/RUBRIC.md) | Scoring rubric, frozen before the first scored run |
| [docs/DEMO.md](docs/DEMO.md) · [docs/DEPLOY.md](docs/DEPLOY.md) | 3-minute demo script · Railway deployment |
| [docs/SPEC-v2.md](docs/SPEC-v2.md) · [docs/SPEC-givingsg-variant.md](docs/SPEC-givingsg-variant.md) | Planner and workflow engine · a design exercise, **not built** |
| [DESIGN.md](DESIGN.md) · [docs/UI-REWORK.md](docs/UI-REWORK.md) | The visual system (pop.site reference, tokens, bans) · the UI rework plan, gate results (§7) and the rebuild (§8) |
| [docs/RESEARCH-contacts-and-graph.md](docs/RESEARCH-contacts-and-graph.md) | Contacts and relationship-graph research: tools, LinkedIn limits, law, design, build order (step 1 is built) |

## 1. Results

**Rubric** (`eval/RUBRIC.md`): each accepted lead is judged blind on Q1 fit, Q2 size and Q3 signal (real, specific, inside the window), each answer with a source URL. Good = Q1 yes, Q3 yes, Q2 not no. A run passes with ≥ 6 good leads at precision ≥ 0.80 within budget. pass^3 = 1 only if all 3 reps pass.

**Setup:** A = workflow (fixed queries, no model in the loop), B = agent on Opus 5.5. Same contract, target 10 leads, $1.00 cap. S1 = ICP-1 logistics, S2 = ICP-3 funded B2B. Per-rep data: `eval/results/pilot-2026-10-12/report.md` (scorer output), `*/*/*/run.json` (spend), `eval/truth/S1/`, `eval/truth/S2/` (verdicts).

| Scen. | Arm | Rep | Accepted | Good | Precision | Spend (Exa + Claude) | $/good | Time | Stop | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | A | 1 | 4 | 2 | 0.50 | $0.746 (Exa only) | $0.37 | 55 s | finish | no |
| S1 | A | 2 | 9 | 2 | 0.22 | $0.773 | $0.39 | 52 s | finish | no |
| S1 | A | 3 | 6 | 2 | 0.33 | $0.764 | $0.38 | 57 s | finish | no |
| S1 | B | 1 | 10 | 9 | 0.90 | $0.812 ($0.443 + $0.369) | $0.09 | 135 s | target | yes |
| S1 | B | 2 | 8 | 7 | 0.88 | $0.853 ($0.504 + $0.349) | $0.12 | 120 s | budget | yes |
| S1 | B | 3 | 7 | 6 | 0.86 | $0.850 ($0.474 + $0.376) | $0.14 | 132 s | finish | yes |
| S2 | A | 1 | 4 | 0 | 0.00 | $0.899 | n/a | 91 s | budget | no |
| S2 | A | 2 | 4 | 1 | 0.25 | $0.898 | $0.90 | 69 s | budget | no |
| S2 | A | 3 | 4 | 0 | 0.00 | $0.898 | n/a | 60 s | budget | no |
| S2 | B | 1 | 10 | 8 | 0.80 | $0.848 ($0.492 + $0.356) | $0.11 | 153 s | target | yes |
| S2 | B | 2 | 10 | 8 | 0.80 | $0.520 ($0.312 + $0.208) | $0.07 | 73 s | target | yes |
| S2 | B | 3 | 10 | 8 | 0.80 | $0.782 ($0.477 + $0.305) | $0.10 | 102 s | target | yes |

| Cell | Mean good | Mean precision | Mean $/good | pass@1 | pass^3 |
|---|---|---|---|---|---|
| S1 workflow | 2.00 | 0.35 | $0.38 | 0.00 | 0 |
| S1 agent | 7.33 | 0.88 | $0.12 | 1.00 | 1 |
| S2 workflow | 0.33 | 0.08 | n/a | 0.00 | 0 |
| S2 agent | 8.00 | 0.80 | $0.09 | 1.00 | 1 |

**Reading.** The agent's margin over the workflow is large on both scenarios; its margin over the pass bar is not. S2 is 8/10 in every rep, so one more miss per rep fails it, and S1 rep 3 had exactly the 6 good leads the bar requires. The S2 misses were 2 wrong funding stage, 3 size, 1 unverifiable signal ([detail](docs/EVAL-DETAIL.md#s2-agent-misses-6-non-good-slots-across-3-reps)). The report reproduces at $0: `npm run eval:score -- --set pilot-2026-10-12` rewrites `report.md` with no diff.

**Live runs since the pilot** (not judged): deposco.com walkthrough, 12 turns, 10 leads, $0.73 (`eval/recordings/live-deposco-2026-10-13/state.json`); public smoke from the deployed URL, 13 turns, 8 leads, $0.83 (`eval/recordings/public-smoke-2026-10-13.txt`).

**2026-10-14 live run with evidence-required gates** (set `live-quotes-2026-10-14`; S1 and S2, agent arm only, 2 reps each, $1.00 cap; report `eval/results/live-quotes-2026-10-14/report.md`, recordings `eval/recordings/live-quotes-2026-10-14/`, verdicts `eval/truth/S1/`, `eval/truth/S2/`). Rep 1 ran before the quote-matcher fix (`5e88d4f`), rep 2 after it.

| Scen. | Rep | Matcher | Leads | Good | Precision | Spend (Exa + Claude) | Stop |
|---|---|---|---|---|---|---|---|
| S1 | 1 | before fix | 4 | 4 | 1.00 | $0.872 ($0.456 + $0.416) | finish |
| S1 | 2 | after fix | 6 | 5 | 0.83 | $0.853 ($0.483 + $0.370) | finish |
| S2 | 1 | before fix | 0 | 0 | n/a | $0.565 ($0.314 + $0.251) | finish |
| S2 | 2 | after fix | 3 | 3 | 1.00 | $0.820 ($0.475 + $0.345) | finish |
| All | | | 13 | 12 | 0.92 | $3.11 | |

**Reading.** The change: required company facts and the why-now signal now need a verbatim quote, and code checks the quote against the captured page text (FAILURES #21, #22). A missing quote makes the company a candidate, not a lead. Rep 1 shows the cost of getting the matcher wrong: it rejected 1 genuine quote in S1 and 3 in S2, which is why S2 rep 1 returned no leads (`eval/results/quote-replay-2026-10-14.md`). Of the 13 accepted leads, 12 were good (blind web judge; every lead passed Q1 and Q3, and the miss failed Q2). That is 0.92 on n = 13, which cannot support a claim about the 98% bar: even 13 of 13 would leave the 95% interval's lower bound at 0.77, and showing 98% takes on the order of 150 leads with no miss. Recall paid for it: the agent returned 0 to 6 leads per run (0 to 5 good) against 7 to 10 accepted (6 to 9 good) per pilot run, because lookups now fetch page text and each rejected quote costs a turn; no run reached the 10-lead target and none passed the 6-good-leads bar (`pass` is "no" in all four cells). The one miss is Verst Logistics (size): the gate accepted it on "Employees: 507" quoted from Exa's company profile, and the judge found the size wrong (flaw 5c, FAILURES #23). A verbatim quote proves the summariser did not invent the fact; it does not prove the source is right. Judging note: 7 of the 13 leads reuse verdicts written on 2026-10-13 for the same company and signal URL (the pilot-era judge), and the 4 verdicts written on 2026-10-14 cost $1.38 in total (`costDollars` in the verdict files). Per-lead table: [docs/EVAL-DETAIL.md](docs/EVAL-DETAIL.md#live-quote-gates-run-2026-10-14).

**Memory eval, 2026-10-15** (S1; run A empty workspace, B same workspace with A's memory, B' control in a fresh one; details in [docs/EVAL-DETAIL.md](docs/EVAL-DETAIL.md#memory-eval)). The first run failed: B 1 good of 1 against the control's 8 of 8, caused by 5 lookup-stage quote rejects and 7 network failures, not memory (FAILURES #25). After the fix the rerun passed: A 7 leads, 3 good; **B 8 of 8 good, all 8 new vs A, 2 paid lookups skipped; B' 6 of 6 good, with 2 repeats of A.** That shows the mechanism works (B is told what A saw and does not redo it); it does not show B is better, because n = 1 per cell and the 2-lead margin is inside the pilot's noise. Caveat: A's 3 of 7 exposed a precision hole. Three of A's four bad leads were job-board listings (snaprecruit, jobs.capitalfactory.com, jobtarget) that the two-roles rule let through; the fourth, Constellation Cold Logistics, was an event dated before the window, which no URL rule catches. The listing hole is fixed in code (FAILURES #26) and replayed on every judged lead (3 bad caught, 1 good lost by design: Jay Group, a single thejobsmap.com job post the rubric would not count; `eval/results/gate-replay-2026-10-15.md`), but it has not been re-measured live. Also, A stopped on budget and wrote no self-note, because the `remember` offer only fires on `finish`, so the PASS run did not exercise note recall.

## 2. What's wrong with the agent (observed)

"Runs" below means the 9 recorded agent runs: the pre-pilot smoke run (`eval/recordings/agent-icp1-2026-10-12/agent/`), the 6 pilot runs (`eval/results/pilot-2026-10-12/S*/B_agent_opus/*/`), the deposco walkthrough and the public smoke. Counters come from each `state.json` `adaptive` field; tool counts from each `events.jsonl`.

| # | Flaw | Evidence | Status |
|---|---|---|---|
| 1 | **It almost never verifies.** The prompt says "Verify when in doubt … `read_page` the signal URL first" (`docs/prompts.md`, Working). It trusts lookup summaries it could have checked. | `verificationReads` = 0 in 8 of 9 runs (smoke, 6 pilot, deposco). The public smoke made 1 `read_page` call (turn 11) and submitted nothing from it. | Open |
| 2 | **It rarely changes tactics.** "Adaptive" behaviour is mostly skipping lookups. The rubric's "workflow-shaped" flag (`adaptive = 0`, `eval/harness/score.ts:147`) is weak because skips alone clear it. | Pilot query rewrites: S1 0 / 0 / 0, S2 1 / 0 / 1. Skips: S1 39 / 49 / 53, S2 11 / 17 / 22. These used the original counter (a new query after a submit rejection): the pilot ran 14:44–14:59Z and `f2bd783`, which also counts lookup-stage trouble, was committed at 15:03Z (inferred from timestamps). Under the wider counter deposco counted 6. | Open (flag); counter fixed |
| 3 | **It doesn't keep its checklist.** The prompt asks for `update_todo` "whenever the picture changes"; the user watches that list. | `update_todo` called 0 times in deposco and the public smoke, 1–2 times in the other 7. In all 7 the final todo understates accepted leads: smoke "4 of 10" (written turn 6) vs 6 accepted; S1 rep 3 "2 of 10" vs 7; S2 rep 2 "3 of 10" vs 10. | Open |
| 4 | **Signal-type drift.** A COO appointment passes as a why-now because the contract lists an ops-hire type. In both cases it was the run's last accepted lead, filling the quota with the weakest type. | Smoke: Ascent Global Logistics, "named Gal Dayan as its new Chief Operating Officer", type `ops_hire`; the author's manual read counted it not good (author's log). Deposco: RBW Logistics COO appointment, type `hiring_operations_leadership`, unjudged. | Open (a contract problem the gates cannot see) |
| 5 | **Precision sits on the bar, and the bar is now 98%.** | Pilot: S2 precision 0.80 = 8/10 in all 3 reps (§1); S1 0.88. After the evidence gates (2026-10-14): 12 of 13 accepted leads good = 0.92, n too small to compare with 98% (§1). | Open; 5a and 5b are the code changes aimed at it, 5c is the miss they did not stop |
| 5a | **The gate trusted unquoted fit booleans.** Required company facts such as funding stage or "is a 3PL" came from Exa yes/no summaries with no page quote. | Root cause of Sybill/Miter false positives. Fix in code: required gates and HQ are nullable plus verbatim quotes; a missing quote is a `candidate` (`unquoted_gate`), a quote not on the captured page is `quote_not_in_page`. Live run 2026-10-14 (§1): 13 accepted leads, all 13 passed the judge's Q1 (fit); the matcher bug that rejected 4 genuine quotes in rep 1 was fixed in `5e88d4f`. | Fixed in code, 2026-10-14, measured on 13 leads (#21); precision n too small, recall cost real |
| 5b | **Non-event pages counted as signals.** Job boards, personal profiles and company-profile/newsletter pages could fill a why-now slot. | Pilot bad sources included snagajob, tealhq, ihirelogistics, Ashby jobs, LinkedIn profiles and a Miter profile. Fix in code: built-in job-board domain list (`exclude_domain`), LinkedIn `/in/` profile URLs (`non_event_page`), `weak_hiring_signal`, and the signal-quote rule. Replay of the deterministic rules alone (pilot data): 11 bad lead-reps newly rejected, 0 good lost. Live run 2026-10-14: all 13 accepted leads passed the judge's Q3 (signal real, specific, in window). | Fixed in code, 2026-10-14, measured on 13 leads (#22); re-opened 2026-10-15 by 3 listings in one run (snaprecruit, jobs.capitalfactory.com, jobtarget; memory eval run A, 3 good of 7); URL-shape rule added (#26), replayed on every judged lead (3 bad caught, 1 good lost by design: Jay Group), not yet re-measured live. Other non-event page shapes still open |
| 5c | **Quoted-but-wrong source fact (Verst headcount).** The quote check proves the text is on the page, not that the page is right. | S1 rep 2: Verst Logistics accepted on size quote "Employees: 507" from Exa's company profile (`employee_estimate_source`, `eval/results/live-quotes-2026-10-14/S1/B_agent_opus/2/state.json`); S1 allows 100–1000 staff. The judge's Q2 is "no" (source builtin.com; `eval/truth/S1/verstlogistics__f8f7b70ca5.json`, which stores no reasoning or number). The same Verst URL was accepted in all 3 pilot agent reps. 1 of 13 leads. | OPEN (FAILURES #23). Candidate fixes, none built or tested: (a) a second-source headcount check, where a second independent page must agree within a tolerance or the lead stays a candidate; (b) the online judge with the evidence payload, which would route a disagreement to review |
| 6 | **Lookups matched the wrong company.** The entity check that fixed it is a heuristic. | Smoke: "AUKLogis" (UK) was enriched as Australia's AUK Logistics; the HQ gate rejected it by luck (FAILURES #5). The fix (`companyResultMatches`, `src/agent/tools.ts:269–277`) accepts ≥ 60% name-token overlap, a matching first token, or a name token in the host, and passes any result with no title. "AUK Logis" would pass on first token. Test: `F1.8`. | Fixed (#5); heuristic open |
| 7 | **Handback advice can be wrong for the buyer type.** | A Singapore pet-business run (2026-10-13) got 3 of 10 leads; the blocker was companies with no verifiable public record, and the code-built suggestion was to widen size (server run, not in the repo). Fix: when lookup misses outnumber size rejections, the suggestion is "needs a different evidence source" (1985bdb; test `unverifiable (lookup misses) outnumbering size …`). | Fixed |
| 8 | **Cost and latency structure.** Claude is 39–48% of a run. About half of Claude's cost is cache writes: the history is append-only, so each turn's tool results are written to cache, and the whole prefix is re-read every turn. One model turn per HTTP request. | Claude $0.21–$0.42 of $0.52–$0.87 per run (`state.json` spend). Repriced from `events.jsonl` tokens at `src/agent/config.ts` rates: cache writes 46–54%, output 31–40%, cache reads 10–22%. Shares are over the 8 runs with token logs (the public smoke has none). Pilot runs took 73–153 s; model calls p50 5.2 s, p95 9.3 s, max 19.5 s (100 calls). | By design; open |
| 9 | **The planner was brittle about JSON shape.** | Three `500`s on the first walkthrough (41,137 / 34,221 / 30,573 ms; FAILURES #12–13) and a fourth on Railway at 11:53:28Z (Railway log, not in the repo), before the exact JSON example went into both prompts (7b6d478). #12–13 have no test. | Fixed |
| 10 | **Client/server contract drift passed the mocked suite.** | #15: approval returned `409` on the first walkthrough. #14: the UI never sent the workspace id (found in code; no failing request recorded). #16: every visitor's last permitted run stopped at its first spend; seen once in production (run `10665d83…`, $0.08, turn 2). #17: planner routes refused a visitor with runs used up but $1.63 left (`402`), and the UI showed it as a card problem. All four passed the mocked tests; #16 and #17 have tests now (`eval/allowance.test.ts`, `eval/ui-copy.test.ts`). | Fixed |
| 11 | **The judge had its own failures.** | Search-only v2 under-verified Q3: S1 8 → 14 and S2 10 → 15 good after adding `web_fetch` (FAILURES #10). A key change in name normalisation hid 2 good verdicts per S2 rep (6/6/6 → 8/8/8, pass^3 0 → 1; FAILURES #11). | Fixed |
| 12 | **Not measured.** | Recall: no ground truth for how many qualifying companies exist. n = 3 per cell, 2 scenarios; S3/S4 never evaluated. Opus only: the Sonnet arm never ran. The blind pool mixed arms, but the 10 spot-checks (22%) were done by the author, who knows the project (`eval/truth/SPOT-CHECKS.md`). The public deployment is live for anonymous visitors, though SPEC-agent §14 gates that on pass^3 in 3 of 4 scenarios. | Open |
| 13 | **Scope change is untested live.** | `request_scope_change` was called 0 times in all 9 runs, so the approval card exists only in mocked tests, and demo replay cannot show it (`docs/DEMO.md`). | Open |
| 14 | **Limits by design.** | Memory is per browser (workspace id in `localStorage`, `app/ui/types.ts:53`); state and ledger are JSON files on one Railway volume (`docs/DEPLOY.md`); rate limit is an in-process `Map` (`app/api/_shared.ts:9`); no accounts: the workspace id is a bearer secret, so anyone who learns it can read or clear its memory, and a run is reachable only with its owner's workspace id (flaw 19). | By design |
| 15 | **Langfuse's per-lead `judge_good` disagrees with the scored good-lead count.** `judge_good` is each verdict's own `good`; the scorer also applies RUBRIC §1's one-Q2-`cannot_verify`-per-run tolerance. | Pilot agent leads in Langfuse (environment `eval`): 48 `judge_good` true of 55. `report.json`: 46 good (S1 9 + 7 + 6, S2 8 + 8 + 8). The 2 are SubBase in S2 reps 1 and 3 (`eval/truth/S2/subbase__ec8a88dd4e.json`, `good: true`), scored no as each run's second size `cannot_verify` (`eval/harness/score.ts` `leadGood`). Experiment-level `precision` and `cost_per_good_lead` use the scorer and agree with the report. | Open |
| 16 | **Does memory help? Only the mechanism was shown.** Seen-company skipping and self-notes are in the loop; the question is whether run B beats a fresh run. | Measured 2026-10-15, S1, n = 1 per cell (EVAL-DETAIL, Memory eval): first run FAIL on the old quote gate (B 1/1 good vs control 8/8; the cause was lookup quote rejects and network failures, not memory, #25). Rerun with the gate fixed: B 8 good of 8, all new vs A, 2 lookups skipped; control 6 of 6 with 2 repeats of A; PASS. The difference of 2 is inside the pilot's noise, so this shows the mechanism, not a benefit. Notes recalled was 0 in the PASS run because run A stopped on budget and wrote none: the `remember` offer fires only on `finish` (`src/agent/tools.ts`), never on a limit stop. Since this eval, seen entries are scoped to the search that produced them (commit `7977110`): a company blocks only a run with the same search signature (gate keys + signal types + industry), entries stop applying after 90 days and are evicted at 180, and the panel groups them by search with "Forget this search". The eval ran before that change and used one search, so it does not exercise scoping; scoping has unit tests, no live run. | Measured: B 8/8 new vs control 6/6 with 2 repeats; benefit unproven (n = 1); budget-stop skips the note offer, open. Scoping: fixed in code, tested, not measured live |
| 17 | **Contact gate gaps found by the first live contacts run.** The gate decides each person's tier; its first rules let four wrong things through. | Live run 2026-10-16 (FAILURES #29, #30): a scraped-profile mirror (`muraena.ai/profile/…`) and a 2019 press release each produced a verified contact; a company-directory page (`visualvisitor.com/companies/<id>/…`) verified Donald Finney; "stepping up from his previous role as Chief Operating Officer" verified Paul Taylor as COO; one person appeared twice ("Neil Midgley" verified, "Neil Midgley FCILT" inferred); "kurt cuncannan" was lowercase. Replay of the recording at $0 (`npx tsx eval/replay-contacts.ts`): Finney verified → inferred, Paul Taylor verified → inferred (role changed), the two Neils become one verified record, the name is title-cased; 9 verified / 3 inferred becomes 7 verified / 5 inferred over 12 contacts. | Fixed in code, replayed on one recording (4 leads), not measured on a second run; the phrase and aggregator lists are finite; an undated press page can still verify |
| 18 | **The input resolver misread every non-website input.** A Facebook page URL profiled facebook.com and came back "Tell us in one sentence"; a bare name became the offering; a Linktree, Shopee or Maps link was profiled at its host. | Observed live on a Facebook page URL (FAILURES #27). Fix: one pipeline, `classifyInput` then `resolveToSite`, one Exa search for social, bio-link, maps and bare-name inputs, shown as "Is this your website?", plus a soft browser-locale country hint that only ranks candidates. Test: `eval/planner-resolve.test.ts`. | Fixed in code; not re-measured live; how often the right domain is in the top 5 is unmeasured (one 3/3 Instagram probe) |
| 19 | **Run routes accepted any caller who knew the run id.** Only the events route checked the workspace; GET, step, stop and decision did not, so a leaked run id could read, drive, approve or stop a run and spend the owner's allowance. | Found 2026-10-16 while adding the event stream (FAILURES #28); not exploited, run ids are UUIDv4. Fix: `requireRunOwner` on all five run routes (400 no workspace, 404 unknown, 403 other workspace). Test: `eval/api-controls.test.ts`. | Fixed in code and tested; the workspace id itself is a bearer secret in `localStorage`, not an account |
| 20 | **Contacts are unmeasured.** | One live run (§5): 6 leads, 4 got contacts, 12 contacts. There is no labelled set (`eval/datasets/contact-cases.jsonl` has 0 lines) and the contact judge (`eval/harness/judge-contacts.ts`) has never run, so the rate of verified contacts that are right and the stale-title rate are unknown. | Open |

The quote rule (flaws 5a/5b) has now run on live Exa once: 4 cells, 13 accepted leads, 12 good (§1). That is evidence that fresh summaries supply quotes and that the leads they admit are mostly right, not evidence of 98% precision (n = 13) and not a recall result: recall fell. The pilot replay in `eval/results/gate-replay-2026-10-14.md` predates it.

Code bounded the damage in each case above: across the 9 runs `submit_lead` rejected only 3 submissions (1 `enterprise`, 2 `entity_mismatch`), because lookups had already screened 0–19 candidates per run.

## 3. Where it stops working

Local small businesses (cafés, clinics, pet shops) have no press coverage and thin public records. On 2026-10-13 a user run targeting Singapore pet businesses (size 2–100) returned 3 of 10 leads. The agent's handback said it "couldn't find reliable company details for small local businesses" and that records matched a similarly named company overseas, while the code-built suggestion said to widen size (flaw 7, fixed). That run is on the server, not in the repo (DECISIONS #15). Enterprises are excluded by design (`enterprise` gate and exclusion lists). What would change this: an evidence source such as a local business registry.

## 4. Try it

| What | Cost | Command or URL |
|---|---|---|
| Tests (mocked model and Exa) | $0 | `npm test`: 877 tests, 46 files, about 15 s (run with the API keys unset and `.env` hidden, as CI does: `env -u ANTHROPIC_API_KEY -u EXA_API_KEY DOTENV_CONFIG_PATH=/nonexistent npx vitest run`) |
| Type check | $0 | `npm run typecheck` |
| Demo replay, no keys | $0 | `npm install && DEMO_MODE=1 npm run dev`, open http://localhost:3000 |
| Re-score the pilot from committed verdicts | $0 | `npm run eval:score -- --set pilot-2026-10-12` |
| Tool-schema preflight | $0 (`count_tokens`, needs a key) | `npx tsx eval/check-tool-schemas.ts` |
| Hosted live run | Free to you; ≈ $0.83 to the host | https://web-production-2b8f6.up.railway.app: 2 runs / $2.50 per visitor, $10/day across all visitors |
| One local live run (the Exa account needs credit: a run with none fails mid-way with HTTP 402) | Run $0.52–$0.87 in the 9 recordings, capped at $1.00; planner ≈ $0.05 in the public smoke ($0.88 ledger − $0.83 run) | `.env` with `ANTHROPIC_API_KEY`, `EXA_API_KEY`; `npm run dev`, or `npx tsx eval/run-agent.ts --icp 1 --max-cost 1.00 --approve auto --record <dir>` |
| Pilot matrix (12 cells) | ≈ $9.64 recorded for the pilot ($7.68 Exa + $1.96 Claude) | `npm run eval:cell -- --set <id> --matrix S1,S2 --arms A,B --reps 3 --max-total-dollars 10` |
| Blind judge | ≈ $0.19 per verdict search-only, ≈ $0.34 with fetch | `npm run eval:judge -- --set <id> --scenario S1` |
| Memory eval (does run A's memory change run B?) | Run twice on S1 (2026-10-15): $2.46 and $2.58 for cells, judge $4.11 and ≈$2.72 new. $0 dry run available | `npx tsx eval/memory-eval.ts --set <id> --scenario S1 --dry-run` · design and results: [EVAL-DETAIL](docs/EVAL-DETAIL.md#memory-eval) |

Demo mode turns on with `DEMO_MODE=1` or when either key is missing (`src/demo/mode.ts`). It replays `eval/demo/run/`, a copy of the memory-eval run of 2026-10-15 (`eval/results/memory-eval-2026-10-15b/S1/B_agent_opus/2/`): the second run in its workspace, so it recalls 7 companies and skips 2 lookups, with a lookup retry, a quote behind every lead, 8 leads (all judged good), a budget stop and a structured handback. A new demo workspace is seeded with that run's starting memory (`eval/demo/run/run.json`). Until 2026-10-15 the demo replayed pilot S1 agent rep 2 (2026-10-12), which predates evidence quotes.

![The demo walkthrough: describe, target, approve, the agent's opening-plan approval, the live run, results with the handback, a lead's evidence, and the memory panel](docs/screenshots/walkthrough.gif)

The walkthrough above (41 s, 1280 px, recorded 2026-10-16 from this replay, on the pop.site-based visual system in [DESIGN.md](DESIGN.md)) goes Describe → Target → Approve → the approval → the run → Results → a lead's Evidence → the memory row. One 1280 still per screen: [Describe](docs/screenshots/screen-1-describe.png), [Target](docs/screenshots/screen-2-target.png), [Approve](docs/screenshots/screen-3-approve.png), [the approval](docs/screenshots/screen-4-approval.png), [the live run](docs/screenshots/screen-5-run-live.png), [Results](docs/screenshots/screen-6-results.png), [Evidence](docs/screenshots/screen-7-evidence.png), [Memory](docs/screenshots/screen-8-memory.png); Results in [light](docs/screenshots/demo-light.png) and [dark](docs/screenshots/demo-dark.png). Re-record them all with `npx next build && node scripts/demo-gif.mjs` (needs Playwright's Chromium, ffmpeg, and network access to Fontshare for the Satoshi font; the script starts its own `DEMO_MODE=1` server).

## 5. How it works

| Step | The user | The system |
|---|---|---|
| 1. Input | Pastes a website, a social profile, a link-in-bio page, a marketplace shop, a Maps link, a bare company name, or one sentence | One resolver (`classifyInput` then `resolveToSite`): a website or marketplace storefront is profiled at its own URL; social, link-in-bio, Maps and bare-name inputs are searched once on Exa and shown as "Is this your website?" with up to 3 candidates and their evidence, ranked with a soft hint from the browser's country (TLD, mention). A platform URL is never profiled as its host. Exa then builds a seller profile |
| 2. Cards | Edits who / why now / size / stage / geo / recency / exclusions, and **who to reach** (buyer-role chips, pre-filled from the profile; none means no contact lookups) | Claude suggests each card and marks hard filters vs estimates |
| 3. **Contract** | **Approves** target lead count and max spend | Cards compile to a validated `SearchPlan` |
| 4. **Strategy** | **Approves, edits or declines** angles, first 3 queries, cost estimate | No spend before this approval (enforced in code) |
| 5. Live run | Watches the ledger, the model's sentence as it is written, todo, spend meter; can Stop | One model turn per request. Events are written as each tool starts and settles, each with a `seq`, and streamed over SSE; visible model text streams as ephemeral deltas (thinking is never forwarded). If the stream fails, the ledger fills one step at a time from the step responses; if the model stream fails, the turn is retried once non-streaming and logged as `stream_fallback` |
| 6. **Scope change** | **Approves, edits or declines** relaxing one constraint | The run pauses durably; code, not the model, edits the contract |
| 7. Results | Leads with sources, up to 3 contacts per lead (verified or inferred), "considered but not added" by reason, CSV | If short, a structured handback with ≤ 2 one-click card changes |
| 8. Feedback | Rates leads 👍/👎 with a reason; can view or clear memory | Companies seen in an earlier run of the same search skipped (without paying for the lookup; 90-day expiry); 👎 reasons and the agent's own dated lessons go into the first message; every remembered item is listed with where it came from and can be forgotten one by one |

```
Browser (app/page.tsx)                      Server: one HTTP request = one agent turn
POST /api/runs ──────────────────────────▶ validate plan → runs/<id>/state.json
POST /api/runs/:id/step  (repeat) ───────▶ requireRunOwner, lock run, load state (versioned)
                                           limits? budget / 30 turns / 6 min / 4 no-progress / target
                                           messages.create(cached system + 10 tools, append-only history)
                                           run tool_use blocks in parallel (≤6) ──▶ Exa (one CostGuard)
                                           submit_lead ──▶ checkLead (src/gates.ts)
                                           append tool_results, save state, append events.jsonl
◀──── status, events, spend ──────────────
GET /api/runs/:id/events?after=seq ───────▶ SSE: events by seq, model-text deltas, heartbeat, end frame
status = awaiting_approval → POST /api/runs/:id/decision appends the tool_result → next step
```

| Element | How it is built | Files |
|---|---|---|
| Loop | Hand-written tool-use loop on the stateless Messages API, one turn per `POST /step`; no framework (DECISIONS #1) | `src/agent/loop.ts`, `app/api/runs/[id]/step/route.ts` |
| Orchestration | One agent, 10 narrow tools, up to 6 parallel calls per turn; no subagents (DECISIONS #3, #9) | `src/agent/tools.ts`, `src/agent/config.ts` |
| Context engineering | Stable cached system prompt; contract and memory in the first user message; append-only history; compact tool results | `src/agent/prompts.ts`, `docs/prompts.md`, `src/agent/state.ts` |
| Guardrails | `checkLead` is the only definition of a lead, shared by both arms; combined $ cap via CostGuard; turn, time and no-progress limits; every run route checks that the caller's workspace owns the run (`requireRunOwner`) | `src/gates.ts`, `src/exa.ts`, `src/agent/config.ts` |
| Approval | Strategy and scope change pause the run as an unanswered `tool_use`; the decision is bound to its `toolUseId` | `app/api/runs/[id]/decision/route.ts`, `src/agent/loop.ts` |
| Memory | Four homes by who may act on a fact: seen list enforced in code and scoped to the search that produced it (same gate keys, signal types and industry; 90-day expiry, evicted at 180); 👎 feedback and the agent's own 60-day lessons (`remember`) ranked into the first message by one `recall()` seam, each with provenance, viewable and forgettable in the UI; working state in the run | `src/agent/memory.ts`, `src/agent/recall.ts`, `app/api/workspaces/[id]/`, `app/ui/Memory.tsx` |
| Observability | One event per step with tokens, Claude and Exa cost, latency, prompt version; written as they happen, each with a `seq`, and tailed by the SSE route | `src/agent/events.ts`, `src/agent/live.ts`, `runs/<id>/events.jsonl` |
| Interface | Pop.site-based visual system: white canvas, Satoshi, one signal-blue action per screen, state shown by ink weight, icon and word rather than green/amber/red, hairline cards, no shadows ([DESIGN.md](DESIGN.md)) | `app/globals.css`, `app/ui/` |
| Evals | Cell runner, blind pooling, Opus judge, scorer, simulated user | `eval/harness/`, `eval/RUBRIC.md`, `eval/truth/` |

`checkLead` runs in order: non-company or built-in job-board source · excluded name/domain · personal/non-event pages · seen in an earlier run · duplicate · event date in the window (publish date substituted only for a year-slip) · company named on the signal page · signal quote found on the page · lookup exists · not enterprise · HQ country with quote · size (the estimate must be backed by its quoted source) · required yes/no questions with quotes. Missing required proof is stored as a candidate, not an accepted lead. The results table is built only from accepted `submit_lead` records, never from the model's text.

**Who to reach (built 2026-10-16, one live run).** After a lead is accepted, the agent can call `find_contacts` once for it: up to 3 people in the buyer roles the user approved on the Target step. Code decides each person's tier. **Verified** needs a page that names the person next to a title that fits an approved role, both checked on the captured page text, and the page must be the company's own domain or press: not LinkedIn, not an aggregator or directory (URL shape and a prose rule), and press older than 24 months verifies only if the people index also lists the person in a current role. A title qualified by a former-role phrase ("previous role", "stepping up from") is inferred. **Inferred** is a people-index listing in an approved role, shown as a name and a profile link only: no LinkedIn text is copied or stored (LinkedIn User Agreement §8.2), so LinkedIn-only people can only ever be inferred links. No emails or phones; contacts live and die with the run. Worst case $0.03 of Exa per lead, capped in code.

*What the one live run showed* (2026-10-16, S1, buyer roles; `eval/recordings/contacts-2026-10-16/S1/agent/`): 6 leads accepted, 12 contacts on 4 of them, 9 verified and 3 inferred, $0.019 per lead with contacts ($0.076 in total, of a $0.873 run). The other 2 leads got none: Exa returned HTTP 402 (out of credit) mid-run, and the error is recorded on those leads. Reading the 12 showed the gate was too loose (flaw 17, FAILURES #29, #30). After the fixes, replaying the recording at $0 flips 2 contacts from verified to inferred, merges 1 duplicate, and leaves 7 verified and 5 inferred. Caveats: one run, four leads with contacts, and a replay of the same data the rules were written from, so it shows the rules do what they say, not that they generalise. There is no labelled set and no contact eval yet, so the share of verified contacts that are right, and how often a verified title is stale, are unknown (flaw 20). Design and limits: SPEC-agent §5b; research: `docs/RESEARCH-contacts-and-graph.md`.

**Autonomy** (SPEC-agent §5a), with what the 9 runs actually did:

| Action | Agent alone | Needs user OK | Never | Observed |
|---|---|---|---|---|
| Search, look up, read pages within the contract | ✅ | | | 5–12 searches and 18–30 lookups per run; 1 page read in 9 runs |
| Opening strategy (angles, first queries, cost estimate) | | ✅ before any spend | | Proposed in all 9; auto-approved by the harness in the pilot, approved by a person live |
| Scope change: size, recency, geography, adjacent industry | | ✅ with reason + evidence | | Never requested |
| Budget increase | | ✅ | | Never requested |
| Find named contacts at an accepted lead (`find_contacts`: once per lead, ≤ 3 people, ≤ $0.03) | ✅ only if the plan has approved buyer roles | | | 1 live run: 4 leads, 12 contacts |
| Accepting a lead that fails a check | | | ✅ code refuses | 3 submissions refused |
| Contacting anyone / any external side effect (finding a contact is not contacting one) | | | ✅ no tool exists | n/a |

## 6. Observability and evals in Langfuse

`runs/<id>/events.jsonl` stays the source of truth. Langfuse Cloud (Hobby tier, JS SDK v5) is where runs are viewed, scored and compared: one function, `toObservations(events)`, builds the masked trace both live and in backfill. With the `LANGFUSE_*` keys unset nothing loads. Design and status: [docs/SPEC-observability.md](docs/SPEC-observability.md).

| Piece | What exists | Where |
|---|---|---|
| Traces | Session = run, trace = one turn: the model generation, one span per tool, approvals, policy checks. Exa cost is on each tool observation, and the recall, retry, trim and repair events are exported. Page text, message history and IPs are dropped (except the ≤ 1,500-char signal excerpt in a judged lead's evidence); the workspace id is HMAC'd | `src/agent/trace.ts` |
| Prompts | Agent system prompt and 2 planner prompts under label `production`, pinned per run, repo text as fallback; `diff` exits 1 on drift | `src/agent/prompt-store.ts`, `eval/langfuse-prompts.ts` |
| Datasets, experiments | `prospector-scenarios` (2 items), `prospector-cases` (28 in `eval/datasets/`; synced to Langfuse by `eval/langfuse-sync.ts`); the pilot as 6 runs × 2 items with judge and grader scores | `eval/datasets/`, `eval/langfuse/` |
| Code graders | 10 must-pass graders at every run end, posted as scores; an hourly worker opens one issue per failing run | `eval/graders/`, `src/agent/online-eval.ts`, `eval/online/worker.ts` |
| Online judge | Managed `judge_q1..q3` evaluators on a capped lead sample. Each lead carries the evidence the gate accepted it on (page excerpt, company lookup, gate result) and the judge answers from that evidence only; the offline judge also checks the web. **Not calibrated**: round 1 scored 4/10 (Q1) and 2/10 (Q2) when the payload had no evidence (FAILURES #19); the evidence-backed round is not run yet. Rule **disabled**, so no evaluator runs on production (2026-10-14 status: judge_q2/q3 active, judge_q1 paused with `EVAL_MODEL_CONFIG_INVALID`) | `eval/online/` |
| Review queue | `review-queue`: 👎 leads, handbacks, errors, must-pass failures, judge "no" | `eval/online/setup-langfuse.ts` |
| Dashboard | "Prospector — weekly", 12 widgets, created by API | `eval/online/dashboard.ts` |
| CI gate | Prompt diff, then the workflow arm replayed on the scenarios dataset as experiment `ci-<sha>` | `.github/workflows/experiment-gate.yml`, `eval/ci/` |

Not live yet: the app does not run with `LANGFUSE_TRACING_ENVIRONMENT=production`, so the production widgets are empty. The gate fails until the two Exa fixtures it replays are recorded (≈ $0.75–0.90 each) and their leads judged, and it cannot run the agent arm at $0 because no model responses are recorded.

## 7. Failures found and fixed

30 entries in [docs/FAILURES.md](docs/FAILURES.md); the ones that changed measured numbers:

| Symptom | Root cause | Fix | Before → after |
|---|---|---|---|
| Fresh articles dropped as stale | Exa extraction slips the event year | Publish date only for a year-slip (±90 days) | 14 → 1 drops on the same recording (#1) |
| 50-result searches cost $0.094, not $0.007 | One assumed Exa price tier | Observed tiers + 25%, reserve/settle CostGuard | 1 row ($0.887 spent) → 6 rows under a $0.60 cap (#2) |
| Event log summed to 2.8× the real Exa spend | Parallel tools logged the shared running total | Per-call cost per event | $1.292 vs $0.455 → equal (#4) |
| S2 workflow crashed 3/3 on the cap | Guard refusal escaped the pipeline | Skip remaining lookups, score, record spend | 3 crashes → 3 budget stops (#7) |
| Judge parsed 0 of 22 verdicts | Parser read the first text block, not the last | Last valid JSON across blocks | 0/22 → 22/22 and 23/23 (#8) |
| S2 agent scored 6/6/6 | Verdict keys broke on a normalisation change | URL-hash fallback, key migration | 6/6/6 → 8/8/8 (#11) |
| 2 of 12 contacts verified on a directory page or a former role; 1 person listed twice | The contact gate checked that a fitting title was on the page, not what kind of page or whether the role was over | Directory/aggregator shapes, former-role phrases, post-nominal dedupe (#29, #30) | 9 verified / 3 inferred → 7 verified / 5 inferred over 12 contacts, replayed at $0 on one recording |
| A stranger holding a run id could read, drive, approve or stop the run | Ownership was checked in one route of five | `requireRunOwner` on all five | 200 and acted → 403, state and spend unchanged (#28) |

## 8. Other limits

- **Exa extraction noise** (wrong-year dates; 356 vs 3,560 staff for one company) is bounded by gates, not eliminated (SPEC-agent §13).
- **Route timeout:** each route has `maxDuration = 60`; model calls max out at 19.5 s in the recordings, but per-turn tool time is not logged, so p95 turn time is unknown.
- The `eval/recordings/icp1-2026-10-11b` replay no longer matches current request hashes ("replay miss").

## 9. What is not built

- **Warm paths from a connections export.** Upload a LinkedIn Connections CSV and join it to leads (build step 3 in the research doc). Not started.
- **Email reveal through the user's own provider key** (Apollo or Lusha; step 4). No email or phone is fetched, stored or shown today.
- **The contact eval.** A frozen labelled set (`eval/datasets/contact-cases.jsonl` is empty) and a run of the contact judge (`eval/harness/judge-contacts.ts`, code only, never run). Until then the contact numbers in §5 are one run.
- **The 150-lead measurement.** Showing 98% precision takes on the order of 150 leads with no miss (§1); the largest judged set is 13.
- **The online judge, enabled.** The rule is disabled and the evidence-backed calibration round has not run (§6).
- **Live re-measurement of the gate fixes** for job listings (FAILURES #26), the input resolver (#27) and the contact rules (#29, #30), and a judged run of the post-pilot agent as a whole.
- **Exa credit.** Live runs need an Exa account with credit; without it a run stops on HTTP 402 and the contacts recording shows two leads with no contact lookup for that reason.

## 10. Repo map

| Path | What |
|---|---|
| `app/page.tsx`, `app/ui/` | Product UI: cards → contract → live run → approvals → results → memory |
| `app/api/planner/*` | Input → seller profile → cards → compiled plan |
| `app/api/runs/*`, `app/api/workspaces/*` | Create / step / decision / stop / state / events (SSE), all behind `requireRunOwner`; grouped memory and feedback |
| `src/agent/` | Loop, tools, prompts, state, memory, events, costs, quota |
| `src/gates.ts` | `checkLead`, the lead definition; `checkContact`, the contact tiers |
| `src/contacts.ts` | `findContacts`: the two Exa calls (people index, public pages) and the contact data model |
| `src/planner/` | Input classification and resolution (`resolve.ts`), seller profile, cards, plan compile |
| `src/agent/live.ts`, `src/agent/live-bus.ts` | SSE tail of `events.jsonl` and the ephemeral model-text bus |
| `DESIGN.md`, `docs/design-reference/` | Visual system and the pop.site reference tokens |
| `src/exa.ts` | Exa client: CostGuard, record/replay, ≤ 4 in flight, 429 retry |
| `src/pipeline.ts`, `src/plan.ts` | Workflow arm and `SearchPlan` validation |
| `eval/*.test.ts`, `eval/harness/` | Mocked unit tests; eval runner, judge, scorer |
| `src/agent/trace.ts`, `src/agent/prompt-store.ts`, `src/agent/online-eval.ts` | Langfuse trace mapping and masking; prompt fetch with pin and fallback; run-end grader scores and capped judge selection |
| `eval/graders/` | Code graders over `state.json` + `events.jsonl` (`gradeRun`) |
| `eval/datasets/` | Dataset items (jsonl, source of truth) mirrored by `eval/langfuse-sync.ts` |
| `eval/langfuse/` | Experiment writer: eval cells as Langfuse experiment items with scores |
| `eval/online/` | Langfuse setup (evaluators, score configs, queue), judge calibration, hourly worker, dashboard |
| `eval/ci/` | CI experiment gate: replay runner, threshold logic, approved baseline |
| `eval/recordings/`, `eval/results/`, `eval/truth/` | Real traces, pilot results, judge verdicts |

## 11. Build notes

This build was AI-assisted: I orchestrated coding agents (Claude models and Codex), and commit trailers say so. The product decisions are mine: architecture, autonomy boundaries, rubric and eval design, which failures to chase, what to claim, and the live-API probes behind them. Every number above comes from a file in this repo or is marked "author's log", "Railway log" or "server run"; anything unmeasured is marked. Stack: Next.js 14 · React 18 · TypeScript · `@anthropic-ai/sdk` (Messages API) · Exa · Vitest.
