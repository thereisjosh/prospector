# Decision log — Prospector agent (v2-engine)

§ = `docs/SPEC-agent.md`. **Smoke** = `eval/recordings/agent-icp1-2026-10-12/agent/` (12 turns, $0.87, 6 leads). **Pilot** = `eval/results/pilot-2026-10-12/` (accepted leads, not yet judged).

| # | Decision | Alternatives | Why (evidence) | What would change it |
|---|---|---|---|---|
| 1 | Stateless Messages API, hand-written loop, one turn per request | LangGraph; OpenAI Agents SDK; Claude Managed Agents | Every step visible (§3). Durable pause = persist append-only history: LangGraph's checkpointer + `interrupt()` in ~30 lines (§5a); short requests fit serverless (§13). Tests: `save/load round-trips messages byte-identically`, `resumes from a saved state after a crash mid-run` | Needing sandboxed execution or multi-hour background work |
| 2 | Opus 5.5 default; Sonnet 5.5 as arm C | Sonnet default; one model | Model is config (`src/agent/config.ts`); cost per lead is a headline metric (§3, RUBRIC §4). Claude was $0.42 of smoke's $0.87 | Arm C matching B on pass^3 at lower cost per good lead |
| 3 | 8 narrow tools; no "run any query" tool | Raw Exa passthrough; generic fetch | Tools apply the plan's schema and `excludeDomains` in code (§4). `submit_lead` is the only write path, so injected text can at most cause a submit that still faces every gate (§5). Test: `state.leads only contains checker-accepted leads even if final text claims more` | Traces showing a missing capability → add a narrow tool, not a generic one |
| 4 | Plan = contract, not script | Fixed query list (workflow, arm A) | §2. The 2026-10-11 workflow rejected 47 candidates, mostly size, without changing a query (`docs/prompts.md`). Smoke: 12 self-written queries, 2 rewrites, 41 lookups skipped | Most runs flagged "workflow-shaped" (RUBRIC §6), or A ties B on pass^3 for less |
| 5 | Approve contract, strategy, scope changes; not each action. No framework interrupt | Per-action approval; full autonomy; `interrupt()` | Smoke made 43 tool calls, none with external side effects (§5a). Strategy-before-spend enforced in code (test `A2b #6`); decisions bound to the pending tool_use id (`F1.5`) | High decline rate (friction not earning its keep) or near-100% approval (auto-approve under a cost) |
| 6 | Model proposes, code decides (`checkLead`) | LLM self-judging; prompt-only rules | One lead definition for both arms (066eee5). Code bounds real Exa failures: year-slip dates, 356 vs 3,560 headcount (§5). `eval/gates.test.ts`: one test per gate code | Judge finding accepted leads failing Q1 at a rate gates cannot reach |
| 7 | Handback, never self-widening | Agent relaxes criteria itself | The plan is the user's (§5). Smoke's handback suggested an un-actionable `scope` → structured, data-driven handback (8f33f2b; test `never emits field 'scope'`) | Sim-user re-runs with suggestion #1 adding no good leads (RUBRIC `handback_quality`) |
| 8 | Memory: seen-list in code; 👎 reasons in first user message | None; notes in system prompt | Otherwise re-runs repeat leads (§6a); system prompt stays cacheable (§6). Test: `memory feeds seen names, appends run outcomes, and preference notes enter the first message` | Same 👎 reasons recurring despite the notes |
| 9 | No subagents; no agent-to-agent handoff | Lookup subagents; outreach handoff | Handoff adds external side effects and does not address lead quality (§5). Smoke's last turn read 42.5k cached tokens; the 30-turn cap bounds context (§6) | Larger targets (e.g. 50 leads) degrading quality as context grows |
| 10 | Exa is the only retrieval layer | Multiple search APIs; scraping | Every output fact comes from Exa (SPEC-v2 §1), behind one cost guard and record/replay (`src/exa.ts`) | Exa extraction errors that gates cannot bound (§13) |
| 11 | Hard combined Exa + Claude $ cap, enforced by the harness | Prompt-stated budget; Exa-only cap | §5 limits; Claude spend reserved per call (`F1.2`); CostGuard breach stops the run (`F1.3`); $0.05 handback reserve. Pilot agent runs all ≤ $0.86 of $1.00; S2 workflow aborted 3/3 on the cap pre-check → graceful degradation (f2bd783) | `budget` stops dominating runs that were still finding good leads |
| 12 | pass^3 headline, pass@1 alongside | Mean good leads; pass@1 only | "A user needs it to work every time" (RUBRIC §3); math tested (`H5`) | pass^3 = 0 for every arm (no signal at n = 3, RUBRIC §7) |
| 13 | Free `count_tokens` preflight | Discover schema errors on a paid turn 1 | `eval/check-tool-schemas.ts`; the strict-schema fixes in 9ff1b21 (`minimum`/`maximum` unsupported) are the class it catches at $0 | An error that passes `count_tokens` but fails `create` |

## Notes

- **Pilot is unjudged.** Accepted leads: S1 workflow 4/9/6, agent 10/8/7; S2 workflow 0/0/0 (cap error), agent 10/10/10. No precision or pass^3 yet; `eval/truth/` is empty.
- **Smoke made 0 verification reads**, so #4 rests on rewrites and skips.
- **Spec inconsistency:** §12 lists "Memory across runs" as out of scope; §6a and the code ship it. §6a is current.

## Evidence gaps

- #1: only LangGraph is named in the repo; the Agents SDK and Managed Agents were not evaluated.
- #2: arm C has not run; the Opus default is a prior.
- #9: "no subagents" is only an out-of-scope line (§12).
- #10: no comparison against other retrieval providers.
- #12: rationale documented; no pass^3 result yet.
