/**
 * Threshold logic of the CI experiment gate (`.github/workflows/experiment-gate.yml`,
 * runner `eval/ci/experiment-gate.ts`). Pure: no I/O, so the decision is unit-tested on
 * its own (eval/experiment-gate.test.ts).
 *
 * Follows the release policy of the Langfuse CI/CD docs ("Experiments in CI/CD"): a
 * missing case, a duplicate case, a task failure or a missing evaluator result fails the
 * gate instead of counting as a pass, and the baseline is a reviewed artifact in the repo
 * (`eval/ci/approved-baseline.json`), never generated from the candidate.
 */
import type { GradeReport } from "../graders";

export type ApprovedBaseline = {
  /** Eval set the baseline numbers come from (its report.json is the reviewed artifact). */
  source: string;
  report: string;
  /** Arm the gate replays at $0. */
  arm: "A_workflow";
  /** Fail when precision < baseline precision − this. */
  maxPrecisionDrop: number;
  scenarios: Record<
    string,
    {
      /** Mean precision of `arm` over the source set's reps (report.json summaries). */
      precision: number;
      reps: number;
      /** Exa recording the replay reads (EXA_REPLAY_DIR); `cell.json` inside holds the recorded cell (its `now`). */
      fixture: string;
    }
  >;
};

/** What the runner observed for one dataset item. */
export type ScenarioOutcome =
  | { scenarioId: string; status: "missing_fixture"; fixture: string }
  | { scenarioId: string; status: "error"; error: string }
  | {
      scenarioId: string;
      status: "ran";
      accepted: number;
      good: number;
      precision: number;
      /** Leads with no verdict in eval/truth: a missing evaluator result, never "not good". */
      unjudged: string[];
      /** Code graders over the cell's state.json + events.jsonl; undefined when the arm leaves none (the workflow arm). */
      graders?: GradeReport;
    };

export type GateFailure = {
  scenarioId: string;
  kind: "missing_case" | "duplicate_case" | "missing_fixture" | "no_baseline" | "task_error" | "unjudged" | "must_pass" | "precision";
  message: string;
};

export type GateRow = {
  scenarioId: string;
  status: ScenarioOutcome["status"] | "not_run";
  precision?: number;
  baseline?: number;
  floor?: number;
  accepted?: number;
  good?: number;
  gradersApplicable?: number;
  mustPassFailed?: string[];
};

export type GateResult = { pass: boolean; failures: GateFailure[]; rows: GateRow[] };

/** Floating-point slack so 0.35 − 0.1 does not fail a run at exactly 0.25. */
const EPS = 1e-9;

/**
 * Decide the gate. `expected` = the scenario ids of the `prospector-scenarios` dataset
 * items; every one must have exactly one outcome, a fixture, a baseline, a completed
 * replay, a verdict for every lead, no failed must-pass grader, and precision no more than
 * `maxPrecisionDrop` below its baseline.
 */
export function evaluateGate(expected: string[], outcomes: ScenarioOutcome[], baseline: ApprovedBaseline): GateResult {
  const failures: GateFailure[] = [];
  const rows: GateRow[] = [];
  const seen = new Map<string, number>();
  for (const o of outcomes) seen.set(o.scenarioId, (seen.get(o.scenarioId) ?? 0) + 1);
  for (const [id, n] of seen) {
    if (n > 1) failures.push({ scenarioId: id, kind: "duplicate_case", message: `${n} outcomes for one dataset item` });
  }
  for (const o of outcomes) {
    if (!expected.includes(o.scenarioId)) failures.push({ scenarioId: o.scenarioId, kind: "duplicate_case", message: "outcome for a scenario that is not a dataset item" });
  }

  for (const id of expected) {
    const o = outcomes.find((x) => x.scenarioId === id);
    const base = baseline.scenarios[id];
    if (!o) {
      failures.push({ scenarioId: id, kind: "missing_case", message: "dataset item was not run" });
      rows.push({ scenarioId: id, status: "not_run" });
      continue;
    }
    if (!base) failures.push({ scenarioId: id, kind: "no_baseline", message: `no approved baseline in eval/ci/approved-baseline.json` });
    if (o.status === "missing_fixture") {
      failures.push({ scenarioId: id, kind: "missing_fixture", message: `no Exa recording at ${o.fixture}; record it once (paid, see eval/ci/experiment-gate.ts --record)` });
      rows.push({ scenarioId: id, status: o.status, baseline: base?.precision });
      continue;
    }
    if (o.status === "error") {
      failures.push({ scenarioId: id, kind: "task_error", message: o.error });
      rows.push({ scenarioId: id, status: o.status, baseline: base?.precision });
      continue;
    }
    const applicable = o.graders?.results.filter((r) => r.applicable) ?? [];
    const mustPassFailed = applicable.filter((r) => r.mustPass && !r.pass).map((r) => r.name);
    const floor = base ? base.precision - baseline.maxPrecisionDrop : undefined;
    rows.push({
      scenarioId: id,
      status: o.status,
      precision: o.precision,
      baseline: base?.precision,
      floor,
      accepted: o.accepted,
      good: o.good,
      gradersApplicable: applicable.length,
      mustPassFailed,
    });
    if (mustPassFailed.length) failures.push({ scenarioId: id, kind: "must_pass", message: `must-pass grader(s) failed: ${mustPassFailed.join(", ")}` });
    if (o.unjudged.length) {
      // A lead with no verdict is a missing evaluator result: precision is unknown, not lower.
      failures.push({ scenarioId: id, kind: "unjudged", message: `${o.unjudged.length} lead(s) have no verdict in eval/truth (${o.unjudged.slice(0, 3).join(", ")}${o.unjudged.length > 3 ? ", …" : ""}); judge them (npm run eval:judge) or the precision is unknown` });
      continue;
    }
    if (floor !== undefined && o.precision < floor - EPS) {
      failures.push({ scenarioId: id, kind: "precision", message: `precision ${o.precision.toFixed(3)} < ${floor.toFixed(3)} (baseline ${base!.precision.toFixed(3)} from ${baseline.source} − ${baseline.maxPrecisionDrop})` });
    }
  }
  return { pass: failures.length === 0, failures, rows };
}

/** Markdown for $GITHUB_STEP_SUMMARY and the log. */
export function gateMarkdown(result: GateResult, context: { experiment: string; runName?: string; link?: string; promptDiff?: string }): string {
  const fmt = (n: number | undefined) => (typeof n === "number" ? n.toFixed(3) : "—");
  const lines = [
    `### Experiment gate: ${result.pass ? "pass" : "FAIL"}`,
    "",
    `Experiment \`${context.experiment}\`${context.runName ? `, run \`${context.runName}\`` : ""} on dataset \`prospector-scenarios\` (workflow arm, Exa replay, $0).${context.link ? ` [Langfuse](${context.link})` : ""}`,
    "",
    "| Scenario | Status | Accepted | Good | Precision | Baseline | Floor | Graders applicable | Must-pass failed |",
    "|---|---|---|---|---|---|---|---|---|",
    ...result.rows.map(
      (r) =>
        `| ${r.scenarioId} | ${r.status} | ${r.accepted ?? "—"} | ${r.good ?? "—"} | ${fmt(r.precision)} | ${fmt(r.baseline)} | ${fmt(r.floor)} | ${r.gradersApplicable ?? "—"} | ${r.mustPassFailed?.length ? r.mustPassFailed.join(", ") : "—"} |`,
    ),
    "",
  ];
  if (result.failures.length) {
    lines.push("**Failures**", "", ...result.failures.map((f) => `- ${f.scenarioId} · ${f.kind}: ${f.message}`), "");
  }
  lines.push("Not covered at $0: the agent arm (no recorded model responses), so agent behaviour is gated only by the prompt diff and the mocked suite.");
  return lines.join("\n");
}
