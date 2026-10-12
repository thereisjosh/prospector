import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

// Isolate from eval/agent.test.ts, which wipes ./runs and ./workspaces.
const dirs = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "run-agent-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  return { root };
});

import type { LoopDeps } from "../src/agent/loop";
import { createRunState, loadState } from "../src/agent/state";
import type { LeadChecker } from "../src/agent/gate-port";
import { squashName } from "../src/agent/memory";
import type { SearchPlan } from "../src/plan";
import { autoDecision, driveRun, summarize } from "./run-agent";

afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

const plan: SearchPlan = {
  label: "Driver test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};

const msg = (stop_reason: string, content: unknown[]) => ({
  id: crypto.randomUUID(), type: "message", role: "assistant", model: "claude-opus-5-5",
  content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const client = (...responses: unknown[]) => ({ messages: { create: vi.fn(async () => {
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return next;
}) } });

const checker: LeadChecker = (_p, input) => ({
  ok: true,
  details: {
    key: squashName(input.company), event_date: "2026-10-01", date_source: "signal", employees: 200,
    size_basis: "quoted", required_gates_passed: ["is_operator"], optional_gates_passed: [],
    hq: "Austin", multiplier: 1, fit_reason: "ok",
  },
});

const signalResult = {
  results: [{
    url: "https://news.example/good", title: "GoodCo expands", publishedDate: "2026-10-01T00:00:00.000Z", text: "GoodCo expands.",
    summary: JSON.stringify({ company_name: "GoodCo", signal_type: "expansion", signal_summary: "GoodCo opened a warehouse.", signal_date: "2026-10-01" }),
  }],
  costDollars: { total: 0.01 },
};
const lookupResult = {
  result: { url: "https://good.example" },
  summary: { description: "GoodCo", industry: "Logistics", employee_estimate: 200, hq: "Austin, TX", is_operator: true },
};

const deps = (c: unknown): LoopDeps => ({
  client: c as never,
  checkLead: checker,
  now: new Date("2026-10-12T00:00:00.000Z"),
  exaSearch: vi.fn(async () => signalResult) as never,
  lookupCompany: vi.fn(async () => lookupResult) as never,
});

const newState = (over = {}) => createRunState({ id: crypto.randomUUID(), workspaceId: "ws", plan, ...over });

const happyPath = () => [
  msg("tool_use", [tool("p", "propose_strategy", { angles: ["a"], first_queries: ["q"], est_cost_dollars: 0.1 })]),
  msg("tool_use", [tool("s", "search_signals", { query: "warehouse expansion", num_results: 10 })]),
  msg("tool_use", [tool("l", "lookup_company", { name: "GoodCo" })]),
  msg("tool_use", [tool("sub", "submit_lead", { company: "GoodCo", signal_url: "https://news.example/good", why_now: "opened warehouse" })]),
  msg("tool_use", [tool("f", "finish", { summary: "done" })]),
];

describe("driveRun", () => {
  it("runs to completion with --approve auto, saving state each step", async () => {
    const s = newState();
    const lines: string[] = [];
    await driveRun(s, deps(client(...happyPath())), "auto", { log: (l) => lines.push(l) });
    expect(s.status).toBe("done");
    expect(s.leads.map((l) => l.company)).toEqual(["GoodCo"]);
    const saved = await loadState(s.id);
    expect(saved.status).toBe("done");
    expect(saved.leads).toHaveLength(1);
    expect(lines.some((l) => l.includes("approval propose_strategy: APPROVE"))).toBe(true);
    expect(lines.some((l) => l.includes("tool_call · search_signals · ok"))).toBe(true);
    expect(lines.some((l) => l.includes("spend $"))).toBe(true);
    const summary = summarize(s).join("\n");
    expect(summary).toContain("GoodCo | https://news.example/good | 2026-10-01 | quoted");
    expect(summary).toContain("state.json");
  });

  it("--approve deny declines everything and the run still terminates", async () => {
    const s = newState();
    const lines: string[] = [];
    await driveRun(s, deps(client(
      msg("tool_use", [tool("p", "propose_strategy", { angles: [], first_queries: [], est_cost_dollars: 0 })]),
      msg("end_turn", [{ type: "text", text: "stopping" }]),
    )), "deny", { log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes("DENY"))).toBe(true);
    expect(JSON.stringify(s.messages)).toContain("declined");
    expect(s.status).toBe("done");
  });

  it("--approve ask uses the ask function", async () => {
    const s = newState();
    const ask = vi.fn(async () => true);
    await driveRun(s, deps(client(
      msg("tool_use", [tool("p", "propose_strategy", { angles: [], first_queries: [], est_cost_dollars: 0 })]),
      msg("end_turn", [{ type: "text", text: "ok" }]),
    )), "ask", { ask, log: () => undefined });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.messages)).toContain("approved");
  });

  it("auto: approves months 3 -> 6 and applies it", async () => {
    const s = newState();
    await driveRun(s, deps(client(
      msg("tool_use", [tool("c", "request_scope_change", { change: { field: "months", value: 6 }, reason: "stale", evidence: "x" })]),
      msg("end_turn", [{ type: "text", text: "ok" }]),
    )), "auto", { log: () => undefined });
    expect(s.contract.months).toBe(6);
  });

  it("auto: denies a request that changes two fields, and applies nothing", async () => {
    const s = newState();
    await driveRun(s, deps(client(
      msg("tool_use", [tool("c", "request_scope_change", {
        change: { field: "months", value: 6, employeeRange: { min: 10, max: 900 } }, reason: "r", evidence: "e",
      })]),
      msg("end_turn", [{ type: "text", text: "ok" }]),
    )), "auto", { log: () => undefined });
    expect(s.contract.months).toBe(3);
    expect(s.contract.employeeRange.max).toBe(500);
    expect(JSON.stringify(s.messages)).toContain("declined");
  });

  it("autoDecision rules", () => {
    const s = newState();
    const req = (change: unknown) => ({ toolUseId: "x", tool: "request_scope_change", input: { change, reason: "", evidence: "" }, otherToolResults: [] });
    expect(autoDecision(s, req({ field: "months", value: 6 })).approve).toBe(true);
    expect(autoDecision(s, req({ field: "months", value: 2 })).approve).toBe(false); // narrows
    expect(autoDecision(s, req({ field: "months", value: 99 })).approve).toBe(false);
    expect(autoDecision(s, req({ field: "employeeRange", value: { min: 25, max: 500 } })).approve).toBe(true);
    expect(autoDecision(s, req({ field: "employeeRange", value: { min: 100, max: 400 } })).approve).toBe(false);
    expect(autoDecision(s, req({ field: "hqCountries", value: ["US", "GB"] })).approve).toBe(true);
    expect(autoDecision(s, req({ field: "hqCountries", value: ["GB"] })).approve).toBe(false);
    expect(autoDecision(s, req({ field: "maxCostDollars", value: 3 })).approve).toBe(false);
    expect(autoDecision(s, req({ field: "industry", value: "x" })).approve).toBe(false);
    expect(autoDecision(s, req({ months: 6, employeeRange: { min: 1, max: 999 } })).approve).toBe(false);
    expect(autoDecision(s, { toolUseId: "x", tool: "propose_strategy", input: {}, otherToolResults: [] }).approve).toBe(true);
    const why = autoDecision(s, req({ field: "maxCostDollars", value: 3 })).why;
    expect(why).toContain("never auto-approved");
  });

  it("resumes from a saved state after a crash mid-run", async () => {
    const s = newState();
    const first = client(...happyPath());
    // Crash (Ctrl-C) while awaiting the user's answer: state was saved first.
    await expect(
      driveRun(s, deps(first), "ask", { ask: async () => { throw new Error("interrupted"); }, log: () => undefined }),
    ).rejects.toThrow("interrupted");
    const saved = await loadState(s.id);
    expect(saved.status).toBe("awaiting_approval");
    expect(saved.pendingApproval?.tool).toBe("propose_strategy");

    // New process: load the state, continue with a fresh client.
    const rest = happyPath().slice(1);
    await driveRun(saved, deps(client(...rest)), "auto", { log: () => undefined });
    expect(saved.status).toBe("done");
    expect(saved.leads.map((l) => l.company)).toEqual(["GoodCo"]);
    expect(saved.counters.turns).toBe(5);
    expect((await loadState(s.id)).status).toBe("done");
  });
});
