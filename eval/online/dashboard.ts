/**
 * The "Prospector — weekly" Langfuse dashboard, as code (SPEC-observability §7). Idempotent:
 * widgets and the dashboard are found by name and created or updated only when they differ.
 * $0: Langfuse dashboard API (`/api/public/unstable/…`, docs: Custom Dashboards → "Manage
 * dashboards via API") and the Metrics API v2 for --verify. No model or Exa call.
 *
 *   npx tsx eval/online/dashboard.ts [--dry-run]
 *   npx tsx eval/online/dashboard.ts --verify [--environment online-eval-check] [--days 30]
 *
 * --verify runs every widget's query through the Metrics API v2 (the engine the widgets
 * use) against one environment and prints the rows, so a widget that the API rejects or that
 * reads the wrong score shows up before anyone opens the dashboard.
 *
 * Every widget is pinned to an environment by its own filter (a widget filter overrides the
 * dashboard's environment selector): `production`, except cost per good lead, which only the
 * offline judge can settle and therefore reads the experiment items (`eval`). Until the app
 * runs with LANGFUSE_TRACING_ENVIRONMENT=production, the production widgets are empty.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { LangfuseClient } from "@langfuse/client";
import { GRADER_NAMES } from "../graders";
import { AGENT_TRACE_NAME } from "../../src/agent/trace";
import { canonical } from "../langfuse/sync";
import { createLangfuseClient, projectId, uiLink } from "../langfuse/client";

export const DASHBOARD_NAME = "Prospector — weekly";
const PREFIX = "Prospector · ";

type Filter = { column: string; operator: string; type: string; value: unknown; key?: string };
export type WidgetSpec = {
  name: string;
  description: string;
  view: "observations" | "scores-numeric" | "scores-boolean" | "scores-categorical";
  dimensions: Array<{ field: string }>;
  metrics: Array<{ measure: string; agg: string }>;
  filters: Filter[];
  chartType: "LINE_TIME_SERIES" | "BAR_TIME_SERIES" | "HORIZONTAL_BAR" | "VERTICAL_BAR" | "PIE" | "NUMBER";
  /** Environment the widget reads (its own filter). */
  environment: string;
  /** Grid tile (12 columns). */
  tile: { x: number; y: number; width: number; height: number };
};

const env = (value: string): Filter => ({ column: "environment", operator: "any of", type: "stringOptions", value: [value] });
const scoreName = (...names: string[]): Filter => ({ column: "name", operator: "any of", type: "stringOptions", value: names });

function widget(spec: Omit<WidgetSpec, "filters" | "name"> & { name: string; filters: Filter[] }): WidgetSpec {
  return { ...spec, name: `${PREFIX}${spec.name}`, filters: [env(spec.environment), ...spec.filters] };
}

/** The weekly PM view (SPEC-observability §7). Score names are the ones the code writes (online-eval.ts, trace.ts, worker.ts, experiment.ts). */
export function dashboardWidgets(): WidgetSpec[] {
  const P = "production";
  return [
    widget({
      name: "Runs per day by stop_reason",
      description: "Run-end `stop_reason` score (one per run, src/agent/online-eval.ts), counted per day and split by value.",
      view: "scores-categorical",
      dimensions: [{ field: "stringValue" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("stop_reason")],
      chartType: "BAR_TIME_SERIES",
      environment: P,
      tile: { x: 0, y: 0, width: 8, height: 6 },
    }),
    widget({
      name: "Target reached (share of runs)",
      description: "Share of runs by `stop_reason`; the `target_leads` slice is the resolution rate.",
      view: "scores-categorical",
      dimensions: [{ field: "stringValue" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("stop_reason")],
      chartType: "PIE",
      environment: P,
      tile: { x: 8, y: 0, width: 4, height: 6 },
    }),
    widget({
      name: "Handback rate",
      description: "Mean of the run-end boolean `handback` score = share of runs that ended with a structured handback.",
      view: "scores-boolean",
      dimensions: [],
      metrics: [{ measure: "value", agg: "avg" }],
      filters: [scoreName("handback")],
      chartType: "NUMBER",
      environment: P,
      tile: { x: 0, y: 6, width: 3, height: 4 },
    }),
    widget({
      name: "Approval decisions",
      description: "`approval_decision` score on each approval span (approve / revise / decline; the comment names the tool: propose_strategy or request_scope_change). The decline slice is the decline rate.",
      view: "scores-categorical",
      dimensions: [{ field: "stringValue" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("approval_decision")],
      chartType: "PIE",
      environment: P,
      tile: { x: 3, y: 6, width: 3, height: 4 },
    }),
    widget({
      name: "Cost per run ($)",
      description: "Mean run-end `run_cost_dollars` (Claude + Exa, from state.json spend).",
      view: "scores-numeric",
      dimensions: [],
      metrics: [{ measure: "value", agg: "avg" }],
      filters: [scoreName("run_cost_dollars")],
      chartType: "NUMBER",
      environment: P,
      tile: { x: 6, y: 6, width: 3, height: 4 },
    }),
    widget({
      name: "Cost per accepted lead ($)",
      description: "Mean run-end `cost_per_accepted_lead` (run spend / accepted leads; runs with 0 leads have no score). Accepted, not good: online, good needs a judge verdict the web-less judge cannot give.",
      view: "scores-numeric",
      dimensions: [],
      metrics: [{ measure: "value", agg: "avg" }],
      filters: [scoreName("cost_per_accepted_lead")],
      chartType: "NUMBER",
      environment: P,
      tile: { x: 9, y: 6, width: 3, height: 4 },
    }),
    widget({
      name: "Cost per good lead, agent arm ($, offline judge)",
      description: "Mean `cost_per_good_lead` over agent-arm experiment items (environment eval; judged by the offline Opus judge with web fetch). Absent for runs with 0 good leads.",
      view: "scores-numeric",
      dimensions: [],
      metrics: [{ measure: "value", agg: "avg" }],
      filters: [scoreName("cost_per_good_lead"), { column: "tags", operator: "any of", type: "arrayOptions", value: ["B_agent_opus"] }],
      chartType: "NUMBER",
      environment: "eval",
      tile: { x: 0, y: 10, width: 4, height: 4 },
    }),
    widget({
      name: "p95 turn latency (ms)",
      description: `p95 duration of the \`${AGENT_TRACE_NAME}\` root observation (one per POST /step turn, from the turn_end event). Each route has maxDuration = 60 s.`,
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "latency", agg: "p95" }],
      filters: [{ column: "name", operator: "any of", type: "stringOptions", value: [AGENT_TRACE_NAME] }],
      chartType: "LINE_TIME_SERIES",
      environment: P,
      tile: { x: 4, y: 10, width: 8, height: 6 },
    }),
    widget({
      name: "user_feedback distribution",
      description: "End-user thumbs on accepted leads: +1 up, −1 down (the 👎 reason is the score comment).",
      view: "scores-numeric",
      dimensions: [{ field: "value" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("user_feedback")],
      chartType: "PIE",
      environment: P,
      tile: { x: 0, y: 14, width: 4, height: 6 },
    }),
    widget({
      name: "Must-pass failures (runs)",
      description: "Runs whose run-end `must_pass` score is false (any must-pass code grader failed). The hourly worker opens one GitHub issue per such run.",
      view: "scores-boolean",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("must_pass"), { column: "booleanValue", operator: "=", type: "boolean", value: false }],
      chartType: "NUMBER",
      environment: P,
      tile: { x: 0, y: 20, width: 4, height: 4 },
    }),
    widget({
      name: "Failed graders",
      description: "Count of false grader scores by grader name (eval/graders).",
      view: "scores-boolean",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName(...GRADER_NAMES), { column: "booleanValue", operator: "=", type: "boolean", value: false }],
      chartType: "HORIZONTAL_BAR",
      environment: P,
      tile: { x: 4, y: 16, width: 8, height: 6 },
    }),
    widget({
      name: "judge_good (online judge)",
      description: "Leads with a `judge_good` score from the worker (derived from the managed judge_q1..q3; source API, so human review labels are excluded), by value. 0 = definitely not good (the trace goes to review-queue). Online 1 is unreachable while Q3 cannot be yes without the web, and an unsettled lead gets no score, so this counts definite failures; it is not a precision. Empty until the LLM connection exists and the lead-judge rule is enabled.",
      view: "scores-boolean",
      dimensions: [{ field: "booleanValue" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [scoreName("judge_good"), { column: "source", operator: "any of", type: "stringOptions", value: ["API"] }],
      chartType: "VERTICAL_BAR",
      environment: P,
      tile: { x: 0, y: 24, width: 4, height: 4 },
    }),
  ];
}

/** The Metrics API v2 query a widget runs (for --verify). Time-series charts add a daily time dimension. */
export function widgetQuery(w: WidgetSpec, environment: string, from: string, to: string) {
  return {
    view: w.view,
    dimensions: w.dimensions,
    metrics: w.metrics.map((m) => ({ measure: m.measure, aggregation: m.agg })),
    filters: w.filters.map((f) => (f.column === "environment" ? env(environment) : f)),
    ...(w.chartType.endsWith("TIME_SERIES") ? { timeDimension: { granularity: "day" } } : {}),
    fromTimestamp: from,
    toTimestamp: to,
    config: { row_limit: 100 },
  };
}

type Api = LangfuseClient["api"];
type RemoteWidget = { id: string; name: string; description: string; view: string; dimensions: unknown; metrics: unknown; filters: unknown; chartType: string };
type Log = (line: string) => void;

function body(w: WidgetSpec) {
  return { name: w.name, description: w.description, view: w.view, dimensions: w.dimensions, metrics: w.metrics, filters: w.filters, chartType: w.chartType };
}

function sameWidget(remote: RemoteWidget, w: WidgetSpec): boolean {
  const pick = (x: { description: string; view: string; dimensions: unknown; metrics: unknown; filters: unknown; chartType: string }) =>
    canonical({ description: x.description, view: x.view, dimensions: x.dimensions, metrics: x.metrics, filters: (x.filters as Filter[]).map((f) => ({ column: f.column, operator: f.operator, type: f.type, value: f.value, ...(f.key ? { key: f.key } : {}) })), chartType: x.chartType });
  return pick(remote) === pick(w);
}

async function listAllWidgets(api: Api): Promise<RemoteWidget[]> {
  const out: RemoteWidget[] = [];
  for (let page = 1; ; page += 1) {
    const res = (await api.unstable.dashboardWidgets.list({ page, limit: 100 })) as unknown as { data: RemoteWidget[]; meta: { totalPages?: number } };
    out.push(...res.data);
    if (res.data.length === 0 || page >= (res.meta.totalPages ?? 1)) break;
  }
  return out;
}

export type DashboardResult = { dashboardId?: string; created: string[]; updated: string[]; unchanged: string[]; dashboard: "created" | "updated" | "unchanged" | "dry-run" };

/** Create or update every widget, then the dashboard and its layout. A second run changes nothing. */
export async function ensureDashboard(api: Api, options: { dryRun?: boolean; log?: Log; specs?: WidgetSpec[] } = {}): Promise<DashboardResult> {
  const log = options.log ?? (() => undefined);
  const specs = options.specs ?? dashboardWidgets();
  const remote = await listAllWidgets(api);
  const result: DashboardResult = { created: [], updated: [], unchanged: [], dashboard: "unchanged" };
  const ids = new Map<string, string>();
  for (const w of specs) {
    const matches = remote.filter((r) => r.name === w.name);
    if (matches.length > 1) throw new Error(`${matches.length} widgets named "${w.name}"; delete the extras first`);
    const existing = matches[0];
    if (!existing) {
      result.created.push(w.name);
      if (options.dryRun) continue;
      const made = (await api.unstable.dashboardWidgets.create(body(w) as never)) as unknown as { id: string };
      ids.set(w.name, made.id);
      log(`widget created: ${w.name}`);
    } else if (!sameWidget(existing, w)) {
      result.updated.push(w.name);
      ids.set(w.name, existing.id);
      if (options.dryRun) continue;
      await api.unstable.dashboardWidgets.update(existing.id, body(w) as never);
      log(`widget updated: ${w.name}`);
    } else {
      result.unchanged.push(w.name);
      ids.set(w.name, existing.id);
    }
  }
  if (options.dryRun) {
    result.dashboard = "dry-run";
    return result;
  }
  const definition = {
    widgets: specs.map((w, i) => ({ type: "widget", id: `prospector-weekly-${i + 1}`, widgetId: ids.get(w.name)!, x: w.tile.x, y: w.tile.y, width: w.tile.width, height: w.tile.height })),
  };
  const description =
    "Weekly PM view (SPEC-observability §7). Widgets read environment production (cost per good lead: eval experiments). Managed as code: npx tsx eval/online/dashboard.ts — edits in the UI are overwritten on the next run.";
  const dashboards = (await api.unstable.dashboards.list({ limit: 100 } as never)) as unknown as { data: Array<{ id: string; name: string; description: string; definition: unknown }> };
  const named = dashboards.data.filter((d) => d.name === DASHBOARD_NAME);
  if (named.length > 1) throw new Error(`${named.length} dashboards named "${DASHBOARD_NAME}"; delete the extras first`);
  const current = named[0];
  if (!current) {
    const made = (await api.unstable.dashboards.create({ name: DASHBOARD_NAME, description, definition } as never)) as unknown as { id: string };
    result.dashboardId = made.id;
    result.dashboard = "created";
    log(`dashboard created: ${DASHBOARD_NAME}`);
  } else {
    result.dashboardId = current.id;
    if (canonical({ description: current.description, definition: current.definition }) !== canonical({ description, definition })) {
      await api.unstable.dashboards.update(current.id, { description, definition } as never);
      result.dashboard = "updated";
      log(`dashboard updated: ${DASHBOARD_NAME}`);
    }
  }
  return result;
}

async function verify(environment: string, days: number): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  for (const w of dashboardWidgets()) {
    const queryEnv = w.environment === "production" ? environment : w.environment;
    const q = widgetQuery(w, queryEnv, from.toISOString(), to.toISOString());
    const res = await fetch(`${base}/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(q))}`, { headers: { authorization: `Basic ${auth}` } });
    const text = await res.text();
    if (!res.ok) {
      console.log(`FAIL ${w.name} [${queryEnv}]: HTTP ${res.status} ${text.slice(0, 300)}`);
      process.exitCode = 1;
      continue;
    }
    const rows = (JSON.parse(text) as { data: unknown[] }).data;
    console.log(`ok   ${w.name} [${queryEnv}]: ${rows.length} row(s) ${JSON.stringify(rows.slice(0, 6))}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--verify")) {
    await verify(arg("--environment") ?? "production", Number(arg("--days") ?? 30));
    return;
  }
  const client = await createLangfuseClient();
  const result = await ensureDashboard(client.api, { dryRun: argv.includes("--dry-run"), log: console.log });
  console.log(`widgets: created ${result.created.length} · updated ${result.updated.length} · unchanged ${result.unchanged.length}; dashboard ${result.dashboard}`);
  if (result.dashboardId) console.log(`dashboard: ${uiLink(await projectId(client), `dashboards/${result.dashboardId}`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
