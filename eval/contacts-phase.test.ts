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
import { contactsPhaseTurn, step } from "../src/agent/loop";
import { createRunState, type AcceptedLead, type RunState } from "../src/agent/state";
import type { FindContactsInput, FindContactsResult } from "../src/contacts";
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
  const s = createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan: plan(over), targetLeads, createdAt: NOW.toISOString() });
  s.strategyApproved = true;
  s.leads.push(...leads);
  s.caches.signalsByUrl["https://news.example/cco"] = {
    url: "https://news.example/cco",
    title: "C Co opens a warehouse",
    text: "C Co opens a warehouse.",
    summary: { company_name: "C Co", signal_type: "expansion", signal_summary: "opened", signal_date: "2026-10-01" },
  };
  s.caches.enrichmentByName.cco = { summary: { description: "C Co" }, url: "https://cco.example" };
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
      input.guard!.reserve(0.03);
      input.guard!.settle(0.03, 0.02);
      return found(1);
    });
    const c = client(
      msg([tool("sub", "submit_lead", { company: "C Co", signal_url: "https://news.example/cco", why_now: "new warehouse" })]),
      msg([tool("c1", "find_contacts", { company: "A Co" }), tool("c2", "find_contacts", { company: "B Co" }), tool("c3", "find_contacts", { company: "C Co" })]),
    );
    const deps = { client: c as never, checkLead: checker, now: NOW, findContacts: findContacts as never };

    const k = await step(s, deps); // turn k: the third lead is accepted
    expect(s.leads).toHaveLength(3);
    expect(s.status).toBe("running");
    expect(phaseEvents(k.events)).toHaveLength(0);

    const phase = await step(s, deps); // the contacts phase turn
    const [entered] = phaseEvents(phase.events);
    expect(entered).toMatchObject({ scope: "loop", check: "contacts_phase", outcome: "pass", leadsWithoutContacts: 3, phaseTurn: 1, maxTurns: 1, budgetDollars: 0.09 });
    expect(s.contactsPhase).toMatchObject({ maxTurns: 1, turnsUsed: 1, budgetDollars: 0.09 });
    // The nudge is on the user message the model read this turn.
    expect(sentAt.at(-1)).toContain("Target reached: look up contacts for the 3 leads without them (A Co, B Co, C Co) with find_contacts, then finish.");
    expect(findContacts).toHaveBeenCalledTimes(3);
    // The phase's Exa budget (3 × $0.03) bounds the guard: never more room than that.
    expect(Math.max(...remaining)).toBeLessThanOrEqual(0.09 + 1e-9);
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
    // $1 cap, $0.05 handback reserve: $0.02 left, under one lookup's $0.03 (and not yet the budget stop).
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
    expect(s.contactsPhase).toMatchObject({ maxTurns: 3, budgetDollars: 7 * 0.03 });
    s.spend.exa += 0.19; // 0.21 budget, 0.02 left
    expect(contactsPhaseTurn(s)).toBeUndefined();
  });
});
