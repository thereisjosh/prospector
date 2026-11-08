import { mkdir, readFile, writeFile } from "node:fs/promises";

const API_BASE = "https://api.exa.ai";
const RESULTS_PATH = "eval/probe-v2-results.json";
const BLOCKED_DOMAINS = new Set([
  "instagram.com",
  "facebook.com",
  "linktr.ee",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
]);

function parseDotEnv(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }

  return env;
}

async function loadEnv() {
  const text = await readFile(".env", "utf8");
  return parseDotEnv(text);
}

function sumNumericLeaves(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumNumericLeaves(item), 0);
  return Object.values(value).reduce((sum, item) => sum + sumNumericLeaves(item), 0);
}

function costFromResponse(value) {
  const cost = value?.costDollars;
  if (!cost || typeof cost !== "object") return 0;
  if (typeof cost.total === "number" && Number.isFinite(cost.total)) return cost.total;
  return sumNumericLeaves(cost);
}

function estimateCost(path, body) {
  if (path === "/search") {
    const numResults = Number(body?.numResults ?? 10);
    return body?.contents ? 0.007 + 0.002 * numResults : 0.007;
  }
  if (path === "/contents") {
    return 0.003 * (Array.isArray(body?.urls) ? body.urls.length : 0);
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactBody(body) {
  if (typeof body === "string") return body.slice(0, 300);
  return JSON.stringify(body).slice(0, 300);
}

function parsePossibleJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllowedOwnedDomain(hostname) {
  if (!hostname) return false;
  return ![...BLOCKED_DOMAINS].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function extractResults(response) {
  return Array.isArray(response?.results) ? response.results : [];
}

function summaryOfResult(result) {
  return parsePossibleJson(result?.summary);
}

function firstText(result) {
  return String(result?.text ?? "").slice(0, 400);
}

function makeProbeRecorder({ apiKey, capUsd, probes, getSpent, addSpent }) {
  return async function post(id, path, body, summarize) {
    const estimate = estimateCost(path, body);
    const request = { path, body, estimatedCostUsd: estimate };

    if (getSpent() + estimate > capUsd) {
      const entry = {
        id,
        request,
        status: "skipped",
        costUsd: 0,
        result: { skipped: "budget" },
      };
      probes.push(entry);
      console.log(`${id}: skipped budget estimate=${estimate.toFixed(4)} spent=${getSpent().toFixed(4)}/${capUsd.toFixed(4)}`);
      return entry;
    }

    let response;
    let text = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });
      text = await response.text();
      if (response.status !== 429 || attempt === 1) break;
      await sleep(1500);
    }

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const entry = {
        id,
        request,
        status: response.status,
        costUsd: 0,
        result: { status: response.status, body: compactBody(parsed ?? text) },
      };
      probes.push(entry);
      console.log(`${id}: HTTP ${response.status} spent=${getSpent().toFixed(4)}/${capUsd.toFixed(4)}`);
      return entry;
    }

    const costUsd = costFromResponse(parsed);
    addSpent(costUsd);

    let result;
    try {
      result = summarize ? summarize(parsed) : parsed;
    } catch (error) {
      result = { summarizeError: error instanceof Error ? error.message : String(error) };
    }

    const entry = {
      id,
      request,
      status: response.status,
      costUsd,
      result,
    };
    probes.push(entry);
    console.log(`${id}: HTTP ${response.status} cost=${costUsd.toFixed(4)} spent=${getSpent().toFixed(4)}/${capUsd.toFixed(4)}`);
    return entry;
  };
}

const SELLER = {
  type: "object",
  additionalProperties: false,
  required: ["offering", "buyer_type", "buyer_roles", "price_band", "geo_served", "competitors"],
  properties: {
    offering: { type: "string" },
    buyer_type: { type: "string", enum: ["B2B", "B2C", "both"] },
    buyer_roles: { type: "array", items: { type: "string" } },
    price_band: { type: "string" },
    geo_served: { type: "array", items: { type: "string" } },
    competitors: { type: "array", items: { type: "string" } },
  },
};

function makeGeneratedSchema() {
  const gateB2BSaas = "gate_is_b2b_saas";
  const gateSea = "gate_based_in_southeast_asia";
  return {
    type: "object",
    additionalProperties: false,
    required: ["company_name", "signal_type", "signal_summary", "signal_date", gateB2BSaas, gateSea],
    properties: {
      company_name: { type: "string" },
      signal_type: { type: "string" },
      signal_summary: { type: "string" },
      signal_date: { type: "string" },
      [gateB2BSaas]: { type: "boolean" },
      [gateSea]: { type: "boolean" },
    },
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const env = await loadEnv();
  const apiKey = env.EXA_API_KEY;
  if (!apiKey) throw new Error("Missing EXA_API_KEY in ./.env");

  const capUsd = Number(process.env.PROBE_CAP ?? 0.3);
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error("PROBE_CAP must be a non-negative number");

  let spent = 0;
  const probes = [];
  const post = makeProbeRecorder({
    apiKey,
    capUsd,
    probes,
    getSpent: () => spent,
    addSpent: (cost) => {
      spent += cost;
    },
  });

  const sellerUrls = ["https://hitpay.com", "https://www.lovebonito.com", "https://thesmartlocal.com"];
  for (const url of sellerUrls) {
    await post(
      `A1 seller profile ${url}`,
      "/contents",
      {
        urls: [url],
        livecrawl: "fallback",
        summary: {
          query: "Describe this business as a seller: what it offers, who buys it, and where",
          schema: SELLER,
        },
      },
      (response) => ({
        url,
        summary: summaryOfResult(extractResults(response)[0]),
        statuses: response?.statuses,
      }),
    );
  }

  const startPublishedDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  await post(
    "A2 generated schema",
    "/search",
    {
      query: "Southeast Asian B2B SaaS startup raised Series A funding",
      startPublishedDate,
      numResults: 3,
      contents: {
        summary: {
          query: "The company named, the why-now signal and its date; whether the company is a B2B SaaS business; whether it is headquartered in Southeast Asia",
          schema: makeGeneratedSchema(),
        },
      },
    },
    (response) => ({
      results: extractResults(response).map((result) => {
        const summary = summaryOfResult(result);
        return {
          url: result.url,
          publishedDate: result.publishedDate,
          summary,
          gateFieldsAreBooleans:
            typeof summary?.gate_is_b2b_saas === "boolean" &&
            typeof summary?.gate_based_in_southeast_asia === "boolean",
        };
      }),
    }),
  );

  for (const handle of ["lovebonito", "thesmartlocal", "hitpaysg"]) {
    await post(
      `A3 instagram resolution ${handle}`,
      "/search",
      {
        query: `instagram.com/${handle} official website`,
        numResults: 5,
      },
      (response) => {
        const urls = extractResults(response).map((result) => result.url).filter(Boolean);
        const ownedDomainCandidates = [
          ...new Set(urls.map(getHost).filter(isAllowedOwnedDomain)),
        ];
        return { urls, ownedDomainCandidates };
      },
    );
  }

  const facebookGroupUrls = [];
  for (const query of [
    "Singapore small business owners group",
    "looking for logistics 3PL recommendation Singapore group",
  ]) {
    await post(
      `FB search ${query}`,
      "/search",
      {
        query,
        includeDomains: ["facebook.com"],
        numResults: 5,
      },
      (response) => {
        const rows = extractResults(response).map((result) => ({
          url: result.url,
          publishedDate: result.publishedDate,
        }));
        for (const row of rows) {
          if (facebookGroupUrls.length < 2 && row.url?.includes("/groups/")) {
            facebookGroupUrls.push(row.url);
          }
        }
        return { results: rows };
      },
    );
  }

  if (facebookGroupUrls.length) {
    await post(
      "FB contents groups",
      "/contents",
      {
        urls: facebookGroupUrls.slice(0, 2),
        text: { maxCharacters: 400 },
        livecrawl: "never",
      },
      (response) => ({
        statuses: response?.statuses,
        results: extractResults(response).map((result) => ({
          url: result.url,
          text: firstText(result),
        })),
      }),
    );
  } else {
    const entry = {
      id: "FB contents groups",
      request: {
        path: "/contents",
        body: { urls: [], text: { maxCharacters: 400 }, livecrawl: "never" },
        estimatedCostUsd: 0,
      },
      status: "skipped",
      costUsd: 0,
      result: { skipped: "no_group_urls" },
    };
    probes.push(entry);
    console.log("FB contents groups: skipped no_group_urls");
  }

  const output = {
    startedAt,
    capUsd,
    spentUsd: spent,
    probes,
  };

  await mkdir("eval", { recursive: true });
  await writeFile(RESULTS_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`spent ${spent.toFixed(4)} / cap ${capUsd.toFixed(4)}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
