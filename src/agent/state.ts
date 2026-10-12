import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  strategyApproved: boolean;
  resumedFromDecision?: boolean;
  summary?: string;
  spend: { exa: number; claude: number; total: number };
  counters: { turns: number; activeMs: number; noProgressTurns: number; toolCalls: number };
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

export async function saveState(state: RunState): Promise<void> {
  const dir = join(RUNS_DIR, assertRunId(state.id));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

export async function loadState(id: string): Promise<RunState> {
  const raw = await readFile(join(RUNS_DIR, assertRunId(id), "state.json"), "utf8");
  return JSON.parse(raw) as RunState;
}

/** Screened-at-lookup companies grouped by gate code, most common first. */
export function screenedByCode(state: Pick<RunState, "screened">): Array<{ code: string; count: number; companies: string[] }> {
  const map = new Map<string, string[]>();
  for (const item of state.screened ?? []) map.set(item.code, [...(map.get(item.code) ?? []), item.company]);
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([code, companies]) => ({ code, count: companies.length, companies: companies.slice(0, 10) }));
}
