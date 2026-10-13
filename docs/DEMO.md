# 3-minute demo script

**Setup:** run `npm install && DEMO_MODE=1 npm run dev` and open `http://localhost:3000` in a fresh browser profile, so the memory panel starts empty. Demo mode replays the real smoke run (`eval/recordings/agent-icp1-2026-10-12/agent/`: 12 turns, $0.87, 6 accepted leads), with its recorded strategy-approval pause. In a second tab, open the README at [§6 Evals](../README.md#6-evals).

**Know before you present:**
- The replay uses a recording made before the cost-logging fix (FAILURES #4), so mid-run the spend meter shows more than the $1.00 cap (up to $1.67), then settles at $0.87. Say so if anyone asks. Don't hide it.
- The recorded run had no scope-change request, so the scope-change card can't be shown in demo mode.
- The handback in the recording is the pre-fix one (FAILURES #6).

| Time | Do | Say (one sentence) | Screen state to have ready |
|---|---|---|---|
| 0:00 | Paste a website into the single input and submit | "A seller who doesn't know where to start gives us one thing: their website." | Empty start screen with the demo badge visible |
| 0:30 | Show the profile ("Here's what we understood"), then the cards. Open one "why this?" and point at the Hard filter / Estimated badges | "Claude turns the site into editable targeting cards, each with its reason, and marks which are hard filters and which are estimates." | Cards step: logistics ops software → mid-sized 3PLs, 100–1,000 staff, US/GB, last 3 months |
| 1:00 | Show the plan in plain words: target 10 leads, stop spending at $1.00. Press Run | "This is the contract: the user approves the goal, what counts as a lead, and the budget, not each step." | Contract screen with the cost estimate |
| 1:30 | The strategy card appears ("Here's how the agent plans to start"). Read one angle and one first query, then press Approve | "Before it spends a cent, the agent proposes its angles and first three searches, and code refuses any spend until I approve." | Approval card: 3 angles, 3 queries, est. $0.95 |
| 2:00 | Let the feed run. Point at the long "skipped" list (Walmart, Maersk, XPO…), the new query *"independent family-owned 3PL warehousing company…"*, the first leads arriving at turn 5, and ColdTrack turned down as too large | "It skips companies it shouldn't pay to check, rewrites its search when the first batch skews to giants, and code, not the model, turns down ColdTrack." | Live run: todo list at the top, spend meter split between AI and web research, activity feed |
| 2:30 | Results: 6 leads with "why now" and source links. Open "Considered but not added". Show the handback ("6 of 10"), then export the CSV | "Every lead has a dated, cited event, every rejection has a reason, and when the run falls short it hands back instead of loosening my criteria." | Results screen, scrolled to the handback |
| 2:50 | Switch to the README tab, §6 Evals | "Same contract and cap for the workflow and the agent: here's what each accepted. The judged pass^3 table is pending, and I don't count accepted leads as quality." | README §6: smoke table, pilot accepted-lead table, PENDING block |

**If there's time for one question:** "What did the agent not do?" It never used `read_page` to verify, in any of the 7 agent runs (README §6). That is the next thing to fix.
