/**
 * $0 replay of the 2026-10-16 live contacts run (FAILURES #30): re-runs `findContacts` for the four leads that had
 * contacts, with the recorded Exa responses standing in for the network (matched on category + query), and prints each
 * contact's recorded tier next to the tier the current gate gives. No keys, no network, no spend.
 *
 *   npx tsx eval/replay-contacts.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findContacts, personKey, type Contact } from "../src/contacts";
import { squashName } from "../src/gates";
import type { ExaSearchResponse } from "../src/types";

const DIR = "eval/recordings/contacts-2026-10-16/S1";
const state = JSON.parse(readFileSync(join(DIR, "agent/state.json"), "utf8")) as {
  leads: Array<{ company: string; contacts?: { roles: string[]; contacts: Contact[] } }>;
  caches: { enrichmentByName: Record<string, { url?: string }> };
};

const recordings = new Map<string, ExaSearchResponse>();
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(join(DIR, f), "utf8")) as { request: { query: string; category?: string }; response: ExaSearchResponse };
  recordings.set(`${j.request.category ?? "web"}|${j.request.query}`, j.response);
}

const fakeExa = async (body: Record<string, unknown>): Promise<ExaSearchResponse> => {
  const hit = recordings.get(`${String(body.category ?? "web")}|${String(body.query)}`);
  if (!hit) throw new Error(`no recording for ${String(body.category ?? "web")} | ${String(body.query)}`);
  return hit;
};

const rows: string[][] = [["lead", "recorded", "now"]];
const label = (c: Contact | undefined) => (c ? `${c.tier}${c.code ? ` (${c.code})` : ""}${c.note ? ` [${c.note}]` : ""}` : "dropped / merged");

for (const lead of state.leads) {
  if (!lead.contacts || lead.contacts.contacts.length === 0) continue;
  const url = state.caches.enrichmentByName[squashName(lead.company)]?.url;
  const now = await findContacts({ company: lead.company, ...(url ? { companyUrl: url } : {}), buyerRoles: lead.contacts.roles }, { exaSearch: fakeExa as never });
  const before = lead.contacts.contacts;
  for (const b of before) {
    const a = now.contacts.find((c) => personKey(c.name) === personKey(b.name));
    rows.push([lead.company, `${b.name}: ${b.tier} as "${b.why}"${b.evidence ? ` @ ${new URL(b.evidence.url).host}` : ""}`, `${a?.name ?? "-"}: ${label(a)}${a?.profile_url ? " +profile" : ""}${a?.tier === "verified" ? ` as "${a.why}"` : ""}`]);
  }
  for (const a of now.contacts) {
    if (!before.some((b) => personKey(b.name) === personKey(a.name))) rows.push([lead.company, "(not recorded)", `${a.name}: ${label(a)}`]);
  }
}
for (const r of rows) console.log(r.join("  |  "));
