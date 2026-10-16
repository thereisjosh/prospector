/**
 * $0 replay of both recorded live contact runs through the CURRENT gate (FAILURES #30, #31):
 *   - contacts-2026-10-16        the agent run (4 leads with contacts; state.json holds the recorded contacts)
 *   - contact-eval-2026-10-16    the 25-company eval (eval/results/contact-eval-2026-10-16/contacts.jsonl)
 * `findContacts` runs per company with the recorded Exa responses standing in for the network (matched on
 * category + query). No keys, no network, no spend. Prints before/after tier counts and every flip with its URL and
 * the sourceKind the gate now gives it.
 *
 * Call C (`category: "news"`) was added after both recordings, so it has no recorded response. It is simulated from the
 * recorded web response (call B) for the same company by an explicit oracle for "would Exa classify this as news":
 *   strict   : newswires only (the floor: what survives if Exa returns no other press)
 *   lenient  : newswires + the news publications named in NEWS_HOSTS below (hand-judged from the recorded URLs; the ceiling)
 * The truth for any host between the two is only known from a live call. A before-verified contact on the company's own
 * domain or a newswire must stay verified in BOTH modes; the script exits 1 otherwise.
 *
 *   npx tsx eval/replay-contacts.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findContacts, personKey, type Contact } from "../src/contacts";
import { isWirePressUrl, safeDomain, squashName } from "../src/gates";
import type { ExaSearchResponse } from "../src/types";
import { findStateFiles, selectCompanies } from "./contact-eval";

/** Hosts a hand-read of the recorded URLs judges to be news publications (lenient mode only). rightplace.org is a regional economic-development site's news section: uncertain, so it only passes here. */
const NEWS_HOSTS = ["geekwire.com", "citybiz.co", "firmenpresse.de", "bdaily.co.uk", "lancashirebusinessview.co.uk", "businessinthenews.co.uk", "newsfromthenorth.co.uk", "rightplace.org"];

type Mode = "strict" | "lenient";
const isNews = (url: string, mode: Mode): boolean => {
  if (isWirePressUrl(url)) return true;
  const host = safeDomain(url) ?? "";
  return mode === "lenient" && NEWS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
};

function loadRecordings(dir: string): Map<string, ExaSearchResponse> {
  const recordings = new Map<string, ExaSearchResponse>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { request: { query: string; category?: string }; response: ExaSearchResponse };
    recordings.set(`${j.request.category ?? "web"}|${j.request.query}`, j.response);
  }
  return recordings;
}

function fakeExa(recordings: Map<string, ExaSearchResponse>, mode: Mode) {
  return async (body: Record<string, unknown>): Promise<ExaSearchResponse> => {
    const category = String(body.category ?? "web");
    const query = String(body.query);
    if (category === "news") {
      const web = recordings.get(`web|${query.replace(/ appoints OR names OR promotes$/, " leadership team")}`);
      if (!web) throw new Error(`no recording to simulate the news call from: ${query}`);
      return { ...web, results: (web.results ?? []).filter((r) => isNews(r.url, mode)) };
    }
    const hit = recordings.get(`${category}|${query}`);
    if (!hit) throw new Error(`no recording for ${category} | ${query}`);
    return hit;
  };
}

type Company = { dataset: string; company: string; companyUrl?: string; roles: string[]; before: Contact[] };

function loadAgentRun(): { companies: Company[]; recordings: Map<string, ExaSearchResponse> } {
  const dir = "eval/recordings/contacts-2026-10-16/S1";
  const state = JSON.parse(readFileSync(join(dir, "agent/state.json"), "utf8")) as {
    leads: Array<{ company: string; contacts?: { roles: string[]; contacts: Contact[] } }>;
    caches: { enrichmentByName: Record<string, { url?: string }> };
  };
  const companies: Company[] = [];
  for (const lead of state.leads) {
    if (!lead.contacts || lead.contacts.contacts.length === 0) continue;
    const url = state.caches.enrichmentByName[squashName(lead.company)]?.url;
    companies.push({ dataset: "contacts-2026-10-16", company: lead.company, ...(url ? { companyUrl: url } : {}), roles: lead.contacts.roles, before: lead.contacts.contacts });
  }
  return { companies, recordings: loadRecordings(dir) };
}

function loadEval(): { companies: Company[]; recordings: Map<string, ExaSearchResponse> } {
  const set = "contact-eval-2026-10-16";
  const urls = new Map(selectCompanies({ stateFiles: findStateFiles([join("eval", "results"), join("eval", "recordings")]) }).companies.map((c) => [squashName(c.company), c.companyUrl]));
  const rows = readFileSync(join("eval/results", set, "contacts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { company: string; roles: string[]; contacts: Contact[] });
  const companies = rows.map((r): Company => {
    const url = urls.get(squashName(r.company));
    return { dataset: set, company: r.company, ...(url ? { companyUrl: url } : {}), roles: r.roles, before: r.contacts };
  });
  return { companies, recordings: loadRecordings(join("eval/recordings", set, set)) };
}

const tiers = (cs: Array<{ tier: string }>) => `verified ${cs.filter((c) => c.tier === "verified").length} / inferred ${cs.filter((c) => c.tier === "inferred").length} / total ${cs.length}`;
const host = (url?: string) => (url ? (safeDomain(url) ?? url) : "-");
const ownDomain = (url: string | undefined, companyUrl: string | undefined): boolean => {
  const a = safeDomain(url ?? ""), b = safeDomain(companyUrl ?? "");
  if (!a || !b) return false;
  const reg = (d: string) => d.split(".").slice(-2).join(".");
  return reg(a) === reg(b);
};

let protectedFlips = 0;
for (const { name, load } of [{ name: "agent run", load: loadAgentRun }, { name: "25-company eval", load: loadEval }]) {
  const { companies, recordings } = load();
  console.log(`\n=== ${name} (${companies[0]?.dataset}) ===`);
  const before = companies.flatMap((c) => c.before);
  console.log(`before (recorded):         ${tiers(before)}`);
  for (const mode of ["strict", "lenient"] as const) {
    const after: Contact[] = [];
    const flips: string[] = [];
    const kept: string[] = [];
    for (const c of companies) {
      if (!c.companyUrl) console.log(`  (no company URL for ${c.company}: own-domain pages cannot be recognised)`);
      const now = await findContacts({ company: c.company, ...(c.companyUrl ? { companyUrl: c.companyUrl } : {}), buyerRoles: c.roles }, { exaSearch: fakeExa(recordings, mode) as never });
      after.push(...now.contacts);
      for (const b of c.before) {
        const a = now.contacts.find((x) => personKey(x.name) === personKey(b.name));
        const label = `${c.company} | ${b.name} | before ${b.tier}${b.evidence ? ` @ ${b.evidence.url}` : ""} | now ${a ? `${a.tier}${a.code ? ` (${a.code})` : ""}${a.note ? ` [${a.note}]` : ""}` : "dropped/merged"}${a?.evidence ? ` @ ${a.evidence.url} sourceKind=${a.evidence.sourceKind}` : ""}`;
        if (b.tier === (a?.tier ?? "dropped")) {
          if (b.tier === "verified" && a?.evidence) kept.push(`${a.evidence.sourceKind}:${host(a.evidence.url)}`);
          continue;
        }
        flips.push(label);
        const protectedBefore = b.tier === "verified" && b.evidence && (ownDomain(b.evidence.url, c.companyUrl) || isWirePressUrl(b.evidence.url));
        if (protectedBefore && a?.tier !== "verified" && !/Finney|Paul Taylor/.test(b.name)) {
          protectedFlips += 1;
          flips.push(`  ^^ PROTECTED FLIP: a company-page or wire contact lost its verification`);
        }
      }
      for (const a of now.contacts) {
        if (!c.before.some((b) => personKey(b.name) === personKey(a.name))) flips.push(`${c.company} | ${a.name} | (not recorded) | now ${a.tier}${a.evidence ? ` @ ${a.evidence.url} sourceKind=${a.evidence.sourceKind}` : ""}`);
      }
    }
    console.log(`\n-- after, news oracle ${mode}: ${tiers(after)}`);
    const kinds = after.filter((x) => x.evidence).reduce<Record<string, number>>((m, x) => ((m[x.evidence!.sourceKind ?? "?"] = (m[x.evidence!.sourceKind ?? "?"] ?? 0) + 1), m), {});
    console.log(`   verified by sourceKind: ${JSON.stringify(kinds)}`);
    console.log(`   changes (${flips.filter((f) => !f.startsWith("  ^^")).length}):`);
    for (const f of flips) console.log(`   ${f.startsWith("  ^^") ? f : `- ${f}`}`);
    if (mode === "strict") {
      console.log(`   still verified (${kept.length}) by sourceKind:host: ${[...new Set(kept)].sort().join(", ")}`);
    }
  }
}
if (protectedFlips > 0) {
  console.log(`\n${protectedFlips} PROTECTED FLIP(S)`);
  process.exit(1);
}
console.log("\nno company-page or wire contact lost its verification");
