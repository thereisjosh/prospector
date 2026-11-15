# SPEC: visible agency (verify-then-submit, shown judgment, measured)

Status: 2026-11-15. Built on branch `visible-agency` (A1–A6, B1–B3, uncommitted); B4 is covered by new tests; B5 and D are not started. Measured result in FAILURES #33: S2 passes the ship rule; S1 rep 2 fell short (3 leads, candidate pool, not the gate) and S1 rep 3 passed (5 leads, 5 of 5 hand-checked), so the gate ships as default. Goal: Prospector should demonstrate agent-building skill, not just produce a CSV. That means the agent's own judgment has to (1) do real work, (2) be checked by code, (3) be visible in the run, and (4) be measured against the current agent.

## 0. What the code does today (read before planning; corrects earlier chat claims)

- **The model never supplies the quote.** `submit_lead` takes `company`, `signal_url`, `why_now` (`src/agent/tools.ts:822`). The quote is `signal.summary.signal_quote`, written by Exa's structured summary at search time (`src/plan.ts:339`, `:384`). `checkLead` (`src/gates.ts:715`) checks it verbatim against `signal.title + signal.text`, the page text captured at search time (`:734`, `:754`).
- **`read_page` already upgrades the evidence.** It replaces the cached signal text with the full page text (`tools.ts:816`), so a later `submit_lead` is gated against the full page. It also counts `state.adaptive.verificationReads` (`tools.ts:815`), which the loop treats as progress (`loop.ts:294`).
- **The agent almost never reads.** `verificationReads` = 0 in 8 of 9 recorded runs (README §2 flaw 1). The prompt says "Verify when in doubt" (`src/agent/prompts.ts:31`), and the model treats it as optional.
- **The live trace already exists.** `app/ui/RunTrace.tsx` renders turn → tool call → verdict → evidence (UI-REWORK §1b). The earlier claim that "today you only see the CSV" was wrong.
- **The model's per-turn text is recorded** on each `model_call` event, clipped to 2,000 chars (`loop.ts:72-76`). Thinking is never recorded. Whether `RunTrace` shows that text is **unverified** (task B0).
- **The evidence seam (board risk 1).** `checkLead` proves the quote is on the page. Nothing in code proves the page answers the decisive question for this contract (3PL serving others vs own warehouses, event inside the window, same company). Today the online judge (Jev Q1–Q3) checks that, after the fact.

## 1. The design in one paragraph

The agent states, for each lead, the one decisive question it checked and the sentence that answers it. It must take that sentence from a page it read in this run. Code checks that the sentence is verbatim in that read page; the model cannot skip the check or supply its own text. The trace shows the question, the sentence and the verdict per lead, plus the model's one-line reason for each turn. An eval arm compares this agent with today's on the pilot scenarios, and the result goes in the README whether it wins or loses.

Why not a blanket "must call `read_page` first" rule: `checkLead` already checks the quote against captured text, so a forced read alone mostly re-confirms what the gate checked, at extra Exa cost. The read only demonstrates judgment if the agent has to use what it read. Hence the `decisive_check` field below.

## 2. Tracks and tasks

Routing follows the standing rule: the session model orchestrates and owns gate and eval judgment; gpt-5.6-terra (via `codex exec`) does clear-spec code; opus does prompt and tool wording and anything user-facing; no Haiku.

### Track A: verify-then-submit (the agent does the checking)

| # | Task | Files | Route |
|---|---|---|---|
| A1 | Track pages read this run: `state.caches.readUrls: string[]` set in the `read_page` branch. Persisted in state.json, so it survives turns and resumes. | `src/agent/state.ts`, `tools.ts:809` | terra |
| A2 | Add `decisive_check: { question: string; answer_quote: string; page_url: string }` to the `submit_lead` schema (strict). | `tools.ts:85` | opus writes the description text; terra wires the schema |
| A3 | New gate `checkDecisiveCheck` in `src/gates.ts`, run in the `submit_lead` handler **before** `checkLead`. Order: `page_url` ∈ `readUrls` else `check_page_not_read`; `answer_quote` verbatim in that page's read text (`quoteInText`, same normaliser) else `check_quote_not_in_page`; `question` non-empty and ≤ 160 chars else `check_missing`. A failure rejects with the named code, like every other gate. `page_url` may differ from `signal_url` (company site, a second source). | `src/gates.ts`, `tools.ts:822` | terra; I review the gate order and codes |
| A4 | Store the check on the accepted lead (`lead.decisive_check`) and pass it to the online judge input so Jev scores "does the quote answer the question" as a new Q4. **Not in the CSV** (decided 2026-11-15): trace and evidence block only. | `tools.ts:843`, `src/agent/judge-input.ts` | terra; Q4 wording by me |
| A5 | Prompt: replace "Verify when in doubt" with the rule and one example per contract type (3PL, funded B2B). Tool result for a rejection says which code and what to do next. | `src/agent/prompts.ts`, `docs/prompts.md` | opus |
| A6 | Unit tests: each new code; quote in signal text but page not read → `check_page_not_read`; read of a second URL accepted; resume keeps `readUrls`. | `src/*.test.ts` | terra |

### Track B: show the judgment

| # | Task | Files | Route |
|---|---|---|---|
| B0 | Verify: does `RunTrace` render the `model_call` text today? Read `app/ui/trace-model.ts` and a recorded `events.jsonl`. Report, change nothing. | — | me |
| B1 | Prompt asks for one plain sentence before each turn's tool calls: "Next: X, because Y." Capped at 200 chars. Recorded already via `model_call`. | `prompts.ts` | opus |
| B2 | Turn header in `RunTrace` shows that sentence under "Step N" (if B0 shows it is not shown). | `app/ui/trace-model.ts`, `RunTrace.tsx`, `copy.ts` | opus (UI copy, taste ≥ 7) |
| B3 | Accepted-lead evidence block shows `decisive_check`: question, quote, link to the read page, verdict "Checked by code: quote found on the page it read." | `RunTrace.tsx` evidence block, Leads row | opus |
| B4 | Update SSR tests (`trace-ssr.test.tsx`, `run-view.test.tsx`) for the new lines. | `app/ui/*.test.tsx` | terra |
| B5 | Re-record the replay demo after A and B land. The existing `icp1-2026-10-11b` replay already misses on request hashes (README §8), and the schema change breaks every recording's hashes. | `eval/recordings/`, `src/demo/replay.ts` | terra runs; I check the replay end to end |

### Track C: prove it, cheaply (budget ≤ $3, decided 2026-11-15)

The claim is a capability claim, not a precision claim: "the agent now does the checking, and code holds it to it." That needs behaviour evidence, not pass^3. Precision stays as README §1 reports it; this spec does not re-measure it.

| # | Task | Route |
|---|---|---|
| C0 | $0: unit tests from A6 prove the gate (each rejection code fires, the model cannot bypass it). | terra |
| C1 | 2 live runs of the new agent: S1 and S2, 1 rep each, Sonnet 5.5, same contract and $1 cap as the 2026-10-17 Sonnet runs. ≤ $2. Baseline is those already-judged 10-17 runs (S1 7, 8, 5 good; S2 9, 9, 9), after diffing HEAD against `2035277` to confirm the agent code matches apart from the model default. | terra runs; I diff and check |
| C2 | Judge the new leads with Jev (Q1–Q4), not Opus: about $0.002 per 10 items (README §6). Hand-check all `decisive_check`s myself: does the quote answer the question, and is the question the deciding one? $0. | me |
| C3 | Report, before vs after: `verificationReads` per run (baseline 0 in 8 of 9 runs), share of accepted leads with a code-checked check (target 100% by construction), hand-check pass rate, good leads per run vs the 10-17 range, cost per run, turns, rejections by new code. One rep is not a precision result and is not reported as one. | me |
| C4 | Ship rule: ship if both runs stay under the $1 cap, good leads fall inside the 10-17 range (S1 ≥ 5, S2 ≥ 9), and ≥ 8 of 10 hand-checked checks answer their question. A miss goes in FAILURES.md either way. | me, decision with Joshua |
| C5 | Optional, independent, not in this budget: the contact eval (README §9): label `eval/datasets/contact-cases.jsonl` (≥ 30 contacts), run `eval/harness/judge-contacts.ts`. Gives the precision number for "verified" contacts. | terra builds the set from recordings; I check labels |

### Track D: tell it

| # | Task | Route |
|---|---|---|
| D1 | README top section: "How the agent works": tool menu vs code checks, one turn, with the C1 table. Replace the scratch diagram with a corrected one (`submit_lead` does not carry the quote). | opus |
| D2 | LinkedIn post draft from the C1 result, not before it. | opus, I fact-check every number |

## 3. Order and dependencies

A1 → A2 → A3 → A4/A5/A6 (parallel) → C0 → B0 → B1–B4 → C1 → C2 → C3 → C4 → B5, D1, D2. C5 is separate. Nothing in D is written before C3 has numbers.

## 4. Costs and limits (estimates, to be replaced by run.json numbers)

- Each `read_page` is one Exa contents call. Recent 10-lead runs cost $0.73 (deposco) and $0.83 (public smoke) against the $1 cap. If the agent reads 10–15 pages per run, the cap may bind. C1 measures it; if it binds, the options are a per-read cost line in the cost guide or a $1.25 cap for the eval, decided after C1, not before.
- C1–C2: 2 runs at ≤ $1 each, Jev judging at cents, hand checks at $0. Budget ≤ $3. Rejected: a 12-run Opus-judged comparison (~$50) or 6 runs reusing the baseline (~$25); both buy a precision claim this spec doesn't need.
- If a run hits the cap before 10 leads, that is the finding; do not raise the cap to rescue it.
- More turns per lead: watch `max_turns` and `no_progress` stops (`loop.ts:298-304`). A read counts as progress already.

## 5. Risks

- **The agent games the field:** it copies `signal_quote` as `answer_quote` with a generic question. Code can't stop that; Q4 and the 10-lead hand check (C2) catch it, and the prompt example has to show a question the signal quote does not answer.
- **Precision drops** because more leads fail the new gate and the agent runs out of budget before 10. That is a real result; C3 decides.
- **Replay demo breaks** until B5. The deployed demo should not be redeployed between A2 and B5.

## 6. Decided 2026-11-15

1. `decisive_check` is required on every lead.
2. Eval budget ≤ $3 (Track C as above).
3. No new CSV columns; the check lives in the trace and evidence block.
4. Sonnet 5.5, the shipped default, with the 2026-10-17 Sonnet runs as baseline.
