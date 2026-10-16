import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartStep, type StartStepProps } from "../app/ui/StartStep";
import { BudgetExceededError, CostGuard } from "../src/exa";
import {
  BIOLINK_HOSTS, classifyInput, MAPS_HOSTS, MARKETPLACE_HOSTS, ProfileTargetError, profileSeller, profileTarget,
  countryFromLocale, resolveToSite, SOCIAL_HOSTS,
} from "../src/planner";

const FB = "https://www.facebook.com/SASairconditioning/";

describe("classifyInput: one case per input shape", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["the exact facebook page that was profiled as facebook.com", FB, { kind: "social", platform: "facebook", handle: "SASairconditioning" }],
    ["bare @handle", "@acmecoffee", { kind: "social", platform: "instagram", handle: "acmecoffee" }],
    ["instagram url", "instagram.com/hitpay.sg", { kind: "social", platform: "instagram", handle: "hitpay.sg" }],
    ["tiktok", "https://www.tiktok.com/@acme.co", { kind: "social", platform: "tiktok", handle: "acme.co" }],
    ["x", "x.com/acme", { kind: "social", platform: "x", handle: "acme" }],
    ["twitter", "https://twitter.com/acme", { kind: "social", platform: "x", handle: "acme" }],
    ["youtube @", "youtube.com/@acme", { kind: "social", platform: "youtube", handle: "acme" }],
    ["youtube /c/", "https://www.youtube.com/c/AcmeTV", { kind: "social", platform: "youtube", handle: "AcmeTV" }],
    ["linkedin company", "https://www.linkedin.com/company/acme-logistics/", { kind: "social", platform: "linkedin", handle: "acme-logistics" }],
    ["threads", "threads.net/@acme", { kind: "social", platform: "threads", handle: "acme" }],
    ["social url with no handle", "https://www.facebook.com/profile.php?id=123", { kind: "social", platform: "facebook", handle: undefined }],
    ["linktree", "https://linktr.ee/acme", { kind: "biolink", platform: "linktr.ee", handle: "acme" }],
    ["beacons", "beacons.ai/acme", { kind: "biolink", platform: "beacons.ai", handle: "acme" }],
    ["shopee shop", "https://shopee.sg/acme_official", { kind: "marketplace", platform: "shopee" }],
    ["lazada shop", "https://www.lazada.sg/shop/acme/", { kind: "marketplace", platform: "lazada" }],
    ["etsy shop", "etsy.com/shop/AcmeCo", { kind: "marketplace", platform: "etsy" }],
    ["myshopify", "https://acme.myshopify.com/collections/all", { kind: "marketplace", platform: "shopify" }],
    ["marketplace home", "shopee.sg", { kind: "unusable", reason: "marketplace_home" }],
    ["g.page", "https://g.page/sas-airconditioning", { kind: "maps", name: "sas airconditioning" }],
    ["google maps q=", "https://maps.google.com/?q=SAS+Airconditioning+Singapore", { kind: "maps", name: "SAS Airconditioning Singapore" }],
    ["google.com/maps/place", "https://www.google.com/maps/place/SAS+Airconditioning/@1.3,103.8,17z", { kind: "maps", name: "SAS Airconditioning" }],
    ["opaque maps short link", "https://maps.app.goo.gl/AbC123", { kind: "maps", name: undefined }],
    ["yelp", "https://www.yelp.com/biz/sas-airconditioning-singapore-2", { kind: "maps", name: "sas airconditioning singapore" }],
    ["title-case name", "SAS Airconditioning", { kind: "name" }],
    ["name with corporate suffix", "Acme Logistics Pte Ltd", { kind: "name" }],
    ["lowercase name with suffix is not a name", "acme logistics pte ltd", { kind: "text" }],
    ["sentence", "We sell payment terminals to cafes in Singapore", { kind: "text" }],
    ["title-case sentence with a verb", "We Sell Payment Terminals", { kind: "text" }],
    ["wa.me", "https://wa.me/6591234567", { kind: "unusable", reason: "contact_link" }],
    ["mailto", "mailto:hello@acme.com", { kind: "unusable", reason: "contact_link" }],
    ["tel", "tel:+6591234567", { kind: "unusable", reason: "contact_link" }],
    ["bare email", "hello@acme.com", { kind: "unusable", reason: "contact_link" }],
    ["phone number", "+65 9123 4567", { kind: "unusable", reason: "contact_link" }],
    ["website", "acme.com", { kind: "url" }],
    ["website with a product path", "https://acme.com/products/x", { kind: "url" }],
    ["carrd page is the seller's site", "https://acme.carrd.co", { kind: "url" }],
    ["pop.site page is the seller's site", "https://acme.pop.site/", { kind: "url" }],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => expect(classifyInput(input)).toMatchObject(expected));
  }
  it("asName forces a name whatever the casing", () => {
    expect(classifyInput("sas airconditioning", { asName: true })).toEqual({ kind: "name", value: "sas airconditioning" });
  });
});

function search(urls: string[]) {
  return vi.fn(async (_body: { query: string; numResults: number }) => ({ results: urls.map((url) => ({ url })) }));
}

describe("resolveToSite", () => {
  it("facebook page: query carries facebook.com/<handle>, social/marketplace/maps hosts never become candidates", async () => {
    const exa = search([
      "https://www.facebook.com/SASairconditioning/",
      "https://www.instagram.com/sasairconditioning/",
      "https://www.yelp.com/biz/sas-airconditioning-singapore",
      "https://shopee.sg/sas_aircon",
      "https://sasairconditioning.com.sg/about",
    ]);
    const out = await resolveToSite(classifyInput(FB), { exaSearch: exa as never });
    expect(exa).toHaveBeenCalledTimes(1);
    const body = exa.mock.calls[0]![0];
    expect(body.query).toContain("facebook.com/SASairconditioning");
    expect(body.query).toContain("official website");
    expect(body.numResults).toBe(10);
    expect(out).toMatchObject({ source: "social", platform: "facebook" });
    expect(out.candidates.map((c) => c.domain)).toEqual(["sasairconditioning.com.sg"]);
  });

  it("social URL with no readable handle asks for the name without searching", async () => {
    const exa = search([]);
    const out = await resolveToSite(classifyInput("https://www.facebook.com/profile.php?id=123"), { exaSearch: exa as never });
    expect(out).toEqual({ source: "social", platform: "facebook", candidates: [], askName: true });
    expect(exa).not.toHaveBeenCalled();
  });

  it("bio link: extracts outbound links, drops social links, first domain leads, max 3", async () => {
    const post = vi.fn(async () => ({
      results: [{ text: [
        "# Acme", "[Instagram](https://instagram.com/acme)", "[WhatsApp](https://wa.me/6591234567)",
        "[Shop](https://www.acmecoffee.com/shop)", "[Menu](https://acmecoffee.com/menu)", "[Shopee](https://shopee.sg/acme)",
        "[Blog](https://blog.acme.io/post)", "https://linktr.ee/other", "[Four](https://fourth.example/)", "[Fifth](https://fifth.example/)",
      ].join("\n") }],
    }));
    const exa = search([]);
    const out = await resolveToSite(classifyInput("https://linktr.ee/acme"), { exaPost: post as never, exaSearch: exa as never });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(expect.arrayContaining(["/contents"]));
    expect(out).toMatchObject({ source: "biolink", platform: "linktr.ee" });
    expect(out.candidates.map((c) => c.domain)).toEqual(["acmecoffee.com", "blog.acme.io", "fourth.example"]);
    expect(exa).not.toHaveBeenCalled();
  });

  it("bio link with no outbound site falls back to one social-style search on the bio handle", async () => {
    const post = vi.fn(async () => ({ results: [{ text: "[IG](https://instagram.com/acme) [WA](https://wa.me/65912)" }] }));
    const exa = search(["https://acmecoffee.com/"]);
    const out = await resolveToSite(classifyInput("linktr.ee/acme"), { exaPost: post as never, exaSearch: exa as never });
    expect(exa).toHaveBeenCalledTimes(1);
    expect(exa.mock.calls[0]![0].query).toBe("linktr.ee/acme official website");
    expect(out.candidates.map((c) => c.domain)).toEqual(["acmecoffee.com"]);
  });

  it("maps: name from g.page and from q=, search is '<name> official website'", async () => {
    const exa = search(["https://www.google.com/maps/place/x", "https://sasairconditioning.com.sg/", "https://www.tripadvisor.com/Restaurant_Review-g1-d2-Reviews-X.html"]);
    const g = await resolveToSite(classifyInput("https://g.page/sas-airconditioning"), { exaSearch: exa as never });
    expect(exa.mock.calls[0]![0].query).toBe("sas airconditioning official website");
    expect(g).toMatchObject({ source: "maps" });
    expect(g.candidates.map((c) => c.domain)).toEqual(["sasairconditioning.com.sg"]);
    await resolveToSite(classifyInput("https://maps.google.com/?q=SAS+Airconditioning"), { exaSearch: exa as never });
    expect(exa.mock.calls[1]![0].query).toBe("SAS Airconditioning official website");
  });

  it("maps link with no extractable name asks for the name and does not search", async () => {
    const exa = search([]);
    const out = await resolveToSite(classifyInput("https://maps.app.goo.gl/AbC123"), { exaSearch: exa as never });
    expect(out).toEqual({ source: "maps", candidates: [], askName: true });
    expect(exa).not.toHaveBeenCalled();
  });

  it("bare company name: one search, candidates scored by name overlap", async () => {
    const exa = search(["https://other-hvac.com/", "https://sasairconditioning.com.sg/"]);
    const out = await resolveToSite(classifyInput("SAS Airconditioning"), { exaSearch: exa as never });
    expect(exa).toHaveBeenCalledTimes(1);
    expect(exa.mock.calls[0]![0].query).toBe("SAS Airconditioning official website");
    expect(out.source).toBe("name");
    expect(out.candidates[0]!.domain).toBe("sasairconditioning.com.sg");
  });

  it("the route's CostGuard still governs: a search past the cap throws before any request", async () => {
    await expect(resolveToSite(classifyInput("SAS Airconditioning"), { guard: new CostGuard(0.001), credentials: { apiKey: "x" } })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("exports the host lists with the platforms from the brief", () => {
    expect(SOCIAL_HOSTS).toEqual(expect.arrayContaining(["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "youtube.com", "linkedin.com", "threads.net"]));
    expect(MARKETPLACE_HOSTS).toEqual(expect.arrayContaining(["shopee.sg", "lazada.sg", "carousell.sg", "etsy.com", "amazon.com", "tokopedia.com"]));
    expect(MAPS_HOSTS).toEqual(expect.arrayContaining(["g.page", "maps.app.goo.gl", "yelp.com", "tripadvisor.com"]));
    expect(BIOLINK_HOSTS).toEqual(expect.arrayContaining(["linktr.ee", "beacons.ai", "bio.site", "lnk.bio"]));
  });
});

describe("locale hint: country mapping, query, ranking", () => {
  it("maps the region subtag to a country name; unknown or missing region gives none", () => {
    expect(countryFromLocale("en-SG")).toBe("Singapore");
    expect(countryFromLocale("en_gb")).toBe("United Kingdom");
    expect(countryFromLocale("zh-Hans-MY")).toBe("Malaysia");
    expect(countryFromLocale("en-US")).toBe("United States");
    expect(countryFromLocale("en")).toBeUndefined();
    expect(countryFromLocale("en-ZZ")).toBeUndefined();
    expect(countryFromLocale("")).toBeUndefined();
    expect(countryFromLocale(null)).toBeUndefined();
  });

  it("appends the country to the query; no hint leaves the query unchanged", async () => {
    const exa = search(["https://acme.com/"]);
    await resolveToSite(classifyInput(FB), { exaSearch: exa as never, countryHint: "Singapore" });
    await resolveToSite(classifyInput(FB), { exaSearch: exa as never });
    expect(exa.mock.calls[0]![0].query).toBe("facebook.com/SASairconditioning official website Singapore");
    expect(exa.mock.calls[1]![0].query).toBe("facebook.com/SASairconditioning official website");
  });

  it("TLD bonus ranks .sg above .co.uk for an SG locale with equal base scores; never filters", async () => {
    const urls = ["https://sasaircon.co.uk/", "https://sasaircon.com.sg/"];
    const sg = await resolveToSite(classifyInput(FB), { exaSearch: search(urls) as never, countryHint: "Singapore" });
    expect(sg.candidates.map((c) => c.domain)).toEqual(["sasaircon.com.sg", "sasaircon.co.uk"]);
    const gb = await resolveToSite(classifyInput(FB), { exaSearch: search(urls) as never, countryHint: "United Kingdom" });
    expect(gb.candidates.map((c) => c.domain)).toEqual(["sasaircon.co.uk", "sasaircon.com.sg"]);
  });

  it("a title or snippet that mentions the country adds one point", async () => {
    const exa = vi.fn(async () => ({ results: [
      { url: "https://zzz-aircon.com/", title: "ZZZ Aircon" },
      { url: "https://aaa-aircon.com/", title: "Aircon servicing in Singapore" },
    ] }));
    const out = await resolveToSite(classifyInput("Zeta Cooling"), { exaSearch: exa as never, countryHint: "Singapore" });
    expect(out.candidates.map((c) => c.domain)).toEqual(["aaa-aircon.com", "zzz-aircon.com"]);
    expect(out.candidates[0]!.score - out.candidates[1]!.score).toBe(1);
  });

  it("returns up to 3 candidates", async () => {
    const exa = search(["https://a.com/", "https://b.com/", "https://c.com/", "https://d.com/", "https://www.facebook.com/x"]);
    const out = await resolveToSite(classifyInput(FB), { exaSearch: exa as never });
    expect(out.candidates).toHaveLength(3);
  });
});

describe("profileTarget (FAILURES #27 regression)", () => {
  it("never collapses a social, bio-link, maps, name or contact input to its host", () => {
    for (const input of [FB, "@acme", "linktr.ee/acme", "https://g.page/acme", "SAS Airconditioning", "wa.me/65912345", "we sell x"]) {
      expect(() => profileTarget(input), input).toThrow(ProfileTargetError);
    }
  });

  it("website: origin plus about pages, path dropped", () => {
    expect(profileTarget("https://www.Acme.com/products/x")).toMatchObject({
      origin: "https://acme.com",
      urls: ["https://acme.com", "https://acme.com/about", "https://acme.com/about-us", "https://acme.com/pricing"],
    });
    expect(profileTarget("acme.com").urls[0]).toBe("https://acme.com");
  });

  it("carrd / pop.site pages are profiled directly with the full URL", () => {
    expect(profileTarget("https://acme.carrd.co/").urls).toEqual(["https://acme.carrd.co/"]);
    expect(profileTarget("https://acme.pop.site/shop").urls).toEqual(["https://acme.pop.site/shop"]);
  });

  it("marketplace storefront keeps its path and sets the channel", () => {
    expect(profileTarget("https://shopee.sg/acme_official")).toEqual({
      urls: ["https://shopee.sg/acme_official"], origin: "https://shopee.sg/acme_official", channel: "marketplace:shopee",
    });
  });

  it("profileSeller on a storefront fetches the storefront URL, sets profile.channel, and asks about the seller not the marketplace", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => new Response(JSON.stringify({
      results: [{ summary: { offering: "Handmade candles", buyer_type: "B2C", buyer_roles: [], price_band: "low", geo_served: ["SG"], competitors: [], existing_customers: [] } }],
      costDollars: { total: 0.001 },
    }), { status: 200 }));
    const out = await profileSeller("https://shopee.sg/acme_official", { fetch: fetchMock as never, credentials: { apiKey: "t" }, guard: new CostGuard(0.1) });
    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { urls: string[]; summary: { query: string } };
    expect(sent.urls).toEqual(["https://shopee.sg/acme_official"]);
    expect(sent.summary.query).toMatch(/storefront listing on shopee, a marketplace.*not the marketplace/s);
    expect(out.profile).toMatchObject({ channel: "marketplace:shopee", origin: "https://shopee.sg/acme_official", offering: "Handmade candles" });
  });
});

describe("POST /api/planner/profile response shapes", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.doUnmock("../src/planner");
    vi.resetModules();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  async function route(live: boolean, mocks: { resolveToSite?: unknown; profileSeller?: unknown } = {}) {
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), "planner-route-"));
    roots.push(root);
    process.env.DATA_DIR = root;
    delete process.env.RUNS_DIR;
    delete process.env.WORKSPACES_DIR;
    delete process.env.NEXT_PUBLIC_DEMO;
    delete process.env.LIVE_MODE;
    if (live) {
      delete process.env.DEMO_MODE;
      process.env.ANTHROPIC_API_KEY = "a";
      process.env.EXA_API_KEY = "e";
      process.env.DAILY_SPEND_CAP_DOLLARS = "10";
    } else {
      process.env.DEMO_MODE = "1";
    }
    vi.doMock("../src/planner", async (orig) => ({ ...(await orig<typeof import("../src/planner")>()), ...mocks }));
    return (await import("../app/api/planner/profile/route")).POST;
  }
  const req = (body: unknown) => new Request("http://x/api/planner/profile", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() }, body: JSON.stringify(body),
  });

  it("candidates: unified shape for social, bio link, maps and name; guard is CostGuard(0.10)", async () => {
    const seen: unknown[] = [];
    const resolve = vi.fn(async (c: { kind: string }, deps: { guard: CostGuard }) => {
      seen.push(deps.guard);
      if (c.kind === "maps") return { source: "maps", candidates: [], askName: true };
      return { source: c.kind, platform: c.kind === "social" ? "facebook" : undefined, candidates: [{ domain: "sasairconditioning.com.sg", score: 3, evidence: ["https://sasairconditioning.com.sg/"] }] };
    });
    const POST = await route(true, { resolveToSite: resolve });
    const fb = await (await POST(req({ workspaceId: "w1", input: FB }))).json();
    expect(fb).toEqual({ kind: "candidates", source: "social", platform: "facebook", candidates: [{ domain: "sasairconditioning.com.sg", score: 3, evidence: ["https://sasairconditioning.com.sg/"] }] });
    expect(await (await POST(req({ workspaceId: "w1", input: "SAS Airconditioning" }))).json()).toMatchObject({ kind: "candidates", source: "name" });
    expect(await (await POST(req({ workspaceId: "w1", input: "https://maps.app.goo.gl/x" }))).json()).toEqual({ kind: "candidates", source: "maps", candidates: [], askName: true });
    expect(await (await POST(req({ workspaceId: "w1", input: "sas airconditioning", asName: true }))).json()).toMatchObject({ kind: "candidates", source: "name" });
    expect((seen[0] as CostGuard).capDollars).toBe(0.10);
  });

  it("url, marketplace: direct profile shape under a CostGuard(0.10)", async () => {
    const guards: CostGuard[] = [];
    const profileSeller = vi.fn(async (_i: string, deps: { guard: CostGuard }) => {
      guards.push(deps.guard);
      return { profile: { buyer_roles: [], geo_served: [], competitors: [], existing_customers: [], offering: "x" }, needsDescription: false, cost: 0.002 };
    });
    const POST = await route(true, { profileSeller });
    for (const input of ["acme.com", "https://shopee.sg/acme_official"]) {
      expect(await (await POST(req({ workspaceId: "w2", input }))).json()).toMatchObject({ kind: "url", needsDescription: false, profile: { offering: "x" } });
    }
    expect(guards.map((g) => g.capDollars)).toEqual([0.10, 0.10]);
  });

  it("the route reads x-locale and passes countryHint; no header passes none", async () => {
    const resolve = vi.fn(async () => ({ source: "social", platform: "facebook", candidates: [] }));
    const POST = await route(true, { resolveToSite: resolve });
    const withLocale = (locale?: string) => new Request("http://x/api/planner/profile", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID(), ...(locale ? { "x-locale": locale } : {}) },
      body: JSON.stringify({ workspaceId: "w9", input: FB }),
    });
    await POST(withLocale("en-SG"));
    await POST(withLocale());
    await POST(withLocale("en-ZZ"));
    const hints = resolve.mock.calls.map((c) => (c as unknown as [unknown, { countryHint?: string }])[1].countryHint);
    expect(hints).toEqual(["Singapore", undefined, undefined]);
  });

  it("unusable and text", async () => {
    const POST = await route(true);
    expect(await (await POST(req({ workspaceId: "w3", input: "https://wa.me/6591234567" }))).json()).toEqual({ kind: "unusable", reason: "contact_link" });
    expect(await (await POST(req({ workspaceId: "w3", input: "We sell X to Y" }))).json()).toMatchObject({ kind: "text", profile: { offering: "We sell X to Y" } });
  });

  it("the daily cap and allowance still apply before any resolve", async () => {
    const resolve = vi.fn();
    const POST = await route(true, { resolveToSite: resolve });
    process.env.DAILY_SPEND_CAP_DOLLARS = "0.01";
    const { addDailySpend } = await import("../app/api/_shared");
    await addDailySpend(0.02);
    expect((await POST(req({ workspaceId: "w4", input: FB }))).status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("demo mode returns the recorded fixtures, relabelled with the real source", async () => {
    const POST = await route(false);
    const fb = await (await POST(req({ input: FB }))).json();
    expect(fb).toMatchObject({ kind: "candidates", source: "social", platform: "facebook" });
    expect(fb.candidates.length).toBeGreaterThan(0);
    expect(await (await POST(req({ input: "SAS Airconditioning" }))).json()).toMatchObject({ kind: "candidates", source: "name" });
    expect(await (await POST(req({ input: "acme.com" }))).json()).toMatchObject({ kind: "text", needsDescription: false });
  });
});

describe("Describe UI: candidate heading names the platform", () => {
  const noop = () => undefined;
  const start = (over: Partial<StartStepProps>) => renderToStaticMarkup(h(StartStep, {
    demo: false, input: FB, setInput: noop, busy: false, error: "", candidates: null, askDescription: false, description: "",
    setDescription: noop, profile: null, setProfile: noop, editing: false, setEditing: noop, onSubmit: noop, onPickCandidate: noop,
    onDescribeInstead: noop, onDescribe: noop, onContinue: noop, ...over,
  } as StartStepProps));

  it("facebook candidates", () => {
    const html = start({ candidates: [{ domain: "sasairconditioning.com.sg", score: 3, evidence: [] }], candidateSource: { source: "social", platform: "facebook" } });
    expect(html).toContain("Is this your website?");
    expect(html).toContain("We found it from your Facebook page.");
    expect(html).toMatch(/>sasairconditioning\.com\.sg<\/button>/);
  });
  it("shows up to 3 candidates with one evidence URL each, and None of these", () => {
    const html = start({ candidates: [
      { domain: "a.com.sg", score: 3, evidence: ["https://a.com.sg/about", "https://a.com.sg/x"] },
      { domain: "b.com", score: 2, evidence: ["https://b.com/"] },
      { domain: "c.com", score: 1, evidence: ["https://c.com/"] },
      { domain: "d.com", score: 1, evidence: ["https://d.com/"] },
    ], candidateSource: { source: "social", platform: "facebook" } });
    expect(html).toContain("https://a.com.sg/about");
    expect(html).not.toContain("https://a.com.sg/x");
    expect(html).toContain(">c.com</button>");
    expect(html).not.toContain("d.com");
    expect(html).toContain("None of these");
  });
  it("no candidates says we could not find a website for that page", () => {
    expect(start({ candidates: [], candidateSource: { source: "social", platform: "facebook" } })).toContain("We couldn&#x27;t find a website for that page.");
  });
  it("maps, name and bio link name their source", () => {
    expect(start({ candidates: [], candidateSource: { source: "maps" } })).toContain("We found it from your map link.");
    expect(start({ candidates: [], candidateSource: { source: "name" } })).toContain("We found it from the name you gave.");
    expect(start({ candidates: [], candidateSource: { source: "biolink", platform: "linktr.ee" } })).toContain("We found it from your Linktree.");
  });
  it("a map link with no name asks for it with the specified copy", () => {
    const html = start({ candidates: [], candidateSource: { source: "maps" }, askName: true });
    expect(html).toContain("That&#x27;s a map link. What&#x27;s the business called?");
    expect(html).toContain('id="name-input"');
  });
});
