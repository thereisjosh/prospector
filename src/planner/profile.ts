import { CostGuard, ExaHttpError, type ExaCredentials } from "../exa";
import { normalizeNullish } from "../plan";

export type SellerProfile = {
  origin?: string;
  offering?: string;
  buyer_type?: "B2B" | "B2C" | "both";
  buyer_roles: string[];
  price_band?: string;
  geo_served: string[];
  competitors: string[];
  existing_customers: string[];
};

export type ProfileDeps = {
  credentials?: ExaCredentials;
  guard?: CostGuard;
  fetch?: typeof fetch;
};

const SELLER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "offering",
    "buyer_type",
    "buyer_roles",
    "price_band",
    "geo_served",
    "competitors",
    "existing_customers",
  ],
  properties: {
    offering: { type: "string" },
    buyer_type: { type: "string", enum: ["B2B", "B2C", "both"] },
    buyer_roles: { type: "array", items: { type: "string" } },
    price_band: { type: "string" },
    geo_served: { type: "array", items: { type: "string" } },
    competitors: { type: "array", items: { type: "string" } },
    existing_customers: { type: "array", items: { type: "string" } },
  },
} as const;

export async function profileSeller(origin: string, deps: ProfileDeps = {}): Promise<{
  profile: SellerProfile;
  needsDescription: boolean;
  cost: number;
}> {
  const cleanOrigin = normalizeOrigin(origin);
  const urls = [
    cleanOrigin,
    `${cleanOrigin}/about`,
    `${cleanOrigin}/about-us`,
    `${cleanOrigin}/pricing`,
  ];
  const guard = deps.guard;
  const estimate = urls.length * 0.002;
  guard?.reserve(estimate);
  try {
    const json = await contentsRequest(urls, deps);
    const actual = typeof json.costDollars?.total === "number" ? json.costDollars.total : estimate;
    guard?.settle(estimate, actual);
    const profile = emptyProfile(cleanOrigin);
    for (const result of json.results ?? []) {
      mergeProfile(profile, cleanSummary(result.summary));
    }
    const needsDescription = !profile.offering;
    return { profile, needsDescription, cost: actual };
  } catch (error) {
    guard?.settle(estimate, 0);
    throw error;
  }
}

export function profileFromText(text: string): SellerProfile {
  return {
    buyer_roles: [],
    geo_served: [],
    competitors: [],
    existing_customers: [],
    offering: text.trim(),
  };
}

function normalizeOrigin(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.hostname.toLowerCase().replace(/^www\./, "")}`;
}

async function contentsRequest(urls: string[], deps: ProfileDeps): Promise<{
  results?: { summary?: unknown }[];
  costDollars?: { total?: number };
}> {
  const baseUrl = (deps.credentials?.baseUrl ?? process.env.EXA_BASE_URL ?? "https://api.exa.ai").replace(/\/$/, "");
  const apiKey = deps.credentials?.apiKey ?? process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is required");
  const response = await (deps.fetch ?? fetch)(`${baseUrl}/contents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      urls,
      livecrawl: "fallback",
      summary: {
        query: "Describe this seller: offering, buyer type, buyer roles, price band, geographies served, competitors, and existing customers.",
        schema: SELLER_SCHEMA,
      },
    }),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as { results?: { summary?: unknown }[]; costDollars?: { total?: number } } : {};
  if (!response.ok) throw new ExaHttpError(response.status, text);
  return json;
}

function emptyProfile(origin: string): SellerProfile {
  return {
    origin,
    buyer_roles: [],
    geo_served: [],
    competitors: [],
    existing_customers: [],
  };
}

function mergeProfile(profile: SellerProfile, incoming: Partial<SellerProfile>): void {
  profile.offering ??= incoming.offering;
  profile.buyer_type ??= incoming.buyer_type;
  profile.price_band ??= incoming.price_band;
  profile.buyer_roles = union(profile.buyer_roles, incoming.buyer_roles);
  profile.geo_served = union(profile.geo_served, incoming.geo_served);
  profile.competitors = union(profile.competitors, incoming.competitors);
  profile.existing_customers = union(profile.existing_customers, incoming.existing_customers);
}

function cleanSummary(summary: unknown): Partial<SellerProfile> {
  const raw = typeof summary === "string" ? parseJson(summary) : summary;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const buyerType = normalizeNullish(rec.buyer_type);
  return {
    offering: stringField(rec.offering),
    buyer_type: buyerType === "B2B" || buyerType === "B2C" || buyerType === "both" ? buyerType : undefined,
    buyer_roles: arrayField(rec.buyer_roles),
    price_band: stringField(rec.price_band),
    geo_served: arrayField(rec.geo_served),
    competitors: arrayField(rec.competitors),
    existing_customers: arrayField(rec.existing_customers),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  const cleaned = normalizeNullish(value);
  return typeof cleaned === "string" ? cleaned : undefined;
}

function arrayField(value: unknown): string[] {
  const cleaned = normalizeNullish(value);
  return Array.isArray(cleaned) ? cleaned.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function union(a: string[], b: string[] | undefined): string[] {
  const seen = new Set(a.map((item) => item.toLowerCase()));
  const out = [...a];
  for (const item of b ?? []) {
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out;
}
