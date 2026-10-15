# Gate Replay Projection - 2026-10-15 (third-party job-listing rule)

Scope: every judged lead (verdict in `eval/truth/S1|S2/*.json`) in `eval/results/{pilot-2026-10-12,live-quotes-2026-10-14,memory-eval-2026-10-15,memory-eval-2026-10-15b}/**`; each lead is counted once per run (rep) it appeared in. No Exa or Anthropic calls are made ($0).

**Simulation limits (exact).** (1) Pilot lead summaries (only) predate the quote fields: none carries `signal_quote`, `signal_date_quote`, `<gate>_quote` or `hq_quote`, so no quote rule can be evaluated against a fresh summary; Layer 1 therefore runs the NEW `checkLead` with `evidenceMode: "skip-quotes"`, and Layer 2 only counts which accepted leads would lack a quote. (2) Lookup page text was not recorded in the pilot state, so `quote_not_in_page` on lookup-page quotes (employee source, HQ, gate quotes) cannot be replayed for any lead. (3) Workflow-arm (`A_workflow`) `run.json` files persist only company, signal URL, why_now, event_date and size_basis: no signal summary, signal text, title, enrichment or lookup. For those leads only the rules that need nothing but company name and signal URL run (built-in/plan excluded domains, personal-profile URL, plan exclude names, placeholder/job-board names); hiring-by-roles, entity match, HQ, size, enterprise, gates and all quote rules are reported unverifiable per lead, not the lead dropped. (4) The signal-page text used for entity/hiring checks on agent-arm leads is the recorded Exa page text; the live-Exa behaviour of the quote rule is unproven until a paid run.

OLD side: `eval/replay/gates-head-62321c3.ts` is byte-identical to `git show 62321c3:src/gates.ts` apart from its provenance comment and import paths (checked at replay time); it is used as the OLD side.

Good/bad = the scorer's rule (`eval/harness/score.ts` leadGood: q1 and q3 yes, q2 yes or one tolerated cannot_verify per run). OLD = `src/gates.ts` at 62321c3, NEW = the working tree, both run with `evidenceMode: "skip-quotes"`, so only deterministic rules differ. The OLD side therefore already carries the 2026-10-14 rules; "bad leads caught" are leads the 62321c3 gates accepted and the new gates reject.

## Layer 1 - deterministic rules only (NEW `skip-quotes` vs OLD)

| set | scenario | arm | judged | accepted-before | accepted-after | bad leads caught (code) | good leads lost (code) | projected precision | leads with unverifiable rules |
|---|---|---|---:|---:|---:|---|---|---:|---:|
| live-quotes-2026-10-14 | S1 | B_agent_opus | 10 | 10 | 10 | - | - | 9/10 = 0.90 | 0 |
| live-quotes-2026-10-14 | S2 | B_agent_opus | 3 | 3 | 3 | - | - | 3/3 = 1.00 | 0 |
| memory-eval-2026-10-15 | S1 | B_agent_opus | 14 | 14 | 13 | - | Jay Group [non_event_page] (rep 3) | 13/13 = 1.00 | 0 |
| memory-eval-2026-10-15b | S1 | B_agent_opus | 21 | 21 | 18 | NXTPoint Logistics [exclude_domain] (rep 1); Fetch Package [exclude_domain] (rep 1); Port City Logistics Inc [exclude_domain] (rep 1) | - | 17/18 = 0.94 | 0 |
| pilot-2026-10-12 | S1 | A_workflow | 19 | 14 | 14 | - | - | 6/14 = 0.43 | 19 |
| pilot-2026-10-12 | S1 | B_agent_opus | 25 | 25 | 25 | - | - | 22/25 = 0.88 | 25 |
| pilot-2026-10-12 | S2 | A_workflow | 12 | 7 | 7 | - | - | 1/7 = 0.14 | 12 |
| pilot-2026-10-12 | S2 | B_agent_opus | 30 | 29 | 29 | - | - | 24/29 = 0.83 | 30 |

Baseline precision (accepted-before, judged good): 
- live-quotes-2026-10-14/S1/B_agent_opus: 9/10
- live-quotes-2026-10-14/S2/B_agent_opus: 3/3
- memory-eval-2026-10-15/S1/B_agent_opus: 14/14
- memory-eval-2026-10-15b/S1/B_agent_opus: 17/21
- pilot-2026-10-12/S1/A_workflow: 6/14
- pilot-2026-10-12/S1/B_agent_opus: 22/25
- pilot-2026-10-12/S2/A_workflow: 1/7
- pilot-2026-10-12/S2/B_agent_opus: 24/29

### Named flips per rule (Layer 1)

- `exclude_domain` (3 lead-reps): memory-eval-2026-10-15b/S1/B_agent_opus/1 NXTPoint Logistics (bad); memory-eval-2026-10-15b/S1/B_agent_opus/1 Fetch Package (bad); memory-eval-2026-10-15b/S1/B_agent_opus/1 Port City Logistics Inc (bad)
- `non_event_page` (1 lead-reps): memory-eval-2026-10-15/S1/B_agent_opus/3 Jay Group (GOOD)

Note: OLD replay already rejected (not accepted-before): pilot-2026-10-12/S2/B_agent_opus/1 Miter [weak_hiring_signal]

### Unverifiable per lead (Layer 1)

- Workflow-arm leads (31): signal-only rules ran; unverifiable: hiring-by-roles (no signal text recorded); quote rules; entity/hq/size/enterprise/gates (no lookup recorded).
- Agent-arm leads (103): all deterministic rules ran; unverifiable: lookup page text not recorded: quote_not_in_page on lookup quotes (55 leads).

## Layer 2 - would require evidence (leads accepted after Layer 1)

Counts leads that rest on an unquoted required gate boolean (or an unquoted HQ) and/or have no `signal_quote`. Under full enforcement these become `tier: "candidate"` (`unquoted_gate` / `unquoted_signal`); the simulation cannot say whether a fresh quote-enabled run would find a quote on the page.

| set | scenario | arm | accepted after L1 | no signal_quote | unquoted required gate / HQ | would become candidate | of which BAD (quote rule stops them) | of which GOOD (demoted pending a fresh run) |
|---|---|---|---:|---:|---:|---:|---|---|
| live-quotes-2026-10-14 | S1 | B_agent_opus | 10 | 0 | 0 | 0 | - | - |
| live-quotes-2026-10-14 | S2 | B_agent_opus | 3 | 0 | 0 | 0 | - | - |
| memory-eval-2026-10-15 | S1 | B_agent_opus | 13 | 0 | 0 | 0 | - | - |
| memory-eval-2026-10-15b | S1 | B_agent_opus | 18 | 0 | 0 | 0 | - | - |
| pilot-2026-10-12 | S1 | A_workflow | 14 | 14 | 0 | 14 | Verst Logistics (rep 1,2,3); Updike Distribution Logistics (rep 1,2,3); A. Duie Pyle (rep 2); Diakonlogistics (rep 2) | FST Logistics (rep 1,2,3); Hollingsworth Logistics (rep 1,2,3) |
| pilot-2026-10-12 | S1 | B_agent_opus | 25 | 25 | 25 | 25 | Verst Logistics (rep 1,2,3) | RK Logistics Group (rep 1,2,3); Metropolitan Warehouse and Delivery (rep 1,2,3); Palmer Logistics (rep 1); RGL Logistics (rep 1,2,3); ePost Global (rep 1,2); TA Services (rep 1); King of Freight (rep 1,3); Southern AG Carriers, Inc. (rep 1,2,3); Capacity LLC (rep 1); Super Smart Service (rep 2); FreezPak Logistics (rep 2,3) |
| pilot-2026-10-12 | S2 | A_workflow | 7 | 7 | 0 | 7 | Avarra.ai (rep 1,2,3); Gallatin AI, Inc. (rep 1,2,3) | Clueso (rep 2) |
| pilot-2026-10-12 | S2 | B_agent_opus | 29 | 29 | 29 | 29 | SubBase (rep 1,3); Sybill (rep 2); Henry AI (rep 2); Scaffold (rep 3) | Avarra.ai (rep 1,2,3); Baselayer (rep 1,2,3); Gallatin AI, Inc. (rep 1,2,3); Vitalize (rep 1,2,3); OuterSignal (rep 1,2,3); Reo.Dev (rep 1,2,3); Probook (rep 1); Healthleap (rep 1); Fazeshift (rep 2); Monk (rep 2); Agave (rep 3); Digs (rep 3) |

Totals: 75 of 119 Layer-1-accepted lead-reps would be candidates; BAD 22, GOOD 53.
Full-enforcement verdict codes on agent-arm leads (NEW `checkLead`, default mode, no lookup text): unquoted_signal 54, weak_hiring_signal 1, accepted 44, non_event_page 1, exclude_domain 3.
Workflow-arm rows count as `no signal_quote` by construction (their run files carry no summary); their gate-quote status is unverifiable.

## Required catches

- NXTPoint Logistics (snaprecruit): caught memory-eval-2026-10-15b/1 [exclude_domain]
- Fetch Package (capitalfactory): caught memory-eval-2026-10-15b/1 [exclude_domain]
- Port City Logistics (jobtarget): caught memory-eval-2026-10-15b/1 [exclude_domain]
- Constellation Cold Logistics (bbc.co.uk news article): not a listing; q3=no because the event (council approval, early June 2026) predates the window and the BBC piece is a later report. NOT caught, and not catchable by a deterministic URL rule: the summary's event date (2026-08-27, the BBC piece) is inside the window; only the judge's fetch of other sources showed the underlying approval was early June. Judge-only failure.

## URL-shape rule on its own (independent of the domain list)

Every agent-arm lead-rep the shape rule (`isThirdPartyListing`: listing-shaped host/path, registrable domain differs from the lookup URL or lookup unknown) would reject, whichever rule fires first in `checkLead`:

- memory-eval-2026-10-15/S1/B_agent_opus/3 Jay Group (GOOD): https://www.thejobsmap.com/job/996a5bb5-50f7-4537-a58b-3a33c4b9fcb1
- memory-eval-2026-10-15b/S1/B_agent_opus/1 NXTPoint Logistics (bad): https://snaprecruit.com/job/operations-supervisor-1st-jessup-maryland-auix20260806110711.html
- memory-eval-2026-10-15b/S1/B_agent_opus/1 Fetch Package (bad): https://jobs.capitalfactory.com/companies/fetch-package/jobs/95918204-warehouse-supervisor
- memory-eval-2026-10-15b/S1/B_agent_opus/1 Port City Logistics Inc (bad): https://www.jobtarget.com/jobs/jt-h76triz8qz/manager-warehouse-operations-savannah-georgia

Listing-shaped URLs the rule lets through (own domain): none

SUMMARY good leads lost: 1 -> memory-eval-2026-10-15/3 Jay Group
SUMMARY reason: Jay Group is lost by design: a single third-party job post (thejobsmap.com) is not counted by the rubric, which accepts a job post only on the company's own site or naming >=2 roles; its judge verdict was good only via the aggregator's "More jobs at Jay Group" list and carried a spot-check flag.
SUMMARY bad leads newly caught: 3 of 27 bad lead-reps accepted before
