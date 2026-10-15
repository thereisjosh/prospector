import { describe, expect, it } from "vitest";
import {
  checkLead,
  parseEmployeeEstimate,
  quoteInText,
  quoteMatch,
  headcountQuoteInText,
  resolveEventDate,
  sizeQuoteSupports,
  squashName,
  type LeadInput,
} from "../src/gates";
import { scoreAndRank, type Candidate } from "../src/score";
import { monthsAgoIso } from "../src/config";
import type { SearchPlan } from "../src/plan";
import { nameMatchesSignal } from "../src/eval";
import { COUNTRY_CODES, countryOfHq, textInCountries } from "../src/geo";
import { V1_PLAN_1 } from "./fixtures/v1-plans";

const NOW = new Date("2026-10-11T03:00:00.000Z");
const GATE = "is_third_party_logistics";

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  ...V1_PLAN_1,
  excludeNames: ["RXO"],
  excludeDomains: ["blocked.example"],
  ...over,
});

function lead(over: Partial<LeadInput> & { enrichment?: Record<string, unknown> | undefined } = {}): LeadInput {
  const company = over.company ?? "ShipCo";
  return {
    company,
    signal: {
      url: "https://news.example.com/shipco",
      title: `${company} opens new warehouse`,
      text: `${company} opened a warehouse in Ohio.`,
      summary: {
        company_name: company,
        signal_type: "new_facility",
        signal_summary: `${company} opened a new warehouse.`,
        signal_date: "2026-09-20",
        signal_quote: `${company} opens new warehouse`,
        signal_date_quote: "",
      },
      publishedDate: "2026-09-21T00:00:00.000Z",
    },
    enrichment: {
      description: "third party logistics provider",
      is_public_or_enterprise: false,
      employee_estimate: 300,
      employee_estimate_source: "300 employees",
      hq: "Columbus, Ohio, United States",
      hq_quote: "Columbus, Ohio, United States",
      [GATE]: true,
      [`${GATE}_quote`]: "third party logistics provider",
    },
    now: NOW,
    ...over,
  } as LeadInput;
}

const code = (input: LeadInput, p = plan()) => {
  const v = checkLead(p, input);
  return v.ok ? "ok" : v.code;
};

describe("checkLead: one test per gate code", () => {
  it("ok: returns details", () => {
    const v = checkLead(plan(), lead());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.details).toMatchObject({
      key: "shipco",
      event_date: "2026-09-20",
      date_source: "signal",
      employees: 300,
      size_basis: "quoted",
      required_gates_passed: [GATE],
    });
    expect(v.details.fit_reason).toContain(GATE);
  });

  it("stale_date", () => {
    const l = lead();
    l.signal.summary.signal_date = "2026-04-15";
    l.signal.publishedDate = "2026-08-20T00:00:00.000Z";
    expect(code(l)).toBe("stale_date");
  });

  it("unparseable_date", () => {
    const l = lead();
    l.signal.summary.signal_date = "not a date";
    delete l.signal.publishedDate;
    expect(code(l)).toBe("unparseable_date");
  });

  it("year-hallucinated signal_date falls back to publishedDate instead of failing", () => {
    const l = lead();
    l.signal.summary.signal_date = "2023-09-20";
    const v = checkLead(plan(), l);
    expect(v.ok && v.details).toMatchObject({ event_date: "2026-09-21", date_source: "published_fallback" });
  });

  it("required_gate:<key>", () => {
    const l = lead();
    (l.enrichment as Record<string, unknown>)[GATE] = false;
    expect(code(l)).toBe(`required_gate:${GATE}`);
  });

  it("size", () => {
    const l = lead();
    Object.assign(l.enrichment!, { employee_estimate: 5000, employee_estimate_source: "5,000 employees" });
    expect(code(l)).toBe("size");
  });

  it("unknown_size (policy reject)", () => {
    const l = lead();
    delete (l.enrichment as Record<string, unknown>).employee_estimate;
    const strict = plan({ employeeRange: { min: 100, max: 1000, unknownPolicy: "reject" } });
    expect(code(l, strict)).toBe("unknown_size");
    expect(code(l)).toBe("ok"); // allow-if-not-enterprise
  });

  it("hq", () => {
    const l = lead();
    l.enrichment!.hq = "Mumbai, India";
    l.signal.text = "Opened a warehouse.";
    expect(code(l)).toBe("hq");
    l.enrichment!.hq = "";
    expect(code(l)).toBe("hq");
    expect(code(l, plan({ hqCountries: [] }))).toBe("ok");
  });

  it("enterprise", () => {
    const l = lead();
    l.enrichment!.is_public_or_enterprise = true;
    expect(code(l)).toBe("enterprise");
  });

  it("exclude_name (fuzzy)", () => {
    for (const name of ["RXO", "Rxo, Inc.", "RXO (formerly XPO Logistics)"]) {
      expect(code(lead({ company: name }))).toBe("exclude_name");
    }
  });

  it("exclude_domain (signal source and company domain)", () => {
    const l = lead();
    l.signal.url = "https://www.blocked.example/post";
    expect(code(l)).toBe("exclude_domain");
    expect(code(lead({ companyUrl: "https://shop.blocked.example" }))).toBe("exclude_domain");
  });

  it("non_company (placeholder, job board name, job board lookup domain)", () => {
    expect(code(lead({ company: "Remote Rush" }))).toBe("non_company");
    expect(code(lead({ company: "Role, Inc." }))).toBe("non_company");
    expect(code(lead({ companyUrl: "https://www.indeed.com/cmp/x" }))).toBe("non_company");
  });

  it("entity_mismatch", () => {
    const l = lead();
    l.signal.title = "OtherCo opens warehouse";
    l.signal.text = "OtherCo news";
    l.signal.summary.signal_summary = "OtherCo opened a warehouse.";
    expect(code(l)).toBe("entity_mismatch");
  });

  it("entity match tolerates name variants ('Diakonlogistics' vs 'Diakon Logistics')", () => {
    const l = lead({ company: "Diakonlogistics" });
    l.signal.title = "Diakon Logistics hiring in Ohio";
    l.signal.text = "Diakon Logistics is hiring.";
    l.signal.summary.signal_summary = "Diakon Logistics is hiring.";
    l.signal.summary.signal_quote = "Diakon Logistics is hiring.";
    l.companyUrl = "https://news.example.com";
    expect(code(l)).toBe("ok");
  });

  it("no_enrichment", () => {
    expect(code(lead({ enrichment: undefined }))).toBe("no_enrichment");
    expect(code(lead({ enrichment: {} }))).toBe("no_enrichment");
  });

  it("already_seen (earlier runs) and duplicate (this run), keyed by squashed name", () => {
    expect(code(lead({ seen: new Set(["shipco"]) }))).toBe("already_seen");
    expect(code(lead({ submitted: new Set(["shipco"]) }))).toBe("duplicate");
    expect(code(lead({ company: "ShipCo Inc.", submitted: new Set(["shipco"]) }))).toBe("duplicate");
    expect(code(lead({ seen: new Set(["otherco"]) }))).toBe("ok");
  });

  it("unquoted_gate returns the candidate tier for required gates with no page quote", () => {
    const l = lead();
    delete (l.enrichment as Record<string, unknown>)[`${GATE}_quote`];
    const v = checkLead(plan(), l);
    expect(v).toMatchObject({ ok: false, code: "unquoted_gate", tier: "candidate", details: { key: GATE } });
  });

  it("quote_not_in_page rejects required gate, signal and size quotes not found in captured text", () => {
    const l = lead({ lookupText: "300 employees Columbus, Ohio, United States but no gate evidence" });
    expect(checkLead(plan(), l)).toMatchObject({ ok: false, code: "quote_not_in_page", details: { key: GATE } });

    const signalBad = lead();
    signalBad.signal.summary.signal_quote = "a sentence that is not there";
    expect(checkLead(plan(), signalBad)).toMatchObject({ ok: false, code: "quote_not_in_page" });

    const sizeBad = lead({ lookupText: "Columbus, Ohio, United States third party logistics provider" });
    expect(checkLead(plan(), sizeBad)).toMatchObject({ ok: false, code: "quote_not_in_page", details: { key: "employee_estimate_source" } });
  });

  it("lookup quote missing from a truncated page is a candidate (unquoted_gate); untruncated stays quote_not_in_page", () => {
    const text = "300 employees Columbus, Ohio, United States but no gate evidence";
    const trunc = lead({ lookupText: text });
    (trunc.enrichment as Record<string, unknown>).lookup_text_truncated = true;
    expect(checkLead(plan(), trunc)).toMatchObject({
      ok: false, code: "unquoted_gate", tier: "candidate", details: { key: GATE },
      reason: `${GATE} quote not found in the first 20,000 characters of the lookup page (page was truncated)`,
    });
    const sizeTrunc = lead({ lookupText: "Columbus, Ohio, United States third party logistics provider" });
    (sizeTrunc.enrichment as Record<string, unknown>).lookup_text_truncated = true;
    expect(checkLead(plan(), sizeTrunc)).toMatchObject({ code: "unquoted_gate", tier: "candidate", details: { key: "employee_estimate_source" } });
    const hqTrunc = lead({ lookupText: "300 employees third party logistics provider" });
    (hqTrunc.enrichment as Record<string, unknown>).lookup_text_truncated = true;
    expect(checkLead(plan(), hqTrunc)).toMatchObject({ code: "unquoted_gate", tier: "candidate", details: { key: "hq" } });
    const full = lead({ lookupText: text });
    (full.enrichment as Record<string, unknown>).lookup_text_truncated = false;
    expect(checkLead(plan(), full)).toMatchObject({ ok: false, code: "quote_not_in_page", details: { key: GATE } });
  });

  it("non_event_page rejects personal profile URLs", () => {
    const profile = lead();
    profile.signal.url = "https://www.linkedin.com/in/jane-doe/";
    expect(code(profile)).toBe("non_event_page");
  });

  it("unquoted_signal: an empty signal quote is a candidate, not a hard reject", () => {
    const noQuote = lead();
    noQuote.signal.summary.signal_quote = "";
    expect(checkLead(plan(), noQuote)).toMatchObject({ ok: false, code: "unquoted_signal", tier: "candidate" });
  });

  it("evidenceMode skip-quotes disables only the quote-dependent rules", () => {
    const noQuote = lead();
    noQuote.signal.summary.signal_quote = "";
    delete (noQuote.enrichment as Record<string, unknown>)[`${GATE}_quote`];
    expect(checkLead(plan(), noQuote, { evidenceMode: "skip-quotes" }).ok).toBe(true);
    const profile = lead();
    profile.signal.url = "https://www.linkedin.com/in/jane-doe/";
    expect(checkLead(plan(), profile, { evidenceMode: "skip-quotes" })).toMatchObject({ ok: false, code: "non_event_page" });
  });

  it("weak_hiring_signal rejects third-party hiring pages with fewer than two roles", () => {
    const l = lead();
    l.signal.summary.signal_type = "ops_hire";
    l.signal.summary.signal_summary = "ShipCo is hiring one courier.";
    l.signal.summary.signal_quote = "ShipCo is hiring one courier.";
    l.signal.text = "ShipCo is hiring one courier.";
    expect(code(l)).toBe("weak_hiring_signal");
    l.signal.text = "ShipCo is hiring an operations manager and a warehouse supervisor.";
    l.signal.summary.signal_quote = "ShipCo is hiring an operations manager and a warehouse supervisor.";
    expect(code(l)).toBe("ok");
  });

  it("isHiringSignal keys on signal_type / job-post shape, not incidental words (Metropolitan Warehouse lease shape)", () => {
    // A facility/lease article that mentions jobs and staffing in prose is NOT a hiring signal.
    const lease = lead({ company: "Metropolitan Warehouse and Delivery" });
    lease.signal.url = "https://re-nj.com/rockefeller-group-metropolitan-warehouse-and-delivery-ink-530000-sq-ft-lease/";
    lease.signal.title = "Rockefeller Group, Metropolitan Warehouse and Delivery ink 530,000 sq. ft. lease at new Carneys Point logistics campus";
    lease.signal.text = `${lease.signal.title}. The building will bring jobs, talent and new roles to Salem County, with planned staffing.`;
    lease.signal.summary.signal_type = "new_facility";
    lease.signal.summary.signal_summary = "Metropolitan Warehouse and Delivery leases 530,000 sq ft; the project will create 150 jobs and careers.";
    lease.signal.summary.signal_quote = "Metropolitan Warehouse and Delivery ink 530,000 sq. ft. lease";
    expect(code(lease)).toBe("ok");
  });

  it("a genuine third-party hiring post (hiring signal_type, or job-post URL/title) with <2 roles is weak", () => {
    const byType = lead();
    byType.signal.summary.signal_type = "ops_hiring_wave";
    byType.signal.text = "ShipCo is hiring one courier.";
    byType.signal.summary.signal_quote = "ShipCo is hiring one courier.";
    expect(code(byType)).toBe("weak_hiring_signal");

    const byUrl = lead();
    byUrl.signal.url = "https://news.example.com/careers/shipco-courier";
    byUrl.signal.text = "ShipCo needs one courier.";
    byUrl.signal.summary.signal_quote = "ShipCo needs one courier.";
    // A job-post path on a third-party site is now caught earlier, by the listing rule.
    expect(code(byUrl)).toBe("non_event_page");

    const byTitle = lead();
    byTitle.signal.title = "ShipCo is hiring";
    byTitle.signal.text = "ShipCo is hiring a courier.";
    byTitle.signal.summary.signal_quote = "ShipCo is hiring a courier.";
    expect(code(byTitle)).toBe("weak_hiring_signal");
  });

  describe("third-party job listings (non_event_page)", () => {
    const listing = (url: string, over: { type?: string; companyUrl?: string | null } = {}) => {
      const l = lead({ companyUrl: over.companyUrl === null ? undefined : over.companyUrl ?? "https://shipco.com/" });
      l.signal.url = url;
      l.signal.title = "Warehouse Supervisor at ShipCo";
      l.signal.text = "ShipCo is hiring a warehouse supervisor and an operations manager.";
      l.signal.summary.signal_type = over.type ?? "ops_hiring_wave";
      l.signal.summary.signal_quote = "ShipCo is hiring a warehouse supervisor";
      return l;
    };
    const run = (l: LeadInput) => checkLead(plan(), l, { evidenceMode: "skip-quotes" });

    it("rejects a job path on an unlisted third-party site (snaprecruit shape)", () => {
      expect(run(listing("https://jobs-example.com/job/operations-supervisor-1st-jessup.html"))).toMatchObject({
        ok: false,
        code: "non_event_page",
        reason: "job listing on a third-party site",
      });
    });
    it("rejects a jobs. subdomain company page on a third-party site", () => {
      expect(code(listing("https://jobs.boardexample.com/companies/shipco/jobs"))).toBe("non_event_page");
      expect(code(listing("https://careers.boardexample.com/shipco"))).toBe("non_event_page");
    });
    it("treats an unknown company domain as third-party", () => {
      expect(code(listing("https://boardexample.com/careers/shipco", { companyUrl: null }))).toBe("non_event_page");
    });
    it("lets an own-domain careers page through to the hiring rules, not the listing rule", () => {
      const own = listing("https://careers.shipco.com/jobs/123");
      expect(run(own).ok).toBe(true);
      const ownLookup = listing("https://www.shipco.com/careers/warehouse-supervisor");
      expect(run(ownLookup).ok).toBe(true);
    });
    it("matches path segments, not substrings of news slugs", () => {
      const news = listing("https://news.example.com/2026/08/shipco-opens-site-plans-75-jobs-per-shift/", { type: "new_facility" });
      news.signal.title = "ShipCo opens new warehouse";
      expect(run(news).ok).toBe(true);
    });
    it("rejects a third-party listing whatever signal_type the summary declares (Jay Group / thejobsmap.com is lost by design)", () => {
      for (const type of ["expansion", "ops_hiring_wave", ""]) {
        expect(run(listing("https://www.thejobsmap.com/job/996a", { type }))).toMatchObject({
          ok: false,
          code: "non_event_page",
          reason: "job listing on a third-party site",
        });
      }
    });
    it("built-in list rejects snaprecruit, jobtarget and capitalfactory by domain", () => {
      for (const url of [
        "https://snaprecruit.com/job/x",
        "https://www.jobtarget.com/jobs/jt-1/manager",
        "https://jobs.capitalfactory.com/companies/fetch-package/jobs",
      ]) {
        expect(code(listing(url))).toBe("exclude_domain");
      }
    });
  });

  it("built-in signal domains reject on exclude_domain", () => {
    const l = lead();
    l.signal.url = "https://jobs.ashbyhq.com/shipco/123";
    expect(code(l)).toBe("exclude_domain");
  });

  it("is pure: does not mutate seen/submitted", () => {
    const seen = new Set<string>();
    const submitted = new Set<string>();
    checkLead(plan(), lead({ seen, submitted }));
    expect(seen.size + submitted.size).toBe(0);
  });
});

describe("quoteInText", () => {
  it("tolerates case, smart quotes, HTML entities and collapsed whitespace", () => {
    expect(quoteInText("ShipCo “opened” & expanded", "shipco &ldquo;opened&rdquo; &amp;   expanded yesterday")).toBe(true);
    expect(quoteInText("about 300 employees in Ohio", "About\n300   employees in Ohio")).toBe(true);
  });
  it("is strict beyond normalisation", () => {
    expect(quoteInText("about 300 employees in Ohio", "About 300 contractors in Ohio")).toBe(false);
    expect(quoteInText("", "300 employees")).toBe(false);
  });

  const axlePage = [
    "## Financials",
    "- Total Funding: USD 26,060,000",
    "  - Series a (2026-08-01): USD 17.5M",
    "  - Seed (2023-04-10): USD 4.0M",
    "",
    "## Workforce",
    "- Employees: 34",
  ].join("\n");
  const outerPage = [
    "- [2026-10-02]",
    "  - Pulse 2.0: OuterSignal Raises $22 Million Series A To Expand Agentic Customer Personalization Platform",
    "  - Yahoo Finance: OuterSignal Raises $22 Million in Series A Funding Round",
    "  - PR Newswire: OuterSignal Raises $22M Series A to Bring Agentic Personalization to Every Consumer Brand",
  ].join("\n");

  it("accepts a flattened list block (bullets vs semicolons)", () => {
    const q = "Total Funding: USD 26,060,000 - Series a (2026-08-01): USD 17.5M; Seed (2023-04-10): USD 4.0M";
    expect(quoteMatch(q, axlePage)).toEqual({ ok: true });
    expect(quoteInText(q, axlePage)).toBe(true);
  });
  it("accepts a news item flattened from a nested list, skipping an unquoted line", () => {
    const q =
      "[2026-10-02] Pulse 2.0: OuterSignal Raises $22 Million Series A To Expand Agentic Customer Personalization Platform; PR Newswire: OuterSignal Raises $22M Series A to Bring Agentic Personalization to Every Consumer Brand";
    expect(quoteMatch(q, outerPage).ok).toBe(true);
  });
  it("accepts a genuine quote that dropped an attribution (Southern AG)", () => {
    const page =
      'This new terminal represents much more than a new facility," said Lem Goodpasture, Chief Executive Officer at Southern AG Holdings, LLC. "It represents the continued growth of Southern AG Holdings and our commitment to the people and customers who have helped us get here."';
    const q =
      "This new terminal represents much more than a new facility, it represents the continued growth of Southern AG Holdings and our commitment to the people and customers who have helped us get here.";
    expect(quoteMatch(q, page).ok).toBe(true);
  });
  it("rejects a synthesised quote from non-adjacent / reordered lines (Baselayer)", () => {
    const page = [
      "## Workforce",
      "- Employees: 34",
      "- Yearly Growth: +57.1%",
      "## Financials",
      "- Annual Revenue: USD 540,000,000",
      "- Industry: Technology",
    ].join("\n");
    const q = "- Yearly Growth: +57.1% (Employees: 34) - Annual Revenue: USD 540,000,000 - Yearly Growth: +57.1%";
    expect(quoteMatch(q, page)).toEqual({ ok: false, reason: "segment_missing" });
  });
  it("rejects an invented parenthetical clause (Zenskar)", () => {
    const page = "We're hiring an Engineering Manager at Zenskar. Billing gets complicated fast.";
    const q = "We're hiring an Engineering Manager at Zenskar. (context implying ongoing hiring post funding)";
    expect(quoteMatch(q, page).ok).toBe(false);
  });
  it("rejects clauses beyond the locality window", () => {
    const page = "The company opened a brand new facility. " + "x".repeat(700) + " It employs three hundred people.";
    expect(quoteMatch("The company opened a brand new facility. It employs three hundred people.", page).ok).toBe(false);
  });
  it("handles ellipsis: in order passes, out of order fails", () => {
    const page = "Acme Robotics has opened a new plant in Ohio and it will hire two hundred workers by spring.";
    expect(quoteMatch("Acme Robotics has opened a new plant ... hire two hundred workers by spring", page).ok).toBe(true);
    expect(quoteMatch("hire two hundred workers by spring ... Acme Robotics has opened a new plant", page).ok).toBe(false);
  });
  it("memory eval 2026-10-15 XDP: a short piece before an ellipsis is not glued to the text after it", () => {
    const page = "XDP is a leading parcel network. XDP LTD employs 263 people (+4.4% YoY, +11 people), founded in 1995. Headquartered in Curdworth, England, United Kingdom, with offices in Tamworth and Minworth. Its workforce is distributed across United Kingdom, Hong Kong, and Nepal.";
    const q = "XDP LTD employs 263 people (+4.4% YoY, +11 people) ... with offices in Tamworth and Minworth. Its workforce is distributed across United Kingdom, Hong Kong, and Nepal.";
    expect(quoteMatch(q, page)).toEqual({ ok: true });
  });
  it("an ellipsis still does not license reordering, distance, or text that is not on the page", () => {
    const page = "XDP LTD employs 263 people (+4.4% YoY, +11 people), founded in 1995. Headquartered in Curdworth, with offices in Tamworth and Minworth.";
    expect(quoteMatch("with offices in Tamworth and Minworth ... XDP LTD employs 263 people (+4.4% YoY, +11 people)", page).ok).toBe(false);
    expect(quoteMatch("XDP LTD employs 263 people (+4.4% YoY, +11 people) ... with offices in Paris and Lyon", page).ok).toBe(false);
    const far = "XDP LTD employs 263 people (+4.4% YoY, +11 people). " + "y".repeat(700) + " with offices in Tamworth and Minworth.";
    expect(quoteMatch("XDP LTD employs 263 people (+4.4% YoY, +11 people) ... with offices in Tamworth and Minworth", far).ok).toBe(false);
  });
  it("a part that is itself under the clause floor is too_short, not merged across the ellipsis", () => {
    expect(quoteMatch("The company opened a brand new facility ... people", "The company opened a brand new facility and hired people")).toEqual({ ok: false, reason: "too_short" });
    // the same part is fine under the short-quote options used for dates and headcounts
    expect(quoteMatch("opened\u2026 on Friday, October 9", "She opened the plant on Friday, October 9", { minSegment: 6, minTotal: 6 }).ok).toBe(true);
  });
  it("memory eval 2026-10-15 rejects that stay rejected (not verbatim page text)", () => {
    const soag = "Southern Ag Carriers, Inc is a Truck Transportation company. SOAG CARRIERS is a logistics company that provides agricultural transportation and refrigerated transport services. They offer nationwide logistics and are dedicated to providing the highest quality agricultural logistics and refrigerated transport services.";
    expect(quoteMatch("SOAG CARRIERS is a logistics company that provides agricultural transportation and refrigerated transport services; nationwide logistics and dedicated to providing the highest quality agricultural logistics and refrigerated transport services.", soag).ok).toBe(false);
    const cleveland = "Cleveland Group is a transportation, logistics and storage company.";
    expect(quoteMatch("The page describes Cleveland as a transportation, logistics and storage company; it does not state it operates as a third-party logistics provider.", cleveland).ok).toBe(false);
    const duie = "A. Duie Pyle (Pyle), a premier, 102-year-old family-owned and operated provider of asset and non-asset-based supply chain solutions, today announces the opening of a new warehouse facility in Camp Hill, Pennsylvania.";
    expect(quoteMatch("A. Duie Pyle today announces the opening of a new warehouse facility in Camp Hill, Pennsylvania.", duie).ok).toBe(false);
    expect(quoteMatch("281 employees", "Workforce - Employees: 281 - Company Size: 201-500", { minSegment: 6, minTotal: 6 }).ok).toBe(false);
    expect(quoteMatch("281", "Employees: 281", { minSegment: 6, minTotal: 6 })).toEqual({ ok: false, reason: "too_short" });
  });
  it("rejects too-short and empty quotes", () => {
    expect(quoteMatch("300 people.", "300 people.")).toEqual({ ok: false, reason: "too_short" });
    expect(quoteMatch("  --- ", "x")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("headcountQuoteInText (employee_estimate_source)", () => {
  it("a bare number passes when the page has it next to an employee word", () => {
    expect(headcountQuoteInText("281", "## Workforce - Employees: 281 - Company Size: 201-500")).toBe("number_adjacent");
    expect(headcountQuoteInText("281 employees", "Workforce - Employees: 281")).toBe("number_adjacent");
    expect(headcountQuoteInText("1,560 staff", "A. Duie Pyle employs 1,560 people")).toBe("number_adjacent");
  });
  it("fails when the number is not near an employee word, or is part of a larger number", () => {
    expect(headcountQuoteInText("281", "The fleet has 281 trucks and 40 depots across the region and beyond.")).toBeUndefined();
    expect(headcountQuoteInText("281", "Employees: 2810")).toBeUndefined();
    expect(headcountQuoteInText("281", "Employees: 1281")).toBeUndefined();
    expect(headcountQuoteInText("281", "Employees: 3.281")).toBeUndefined();
  });
  it("a phrase quote still goes through the general matcher", () => {
    expect(headcountQuoteInText("SpartanCo employs 281 people", "x SpartanCo employs 281 people (+2.2% YoY)")).toBe("phrase");
    expect(headcountQuoteInText("SpartanCo employs 999 people", "SpartanCo employs 281 people")).toBeUndefined();
  });
  it("checkLead records size_quote_match and rejects a bare number with no employee word", () => {
    const page = (size: string) => `Columbus, Ohio, United States. third party logistics provider. ${size}`;
    const enrichment = { ...lead().enrichment, employee_estimate: 281, employee_estimate_source: "281" };
    const good = checkLead(plan(), lead({ enrichment, lookupText: page("Workforce - Employees: 281") }));
    expect(good.ok && good.details.size_quote_match).toBe("number_adjacent");
    const phrase = checkLead(plan(), lead({ enrichment: { ...enrichment, employee_estimate_source: "281 people" }, lookupText: page("SpartanCo has 281 people") }));
    expect(phrase.ok && phrase.details.size_quote_match).toBe("phrase");
    const bad = checkLead(plan(), lead({ enrichment, lookupText: page("Fleet: 281 trucks") }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe("quote_not_in_page");
  });
});

describe("squashName / dedupe", () => {
  it("collapses name variants", () => {
    expect(squashName("Diakon Logistics")).toBe(squashName("Diakonlogistics"));
    expect(squashName("Verst Logistics, Inc.")).toBe(squashName("Verst Logistics Group"));
    expect(squashName("C.H. Robinson")).toBe(squashName("Chrobinson"));
    expect(squashName("Rohlík")).toBe(squashName("Rohlik"));
  });
  it("domain-style names collapse onto the plain name; lookalikes do not", () => {
    expect(squashName("Avarra.ai")).toBe(squashName("Avarra"));
    expect(squashName("Baselayer")).toBe(squashName("baselayer.io"));
    expect(squashName("Acme.com")).toBe("acme");
    expect(squashName("Acme Co.")).toBe("acme"); // unchanged: corporate suffix
    expect(squashName("Monk")).not.toBe(squashName("Monkeys"));
    expect(squashName("Open AI")).not.toBe(squashName("Openly"));
    expect(squashName("Open AI")).toBe("openai");
    expect(squashName("C.H. Robinson")).toBe("chrobinson");
    expect(squashName("Ship.co")).toBe("ship");
    expect(squashName(".ai")).toBe("ai"); // nothing before the dot: untouched
  });
  it("does not over-strip", () => {
    expect(squashName("Costco")).toBe("costco");
    expect(squashName("Group")).toBe("group");
    expect(squashName("Acme")).not.toBe(squashName("Acme Logistics"));
  });

  it("scoreAndRank groups variants into one row", () => {
    const mk = (company: string, url: string): Candidate => ({
      result: { url, title: `${company} hiring`, publishedDate: "2026-09-20T00:00:00.000Z", text: `${company} Diakon Logistics is hiring` },
      summary: { company_name: company, signal_type: "ops_hire", signal_summary: `${company} is hiring`, signal_date: "2026-09-20", signal_quote: `${company} Diakon Logistics is hiring`, signal_date_quote: "" },
      company: { result: { url: "https://jobs.example.com", text: "150 employees Austin, TX, United States third party logistics provider" }, summary: { employee_estimate: 150, employee_estimate_source: "150 employees", hq: "Austin, TX, United States", hq_quote: "Austin, TX, United States", is_public_or_enterprise: false, [GATE]: true, [`${GATE}_quote`]: "third party logistics provider" } },
    });
    const rows = scoreAndRank(
      plan(),
      [mk("Diakon Logistics", "https://jobs.example.com/a"), mk("Diakonlogistics", "https://jobs.example.com/b")],
      monthsAgoIso(3, NOW),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company).toBe("Diakon Logistics");
  });
});

describe("size source rule", () => {
  it("accepts quotes within +/-25% in common phrasings", () => {
    for (const q of ["350 employees", "350+", "~350", "about 3,560 staff", "over 1.2k people", "200-500 employees"]) {
      const est = q.includes("3,560") ? 3560 : q.includes("1.2k") ? 1200 : 350;
      expect(sizeQuoteSupports(est, q)).toBe(true);
    }
    expect(sizeQuoteSupports(350, "300 employees")).toBe(true);
  });
  it("rejects empty, number-free and off-by-10x quotes", () => {
    expect(sizeQuoteSupports(350, "")).toBe(false);
    expect(sizeQuoteSupports(350, undefined)).toBe(false);
    expect(sizeQuoteSupports(350, "a large team")).toBe(false);
    expect(sizeQuoteSupports(350, "3,560 employees")).toBe(false);
    expect(sizeQuoteSupports(350, "1,000 employees")).toBe(false);
  });

  // Evidence: A. Duie Pyle came back as 356 on one run and 3,560 on another.
  it("A. Duie Pyle: 356 backed by '3,560 employees' is unverified, 3,560 backed by it is quoted", () => {
    const mk = (est: number, quote: string) => {
      const l = lead({ company: "A. Duie Pyle" });
      Object.assign(l.enrichment!, { employee_estimate: est, employee_estimate_source: quote });
      return l;
    };
    // 356 contradicts its own quote -> unverified, but within 2x of 100-1000 -> kept with the penalty
    const bad = checkLead(plan(), mk(356, "A. Duie Pyle employs 3,560 people"));
    expect(bad.ok && bad.details.size_basis).toBe("unverified");
    expect(bad.ok && bad.details.employees).toBeUndefined();
    expect(bad.ok && bad.details.multiplier).toBeCloseTo(0.82, 6);
    // ...and under a reject policy an unverified estimate is rejected as unknown_size
    expect(
      code(mk(356, "A. Duie Pyle employs 3,560 people"), plan({ employeeRange: { min: 100, max: 1000, unknownPolicy: "reject" } })),
    ).toBe("unknown_size");
    // 3,560 with its quote is quoted, and then out of the 100-1000 range
    const big = checkLead(plan(), mk(3560, "A. Duie Pyle employs 3,560 people"));
    expect(big).toMatchObject({ ok: false, code: "size" });
    // 356 with a matching quote passes as quoted
    const good = checkLead(plan(), mk(356, "approximately 356 employees"));
    expect(good.ok && good.details).toMatchObject({ size_basis: "quoted", employees: 356 });
  });

  it("missing source field counts as unverified", () => {
    const l = lead();
    delete l.enrichment!.employee_estimate_source;
    const v = checkLead(plan(), l);
    expect(v.ok && v.details.size_basis).toBe("unverified");
  });
});

describe("unverified estimates are weaker evidence, not no evidence", () => {
  const mk = (est: number, quote = "") => {
    const l = lead();
    Object.assign(l.enrichment!, { employee_estimate: est, employee_estimate_source: quote });
    return l;
  };
  it("rejects far-outside unverified estimates (ShipBob 1,707, iMile 3,983, 1,501 vs 100-1000)", () => {
    for (const est of [1707, 3983, 1501]) {
      const v = checkLead(plan(), mk(est));
      expect(v).toMatchObject({ ok: false, code: "size" });
      expect(!v.ok && v.reason).toContain(`unverified estimate ${est.toLocaleString()} is far outside 100\u20131000`);
    }
    expect(code(mk(40))).toBe("size"); // < min/2
  });
  it("passes unverified estimates within 1.5x of max (and above min/2), with the 0.82 penalty", () => {
    for (const est of [356, 1400, 1500, 50]) {
      const v = checkLead(plan(), mk(est));
      expect(v.ok && v.details.size_basis).toBe("unverified");
      expect(v.ok && v.details.multiplier).toBeCloseTo(0.82, 6);
    }
    expect(code(mk(1501))).toBe("size");
  });
  it("quoted estimates still use the exact band", () => {
    expect(code(mk(1100, "1,100 employees"))).toBe("size");
  });
  it("no estimate at all uses unknownPolicy", () => {
    const l = lead();
    delete l.enrichment!.employee_estimate;
    expect(code(l)).toBe("ok");
    expect(code(l, plan({ employeeRange: { min: 100, max: 1000, unknownPolicy: "reject" } }))).toBe("unknown_size");
  });
});

describe("year-like numbers in size quotes", () => {
  it("'founded 2004' cannot corroborate 2,004", () => {
    expect(sizeQuoteSupports(2004, "founded in 2004")).toBe(false);
    expect(sizeQuoteSupports(2000, "Since 1999, serving 2024 customers")).toBe(false);
  });
  it("keeps year-like numbers followed by a headcount word", () => {
    expect(sizeQuoteSupports(2004, "2004 employees")).toBe(true);
    expect(sizeQuoteSupports(2004, "about 2004 full-time staff")).toBe(true);
    expect(sizeQuoteSupports(2004, "2,004 employees")).toBe(true);
    expect(sizeQuoteSupports(1950, "1950 team members")).toBe(true);
  });
  it("does not affect non-year numbers", () => {
    expect(sizeQuoteSupports(1800, "1800 in total")).toBe(true);
    expect(sizeQuoteSupports(350, "founded 2004, 350 employees")).toBe(true);
  });
});

describe("F2 G1: inclusive window boundary", () => {
  // now 2026-10-11T03:00Z, 3 months -> window starts 2026-07-11T00:00Z
  const at = (date: string) => {
    const l = lead();
    l.signal.summary.signal_date = date;
    l.signal.publishedDate = `${date}T12:00:00.000Z`;
    return l;
  };
  it("an event exactly on the window start day is fresh; the day before is stale", () => {
    expect(code(at("2026-07-11"))).toBe("ok");
    expect(code(at("2026-07-10"))).toBe("stale_date");
  });
  it("an event today is fresh", () => {
    expect(code(at("2026-10-11"))).toBe("ok");
  });
});

describe("F2 G2: substitute publishedDate only for a year-slip", () => {
  it("year-slips (RGL / FST / G10) still fall back to the publish date", () => {
    expect(resolveEventDate({ signal_date: "2023-10-05", publishedDate: "2026-10-05" }, NOW)).toEqual({ date: "2026-10-05", source: "published_fallback" });
    expect(resolveEventDate({ signal_date: "2023-12-05", publishedDate: "2026-09-25" }, NOW).source).toBe("published_fallback");
    expect(resolveEventDate({ signal_date: "2024-10-24", publishedDate: "2026-09-11" }, NOW).source).toBe("published_fallback");
  });
  it("'opened its facility in March 2024' in a Sept 2026 article is stale, not fresh", () => {
    expect(resolveEventDate({ signal_date: "2024-03-15", publishedDate: "2026-09-20" }, NOW)).toEqual({ date: "2024-03-15", source: "signal" });
    const l = lead();
    l.signal.summary.signal_date = "2024-03-15";
    l.signal.publishedDate = "2026-09-20T00:00:00.000Z";
    expect(code(l)).toBe("stale_date");
  });
  it("future dates still fall back; with no publish date they stay unparseable", () => {
    expect(resolveEventDate({ signal_date: "2026-12-07", publishedDate: "2026-10-02" }, NOW).source).toBe("published_fallback");
    expect(resolveEventDate({ signal_date: "2026-12-07" }, NOW).source).toBe("");
    expect(resolveEventDate({ signal_date: "2023-01-01" }, NOW).source).toBe("");
  });
});

describe("F2 G3: HQ evidence and country codes", () => {
  it("a known foreign HQ rejects even if the signal text names a US place", () => {
    const l = lead();
    l.enrichment!.hq = "Mumbai, India";
    l.signal.text = "ShipCo opened a warehouse in Ohio, United States.";
    expect(code(l)).toBe("hq");
  });
  it("signal text is used only when the lookup has no HQ, with hq_basis and a 0.9 multiplier", () => {
    const base = checkLead(plan(), lead());
    const l = lead();
    l.enrichment!.hq = "";
    const v = checkLead(plan(), l); // text says "in Ohio"
    expect(v.ok && v.details.hq_basis).toBe("signal_text");
    expect(base.ok && base.details.hq_basis).toBe("enrichment");
    expect(v.ok && base.ok && v.details.multiplier / base.details.multiplier).toBeCloseTo(0.9, 6);
    l.signal.text = "ShipCo opened a warehouse.";
    l.signal.title = "ShipCo expands";
    l.signal.summary.signal_quote = "ShipCo opened a warehouse.";
    expect(code(l)).toBe("hq");
    const unk = lead();
    unk.enrichment!.hq = "unknown";
    expect(checkLead(plan(), unk).ok && true).toBe(true);
  });
  it("2-letter codes: only the last token, never a US state code", () => {
    expect(countryOfHq("San Francisco, CA")).toBe("US");
    expect(textInCountries("San Francisco, CA", ["CA"], true)).toBe(false);
    expect(countryOfHq("Indianapolis, IN")).toBe("US");
    expect(textInCountries("Indianapolis, IN", ["IN"], true)).toBe(false);
    expect(countryOfHq("Wilmington, DE")).toBe("US");
    expect(textInCountries("Wilmington, DE", ["DE"], true)).toBe(false);
    expect(countryOfHq("Calgary, AB, CA")).toBe("CA");
    expect(textInCountries("Calgary, AB, CA", ["US"], true)).toBe(false);
    expect(textInCountries("Calgary, AB, CA", ["CA"], true)).toBe(true);
    expect(countryOfHq("Austin, TX, United States")).toBe("US");
    expect(countryOfHq("Toronto, ON, Canada")).toBe("CA");
    expect(countryOfHq("Berlin, Germany")).toBe("DE");
    expect(countryOfHq("Sydney, NSW, AU")).toBe("AU");
    expect(countryOfHq("")).toBeUndefined();
    expect(COUNTRY_CODES).toContain("US");
    expect(COUNTRY_CODES).toContain("GB");
  });
});

describe("F2 G4: entity match", () => {
  it("word boundaries: 'UPS' does not match 'startups'", () => {
    expect(nameMatchesSignal({ company: "UPS", text: "Startups are hiring" })).toBe(false);
    expect(nameMatchesSignal({ company: "UPS", text: "UPS opens a hub" })).toBe(true);
  });
  it("squashed substring only for names of 8+ characters", () => {
    expect(nameMatchesSignal({ company: "Diakonlogistics", text: "Diakon Logistics is hiring" })).toBe(true);
    expect(nameMatchesSignal({ company: "Ship Co", text: "Shipco expands" })).toBe(false); // 6 chars
    expect(nameMatchesSignal({ company: "Northwind Freight", text: "northwindfreight announced" })).toBe(true); // 16 chars
  });
  it("signal_summary does not self-confirm the entity", () => {
    const l = lead();
    l.signal.title = "Warehouse news";
    l.signal.text = "A warehouse opened in Ohio.";
    l.signal.summary.signal_summary = "ShipCo opened a new warehouse.";
    expect(code(l)).toBe("entity_mismatch");
  });
  it("no page text -> entity_mismatch with the explicit reason", () => {
    const l = lead();
    delete l.signal.title;
    delete l.signal.text;
    const v = checkLead(plan(), l);
    expect(v).toMatchObject({ ok: false, code: "entity_mismatch", reason: "no page text to verify the company name" });
  });
});

describe("F2 G5: parseEmployeeEstimate", () => {
  it.each([
    ["1.2k", 1200], ["10k+", 10000], ["~350", 350], ["350+", 350], ["200-500", 350], ["3,560", 3560],
    ["2000", 2000], ["201–500 employees", 351], ["1-2k", 1500], ["about 350 people", 350],
  ])("%s -> %d", (input, expected) => {
    expect(parseEmployeeEstimate(input)).toBe(expected);
  });
  it("numbers pass through; junk is undefined", () => {
    expect(parseEmployeeEstimate(120)).toBe(120);
    expect(parseEmployeeEstimate("unknown")).toBeUndefined();
    expect(parseEmployeeEstimate(undefined)).toBeUndefined();
  });
});
