# Gate Replay Projection - 2026-10-14

Scope: judged pilot leads (distinct leads in `eval/truth/S1|S2/*.json`; the table counts each lead once per rep it appeared in, 86 lead-reps), replayed from `eval/results/pilot-2026-10-12/**`. No Exa or Anthropic calls are made ($0).

**Simulation limits (exact).** (1) Pilot lead summaries predate the quote fields: none carries `signal_quote`, `signal_date_quote`, `<gate>_quote` or `hq_quote`, so no quote rule can be evaluated against a fresh summary; Layer 1 therefore runs the NEW `checkLead` with `evidenceMode: "skip-quotes"`, and Layer 2 only counts which accepted leads would lack a quote. (2) Lookup page text was not recorded in the pilot state, so `quote_not_in_page` on lookup-page quotes (employee source, HQ, gate quotes) cannot be replayed for any lead. (3) Workflow-arm (`A_workflow`) `run.json` files persist only company, signal URL, why_now, event_date and size_basis: no signal summary, signal text, title, enrichment or lookup. For those leads only the rules that need nothing but company name and signal URL run (built-in/plan excluded domains, personal-profile URL, plan exclude names, placeholder/job-board names); hiring-by-roles, entity match, HQ, size, enterprise, gates and all quote rules are reported unverifiable per lead, not the lead dropped. (4) The signal-page text used for entity/hiring checks on agent-arm leads is the recorded Exa page text; the live-Exa behaviour of the quote rule is unproven until a paid run.

OLD side: `eval/replay/gates-before.ts` is byte-identical to `git show HEAD:src/gates.ts` apart from its provenance comment and import paths (checked at replay time); it is used as the OLD side.

Good/bad = the scorer's rule (`eval/harness/score.ts` leadGood: q1 and q3 yes, q2 yes or one tolerated cannot_verify per run). The accepted-before precision below reproduces `eval/results/pilot-2026-10-12/report.md` (S1 agent 22/25, S2 agent 24/30, S1 workflow 6/19, S2 workflow 1/12).

## Layer 1 - deterministic rules only (NEW `skip-quotes` vs OLD)

| scenario | arm | judged | accepted-before | accepted-after | bad leads caught (code) | good leads lost (code) | projected precision | leads with unverifiable rules |
|---|---|---:|---:|---:|---|---|---:|---:|
| S1 | A_workflow | 19 | 19 | 14 | Spreetail [exclude_domain] (rep 2,3); Away Team (Spreetail) [exclude_domain] (rep 2); HIVED [exclude_domain] (rep 2); Diakonlogistics [exclude_domain] (rep 3) | - | 6/14 = 0.43 | 19 |
| S1 | B_agent_opus | 25 | 25 | 25 | - | - | 22/25 = 0.88 | 25 |
| S2 | A_workflow | 12 | 12 | 7 | Avarra [non_event_page] (rep 1,2,3); Clueso [non_event_page] (rep 1,3) | - | 1/7 = 0.14 | 12 |
| S2 | B_agent_opus | 30 | 30 | 29 | Miter [weak_hiring_signal] (rep 1) | - | 24/29 = 0.83 | 30 |

Baseline precision (accepted-before, judged good): 
- S1/A_workflow: 6/19
- S1/B_agent_opus: 22/25
- S2/A_workflow: 1/12
- S2/B_agent_opus: 24/30

### Named flips per rule (Layer 1)

- `exclude_domain` (5 lead-reps): S1/A_workflow/2 Spreetail (bad); S1/A_workflow/2 Away Team (Spreetail) (bad); S1/A_workflow/2 HIVED (bad); S1/A_workflow/3 Spreetail (bad); S1/A_workflow/3 Diakonlogistics (bad)
- `non_event_page` (5 lead-reps): S2/A_workflow/1 Avarra (bad); S2/A_workflow/1 Clueso (bad); S2/A_workflow/2 Avarra (bad); S2/A_workflow/3 Avarra (bad); S2/A_workflow/3 Clueso (bad)
- `weak_hiring_signal` (1 lead-reps): S2/B_agent_opus/1 Miter (bad)

### Unverifiable per lead (Layer 1)

- Workflow-arm leads (31): signal-only rules ran; unverifiable: hiring-by-roles (no signal text recorded); quote rules; entity/hq/size/enterprise/gates (no lookup recorded).
- Agent-arm leads (55): all deterministic rules ran; unverifiable: lookup page text not recorded: quote_not_in_page on lookup quotes (55 leads).

## Layer 2 - would require evidence (leads accepted after Layer 1)

Counts leads that rest on an unquoted required gate boolean (or an unquoted HQ) and/or have no `signal_quote`. Under full enforcement these become `tier: "candidate"` (`unquoted_gate` / `unquoted_signal`); the simulation cannot say whether a fresh quote-enabled run would find a quote on the page.

| scenario | arm | accepted after L1 | no signal_quote | unquoted required gate / HQ | would become candidate | of which BAD (quote rule stops them) | of which GOOD (demoted pending a fresh run) |
|---|---|---:|---:|---:|---:|---|---|
| S1 | A_workflow | 14 | 14 | 0 | 14 | Verst Logistics (rep 1,2,3); Updike Distribution Logistics (rep 1,2,3); A. Duie Pyle (rep 2); Diakonlogistics (rep 2) | FST Logistics (rep 1,2,3); Hollingsworth Logistics (rep 1,2,3) |
| S1 | B_agent_opus | 25 | 25 | 25 | 25 | Verst Logistics (rep 1,2,3) | RK Logistics Group (rep 1,2,3); Metropolitan Warehouse and Delivery (rep 1,2,3); Palmer Logistics (rep 1); RGL Logistics (rep 1,2,3); ePost Global (rep 1,2); TA Services (rep 1); King of Freight (rep 1,3); Southern AG Carriers, Inc. (rep 1,2,3); Capacity LLC (rep 1); Super Smart Service (rep 2); FreezPak Logistics (rep 2,3) |
| S2 | A_workflow | 7 | 7 | 0 | 7 | Avarra.ai (rep 1,2,3); Gallatin AI, Inc. (rep 1,2,3) | Clueso (rep 2) |
| S2 | B_agent_opus | 29 | 29 | 29 | 29 | SubBase (rep 1,3); Sybill (rep 2); Henry AI (rep 2); Scaffold (rep 3) | Avarra.ai (rep 1,2,3); Baselayer (rep 1,2,3); Gallatin AI, Inc. (rep 1,2,3); Vitalize (rep 1,2,3); OuterSignal (rep 1,2,3); Reo.Dev (rep 1,2,3); Probook (rep 1); Healthleap (rep 1); Fazeshift (rep 2); Monk (rep 2); Agave (rep 3); Digs (rep 3) |

Totals: 75 of 75 Layer-1-accepted lead-reps would be candidates; BAD 22, GOOD 53.
Full-enforcement verdict codes on agent-arm leads (NEW `checkLead`, default mode, no lookup text): unquoted_signal 54, weak_hiring_signal 1.
Workflow-arm rows count as `no signal_quote` by construction (their run files carry no summary); their gate-quote status is unverifiable.
