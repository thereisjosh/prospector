import probe from "./probe-v2-results.json";
import { describe, expect, it, vi } from "vitest";
import { validatePlan } from "../src/plan";
import { CostGuard } from "../src/exa";
import { classifyInput, compilePlan, profileSeller, resolveInstagram, suggestCards, type CardSet } from "../src/planner";

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
    expect(classifyInput("@lovebonito")).toEqual({ kind: "instagram", value: "lovebonito" });
    expect(classifyInput("instagram.com/hitpay.sg")).toEqual({ kind: "instagram", value: "hitpay.sg" });
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
    await expect(resolveInstagram("lovebonito", { exaSearch: exaSearch as never })).resolves.toMatchObject({
      candidates: [{ domain: "lovebonito.com" }],
    });
    const hitpay = await resolveInstagram("hitpaysg", { exaSearch: exaSearch as never });
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
});
