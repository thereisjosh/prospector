import probe from "./probe-v2-results.json";
import { describe, expect, it, vi } from "vitest";
import { validatePlan } from "../src/plan";
import { CostGuard } from "../src/exa";
import { classifyInput, compilePlan, profileSeller, resolveToSite, suggestCards, type CardSet } from "../src/planner";
import { extractFirstJsonObject, PlannerTokenLimitError } from "../src/planner/claude";

function probeUrls(id: string): string[] {
  const p = probe.probes.find((item) => item.id === id);
  return (p?.result as { urls?: string[] } | undefined)?.urls ?? [];
}

function fakeClient(jsons: unknown[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: JSON.stringify(jsons[i++]) }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      })),
    },
  };
}

const validCards = (): CardSet => ({
  who: { industry: "restaurants and cafes", descriptor: "independent cafes" },
  whyNow: {
    signalTypes: ["new_location", "hiring_ops"],
    description: "expansion or operational change",
  },
  size: { min: 5, max: 200, unknownPolicy: "allow-if-not-enterprise" },
  stage: "any",
  geo: { hqCountries: ["SG"] },
  recency: { months: 6 },
  exclusions: { names: ["Starbucks"], domains: ["starbucks.com"] },
  rationale: { who: "Likely buyers." },
  alternatives: [],
});

describe("planner input resolution", () => {
  it("classifies urls, instagram handles, instagram URLs, and text", () => {
    expect(classifyInput("@lovebonito")).toMatchObject({ kind: "social", platform: "instagram", handle: "lovebonito" });
    expect(classifyInput("instagram.com/hitpay.sg")).toMatchObject({ kind: "social", platform: "instagram", handle: "hitpay.sg" });
    expect(classifyInput("hitpayapp.com")).toEqual({ kind: "url", value: "hitpayapp.com" });
    expect(classifyInput("we sell payment terminals to cafes")).toEqual({
      kind: "text",
      value: "we sell payment terminals to cafes",
    });
  });

  it("ranks Instagram domain candidates from the probe URLs and excludes social hosts", async () => {
    const exaSearch = vi.fn(async ({ query }: { query: string }) => {
      const id = query.includes("lovebonito")
        ? "A3 instagram resolution lovebonito"
        : "A3 instagram resolution hitpaysg";
      return { results: probeUrls(id).map((url) => ({ url })) };
    });
    const love = await resolveToSite(classifyInput("@lovebonito"), { exaSearch: exaSearch as never });
    expect(love).toMatchObject({ source: "social", platform: "instagram", candidates: [{ domain: "lovebonito.com" }] });
    const hitpay = await resolveToSite(classifyInput("@hitpaysg"), { exaSearch: exaSearch as never });
    expect(hitpay.candidates.map((c) => c.domain).slice(0, 2)).toEqual(["hitpayapp.com", "hitpay.org"]);
  });
});

describe("profileSeller", () => {
  it("merges profile summaries and normalises literal nulls and padded array items", async () => {
    const love = probe.probes.find((item) => item.id === "A1 seller profile https://www.lovebonito.com")!
      .result as { summary: unknown };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      costDollars: { total: 0.004 },
      results: [
        { summary: { offering: "null", buyer_type: "B2C", buyer_roles: [" cafes"], price_band: "null", geo_served: [], competitors: ["null"], existing_customers: [] } },
        { summary: love.summary },
        { summary: { existing_customers: ["Customer A"], competitors: [" Zara"] } },
      ],
    }), { status: 200 }));
    const result = await profileSeller("https://www.lovebonito.com", {
      fetch: fetchMock as never,
      credentials: { apiKey: "test" },
      guard: new CostGuard(0.10),
    });
    expect(result.cost).toBe(0.004);
    expect(result.needsDescription).toBe(false);
    expect(result.profile.offering).toContain("Love, Bonito");
    expect(result.profile.buyer_roles).toContain("cafes");
    expect(result.profile.competitors).toContain("asos");
    expect(result.profile.competitors).toContain("Zara");
    expect(result.profile.existing_customers).toEqual(["Customer A"]);
  });

  it("sets needsDescription when offering normalises away for thesmartlocal", async () => {
    const smart = probe.probes.find((item) => item.id === "A1 seller profile https://thesmartlocal.com")!
      .result as { summary: unknown };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ summary: smart.summary }],
      costDollars: { total: 0.001 },
    }), { status: 200 }));
    const result = await profileSeller("https://thesmartlocal.com", {
      fetch: fetchMock as never,
      credentials: { apiKey: "test" },
    });
    expect(result.needsDescription).toBe(true);
    expect(result.profile.offering).toBeUndefined();
    expect(result.profile.price_band).toBeUndefined();
  });
});

describe("suggestCards", () => {
  it("validates, retries once, and accounts Claude cost", async () => {
    const client = fakeClient([
      { ...validCards(), whyNow: { signalTypes: ["one"], description: "too few" } },
      validCards(),
    ]);
    const result = await suggestCards({ offering: "Payment terminals for cafes", buyer_roles: [], geo_served: [], competitors: [], existing_customers: [] }, { client });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.cards.whyNow.signalTypes).toEqual(["new_location", "hiring_ops"]);
    expect(result.cost).toBeCloseTo(0.028, 6);
  });
});

type CreateArgs = { system: string; messages: { content: string }[] };
const profileStub = { offering: "Payment terminals for cafes", buyer_roles: [], geo_served: [], competitors: [], existing_customers: [] };

async function cardsFrom(raw: unknown) {
  const client = fakeClient([raw]);
  const result = await suggestCards(profileStub, { client });
  expect(client.messages.create).toHaveBeenCalledTimes(1);
  return result.cards;
}

describe("suggestCards shape tolerance", () => {
  it("accepts signal types as an array of objects (type/name/label/id)", async () => {
    const cards = await cardsFrom({
      ...validCards(),
      whyNow: {
        description: "d",
        signalTypes: [{ type: "New Location" }, { name: "hiring-ops" }, { label: "Menu relaunch" }, { id: "3pl_switch" }],
      },
    });
    expect(cards.whyNow.signalTypes).toEqual(["new_location", "hiring_ops", "menu_relaunch", "3pl_switch"]);
  });

  it("accepts signal types as a comma or newline separated string and truncates beyond 6", async () => {
    const comma = await cardsFrom({ ...validCards(), whyNow: { description: "d", signalTypes: "new_location, hiring ops" } });
    expect(comma.whyNow.signalTypes).toEqual(["new_location", "hiring_ops"]);
    const lines = await cardsFrom({ ...validCards(), whyNow: { description: "d", signalTypes: "a1\nb2\nc3\nd4\ne5\nf6\ng7\nh8" } });
    expect(lines.whyNow.signalTypes).toEqual(["a1", "b2", "c3", "d4", "e5", "f6"]);
  });

  it("still errors when fewer than 2 signal types remain", async () => {
    const client = fakeClient([
      { ...validCards(), whyNow: { description: "d", signalTypes: "only_one" } },
      { ...validCards(), whyNow: { description: "d", signalTypes: [{ type: "only_one" }] } },
    ]);
    await expect(suggestCards(profileStub, { client })).rejects.toMatchObject({ errors: ["whyNow.signalTypes must have 2-6 items"] });
  });

  it("maps country names to ISO-2 and uppercases codes", async () => {
    const cards = await cardsFrom({ ...validCards(), geo: { hqCountries: ["Singapore", "united kingdom", "my", "USA"] } });
    expect(cards.geo.hqCountries).toEqual(["SG", "GB", "MY", "US"]);
    const csv = await cardsFrom({ ...validCards(), geo: { hqCountries: "Singapore, Malaysia" } });
    expect(csv.geo.hqCountries).toEqual(["SG", "MY"]);
  });

  it("parses recency.months from '6 months' and size from comma strings", async () => {
    const cards = await cardsFrom({
      ...validCards(),
      recency: { months: "6 months" },
      size: { min: "1,000", max: "5,000", unknownPolicy: "allow-if-not-enterprise" },
    });
    expect(cards.recency.months).toBe(6);
    expect(cards.size).toEqual({ min: 1000, max: 5000, unknownPolicy: "allow-if-not-enterprise" });
  });

  it("accepts who as a string, comma-string exclusions, missing rationale, and ignores extra keys", async () => {
    const { rationale: _r, ...rest } = validCards();
    const cards = await cardsFrom({
      ...rest,
      who: "independent cafes",
      exclusions: { names: "Starbucks, Costa", domains: "starbucks.com\ncosta.com" },
      surprise: { anything: true },
    });
    expect(cards.who).toEqual({ industry: "independent cafes", descriptor: "independent cafes" });
    expect(cards.exclusions).toEqual({ names: ["Starbucks", "Costa"], domains: ["starbucks.com", "costa.com"] });
    expect(cards.rationale).toEqual({});
    expect(cards).not.toHaveProperty("surprise");
  });

  it("prompt contains the example object, enums, and the no-markdown-fences instruction", async () => {
    const client = fakeClient([validCards()]);
    await suggestCards(profileStub, { client });
    const { system } = (client.messages.create.mock.calls[0] as unknown as [CreateArgs])[0];
    expect(system).toContain("Reply with one JSON object with exactly these keys; arrays of plain strings where shown; no markdown fences.");
    expect(system).toContain('"signalTypes": [');
    expect(system).toContain('"unknownPolicy": "allow-if-not-enterprise"');
    expect(system).toContain("series_b_plus");
    expect(system).toContain('"hqCountries": [');
  });

  it("retry message includes both the error list and the example object", async () => {
    const client = fakeClient([{ ...validCards(), size: { min: 5, max: 200, unknownPolicy: "maybe" } }, validCards()]);
    await suggestCards(profileStub, { client });
    const retry = (client.messages.create.mock.calls[1] as unknown as [CreateArgs])[0].messages[0]!.content;
    expect(retry).toContain("size.unknownPolicy must be allow-if-not-enterprise or reject");
    expect(retry).toContain('"signalTypes": [');
    expect(retry).toContain('"unknownPolicy": "allow-if-not-enterprise"');
  });
});

describe("compilePlan shape tolerance", () => {
  const goodQueries = ["q one", "q two", "q three", "q four", "q five"];
  const base = { signalSummaryQuery: "s", companySummaryQuery: "c" };

  it("accepts signalQueries as objects and gate required as yes/true strings", async () => {
    const client = fakeClient([{
      ...base,
      signalQueries: goodQueries.map((q, i) => (i % 2 ? { query: q } : { text: q })),
      gateFields: [
        { key: "Is Cafe", question: "Is it a cafe?", required: "yes" },
        { key: "sells_food", question: "Does it sell food?", required: "false" },
      ],
      extra: 1,
    }]);
    const { plan } = await compilePlan(validCards(), { client });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(plan.signalQueries).toEqual(goodQueries);
    expect(plan.gateFields).toEqual([
      { key: "is_cafe", question: "Is it a cafe?", required: true },
      { key: "sells_food", question: "Does it sell food?", required: false },
    ]);
  });

  it("prompt has the example and fence instruction; retry repeats errors and example", async () => {
    const client = fakeClient([
      { ...base, signalQueries: ["one"], gateFields: [] },
      { ...base, signalQueries: goodQueries, gateFields: [{ key: "is_cafe", question: "Is it a cafe?", required: true }] },
    ]);
    await compilePlan(validCards(), { client });
    const calls = client.messages.create.mock.calls as unknown as [CreateArgs][];
    expect(calls[0]![0].system).toContain("no markdown fences.");
    expect(calls[0]![0].system).toContain('"signalQueries": [');
    const retry = calls[1]![0].messages[0]!.content;
    expect(retry).toContain("signalQueries must have exactly 5 items");
    expect(retry).toContain('"gateFields": [');
  });
});

describe("compilePlan", () => {
  it("produces a validated SearchPlan and retries once after invalid output", async () => {
    const first = {
      signalQueries: ["one"],
      gateFields: [],
      signalSummaryQuery: "Summarise signal.",
      companySummaryQuery: "Summarise company.",
    };
    const second = {
      signalQueries: [
        "cafes opening new outlets",
        "cafes hiring operations manager",
        "restaurants expanding locations",
        "food service businesses launching new branches",
        "cafes upgrading payment operations",
      ],
      gateFields: [
        { key: "is_independent_cafe", question: "Is this company an independent cafe or restaurant?", required: true },
        { key: "sells_food_to_consumers", question: "Does this company sell food or drinks to consumers?", required: false },
      ],
      signalSummaryQuery: "Extract the company, signal type, event date, and concise signal summary.",
      companySummaryQuery: "Extract firmographics, HQ, employee estimate, and answer gates.",
    };
    const client = fakeClient([first, second]);
    const result = await compilePlan(validCards(), { client });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(validatePlan(result.plan).ok).toBe(true);
    expect(result.plan.months).toBe(6);
    expect(result.plan.employeeRange).toEqual(validCards().size);
    expect(result.plan.hqCountries).toEqual(["SG"]);
    expect(result.plan.excludeDomains).toEqual(["starbucks.com"]);
    expect(result.plan.signalTypes).toEqual(["new_location", "hiring_ops"]);
    expect(result.cost).toBeCloseTo(0.028, 6);
    expect(result.estimatedRunCost).toBeGreaterThan(0.3);
  });

  it("F1.11 refuses planner Claude calls above 20k input tokens before create", async () => {
    const client = {
      messages: {
        countTokens: vi.fn(async () => ({ input_tokens: 20_001 })),
        create: vi.fn(),
      },
    };
    await expect(compilePlan(validCards(), { client: client as never })).rejects.toBeInstanceOf(PlannerTokenLimitError);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("F1.11 planner routes reject oversized shapes before model work", async () => {
    const { POST } = await import("../app/api/planner/plan/route");
    const res = await POST(new Request("http://x/api/planner/plan", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.200" },
      body: JSON.stringify({ cards: { ...validCards(), who: { industry: "x".repeat(2001), descriptor: "cafes" } } }),
    }));
    expect(res.status).toBe(400);
  });

  it("F1.12 extractFirstJsonObject tries each opening brace until one parses", () => {
    expect(extractFirstJsonObject("ignore {not json} then {\"ok\":true}")).toEqual({ ok: true });
  });
});
