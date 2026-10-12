# Prospector v2 — "paste your website, get leads"

Status: DRAFT for review · 2026-10-11 · audience: portfolio / Exa application

## 1. Goal

A seller who doesn't know where to start pastes **one thing** — their website, an Instagram handle, or a sentence — and gets a cited lead list. Structured **cards** (who / why-now / size / stage / geo / recency / exclusions) replace the free-text box; the product pre-fills them from the seller's own business.

Positioning change: v1 was "Exa-only". v2 is **"Claude plans, Exa retrieves"** — every fact in the output is still retrieved and extracted by Exa; Claude only decides *what to ask Exa*.

## 2. Pipeline

```
[0] RESOLVE INPUT        one field → kind ∈ {url, instagram, text}
      url        → normalise to origin
      instagram  → Exa /search for pages citing the handle ("@h", "instagram.com/h")
                   → pick the brand's own domain (bio link / linktree / press)
                   → none found: ask the user for one sentence (explicit, not a guess)
      text       → used directly as the seller description
[1] SELLER PROFILE       Exa: category:"company" lookup + /contents on the seller origin,
                         summary.schema = {offering, buyer_type, buyer_roles, price_band,
                         geo_served, existing_customers[], competitors[]}
[2] SUGGEST CARDS        Claude (claude-opus-5-5, structured output): profile → card values
                         + one-line rationale per card + 2 alternative ICPs
[3] USER EDITS CARDS     UI; every card editable; "why this?" shows the rationale
[4] COMPILE PLAN         Claude (structured output): cards → SearchPlan (§4)
                         then deterministic validation + cost estimate shown before run
[5] EXECUTE              generalised v1 pipeline driven by SearchPlan (no per-ICP code)
[6] RESULTS              table, per-field provenance badges, CSV export
```

## 3. Cards → Exa levers (UI must show hard vs estimated)

| Card | Exa lever | Kind |
|---|---|---|
| Why now (funding, hiring role X, new location, launch, new exec, compliance) | signal query templates; optional follow-up probe (generalises v1 ICP 3's ops-hire probe) | primary |
| Recency | `startPublishedDate` on signal search | **hard** |
| Industry / what they do | query text + generated boolean gate in company schema | estimated |
| Company size | `employee_estimate` gate; user picks unknown-policy | estimated |
| Funding stage | trigger (hard-ish) or extracted gate (estimated) | estimated |
| Geography | query text + HQ gate | estimated |
| Exclusions (customers, competitors, giants) | `excludeDomains` + name denylist | **hard** |

## 4. SearchPlan (replaces hand-written IcpConfig)

```ts
type SearchPlan = {
  label: string;
  months: number;                       // 1..12
  signalQueries: string[];              // 3..8, meaning-phrased
  signalSummaryQuery: string;
  followUp?: { queryTemplate: string; summaryQuery: string }; // "{company} ..."
  companySummaryQuery: string;
  gateFields: { key: string; question: string; required: boolean }[]; // → dynamic boolean schema props, ≤6
  employeeRange: { min: number; max: number; unknownPolicy: "allow-if-not-enterprise" | "reject" };
  hqCountries: string[];                // ISO-2; [] = any
  excludeDomains: string[];
  excludeNames: string[];
};
```

- `COMPANY_SCHEMA` becomes generated: fixed core (description, industry, employee_estimate, is_public_or_enterprise, hq) + one boolean per `gateFields[i]`.
- Validation: zod schema; caps on query count, months, gate count; reject plan → re-ask Claude once with the validation error, else surface error (no silent default plan).

## 5. Generalising the engine (the real work)

- `runProspecting(plan: SearchPlan, …)` — remove `icp.id === 3` branch (→ `plan.followUp`).
- `score.ts`: delete per-ICP term lists (FIRMOGRAPHIC_TERMS, PAYMENTS_COMPANY_TERMS, EXCLUDED_COMPANIES …). Fit = generated gates + size + geo; signal strength = Exa summary `signal_type` matched against the chosen trigger; freshness unchanged.
- v1 ICP 1–3 configs move to `eval/fixtures/` as golden card sets.

## 6. Eval gates (portfolio = rigour is the product)

1. **Regression (blocking), two stages so a failure is attributable:**
   - **6.1a engine (after T2):** hand-translated ICP-1 `SearchPlan` fixture → generic engine must score **≥ v1 hand-tuned (~8/10)** and pass deterministic checks (date in window, URL resolves, entity match, net-new). The fixture excludes only the enterprise denylist, not v1's hand-curated off-profile list — generic gates must catch those firms themselves. Exa cap $1.00.
   - **6.1b planner (after T5):** ICP-1 *card set* → Claude-compiled plan → same bar. If 6.1a passes and 6.1b fails, the planner is at fault.
   Discrepancy vs v1 is a bug to root-cause, not variance.
2. **Planner eval:** 6 seller inputs (B2B SaaS, agency, SG B2B services, D2C IG brand, marketplace, sentence-only) → judge card suggestions on a written rubric (Opus judge + my review).
3. **IG resolution:** hit rate on 10 real handles; report it, don't hide it.
4. **Cost:** log Exa + Claude cost per run; target < $0.50/run.

## 7. Safety & ops

- Seller-site text reaches Claude → treat as data (system prompt says so); blast radius is bounded because the plan can only become validated Exa queries.
- Fold in the two pushed-commit findings: generic 500 message + server log; `http(s)`-only link rendering.
- Public deploy: per-IP rate limit + daily spend cap on the server keys.
- New env: `ANTHROPIC_API_KEY` (server only). Claude calls: `claude-opus-5-5`, structured outputs, effort `medium`, server-side `fallbacks: "default"`.

## 8. Assumptions — T0 probe results (2026-10-11, `eval/probe-v2.mjs`, $0.049 spent, n is tiny)

- A1 seller profile from homepage — **PARTIAL (1/3).** lovebonito.com: clean profile. thesmartlocal.com (media homepage): `offering` came back as the *string* `"null"`. hitpay.com: `CRAWL_UNKNOWN_ERROR` — and the wrong input; the real domain is hitpayapp.com.
  → Design change: profile = homepage + about/pricing subpages (`subpages`), merged; normalise `"null"`/whitespace; if `offering` still empty, ask the user for one sentence.
- A2 generated per-run schema — **VERIFIED (3/3).** Dynamic boolean gates returned as real booleans.
  → But `signal_type` echoed the prompt ("why-now") and `signal_date` formats vary ("2026-04-15", "Oct 1, 2026"); one event date predates the publish window. Signal summary needs an enum `signal_type`, ISO-date normalisation, and freshness judged on the event date.
- A3 Instagram → owned domain — **VERIFIED 3/3 as top candidate** (lovebonito.com, thesmartlocal.com, hitpayapp.com), with noise (linkedin, zaver.one, unrelated hitpay.org).
  → Rank candidates by frequency + brand-name match, and show "Is this you?" confirmation; never auto-commit.
- A4 Generic gates match v1 precision — **UNTESTED**; gate 6.1 decides it.
- FB (side question): Exa **does** index some *public* group posts — 6/10 facebook.com results were group posts; /contents returned real post text for 1/2, the other only login-wall chrome. Only 3/10 carried a `publishedDate`. Private groups: not reachable. → Out of v2 scope; candidate v2.1 "buyer-intent" source (e.g. "looking for a 3PL recommendation" posts), patchy and undated.
- Cost reference: `/contents`+summary ≈ $0.001/page; `/search` $0.007 base; search+3 summaries $0.010.

## 9. Tasks & model routing

| # | Task | Owner model | Why |
|---|---|---|---|
| T0 | Probe A1–A3 against live Exa (script) | gpt-5.5 (codex) | mechanical; I judge results |
| T1 | SearchPlan types, zod validation, generated company schema | gpt-5.5 | clear spec |
| T2 | Generalise pipeline + score.ts; move v1 configs to fixtures | gpt-5.5 | clear spec, large mechanical diff |
| T3 | Regression eval harness (gate 6.1) + run | gpt-5.5 build, **fable judges** | gate judgment is orchestration |
| T4 | Input resolver + seller profile (Exa) | gpt-5.5 | clear spec |
| T5 | Claude planner + compiler prompts & calls | opus-4.8 | prompt quality = taste |
| T6 | Cards UI, onboarding flow, provenance badges, CSV | opus-4.8 | user-facing, taste ≥7 |
| T7 | Security fixes, rate limit, spend cap | gpt-5.5 | mechanical |
| T8 | Planner eval (gate 6.2) | opus-4.8 judge + fable review | |
| T9 | Review of full diff | opus-4.8 + codex review | independent perspectives |
| T10 | README rewrite ("Claude plans, Exa retrieves") | opus-4.8 | copy |

Order: T0 → (T1,T4,T7 parallel) → T2 → T3 **gate** → T5 → T6 → T8 → T9 → T10.
