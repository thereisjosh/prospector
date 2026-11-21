/**
 * The contacts phase (src/agent/loop.ts contactsPhaseTurn, docs/SPEC-agent.md §5b): when the target is reached
 * while accepted leads lack contacts, the run gets ceil(leads/3) more turns, nudged, budget-capped; a
 * find_contacts result counts as progress. Fake model client and fake findContacts: no network, no keys.
 */
import { rm } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "contacts-phase-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  return { root, runs: join(root, "runs"), workspaces: join(root, "workspaces") };
});

import type { AgentEvent } from "../src/agent/events";
import type { LeadChecker } from "../src/agent/gate-port";
import { contactsPhaseTurn, contactsReserveDollars, limitReason, step } from "../src/agent/loop";
import { createRunState, type AcceptedLead, type RunState } from "../src/agent/state";
import { CONTACT_LIMITS, type FindContactsInput, type FindContactsResult } from "../src/contacts";
import { squashName } from "../src/gates";
import type { SearchPlan } from "../src/plan";

const NOW = new Date("2026-10-16T00:00:00.000Z");
const ROLES = ["VP of Operations"];

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "Phase test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
  buyerRoles: ROLES,
  ...over,
});

const msg = (content: unknown[], stop_reason = "tool_use") => ({
  id: crypto.randomUUID(),
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const decisiveCheck = (pageUrl: string, answerQuote: string) => ({ question: "Is this company an operator?", answer_quote: answerQuote, page_url: pageUrl });

/** What each model call was sent, serialised at call time (the history array keeps growing after). */
const sentAt: string[] = [];

function client(...responses: unknown[]) {
  return {
    messages: {
      create: vi.fn(async (params: { messages: unknown[] }) => {
        sentAt.push(JSON.stringify(params.messages.at(-1)));
        const next = responses.shift();
        if (!next) throw new Error("no scripted response left");
        return next;
      }),
    },
  };
}

const checker: LeadChecker = (_p, input) => ({
  ok: true,
  details: { key: squashName(input.company), event_date: "2026-10-01", date_source: "signal", size_basis: "quoted", required_gates_passed: ["is_operator"], optional_gates_passed: [], hq: "US", multiplier: 1, fit_reason: "fit" },
});

const lead = (company: string, withContacts = false): AcceptedLead => ({
  company,
  signal_url: `https://news.example/${squashName(company)}`,
  why_now: "new warehouse",
  summary: { company_name: company, signal_type: "expansion", signal_summary: "new site", signal_date: "2026-10-01" },
  details: {},
  turn: 1,
  ...(withContacts ? { contacts: { at: NOW.toISOString(), roles: ROLES, contacts: [], cost: 0.02 } } : {}),
});

/** A run past its strategy, with `leads` accepted and the fourth company ready to submit. */
function runState(leads: AcceptedLead[], over: Partial<SearchPlan> = {}, targetLeads = 3): RunState {
  const s = createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan: plan(over), targetLeads, maxCostDollars: 1, createdAt: NOW.toISOString() });
  s.strategyApproved = true;
  s.leads.push(...leads);
  s.caches.signalsByUrl["https://news.example/cco"] = {
    url: "https://news.example/cco",
    title: "C Co opens a warehouse",
    text: "C Co opens a warehouse.",
    summary: { company_name: "C Co", signal_type: "expansion", signal_summary: "opened", signal_date: "2026-10-01" },
  };
  s.caches.enrichmentByName.cco = { summary: { description: "C Co" }, url: "https://cco.example" };
  s.caches.readPages["https://news.example/cco"] = { title: "C Co opens a warehouse", text: "C Co opens a warehouse for customers." };
  // The model's last turn was answered: history ends on a user message, as after any tool turn.
  s.messages.push({ role: "assistant", content: [{ type: "text", text: "working" }] }, { role: "user", content: [{ type: "text", text: "Spend: $0.10" }] });
  return s;
}

const found = (n = 1): FindContactsResult => ({
  contacts: Array.from({ length: n }, (_, i) => ({ name: `Person ${i} Smith`, tier: "inferred" as const, role: "VP of Operations", why: "VP of Operations", profile_url: `https://www.linkedin.com/in/p${i}`, found_via: "people_index" as const, code: "contact_unverified" as const })),
  cost: 0.02,
  checked: [],
});

const phaseEvents = (events: AgentEvent[]) => events.filter((e) => e.kind === "policy" && e.check === "contacts_phase");

afterEach(async () => {
  await rm(tmp.runs, { recursive: true, force: true });
  await rm(tmp.workspaces, { recursive: true, force: true });
});
afterAll(() => rm(tmp.root, { recursive: true, force: true }));

describe("contacts phase", () => {
  it("target 3 reached on turn k: one extra turn (ceil(3/3)) looks up contacts, nudged and budget-capped, then stops target_leads", async () => {
    const s = runState([lead("A Co"), lead("B Co")]);
    const remaining: number[] = [];
    const findContacts = vi.fn(async (input: FindContactsInput) => {
      remaining.push(input.guard!.remaining);
      // The real lookup settles its spend on the guard.
      input.guard!.reserve(CONTACT_LIMITS.maxCostDollars);
      input.guard!.settle(CONTACT_LIMITS.maxCostDollars, 0.02);
      return found(1);
    });
    const c = client(
      msg([tool("sub", "submit_lead", { company: "C Co", signal_url: "https://news.example/cco", why_now: "new warehouse", decisive_check: decisiveCheck("https://news.example/cco", "C Co opens a warehouse for customers.") })]),
      msg([tool("c1", "find_contacts", { company: "A Co" }), tool("c2", "find_contacts", { company: "B Co" }), tool("c3", "find_contacts", { company: "C Co" })]),
    );
    const deps = { client: c as never, checkLead: checker, now: NOW, findContacts: findContacts as never };

    const k = await step(s, deps); // turn k: the third lead is accepted
    expect(s.leads).toHaveLength(3);
    expect(s.status).toBe("running");
    expect(phaseEvents(k.events)).toHaveLength(0);

    const phase = await step(s, deps); // the contacts phase turn
    const [entered] = phaseEvents(phase.events);
    expect(entered).toMatchObject({ scope: "loop", check: "contacts_phase", outcome: "pass", leadsWithoutContacts: 3, phaseTurn: 1, maxTurns: 1, budgetDollars: 3 * CONTACT_LIMITS.maxCostDollars });
    expect(s.contactsPhase).toMatchObject({ maxTurns: 1, turnsUsed: 1, budgetDollars: 3 * CONTACT_LIMITS.maxCostDollars });
    // The nudge is on the user message the model read this turn.
    expect(sentAt.at(-1)).toContain("Target reached: look up contacts for the 3 leads without them (A Co, B Co, C Co) with find_contacts, then finish.");
    expect(findContacts).toHaveBeenCalledTimes(3);
    // The phase's Exa budget (3 × CONTACT_LIMITS.maxCostDollars) bounds the guard: never more room than that.
    expect(Math.max(...remaining)).toBeLessThanOrEqual(3 * CONTACT_LIMITS.maxCostDollars + 1e-9);
    expect(s.leads.every((l) => l.contacts && l.contacts.contacts.length === 1)).toBe(true);
    expect(s.status).toBe("running");

    const end = await step(s, deps); // every lead has contacts: stop on target
    expect(s.status).toBe("done");
    expect(s.stopReason).toBe("target_leads");
    expect(c.messages.create).toHaveBeenCalledTimes(2);
    expect(phaseEvents(end.events)).toHaveLength(0);
    expect(end.events.find((e) => e.kind === "stop")).toMatchObject({ reason: "target_leads", status: "done" });
  });

  it("the phase is bounded: a turn that does not look anything up still ends the phase after ceil(leads/3) turns", async () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")]);
    const c = client(msg([tool("t", "update_todo", { markdown: "checking" })]));
    const deps = { client: c as never, checkLead: checker, now: NOW, findContacts: vi.fn() as never };
    await step(s, deps);
    expect(s.contactsPhase).toMatchObject({ turnsUsed: 1, maxTurns: 1 });
    await step(s, deps);
    expect(s).toMatchObject({ status: "done", stopReason: "target_leads" });
    expect(c.messages.create).toHaveBeenCalledTimes(1);
  });

  it("a contacts-only turn is progress: the no-progress counter resets instead of firing", async () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")], {}, 3);
    s.counters.noProgressTurns = 3;
    const c = client(msg([tool("c1", "find_contacts", { company: "A Co" })]));
    // Zero people found still counts: the lookup returned.
    await step(s, { client: c as never, checkLead: checker, now: NOW, findContacts: vi.fn(async () => found(0)) as never });
    expect(s.counters.noProgressTurns).toBe(0);
    expect(s.leads[0]!.contacts).toMatchObject({ contacts: [] });
  });

  it("a failed lookup is not progress", async () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")]);
    s.counters.noProgressTurns = 1;
    const c = client(msg([tool("c1", "find_contacts", { company: "A Co" })]));
    await step(s, { client: c as never, checkLead: checker, now: NOW, findContacts: vi.fn(async () => { throw new Error("network"); }) as never });
    expect(s.counters.noProgressTurns).toBe(2);
  });

  it("skipped when every lead already has contacts", async () => {
    const s = runState([lead("A Co", true), lead("B Co", true), lead("C Co", true)]);
    const c = client();
    const r = await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s).toMatchObject({ status: "done", stopReason: "target_leads" });
    expect(phaseEvents(r.events)).toHaveLength(0);
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("skipped when the budget left cannot pay for one lookup", async () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")]);
    // $1 cap, $0.05 handback reserve: $0.02 left, under one lookup's cap (and not yet the budget stop).
    s.spend = { exa: 0.5, claude: 0.43, total: 0.93 };
    const c = client();
    const r = await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s).toMatchObject({ status: "done", stopReason: "target_leads" });
    expect(phaseEvents(r.events)).toHaveLength(0);
    expect(s.contactsPhase).toBeUndefined();
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("skipped when the plan has no approved roles", () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")], { buyerRoles: undefined });
    expect(contactsPhaseTurn(s)).toBeUndefined();
  });

  it("ends once the phase's Exa budget cannot pay for another lookup", () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("C Co")], {}, 3);
    s.leads.push(lead("D Co"), lead("E Co"), lead("F Co"), lead("G Co"));
    expect(contactsPhaseTurn(s)).toMatchObject({ pending: ["A Co", "B Co", "C Co", "D Co", "E Co", "F Co", "G Co"] });
    expect(s.contactsPhase).toMatchObject({ maxTurns: 3, budgetDollars: 7 * CONTACT_LIMITS.maxCostDollars });
    s.spend.exa += 7 * CONTACT_LIMITS.maxCostDollars - 0.02; // budget minus 0.02: under one lookup left
    expect(contactsPhaseTurn(s)).toBeUndefined();
  });
});

/* ---------- FAILURES #34: discovery leaves money for contacts ---------- */

describe("discovery budget holds back the contact lookups (FAILURES #34)", () => {
  const lastUserText = (s: RunState): string => {
    const last = s.messages.at(-1)!;
    const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as Array<{ type: string; text?: string }>);
    return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  };
  const spend = (s: RunState, total: number) => {
    s.spend = { exa: total - 0.2, claude: 0.2, total };
  };

  it("the reserve is (leads without contacts + 1) × the per-lead cap with roles, 0 without", () => {
    const s = runState([lead("A Co"), lead("B Co"), lead("Done Co", true)], {}, 10);
    expect(contactsReserveDollars(s)).toBeCloseTo(3 * CONTACT_LIMITS.maxCostDollars, 9);
    // A failed lookup has an entry: its one call is spent, nothing is held for it.
    s.leads[0]!.contacts = { at: NOW.toISOString(), roles: ROLES, contacts: [], cost: 0, error: "network" };
    expect(contactsReserveDollars(s)).toBeCloseTo(2 * CONTACT_LIMITS.maxCostDollars, 9);
    expect(contactsReserveDollars(runState([lead("A Co")], { buyerRoles: undefined }, 10))).toBe(0);
  });

  it("limitReason: with roles, discovery stops on budget once spend + handback reserve + held lookups reaches the cap", () => {
    // $1 cap, 2 leads without contacts: hold 3 × $0.045 = $0.135, plus the $0.05 handback reserve.
    const s = runState([lead("A Co"), lead("B Co")], {}, 10);
    spend(s, 0.81); // 0.81 + 0.05 + 0.135 = 0.995
    expect(limitReason(s)).toBeUndefined();
    spend(s, 0.82); // 1.005
    expect(limitReason(s)).toEqual({ status: "stopped", reason: "budget", discoveryBudget: true });
    // Without roles the same spend keeps searching; only the old line (spend + handback reserve) stops it.
    const plain = runState([lead("A Co"), lead("B Co")], { buyerRoles: undefined }, 10);
    spend(plain, 0.82);
    expect(limitReason(plain)).toBeUndefined();
    spend(plain, 0.95);
    expect(limitReason(plain)).toEqual({ status: "stopped", reason: "budget" });
    // The hard line is unchanged with roles and is not a discovery stop: no contacts phase past it.
    spend(s, 0.95);
    expect(limitReason(s)).toEqual({ status: "stopped", reason: "budget" });
  });

  it("the live run's shape: discovery stops with 2 leads unlooked-up, the contacts phase runs on the budget stop, then the run stops on budget", async () => {
    const s = runState([lead("A Co"), lead("B Co")], {}, 10);
    spend(s, 0.82);
    const remaining: number[] = [];
    const findContacts = vi.fn(async (input: FindContactsInput) => {
      remaining.push(input.guard!.remaining);
      input.guard!.reserve(CONTACT_LIMITS.maxCostDollars);
      input.guard!.settle(CONTACT_LIMITS.maxCostDollars, 0.02);
      return found(1);
    });
    const c = client(
      msg([tool("c1", "find_contacts", { company: "A Co" }), tool("c2", "find_contacts", { company: "B Co" })]),
      msg([{ type: "text", text: JSON.stringify({ shortfall: "2 of 10", top_reasons: [], suggestions: [] }) }], "end_turn"),
    );
    const deps = { client: c as never, checkLead: checker, now: NOW, findContacts: findContacts as never };

    const phase = await step(s, deps);
    const [entered] = phaseEvents(phase.events);
    expect(entered).toMatchObject({ outcome: "pass", reason: "budget_contacts_pending", leadsWithoutContacts: 2, phaseTurn: 1, maxTurns: 1, budgetDollars: 2 * CONTACT_LIMITS.maxCostDollars });
    expect(s.contactsPhase).toMatchObject({ trigger: "budget", maxTurns: 1, turnsUsed: 1 });
    expect(sentAt.at(-1)).toContain("The budget for finding leads is used up; what is left is held for contact lookups. Look up contacts for the 2 leads without them (A Co, B Co) with find_contacts, then finish.");
    expect(sentAt.at(-1)).not.toContain("Target reached");
    expect(findContacts).toHaveBeenCalledTimes(2);
    expect(Math.max(...remaining)).toBeLessThanOrEqual(2 * CONTACT_LIMITS.maxCostDollars + 1e-9);
    expect(s.leads.every((l) => l.contacts && l.contacts.contacts.length === 1)).toBe(true);
    expect(s.status).toBe("running");
    // CostGuard: the run cap stays a hard ceiling.
    expect(s.spend.total).toBeLessThan(1);

    const end = await step(s, deps);
    expect(s).toMatchObject({ status: "stopped", stopReason: "budget" });
    expect(end.events.find((e) => e.kind === "stop")).toMatchObject({ reason: "budget", status: "stopped" });
    expect(phaseEvents(end.events)).toHaveLength(0);
    expect(s.handback).toBeDefined();
    expect(s.spend.total).toBeLessThan(1);
  });

  it("a phase begun on the budget stop ends the run when it ends: discovery does not resume on money the lookups left over", async () => {
    const s = runState([lead("A Co"), lead("B Co")], {}, 10);
    spend(s, 0.82);
    const c = client(msg([tool("c1", "find_contacts", { company: "A Co" }), tool("c2", "find_contacts", { company: "B Co" })]), msg([{ type: "text", text: "{}" }], "end_turn"));
    // Lookups that cost nothing: by the reserve line alone discovery could start again.
    const deps = { client: c as never, checkLead: checker, now: NOW, findContacts: vi.fn(async () => ({ ...found(1), cost: 0 })) as never };
    await step(s, deps);
    s.spend = { exa: 0.5, claude: 0.2, total: 0.7 };
    await step(s, deps);
    expect(s).toMatchObject({ status: "stopped", stopReason: "budget" });
  });

  it("with roles and every lead looked up, the stop still holds one lookup for the next lead, and no phase runs", async () => {
    const s = runState([lead("A Co", true)], {}, 10);
    spend(s, 0.91); // 0.91 + 0.05 + 1 × 0.045 = 1.005
    const c = client(msg([{ type: "text", text: "{}" }], "end_turn"));
    const r = await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s).toMatchObject({ status: "stopped", stopReason: "budget" });
    expect(phaseEvents(r.events)).toHaveLength(0);
    expect(s.contactsPhase).toBeUndefined();
  });

  it("without roles, the same spend runs an ordinary discovery turn (no phase, no held money on the spend line)", async () => {
    const s = runState([lead("A Co"), lead("B Co")], { buyerRoles: undefined }, 10);
    spend(s, 0.82);
    const c = client(msg([tool("t", "update_todo", { markdown: "searching" })]));
    const r = await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("running");
    expect(phaseEvents(r.events)).toHaveLength(0);
    expect(c.messages.create).toHaveBeenCalledTimes(1);
    expect(lastUserText(s)).toMatch(/^Spend: \$0\.82 of \$1\.00 · Leads: 2\/10 · Turn 1\/\d+$/m);
  });

  it("with roles, the spend line tells the model how much is held for lookups", async () => {
    const s = runState([lead("A Co"), lead("B Co")], {}, 10);
    spend(s, 0.5);
    const c = client(msg([tool("t", "update_todo", { markdown: "searching" })]));
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(lastUserText(s)).toMatch(/^Spend: \$0\.50 of \$1\.00 \(\$0\.1[34] of it held for contact lookups\) · Leads: 2\/10 · Turn 1\/\d+$/m);
  });
});
