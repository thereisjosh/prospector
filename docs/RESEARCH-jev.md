# Jev (TypeSafe AI) for Prospector's classification jobs

Researched 2026-10-16 from docs.typesafe.ai (WebFetch summaries of the pages below; where a page was paraphrased rather than quoted, the facts are as the fetch tool reported them). No API key existed when this was written (live runs happened later the same day, see Results at the end): at the time nothing here had been run against the live API. Everything in the adapter (`src/judges/jev.ts`) is tested against fakes that follow the documented schema, so the first live call is the real verification of the schema.

## Verdict

Jev can replace the **evidence-only judges** (lead Q1/Q2/Q3 online judges, "is this title on this page a current role", "is this URL a job listing", handback-reason classification) at roughly 1/1000 of the cost of an Opus call, if calibration shows it matches the human labels. It cannot replace anything that writes text, calls a tool or browses. **Jev cannot produce the quotes our gates require** (`evidence.quote`, `title_quote`): it returns a label and a probability, never a span of text. So it can only judge evidence the code already extracted; it never produces evidence.

## API facts (documented)

| Item | Value | Source |
|---|---|---|
| Base URL | `https://api.typesafe.ai` | /api.md, /introduction/quickstart.md |
| Endpoint | `POST /v1/systemone` (one endpoint for all question types) | /api.md |
| Auth | `Authorization: Bearer <API_KEY>`, `Content-Type: application/json` | /api.md |
| Get a key | console.typesafe.ai/keys (SDKs read `TYPESAFE_API_KEY`) | /introduction/quickstart.md |
| Model ids | `jev-1.13.0`, `jev-1.14.0` (since 2026-10-14); aliases `jev-latest` (= 1.13.0, SDK default) and `jev-preview` (= 1.14.0). Aliases move; versioned ids are accepted in requests | /models.md |
| Request | `{ "state": string \| object \| array, "model": string, "questions": { "<id>": Question } }`. Question ids are yours; the model never sees them | /api.md |
| Response | `{ "model": string, "answers": { "<id>": Answer }, "usage": { "input_tokens": int, "output_tokens": int } }` | /api.md |
| Pricing | $42 per billion input tokens ($0.042 per million). Output tokens free. Same for 1.13 and 1.14 | /models.md |
| Context | 64k tokens per request (state + all questions); 32k per question (state + that one question). No limit on question count within those. Header `TypeSafe-Danger-Zone-Long-Context: true` raises both to 262k (slower, less accurate, same price) | /models.md |
| Body size | 32 MiB, UTF-8 JSON, nesting <= 64. gzip / zstd `Content-Encoding` accepted | /api.md |
| Input | Text only (strings, objects, arrays). English is best; other languages (CJK) lower accuracy | /concepts/state.md, /models.md |
| Errors | 400 (incl. `max_tokens_exceeded`), 401, 413, 415, 422 (names the field), 429, 529 (overloaded) | /api.md |
| Rate limits | Per organization, in tokens/s and requests/s; current values are in the developer console. 429 on excess; SDKs retry with backoff and honour `retry-after`. Higher limits via sales@typesafe.ai. **No numbers are published** | /models.md |
| SDKs | Python `typesafe-sdk` (`TypeSafeClient.system_one`), JavaScript `@typesafe-ai/sdk` (`TypeSafeClient.systemOne`), HTTP. Plus an agent skill page. We use plain `fetch`, no SDK dependency | /introduction/quickstart.md, /sdk.md |
| Privacy | Privacy policy states a commitment not to train models on user data. Enterprise customers can get zero data retention (ZDR) via sales@typesafe.ai. A data processing agreement covers retention; **the retention period is not stated on the legal index page** (it links to the DPA, which I did not read) | /legal.md |

### Question types

- **Choice** `{ type: "choice", instructions, criteria: { "<option>": description \| null } }`: up to 255 options. Answer `{ type: "choice", choice, probabilities: {option: p, sum 1}, confidence: 0..1 }`. Add an "other / none" option when the list may not be exhaustive.
- **Noul** `{ type: "noul", instructions, criteria?: { true, false } }`. Answer `{ type: "noul", noul: 0..1 }` = probability the answer is yes. **No confidence field**; distance from 0.5 is the uncertainty.
- **Score** `{ type: "score", instructions, criteria: [level descriptions, 2..10, ordered low to high] }`. Answer `{ type: "score", score: probability-weighted level (fractional), legend, probabilities, confidence }`. The model sees descriptions, not the numbers.
- **Box** (image regions): irrelevant to us.
- `instructions` and each criterion/description can be a string, object or array (structured instructions are supported; field names are ours).

### Batching

Many questions in one request, all against one `state`; they are evaluated in parallel and independently (/primitives/choice.md, /cookbooks/parallel_questions.md). The state is sent and billed once: the cookbook measured a 13-question single call as about 12x cheaper and 10x faster than 13 calls with the same document, with matching answers. Billing is per request input tokens (state + all questions' text), so per-call `usage.input_tokens` is the cost basis (`jevCostDollars`).

### Confidence

- Computed from the probability distribution (1 = all mass on one outcome, 0 = spread evenly); it describes concentration, not correctness (/confidence.md). For Score it also accounts for distance between levels. Noul has none.
- Docs recommend three bands: high = act automatically, medium = proceed with care / confirm, low = do not act (human, clarification, fallback), with thresholds scaled to risk; their example floors at 0.5 and requires > 0.9 for a high-stakes action. They say to start conservative and tune on your own data.
- Noul guidance: ~0.5 when yes/no errors cost the same; raise the threshold when a false yes is expensive; send the middle to a person. Their routing example uses 0.8 / 0.2 (/primitives/noul.md). Our adapter uses those 0.8 / 0.2 values for the contact judge as **placeholders, not calibrated**.
- "Higher confidence alone doesn't show a description is correct" (Score page): calibration against our labels is the only evidence.

## Not documented / unverified

- **Latency**: the "70-500 ms" claim is not on /models.md (which gives no latency figures, only "long context is slower"). Unverified; measure on the first live call.
- **Rate-limit values**, **ZDR / retention periods**, **uptime / SLA**: not published in the pages read.
- **Accuracy on our tasks**: nothing; that is what the calibration run measures. The docs publish a "Jev 1.13 jaggedness" page (/model-jaggedness/jev-1.13.md) that lists known weak spots; **not read**, read it before trusting a result.
- **Early-access terms** (since 2026-09-15 per Joshua): not on the pages read.
- The API reference's `usage.input_tokens` is assumed to include the question text (the docs say each option and question costs tokens); the adapter bills exactly what `usage` reports.
- Whether `state` as a JSON object is tokenized more expensively than the same content as text: not documented. We send objects (the docs' recommended form).
- Pages I did not read: /primitives/advanced.md, the cookbooks other than parallel questions, /patterns/*, the SDK pages, /model-jaggedness/jev-1.13.md, the DPA itself. `docs.typesafe.ai/llms.txt` lists them all.

## Job mapping

| Job | Fit | Jev shape | Notes |
|---|---|---|---|
| Lead judge Q1 / Q2 / Q3 (evidence-only; today the Langfuse online judges `judge_q1..3`, Opus) | **Fits** | 3 Choice over `yes / no / cannot_verify`, one request, state = `JudgePayload` incl. `evidence` | Implemented: `jevLeadJudge`. The rubric rules (eval/online/judge-prompt.ts `RULES`) go in each question's `instructions`. The online judge already cannot browse, so there is no capability loss. Opus also writes reasoning; Jev returns only probabilities, so mismatches have no free-text explanation. |
| Contact: "is this title on this page a current role" | **Fits** | 1 Noul; state = `{ page: {url, published, text}, candidate: {name, title, company} }` | Implemented: `jevContactCurrent`. Evidence-only (no web), so it answers "does this page show a current role", which is narrower than the Opus judge that searches. |
| "Is this URL a job listing / aggregator" | **Fits** (not built) | 1 Noul over URL + title + first N chars of page text | Cheap, would replace a heuristic or an LLM call; needs a labelled set before swapping. |
| Handback-reason classification | **Fits** (not built) | 1 Choice over the closed reason set (+ "other") | Closed taxonomy, short text. |
| Offline lead judge (Opus, web_search/web_fetch) | **No** | | Verifies on the live web; Jev has no tools or web. Stays the authority (RUBRIC change log 2026-10-14). |
| Agent loop | **No** | | Needs tool calls and free text. |
| Planner (search plan from the user's brief) | **No** | | Generates structured text/plans. |
| Exa summariser jobs (people extraction with `title_quote`, page summaries) | **No** | | Must copy a quote from the page; Jev cannot emit text. Our gates verify quotes by substring match, so anything quote-shaped stays on a generative model. |

Design rule: Jev sits **after** extraction and **before** nothing that needs a string from it. Anything it says is a label plus a probability; gates stay deterministic.

## What was built (all behind `--model jev` / explicit calls; fakes only so far)

- `src/judges/jev.ts`: `jevAsk` (documented wire format, 429/529 retry with backoff, strict response validation, cost from `usage.input_tokens`), `jevLeadJudge`, `jevContactCurrent`. Missing/blank key throws `JevConfigError` before any request; there is no fallback.
- `eval/online/calibrate-judge.ts --model jev`: same three datasets, same report, same Langfuse experiment recording (model recorded as `jev-1.13.0`, run name prefixed `jev · `). `--run` refuses to start without `JEV_API_KEY`; `--dry-run` answers from a local fake (always "yes"), so it checks plumbing, not quality. Each item asks only its own question (one dataset = one question).
- `eval/harness/judge-contacts.ts --model jev`: the 45 verified contacts of `contact-eval-2026-10-16`, each joined to the recorded Exa page text of its evidence URL (all 45 resolve), one Noul each, agreement printed against the Opus verdicts in `contacts-v1-*.jsonl` (currently only 1 exists: Capacity LLC / Karim Fofana).
- `eval/online/judge-prompt.ts`: added `judgeQuestionText()` (exports the existing title/rules so there is one copy).

## Commands once a key exists

Put `JEV_API_KEY=...` in `.env` (and `JEV_BASE_URL` only if routing through a proxy).

```
# $0 plumbing check (no key, no network beyond Langfuse reads)
npx tsx eval/online/calibrate-judge.ts --model jev --dry-run --judge judge_q3
# $0 estimate for the real round
npx tsx eval/online/calibrate-judge.ts --model jev
# first paid call: ONE item, read the raw report before anything else
npx tsx eval/online/calibrate-judge.ts --model jev --run --max-dollars 0.01 --judge judge_q1 --item <company substring>
# the full round (3 datasets)
npx tsx eval/online/calibrate-judge.ts --model jev --run --max-dollars 0.05
# contacts: one first, then all 45
npx tsx eval/harness/judge-contacts.ts --model jev --limit 1
npx tsx eval/harness/judge-contacts.ts --model jev
```

## Expected cost

Jev bills input tokens only, $42 / 1e9.

- **One calibration round (3 datasets)**: a lead payload plus one question's rules is about 6-7k characters, about 3k tokens at the repo's conservative 2.2 chars/token (the 2026-10-14 Opus round averaged 6.8k prompt chars per call) = about $0.00013 per item. Dataset sizes live in Langfuse and were not read, so for 10-30 items per dataset: **about $0.004-$0.012 for the whole round**, against about $0.26 for one Opus judge_q1 round. The `--model jev` estimate (no `--run`) prints the exact upper bound from the real dataset.
- **45 verified contacts**: measured from the recordings, 245k characters of page text (+200 chars of candidate JSON each) = about 111k tokens at 2.2 chars/token = **about $0.0047** (plus about $0.0006 of question text, so **about $0.005**). The Opus run was $0.14 per contact (about $6.30 for 45).
- Caveat: tokens are estimated from characters, not counted by Jev's tokenizer; the live `usage.input_tokens` is what the run reports and what `spent` sums.

## Risks to check on the first live calls

1. Does the live response match the documented schema (the adapter throws on any mismatch rather than guessing).
2. Latency and 429 behaviour at the default rate limit.
3. Calibration against the human labels, per category, before any gate or routing uses a Jev verdict; thresholds for confidence-gating (cannot_verify when confidence is low) are untuned.
4. Early-access stability: the model alias moves; we pin `jev-1.13.0`.

## Results (2026-10-16, live API, `jev-1.13.0`)

Full tables: `docs/EVAL-DETAIL.md` "Smallest model per job (2026-10-16)".

- **Schema held:** the adapter's strict response validation did not throw on the live calls (calibration and contacts completed with 0 errors in `eval/results/calibration/2026-10-16/judge_q*.json`).
- **Calibration, 10 labelled items per question** (`judge_q1.json`, `judge_q2.json`, `judge_q3.json`): Q1 6/10, Q2 8/10, Q3 8/10, total $0.00191 ($0.000624 + $0.000624 + $0.000662); a one-item check on Sybill cost $0.00007. For comparison: Opus on the same evidence 7/8/8 for $0.81 (commit messages only; the per-item file was overwritten by this run), Sonnet 7/8/8 $0.39, Kimi 7/8/9 $0.18.
- **Confidence behaved as the docs warn.** A 0.4 floor drops 2 of 30 answers (Q1 Miter 0.30, Q1 Away Team 0.33), both wrong. But Jev was wrong at 0.98 on Hollingsworth Logistics (Q1 and Q2, `cannot_verify` where the human label is `yes`), 0.97 on Capacity LLC Q2 (`yes`, label `cannot_verify`) and 0.72 on Miter Q3 (`no`, label `yes`). Concentration is not correctness. The Hollingsworth miss is shared by Opus-class models too: the label needed a page fetch the evidence did not contain.
- **Contacts:** 45 verified contacts, one Noul each, $0.003265 total (`eval/results/contacts/jev-contacts-2026-10-16T13-50-12-202Z.jsonl`): 36 yes, 9 `cannot_verify`. `pFound` for the 9 spans 0.42 to 0.73; for the 36 yes, 0.81 to 0.97, a clean split on this set. Agreement with the Opus contact judge: 1 of 1 (Capacity LLC / Karim Fofana, `contacts-v1-2026-10-16T12-52-10-257Z.jsonl`, $0.1447). The other 44 have no second opinion and no human label.
- The projected cost held: about $0.005 for 45 contacts (actual $0.0033), about $0.004 to $0.012 for the round (actual $0.0019).

### Open items

1. **Jaggedness page unread:** `/model-jaggedness/jev-1.13.md` (known weak spots) has still not been read. Read it before any gate or routing uses a Jev verdict.
2. **Latency and 429 behaviour** were not recorded in the result files; the run files carry cost only. Measure on the next live run.
3. **Thresholds untuned:** 0.4 for lead judges is chosen on 30 items; the contact judge's 0.8 / 0.2 are the docs' placeholders. A labelled contact set (the 45 verified contacts have none) is needed to say how many of the 36 yes are right.
4. **Early-access terms, ZDR, rate limits and the DPA retention period** are still unread or unpublished.
5. **Not built:** job-listing detection and handback-reason classification (section "Job mapping").

