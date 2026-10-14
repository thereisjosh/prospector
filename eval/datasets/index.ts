/**
 * The eval datasets, in-repo source of truth (`eval/datasets/*.jsonl`), mirrored to
 * Langfuse Datasets by `eval/langfuse-sync.ts`. One JSON object per line, in the shape
 * of a Langfuse dataset item: `id` (project-unique, the upsert key), `input`,
 * `expectedOutput`, `metadata`. Notes and grader wiring live in `metadata`, never in
 * `input` / `expectedOutput` (Langfuse dataset guidance).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRADER_NAMES } from "../graders/types";

export const DATASETS = {
  "prospector-scenarios": {
    file: "prospector-scenarios.jsonl",
    description:
      "End-to-end contracts (S1 logistics, S2 funded B2B). One item per scenario; an experiment run = one arm × one rep. Pass = ≥6 good leads, precision ≥0.8, spend ≤ cap (eval/RUBRIC.md §3). Source of truth: eval/datasets/prospector-scenarios.jsonl.",
  },
  "prospector-cases": {
    file: "prospector-cases.jsonl",
    description:
      "Graded regression cases: every docs/FAILURES.md entry, adversarial prompt-injection cases and escalation cases. metadata.kind tags the behaviour; metadata.grader names the code grader (eval/graders), vitest test or 'manual'. Source of truth: eval/datasets/prospector-cases.jsonl.",
  },
} as const;

export type DatasetName = keyof typeof DATASETS;

export const CASE_KINDS = ["task-outcome", "tool-use", "policy", "safety-adversarial", "escalation", "quality", "reliability", "cost"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** Graders a case can name besides the code graders: the rubric scorer, a vitest test, or a manual check (no automated test yet). */
export const OTHER_GRADERS = ["rubric_pass", "vitest", "manual"] as const;

export type DatasetItem = {
  id: string;
  input: unknown;
  expectedOutput: unknown;
  metadata: {
    kind: CaseKind;
    kinds: CaseKind[];
    source: string;
    title: string;
    grader: string;
    mustPass: boolean;
    mode: "mocked" | "recorded" | "replay" | "live";
    /** vitest: "<file>::<test name>". */
    test?: string;
    alsoTests?: string[];
    alsoGradedBy?: string[];
    graderArgs?: Record<string, unknown>;
    /** recorded: run dirs (state.json + events.jsonl) the grader must fail / pass on. */
    fixtures?: { fails?: string[]; passes?: string[] };
    coverage?: string;
    [key: string]: unknown;
  };
};

export const DATASETS_DIR = join(process.cwd(), "eval", "datasets");

export function readDataset(name: DatasetName, dir = DATASETS_DIR): DatasetItem[] {
  return readFileSync(join(dir, DATASETS[name].file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as DatasetItem;
      } catch (error) {
        throw new Error(`${DATASETS[name].file}:${i + 1}: invalid JSON (${error instanceof Error ? error.message : error})`);
      }
    });
}

/** Problems with a dataset; empty when valid. Paths are resolved against `root` (the repo). */
export function validateDataset(name: DatasetName, items: DatasetItem[], root = process.cwd()): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const prefix = name === "prospector-scenarios" ? "scenario-" : "case-";
  for (const item of items) {
    const at = `${name}/${item.id ?? "?"}`;
    if (typeof item.id !== "string" || !item.id.startsWith(prefix)) problems.push(`${at}: id must start with "${prefix}" (ids are project-unique in Langfuse)`);
    if (seen.has(item.id)) problems.push(`${at}: duplicate id`);
    seen.add(item.id);
    if (item.input === undefined) problems.push(`${at}: input is required`);
    const m = item.metadata;
    if (!m || typeof m !== "object") {
      problems.push(`${at}: metadata is required`);
      continue;
    }
    if (!(CASE_KINDS as readonly string[]).includes(m.kind)) problems.push(`${at}: kind "${m.kind}" is not one of ${CASE_KINDS.join(", ")}`);
    if (!Array.isArray(m.kinds) || m.kinds[0] !== m.kind || m.kinds.some((k) => !(CASE_KINDS as readonly string[]).includes(k))) problems.push(`${at}: kinds must start with kind and use known kinds`);
    if (!m.source || !m.title) problems.push(`${at}: source and title are required`);
    const graders = [m.grader, ...(m.alsoGradedBy ?? []), ...((m.graders as string[] | undefined) ?? [])];
    for (const g of graders) {
      if (!(GRADER_NAMES as readonly string[]).includes(g) && !(OTHER_GRADERS as readonly string[]).includes(g)) problems.push(`${at}: unknown grader "${g}"`);
    }
    if (m.grader === "vitest" && !m.test) problems.push(`${at}: grader vitest needs metadata.test`);
    if (m.grader === "manual" && !m.coverage) problems.push(`${at}: grader manual needs metadata.coverage (why no automated grader)`);
    for (const ref of [m.test, ...(m.alsoTests ?? [])].filter((t): t is string => typeof t === "string")) {
      const [file, testName] = ref.split("::");
      if (!file || !testName) {
        problems.push(`${at}: test "${ref}" must be "<file>::<test name>"`);
        continue;
      }
      const path = join(root, file);
      if (!existsSync(path)) problems.push(`${at}: test file ${file} does not exist`);
      else if (!readFileSync(path, "utf8").includes(testName)) problems.push(`${at}: test "${testName}" not found in ${file}`);
    }
    for (const dir of [...(m.fixtures?.fails ?? []), ...(m.fixtures?.passes ?? [])]) {
      if (!existsSync(join(root, dir, "state.json")) || !existsSync(join(root, dir, "events.jsonl"))) problems.push(`${at}: fixture ${dir} has no state.json + events.jsonl`);
    }
    if (name === "prospector-cases") {
      const expected = item.expectedOutput as { expected?: unknown; must_not?: unknown } | undefined;
      if (!expected || expected.expected === undefined || !Array.isArray(expected.must_not) || expected.must_not.length === 0) problems.push(`${at}: expectedOutput needs expected and a non-empty must_not`);
    }
  }
  return problems;
}

/** FAILURES.md entry numbers each case covers (metadata.source "FAILURES#n"). */
export function failuresCovered(items: DatasetItem[]): number[] {
  return [...new Set(items.map((i) => /^FAILURES#(\d+)$/.exec(i.metadata.source)?.[1]).filter((n): n is string => !!n).map(Number))].sort((a, b) => a - b);
}

export function countByKind(items: DatasetItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.metadata.kind] = (out[item.metadata.kind] ?? 0) + 1;
  return out;
}
