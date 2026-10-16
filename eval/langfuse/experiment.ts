/**
 * Eval cells as Langfuse experiment items (docs: Experiments data model, Experiments via
 * OpenTelemetry). One experiment run = one arm × one rep of an eval set, named
 * `<set>:<arm>:r<rep>`, on the `prospector-scenarios` dataset; its items are that rep's
 * scenarios. (Langfuse assumes no repetitions inside one run: each dataset item appears
 * once per experiment, so the 3 reps of a cell are 3 runs, not 3 items of one run.)
 *
 * Per cell: one experiment-item trace (one root span carrying the `langfuse.experiment.*`
 * attributes that link it to the dataset item; session = the agent run id, so it sits next
 * to the agent's turn traces),
 * run-level scores on that root, code-grader scores, and per-lead judge verdicts on the
 * agent's `tool:submit_lead` observations. Everything uses deterministic ids, and the
 * writer checks what exists first, so re-running never duplicates.
 *
 * $0: Langfuse API calls only.
 */
import { createHash } from "node:crypto";
import type { LangfuseClient } from "@langfuse/client";
import type { AgentEvent } from "../../src/agent/events";
import { observationIdFor, toObservations } from "../../src/agent/trace";
import { readDataset, type DatasetItem } from "../datasets";
import type { GradeReport } from "../graders";
import type { CellMetric } from "../harness/score";
import { ARM_MODELS, type RunRecord, type Verdict } from "../harness/types";
import { EVAL_ENVIRONMENT } from "./client";
import { exportExperimentItemSpans, type ExperimentItemSpan } from "./otel";
import { syncDataset } from "./sync";

export const SCENARIOS_DATASET = "prospector-scenarios";
export const EXPERIMENT_TRACE_NAME = "eval-cell";

export function runNameFor(experiment: string, arm: string, rep: number): string {
  return `${experiment}:${arm}:r${rep}`;
}

export function scenarioItemId(scenarioId: string): string {
  return `scenario-${scenarioId}`;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Same scheme as the agent traces (trace.ts): sha256 of an environment-qualified seed, first 32 hex. */
export function experimentTraceId(runName: string, datasetItemId: string, environment = EVAL_ENVIRONMENT): string {
  return sha(`${environment}:experiment:${runName}:${datasetItemId}`).slice(0, 32);
}

/** Experiment (run) id: 16 hex like the SDK's createExperimentId, but deterministic so re-runs land in the same run. */
export function experimentId(runName: string, environment = EVAL_ENVIRONMENT): string {
  return sha(`${environment}:experiment-run:${runName}`).slice(0, 16);
}

export function experimentRootId(traceId: string): string {
  return observationIdFor(traceId, "experiment-item");
}

export type PlannedScore = {
  id: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  traceId: string;
  observationId: string;
  comment?: string;
};

const scoreId = (name: string, traceId: string, observationId: string) => sha(`score|${name}|${traceId}|${observationId}`).slice(0, 32);

function score(name: string, value: number | string, dataType: PlannedScore["dataType"], traceId: string, observationId: string, comment?: string): PlannedScore {
  return { id: scoreId(name, traceId, observationId), name, value, dataType, traceId, observationId, ...(comment ? { comment: comment.slice(0, 500) } : {}) };
}

export type CellPlan = {
  runName: string;
  datasetItemId: string;
  experimentId: string;
  /** Span without the dataset id, which is resolved against Langfuse when written. */
  span: Omit<ExperimentItemSpan, "experiment"> & { experiment: Omit<ExperimentItemSpan["experiment"], "datasetId"> };
  scores: PlannedScore[];
  /** Agent turn trace ids the item links to (env-qualified, as backfilled). */
  agentTraceIds: string[];
};

export type PlanCellInput = {
  experimentName: string;
  record: RunRecord;
  /** Judged metrics; undefined while any lead is unjudged (outcome scores are then withheld). */
  metric?: CellMetric;
  grades?: GradeReport;
  /** The agent cell's events (to link turn traces and place lead verdicts). */
  events?: AgentEvent[];
  /** Verdict for a lead, from eval/truth (findVerdictFile). */
  verdictFor?: (company: string, signalUrl: string) => Verdict | undefined;
  /** Dataset item (input + expectedOutput) the cell ran; defaults to the scenarios jsonl. */
  datasetItem: DatasetItem;
  /** Relative directory the cell was read from (provenance only). */
  sourceDir?: string;
  environment?: string;
  description?: string;
};

/** Pure: everything that will be written for one cell. */
export function planCell(input: PlanCellInput): CellPlan {
  const { record, metric, grades } = input;
  const environment = input.environment ?? EVAL_ENVIRONMENT;
  const runName = runNameFor(input.experimentName, record.arm, record.rep);
  const datasetItemId = input.datasetItem.id;
  const traceId = experimentTraceId(runName, datasetItemId, environment);
  const rootId = experimentRootId(traceId);
  const events = input.events ?? [];
  const agentTraces = events.length ? toObservations(events, { environment, legacyRoots: !events.some((e) => e.kind === "turn_end") }) : [];
  const agentTraceIds = agentTraces.map((t) => t.traceId);

  const scores: PlannedScore[] = [];
  const add = (s: PlannedScore) => scores.push(s);
  add(score("stop_reason", record.stopReason, "CATEGORICAL", traceId, rootId));
  if (metric) {
    add(score("good_leads", metric.good_leads, "NUMERIC", traceId, rootId, `${metric.good_leads} good of ${metric.n} accepted (RUBRIC §1)`));
    add(score("precision", metric.precision, "NUMERIC", traceId, rootId));
    if (typeof metric.cost_per_good_lead === "number") add(score("cost_per_good_lead", metric.cost_per_good_lead, "NUMERIC", traceId, rootId, `$${record.spend.total.toFixed(4)} / ${metric.good_leads}`));
    add(score("pass", metric.pass ? 1 : 0, "BOOLEAN", traceId, rootId, `good ≥ 6 (${metric.good_leads}), precision ≥ 0.8 (${metric.precision.toFixed(2)}), spend ≤ $${record.maxCostDollars} ($${record.spend.total.toFixed(4)})`));
    add(score("workflow_shaped", metric.workflow_shaped ? 1 : 0, "BOOLEAN", traceId, rootId, `adaptive actions ${metric.adaptive_actions}`));
  }
  for (const r of grades?.results ?? []) {
    if (!r.applicable) continue;
    add(score(r.name, r.pass ? 1 : 0, "BOOLEAN", traceId, rootId, r.comment));
  }
  // Per-lead judge verdicts on the agent's submit observations (RUBRIC §1).
  if (input.verdictFor && agentTraces.length) {
    for (const t of agentTraces) {
      for (const o of t.observations) {
        if (o.name !== "tool:submit_lead") continue;
        const out = (o.output ?? {}) as { verdict?: unknown; company?: unknown };
        if (out.verdict !== "accepted") continue;
        const inp = (o.input ?? {}) as { company?: unknown; signal_url?: unknown };
        const company = typeof inp.company === "string" ? inp.company : typeof out.company === "string" ? out.company : "";
        const lead = record.leads.find((l) => l.company.slice(0, 200) === company && l.signal_url.slice(0, 200) === inp.signal_url);
        if (!lead) continue;
        const v = input.verdictFor(lead.company, lead.signal_url);
        if (!v) continue;
        add(score("judge_q1", v.q1, "CATEGORICAL", t.traceId, o.id, v.q1_source));
        add(score("judge_q2", v.q2, "CATEGORICAL", t.traceId, o.id, v.q2_source));
        add(score("judge_q3", v.q3, "CATEGORICAL", t.traceId, o.id, v.q3_source));
        add(score("judge_good", v.good ? 1 : 0, "BOOLEAN", t.traceId, o.id, `judge ${v.judge}${v.judgeVersion ? ` ${v.judgeVersion}` : ""}, ${v.judgedAt.slice(0, 10)}`));
      }
    }
  }

  const output = {
    leads: record.leads.map((l) => ({ company: l.company, signal_url: l.signal_url, event_date: l.event_date, why_now: l.why_now })),
    spend: record.spend,
    stopReason: record.stopReason,
    activeMs: record.activeMs,
    ...(record.handback ? { handback: record.handback } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(metric ? { metrics: { good_leads: metric.good_leads, precision: metric.precision, cost_per_good_lead: metric.cost_per_good_lead, pass: metric.pass } } : { metrics: "withheld: unjudged leads" }),
  };
  const metadata: Record<string, unknown> = {
    set: input.experimentName,
    scenarioId: record.scenarioId,
    arm: record.arm,
    rep: record.rep,
    ...(record.runId ? { agent_run_id: record.runId, agent_session_id: record.runId, agent_trace_ids: agentTraceIds } : {}),
    ...(input.sourceDir ? { source: input.sourceDir } : {}),
  };
  const description = input.description ?? `${input.experimentName} · ${record.arm} · rep ${record.rep}: one item per scenario; scores from eval/harness/score.ts and eval/graders`;
  return {
    runName,
    datasetItemId,
    experimentId: experimentId(runName, environment),
    agentTraceIds,
    scores,
    span: {
      traceId,
      rootId,
      name: EXPERIMENT_TRACE_NAME,
      startTime: record.startedAt,
      endTime: record.finishedAt,
      input: input.datasetItem.input,
      output,
      metadata,
      ...(record.runId ? { sessionId: record.runId } : {}),
      tags: ["eval", input.experimentName, record.arm],
      ...(record.error ? { level: "ERROR" as const, statusMessage: record.error.slice(0, 300) } : {}),
      experiment: {
        id: experimentId(runName, environment),
        name: runName,
        itemId: datasetItemId,
        description,
        metadata: {
          set: input.experimentName,
          arm: record.arm,
          rep: String(record.rep),
          ...(record.arm === "A_workflow" ? {} : { model: ARM_MODELS[record.arm] }),
        },
        itemMetadata: { scenarioId: record.scenarioId },
        expectedOutput: input.datasetItem.expectedOutput,
      },
    },
  };
}

export type RecordApi = {
  api: {
    datasets: Pick<LangfuseClient["api"]["datasets"], "get" | "create">;
    datasetItems: Pick<LangfuseClient["api"]["datasetItems"], "list" | "create">;
    experiments: Pick<LangfuseClient["api"]["experiments"], "listItems">;
    observations: Pick<LangfuseClient["api"]["observations"], "getMany">;
  };
  score: { create(body: Record<string, unknown>): unknown; flush(): Promise<unknown> };
};

export type RecordResult = {
  spans: { exported: number; existing: number };
  scores: number;
  runs: Array<{ runName: string; experimentId: string }>;
};

type ExistingItem = { experimentId: string; experimentItemId: string; traceId: string };

/** Experiment items already in Langfuse for these experiments (the read API can lag a few minutes). */
async function existingItems(api: RecordApi["api"], experimentIds: string[], from: string): Promise<ExistingItem[]> {
  const out: ExistingItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.experiments.listItems({ fromStartTime: from, experimentId: experimentIds.join(","), limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...page.data.map((d) => ({ experimentId: d.experimentId, experimentItemId: d.experimentItemId, traceId: d.traceId })));
    cursor = (page.meta as { cursor?: string | null }).cursor ?? undefined;
  } while (cursor);
  return out;
}

/**
 * Write planned cells to Langfuse, idempotently. Langfuse v4 has no create endpoint for
 * experiment runs (the legacy dataset-run-items API returns 410 for this org; docs:
 * Experiments data model, Versions & Compatibility): an experiment item exists because its
 * root span carries the experiment attributes. So: a span is exported only when its trace
 * has no observations in this environment (live Observations API v2) and the experiment has
 * no item for that dataset item (Experiments API, which may lag); a dataset item already
 * linked to a different trace in the same run is refused. Scores always (they upsert on
 * their deterministic id). The scenarios dataset is synced from the jsonl first.
 */
export async function recordCells(
  client: RecordApi,
  plans: CellPlan[],
  options: {
    environment?: string;
    exportSpans?: typeof exportExperimentItemSpans;
    datasetItems?: DatasetItem[];
    /**
     * false: never write the dataset (the CI gate runs on unmerged branches, which must not
     * change the shared dataset); every planned item must already exist in Langfuse.
     */
    syncDataset?: boolean;
  } = {},
): Promise<RecordResult> {
  const environment = options.environment ?? EVAL_ENVIRONMENT;
  const exportSpans = options.exportSpans ?? exportExperimentItemSpans;
  if (options.syncDataset === false) {
    const remote = await client.api.datasetItems.list({ datasetName: SCENARIOS_DATASET, limit: 100 });
    const ids = new Set((remote.data as Array<{ id: string; status?: string }>).filter((d) => d.status !== "ARCHIVED").map((d) => d.id));
    const missing = [...new Set(plans.map((p) => p.datasetItemId))].filter((id) => !ids.has(id));
    if (missing.length) throw new Error(`dataset ${SCENARIOS_DATASET} in Langfuse has no active item ${missing.join(", ")}; sync it from the default branch first (npx tsx eval/langfuse-sync.ts)`);
  } else {
    await syncDataset(client.api, SCENARIOS_DATASET, options.datasetItems ?? readDataset(SCENARIOS_DATASET));
  }
  const dataset = await client.api.datasets.get(SCENARIOS_DATASET);
  const result: RecordResult = { spans: { exported: 0, existing: 0 }, scores: 0, runs: [] };
  const earliest = plans.map((p) => p.span.startTime).sort()[0];
  const from = new Date(Date.parse(earliest ?? new Date().toISOString()) - 86_400_000).toISOString();
  const known = plans.length ? await existingItems(client.api, [...new Set(plans.map((p) => p.experimentId))], from) : [];
  const toExport: ExperimentItemSpan[] = [];
  for (const plan of plans) {
    if (!result.runs.some((r) => r.runName === plan.runName)) result.runs.push({ runName: plan.runName, experimentId: plan.experimentId });
    const linked = known.find((k) => k.experimentId === plan.experimentId && k.experimentItemId === plan.datasetItemId);
    if (linked && linked.traceId !== plan.span.traceId) {
      throw new Error(`run ${plan.runName} already links ${plan.datasetItemId} to trace ${linked.traceId}, not ${plan.span.traceId}; refusing to add a second item`);
    }
    const existing = await client.api.observations.getMany({ traceId: plan.span.traceId, environment, fields: "core", limit: 10 });
    if (linked || existing.data.length > 0) result.spans.existing += 1;
    else toExport.push({ ...plan.span, experiment: { ...plan.span.experiment, datasetId: dataset.id } });
  }
  result.spans.exported = await exportSpans(toExport, { environment });
  for (const plan of plans) {
    for (const s of plan.scores) {
      client.score.create({ ...s, environment });
      result.scores += 1;
    }
  }
  await client.score.flush();
  return result;
}

/** The dataset item a cell ran (scenarios jsonl), or undefined for a scenario not in the dataset. */
export function scenarioItem(scenarioId: string, items: DatasetItem[] = readDataset(SCENARIOS_DATASET)): DatasetItem | undefined {
  return items.find((i) => i.id === scenarioItemId(scenarioId));
}

