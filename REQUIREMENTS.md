# Prospector — Customer Requirements (Northwind / "Priya")

Source: FDE discovery call. This is the POC input + the eval target. See `SPEC.md` for the build.

**Customer:** Northwind — Series B B2B SaaS (~$40M ARR) selling **operations software to mid-market**. Their edge is *timing* — reaching a company right when its ops function is straining.

**"Fit" = firmographic match AND a real, current why-now trigger.** No trigger = not a fit.

**Test method:** for each ICP below, return **top 10–15 companies**; score live against the 0–10 bar in `SPEC.md §1/§5`.

---

## ICP 1 — Logistics ops, scaling now *(primary)*
- **Plain:** mid-market logistics / 3PL / freight / last-mile companies visibly scaling operations right now.
- **Firmographics:** ~100–1,000 employees · logistics/3PL/freight/last-mile · US (UK ok).
- **Trigger (why-now):** hiring wave for ops / operations-manager / VP-Ops roles, OR a new warehouse/facility, OR volume/ops-growth posts — **last ~3 months**.
- **Good:** ~300-person 3PL that just posted 8 ops roles + announced a new DC.
- **Bad:** DHL/FedEx (too big); a logistics co with no growth signal.
- **Signal query seed:** *"logistics or 3PL company hiring a wave of operations manager roles / opening a new warehouse"*

## ICP 2 — Just launched/expanded payments or billing
- **Plain:** companies that just launched or expanded payments/billing/monetization (→ ops & reconciliation get messy = us).
- **Firmographics:** B2B SaaS or marketplaces · ~100–800 employees · US.
- **Trigger:** payments/billing feature launch, OR hiring payments/billing/revenue-ops engineers, OR a finance-ops exec hire — **last ~3 months**.
- **Good:** 250-person vertical SaaS that just launched embedded payments + is hiring a billing-ops lead.
- **Bad:** a payments company itself; no recent signal.
- **Signal query seed:** *"B2B software company launched embedded payments or billing, hiring billing operations"*

## ICP 3 — Newly funded, hiring first Ops/RevOps
- **Plain:** B2B companies that raised seed/Series A in the last ~6 months AND are hiring their **first** Ops/RevOps/BizOps person.
- **Firmographics:** B2B · post-seed/Series A · ~30–200 employees · US.
- **Trigger:** funding announcement (≤6 months) **+** a "first ops/RevOps hire" job posting.
- **Good:** Series-A fintech that raised 3 months ago posting "Head of RevOps (first hire)."
- **Bad:** already has a big ops team; funding is 2 years old *(the stale-signal disaster to avoid)*.
- **Signal query seed:** *"recently funded seed or Series A B2B startup hiring its first RevOps or operations lead"*

---

## Apollo baseline — ICP 1 (the set to BEAT on net-new)
Stand-in for "what Apollo returns": the obvious big names, no timing signal. Net-new = surfacing *smaller, clearly-scaling* companies NOT on this list, each with a real trigger. *(Replace with a real Apollo export if available.)*
```
DHL Supply Chain, FedEx Logistics, XPO Logistics, C.H. Robinson, Ryder System,
DSV, Kuehne+Nagel, DB Schenker, GEODIS, Expeditors, J.B. Hunt, Penske Logistics,
UPS Supply Chain Solutions, Uber Freight, Flexport
```

---

## Output per company (see SPEC §4)
`company · one_liner · fit_reason · why_now_signal · signal_source_url · signal_date · confidence · freshness · net_new`

## Acceptance (Priya's 8/10)
Most fit the nuanced ICP · every signal real + in-window + with clickable source URL/date · includes net-new vs the Apollo list · low wrong-company/stale rate · **accuracy + net-new > volume**.
