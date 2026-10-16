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
import { CONTACT_LIMITS, estimateContactCost, findContacts, pageSearchBody, peopleSearchBody, type FindContactsResult } from "../src/contacts";
import { BudgetExceededError, CostGuard, estimateExaCost } from "../src/exa";
import { checkContact, titleMatchesRole } from "../src/gates";
import { validatePlan, type SearchPlan } from "../src/plan";
import { validateCards, withBuyerRoles, type CardSet } from "../src/planner/cards";
import { demoPlan } from "../src/demo/planner";
import { firstUserMessage, AGENT_SYSTEM_PROMPT } from "../src/agent/prompts";
import { CONTACT_CSV_COLUMNS, leadsCsv } from "../app/ui/copy";
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
    const press = { url: "https://news.example.com/verst", text: TEAM_TEXT };
    expect(checkContact(base, { ...ctx, page: press }).ok).toBe(true);
    const unnamed = { url: "https://news.example.com/x", text: TEAM_TEXT.replace(/Verst Logistics/g, "the company") };
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
  it("the labelled set ships empty and parses; a case is validated field by field", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseContactCases, validateContactCase } = await import("./harness/judge-contacts");
    expect(parseContactCases(readFileSync("eval/datasets/contact-cases.jsonl", "utf8"))).toEqual([]);
    const good = { id: "cc-1", company: "Verst Logistics", candidate_name: "Travis French", title: "SVP Logistics", url: "https://verstlogistics.com/team", label: "verified", note: "team page" };
    expect(validateContactCase(good)).toEqual([]);
    expect(validateContactCase({ ...good, label: "maybe", url: "ftp://x" })).toEqual(["url must be http(s)", "label must be one of verified | inferred | wrong"]);
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
      { id: "Verst Logistics#0", company: "Verst Logistics", name: "Travis French", title: "Senior Vice President of Operations" },
      { id: "Verst Logistics#1", company: "Verst Logistics", name: "Jane Ops", title: "VP of Operations" },
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
