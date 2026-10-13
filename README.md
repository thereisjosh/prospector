# Prospector

Prospector finds B2B sales leads for a seller who doesn't know where to start. You paste your website, approve a short plan, and an agent searches the web for companies with a recent, cited "why now" event (a new warehouse, a funding round, a hiring wave). It checks each one against your plan in code and returns leads with evidence, the companies it turned down and why, and a CSV. It is built for small sales teams that can't afford a data vendor. The same repo contains a fixed-pipeline workflow, which serves as the control arm.

**I built the workflow and the agent, and measured when the agent earns its cost.** On the logistics scenario the agent passed all 3 judged reps at $0.12 per good lead, and the workflow passed none. On the funded-B2B scenario the agent is limited by precision (see [Evals](#6-evals)).

## Documents

| Document | What it is |
|---|---|
| [docs/SPEC-agent.md](docs/SPEC-agent.md) | Agent spec: goal, flow, tools, autonomy, guardrails, evals, [§14 rollout](docs/SPEC-agent.md#14-rollout-plan) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 14 decisions with alternatives, evidence and what would change them |
| [docs/FAILURES.md](docs/FAILURES.md) | Failures found in this build: symptom, layer, root cause, fix, before → after |
| [docs/DEMO.md](docs/DEMO.md) | 3-minute demo script |
| [docs/prompts.md](docs/prompts.md) | The system prompt and tool descriptions, and why each section exists |
| [eval/RUBRIC.md](eval/RUBRIC.md) | Scoring rubric, frozen before the first scored run |
| [docs/SPEC-v2.md](docs/SPEC-v2.md) | The "paste your website" planner and the generic workflow engine |
| [docs/SPEC-givingsg-variant.md](docs/SPEC-givingsg-variant.md) | Design exercise (**not built**): the same framework applied to donor support on giving.sg |

## 1. Try it

**Hosted:** `<DEPLOY_URL>`. The public URL runs in demo mode: a replay of a real recorded agent run (below), with no spend. You'll see the full flow, and the agent pauses for your approval of its opening strategy.

**Local, no keys, about 5 minutes:**

```bash
npm install && DEMO_MODE=1 npm run dev     # open http://localhost:3000
```

Demo mode turns on when `DEMO_MODE=1` is set, or when either API key is missing (`src/demo/mode.ts`). The planner returns fixtures from `eval/demo/planner/`, and runs replay `eval/demo/run/`, whose `events.jsonl` is byte-identical to pilot S1 agent rep 2 (`eval/results/pilot-2026-10-12/S1/B_agent_opus/2/`: 8 leads, budget stop, structured handback). A badge marks the replay.

**Live, with keys:** copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` and `EXA_API_KEY`. Then run `npm run dev`.

| Control | Default | Where |
|---|---|---|
| Per-run cap (Exa + Claude combined) | $1.00, editable in the UI, clamped to $5 | `app/api/runs/route.ts`, `src/agent/config.ts` |
| Daily cap across all runs | `DAILY_SPEND_CAP_DOLLARS`, default $25; when reached, `POST /api/runs` returns 503 | `app/api/_shared.ts` |
| Rate limit | 30 requests/min per IP | `app/api/_shared.ts` |

## 2. The product flow

| Step | The user | The system |
|---|---|---|
| 1. Input | Pastes a website, an @instagram handle, or one sentence | Exa builds a seller profile. For Instagram it asks "Is this you?" |
| 2. Cards | Edits who / why now / size / stage / geo / recency / exclusions | Claude suggests each card with a "why this?" and marks hard filters vs estimates |
| 3. **Contract** | **Approves** the target lead count and max spend, then presses Run | Cards compile to a validated `SearchPlan`, the contract |
| 4. **Strategy** | **Approves, edits or declines** the agent's angles, first 3 queries and cost estimate | Nothing is spent before this approval. Code enforces that |
| 5. Live run | Watches the todo list, spend meter and activity feed. Can Stop | One model turn per request. Leads appear as code accepts them |
| 6. **Scope change** | **Approves, edits or declines** a request to relax one constraint, shown with its evidence | The run pauses durably. On approval, code (not the model) edits the contract |
| 7. Results and handback | Gets leads with source links, "considered but not added" grouped by reason, and CSV | If the run ends short, a structured handback offers ≤2 one-click card changes and a re-run |
| 8. Feedback and memory | Rates a lead 👍/👎 with a reason. Can view or clear memory | Seen companies are excluded on the next run. 👎 reasons go into the next run's first message |

## 3. Architecture

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

The Messages API is stateless, so a run is a file: the message history exactly as received (thinking blocks included), the contract, spend and counters. A paused run costs nothing and resumes hours later or after a restart. The UI drives the loop by calling `step`, and there is no server-sent stream. Code: `src/agent/loop.ts`, `src/agent/state.ts`.

| Tool | Does |
|---|---|
| `propose_strategy` | Opening angles, 3 first queries, cost estimate. Pauses for approval. Required before any spend |
| `search_signals` | Exa search for why-now events, with the plan's schema and excluded domains applied in code |
| `lookup_company` | Exa company lookup: size with its source quote, HQ, the plan's yes/no questions. Screens known signals through the gates |
| `read_page` | Page text (3,000 chars) to settle a decisive question |
| `submit_lead` | The only way a lead enters the results. Code accepts or rejects it with a reason code |
| `update_todo` | The live checklist the user sees |
| `request_scope_change` | Ask to relax one field, with reason and evidence. Pauses for approval |
| `finish` | End with a summary, plus a structured handback if short |

**The model proposes, code decides.** `checkLead` in `src/gates.ts` is the single definition of a lead, shared by the workflow and the agent. It runs these checks in order: non-company / job board · excluded name · excluded domain · already seen in an earlier run · duplicate in this run · event date inside the window (publish date substituted only for a year-slip) · company named on the signal page · lookup exists · not enterprise · HQ country · size (the estimate must be backed by its quoted source, and unverified estimates are rejected only when far outside the band) · required yes/no questions. The results table is built only from accepted `submit_lead` records, never from the model's text.

**Not used, on purpose:**
- **No agent framework.** The durable pause is a persisted append-only history (about 30 lines), and every step stays visible (DECISIONS #1).
- **No subagents.** One loop and a 30-turn cap keep the context bounded: the smoke run's last turn read 42,498 cached tokens (DECISIONS #9).
- **No agent-to-agent handoff.** Handing off to, say, an outreach agent would add external side effects and does nothing for lead quality (SPEC-agent §5).

## 4. Autonomy

| Action | Agent alone | Needs user OK | Never |
|---|---|---|---|
| Search, look up, read pages within the contract | ✅ | | |
| Opening strategy (angles, first queries, cost estimate) | | ✅ before any spend | |
| Scope change: wider size, longer recency, new geography, adjacent industry | | ✅ with reason + evidence | |
| Budget increase | | ✅ | |
| Accepting a lead that fails a check | | | ✅ (code refuses) |
| Contacting anyone / any external side effect | | | ✅ (no tool exists) |

## 5. Why signal-first (kept from v1)

Before building, I probed Exa's live API and found that `category: "company"` search uses a semantic index that rejects `startPublishedDate`, so you cannot date-filter a company search. The buyer's need is freshness, so the pipeline filters freshness on the **trigger** instead. It searches dated news and job pages for the event, then looks up the named company for size, HQ and type. Both arms still work this way. The v2 change: "Claude plans, Exa retrieves." Every fact in the output comes from Exa, and Claude only decides what to ask (SPEC-v2 §1).

## 6. Evals

**Rubric** (`eval/RUBRIC.md`, frozen before any scored run):
- Each accepted lead is judged blind on Q1 fit, Q2 size and Q3 signal (real, specific, inside the window), and every answer needs a source URL.
- Good lead = Q1 yes, Q3 yes, and Q2 not no.
- A run **passes** with ≥ 6 good leads at precision ≥ 0.8, within budget.
- **pass^3** = 1 only if all 3 reps pass (the headline). pass@1 is reported alongside.

**Arms:** A = workflow (fixed queries), B = agent on Opus 5.5, with the same contract and the same $1.00 cap. Arm C (Sonnet 5.5) and scenarios S3/S4 have not run.

**Pre-pilot smoke run** (`eval/recordings/agent-icp1-2026-10-12/agent/`, ICP-1 logistics, arm B, 1 run, before the pilot):

| Turns | Tool calls | Spend (Exa + Claude) | Accepted | Good (author's manual read against the rubric, not the blind judge) | Lookups skipped | Query rewrites | Verification reads |
|---|---|---|---|---|---|---|---|
| 12 | 43 | $0.87 ($0.455 + $0.417) | 6 | 5 | 41 | 2 | 0 |

**Pilot, judged** (`eval/results/pilot-2026-10-12/report.md`; per-rep accepted counts and spend from `*/*/*/run.json`; verdicts in `eval/truth/S1/`, `eval/truth/S2/`). Target 10 leads, $1.00 cap, n = 3 reps per cell.

| Scenario | Arm | Good leads per rep (of accepted) | Precision (mean) | Cost per good lead (mean) | pass@1 | pass^3 |
|---|---|---|---|---|---|---|
| S1 ICP-1 logistics | A workflow | 2 / 2 / 2 (of 4 / 9 / 6) | 0.35 | $0.38 | 0.00 | 0 |
| S1 ICP-1 logistics | B agent | 9 / 7 / 6 (of 10 / 8 / 7) | 0.88 | $0.12 | 1.00 | **1** |
| S2 ICP-3 funded B2B | A workflow | 0 / 1 / 0 (of 4 / 4 / 4) | 0.08 | n/a (no good lead in 2 of 3 reps; $0.90 in rep 2) | 0.00 | 0 |
| S2 ICP-3 funded B2B | B agent | 6 / 6 / 6 (of 10 / 10 / 10) ‡ | 0.60 ‡ | $0.12 | 0.00 | 0 ‡ |

‡ **Under-counted; re-score pending.** Two leads per rep that the judge scored good (Avarra.ai, Reo.Dev) are counted as misses because their verdict files were keyed before `squashName` started stripping ".ai"/".dev" (FAILURES #11). Recounted from the verdict files under the scorer's own rule, the S2 agent has 8 / 8 / 8 good at precision 0.80, which meets the pass bar. The table shows `report.md` until it is re-scored.

**Reading.** The agent passed S1 in every rep (pass^3 = 1) at $0.12 per good lead, while the workflow, with the same contract and cap, never reached 6 good leads on either scenario. On S2 the agent reached 6 good leads every rep, but `report.md` puts its precision at 0.60, below the 0.8 bar. Of its 12 non-good lead slots, 6 are the scoring bug above. The other 6 come from the verdict files:
- **Q1 no, wrong stage (2):** Miter (rep 1) and Sybill (rep 2) passed the "recently raised seed or Series A" gate, but the judge found later-stage funding.
- **Q2 (3):** Scaffold (rep 3) is outside 30–200 staff. SubBase (reps 1 and 3) was the run's second "cannot verify" on size, and the rubric tolerates only one per run (OuterSignal used it).
- **Q3 not verifiable (1):** Henry AI (rep 2). The judge's fetch of the signal page failed, and it found no corroborating source.

Recency was not the problem: no agent lead failed Q3 for an out-of-window event. LinkedIn hosting hurt the workflow, not the agent. All 5 pooled S2 workflow leads cite a LinkedIn URL, and the 4 not-good ones all fail Q3. Only one agent miss (Sybill) is LinkedIn-hosted, and it failed on Q1. The next iteration would, in order:
1. Fix the verdict key and re-score. This needs no new runs.
2. Make the funding round a quoted fact checked in code, the way size already needs its quoted source (`size_basis`), so the stage comes from the page, not a yes/no summary.
3. Exclude `linkedin.com` as a signal host. The judge cannot open it, and it accounts for all of the workflow's S2 leads.

**Judging.** The blind judge is Opus 5.5 with web search (max 3) and web fetch (max 2). The first, search-only version could not open signal pages and scored S1 8/22 and S2 10/23 good. Its Q3 "cannot verify" verdicts were re-judged with fetch: 8 in S1 (6 flipped to good) and 9 in S2 (5 flipped), giving 14/22 and 15/23. The superseded verdicts are kept as `*.prev.json` (FAILURES #10, RUBRIC change log). I spot-checked 10 of 45 verdicts (22%, `eval/truth/SPOT-CHECKS.md`). All 10 agree with the final verdicts. The one that disagreed with the search-only judge (RGL Logistics) is what triggered the fetch fix.

**What it cost.** About $40 across the build:
- **Exa ≈ $14** (author's log). Files back $11.22 of it: $7.68 for the 12 pilot cells (`run.json`), $1.89 for the three recordings in `eval/recordings/`, and at least $1.64 for the three crashed S2 workflow cells ($0.548 each in their error text, FAILURES #7).
- **Claude agent and planner ≈ $8** (author's log). Files back $2.38: $1.96 for the pilot and $0.42 for the smoke run.
- **Judging: $14.39 recorded.** The search-only pass cost $8.64 (`S1/judge-cost.json` $4.08 + `S2/judge-cost.json` $4.56). The fetch re-judges cost $5.75 (the sum of `costDollars` over the 17 `v3-fetch` verdicts).
- **≈ $3.50 lost** to the first judge run, which parsed 0 of 22 verdicts and left no record (author's log, FAILURES #8).

**Agency check.** Every pilot agent run skipped lookups (S1: 39 / 49 / 53, S2: 11 / 17 / 22), so none trips the rubric's "workflow-shaped" flag. That flag is weak. Query rewrites were 0 / 0 / 0 on S1 and 1 / 0 / 1 on S2, and **no agent run, smoke or pilot, used `read_page`**.

**What the agent did that the workflow couldn't** (from the pre-pilot smoke run's `events.jsonl`):
1. **It proposed a strategy before spending.** At turn 1 it proposed three angles and wrote its own first queries, for example *"UK 3PL logistics company opens new distribution centre warehouse"*, with an estimate of $0.95. The actual spend was $0.87.
2. **It skipped lookups it shouldn't pay for.** On turn 3 it skipped 15 names before any lookup, including *Walmart, Maersk, XPO, CEVA Logistics, A. Duie Pyle*. For comparison, the S1 workflow accepted A. Duie Pyle in rep 2 on an unverified size estimate.
3. **It rewrote its queries.** After the first batch surfaced mostly large firms, it searched *"independent family-owned 3PL warehousing company opens new warehouse, hiring dozens of workers"*, then looked up *Metropolitan Warehouse and Delivery* (541 staff, quoted), which was accepted at turn 5. Its todo list recorded the lesson: *"hiring ads (mostly giant firms)"*.

## 7. Failures found and fixed

Full write-ups: [docs/FAILURES.md](docs/FAILURES.md).

| Symptom | Root cause | Fix | Test |
|---|---|---|---|
| Fresh articles dropped as stale (14 drops on the 2026-10-11 run) | Exa extraction slips the event year | Publish date substituted only for a year-slip (±90 days) | `F2 G2: substitute publishedDate only for a year-slip` |
| 50-result searches cost $0.094, not the probed $0.007 base. 115 of 130 candidates went unenriched | Cost estimates assumed one search price tier | Observed tiers + 25% margin, reserve/settle CostGuard | `cost guard › estimates conservatively` |
| Tool schemas rejected by the API | `minimum`/`maximum` are unsupported with strict tools | Removed. A free `count_tokens` preflight now runs first | `eval/check-tool-schemas.ts` |
| The handback came back as markdown prose, and the UI showed "1 enterprise" | `finish.handback` was a free string | Strict object with counts, data-driven suggestions | `A2c … stores a structured handback` |
| Event log summed to $1.29 of Exa spend against $0.455 actual (2.8×) | Parallel tools logged the shared guard's running total | Per-call Exa cost on each event | `F1.4 reports per-call Exa costs` |
| Concurrent step requests could both run a turn | No lock on the step route | File lock + versioned state, 409 when busy | `F1.1 rejects stale state saves` |
| "AUKLogis" (UK warehouse news) was enriched as Australia's AUK Logistics | Lookup trusted Exa's top company match | Entity check on lookups | `F1.8 lookup_company rejects mismatched entities` |

## 8. Not production-ready

- **Storage:** run state, memory and the daily-spend ledger are JSON files. On Vercel they live in `/tmp`, which is per instance and ephemeral, so the daily cap and memory are not global there.
- **Rate limit** is an in-memory map per process.
- **No auth.** A workspace is an id in `localStorage`, and anyone holding the id can read or clear its memory.
- **Evidence is thin.** n = 3 per cell over 2 scenarios. Arm C and scenarios S3/S4 have not run. 10 of 45 verdicts are human spot-checked. The S2 agent row awaits a re-score (FAILURES #11).
- **Exa extraction noise** (wrong-year dates, conflicting headcounts such as 356 vs 3,560 for one company) is bounded by gates, not eliminated (SPEC-agent §13).
- **Hosting:** each route has `maxDuration = 60`. A turn with slow Exa calls and a long model response could exceed it, and p95 turn time has not been measured.
- The old `eval/recordings/icp1-2026-10-11b` replay no longer matches current request hashes ("replay miss").

## 9. Repo map and commands

| Path | What |
|---|---|
| `app/page.tsx`, `app/ui/` | The product UI (cards → contract → live run → approvals → results → memory) |
| `app/api/planner/*` | Input → seller profile → cards → compiled plan |
| `app/api/runs/*`, `app/api/workspaces/*` | Create / step / decision / stop / state; memory and feedback |
| `src/agent/` | Loop, tools, prompts, state, memory, events, costs |
| `src/gates.ts` | `checkLead`: the lead definition |
| `src/exa.ts` | Exa client: CostGuard, record/replay, concurrency limit, 429 retry |
| `src/pipeline.ts`, `src/plan.ts` | Workflow arm and `SearchPlan` validation |
| `src/demo/` | Keyless demo mode |
| `eval/*.test.ts` | Unit tests, all mocked |
| `eval/harness/` | Cell runner, blind pooling, judge, scorer, simulated user |
| `eval/recordings/`, `eval/results/`, `eval/truth/` | Real traces, pilot results, judge verdicts |

```bash
npm test                 # 275 tests, mocked model + Exa (13 files)
npm run typecheck
npx tsx eval/check-tool-schemas.ts                     # free: prompt + tools via count_tokens
npx tsx eval/run-agent.ts --icp 1 --max-cost 1.00 --approve auto --record <dir>   # one live run
npm run eval:cell -- --set <id> --matrix S1,S2 --arms A,B --reps 3 --max-total-dollars 10
npm run eval:judge -- --set <id> --scenario S1         # blind Opus judge → eval/truth/
npm run eval:score -- --set <id>                       # → eval/results/<id>/report.md
```

## 10. Build notes

This build was AI-assisted. I orchestrated it with coding agents and subagents (Claude models and Codex), and the commit trailers say so. The product decisions are mine: the architecture, the autonomy boundaries, the rubric and eval design, which failures to chase, and what to claim. The live-API probes behind them are mine too. Every number above comes from a file in this repo or is marked "author's log", and anything not yet measured or re-scored is marked as such.

Stack: Next.js 14 · React 18 · TypeScript · `@anthropic-ai/sdk` (Messages API, no framework) · Exa · Vitest.
