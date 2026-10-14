# Prospector

Prospector finds B2B sales leads. A seller pastes their website and approves a short plan; an agent (Claude Opus 5.5 over the Exa search API) looks for companies with a recent, cited "why now" event such as a new warehouse, a funding round or an operations hire. Code, not the model, checks each company against the plan. The output is leads with source links, the companies turned down and why, and a CSV. It is aimed at sellers whose buyers are mid-market companies with a public footprint (press, trade news, LinkedIn headcounts): logistics, SaaS, funded startups, manufacturers. The repo also holds a fixed-query workflow as a control arm.

**Result.** On 2 scenarios × 3 reps, judged blind, the agent passed every rep (pass^3 = 1) at $0.07–$0.14 per good lead. The workflow, with the same contract and the same $1.00 cap, passed none. The agent's S2 precision sits exactly on the 0.80 bar, and the agent has flaws the pass rate hides: it almost never checks pages (1 read in 9 runs), rarely changes tactics, and lets its checklist go stale. [§2](#2-whats-wrong-with-the-agent-observed) lists them with evidence.

| Document | What it is |
|---|---|
| [docs/FAILURES.md](docs/FAILURES.md) | 17 failures found in this build: symptom, layer, cause, fix, before → after |
| [docs/EVAL-DETAIL.md](docs/EVAL-DETAIL.md) | Pre-pilot smoke run, S2 miss breakdown, judge history, build cost |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 15 decisions with alternatives, evidence and what would change them |
| [docs/SPEC-agent.md](docs/SPEC-agent.md) | Agent spec: loop, tools, autonomy (§5a), guardrails, evals, rollout (§14) |
| [docs/prompts.md](docs/prompts.md) | System prompt and tool descriptions, verbatim, with the reason for each section |
| [eval/RUBRIC.md](eval/RUBRIC.md) | Scoring rubric, frozen before the first scored run |
| [docs/DEMO.md](docs/DEMO.md) · [docs/DEPLOY.md](docs/DEPLOY.md) | 3-minute demo script · Railway deployment |
| [docs/SPEC-v2.md](docs/SPEC-v2.md) · [docs/SPEC-givingsg-variant.md](docs/SPEC-givingsg-variant.md) | Planner and workflow engine · a design exercise, **not built** |

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

## 2. What's wrong with the agent (observed)

"Runs" below means the 9 recorded agent runs: the pre-pilot smoke run (`eval/recordings/agent-icp1-2026-10-12/agent/`), the 6 pilot runs (`eval/results/pilot-2026-10-12/S*/B_agent_opus/*/`), the deposco walkthrough and the public smoke. Counters come from each `state.json` `adaptive` field; tool counts from each `events.jsonl`.

| # | Flaw | Evidence | Status |
|---|---|---|---|
| 1 | **It almost never verifies.** The prompt says "Verify when in doubt … `read_page` the signal URL first" (`docs/prompts.md`, Working). It trusts lookup summaries it could have checked. | `verificationReads` = 0 in 8 of 9 runs (smoke, 6 pilot, deposco). The public smoke made 1 `read_page` call (turn 11) and submitted nothing from it. | Open |
| 2 | **It rarely changes tactics.** "Adaptive" behaviour is mostly skipping lookups. The rubric's "workflow-shaped" flag (`adaptive = 0`, `eval/harness/score.ts:147`) is weak because skips alone clear it. | Pilot query rewrites: S1 0 / 0 / 0, S2 1 / 0 / 1. Skips: S1 39 / 49 / 53, S2 11 / 17 / 22. These used the original counter (a new query after a submit rejection): the pilot ran 14:44–14:59Z and `f2bd783`, which also counts lookup-stage trouble, was committed at 15:03Z (inferred from timestamps). Under the wider counter deposco counted 6. | Open (flag); counter fixed |
| 3 | **It doesn't keep its checklist.** The prompt asks for `update_todo` "whenever the picture changes"; the user watches that list. | `update_todo` called 0 times in deposco and the public smoke, 1–2 times in the other 7. In all 7 the final todo understates accepted leads: smoke "4 of 10" (written turn 6) vs 6 accepted; S1 rep 3 "2 of 10" vs 7; S2 rep 2 "3 of 10" vs 10. | Open |
| 4 | **Signal-type drift.** A COO appointment passes as a why-now because the contract lists an ops-hire type. In both cases it was the run's last accepted lead, filling the quota with the weakest type. | Smoke: Ascent Global Logistics, "named Gal Dayan as its new Chief Operating Officer", type `ops_hire`; the author's manual read counted it not good (author's log). Deposco: RBW Logistics COO appointment, type `hiring_operations_leadership`, unjudged. | Open (a contract problem the gates cannot see) |
| 5 | **Precision sits on the bar.** | S2 precision 0.80 = 8/10 in all 3 reps (§1). | Open |
| 6 | **Lookups matched the wrong company.** The entity check that fixed it is a heuristic. | Smoke: "AUKLogis" (UK) was enriched as Australia's AUK Logistics; the HQ gate rejected it by luck (FAILURES #5). The fix (`companyResultMatches`, `src/agent/tools.ts:269–277`) accepts ≥ 60% name-token overlap, a matching first token, or a name token in the host, and passes any result with no title. "AUK Logis" would pass on first token. Test: `F1.8`. | Fixed (#5); heuristic open |
| 7 | **Handback advice can be wrong for the buyer type.** | A Singapore pet-business run (2026-10-13) got 3 of 10 leads; the blocker was companies with no verifiable public record, and the code-built suggestion was to widen size (server run, not in the repo). Fix: when lookup misses outnumber size rejections, the suggestion is "needs a different evidence source" (1985bdb; test `unverifiable (lookup misses) outnumbering size …`). | Fixed |
| 8 | **Cost and latency structure.** Claude is 39–48% of a run. About half of Claude's cost is cache writes: the history is append-only, so each turn's tool results are written to cache, and the whole prefix is re-read every turn. One model turn per HTTP request. | Claude $0.21–$0.42 of $0.52–$0.87 per run (`state.json` spend). Repriced from `events.jsonl` tokens at `src/agent/config.ts` rates: cache writes 46–54%, output 31–40%, cache reads 10–22%. Shares are over the 8 runs with token logs (the public smoke has none). Pilot runs took 73–153 s; model calls p50 5.2 s, p95 9.3 s, max 19.5 s (100 calls). | By design; open |
| 9 | **The planner was brittle about JSON shape.** | Three `500`s on the first walkthrough (41,137 / 34,221 / 30,573 ms; FAILURES #12–13) and a fourth on Railway at 11:53:28Z (Railway log, not in the repo), before the exact JSON example went into both prompts (7b6d478). #12–13 have no test. | Fixed |
| 10 | **Client/server contract drift passed the mocked suite.** | #15: approval returned `409` on the first walkthrough. #14: the UI never sent the workspace id (found in code; no failing request recorded). #16: every visitor's last permitted run stopped at its first spend; seen once in production (run `10665d83…`, $0.08, turn 2). #17: planner routes refused a visitor with runs used up but $1.63 left (`402`), and the UI showed it as a card problem. All four passed the mocked tests; #16 and #17 have tests now (`eval/allowance.test.ts`, `eval/ui-copy.test.ts`). | Fixed |
| 11 | **The judge had its own failures.** | Search-only v2 under-verified Q3: S1 8 → 14 and S2 10 → 15 good after adding `web_fetch` (FAILURES #10). A key change in name normalisation hid 2 good verdicts per S2 rep (6/6/6 → 8/8/8, pass^3 0 → 1; FAILURES #11). | Fixed |
| 12 | **Not measured.** | Recall: no ground truth for how many qualifying companies exist. n = 3 per cell, 2 scenarios; S3/S4 never evaluated. Opus only: the Sonnet arm never ran. The blind pool mixed arms, but the 10 spot-checks (22%) were done by the author, who knows the project (`eval/truth/SPOT-CHECKS.md`). The public deployment is live for anonymous visitors, though SPEC-agent §14 gates that on pass^3 in 3 of 4 scenarios. | Open |
| 13 | **Scope change is untested live.** | `request_scope_change` was called 0 times in all 9 runs, so the approval card exists only in mocked tests, and demo replay cannot show it (`docs/DEMO.md`). | Open |
| 14 | **Limits by design.** | Memory is per browser (workspace id in `localStorage`, `app/ui/types.ts:53`); state and ledger are JSON files on one Railway volume (`docs/DEPLOY.md`); rate limit is an in-process `Map` (`app/api/_shared.ts:9`); no auth: anyone with a workspace id can read or clear its memory. | By design |
| 15 | **Langfuse's per-lead `judge_good` disagrees with the scored good-lead count.** `judge_good` is each verdict's own `good`; the scorer also applies RUBRIC §1's one-Q2-`cannot_verify`-per-run tolerance. | Pilot agent leads in Langfuse (environment `eval`): 48 `judge_good` true of 55. `report.json`: 46 good (S1 9 + 7 + 6, S2 8 + 8 + 8). The 2 are SubBase in S2 reps 1 and 3 (`eval/truth/S2/subbase__ec8a88dd4e.json`, `good: true`), scored no as each run's second size `cannot_verify` (`eval/harness/score.ts` `leadGood`). Experiment-level `precision` and `cost_per_good_lead` use the scorer and agree with the report. | Open |

Code bounded the damage in each case above: across the 9 runs `submit_lead` rejected only 3 submissions (1 `enterprise`, 2 `entity_mismatch`), because lookups had already screened 0–19 candidates per run.

## 3. Where it stops working

Local small businesses (cafés, clinics, pet shops) have no press coverage and thin public records. On 2026-10-13 a user run targeting Singapore pet businesses (size 2–100) returned 3 of 10 leads. The agent's handback said it "couldn't find reliable company details for small local businesses" and that records matched a similarly named company overseas, while the code-built suggestion said to widen size (flaw 7, fixed). That run is on the server, not in the repo (DECISIONS #15). Enterprises are excluded by design (`enterprise` gate and exclusion lists). What would change this: an evidence source such as a local business registry.

## 4. Try it

| What | Cost | Command or URL |
|---|---|---|
| Tests (mocked model and Exa) | $0 | `npm test`: 422 tests, 26 files, about 3 s |
| Type check | $0 | `npm run typecheck` |
| Demo replay, no keys | $0 | `npm install && DEMO_MODE=1 npm run dev`, open http://localhost:3000 |
| Re-score the pilot from committed verdicts | $0 | `npm run eval:score -- --set pilot-2026-10-12` |
| Tool-schema preflight | $0 (`count_tokens`, needs a key) | `npx tsx eval/check-tool-schemas.ts` |
| Hosted live run | Free to you; ≈ $0.83 to the host | https://web-production-2b8f6.up.railway.app: 2 runs / $2.50 per visitor, $10/day across all visitors |
| One local live run | Run $0.52–$0.87 in the 9 recordings, capped at $1.00; planner ≈ $0.05 in the public smoke ($0.88 ledger − $0.83 run) | `.env` with `ANTHROPIC_API_KEY`, `EXA_API_KEY`; `npm run dev`, or `npx tsx eval/run-agent.ts --icp 1 --max-cost 1.00 --approve auto --record <dir>` |
| Pilot matrix (12 cells) | ≈ $9.64 recorded for the pilot ($7.68 Exa + $1.96 Claude) | `npm run eval:cell -- --set <id> --matrix S1,S2 --arms A,B --reps 3 --max-total-dollars 10` |
| Blind judge | ≈ $0.19 per verdict search-only, ≈ $0.34 with fetch | `npm run eval:judge -- --set <id> --scenario S1` |

Demo mode turns on with `DEMO_MODE=1` or when either key is missing (`src/demo/mode.ts`). It replays `eval/demo/run/`, whose `events.jsonl` is byte-identical to pilot S1 agent rep 2 (8 leads, budget stop, structured handback).

## 5. How it works

| Step | The user | The system |
|---|---|---|
| 1. Input | Pastes a website, @instagram handle or one sentence | Exa builds a seller profile |
| 2. Cards | Edits who / why now / size / stage / geo / recency / exclusions | Claude suggests each card and marks hard filters vs estimates |
| 3. **Contract** | **Approves** target lead count and max spend | Cards compile to a validated `SearchPlan` |
| 4. **Strategy** | **Approves, edits or declines** angles, first 3 queries, cost estimate | No spend before this approval (enforced in code) |
| 5. Live run | Watches todo, spend meter, activity feed; can Stop | One model turn per request; leads appear as code accepts them |
| 6. **Scope change** | **Approves, edits or declines** relaxing one constraint | The run pauses durably; code, not the model, edits the contract |
| 7. Results | Leads with sources, "considered but not added" by reason, CSV | If short, a structured handback with ≤ 2 one-click card changes |
| 8. Feedback | Rates leads 👍/👎 with a reason; can view or clear memory | Seen companies excluded next run; 👎 reasons go into the first message |

```
Browser (app/page.tsx)                      Server: one HTTP request = one agent turn
POST /api/runs ──────────────────────────▶ validate plan → runs/<id>/state.json
POST /api/runs/:id/step  (repeat) ───────▶ lock run, load state (versioned)
                                           limits? budget / 30 turns / 6 min / 4 no-progress / target
                                           messages.create(cached system + 8 tools, append-only history)
                                           run tool_use blocks in parallel (≤6) ──▶ Exa (one CostGuard)
                                           submit_lead ──▶ checkLead (src/gates.ts)
                                           append tool_results, save state, append events.jsonl
◀──── status, events, spend ──────────────
status = awaiting_approval → POST /api/runs/:id/decision appends the tool_result → next step
```

| Element | How it is built | Files |
|---|---|---|
| Loop | Hand-written tool-use loop on the stateless Messages API, one turn per `POST /step`; no framework (DECISIONS #1) | `src/agent/loop.ts`, `app/api/runs/[id]/step/route.ts` |
| Orchestration | One agent, 8 narrow tools, up to 6 parallel calls per turn; no subagents (DECISIONS #3, #9) | `src/agent/tools.ts`, `src/agent/config.ts` |
| Context engineering | Stable cached system prompt; contract and memory in the first user message; append-only history; compact tool results | `src/agent/prompts.ts`, `docs/prompts.md`, `src/agent/state.ts` |
| Guardrails | `checkLead` is the only definition of a lead, shared by both arms; combined $ cap via CostGuard; turn, time and no-progress limits | `src/gates.ts`, `src/exa.ts`, `src/agent/config.ts` |
| Approval | Strategy and scope change pause the run as an unanswered `tool_use`; the decision is bound to its `toolUseId` | `app/api/runs/[id]/decision/route.ts`, `src/agent/loop.ts` |
| Memory | Seen-company list enforced in code; 👎 reasons injected into the next run | `src/agent/memory.ts`, `app/api/workspaces/[id]/` |
| Observability | One event per step with tokens, Claude and Exa cost, latency, prompt version | `src/agent/events.ts`, `runs/<id>/events.jsonl` |
| Evals | Cell runner, blind pooling, Opus judge, scorer, simulated user | `eval/harness/`, `eval/RUBRIC.md`, `eval/truth/` |

`checkLead` runs in order: non-company or job board · excluded name · excluded domain · seen in an earlier run · duplicate · event date in the window (publish date substituted only for a year-slip) · company named on the signal page · lookup exists · not enterprise · HQ country · size (the estimate must be backed by its quoted source) · required yes/no questions. The results table is built only from accepted `submit_lead` records, never from the model's text.

**Autonomy** (SPEC-agent §5a), with what the 9 runs actually did:

| Action | Agent alone | Needs user OK | Never | Observed |
|---|---|---|---|---|
| Search, look up, read pages within the contract | ✅ | | | 5–12 searches and 18–30 lookups per run; 1 page read in 9 runs |
| Opening strategy (angles, first queries, cost estimate) | | ✅ before any spend | | Proposed in all 9; auto-approved by the harness in the pilot, approved by a person live |
| Scope change: size, recency, geography, adjacent industry | | ✅ with reason + evidence | | Never requested |
| Budget increase | | ✅ | | Never requested |
| Accepting a lead that fails a check | | | ✅ code refuses | 3 submissions refused |
| Contacting anyone / any external side effect | | | ✅ no tool exists | n/a |

## 6. Observability and evals in Langfuse

`runs/<id>/events.jsonl` stays the source of truth. Langfuse Cloud (Hobby tier, JS SDK v5) is where runs are viewed, scored and compared: one function, `toObservations(events)`, builds the masked trace both live and in backfill. With the `LANGFUSE_*` keys unset nothing loads. Design and status: [docs/SPEC-observability.md](docs/SPEC-observability.md).

| Piece | What exists | Where |
|---|---|---|
| Traces | Session = run, trace = one turn: the model generation, one span per tool, approvals, policy checks. Page text, message history and IPs are dropped; the workspace id is HMAC'd | `src/agent/trace.ts` |
| Prompts | Agent system prompt and 2 planner prompts under label `production`, pinned per run, repo text as fallback; `diff` exits 1 on drift | `src/agent/prompt-store.ts`, `eval/langfuse-prompts.ts` |
| Datasets, experiments | `prospector-scenarios` (2 items), `prospector-cases` (24); the pilot as 6 runs × 2 items with judge and grader scores | `eval/datasets/`, `eval/langfuse/` |
| Code graders | 10 must-pass graders at every run end, posted as scores; an hourly worker opens one issue per failing run | `eval/graders/`, `src/agent/online-eval.ts`, `eval/online/worker.ts` |
| Online judge | Managed `judge_q1..q3` evaluators on a capped lead sample: **paused** (the project has no LLM connection), rule disabled until a calibration round (≤ $0.62, not run) is reviewed | `eval/online/` |
| Review queue | `review-queue`: 👎 leads, handbacks, errors, must-pass failures, judge "no" | `eval/online/setup-langfuse.ts` |
| Dashboard | "Prospector — weekly", 12 widgets, created by API | `eval/online/dashboard.ts` |
| CI gate | Prompt diff, then the workflow arm replayed on the scenarios dataset as experiment `ci-<sha>` | `.github/workflows/experiment-gate.yml`, `eval/ci/` |

Not live yet: the app does not run with `LANGFUSE_TRACING_ENVIRONMENT=production`, so the production widgets are empty. The gate fails until the two Exa fixtures it replays are recorded (≈ $0.75–0.90 each) and their leads judged, and it cannot run the agent arm at $0 because no model responses are recorded.

## 7. Failures found and fixed

17 entries in [docs/FAILURES.md](docs/FAILURES.md); the ones that changed measured numbers:

| Symptom | Root cause | Fix | Before → after |
|---|---|---|---|
| Fresh articles dropped as stale | Exa extraction slips the event year | Publish date only for a year-slip (±90 days) | 14 → 1 drops on the same recording (#1) |
| 50-result searches cost $0.094, not $0.007 | One assumed Exa price tier | Observed tiers + 25%, reserve/settle CostGuard | 1 row ($0.887 spent) → 6 rows under a $0.60 cap (#2) |
| Event log summed to 2.8× the real Exa spend | Parallel tools logged the shared running total | Per-call cost per event | $1.292 vs $0.455 → equal (#4) |
| S2 workflow crashed 3/3 on the cap | Guard refusal escaped the pipeline | Skip remaining lookups, score, record spend | 3 crashes → 3 budget stops (#7) |
| Judge parsed 0 of 22 verdicts | Parser read the first text block, not the last | Last valid JSON across blocks | 0/22 → 22/22 and 23/23 (#8) |
| S2 agent scored 6/6/6 | Verdict keys broke on a normalisation change | URL-hash fallback, key migration | 6/6/6 → 8/8/8 (#11) |

## 8. Other limits

- **Exa extraction noise** (wrong-year dates; 356 vs 3,560 staff for one company) is bounded by gates, not eliminated (SPEC-agent §13).
- **Route timeout:** each route has `maxDuration = 60`; model calls max out at 19.5 s in the recordings, but per-turn tool time is not logged, so p95 turn time is unknown.
- The `eval/recordings/icp1-2026-10-11b` replay no longer matches current request hashes ("replay miss").

## 9. Repo map

| Path | What |
|---|---|
| `app/page.tsx`, `app/ui/` | Product UI: cards → contract → live run → approvals → results → memory |
| `app/api/planner/*` | Input → seller profile → cards → compiled plan |
| `app/api/runs/*`, `app/api/workspaces/*` | Create / step / decision / stop / state; memory and feedback |
| `src/agent/` | Loop, tools, prompts, state, memory, events, costs, quota |
| `src/gates.ts` | `checkLead`, the lead definition |
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

## 10. Build notes

This build was AI-assisted: I orchestrated coding agents (Claude models and Codex), and commit trailers say so. The product decisions are mine: architecture, autonomy boundaries, rubric and eval design, which failures to chase, what to claim, and the live-API probes behind them. Every number above comes from a file in this repo or is marked "author's log", "Railway log" or "server run"; anything unmeasured is marked. Stack: Next.js 14 · React 18 · TypeScript · `@anthropic-ai/sdk` (Messages API) · Exa · Vitest.
