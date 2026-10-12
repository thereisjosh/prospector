import type Anthropic from "@anthropic-ai/sdk";
import type { LoopDeps } from "../../src/agent/loop";
import type { RunState } from "../../src/agent/state";
import type { SearchPlan } from "../../src/plan";
import type { ProspectRun } from "../../src/pipeline";
import type { ProspectRow } from "../../src/types";
import type { ApprovePolicy, driveRun as driveRunFn } from "../run-agent";

export type Scenario = {
  id: string;
  label: string;
  plan: SearchPlan;
  targetLeads: number;
  maxCostDollars: number;
};

export type Arm = "A_workflow" | "B_agent_opus" | "C_agent_sonnet";

export type LeadRecord = {
  company: string;
  signal_url: string;
  why_now: string;
  event_date: string;
  size_basis: string;
};

export type RunRecord = {
  scenarioId: string;
  arm: Arm;
  rep: number;
  runId?: string;
  leads: LeadRecord[];
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
};

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
  good: boolean;
  /** Judge spend for this verdict: tokens, dollars (Opus prices) and web searches used. */
  usage?: { input: number; output: number; cache_read: number; cache_creation: number };
  costDollars?: number;
  webSearches?: number;
  judgedAt: string;
  judge: "opus" | "human";
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
};
