# Sample output — ICP 1 (logistics ops, scaling)

Captured from a live run: `npm run prospect -- --icp 1`. Each company was found via a fresh, dated "why-now" trigger; the source URL and the why-now text for each are generated at runtime (run it yourself to reproduce).

| Company | Why-now signal | Date | Confidence | Net-new |
|---|---|---:|---:|:--:|
| King of Freight | new-facility / expansion | 2026-09-21 | 0.95 | ✓ |
| Roadway Moving | new 117,000 sq ft Long Island City facility | 2026-09-17 | 0.96 | ✓ |
| Southern AG Carriers | new-facility / expansion | 2026-09-17 | 0.96 | ✓ |
| G10 Fulfillment | grand opening, new Kenosha distribution facility | 2026-08-31 | 0.79 | ✓ |
| MIURA Logistics | new-facility / expansion | 2026-07-14 | 0.79 | ✓ |
| Meridian Direct | operations hiring signal | 2026-09-16 | 0.78 | ✓ |
| Suddath | operations hiring signal | 2026-09-16 | 0.64 | ✓ |
| Logistics Plus | operations hiring signal | 2026-08-30 | 0.64 | ✓ |

Every company is a **US mid-market logistics/3PL operator with a real, recent scaling trigger** — not the enterprise giants (DHL, FedEx, GXO, RXO) that a keyword search surfaces. The eval filters out enterprise-scale, out-of-geo, and non-3PL companies *before* scoring, so what's left is what a rep would actually want to reach out to this quarter.

Signals ranked highest are hard triggers (new facility / expansion); single job postings score lower. Each row's `source_url` is a press release or job posting a rep can open and verify in two seconds.
