import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_LIMITS, DEFAULT_MODEL, RUNS_DIR, type AgentModel } from "./config";
import { assertRunId } from "./ids";
import { firstUserMessage } from "./prompts";
import type { SearchPlan } from "../plan";
import type { CompanySummary, SignalSummary } from "../types";

export type AcceptedLead = {
  company: string;
  signal_url: string;
  why_now: string;
  summary: SignalSummary;
  enrichment?: CompanySummary;
  details: Record<string, unknown>;
  turn: number;
};

export type Handback = {
  shortfall: string;
  top_reasons: Array<{ code: string; count: number }>;
  suggestions: Array<{ field: string; value: unknown; why: string }>;
};

export type ScreenedCompany = { company: string; code: string; reason: string; turn: number; stage: "lookup" };

export type RunStatus = "running" | "awaiting_approval" | "done" | "stopped" | "error";

export type RunState = {
  version: number;
  id: string;
  createdAt: string;
  workspaceId: string;
  model: AgentModel;
  contract: SearchPlan & { targetLeads: number; maxCostDollars: number; preferenceNotes: string[] };
  /** Deep copy of the contract at creation, so the UI can show what scope changes altered. */
  initialContract?: SearchPlan & { targetLeads: number; maxCostDollars: number; preferenceNotes: string[] };
  messages: Anthropic.MessageParam[];
  status: RunStatus;
  stopReason?: string;
  stopRequested?: boolean;
  strategyApproved: boolean;
  resumedFromDecision?: boolean;
  summary?: string;
  spend: { exa: number; claude: number; total: number };
  counters: { turns: number; activeMs: number; noProgressTurns: number; toolCalls: number; consecutiveErrors?: number; lastModelInputTokens?: number };
  leads: AcceptedLead[];
  rejected: Array<{ company: string; code: string; reason: string; turn: number }>;
  /** Companies the gates would reject, found at the lookup stage (never submitted). */
  screened?: ScreenedCompany[];
  todo: string;
  pendingApproval?: {
    toolUseId: string;
    tool: string;
    input: unknown;
    otherToolResults: Anthropic.ToolResultBlockParam[];
    toolUseOrder?: string[];
  };
  handback?: Handback;
  adaptive: { queryRewrites: number; lookupsSkipped: number; verificationReads: number };
  caches: {
    signalsByUrl: Record<string, { url: string; title?: string; text?: string; publishedDate?: string; summary: SignalSummary }>;
    enrichmentByName: Record<string, { result?: unknown; summary: CompanySummary; url?: string }>;
    candidateCompanies: string[];
    searchQueries: string[];
    seenKeys: string[];
  };
};

export function createRunState(args: {
  id: string;
  workspaceId: string;
  plan: SearchPlan;
  preferenceNotes?: string[];
  model?: AgentModel;
  targetLeads?: number;
  maxCostDollars?: number;
  seenKeys?: string[];
  createdAt?: string;
}): RunState {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const contract = {
    ...args.plan,
    targetLeads: args.targetLeads ?? DEFAULT_LIMITS.targetLeads,
    maxCostDollars: args.maxCostDollars ?? DEFAULT_LIMITS.maxCostDollars,
    preferenceNotes: args.preferenceNotes ?? [],
  };
  return {
    id: args.id,
    version: 0,
    createdAt,
    workspaceId: args.workspaceId,
    model: args.model ?? DEFAULT_MODEL,
    contract,
    initialContract: structuredClone(contract),
    messages: [{ role: "user", content: firstUserMessage(contract, { today: createdAt.slice(0, 10) }) }],
    status: "running",
    strategyApproved: false,
    spend: { exa: 0, claude: 0, total: 0 },
    counters: { turns: 0, activeMs: 0, noProgressTurns: 0, toolCalls: 0 },
    leads: [],
    rejected: [],
    screened: [],
    todo: "",
    adaptive: { queryRewrites: 0, lookupsSkipped: 0, verificationReads: 0 },
    caches: {
      signalsByUrl: {},
      enrichmentByName: {},
      candidateCompanies: [],
      searchQueries: [],
      seenKeys: args.seenKeys ?? [],
    },
  };
}

export class StaleStateError extends Error {
  constructor(message = "Run state changed before save") {
    super(message);
    this.name = "StaleStateError";
  }
}

export class RunBusyError extends Error {
  constructor(message = "Run is busy.") {
    super(message);
    this.name = "RunBusyError";
  }
}

export async function saveState(state: RunState, expectedVersion?: number): Promise<void> {
  const dir = join(RUNS_DIR, assertRunId(state.id));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "state.json");
  if (expectedVersion !== undefined) {
    let currentVersion = 0;
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
      currentVersion = typeof current.version === "number" ? current.version : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentVersion !== expectedVersion) throw new StaleStateError();
    state.version = expectedVersion + 1;
  } else {
    state.version = typeof state.version === "number" ? state.version : 0;
  }
  const temp = join(dir, `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await rename(temp, path);
}

export async function loadState(id: string): Promise<RunState> {
  const raw = await readFile(join(RUNS_DIR, assertRunId(id), "state.json"), "utf8");
  const state = JSON.parse(raw) as RunState;
  state.version = typeof state.version === "number" ? state.version : 0;
  state.counters.consecutiveErrors ??= 0;
  return state;
}

export async function withRunLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const runId = assertRunId(id);
  const dir = join(RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
  const lock = join(dir, ".lock");
  try {
    const s = await stat(lock);
    if (Date.now() - s.mtimeMs > 90_000) await rm(lock, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let handle;
  try {
    handle = await open(lock, "wx");
    await handle.writeFile(String(process.pid), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RunBusyError();
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Screened-at-lookup companies grouped by gate code, most common first. */
export function screenedByCode(state: Pick<RunState, "screened">): Array<{ code: string; count: number; companies: string[] }> {
  const map = new Map<string, string[]>();
  for (const item of state.screened ?? []) map.set(item.code, [...(map.get(item.code) ?? []), item.company]);
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([code, companies]) => ({ code, count: companies.length, companies: companies.slice(0, 10) }));
}
