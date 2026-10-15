# Memory eval: memory-eval-2026-10-15 / S1

Generated 2026-10-15T10:56:13.577Z. A = first run in an empty workspace (`mem-eval-memory-eval-2026-10-15-S1`); B = second run in the same workspace, with A's memory; B' = control, a first run in a separate empty workspace (`mem-eval-memory-eval-2026-10-15-S1-control`).

| run | leads | good (judged) | new vs A | lookups skipped | Exa $ saved | notes written | notes recalled | dead-query overlap | cache share | spend | $ / good lead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5 | 5 | - | 0 | $0.0000 | 1 | 0 | - | 0.88 | $0.7984 | $0.1597 |
| B | 1 | 1 | 1/1 | 2 | $0.0180 | 1 | 1 | 0/12 | 0.91 | $0.8043 | $0.8043 |
| B' (control) | 8 | 8 | 4/8 (info) | 0 | $0.0000 | 0 | 0 | 0/13 | 0.90 | $0.8596 | $0.1074 |

**Verdict: FAIL**: good(B) = 1 is more than 2 below good(B') = 8

Rule: PASS if B skipped >= 2 lookups AND every B lead is new vs A AND good(B) >= good(B') - 2 (pilot noise is +/-2); else FAIL.

## Definitions

- leads / good: leads delivered / of those, judged good (rubric Q1 and Q3 yes, Q2 not no), from the judge's verdict per company + signal URL.
- new vs A: B leads whose company A did not also deliver. Shown for B' for information only.
- lookups skipped: `lookup_company` events carrying `seen` (a company remembered from an earlier run, no paid lookup). Exa $ saved = skipped x $0.0090 (src/exa.ts COST_ESTIMATE.companyLookup, list price).
- notes written: `remember` calls that succeeded. notes recalled: notes in the `memory_recalled` event's included set.
- dead-query overlap: distinct (normalised: lowercase, punctuation stripped) search queries of the run that equal a query of A that returned no accepted lead; a query counts as having returned a lead when an accepted company is named in its result line.
- spend: cell spend (Claude + Exa) from run.json; cost per good lead = spend / good. Judge spend $4.1088 is separate and not in the table. Guard: --max-dollars 4.

## Detail

### A

- search queries (10): "independent third-party logistics provider opens new warehouse fulfillment center", "UK 3PL logistics company opens new distribution warehouse expansion", "regional last-mile delivery or freight logistics company expands to new market hiring operations staff", "US 3PL warehousing company expands with new distribution center, adding jobs", "family-owned trucking and logistics carrier opens new terminal or cross-dock", "UK logistics provider pallet network haulier opens new depot creating jobs", "cold storage temperature-controlled logistics provider opens new facility United States", "ecommerce fulfillment provider opens additional fulfillment center to serve brands", "UK third-party logistics firm signs lease on new warehouse to support client growth", "mid-sized 3PL logistics provider hiring hundreds of warehouse workers for new site launch"
- dead queries (5): "UK 3PL logistics company opens new distribution warehouse expansion", "regional last-mile delivery or freight logistics company expands to new market hiring operations staff", "UK logistics provider pallet network haulier opens new depot creating jobs", "ecommerce fulfillment provider opens additional fulfillment center to serve brands", "UK third-party logistics firm signs lease on new warehouse to support client growth"

### B

- search queries (12): "regional third-party logistics provider opens new warehouse or distribution center", "cold storage logistics provider opens new facility", "fulfillment or last-mile delivery company expands to new market and hires operations staff", "family-owned trucking and warehousing logistics company announces new distribution center and new jobs in US", "UK logistics and freight forwarding company opens new warehouse depot creating jobs", "3PL company announces expansion new warehouse location regional press release 2026", "LTL or truckload carrier opens new terminal in US", "freight brokerage opens new office and plans to hire dozens of employees", "contract logistics and warehousing provider announces new facility creating 50 to 200 jobs, economic development announcement", "ecommerce fulfillment 3PL opens additional fulfillment center in US to meet client demand", "UK third-party logistics provider takes new warehouse and creates over 100 jobs", "regional last-mile or final-mile delivery provider expands to new cities with new hub, US"
- dead queries (11): "regional third-party logistics provider opens new warehouse or distribution center", "cold storage logistics provider opens new facility", "fulfillment or last-mile delivery company expands to new market and hires operations staff", "family-owned trucking and warehousing logistics company announces new distribution center and new jobs in US", "UK logistics and freight forwarding company opens new warehouse depot creating jobs", "3PL company announces expansion new warehouse location regional press release 2026", "LTL or truckload carrier opens new terminal in US", "contract logistics and warehousing provider announces new facility creating 50 to 200 jobs, economic development announcement", "ecommerce fulfillment 3PL opens additional fulfillment center in US to meet client demand", "UK third-party logistics provider takes new warehouse and creates over 100 jobs", "regional last-mile or final-mile delivery provider expands to new cities with new hub, US"

### B'

- search queries (13): "third-party logistics provider opens new warehouse fulfillment center", "UK logistics company opens new distribution centre for clients", "regional last-mile delivery or freight company expands to new market adds depot", "regional 3PL warehousing company announces new warehouse lease expansion in US city", "independent UK contract logistics or haulage firm opens new warehouse site, creates jobs", "UK independent logistics provider opens new warehouse and creates jobs", "3PL logistics company hires new VP of operations or opens additional cross-dock terminal", "fulfillment provider for ecommerce brands opens second warehouse in new state", "cold storage or refrigerated logistics provider opens new facility US", "UK pallet network member or freight forwarder opens larger warehouse depot, hiring staff", "drayage or LTL trucking logistics company opens new terminal warehouse and adds jobs", "contract logistics 3PL opens new warehouse campus Texas Georgia Tennessee October 2026", "3PL warehousing company opens new distribution center in the Southeast US"
- dead queries (6): "UK logistics company opens new distribution centre for clients", "independent UK contract logistics or haulage firm opens new warehouse site, creates jobs", "UK independent logistics provider opens new warehouse and creates jobs", "UK pallet network member or freight forwarder opens larger warehouse depot, hiring staff", "contract logistics 3PL opens new warehouse campus Texas Georgia Tennessee October 2026", "3PL warehousing company opens new distribution center in the Southeast US"
- repeated from A: Wagner Logistics, FreezPak Logistics, ColdTrack, RGL Logistics

### Memory after A

5 seen, 0 preferences, 1 notes (full files: memory-after-A.json, memory-after-B.json).

- 2026-10-15 [third_party_logistics, new_facility, cold storage, size, warehouse] For 3PL facility news, most hits are too small (under 100 staff) or global giants; cold-storage providers and regional US 3PLs with press releases (e.g. FreezPak, RGL Logistics) fit the 100-1000 range best. UK lease news mostly misses.

