/**
 * Named contacts at an accepted lead (docs/SPEC-agent.md §5b, docs/RESEARCH-contacts-and-graph.md §5).
 *
 * Two Exa calls under the run's CostGuard:
 *   A. people index (`category: "people"`): names and LinkedIn profile URLs. Nothing else from a profile is
 *      kept or shown (LinkedIn User Agreement §8.2): the index title is read only to say which approved
 *      role a person was listed under (their "role bucket").
 *   B. a plain web search that excludes LinkedIn, its copies and people-data aggregators, with page text
 *      and a summariser that lists the people each page names with their title as written.
 * Code then decides every tier with `checkContact` (src/gates.ts): `verified` needs a page that names the
 * person next to a title fitting an approved role, both checked on the page text, and that page is the
 * company's own domain or real press (not a profile/directory page, with prose around the quote); press older
 * than 24 months also needs the people index to list the person in a current approved role. `inferred` is a
 * people-index listing in an approved role (name + profile link only), or an old press page (title as quoted,
 * "last confirmed <year>"). A name only the summariser
 * produced and the page does not support is dropped: code never shows a person no source supports.
 * No emails or phones are fetched, stored or shown.
 */
import { CONTACT_NON_EVIDENCE_DOMAINS, checkContact, matchedBuyerRole, nameTokens, personNameTokens, safeDomain, squashName, type ContactGateCode } from "./gates";
import { BudgetExceededError, CostGuard, estimateExaCost, exaSearch, type ExaCredentials } from "./exa";
import { CONTACT_TITLE_MAX, type ContactEvidence } from "./evidence";
import { normalizeNullish } from "./plan";
import type { ExaResult, ExaSearchResponse } from "./types";

export type ContactTier = "verified" | "inferred";

export type Contact = {
  name: string;
  tier: ContactTier;
  /** The approved buyer role the title (verified) or the index listing (inferred) fits. */
  role: string;
  /** "Why this person": the quoted title for verified, the role bucket for inferred. */
  why: string;
  /** linkedin.com/in/… when the people index listed them: a link only, no profile text is kept. */
  profile_url?: string;
  /** Verified only: the page span and title quote the gate checked. */
  evidence?: ContactEvidence;
  /** Where the name came from: the people index (A) or only a public page (B). */
  found_via: "people_index" | "web_page";
  /** Why an inferred contact is not verified (gate code). */
  code?: ContactGateCode;
  /** Inferred from an old press page only: "last confirmed 2019". */
  note?: string;
};

/** What `find_contacts` stored on the lead. One per lead; run retention applies, nothing goes to workspace memory. */
export type LeadContacts = {
  at: string;
  /** The approved roles the lookup checked against. */
  roles: string[];
  contacts: Contact[];
  /** Exa dollars this lookup spent. */
  cost: number;
  /** Set when the lookup failed; the one call per lead is spent either way. */
  error?: string;
};

export const CONTACT_LIMITS = {
  maxContacts: 3,
  /** Per-lead cap on the two calls' worst-case estimate (src/exa.ts estimateExaCost, margin included). */
  maxCostDollars: 0.03,
  peopleResults: 5,
  pageResults: 5,
  pageTextMax: 20_000,
  /** Roles named in a query. */
  queryRoles: 3,
} as const;

export type FindContactsInput = {
  company: string;
  /** URL of the lead's company lookup page, so the gate can recognise the company's own domain. */
  companyUrl?: string;
  buyerRoles: string[];
  guard?: CostGuard;
};

export type FindContactsDeps = {
  exaSearch?: typeof exaSearch;
  credentials?: ExaCredentials;
  /**
   * Not accepted: the run's CostGuard travels in `FindContactsInput.guard` and is the only one charged.
   * (A guard passed here was silently ignored in the 2026-10-16 live probe: cost 0.019, guard.spent 0.)
   */
  guard?: never;
};

export type FindContactsResult = {
  contacts: Contact[];
  cost: number;
  /** Every person considered and how the gate decided, for the trace (counts only leave the process). */
  checked: Array<{ name: string; outcome: ContactTier | "dropped"; code?: ContactGateCode }>;
};


function roleWords(roles: string[]): string {
  return roles.slice(0, CONTACT_LIMITS.queryRoles).join(" or ");
}

/** Call A: the people index. No contents: nothing from a LinkedIn profile is fetched beyond the listing. */
export function peopleSearchBody(company: string, roles: string[]): Record<string, unknown> {
  return { query: `${roleWords(roles)} at ${company}`, category: "people", type: "auto", numResults: CONTACT_LIMITS.peopleResults };
}

const PEOPLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, title_quote: { type: "string" } },
        required: ["name", "title_quote"],
      },
    },
  },
  required: ["people"],
} as const;

/** Call B: public pages (not LinkedIn, its copies or aggregators) that name people at the company, with text and a people summary. */
export function pageSearchBody(company: string, roles: string[], names: string[]): Record<string, unknown> {
  const known = names.length > 0 ? ` If the page names any of these people, include them: ${names.slice(0, CONTACT_LIMITS.peopleResults).join(", ")}.` : "";
  return {
    query: `"${company}" ${roleWords(roles)} leadership team`,
    type: "auto",
    numResults: CONTACT_LIMITS.pageResults,
    excludeDomains: [...CONTACT_NON_EVIDENCE_DOMAINS],
    contents: {
      text: { maxCharacters: CONTACT_LIMITS.pageTextMax },
      summary: {
        query: `List the people this page names who work at ${company}, each with their job title copied exactly as the page writes it (title_quote, one contiguous phrase of at most ${CONTACT_TITLE_MAX} characters). Only people the page itself names; an empty list if none.${known}`,
        schema: PEOPLE_SCHEMA,
      },
      livecrawl: "fallback",
    },
  };
}

/** Worst-case estimate of one lead's two calls (call B's estimate does not depend on the names it lists). */
export function estimateContactCost(company: string, roles: string[]): number {
  return estimateExaCost(peopleSearchBody(company, roles)) + estimateExaCost(pageSearchBody(company, roles, []));
}

function actualCost(response: ExaSearchResponse | undefined, fallback: number): number {
  const total = response?.costDollars?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : fallback;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isLinkedInProfile(url: string): boolean {
  const host = safeDomain(url);
  if (!host || !(host === "linkedin.com" || host.endsWith(".linkedin.com"))) return false;
  try {
    return /^\/in\/[^/]+\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Normalised key for "is this the same person": lowercase name tokens, middle initials dropped. */
export function personKey(name: string): string {
  const tokens = personNameTokens(name).map((t) => t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase());
  const kept = tokens.filter((t, i) => i === 0 || i === tokens.length - 1 || t.replace(/\./g, "").length > 1);
  return kept.join(" ");
}

function plausibleName(name: string | undefined): name is string {
  if (!name) return false;
  const t = name.trim();
  const tokens = personNameTokens(t);
  return t.length <= 80 && tokens.length >= 2 && tokens.length <= 5 && /\p{L}/u.test(t) && !/\d/.test(t);
}

/** "Travis French - SVP … | LinkedIn" -> "Travis French" (only when the index entity carries no name). */
function nameFromTitle(title: string | undefined): string | undefined {
  const head = (title ?? "").split(/\s+[-–—|·]\s+|\s*\|\s*/)[0]?.trim();
  return head || undefined;
}

/** Same company, by the lookup's token rule: ≥ 60% of the lead's name tokens, or the same squashed name. */
function sameCompany(lead: string, other: string): boolean {
  if (!other.trim()) return false;
  if (squashName(lead) === squashName(other)) return true;
  const want = nameTokens(lead).filter((t) => t.length > 1 && t !== "group");
  const have = new Set(nameTokens(other));
  if (want.length === 0) return false;
  return want.filter((t) => have.has(t)).length / want.length >= 0.6;
}

type IndexPerson = { name: string; profileUrl: string; role?: string };

/**
 * One people-index result: name, profile URL, and the approved role of their CURRENT position at this
 * company (workHistory entry with no end date), if any. The index title is read for that match only.
 */
export function parseIndexPerson(result: ExaResult, company: string, roles: string[]): IndexPerson | undefined {
  if (!isLinkedInProfile(result.url)) return undefined;
  const entities = Array.isArray(result.entities) ? result.entities : [];
  const entity = rec(entities.find((e) => rec(e).type === "person") ?? entities[0]);
  const props = rec(entity.properties ?? entity);
  const rawName = typeof props.name === "string" ? props.name : typeof entity.name === "string" ? entity.name : nameFromTitle(result.title);
  const name = rawName?.replace(/\s+/g, " ").trim();
  if (!plausibleName(name)) return undefined;
  const history = Array.isArray(props.workHistory) ? props.workHistory : [];
  let role: string | undefined;
  for (const item of history) {
    const entry = rec(item);
    const dates = rec(entry.dates);
    const current = dates.to === null || dates.to === undefined || dates.to === "";
    const companyName = typeof entry.company === "string" ? entry.company : String(rec(entry.company).name ?? "");
    const title = typeof entry.title === "string" ? entry.title : "";
    if (!current || !title || !sameCompany(company, companyName)) continue;
    role = matchedBuyerRole(title, roles);
    if (role) break;
  }
  return { name, profileUrl: result.url, ...(role ? { role } : {}) };
}

type PageClaim = { name: string; title_quote: string };

/** The summariser's people list for one page (strings only, "null" dropped). */
export function parsePagePeople(summary: unknown): PageClaim[] {
  let raw = summary;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const people = rec(raw).people;
  if (!Array.isArray(people)) return [];
  const out: PageClaim[] = [];
  for (const item of people) {
    const name = normalizeNullish(rec(item).name);
    const title = normalizeNullish(rec(item).title_quote);
    if (typeof name === "string" && typeof title === "string" && name.trim() && title.trim()) out.push({ name: name.trim(), title_quote: title.trim() });
  }
  return out;
}

/**
 * Find up to 3 contacts at one accepted lead. Throws BudgetExceededError, before any spend, when the two
 * calls' estimate exceeds CONTACT_LIMITS.maxCostDollars or the run guard's remaining budget.
 */
export async function findContacts(input: FindContactsInput, deps: FindContactsDeps = {}): Promise<FindContactsResult> {
  if ((deps as { guard?: unknown }).guard !== undefined) throw new Error("findContacts: pass the CostGuard as input.guard, not deps.guard");
  const roles = input.buyerRoles.filter((r) => r.trim());
  if (roles.length === 0) throw new Error("no approved buyer roles: contacts cannot be checked");
  const estimate = estimateContactCost(input.company, roles);
  if (estimate > CONTACT_LIMITS.maxCostDollars + 1e-9) {
    throw new BudgetExceededError(`contact lookup estimate $${estimate.toFixed(4)} is over the $${CONTACT_LIMITS.maxCostDollars.toFixed(2)} per-lead cap`);
  }
  if (input.guard && input.guard.remaining + 1e-9 < estimate) {
    throw new BudgetExceededError(`contact lookup needs about $${estimate.toFixed(3)}; $${Math.max(0, input.guard.remaining).toFixed(3)} of the run budget is left`);
  }
  const search = deps.exaSearch ?? exaSearch;
  let cost = 0;

  // A: names from the people index.
  const peopleBody = peopleSearchBody(input.company, roles);
  const people = (await search(peopleBody, deps.credentials, input.guard)) as ExaSearchResponse;
  cost += actualCost(people, estimateExaCost(peopleBody));
  const indexed: IndexPerson[] = [];
  for (const result of people.results ?? []) {
    const person = parseIndexPerson(result, input.company, roles);
    if (person && !indexed.some((p) => personKey(p.name) === personKey(person.name))) indexed.push(person);
  }

  // B: public pages that name people at the company.
  const pageBody = pageSearchBody(input.company, roles, indexed.map((p) => p.name));
  const pages = (await search(pageBody, deps.credentials, input.guard)) as ExaSearchResponse;
  cost += actualCost(pages, estimateExaCost(pageBody));
  const pageClaims = (pages.results ?? []).map((result) => ({ result, claims: parsePagePeople(result.summary) }));

  // Everyone to consider: index names first (in index order), then names only a page lists.
  const candidates: Array<{ name: string; index?: IndexPerson }> = indexed.map((p) => ({ name: p.name, index: p }));
  for (const { claims } of pageClaims) {
    for (const claim of claims) {
      if (plausibleName(claim.name) && !candidates.some((p) => personKey(p.name) === personKey(claim.name))) candidates.push({ name: claim.name });
    }
  }

  const contacts: Contact[] = [];
  const checked: FindContactsResult["checked"] = [];
  for (const person of candidates) {
    const key = personKey(person.name);
    let verified: Contact | undefined;
    let stale: NonNullable<Extract<ReturnType<typeof checkContact>, { ok: false }>["stale"]> | undefined;
    const codes = new Set<ContactGateCode>();
    for (const { result, claims } of pageClaims) {
      const titles = claims.filter((c) => personKey(c.name) === key).map((c) => c.title_quote);
      for (const title_quote of titles.length > 0 ? titles : [undefined]) {
        const verdict = checkContact(
          { name: person.name, company: input.company, ...(title_quote ? { title_quote } : {}) },
          {
            page: { url: result.url, ...(result.text ? { text: result.text } : {}), ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}) },
            buyerRoles: roles,
            companyUrl: input.companyUrl,
            // The index lists them in a CURRENT position at this company in an approved role.
            currentInIndex: Boolean(person.index?.role),
          },
        );
        if (verdict.ok) {
          verified = {
            name: person.name,
            tier: "verified",
            role: verdict.role,
            why: verdict.evidence.title_quote,
            ...(person.index ? { profile_url: person.index.profileUrl } : {}),
            evidence: verdict.evidence,
            found_via: person.index ? "people_index" : "web_page",
          };
          break;
        }
        codes.add(verdict.code);
        if (verdict.stale && (!stale || verdict.stale.published > stale.published)) stale = verdict.stale;
      }
      if (verified) break;
    }
    // A public page giving them a title outside the approved roles outranks the index listing: not a contact.
    const roleMismatch = codes.has("contact_role_mismatch");
    const worst: ContactGateCode = roleMismatch ? "contact_role_mismatch" : codes.has("contact_quote_not_in_page") ? "contact_quote_not_in_page" : "contact_unverified";
    if (verified) {
      contacts.push(verified);
      checked.push({ name: person.name, outcome: "verified" });
    } else if (person.index?.role && !roleMismatch) {
      // Listed in the index in an approved role; no public page confirms the title. Link only.
      contacts.push({
        name: person.name,
        tier: "inferred",
        role: person.index.role,
        why: person.index.role,
        profile_url: person.index.profileUrl,
        found_via: "people_index",
        code: worst,
      });
      checked.push({ name: person.name, outcome: "inferred", code: worst });
    } else if (stale && !roleMismatch) {
      // Only an old press page names them in an approved role: the title as quoted, with when it was last confirmed.
      contacts.push({
        name: person.name,
        tier: "inferred",
        role: stale.role,
        why: stale.title_quote,
        ...(person.index ? { profile_url: person.index.profileUrl } : {}),
        found_via: person.index ? "people_index" : "web_page",
        code: "contact_stale",
        note: `last confirmed ${stale.published.slice(0, 4)}`,
      });
      checked.push({ name: person.name, outcome: "inferred", code: "contact_stale" });
    } else {
      checked.push({ name: person.name, outcome: "dropped", code: worst });
    }
  }

  const ordered = [...contacts.filter((c) => c.tier === "verified"), ...contacts.filter((c) => c.tier === "inferred")].slice(0, CONTACT_LIMITS.maxContacts);
  return { contacts: ordered, cost, checked };
}

/** The result `find_contacts` returns to the model: structured, no page text, no profile text. */
export function contactsToolResult(company: string, found: Pick<FindContactsResult, "contacts">): string {
  return JSON.stringify({
    company,
    contacts: found.contacts.map((c) => ({
      name: c.name,
      tier: c.tier,
      why: c.tier === "verified" ? `title on ${safeDomain(c.evidence?.url ?? "") ?? "a public page"}: "${c.why}"` : `listed in a people index as ${c.role}; title not confirmed`,
      ...(c.evidence ? { evidence_url: c.evidence.url } : {}),
    })),
    note:
      found.contacts.length === 0
        ? "No one in the approved roles was found. Do not look for or name people yourself."
        : "Code checked these; do not add, rename or guess other people.",
  });
}
