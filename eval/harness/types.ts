import type Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODELS, type AgentModel } from "../../src/agent/config";
import type { LoopDeps } from "../../src/agent/loop";
import type { RunState } from "../../src/agent/state";
import type { SearchPlan } from "../../src/plan";
import type { ProspectRun } from "../../src/pipeline";
import type { JudgeEvidence } from "../../src/evidence";
import type { ProspectRow } from "../../src/types";
import type { ApprovePolicy, driveRun as driveRunFn } from "../run-agent";

export type Scenario = {
  id: string;
  label: string;
  plan: SearchPlan;
  targetLeads: number;
  maxCostDollars: number;
};

export type Arm = "A_workflow" | "B_agent_opus" | "C_agent_sonnet" | "D_agent_kimi";

/** The model each agent arm runs (D: Moonshot kimi-k2.6, docs/RESEARCH-kimi.md). */
export const ARM_MODELS: Record<Exclude<Arm, "A_workflow">, AgentModel> = {
  B_agent_opus: AGENT_MODELS.opus,
  C_agent_sonnet: AGENT_MODELS.sonnet,
  D_agent_kimi: AGENT_MODELS.kimi,
};

export type LeadRecord = {
  company: string;
  signal_url: string;
  why_now: string;
  event_date: string;
  size_basis: string;
  /** What the gate accepted the lead on (src/evidence.ts), same shape for every arm. Absent in run.json files written before 2026-10-14. */
  evidence?: JudgeEvidence;
};

export type RunRecord = {
  scenarioId: string;
  arm: Arm;
  rep: number;
  runId?: string;
  leads: LeadRecord[];
  candidates?: Array<Pick<LeadRecord, "company" | "signal_url" | "why_now"> & { code: string; missing: string }>;
  spend: { exa: number; claude: number; total: number };
  activeMs: number;
  stopReason: string;
  adaptive?: { queryRewrites: number; lookupsSkipped: number; verificationReads: number };
  handback?: RunState["handback"];
  startedAt: string;
  finishedAt: string;
  /** Cell budget and lead target, so scoring never guesses the cap. */
  maxCostDollars: number;
  targetLeads: number;
  /** ISO time the cell treated as "now" (the recency window is relative to it). */
  now?: string;
  /** Set when the cell crashed: the run is recorded with zero leads and stopReason "error". */
  error?: string;
  /** For a handback re-run: "<scenarioId>/<arm>/<rep>" of the original cell. */
  rerunOf?: string;
  /** Memory eval (`--workspace`): the workspace this cell read memory from and wrote it to. Absent for ordinary cells. */
  workspaceId?: string;
  /** The workspace's memory file as it was BEFORE the run (what recall() was given), so a report can diff it. */
  memoryBefore?: MemorySnapshot;
  /** What recall() put in front of the run: the `memory_recalled` event payload (counts and included ids). */
  memoryRecalled?: { seen: number; preferences: { considered: number; included: number }; notes: { considered: number; included: number }; includedIds: string[] };
};

/** The memory file as stored (src/agent/memory.ts serialise()). */
export type MemorySnapshot = { version: number; seen: unknown[]; preferences: unknown[]; notes: unknown[] };

export type RubricAnswer = "yes" | "no" | "cannot_verify";

export type Verdict = {
  company: string;
  /** The signal this verdict judged; the unit of judgment is (company, signal_url). */
  signal_url?: string;
  /** The lead's event date and the date ("now") the window was judged against. */
  event_date?: string;
  now?: string;
  scenarioId: string;
  q1: RubricAnswer;
  q1_source: string;
  q2: RubricAnswer;
  q2_source: string;
  q3: RubricAnswer;
  q3_source: string;
  /** The judge's (or human's) reasoning, trimmed to 1,500 characters. */
  note?: string;
  good: boolean;
  /** Judge spend for this verdict: tokens, dollars (Opus prices) and web searches used. */
  usage?: { input: number; output: number; cache_read: number; cache_creation: number };
  costDollars?: number;
  webSearches?: number;
  webFetches?: number;
  tools?: { webSearches: number; webFetches: number };
  /** Which judge produced this verdict: "v3-fetch" = could open the signal URL. */
  judgeVersion?: string;
  /** How Q3 was verified: the page was fetched, a different site corroborated the event, or neither. */
  q3_basis?: "fetched" | "corroborated" | "none";
  judgedAt: string;
  /** opus = the offline authority (eval/truth); sonnet / kimi verdicts live under eval/results/<set>/judge-<model>/ (judge.ts --model). */
  judge: "opus" | "sonnet" | "kimi" | "human";
};

export type RunCellDeps = {
  runProspecting?: (plan: SearchPlan, options: {
    type: "auto" | "keyword" | "neural" | "fast" | "deep";
    numResults?: number;
    maxCostDollars?: number;
    now?: Date;
  }) => Promise<ProspectRun>;
  driveRun?: typeof driveRunFn;
  createClient?: () => Pick<Anthropic, "messages">;
  checkLead?: LoopDeps["checkLead"];
  now?: Date;
  resultsRoot?: string;
  runsDir?: string;
  runSetId?: string;
  log?: (line: string) => void;
  maxIterations?: number;
  workflowRows?: ProspectRow[];
  approvePolicy?: ApprovePolicy;
  /** Set when this cell is a handback re-run of another cell. */
  rerunOf?: string;
  /** `--langfuse-experiment <name>`: record the cell as a Langfuse experiment item (run `<name>:<arm>:r<rep>`). */
  langfuseExperiment?: string;
  /**
   * Memory eval: run the cell in this workspace (must start with `mem-eval-` or `eval-`; src/agent/memory.ts
   * paths come from WORKSPACES_DIR). Memory is loaded and recalled exactly as eval/run-agent.ts does and the
   * loop appends to it at stop. Unset: the cell uses a fresh `eval-<scenario>-<arm>-<rep>` id and never recalls.
   */
  workspaceId?: string;
  /** Test seam: replaces the Langfuse recorder. */
  recordExperiment?: (experimentName: string, cell: { record: RunRecord; dir: string }) => Promise<void>;
};
