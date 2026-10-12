/**
 * CLI driver for the agent loop (live smoke runs).
 *
 *   npx tsx eval/run-agent.ts --icp 1 [--max-cost 1.00] [--target 10] [--workspace smoke]
 *       [--model opus|sonnet|<model id>] [--approve auto|ask|deny] [--record <dir>]
 *   npx tsx eval/run-agent.ts --plan path/to/plan.json ...
 *   npx tsx eval/run-agent.ts --resume <runId> [--approve ...]
 *
 * The run is created exactly as POST /api/runs does (validated plan, workspace
 * memory -> preference notes + seen keys, cost cap clamped to $5) and state is
 * saved after every step, so a crash leaves a resumable runs/<id>/state.json.
 * --record <dir> sets EXA_RECORD_DIR and copies state.json and events.jsonl to
 * <dir>/agent/. Exit code: 0 on done/stopped, 1 on error.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { AGENT_MODELS, isAgentModel, RUNS_DIR, type AgentModel } from "../src/agent/config";
import type { AgentEvent } from "../src/agent/events";
import { decide, step, type LoopDeps } from "../src/agent/loop";
import { loadMemory } from "../src/agent/memory";
import { createRunState, loadState, saveState, type RunState } from "../src/agent/state";
import { checkLead } from "../src/gates";
import { validatePlan, type SearchPlan } from "../src/plan";
import { getV1Plan } from "./fixtures/v1-plans";

export type ApprovePolicy = "auto" | "ask" | "deny";

export type Decision = { approve: boolean; why: string };

type Pending = NonNullable<RunState["pendingApproval"]>;

/** The field/value pairs a scope-change request would apply. */
function proposedChanges(input: unknown): Array<{ field: string; value: unknown }> {
  const change = (input as { change?: unknown } | null)?.change;
  if (Array.isArray(change)) {
    return change.map((c) => ({ field: String((c as { field?: unknown })?.field), value: (c as { value?: unknown })?.value }));
  }
  if (change && typeof change === "object") {
    const rec = change as Record<string, unknown>;
    if (typeof rec.field === "string") {
      // Extra keys beside field/value are further changes smuggled into one request.
      const extras = Object.keys(rec).filter((k) => k !== "field" && k !== "value");
      return [{ field: rec.field, value: rec.value }, ...extras.map((k) => ({ field: k, value: rec[k] }))];
    }
    return Object.entries(rec).map(([field, value]) => ({ field, value }));
  }
  return [];
}

/**
 * --approve auto: approve propose_strategy, and a request_scope_change that
 * widens exactly one constraint (more months, a wider employee band, more HQ
 * countries). Everything else (narrowing, a budget increase, an industry
 * change, several fields at once, malformed input) is denied with a reason.
 */
export function autoDecision(state: RunState, pending: Pending): Decision {
  if (pending.tool === "propose_strategy") return { approve: true, why: "auto-approve propose_strategy" };
  if (pending.tool !== "request_scope_change") return { approve: false, why: `auto: unknown approval tool ${pending.tool}` };

  const changes = proposedChanges(pending.input);
  if (changes.length !== 1) return { approve: false, why: `auto: request changes ${changes.length} fields; only exactly one is auto-approved` };
  const { field, value } = changes[0]!;
  const c = state.contract;
  if (field === "months") {
    if (typeof value === "number" && Number.isInteger(value) && value > c.months && value <= 12) {
      return { approve: true, why: `auto: widens months ${c.months} -> ${value}` };
    }
    return { approve: false, why: `auto: months ${String(value)} does not widen ${c.months} within 12` };
  }
  if (field === "employeeRange") {
    const r = value as { min?: unknown; max?: unknown } | null;
    if (r && typeof r.min === "number" && typeof r.max === "number") {
      const widens = r.min <= c.employeeRange.min && r.max >= c.employeeRange.max;
      const changed = r.min !== c.employeeRange.min || r.max !== c.employeeRange.max;
      if (widens && changed) return { approve: true, why: `auto: widens employee range to ${r.min}-${r.max}` };
    }
    return { approve: false, why: "auto: employeeRange does not strictly widen the current band" };
  }
  if (field === "hqCountries") {
    if (
      Array.isArray(value) &&
      value.length > c.hqCountries.length &&
      c.hqCountries.every((x) => value.includes(x))
    ) {
      return { approve: true, why: `auto: adds HQ countries (${value.join(",")})` };
    }
    return { approve: false, why: "auto: hqCountries is not a strict superset of the current list" };
  }
  return { approve: false, why: `auto: ${field} changes are never auto-approved` };
}

export type DriveOptions = {
  /** y/n source for --approve ask. */
  ask?: (state: RunState, pending: Pending) => Promise<boolean>;
  /** Line sink; defaults to console.log. */
  log?: (line: string) => void;
  /** Persist state; defaults to saveState (runs/<id>/state.json). */
  save?: (state: RunState) => Promise<void>;
  /** Safety valve against a runaway loop. */
  maxIterations?: number;
};

export function formatEvent(e: AgentEvent): string {
  const num = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(4)}` : "-");
  const ms = typeof e.latencyMs === "number" ? `${e.latencyMs}ms` : "-";
  let tool = "-";
  let status = "-";
  switch (e.kind) {
    case "tool_call":
      tool = String(e.tool ?? "-");
      status = e.is_error ? "error" : "ok";
      break;
    case "submit_verdict":
      tool = `submit_lead:${String(e.company ?? "?")}`;
      status = e.ok ? "ok" : `rejected ${String(e.code ?? "")}`;
      break;
    case "model_call":
      status = "ok";
      break;
    case "approval_request":
      tool = String(e.tool ?? "-");
      status = "awaiting";
      break;
    case "decision":
      status = e.approve ? "approved" : "declined";
      break;
    case "stop":
      status = String(e.reason ?? "stop");
      break;
    case "error":
      status = `error ${String(e.reason ?? e.message ?? "")}`.trim();
      break;
  }
  return `${String(e.turn).padStart(2)} · ${e.kind} · ${tool} · ${status} · claude ${num(e.claudeCost)} · exa ${num(e.exaCost)} · ${ms}`;
}

function turnFooter(state: RunState): string[] {
  const todo = state.todo.split("\n").filter((l) => l.trim()).slice(0, 3);
  return [
    ...todo.map((l) => `   todo: ${l.trim()}`),
    `   spend $${state.spend.total.toFixed(4)} / $${state.contract.maxCostDollars.toFixed(2)} (claude $${state.spend.claude.toFixed(4)}, exa $${state.spend.exa.toFixed(4)})`,
  ];
}

/**
 * Drive a run to a terminal status: step() while running, decide() per the
 * approval policy while awaiting_approval, saving state after every step.
 */
export async function driveRun(
  state: RunState,
  deps: LoopDeps,
  policy: ApprovePolicy,
  options: DriveOptions = {},
): Promise<RunState> {
  const log = options.log ?? ((l: string) => console.log(l));
  const save = options.save ?? saveState;
  const limit = options.maxIterations ?? 500;

  for (let i = 0; i < limit; i += 1) {
    if (state.status === "awaiting_approval") {
      const pending = state.pendingApproval;
      if (!pending) throw new Error("awaiting_approval without pendingApproval");
      let decision: Decision;
      if (policy === "auto") decision = autoDecision(state, pending);
      else if (policy === "deny") decision = { approve: false, why: "--approve deny" };
      else {
        if (!options.ask) throw new Error("--approve ask needs an ask function");
        const approve = await options.ask(state, pending);
        decision = { approve, why: approve ? "approved by user" : "declined by user" };
      }
      log(`   approval ${pending.tool}: ${decision.approve ? "APPROVE" : "DENY"} (${decision.why})`);
      let result;
      try {
        result = await decide(state, { approve: decision.approve, note: decision.why });
      } catch (error) {
        // decide() validates scope changes before applying them; a bad value is declined, not fatal.
        log(`   approval could not be applied (${error instanceof Error ? error.message : String(error)}); declining`);
        result = await decide(state, { approve: false, note: "invalid change" });
      }
      for (const e of result.events) log(formatEvent(e));
      await save(state);
      continue;
    }
    if (state.status !== "running") break;

    const result = await step(state, deps);
    for (const e of result.events) log(formatEvent(e));
    for (const line of turnFooter(state)) log(line);
    await save(state);
  }
  return state;
}

export function summarize(state: RunState): string[] {
  const out: string[] = [];
  out.push("", `status: ${state.status}   stopReason: ${state.stopReason ?? "-"}`);
  out.push(`leads (${state.leads.length}/${state.contract.targetLeads}):`);
  for (const lead of state.leads) {
    const d = lead.details as { event_date?: string; size_basis?: string };
    out.push(`  ${lead.company} | ${lead.signal_url} | ${d.event_date ?? "-"} | ${d.size_basis ?? "-"}`);
  }
  const byCode = new Map<string, number>();
  for (const r of state.rejected) byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
  out.push(`rejected (${state.rejected.length}):`);
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) out.push(`  ${code}: ${n}`);
  const a = state.adaptive;
  out.push(`adaptive: queryRewrites ${a.queryRewrites}, lookupsSkipped ${a.lookupsSkipped}, verificationReads ${a.verificationReads}`);
  out.push(`spend: total $${state.spend.total.toFixed(4)} = claude $${state.spend.claude.toFixed(4)} + exa $${state.spend.exa.toFixed(4)} (cap $${state.contract.maxCostDollars.toFixed(2)})`);
  out.push(`turns ${state.counters.turns}, tool calls ${state.counters.toolCalls}, active ${(state.counters.activeMs / 1000).toFixed(1)}s`);
  if (state.handback) out.push(`handback: ${state.handback.shortfall}; ${JSON.stringify(state.handback.suggestions)}`);
  out.push(`state:  ${join(RUNS_DIR, state.id, "state.json")}`);
  out.push(`events: ${join(RUNS_DIR, state.id, "events.jsonl")}`);
  return out;
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) a[arg.slice(2)] = argv[++i] ?? "";
  }
  return a;
}

function resolveModel(value: string | undefined): AgentModel | undefined {
  if (!value) return undefined;
  if (value === "opus") return AGENT_MODELS.opus;
  if (value === "sonnet") return AGENT_MODELS.sonnet;
  if (isAgentModel(value)) return value;
  throw new Error(`unknown --model "${value}" (use opus, sonnet, or ${Object.values(AGENT_MODELS).join(" / ")})`);
}

function loadPlan(args: Record<string, string>): SearchPlan {
  if (args.plan) {
    const validation = validatePlan(JSON.parse(readFileSync(args.plan, "utf8")));
    if (!validation.ok) throw new Error(`invalid plan:\n  ${validation.errors.join("\n  ")}`);
    return validation.plan;
  }
  const icp = Number(args.icp);
  if (icp !== 1 && icp !== 2 && icp !== 3) throw new Error("pass --icp 1|2|3, --plan <path.json>, or --resume <runId>");
  return getV1Plan(icp);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = (args.approve ?? "ask") as ApprovePolicy;
  if (!["auto", "ask", "deny"].includes(policy)) throw new Error("--approve must be auto, ask or deny");
  if (args.record) process.env.EXA_RECORD_DIR = args.record;

  let state: RunState;
  if (args.resume) {
    state = await loadState(args.resume);
    console.log(`resuming ${state.id} (status ${state.status}, turn ${state.counters.turns})`);
  } else {
    const plan = loadPlan(args);
    const workspaceId = args.workspace || "smoke";
    const memory = await loadMemory(workspaceId);
    state = createRunState({
      id: randomUUID(),
      workspaceId,
      plan,
      model: resolveModel(args.model),
      targetLeads: args.target ? Number(args.target) : undefined,
      maxCostDollars: Math.min(5, args["max-cost"] ? Number(args["max-cost"]) : 1),
      preferenceNotes: memory.preferenceNotes,
      seenKeys: memory.seen.map((s) => s.squashed),
    });
    await saveState(state);
    console.log(
      `run ${state.id} | ${plan.label} | model ${state.model} | cap $${state.contract.maxCostDollars.toFixed(2)} | target ${state.contract.targetLeads} | workspace ${workspaceId} (${memory.seen.length} seen) | approve ${policy}`,
    );
  }

  const rl = policy === "ask" ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (s: RunState, pending: Pending) => {
    console.log(`\n--- approval requested: ${pending.tool} ---\n${JSON.stringify(pending.input, null, 2)}`);
    const answer = await rl!.question("approve? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  };

  try {
    await driveRun(state, { client: new Anthropic(), checkLead }, policy, { ask });
  } finally {
    rl?.close();
  }

  for (const line of summarize(state)) console.log(line);

  if (args.record) {
    const dest = join(args.record, "agent");
    await mkdir(dest, { recursive: true });
    await copyFile(join(RUNS_DIR, state.id, "state.json"), join(dest, "state.json"));
    await copyFile(join(RUNS_DIR, state.id, "events.jsonl"), join(dest, "events.jsonl")).catch(() => undefined);
    console.log(`recorded Exa responses to ${args.record}; agent artifacts to ${dest}`);
  }
  process.exitCode = state.status === "error" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
