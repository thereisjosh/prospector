# Human spot-checks of judge verdicts — pilot-2026-10-12

RUBRIC §5.3 requires the author to check ≥ 20% of verdicts against sources. 10 of 45 checked (22%), 2026-10-13. Method: fetch the signal URL where the site allows it; otherwise corroborate the same event via independent coverage (the judge's own fallback rule). Disagreements are resolved by the source.

| # | Scenario | Company | Judge verdict | Human check | Source used | Agree? |
|---|---|---|---|---|---|---|
| 1 | S1 | RGL Logistics | Q3 cannot_verify (v2, search-only) | Article names RGL, "October 5, 2026", 427,500 sq ft, lists third-party logistics among services | thebusinessnews.com (fetched) | **No** → drove the judge v3 fix (web_fetch); re-judged |
| 2 | S1 | Metropolitan Warehouse and Delivery | good | "Sep 23, 2026", 530,000 sq ft lease at Carneys Point; "white-glove logistics, warehousing and delivery services" for customers | re-nj.com (fetched) | Yes |
| 3 | S1 | Southern AG Carriers | good | Terminal opening ceremony "Tuesday, September 15, 2026", Albany GA | choosealbany.com news listing (fetched) | Yes |
| 4 | S1 | Hollingsworth Logistics | not good (v2) → good (v3, fetched) | Expansion article reachable; v3 fetched it | judge v3 fetch | Yes (v3) |
| 5 | S1 | Away Team (Spreetail) | not good (Q1 no, Q3 no) | Spreetail is a retailer running its own fulfilment; "Away Team" is an internal team; single-role aggregator post | judge note + startup.jobs | Yes |
| 6 | S2 | Agave | good | $15M Series A led by Accel, July 7, 2026; customers are contractors (B2B) | pulse2.com, lasvegassun.com, seedtable (search corroboration; businesswire blocks fetch) | Yes |
| 7 | S2 | Capacity LLC | good | Majority stake in Core Fulfilment reported Oct 8, 2026; NJ third-party logistics provider | ajot.com, pulse2.com (search corroboration; citybiz blocks fetch) | Yes |
| 8 | S2 | Healthleap | good | $38M across $8M seed + $30M Series A; sells to hospitals (B2B) | fiercehealthcare.com, techcrunch (search corroboration) | Yes |
| 9 | S2 | Sybill | not good (Q1 no) | Gate is "B2B AND recently raised seed/Series A"; Sybill's last round was earlier and later-stage | tracxn (judge source) | Yes |
| 10 | S2 | Miter | not good (Q1 no) | Same gate; Miter's funding is later-stage, not a recent seed/A | nextplayso.substack (judge source) | Yes |

Observed judge failure modes: (a) search-only judge could not open signal URLs → systematic Q3 cannot_verify (fixed in v3 with web_fetch + corroboration rule); (b) "cannot verify" spelling variant broke parsing once (normalised); (c) sites that block fetches (businesswire, citybiz, lanereport) force the corroboration path.

Verdicts from the v2 judge carry no `note` (field was not persisted until 2026-10-13); re-judged verdicts do.
