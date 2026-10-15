# Quote replay: memory eval 2026-10-15 (S1 arm B, 3 reps)

Source: `eval/results/memory-eval-2026-10-15/S1/B_agent_opus/{1,2,3}` events and state, `eval/recordings/memory-eval-2026-10-15/{1,2,3}` Exa recordings. $0, no API calls. Matcher: current `quoteMatch` (12-char clauses, in order, 600-char window).

## Counts

- lookups screened `quote_not_in_page`: 9 (rep 1: 2, rep 2: 5, rep 3: 2)
- before (matcher at HEAD fe7a4ee): 0 of 9 lookups pass the lookup-stage quote check
- after (current matcher): 4 of 9 lookups pass the quote check on every failing key; 5 still rejected
- failing keys by class: {"(f) bare figure":2,"(f) other: edited text":1,"(f) silent appositive deletion (no ellipsis marker)":2,"(f) label/value reversed":1,"(f) summariser commentary / paraphrase":2,"(b) elision join (matcher bug, fixed)":1,"(c) two sentences 717 chars apart joined by ellipsis (outside window)":1}
- no recorded lookup has text >= 20,000 chars (max 16,980), so class (e) cannot occur here; no quote matches `results[1].text`, so class (d) does not occur.

## Classification

| rep | company | failing key (failed at HEAD) | quote | nearest page text (stripped chars) | class | now | note |
|---|---|---|---|---|---|---|---|
| 1 | Spartan Logistics | employee_estimate_source | 281 | 3/3: 281 | (f) bare figure | PASS | bare figure '281' (3 chars, below the 6-char floor); the page has 'Employees: 281' and 'employs 281 people' |
| 1 | Southern AG Carriers | is_third_party_logistics_quote | SOAG CARRIERS is a logistics company that provides agricultural transportation and refrigerated transport services; nationwide logistics and dedicated to provid | 101/213: soagcarriersisalogisticscompanythatprovidesagriculturaltransportationandrefrigeratedtransp | (f) other: edited text | reject | summariser dropped words: page says 'They offer nationwide logistics and are dedicated to', quote says 'nationwide logistics and dedicated to' |
| 2 | A. Duie Pyle | signal_quote @ https://aduiepyle.com/camp-hill-integrated-logistics-center/ | A. Duie Pyle today announces the opening of a new warehouse facility in Camp Hill, Pennsylvania. | 69/78: todayannouncestheopeningofanewwarehousefacilityincamphillpennsylvania | (f) silent appositive deletion (no ellipsis marker) | reject | signal_quote: summariser silently deleted the appositive '(Pyle), a premier ... solutions,' between subject and verb (no ellipsis marker); first fragment 'A. Duie Pyle' is 9 chars |
| 2 | A. Duie Pyle | signal_quote @ https://www.globenewswire.com/news-release/2026/10/06/3375546/0/en/a-duie-pyle-opens-new-warehouse-facility-creating-a-fully-integrated-logistics-center-in-central-pennsylvania.html | A. Duie Pyle today announces the opening of a new warehouse facility in Camp Hill, Pennsylvania. | 69/78: todayannouncestheopeningofanewwarehousefacilityincamphillpennsylvania | (f) silent appositive deletion (no ellipsis marker) | reject | signal_quote: summariser silently deleted the appositive '(Pyle), a premier ... solutions,' between subject and verb (no ellipsis marker); first fragment 'A. Duie Pyle' is 9 chars |
| 2 | Spartan Logistics | employee_estimate_source | 281 employees | 9/12: employees | (f) label/value reversed | PASS | label/value reversed: quote '281 employees', page 'Employees: 281' |
| 2 | Cleveland Group | is_third_party_logistics_quote | The page describes Cleveland as a transportation, logistics and storage company; it does not state it operates as a third-party logistics provider for others in | 25/187: satransportationlogistics | (f) summariser commentary / paraphrase | reject | not a quote: summariser commentary ('it does not state ... third-party logistics'); the gate value is also 'no' |
| 2 | King of Freight | employee_estimate_source | 679 | 3/3: 679 | (f) bare figure | PASS | bare figure '679' (3 chars); the page has 'Employees: 679' and 'employs 679 people' |
| 2 | Hollingsworth Logistics Group | is_third_party_logistics_quote | 3PL services, assembly sequencing, automotive-transportation, etc. listed under capabilities and services; company described as providing supply chain managemen | 102/219: supplychainmanagementand3plservicesincludingwarehousingfulfillmentpackagingassemblyandreve | (f) summariser commentary / paraphrase | reject | starts with summariser commentary ('listed under capabilities and services; company described as'); the tail is genuine page text with one comma dropped |
| 3 | XDP Ltd | is_third_party_logistics_quote | XDP LTD employs 263 people (+4.4% YoY, +11 people) ... with offices in Tamworth and Minworth. Its workforce is distributed across United Kingdom, Hong Kong, and | 92/127: withofficesintamworthandminworthitsworkforceisdistributedacrossunitedkingdomhongkongandnep | (b) elision join (matcher bug, fixed) | PASS | explicit ellipsis join; both halves are contiguous page text 'employs 263 people (+4.4% YoY, +11 people), founded ... with offices in Tamworth'. Matcher bug: the short piece '+11 people)' was merged forward across the ellipsis |
| 3 | Spartan Logistics | is_third_party_logistics_quote | Spartan Logistics is a Transportation, Logistics, Supply Chain and Storage company. ... Spartan Logistics provides contract warehousing, fulfillment services, f | 140/210: spartanlogisticsprovidescontractwarehousingfulfillmentservicesfullservicetransportationind | (c) two sentences 717 chars apart joined by ellipsis (outside window) | reject | two genuine sentences joined by '...'; the second starts 717 stripped chars after the first (window 600) |

## `error: fetch failed` lookups

| rep | company | turn | resultSummary |
|---|---|---|---|
| 1 | Davidson Logistics | 3 | error: fetch failed |
| 1 | Davidson Logistics | 4 | error: fetch failed |
| 1 | PermaCold Logistics | 6 | error: fetch failed |
| 2 | Spartan Logistics | 3 | error: fetch failed |
| 2 | Behnke Logistics | 5 | error: fetch failed |
| 3 | Toga Freight | 11 | error: fetch failed |
| 3 | Freitty | 14 | error: fetch failed |

Origin: Node's `fetch` rejects with `TypeError: fetch failed` (the real reason is in `error.cause`) when the TCP/TLS connection to api.exa.ai fails. `fetchWithRetry` in `src/exa.ts` only retried HTTP 429/5xx; a thrown network error escaped on the first attempt with no cause in the message. It is Exa transport, not our page fetch (lookup_company makes no page fetch of its own).

