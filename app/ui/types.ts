import type { AgentEvent } from "../../src/agent/events";
import type { AcceptedLead, Handback, RunStatus } from "../../src/agent/state";
import type { SearchPlan } from "../../src/plan";
import type { SellerProfile } from "../../src/planner/profile";
import type { ResolveSource, SiteCandidate, UnusableReason } from "../../src/planner/resolve";
import type { Note, Preference, SeenGroup } from "../../src/agent/memory";
import type { ContractView } from "./copy";

/** POST /api/planner/profile */
export type ProfileResponse =
  | { kind: "url" | "text"; profile: SellerProfile; needsDescription: boolean; cost: number }
  | { kind: "candidates"; source: ResolveSource; platform?: string; candidates: SiteCandidate[]; askName?: boolean }
  | { kind: "unusable"; reason: UnusableReason }
  /** Alias kept for one release (older deploys / fixtures): same as candidates from an Instagram handle. */
  | { kind: "instagram"; candidates: SiteCandidate[] };

/** Where an "Is this your website?" list came from: names the platform in the heading. */
export type CandidateSource = { source: ResolveSource; platform?: string };

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
  /** Unverified candidates; absent on older runs (treat as []). */
  candidates?: UnverifiedCandidate[];
  rejected: Array<{ company: string; code: string; reason: string; turn: number }>;
  /** Companies screened out at lookup, grouped by reason (companies capped per group). */
  screened?: Array<{ code: string; count: number; companies: string[] }>;
  todo: string;
  handback?: Handback;
  pendingApproval?: { toolUseId?: string; tool: string; input: unknown };
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

/** GET /api/workspace/memory: the lists themselves, newest first, with provenance. */
export type MemoryView = {
  /** Unique companies remembered across all searches (live ones, under 90 days). */
  seenCount: number;
  /** Remembered companies grouped by the search they came from; the current search's group first. */
  groups: SeenGroup[];
  preferences: Preference[];
  notes: Note[];
  preferenceNotes: string[];
};

/** @deprecated use SiteCandidate */
export type InstagramCandidate = SiteCandidate;
export type { SellerProfile, SiteCandidate, ResolveSource, UnusableReason };

/** One-release migration: send a legacy browser id once, then forget it after a successful response. */
const LEGACY_WORKSPACE_KEY = "prospector.workspaceId";
let legacyWorkspaceSent = false;

function legacyWorkspaceHeader(): Record<string, string> {
  try {
    if (legacyWorkspaceSent || typeof window === "undefined") return {};
    const id = window.localStorage.getItem(LEGACY_WORKSPACE_KEY);
    return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { "x-legacy-workspace-id": id } : {};
  } catch {
    return {};
  }
}

function clearLegacyWorkspaceAfterSuccess(): void {
  if (legacyWorkspaceSent || typeof window === "undefined") return;
  legacyWorkspaceSent = true;
  try {
    window.localStorage.removeItem(LEGACY_WORKSPACE_KEY);
  } catch {
    // Browser privacy settings may deny storage; the cookie remains authoritative.
  }
}

/** Browser locale (e.g. en-SG); the planner turns its region into a soft country hint for website search. */
function localeHeader(): Record<string, string> {
  try {
    const l = typeof navigator !== "undefined" ? navigator.language : "";
    return l && /^[A-Za-z0-9_-]{2,35}$/.test(l) ? { "x-locale": l } : {};
  } catch {
    return {};
  }
}

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: {
      ...legacyWorkspaceHeader(),
      ...localeHeader(),
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  let data: unknown = undefined;
  try {
    data = await response.json();
  } catch {
    // fall through to the status check
  }
  if (!response.ok) {
    const code = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : undefined;
    throw new HttpError(response.status, code);
  }
  clearLegacyWorkspaceAfterSuccess();
  return data as T;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code?: string) {
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

/** A company the agent found but could not verify against a required fact. Never counted as a lead. */
// TODO(contract): replace with the src type once it exists.
export type UnverifiedCandidate = { company: string; signal_url: string; why_now: string; code: string; missing: string };

/**
 * URL of a run's live event stream (GET /api/runs/:id/events). Same-origin EventSource sends cookies.
 */
export function runEventsUrl(runId: string, after: number): string {
  const query = new URLSearchParams({ after: String(Math.max(0, Math.trunc(after))) });
  return `/api/runs/${encodeURIComponent(runId)}/events?${query.toString()}`;
}
