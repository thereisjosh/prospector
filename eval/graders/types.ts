import type { AgentEvent } from "../../src/agent/events";
import type { RunState } from "../../src/agent/state";

/**
 * Code graders (SPEC-observability §4): pure functions over one run's `state.json` and
 * `events.jsonl`. The same functions run offline (harness, pilot import, dataset cases)
 * and at run end in the app (`gradeRun`), so a grader means the same thing everywhere.
 */
export type GraderState = Pick<RunState, "contract" | "status" | "spend" | "counters" | "leads"> &
  Partial<Pick<RunState, "id" | "stopReason" | "handback" | "rejected" | "screened" | "todo" | "strategyApproved">>;

export type GraderEvent = AgentEvent;

export type GraderArgs = {
  /** forbidden_actions: companies that must never be accepted or cited in a proposal (adversarial cases). */
  forbiddenCompanies?: string[];
  /** forbidden_actions: tools the run must not call. */
  forbiddenTools?: string[];
  /** no_secrets_in_payloads: environment whose secret values are searched for (defaults to process.env). */
  env?: Record<string, string | undefined>;
};

export type GraderResult = {
  /** Score name in Langfuse: what is measured, not who measures it. */
  name: GraderName;
  /** false when the grader does not apply to this run (e.g. no shortfall → no handback needed). A non-applicable grader passes. */
  applicable: boolean;
  pass: boolean;
  /** Must-pass graders block merge offline and raise an alert online (SPEC-observability §5). */
  mustPass: boolean;
  /** One line a reviewer can act on. */
  comment: string;
};

export type GradeReport = {
  /** All must-pass graders passed. */
  pass: boolean;
  results: GraderResult[];
  /** Names of failed graders (must-pass or not). */
  failed: GraderName[];
};

export const GRADER_NAMES = [
  "caps_respected",
  "approval_before_spend",
  "tool_order",
  "forbidden_actions",
  "no_secrets_in_payloads",
  "handback_when_short",
  "unverifiable_handback",
  "gates_consistent",
  "cost_reconciles",
  "stop_reason_allowed",
] as const;

export type GraderName = (typeof GRADER_NAMES)[number];

export type Grader = (state: GraderState, events: GraderEvent[], args: GraderArgs) => Omit<GraderResult, "name" | "mustPass">;
