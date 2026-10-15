# UI rework: Phase 2 spec

Phase 1 output, 2026-10-15, branch `v2-engine` at `387bd69`. This is the spec Phase 2 builds from. Nothing under `app/` or `src/` has changed. Read with [PRODUCT.md](../PRODUCT.md) (who and why) and [DESIGN.md](../DESIGN.md) (tokens and rules).

**Short version.** Keep Next 14 and React 18. Add Tailwind 4 through a cascade-layered bridge with no preflight, and copy in shadcn's Trace and Code Block with the CLI. This was verified in a scratch copy of the app: 573 of 573 tests pass, typecheck is clean, and the bridged app is bit-identical to today's on every screenshot that doesn't catch an animation mid-flight, at 1280, 768 and 390 px. The upgrade to Next 15 / React 19 is not needed for this work. The run view becomes one Trace (turn → tool call → verdict → evidence quote) with a single shimmering "running" line, and it shows six kinds of information the client already receives and throws away.

## 0. Decisions and open questions

Decided in this spec (each argued in its section):
- Tooling: Tailwind 4 bridge on Next 14 / React 18, no upgrade (§4).
- No springs. No surface in the design is gesture-driven (§3).
- The agent's checklist maps to **Queue**, and each turn maps to **Task**. Unverified candidates do **not** map to Queue: Queue means "work still to do", and nothing will ever process those candidates. They use the same sectioned Trace that Queue is built on, with outcome wording (§1).
- Turned-down companies are a normal outcome, not an error. Their Trace lines are neutral with a red icon, and never `status="error"` (§1).

Open, for Joshua:
1. **Demo fixture.** The current recording (`eval/demo/run/`, pilot S1 rep 2, 2026-10-12) predates evidence quotes and the newer event kinds. In demo mode the new evidence blocks would show only the size quote, and the retry, memory, trim and repair lines would never appear. The candidate replacement is `eval/results/memory-eval-2026-10-15b/S1/B_agent_opus/3/` (B', fresh workspace, 6 leads with `evidence` and `summary.signal_quote`, 5 `lookup_retry` events, `memory_recalled`, stop = finish). Swapping it changes docs/DEMO.md's script and README's "byte-identical to pilot S1 rep 2" claim, and `eval/ui-copy.test.ts` reads the fixture. This is your call. Phase 2 is demo-safe either way (§5).
2. **PRODUCT.md is inferred.** Init's interview round could not run from a subagent. The second audience (evaluators), the anti-references and the WCAG level are marked `(inferred)` there.
3. **`.impeccable/design.json` sidecar and `.impeccable/live/config.json`** were not written. They are outside this phase's allowed files.

## 1. Component map

### 1a. Every current surface → its replacement

| Current surface (file:line) | Replacement | Why / notes |
|---|---|---|
| Describe input `StartStep` form (app/page.tsx:648–675) | **Prompt Input** (`InputGroup` + `InputGroupTextarea` + `InputGroupButton` submit) | Same Enter-submits, Shift+Enter-newline behaviour it has today (page.tsx:665–670). No attach button, no model menu: there is nothing to attach and the user doesn't pick a model. |
| Submitted input + "Here's what we understood" profile panel (page.tsx:737–770) | **Message**: the user's sentence as a `Bubble`, the agent's reading as a `Message` with an inline Edit and the primary "Suggest who to target" | Turns the step into one exchange with the same agent that later runs. After submit, the input collapses into the bubble. "Change" reopens it. |
| "Is this you?" Instagram candidates (page.tsx:687–708) | **Suggestion** (one-click options, one per domain) + the existing "None of these…" link | Suggestions are exactly one-click answers. |
| "Tell us in one sentence" fallback (page.tsx:710–728) | Second **Prompt Input**, inside the agent `Message` | Same control vocabulary as the first input. |
| Busy/reading state (page.tsx:730–735) | A `TraceLine status="running"` reading "Reading about your business…" | One running indicator vocabulary across the app, replacing the spinner. |
| Target alternatives row (CardsStep.tsx:52–64) | **Suggestion** chips ("Suggested", "Smaller regional 3PLs", …) with `aria-pressed` | They are one-click re-targetings. |
| Target cards grid, 7 bordered and shadowed cards (CardsStep.tsx:71–164; globals.css:1198, :1204) | **Stays custom**: one form surface with hairline-separated rows. Label column (title, `Badge` Hard filter / Estimated, "Why this?" `Collapsible`) on the left, controls on the right | These are form groups, not content cards. Seven same-chrome cards is the identical-card-grid ban (§6). Field types are standard inputs and selects, so shadcn adds nothing here except `Badge` and `Collapsible`. |
| `ChipList`, `CountryPicker` (CardsStep.tsx:215, :287) | **Stay custom**, restyled | Native `<select>` for country stays: it works at 390 px and with screen readers. |
| Approve step contract `dl` (page.tsx:805–867) | **Stays custom**: one "contract" surface. "Starting search ideas" becomes a `TraceCollapsible` of `TraceLine`s with a search icon and mono queries | The contract is the user's terms, not the agent's plan, so Plan doesn't fit. Its search ideas are agent intentions, which is Trace's vocabulary. |
| Budget panel (page.tsx:869–889) | **Stays custom**, merged into the contract surface as its last row | One surface, one primary action ("Run agent"). |
| `StatusBar` with pulsing dot (RunView.tsx:193–224; globals.css:1392, :1412) | Run header: a `TraceLine status="running"` (shimmer) plus the existing status sentences plus Stop / Keep going | The shimmer becomes the single continuous indicator. `role="status"` stays on the sentence. |
| `ApprovalCard`, strategy (RunView.tsx:261–304) | **Confirmation** (Item + Buttons) wrapping a **Plan** body: angles and first searches as Plan steps (`pending`), with the estimate as the Plan description | Per shadcn: "A pending approval is a prompt, not activity, so it sits outside Trace." After a decision it resolves to a Trace line ("You approved." / "You approved with changes." / "You declined."), using the existing copy.ts strings. |
| `ApprovalCard`, scope change + `ScopeSummary` + `ScopeEditor` / `StrategyEditor` (RunView.tsx:306, :331, :353, :370) | **Confirmation**. Edit opens the existing editors inline inside the Item | The editors are domain forms and stay custom. Untested live (README §2 flaw 13), so the mocked tests are its only coverage. |
| Checklist panel (RunView.tsx:118–125; `Checklist` in parts.tsx:15) | **Queue** for `[ ]` and `[x]` items, plus labelled lines for the agent's bold-key prose ("**Tried:** …", "**Next:** …"), plus a staleness line | The demo's todo has no checkbox items at all (`eval/demo/run/state.json` `todo`), so the bold-key rendering is required, not optional. README §2 flaw 3: the checklist goes stale. Show "Updated at step 7 · 6 steps ago" and, when it disagrees, "Leads found: 5 of 10 (agent's note) · 6 accepted". No shimmer on Queue (§3). |
| Spend panel `SpendMeter` + mini-stats (RunView.tsx:127–142, :226–253) | **Stays custom** (`role="meter"`), extended with a **Context**-style disclosure: cache share and tokens | "Turned down 0" next to "Considered but not added 53" (seen on the 1280 results screen) is two different counts under one word. Rename the mini-stat to count everything in "Considered but not added", or drop it. |
| Activity feed "What it's doing" (RunView.tsx:144–158; `eventLine` copy.ts:256) | **Trace**, nested: turn (**Task**) → tool call → verdict → evidence **Code Block** | See 1b and 1c. Chronological, auto-following the bottom unless the user has scrolled up. Completed turns collapse to one line, and only the running or latest turn is open (`open ?? running`, per the Trace docs). |
| Mid-run pause (`pausedByUser`, RunView.tsx:206–208) and lost contact (page.tsx:309) | **Checkpoint** (`Marker variant="separator"` + `Button`): "Paused at step 6 · $0.41 spent [Keep going]" | Runs are durable (state.json per run), so a pause is a real checkpoint. Checkpoint's "restore" (truncate later turns) does not apply. Its action is resume. |
| `Outcome` + `Handback` (RunView.tsx:474–575) | **Stays custom** (headline, summary, top reasons). Each handback suggestion is a **Suggestion** with its existing "Apply and run again" action | Removes the inset side stripe (globals.css:1710) and the nested bordered `.suggestion` boxes (:1745). |
| `Leads` table + `LeadRow` (RunView.tsx:579–720) | **Stays custom** (a data table with 6 columns and CSV parity). Each row gets an "Evidence" `TraceCollapsible` that opens a **Code Block** (size `sm`, `wrap`) of verbatim quotes | Inline Citation was considered for the why-now sentence and rejected: hover-only detail fails on touch, and the Source column already carries the link. |
| `Candidates` (Candidates.tsx:8–40) | The sectioned Trace that Queue is built on, under the existing heading "Unverified candidates" and its intro, one `TraceCollapsible` per company opening to the missing-quote reason and source | Not Queue semantics. Nothing will verify them later, so no "to do" icon or wording. `app/ui/candidates.test.tsx` fixes the strings and `href` (§5). |
| `Rejections` "Considered but not added" (RunView.tsx:724–808) | **Trace** sections, one `TraceCollapsible` per reason group with its count, opening to companies and phrases | Same strings via `groupRejections` / `reasonGroup`. |
| `MemoryPanel` in the rail (Memory.tsx:27–115) | **Stays custom** on the dark rail, built from `Collapsible` + `Item` rows. Forget becomes an icon `Button` with the existing aria-label | The rail's dark material is not a shadcn theme surface. `eval/memory.test.ts` imports `MemoryPanel`. |
| `AboutDialog` (page.tsx:912–946) | shadcn **Dialog** (Base UI) | Today it has no focus trap: focus can tab behind the scrim. Base UI's Dialog traps focus, returns it on close and handles Escape. |
| Rail nav, topbar, theme toggle, demo badge (page.tsx:440–499) | **Stay custom** | App shell. Fix: the demo badge wraps to two lines at 390 px and the last step tab clips ("Ru"; see `.agents/scratch/shots/baseline/390-4b-run-live.png`). |
| Not used | Chat, Reasoning, Subagent, Tool, Sources, Model Selector, File Tree, Terminal, Test Results, Stack Trace, Chain of Thought | Chat and Message Scroller: this is a one-shot contract, not a conversation. Reasoning: events carry no thinking text. Subagent: there is a single agent. Tool: Trace lines plus nested Code Block already show input → output, at lower density. Model Selector: the model is fixed by the contract. Stack Trace: errors are deliberately generic to the user ("Something went wrong on our side"). Chain of Thought: the turn-level Task collapse covers it. |

### 1b. Event → Trace line (the run ledger)

Every event already reaches the browser: `POST /api/runs/:id/step` returns `events`, and `GET /api/runs/:id` returns full `AcceptedLead` objects. `eventLine` (copy.ts:256) returns `null` for everything below marked **new**. No API change is needed.

| Event (src/agent/events.ts:16–30) | Trace rendering | Status / icon |
|---|---|---|
| `model_call` | Turn header (**Task**): "Step 4" + description "2 searches · 3 lookups · 1 added · $0.06 · 5.2 s" (sums of `claudeCost` and the turn's Exa cost; `latencyMs`) | running while the turn is in flight, otherwise none |
| `tool_call` search_signals | existing "Searching: {query}" (copy.ts:265); the query in mono | search icon |
| `tool_call` lookup_company | existing "Looking up {name}; skipped N obvious non-fits (…)" (copy.ts:278); skipped names nest as a collapsible child | building icon |
| `tool_call` lookup_company with `seen` | existing "Skipped {name}, {when} in an earlier run, lookup saved" | memory icon |
| `tool_call` read_page | existing "Reading {host} to double-check" | file icon |
| `tool_call` is_error | existing "A search didn't go through; trying something else." | `status="error"` (a real failure) |
| `submit_verdict` ok | existing "Checked {company}: fits. Added to your leads." → nested **evidence Code Block** (1c) | check icon, green |
| `submit_verdict` rejected | existing "Turned down {company}: {phrase}" | neutral line, red x icon; **not** `status="error"` |
| `approval_request` / `decision` | Confirmation while pending (outside Trace), then the existing "You approved." / "You declined." lines | — |
| `update_todo` | existing "Updated its checklist", and it drives the Queue's staleness line | list icon |
| `stop` | existing `stopSentence` (copy.ts:233) as the last line | — |
| **new** `lookup_retry` | nested under its lookup: "Retried the lookup once: {reason}. {outcome}" | retry icon; `status="error"` only for `retry_failed` |
| **new** `memory_recalled` | first line of the run: "Recalled memory: {seen} companies already seen, {notes.included} notes, {preferences.included} pieces of your feedback" (links to the rail panel) | memory icon |
| **new** `context_trimmed` | in its turn: "Condensed {droppedTurns} older steps to stay within its working memory" | — |
| **new** `turn_repaired` | in its turn: "Recovered an interrupted step" | — |
| `policy`, `turn_end`, `token_count_estimated`, `feedback` | not shown (internal) | — |

**New information made visible, and where it comes from:**

| What the user sees | Source | Observed |
|---|---|---|
| Lookup retries and their outcome | `lookup_retry` {company, reason: `network` / `quote_not_in_page`, outcome: `recovered` / `kept_retry` / `kept_first` / `retry_failed` / `skipped_budget`, retryExaCost} (src/agent/tools.ts:566) | memory-eval 2026-10-15b: 9 events (5 network→recovered, 1 quote→kept_retry and accepted, 3 quote→kept_first) |
| Memory recalled at start | `memory_recalled` {seen, preferences, notes} (src/agent/loop.ts:122) | every 2026-10-15 run |
| Context trimmed | `context_trimmed` {droppedTurns, droppedTokens, keptTokens} (loop.ts:313, :594) | none recorded yet. The line ships but stays unseen until a long run triggers it |
| Turn repaired | `turn_repaired` {toolUseIds} (loop.ts:287) | none recorded yet |
| Cache share | `model_call.tokens` {input, cache_read, cache_creation}. Show "{n}% of the agent's reading came from cache" as cache_read ÷ (cache_read + cache_creation + input), in the Spend panel's Context disclosure | memory-eval 2026-10-15b rep 2: 91% (327,760 read / 32,930 written / 56 uncached) |
| Evidence quote per lead | `lead.summary.signal_quote`, `signal_date_quote`; `lead.enrichment.employee_estimate_source`, `hq_quote`, `is_<gate>_quote`; `lead.evidence.signal_title`, `signal_published_date` (src/agent/state.ts:24–37, src/evidence.ts:23) | all leads since 2026-10-14. The current demo fixture has only `employee_estimate_source` (§0, Q1) |
| Checklist staleness | turn of the last `update_todo` vs the current turn; the agent's "Leads found" vs `leads.length` | demo: note says 5 of 10, 6 shown |

**Copy rule (C).** Every existing string in `app/ui/copy.ts` stays as it is. Phase 2 adds new strings for the new lines to copy.ts, in the same voice: plain words, numbers, no internal codes. They are covered by extending `eval/ui-copy.test.ts`'s "no internal codes" check to the new formatter. Proposed additions:

```ts
// lookup_retry
`Retried the lookup for ${company} once after a network error. It went through.`        // network, recovered
`Retried the lookup for ${company} once after a network error. It failed again.`        // network, retry_failed
`Retried the lookup for ${company}: a quote wasn't on the page. The second try found it.` // quote, kept_retry
`Retried the lookup for ${company}: a quote wasn't on the page. Kept the first result.`  // quote, kept_first
`Didn't retry the lookup for ${company}: the budget was nearly spent.`                   // skipped_budget
// memory_recalled / context_trimmed / turn_repaired / cache / staleness
`Recalled memory: ${seen} compan${seen === 1 ? "y" : "ies"} already seen, ${notes} note${notes === 1 ? "" : "s"}, ${prefs} piece${prefs === 1 ? "" : "s"} of your feedback`
`Condensed ${n} older step${n === 1 ? "" : "s"} to stay within its working memory`
`Recovered an interrupted step`
`${pct}% of the agent's reading came from cache`
`Updated at step ${t} · ${ago} step${ago === 1 ? "" : "s"} ago`
```

Strings inline in `app/page.tsx` today (STEPS titles at :35–40, hints, AboutDialog body) stay byte-identical. Moving them into copy.ts is allowed only as a pure move.

### 1c. The evidence Code Block (per accepted lead)

```
✓ Added Southern AG Carriers, Inc.                                        ▾
│ ┌ Evidence · albanyga.com · published 18 Sep 2026 ───────────── [copy] ┐
│ │ Why now   "…Expands Regional Operations with New Terminal Facility…"   │
│ │ When      "September 2026"                                             │
│ │ Size      "119 employees"                    quoted · 100–1,000 ✓      │
│ │ Based in  "Albany, Georgia"                                            │
│ │ 3PL       "provides …logistics services to other companies"            │
│ └────────────────────────────────────────────────────────────────────────┘
```
Labels are sans (Small, muted) and quotes are mono (Mono, ink). This is the Verbatim Rule in DESIGN.md §3. A missing quote renders as the absence it is ("No quote captured", muted). It is never synthesised. The same block appears in the leads table's Evidence row.

## 2. Information architecture and layout

**Shell (all screens).** Dark rail on the left (244 px) holding brand, the four steps, "What I remember" and footer links. Light canvas on the right. The sticky translucent topbar holds the step title, subtitle, demo badge and theme toggle. **Rationale (PRODUCT.md scene):** the canvas is where close reading happens (quotes, company names, CSV-bound rows) in a daylight office and on shared screens, which calls for light. The rail is the instrument housing that persists across steps and runs: the steps, and the memory that outlives a run. A heavier, darker material separates structure from work (apple-design §12). It stays dark in both themes because it isn't content. The canvas, which is content, follows the theme.

**Spacing rhythm.** 4 px base. Steps: 4 · 8 · 12 · 16 · 24 · 32 · 48. Within a row 8, between rows 12, between sections 24, page padding 32 at 1280, 24 at 768, 16 at 390. Today's off-grid values (6, 10, 14, 18, 22, 26, 28; e.g. globals.css:167, :1489, :1627) move onto the scale in the polish step (5-iv), not in the no-visual-change step.

**Type scale.** Fixed rem, six steps, tracking and leading per size (DESIGN.md §3). Body 14/20 at 0, Small 13/18 at 0, Label 12/16 at +0.01em sentence case, Body Large 15/22 at −0.005em, Title 17/24 at −0.01em, Headline 22/28 at −0.02em, Mono 12.5/18. Tabular figures on money, counts and dates.

**Z-index scale** (replacing globals.css:59–61; same order, room between steps). Base UI popups portal to `body`.
`--z-dropdown: 100` (popovers, hover cards) · `--z-sticky: 200` (topbar) · `--z-scrim: 300` · `--z-dialog: 310` · `--z-toast: 400` · `--z-tooltip: 500`. Code Block's in-block action overlay uses a local `z-10` inside its own stacking context, which is fine.

**Breakpoints.** Structural, not fluid type. ≥1100: full layout. 900–1099: leads table stacks to 2 columns (exists, globals.css:2068). <900: rail becomes a top band (exists, :2092). <600: single column (exists, :2157).

### Describe
```
1280 ──────────────────────────────────────────────────────────────────────
│rail│ What do you sell?                                  [Demo] [◐]      │
│    │ One line is enough. We'll work out who to look for.                │
│    ├────────────────────────────────────────────────────────────────────┤
│    │   ┌ Prompt Input (max 680) ─────────────────────────────────────┐  │
│    │   │ Your website, Instagram handle, or one sentence about…      │  │
│    │   │                                               [Continue ↵]  │  │
│    │   └─────────────────────────────────────────────────────────────┘  │
│    │   e.g. acme-logistics.com, @acmecoffee, or We sell payment…        │
│    │                                                                    │
│    │   after submit:                    ┌ Bubble ─────────────────┐    │
│    │                                    │ We sell labor-scheduling…│ Change
│    │                                    └─────────────────────────┘    │
│    │   ◎ Here's what we understood                                     │
│    │     We think you sell … in United States and United Kingdom. Edit  │
│    │     [Suggest who to target]                                        │
```
Primary task: say what you sell. Content column max 680 px (68ch prose). 390: the input's submit button moves below the textarea (exists, globals.css:2174) and the bubble goes full width.

### Target
```
1280 ──────────────────────────────────────────────────────────────────────
│rail│ Who should we look for?                                            │
│    │ Try a different angle: (Suggested) (Smaller regional 3PLs) (Last-mile…)
│    │ Hard filter applied exactly. Estimated judged from public info…    │
│    │ ┌ one surface, hairline rows ────────────────────────────────────┐ │
│    │ │ Who                      │ Industry [Third-party logistics   ] │ │
│    │ │ Why this? ▸              │ Kind     [Mid-sized 3PL, wareh…   ] │ │
│    │ │──────────────────────────┼─────────────────────────────────────│ │
│    │ │ Why now                  │ [a new warehouse, an expansion…   ] │ │
│    │ │ Why this? ▸              │ (New facility ×)(Expansion ×)(+ Add)│ │
│    │ │──────────────────────────┼─────────────────────────────────────│ │
│    │ │ Company size  Estimated  │ From [100]  To [1000]  ☑ Include…  │ │
│    │ │ … Stage · Where · How recent (Hard filter) · Leave out …        │ │
│    │ └─────────────────────────────────────────────────────────────────┘ │
│    │ [Back] [Build the plan]                     (problems listed above) │
```
Label column 220 px. At 768 the label column stacks above the controls. At 390 everything is single column and the pairs (From/To) stay side by side, since both fit at 390.

### Approve
```
│    │ ┌ the contract ──────────────────────────────────────────────────┐ │
│    │ │ Find [10] companies that are                                   │ │
│    │ │ Mid-sized 3PL, warehousing and fulfillment providers (3PL)     │ │
│    │ │ Why now     a new warehouse, …, in the last 3 months           │ │
│    │ │ Size        About 100–1,000 employees. Companies that don't…   │ │
│    │ │ Based in    United States and United Kingdom                   │ │
│    │ │ Must be true provides warehousing, fulfillment…                │ │
│    │ │ Leave out   12 companies (RXO, XPO, XPO Logistics, GXO, …)     │ │
│    │ │ ▸ Starting search ideas  (Trace lines, mono queries)           │ │
│    │ │────────────────────────────────────────────────────────────────│ │
│    │ │ Stop spending at [$ 1.00]   Estimated cost: about $0.84        │ │
│    │ │ Free runs left on this site: 2 · $2.50                         │ │
│    │ │ Before it spends anything, the agent shows you its opening…    │ │
│    │ └────────────────────────────────────────────────────────────────┘ │
│    │ Demo: the run that follows is a recording…  (plain muted line)     │
│    │ [Edit targeting] [Run agent]                                       │
```
Max 760 px. At 390 the terms become stacked label-over-value (exists, globals.css:2186).

### Run (live) and Results
```
1280 live ─────────────────────────────────────────────────────────────────
│rail│ Finding leads                                       [Demo] [◐]     │
│    │ ≋ Working on step 5…  (only shimmer on screen)            [Stop]   │
│    │ ┌ Confirmation (only while pending; takes focus) ───────────────┐  │
│    │ │ Here's how the agent plans to start                           │  │
│    │ │  ○ Angle 1   ○ Angle 2   ○ Angle 3     First searches (mono)  │  │
│    │ │  Its estimate for the whole run: $0.90 (your limit is $1.00). │  │
│    │ │                                   [Decline] [Edit] [Approve]  │  │
│    │ └───────────────────────────────────────────────────────────────┘  │
│    │ ┌ Trace (1fr) ─────────────────────────┐ ┌ side 300 ────────────┐  │
│    │ │ ◇ Recalled memory: 7 companies …     │ │ Spend                │  │
│    │ │ ▸ Step 1 · plan proposed · $0.01     │ │ $0.41 of $1.00 limit │  │
│    │ │ ▸ Step 2 · 2 searches · $0.05        │ │ ▓▓▓▓▓▒▒▒░░░░░░       │  │
│    │ │ ▾ Step 4 · 3 lookups · 1 added       │ │ AI $0.20 · Web $0.21 │  │
│    │ │   ⌂ Looking up Cleveland Group       │ │ ▸ 91% from cache     │  │
│    │ │     ↻ Retried once: quote wasn't…    │ │──────────────────────│  │
│    │ │   ✓ Added RGL Logistics          ▸   │ │ Checklist  (Queue)   │  │
│    │ │   ✕ Turned down A. Duie Pyle: size   │ │ Updated at step 3 ·  │  │
│    │ │ ≋ Step 5 · working…                  │ │ 2 steps ago          │  │
│    │ └──────────────────────────────────────┘ └──────────────────────┘  │
│    │ Leads 2 ──────────────────────────────────────── [Download CSV]    │
│    │ Company and fit | Why now | Event date | Size | Source | Good lead? │
│    │ ▸ Evidence (per row)                                              │
1280 results: the run header becomes the Outcome (headline, summary, Suggestions);
then Leads → Unverified candidates → Considered but not added → "How it got here ·
13 steps · $0.84" (Trace, collapsed). The side column keeps Spend and the Checklist.
```
**Order rationale.** While live, the user watches activity and must not miss an approval, so status and Confirmation go first and the trace sits above the fold. Once finished, the job is the leads, so the outcome and leads come first and the trace becomes provenance, one click down. **768:** a single column, ordered status → Confirmation → Spend (compact, one line plus bar) → Trace → Checklist → Leads. Leads use the existing 2-column stacked rows (globals.css:2068). **390:** same order. Trace descriptions drop under titles, evidence Code Blocks wrap (`wrap`, no horizontal scroll), the demo badge shortens to "Demo" (the full sentence moves to its `title` and an sr-only span), and the step tabs scroll with the active tab scrolled into view.

**Trace scroll behaviour.** The trace is a bounded scroller (max 60vh). It follows the bottom while the user is at the bottom. If they scroll up, it stops following and shows a "Jump to latest" button. Completed turns auto-collapse, so a 13-turn run is 13 lines plus the open one. `aria-live="polite"` sits on a visually hidden region that announces each new turn header, not every child line.

## 3. Motion plan

**Tokens** (extend globals.css:63 `--ease`; don't add a parallel set):

| Token | Value | Use |
|---|---|---|
| `--ease-out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)` | alias of today's `--ease`. State transitions, press release |
| `--ease-out-quint` | `cubic-bezier(0.22, 1, 0.36, 1)` | entrances (Confirmation, lead row, outcome, dialog) |
| `--ease-in-quart` | `cubic-bezier(0.5, 0, 0.75, 0)` | exits (same path back) |
| `--ease-in-out-cubic` | `cubic-bezier(0.65, 0, 0.35, 1)` | theme crossfade only |
| `--dur-press` / `--dur-1` / `--dur-2` / `--dur-3` | `100ms` / `150ms` / `220ms` / `320ms` | |
| `--shimmer-duration` | `2s` linear (shadcn default) | running Trace title |

**Springs: none.** Apple-design reserves springs for gesture-driven surfaces (drag, swipe, sheet). This design has none: evidence expands inline at every width, memory stays a rail disclosure, and nothing is draggable. If a mobile bottom sheet is ever added, it gets a critically damped spring (damping 1.0, response 0.3 s), with 0.8 only after a flick, plus velocity handoff. Everything else uses CSS transitions, which retarget from the current value when interrupted (a re-triggered transition starts from the computed style), so there are no keyframes on anything that can be interrupted. No layout-property animation anywhere: the spend meter moves from `width` to `transform`, and Trace collapsibles lose their height transition.

**Surviving moments** (each passed the find-animation gate on frequency, purpose, budget and function):

| # | Moment | Properties | Duration · curve | Reduced motion | Frequency · purpose |
|---|---|---|---|---|---|
| M1 | Running Trace title shimmer, the one continuous indicator. Replaces `.status-dot` pulse (globals.css:1412) and `.live-dot` pulse (:270) | `background-position` on a `background-clip:text` gradient (shadcn `shimmer`) | `--shimmer-duration` 2s linear, infinite while running | static text, no gradient (built into the shadcn utility; verified `animationName: none` under `reducedMotion: reduce`) | continuous while running · state |
| M2 | Press feedback on every pressable: primary, ghost, chip, thumb, step tab, Suggestion. Today only primary and search (globals.css:377, :494) | `transform: scale(0.97)` on `:active`, which fires on pointer-down | press `--dur-press` `--ease-out-quart`; release `--dur-1` | kept (a 3% scale isn't vestibular). The global RM rule makes it instant | tens/day · feedback |
| M3 | Confirmation appears (approval request) and moves focus to its question | `opacity 0→1`, `transform: translateY(4px)→0` | `--dur-2` `--ease-out-quint` | opacity only, `--dur-1` | 1–2 per run · preventing a jarring change |
| M4 | Confirmation resolves into its Trace line (today it vanishes instantly: RunView.tsx:94 conditional render) | exit `opacity 1→0`; then the line enters per M5 | `--dur-1` `--ease-in-quart` | instant | 1–2 per run · spatial consistency |
| M5 | New turn header / Trace line arrives | `opacity 0→1` only, no translate | `--dur-1` `--ease-out-quart` | instant | tens per run · preventing a jarring change, kept near-imperceptible for its frequency |
| M6 | Lead row enters the table mid-run (today `rise` 360ms on every row, globals.css:1821) | `opacity` + `translateY(4px)→0`; row background `--accent-soft → transparent` | entrance `--dur-2` `--ease-out-quint`; highlight 1200ms `--ease-out-quart` | appears instantly, no highlight | ~6–10 per run · state (where the new lead landed) |
| M7 | Spend meter moves (today `width` 400ms, globals.css:1584) | `transform: scaleX(f)`, `transform-origin: left`; the second segment is `translateX` by the first's fraction | `--dur-2` `--ease-out-quart` | instant | every step · state |
| M8 | Outcome appears at run end (today: no entrance) | `opacity` + `translateY(6px)→0` | `--dur-3` `--ease-out-quint`, no overshoot | opacity only, `--dur-1` | once per run · completion |
| M9 | Disclosures (Trace rows, Why this?, Evidence, memory, rejection groups) | chevron `rotate(90deg)`; content `opacity 0→1`; **height instant**: override `transition-[height] duration-200` at components/ui/trace.tsx (`TraceCollapsibleContent`) | chevron `--dur-1` `--ease-out-quart`; content 120ms; close mirrors with `--ease-in-quart` | instant | occasional · state |
| M10 | About dialog | scrim `opacity`; dialog `opacity` + `scale(0.98)→1`, centred (modals are exempt from trigger origin); exit along the same path | in `--dur-2` `--ease-out-quint`, out `--dur-1` `--ease-in-quart` | opacity only | rare · preventing a jarring change |
| M11 | Theme toggle: no brightness jump (apple-design §14) | View Transitions root crossfade | `--dur-2` `--ease-in-out-cubic` | instant | rare · preventing a jarring change |
| M12 | Step content change (replaces `.step` rise 280ms + translate, globals.css:852) | `opacity 0→1` only | `--dur-1` `--ease-out-quart` | instant | a few per session · preventing a jarring change |

**Rejected:**
- **Demo/Live badge pulse** (globals.css:270, 2.4s infinite). It decorates a state that never changes, and it is a slow continuous oscillation (about 0.4 Hz) of the kind apple-design §14 warns against. Removed.
- **Count-up on spend total and lead count.** These are numbers the user reads, and they also drive `aria-valuenow`. Function: hinders.
- **Stagger on the Target rows.** Product register: no orchestrated page-load sequences. The user is about to edit, not watch.
- **Slide transitions between wizard steps.** This is core navigation, and a slide adds latency on every move. The rail already tells the user where they are.
- **Height animation on Trace collapsibles** (shadcn default). It animates a layout property inside a list that is streaming: neighbours reflow for 200 ms on every toggle.
- **Shimmer on Queue in-progress items or on skeletons.** It would break the single-continuous-indicator rule.
- **Exit animation when forgetting a memory item.** Removal lands after a server round-trip and refetch (page.tsx:417–424), so the motion would fire late and detached from the click.
- **Hover lift or highlight on lead rows.** Tens per day and decorative.

### Find-animation-opportunities report (the current app, read-only, before the rework)

Recon: Next 14, plain CSS, no motion library. One easing token (`--ease`, ease-out-quart). Existing motion: `rise` (on steps, the approval card, the first feed item and lead rows), `fade`/`pop` on the dialog, `pulse` on two dots, `spin` on the spinner, a `width` transition on the spend bar, and a global reduced-motion clamp (globals.css:2214). The product is a crisp tool, which earns few and subtle suggestions. Frequency map: step navigation a few per session; feed lines 40–60 per run; approvals 1–2 per run; run end once.

**Part 1: Opportunities**

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `RunView.tsx:94` (`waiting && <ApprovalCard>`) | After Approve the card disappears in one frame while the feed gains "You approved." elsewhere | Spatial consistency | 1–2 per run | Exit `opacity 1→0` 150ms `cubic-bezier(0.5,0,0.75,0)`, then the decision line enters with `opacity` 150ms `var(--ease)`. RM: instant |
| 2 | `globals.css:497` `.ghost-btn`, `:1148` `.chip-btn`, `:1937` `.thumb`, `:640` `.step-link` | No `:active` state, while primary buttons have one (:494) | Feedback | Tens/day | `:active { transform: scale(0.97) }`, `transition: transform 100ms var(--ease)` |
| 3 | `RunView.tsx:105` `<Outcome>` (`.outcome`, globals.css:1705) | The results headline appears with no bridge when the run stops | Preventing a jarring change | Once per run | `opacity 0→1` + `translateY(6px)→0`, 320ms `cubic-bezier(0.22,1,0.36,1)`. RM: opacity 150ms |
| 4 | `CardsStep.tsx:196`, `Memory.tsx:31`, `page.tsx:862` (`<details>`) | Disclosure content snaps in and the marker flips | State indication | Occasional | Marker `rotate(90deg)` 150ms `var(--ease)`; content `opacity` 120ms; no height. RM: instant |
| 5 | `page.tsx:183` `toggleTheme` | Instant full-screen brightness jump | Preventing a jarring change | Rare | `document.startViewTransition` root crossfade 200ms `cubic-bezier(0.65,0,0.35,1)`. RM: skip |

**Part 2: Rejected candidates**
- `page.tsx:665` Enter-to-submit on the describe textarea: keyboard-initiated. **Rejected on frequency: never animate.**
- `RunView.tsx:233` spend total and `:134` lead count number roll: **rejected on function**, since these are data being read.
- `CardsStep.tsx:71` cards grid entrance stagger: **rejected on purpose**, decoration on a form the user is about to edit.
- `page.tsx:455` step navigation slide: **rejected on frequency and speed**. Core navigation; latency on every move.
- `Memory.tsx:20` forget-item exit: **rejected on function**. It fires after a network round-trip, detached from the click.

**Part 3: Verdict.** The app needs less motion than it has, not more. It already runs one identical `rise` entrance on four different things and two infinite pulses. The adds are small: press feedback that is missing on most buttons, a bridge when the approval card resolves, and one entrance for the outcome. Highest leverage is #1, because the approval resolution is the moment a user is most likely to lose their place. Hand-off: `improve-animations plan <row>` turns any row into an implementation plan. For the rework the full set is the M-table above.

## 4. Tooling plan (verified)

**Verdict: no upgrade.** `npx shadcn@latest init` + `add trace code-block` works on Next 14.2.35 / React 18.3.1 once Tailwind 4 and an `@/*` alias exist. The CLI does not require Next 15 or React 19. It does require Tailwind and an import alias, and it picks Tailwind v4 and whichever base you pass (`-b base` gives Base UI; Radix and React Aria are also offered). Pick **Base UI**: it is the docs' default variant, and its peer range is `react ^17 || ^18 || ^19`. Choose the bridge (keep our CSS, layer Tailwind under it) over hand-vendoring Trace and Code Block into plain CSS. Hand-vendoring would mean rewriting about 690 lines of utility classes per component (trace.tsx 162, code-block.tsx 249, plus collapsible, button, highlighter and hook) and losing upstream fixes. The bridge was proven to cost zero visual change.

### Exact commands that worked (scratch: `.agents/scratch/shadcn-probe`, `.agents/scratch/app-bridge`)

```bash
# CLI 4.21.5, against a copy of our package.json (next ^14.2.15 → 14.2.35, react 18.3.1)
npx shadcn@latest init -b base -p nova -y          # needs Tailwind + alias first, see errors below
npx shadcn@latest add trace code-block -y           # → collapsible, button, trace, code-block, lib/highlighter.tsx, hooks/use-highlighted-code.ts
npx shadcn@4.21.5 add item marker input-group message bubble badge -y   # Confirmation/Checkpoint/Prompt Input/Message parts; tsc clean on React 18 types
npm i tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 postcss tw-animate-css@1.4.0 shadcn@4.21.5 cn@0.4.0 \
      lucide-react@1.57.0 @base-ui/react@1.9.0 class-variance-authority@0.7.1 shiki@4.5.0   # no peer conflicts with React 18
```

### Errors hit, verbatim, with root causes

1. Init with no Tailwind and no alias (our repo today):
   ```
   ✖ Validating Tailwind CSS.
   ✖ Validating import alias.
   No Tailwind CSS configuration found at …/shadcn-probe.
   It is likely you do not have Tailwind CSS installed or have an invalid configuration.
   Install Tailwind CSS then try again.
   Could not find valid path aliases or package imports for init.
   Configure path aliases in tsconfig.json or imports in package.json, then run init again.
   ```
2. Init then **overwrote our tokens.** Light `--muted: #565d6d` became `oklch(0.97 0 0)` and `--accent: #2f5cf0` became `oklch(0.97 0 0)`, while the dark-theme values were left alone. These are the only two name collisions (`--muted` appears on 28 lines of globals.css; `--accent` and its `-ink`/`-soft`/`-line` variants on 49). Fix: **don't keep init's globals.css edits.** Use the bridge file below.
3. Init injected `import { Geist } from "next/font/google"` into layout.tsx, and the Next 14 build failed: ``` `next/font` error: Unknown font `Geist` ```. Fix: drop it. We use the system stack anyway.
4. With init's CSS in place, the Trace trigger rendered `rgb(20,22,28)` (our ink) instead of `text-muted-foreground`. Cause: our **unlayered** `button { color: inherit }` beats Tailwind's **layered** utilities. Fix: put our CSS in a `legacy` cascade layer below `utilities`.
5. Tailwind **preflight** changed our UI (13–1,581 px diffs: checkbox UA margin, list markers). Fix: import `tailwindcss/theme.css` + `tailwindcss/utilities.css` only, and add the one preflight rule shadcn parts need, scoped to `[data-slot]` (border colour).
6. `@keyframes pulse` and `spin` collide with Tailwind's. The build keeps one `pulse`, and it was Tailwind's (`50%{opacity:.5}` replaced our `0.45`). Fix: rename ours `pr-pulse` and `pr-spin` (3 animation references + 2 keyframes).
7. Running our CSS through `@tailwindcss/postcss` (Lightning CSS) rewrote it in two lossy ways. (a) Source order `backdrop-filter` then `-webkit-backdrop-filter` was collapsed to **only** `-webkit-backdrop-filter`, so Chrome lost the topbar blur and the reduced-transparency override. (b) `rgba(255,255,255,.09)` was re-encoded as `#ffffff17` (alpha 23/255 = 0.0902), a 1/255 shift on rail borders. Fix: **keep `legacy.css` out of the Tailwind file** and import it separately from `layout.tsx`. Next's own pipeline then handles it exactly as today. Verified byte-for-byte: `.topbar` keeps both declarations and `--rail-edge` stays `hsla(0,0%,100%,.09)`.
8. Trying `optimize: false` to avoid (7) is **unsafe**. Tailwind then emits nested `@supports` inside rules, and Next 14's minifier, which doesn't understand nesting, merged `.text-muted-foreground` with `.text-muted-foreground\/70`, so all muted text rendered at 70% alpha. Keep the default `optimize`.
9. **React 18 drops refs on shadcn components.** shadcn v4 components are plain functions that take `ref` as a prop, which is a React 19 behaviour. Measured in the browser: `<Button ref>` → `null`, and the shadcn wrapper `<CollapsibleTrigger ref>` → `null`, with no warning in a production build. Today the app's only DOM ref is a native `<h1>` (page.tsx:480), so nothing breaks. **Rule for Phase 2:** never pass `ref` to a shadcn component. If one is needed (e.g. to focus the Confirmation question), put it on a native element inside, or wrap that one component in `React.forwardRef` and say so in the PR.
10. Vitest uses classic JSX (that's why Candidates.tsx and Memory.tsx carry `@jsxRuntime automatic` pragmas). Vendored shadcn files threw `ReferenceError: React is not defined`. Fix: `esbuild: { jsx: "automatic" }` in vitest.config.ts, plus the `@` alias.

### The bridge (final, verified files)

`postcss.config.mjs`
```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```
`app/layout.tsx`: first two lines
```ts
import "./globals.css";   // Tailwind + shadcn + bridge (below)
import "./legacy.css";    // today's globals.css verbatim inside `@layer legacy { … }`, keyframes renamed
```
`app/legacy.css` = `@layer legacy {` + current `app/globals.css` (2,234 lines, unchanged except `pulse→pr-pulse`, `spin→pr-spin`) + `}`.

`app/globals.css`
```css
/* Layer order: Tailwind theme, then a base with one scoped rule, then our legacy stylesheet,
   then utilities, so shadcn utility classes win over legacy element rules. */
@layer theme, base, legacy, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);   /* no preflight, on purpose */
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) { @slot; }
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme="light"]), :root:not([data-theme="light"]) *) { @slot; }
  }
}

/* shadcn names as aliases of OUR tokens; --muted and --accent are NOT redefined (they mean muted ink and brand blue here). */
:root {
  --background: var(--bg); --foreground: var(--ink);
  --card: var(--bg); --card-foreground: var(--ink);
  --popover: var(--bg); --popover-foreground: var(--ink);
  --primary: var(--accent); --primary-foreground: var(--accent-ink);
  --secondary: var(--panel); --secondary-foreground: var(--ink);
  --muted-foreground: var(--muted); --accent-foreground: var(--ink);
  --destructive: var(--red); --border: var(--line); --input: var(--line);
  --ring: var(--accent); --radius: var(--r);
}

@theme inline {
  --font-sans: var(--sans); --font-mono: var(--mono);
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--panel);            /* collision, mapped by role */
  --color-muted-foreground: var(--muted);
  --color-accent: var(--panel-hover);     /* collision, mapped by role */
  --color-accent-foreground: var(--ink);
  --color-destructive: var(--red);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --radius-sm: var(--r-sm); --radius-md: var(--r); --radius-lg: var(--r); --radius-xl: var(--r-lg);
}

@layer base {
  [data-slot], [data-slot] *, [data-slot]::before, [data-slot]::after { border-color: var(--color-border); }
}
```
`tsconfig.json`: add `"baseUrl": "."`, `"paths": { "@/*": ["./*"] }`, and add `components/**/*.tsx`, `lib/**/*.ts`, `lib/**/*.tsx`, `hooks/**/*.ts` to `include`.
`vitest.config.ts`: add `esbuild: { jsx: "automatic" }` and `resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } }`.
`components.json`: from init (`style: base-nova`, `iconLibrary: lucide`, `tailwind.css: app/globals.css`, `cssVariables: true`). After any future `shadcn add`, re-check that it didn't append `:root` variables to globals.css (error 2).
`package.json`: `@base-ui/react`, `class-variance-authority`, `cn` (shadcn's own clsx + tailwind-merge replacement, github.com/shadcn-ui/cn), `lucide-react` and `shiki` in `dependencies`. `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `tw-animate-css` and `shadcn` (needed only for its `tailwind.css` at build time; as a runtime dependency it pulled 462 packages) in `devDependencies`. **Not verified:** that Railway's Nixpacks build installs devDependencies before `next build`. Check on the step (i) deploy.

### Verification evidence

| Check | Result |
|---|---|
| Probe build, Next 14.2.35 + React 18.3.1 + Tailwind 4.3.3 + Base UI 1.9.0 | `next build` ✓. `/` with Trace + CodeBlock is 21.5 kB |
| SSR with `renderToStaticMarkup` (what our tests use) | ✓ in the probe and in the app copy (`app/ui/trace-ssr.test.tsx`, scratch only) |
| Full project suite in the bridged copy, keys unset | **573 / 573 pass** (572 existing + 1 Trace SSR). `tsc --noEmit` clean |
| Screenshot noise floor: baseline vs baseline, same build | 0 px differ on all 14 screens (bit-exact) |
| Bridged vs baseline, demo walkthrough (describe → profile → target → approve → approval → live → results) at 1280 / 768 / 390, `reducedMotion: reduce` | 16 of 21 screens **bit-identical**. The other 5 differ only at animated elements: 3 at the infinitely pulsing demo-badge dot (16 px each, max 4/255) and 2 mid-run frames (taken 2.5 s after Approve). Both kinds also vary within one build. With animations frozen, approve at 1280 and run-approval at 768 and 1280 are bit-identical, dot included. Approve at 768 additionally shows a hover race (the pointer is left on "Run agent", `rgb(50,98,254)` = accent × `brightness(1.06)`) that flips between repeats of **both** builds, plus a 17 px first-load difference that also appears between two captures of the same build. The second non-hovered pair is bit-identical |
| Trace picks up our tokens | light: trigger `rgb(86,93,109)` = `--muted`, Code Block border `rgb(229,231,238)` = `--line`, radius 10px = `--r`, our mono stack. Dark (via `prefers-color-scheme`): `rgb(153,160,178)` and `rgb(35,38,47)`. Running title `animationName: tw-shimmer`, and `none` under reduced motion |

Artifacts: `.agents/scratch/shots/{baseline,baseline2,bridgeA…bridgeH}`, `diff-*` folders, `.agents/scratch/app-bridge/` (the bridged copy, with `app/probe/page.tsx`), `.agents/scratch/shadcn-probe/` (the CLI probe, with `app/refcheck/page.tsx` for error 9). All under `.agents/`, which is git-ignored. About 1.6 GB including node_modules; delete it when Phase 2 lands.

**If you later want Next 15 / React 19** (not needed here): this removes error 9 and costs the async request API change in the 7 dynamic route files that type `{ params }` synchronously (e.g. app/api/workspaces/[id]/memory/route.ts:27; codemod `npx @next/codemod@latest next-async-request-api`), plus a re-run of everything above. `renderToStaticMarkup` still exists in React 19's `react-dom/server`. Do it as its own PR, never mixed with UI changes.

## 5. Migration order (Phase 2)

Every step: run the CI no-keys check before push (`env -u ANTHROPIC_API_KEY -u EXA_API_KEY npm test` with `.env` hidden), `npm run typecheck`, `npm run build`, then the browser check in `DEMO_MODE=1`. Tests that must keep passing in every step: `app/ui/candidates.test.tsx` (the strings "Unverified candidates", "Not counted as leads", "Not counted: …", `href`, `javascript:` refusal, empty → `""`), `eval/ui-copy.test.ts` (no internal codes, rejection grouping, CSV, HTTP copy; it reads the demo fixture), `eval/memory.test.ts` (imports `MemoryPanel`), and `eval/record-replay.test.ts` + `eval/api-controls.test.ts` (demo replay and routes). Model routing follows the standing rule: the orchestrator writes no shipped code.

### (i) Tooling and token bridge, no visual change. **Routing: gpt-5.5 (codex) implements the exact recipe in §4; fable-5 or opus-4.8 reviews.**
- Files: `package.json`, `package-lock.json`, `postcss.config.mjs` (new), `components.json` (new), `tsconfig.json`, `vitest.config.ts`, `app/layout.tsx` (2 lines), `app/globals.css` (replaced by the bridge), `app/legacy.css` (new: the old globals verbatim in `@layer legacy`, 5 renamed tokens), `components/ui/{trace,code-block,collapsible,button}.tsx`, `lib/{utils,highlighter}.ts(x)`, `hooks/use-highlighted-code.ts` (CLI output, unedited), `app/ui/trace-ssr.test.tsx` (a small fixture, not a demo page). No `app/probe` route ships.
- Acceptance: re-run the scratch walkthrough (`.agents/scratch` scripts: `walk.mjs` 3 widths, `diff.mjs`/`delta.mjs`) against `main` vs the branch. Bit-identical on every non-timing frame, same as §4. `.topbar` in the built CSS has both `backdrop-filter` declarations. 573 tests pass.
- Demo-safe: no rendering change.

### (ii) Run view on Trace, Code Block, Confirmation, Task, Queue, Checkpoint. **Routing: opus-4.8 (taste ≥ 7, user-facing); gpt-5.5 for the pure formatter and its tests (`traceModel(events, snapshot)` in a new `app/ui/trace-model.ts`, plus the new copy.ts strings); fable-5 reviews.**
- Files: `app/ui/RunView.tsx` (split into `RunTrace.tsx`, `RunConfirmation.tsx`, `RunSide.tsx`, keeping `Leads`/`LeadRow`/`Outcome` in place), `app/ui/Candidates.tsx` (Trace sections, same strings), `app/ui/copy.ts` (additions only, §1b), `app/ui/trace-model.ts` + `eval/trace-model.test.ts` (new: event→line mapping, cache share, staleness, run against the current fixture **and** `memory-eval-2026-10-15b/.../3/events.jsonl` so the new kinds are covered), `components/ui/{item,marker,badge}.tsx` (CLI), `app/legacy.css` (delete feed, status and approval rules as they're replaced; nothing else).
- Motion: M1, M3–M7, M9 (§3). Remove the `.live-dot` and `.status-dot` pulses.
- Acceptance in the browser (demo): the Confirmation appears, takes focus, and Approve, Edit and Decline work by keyboard alone. After Approve, "You approved." is a Trace line. Only one shimmer is ever on screen. Completed turns auto-collapse. Each lead's Evidence opens a Code Block (with the current fixture it shows only the size quote and "No quote captured" for the rest; correct for that data). The spend figures still add up. At 390 there is no horizontal scroll and the evidence wraps. Reduced motion: nothing moves except instant state changes. Screen reader: one polite announcement per new turn.
- Demo-safe: the fixture is unchanged. Lines for the new event kinds simply don't occur in it.
- Optional, gated on decision Q1: swap the demo fixture, update docs/DEMO.md's script and README's fixture claim in the same PR, re-run `eval/ui-copy.test.ts`.

### (iii) Describe, Target, Approve on Prompt Input, Message, Suggestion and the contract surface. **Routing: opus-4.8; fable-5 reviews.**
- Files: `app/page.tsx` (`StartStep`, `ContractStep`; the shell untouched), `app/ui/CardsStep.tsx` (one surface, label column, `Badge`, `Collapsible`), `components/ui/{input-group,textarea,input,message,bubble,separator}.tsx` (CLI), `app/legacy.css` (remove `.cards`, `.card`, `.search-field`, `.panel` usage for these steps).
- Acceptance: Enter submits and Shift+Enter adds a newline. Instagram candidates are one-click. Every Target field keeps its label and `htmlFor` (today's `useId` pattern). `cardProblems` still blocks "Build the plan" with the same sentences. The contract shows the same terms. No card grid at any width. The 390 layout has no horizontal scroll. M2 and M12 are in.
- Demo-safe: the demo planner fixtures (`eval/demo/planner/`) drive the same flow.

### (iv) Memory panel, About, polish pass, GIF walkthrough. **Routing: opus-4.8 implements; sonnet-5 for the GIF capture script; fable-5 runs `$impeccable critique` and `audit` as the gate.**
- Files: `app/ui/Memory.tsx` (Collapsible + Item on the rail), `app/page.tsx` (`AboutDialog` → shadcn `Dialog`, Base UI), `components/ui/dialog.tsx` (CLI), `app/legacy.css`/`globals.css` (token pass: faint-ink `#636b7b`, amber text `#965a00`, z-index scale, 4 px spacing, size-specific tracking and leading per DESIGN.md §3, remove border+shadow pairs and side stripes per §6), `docs/screenshots/` (replace the stale v1 `demo-light.png` / `demo-dark.png`), `docs/DEMO.md` (only if Q1 swapped the fixture), plus a GIF of the demo walkthrough.
- Motion: M8, M10, M11.
- Acceptance: About traps focus, Escape closes it, and focus returns to "About this build". Text on every background is ≥ 4.5:1 (check placeholders, column headers, "Estimated" badge, demo badge). §6's list is empty when re-grepped. `$impeccable critique` reports no P0/P1. The GIF covers describe → results in under 60 s.

## 6. Absolute bans and the AI slop test, applied to the current UI

**Side-stripe borders** (coloured inset or border wider than 1px on one side):
- `app/globals.css:664–667` `.step-link.is-active { box-shadow: inset 2px 0 0 var(--accent) }`: the active rail step.
- `app/globals.css:1440–1445` `.approval { … box-shadow: var(--shadow), inset 3px 0 0 var(--amber) }`
- `app/globals.css:1705–1710` `.outcome { … inset 3px 0 0 var(--accent) }` and `:1713–1714` `.outcome.is-short { … inset 3px 0 0 var(--amber) }`
- Not a violation: `:2127` `inset 0 -2px 0` is a bottom tab indicator at ≤900 px, a standard tab affordance.

**Ghost-card: a 1px border plus a soft wide shadow on the same element** (`--shadow` has a 24px blur, globals.css:55):
`.search-field` :321 (shadow :328) · `.results` :387 (:391) · `.state` :424 (:434) · `.dialog` :527 (`--shadow-lg` 60px blur, :535) · `.panel` :891 (:895) · `.card` :1204 (:1210) · `.approval` :1440 (:1445) · `.outcome` :1705 (:1710, :1714) · `.rej-groups` :1979 (:1986) · `.cand-rows` :2031 (:2038). That is 10 surfaces, so nothing ranks above anything.

**Over-rounding:** none at 32px or more. The only card over the 12–16px cap is `.dialog { border-radius: 18px }` (globals.css:534).

**Eyebrows:** no tracked uppercase kickers. One kicker: `.eyebrow` "Needs your OK" (globals.css:1466; RunView.tsx:283), amber 12px. It isn't AI grammar, but it repeats the status bar's "Waiting for your OK" directly above it, and amber 12px text measures 4.24:1, which fails AA. Drop it; the Confirmation question carries it.

**Identical card grids:**
- Target: 7 same-chrome cards in a 2-column grid (CardsStep.tsx:71–164; globals.css:1198, :1204). The equal heights leave dead space (the 1280 Target screen shows the "Who" card padded to match "Why now").
- Run: checklist, spend and feed as three same-chrome panels (RunView.tsx:117–159; globals.css:1486, :891).

**Nested cards** (always wrong): the bordered amber `.demo-note` box (globals.css:869) inside the bordered `.approval` card (RunView.tsx:309), and bordered `.suggestion` boxes (globals.css:1745) inside the bordered `.outcome` card (RunView.tsx:544–571).

**Glassmorphism:** the topbar material (globals.css:224, blur 20px) is purposeful, since content scrolls under a sticky bar. Keep it. The scrim's `blur(3px)` (:523) is decorative. Drop it and keep the 50% dim.

**Gradient text:** none today. shadcn's `shimmer` is `background-clip: text` with a gradient. It is allowed only as M1, on exactly one running line, and it disappears under reduced motion. Any other use is the ban.

**Hero-metric template:** the Spend panel ("$0.84" at 22px, "of $1.00 limit", then a "Leads 6 of 10 · Turned down 0" stat row) is the shape without the gradient. It earns the big figure because spend is a contract term. The stat row doesn't earn its place: "Turned down 0" contradicts "Considered but not added 53" on the same screen. Fix the count or drop the row (§1a).

**Contrast failures** (impeccable's first colour rule): `--faint` #878e9e used as text measures 3.28:1 on white and 2.88:1 on Panel. It is used for the placeholder (globals.css:356), `.hint` (:866), `.chips-empty` (:1308), `.lrow-head` on `--panel` (:1840), `.basis` (:1879), `.cell-label` (:1886) and `.no-source` (:1921). Amber text measures 4.24:1 on white and 3.75:1 on amber-soft: `.live.is-demo` (:836), `.note` (:882), `.kind-est` (:1193), `.problems` (:1324), `.eyebrow` (:1470). Fixes are in DESIGN.md §2 and step (iv).

**Product slop test** ("would a user fluent in Linear or Stripe trust it?"). Mostly yes: system font, restrained palette, plain copy, real states. The tells that read as generated are card soup (every block the same white box with border and shadow), one `rise` entrance reused on four unrelated things, two pulses that never stop, coloured side stripes marking importance, and a kicker that repeats the line above it. **Category reflex check.** First order: "AI lead-gen tool" predicts dark mode with neon or a purple gradient. This isn't that. Second order: "AI agent tool that isn't neon" predicts a chat thread with a sidebar of tool calls. The rework avoids it by staying a contract → ledger product (no chat, the trace as provenance under the outcome), with mono reserved for verbatim evidence.

## 7. Gate results (step iv gate, 2026-10-16)

`$impeccable critique` (dual-agent: A design review and B detector + browser, isolated) and `$impeccable audit` ran against a `DEMO_MODE=1` production build, at 1280, 768 and 390, in light and dark, with reduced motion at 1280 light and 390 dark. The snapshot is `.impeccable/critique/2026-10-15T16-00-32Z__app-page-tsx.md`. This is the first run for this target, so there is no trend yet.

**Scores before the fix pass.**
- **Critique:** 29/40 overall (Good). Describe 32, Target 30, Approve 31, Run/Results 28. P0: 0.
- **Audit:** 16/20 (Good). Accessibility 3, Performance 3, Responsive 3, Theming 3, Anti-patterns 4.
- **AI slop test:** passes in both. The §6 bans re-grep clean.
- **Detector:** 0 findings on markup. On CSS, 6 advisory design-system drift hits:
  - shadow rgba at `globals.css:411` and `:1410`;
  - radii of 2, 4 and 16px at `legacy.css:146` and `:864`, and `globals.css:999` and `:1407`.

**Fixed (P1, plus two P2s tied to the memory requirement and the GIF):**

| Issue | Before | After | Where |
|---|---|---|---|
| Replayed demo run never promoted the agent's saved note | "What the agent learned" absent after the replay | The note shows, stamped with this replay's run id and clock like its leads (60-day TTL from now, not the recording's 14 Dec expiry) | `src/demo/replay.ts`; test in `eval/memory.test.ts` (fails without the fix, passes with it) |
| P1: stop sentence contradicted the meter | "Stopped at your spending limit." beside $0.85 of $1.00 | "Stopped before the next step could go over your spending limit. $0.85 of $1.00 spent." | `app/ui/copy.ts` `stopSentence` / `RUN.budgetSpent`, `app/ui/RunView.tsx` Outcome |
| P1: focus ring on filled buttons (Approve, Run agent, Continue) | A 1px accent outline flush on the accent fill, about 1.1:1 | `outline-offset: 2px`, so the edge sits on the background | `app/globals.css` (`:is(.primary-btn, .pr-prompt-go):focus-visible`) |
| P1: accent text on the accent-soft tint over canvas ("Hard filter", the selected Suggestion) | 4.39:1 | 5.21:1 light and 5.69:1 dark, via a new `--accent-ink-text` (#2a52d8 light, `--accent` dark) | `app/globals.css` |
| P2: learned note clipped mid-sentence in a 180 px scroller | "…UK fulfilment news mostly yielded" | Whole note shown (notes list 360 px; scrollHeight equals clientHeight) | `app/ui/Memory.tsx`, `app/globals.css` |
| P2: checklist empty state after approval | "The agent writes its checklist once you approve…" while the trace shows "You approved." | "No checklist yet." after a decision | `app/ui/copy.ts`, `app/ui/RunSide.tsx`, `app/ui/RunView.tsx` |

**Motion checklist** (§3 M1–M12 against apple-design §1–3, §7, §12, §14 and find-animation "The Gate"): **pass**, measured live.
- At most one shimmer on screen at any moment, the run header. Under reduced motion there is none.
- Press feedback is `scale(0.97)` on pointer-down, on primary, ghost, Suggestion and Approve. The current step is disabled by design.
- No layout-property animation: the evidence toggle moves its neighbours in one frame, not over 250 ms. The spend meter moves by `scaleX`.
- The only blur is the topbar. The dialog scrim has none.
- Under reduced motion only the opacity fades for M3, M8 and M10 remain, at 150 ms. Everything else is clamped. The theme crossfade is skipped.

**Remaining P2s, for later:**
- "Before it spends anything" is contradicted by the $0.01 shown at the Confirmation: `ContractStep.tsx:155`, `AboutDialog.tsx:24`.
- Two cost estimates are never reconciled ($0.84 on the plan, $0.95 from the agent): `ContractStep.tsx:146`, `RunConfirmation.tsx:98`.
- Results has no primary action, and the cost sits below the leads: `RunView.tsx:292–313`, `:181–195`.
- Provenance turns read only "Step N": `RunTrace.tsx:226`, `trace-model.ts`.
- Focus drops to `<body>` at run end (`RunView.tsx:140`, `:197`) and after Describe submits (`StartStep.tsx:64`). The outcome's `role=status` is inserted with its text already in it.
- Layout shift at run end is 0.40 at 1280 and 0.71 at 390. The Confirmation insert adds 0.17–0.46.
- A step change keeps the old scroll offset, so Approve opens at the bottom at 390: `page.tsx:155`.
- The seen-companies memory list still clips in its 180 px scroller with no scroll cue.
- Touch targets are under 44 px at 390 (thumbs 32, `.chip-x` 20, trace triggers 18). All pass WCAG 2.5.8 through spacing.
- P3:
  - skipped heading levels (Target h1 → h3, rail h3/h4);
  - evidence "Must be true" truncated at 57 characters (`trace-model.ts:123`);
  - the theme choice isn't saved;
  - About pulls a 41 KB-gz Base UI chunk into First Load;
  - mono on event dates and hosts.

**GIF** (`docs/screenshots/walkthrough.gif`, 6.7 MB, 40.8 s, regenerated). Plan → approval → ledger with verdicts and evidence → handback → memory is legible in about 40 s. `scripts/demo-gif.mjs` now scrolls the notes list into view (`block: "nearest"`) before the final pause, so the last frame shows the whole "What the agent learned" note with its provenance.

**`.impeccable/`** is tracked, not gitignored. The skill treats `.impeccable/config.json`, `design.json` and the critique snapshots as shared project state; only `config.local.json` is meant to be gitignored. The one snapshot has no secrets and no absolute paths.
