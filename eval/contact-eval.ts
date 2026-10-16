/**
 * Contact eval, step 2 of docs/RESEARCH-contacts-and-graph.md §6: how precise are the contacts `findContacts` returns?
 *
 *   npx tsx eval/contact-eval.ts --set contact-eval-2026-10-16 --max-exa-dollars 1.00 [--judge-limit N] [--dry-run]
 *
 * Company set: every distinct company judged GOOD in eval/truth/S1 and S2 (lead = company + signal_url), with its company
 * URL taken from a recorded enrichment (state.json caches.enrichmentByName[...].url under eval/results and eval/recordings).
 * Capped at 25, companies with a URL first, alternating S1/S2 so neither fills the cap; companies with no recorded URL are skipped and listed.
 * Buyer roles: S1 (warehousing / 3PL buyers) and S2 (funded B2B: the contract buys a sales or revenue leader, or the founder).
 *
 * Every company is run through `findContacts` under ONE shared CostGuard (--max-exa-dollars); the run stops cleanly when the
 * guard refuses. Exa responses are recorded under eval/recordings/<set>/<set>. Output: eval/results/<set>/contacts.jsonl,
 * summary.json, and every contact appended to eval/datasets/contact-cases.jsonl with label null (to be filled by the judge,
 * eval/harness/judge-contacts.ts, or a human).
 *
 * --judge-limit N is accepted for the record only: judging is a separate paid step (judge-contacts.ts --limit N).
 * --dry-run: canned empty Exa, temp output directory, no recording, no spend.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetExceededError, CostGuard } from "../src/exa";
import { findContacts, type Contact, type FindContactsDeps } from "../src/contacts";
import { squashName } from "../src/gates";
import type { ContactCase } from "./harness/judge-contacts";

export const BUYER_ROLES = {
  S1: ["VP of Operations", "COO", "Head of Warehousing", "Director of Logistics"],
  /** S2 contract is funded B2B: the buyer is a sales/revenue leader or the founder, not an operations head. */
  S2: ["Head of Sales", "VP of Revenue", "Founder", "COO"],
} as const;
export type ScenarioId = keyof typeof BUYER_ROLES;

export type EvalCompany = { company: string; scenarioId: ScenarioId; signalUrl: string; companyUrl?: string };
export type SkippedCompany = { company: string; scenarioId: ScenarioId; reason: "no company URL" | "over cap" };

/** state.json files under the given roots (any depth), newest-path-order independent. */
export function findStateFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "state.json") out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** squashed company name -> company URL, first recorded enrichment wins. */
export function enrichmentUrls(stateFiles: string[]): Map<string, string> {
  const urls = new Map<string, string>();
  for (const file of stateFiles) {
    let state: { caches?: { enrichmentByName?: Record<string, { url?: unknown }> } };
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(state.caches?.enrichmentByName ?? {})) {
      if (typeof value?.url === "string" && /^https?:\/\//.test(value.url) && !urls.has(key)) urls.set(key, value.url);
    }
  }
  return urls;
}

export function selectCompanies(options: { truthRoot?: string; stateFiles: string[]; cap?: number }): { companies: EvalCompany[]; skipped: SkippedCompany[] } {
  const truthRoot = options.truthRoot ?? join("eval", "truth");
  const urls = enrichmentUrls(options.stateFiles);
  const seen = new Set<string>();
  const all: EvalCompany[] = [];
  for (const scenarioId of ["S1", "S2"] as const) {
    const dir = join(truthRoot, scenarioId);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || name.endsWith(".prev.json")) continue;
      let v: { company?: unknown; signal_url?: unknown; good?: unknown };
      try {
        v = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;
      }
      if (v.good !== true || typeof v.company !== "string" || typeof v.signal_url !== "string") continue;
      const key = squashName(v.company);
      if (seen.has(key)) continue;
      seen.add(key);
      const companyUrl = urls.get(key);
      all.push({ company: v.company, scenarioId, signalUrl: v.signal_url, ...(companyUrl ? { companyUrl } : {}) });
    }
  }
  const cap = options.cap ?? 25;
  // Round-robin S1/S2 so the cap does not fill with one scenario (S1 alone has more than 25 good companies).
  const byScenario = (id: ScenarioId) => all.filter((c) => c.scenarioId === id && c.companyUrl);
  const [s1, s2] = [byScenario("S1"), byScenario("S2")];
  const withUrl: EvalCompany[] = [];
  for (let i = 0; i < Math.max(s1.length, s2.length); i += 1) {
    if (s1[i]) withUrl.push(s1[i]!);
    if (s2[i]) withUrl.push(s2[i]!);
  }
  const skipped: SkippedCompany[] = all.filter((c) => !c.companyUrl).map((c) => ({ company: c.company, scenarioId: c.scenarioId, reason: "no company URL" }));
  for (const c of withUrl.slice(cap)) skipped.push({ company: c.company, scenarioId: c.scenarioId, reason: "over cap" });
  return { companies: withUrl.slice(0, cap), skipped };
}

export type ContactRow = {
  company: string;
  scenarioId: ScenarioId;
  roles: string[];
  contacts: Array<{ name: string; tier: Contact["tier"]; role: string; why: string; evidence?: Contact["evidence"]; profile_url?: string; note?: string }>;
  cost: number;
  latencyMs: number;
  error?: string;
};

export type EvalSummary = {
  set: string;
  companiesRun: number;
  companiesSkipped: number;
  stoppedByGuard: boolean;
  contacts: number;
  verified: number;
  inferred: number;
  exaDollars: number;
  costPerCompany: number | null;
  p50LatencyMs: number | null;
  errors: number;
};

export function summarise(set: string, rows: ContactRow[], skipped: number, stoppedByGuard: boolean): EvalSummary {
  const all = rows.flatMap((r) => r.contacts);
  const exa = rows.reduce((n, r) => n + r.cost, 0);
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    set,
    companiesRun: rows.length,
    companiesSkipped: skipped,
    stoppedByGuard,
    contacts: all.length,
    verified: all.filter((c) => c.tier === "verified").length,
    inferred: all.filter((c) => c.tier === "inferred").length,
    exaDollars: Number(exa.toFixed(6)),
    costPerCompany: rows.length ? Number((exa / rows.length).toFixed(6)) : null,
    p50LatencyMs: lat.length ? lat[Math.floor((lat.length - 1) / 2)]! : null,
    errors: rows.filter((r) => r.error).length,
  };
}

/** The case row for one contact: label null until judged; url = the page the gate quoted, else the profile link, else the company page. */
export function toCase(row: ContactRow, c: ContactRow["contacts"][number], i: number, company: EvalCompany): ContactCase {
  return {
    id: `${squashName(row.company)}#${i}`,
    company: row.company,
    candidate_name: c.name,
    title: c.why,
    url: c.evidence?.url ?? c.profile_url ?? company.companyUrl ?? company.signalUrl,
    label: null,
    tier: c.tier,
    ...(c.note ? { note: c.note } : {}),
  };
}

export async function runContactEval(options: {
  set: string;
  companies: EvalCompany[];
  skipped: SkippedCompany[];
  maxExaDollars: number;
  resultsDir: string;
  casesFile: string;
  deps?: FindContactsDeps;
  now?: () => number;
}): Promise<{ rows: ContactRow[]; summary: EvalSummary }> {
  const guard = new CostGuard(options.maxExaDollars);
  const clock = options.now ?? Date.now;
  const rows: ContactRow[] = [];
  const cases: ContactCase[] = [];
  let stoppedByGuard = false;
  for (const company of options.companies) {
    const roles = [...BUYER_ROLES[company.scenarioId]];
    const before = guard.spent;
    const t0 = clock();
    let row: ContactRow;
    try {
      const r = await findContacts({ company: company.company, ...(company.companyUrl ? { companyUrl: company.companyUrl } : {}), buyerRoles: roles, guard }, options.deps);
      row = {
        company: company.company,
        scenarioId: company.scenarioId,
        roles,
        contacts: r.contacts.map((c) => ({ name: c.name, tier: c.tier, role: c.role, why: c.why, ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.profile_url ? { profile_url: c.profile_url } : {}), ...(c.note ? { note: c.note } : {}) })),
        cost: guard.spent - before,
        latencyMs: clock() - t0,
      };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stoppedByGuard = true;
        console.error(`contact-eval: guard refused at ${company.company}: ${error.message}`);
        break;
      }
      row = { company: company.company, scenarioId: company.scenarioId, roles, contacts: [], cost: guard.spent - before, latencyMs: clock() - t0, error: error instanceof Error ? error.message : String(error) };
      console.error(`contact-eval: ${company.company}: ${row.error}`);
    }
    rows.push(row);
    row.contacts.forEach((c, i) => cases.push(toCase(row, c, i, company)));
  }
  await mkdir(options.resultsDir, { recursive: true });
  await writeFile(join(options.resultsDir, "contacts.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  const summary = summarise(options.set, rows, options.skipped.length, stoppedByGuard);
  await writeFile(join(options.resultsDir, "summary.json"), `${JSON.stringify({ ...summary, skipped: options.skipped, guardSpent: guard.spent }, null, 2)}\n`, "utf8");
  const existing = existsSync(options.casesFile) ? new Set((await readFile(options.casesFile, "utf8")).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id)) : new Set<string>();
  const fresh = cases.filter((c) => !existing.has(c.id));
  if (fresh.length) await appendFile(options.casesFile, fresh.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
  return { rows, summary };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const set = arg("--set") ?? "contact-eval-2026-10-16";
  const maxExaDollars = Number(arg("--max-exa-dollars") ?? "1.00");
  const dry = process.argv.includes("--dry-run");
  const { companies, skipped } = selectCompanies({ stateFiles: findStateFiles([join("eval", "results"), join("eval", "recordings")]) });
  console.log(`companies: ${companies.length} to run, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped (${s.reason}): ${s.company} [${s.scenarioId}]`);
  let resultsDir = join("eval", "results", set);
  let casesFile = join("eval", "datasets", "contact-cases.jsonl");
  let deps: FindContactsDeps | undefined;
  if (dry) {
    const tmp = await mkdtemp(join(tmpdir(), "contact-eval-"));
    resultsDir = join(tmp, "results");
    casesFile = join(tmp, "contact-cases.jsonl");
    deps = { exaSearch: (async () => ({ results: [], costDollars: { total: 0 } })) as never };
  } else {
    process.env.EXA_RECORD_DIR = join("eval", "recordings", "contact-eval-2026-10-16", set);
  }
  const { rows, summary } = await runContactEval({ set, companies, skipped, maxExaDollars, resultsDir, casesFile, ...(deps ? { deps } : {}) });
  console.log("\ncompany | scenario | verified | inferred | cost | latency ms | error");
  for (const r of rows) console.log([r.company, r.scenarioId, r.contacts.filter((c) => c.tier === "verified").length, r.contacts.filter((c) => c.tier === "inferred").length, `$${r.cost.toFixed(4)}`, r.latencyMs, r.error ?? ""].join(" | "));
  console.log(`\n${JSON.stringify(summary, null, 2)}\nresults: ${resultsDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
