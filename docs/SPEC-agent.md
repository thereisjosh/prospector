# Prospector Agent — spec

## GOAL (set 2026-10-12)

Build the full Prospector agent end-to-end, with verified testing, so that a hiring manager at Manus can **assess the repo and use the product**. Concretely, "done" means all of:

1. **Usable:** a deployed URL where someone can paste a website, approve cards, watch the agent run, approve a scope change, and get leads with evidence. Plus a `demo` mode on recorded data that works with no API keys, so a reviewer can run it locally in under 5 minutes.
2. **Verified:** unit tests on every gate and the loop (mocked model + Exa), a replayable regression suite, and a live eval with pass^k results committed to the repo. No claim in the README without a command or file that backs it.
3. **Assessable:** a README that reads as a case study (problem → decisions → evals → failures found → limits), an architecture diagram, the autonomy table, a 3-minute demo script, and trace logs from real runs checked in.
4. **Honest:** what is not production-ready is listed, not hidden.

Orchestration and code review: Fable (this session). Implementation: subagents (Sonnet 5.5, Opus 4.8, gpt-5.5 via Codex) per §11. Paid eval stages (§9) each need the user's go.

Status: APPROVED 2026-10-12 · supersedes the "evaluator-optimizer later" idea in SPEC-v2
Audience: Manus — **Agent Product Manager** (Singapore / Beijing), careers.manus.im/en/job/3b841ff5-ef2e-4ea7-92f0-d0fc3ef0cad6 (read 2026-10-12)
Baseline: the v2 workflow engine (`v2-engine` branch) stays as the control arm.

## 1. Why this build, mapped to the role

The JD explicitly prefers *"representative AI agent projects that can be demonstrated."* Every responsibility and requirement maps to an artifact:

| JD line (paraphrased) | What this build shows |
|---|---|
| Study user needs; set plans, priorities and **testable success criteria** | SPEC-v2 / this spec; a rubric and pass^k thresholds written *before* any run (§9) |
| Prototype key flows independently: **task inputs, execution and result delivery** | Inputs: one field → cards. Execution: live agent view. Delivery: leads with evidence, rejections with reasons, CSV (§2) |
| Refine with domain experts via practical scenarios | Scenarios grounded in real seller sites; v1's hand-tuned ICPs used as expert baselines |
| Coordinate delivery: scope, acceptance criteria, trade-offs | Task table with a gate per task (§11); cost and quality trade-offs measured, not asserted |
| **Review task outcomes after launch, find shortfalls, prioritise the next round** | Per-lead 👍/👎 feedback and the rejection log feed the next eval round (§2, §9); the funnel analysis that found the year-date and cost-tier bugs |
| Understand agent mechanisms, **capabilities and limitations** | Workflow vs agent head-to-head; the documented limits of Exa extraction (wrong-year dates, unreliable sizes) and how code gates bound them |
| Hands-on: test ideas through prototypes or technical experiments | The build itself: a harness written without a framework, a recorded and replayable eval, staged live experiments |

The pitch in one line: **"I built the workflow and the agent, and measured when the agent earns its cost."**

The pitch in one line: **"I built the workflow and the agent, and measured when the agent earns its cost."**

## 2. User flow

```
[1] One input: website URL | @instagram | one sentence
[2] Seller profile (Exa)            ── shown: "Is this you?" + what we think you sell
[3] Claude suggests cards           ── who / why-now / size / stage / geo / recency / exclusions,
                                       each with a one-line "why"
[4] USER APPROVES THE PLAN          ── edits cards, sees target lead count + max spend; presses Run
[5] Agent runs (live view)          ── todo list, each step in plain words, leads appearing,
                                       spend meter; user can Stop
[6] Results                         ── leads + evidence + source; "considered but rejected"
                                       with reasons; CSV
[7] Feedback                        ── 👍/👎 + optional reason per lead → stored with the run;
                                       👎 cases become eval cases (post-launch iteration loop)
```

The human approves the **contract** (step 4), the agent's **opening strategy**, and any **scope change** mid-run (§5a), not each action. The agent can only read and propose; nothing leaves the system.

**Plan = contract, not script.** In the workflow arm the plan is a script: fixed queries, run in order. In the agent arm the cards compile to a contract:
- the goal (N leads)
- what counts as a lead (gates, size, HQ, recency window, exclusions)
- the budget

The agent writes its own queries and decides what to look up, what to verify, when to change tactic and when to stop. `signalQueries` become optional seed ideas.

## 2a. The loop

```ts
// Logical loop. Physically, each iteration is one POST /step request that
// loads and saves state (§5a), so a run can pause for approval and resume.
messages = [contract + memory (§6a)]               // append-only from here
while (true) {
  if (limitHit()) return handback()                // §5: budget, turns, time, no-progress
  flush(policy, memory_recalled, …)                // the turn is visible before the model answers
  res = await claude.messages.stream({ system, tools, messages }).finalMessage()  // model decides;
                                                     // its visible text_deltas go to the live view only
  messages.push(assistant(res))
  if (res.stop_reason === "end_turn") break
  flush(model_call, tool_started × batch)          // written just before the tools run
  results = await Promise.all(res.toolUses.map(t =>  // parallel tool calls;
    runTool(t).then(r => flush(tool_call(r)))))      // each written the moment it settles
                                                     // approval tools pause here (§5a)
  messages.push(user(toolResults(results)))        // rejections stay in context
  flush(turn_end)
}
```

**Events as they happen (2026-10-16).** `events.jsonl` is written during the turn, not at its end: the turn's opening events before the model call, then `model_call` with one `tool_started` per tool of the parallel batch (kind, `tool`, `toolUseId`, `eventInput()` summary, turn, ts), then each `tool_call` (with its `lookup_retry` / `submit_verdict`) the moment that tool settles, so a batch lands in completion order; `submit_lead` calls still run one at a time after the batch, each `tool_started` then `tool_call`. Calls refused for the parallel cap never ran and get a `tool_call` only. `policy`, `model_call` and `turn_end` keep their place. Every event gets **`seq`** at append time: its line number in the file, assigned under a per-file lock (`events.jsonl.lock`, the same `withFileLock` as the quota files), so concurrent writers (a step and a route-policy line, or two processes) never share one and a resumed run continues from the file; lines written before seq existed read back as their line number. The step response still returns the turn's events, now carrying the same seq.

**Live stream.** `GET /api/runs/:id/events?after=<seq>` (Node runtime, Server-Sent Events, `src/agent/live.ts`) sends every event with seq > `after`, then tails the file (an in-process "appended" notification, `fs.watch` on the run directory, and a 250 ms poll as the floor), heartbeats (`: heartbeat`) every 15 s, and ends with `event: end` once the run is neither running nor awaiting approval (after sending what is left), or when the client goes away. Frames: `id: <seq>` + `event: event` + the event JSON; `event: delta` + `{turn, text}`; `event: end` + `{status}`. Access: the workspace id (`x-workspace-id`, or `workspaceId` in the query because EventSource cannot send headers) must own the run: 400 without one, 403 for another workspace, 404 for an unknown run. The same check (`requireRunOwner`, `app/api/_shared.ts`, header only) guards `GET /api/runs/:id` and `POST step`, `stop` and `decision`, so a leaked run id alone grants nothing. Last-Event-ID from a reconnecting EventSource is honoured. Headers `Cache-Control: no-cache, no-transform` (also keeps Next's gzip off the stream) and `X-Accel-Buffering: no`. The page subscribes while a run is live and merges the stream with the step responses by seq (dedupe, seq order), so if EventSource is missing or fails the ledger still fills a step at a time. Assumes one server process (Railway runs one replica): the deltas travel on an in-process bus; the file part would survive several, the deltas would not.

**Streamed model text.** The turn's model call uses `messages.stream`. Only `text_delta`s of visible text blocks are forwarded, as ephemeral `assistant_text_delta` messages (never written to events.jsonl); thinking and tool-input deltas are not. The final message is what `messages.create` returned before, so usage, cost, prompt caching, the `count_tokens` preflight and the `model_call` event are unchanged. A stream that fails after it started (or never connected) is retried once with `messages.create`, recorded as a `stream_fallback` WARNING event; the tokens the failed stream had already used (message_start / message_delta usage) are billed, so they are added to spend and carried on that event as `claudeCost`. An HTTP error before the stream starts (400, 429, 529…) is rethrown unchanged to the loop's existing retry policy. The handback call stays non-streaming.

**Demo.** The replay writes each step's events to the demo run's own `events.jsonl` (with seq) as it paces them: the model call with `tool_started` lines for its batch (derived from the recorded calls: same tool, id and input, since the recording predates `tool_started`), then each tool call 300 ms apart (`DEMO_TOOL_MS`). The same SSE route serves it.

What the model decides that the workflow cannot, each logged as an **adaptive action** and counted in the eval (§9). If an agent trace is indistinguishable from the fixed sequence, the agent is not earning its cost:
- **Query rewrites driven by rejection reasons:** e.g. "too big" ×3 leads to "family-owned regional 3PL"
- **Lookups skipped:** obvious enterprises and job boards are not paid for
- **Verification reads:** `read_page` before submitting an uncertain company
- **When to stop:** at N leads, or when the remaining options are poor

**Context budget (working memory).** `state.messages` is the full append-only record (replay, resume, the UI read it). What each call re-sends is decided by `assembleMessages` (`src/agent/context.ts`). Before every model call the loop measures the whole request (system, tools, messages) with the free `count_tokens` endpoint, caches the count on `state.tokenCount` so a retried or resumed step does not re-measure, and falls back to a 4-chars-per-token estimate on failure (event `token_count_estimated`, with the reason). The budget is 60% of the model's context window (`CONTEXT_WINDOW_TOKENS` in `config.ts`; 200,000 assumed, not confirmed from Anthropic docs). Over budget, the oldest whole turns (an assistant message plus the user message answering its tool calls) are dropped, by token size, until the request fits; the newest turn is always kept. The approved contract lives in the first user message (the system prompt is generic), so that message is kept and a code-written summary block is appended to it: progress and spend, accepted leads (company, signal host, date), candidates awaiting evidence, rejection counts by code, handback if any, searches already tried. Every fact comes from structured state, never from message text, and the block is cut to at most 1,500 tokens. No model writes it. Event `context_trimmed` records `droppedTurns`, `droppedTokens`, `keptTokens`, `summaryTokens`. Trimming changes the prefix, so the turn that trims pays a cache write instead of a cache read. The handback call uses the same assembly.

## 3. Architecture

- **Harness:** TypeScript, server-side Next.js routes; the UI drives the run one turn per `POST /step` and reads the turn's events live over SSE as they are written (`GET /api/runs/:id/events`, §2a), with each step response's events as the fallback. A manual tool-use loop on `@anthropic-ai/sdk` `messages.stream` (non-streaming `messages.create` as the one retry). No agent framework, so every part of the loop is visible and explainable.
- **Model:** `claude-opus-5-5`, effort `medium`, adaptive thinking (always on for this model), server-side `fallbacks: "default"` for refusals. The model is a config value, and **Opus 5.5 vs Sonnet 5.5 is an eval arm** (§9), because cost per lead is a headline metric.
- **API constraints:**
  - forced `tool_choice` returns a 400 on this model, so use `auto` and steer from the prompt
  - history must be **append-only**, because Opus 5.5 thinking blocks are bound to the conversation; never edit or trim earlier turns
- **Exa:** the existing client (`src/exa.ts`) with its CostGuard and record/replay.

## 4. Tools (what the model sees)

| Tool | Does | Returns (kept short: results are input tokens next turn) |
|---|---|---|
| `search_signals(query, months?, num_results≤25)` | Exa search with the plan's signal summary schema; `excludeDomains` applied automatically | ≤25 lines: company · signal_type · event date · url · one-line summary |
| `lookup_company(name)` | Exa company lookup with the plan's generated schema; size must quote its source | description, industry, employee estimate + source quote, HQ, each gate verdict |
| `read_page(url)` | Exa contents, text capped at 3,000 chars | title, date, text excerpt |
| `submit_lead(company, signal_url, why_now)` | **Code checks every gate** (below) and accepts or rejects | `accepted` or `rejected: <reason>` the model can act on |
| `update_todo(markdown)` | Replaces the agent's working checklist (shown live in the UI) | `ok` |
| `propose_strategy(angles[], first_queries[], est_cost)` | **Required before any spend.** Pauses for user approval (§5a) | `approved` / `revised: <user note>` / `declined` |
| `request_scope_change(change, reason, evidence)` | Asks to relax the contract (size, recency, geo, adjacent industry) or raise the budget. Pauses for approval | `approved` (contract updated by code) / `declined` |
| `remember(text, tags[])` | Saves a lesson for future runs (§6a); ≤ 3 per run, only once the run has a lead or handback; code validates it | `saved (n of 3)` or an error to fix |
| `find_contacts(company)` | Up to 3 people to reach at one **accepted** lead, in the plan's approved buyer roles (§5b). Code decides every tier; one call per lead; refused for a non-accepted company or a plan without roles (no spend) | JSON `{company, contacts: [{name, tier, why, evidence_url?}], note}` |
| `finish(summary, handback?)` | Ends the run; `handback` is required if fewer than N leads were accepted (§5). Held once with a reminder to `remember` | — |

No other write actions exist (`find_contacts` writes only to its own lead's `contacts`). `submit_lead` is the only way a lead enters the results. The results table is built **only from code-accepted `submit_lead` records**, never from the model's final text (the output check). The model may issue several tool calls in one turn; the harness runs them in parallel and returns all results in one message (the parallelisation pattern, logged as calls per turn).

## 5a. Autonomy table and mid-run approval

| Action | Agent alone | Needs user OK | Never |
|---|---|---|---|
| Search, look up, read pages within the contract | ✅ | | |
| Opening strategy (angles, first queries, cost estimate) | | ✅ before any spend | |
| Scope change: wider size, longer recency, new geography, adjacent industry | | ✅ with reason + evidence | |
| Budget increase | | ✅ | |
| Accepting a lead that fails a check | | | ✅ (code refuses) |
| Looking up people at an accepted lead (`find_contacts`, once per lead, code-gated) | ✅ | | |
| Contacting anyone / any external side effect | | | ✅ (no tool exists) |

**Mechanism: durable pause by persisting the message history (no framework).** The Messages API is stateless, so a run's entire state is ours: `messages` (stored exactly as received, thinking blocks included), the contract, spend, and counters.
- **One turn per request:** `POST /api/runs/:id/step` loads the state, makes one model call, runs its tools in parallel, appends the results, saves the state to `runs/<id>/state.json` (DB later), and returns events. The UI calls `step` again until the run ends. Each request is short (≈10–30 s), so it fits serverless limits. The step still drives turns; the live view reads the turn's events as they are written from `GET /api/runs/:id/events` (§2a), and the step response's events (same seq) are the fallback.
- **Approval:** when a turn contains `propose_strategy` or `request_scope_change`, the harness saves the state with status `awaiting_approval` and stops. That tool_use is left as the last entry and is not yet answered.
- **Resume:** `POST /api/runs/:id/decision` loads the state, appends the user's decision as that tool's `tool_result` (any other tool results from that turn go in the same message), and continues with the next `step`. It works minutes or hours later, and across restarts.
- **Crash repair:** a turn that died after its assistant `tool_use` but before the `tool_result` was saved would make the next call 400. `loadState` finds a *running* run whose last message is an assistant message with `tool_use` blocks and appends one user message with an error `tool_result` per id ("interrupted before a result was recorded; call again if still needed"); the next step records a `turn_repaired` event with the ids. A run with `pendingApproval` is never repaired: its unanswered `tool_use` is the pause, answered by the decision. Since events are written as they happen, a crash mid-batch leaves `tool_started` lines (and the `tool_call`s that settled) in events.jsonl; the repair is unchanged, seq continues from the file, and the ledger shows the unfinished calls as "Didn't finish".
- **No decision:** the run stays paused, with no timeout and no spend. The wall clock counts only active time.
- On approval, **code** updates the contract (gates, window, budget). The model never edits it directly.
- This is what LangGraph's checkpointer plus `interrupt()` provides, built in about 30 lines so the mechanism stays explainable.

Measured as: approval requests per run, approval rate, and whether approved scope changes produced accepted leads.

## 5. Guardrails — the model proposes, code decides

`submit_lead` runs these deterministic checks. All of them already exist from the v2 engine, or are fixes queued from the last eval:
- **Event date** in the plan window (inclusive), judged on the signal's own event date. The article's publish date is substituted only for an apparent *year-slip*: a signal date in a different year whose month/day falls within ±90 days of the publish date (Exa's observed failure: "2023-10-05" for an article published 2026-10-05; the real FST/G10 cases were 43–81 days off, which is why ±7 was too tight). Future dates and dates >24 months old with no publish date are unparseable. Residual risk, left to the judge's Q3: a fresh retrospective article about a year-old event.
- **Required gates** true on a `lookup_company` result for this company
- **Evidence-required gates:** every required lookup gate is `true | null` plus `<key>_quote`; `null` or an empty quote returns `unquoted_gate` as a candidate, not an accepted lead. Quotes must be literal substrings of the lookup page text after normalising case, whitespace, smart quotes and HTML entities, otherwise `quote_not_in_page`. Optional gates without a verified quote simply do not add confidence.
- **Size:** the lookup must quote the phrase its employee estimate came from. A quoted estimate is checked against the exact band. An estimate its quote does not support is unverified. Under the plan's unknown-size rule `reject` (the user asked for known sizes), an unverified estimate is rejected as `unknown_size`. Under `allow-if-not-enterprise`, the weak-evidence rule applies: *weak evidence, not no evidence*, so it is rejected if below min/2 or above 1.5× max, otherwise accepted with a confidence penalty. No estimate at all follows the plan's unknown-size rule. (Decided 2026-10-12 after a live run returned 356 and 3,560 for the same company; year-like numbers such as "founded 2004" cannot corroborate a headcount.)
- **Signal evidence:** a signal summary carries `signal_quote` and `signal_date_quote`. An empty `signal_quote` is `unquoted_signal` (candidate tier); a `signal_quote` or non-empty `signal_date_quote` that is not a substring of the signal page text is a hard `quote_not_in_page`. A LinkedIn personal profile URL (`linkedin.com/in/<name>`) is `non_event_page`. Job/career-board sources are `exclude_domain` by a built-in list (`BUILTIN_EXCLUDED_SIGNAL_DOMAINS` in `src/gates.ts`), in addition to the plan's `excludeDomains`: indeed.com, glassdoor.com, snagajob.com, tealhq.com, ihire.com, ihirelogistics.com, ziprecruiter.com, linkedin.com/jobs, jobs.ashbyhq.com, boards.greenhouse.io, job-boards.greenhouse.io, jobs.lever.co, apply.workable.com, builtin.com, wellfound.com/jobs, simplyhired.com, monster.com, careerbuilder.com, jobvite.com, smartrecruiters.com, workdayjobs.com, greenhouse.io, lever.co, ashbyhq.com, breezy.hr, recruitee.com, comeet.com, jobberman.com, jobrapido.com, jobera.com, intern-flow.in, zerogtalent.com, snaprecruit.com, jobtarget.com, jobs.capitalfactory.com (the last three added 2026-10-15; subdomains match; entries with a path match that prefix). A *hiring signal* is one whose `signal_type` contains a hire/hiring/job/role/career/recruit token, or whose URL path (`/jobs`, `/careers`, `/openings`, `/positions`, `/vacancies`) or title is itself a job post; incidental words such as "jobs" in a facility or lease article do not count. A hiring signal must be on the company's own registrable domain or name at least two distinct roles, otherwise `weak_hiring_signal`. **Third-party job listings** (2026-10-15, FAILURES #26): independent of the domain list, a signal URL whose host starts `jobs.`, `career(s).`, `apply.` or `boards.`, or whose path has a segment `job`, `jobs`, `career(s)`, `vacancy/vacancies`, `position(s)` or `opening(s)`, on a registrable domain that differs from the company's lookup URL (an unknown company domain counts as different) is `non_event_page` ("job listing on a third-party site"). Own-domain careers pages are not caught by it. The summary's `signal_type` is not consulted: the rule does not trust the summariser's label. A single third-party job post is rejected even if it carries a real facility event (Jay Group, judged good only via the aggregator's other listings); the rubric counts a job post only on the company's own site or with at least two named roles.
- **HQ** in the plan's countries
- **Exclusions:** fuzzy name match against the exclusion list, job-board and placeholder filters
- **Entity match:** the company name appears in the signal page
- **Dedupe:** squashed name variants count as one company ("Diakon Logistics" = "Diakonlogistics")

**Gate codes and tiers.** `checkLead` returns `{ ok: true, details }` or `{ ok: false, code, reason, tier? }`. Only `unquoted_signal` and `unquoted_gate` carry `tier: "candidate"` (missing proof, worth a better source); every other code is a hard reject.

| Code | Tier | Meaning |
|---|---|---|
| `stale_date`, `unparseable_date` | reject | event date outside the window, or no plausible date |
| `exclude_name`, `exclude_domain`, `non_company` | reject | plan exclusions, built-in job-board domains, placeholder/staffing names and lookup domains |
| `non_event_page` | reject | personal LinkedIn profile as the signal; job listing on a third-party site |
| `already_seen`, `duplicate` | reject | earlier run / this run |
| `entity_mismatch` | reject | company name not on the signal page (or no page text) |
| `weak_hiring_signal` | reject | hiring signal off the company's domain with fewer than two distinct roles |
| `unquoted_signal` | candidate | no `signal_quote` |
| `no_enrichment`, `enterprise`, `hq`, `size`, `unknown_size`, `required_gate:<key>` | reject | lookup missing or fit gate failed |
| `unquoted_gate` | candidate | required gate null or true without `<key>_quote`, or known HQ without `hq_quote` |
| `unquoted_gate` (truncated page) | candidate | a lookup quote (HQ, employee source, gate) is absent from the lookup text and `lookup_text_truncated` is true: the page was cut at 20,000 characters, so the quote is unproven rather than false |
| `quote_not_in_page` | reject | a signal, date, HQ, employee-source or gate quote is not in the captured page text (lookup quotes can only be checked when `lookupText` was captured, and only on an untruncated page) |

**Contact gate codes** (`checkContact`, §5b): `contact_unverified`, `contact_stale` and `contact_role_changed` (tier inferred), `contact_quote_not_in_page` and `contact_role_mismatch` (rejected). They decide a contact's tier only; they never change a lead's status, the lead count, or lead precision.

`checkLead(plan, input, { evidenceMode: "skip-quotes" })` disables the quote-dependent rules (`unquoted_*`, `quote_not_in_page`). It exists for replaying old runs only (`eval/replay-gates.ts`); the production default is full enforcement. Unproven on live Exa until a paid run.

Budget and loop limits are enforced by the harness, never by the prompt. The run stops at whichever comes first:

| Limit | Default |
|---|---|
| Combined spend cap (Exa + Claude) | $1.00, user-visible |
| Accepted leads | target N = 10 |
| Turns | 30 |
| Wall clock | 6 minutes |
| No progress | 4 turns with no new accepted lead and no new candidate |

**Candidate tier.** When a lead fails only because a required lookup gate is not stated or is unquoted (`unquoted_gate`), `submit_lead` returns a structured `unverified` result so the model can look for a better source. The run persists up to 20 deduped candidates separately from accepted leads. They never count toward `state.leads`, target lead count, precision or scores. The API/export contract exposes them as `candidates: Array<{ company, signal_url, why_now, code, missing }>`.

**Handback to the user (the handoff in this product).** If the run stops on budget, turns, time or no progress before reaching N leads, the agent does not loosen the criteria itself; the plan is the user's. Instead it ends with a structured handback, which the UI renders as one-click card changes:
- the shortfall (e.g. "3 of 10")
- the top rejection reasons with counts, from the `submit_lead` verdicts
- at most 2 concrete card changes, e.g. "widen size to 50–5,000" or "recency 6 months"

When the *harness* stops the run, the model cannot call `finish`. So $0.05 of the cap is reserved for one final call with tools disabled that writes the handback. The rejection counts are always computed by code, so the handback stays correct even if that call fails. The user applies one change and re-runs, or accepts the partial list. Measured as: share of runs ending in handback, and whether the re-run with the suggested change yields more good leads.

**Agent-to-agent handoff (e.g. to an outreach agent) is out of scope.** It adds external side effects (sending email) and does not address the open problem, lead quality.

**Prompt injection:** page text and search results are data. The system prompt says so, and the blast radius is bounded because the only effect a tool result can have is a `submit_lead` that still must pass every code check.

Also kept: server-only keys, per-IP rate limit, generic errors, http(s)-only links.

## 5b. Contacts: who to reach at an accepted lead (built 2026-10-16; two live runs, rules tightened after each: FAILURES #29, #30)

Background, market and legal research: `docs/RESEARCH-contacts-and-graph.md` (§5 design, §6 build order, §7 decisions). This is build step 1 there: named contacts with gates. No warm paths, no email reveal.

**Decisions** (Joshua chose to build; the defaults below were set by the orchestrator and are reversible):
1. **LinkedIn-only people are shown as inferred**: name and profile link only, no copied text (LinkedIn User Agreement §8.2 bans using LinkedIn data obtained "through third parties (such as search tools…)"). Nothing from a profile is stored or displayed; the people-index title is read in code only to say which approved role the person was listed under.
2. **A verified contact needs a page that names the person next to a title fitting an approved buyer role**, both checked on the captured page text by code (`quoteMatch`), AND the page is either the company's own registrable domain, or press (rule below). Two tiers: verified / inferred. (Tightened 2026-10-16, FAILURES #29: "not LinkedIn" was not enough; a scraped-profile mirror and a 2019 press release both verified.)
3. **No emails or phones** are fetched, stored or displayed. Email reveal through a user-supplied provider key is a later step.
4. **Retention:** contacts live on the run's lead (`AcceptedLead.contacts`), so run retention applies. Nothing contact-related is written to workspace memory: `appendRunToMemory` records company names only, and `remember` refuses a note that names a person `find_contacts` returned.
5. **"Who to reach" card** on the Target step, pre-filled by code from the seller profile's `buyer_roles`, editable chips, saved on the plan as `buyerRoles: string[]` (validated like other plan fields: ≤ 6 roles, ≤ 80 chars, deduped case-insensitively; absent or empty = no contact lookups).

**Data model** (`src/contacts.ts`):

```ts
type Contact = {
  name: string;
  tier: "verified" | "inferred";
  role: string;               // the approved buyer role it fits
  why: string;                // "why this person": the quoted title (verified) or the role bucket (inferred)
  profile_url?: string;       // linkedin.com/in/… from the people index: a link only
  evidence?: { url: string; quote: string; title_quote: string }; // verified only (src/evidence.ts ContactEvidence)
  found_via: "people_index" | "web_page";
  code?: ContactGateCode;     // why an inferred contact is not verified
  note?: string;              // inferred only: "last confirmed 2019" (contact_stale) or "role changed" (contact_role_changed)
};
type LeadContacts = { at: string; roles: string[]; contacts: Contact[]; cost: number; error?: string }; // AcceptedLead.contacts
```

**The two Exa calls** (`findContacts`, under the run's `CostGuard`):
- **A. People index:** `{ query: "<roles joined by ' or '> at <company>", category: "people", type: "auto", numResults: 5 }`, no contents. Keeps results whose URL is `linkedin.com/in/…`, with the entity's name and, from `workHistory`, the approved role of a *current* position (no end date) at this company (≥ 60% name-token overlap, so "Verst Group Logistics" = "Verst Logistics").
- **B. Public pages:** `{ query: "\"<company>\" <roles> leadership team", type: "auto", numResults: 5, excludeDomains: CONTACT_NON_EVIDENCE_DOMAINS, contents: { text ≤ 20,000 chars, summary: {people: [{name, title_quote}]} } }`. The summary query lists the names from A. Exa's `site:` operator is not documented, so the brief's `site:<host>` was not used; the company's own domain is recognised by the gate instead.
- **Cost:** worst-case estimate $0.00875 (A) + $0.02125 (B) = **$0.03 per lead**, the cap (`CONTACT_LIMITS.maxCostDollars`, checked before any call, and against the run guard's remaining budget). Actual is probably ≈ $0.014–0.019 (research §5.3 measured $0.007 per call with contents included; the page summaries may add $0.001 per page); unmeasured until a live run.

**Gate** (`checkContact(contact, { page, buyerRoles, companyUrl })` in `src/gates.ts`, pure):

| Code | Tier | Rule |
|---|---|---|
| — | verified | all below pass |
| `contact_unverified` | inferred | no page; the page is LinkedIn, a LinkedIn copy or a people-data aggregator (`CONTACT_NON_EVIDENCE_DOMAINS`: linkedin.com, exa.ai, theorg.com, muraena.ai, zoominfo.com, rocketreach.co/.com, apollo.io, lusha, contactout, signalhire, kaspr, crunchbase, pitchbook, cbinsights, datanyze, seamless.ai, leadiq, clearbit, hunter.io, findymail, snov.io, getprospect, wiza, uplead, cognism, 6sense, lead411, and company directories: visualvisitor, dnb, hoovers, buzzfile, manta, bizapedia, opencorporates, corporationwiki, growjo, tracxn, aeroleads, globaldatabase, kompass, …); no page text; off the company's domain and the URL is profile/directory-shaped, or the page does not name the company, or under 200 characters of prose surround the name and title; no title for the person on the page |
| `contact_role_changed` | inferred | the matched title is a former one (phrase list under **Former roles**); never verified, and a people-index listing does not rescue it; shown with the title as quoted and the note "role changed" |
| `contact_stale` | inferred | off the company's domain, the page is older than 24 months and the people index does not list the person in a current approved role at the company (below) |
| `contact_quote_not_in_page` | rejected | title quote over 120 chars; not a full name (2+ tokens); the name (word-bounded, one middle initial allowed) or the title (`quoteMatch`) not on the page text; title more than 200 characters from the name |
| `contact_role_mismatch` | rejected | the title fits none of the approved roles |

**What may verify** (`checkContact`, FAILURES #29). The aggregator list is a floor, not the rule: mirrors are endless. A page verifies only if (a) its registrable domain equals the company's own domain (from the lookup URL), or (b) it is press: not on the aggregator list; its URL path has none of the segments `profile(s)`, `person`, `people`, `employee(s)`, `contact(s)`, `in`, `pub`, `directory` (this covers `/company/<x>/people`), no `/company/<digits>` or `/companies/<digits>` directory-record segment, and no `?person=` query; it names the company; and at least 200 characters of prose surround the name and title (`proseCharsAround`: sentences of 7+ words that are mostly lowercase words, within 600 characters of the span; aggregator pages are field lists). Anything else is inferred at best.

**Recency.** Each evidence page gets a date: Exa's `publishedDate` on the result, else the full date (`Jun 3, 2019`, `3 June 2019`, `June 2019`, `2019-06-03`) written nearest the quote within 400 characters, else none. It is stored on the evidence (`ContactEvidence.published`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`). A press page older than 24 months cannot verify on its own: it verifies only if the people index (call A) lists the same person with a CURRENT position at the company in an approved role (`findContacts` passes `currentInIndex`). Otherwise the contact is inferred (`contact_stale`) with `why` = the quoted title, no evidence, and `note` "last confirmed <year>". Company-domain pages have no age rule (they are current by construction) but still record the date if present. A page with no date at all has no age to judge and is not penalised (a known gap). The UI line is name · “quoted title” · host · Jun 2019 (muted), the date is also on the evidence row beside the host, and a stale inferred contact reads name · “title” · muted “last confirmed 2019”.

**Former roles** (`checkContact`, FAILURES #30). A title that fits an approved role is not current if the page says it is over. The check reads the title quote and the text within 160 characters either side of the title on the page, bounded by the paragraph or heading it sits in. These phrases make the matched role NOT current: `former` / `formerly`; `previous|prior role|position|title|post|job`; `stepping|stepped up|down|aside`; `moved|moving (up) from`; `promoted from`; `outgoing`; `retired|retiring|retires|retirement`; `succeeded by`; `succeeds <this person's surname>` (the named person is the one replaced); `ex-<word>`; `until <year>` (also `until March 2024`, `until early 2024`); `was <title>` (was chief / vice / VP / director / head / managing / general manager / president / COO / CEO / CFO); `, now <Title>`. The list is deliberately narrow: a bare `previously` is common in a current executive's bio and does not flag. Outcome: if the quote splits on the phrase, the part before it is the person's new title and is judged alone (it verifies only if it fits an approved role itself, and that part is what the evidence records); otherwise the matched role is the old one and the verdict is `contact_role_changed`. `findContacts` shows that contact as **inferred** with `note` "role changed", `why` the quote, the approved role it matched, and the profile link if the index had one. It outranks a people-index listing and a page-title mismatch from another page; a page that verifies the person in a current approved role outranks it.

**One person, one record; names as written.** Names are compared by `personKey`: lowercase, accents and punctuation dropped, middle initials dropped, trailing post-nominals dropped (explicit list: FCILT, MCILT, CMILT, CILT, MBA, PhD, CPA, Esq, DBA, MSc, BSc, MBE, OBE, CBE, CFA, CMA, CIPS, CPSM, CSCP, CPIM, CLTD, CWLP, PMP, FCA, ACA, FCCA, FCMI, Jr, Sr, II, III, IV). "Neil Midgley" (company page) and "Neil Midgley FCILT" (LinkedIn index) are one person: the higher tier is kept and the profile link is attached to it (`dedupeContacts`). A verified contact's `name` is the evidence page's own spelling of it, not the index's or the summariser's; a name that is all lowercase or all uppercase (nothing better available) is title-cased (`properCaseName`: "kurt cuncannan" -> "Kurt Cuncannan", particles van/von/de kept lower, mixed case such as "MacLean" untouched).

**Replay.** `npx tsx eval/replay-contacts.ts` re-runs `findContacts` over the recorded 2026-10-16 live run (Exa responses matched on category + query, no network, $0) and prints each recorded contact's tier next to the tier now.

**Cost guard.** The run's `CostGuard` is `FindContactsInput.guard` and nothing else; both Exa calls go through it, so the tool's spend lands on the run. `deps.guard` is `never` in the type and throws at runtime (a guard handed over that way was silently ignored in the first live probe: cost $0.019, guard spent $0).

`titleMatchesRole(title, role)` is deterministic token overlap, case-insensitive. Both sides are folded first: abbreviations (`VP`/`SVP`/`EVP` → vp, `ops` → operations, `HR` → people), C-suite titles carry their function (`COO` / "Chief Operating Officer" → coo + operations, CFO → finance, CTO → technology, CMO → marketing, CRO → revenue), word stems (`operational` → operations, `warehousing` → warehouse). If the role names a function (any word that is not a rank or filler word such as VP, director, head, senior, of), the title must share at least one function word; a rank-only role ("CEO", "Founder", "VP") must share a rank word. **Refinement of the brief's "≥ 1 role word":** a shared rank word alone does not count when the role names a function, because "VP" would otherwise match "VP of Sales" to "VP of Operations". The Verst title disagreement (research §5.3) shows the cost: "Senior Vice President, Logistics" does not fit "VP of Operations"; the user adds "Logistics" as a role if they want it.

**Who becomes what** (code only; the model never decides a tier):
- verified on any page in B (own domain or press, current enough) → **verified** (with the LinkedIn link too if A listed them).
- only an old press page (`contact_stale`) → **inferred**, title as quoted, "last confirmed <year>".
- not verified, listed in A in an approved role, and no page gives them a title outside the roles → **inferred** (`code` = the most specific failure).
- a name only B's summariser produced that its page does not support, someone A lists at another company or in a past role, or a page title outside the roles → **dropped** (counted in the trace, never shown).
- At most 3 per lead, verified first.

**Tool rules** (`find_contacts` in `src/agent/tools.ts`): the company must be in `state.leads` (squashed name); a second call for the same lead is refused, including a duplicate in the same parallel batch (the lead's `contacts` record is claimed before the first await); a failed call still spends the one call and records `error`. The tool result to the model has names, tiers and a "why" line, never page or profile text. The trace (`tool:find_contacts` observation) gets the Exa cost and counts only (`metadata.contacts = {verified, inferred, dropped}`), never names. Prompt: the system prompt's "Who to reach" section and the first message's approved roles (only when the plan has roles).

**UI:** each lead row has a "Who to reach" line. Verified: name · “quoted title” · source host (a button that opens the evidence block on its "Who to reach" row: the verbatim page span and host). Inferred: name · "profile" link · muted "inferred from a public profile" (tooltip: the approved role it was listed under, title not confirmed). Never a LinkedIn snippet. In demo mode a lead without contacts shows one muted line, "No contacts looked up in this recording"; a live lead that was not looked up shows nothing. CSV gains "Contact names / titles / tiers / profile URLs / evidence URLs" (up to 3 joined by "; ", inferred titles blank).

**Contacts phase** (`contactsPhaseTurn` in `src/agent/loop.ts`). Reaching the target no longer stops the run at once when contacts are still missing. If `limitReason` would stop on `target_leads`, the plan has approved buyer roles, some accepted lead has no `contacts` entry, and at least one lookup's $0.03 is left under the run cap (after the $0.05 handback reserve), the run enters a bounded phase:
- at most ceil(leads / 3) extra turns (`state.contactsPhase.maxTurns`);
- each phase turn writes a `policy` event `check: "contacts_phase"` with `leadsWithoutContacts`, `phaseTurn`, `maxTurns`, `budgetDollars`, and appends the turn nudge to the (not yet sent) user message: "Target reached: look up contacts for the N leads without them (…) with find_contacts, then finish.";
- Exa spend since the phase began is capped at leads × $0.03: that turn's `CostGuard` is lowered to it, never above the run cap, so `findContacts` refuses before spending when it would not fit;
- the run stops as `target_leads` when every lead has contacts, the phase's turns are used, or its budget cannot pay for another lookup. Every other limit (budget, turns, time, no progress) still wins first; a `finish` in the phase ends the run as usual.

A turn in which at least one `find_contacts` call returned (success, even with zero people) counts as progress for the no-progress limit; a failed lookup does not.

**Eval scaffold** (not run): `eval/datasets/contact-cases.jsonl` (ships empty; one `ContactCase` per line: company, candidate_name, title, url, label verified | inferred | wrong, note) and `eval/harness/judge-contacts.ts` (web-search judge: is this person currently in that role at that company? yes / no / cannot_verify; the judge never sees the tier; metrics: verified precision, stale rate, inferred wrong-share). Paid: run `--limit 1` first.

## 6. Context engineering (applying Manus's published lessons; verify against the original post)

- **Stable prefix for caching:** system prompt and tool definitions never change mid-run; the plan goes in the first user message; tool lists are deterministic and sorted; `cache_control` on the prefix. Log `cache_read_input_tokens` to prove caching works.
- **Append-only record, budgeted re-send:** `state.messages` is never rewritten or trimmed. What is sent each call is trimmed only when the request passes 60% of the context window (§2a "Context budget"); dropped turns become a code-written summary from state.
- **Keep failures visible:** rejected leads and tool errors stay in context, so the model stops repeating them.
- **Recitation:** `update_todo` keeps the goal and the remaining work at the end of the context.
- **Compact tool results:** fixed short formats, never raw page dumps.

## 6a. Memory across runs

Without memory, a second run for the same ICP returns the same leads, and the ones the user already rejected. The rule: **a fact lives in exactly one home, chosen by who may act on it.**

| Home | What | Stored | Re-enters the run as | Who acts on it | Expires |
|---|---|---|---|---|---|
| Constraints | `seen[]`: every company delivered or rejected in an earlier run, each tagged with the search that produced it (`search: { planKey, label, industry? }`) | `workspaces/<id>/memory.json` | `state.caches.seenKeys` (+ `seenInfo` for provenance): the entries that apply to this run's search (below) | **Code.** `lookup_company` skips a seen name without paying for the lookup; `submit_lead` rejects `already_seen` | 90 days after `at` (no longer applied); evicted on save after 180 days |
| Preferences | `preferences[]`: the user's 👍/👎 per company, with reason, run and signal URL | same file | first user message, "Notes from this user's earlier feedback" | **The model**, as advice | Only by supersession: a later feedback on the same company sets `supersededBy` on the earlier one (kept, not deleted) |
| Episodic | `notes[]`: lessons the agent wrote with `remember` ("what worked / was dead for this kind of search") | same file | first user message, "From earlier runs in this workspace", each line dated | **The model**, as hints to check | `expiresAt`, default 60 days; list capped at 200 (expired first, then oldest) |
| Working | todo, caches, this run's candidate list, this run's notes (`state.notes`) | `runs/<id>/state.json` | the append-only history | The model, this run only | End of run (notes are promoted to episodic when the run ends) |

None of this touches the system prompt, so the cached prefix stays stable (§6).

**Provenance on every item.** Each item has a stable `id` and the run it came from: `seen` carries `runId`, `at`, `signalUrl`, `leadIndex`; a preference carries `runId`, `signalUrl`, `at`; a note carries `runId`, `at`, `expiresAt`. The UI lists all three groups (GET `/api/workspaces/:id/memory`: `groups` = live seen entries grouped by search, current search first, each `{ planKey, label, industry?, count, firstAt, lastAt, current, items }` with items newest first and capped at 50; `seenCount`; all active preferences; all unexpired notes; `?planKey=` marks the current group, default the most recently touched) and forgets one item with DELETE `/api/workspaces/:id/memory/items/:itemId` (removes that item only), or one whole search with DELETE `/api/workspaces/:id/memory?search=<planKey>`. DELETE `/api/workspaces/:id/memory` still clears everything. Files written before this change load through a migration (`migrateMemory`): old `seen` items get ids; `preferenceNotes` strings in our own "User rejected X: why" format become preferences, any other string becomes a note.

**Scoped constraints.** A seen company only blocks the search that saw it. `planSignature(plan)` (memory.ts) is `plan_` + the first 12 hex of sha1 over the sorted gate keys, the sorted signal types and the industry phrase, if the plan has one (a scope change's `Prefer industry: X.`; plans have no industry field, so industry normally shows up through the gate keys). Size, HQ, recency, label, queries and exclusions are not part of it: editing them keeps the key, a different industry or gate set is a different key. Every `seen` entry stores `search = { planKey, label, industry? }` from the run's initial plan. Entries written before scoping migrate (in `migrateMemory`) to `search: { planKey: "legacy", label: "earlier searches" }`. `recall()` passes a seen key to the gate only when `entry.search.planKey === planSignature(plan)`, or the entry is legacy and at most 30 days old, and the entry is under 90 days old; everything else stays in memory but is not applied. Still no ranking for constraints. `appendRunToMemory` dedupes only against live entries of the same search, so a company seen under another search is recorded again under this one. The "Skipped X, delivered 12 Oct in an earlier run" feed line therefore fires only for same-search entries.

**Recall contract (`src/agent/recall.ts`).** The only way a run reads memory.

```
recall(memory, plan, { budgetTokens, now }) -> {
  constraints: { seenKeys, seenInfo },            // seen entries scoped to this plan (or recent legacy); never ranked, never cut
  prompt: { preferences: Preference[], notes: Note[] },
  log: Array<{ id, kind: "preference" | "note", score, included }>
}
```

- Preferences and notes are **ranked, not filtered**. `score = overlap + recency`. `overlap` is the number of distinct words an item shares with the plan: for a note its tags (each tag also matches whole, so `new_facility` matches the gate/signal key); for a preference its company and reason words. Plan words are the gate field keys, signal types, label, signal queries and the signal/company summary queries, lowercased, stop words and words under 3 letters dropped, trailing plural `s` stripped. `recency = 0.9 * 0.5^(ageDays / 30)`. Because recency is below 1, one shared word always beats any recency.
- Expired notes and superseded preferences score 0 and are excluded. Remaining items are included best-first until the budget (`RECALL_BUDGET_TOKENS` = 800, estimated at 4 characters per token) is spent. If items exist the top one is always included, even if it alone exceeds the budget. Ties: feedback before self-notes, then newer.
- The run stores `log` as `state.memoryRecall` and writes one `memory_recalled` event on its first turn (`seen` count, considered/included counts for preferences and notes, and `includedIds`), so a trace shows which memories shaped the run.
- Callers: `app/api/runs/route.ts` and `eval/run-agent.ts` build the run with `createRunState({ recalled: recall(...) })`.

**Expiry** is applied at read time inside `recall`, and by `compact(memory, now)` on every save. No background jobs. `seen` entries stop applying 90 days after `at` and are evicted after 180; preferences end only by supersession; notes expire at `expiresAt` (60 days) and the list is capped at 200.

**Self-notes (`remember`).** At most 3 per run, only once the run has an accepted lead or a handback. Code checks: text 1-240 characters, at most 6 tags (lowercased, deduplicated), no URLs or domain names, and no company the run met in search or lookup but did not accept or reject. (Limit: the last check matches names the run actually saw; it cannot catch a company the model names from its own knowledge.) The first `finish` of a run that has a lead or handback and wrote no note is held once with a reminder; the second ends the run.

- **Keeping the model honest:** recalled notes are labelled hints from earlier runs, dated, and the run still faces every gate.
- **Store:** `workspaces/<id>/memory.json` per anonymous workspace (no accounts), read-modify-write under a file lock (`.memory.lock`), written atomically.
- **Kept:** company names, verdicts, reasons, signal URLs, short lessons. **Not kept:** page text.

## 7. Observability

One event per step to `runs/<id>/events.jsonl`:
- turn, kind (model_call | tool_call | submit_verdict | stop)
- tool name and arguments, result summary
- input, output and cache-read tokens; Claude cost; Exa cost
- latency, prompt version

The UI's live view reads the same stream. The run summary records: stop reason, accepted and rejected counts by reason, spend split by model and Exa, turns, and time to first lead.

Production tracing (Langfuse), trace data policy, and offline/online evals: see [SPEC-observability.md](SPEC-observability.md).

## 8. Prerequisite engine fixes (from the 2026-10-11 eval)

These become tools and gates, so they ship first:
- Look up every candidate within budget (no ranking guesswork)
- Dedupe name variants
- Size must quote its source; contradictions become unknown
- Stricter 3PL gate question: "provides logistics services to other companies as its primary business"
- Rewrite the ICP-1 fixture to 5 signal queries

## 9. Evals — the experiment

- **Scenarios (4):** ICP 1 (logistics), ICP 3 (funded B2B and first ops hire), plus 2 generated from real seller sites through the card flow.
- **Arms:** (A) v2 workflow · (B) agent on Opus 5.5 · (C) agent on Sonnet 5.5.
- **Rubric, written before any run:**
  - a lead is *good* if the company type and size are confirmed from a cited source (its own site or LinkedIn), and the signal is real, specific and inside the window
  - judged blind (arm labels hidden) by an Opus judge, with my spot-check of ≥20%
  - ground-truth facts recorded with source URLs in `eval/truth/`
- **Metrics:** good leads per run, precision, cost per good lead, p50 and p95 latency, stop-reason mix.
- **pass^k:** each scenario × arm runs k = 3 times. *Pass* = ≥ 6 good leads at precision ≥ 0.8 within budget. Report pass^3 (it must work every time), alongside pass@1.
- **Agency check:** count adaptive actions per run (§2a). An agent run with zero rewrites, skips or verification reads is flagged as "workflow-shaped".
- **Simulated user (deterministic, no LLM):**
  - approves the opening strategy
  - approves scope changes that only widen one constraint
  - on handback, applies suggestion #1 and re-runs once

  This measures whether the agent's handback suggestions raise good leads.
- **Regression:** the deterministic gates stay covered by the existing test suite, with Exa responses replayable. Agent decisions are not deterministic, so agent evals are always live, which is why they run in budgeted stages.
- **Budget, staged, and each stage needs your go:**

  | Stage | Runs | Est. cost |
  |---|---|---|
  | Smoke | 1 scenario × arm B × 1 | ≈ $1 |
  | Pilot | 2 scenarios × arms A, B × 3 reps | ≈ $8 |
  | Full | 4 × 3 arms × 3 | ≈ $25–35 |

  Estimates: agent run ≈ Exa $0.3–0.6 + Claude ≈ $0.3–0.8 on Opus with caching. The smoke run replaces these guesses with measured numbers.

## 10. Deliverables

1. The app (cards → live agent → results), deployed.
2. README rewritten as a case study:
   - the problem
   - the workflow vs agent decision
   - where the human approves, and why
   - code-enforced gates
   - eval results with cost per good lead
   - **two real failures found and fixed:** wrong-year dates, and cost tiers that broke the budget
   - what is not production-ready
3. A 3-minute demo script.

## 11. Tasks & model routing

| # | Task | Owner | Gate |
|---|---|---|---|
| A1 | Engine fixes (§8) + tests | sonnet-5.5 subagent | vitest/typecheck/build pass |
| A2 | Agent harness: per-turn `step` endpoint, persisted state, parallel tool calls, limits, durable approval pause/resume (§5a), memory store (§6a), event log | gpt-5.5 (codex): clear spec | unit tests with mocked Claude + Exa, incl. resume after restart, and byte-identical history after save/load |
| A3 | System prompt + tool descriptions | opus-4.8: copy the model reads, taste | reviewed by me |
| A4 | Smoke run (stage 1) | me | measured cost; trace reviewed end-to-end |
| A5 | Input resolver + seller profile + card suggestion/compile (SPEC-v2 T4–T5) | gpt-5.5 + opus-4.8 (prompts) | planner eval on 6 sellers |
| A6 | UI: cards, live agent view, results + rejections, per-lead 👍/👎 feedback, CSV | opus-4.8: user-facing | usable without explanation by someone new |
| A7 | Eval harness: rubric, truth files, blind judge, pass^k report | gpt-5.5 build; **I judge** | rubric frozen before runs |
| A8 | Pilot → full eval (stages 2–3) | me | each stage approved |
| A9 | Review of full diff | opus-4.8 + codex review | findings fixed |
| A10 | README case study + demo script | opus-4.8 draft, me edit | — |

Order: A1 → A2 + A3 → **A4 smoke (gate)** → A5 + A6 in parallel → A7 → A8 → A9 → A10.

## 12. Out of scope (v1)

- Multi-agent / subagents
- Facebook groups as a source
- Sending outreach
- User accounts

## 13. Open risks

- **Hosting:** resolved by the one-turn-per-request design (§5a). Remaining risk: a single turn with slow Exa calls plus a long model response exceeding 60 s. Mitigations: stream the model call, cap parallel tools per turn, measure p95 turn time in the smoke run.

- The agent may not beat the workflow on precision. If so, that is a valid finding, and the case study reports it.
- Claude cost per good lead could exceed the value. That is a pricing question the eval answers.
- Exa summary noise (wrong-year dates, unreliable sizes) is mitigated by code gates, not eliminated.

## 14. Rollout plan

**Stage 0: shadow.** The agent runs on real contracts next to the workflow (arm A) with the same contract and cap; only the workflow's results are shown. Both are pooled blind and judged with `eval/RUBRIC.md`. Nothing from the agent reaches a user.

**Stage 1: small share.** The public URL defaults to demo mode (recorded replay, no spend). Live mode is on only for named users, under the per-run cap ($1.00) and the daily cap.

**Ramp criteria (rubric-based).** Widen live mode only when, on the latest full eval (§9):
- arm B has pass^3 = 1 on at least 3 of 4 scenarios
- mean precision ≥ 0.8 in every scenario
- cost per good lead is no worse than arm A's
- shadow runs from the previous stage meet the same bar

Any later eval that misses a criterion rolls back one stage.

**Kill switch.** `DEMO_MODE=1` (every run becomes the recorded replay) plus `DAILY_SPEND_CAP_DOLLARS=0` (`POST /api/runs` returns 503; test `F1.11`). The owner of the deployment flips both in the host's environment settings and redeploys. Trigger: a confirmed bad lead pattern, a spend anomaly, or a prompt-injection report.

**Weekly review** (from `events.jsonl`, run summaries and workspace feedback):
- cost per good lead (judged sample)
- handback rate, and whether re-runs with suggestion #1 added good leads
- approval decline rate, split by strategy and scope change
- 👎 reasons, grouped; recurring ones become eval cases (§2 step 7)
