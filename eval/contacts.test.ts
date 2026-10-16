/**
 * Named contacts (docs/SPEC-agent.md §5b): titleMatchesRole, checkContact codes, findContacts on a fake Exa,
 * the find_contacts tool's refusals and caps, CSV columns, plan/card validation of buyerRoles, the trace
 * mapping. No network: Exa is a fake, keys are unset.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events";
import { createRunState, type AcceptedLead, type RunState } from "../src/agent/state";
import { agentTools, executeTool, validateNote, type ToolDeps } from "../src/agent/tools";
import { contactCounts, toObservations } from "../src/agent/trace";
import { CONTACT_LIMITS, dedupeContacts, estimateContactCost, findContacts, pageSearchBody, peopleSearchBody, personKey, type Contact, type FindContactsResult } from "../src/contacts";
import { BudgetExceededError, CostGuard, estimateExaCost } from "../src/exa";
import { CONTACT_NON_EVIDENCE_DOMAINS, checkContact, formerRoleMarker, isAggregatorShapedUrl, normalizePageDate, personNameTokens, properCaseName, titleMatchesRole } from "../src/gates";
import { validatePlan, type SearchPlan } from "../src/plan";
import { validateCards, withBuyerRoles, type CardSet } from "../src/planner/cards";
import { demoPlan } from "../src/demo/planner";
import { firstUserMessage, AGENT_SYSTEM_PROMPT } from "../src/agent/prompts";
import { CONTACT_CSV_COLUMNS, contactDate, leadsCsv } from "../app/ui/copy";
import type { ExaResult, ExaSearchResponse } from "../src/types";

const NOW = new Date("2026-10-16T00:00:00.000Z");
const ROLES = ["VP of Operations", "Warehouse general manager"];

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "Contacts test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
  buyerRoles: ROLES,
  ...over,
});

/* ---------- titleMatchesRole ---------- */

describe("titleMatchesRole: deterministic token overlap on function words", () => {
  it.each([
    ["VP of Fulfillment Operations", "VP of Operations", true],
    ["Chief Operating Officer", "VP of Operations", true],
    ["COO", "Head of Operations", true],
    ["Ops Director", "Director of Operations", true],
    ["Director of Operational Excellence", "VP of Operations", true],
    ["Warehouse Manager", "Warehouse general manager", true],
    ["SVP. Warehousing and Fulfillment", "Warehouse general manager", true],
    ["vp OF OPERATIONS", "vp of operations", true],
    ["Co-Founder & CEO", "CEO", true],
    ["Chief Executive Officer", "CEO", true],
    ["Vice President", "VP", true],
    // A shared rank word is not a shared role.
    ["VP of Sales", "VP of Operations", false],
    ["Senior Vice President, Logistics", "VP of Operations", false],
    ["General Manager", "Warehouse general manager", false],
    ["CEO", "Founder", false],
    ["", "VP of Operations", false],
    ["VP of Operations", "", false],
  ])("%s vs %s -> %s", (title, role, expected) => {
    expect(titleMatchesRole(title, role)).toBe(expected);
  });
});

/* ---------- checkContact ---------- */

const TEAM_URL = "https://www.verstlogistics.com/about-us/our-team/travis-french";
const TEAM_TEXT =
  "Our team. Travis French, Senior Vice President of Warehousing and Fulfillment Operations, joined Verst Logistics in 2024 and runs every building. " +
  "Chris Verst, Vice President, Transportation, leads the fleet.";

// Press prose: a sentence about the person with enough surrounding text (>= 200 chars) to count as an article.
const PRESS_TEXT =
  "Travis French, Senior Vice President of Warehousing and Fulfillment Operations, joined Verst Logistics in 2024 and runs every building in the network. " +
  "The company said the move reflects how quickly its contract logistics business has grown over the last two years. " +
  "Chris Verst, Vice President, Transportation, leads the fleet.";

describe("checkContact: code decides the tier", () => {
  const base = { name: "Travis French", company: "Verst Logistics", title_quote: "Senior Vice President of Warehousing and Fulfillment Operations" };
  const ctx = { page: { url: TEAM_URL, text: TEAM_TEXT }, buyerRoles: ROLES, companyUrl: "https://verstlogistics.com" };

  it("verified: non-LinkedIn page, name and title verbatim and adjacent, title fits a role", () => {
    const v = checkContact(base, ctx);
    expect(v).toMatchObject({ ok: true, tier: "verified", role: "VP of Operations" });
    if (!v.ok) return;
    expect(v.evidence.url).toBe(TEAM_URL);
    expect(v.evidence.title_quote).toBe(base.title_quote);
    expect(v.evidence.quote).toBe("Travis French, Senior Vice President of Warehousing and Fulfillment Operations");
    expect(TEAM_TEXT).toContain(v.evidence.quote);
  });

  it("verified on another site only when it names the company", () => {
    const press = { url: "https://news.example.com/verst", text: PRESS_TEXT };
    expect(checkContact(base, { ...ctx, page: press }).ok).toBe(true);
    const unnamed = { url: "https://news.example.com/x", text: PRESS_TEXT.replace(/Verst Logistics/g, "the company") };
    expect(checkContact(base, { ...ctx, page: unnamed })).toMatchObject({ ok: false, tier: "inferred", code: "contact_unverified" });
  });

  it("contact_unverified: no page, a LinkedIn or aggregator page, no text, no title", () => {
    expect(checkContact(base, { ...ctx, page: undefined })).toMatchObject({ code: "contact_unverified", tier: "inferred" });
    expect(checkContact(base, { ...ctx, page: { url: "https://www.linkedin.com/in/travis-french", text: TEAM_TEXT } })).toMatchObject({ code: "contact_unverified" });
    expect(checkContact(base, { ...ctx, page: { url: "https://exa.ai/library/person/travis-french", text: TEAM_TEXT } })).toMatchObject({ code: "contact_unverified" });
    expect(checkContact(base, { ...ctx, page: { url: "https://theorg.com/org/verst/travis", text: TEAM_TEXT } })).toMatchObject({ code: "contact_unverified" });
    expect(checkContact(base, { ...ctx, page: { url: TEAM_URL, text: "" } })).toMatchObject({ code: "contact_unverified" });
    expect(checkContact({ ...base, title_quote: undefined }, ctx)).toMatchObject({ code: "contact_unverified" });
  });

  it("contact_quote_not_in_page: name missing, title missing, title far from the name, title too long", () => {
    expect(checkContact({ ...base, name: "Pat Ghost" }, ctx)).toMatchObject({ ok: false, tier: "rejected", code: "contact_quote_not_in_page" });
    expect(checkContact({ ...base, title_quote: "Chief Operating Officer" }, ctx)).toMatchObject({ code: "contact_quote_not_in_page" });
    const far = `Travis French joined us. ${"x ".repeat(150)} Senior Vice President of Warehousing and Fulfillment Operations is a role at Verst Logistics.`;
    expect(checkContact(base, { ...ctx, page: { url: TEAM_URL, text: far } })).toMatchObject({ code: "contact_quote_not_in_page", reason: expect.stringContaining("next to the name") });
    expect(checkContact({ ...base, title_quote: `VP of Operations ${"and more ".repeat(20)}` }, ctx)).toMatchObject({ code: "contact_quote_not_in_page" });
    expect(checkContact({ ...base, name: "Travis" }, ctx)).toMatchObject({ code: "contact_quote_not_in_page" });
  });

  it("contact_role_mismatch: the page title is outside every approved role", () => {
    expect(checkContact({ name: "Chris Verst", company: "Verst Logistics", title_quote: "Vice President, Transportation" }, ctx)).toMatchObject({
      ok: false,
      tier: "rejected",
      code: "contact_role_mismatch",
    });
    expect(checkContact(base, { ...ctx, buyerRoles: [] })).toMatchObject({ code: "contact_role_mismatch" });
  });

  it("a middle initial on the page still matches the name", () => {
    const text = "At Verst Logistics, Travis J. French, Senior Vice President of Warehousing and Fulfillment Operations, leads operations.";
    expect(checkContact(base, { ...ctx, page: { url: TEAM_URL, text } }).ok).toBe(true);
  });
});

/* ---------- what may verify, and how old (FAILURES #29) ---------- */

describe("checkContact: only the company's own site or real press can verify; old press needs a current index entry", () => {
  const NOW_D = new Date("2026-10-16T00:00:00.000Z");
  const todd = { name: "Todd Johnson", company: "Verst Logistics", title_quote: "President and COO" };
  const roles = ["VP of Operations", "COO"];
  const PRESS_URL = "https://www.prnewswire.com/news-releases/verst-logistics-names-todd-johnson-as-new-president-and-coo-300836065.html";
  const press = (dateLine: string) =>
    `${dateLine} CINCINNATI -- Verst Logistics today announced that Todd Johnson has been named President and COO of the company. ` +
    "Johnson will oversee warehousing, transportation and customer operations across all of the company's facilities in the Midwest and Southeast.";
  const base = { buyerRoles: roles, companyUrl: "https://verstlogistics.com", now: NOW_D };
  const FIELD_LIST = "Virgil Chandler\nTitle: VP of Warehousing\nCompany: Verst Logistics\nLocation: Cincinnati, Ohio\nIndustry: Logistics\nSeniority: VP\nDepartment: Operations";

  it("a muraena-like people-data mirror is inferred, never verified (list, URL shape and prose rule each catch it)", () => {
    const v = { name: "Virgil Chandler", company: "Verst Logistics", title_quote: "VP of Warehousing" };
    const ctx = { ...base, buyerRoles: ["Head of Warehousing", "VP of Warehousing"] };
    expect(checkContact(v, { ...ctx, page: { url: "https://muraena.ai/profile/virgil_chandler_7a81e5b6", text: FIELD_LIST } })).toMatchObject({ ok: false, tier: "inferred", code: "contact_unverified" });
    // An aggregator the list does not know, with a profile-shaped URL.
    expect(checkContact(v, { ...ctx, page: { url: "https://peoplemirror.example/profile/virgil-chandler", text: FIELD_LIST } })).toMatchObject({ ok: false, code: "contact_unverified", reason: expect.stringContaining("profile or directory") });
    // Unknown domain, neutral URL, but the page is a field list: the prose rule.
    expect(checkContact(v, { ...ctx, page: { url: "https://peoplemirror.example/v/virgil-chandler", text: FIELD_LIST } })).toMatchObject({ ok: false, code: "contact_unverified", reason: expect.stringContaining("prose") });
  });

  it.each([
    "https://x.example/profile/todd",
    "https://x.example/profiles/todd",
    "https://x.example/person/todd-johnson",
    "https://x.example/people/todd-johnson",
    "https://x.example/employee/123",
    "https://x.example/contact/todd",
    "https://x.example/in/todd-johnson",
    "https://x.example/pub/todd-johnson/1/2/3",
    "https://x.example/directory/verst",
    "https://x.example/company/verst-logistics/people",
    "https://x.example/lookup?person=todd-johnson",
  ])("aggregator URL shape %s cannot verify", (url) => {
    expect(isAggregatorShapedUrl(url)).toBe(true);
    expect(checkContact(todd, { ...base, page: { url, text: press("Oct 1, 2026"), publishedDate: "2026-10-01" } })).toMatchObject({ ok: false, code: "contact_unverified" });
  });

  it("every newly listed aggregator host is excluded from the evidence search", () => {
    for (const d of ["muraena.ai", "rocketreach.com", "zoominfo.com", "apollo.io", "lusha.com", "contactout.com", "signalhire.com", "kaspr.io", "theorg.com", "crunchbase.com", "pitchbook.com", "cbinsights.com", "datanyze.com", "seamless.ai", "leadiq.com", "clearbit.com", "hunter.io", "findymail.com", "snov.io", "getprospect.com", "wiza.co", "uplead.com", "cognism.com", "6sense.com", "lead411.com", "exa.ai"]) {
      expect(CONTACT_NON_EVIDENCE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`)), d).toBe(true);
    }
  });

  it("prose rule: a press-shaped URL with a bare name-and-title line is inferred; the same name in an article verifies", () => {
    const bare = "Todd Johnson, President and COO. Verst Logistics.";
    expect(checkContact(todd, { ...base, page: { url: "https://news.example.com/a", text: bare, publishedDate: "2026-09-01" } })).toMatchObject({ ok: false, code: "contact_unverified" });
    expect(checkContact(todd, { ...base, page: { url: "https://news.example.com/a", text: press("Sep 1, 2026"), publishedDate: "2026-09-01" } })).toMatchObject({ ok: true });
  });

  it("the company's own domain verifies whatever its age or shape, and records the date when it has one", () => {
    const own = { url: "https://www.verstlogistics.com/about/people/todd-johnson", text: "Todd Johnson, President and COO.", publishedDate: "2019-06-03T00:00:00.000Z" };
    const v = checkContact(todd, { ...base, page: own });
    expect(v).toMatchObject({ ok: true, tier: "verified" });
    if (v.ok) expect(v.evidence.published).toBe("2019-06-03");
    const undated = checkContact(todd, { ...base, page: { url: own.url, text: own.text } });
    expect(undated).toMatchObject({ ok: true });
    if (undated.ok) expect(undated.evidence.published).toBeUndefined();
  });

  it("2019 press with a current people-index entry verifies, and the date is kept", () => {
    const page = { url: PRESS_URL, text: press("Jun 3, 2019"), publishedDate: "2019-06-03T00:00:00.000Z" };
    const v = checkContact(todd, { ...base, page, currentInIndex: true });
    expect(v).toMatchObject({ ok: true, tier: "verified", role: "VP of Operations" });
    if (v.ok) expect(v.evidence.published).toBe("2019-06-03");
  });

  it("2019 press alone is inferred (contact_stale) with the title and the year it was last confirmed", () => {
    const page = { url: PRESS_URL, text: press("Jun 3, 2019"), publishedDate: "2019-06-03T00:00:00.000Z" };
    const v = checkContact(todd, { ...base, page });
    expect(v).toMatchObject({ ok: false, tier: "inferred", code: "contact_stale", stale: { title_quote: "President and COO", published: "2019-06-03", role: "VP of Operations" } });
  });

  it("the date comes from the text near the quote when Exa gave none; no date at all means the age rule has nothing to apply", () => {
    const fromText = checkContact(todd, { ...base, page: { url: PRESS_URL, text: press("June 3, 2019") } });
    expect(fromText).toMatchObject({ ok: false, code: "contact_stale", stale: { published: "2019-06-03" } });
    const undated = checkContact(todd, { ...base, page: { url: "https://news.example.com/a", text: press("") } });
    expect(undated).toMatchObject({ ok: true });
    if (undated.ok) expect(undated.evidence.published).toBeUndefined();
  });

  it("24 months is the line: 23 months old verifies, 25 does not", () => {
    expect(checkContact(todd, { ...base, page: { url: "https://news.example.com/a", text: press(""), publishedDate: "2024-11-10" } })).toMatchObject({ ok: true });
    expect(checkContact(todd, { ...base, page: { url: "https://news.example.com/a", text: press(""), publishedDate: "2024-09-10" } })).toMatchObject({ ok: false, code: "contact_stale" });
  });

  it("date helpers", () => {
    expect(normalizePageDate("2019-06-03T10:00:00.000Z", NOW_D)).toBe("2019-06-03");
    expect(normalizePageDate("2030-01-01", NOW_D)).toBeUndefined();
    expect(normalizePageDate("garbage", NOW_D)).toBeUndefined();
    expect(contactDate("2019-06-03")).toBe("Jun 2019");
    expect(contactDate("2019")).toBe("2019");
  });
});

/* ---------- findContacts on a fake Exa ---------- */

const person = (url: string, name: string, history: Array<{ title: string; company: string; to?: string | null }>): ExaResult => ({
  url,
  title: `${name} - LinkedIn`,
  entities: [{ type: "person", properties: { name, workHistory: history.map((h) => ({ title: h.title, company: { name: h.company }, dates: { from: "2022-01", to: h.to ?? null } })) } }],
});

const PEOPLE: ExaResult[] = [
  person("https://www.linkedin.com/in/travis-french", "Travis French", [{ title: "SVP. Warehousing and Fulfillment", company: "Verst Logistics" }]),
  person("https://www.linkedin.com/in/jane-ops", "Jane Ops", [{ title: "Vice President of Fulfillment Operations", company: "Verst Group Logistics" }]),
  person("https://www.linkedin.com/in/bob-gone", "Bob Gone", [{ title: "VP of Operations", company: "Verst Logistics", to: "2025-01" }]),
  person("https://www.linkedin.com/in/ann-elsewhere", "Ann Elsewhere", [{ title: "VP of Operations", company: "Acme Freight" }]),
];

const page = (url: string, text: string, people: Array<{ name: string; title_quote: string }>): ExaResult => ({ url, text, summary: JSON.stringify({ people }) });

const PAGES: ExaResult[] = [
  page(TEAM_URL, TEAM_TEXT, [
    { name: "Travis French", title_quote: "Senior Vice President of Warehousing and Fulfillment Operations" },
    { name: "Chris Verst", title_quote: "Vice President, Transportation" },
    { name: "Pat Ghost", title_quote: "VP Operations" },
  ]),
];

function fakeExa(people: ExaResult[], pages: ExaResult[]) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (body: Record<string, unknown>, _creds?: unknown, guard?: CostGuard): Promise<ExaSearchResponse> => {
    calls.push(body);
    const estimate = estimateExaCost(body);
    guard?.reserve(estimate);
    const actual = body.category === "people" ? 0.007 : 0.012;
    guard?.settle(estimate, actual);
    return { results: body.category === "people" ? people : pages, costDollars: { total: actual } };
  });
  return { fn, calls };
}

describe("findContacts", () => {
  it("verified when a non-LinkedIn page has the title quote; inferred from the index otherwise; unsupported names dropped", async () => {
    const exa = fakeExa(PEOPLE, PAGES);
    const r = await findContacts({ company: "Verst Logistics", companyUrl: "https://verstlogistics.com", buyerRoles: ROLES }, { exaSearch: exa.fn as never });
    expect(r.contacts.map((c) => [c.name, c.tier, c.role])).toEqual([
      ["Travis French", "verified", "VP of Operations"],
      ["Jane Ops", "inferred", "VP of Operations"],
    ]);
    const [travis, jane] = r.contacts;
    expect(travis).toMatchObject({ why: "Senior Vice President of Warehousing and Fulfillment Operations", profile_url: "https://www.linkedin.com/in/travis-french", found_via: "people_index" });
    expect(travis!.evidence).toMatchObject({ url: TEAM_URL });
    // Inferred: name, link and the approved role it was listed under; no title text, no evidence.
    expect(jane).toEqual({ name: "Jane Ops", tier: "inferred", role: "VP of Operations", why: "VP of Operations", profile_url: "https://www.linkedin.com/in/jane-ops", found_via: "people_index", code: "contact_unverified" });
    expect(r.checked).toEqual(expect.arrayContaining([
      { name: "Bob Gone", outcome: "dropped", code: "contact_unverified" },
      { name: "Ann Elsewhere", outcome: "dropped", code: "contact_unverified" },
      { name: "Chris Verst", outcome: "dropped", code: "contact_role_mismatch" },
      { name: "Pat Ghost", outcome: "dropped", code: "contact_quote_not_in_page" },
    ]));
    expect(r.cost).toBeCloseTo(0.019, 9);
  });

  it("sends a people search with no contents, then a page search that excludes LinkedIn and aggregators", async () => {
    const exa = fakeExa(PEOPLE, PAGES);
    await findContacts({ company: "Verst Logistics", buyerRoles: ROLES }, { exaSearch: exa.fn as never });
    expect(exa.calls[0]).toEqual(peopleSearchBody("Verst Logistics", ROLES));
    expect(exa.calls[0]).toMatchObject({ category: "people", numResults: 5, query: "VP of Operations or Warehouse general manager at Verst Logistics" });
    expect(exa.calls[0]!.contents).toBeUndefined();
    expect(exa.calls[1]).toMatchObject({ query: '"Verst Logistics" VP of Operations or Warehouse general manager leadership team', numResults: 5 });
    expect(exa.calls[1]!.excludeDomains).toEqual(expect.arrayContaining(["linkedin.com", "exa.ai", "theorg.com", "zoominfo.com"]));
    expect(JSON.stringify((exa.calls[1]!.contents as { summary: { query: string } }).summary.query)).toContain("Travis French");
  });

  it("inferred when only LinkedIn knows them", async () => {
    const exa = fakeExa(PEOPLE, []);
    const r = await findContacts({ company: "Verst Logistics", buyerRoles: ROLES }, { exaSearch: exa.fn as never });
    expect(r.contacts.map((c) => [c.name, c.tier, c.role])).toEqual([
      ["Travis French", "inferred", "Warehouse general manager"],
      ["Jane Ops", "inferred", "VP of Operations"],
    ]);
    expect(r.contacts.every((c) => c.evidence === undefined)).toBe(true);
  });

  it("a LinkedIn page that slips into the page results never verifies anyone", async () => {
    const leaked = page("https://www.linkedin.com/in/travis-french", TEAM_TEXT, [{ name: "Travis French", title_quote: "Senior Vice President of Warehousing and Fulfillment Operations" }]);
    const r = await findContacts({ company: "Verst Logistics", buyerRoles: ROLES }, { exaSearch: fakeExa(PEOPLE, [leaked]).fn as never });
    expect(r.contacts.find((c) => c.name === "Travis French")).toMatchObject({ tier: "inferred" });
  });

  it("zero contacts when the only name is absent from its page", async () => {
    const r = await findContacts(
      { company: "Verst Logistics", buyerRoles: ROLES },
      { exaSearch: fakeExa([], [page(TEAM_URL, "Verst Logistics has a great team.", [{ name: "Pat Ghost", title_quote: "VP Operations" }])]).fn as never },
    );
    expect(r.contacts).toEqual([]);
    expect(r.checked).toEqual([{ name: "Pat Ghost", outcome: "dropped", code: "contact_quote_not_in_page" }]);
  });

  it("at most 3 contacts, verified first", async () => {
    const many = ["Ann One", "Ben Two", "Cat Three", "Dan Four", "Eve Five"].map((n) =>
      person(`https://www.linkedin.com/in/${n.replace(" ", "-").toLowerCase()}`, n, [{ title: "Head of Operations", company: "Verst Logistics" }]),
    );
    const r = await findContacts({ company: "Verst Logistics", buyerRoles: ROLES }, { exaSearch: fakeExa(many, PAGES).fn as never });
    expect(r.contacts).toHaveLength(CONTACT_LIMITS.maxContacts);
  });

  it("cost cap: the two calls' worst case is at most $0.03, and a run guard without room refuses before any call", async () => {
    expect(estimateContactCost("Verst Logistics", ROLES)).toBeLessThanOrEqual(CONTACT_LIMITS.maxCostDollars + 1e-9);
    expect(estimateExaCost(pageSearchBody("X", ROLES, ["A B", "C D"]))).toBe(estimateExaCost(pageSearchBody("X", ROLES, [])));
    const exa = fakeExa(PEOPLE, PAGES);
    const guard = new CostGuard(0.02);
    await expect(findContacts({ company: "Verst Logistics", buyerRoles: ROLES, guard }, { exaSearch: exa.fn as never })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(exa.fn).not.toHaveBeenCalled();
    const roomy = new CostGuard(1);
    await findContacts({ company: "Verst Logistics", buyerRoles: ROLES, guard: roomy }, { exaSearch: exa.fn as never });
    expect(roomy.spent).toBeCloseTo(0.019, 9);
  });

  it("a people-data mirror page cannot verify a contact; an old press page needs the index, else the contact is inferred with 'last confirmed'", async () => {
    const mirror = page("https://muraena.ai/profile/virgil_chandler_7a81e5b6", "Virgil Chandler\nTitle: VP of Operations\nCompany: Verst Logistics", [{ name: "Virgil Chandler", title_quote: "VP of Operations" }]);
    const oldPress: ExaResult = {
      ...page(
        "https://www.prnewswire.com/news-releases/verst-names-todd-johnson-300836065.html",
        "Verst Logistics today announced that Todd Johnson has been named President and COO of the company, effective immediately. Johnson will oversee warehousing, transportation and customer operations across all of the company's facilities in the Midwest and Southeast.",
        [{ name: "Todd Johnson", title_quote: "President and COO" }, { name: "Jane Ops", title_quote: "Vice President of Fulfillment Operations" }],
      ),
      publishedDate: "2019-06-03T00:00:00.000Z",
    };
    const roles = ["VP of Operations", "COO"];
    const people = [
      person("https://www.linkedin.com/in/todd-johnson", "Todd Johnson", [{ title: "President and COO", company: "Verst Logistics" }]),
    ];
    // Todd: index lists him current in an approved role -> the 2019 press verifies, date kept.
    const withIndex = await findContacts({ company: "Verst Logistics", buyerRoles: roles }, { exaSearch: fakeExa(people, [mirror, oldPress]).fn as never });
    const todd = withIndex.contacts.find((c) => c.name === "Todd Johnson")!;
    expect(todd).toMatchObject({ tier: "verified" });
    expect(todd.evidence!.published).toBe("2019-06-03");
    expect(withIndex.contacts.find((c) => c.name === "Virgil Chandler")).toBeUndefined();
    // Without the index entry the same page only infers, and says when it was last confirmed.
    const alone = await findContacts({ company: "Verst Logistics", buyerRoles: roles }, { exaSearch: fakeExa([], [mirror, oldPress]).fn as never });
    expect(alone.contacts.find((c) => c.name === "Todd Johnson")).toEqual({
      name: "Todd Johnson",
      tier: "inferred",
      role: "VP of Operations",
      why: "President and COO",
      found_via: "web_page",
      code: "contact_stale",
      note: "last confirmed 2019",
    });
    expect(alone.contacts.some((c) => c.tier === "verified")).toBe(false);
  });

  it("the run's guard is input.guard: spend lands on it; a guard passed through deps is refused, not silently ignored", async () => {
    const exa = fakeExa(PEOPLE, PAGES);
    const guard = new CostGuard(1);
    const r = await findContacts({ company: "Verst Logistics", buyerRoles: ROLES, guard }, { exaSearch: exa.fn as never });
    expect(r.cost).toBeCloseTo(0.019, 9);
    expect(guard.spent).toBeCloseTo(r.cost, 9);
    expect(exa.fn.mock.calls.every((c) => c[2] === guard)).toBe(true);
    const other = new CostGuard(1);
    await expect(findContacts({ company: "Verst Logistics", buyerRoles: ROLES }, { exaSearch: exa.fn as never, guard: other } as never)).rejects.toThrow(/input\.guard/);
    expect(other.spent).toBe(0);
  });

  it("no approved roles: refuses without spending", async () => {
    const exa = fakeExa(PEOPLE, PAGES);
    await expect(findContacts({ company: "Verst Logistics", buyerRoles: [] }, { exaSearch: exa.fn as never })).rejects.toThrow(/no approved buyer roles/);
    expect(exa.fn).not.toHaveBeenCalled();
  });
});

/* ---------- the find_contacts tool ---------- */

const lead = (company: string): AcceptedLead => ({
  company,
  signal_url: `https://news.example/${company.toLowerCase().replace(/\s+/g, "-")}`,
  why_now: "Opened a new warehouse",
  summary: { company_name: company, signal_type: "expansion", signal_summary: "new site", signal_date: "2026-10-01" },
  details: {},
  turn: 3,
});

function state(over: Partial<SearchPlan> = {}): RunState {
  const s = createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan: plan(over), createdAt: NOW.toISOString() });
  s.strategyApproved = true;
  s.leads.push(lead("Verst Logistics"));
  s.caches.enrichmentByName.verstlogistics = { summary: {}, url: "https://verstlogistics.com" };
  return s;
}

const found: FindContactsResult = {
  contacts: [
    { name: "Travis French", tier: "verified", role: "VP of Operations", why: "Senior Vice President of Operations", found_via: "web_page", evidence: { url: TEAM_URL, quote: "Travis French, Senior Vice President of Operations", title_quote: "Senior Vice President of Operations" } },
    { name: "Jane Ops", tier: "inferred", role: "VP of Operations", why: "VP of Operations", profile_url: "https://www.linkedin.com/in/jane-ops", found_via: "people_index", code: "contact_unverified" },
  ],
  cost: 0.019,
  checked: [
    { name: "Travis French", outcome: "verified" },
    { name: "Jane Ops", outcome: "inferred", code: "contact_unverified" },
    { name: "Pat Ghost", outcome: "dropped", code: "contact_quote_not_in_page" },
  ],
};

function deps(findContacts = vi.fn(async () => found)): ToolDeps & { findContacts: typeof findContacts } {
  return { checkLead: vi.fn() as never, now: NOW, findContacts };
}

const call = (s: RunState, d: ToolDeps, company: string, id = "toolu_c1", guard = new CostGuard(1)) =>
  executeTool(s, { id, name: "find_contacts", input: { company } }, d, { guard });

describe("find_contacts tool", () => {
  it("schema is strict: one string, no min/max, no {}", () => {
    const tool = agentTools().find((t) => t.name === "find_contacts")!;
    expect(tool).toMatchObject({ strict: true, input_schema: { type: "object", additionalProperties: false, required: ["company"], properties: { company: { type: "string" } } } });
    expect(JSON.stringify(tool.input_schema)).not.toMatch(/minimum|maximum|minItems|maxItems|"\{\}"/);
  });

  it("an accepted lead: contacts persisted on the lead, structured result, counts only in the trace summary", async () => {
    const s = state();
    const d = deps();
    const r = await call(s, d, "verst logistics");
    expect(r.result.is_error).toBeUndefined();
    expect(d.findContacts).toHaveBeenCalledWith(
      expect.objectContaining({ company: "Verst Logistics", companyUrl: "https://verstlogistics.com", buyerRoles: ROLES }),
      expect.anything(),
    );
    expect(s.leads[0]!.contacts).toMatchObject({ at: NOW.toISOString(), roles: ROLES, cost: 0.019, contacts: found.contacts });
    const content = JSON.parse(String(r.result.content));
    expect(content.contacts).toEqual([
      { name: "Travis French", tier: "verified", why: 'title on verstlogistics.com: "Senior Vice President of Operations"', evidence_url: TEAM_URL },
      { name: "Jane Ops", tier: "inferred", why: "listed in a people index as VP of Operations; title not confirmed" },
    ]);
    expect(r.exaCost).toBe(0.019);
    expect(r.resultSummary).toBe("Verst Logistics: verified=1 · inferred=1 · dropped=1");
    expect(r.resultSummary).not.toMatch(/Travis|Jane|Pat/);
    // Contacts never change the lead count or the lead itself.
    expect(s.leads).toHaveLength(1);
    expect(r.acceptedLead).toBe(false);
  });

  it("refuses a company that is not an accepted lead, without spending", async () => {
    const s = state();
    s.candidates.push({ ...lead("Candidate Co"), code: "quote_not_in_page", missing: "x" });
    const d = deps();
    for (const company of ["Candidate Co", "Nobody Inc", ""]) {
      const r = await call(s, d, company);
      expect(r.result.is_error).toBe(true);
      expect(String(r.result.content)).toMatch(/not an accepted lead/);
      expect(r.exaCost).toBe(0);
    }
    expect(d.findContacts).not.toHaveBeenCalled();
  });

  it("one call per lead: a second call is refused, also when two land in the same parallel batch", async () => {
    const s = state();
    const d = deps();
    await call(s, d, "Verst Logistics");
    const again = await call(s, d, "Verst Logistics", "toolu_c2");
    expect(again.result.is_error).toBe(true);
    expect(String(again.result.content)).toMatch(/already looked up/);
    expect(d.findContacts).toHaveBeenCalledTimes(1);

    const s2 = state();
    const d2 = deps();
    const [a, b] = await Promise.all([call(s2, d2, "Verst Logistics", "toolu_a"), call(s2, d2, "VERST LOGISTICS", "toolu_b")]);
    expect([a.result.is_error, b.result.is_error].filter(Boolean)).toHaveLength(1);
    expect(d2.findContacts).toHaveBeenCalledTimes(1);
  });

  it("a failed lookup still spends the one call and records the error", async () => {
    const s = state();
    const d = deps(vi.fn(async () => {
      throw new BudgetExceededError("budget cap would be exceeded");
    }));
    const r = await call(s, d, "Verst Logistics");
    expect(r.result.is_error).toBe(true);
    expect(s.leads[0]!.contacts).toMatchObject({ contacts: [], error: "budget cap would be exceeded" });
    expect((await call(s, d, "Verst Logistics", "toolu_c3")).result.content).toMatch(/already looked up/);
  });

  it("a plan without approved roles: refused, nothing spent", async () => {
    const s = state({ buyerRoles: undefined });
    const d = deps();
    const r = await call(s, d, "Verst Logistics");
    expect(r.result.is_error).toBe(true);
    expect(String(r.result.content)).toMatch(/no approved buyer roles/);
    expect(d.findContacts).not.toHaveBeenCalled();
    expect(s.leads[0]!.contacts).toBeUndefined();
  });

  it("end to end with the real findContacts on a fake Exa: run spend and lead cost agree", async () => {
    const s = state();
    const exa = fakeExa(PEOPLE, PAGES);
    const guard = new CostGuard(1);
    const r = await executeTool(s, { id: "toolu_e2e", name: "find_contacts", input: { company: "Verst Logistics" } }, { checkLead: vi.fn() as never, now: NOW, exaSearch: exa.fn as never }, { guard });
    expect(r.result.is_error).toBeUndefined();
    expect(s.leads[0]!.contacts!.contacts.map((c) => c.tier)).toEqual(["verified", "inferred"]);
    expect(s.leads[0]!.contacts!.cost).toBeCloseTo(guard.spent, 9);
    expect(s.spend.exa).toBeCloseTo(0.019, 9);
  });

  it("remember refuses a note that names a person find_contacts returned", async () => {
    const s = state();
    await call(s, deps(), "Verst Logistics");
    expect(validateNote(s, { text: "Travis French at a 3PL answered first.", tags: ["3pl"] })).toMatchObject({ ok: false, error: expect.stringMatching(/must not name people/) });
    expect(validateNote(s, { text: "Team pages of mid-size 3PLs name their operations leaders.", tags: ["3pl"] })).toMatchObject({ ok: true });
  });
});

/* ---------- prompts ---------- */

describe("prompts", () => {
  it("the first message lists the approved roles only when the plan has them", () => {
    const contract = { ...plan(), targetLeads: 5, maxCostDollars: 2, preferenceNotes: [] };
    expect(firstUserMessage(contract)).toContain("Approved buyer roles: VP of Operations; Warehouse general manager.");
    expect(firstUserMessage({ ...contract, buyerRoles: undefined })).not.toContain("Who to reach");
    expect(AGENT_SYSTEM_PROMPT).toContain("Never name, guess or add a person yourself.");
  });
});

/* ---------- plan and cards ---------- */

describe("buyerRoles on the plan and the cards", () => {
  it("validatePlan keeps clean roles, dedupes case-insensitively, omits the key when absent", () => {
    const ok = validatePlan(plan({ buyerRoles: ["  VP of  Operations ", "vp of operations", "COO"] }));
    expect(ok).toMatchObject({ ok: true, plan: { buyerRoles: ["VP of Operations", "COO"] } });
    const none = validatePlan(plan({ buyerRoles: undefined }));
    expect(none.ok && "buyerRoles" in none.plan).toBe(false);
    const empty = validatePlan(plan({ buyerRoles: [] }));
    expect(empty.ok && "buyerRoles" in empty.plan).toBe(false);
  });

  it("validatePlan rejects a non-array, blank or over-long role, and more than 6", () => {
    expect(validatePlan({ ...plan(), buyerRoles: "COO" })).toMatchObject({ ok: false, errors: ["buyerRoles must be an array when present"] });
    expect(validatePlan(plan({ buyerRoles: [""] }))).toMatchObject({ ok: false });
    expect(validatePlan(plan({ buyerRoles: ["x".repeat(81)] }))).toMatchObject({ ok: false });
    expect(validatePlan(plan({ buyerRoles: ["123"] }))).toMatchObject({ ok: false });
    expect(validatePlan(plan({ buyerRoles: ["A", "B", "C", "D", "E", "F", "G"] }))).toMatchObject({ ok: false, errors: ["buyerRoles must have at most 6 items"] });
  });

  const cards = (): CardSet => ({
    who: { industry: "3PL", descriptor: "mid-size 3PLs" },
    whyNow: { signalTypes: ["new_facility", "expansion"], description: "a new warehouse" },
    size: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
    geo: { hqCountries: ["US"] },
    recency: { months: 3 },
    exclusions: { names: [], domains: [] },
    rationale: {},
    alternatives: [],
  });

  it("cards are pre-filled from the profile's buyer_roles by code, and kept when already set", () => {
    expect(withBuyerRoles(cards(), { buyer_roles: ["VP of Operations", " ", "vp of operations", "Warehouse GM"] }).buyerRoles).toEqual(["VP of Operations", "Warehouse GM"]);
    expect(withBuyerRoles({ ...cards(), buyerRoles: [] }, { buyer_roles: ["COO"] }).buyerRoles).toEqual([]);
    expect(withBuyerRoles(cards(), null).buyerRoles).toEqual([]);
  });

  it("validateCards keeps buyerRoles and rejects a non-array", () => {
    expect(validateCards({ ...cards(), buyerRoles: ["COO", "coo"] })).toMatchObject({ ok: true, value: { buyerRoles: ["COO"] } });
    expect(validateCards({ ...cards(), buyerRoles: "COO" })).toMatchObject({ ok: false });
    const without = validateCards(cards());
    expect(without.ok && "buyerRoles" in without.value).toBe(false);
  });

  it("the demo planner copies the card's roles onto the plan", async () => {
    const { plan: p } = await demoPlan({ ...cards(), buyerRoles: ["COO"] });
    expect(p.buyerRoles).toEqual(["COO"]);
    const { plan: q } = await demoPlan(cards());
    expect(q.buyerRoles).toBeUndefined();
  });
});

/* ---------- CSV ---------- */

describe("CSV export", () => {
  it("adds name / title / tier / profile URL / evidence URL columns; inferred rows copy no title", () => {
    const withContacts: AcceptedLead = { ...lead("Verst Logistics"), contacts: { at: NOW.toISOString(), roles: ROLES, cost: 0.019, contacts: found.contacts } };
    const csv = leadsCsv([withContacts, lead("Other Co")]);
    const [head, first, second] = csv.split("\r\n");
    expect(head!.endsWith(CONTACT_CSV_COLUMNS.join(","))).toBe(true);
    expect(first).toContain("Travis French; Jane Ops,Senior Vice President of Operations; ,verified; inferred,; https://www.linkedin.com/in/jane-ops,https://www.verstlogistics.com/about-us/our-team/travis-french; ");
    expect(second!.endsWith(",,,,,")).toBe(true);
    expect(csv).not.toMatch(/@|phone|email/i);
  });
});

/* ---------- trace ---------- */

describe("trace: tool:find_contacts observation", () => {
  it("carries its Exa cost and contact counts, never names", () => {
    const RUN = "7c1d2a9e-0000-4000-8000-00000000c0aa";
    const ev = (over: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "turn" | "ts">) => ({ runId: RUN, promptVersion: "p", ...over }) as AgentEvent;
    const events = [
      ev({ kind: "model_call", turn: 4, ts: "2026-10-16T09:00:01.000Z", latencyMs: 1000, tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0 }, claudeCost: 0.01, model: "claude-opus-5-5", responseId: "msg_c" }),
      ev({ kind: "tool_call", turn: 4, ts: "2026-10-16T09:00:03.000Z", tool: "find_contacts", input: { company: "Verst Logistics" }, toolUseId: "toolu_fc", latencyMs: 2000, is_error: false, exaCost: 0.019, resultSummary: "Verst Logistics: verified=1 · inferred=1 · dropped=1" }),
      ev({ kind: "turn_end", turn: 4, ts: "2026-10-16T09:00:04.000Z", durationMs: 3000, status: "running", spend: { total: 0.029 }, leads: 1, before: { status: "running", turn: 3 } }),
    ];
    const obs = toObservations(events)[0]!.observations.find((o) => o.name === "tool:find_contacts")!;
    expect(obs).toMatchObject({ type: "tool", costDetails: { total: 0.019 }, metadata: { tool: "find_contacts", exaCost: 0.019, contacts: { verified: 1, inferred: 1, dropped: 1 } } });
    expect(contactCounts("error: boom")).toEqual({});
  });
});

/* ---------- eval scaffold (code only; the judge is not run) ---------- */

describe("contact eval scaffold", () => {
  it("the case set parses (contact-eval cases carry label null until judged); a case is validated field by field", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseContactCases, validateContactCase } = await import("./harness/judge-contacts");
    for (const c of parseContactCases(readFileSync("eval/datasets/contact-cases.jsonl", "utf8"))) expect(c.label === null || ["verified", "inferred", "wrong"].includes(c.label)).toBe(true);
    const good = { id: "cc-1", company: "Verst Logistics", candidate_name: "Travis French", title: "SVP Logistics", url: "https://verstlogistics.com/team", label: "verified", note: "team page" };
    expect(validateContactCase(good)).toEqual([]);
    expect(validateContactCase({ ...good, label: "maybe", url: "ftp://x" })).toEqual(["url must be http(s)", "label must be null or one of verified | inferred | wrong"]);
    expect(() => parseContactCases(`${JSON.stringify({ ...good, company: "" })}\n`)).toThrow(/line 1: company must be a non-empty string/);
  });

  it("the judge answer parser takes the last valid verdict; unparseable replies become cannot_verify, never silent", async () => {
    const { parseContactJudge, judgeContact, contactsFromRunState, contactMetrics } = await import("./harness/judge-contacts");
    expect(parseContactJudge('thinking {"x":1} then {"current":"Yes","source":"https://a.example","note":"team page"}')).toEqual({ current: "yes", source: "https://a.example", note: "team page" });
    expect(parseContactJudge("no json")).toBeUndefined();
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "I could not decide." }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const v = await judgeContact({ id: "c1", company: "Verst Logistics", name: "Travis French", title: "SVP" }, { messages: { create } } as never, NOW);
    expect(v).toMatchObject({ current: "cannot_verify", note: "unparseable judge reply" });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/no parseable verdict for c1/));
    err.mockRestore();
    // The judge prompt never carries the product's tier or evidence.
    expect(JSON.stringify((create.mock.calls[0] as unknown[])[0])).not.toMatch(/verified|inferred|evidence/);
    const s = state();
    s.leads[0]!.contacts = { at: "", roles: ROLES, cost: 0, contacts: found.contacts };
    expect(contactsFromRunState(s)).toEqual([
      { id: "Verst Logistics#0", company: "Verst Logistics", name: "Travis French", title: "Senior Vice President of Operations", tier: "verified" },
      { id: "Verst Logistics#1", company: "Verst Logistics", name: "Jane Ops", title: "VP of Operations", tier: "inferred" },
    ]);
    expect(contactMetrics([{ tier: "verified", current: "yes" }, { tier: "verified", current: "no" }, { tier: "inferred", current: "no" }, { tier: "inferred", current: "cannot_verify" }])).toEqual({
      verified: 2,
      inferred: 2,
      verifiedPrecision: 0.5,
      verifiedStaleRate: 0.5,
      inferredWrongShare: 1,
      cannotVerify: 1,
    });
  });
});

/* ---------- FAILURES #30: directories, former roles, duplicates, casing ---------- */

describe("FAILURES #30: company directories cannot verify", () => {
  const finney = { name: "Donald Finney", company: "Bay Logistics", title_quote: "Operational Director And Mentor" };
  const ctx = { buyerRoles: ["VP of Operations", "COO", "Head of Warehousing", "Director of Logistics"], companyUrl: "https://www.baylogistics.com/", now: NOW };
  const DIRECTORY =
    "## Vice President Operations for Bay Logistics, Inc. \n\nJon Swart\n\nVice President Operations\n\n## View Employees\n\nRob Whitby\n\n Director Of Operations \n\nDonald Finney\n\n Operational Director And Mentor \n\nChili Akoma\n\n Director Of Business Development \n\n## Frequently Asked Questions regarding Bay Logistics, Inc.";

  it("the recorded visualvisitor company page is inferred by its host and, on an unknown host, by its /companies/<id>/ URL shape", () => {
    const url = "https://www.visualvisitor.com/companies/5788692/bay_logistics_inc.";
    expect(checkContact(finney, { ...ctx, page: { url, text: DIRECTORY } })).toMatchObject({ ok: false, tier: "inferred", code: "contact_unverified" });
    const unknownHost = "https://bizdir.example/companies/5788692/bay_logistics_inc";
    expect(isAggregatorShapedUrl(unknownHost)).toBe(true);
    expect(checkContact(finney, { ...ctx, page: { url: unknownHost, text: DIRECTORY } })).toMatchObject({ ok: false, code: "contact_unverified", reason: expect.stringContaining("profile or directory") });
  });

  it.each(["https://x.example/companies/5788692/bay", "https://x.example/company/12345/acme", "https://x.example/company/12345"])("directory URL shape %s", (url) => {
    expect(isAggregatorShapedUrl(url)).toBe(true);
  });

  it("a company path with a slug (not an id) is not a directory shape; the company's own /company/<id> page still verifies", () => {
    expect(isAggregatorShapedUrl("https://news.example/company/bay-logistics-expands")).toBe(false);
    const own = { name: "Jon Swart", company: "Bay Logistics", title_quote: "Vice President of Operations" };
    expect(checkContact(own, { ...ctx, page: { url: "https://www.baylogistics.com/company/42/leadership", text: "Jon Swart, Vice President of Operations." } })).toMatchObject({ ok: true });
  });

  it("directory hosts are excluded from the evidence search", () => {
    for (const d of ["visualvisitor.com", "dnb.com", "buzzfile.com", "manta.com", "bizapedia.com", "opencorporates.com", "growjo.com", "tracxn.com", "owler.com", "craft.co", "cbinsights.com", "signalhire.com", "zoominfo.com"]) {
      expect(CONTACT_NON_EVIDENCE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`)), d).toBe(true);
    }
  });

  it("titleMatchesRole: the function word must match; operations is not logistics unless the role list holds both", () => {
    // "Operational Director And Mentor" fits "VP of Operations" on the function word only (as "Director of Operations" does).
    expect(titleMatchesRole("Operational Director And Mentor", "VP of Operations")).toBe(true);
    expect(titleMatchesRole("Operational Director And Mentor", "Director of Logistics")).toBe(false);
    expect(titleMatchesRole("Director of Logistics", "VP of Operations")).toBe(false);
    expect(titleMatchesRole("Director of Logistics", "Director of Logistics")).toBe(true);
  });
});

describe("FAILURES #30: a former role is not a current one", () => {
  const roles = ["VP of Operations", "COO"];
  const company = "fulfilmentcrowd";
  const own = "https://www.fulfilmentcrowd.com/blog/leadership";
  const ctx = { buyerRoles: roles, companyUrl: "https://fulfilmentcrowd.com/", now: NOW };
  const taylor = (title_quote: string) => ({ name: "Paul Taylor", company, title_quote });

  it("Paul Taylor: 'Managing Director, stepping up from his previous role as Chief Operating Officer' is inferred as role changed", () => {
    const text = "Paul Taylor has been appointed Managing Director, stepping up from his previous role as Chief Operating Officer.\n\nJoining fulfilmentcrowd in 2021, Paul has over 20 years of experience.";
    const v = checkContact(taylor("Managing Director, stepping up from his previous role as Chief Operating Officer."), { ...ctx, page: { url: own, text } });
    expect(v).toMatchObject({ ok: false, tier: "inferred", code: "contact_role_changed", changed: { role: "VP of Operations", marker: expect.stringMatching(/stepping up/i) } });
  });

  it("when the new title itself fits a role, the new title verifies (and is the one recorded)", () => {
    const text = "Pat Lee has been appointed Chief Operating Officer, stepping up from his previous role as Director of Sales at fulfilmentcrowd.";
    const v = checkContact({ name: "Pat Lee", company, title_quote: "Chief Operating Officer, stepping up from his previous role as Director of Sales" }, { ...ctx, page: { url: own, text } });
    expect(v).toMatchObject({ ok: true, tier: "verified", role: "VP of Operations", evidence: { title_quote: "Chief Operating Officer" } });
  });

  it.each([
    "Paul Taylor, former Chief Operating Officer, left in March.",
    "Paul Taylor, formerly Chief Operating Officer of fulfilmentcrowd, now advises the board.",
    "Paul Taylor is the outgoing Chief Operating Officer.",
    "Paul Taylor retired as Chief Operating Officer last year.",
    "Paul Taylor, retiring Chief Operating Officer, hands over in May.",
    "Paul Taylor, Chief Operating Officer until 2024, now consults.",
    "Paul Taylor was Chief Operating Officer for five years.",
    "Paul Taylor, ex-Chief Operating Officer, speaks next week.",
    "Paul Taylor, Chief Operating Officer, was succeeded by Ann Lee in May.",
    "Ann Lee succeeds Paul Taylor as Chief Operating Officer in May.",
    "Paul Taylor joined in 2021 as Chief Operating Officer – now Managing Director of the group.",
  ])("%s", (text) => {
    const v = checkContact(taylor("Chief Operating Officer"), { ...ctx, page: { url: own, text } });
    expect(v).toMatchObject({ ok: false, tier: "inferred", code: "contact_role_changed" });
  });

  it("a current executive's 'previously' bio, and a former-role phrase in the NEXT person's paragraph, do not flag", () => {
    const team =
      "### Paul Taylor\n\nChief Operating Officer\n\nPreviously, Paul led operations at two other fulfilment businesses and has over 20 years of experience.\n\n### Ann Lee\n\nFormer Chief Financial Officer at Acme, now Head of Finance.";
    expect(checkContact(taylor("Chief Operating Officer"), { ...ctx, page: { url: own, text: team } })).toMatchObject({ ok: true, tier: "verified" });
  });

  it("formerRoleMarker: the phrase list", () => {
    for (const t of ["former COO", "his previous role", "stepping up from", "stepped down", "outgoing", "retired", "until 2024", "until March 2024", "was COO", "ex-COO", "succeeded by Ann"]) {
      expect(formerRoleMarker(t), t).toBeTruthy();
    }
    for (const t of ["COO", "Previously, Troy led operations", "joined in 2021", "was named COO", "runs the business until further notice"]) {
      expect(formerRoleMarker(t), t).toBeUndefined();
    }
  });

  it("findContacts: Paul Taylor is shown as inferred 'role changed' (the index listing does not rescue him), Neil still verifies", async () => {
    const pages: ExaResult[] = [
      page(own, "Paul Taylor has been appointed Managing Director, stepping up from his previous role as Chief Operating Officer.", [{ name: "Paul Taylor", title_quote: "Managing Director, stepping up from his previous role as Chief Operating Officer." }]),
      page("https://www.fulfilmentcrowd.com/our-people", "### Paul Taylor\n\nManaging Director\n\n### Neil Midgley\n\nDirector of Operations\n\nNeil arrived in 2026.", [
        { name: "Paul Taylor", title_quote: "Managing Director" },
        { name: "Neil Midgley", title_quote: "Director of Operations" },
      ]),
    ];
    const r = await findContacts({ company, companyUrl: "https://fulfilmentcrowd.com/", buyerRoles: roles }, { exaSearch: fakeExa([], pages).fn as never });
    expect(r.contacts.find((c) => c.name === "Neil Midgley")).toMatchObject({ tier: "verified" });
    expect(r.contacts.find((c) => c.name === "Paul Taylor")).toMatchObject({ tier: "inferred", code: "contact_role_changed", note: "role changed", role: "VP of Operations" });
    expect(r.contacts.filter((c) => c.tier === "verified").map((c) => c.name)).toEqual(["Neil Midgley"]);
  });
});

describe("FAILURES #30: one person, one record", () => {
  it("post-nominals, punctuation and middle initials do not make a second person", () => {
    expect(personNameTokens("Neil Midgley FCILT")).toEqual(["Neil", "Midgley"]);
    expect(personNameTokens("Pat Lee, MBA")).toEqual(["Pat", "Lee"]);
    expect(personNameTokens("Sam Ray Jr.")).toEqual(["Sam", "Ray"]);
    expect(personNameTokens("Dr. Ann Cole, PhD")).toEqual(["Ann", "Cole"]);
    expect(personNameTokens("Kim Park III")).toEqual(["Kim", "Park"]);
    expect(personNameTokens("Anna SMITH")).toEqual(["Anna", "SMITH"]);
    const key = personKey("Neil Midgley");
    for (const n of ["Neil Midgley FCILT", "Neil J. Midgley", "neil midgley", "Neil Midgley, CPA", "NEIL MIDGLEY"]) expect(personKey(n), n).toBe(key);
    expect(personKey("Neil Midgley")).not.toBe(personKey("Neil Midgeley"));
  });

  it("dedupeContacts keeps the higher tier and attaches the profile link to it", () => {
    const verified: Contact = { name: "Neil Midgley", tier: "verified", role: "VP of Operations", why: "Director of Operations", found_via: "web_page", evidence: { url: "https://www.fulfilmentcrowd.com/our-people", quote: "Neil Midgley Director of Operations", title_quote: "Director of Operations" } };
    const inferred: Contact = { name: "Neil Midgley FCILT", tier: "inferred", role: "VP of Operations", why: "VP of Operations", profile_url: "https://linkedin.com/in/neil-midgley-fcilt-b8ba8548", found_via: "people_index", code: "contact_unverified" };
    const out = dedupeContacts([inferred, verified]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Neil Midgley", tier: "verified", profile_url: "https://linkedin.com/in/neil-midgley-fcilt-b8ba8548" });
  });

  it("findContacts: an index entry with post-nominals and the page's plain name come out as one verified contact with the profile link", async () => {
    const people = [person("https://www.linkedin.com/in/neil-midgley-fcilt-b8ba8548", "Neil Midgley FCILT", [{ title: "VP of Operations", company: "fulfilmentcrowd" }])];
    const pages = [page("https://www.fulfilmentcrowd.com/our-people", "### Neil Midgley\n\nDirector of Operations\n\nNeil arrived in 2026.", [{ name: "Neil Midgley", title_quote: "Director of Operations" }])];
    const r = await findContacts({ company: "fulfilmentcrowd", companyUrl: "https://fulfilmentcrowd.com/", buyerRoles: ["VP of Operations"] }, { exaSearch: fakeExa(people, pages).fn as never });
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]).toMatchObject({ name: "Neil Midgley", tier: "verified", profile_url: "https://www.linkedin.com/in/neil-midgley-fcilt-b8ba8548" });
  });
});

describe("FAILURES #30: names come out as the evidence page writes them", () => {
  it("properCaseName title-cases only an all-lowercase or all-uppercase name", () => {
    expect(properCaseName("kurt cuncannan")).toBe("Kurt Cuncannan");
    expect(properCaseName("KURT CUNCANNAN")).toBe("Kurt Cuncannan");
    expect(properCaseName("mary-jane o'brien")).toBe("Mary-Jane O'Brien");
    expect(properCaseName("ludwig van beethoven")).toBe("Ludwig van Beethoven");
    expect(properCaseName("Kurt McCann")).toBe("Kurt McCann");
    expect(properCaseName("Joe MacLean")).toBe("Joe MacLean");
  });

  it("checkContact returns the page's casing; a lowercase name from the index or summariser does not leak through", () => {
    const text = "Kurt Cuncannan, COO\n\nBay Logistics\n\nKurt joined the company in 2019 and runs the day to day operation of every terminal in the network.";
    const v = checkContact({ name: "kurt cuncannan", company: "Bay Logistics", title_quote: "COO" }, { page: { url: "https://www.baylogistics.com/team", text }, buyerRoles: ["COO"], companyUrl: "https://baylogistics.com", now: NOW });
    expect(v).toMatchObject({ ok: true, name: "Kurt Cuncannan" });
    const shouting = checkContact({ name: "kurt cuncannan", company: "Bay Logistics", title_quote: "COO" }, { page: { url: "https://www.baylogistics.com/team", text: "KURT CUNCANNAN, COO" }, buyerRoles: ["COO"], companyUrl: "https://baylogistics.com", now: NOW });
    expect(shouting).toMatchObject({ ok: true, name: "Kurt Cuncannan" });
  });

  it("findContacts: verified name uses the page casing; an index-only lowercase name is title-cased", async () => {
    const people = [
      person("https://www.linkedin.com/in/kurt-cuncannan-b1933228", "kurt cuncannan", [{ title: "COO", company: "Bay Logistics" }]),
      person("https://www.linkedin.com/in/rock-magnan-1", "rock magnan", [{ title: "COO", company: "Bay Logistics" }]),
    ];
    const pages = [page("https://www.baylogistics.com/team", "Kurt Cuncannan, COO\n\nBay Logistics runs terminals across the Midwest.", [{ name: "Kurt Cuncannan", title_quote: "COO" }])];
    const r = await findContacts({ company: "Bay Logistics", companyUrl: "https://baylogistics.com", buyerRoles: ["COO"] }, { exaSearch: fakeExa(people, pages).fn as never });
    expect(r.contacts.map((c) => [c.name, c.tier])).toEqual([["Kurt Cuncannan", "verified"], ["Rock Magnan", "inferred"]]);
  });
});
