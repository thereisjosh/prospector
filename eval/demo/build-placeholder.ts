/**
 * Builds the PLACEHOLDER demo fixtures in eval/demo/ until a live smoke run
 * replaces them:
 *
 *   npx tsx eval/demo/build-placeholder.ts
 *
 * Planner fixtures (eval/demo/planner/*.json) are hand-written below in the
 * exact shapes the /api/planner routes return. The run (eval/demo/run/
 * state.json + events.jsonl) is a SCRIPTED agent: the turns, tool inputs, todo
 * text and strategy are written here, but every search result, company lookup
 * and source URL is a real Exa response recorded on 2026-10-11
 * (eval/recordings/icp1-*), and every accept/reject verdict comes from the real
 * gate code (checkLead) run against that data. Costs use the Exa cost
 * estimator and typical per-turn Claude costs.
 *
 * To replace with a real recording: run `eval/run-agent.ts --record <dir>` and
 * copy <dir>/agent/state.json and events.jsonl into eval/demo/run/.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { estimateExaCost } from "../../src/exa";
import { checkLead, squashName } from "../../src/gates";
import { PROMPT_VERSION } from "../../src/agent/prompts";
import type { SearchPlan } from "../../src/plan";
import type { CardSet } from "../../src/planner";
import type { SellerProfile } from "../../src/planner";
import type { CompanySummary, SignalSummary } from "../../src/types";
import { V1_PLAN_1 } from "../fixtures/v1-plans";

const ROOT = join(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "eval", "demo");
const RECORDINGS = ["icp1-2026-10-11", "icp1-2026-10-11b"].map((d) => join(ROOT, "eval", "recordings", d));
const NOW = new Date("2026-10-11T06:00:00.000Z");
const RUN_ID = "recorded-demo-run";

// ---------------------------------------------------------------- planner

const profile: SellerProfile = {
  offering: "Labor-scheduling software for warehouse teams at mid-sized third-party logistics (3PL) providers",
  buyer_type: "B2B",
  buyer_roles: ["VP of Operations", "Warehouse general manager"],
  price_band: "$1,000–5,000 per site per month",
  geo_served: ["United States", "United Kingdom"],
  competitors: [],
  existing_customers: [],
};

const cards: CardSet = {
  who: { industry: "Third-party logistics", descriptor: "Mid-sized 3PL, warehousing and fulfillment providers" },
  whyNow: {
    signalTypes: ["new_facility", "expansion", "ops_hiring_wave", "ops_hire"],
    description: "a new warehouse, an expansion, or a wave of operations hiring",
  },
  size: { min: 100, max: 1000, unknownPolicy: "allow-if-not-enterprise" },
  stage: "any",
  geo: { hqCountries: ["US", "GB"] },
  recency: { months: 3 },
  exclusions: { names: V1_PLAN_1.excludeNames.slice(0, 12), domains: [] },
  rationale: {
    who: "Scheduling pain is sharpest for 3PLs running several client accounts in one building.",
    whyNow: "A new site or a hiring wave means new shifts to staff, which is when scheduling breaks.",
    size: "Below ~100 staff a spreadsheet works; above ~1,000 they usually run an enterprise suite.",
    stage: "Funding stage matters little for logistics operators, so no filter.",
    geo: "Your site serves the US and UK.",
    recency: "Three months keeps the event fresh enough to open a conversation.",
    exclusions: "National carriers and giants already run enterprise tools.",
  },
  alternatives: [
    {
      label: "Smaller regional 3PLs",
      cards: { size: { min: 20, max: 300, unknownPolicy: "allow-if-not-enterprise" } },
    },
    {
      label: "Last-mile delivery firms",
      cards: {
        who: { industry: "Last-mile delivery", descriptor: "Regional last-mile and courier companies" },
        whyNow: { signalTypes: ["new_facility", "ops_hiring_wave"], description: "a new depot or a wave of driver and dispatch hiring" },
      },
    },
  ],
};

const plan: SearchPlan = {
  ...V1_PLAN_1,
  label: `${cards.who.descriptor} with ${cards.whyNow.description}`.slice(0, 160),
  excludeNames: cards.exclusions.names,
};

const searchCost = estimateExaCost({ query: "x", numResults: 25, contents: { summary: { query: "x" } } });
const lookupCost = estimateExaCost({ query: "x", category: "company", numResults: 2 });
const readCost = 0.002;
const estimatedRunCost = Math.round((5 * searchCost + 30 * lookupCost + 0.3) * 100) / 100;

// ---------------------------------------------------------------- recorded Exa data

type Signal = { url: string; title?: string; text?: string; publishedDate?: string; summary: SignalSummary; query: string };
const signals = new Map<string, Signal>();
const lookups = new Map<string, CompanySummary>();
for (const dir of RECORDINGS) {
  for (const file of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
    const rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      request: { query: string; category?: string };
      response: { results?: Array<{ url: string; title?: string; text?: string; publishedDate?: string; summary?: unknown }> };
    };
    for (const result of rec.response.results ?? []) {
      let summary: Record<string, unknown> | undefined;
      try {
        summary = typeof result.summary === "string" ? JSON.parse(result.summary) : (result.summary as Record<string, unknown>);
      } catch {
        continue;
      }
      if (!summary) continue;
      if (rec.request.category === "company") {
        if (!lookups.has(rec.request.query)) lookups.set(rec.request.query, summary as CompanySummary);
        break;
      }
      if (typeof summary.company_name !== "string") continue;
      const key = squashName(summary.company_name);
      if (signals.has(key)) continue;
      signals.set(key, {
        url: result.url,
        title: result.title,
        text: result.text,
        publishedDate: result.publishedDate,
        query: rec.request.query,
        summary: {
          company_name: summary.company_name,
          signal_type: String(summary.signal_type ?? ""),
          signal_summary: String(summary.signal_summary ?? ""),
          signal_date: String(summary.signal_date ?? ""),
        },
      });
    }
  }
}

function signalFor(company: string): Signal {
  const s = signals.get(squashName(company));
  if (!s) throw new Error(`no recorded signal for ${company}`);
  return s;
}
function lookupFor(company: string): CompanySummary {
  const l = lookups.get(company);
  if (!l) throw new Error(`no recorded lookup for ${company}`);
  return l;
}

// ---------------------------------------------------------------- scripted run

type Ev = Record<string, unknown> & { kind: string };
const events: Array<Record<string, unknown>> = [];
const contract = { ...plan, targetLeads: 10, maxCostDollars: 1, preferenceNotes: [] as string[] };
const initialContract = structuredClone(contract);
const leads: Array<Record<string, unknown>> = [];
const rejected: Array<{ company: string; code: string; reason: string; turn: number }> = [];
const spend = { exa: 0, claude: 0, total: 0 };
let turn = 0;
let clock = NOW.getTime();
let todo = "";

function emit(ev: Ev) {
  clock += 1500;
  events.push({ ts: new Date(clock).toISOString(), runId: RUN_ID, turn, promptVersion: PROMPT_VERSION, ...ev });
}
function modelCall(rawCost: number) {
  const claudeCost = Math.round(rawCost * 0.6 * 10000) / 10000;
  turn += 1;
  spend.claude += claudeCost;
  emit({ kind: "model_call", tokens: { input: 2400 + turn * 900, output: 600, cache_read: 9800, cache_creation: turn === 1 ? 9800 : 0 }, claudeCost, latencyMs: 6000 + turn * 400 });
}
function tool(name: string, input: unknown, exaCost = 0) {
  spend.exa += exaCost;
  if (name === "update_todo") todo = String((input as { markdown: string }).markdown);
  emit({ kind: "tool_call", tool: name, input, is_error: false, exaCost });
}
function submit(company: string, whyNow: string) {
  const signal = signalFor(company);
  const enrichment = lookupFor(company);
  tool("submit_lead", { company, signal_url: signal.url, why_now: whyNow });
  const verdict = checkLead(contract, {
    company,
    signal,
    enrichment,
    now: NOW,
    seen: new Set(),
    submitted: new Set(leads.map((l) => squashName(String(l.company)))),
  });
  if (verdict.ok) {
    leads.push({ company, signal_url: signal.url, why_now: whyNow, summary: signal.summary, enrichment, details: verdict.details, turn });
    emit({ kind: "submit_verdict", company, code: "accepted", reason: "accepted", ok: true });
  } else {
    rejected.push({ company, code: verdict.code, reason: verdict.reason, turn });
    emit({ kind: "submit_verdict", company, code: verdict.code, reason: verdict.reason, ok: false });
  }
}

const batch1 = ["Verst Logistics", "G10 Fulfillment", "A. Duie Pyle", "RGL Logistics", "Averitt"];
const batch2 = ["Diakon Logistics", "Meyer Logistics Inc.", "TSS, Inc.", "Shipbobinc"];
const batch3 = ["Davidson Logistics", "QE Dynamics LLC", "Clark Distributing Co.", "Delivery One LLC"];
const firstQueries = [
  "third-party logistics provider opening a new warehouse fulfillment center",
  "3PL fulfillment provider announced expansion new warehouse facility",
  "regional logistics provider warehouse expansion operations hiring",
];

// Turn 1: strategy, then pause.
modelCall(0.041);
const strategy = {
  angles: [
    "3PLs announcing a new warehouse or fulfillment center in the last 3 months",
    "Regional logistics firms expanding an existing site",
    "3PLs hiring several warehouse operations managers at once",
  ],
  first_queries: firstQueries,
  est_cost_dollars: 0.7,
};
emit({ kind: "approval_request", tool: "propose_strategy", input: strategy });
emit({ kind: "decision", approve: true });

// Turn 2: searches + todo.
modelCall(0.036);
tool("update_todo", {
  markdown: [
    "**Leads: 0 of 10**",
    "- [ ] Search for 3PLs opening new warehouses",
    "- [ ] Search for 3PLs expanding a site",
    "- [ ] Search for operations hiring waves",
    "- [ ] Check each candidate's size, HQ and business model",
  ].join("\n"),
});
for (const q of firstQueries) tool("search_signals", { query: q, num_results: 25 }, searchCost);

// Turn 3: lookups, skipping obvious non-fits.
modelCall(0.052);
batch1.forEach((name, i) =>
  tool("lookup_company", i === 0 ? { name, skipped_companies: ["Walmart", "Amazon", "Maersk", "SHEIN"] } : { name }, lookupCost),
);

// Turn 4: submit batch 1.
modelCall(0.058);
submit("Verst Logistics", "Opened a new Northern Kentucky excellence center in August, adding warehouse space and shifts to staff.");
submit("G10 Fulfillment", "Opened a 315,000 sq ft distribution facility in Kenosha in September.");
submit("A. Duie Pyle", "Expanded distribution capacity in central Pennsylvania this month.");
submit("RGL Logistics", "Unveiled a new warehouse in Appleton, Wisconsin in October.");
submit("Averitt", "Opened a new Mississippi warehouse in August.");
tool("update_todo", {
  markdown: [
    "**Leads: 3 of 10**",
    "- [x] New-warehouse search: 3 good fits (Verst, G10, RGL)",
    "- [x] Two turned down: one too large, one enterprise-scale",
    "- [ ] Try smaller, family-owned regional 3PLs",
    "- [ ] Try operations-hiring announcements",
  ].join("\n"),
});

// Turn 5: rewritten searches after "too large" rejections.
modelCall(0.047);
tool("search_signals", { query: "family-owned regional 3PL opens new warehouse or cross-dock", num_results: 25 }, searchCost);
tool("search_signals", { query: "3PL hiring operations manager for a new warehouse site", num_results: 25 }, searchCost);

// Turn 6: lookups batch 2.
modelCall(0.061);
batch2.forEach((name) => tool("lookup_company", { name }, lookupCost));

// Turn 7: verify an ambiguous one, then submit.
modelCall(0.066);
tool("read_page", { url: signalFor("TSS, Inc.").url }, readCost);
submit("Diakon Logistics", "Hiring a 3PL operations manager for its Fredericksburg site in September.");
submit("Meyer Logistics Inc.", "Opened a new cross-dock in Rochester, Minnesota in October.");
submit("TSS, Inc.", "Leased 380,000 sq ft of warehouse space in October.");
submit("Shipbobinc", "Hiring fulfillment operations managers across sites.");

// Turn 8: scope change request, then pause.
modelCall(0.054);
const sizeRejections = rejected.filter((r) => r.code === "size" || r.code === "enterprise").length;
const scopeChange = {
  change: { field: "employeeRange", value: { min: 100, max: 2000, unknownPolicy: "allow-if-not-enterprise" } },
  reason: "Several active 3PLs opening sites are just above 1,000 employees, which the current range turns away.",
  evidence: `${sizeRejections} of ${rejected.length} rejections were for being too large; estimates 1,707–3,560.`,
};
emit({ kind: "approval_request", tool: "request_scope_change", input: scopeChange });
emit({ kind: "decision", approve: true });
contract.employeeRange = scopeChange.change.value as SearchPlan["employeeRange"];

// Turn 9: more searches.
modelCall(0.058);
tool("update_todo", {
  markdown: [
    "**Leads: 5 of 10**",
    "- [x] New-warehouse search: Verst, G10, RGL",
    "- [x] Hiring search: Diakon, Meyer",
    "- [x] Size range widened to 100–2,000 (you approved)",
    "- [ ] Last sweep: new depots and cross-docks",
  ].join("\n"),
});
tool("search_signals", { query: "logistics company opens new warehouse in October", num_results: 25 }, searchCost);
tool("search_signals", { query: "3PL expansion new distribution center Midwest", num_results: 25 }, searchCost);

// Turn 10: lookups batch 3.
modelCall(0.071);
batch3.forEach((name) => tool("lookup_company", { name }, lookupCost));

// Turn 11: submit batch 3.
modelCall(0.074);
submit("Davidson Logistics", "Opened a new warehouse in Bridgeton, Missouri in October.");
submit("QE Dynamics LLC", "Expanding operations with new warehouse roles.");
submit("Clark Distributing Co.", "Plans a new facility at MidAmerica Airpark.");
submit("Delivery One LLC", "Hiring a last-mile operations lead.");

// Turn 12: finish with a handback.
modelCall(0.063);
const summary =
  "Found 6 of the 10 leads you asked for. New-warehouse announcements worked best; hiring posts mostly surfaced companies that were too small or outside the US and UK. Most rejections were on size, in both directions.";
const counts = new Map<string, number>();
for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
const topReasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
const handback = {
  shortfall: `${leads.length} of ${contract.targetLeads}`,
  top_reasons: topReasons.slice(0, 2),
  suggestions: [
    { field: "employeeRange", value: { min: 20, max: 2000, unknownPolicy: "allow-if-not-enterprise" }, why: "Several active regional 3PLs had fewer than 100 employees." },
    { field: "months", value: 6, why: "Most fresh announcements in the last 3 months were already checked." },
  ],
};
tool("update_todo", {
  markdown: [
    `**Leads: ${leads.length} of 10**`,
    "- [x] New-warehouse search: best source of fits",
    "- [x] Hiring search: mostly too small or outside the US/UK",
    "- [x] Size range widened to 100–2,000",
    "- [ ] Suggest: allow smaller companies, or look back 6 months",
  ].join("\n"),
});
tool("finish", { summary, handback: "6 of 10. Mostly size rejections. Try 20–2,000 employees or 6 months." });
emit({ kind: "stop", reason: "finish", status: "done" });

spend.total = spend.claude + spend.exa;
const state = {
  id: RUN_ID,
  createdAt: NOW.toISOString(),
  workspaceId: "demo",
  model: "claude-opus-5-5",
  contract,
  initialContract,
  messages: [],
  status: "done",
  stopReason: "finish",
  strategyApproved: true,
  summary,
  spend,
  counters: { turns: turn, activeMs: 0, noProgressTurns: 0, toolCalls: events.filter((e) => e.kind === "tool_call").length },
  leads,
  rejected,
  todo,
  handback,
  adaptive: { queryRewrites: 2, lookupsSkipped: 4, verificationReads: 1 },
  caches: { signalsByUrl: {}, enrichmentByName: {}, candidateCompanies: [], searchQueries: [], seenKeys: [] },
  _placeholder:
    "Scripted placeholder: real Exa data and real gate verdicts, scripted agent turns. Replace with a live recording (see eval/demo/build-placeholder.ts).",
};

// ---------------------------------------------------------------- write

mkdirSync(join(OUT, "planner"), { recursive: true });
mkdirSync(join(OUT, "run"), { recursive: true });
const write = (path: string, value: unknown) => writeFileSync(join(OUT, path), JSON.stringify(value, null, 2) + "\n", "utf8");
write("planner/profile.json", { kind: "text", profile, needsDescription: false, cost: 0 });
write("planner/profile-instagram.json", {
  kind: "candidates",
  source: "social",
  platform: "instagram",
  candidates: [
    { domain: "lanehand.example", score: 3, evidence: ["https://lanehand.example/"] },
    { domain: "lanehand-staffing.example", score: 1, evidence: ["https://lanehand-staffing.example/about"] },
  ],
});
write("planner/cards.json", { cards, cost: 0.012 });
write("planner/plan.json", { plan, cost: 0.009, estimatedRunCost });
write("run/state.json", state);
writeFileSync(join(OUT, "run", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

console.log(`leads ${leads.length}: ${leads.map((l) => l.company).join(", ")}`);
console.log(`rejected ${rejected.length}: ${rejected.map((r) => `${r.company} (${r.code})`).join(", ")}`);
console.log(`spend $${spend.total.toFixed(3)} (claude ${spend.claude.toFixed(3)}, exa ${spend.exa.toFixed(3)}), ${events.length} events, ${turn} turns`);
