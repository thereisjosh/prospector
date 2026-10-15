# 3-minute demo script

**Setup:** run `npm install && DEMO_MODE=1 npm run dev` and open `http://localhost:3000` in a fresh browser profile. Demo mode replays the memory-eval run of 2026-10-15, scenario S1, agent rep 2 (`eval/results/memory-eval-2026-10-15b/S1/B_agent_opus/2/`; `eval/demo/run/events.jsonl` and `state.json` are copies of its files): 15 steps, $0.85 ($0.36 AI + $0.49 web), 8 accepted leads, all 8 judged good, stopped on budget. It was the second run in its workspace, so it started out remembering the 7 companies the first run delivered; `eval/demo/run/run.json` keeps that memory, and the demo seeds a new workspace with exactly those 7 (`src/demo/memory.ts`). The replay pauses at its strategy approval. In a second tab, open the README at [§1 Results](../README.md#1-results).

**Know before you present:**
- Event costs sum to the run's spend, so the meter never overshoots. The one lookup retry (Cleveland Group, $0.009) is already inside that lookup's cost and is not counted twice.
- In the eval, the strategy was auto-approved by the harness; in the replay, you press Approve.
- The recorded run had no scope-change request, so the scope-change card can't be shown in demo mode.
- The run wrote no checklist, so the checklist panel stays empty ("No checklist was written."). That is the recording, not a bug.
- "Clear memory" empties the rail, but the replay is still the recording: it still recalls 7 companies and still skips Wagner and Spartan. The contract screen's "clear memory to see the full run" no longer holds for this recording.

| Time | Do | Say (one sentence) | Screen state to have ready |
|---|---|---|---|
| 0:00 | Paste a website into the single input and submit | "A seller who doesn't know where to start gives us one thing: their website." | Empty start screen with the demo badge visible |
| 0:30 | Show the profile ("Here's what we understood"), then the cards. Open one "why this?" and point at the Hard filter / Estimated badges | "Claude turns the site into editable targeting cards, each with its reason, and marks which are hard filters and which are estimates." | Cards step: logistics ops software → mid-sized 3PLs, 100–1,000 staff, US/GB, last 3 months |
| 1:00 | Show the plan in plain words: target 10 leads, stop spending at $1.00. Point at "This workspace already remembers 7 companies". Press Run | "This is the contract, and the agent already knows what it delivered last time." | Contract screen with the cost estimate and the demo note |
| 1:20 | The Confirmation appears and takes focus ("Here's how the agent plans to start"). Read one angle and one first search, then press Approve (or Tab, Enter) | "Before it spends a cent, the agent proposes its angles and first three searches, and code refuses any spend until I approve." | Confirmation: 3 angles, 3 searches, estimate $0.95 |
| 1:40 | Let it run. The one moving line is the header. In the trace: step 1 "Recalled memory: 7 companies already seen"; step 3 "Skipped Wagner Logistics, delivered 15 Oct in an earlier run, lookup saved" (and Spartan); step 4 "Looking up Cleveland Group" with its retry nested under it; step 5 the first lead, Southern AG Carriers | "It remembers what it already gave me and doesn't pay to look those up again, and when a quote isn't on the page it retries once and says what happened." | Live run: trace on the left, spend meter split between AI and web research on the right |
| 2:10 | Open a lead's Evidence | "Every lead opens onto the sentences it was accepted on, word for word, with the page and the date." | Southern AG Carriers: why-now, when, size ("Employees: 119"), based in, and the 3PL check, each a quote |
| 2:30 | The run stops on budget at 8 of 10. Show the handback: 9 of 9 turned down on size were under 100 staff, so it suggests 50–1,000. Open "Considered but not added". Export the CSV | "When it runs out of budget it doesn't loosen my criteria; it tells me which one to change and why, with the count behind it." | Results screen: outcome, leads, then what was turned down |
| 2:50 | Switch to the README tab, §1 Results, and stop on the judged table | "Same contract and cap: the agent with memory found 8 new good leads where a fresh run found 6." | README §1 and the memory-eval row |

**If there's time for one question:** "What did the agent not do?" It turned down FST Logistics because a date quote wasn't on the page, and it never used `read_page` to check a page itself (README §2, flaw 1). Verifying claims on the source page is the next thing to fix.
