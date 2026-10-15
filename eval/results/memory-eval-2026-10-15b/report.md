# Memory eval: memory-eval-2026-10-15b / S1

Generated 2026-10-15T11:58:59.634Z. A = first run in an empty workspace (`mem-eval-memory-eval-2026-10-15b-S1`); B = second run in the same workspace, with A's memory; B' = control, a first run in a separate empty workspace (`mem-eval-memory-eval-2026-10-15b-S1-control`).

| run | leads | good (judged) | new vs A | lookups skipped | Exa $ saved | notes written | notes recalled | dead-query overlap | cache share | spend | $ / good lead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 7 | 3 | - | 0 | $0.0000 | 0 | 0 | - | 0.89 | $0.8796 | $0.2932 |
| B | 8 | 8 | 8/8 | 2 | $0.0180 | 1 | 0 | 0/11 | 0.91 | $0.8542 | $0.1068 |
| B' (control) | 6 | 6 | 4/6 (info) | 0 | $0.0000 | 1 | 0 | 0/11 | 0.92 | $0.8453 | $0.1409 |

**Verdict: PASS** (B skipped 2 lookups, 8/8 B leads are new vs A, good(B) 8 vs good(B') 6)

Rule: PASS if B skipped >= 2 lookups AND every B lead is new vs A AND good(B) >= good(B') - 2 (pilot noise is +/-2); else FAIL.

## Definitions

- leads / good: leads delivered / of those, judged good (rubric Q1 and Q3 yes, Q2 not no), from the judge's verdict per company + signal URL.
- new vs A: B leads whose company A did not also deliver. Shown for B' for information only.
- lookups skipped: `lookup_company` events carrying `seen` (a company remembered from an earlier run, no paid lookup). Exa $ saved = skipped x $0.0090 (src/exa.ts COST_ESTIMATE.companyLookup, list price).
- notes written: `remember` calls that succeeded. notes recalled: notes in the `memory_recalled` event's included set.
- dead-query overlap: distinct (normalised: lowercase, punctuation stripped) search queries of the run that equal a query of A that returned no accepted lead; a query counts as having returned a lead when an accepted company is named in its result line.
- spend: cell spend (Claude + Exa) from run.json; cost per good lead = spend / good. Judge spend $5.8616 is separate and not in the table. Guard: --max-dollars 4.

## Detail

### A

- search queries (11): "independent third-party logistics provider opens new warehouse fulfillment center", "UK logistics company opens new distribution warehouse for clients", "regional last-mile delivery or freight company expands with new terminal hiring operations staff", "logistics company economic development announcement new distribution center creating 100 jobs warehousing services for customers", "UK haulage and warehousing firm expands with new site creating jobs", "mid-sized 3PL or freight carrier hiring dozens of warehouse operations managers and supervisors for new site", "US warehousing and fulfillment provider expands with new building or acquisition announcement, independent family-owned 3PL", "UK contract logistics or pallet network member opens new depot or warehouse for customers", "job posting warehouse operations manager at regional third-party logistics company", "drayage, cold storage or fulfillment provider hiring operations manager or site manager for new warehouse", "asset-based trucking and warehousing company with several hundred employees opens new terminal or warehouse October 2026"
- dead queries (3): "UK logistics company opens new distribution warehouse for clients", "UK contract logistics or pallet network member opens new depot or warehouse for customers", "drayage, cold storage or fulfillment provider hiring operations manager or site manager for new warehouse"

### B

- search queries (11): "third-party logistics provider opens new warehouse or fulfillment center in the US", "UK logistics and fulfilment company opens new warehouse expansion", "regional last-mile or freight logistics company expands with new terminal or hub", "mid-sized contract logistics or 3PL company with several hundred employees announces new distribution center lease, US", "UK haulage and warehousing firm opens new distribution centre creating jobs", "3PL or freight company hiring dozens of warehouse operations staff for new site opening, US or UK", "family-owned trucking and warehousing company opens new cross-dock or warehouse, local news", "UK 3PL fulfilment provider takes new warehouse unit to meet client demand", "cold storage or refrigerated logistics provider opens new facility in US, serving food customers", "regional LTL or truckload carrier with logistics division opens new warehouse or service center, September or October 2026", "final-mile or white-glove delivery logistics company opens new hub in US, 2026"
- dead queries (6): "third-party logistics provider opens new warehouse or fulfillment center in the US", "UK logistics and fulfilment company opens new warehouse expansion", "UK haulage and warehousing firm opens new distribution centre creating jobs", "3PL or freight company hiring dozens of warehouse operations staff for new site opening, US or UK", "UK 3PL fulfilment provider takes new warehouse unit to meet client demand", "final-mile or white-glove delivery logistics company opens new hub in US, 2026"

### B'

- search queries (11): "regional third-party logistics provider opens new warehouse or fulfillment center in the US", "UK 3PL logistics company opens new distribution centre or warehouse", "last-mile delivery or freight logistics company expands with new depot or terminal", "independent logistics company hiring operations managers for new warehouse site, US or UK", "family-owned warehousing and logistics company announces new warehouse expansion, creating jobs", "cold storage or temperature-controlled logistics provider opens new facility", "UK independent haulage and warehousing firm expands with new site in 2026", "mid-sized 3PL fulfillment provider announces expansion into new market with additional warehouse", "regional LTL or trucking logistics company opens new terminal or cross-dock in US, hiring drivers and dock staff", "UK contract logistics or e-fulfilment provider opens new warehouse and creates jobs", "third-party logistics company leases new distribution center in US and plans to hire 100 or more workers"
- dead queries (5): "UK 3PL logistics company opens new distribution centre or warehouse", "independent logistics company hiring operations managers for new warehouse site, US or UK", "UK independent haulage and warehousing firm expands with new site in 2026", "regional LTL or trucking logistics company opens new terminal or cross-dock in US, hiring drivers and dock staff", "UK contract logistics or e-fulfilment provider opens new warehouse and creates jobs"
- repeated from A: Wagner Logistics, Spartan Logistics

### Memory after A

7 seen, 0 preferences, 0 notes (full files: memory-after-A.json, memory-after-B.json).


