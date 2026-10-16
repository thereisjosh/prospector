/**
 * The run ledger as data (docs/UI-REWORK.md §1b/§1c/§1a): a pure mapping from the agent's event log
 * and the run snapshot to the tree the Trace renders. No React, no I/O. Every string is in copy.ts.
 *
 * Contract: no event is dropped silently. Events §1b marks "not shown" are counted in `hidden`;
 * anything the mapper does not know becomes a generic line and is counted in `unmapped`.
 */
import type { AgentEvent } from "../../src/agent/events";
import type { AcceptedLead } from "../../src/agent/state";
import {
  CONTACTS,
  TRACE,
  TRACE_LIVE,
  candidateReason,
  eventLine,
  formatDate,
  groupRejections,
  host,
  humanize,
  isHttpUrl,
  plainText,
  reasonGroup,
  shortenList,
  shortfallHeadline,
  stopSentence,
  type ContractView,
} from "./copy";
import type { RunSnapshot } from "./types";

/* ---------- types ---------- */

/** A semantic icon name; the renderer maps it to a component. */
export type TraceIcon =
  | "search"
  | "building"
  | "memory"
  | "file"
  | "check"
  | "x"
  | "list"
  | "retry"
  | "approval"
  | "stop"
  | "alert"
  | "layers"
  | "wrench"
  | "flag"
  | "note"
  | "clock";

export type TraceStatus = "running" | "error" | "pending";

export type EvidenceQuote = { label: string; quote: string; source?: string; date?: string };
export type EvidenceGate = { key: string; label: string; required: boolean; passed: boolean };
export type EvidenceDetail = {
  kind: "evidence";
  company: string;
  /** Host of the signal page, when the lead has a safe link. */
  source?: string;
  published?: string;
  /** Verbatim quotes only. Empty for runs recorded before quotes were captured. */
  quotes: EvidenceQuote[];
  /** Standard rows with no captured quote ("No quote captured"); never synthesised. */
  missing: string[];
  gates: EvidenceGate[];
  size?: { employees?: number; basis?: string; range?: string; inRange?: boolean };
  sizeQuoteMatch?: "phrase" | "number_adjacent";
  /** Verified contacts only: the page span naming the person and their title, and the page host. Inferred ones carry no quote. */
  contacts?: EvidenceContact[];
};

export type EvidenceContact = { name: string; quote: string; titleQuote: string; source: string; url: string; published?: string };

export type TraceDetail = EvidenceDetail | { kind: "text"; text: string } | { kind: "json"; value: unknown };

export type TraceLine = {
  id: string;
  /** Machine kind for the renderer and tests: "search", "lookup", "lookup_seen", "verdict_ok", ... */
  kind: string;
  icon: TraceIcon;
  title: string;
  description?: string;
  status?: TraceStatus;
  detail?: TraceDetail;
  children?: TraceLine[];
  /**
   * A tool call that has started and not settled (`tool_started` with no `tool_call` yet). The first
   * one in flight is `status: "running"` (the one shimmer); the rest are `"pending"`. When its
   * `tool_call` arrives the line is replaced in place: same id, same position.
   */
  inflight?: true;
};

/** Live-only input to the model: the model's visible text for `turn`, as it streams (never persisted). */
export type TraceLive = { streaming?: { turn: number; text: string } | null };

export type TraceTurn = {
  turn: number;
  title: string;
  description?: string;
  status: "running" | "error" | "pending" | undefined;
  lines: TraceLine[];
};

export type TraceTree = {
  turns: TraceTurn[];
  /** Unknown event kinds and unknown tools: each got a generic line. */
  unmapped: number;
  unmappedKinds: string[];
  /** Events the ledger intentionally does not show (policy, turn_end, token_count_estimated, feedback). */
  hidden: number;
  /** cache_read / (cache_read + cache_creation + input) over all model calls; absent without token data. */
  cache?: { read: number; written: number; uncached: number; share: number; text: string };
};

/** What the model reads from the snapshot. A RunSnapshot satisfies it. */
export type TraceSnapshot = Pick<RunSnapshot, "status" | "leads" | "rejected" | "todo" | "contract"> &
  Partial<Pick<RunSnapshot, "candidates" | "screened" | "handback" | "counters">>;

/* ---------- small helpers ---------- */

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
const norm = (s: string) => s.trim().toLowerCase();

/* ---------- evidence (§1c) ---------- */

function gateLabel(key: string, contract?: ContractView): string {
  const question = contract?.gateFields?.find((g) => g.key === key)?.question;
  const text = (question ?? humanize(key.replace(/^is_/, ""))).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\?$/, "").trim();
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

/** The Code Block content for one accepted lead. Runs without quotes yield `quotes: []`, never a throw. */
export function evidenceFor(lead: AcceptedLead, contract?: ContractView): EvidenceDetail {
  const summary = rec(lead.summary);
  const enrichment = rec(lead.enrichment);
  const details = rec(lead.details);
  const evidence = rec(lead.evidence);
  const link = isHttpUrl(lead.signal_url) ? lead.signal_url : undefined;
  const source = link ? host(link) : undefined;
  const publishedRaw = str(evidence.signal_published_date) ?? str(summary.signal_date);
  const published = publishedRaw ? formatDate(publishedRaw) || undefined : undefined;

  const quotes: EvidenceQuote[] = [];
  const missing: string[] = [];
  const row = (label: string, quote: unknown, extra: { source?: string; date?: string } = {}) => {
    const q = str(quote);
    if (q) quotes.push({ label, quote: q, ...(extra.source ? { source: extra.source } : {}), ...(extra.date ? { date: extra.date } : {}) });
    else missing.push(label);
  };
  row(TRACE.quoteLabels.whyNow, summary.signal_quote, { source, date: published });
  row(TRACE.quoteLabels.when, summary.signal_date_quote, { source, date: published });
  row(TRACE.quoteLabels.size, enrichment.employee_estimate_source);
  row(TRACE.quoteLabels.basedIn, enrichment.hq_quote);

  const required = Array.isArray(details.required_gates_passed) ? details.required_gates_passed.filter((k): k is string => typeof k === "string") : [];
  const optional = Array.isArray(details.optional_gates_passed) ? details.optional_gates_passed.filter((k): k is string => typeof k === "string") : [];
  const gates: EvidenceGate[] = [
    ...required.map((key) => ({ key, label: gateLabel(key, contract), required: true, passed: true })),
    ...optional.map((key) => ({ key, label: gateLabel(key, contract), required: false, passed: true })),
  ];
  for (const gate of gates) row(gate.label, enrichment[`${gate.key}_quote`]);

  const employees = typeof details.employees === "number" ? details.employees : undefined;
  const range = contract?.employeeRange;
  const size =
    employees !== undefined || str(details.size_basis)
      ? {
          ...(employees !== undefined ? { employees } : {}),
          ...(str(details.size_basis) ? { basis: str(details.size_basis) } : {}),
          ...(range ? { range: `${range.min.toLocaleString("en-US")}–${range.max.toLocaleString("en-US")}` } : {}),
          ...(employees !== undefined && range ? { inRange: employees >= range.min && employees <= range.max } : {}),
        }
      : undefined;
  const match = details.size_quote_match;
  const contacts: EvidenceContact[] = (lead.contacts?.contacts ?? []).flatMap((c) =>
    c.tier === "verified" && c.evidence && isHttpUrl(c.evidence.url)
      ? [{ name: c.name, quote: c.evidence.quote, titleQuote: c.evidence.title_quote, source: host(c.evidence.url), url: c.evidence.url, ...(c.evidence.published ? { published: c.evidence.published } : {}) }]
      : [],
  );
  return {
    kind: "evidence",
    company: lead.company,
    ...(source ? { source } : {}),
    ...(published ? { published } : {}),
    quotes,
    missing,
    gates,
    ...(size ? { size } : {}),
    ...(match === "phrase" || match === "number_adjacent" ? { sizeQuoteMatch: match } : {}),
    ...(contacts.length > 0 ? { contacts } : {}),
  };
}

/* ---------- the tree (§1b) ---------- */

type Ctx = {
  contract: ContractView;
  leads: AcceptedLead[];
  candidates: NonNullable<RunSnapshot["candidates"]>;
};

function findLead(ctx: Ctx, company: string, turn: number): AcceptedLead | undefined {
  const same = ctx.leads.filter((l) => norm(l.company) === norm(company));
  return same.find((l) => l.turn === turn) ?? same[0];
}

function line(id: string, kind: string, icon: TraceIcon, title: string, extra: Partial<TraceLine> = {}): TraceLine {
  return { id, kind, icon, title, ...extra };
}

const NAME_LIST_MAX = 4;

function toolCallLine(event: AgentEvent, id: string, ctx: Ctx): { line: TraceLine | null; unknown?: boolean } {
  const input = rec(event.input);
  const tool = String(event.tool ?? "");
  const summary = str(event.resultSummary);
  if (event.is_error === true) {
    const text = eventLine(event, ctx.contract)?.text ?? TRACE.oneStepFailed;
    return { line: line(id, "tool_error", "alert", text, { status: "error" }) };
  }
  switch (tool) {
    case "search_signals": {
      const m = summary ? /^(\d+) results? of (\d+)(?::\s*(.*))?$/.exec(summary) : null;
      const names = m?.[3]?.trim();
      return {
        line: line(id, "search", "search", eventLine(event, ctx.contract)!.text, {
          ...(m ? { description: TRACE.searchResults(Number(m[1]), Number(m[2])) } : {}),
          ...(names ? { detail: { kind: "text" as const, text: names } } : {}),
        }),
      };
    }
    case "lookup_company": {
      const name = str(input.name);
      const seen = rec(event.seen);
      if (name && Object.keys(seen).length > 0) {
        return { line: line(id, "lookup_seen", "memory", eventLine(event, ctx.contract)!.text) };
      }
      const skipped = Array.isArray(input.skipped_companies) ? input.skipped_companies.filter((s): s is string => typeof s === "string") : [];
      const screened = summary ? /\bscreened=([a-z_:0-9]+)/.exec(summary)?.[1] : undefined;
      const noMatch = summary?.startsWith("no_match:") === true;
      const description = noMatch ? TRACE.noMatch : screened ? TRACE.ruledOutAtLookup(reasonGroup(screened, "", ctx.contract)) : undefined;
      const children = skipped.length
        ? [line(`${id}.skipped`, "skipped", "building", TRACE.skippedNonFits(skipped.length), {
            description: shortenList(skipped, NAME_LIST_MAX),
            detail: { kind: "text" as const, text: skipped.join(", ") },
          })]
        : undefined;
      return { line: line(id, "lookup", "building", TRACE.lookingUp(name), { ...(description ? { description } : {}), ...(children ? { children } : {}) }) };
    }
    case "read_page":
      return { line: line(id, "read_page", "file", eventLine(event, ctx.contract)!.text) };
    case "update_todo": {
      const markdown = str(input.markdown);
      return { line: line(id, "todo", "list", eventLine(event, ctx.contract)!.text, markdown ? { detail: { kind: "text", text: markdown } } : {}) };
    }
    case "finish":
      return { line: line(id, "finish", "flag", eventLine(event, ctx.contract)!.text) };
    case "remember":
      return { line: line(id, "remember", "memory", TRACE.remembered) };
    case "find_contacts": {
      const m = summary ? /verified=(\d+) · inferred=(\d+)/.exec(summary) : null;
      return {
        line: line(id, "contacts", "search", CONTACTS.looking(str(input.company)), m ? { description: CONTACTS.found(Number(m[1]), Number(m[2])) } : {}),
      };
    }
    case "submit_lead":
      return { line: null }; // the verdict line says what happened
    default:
      return { line: line(id, "tool_unknown", "wrench", TRACE.otherStep), unknown: true };
  }
}

function verdictLine(event: AgentEvent, id: string, ctx: Ctx): TraceLine {
  const company = str(event.company) ?? "A company";
  if (event.ok === true) {
    const lead = findLead(ctx, company, num(event.turn));
    return line(id, "verdict_ok", "check", eventLine(event, ctx.contract)!.text, {
      ...(lead
        ? { children: [line(`${id}.evidence`, "evidence", "file", TRACE.evidenceTitle, { detail: evidenceFor(lead, ctx.contract) })] }
        : {}),
    });
  }
  const code = String(event.code ?? "");
  const candidate = ctx.candidates.find((c) => norm(c.company) === norm(company) && c.code === code);
  if (candidate) {
    return line(id, "verdict_unverified", "note", TRACE.unverified(company), { description: candidateReason(candidate.missing) });
  }
  const base = eventLine(event, ctx.contract)!;
  const kind = event.code === "already_seen" && Object.keys(rec(event.seen)).length > 0 ? "verdict_seen" : "verdict_rejected";
  return line(id, kind, kind === "verdict_seen" ? "memory" : "x", base.text); // neutral: a turn-down is not an error
}

function retryLine(event: AgentEvent, id: string): TraceLine {
  const company = str(event.company) ?? "this company";
  const reason = String(event.reason ?? "");
  const outcome = String(event.outcome ?? "");
  const before = str(event.before);
  const after = str(event.after);
  return line(id, "lookup_retry", "retry", TRACE.retry(company, reason, outcome), {
    ...(outcome === "retry_failed" ? { status: "error" as const } : {}),
    ...(before && after ? { description: TRACE.retryChange(before, after) } : {}),
  });
}

function startedLine(event: AgentEvent, id: string): TraceLine {
  const tool = String(event.tool ?? "");
  const kinds: Record<string, [string, TraceIcon]> = {
    search_signals: ["search", "search"],
    lookup_company: ["lookup", "building"],
    read_page: ["read_page", "file"],
    update_todo: ["todo", "list"],
    finish: ["finish", "flag"],
    remember: ["remember", "memory"],
    submit_lead: ["submit", "check"],
    find_contacts: ["contacts", "search"],
  };
  const [kind, icon] = kinds[tool] ?? ["tool_started", "wrench"];
  return line(id, kind, icon, TRACE_LIVE.started(tool, rec(event.input)), { inflight: true });
}

export function traceModel(events: AgentEvent[], snapshot: TraceSnapshot, live: TraceLive = {}): TraceTree {
  const ctx: Ctx = { contract: snapshot.contract, leads: snapshot.leads ?? [], candidates: snapshot.candidates ?? [] };
  const byTurn = new Map<number, { turn: number; lines: TraceLine[]; searches: number; lookups: number; added: number; cost: number; ms: number; error: boolean }>();
  const turnOf = (n: number) => {
    let t = byTurn.get(n);
    if (!t) byTurn.set(n, (t = { turn: n, lines: [], searches: 0, lookups: 0, added: 0, cost: 0, ms: 0, error: false }));
    return t;
  };
  const lookups: Array<{ line: TraceLine; turn: number; toolUseId?: string; company: string }> = [];
  const retries: Array<{ line: TraceLine; turn: number; toolUseId?: string; company: string }> = [];
  const openApprovals = new Map<string, TraceLine>();
  // Tool calls in flight, by tool_use id, in the order they started.
  const inFlight = new Map<string, { line: TraceLine; turn: number }>();
  const modelCalled = new Set<number>();
  let unmapped = 0;
  const unmappedKinds: string[] = [];
  let hidden = 0;
  const cache = { read: 0, written: 0, uncached: 0 };
  let sawTokens = false;
  let stopped = false;
  const noteUnmapped = (what: string) => {
    unmapped += 1;
    if (!unmappedKinds.includes(what)) unmappedKinds.push(what);
  };

  events.forEach((event, index) => {
    const t = turnOf(num(event.turn));
    const id = `t${t.turn}.${index}`;
    // retryExaCost is informational: the lookup's tool_call exaCost already includes the retry (src/agent/tools.ts).
    t.cost += num(event.claudeCost) + num(event.exaCost);
    switch (event.kind) {
      case "model_call": {
        if (event.handback !== true) modelCalled.add(t.turn);
        t.ms += num(event.latencyMs);
        const tokens = rec(event.tokens);
        if (event.tokens !== undefined) {
          sawTokens = true;
          cache.read += num(tokens.cache_read);
          cache.written += num(tokens.cache_creation);
          cache.uncached += num(tokens.input);
        }
        return;
      }
      case "policy":
      case "turn_end":
      case "token_count_estimated":
      case "stream_fallback":
      case "feedback":
        hidden += 1;
        return;
      case "tool_started": {
        const key = str(event.toolUseId) ?? id;
        const l = startedLine(event, `t${t.turn}.u.${key}`);
        inFlight.set(key, { line: l, turn: t.turn });
        t.lines.push(l);
        return;
      }
      case "memory_recalled": {
        const prefs = rec(event.preferences);
        const notes = rec(event.notes);
        t.lines.push(
          line(id, "memory_recalled", "memory", TRACE.recalledMemory(num(event.seen), num(notes.included), num(prefs.included)), {
            detail: { kind: "json", value: { seen: event.seen, preferences: event.preferences, notes: event.notes, includedIds: event.includedIds ?? [] } },
          }),
        );
        return;
      }
      case "tool_call": {
        const key = str(event.toolUseId);
        const open = key ? inFlight.get(key) : undefined;
        const { line: l, unknown } = toolCallLine(event, open ? open.line.id : id, ctx);
        if (unknown) noteUnmapped(`tool:${String(event.tool)}`);
        if (event.is_error !== true) {
          if (event.tool === "search_signals") t.searches += 1;
          if (event.tool === "lookup_company" && Object.keys(rec(event.seen)).length === 0) t.lookups += 1;
        }
        if (open) {
          // The started line resolves in place; its tool_started event is folded into this line.
          inFlight.delete(key!);
          hidden += 1;
          const host = turnOf(open.turn).lines;
          const at = host.indexOf(open.line);
          if (!l) {
            if (at >= 0) host.splice(at, 1);
            return;
          }
          if (at >= 0) host[at] = l;
          else t.lines.push(l);
        } else {
          if (!l) return;
          t.lines.push(l);
        }
        if (l.kind === "lookup" || l.kind === "lookup_seen") {
          lookups.push({ line: l, turn: t.turn, toolUseId: str(event.toolUseId), company: str(rec(event.input).name) ?? "" });
        }
        return;
      }
      case "lookup_retry": {
        const l = retryLine(event, id);
        retries.push({ line: l, turn: t.turn, toolUseId: str(event.toolUseId), company: str(event.company) ?? "" });
        t.lines.push(l);
        return;
      }
      case "submit_verdict": {
        if (event.ok === true) t.added += 1;
        t.lines.push(verdictLine(event, id, ctx));
        return;
      }
      case "approval_request": {
        const text = eventLine(event, ctx.contract)!.text;
        const l = line(id, "approval_request", "approval", text, { status: "pending", detail: { kind: "json", value: event.input ?? null } });
        openApprovals.set(String(event.tool ?? ""), l);
        t.lines.push(l);
        return;
      }
      case "decision": {
        const text = eventLine(event, ctx.contract)!.text;
        const open = openApprovals.get(String(event.tool ?? "")) ?? (openApprovals.size === 1 ? [...openApprovals.values()][0] : undefined);
        if (open) {
          // The request resolves in place: one line, "You approved."
          open.kind = "decision";
          open.title = text;
          open.icon = "check";
          delete open.status;
          for (const [k, v] of openApprovals) if (v === open) openApprovals.delete(k);
        } else {
          t.lines.push(line(id, "decision", "check", text));
        }
        return;
      }
      case "context_trimmed":
        t.lines.push(line(id, "context_trimmed", "layers", TRACE.condensed(num(event.droppedTurns)), { detail: { kind: "json", value: { droppedTurns: event.droppedTurns, droppedTokens: event.droppedTokens, keptTokens: event.keptTokens } } }));
        return;
      case "turn_repaired":
        t.lines.push(line(id, "turn_repaired", "wrench", TRACE.recovered));
        return;
      case "stop":
        stopped = true;
        t.lines.push(line(id, "stop", "stop", stopSentence(str(event.reason), str(event.status))));
        return;
      case "error":
        t.error = true;
        t.lines.push(line(id, "error", "alert", eventLine(event, ctx.contract)!.text, { status: "error" }));
        return;
      default:
        noteUnmapped(String((event as { kind?: unknown }).kind));
        t.lines.push(line(id, "unknown", "note", TRACE.unknownEvent, { detail: { kind: "json", value: event } }));
        return;
    }
  });

  // Retries nest under the lookup they belong to (by tool call id, else company within the turn).
  for (const retry of retries) {
    const target =
      lookups.find((l) => l.line.kind === "lookup" && retry.toolUseId && l.toolUseId === retry.toolUseId) ??
      lookups.find((l) => l.line.kind === "lookup" && l.turn === retry.turn && retry.company && norm(l.company) === norm(retry.company));
    if (!target) continue;
    for (const t of byTurn.values()) {
      const at = t.lines.indexOf(retry.line);
      if (at >= 0) t.lines.splice(at, 1);
    }
    (target.line.children ??= []).push({ ...retry.line, id: `${target.line.id}.retry` });
  }

  const running = snapshot.status === "running" && !stopped;
  const waiting = snapshot.status === "awaiting_approval";
  const streaming = running && live.streaming && live.streaming.text.trim() ? live.streaming : undefined;
  // Streamed text can arrive before the new turn's first event does.
  if (streaming && (!byTurn.size || streaming.turn > Math.max(...byTurn.keys()))) turnOf(streaming.turn);
  const lastTurnNo = byTurn.size ? Math.max(...byTurn.keys()) : snapshot.counters?.turns ? Math.max(snapshot.counters.turns, 1) : 1;
  if (running || waiting) turnOf(lastTurnNo);

  // Calls still in flight: on the live turn the earliest started is the running line, the rest wait;
  // anywhere else (the run stopped, or a crash left them) they never finished.
  let shimmer = false;
  for (const { line: l, turn } of inFlight.values()) {
    if (running && turn === lastTurnNo) {
      l.status = shimmer ? "pending" : "running";
      shimmer = true;
    } else {
      delete l.inflight;
      l.description = TRACE_LIVE.interrupted;
    }
  }

  const turns: TraceTurn[] = [...byTurn.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((t) => {
      const last = t.turn === lastTurnNo;
      const lines = [...t.lines];
      // The one in-flight call: a turn that has started and not finished.
      // A tool call in flight is the running line; otherwise the model is working (and may be streaming text).
      if (running && last && !shimmer) {
        const text = streaming && streaming.turn === t.turn && !modelCalled.has(t.turn) ? TRACE_LIVE.streamTail(streaming.text) : "";
        lines.push(line(`t${t.turn}.live`, "working", "clock", TRACE.working, { status: "running", ...(text ? { description: text } : {}) }));
      }
      const description = TRACE.turnSummary({ searches: t.searches, lookups: t.lookups, added: t.added, cost: t.cost, ms: t.ms });
      return {
        turn: t.turn,
        title: TRACE.step(t.turn),
        ...(description ? { description } : {}),
        status: running && last ? "running" : waiting && last ? "pending" : t.error ? "error" : undefined,
        lines,
      };
    });

  // The handback is the last thing the run says.
  if (snapshot.handback && turns.length) {
    const h = snapshot.handback;
    const suggestions = (h.suggestions ?? []).filter((s) => s.why).map((s, i) => line(`handback.${i}`, "handback_suggestion", "note", plainText(s.why, ctx.contract)));
    turns[turns.length - 1]!.lines.push(
      line("handback", "handback", "flag", shortfallHeadline(h.shortfall, ctx.leads.length, ctx.contract.targetLeads), {
        ...(suggestions.length ? { description: TRACE.handbackSuggestions, children: suggestions } : {}),
      }),
    );
  }

  const total = cache.read + cache.written + cache.uncached;
  const share = total > 0 ? cache.read / total : 0;
  return {
    turns,
    unmapped,
    unmappedKinds,
    hidden,
    ...(sawTokens && total > 0 ? { cache: { read: cache.read, written: cache.written, uncached: cache.uncached, share, text: TRACE.cacheShare(Math.round(share * 100)) } } : {}),
  };
}

/* ---------- checklist (Queue, §1a) ---------- */

export type ChecklistItem =
  | { kind: "todo" | "done"; text: string }
  | { kind: "note"; label: string; text: string }
  | { kind: "text"; text: string };

export type ChecklistModel = {
  items: ChecklistItem[];
  /** Turn of the last update_todo; absent when the agent never wrote one. */
  updatedAtTurn?: number;
  currentTurn: number;
  stepsAgo?: number;
  updatedLine?: string;
  /** The agent's own "Leads found: N of M" number. */
  agentLeadsFound?: number;
  agentLeadsTarget?: number;
  /** leads.length > the agent's note. */
  stale: boolean;
  staleLine?: string;
};

function stripMd(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`/g, "").trim();
}

export function checklistModel(events: AgentEvent[], snapshot: Pick<TraceSnapshot, "todo" | "leads" | "counters">): ChecklistModel {
  let lastMarkdown: string | undefined;
  let updatedAtTurn: number | undefined;
  let currentTurn = snapshot.counters?.turns ?? 0;
  for (const e of events) {
    currentTurn = Math.max(currentTurn, num(e.turn));
    if (e.kind === "tool_call" && e.tool === "update_todo" && e.is_error !== true) {
      updatedAtTurn = num(e.turn);
      lastMarkdown = str(rec(e.input).markdown) ?? lastMarkdown;
    }
  }
  const markdown = str(snapshot.todo) ?? lastMarkdown ?? "";
  const items: ChecklistItem[] = [];
  for (const raw of markdown.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    const task = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(l);
    if (task) {
      items.push({ kind: task[1] === " " ? "todo" : "done", text: stripMd(task[2] ?? "") });
      continue;
    }
    const key = /^(?:[-*]\s+)?\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(l);
    if (key) {
      items.push({ kind: "note", label: (key[1] ?? "").replace(/:$/, "").trim(), text: stripMd(key[2] ?? "") });
      continue;
    }
    items.push({ kind: "text", text: stripMd(l.replace(/^(?:[-*]|\d+\.|#{1,6})\s+/, "")) });
  }
  const found = items.find((i): i is Extract<ChecklistItem, { kind: "note" }> => i.kind === "note" && /^leads found$/i.test(i.label));
  const m = found ? /(\d+)(?:\s*(?:of|\/)\s*(\d+))?/.exec(found.text) : null;
  const agentLeadsFound = m ? Number(m[1]) : undefined;
  const agentLeadsTarget = m?.[2] ? Number(m[2]) : undefined;
  const accepted = snapshot.leads?.length ?? 0;
  const stale = agentLeadsFound !== undefined && accepted > agentLeadsFound;
  const stepsAgo = updatedAtTurn !== undefined ? Math.max(0, currentTurn - updatedAtTurn) : undefined;
  return {
    items,
    ...(updatedAtTurn !== undefined ? { updatedAtTurn, stepsAgo, updatedLine: TRACE.updatedAt(updatedAtTurn, stepsAgo ?? 0) } : {}),
    currentTurn,
    ...(agentLeadsFound !== undefined ? { agentLeadsFound } : {}),
    ...(agentLeadsTarget !== undefined ? { agentLeadsTarget } : {}),
    stale,
    ...(stale ? { staleLine: TRACE.leadsMismatch(agentLeadsFound!, agentLeadsTarget, accepted) } : {}),
  };
}

/* ---------- candidates (§1a) ---------- */

export type CandidateItem = { company: string; whyNow: string; reason: string; sourceUrl?: string; sourceHost?: string };
export type CandidateSection = { id: string; label: string; count: number; items: CandidateItem[] };

function missingFactLabel(code: string, contract?: ContractView): string {
  if (code.startsWith("required_gate:")) {
    const key = code.slice("required_gate:".length);
    const question = contract?.gateFields?.find((g) => g.key === key)?.question;
    return TRACE.candidateNotStated((question ?? humanize(key)).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\?$/, "").trim());
  }
  if (code === "quote_not_in_page") return TRACE.candidateQuoteMissing;
  const group = reasonGroup(code, "", contract);
  return group === "Didn't pass the checks" ? TRACE.candidateOther : group;
}

/** Unverified candidates, one section per missing fact. Section counts sum to `candidates.length`. */
export function candidatesModel(snapshot: Pick<TraceSnapshot, "candidates" | "contract">): CandidateSection[] {
  const sections = new Map<string, CandidateSection>();
  for (const c of snapshot.candidates ?? []) {
    const label = missingFactLabel(c.code, snapshot.contract);
    const section = sections.get(label) ?? { id: `cand.${sections.size}`, label, count: 0, items: [] };
    const safe = isHttpUrl(c.signal_url);
    section.items.push({
      company: c.company,
      whyNow: c.why_now,
      reason: candidateReason(c.missing),
      ...(safe ? { sourceUrl: c.signal_url, sourceHost: host(c.signal_url) } : {}),
    });
    section.count += 1;
    sections.set(label, section);
  }
  return [...sections.values()].sort((a, b) => b.count - a.count);
}

/* ---------- rejections (§1a) ---------- */

export type RejectionSection = {
  id: string;
  kind: "checks" | "lookup" | "dropped" | "skipped";
  label: string;
  count: number;
  /** Companies shown (lookup groups are capped upstream, so `count` can exceed `items.length`). */
  items: Array<{ company: string; phrase?: string }>;
};

/**
 * "Considered but not added": one section per reason with its count. `dropped` and `skipped` are the
 * after-the-run extras RunView derives from the event log; omit them mid-run.
 */
export function rejectionsModel(
  snapshot: Pick<TraceSnapshot, "rejected" | "screened" | "contract">,
  extras: { dropped?: string[]; skipped?: string[] } = {},
): RejectionSection[] {
  const out: RejectionSection[] = [];
  for (const g of groupRejections(snapshot.rejected ?? [], snapshot.contract)) {
    out.push({ id: `rej.checks.${out.length}`, kind: "checks", label: TRACE.turnedDownByChecks(g.label), count: g.items.length, items: g.items });
  }
  for (const g of snapshot.screened ?? []) {
    if (g.count <= 0) continue;
    out.push({
      id: `rej.lookup.${out.length}`,
      kind: "lookup",
      label: TRACE.ruledOutAtLookup(reasonGroup(g.code, "", snapshot.contract)),
      count: g.count,
      items: g.companies.map((company) => ({ company })),
    });
  }
  if (extras.dropped?.length) out.push({ id: "rej.dropped", kind: "dropped", label: TRACE.droppedAfterLookup, count: extras.dropped.length, items: extras.dropped.map((company) => ({ company })) });
  if (extras.skipped?.length) out.push({ id: "rej.skipped", kind: "skipped", label: TRACE.skippedWithoutLookup, count: extras.skipped.length, items: extras.skipped.map((company) => ({ company })) });
  return out;
}
