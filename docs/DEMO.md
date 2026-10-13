# 3-minute demo script

**Setup:** run `npm install && DEMO_MODE=1 npm run dev` and open `http://localhost:3000` in a fresh browser profile, so the memory panel starts empty. Demo mode replays pilot S1 agent rep 2 (`eval/results/pilot-2026-10-12/S1/B_agent_opus/2/`; `eval/demo/run/events.jsonl` is byte-identical to its `events.jsonl`): 13 turns, $0.85, 8 accepted leads, 7 judged good, stopped on budget. The replay pauses at its strategy approval. In a second tab, open the README at [§6 Evals](../README.md#6-evals).

**Know before you present:**
- The recording is post-fix: event costs sum to the run's spend ($0.504 Exa + $0.349 Claude), so the meter never overshoots (FAILURES #4).
- In the pilot, the strategy was auto-approved by the harness; in the replay, you press Approve.
- The recorded run had no scope-change request, so the scope-change card can't be shown in demo mode.
- One of the 8 leads, Verst Logistics, was judged not good (size). If asked, say so.

| Time | Do | Say (one sentence) | Screen state to have ready |
|---|---|---|---|
| 0:00 | Paste a website into the single input and submit | "A seller who doesn't know where to start gives us one thing: their website." | Empty start screen with the demo badge visible |
| 0:30 | Show the profile ("Here's what we understood"), then the cards. Open one "why this?" and point at the Hard filter / Estimated badges | "Claude turns the site into editable targeting cards, each with its reason, and marks which are hard filters and which are estimates." | Cards step: logistics ops software → mid-sized 3PLs, 100–1,000 staff, US/GB, last 3 months |
| 1:00 | Show the plan in plain words: target 10 leads, stop spending at $1.00. Press Run | "This is the contract: the user approves the goal, what counts as a lead, and the budget, not each step." | Contract screen with the cost estimate |
| 1:30 | The strategy card appears ("Here's how the agent plans to start"). Read one angle and one first query, then press Approve | "Before it spends a cent, the agent proposes its angles and first three searches, and code refuses any spend until I approve." | Approval card: 3 angles, 3 queries, est. $0.90 |
| 2:00 | Let the feed run. Point at the "skipped" list on turn 3 (Walmart, XPO, Amazon, Maersk…), four leads accepted at turn 4, the todo note at turn 7 (*"job ads (mostly large firms)"*) and the query that follows it, *"family-owned regional warehousing and logistics company opens new distribution center…"*. Then A. Duie Pyle turned down on size (1,356 staff) | "It skips companies it shouldn't pay to check, changes angle when one stops paying off, and code, not the model, turns down A. Duie Pyle, which the workflow accepted and the judge marked too big." | Live run: todo list at the top, spend meter split between AI and web research, activity feed |
| 2:30 | The run stops on budget at 8 of 10. Results: 8 leads with "why now" and source links. Open "Considered but not added" (13 size, 3 enterprise). Show the handback: "11 of 13" turned down on size were under 100 staff, so it suggests widening to 50–1,000. Export the CSV | "When it runs out of budget it doesn't loosen my criteria; it tells me which one to change and why, with the count behind it." | Results screen, scrolled to the handback |
| 2:50 | Switch to the README tab, §6 Evals, and stop on the judged table | "Same contract and cap for both: the agent passed all 3 reps on both scenarios at 9 to 12 cents a good lead, and the workflow passed none." | README §6: the final scenario × arm table |

**If there's time for one question:** "What did the agent not do?" It never used `read_page` to verify, in any of the 7 agent runs (README §6). On the funded-B2B scenario, two of its judged misses (Miter, Sybill) were later-stage companies that passed the "recently raised seed or Series A" gate. Verifying the round is the next thing to fix.
