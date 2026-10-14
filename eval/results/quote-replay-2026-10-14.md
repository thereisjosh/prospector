# Quote matcher replay - 2026-10-14

Source: `eval/recordings/live-quotes-2026-10-14/**` (40 company lookups; signal recordings with signal_quote included). $0, no API calls.

## Counts

- quote fields: 410 (present 375, empty 35)
- OLD pass: 323/375
- NEW pass: 342/375
- flip old FAIL -> new PASS: 22
- regress old PASS -> new FAIL: 3
- NEW fail reasons: {"segment_missing":28,"too_short":5}

## NEW passes that span many lines / sections (eyeball these)

These are contiguous on the page once punctuation is stripped, so they are not stitched from distant lines; they are flagged only because a multi-line quote is where a false accept would hide. Quotes with an explicit ellipsis are flagged separately below.

- Axle / recently_funded_seed_or_series_a_quote (spans 5 non-empty lines): Total Funding: USD 26,060,000 - Series a (2026-08-01): USD 17.5M; Seed (2023-04-10): USD 4.0M; Seed (2022-11-01): USD 4.1M; Pre seed (2022-05-18): USD 500,000
- Digs / recently_funded_seed_or_series_a_quote (spans 6 non-empty lines): Total Funding: USD 44,300,000 - Series a (2026-08-01): USD 25.3M; Seed (2025-11-01): USD 5.0M; Seed (2024-01-25): USD 7.0M; Seed (2023-02-01): USD 7.0M; Series a
- Agave / recently_funded_seed_or_series_a_quote (spans 5 non-empty lines): Total Funding: USD 18,525,000 - Series a (2026-07-01): USD 15.0M; Seed (2023-08-30): USD 2.9M; Seed (2022-07-01): USD 125,000; Pre seed (2022-01-18): USD 500,000
- Meticulous / recently_funded_seed_or_series_a_quote (spans 5 non-empty lines): Total Funding: USD 19,125,000 - Series a (2026-07-01): USD 15.0M - Seed (2023-02-01): USD 4.0M - Venture (2022-01-01) - Seed (2021-09-01): USD 125,000
- Arzana / recently_funded_seed_or_series_a_quote (spans 4 non-empty lines): Total Funding: USD 4,925,000 - Seed (2026-07-01): USD 4.3M - Pre seed (2026-06-01): USD 500,000 - Seed (2026-03-01): USD 125,000

## NEW passes using an explicit ellipsis (elided parts are skipped; clauses must still be in order and local)

- Arvato / signal_quote: Today, Gov. Andy Beshear announced exciting new momentum within the state’s distribution and logistics sector as Arvato... recently celebrated the grand opening of its new distribution and fulfillment
- Davinci Micro Fulfillment / signal_quote: Davinci Micro Fulfillment ... has opened its sixth U.S. facility in Pennsylvania’s Jenkins Township.
- Wagner Logistics / signal_quote: Wagner Logistics... today announced it has signed a multi-year agreement with a Kansas City-area manufacturer to launch a new manufacturing support and warehouse operations program in Liberty, Mo.
- Zenskar / hiring_first_ops_or_revops_quote: We’re hiring an Engineering Manager at Zenskar. 🚀 Billing gets complicated fast. Pricing changes, credits, refunds, usage, true-ups, revenue recognition: every edge case creates another. One small...
- Avarra.ai / recently_funded_seed_or_series_a_quote: Total Funding: USD 8,000,000 - Seed (2024-10-03): USD 8.0M ...
- Readily / hiring_first_ops_or_revops_quote: Key Executives: ... Chelsea Hardy: VP of Compliance ...
- Graph AI / recently_funded_seed_or_series_a_quote: Total Funding: USD 16,300,000 - Series a (2026-09-01): USD 13.3M - Seed (2025-11-15): USD 3.0M - ...
- Rivet Recruiting / signal_quote: Rivet Recruiting is partnering with a Series A, woman-founded (🙌) AI health tech company backed by Y Combinator + Google… and we’re hiring their FIRST RevOps leader.

## Regressions (old pass, new fail)

- Forgepoint / recently_funded_seed_or_series_a_quote [too_short]: Yearly Growth: +600.0%
- Axle / hiring_first_ops_or_revops_quote [too_short]: Active job postings: 21
- remotenex.us / signal_quote [too_short]: VP of Operations

## Table

| company | key | value | quote (first 100) | old | new | new reason | note |
|---|---|---|---|---|---|---|---|
| Haulystic | employee_estimate_source | 11 | Employees: 11 | pass | pass |  |  |
| Haulystic | hq_quote | United Kingdom (HQ in London) | Headquartered in United Kingdom, with an office in London. | pass | pass |  |  |
| Haulystic | is_third_party_logistics_quote | true | Haulystic is a pioneer in global e-commerce logistics, leveraging cutting-edge technology and operat | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart today opened its fifth next-generation fulfillment center, a more than 900,000-square-foot f | pass | pass |  |  |
| Arvato | signal_quote |  | Today, Gov. Andy Beshear announced exciting new momentum within the state’s distribution and logisti | FAIL | pass |  |  |
| Maersk | signal_quote |  | Maersk has fired up a 71,800-square-metre warehouse on Germany's A4 corridor in Herleshausen, Hessen | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart’s 900,000-sq-ft Stockton center cuts fulfillment from 12 steps to five with 1,000 hires, par | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  |  | - | - | empty |  |
| Davinci Micro Fulfillment | signal_quote |  | Davinci Micro Fulfillment ... has opened its sixth U.S. facility in Pennsylvania’s Jenkins Township. | FAIL | pass |  |  |
| G10 Fulfillment | signal_quote |  | G10 Fulfillment, a North American third-party logistics and fulfillment provider, will hold a ribbon | pass | pass |  |  |
| Alo Yoga | signal_quote |  | Alo...is setting up a massive new fulfillment and distribution center in Southaven, Mississippi, a p | FAIL | FAIL | segment_missing |  |
| Cutter & Buck | signal_quote |  | Cutter & Buck officially opened its new distribution center in Grand Prairie, Texas, on Friday Octob | pass | pass |  |  |
| ALO | signal_quote |  | ALO, the fashion and lifestyle brand synonymous with premium studio-to-streetwear rooted in mind-bod | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart has opened a 900,000-square-foot facility in Stockton, Calif. that it says represents the la | pass | pass |  |  |
| SHEIN | signal_quote |  | SHEIN, a global online fashion and lifestyle retailer, today celebrated the grand opening of its new | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart today opened its fifth next-generation fulfillment center, a more than 900,000-square-foot f | pass | pass |  |  |
| Maersk | signal_quote |  | The 617,000-square-foot facility will support a major e-commerce customer and enhance Maersk's abili | pass | pass |  |  |
| SHEIN | signal_quote |  | the grand opening of its new 737,000-square-foot automated fulfillment facility in Lebanon, Indiana | pass | pass |  |  |
| R/S-Godwin Truck Body Co. | signal_quote |  | Today, a week after announcing the largest investment on record for Owsley County, Gov. Andy Beshear | pass | pass |  |  |
| Summit Truck Bodies | signal_quote |  | Summit Truck Bodies celebrated the opening of its new 220,000-square-foot facility Thursday with a r | pass | pass |  |  |
| A. Duie Pyle | signal_quote |  | A. Duie Pyle opens new warehouse facility, creating a fully integrated logistics center in Central P | pass | pass |  |  |
| Wayne Smith Trucking | signal_quote |  | Wayne Smith Trucking of Morrilton celebrated 50 years in business Friday with a special open house e | pass | pass |  |  |
| R/S-Godwin Truck Body Co. | signal_quote |  | Today, a week after announcing the largest investment on record for Owsley County, Gov. Andy Beshear | pass | pass |  |  |
| Summit Truck Bodies | signal_quote |  | Ribbon cutting of Summit Truck Bodies expansion September 10, 2026. | pass | pass |  |  |
| Strimbu family and Nick Strimbu Inc. | signal_quote |  | Trumbull County commissioners on Aug. 19 adopted a resolution acknowledging and congratulating the S | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics, a nationwide provider of third-party logistics, today announced it has signed a mu | pass | pass |  |  |
| McElroy Truck Lines | signal_quote |  |  | - | - | empty |  |
| Pike Distributors | signal_quote |  | Pike Distributors celebrates grand opening of its new Marquette office and warehouse | FAIL | FAIL | segment_missing |  |
| Southern AG Carriers, Inc. | signal_quote |  | This new terminal represents much more than a new facility, it represents the continued growth of So | FAIL | pass |  |  |
| Felbermayr | signal_quote |  | Felbermayr Transport and Lifting Technology has opened a 50,000 square meter facility near Graz. | pass | pass |  |  |
| Saia Inc. | signal_quote |  | The new facility strengthens service capabilities across the New York metro market | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  | Davinci Micro Fulfillment — which services customers throughout the United States — opened a locatio | pass | pass |  |  |
| Hollingsworth Logistics | signal_quote |  | Hollingsworth Logistics is adding 150 jobs and consolidating its operations near San Antonio with a  | pass | pass |  |  |
| FreezPak Logistics | employee_estimate_source | 272 | Employees: 272 | pass | pass |  |  |
| FreezPak Logistics | hq_quote | Woodbridge, United States | Headquartered in Woodbridge, New Jersey, United States, with offices in Paterson and Carteret. | pass | pass |  |  |
| FreezPak Logistics | is_third_party_logistics_quote | true | FreezPak Logistics is a leading cold storage and logistics solutions provider with over 25 years of  | pass | pass |  |  |
| A. Duie Pyle | employee_estimate_source | 1.356 | Employees: 1,356 | pass | pass |  |  |
| A. Duie Pyle | hq_quote | West Chester, United States | Headquartered in West Chester, Pennsylvania, United States | pass | pass |  |  |
| A. Duie Pyle | is_third_party_logistics_quote | true | third-party logistics, warehousing and distribution, port services and third-party logistics, the Py | FAIL | FAIL | segment_missing |  |
| Cleveland Group | employee_estimate_source | 9 | Employees: 9 | pass | pass |  |  |
| Cleveland Group | hq_quote | Headquartered in Cleveland, Oh | Headquartered in Cleveland, Ohio, United States. | pass | pass |  |  |
| Cleveland Group | is_third_party_logistics_quote |  |  | - | - | empty |  |
| G10 Fulfillment | employee_estimate_source | 93 | Employees: 93 | pass | pass |  |  |
| G10 Fulfillment | hq_quote | Delavan, Wisconsin, United Sta | Headquartered in Delavan, Wisconsin, United States | pass | pass |  |  |
| G10 Fulfillment | is_third_party_logistics_quote | true | G10 Fulfillment is a logistics company that offers e-commerce fulfillment, retail fulfillment, hazma | pass | pass |  |  |
| Campeys of Selby | employee_estimate_source | 50 | Employees: 50 | pass | pass |  |  |
| Campeys of Selby | hq_quote | Selby, United Kingdom | Headquartered in Selby, North Yorkshire, United Kingdom, with an office in Thorpe Willoughby. | pass | pass |  |  |
| Campeys of Selby | is_third_party_logistics_quote | true | - Freight service, transportation, warehousing ... - Employees: 50 - Company Size: 51-200 employees  | FAIL | FAIL | segment_missing |  |
| Central Storage & Warehouse | employee_estimate_source | 72 | Employees: 72 | pass | pass |  |  |
| Central Storage & Warehouse | hq_quote | Franksville, Wisconsin, United | Headquartered in Franksville, Wisconsin, United States | pass | pass |  |  |
| Central Storage & Warehouse | is_third_party_logistics_quote | true | One of Wisconsin's largest providers of refrigerated and frozen public warehousing, with locations a | FAIL | FAIL | segment_missing |  |
| Hollingsworth Logistics | employee_estimate_source | 805 | Employees: 805 | pass | pass |  |  |
| Hollingsworth Logistics | hq_quote | Dearborn, United States | Headquartered in Dearborn, Michigan, United States. | pass | pass |  |  |
| Hollingsworth Logistics | is_third_party_logistics_quote | true | HOLLINGSWORTH employs 805 people (+4.4% YoY, +34 people) and has an annual revenue of $250M, founded | pass | pass |  |  |
| Route2 Logistics | employee_estimate_source | 9 | Employees: 9 | pass | pass |  |  |
| Route2 Logistics | hq_quote | Dunfermline, United Kingdom | Headquartered in Dunfermline, Scotland, United Kingdom. | pass | pass |  |  |
| Route2 Logistics | is_third_party_logistics_quote | true | Route2 Logistics is a specialist haulage and pallet distribution company providing pallet deliveries | FAIL | pass |  |  |
| SJH Fulfilment | employee_estimate_source | 5 | Employees: 5 | pass | pass |  |  |
| SJH Fulfilment | hq_quote | Kilkeel, United Kingdom | Headquarters: Kilkeel, United Kingdom | pass | pass |  |  |
| SJH Fulfilment | is_third_party_logistics_quote | true | logistics, order fulfillment, packing, picking, receiving, transportation, warehousing | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics, a nationwide provider of third-party logistics, today announced it has signed a mu | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk leases 71,800 sqm at Panattoni Park Bad Hersfeld Ost, on the A4 in Herleshausen, Hessen, for  | pass | pass |  |  |
| Rockefeller Group | signal_quote |  | Rockefeller Group has filled one of two new industrial buildings in Salem County, leasing 530,000 sq | pass | pass |  |  |
| Parts Town Unlimited | signal_quote |  | Parts Town Unlimited has signed a lease for a sprawling 538,450-square-foot distribution facility in | pass | pass |  |  |
| FST Logistics | signal_quote |  |  | - | - | empty |  |
| Bridge Logistics Properties (BLP) | signal_quote |  | Bridge Logistics Properties (" BLP") announced the acquisition of 6920 192nd Street, a 782,775-squar | pass | pass |  |  |
| Dermody | signal_quote |  | Dermody announced two lease transactions at LogistiCenter® at Carneys Point, increasing occupancy at | pass | pass |  |  |
| Link Logistics | signal_quote |  | Link Logistics (“Link” or the “Company”), a leading operator of last-mile industrial real estate and | pass | pass |  |  |
|  Tractor Supply Company | signal_quote |  | the grand opening of its 11th distribution center, located in Nampa, Idaho | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  | Davinci Micro Fulfillment — which services customers throughout the United States — opened a locatio | pass | pass |  |  |
| Averitt | signal_quote |  | Averitt has opened a 100,000-square-foot warehouse beside its existing 57-door LTL terminal in Richl | pass | pass |  |  |
| A. Duie Pyle | signal_quote |  | A. Duie Pyle has opened a 78,760-square-foot warehouse in Camp Hill, Pennsylvania, integrating stora | pass | pass |  |  |
| Bridge Logistics Properties | signal_quote |  | BLP announced the acquisition of 6920 192nd Street, a 782,775-square-foot Class A distribution facil | FAIL | pass |  |  |
| Wonderful Real Estate | signal_quote |  | Wonderful Real Estate sold two large parcels and a 1M SF industrial property at its 1,700-acre Wonde | pass | pass |  |  |
| Hollingsworth Logistics | signal_quote |  | Hollingsworth Logistics is adding 150 jobs and consolidating its operations near San Antonio with a  | pass | pass |  |  |
| Halsted | signal_quote |  | In this new role, I will bring structure, discipline, and scalability to the warehousing, logistics, | pass | pass |  |  |
| LUIS PEREZ | signal_quote |  |  | - | - | empty |  |
| Logistics Plus Inc. | signal_quote |  | Regional Director of Operations - Logistics Plus Inc. | FAIL | pass |  |  |
| Broadrange Logistics | signal_quote |  |  | - | - | empty |  |
| Curri | signal_quote |  |  | - | - | empty |  |
| John K. | signal_quote |  |  | - | - | empty |  |
| Riverstone Logistics | signal_quote |  | Senior Director, Warehouse Ops - Riverstone Logistics (Current) | FAIL | FAIL | segment_missing |  |
| Neovia Logistics | signal_quote |  |  | - | - | empty |  |
| Sammons Warehouse Solutions | signal_quote |  | I’m excited to share that I’ve stepped into the role of Vice President of Operations at Sammons Ware | pass | pass |  |  |
| Gourmet Foods International | signal_quote |  | Vice President Operations (Current) | pass | pass |  |  |
| Jones Logistics | signal_quote |  |  | - | - | empty |  |
| Frozen Logistics | signal_quote |  |  | - | - | empty |  |
| Universal Logistics Holdings | signal_quote |  |  | - | - | empty |  |
| Veho | signal_quote |  |  | - | - | empty |  |
| Sonwil Distribution Center | signal_quote |  | Vice President Operations (Current) | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics, a nationwide provider of third-party logistics, today announced it has signed a mu | pass | pass |  |  |
| Arvato | signal_quote |  | Today, Gov. Andy Beshear announced exciting new momentum within the state’s distribution and logisti | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart today opened its fifth next-generation fulfillment center, a more than 900,000-square-foot f | pass | pass |  |  |
| Flexport | signal_quote |  | Flexport has opened its first fully automated fulfillment center just outside Chicago. | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart's 900,000-sq-ft Stockton center cuts fulfillment from 12 steps to five with 1,000 hires, par | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk has fired up a 71,800-square-metre warehouse on Germany's A4 corridor in Herleshausen, Hessen | pass | pass |  |  |
| G10 Fulfillment | signal_quote |  | G10 Fulfillment, a North American third-party logistics and fulfillment provider, will hold a ribbon | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  |  | - | - | empty |  |
| Davinci Micro Fulfillment | signal_quote |  | has opened its sixth U.S. facility in Pennsylvania’s Jenkins Township | pass | pass |  |  |
| CJ Logistics | signal_quote |  | CJ Logistics announced that it has begun operations at its new logistics center in Elwood, Illi | pass | pass |  |  |
| FST Logistics | signal_quote |  | FST Logistics Expands Central Ohio Presence with New West Jefferson, Ohio Facility | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk will open a new 617,000-square-foot fulfillment center in Hopedale, Massachusetts, later this | pass | pass |  |  |
| Walmart | signal_quote |  | Walmart has opened a 900,000-square-foot facility in Stockton, Calif. that it says represents the la | pass | pass |  |  |
| Arvato | signal_quote |  | Arvato has opened its seventh facility in Louisville, adding approximately 400,000 square feet of lo | pass | pass |  |  |
| Maersk | signal_quote |  | A.P. Moller – Maersk (Maersk) today announced the opening in late August of a new fulfillment hub in | pass | pass |  |  |
| Arrive Logistics | employee_estimate_source | 5450 | 2,545 people | pass | pass |  |  |
| Arrive Logistics | hq_quote | Austin, Texas, United States | Headquartered in Austin, Texas, United States | pass | pass |  |  |
| Arrive Logistics | is_third_party_logistics_quote | true | Arrive Logistics is a North American logistics brokerage that provides shipping and carrier services | pass | pass |  |  |
| Campeys | signal_quote |  | Campeys of Selby has opened a new 190,000 sq ft warehouse at Sherburn 42, more than tripling its exi | pass | pass |  |  |
| LV Logistics (LV Shipping Ltd) | signal_quote |  | LV Shipping Ltd has completed the purchase of our Manby Road site in Immingham, which we have been o | pass | pass |  |  |
| Haulystic | signal_quote |  | Haulystic, a growing logistics business, has acquired the Daventry facility as part of the continued | pass | pass |  |  |
| Caddick Construction | signal_quote |  | Practical completion has been reached on a 63,000 sq ft centre for the parcel dispatch firm at the £ | pass | pass |  |  |
| Yusen Logistics | signal_quote |  | Yusen Logistics officially opened its Sustainable Distribution Centre (SDC) on Thursday 24th Septemb | pass | pass |  |  |
| Redevco | signal_quote |  | Redevco, one of Europe’s largest privately owned real estate managers, acquired a logistics fleet fa | pass | pass |  |  |
| LSH (Lambert Smith Hampton) | signal_quote |  | LSH Secures 57,643 sq ft Logistics Facility at Indurent Park Gloucester for Evri Premium | pass | pass |  |  |
| Pass Logistics | signal_quote |  | As Pass Logistics continues to grow, we're delighted to announce the acquisition of an additional wa | pass | pass |  |  |
| Pass Logistics | signal_quote |  | Pass Logistics expands Portfolio with Strategic Doncaster Warehouse Facility | pass | pass |  |  |
| Likewise Group | signal_quote |  | Likewise Group is acquiring a new distribution centre in Corby, Northamptonshire, for £9.57 million  | pass | pass |  |  |
| Evri Group | signal_quote |  | Evri Group has opened a new £1.3 million depot in Gloucester, expanding its parcel delivery network  | pass | pass |  |  |
| Likewise Group plc | signal_quote |  | Completion of the Purchase of Corby Distribution Hub | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk has fired up a 71,800 sqm warehouse in Herleshausen, Hessen, on the A4 motorway, leased long- | pass | pass |  |  |
| Cleveland Group | signal_quote |  | Cleveland Group has continued its rapid national expansion with the opening of a new Cleveland-opera | pass | pass |  |  |
| Route2 Logistics | signal_quote |  | Route2 Logistics has officially opened its new depot in Coatbridge, marking a major milestone in the | pass | pass |  |  |
| Saia Inc. | signal_quote |  | The opening of its newest terminal in Deer Park, New York, further expanding the company’s growing n | pass | pass |  |  |
| Saia Inc. | signal_quote |  | Saia Inc. announced the opening of its newest terminal in Deer Park, New York, further expanding the | FAIL | FAIL | segment_missing |  |
| Maersk | signal_quote |  | Maersk has fired up a 71,800-square-metre warehouse on Germany's A4 corridor in Herleshausen, Hessen | pass | pass |  |  |
| A. Duie Pyle | signal_quote |  | A. Duie Pyle has opened a 78,760-square-foot warehouse in Camp Hill, Pennsylvania, creating an integ | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  | Davinci Micro Fulfillment — which services customers throughout the United States — opened a locatio | pass | pass |  |  |
| Safexpress | signal_quote |  | Safexpress has opened a major logistics facility serving Gujarat manufacturers. Its new 350,000 sq f | pass | pass |  |  |
| FST Logistics | signal_quote |  | FST Logistics Expands Central Ohio Presence with New West Jefferson, Ohio Facility | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics... today announced it has signed a multi-year agreement with a Kansas City-area man | FAIL | pass |  |  |
| Rockefeller Group | signal_quote |  | Rockefeller Group has filled one of two new industrial buildings in Salem County, leasing 530,000 sq | pass | pass |  |  |
| XPO | signal_quote |  | XPO announced Thursday that it has added new locations in Arizona and Missouri, increasing its termi | pass | pass |  |  |
| Davidson Logistics | employee_estimate_source | 50 | Employees: 50 | pass | pass |  |  |
| Davidson Logistics | hq_quote | Saint Louis, Missouri, United  | Headquartered in Saint Louis, Missouri, United States. | pass | pass |  |  |
| Davidson Logistics | is_third_party_logistics_quote |  | null | FAIL | FAIL | too_short |  |
| Arrive Logistics | signal_quote |  | Arrive Logistics will hire 1,000 employees in 2026 across sales, operations, and technology roles fo | pass | pass |  |  |
| UPS | signal_quote |  | UPS is entering the busy 2026 holiday shipping season with expanded shipping options. | FAIL | pass |  |  |
| ShipMonk | signal_quote |  | A LinkedIn post from ShipMonk highlights that the company is recruiting seasonal full-time warehouse | pass | pass |  |  |
| UPS | signal_quote |  | UPS is scaling its workforce by hiring 100,000 seasonal employees nationwide ahead of the 2026 holid | pass | pass |  |  |
| UPS | signal_quote |  | UPS is hiring 100,000 seasonal workers across hundreds of U.S. locations for the 2026 holiday shippi | pass | pass |  |  |
| UPS | signal_quote |  | UPS announced plans to hire 100,000 seasonal workers ahead of the 2026 holiday shipping season, cont | pass | pass |  |  |
| Kuehne+Nagel | signal_quote |  | Kuehne+Nagel announced a record wave of hiring on October 2, 2026, adding 1,059 new job postings acr | pass | pass |  |  |
| Raicom | signal_quote |  | Director of Operations & 3PL Growth, Fulfillment Network | pass | pass |  |  |
| Flexport | signal_quote |  | Flexport opened its 1.1 million-square-foot Phillipsburg fulfillment center by mid-January, the comp | pass | pass |  |  |
| UPS | signal_quote |  | UPS (NYSE: UPS) announced plans to hire 100,000 seasonal employees across hundreds of locations nati | pass | pass |  |  |
| Arrive Logistics | signal_quote |  | Arrive Logistics is preparing for a new phase of expansion after Mubadala Capital agreed to acquire  | pass | pass |  |  |
| UPS | signal_quote |  | UPS has announced plans to hire 100,000 seasonal workers ahead of the 2026 holiday shipping season. | pass | pass |  |  |
| Southern AG Carriers, Inc. | employee_estimate_source | 119 | Employees: 119 | pass | pass |  |  |
| Southern AG Carriers, Inc. | hq_quote | Albany, Georgia, United States | Headquartered in Albany, Georgia, United States. | pass | pass |  |  |
| Southern AG Carriers, Inc. | is_third_party_logistics_quote | true | Southern AG Carriers is a trusted transportation provider specializing in agricultural and refrigera | pass | pass |  |  |
| Metropolitan Warehouse and Delivery | employee_estimate_source | 541 | Employees: 541 | pass | pass |  |  |
| Metropolitan Warehouse and Delivery | hq_quote | Perth Amboy, New Jersey, Unite | Headquartered in Perth Amboy, New Jersey, United States | pass | pass |  |  |
| Metropolitan Warehouse and Delivery | is_third_party_logistics_quote | true | Metropolitan Warehouse & Delivery provides reliable white glove delivery backed by a trusted 3PL war | pass | pass |  |  |
| Yusen Logistics | signal_quote |  | Yusen Logistics officially opens its Sustainable Distribution Centre (SDC) on Thursday 24th Septembe | FAIL | FAIL | segment_missing |  |
| Yusen Logistics UK | signal_quote |  | Yusen Logistics UK has opened a 1.1 million sq ft distribution centre near Northampton that uses an  | pass | pass |  |  |
| Yusen Logistics | signal_quote |  | Yusen Logistics opens a 1.2 million ft² automated distribution centre in Northampton with 236,000 pa | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk has started outbound operations at its Herleshausen logistics centre. | pass | pass |  |  |
| Caddick Construction | signal_quote |  | Practical completion has been reached on a 63,000 sq ft centre for the parcel dispatch firm at the £ | pass | pass |  |  |
| Campeys | signal_quote |  | Campeys of Selby has opened a new 190,000 sq ft warehouse at Sherburn 42, more than tripling its exi | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk leases 71,800 sqm at Panattoni Park Bad Hersfeld Ost, on the A4 in Herleshausen, Hessen, for  | pass | pass |  |  |
| CEVA Logistics | signal_quote |  | the opening of a new large-scale warehouse operation in Derby, UK | pass | pass |  |  |
| Finsa UK | signal_quote |  | Finsa UK has opened the doors on its new £20 million logistics hub in Birkenhead at Grandidges Quay, | pass | pass |  |  |
| Palletways | signal_quote |  | Building work on Palletways’ new national headquarters at Fradley is expected to start in November. | pass | pass |  |  |
| Yusen Logistics UK | signal_quote |  | New giant warehouse in England's logistics "golden triangle" is adopting pioneering technology previ | pass | pass |  |  |
| Yusen Logistics UK | signal_quote |  | Yusen Logistics UK has opened a 1.1 million sq ft distribution centre in Northampton, introducing a  | pass | pass |  |  |
| Davinci Micro Fulfillment | employee_estimate_source | 49 | Employees: 49 | pass | pass |  |  |
| Davinci Micro Fulfillment | hq_quote | Bound Brook, United States | Headquartered in Bound Brook, New Jersey, United States | pass | pass |  |  |
| Davinci Micro Fulfillment | is_third_party_logistics_quote | true | Davinci Micro Fulfillment partners with brands to support their direct to consumer eCommerce busines | pass | pass |  |  |
| ColdTrack | employee_estimate_source | 106 | Employees: 106 | pass | pass |  |  |
| ColdTrack | hq_quote | Edison, New Jersey, United Sta | Headquartered in New York City and with locations in Edison, NJ, Stockton, CA, Patterson, CA, and In | pass | pass |  |  |
| ColdTrack | is_third_party_logistics_quote | true | ColdTrack is described as the leading tech-enabled third-party fulfillment platform for B2C and B2B  | FAIL | FAIL | segment_missing |  |
| Yusen Logistics | signal_quote |  | Yusen Logistics officially opened its Sustainable Distribution Centre (SDC) on Thursday 24th Septemb | pass | pass |  |  |
| Yusen Logistics UK | signal_quote |  | Yusen Logistics UK has opened a 1.1 million sq ft distribution centre near Northampton that uses an  | pass | pass |  |  |
| Yusen Logistics | signal_quote |  | Yusen Logistics opens a 1.2 million ft² automated distribution centre in Northampton with 236,000 pa | pass | pass |  |  |
| Allegro | signal_quote |  | The expansion includes the addition of a further warehouse at Allegro’s established Clevedon operati | pass | pass |  |  |
| Evri Group | signal_quote |  | Evri Group has opened a new depot in Gloucester following a £1.3 million investment to strengthen it | pass | pass |  |  |
| Finsa UK | signal_quote |  | Finsa UK has opened the doors on its new £20 million logistics hub in Birkenhead at Grandidges Quay, | pass | pass |  |  |
| Yusen Logistics UK | signal_quote |  | A new giant warehouse in England's logistics "golden triangle" is adopting pioneering technology pre | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk has started outbound operations at its Herleshausen logistics centre. | pass | pass |  |  |
| Yusen Logistics UK | signal_quote |  | Yusen Logistics UK has opened a 1.1 million sq ft distribution centre in Northampton, introducing a  | pass | pass |  |  |
| Maersk | signal_quote |  | Maersk has fired up a 71,800-square-metre warehouse on Germany's A4 corridor in Herleshausen, Hessen | pass | pass |  |  |
| SJH Fulfilment | signal_quote |  | The investment in a new 46,000 sq ft facility in Greater Belfast, more than doubles its Northern Ire | pass | pass |  |  |
| Richardson Barberry | signal_quote |  | Practical completion has been reached on a 63,000 sq ft centre for the parcel dispatch firm at the £ | pass | pass |  |  |
| SJH Fulfilment | signal_quote |  | SJH Fulfilment has announced a £3.5 million investment in a new 46,000 sq ft Greater Belfast fulfilm | pass | pass |  |  |
| Campeys | signal_quote |  |  | - | - | empty |  |
| Campeys of Selby | signal_quote |  | Campeys of Selby has opened a new 190,000 sq ft warehouse at Sherburn 42, more than tripling its exi | pass | pass |  |  |
| Sammons Warehouse Solutions | employee_estimate_source | 30 | Employees: 30 | pass | pass |  |  |
| Sammons Warehouse Solutions | hq_quote | Alpharetta, Georgia, United St | Headquartered in Alpharetta, Georgia, United States, with an office in Dallas. | pass | pass |  |  |
| Sammons Warehouse Solutions | is_third_party_logistics_quote | false | - Industry: Warehousing and Storage; Type: Privately held; Headquarters: Alpharetta, United States;  | FAIL | FAIL | segment_missing |  |
| Meyer Logistics Inc. | employee_estimate_source | 86 | Employees: 86 | pass | pass |  |  |
| Meyer Logistics Inc. | hq_quote | Jasper, Indiana, United States | Headquartered in Jasper, Indiana, United States. | pass | pass |  |  |
| Meyer Logistics Inc. | is_third_party_logistics_quote |  | - Industry: Transportation, Logistics and Storage - Type: Privately held - Headquarters: Jasper, Uni | FAIL | FAIL | segment_missing |  |
| Palletways | employee_estimate_source | 239 | Employees: 239 | pass | pass |  |  |
| Palletways | hq_quote | Headquartered in Lichfield, St | Headquartered in Lichfield, Staffordshire, United Kingdom, with offices in Livingstone, Greenford, M | pass | pass |  |  |
| Palletways | is_third_party_logistics_quote |  |  | - | - | empty |  |
| Yusen Logistics UK | employee_estimate_source | 13165 | Employees: 13,165 | pass | pass |  |  |
| Yusen Logistics UK | hq_quote | Tokyo, Japan | Headquartered in Tokyo, Japan | pass | pass |  |  |
| Yusen Logistics UK | is_third_party_logistics_quote | true | Yusen Logistics has a global network linking Japan, the Americas, Europe, East Asia and South Asia & | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics, a nationwide provider of third-party logistics, today announced it has signed a mu | pass | pass |  |  |
| ID Logistics | signal_quote |  | France-based ID Logistics, with U.S. headquarters in Georgia, has leased the 650,000-square-foot rec | pass | pass |  |  |
| Hollingsworth Logistics | signal_quote |  | Hollingsworth Logistics is adding 150 jobs and consolidating its operations near San Antonio with a  | pass | pass |  |  |
| A. Duie Pyle | signal_quote |  | A. Duie Pyle has opened a 78,760-square-foot warehouse in Camp Hill, Pennsylvania, creating an integ | pass | pass |  |  |
| Greystar | signal_quote |  | Greystar, a global leader in rental housing, investment management, development, and property manage | pass | pass |  |  |
| Westcore | signal_quote |  | Westcore acquires Keystone Crossings II, a 281,600-square-foot distribution facility at 100 Crossing | FAIL | pass |  |  |
| Davidson Logistics | signal_quote |  | Davidson Logistics celebrated the grand opening of its new warehouse in Bridgeton on Thursday. | pass | pass |  |  |
| Meyer Logistics Inc. | signal_quote |  | Meyer Logistics Inc., a leader in specialty products logistics and shipping, announced the opening o | pass | pass |  |  |
| Wagner Logistics | signal_quote |  | Wagner Logistics is laying down some serious roots in Liberty, MO. They’ve snagged a deal with a loc | pass | pass |  |  |
| Link Logistics | signal_quote |  | Link Logistics announced Oct. 12 that it has acquired the Eaton Logistics Facility, a 550,992-square | pass | pass |  |  |
| Everflow Supplies | signal_quote |  | A national distributor of plumbing, HVAC and other products has leased nearly 333,000 square feet at | pass | pass |  |  |
| Clark Distributing Co. | signal_quote |  | Clark Distributing Co. is expanding its operations in Owensboro with plans to build a new 26,000-squ | pass | pass |  |  |
| Opus | signal_quote |  | Opus has completed leasing at a three-building industrial park about 20 miles from Kansas City, Miss | pass | pass |  |  |
| Davinci Micro Fulfillment | signal_quote |  | Davinci Micro Fulfillment — which services customers throughout the United States — opened a locatio | pass | pass |  |  |
| S&C Electric Company, LSL Industries | signal_quote |  | Dermody announced two new leases totaling 376,503 square feet at The Logistics Campus in Glenview, I | pass | pass |  |  |
| Pass Logistics | employee_estimate_source | 39 | Pass Logistics employs 39 people (+5.4% YoY, +2 people) | pass | pass |  |  |
| Pass Logistics | hq_quote | Harworth, United Kingdom | Headquartered in Harworth, Northumberland, United Kingdom. | pass | pass |  |  |
| Pass Logistics | is_third_party_logistics_quote | true | Pass Logistics is a UK logistics company offering 3PL, warehousing, national same‑day courier, UK an | FAIL | FAIL | segment_missing |  |
| Wagner Logistics | employee_estimate_source | 300 | Employees: 300 | pass | pass |  |  |
| Wagner Logistics | hq_quote | North Kansas City, Missouri, U | Headquartered in North Kansas City, Missouri, United States | pass | pass |  |  |
| Wagner Logistics | is_third_party_logistics_quote | true | Wagner is a leading 3PL service provider offering distribution, warehousing, contract packaging and  | pass | pass |  |  |
| PermaCold Logistics | signal_quote |  | FOR IMMEDIATE RELEASE: PermaCold Logistics Celebrates Grand Opening of State-of-the-Art Cold Storage | pass | pass |  |  |
| Central Storage & Warehouse | signal_quote |  | Central Storage & Warehouse(CSW), a premier Midwest cold storage developer and operator, celebrated  | pass | pass |  |  |
| We Store Frozen | signal_quote |  | Houston Storage Expansion: 13,000+ New Pallet Positions Across Frozen, Refrigerated, and Ambient Sto | FAIL | pass |  |  |
| J.G. Petrucci Company and BGO Cold Chain | signal_quote |  | J.G. Petrucci Company and BGO Cold Chain announced Aug. 11 that Freshpet has signed a lease for the  | pass | pass |  |  |
| PermaCold Logistics | signal_quote |  | PermaCold Logistics has officially broken ground on a new state-of-the-art cold storage facility | pass | pass |  |  |
| FreezPak Logistics | signal_quote |  | FreezPak Logistics, a national leader in temperature-controlled logistics solutions, opened a new st | pass | pass |  |  |
| Central Storage & Warehouse | signal_quote |  | Central Storage & Warehouse(CSW), a premier Midwest cold storage developer and operator, celebrated  | pass | pass |  |  |
| ColdTrack | signal_quote |  | Moving cold food to homes in a hot region presents a shipping challenge. | pass | pass |  |  |
| PermaCold Logistics | signal_quote |  | PermaCold Logistics has broken ground on a new frozen cold storage facility in Alabama. | pass | pass |  |  |
| Interstate Capital | signal_quote |  | A developer is preparing to make a more than $50 million bet on a massive cold-storage facility near | pass | pass |  |  |
| Baselayer | employee_estimate_source | 34 | Employees: 34 | pass | pass |  |  |
| Baselayer | hiring_first_ops_or_revops_quote | false |  | - | - | empty |  |
| Baselayer | hq_quote | New York, United States | Headquartered in New York, New York, United States | pass | pass |  |  |
| Baselayer | is_b2b_company_quote | true | Baselayer is a Technology, Information and Internet company. | pass | pass |  |  |
| Baselayer | recently_funded_seed_or_series_a_quote | true | - Yearly Growth: +57.1% (Employees: 34) - Annual Revenue: USD 540,000,000 - Yearly Growth: +57.1% | FAIL | FAIL | segment_missing |  |
| Forgepoint | employee_estimate_source | 7 | 7 employees (Yearly Growth: +600.0%, 11-50 employees company size) | FAIL | FAIL | segment_missing |  |
| Forgepoint | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Forgepoint | hq_quote | United States and Australia | By Country: United States: 5 (71%), Australia: 1 (14%) | pass | pass |  |  |
| Forgepoint | is_b2b_company_quote | true | Industry: Software Development | pass | pass |  |  |
| Forgepoint | recently_funded_seed_or_series_a_quote | true | Yearly Growth: +600.0% | pass | FAIL | too_short |  |
| Othello | employee_estimate_source | 24 | Employees: 24 | pass | pass |  |  |
| Othello | hiring_first_ops_or_revops_quote | true | Brandon's right - we're hiring for tons of roles across GTM and engineering and we don't care if you | pass | pass |  |  |
| Othello | hq_quote | New York, United States | Headquartered in New York, New York, United States. | pass | pass |  |  |
| Othello | is_b2b_company_quote | true | Othello is a Software Development company. | pass | pass |  |  |
| Othello | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 6,850,000 - Seed (2026-08-01): USD 6.8M | pass | pass |  |  |
| Axle | employee_estimate_source | 43 | Employees: 43 | pass | pass |  |  |
| Axle | hiring_first_ops_or_revops_quote | true | Active job postings: 21 | pass | FAIL | too_short |  |
| Axle | hq_quote | New York City, United States | Headquartered in New York City, New York, United States, with an office in Atlanta. | pass | pass |  |  |
| Axle | is_b2b_company_quote | true | Axle is a Software Development company. Axle is an AI-native clearinghouse for insurance that provid | pass | pass |  |  |
| Axle | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 26,060,000 - Series a (2026-08-01): USD 17.5M; Seed (2023-04-10): USD 4.0M; Seed  | FAIL | pass |  | spans 5 non-empty lines |
| Digs | employee_estimate_source | 58 | Employees: 58 | pass | pass |  |  |
| Digs | hiring_first_ops_or_revops_quote | true | We’re excited to welcome two new members to Digs as we continue building what’s next | FAIL | FAIL | segment_missing |  |
| Digs | hq_quote | Vancouver, United States | Headquartered in Vancouver, Washington, United States, with an office in New York. | pass | pass |  |  |
| Digs | is_b2b_company_quote | true | Industry: Software Development | pass | pass |  |  |
| Digs | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 44,300,000 - Series a (2026-08-01): USD 25.3M; Seed (2025-11-01): USD 5.0M; Seed  | FAIL | pass |  | spans 6 non-empty lines |
| Zenskar | employee_estimate_source | 116 | Employees: 116 | pass | pass |  |  |
| Zenskar | hiring_first_ops_or_revops_quote | true | We’re hiring an Engineering Manager at Zenskar. 🚀 Billing gets complicated fast. Pricing changes, c | pass | pass |  |  |
| Zenskar | hq_quote | Headquartered in New York, New | Headquartered in New York, New York, United States. | pass | pass |  |  |
| Zenskar | is_b2b_company_quote | true | Industry: Software Development | pass | pass |  |  |
| Zenskar | recently_funded_seed_or_series_a_quote | true | We’re hiring an Engineering Manager at Zenskar. 🚀 (context implying ongoing hiring post funding) | FAIL | FAIL | segment_missing |  |
| OuterSignal | employee_estimate_source | 31 | Employees: 31 | pass | pass |  |  |
| OuterSignal | hiring_first_ops_or_revops_quote | true | Two especially massive roles we’ve just opened: → Head of Marketing → Head of Partnerships | pass | pass |  |  |
| OuterSignal | hq_quote | Wilmington, Delaware, United S | Headquartered in Wilmington, Delaware, United States. | pass | pass |  |  |
| OuterSignal | is_b2b_company_quote | true | - B2B leads in DTC | FAIL | FAIL | too_short |  |
| OuterSignal | recently_funded_seed_or_series_a_quote | true | [2026-10-02] Pulse 2.0: OuterSignal Raises $22 Million Series A To Expand Agentic Customer Personali | FAIL | pass |  |  |
| Clueso | signal_quote |  | The company announced a $10 million Series A on October 13, led by Dharana Capital. | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Avarra.ai | signal_quote |  | Avarra today announced a $17 million Series A following a year in which the company grew ARR more th | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Meticulous | signal_quote |  | Meticulous announces a $15m Series A round led by Chemistry to enable every developer to ship at the | pass | pass |  |  |
| Siena | signal_quote |  | Siena, the AI-driven customer experience platform trusted by hundreds of leading consumer brands to  | pass | pass |  |  |
| OuterSignal | signal_quote |  | OuterSignal, the agentic customer intelligence platform that tells brands who their customers actual | pass | pass |  |  |
| Marklo AI | signal_quote |  | Marklo has now raised $5 million in seed funding | FAIL | FAIL | segment_missing |  |
| Clueso | signal_quote |  | Clueso’s $10M Series A, led by Dharana Capital, with continued participation from Y Combinator and f | pass | pass |  |  |
| Clueso | signal_quote |  | Clueso has raised $10 million in series A funding to expand software that uses AI agents to record w | pass | pass |  |  |
| Forgepoint Inc. | signal_quote |  | One of President Donald Trump’s main priorities is to revive America’s manufacturing industry in ord | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Uvi | signal_quote |  | Uvi said today it has raised $7.5 million in seed funding to tackle an expensive problem around busi | pass | pass |  |  |
| Duvo | signal_quote |  | Duvo today announced a $32 million Series A led by Balderton Capital, with participation from existi | pass | pass |  |  |
| Marklo | signal_quote |  | Marklo raises $5M to launch the Agentic Marketing Platform for Modern Commerce | pass | pass |  |  |
| Othello | signal_quote |  | Othello exclusively told CMO Insider on Wednesday that it had raised an $8 million seed funding roun | pass | pass |  |  |
| Mogul | signal_quote |  | Mogul, the AI-powered real estate investing platform, today announced it closed a $15.5 million Seri | FAIL | pass |  |  |
| Readily | signal_quote |  | Readily, an AI-native compliance intelligence platform for healthcare, today announced an $11 millio | pass | pass |  |  |
| Forgepoint | signal_quote |  | Forgepoint today announced a $9.8 million seed round led by Primary Venture Partners and a16z speedr | pass | pass |  |  |
|  Baselayer | signal_quote |  | Baselayer, the identity and risk infrastructure company trusted by 1 in 5 financial institutions nat | pass | pass |  |  |
| Avarra.ai | employee_estimate_source | 31 | Employees: 31 | pass | pass |  |  |
| Avarra.ai | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Avarra.ai | hq_quote | San Mateo, United States | Headquartered in San Mateo, California, United States. | pass | pass |  |  |
| Avarra.ai | is_b2b_company_quote | true | Industry: Software Development - Type: Privately held | pass | pass |  |  |
| Avarra.ai | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 8,000,000 - Seed (2024-10-03): USD 8.0M ... | FAIL | pass |  |  |
| Fazeshift | employee_estimate_source | 44 | Employees: 44 | pass | pass |  |  |
| Fazeshift | hiring_first_ops_or_revops_quote | true | Key Executives include roles such as Head of Sales and Head of Strategy & Operations, indicating ope | FAIL | FAIL | segment_missing |  |
| Fazeshift | hq_quote | San Francisco, United States | Headquartered in San Francisco, California, United States. | pass | pass |  |  |
| Fazeshift | is_b2b_company_quote | true | - Industry: Software Development - Type: Privately held | pass | pass |  |  |
| Fazeshift | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 21,825,000 — including Series A (2026-05-01) USD 17.0M and Seed (2025-01-07): USD | FAIL | FAIL | segment_missing |  |
| Graph AI | signal_quote |  | Graph AI, developer of the Graph Safety AI-native patient safety platform, today announced a $13.3 m | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Stuut Inc. | signal_quote |  | The company today said it has closed on a Series B funding round worth $52.5 million, bringing its t | pass | pass |  |  |
| Zenskar | signal_quote |  | Zenskar, the AI-native billing and revenue automation platform powering Zero-Touch Finance for real- | pass | pass |  |  |
| Fazeshift | signal_quote |  | Fazeshift, a startup that uses AI agents to automate accounts receivable, has raised $17 million in  | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Monk | signal_quote |  | The first time we met George and Joe, they walked us through their customers’ collections challenges | pass | pass |  |  |
| Ampersand | signal_quote |  | Ampersand today announced a $15 million Series A led by Bessemer Venture Partners, with participatio | pass | pass |  |  |
| Agave | signal_quote |  | We’ve raised a $15M Series A led by Accel, with continued participation from Y Combinator, bringing  | pass | pass |  |  |
| Forgepoint Inc. | signal_quote |  | One of President Donald Trump’s main priorities is to revive America’s manufacturing industry in ord | pass | pass |  |  |
| Axya | signal_quote |  | Axya closes $17-million Series A to modernize manufacturing procurement | pass | pass |  |  |
| Go.AI | signal_quote |  | Go.AI™, the leading provider of on-premises, examiner-ready AI infrastructure for regulated industri | pass | pass |  |  |
| Fazeshift | signal_quote |  | Exclusive: Fazeshift Scores $17M As Investors Bet On AI-Powered Finance Ops, Starting With Accounts  | pass | pass |  |  |
| Fazeshift | signal_quote |  | Fazeshift, a startup that uses AI agents to automate accounts receivable, has raised $17 million in  | pass | pass |  |  |
| Avarra.ai | signal_quote |  | Avarra today announced a $17 million Series A following a year in which the company grew ARR more th | pass | pass |  |  |
| Fazeshift | signal_quote |  | Exclusive: Fazeshift Scores $17M As Investors Bet On AI-Powered Finance Ops, Starting With Accounts  | pass | pass |  |  |
| Centralize | signal_quote |  | Centralize, an enterprise sales platform emerging from stealth today alongside a $15 million Series  | pass | pass |  |  |
| Reo.Dev | signal_quote |  | Just eight months after announcing its Seed round, Reo.Dev, the AI-native GTM platform built for com | pass | pass |  |  |
| Fazeshift | signal_quote |  |  | - | - | empty |  |
| Clueso | signal_quote |  | The company announced a $10 million Series A on October 13, led by Dharana Capital. | pass | pass |  |  |
| Agave | employee_estimate_source | 95 | Employees: 95 | pass | pass |  |  |
| Agave | hiring_first_ops_or_revops_quote | true | We are hiring the Head of Sales. | FAIL | FAIL | segment_missing |  |
| Agave | hq_quote | San Francisco, United States | Headquartered in San Francisco, California, United States. | pass | pass |  |  |
| Agave | is_b2b_company_quote | true | Agave is a Software Development company. | pass | pass |  |  |
| Agave | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 18,525,000 - Series a (2026-07-01): USD 15.0M; Seed (2023-08-30): USD 2.9M; Seed  | FAIL | pass |  | spans 5 non-empty lines |
| Siena | employee_estimate_source | 2632 | Employees: 2,632 | pass | pass |  |  |
| Siena | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Siena | hq_quote | Siena, Tuscany, Italy | Headquartered in Siena, Tuscany, Italy | pass | pass |  |  |
| Siena | is_b2b_company_quote |  |  | - | - | empty |  |
| Siena | recently_funded_seed_or_series_a_quote | false | Further funding details are not stated on the page. | FAIL | FAIL | segment_missing |  |
| Meticulous | employee_estimate_source | 29 | Employees: 29 | pass | pass |  |  |
| Meticulous | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Meticulous | hq_quote | London, United Kingdom | Headquartered in London, England, United Kingdom | pass | pass |  |  |
| Meticulous | is_b2b_company_quote | true | Meticulous is a Software Development company. | pass | pass |  |  |
| Meticulous | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 19,125,000 - Series a (2026-07-01): USD 15.0M - Seed (2023-02-01): USD 4.0M  | pass | pass |  | spans 5 non-empty lines |
| Zeroset | employee_estimate_source | 5 | Employees: 5 | pass | pass |  |  |
| Zeroset | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Zeroset | hq_quote | San Francisco, California, Uni | Headquartered in San Francisco, United States | FAIL | pass |  |  |
| Zeroset | is_b2b_company_quote | true | Industry: Software Development | pass | pass |  |  |
| Zeroset | recently_funded_seed_or_series_a_quote |  |  | - | - | empty |  |
| Ampersand | employee_estimate_source | 661 | Employees: 661 | pass | pass |  |  |
| Ampersand | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Ampersand | hq_quote | New York, New York, United Sta | Headquartered in New York, New York, United States. | pass | pass |  |  |
| Ampersand | is_b2b_company_quote | true | Ampersand is an Advertising Services company. | FAIL | FAIL | segment_missing |  |
| Ampersand | recently_funded_seed_or_series_a_quote |  |  | - | - | empty |  |
| Readily | employee_estimate_source | 24 | "Employees: 24" | FAIL | pass |  |  |
| Readily | hiring_first_ops_or_revops_quote | true | Key Executives: ... Chelsea Hardy: VP of Compliance ... | FAIL | pass |  |  |
| Readily | hq_quote | San Francisco, United States | Headquartered in San Francisco, United States. | pass | pass |  |  |
| Readily | is_b2b_company_quote | true | Industry: Information Services | pass | pass |  |  |
| Readily | recently_funded_seed_or_series_a_quote |  | null - not stated on page, no funding round mentioned in provided excerpts. | FAIL | FAIL | segment_missing |  |
| Graph AI | employee_estimate_source | 22 | Employees: 22 | pass | pass |  |  |
| Graph AI | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Graph AI | hq_quote | Pleasanton, California, United | Headquartered in Pleasanton, California, United States, with an office in Hyderabad. | pass | pass |  |  |
| Graph AI | is_b2b_company_quote | true | - Industry: Technology, Information and Internet - Type: Privately held | pass | pass |  |  |
| Graph AI | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 16,300,000 - Series a (2026-09-01): USD 13.3M - Seed (2025-11-15): USD 3.0M - ... | FAIL | pass |  |  |
| Arzana | employee_estimate_source | 6 | Employees: 6 | pass | pass |  |  |
| Arzana | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Arzana | hq_quote | New York, United States | Headquartered in New York, New York, United States, with an office in San Francisco. | pass | pass |  |  |
| Arzana | is_b2b_company_quote | true | - Industry: Software Development - Type: Privately held - Headquarters: New York, United States | pass | pass |  |  |
| Arzana | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 4,925,000 - Seed (2026-07-01): USD 4.3M - Pre seed (2026-06-01): USD 500,000  | pass | pass |  | spans 4 non-empty lines |
| Axle | signal_quote |  | We're thrilled to announce $17.5M in Series A funding led by Base10 Partners, with continued investm | pass | pass |  |  |
| Rebuild | signal_quote |  | Asymmetric led the Series A in Rebuild, the New York-based company building the AI-native operating  | pass | pass |  |  |
| Axle | signal_quote |  | Axle, the AI-native clearinghouse for insurance, today announced $17.5M in Series A funding led by B | pass | pass |  |  |
| Rebuild | signal_quote |  | Rebuild, which sells software to property restoration contractors, announced on 15 September that it | pass | pass |  |  |
| Agave | signal_quote |  | Agave, the AI platform for construction financials, today announced it raised a $15M Series A fundin | pass | pass |  |  |
| Agave | signal_quote |  | We’ve raised a $15M Series A led by Accel, with continued participation from Y Combinator, bringing  | pass | pass |  |  |
| Agave | signal_quote |  | Agave, the AI platform for construction financials, today announced it raised a $15M Series A fundin | pass | pass |  |  |
| Ledgebrook | signal_quote |  | Ledgebrook ... today announced it has raised USD 200 million in primary equity financing co-led by A | FAIL | FAIL | segment_missing |  |
| Axle | signal_quote |  | Axle, a technology company developing an AI-native clearinghouse for the insurance industry, has rai | pass | pass |  |  |
| Miter | signal_quote |  | Miter, the leading AI-powered workforce management platform for the construction industry and the bu | pass | pass |  |  |
| Digs | signal_quote |  | Digs, a Vancouver, Wash.-based startup building AI software for residential construction, raised $25 | pass | pass |  |  |
| Upside | signal_quote |  | Upside, the only nationally scalable housing stability platform purpose-built for healthcare, today  | pass | pass |  |  |
| RockRose Risk | signal_quote |  | RockRose Risk, the insurance brokerage giving property owners discounts for wildfire mitigation, tod | pass | pass |  |  |
| Digs | signal_quote |  | Digs, a Vancouver, Washington-based startup building AI software for residential construction, raise | pass | pass |  |  |
| Adaptive | signal_quote |  | Adaptive, the agentic accounting platform for construction, today announced it has raised $30 millio | pass | pass |  |  |
| Axle | signal_quote |  | The company has raised $17.5 million in Series A funding, led by Base10 Partners. | pass | pass |  |  |
| Ledgebrook | signal_quote |  | Ledgebrook has secured $200 mn in primary equity financing co-led by Allianz X and Rockefeller Capit | pass | pass |  |  |
| Scaffold | signal_quote |  | Scaffold has announced a $15 million seed round led by Navitas Capital, dated 15 September from Aust | pass | pass |  |  |
| Outmarket AI Inc | signal_quote |  | Outmarket AI, the leading AI platform purpose-built for insurance, today announced it has raised $34 | pass | pass |  |  |
| Ledgebrook | signal_quote |  | Ledgebrook… today announced it has raised USD 200 million in primary equity financing co-led by Alli | FAIL | FAIL | segment_missing |  |
| Nectar | signal_quote |  | Founding Revenue Operations Manager at Nectar · Palo Alto, CA | pass | pass |  |  |
| Rebar | signal_quote |  |  | - | - | empty |  |
| Rebar | signal_quote |  |  | - | - | empty |  |
| Keycard | signal_quote |  |  | - | - | empty |  |
| remotenex.us | signal_quote |  | "Head of Operations & Finance" | FAIL | pass |  |  |
| MintMCP | signal_quote |  | Founding Operations (Recruiting Coordinator / People Coordinator) at MintMCP \| Remote Source | pass | pass |  |  |
| remotenex.us | signal_quote |  | VP of Operations | pass | FAIL | too_short |  |
| Bravi | signal_quote |  | Bravi (YC F25) - Founding GTM - New York | pass | pass |  |  |
| Rivet Recruiting | signal_quote |  | Rivet Recruiting is partnering with a Series A, woman-founded (🙌) AI health tech company backed by  | pass | pass |  |  |
| Sybill | signal_quote |  | Excited to share that I’ve joined Sybill as Founding Revenue Operations Lead!🚀 | pass | pass |  |  |
| Othello | signal_quote |  | Othello... had raised an $8 million seed funding round, led by Andreessen Horowitz's startup acceler | FAIL | FAIL | segment_missing |  |
| Marklo | signal_quote |  | Marklo raises $5M to launch the Agentic Marketing Platform for Modern Commerce | pass | pass |  |  |
| Marklo AI | signal_quote |  |  | - | - | empty |  |
| Clueso | signal_quote |  | The company announced a $10 million Series A on October 13, led by Dharana Capital. | pass | pass |  |  |
| Othello | signal_quote |  | Othello just raised an $8 million seed funding round, led by Andreessen Horowitz‘s startup accelerat | FAIL | FAIL | segment_missing |  |
| Uvi | signal_quote |  | Uvi raises $7.5M to help AI agents learn business context and run at eight times lower cost | pass | pass |  |  |
| Zeroset | signal_quote |  | Zeroset raised a $5.2M pre-seed round to build Nebula, a state layer designed to help enterprise AI  | pass | pass |  |  |
| Zeroset | signal_quote |  | Zeroset raised a $5.2M pre-seed round led by Gradient Ventures to build Nebula, an AI agent context  | pass | pass |  |  |
| Zeroset | signal_quote |  | Zeroset announced Sunday it raised $5.2 million in pre-seed funding co-led by Gradient Ventures and  | pass | pass |  |  |
| Evos (Evolutionary Operating System, Inc.) | signal_quote |  | Evos is betting that capturing those judgments can turn AI from another tool employees manage into s | pass | pass |  |  |
| Zeroset | signal_quote |  | Now, Zeroset has come out of stealth and raised $5.2 million to build models that give AI agents a c | pass | pass |  |  |
| Forgepoint | signal_quote |  | Forgepoint today announced a $9.8 million seed round led by Primary Venture Partners and a16z speedr | pass | pass |  |  |
| Forgepoint Inc. | signal_quote |  | Forgepoint is the creator of an artificial intelligence agent that acts as an “inside sales rep,” he | pass | pass |  |  |
| Hone | signal_quote |  | Hone raises seed funding co-led by Benchmark and Index Ventures to build autonomous AI 'engines' tha | pass | pass |  |  |
| Arzana | signal_quote |  | The company announced a $4.3 million seed round in October 2026, bringing its total disclosed fundin | pass | pass |  |  |
| Uvi | signal_quote |  | Uvi, a startup that feeds company knowledge to AI agents, has emerged from stealth with $7.5 million | pass | pass |  |  |
| Causa Prima | signal_quote |  | Causa Prima has raised $20 million in seed funding to bring its AI-powered payments platform to the  | pass | pass |  |  |
| Evolutionary Operating System Inc. (Evos) | signal_quote |  | Evos said today it has raised $9 million in pre-seed funding to spearhead the adoption of artificial | pass | pass |  |  |
| Zeroset | signal_quote |  | Zeroset,... has raised $5.2 million in pre-seed funding. | FAIL | FAIL | segment_missing |  |
| Dapta | signal_quote |  | Dapta, the Miami- and Scottsdale-based startup building an AI sales agent for small businesses, said | pass | pass |  |  |
| Clueso | employee_estimate_source | 41 | Employees: 41 | pass | pass |  |  |
| Clueso | hiring_first_ops_or_revops_quote |  |  | - | - | empty |  |
| Clueso | hq_quote | San Francisco, United States | Headquartered in San Francisco, United States, with an office in Campbell. | pass | pass |  |  |
| Clueso | is_b2b_company_quote | true |  | - | - | empty |  |
| Clueso | recently_funded_seed_or_series_a_quote | true | Total Funding: USD 1,900,000; Seed (2024-04-23): USD 1.4M; Pre seed (2023-03-24): USD 500,000 | FAIL | pass |  |  |
