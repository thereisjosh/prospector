/**
 * Online-evaluation configuration in Langfuse, as code (SPEC-observability §5). Idempotent:
 * finds each object by name and creates or updates it only when it differs.
 *
 *   npx tsx eval/online/setup-langfuse.ts [--dry-run] [--enable-rule]
 *
 * Creates or updates, all $0:
 *  - score configs judge_q1/q2/q3 (categorical yes/no/cannot_verify), judge_good (boolean),
 *    user_feedback (numeric −1..1), review_outcome (new_case / wont_fix);
 *  - the `review-queue` annotation queue (review_outcome + the judge configs, so human labels
 *    land under the same score names as the judges and feed Score Analytics agreement);
 *  - three LLM-as-a-judge evaluators judge_q1/q2/q3 (eval/online/judge-prompt.ts), pinned to
 *    the offline judge's model, mapping {{lead}} ← observation input;
 *  - one evaluation rule "lead-judge (production)": observations named `lead-judge` in
 *    environment production, sampling 1 (selection and the dollar cap are ours:
 *    src/agent/online-eval.ts). The rule is created DISABLED and stays disabled unless
 *    --enable-rule is passed: per references/judge-calibration.md a new judge runs only
 *    after its calibration is approved;
 *  - judge-calibration datasets and candidate prompts, one per question
 *    (`judge-calibration/<judge>`), from eval/online/calibration-set.ts.
 * No model is called. (Saving an evaluator may make Langfuse send one short validation
 * request through the project's LLM connection; with no connection the evaluator is saved
 * paused.)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { LangfuseClient } from "@langfuse/client";
import { createLangfuseClient, isNotFound, projectId, uiLink } from "../langfuse/client";
import { canonical } from "../langfuse/sync";
import { LEAD_JUDGE_OBSERVATION, REVIEW_QUEUE_NAME } from "../../src/agent/trace";
import { ONLINE_JUDGE_ENVIRONMENTS } from "../../src/agent/online-eval";
import { calibrationDatasetName, calibrationItems } from "./calibration-set";
import { JUDGE_MODEL, JUDGE_QUESTIONS, LEAD_VARIABLE, judgeMessages, judgeOutputDefinition, type JudgeQuestion } from "./judge-prompt";

export const RULE_NAME = `${LEAD_JUDGE_OBSERVATION} (production)`;

type Api = LangfuseClient["api"];
type Log = (line: string) => void;

const Q_DESCRIPTION: Record<JudgeQuestion, string> = {
  judge_q1: "RUBRIC §1 Q1 company fit",
  judge_q2: "RUBRIC §1 Q2 size band",
  judge_q3: "RUBRIC §1 Q3 why-now signal",
};

export const SCORE_CONFIGS = [
  ...JUDGE_QUESTIONS.map((q) => ({
    name: q,
    dataType: "CATEGORICAL" as const,
    categories: [
      { label: "yes", value: 1 },
      { label: "no", value: 0 },
      { label: "cannot_verify", value: 2 },
    ],
    description: `${Q_DESCRIPTION[q]}: yes / no / cannot_verify. Same name for the offline Opus judge (eval/harness/judge.ts), the managed online evaluator and human review.`,
  })),
  {
    name: "judge_good",
    dataType: "BOOLEAN" as const,
    description: "RUBRIC §1 good lead = Q1 yes AND Q3 yes AND Q2 != no. Offline: judge.ts; online: derived from the managed judge_q1..q3 by eval/online/worker.ts; human: review-queue.",
  },
  { name: "user_feedback", dataType: "NUMERIC" as const, minValue: -1, maxValue: 1, description: "End-user thumbs on an accepted lead: +1 up, -1 down; the reason is the score comment." },
  {
    name: "review_outcome",
    dataType: "CATEGORICAL" as const,
    categories: [
      { label: "new_case", value: 1 },
      { label: "wont_fix", value: 0 },
    ],
    description: "review-queue outcome: new_case (add it to eval/datasets/prospector-cases.jsonl) or wont_fix (say why in the comment).",
  },
];

const QUEUE_DESCRIPTION =
  "Production runs to review (SPEC-observability §5): every thumbs-down lead trace, every run that ended with a handback, an error or a failed must-pass grader, and every lead the online judge scored no. Each item ends as review_outcome new_case (add a dataset case) or wont_fix (say why). Labelling judge_q1..q3 here also feeds human-vs-judge agreement in Score Analytics.";

export function evaluatorBody(question: JudgeQuestion, rubric: string, model: "pinned" | "default" = "pinned") {
  return {
    name: question,
    description: `${Q_DESCRIPTION[question]} on production leads selected by src/agent/online-eval.ts (lead-judge observations). No web access: see eval/online/judge-prompt.ts. Source of truth: eval/online/judge-prompt.ts + eval/RUBRIC.md.`,
    type: "llm_as_judge" as const,
    prompt: judgeMessages(question, rubric),
    modelConfig: model === "pinned" ? { ...JUDGE_MODEL } : null,
    variableMapping: [{ variable: LEAD_VARIABLE, source: "input" as const }],
    outputDefinition: judgeOutputDefinition(question),
  };
}

export function ruleFilter() {
  return [
    { type: "stringOptions" as const, column: "environment", operator: "any of" as const, value: ONLINE_JUDGE_ENVIRONMENTS },
    { type: "stringOptions" as const, column: "name", operator: "any of" as const, value: [LEAD_JUDGE_OBSERVATION] },
  ];
}

async function ensureScoreConfigs(api: Api, dryRun: boolean, log: Log): Promise<Map<string, string>> {
  const existing: Array<{ id: string; name: string; isArchived?: boolean }> = [];
  for (let page = 1; ; page += 1) {
    const res = await api.scoreConfigs.get({ page, limit: 100 });
    existing.push(...(res.data as typeof existing));
    if (page >= (res.meta.totalPages ?? 1) || res.data.length === 0) break;
  }
  const ids = new Map<string, string>();
  for (const config of SCORE_CONFIGS) {
    const hit = existing.find((c) => c.name === config.name && !c.isArchived);
    if (hit) {
      ids.set(config.name, hit.id);
      log(`score config ${config.name}: exists (${hit.id})`);
      continue;
    }
    if (dryRun) {
      log(`score config ${config.name}: would create`);
      continue;
    }
    const created = await api.scoreConfigs.create(config as never);
    ids.set(config.name, created.id);
    log(`score config ${config.name}: created (${created.id})`);
  }
  return ids;
}

async function ensureQueue(api: Api, configIds: Map<string, string>, dryRun: boolean, log: Log): Promise<string | undefined> {
  for (let page = 1; ; page += 1) {
    const res = await api.annotationQueues.listQueues({ page, limit: 100 });
    const hit = res.data.find((q) => q.name === REVIEW_QUEUE_NAME);
    if (hit) {
      log(`annotation queue ${REVIEW_QUEUE_NAME}: exists (${hit.id})`);
      return hit.id;
    }
    if (page >= (res.meta.totalPages ?? 1) || res.data.length === 0) break;
  }
  if (dryRun) {
    log(`annotation queue ${REVIEW_QUEUE_NAME}: would create`);
    return undefined;
  }
  const scoreConfigIds = ["review_outcome", ...JUDGE_QUESTIONS, "judge_good"].map((n) => configIds.get(n)).filter((id): id is string => !!id);
  const queue = await api.annotationQueues.createQueue({ name: REVIEW_QUEUE_NAME, description: QUEUE_DESCRIPTION, scoreConfigIds });
  log(`annotation queue ${REVIEW_QUEUE_NAME}: created (${queue.id})`);
  return queue.id;
}

type RemoteEvaluator = { id: string; name: string; status?: string; pausedReason?: string | null; pausedMessage?: string | null; prompt?: unknown; modelConfig?: unknown; variableMapping?: unknown; outputDefinition?: unknown };

async function listEvaluators(api: Api): Promise<RemoteEvaluator[]> {
  const out: RemoteEvaluator[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const res = (await api.evaluators.list({ limit: 100, ...(cursor ? { cursor } : {}) } as never)) as unknown as { data: RemoteEvaluator[]; meta?: { cursor?: string | null; nextCursor?: string | null } };
    out.push(...res.data);
    cursor = res.meta?.nextCursor ?? res.meta?.cursor ?? undefined;
    if (!cursor || res.data.length === 0) break;
  }
  return out;
}

function sameEvaluator(remote: RemoteEvaluator, body: ReturnType<typeof evaluatorBody>): boolean {
  const out = (remote.outputDefinition ?? {}) as Record<string, unknown>;
  const want = body.outputDefinition as unknown as Record<string, unknown>;
  const outputSame = Object.keys(want).every((k) => canonical(out[k]) === canonical(want[k]));
  const mapping = ((remote.variableMapping ?? []) as Array<{ variable: string; source: string | null; jsonPath?: string | null }>).map((m) => ({ variable: m.variable, source: m.source }));
  return (
    canonical(remote.prompt) === canonical(body.prompt) &&
    canonical(remote.modelConfig ?? null) === canonical(body.modelConfig) &&
    canonical(mapping) === canonical(body.variableMapping) &&
    outputSame
  );
}

async function ensureEvaluators(api: Api, rubric: string, model: "pinned" | "default", dryRun: boolean, log: Log): Promise<Map<JudgeQuestion, RemoteEvaluator>> {
  const remote = await listEvaluators(api);
  const out = new Map<JudgeQuestion, RemoteEvaluator>();
  for (const q of JUDGE_QUESTIONS) {
    const body = evaluatorBody(q, rubric, model);
    const hit = remote.find((e) => e.name === q);
    if (!hit) {
      if (dryRun) {
        log(`evaluator ${q}: would create`);
        continue;
      }
      const created = (await api.evaluators.create(body as never)) as unknown as RemoteEvaluator;
      out.set(q, created);
      log(`evaluator ${q}: created (${created.id}, status ${created.status ?? "?"}${created.pausedReason ? `, paused: ${created.pausedReason}` : ""})`);
      continue;
    }
    if (sameEvaluator(hit, body)) {
      out.set(q, hit);
      log(`evaluator ${q}: unchanged (${hit.id}, status ${hit.status ?? "?"}${hit.pausedReason ? `, paused: ${hit.pausedReason}` : ""})`);
      continue;
    }
    if (dryRun) {
      out.set(q, hit);
      log(`evaluator ${q}: would update (${hit.id})`);
      continue;
    }
    const { name: _name, ...definition } = body;
    const updated = (await api.evaluators.update(hit.id, definition as never)) as unknown as RemoteEvaluator;
    out.set(q, updated);
    log(`evaluator ${q}: updated (${updated.id}, new version)`);
  }
  return out;
}

type RemoteRule = { id: string; name: string; enabled?: boolean; sampling?: number; filter?: unknown; evaluators?: Array<{ evaluatorId: string }>; evaluatorAssignments?: Array<{ evaluatorId: string }> };

async function ensureRule(api: Api, evaluators: Map<JudgeQuestion, RemoteEvaluator>, enable: boolean, dryRun: boolean, log: Log): Promise<RemoteRule | undefined> {
  const res = (await api.evaluationRules.list({ limit: 100 } as never)) as unknown as { data: RemoteRule[] };
  const hit = res.data.find((r) => r.name === RULE_NAME);
  const assignments = JUDGE_QUESTIONS.map((q) => evaluators.get(q)?.id).filter((id): id is string => !!id).map((evaluatorId) => ({ evaluatorId, variableMapping: null }));
  const body = { name: RULE_NAME, enabled: enable && assignments.length === JUDGE_QUESTIONS.length, sampling: 1, filter: ruleFilter(), evaluatorAssignments: assignments };
  if (!hit) {
    if (dryRun) {
      log(`rule ${RULE_NAME}: would create (enabled ${body.enabled})`);
      return undefined;
    }
    const created = (await api.evaluationRules.create(body as never)) as unknown as RemoteRule;
    log(`rule ${RULE_NAME}: created (${created.id}, enabled ${created.enabled})`);
    return created;
  }
  const remoteAssigned = (hit.evaluatorAssignments ?? hit.evaluators ?? []).map((a) => a.evaluatorId).sort();
  const same = hit.enabled === body.enabled && hit.sampling === 1 && canonical(hit.filter) === canonical(body.filter) && canonical(remoteAssigned) === canonical(assignments.map((a) => a.evaluatorId).sort());
  if (same) {
    log(`rule ${RULE_NAME}: unchanged (${hit.id}, enabled ${hit.enabled})`);
    return hit;
  }
  if (dryRun) {
    log(`rule ${RULE_NAME}: would update (${hit.id})`);
    return hit;
  }
  const updated = (await api.evaluationRules.update(hit.id, { enabled: body.enabled, sampling: 1, filter: body.filter, evaluatorAssignments: assignments } as never)) as unknown as RemoteRule;
  log(`rule ${RULE_NAME}: updated (${updated.id}, enabled ${updated.enabled})`);
  return updated;
}

async function ensureCalibration(client: LangfuseClient, rubric: string, dryRun: boolean, log: Log): Promise<void> {
  const api = client.api;
  for (const q of JUDGE_QUESTIONS) {
    const name = calibrationDatasetName(q);
    const items = calibrationItems(q);
    let exists = true;
    try {
      await api.datasets.get(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      exists = false;
    }
    if (!exists && !dryRun) {
      await api.datasets.create({
        name,
        description: `Calibration set for the online ${q} evaluator: the 10 human spot-checked pilot leads (eval/truth/SPOT-CHECKS.md). Built by eval/online/calibration-set.ts.`,
        metadata: { judge: q, source: "eval/online/calibration-set.ts" },
      });
    }
    const remote = new Map<string, { input?: unknown; expectedOutput?: unknown; metadata?: unknown; status?: string }>();
    if (exists) {
      const res = await api.datasetItems.list({ datasetName: name, page: 1, limit: 100 });
      for (const r of res.data) remote.set(r.id, r);
    }
    let changed = 0;
    for (const item of items) {
      const r = remote.get(item.id);
      const same = r && r.status === "ACTIVE" && canonical(r.input) === canonical(item.input) && canonical(r.expectedOutput) === canonical(item.expectedOutput) && canonical(r.metadata) === canonical(item.metadata);
      if (same) continue;
      changed += 1;
      if (!dryRun) await api.datasetItems.create({ datasetName: name, id: item.id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata, status: "ACTIVE" });
    }
    log(`dataset ${name}: ${exists ? "exists" : dryRun ? "would create" : "created"}, ${changed} item(s) ${dryRun ? "to write" : "written"}, ${items.length - changed} unchanged`);

    // Candidate prompt: a new version only when the messages changed; never labelled production here.
    const messages = judgeMessages(q, rubric);
    let latest: { version: number; prompt: unknown } | undefined;
    try {
      latest = (await api.prompts.get(name, { label: "latest", resolve: false })) as unknown as { version: number; prompt: unknown };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const remoteMessages = Array.isArray(latest?.prompt) ? (latest!.prompt as Array<{ role: string; content: string }>).map((m) => ({ role: m.role, content: m.content })) : undefined;
    if (remoteMessages && canonical(remoteMessages) === canonical(messages)) {
      log(`prompt ${name}: unchanged (v${latest!.version})`);
      continue;
    }
    if (dryRun) {
      log(`prompt ${name}: would create a version`);
      continue;
    }
    const created = await client.prompt.create({
      name,
      type: "chat",
      prompt: messages,
      labels: [],
      config: { model: JUDGE_MODEL.model, provider: JUDGE_MODEL.provider, outputDefinition: judgeOutputDefinition(q) },
      commitMessage: "candidate judge prompt (eval/online/judge-prompt.ts)",
    } as never);
    log(`prompt ${name}: created v${(created as unknown as { version: number }).version}`);
  }
}

export async function setupLangfuse(options: { dryRun?: boolean; enableRule?: boolean; model?: "pinned" | "default"; log?: Log } = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  const dryRun = !!options.dryRun;
  const client = await createLangfuseClient();
  const rubric = readFileSync("eval/RUBRIC.md", "utf8");
  const project = await projectId(client);
  const configIds = await ensureScoreConfigs(client.api, dryRun, log);
  const queueId = await ensureQueue(client.api, configIds, dryRun, log);
  const evaluators = await ensureEvaluators(client.api, rubric, options.model ?? "pinned", dryRun, log);
  const rule = await ensureRule(client.api, evaluators, !!options.enableRule, dryRun, log);
  await ensureCalibration(client, rubric, dryRun, log);
  log("");
  log(`evaluators:   ${uiLink(project, "evals")}`);
  for (const [q, e] of evaluators) log(`  ${q}: ${uiLink(project, `evals/${e.id}`)}`);
  if (rule) log(`rule:         ${RULE_NAME} (${rule.id}), enabled ${rule.enabled}`);
  if (queueId) log(`review queue: ${uiLink(project, `annotation-queues/${queueId}`)}`);
  for (const q of JUDGE_QUESTIONS) log(`calibration:  ${uiLink(project, "datasets")} → ${calibrationDatasetName(q)}`);
  return { project, queueId, evaluators, rule };
}

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    enableRule: argv.includes("--enable-rule"),
    model: (argv.includes("--default-model") ? "default" : "pinned") as "pinned" | "default",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupLangfuse(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    const e = error as { statusCode?: number; body?: unknown; message?: string };
    console.error(`setup-langfuse failed: ${e.statusCode ?? ""} ${e.message ?? String(error)}`);
    if (e.body) console.error(JSON.stringify(e.body).slice(0, 2000));
    process.exitCode = 1;
  });
}
