# Prospector

Prospector finds B2B sales leads for a seller who doesn't know where to start. You paste your website, approve a short plan, and an agent searches the web for companies with a recent, cited "why now" event (a new warehouse, a funding round, a hiring wave). It checks each one against your plan in code and returns leads with evidence, the companies it turned down and why, and a CSV. It is built for small sales teams that can't afford a data vendor. The same repo contains a fixed-pipeline workflow, which serves as the control arm.

**I built the workflow and the agent, and measured when the agent earns its cost.** The measuring is only partly done. Accepted-lead counts and costs are in. Judged quality is not (see [Evals](#6-evals)).

## Documents

| Document | What it is |
|---|---|
| [docs/SPEC-agent.md](docs/SPEC-agent.md) | Agent spec: goal, flow, tools, autonomy, guardrails, evals, [§14 rollout](docs/SPEC-agent.md#14-rollout-plan) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 13 decisions with alternatives, evidence and what would change them |
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

Demo mode turns on when `DEMO_MODE=1` is set, or when either API key is missing (`src/demo/mode.ts`). The planner returns fixtures from `eval/demo/planner/`, and runs replay `eval/demo/run/`, which is byte-identical to the smoke run's `events.jsonl`. A badge marks the replay.

**Live, with keys:** put `ANTHROPIC_API_KEY` and `EXA_API_KEY` in `.env`. (`.env.example` predates v2 and lists only the Exa key.) Then run `npm run dev`.

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

**Smoke run** (`eval/recordings/agent-icp1-2026-10-12/agent/`, ICP-1 logistics, arm B, 1 run):

| Turns | Tool calls | Spend (Exa + Claude) | Accepted | Good (author's manual read against the rubric, not the blind judge) | Lookups skipped | Query rewrites | Verification reads |
|---|---|---|---|---|---|---|---|
| 12 | 43 | $0.87 ($0.455 + $0.417) | 6 | 5 | 41 | 2 | 0 |

**Pilot** (`eval/results/pilot-2026-10-12/*/*/*/run.json`). These are **accepted, not yet judged**. An accepted lead passed the code gates, and that is not a quality score.

| Scenario | Arm | Accepted per rep (target 10) | Spend per rep | Stop reasons |
|---|---|---|---|---|
| S1 ICP-1 logistics | A workflow | 4 / 9 / 6 | $0.75 / $0.77 / $0.76 (Exa only) | finish ×3 |
| S1 ICP-1 logistics | B agent | 10 / 8 / 7 | $0.81 / $0.85 / $0.85 | target, budget, finish |
| S2 ICP-3 funded B2B | A workflow | 0 / 0 / 0 | $0 recorded (the error text shows $0.548 already spent) | error ×3: the budget pre-check threw. Fixed since (f2bd783), not re-run |
| S2 ICP-3 funded B2B | B agent | 10 / 10 / 10 | $0.85 / $0.52 / $0.78 | target ×3 |

<!-- PENDING: judged pass^3 table from eval/results/pilot-2026-10-12/report.md -->
> **Pending:** good leads, precision, cost per good lead, pass@1, pass^3 and the workflow-shaped flag per cell, from `eval/results/pilot-2026-10-12/report.md` (not yet generated). So far 1 of the 22 pooled S1 leads has been judged (`eval/truth/S1/`): *Away Team (Spreetail)*, from arm A, which the judge scored **not good** (a brand running its own fulfilment network, not a 3PL).
<!-- /PENDING -->

**Agency check.** Every pilot agent run skipped lookups (S1: 39 / 49 / 53, S2: 11 / 17 / 22), so none trips the rubric's "workflow-shaped" flag. That flag is weak. Query rewrites were 0 / 0 / 0 on S1 and 1 / 0 / 1 on S2, and **no agent run, smoke or pilot, used `read_page`**.

**What the agent did that the workflow couldn't** (from the smoke run's `events.jsonl`):
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
- **Evidence is thin.** The pilot is unjudged (1 of 22 S1 verdicts so far), there is no human spot-check yet, n = 3 per cell, arm C and scenarios S3/S4 have not run, and the S2 workflow cells need a re-run after the budget fix.
- **Exa extraction noise** (wrong-year dates, conflicting headcounts such as 356 vs 3,560 for one company) is bounded by gates, not eliminated (SPEC-agent §13).
- **Hosting:** each route has `maxDuration = 60`. A turn with slow Exa calls and a long model response could exceed it, and p95 turn time has not been measured.
- **Demo replay** uses the smoke recording made before the cost-logging fix. Mid-replay, the step responses report up to $1.67 of spend, then $0.87 at the end.
- `.env.example` predates v2. The old `eval/recordings/icp1-2026-10-11b` replay no longer matches current request hashes ("replay miss").

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

This build was AI-assisted. I orchestrated it with coding agents and subagents (Claude models and Codex), and the commit trailers say so. The product decisions are mine: the architecture, the autonomy boundaries, the rubric and eval design, which failures to chase, and what to claim. The live-API probes behind them are mine too. Every number above comes from a file in this repo, and anything not yet measured is marked as pending.

Stack: Next.js 14 · React 18 · TypeScript · `@anthropic-ai/sdk` (Messages API, no framework) · Exa · Vitest.
