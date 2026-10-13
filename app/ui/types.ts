import type { AgentEvent } from "../../src/agent/events";
import type { AcceptedLead, Handback, RunStatus } from "../../src/agent/state";
import type { SearchPlan } from "../../src/plan";
import type { SellerProfile } from "../../src/planner/profile";
import type { InstagramCandidate } from "../../src/planner/resolve";
import type { ContractView } from "./copy";

/** POST /api/planner/profile */
export type ProfileResponse =
  | { kind: "url" | "text"; profile: SellerProfile; needsDescription: boolean; cost: number }
  | { kind: "instagram"; candidates: InstagramCandidate[] };

/** POST /api/planner/plan */
export type PlanResult = { plan: SearchPlan; cost: number; estimatedRunCost: number };

/** GET /api/runs/:id */
export type RunSnapshot = {
  id: string;
  status: RunStatus;
  stopReason?: string;
  summary?: string;
  spend: { exa: number; claude: number; total: number };
  counters?: { turns?: number };
  contract: ContractView;
  leads: AcceptedLead[];
  rejected: Array<{ company: string; code: string; reason: string; turn: number }>;
  /** Companies screened out at lookup, grouped by reason (companies capped per group). */
  screened?: Array<{ code: string; count: number; companies: string[] }>;
  todo: string;
  handback?: Handback;
  pendingApproval?: { tool: string; input: unknown };
};

/** POST /api/runs/:id/step and /decision */
export type StepResponse = {
  status: RunStatus;
  turn: number;
  spend: { exa: number; claude: number; total: number };
  leadsCount: number;
  events: AgentEvent[];
  handback?: Handback;
};

export type Feedback = { verdict?: "up" | "down"; reason?: string; open?: boolean; sending?: boolean; sent?: boolean; error?: boolean };

export type MemoryView = { seenCount: number; preferenceNotes: string[] };

export type { SellerProfile, InstagramCandidate };

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  let data: unknown = undefined;
  try {
    data = await response.json();
  } catch {
    // fall through to the status check
  }
  if (!response.ok) throw new HttpError(response.status);
  return data as T;
}

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * The API rate-limits per IP (30 requests, refilling 1 every 2 s). A run polls twice per
 * turn, so a long run can outpace the refill: on 429, wait and retry instead of failing.
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>, tries = 8): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 429 || attempt >= tries) throw error;
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
}
