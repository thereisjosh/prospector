import { describe, expect, it } from "vitest";
import {
  checkLead,
  parseEmployeeEstimate,
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
      },
      publishedDate: "2026-09-21T00:00:00.000Z",
    },
    enrichment: {
      description: "3PL",
      is_public_or_enterprise: false,
      employee_estimate: 300,
      employee_estimate_source: "300 employees",
      hq: "Columbus, Ohio, United States",
      [GATE]: true,
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

  it("is pure: does not mutate seen/submitted", () => {
    const seen = new Set<string>();
    const submitted = new Set<string>();
    checkLead(plan(), lead({ seen, submitted }));
    expect(seen.size + submitted.size).toBe(0);
  });
});

describe("squashName / dedupe", () => {
  it("collapses name variants", () => {
    expect(squashName("Diakon Logistics")).toBe(squashName("Diakonlogistics"));
    expect(squashName("Verst Logistics, Inc.")).toBe(squashName("Verst Logistics Group"));
    expect(squashName("C.H. Robinson")).toBe(squashName("Chrobinson"));
    expect(squashName("Rohlík")).toBe(squashName("Rohlik"));
  });
  it("does not over-strip", () => {
    expect(squashName("Costco")).toBe("costco");
    expect(squashName("Group")).toBe("group");
    expect(squashName("Acme")).not.toBe(squashName("Acme Logistics"));
  });

  it("scoreAndRank groups variants into one row", () => {
    const mk = (company: string, url: string): Candidate => ({
      result: { url, title: `${company} hiring`, publishedDate: "2026-09-20T00:00:00.000Z", text: `${company} Diakon Logistics is hiring` },
      summary: { company_name: company, signal_type: "ops_hire", signal_summary: `${company} is hiring`, signal_date: "2026-09-20" },
      company: { summary: { employee_estimate: 150, employee_estimate_source: "150 employees", hq: "Austin, TX, United States", is_public_or_enterprise: false, [GATE]: true } },
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
