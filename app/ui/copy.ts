/**
 * Plain-words copy for everything the agent and the gates report in codes.
 * Pure functions, no React: covered by eval/ui-copy.test.ts so no raw code
 * (required_gate:..., stale_date, snake_case) reaches the screen.
 */
import type { AgentEvent } from "../../src/agent/events";
import type { AcceptedLead, Handback } from "../../src/agent/state";
import type { SearchPlan } from "../../src/plan";
import type { CardSet } from "../../src/planner/cards";

export type ContractView = SearchPlan & { targetLeads: number; maxCostDollars: number; preferenceNotes?: string[] };
export type Tone = "info" | "good" | "bad" | "wait" | "you";
export type FeedLine = { text: string; tone: Tone };

/* ---------- small formatters ---------- */

export function money(n: number | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(2)}`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const WORDS: Record<string, string> = { ops: "operations", hq: "HQ", b2b: "B2B", saas: "SaaS", vp: "VP", ai: "AI", us: "US", uk: "UK" };

/** "ops_hiring_wave" -> "Operations hiring wave". */
export function humanize(snake: string): string {
  const words = snake
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Turns free text into a signal-type key the planner accepts. */
export function toSignalKey(text: string): string {
  const key = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(key) ? key : key ? `s_${key}`.slice(0, 40) : "";
}

let regionNames: Intl.DisplayNames | undefined;
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function countryList(codes: string[]): string {
  if (codes.length === 0) return "anywhere";
  return joinWords(codes.map(countryName));
}

export function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const COUNTRY_CHOICES = [
  "US", "CA", "GB", "IE", "DE", "FR", "NL", "BE", "ES", "IT", "SE", "DK", "NO", "FI", "CH", "AT", "PL",
  "AU", "NZ", "SG", "MY", "ID", "PH", "TH", "VN", "IN", "JP", "KR", "HK", "TW", "AE", "SA", "IL", "ZA",
  "BR", "MX", "AR", "CL", "CO",
];

export const STAGES: Array<{ value: NonNullable<CardSet["stage"]>; label: string }> = [
  { value: "any", label: "Any stage" },
  { value: "seed", label: "Seed" },
  { value: "series_a", label: "Series A" },
  { value: "series_b_plus", label: "Series B or later" },
  { value: "bootstrapped", label: "Bootstrapped" },
];

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, d ? Number(d) : 1));
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "short",
    ...(d ? { day: "numeric" } : {}),
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ---------- rejection reasons ---------- */

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

function sizeDirection(reason: string, contract?: ContractView): "large" | "small" {
  const nums = numbersIn(reason);
  const estimate = nums[0];
  // The reason quotes the range in force when the company was checked; prefer it to the
  // current contract, which a later scope change may have widened.
  const max = nums.length >= 3 ? nums[nums.length - 1] : contract?.employeeRange.max ?? nums[nums.length - 1];
  if (estimate === undefined || max === undefined) return "large";
  return estimate > max ? "large" : "small";
}

function gateQuestion(code: string, contract?: ContractView): string {
  const key = code.slice("required_gate:".length);
  const question = contract?.gateFields.find((g) => g.key === key)?.question;
  const text = (question ?? humanize(key)).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\?$/, "").trim();
  return text.length > 90 ? `${text.slice(0, 87).trimEnd()}…` : text;
}

/** The group a rejection falls into, e.g. "Too large". Used for counts. */
export function reasonGroup(code: string, reason: string, contract?: ContractView): string {
  if (code === "size") return reason ? (sizeDirection(reason, contract) === "large" ? "Too large" : "Too small") : "Outside the size range";
  if (code.startsWith("required_gate:")) return `Not a match: ${gateQuestion(code, contract)}`;
  return REASON_GROUPS[code] ?? "Didn't pass the checks";
}

const REASON_GROUPS: Record<string, string> = {
  enterprise: "Large enterprise or public company",
  unknown_size: "Size couldn't be confirmed",
  stale_date: "News older than the time window",
  unparseable_date: "News had no clear date",
  hq: "Based outside your countries",
  entity_mismatch: "Source didn't name the company",
  no_enrichment: "Couldn't verify the company",
  exclude_name: "On your exclusion list",
  exclude_domain: "From an excluded website",
  non_company: "Job board, staffing agency or placeholder",
  already_seen: "Already seen in an earlier run",
  duplicate: "Already in this run's leads",
  visitor_allowance: "Your free allowance was reached",
};

/** One short clause for a single rejection, e.g. "too large (3,560 employees)". */
export function rejectionPhrase(code: string, reason: string, contract?: ContractView): string {
  if (code === "size") {
    const n = numbersIn(reason)[0];
    const dir = sizeDirection(reason, contract) === "large" ? "too large" : "too small";
    return n !== undefined ? `${dir} (${int(n)} employees)` : dir;
  }
  if (code === "hq") {
    const where = /HQ "([^"]*)"/.exec(reason)?.[1];
    return where && where !== "unknown" ? `based outside your countries (${where})` : "based outside your countries";
  }
  if (code.startsWith("required_gate:")) return `not a match: ${gateQuestion(code, contract).replace(/^./, (c) => c.toLowerCase())}`;
  const group = REASON_GROUPS[code];
  return group ? group.charAt(0).toLowerCase() + group.slice(1) : "didn't pass the checks";
}

export type RejectionGroup = { label: string; items: Array<{ company: string; phrase: string }> };

export function groupRejections(
  rejected: Array<{ company: string; code: string; reason: string }>,
  contract?: ContractView,
): RejectionGroup[] {
  const groups = new Map<string, RejectionGroup>();
  for (const r of rejected) {
    const label = reasonGroup(r.code, r.reason, contract);
    const group = groups.get(label) ?? { label, items: [] };
    group.items.push({ company: r.company, phrase: rejectionPhrase(r.code, r.reason, contract) });
    groups.set(label, group);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

/* ---------- memory ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Oct" from an ISO timestamp (UTC, so the server and the browser agree). Empty when unparseable. */
export function shortDate(iso: unknown): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "delivered 12 Oct" / "turned down 12 Oct" / "seen 12 Oct" */
export function seenWhen(seen: { verdict?: unknown; at?: unknown }): string {
  const verb = seen.verdict === "accepted" ? "delivered" : seen.verdict === "rejected" ? "turned down" : "seen";
  const date = shortDate(seen.at);
  return date ? `${verb} ${date}` : verb;
}

export const MEMORY_COPY = {
  seenHeading: "Companies already seen",
  feedbackHeading: "Your feedback",
  learnedHeading: "What the agent learned",
  forget: (what: string) => `Forget ${what}`,
  empty: "Nothing yet. After a run I skip companies you've already seen and keep your feedback.",
  latestOnly: (shown: number, total: number) => `Showing the latest ${shown} of ${total}.`,
  expires: (iso: string) => `expires ${shortDate(iso)}`,
} as const;

/* ---------- activity feed ---------- */

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stopSentence(reason: string | undefined, status?: string): string {
  switch (reason) {
    case "target_leads":
      return "Reached the number of leads you asked for.";
    case "finish":
    case "end_turn":
      return "The agent finished.";
    case "budget":
      return "Stopped at your spending limit.";
    case "max_turns":
      return "Stopped after the maximum number of steps.";
    case "max_active_ms":
      return "Stopped at the time limit.";
    case "no_progress":
      return "Stopped: several steps in a row found nothing new.";
    case "refusal":
      return "The AI declined to continue this search.";
    default:
      return status === "error" ? "Something went wrong and the run stopped." : "The run ended.";
  }
}

/** One plain sentence per event, or null for events the user doesn't need to see. */
export function eventLine(event: AgentEvent, contract?: ContractView): FeedLine | null {
  const input = rec(event.input);
  switch (event.kind) {
    case "tool_call": {
      if (event.is_error === true) {
        return { text: event.tool === "search_signals" ? "A search didn't go through; trying something else." : "One step didn't go through; moving on.", tone: "info" };
      }
      if (event.tool === "search_signals") {
        const query = str(input.query);
        return { text: query ? `Searching: ${query}` : "Searching recent news for why-now events", tone: "info" };
      }
      if (event.tool === "lookup_company") {
        const name = str(input.name);
        const seen = rec(event.seen);
        // The company is in this workspace's memory: the paid lookup was skipped.
        if (name && Object.keys(seen).length > 0) {
          return { text: `Skipped ${name}, ${seenWhen(seen)} in an earlier run, lookup saved`, tone: "info" };
        }
        const skipped = Array.isArray(input.skipped_companies) ? input.skipped_companies.filter((s): s is string => typeof s === "string") : [];
        const look = name ? `Looking up ${name}` : "Looking up a candidate company";
        const shown = skipped.length > 4 ? [...skipped.slice(0, 3), `${skipped.length - 3} more`] : skipped;
        return { text: skipped.length ? `${look}; skipped ${skipped.length} obvious non-fit${skipped.length === 1 ? "" : "s"} (${joinWords(shown)})` : look, tone: "info" };
      }
      if (event.tool === "read_page") {
        const url = str(input.url);
        return { text: url && isHttpUrl(url) ? `Reading ${host(url)} to double-check` : "Reading a page to double-check", tone: "info" };
      }
      if (event.tool === "update_todo") return { text: "Updated its checklist", tone: "info" };
      if (event.tool === "finish") return { text: "Wrapping up", tone: "info" };
      return null; // submit_lead: the verdict line says what happened
    }
    case "submit_verdict": {
      const company = str(event.company) ?? "A company";
      if (event.ok === true) return { text: `Checked ${company}: fits. Added to your leads.`, tone: "good" };
      if (event.code === "already_seen" && Object.keys(rec(event.seen)).length > 0) {
        return { text: `Skipped ${company}, ${seenWhen(rec(event.seen))} in an earlier run`, tone: "info" };
      }
      return { text: `Turned down ${company}: ${rejectionPhrase(String(event.code ?? ""), String(event.reason ?? ""), contract)}`, tone: "bad" };
    }
    case "approval_request":
      return {
        text: event.tool === "propose_strategy" ? "Proposed an opening plan. Waiting for your OK." : "Asked to change the targeting. Waiting for your OK.",
        tone: "wait",
      };
    case "decision": {
      if (event.approve !== true) return { text: "You declined.", tone: "you" };
      return { text: event.revisedValue !== undefined ? "You approved with changes." : "You approved.", tone: "you" };
    }
    case "stop":
      return { text: stopSentence(str(event.reason), str(event.status)), tone: "info" };
    case "error":
      return { text: "Something went wrong on our side.", tone: "bad" };
    default:
      return null;
  }
}

/* ---------- approvals ---------- */

export type ScopeChange = { field: string; value: unknown; reason?: string; evidence?: string };

export function readScopeChange(input: unknown): ScopeChange {
  const r = rec(input);
  const change = rec(r.change);
  return { field: String(change.field ?? ""), value: change.value, reason: str(r.reason), evidence: str(r.evidence) };
}

function rangeText(value: unknown): string | undefined {
  const r = rec(value);
  if (typeof r.min === "number" && typeof r.max === "number") return `${int(r.min)}–${int(r.max)} employees`;
  return undefined;
}

/** "Company size: 100–1,000 → 100–2,000 employees". */
export function describeChange(field: string, value: unknown, contract?: ContractView): string {
  switch (field) {
    case "employeeRange": {
      const next = rangeText(value) ?? "a different size range";
      const now = contract ? rangeText(contract.employeeRange) : undefined;
      return now ? `Company size: ${now} → ${next}` : `Company size: ${next}`;
    }
    case "months":
      return typeof value === "number"
        ? `Look back ${value} month${value === 1 ? "" : "s"}${contract ? ` instead of ${contract.months}` : ""}`
        : "Change how far back to look";
    case "hqCountries":
      return Array.isArray(value) ? `Company HQ in ${countryList(value.filter((v): v is string => typeof v === "string"))}` : value === "any" ? "Company HQ anywhere" : "Change where companies are based";
    case "industry":
      return typeof value === "string" ? `Also consider: ${value}` : "Consider an adjacent industry";
    case "maxCostDollars":
      return typeof value === "number" ? `Raise the spending limit${contract ? ` from ${money(contract.maxCostDollars)}` : ""} to ${money(value)}` : "Raise the spending limit";
    default:
      return "Change the targeting";
  }
}

/* ---------- handback suggestions ---------- */

/**
 * Rewrites codes inside harness-written text into words: "Rejections clustered around enterprise."
 * -> "...around large enterprise or public company.", "required_gate:x" and snake_case keys likewise.
 * Plain prose is left alone (words like "size" or "duplicate" are not codes there).
 */
export function plainText(text: string, contract?: ContractView): string {
  return text
    .replace(/required_gate:[a-z0-9_]+/g, (code) => reasonGroup(code, "", contract).toLowerCase())
    .replace(/(clustered around|reason:?)\s+([a-z_]+)(?=[.,;]|$)/g, (_m, lead: string, code: string) =>
      `${lead} ${code in REASON_GROUPS || code === "size" ? reasonGroup(code, "", contract).toLowerCase() : humanize(code).toLowerCase()}`)
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (word) => humanize(word).toLowerCase());
}

const CHANGE_FIELDS = ["employeeRange", "months", "hqCountries", "industry", "maxCostDollars"];

/** Whether a handback suggestion names a contract field (vs advice like "scope" / "none"). */
export function isChangeField(field: string): boolean {
  return CHANGE_FIELDS.includes(field);
}

/** Heading for a suggestion that has no one-click form. */
export function suggestionTitle(field: string, value: unknown, contract?: ContractView): string {
  if (["employeeRange", "months", "hqCountries", "industry", "maxCostDollars"].includes(field)) return describeChange(field, value, contract);
  return "Review your targeting";
}

export type SuggestionPatch = { label: string; cards: CardSet; maxCost?: number };

function isoList(value: unknown): string[] | undefined {
  if (value === "any") return [];
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && /^[A-Z]{2}$/.test(v))) return value as string[];
  return undefined;
}

/** Turns one handback suggestion into card edits. null = no one-click form; the user edits by hand. */
export function suggestionPatch(s: Handback["suggestions"][number], cards: CardSet, maxCost: number): SuggestionPatch | null {
  const value = s.value;
  switch (s.field) {
    case "employeeRange": {
      const r = rec(value);
      if (typeof r.min !== "number" || typeof r.max !== "number" || r.min > r.max) return null;
      const unknownPolicy = r.unknownPolicy === "reject" || r.unknownPolicy === "allow-if-not-enterprise" ? r.unknownPolicy : cards.size.unknownPolicy;
      return { label: `Use ${int(r.min)}–${int(r.max)} employees`, cards: { ...cards, size: { min: r.min, max: r.max, unknownPolicy } } };
    }
    case "months": {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) return null;
      return { label: `Look back ${value} months`, cards: { ...cards, recency: { months: value } } };
    }
    case "hqCountries": {
      const list = isoList(value);
      if (!list) return null;
      return { label: list.length ? `Companies based in ${countryList(list)}` : "Companies based anywhere", cards: { ...cards, geo: { hqCountries: list } } };
    }
    case "industry": {
      if (typeof value !== "string" || !value.trim()) return null;
      return { label: `Target ${value.trim()}`, cards: { ...cards, who: { ...cards.who, industry: value.trim() } } };
    }
    case "maxCostDollars": {
      if (typeof value !== "number" || value <= 0 || value > 5) return null;
      return { label: `Raise the limit to ${money(value)}`, cards, maxCost: Math.max(maxCost, value) };
    }
    default:
      return null;
  }
}

export function shortfallHeadline(shortfall: string, leadsFound: number, target?: number): string {
  const m = /^(\d+)\s+of\s+(\d+)$/.exec(shortfall.trim());
  if (m) return `Found ${m[1]} of the ${m[2]} leads you asked for`;
  if (target !== undefined) return `Found ${leadsFound} of the ${target} leads you asked for`;
  return shortfall;
}

/* ---------- leads ---------- */

export function leadSize(lead: AcceptedLead): { text: string; basis: string } {
  const details = rec(lead.details);
  if (typeof details.employees === "number") return { text: `${int(details.employees)} employees`, basis: "Quoted from a source" };
  const estimate = lead.enrichment?.employee_estimate;
  const n = typeof estimate === "number" ? estimate : typeof estimate === "string" ? Number(estimate.replace(/[^\d.]/g, "")) : NaN;
  if (Number.isFinite(n) && n > 0) return { text: `About ${int(n)}`, basis: "Estimate, not confirmed" };
  return { text: "Not published", basis: "Size unknown" };
}

export function leadDate(lead: AcceptedLead): string {
  const details = rec(lead.details);
  return typeof details.event_date === "string" ? details.event_date : lead.summary?.signal_date ?? "";
}

export function leadFit(lead: AcceptedLead): string {
  const description = str(lead.enrichment?.description) ?? str(lead.summary?.signal_summary) ?? "";
  const short = description.length > 160 ? `${description.slice(0, 157).trimEnd()}…` : description;
  const hq = str(rec(lead.details).hq) ?? str(lead.enrichment?.hq);
  return [short, hq ? `HQ: ${hq}.` : ""].filter(Boolean).join(" ");
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function leadsCsv(leads: AcceptedLead[], feedback: Record<string, { verdict?: "up" | "down"; reason?: string }> = {}): string {
  const head = ["Company", "Why now", "Event date", "Size", "Size basis", "Fit", "Source", "Your verdict", "Your note"];
  const rows = leads.map((lead) => {
    const size = leadSize(lead);
    const fb = feedback[lead.company];
    return [
      lead.company,
      lead.why_now,
      leadDate(lead),
      size.text,
      size.basis,
      leadFit(lead),
      isHttpUrl(lead.signal_url) ? lead.signal_url : "",
      fb?.verdict === "up" ? "Good lead" : fb?.verdict === "down" ? "Not a fit" : "",
      fb?.reason ?? "",
    ];
  });
  return [head, ...rows].map((row) => row.map((cell) => csvCell(String(cell ?? ""))).join(",")).join("\r\n");
}

/* ---------- screening (companies the agent passed over without submitting) ---------- */

export type Screened = { skipped: string[]; lookedUp: string[] };

export function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Companies named in lookup_company calls: looked up, or listed as skipped without a lookup. */
export function screenedFrom(events: AgentEvent[]): Screened {
  const skipped: string[] = [];
  const lookedUp: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool_call" || event.tool !== "lookup_company" || event.is_error === true) continue;
    const input = rec(event.input);
    const name = str(input.name);
    if (name && Object.keys(rec(event.seen)).length > 0) skipped.push(name); // skipped as already seen: never looked up
    else if (name) lookedUp.push(name);
    if (Array.isArray(input.skipped_companies)) skipped.push(...input.skipped_companies.filter((v): v is string => typeof v === "string" && v.trim().length > 0));
  }
  return { skipped: uniq(skipped), lookedUp: uniq(lookedUp) };
}

/** Looked-up companies that never reached a verdict (the agent dropped them after the lookup). */
export function droppedAfterLookup(screened: Screened, decided: string[]): string[] {
  const done = new Set(decided.map((c) => c.trim().toLowerCase()));
  return screened.lookedUp.filter((c) => !done.has(c.trim().toLowerCase()));
}

/* ---------- HTTP errors ---------- */

export type HttpErrorKind = "planner" | "run" | "other";

export type AllowanceView = { remainingRuns: number; remainingDollars: number };

const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * One specific sentence for every non-validation status the API documents. Returns undefined
 * for statuses that keep the caller's own generic copy (400, real 5xx).
 * 402 is an allowance problem, never a card/validation problem.
 */
export function httpErrorMessage(
  status: number,
  where: HttpErrorKind,
  opts: { code?: string; limitDollars?: number; runLimit?: number } = {},
): string | undefined {
  if (status === 402) {
    if (where === "run") {
      const n = opts.runLimit;
      return n !== undefined ? `You've used your ${n} free runs here.` : "You've used your free runs here.";
    }
    return `You've used your free allowance on this site (${dollars(opts.limitDollars ?? 2.5)}). Run it locally with your own keys (see README) or try a private window.`;
  }
  if (status === 503 && opts.code === "daily_budget_reached") return "This site has reached its daily budget; try tomorrow or run locally.";
  if (status === 429) return "Too many requests; wait a moment.";
  return undefined;
}

export function allowanceLine(v: AllowanceView): string {
  return `Free runs left on this site: ${v.remainingRuns} \u00b7 ${dollars(v.remainingDollars)}`;
}

/* ---------- unverified candidates ---------- */

export const CANDIDATES_HEADING = "Unverified candidates";
export const CANDIDATES_INTRO = "Not counted as leads. The page the agent found does not state something this search requires.";
export const UNVERIFIED_SUFFIX = (n: number): string => (n > 0 ? ` · ${n} unverified` : "");

/** Muted per-row reason, e.g. "Not counted: funding stage not stated on sybill.ai". */
export function candidateReason(missing: string): string {
  return `Not counted: ${missing.trim().replace(/[.\s]+$/, "")}`;
}

/* ---------- run trace (app/ui/trace-model.ts) ---------- */

const plural = (n: number, one: string, many: string): string => `${int(n)} ${n === 1 ? one : many}`;

/** Every new user-facing string of the run Trace. Plain words, numbers, no internal codes. */
export const TRACE = {
  step: (turn: number) => `Step ${turn}`,
  working: "Working on the next step",
  /** "2 searches · 3 lookups · 1 added · $0.06 · 5.2 s" */
  turnSummary: (s: { searches: number; lookups: number; added: number; cost: number; ms: number }): string =>
    [
      s.searches > 0 ? plural(s.searches, "search", "searches") : "",
      s.lookups > 0 ? plural(s.lookups, "lookup", "lookups") : "",
      s.added > 0 ? `${int(s.added)} added` : "",
      s.cost > 0 ? money(s.cost) : "",
      s.ms > 0 ? `${(s.ms / 1000).toFixed(1)} s` : "",
    ]
      .filter(Boolean)
      .join(" · "),

  searchResults: (n: number, total: number): string =>
    n === total ? plural(n, "result", "results") : `${int(n)} of ${plural(total, "result", "results")}`,
  lookingUp: (name: string | undefined): string => (name ? `Looking up ${name}` : "Looking up a candidate company"),
  skippedNonFits: (n: number): string => `Skipped ${plural(n, "obvious non-fit", "obvious non-fits")}`,
  noMatch: "Couldn't find this company online.",
  ruledOutAtLookup: (reason: string): string => `Ruled out at lookup: ${reason.replace(/^./, (c) => c.toLowerCase())}`,
  oneStepFailed: "One step didn't go through; moving on.",
  otherStep: "Ran a step",
  remembered: "Saved a note for next time",
  unknownEvent: "Something else happened during this step",

  recalledMemory: (seen: number, notes: number, prefs: number): string =>
    `Recalled memory: ${plural(seen, "company", "companies")} already seen, ${plural(notes, "note", "notes")}, ${plural(prefs, "piece", "pieces")} of your feedback`,
  condensed: (n: number): string => `Condensed ${plural(n, "older step", "older steps")} to stay within its working memory`,
  recovered: "Recovered an interrupted step",

  unverified: (company: string): string => `Unverified: ${company}`,
  addedToLeads: (company: string): string => `Added ${company}`,

  retry: (company: string, reason: string, outcome: string): string => {
    const why = reason === "network" ? "after a network error" : "because a quote wasn't on the page";
    if (outcome === "skipped_budget") return `Didn't retry the lookup for ${company}: the budget was nearly spent.`;
    if (reason === "network") {
      return outcome === "recovered"
        ? `Retried the lookup for ${company} once ${why}. It went through.`
        : `Retried the lookup for ${company} once ${why}. It failed again.`;
    }
    if (outcome === "kept_retry") return `Retried the lookup for ${company}: a quote wasn't on the page. The second try found it.`;
    if (outcome === "retry_failed") return `Retried the lookup for ${company}: a quote wasn't on the page. The retry failed, so the first result stands.`;
    return `Retried the lookup for ${company}: a quote wasn't on the page. Kept the first result.`;
  },
  retryState: (state: string): string =>
    (({ accepted: "fits", candidate: "unverified", rejected: "didn't fit", error: "error", ok: "loaded" }) as Record<string, string>)[state] ?? state,
  retryChange: (before: string, after: string): string => `${TRACE.retryState(before)} → ${TRACE.retryState(after)}`,

  handbackSuggestions: "What the agent suggests",
  cacheShare: (pct: number): string => `${int(pct)}% of the agent's reading came from cache`,

  /* evidence block */
  evidenceTitle: "Evidence",
  noQuote: "No quote captured",
  quoteLabels: { whyNow: "Why now", when: "When", size: "Size", basedIn: "Based in" },
  published: (date: string): string => `published ${date}`,

  /* checklist (Queue) */
  updatedAt: (turn: number, ago: number): string => `Updated at step ${turn} · ${plural(ago, "step", "steps")} ago`,
  leadsMismatch: (found: number, of: number | undefined, accepted: number): string =>
    `Leads found: ${of !== undefined ? `${int(found)} of ${int(of)}` : int(found)} (agent's note) · ${int(accepted)} accepted`,

  /* candidates / rejections sections */
  candidateNotStated: (what: string): string => `Page doesn't state: ${what.replace(/^./, (c) => c.toLowerCase())}`,
  candidateQuoteMissing: "A quote wasn't found on the page",
  candidateOther: "Couldn't be verified",
  turnedDownByChecks: (label: string): string => `Turned down by the checks: ${label}`,
  droppedAfterLookup: "Looked up, then dropped by the agent as a poor fit",
  skippedWithoutLookup: "Skipped as obvious non-fits, without a lookup",
} as const;

/** "Walmart, Maersk, Arvato and 12 more" (names beyond `max` collapse into a count). */
export function shortenList(items: string[], max = 4): string {
  return items.length > max ? joinWords([...items.slice(0, max - 1), `${items.length - (max - 1)} more`]) : joinWords(items);
}
