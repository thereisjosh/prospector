# Prospector — Build Spec  (v2, verified against live Exa API 2026-09-24)

**What it is:** A natural-language B2B prospecting POC on the Exa API. Input an ICP in plain English; it finds companies via a **fresh, dated, verifiable "why-now" trigger** and returns a structured, cited brief per company. Exa-only (no other LLM in the MVP). Built as an FDE practice POC against the Northwind / "Priya" scenario.

---

## 1. Acceptance criteria (= Priya's 8/10 bar)
Per ICP, top **10–15 companies** where: ≥~70% genuinely fit the firmographic ICP **and** have a real trigger; **every** why-now signal is real, within the ICP freshness window, and has a **clickable source URL + date** that resolves; coverage includes **net-new** companies (not on the Apollo baseline, ICP 1); **low wrong-company/stale rate** (the company named actually matches the signal entity). Accuracy + net-new > volume.

---

## 2. Inputs (see `REQUIREMENTS.md` for full ICPs)
| # | ICP | Window | Trigger |
|---|---|---|---|
| 1 | Mid-market logistics/3PL scaling ops (~100–1,000 emp, US/UK) | ~3 mo | ops hiring wave / new facility / volume growth |
| 2 | B2B SaaS/marketplace that just launched/expanded payments-billing (~100–800, US) | ~3 mo | payments launch / billing-ops hire / finance-ops exec |
| 3 | Newly funded (seed/Series A ≤6mo) hiring first Ops/RevOps (~30–200, US) | ~6 mo | funding announcement + "first ops hire" posting |

Apollo baseline (ICP 1) = static CSV/JSON of the "obvious big" names to beat on net-new. **Fit = firmographic match AND a real current trigger.**

---

## 3. Architecture / pipeline  (VERIFIED — see §8)

> **Signal-first.** The `company` index is semantic-only and **rejects `startPublishedDate`** — so freshness is filtered on the **trigger** search (general index), then the company is enriched. This also matches the customer need: the trigger *is* the point; the company falls out of it.

```
[1] SIGNAL SEARCH per ICP → POST /search   (general index — NO category)
      query:  the TRIGGER phrased for meaning
              e.g. "logistics/3PL company hiring a wave of operations manager roles"
      type:   A/B — "neural" (default, richest) vs "fast" vs "deep"; "keyword" = baseline
      startPublishedDate: today − (3 or 6 months per ICP)   ← ISO-8601, works on general index
      numResults: 15–25 (over-fetch, rank down)
      contents:
        text:       { maxCharacters: ~500 }
        highlights: { query: <trigger>, numSentences: 2 }
        summary:    { query: "the why-now signal + its date", schema: <SIGNAL_SCHEMA> }
        livecrawl:  "fallback"
      → each result: id, title, url, publishedDate, text, highlights, summary
        (url + publishedDate = the verifiable dated source — Priya's bar, for free)

[2] ENRICH company → POST /search  category:"company"  (NO date)
      For each company named in a signal, one company-category lookup:
        contents.summary.schema = { description, hq, ... }   (also returns entities + image)
      Firmographic fill + fit check. Skip if the signal already carries enough.

[3] SCORE + RANK  (YOUR logic — the moat, not Exa's)
      confidence = firmographic-fit × signal-strength (funding > hiring-wave > single post)
      freshness  = recency of signal publishedDate within the ICP window
      dedupe by domain → rank → keep top 10–15

[4] VERIFY flagged rows → POST /contents  livecrawl:"always"  (slow/costly → only rows going to the customer)
      + wrong-company check: does the company named match the signal entity?

  (MVP uses NO /answer, NO /findSimilar (deprecated), NO Anthropic — Exa's summary does synthesis.)
```

---

## 4. Output row schema
```json
{ "company":"str", "one_liner":"str", "fit_reason":"str",
  "why_now_signal":"str", "signal_source_url":"str", "signal_date":"YYYY-MM-DD",
  "confidence_score":0.0, "freshness_score":0.0, "net_new":false }
```
`SIGNAL_SCHEMA` (for `summary.schema` on step 1) extracts: `{ company_name, signal_type, signal_summary, signal_date }`.

---

## 5. Eval harness (build FIRST). Open-ended discovery → no golden exact-match. Three layers:
- **Deterministic (no LLM):** `date_in_window` · `url_resolves` (livecrawl) · `name_matches_signal` (wrong-company gate) · `net_new` (set-diff vs Apollo).
- **Rubric (human for MVP):** you score fit / signal-real / on-point against the ICP — you're the judge, like Priya. (Automated LLM judge = stretch, needs Anthropic key.)
- **Recall set:** handwritten known-positives per ICP → did it surface them.
- **0–10 map:** 0–2 junk/all-obvious/stale; ~5 half-hit, manual verify; **8 = pass** (fit ≥70%, signal-real ≥80%, freshness 100% in-window, url_resolves 100%, wrong-company ~0, net-new present); 10 = finds what a rep couldn't.
- **Tooling:** deterministic checks = Vitest; run **live** on the 3 real ICPs (mock data only tests plumbing).

---

## 6. Tech stack (Exa-only MVP)
- **TypeScript/Node.** Raw `fetch` to `$EXA_BASE_URL` with header `x-api-key` (or Exa TS SDK if it covers it).
- `pipeline.ts` (steps 1–4) · `score.ts` (ranking) · `eval/` (harness) · CLI entry: ICP id → ranked JSON+CSV.
- **UI (stretch):** minimal Next.js page (input → results table w/ clickable sources) — the demoable artifact; MVP is CLI-first.
- **Secrets:** `.env` → `EXA_API_KEY`, `EXA_BASE_URL`. (Anthropic = stretch only.)
- **Cost:** log `costDollars` per call; use `neural`/`fast` + `livecrawl:"fallback"` for bulk, `deep`/`always` only on flagged rows.

---

## 7. MVP vs stretch
- **MVP:** steps 1–4 as CLI, ranked JSON/CSV per ICP, eval harness (deterministic + human rubric + recall) live on 3 ICPs, hit 8/10 on ICP 1.
- **Stretch:** Next.js UI · `neural/fast/deep` A/B report · CSV export · automated LLM judge (Anthropic) · live "verify" button.

---

## 8. VERIFIED against live API (probes, 2026-09-24)
- **`type`** valid = `auto | keyword | neural | fast | deep`. Default → neural (richest: +publishedDate/author/score). `deep` pricier ($0.012 vs $0.007). A/B = neural vs fast vs deep; keyword = leaner baseline.
- **`category:"company"`** valid BUT **semantic-only → rejects `startPublishedDate` (400)**. Returns `entities` + `image` + (with `summary.schema`) structured firmographics.
- **Freshness:** `startPublishedDate` (ISO-8601, e.g. `2026-06-24T00:00:00.000Z`) works on the **general** index (no category) → filter freshness on the signal search.
- **`contents`** = `{ text:{maxCharacters}, highlights:{query,numSentences}, summary:{query,schema} }` all work. `summary.schema` = JSON-schema structured output (verified). **`livecrawl:"fallback"`** verified (also `auto`/`always`; `always` slow+costly → flagged rows only).
- **`costDollars`** returned per call (search ~$0.007 neural / $0.012 deep; +$0.003 summary) — log it.
- Prior: `/findSimilar` **deprecated** (use `/search`); `/answer` = `answer`+`citations`+`costDollars` (unused in MVP).
- Base `https://api.exa.ai`, POST, header `x-api-key`. Response top-level: `requestId, resolvedSearchType, results, searchTime, costDollars`.

---

## 9. Model routing (standing rule, per task)
| Task | Nature | Route |
|---|---|---|
| `pipeline.ts` (steps 1–4), `score.ts`, CLI | clear-spec API plumbing on verified schema | **gpt-5.5 via codex** (`codex-implementation`) |
| Eval harness (Vitest deterministic + recall) | clear-spec, mechanical | **gpt-5.5 via codex** |
| `SIGNAL_SCHEMA` + summary `query` wording (extraction quality) | small taste/judgment | **you + me** draft; codex wires |
| Next.js UI (stretch) | taste ≥7 | **opus-4.8 / sonnet-5** subagent |
| Spec, acceptance gate, output review vs Priya's bar | orchestration | **session model (you + me)** |

---

## 10. Risks / notes
- **Cost (Priya's concern):** `deep` + `livecrawl:"always"` are the expensive knobs — bulk on `neural/fast` + `fallback`; escalate only on flagged rows. Log `costDollars`.
- **Wrong-company check is load-bearing** — customer's #1 fear, cheapest trust win → first-class deterministic gate.
- **Freshness = publish date of the signal page** (a good proxy). Signal-first makes this clean: the trigger page's `publishedDate` is the date.
- **Company firmographics** (size, exact HQ) may be thin from the open web — company-category `entities`/summary help; accept some gaps in the POC.
