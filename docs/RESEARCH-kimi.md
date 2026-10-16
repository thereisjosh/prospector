# Kimi K2.6 vs Sonnet 5.5: research, provider design, and how to run it

**Status (2026-10-16):** the code is built and tested against fakes only. The paid runs below have not been done. **One exception:** at 21:46 a `calibrate-evidence-judge --model kimi --run --max-dollars 1` command, meant to check that the script refuses to run without a key, actually started a paid round. `.env` already had a non-empty `KIMI_API_KEY`, which was not checked first. It was killed after about 2 minutes, before the first judge's 10 items finished. No report was written. The worst case is 10 kimi-k2.6 calls, about **$0.21 or less**. The real figure is on the platform.kimi.ai usage page.

Sources were read on 2026-10-16. `platform.moonshot.ai/docs/*` now returns a 301 to `platform.kimi.ai/docs/*`.

## 1. What Moonshot documents, and what it does not

| Topic | What Moonshot documents | Source |
|---|---|---|
| OpenAI-compatible endpoint | `https://api.moonshot.ai/v1`, Chat Completions format, env var `MOONSHOT_API_KEY` in examples | docs/guide/agent-support (quickstart) |
| Anthropic-compatible endpoint | Base `https://api.moonshot.ai/anthropic`; `POST /anthropic/v1/messages` | docs/api/messages; docs/guide/claude-code-kimi |
| Auth on /anthropic | Only `Authorization: Bearer <key>`; no `x-api-key`. The Claude Code guide sets `ANTHROPIC_AUTH_TOKEN` and says to unset `ANTHROPIC_API_KEY` because it "conflicts with `ANTHROPIC_AUTH_TOKEN`". | docs/api/messages; claude-code-kimi |
| Model ids | `kimi-k3` (the only id in the /anthropic schema enum), `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`. The Claude Code guide uses `kimi-k3[1m]` and lists `kimi-k2.6` "for latency-sensitive simple tasks". | pricing/chat; api/messages; claude-code-kimi |
| **kimi-k2.6 on /anthropic** | **Not documented.** The schema lists only `kimi-k3`. The Claude Code guide implies it works but does not state it. **The smoke run (§4a) is the test.** | — |
| Context | kimi-k2.6: 262,144 tokens in the pricing table; the K2.6 quickstart says "256K". kimi-k3: 1,048,576. | pricing/chat; kimi-k2-6-quickstart |
| Pricing, kimi-k2.6 | $0.95 per M input on a cache miss, $0.16 on a cache hit, $4.00 per M output | pricing/chat |
| Cache writes | Priced only for K3 ($3/M at 5 min TTL, $6/M at 1 h). **No write price is listed for K2.6.** We price a write as a cache-miss input token ($0.95), which is an assumption. | pricing/chat |
| Thinking / reasoning tokens | "`output_tokens`: includes reasoning tokens"; `output_tokens_details.thinking_tokens` gives the reasoning share. **Reasoning is billed as output.** K2.6 has thinking on by default (`{"type":"enabled"}`) and can be turned off with `{"type":"disabled"}` (Chat API). The /anthropic schema has no request-level `thinking` field, but the Claude Code guide shows the endpoint parses it: kimi-k2.7-code returns `400 invalid thinking: only type=enabled is allowed`. | api/messages; kimi-k2-6-quickstart; claude-code-kimi |
| Tool calling (/anthropic) | Supported. `tools[]` takes `name` and `input_schema` (top-level type `object`). `tool_choice` accepts `auto`, `any` or `none`; **forced `tool` is not listed**. In thinking mode, K2.6 accepts only `auto` or `none` ("any other value will result in an error"). | api/messages; kimi-k2-6-quickstart |
| Streaming (/anthropic) | Supported, using Anthropic's SSE events (message_start, content_block_*, message_delta, message_stop) and the deltas text_delta, thinking_delta, signature_delta and input_json_delta | api/messages |
| Prompt caching (/anthropic) | A top-level `cache_control` (`ephemeral`, ttl `5m`/`1h`) is supported. **Markers inside messages are ignored**, not rejected. Caches are per organisation; a hit refreshes the TTL. Usage fields have Anthropic's meaning: `input_tokens` excludes cache reads and writes. | api/messages |
| `output_config.effort` | `low`, `high` or `max` (default `max`); changing it breaks prefix-cache hits. The only model in that schema is K3, and **`medium` is not a value**. | api/messages |
| Sampling | K2.6 fixes temperature (1.0 thinking, 0.6 non-thinking) and top_p (0.95); "any other value will result in an error" | kimi-k2-6-quickstart |
| max_tokens | Required on /anthropic. K2.6 defaults to 32,768. | api/messages; kimi-k2-6-quickstart |
| count_tokens | **Not documented** on /anthropic | api/messages |
| Server tools on /anthropic | **None documented**: no web_search or web_fetch server tools | api/messages |
| `$web_search` builtin | Chat Completions only: `{"type":"builtin_function","function":{"name":"$web_search"}}`. The model returns `finish_reason=tool_calls`, and the client echoes the arguments back as a `role=tool` message. $0.005 per call, plus the search content billed as prompt tokens (a sample used 13,046 tokens). **"expected to be deprecated on October 20, 2026."** The K2.6 quickstart says it is "temporarily incompatible with Kimi K2.6 thinking mode". The web-search guide says K2.6 can search with thinking on, so **the two pages contradict each other**. | guide/use-web-search; pricing/websearch; kimi-k2-6-quickstart |
| Replacement search APIs | `POST /v1/tools/search` (Basic, $0.002/call), `/v1/tools/search_pro` (Pro, $0.003/call), `/v1/tools/fetch` (URL Fetch, $0.002/call), all with Bearer auth. Pro takes `{text_query, limit 1–20, timeout_seconds 1–60, sites?, time_window?}` and returns `search_results[{title,url,site_name,date,snippet,chunks[{text,score}]}]`. Fetch takes `{url}` and returns `{url, markdown, title}`. Calls are billed only when they succeed with results. **Basic's response shape is not documented.** | guide/web-search-best-practice; api/tools-fetch.md; pricing/websearch |
| Rate limits | By cumulative recharge. Tier0 ($1): concurrency 1, **3 RPM**, 500k TPM. Tier1 ($10): 15 concurrent, 100 RPM, 2M TPM. Tier2 ($20) through Tier5 ($3,000): 40–100 concurrent, 100–300 RPM. | pricing/limits |

Not verified anywhere: whether `kimi-k2.6` is accepted on /anthropic, and how /anthropic handles unknown fields. These include `strict` on tools, `metadata`, `betas`, and the `anthropic-beta` header the SDK sends. The smoke run settles both.

## 2. Provider design (no behaviour change for Anthropic)

- **`src/agent/config.ts`** adds three things. First, `providers` is `{ anthropic: { baseURL: undefined, apiKeyEnv: "ANTHROPIC_API_KEY", authMode: "apiKey" }, kimi: { baseURL: "https://api.moonshot.ai/anthropic" (KIMI_BASE_URL overrides), apiKeyEnv: "KIMI_API_KEY", authMode: "authToken" } }`, and each entry also has `countTokens`. Second, `MODEL_REGISTRY` holds provider, prices and context window per model id, with `kimi-k2.6` at $0.95/$4/$0.16 (cache write $0.95, assumed) and 262,144 tokens. Third, `AGENT_MODELS.kimi = "kimi-k2.6"`. `claudeCostDollars`/`modelCostDollars` price by model id and throw on an unknown id. `CLAUDE_PRICES_PER_MILLION` and `CONTEXT_WINDOW_TOKENS` are now derived from the registry and keep their old values for the Claude ids.
- **`src/agent/providers.ts` `createModelClient(model)`** returns `new Anthropic()` unchanged for Claude ids. For kimi it returns `new Anthropic({ baseURL, authToken: KIMI_API_KEY, apiKey: null })`, and `apiKey: null` stops the SDK sending `ANTHROPIC_API_KEY` to Moonshot. That client is wrapped so `create` and `stream` pass every request through **`shapeKimiRequest`**, which:
  - drops `thinking`, temperature/top_p/top_k and betas, and drops `output_config.effort` (our `"medium"` is not a Moonshot value);
  - turns a forced `tool_choice` (`any`/`tool`) into `auto` (`none` is kept);
  - removes `tools[].strict` and strips block-level `cache_control`, keeping the top-level marker;
  - clamps `max_tokens` to 32,768;
  - **throws** on Anthropic server tools rather than dropping them.

  A missing key throws `ProviderConfigError`. Nothing falls back to another model.
- **Run client sites**: `eval/run-agent.ts`, `eval/harness/run-cell.ts` and `app/api/runs/[id]/step/route.ts` call `createModelClient(state.model)`. The public `POST /api/runs` still accepts Anthropic models only.
- **count_tokens preflight** (`src/agent/context.ts`): for a provider with `countTokens: false` it does not call the endpoint. It estimates at 4 characters per token, and the loop writes its existing `token_count_estimated` event with the reason "count_tokens is Anthropic-only; provider kimi has none".
- **Streaming** goes through the SDK's `messages.stream` to Moonshot's SSE. Tested end to end through the real SDK with a fake fetch: thinking, signature and text deltas arrive, the thinking block and its signature are kept in history (Moonshot asks for that), and cost is at kimi prices.
- **Arm D** (`D_agent_kimi`, `normalizeArm("D")`) runs `ARM_MODELS.D_agent_kimi = AGENT_MODELS.kimi` and records, judges and scores exactly like B and C. The Langfuse experiment item records the arm's model.
- **Offline judge** (`eval/harness/judge.ts --model opus|sonnet|kimi`, default opus):
  - sonnet uses the same Anthropic server tools with the Sonnet id.
  - kimi uses `eval/harness/judge-kimi.ts`, which gives the model **client tools with the same names**. `web_search` (max 3) calls Moonshot **Web Search Pro**, and `web_fetch` (max 2 pages, 24,000 characters each, roughly the Opus judge's 6,000-token cap) uses our own plain fetch plus HTML-to-text. A call past a cap gets an error tool_result. The rubric and user prompt are identical to the Opus judge's. The last JSON block is parsed and `settleQ3` applies.
  - Cost is tokens at the model's price plus $0.003 per search that returned results.
  - Comparison verdicts are written to `eval/results/<set>/judge-<model>/<scenario>/` and **never to `eval/truth`** (judgeLead refuses). Their cost goes to `judge-cost-<model>.json`. After judging, an agreement report against the stored Opus verdicts goes to `judge-agreement-<model>.json` and is printed (q1, q2, q3 and good, with each disagreement).
  - **Departure from the brief:** the brief named Moonshot's `$web_search` builtin. I used the standalone Search API instead. `$web_search` retires on 2026-10-20, four days from now. It exists only in OpenAI format, so it would need a second, non-Anthropic judge loop. And one Moonshot page says it does not work in K2.6 thinking mode.
- **Online evidence-only judge**: `src/judges/evidence.ts` provides `evidenceJudge(payload, { model })`. It uses the exact repo prompt (`compileJudgeMessages`: system is RUBRIC.md, user is the question plus the lead JSON) and the same `verdict` tool contract as `calibrate-judge.ts judgeOnce`, with no forced tool_choice. It returns yes, no or cannot_verify per question, or `"invalid"` when no verdict tool was called. `max_tokens` is 1000 for Claude and 4000 for Kimi, because K2.6 thinks by default and reasoning counts against `max_tokens`.
- **`eval/online/calibrate-evidence-judge.ts --model sonnet|kimi`** reads the three `judge-calibration/<judge>` datasets from Langfuse. The access code is copied from calibrate-judge.ts, which is not edited. It runs `evidenceJudgeQuestion` on every item and prints the same `summaryLine` and `mismatchLines`. It writes `eval/results/calibration/<date>/<judge>.evidence-<model>.json`. It also checks that Langfuse prompt v3 matches the repo prompt; a $0 dry run on 2026-10-16 found all three **identical**. Results are not recorded as Langfuse experiment runs. `--run` refuses without the provider's key or when the estimate exceeds `--max-dollars`.

### What Kimi cannot do in our loop (as documented)

1. **No `effort` control.** `output_config.effort: "medium"` is dropped, and K2.6 thinks at its default. The arms therefore do not run at the same reasoning setting. Kimi's thinking is billed as output, at $4/M.
2. **No forced tool_choice** in thinking mode. The loop never forces a tool. The handback call uses `none`, which is allowed.
3. **No count_tokens.** Context trimming runs on the 4 characters per token estimate.
4. **No Anthropic server tools.** The agent loop does not use any, but the offline judge's kimi path needs client tools (above).
5. **Prompt caching is coarser.** Only the top-level marker counts; per-block breakpoints are ignored.
6. **Risk to watch in the smoke run:** `maxTokensForTurn` caps a turn at 8,000 output tokens, and K2.6's thinking counts against that. A long think could hit `stop_reason: max_tokens`, which the loop treats as a run error. Moonshot also documents `stop_reason: null` as possible, which the loop would record as `unknown_stop:null`.
7. **Rate limits.** At Tier0 (3 RPM, concurrency 1) a 30-turn run cannot finish inside `maxActiveMs` (6 min). **Recharge at least $10 (Tier1) before the cells.**

## 3. Files

New: `src/agent/providers.ts`, `src/judges/evidence.ts`, `src/judges/moonshot-search.ts`, `eval/harness/judge-kimi.ts`, `eval/online/calibrate-evidence-judge.ts`, `eval/kimi.test.ts` (23 tests), and this file.
Changed: `src/agent/config.ts`, `src/agent/context.ts`, `eval/run-agent.ts`, `eval/harness/run-cell.ts`, `eval/harness/types.ts`, `eval/harness/judge.ts`, `eval/langfuse/experiment.ts`, `app/api/runs/route.ts`, `app/api/runs/[id]/step/route.ts`, `.gitignore`, `.env.example`.

## 4. How to run (paid; run them in this order and inspect each before the next)

Prerequisites: `KIMI_API_KEY` in `.env` (present as of 2026-10-16) and a Moonshot account at Tier1 or above. Optionally set `KIMI_BASE_URL` (default `https://api.moonshot.ai/anthropic`).

**(a) Smoke run: one run, about $1 or less.** Read its tool calls before running anything else.

```bash
npx tsx eval/run-agent.ts --icp 1 --model kimi-k2.6 --max-cost 1 --approve auto --workspace eval-kimi-smoke --record eval/recordings/kimi-smoke-2026-10-16 < /dev/null
```

Then check `eval/recordings/kimi-smoke-2026-10-16/agent/events.jsonl` for:
- the first `model_call` (`model` should be `kimi-k2.6`, and there should be no 400 from an unknown field);
- `token_count_estimated`;
- every `tool_call` input against the tool schemas: JSON fidelity, `submit_lead` fields, and parallel calls;
- `stop_reason` values, including any `max_tokens` or `null`;
- the per-turn `claudeCost`.

If the first call returns 400, read the message and fix the shaping (§2). Do not retry blind.

**(b) The comparison, 4 cells at ≤ $1 each (≤ $4 in cells).**

```bash
for S in S1 S2; do for A in D C; do
  npm run eval:cell -- --set kimi-vs-sonnet-2026-10-16 --scenario $S --arm $A --rep 1 < /dev/null
done; done
for S in S1 S2; do npx tsx eval/harness/blind.ts --set kimi-vs-sonnet-2026-10-16 --scenario $S; done
# $0 projection first: it prints how many leads would be judged and the projected Opus cost
for S in S1 S2; do npm run eval:judge -- --set kimi-vs-sonnet-2026-10-16 --scenario $S --dry-run | head -1; done
for S in S1 S2; do npm run eval:judge -- --set kimi-vs-sonnet-2026-10-16 --scenario $S --now 2026-10-16 --months 3 < /dev/null; done
npm run eval:score -- --set kimi-vs-sonnet-2026-10-16
```

The Opus judge reuses any `eval/truth` verdict with the same company and URL. A new lead costs **$0.17–$0.44 to judge, $0.28 on average** (live-quotes S1: $2.26 for 8 leads). Up to 40 pooled leads could cost **up to about $11 before reuse**, so the brief's "≤ $6 total" holds only if the dry-run projection is small. Rule: if the projection plus the cells exceeds the budget, judge S1 only (`--scenario S1`) or pass `--limit N`. Each scenario has its own `--months`; S1 and S2 are both 3, from `getV1Plan`.

**(c) Kimi as the offline judge, compared with the stored Opus verdicts. About $0.10 or less.**

```bash
npm run eval:judge -- --set live-quotes-2026-10-14 --scenario S1 --model kimi --limit 3 < /dev/null
```

Verdicts go to `eval/results/live-quotes-2026-10-14/judge-kimi/S1/`, cost to `.../S1/judge-cost-kimi.json`, and agreement to `.../S1/judge-agreement-kimi.json`, which is also printed. Each lead uses at most 3 Moonshot Pro searches ($0.009), 2 page fetches (free) and a few K2.6 turns. Check the first lead's `webSearches` and `webFetches` and its search results before raising `--limit`.

**(d) Evidence-only calibration: 30 items per model.**

```bash
npx tsx eval/online/calibrate-evidence-judge.ts --model kimi --dry-run < /dev/null   # $0 (Langfuse read only)
npx tsx eval/online/calibrate-evidence-judge.ts --model kimi --run --max-dollars 0.7 < /dev/null
npx tsx eval/online/calibrate-evidence-judge.ts --model sonnet --run --max-dollars 0.7 < /dev/null
```

The upper-bound estimates are $0.63 (kimi, with a 4,000-token output budget per verdict) and $0.62 (sonnet). Expected actual cost is about $0.15–0.30 each. Compare with the Opus rounds in `eval/results/calibration/*/judge_q*.json`.

**Expected total:** (a) ≤ $1, (b) ≤ $4 in cells plus Opus judging per the dry-run projection, (c) ≈ $0.10, (d) ≈ $0.6. The total stays at or under $6 only if (b)'s judging is small; otherwise limit (b) to S1.
