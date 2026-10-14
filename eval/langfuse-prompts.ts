/**
 * Keep the repo and Langfuse Prompt Management in sync ($0: prompt API only, no model calls).
 *
 *   npx tsx eval/langfuse-prompts.ts diff [--label production]   exit 1 when any prompt differs or is missing
 *   npx tsx eval/langfuse-prompts.ts push [--label production]   repo → Langfuse; a new version only when text/config differ
 *   npx tsx eval/langfuse-prompts.ts pull [--label production]   Langfuse → repo; rewrites the <langfuse-prompt> blocks
 *
 * The repo copy of each prompt lives in a `// <langfuse-prompt name="…">` block in its
 * owning source file (the runtime fallback). Workflow: docs/prompts.md.
 */
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_SYSTEM_PROMPT_DEF } from "../src/agent/prompts";
import type { PromptConfig, PromptDef } from "../src/agent/prompt-store";
import { CARDS_PROMPT_DEF } from "../src/planner/cards";
import { FORMAT_MARKER } from "../src/planner/claude";
import { COMPILE_PROMPT_DEF } from "../src/planner/compile";

export type PromptSource = {
  def: PromptDef;
  /** Repo-relative file holding the block. */
  file: string;
  textConst: string;
  configConst: string;
  /** Text the prompt must contain (checked on push and pull). */
  requires?: string;
};

export const PROMPT_SOURCES: PromptSource[] = [
  { def: AGENT_SYSTEM_PROMPT_DEF, file: "src/agent/prompts.ts", textConst: "AGENT_SYSTEM_PROMPT", configConst: "AGENT_SYSTEM_CONFIG" },
  { def: CARDS_PROMPT_DEF, file: "src/planner/cards.ts", textConst: "CARDS_SYSTEM_PROMPT", configConst: "CARDS_PROMPT_CONFIG", requires: FORMAT_MARKER },
  { def: COMPILE_PROMPT_DEF, file: "src/planner/compile.ts", textConst: "COMPILE_SYSTEM_PROMPT", configConst: "COMPILE_PROMPT_CONFIG", requires: FORMAT_MARKER },
];

type RemotePrompt = { version: number; type: string; prompt: unknown; config: unknown; labels: string[] };

/** The slice of `LangfuseClient` the sync uses (mocked in tests). */
export type SyncClient = {
  /** Raw public API: no SDK cache, no SDK error logging for an expected 404. */
  api: { prompts: { get(name: string, request: { label: string }): Promise<RemotePrompt> } };
  prompt: {
    create(body: { name: string; type: "text"; prompt: string; config: PromptConfig; labels: string[]; commitMessage?: string }): Promise<{ version: number }>;
    update(params: { name: string; version: number; newLabels: string[] }): Promise<unknown>;
  };
};

/* ---------- pure helpers ---------- */

/** JSON with sorted keys, so config comparison ignores key order. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    : v;
  return JSON.stringify(sort(value ?? {}));
}

export function templateLiteral(text: string): string {
  return "`" + text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

const BLOCK_START = (name: string) => `// <langfuse-prompt name="${name}">`;
const BLOCK_END = "// </langfuse-prompt>";

export function renderBlock(source: PromptSource, text: string, config: PromptConfig): string {
  return [
    `${BLOCK_START(source.def.name)} repo copy and runtime fallback; sync with \`npx tsx eval/langfuse-prompts.ts push|pull|diff\` (docs/prompts.md)`,
    `export const ${source.textConst} = ${templateLiteral(text)};`,
    `export const ${source.configConst}: PromptConfig = ${JSON.stringify(config)};`,
    BLOCK_END,
  ].join("\n");
}

/** Replace the named block in a source file; throws when the block is missing or duplicated. */
export function replaceBlock(fileText: string, source: PromptSource, text: string, config: PromptConfig): string {
  const start = fileText.indexOf(BLOCK_START(source.def.name));
  if (start < 0 || fileText.indexOf(BLOCK_START(source.def.name), start + 1) >= 0) {
    throw new Error(`${source.file}: expected exactly one ${BLOCK_START(source.def.name)} block`);
  }
  const end = fileText.indexOf(BLOCK_END, start);
  if (end < 0) throw new Error(`${source.file}: unterminated block for ${source.def.name}`);
  return fileText.slice(0, start) + renderBlock(source, text, config) + fileText.slice(end + BLOCK_END.length);
}

export type DiffResult = {
  name: string;
  label: string;
  status: "same" | "differs" | "missing";
  version?: number;
  /** Human-readable reasons when status is "differs". */
  details: string[];
};

function firstDifference(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) {
      const clip = (s: string | undefined) => (s === undefined ? "<none>" : JSON.stringify(s.length > 160 ? `${s.slice(0, 159)}…` : s));
      return `text differs at line ${i + 1}:\n      repo:     ${clip(al[i])}\n      langfuse: ${clip(bl[i])}`;
    }
  }
  return "text differs";
}

export function compare(def: PromptDef, remote: RemotePrompt | undefined, label: string): DiffResult {
  if (!remote) return { name: def.name, label, status: "missing", details: [`no version labelled ${label}`] };
  const details: string[] = [];
  if (remote.type !== "text") details.push(`type is ${remote.type}, expected text`);
  else if (remote.prompt !== def.text) details.push(firstDifference(def.text, String(remote.prompt)));
  if (canonicalJson(remote.config) !== canonicalJson(def.config)) {
    details.push(`config differs: repo ${canonicalJson(def.config)} vs langfuse ${canonicalJson(remote.config)}`);
  }
  return { name: def.name, label, status: details.length ? "differs" : "same", version: remote.version, details };
}

function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404;
}

async function fetchRemote(client: SyncClient, name: string, label: string): Promise<RemotePrompt | undefined> {
  try {
    // The raw API, not the cached PromptManager: the sync must see the server's current state.
    return await client.api.prompts.get(name, { label });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function checkRequired(source: PromptSource, text: string, where: string): void {
  if (source.requires && !text.includes(source.requires)) {
    throw new Error(`${source.def.name} (${where}) must contain "${source.requires}" (the planner retry repeats that section)`);
  }
}

/* ---------- commands ---------- */

export async function diffPrompts(client: SyncClient, label: string, sources = PROMPT_SOURCES): Promise<DiffResult[]> {
  const results: DiffResult[] = [];
  for (const source of sources) results.push(compare(source.def, await fetchRemote(client, source.def.name, label), label));
  return results;
}

export type PushResult = { name: string; action: "unchanged" | "labelled" | "created"; version: number };

export async function pushPrompts(client: SyncClient, label: string, sources = PROMPT_SOURCES, commitMessage?: string): Promise<PushResult[]> {
  const results: PushResult[] = [];
  for (const source of sources) {
    const { def } = source;
    checkRequired(source, def.text, "repo");
    const current = await fetchRemote(client, def.name, label);
    if (current && compare(def, current, label).status === "same") {
      results.push({ name: def.name, action: "unchanged", version: current.version });
      continue;
    }
    // The newest version may already hold this text (e.g. pushed earlier to another label): move the label, no new version.
    const latest = label === "latest" ? current : await fetchRemote(client, def.name, "latest");
    if (latest && compare(def, latest, "latest").status === "same") {
      const newLabels = [...new Set([...latest.labels.filter((l) => l !== "latest"), label])];
      await client.prompt.update({ name: def.name, version: latest.version, newLabels });
      results.push({ name: def.name, action: "labelled", version: latest.version });
      continue;
    }
    const created = await client.prompt.create({
      name: def.name,
      type: "text",
      prompt: def.text,
      config: def.config,
      labels: label === "latest" ? [] : [label],
      ...(commitMessage ? { commitMessage } : {}),
    });
    results.push({ name: def.name, action: "created", version: created.version });
  }
  return results;
}

export type PullResult = { name: string; file: string; version: number; changed: boolean };

export async function pullPrompts(
  client: SyncClient,
  label: string,
  sources = PROMPT_SOURCES,
  io: { read(file: string): Promise<string>; write(file: string, text: string): Promise<void> } = {
    read: (file) => readFile(resolve(file), "utf8"),
    write: (file, text) => writeFile(resolve(file), text, "utf8"),
  },
): Promise<PullResult[]> {
  const results: PullResult[] = [];
  for (const source of sources) {
    const remote = await fetchRemote(client, source.def.name, label);
    if (!remote) throw new Error(`${source.def.name}: no version labelled ${label}`);
    if (remote.type !== "text" || typeof remote.prompt !== "string") throw new Error(`${source.def.name}: not a text prompt`);
    checkRequired(source, remote.prompt, `langfuse v${remote.version}`);
    const config = (remote.config && typeof remote.config === "object" && !Array.isArray(remote.config) ? remote.config : {}) as PromptConfig;
    const before = await io.read(source.file);
    const after = replaceBlock(before, source, remote.prompt, config);
    if (after !== before) await io.write(source.file, after);
    results.push({ name: source.def.name, file: source.file, version: remote.version, changed: after !== before });
  }
  return results;
}

/* ---------- CLI ---------- */

function promptUrl(project: string | undefined, name: string): string {
  const base = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/+$/, "");
  return project ? `${base}/project/${project}/prompts/${encodeURIComponent(name)}` : `${base} (prompt ${name})`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const labelAt = rest.indexOf("--label");
  const label = labelAt >= 0 ? rest[labelAt + 1] ?? "" : "production";
  if (!["diff", "push", "pull"].includes(command ?? "") || !/^[a-z0-9_.-]{1,36}$/i.test(label)) {
    console.error("usage: npx tsx eval/langfuse-prompts.ts diff|push|pull [--label production]");
    return 2;
  }
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    // Never report "in sync" without having looked: CI must fail loudly when keys are missing.
    console.error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set; cannot compare with Langfuse.");
    return 2;
  }
  const { LangfuseClient } = await import("@langfuse/client");
  const client = new LangfuseClient() as unknown as SyncClient;

  if (command === "diff") {
    const results = await diffPrompts(client, label);
    for (const r of results) {
      console.log(`${r.status === "same" ? "same   " : r.status === "missing" ? "MISSING" : "DIFFERS"} ${r.name}${r.version !== undefined ? ` (${label} = v${r.version})` : ""}`);
      for (const d of r.details) console.log(`    ${d}`);
    }
    const bad = results.filter((r) => r.status !== "same");
    if (bad.length) console.log(`\n${bad.length} prompt(s) out of sync with label ${label}. Pull (Langfuse is right) or push (repo is right); see docs/prompts.md.`);
    return bad.length ? 1 : 0;
  }
  if (command === "push") {
    const results = await pushPrompts(client, label, PROMPT_SOURCES, "pushed from repo by eval/langfuse-prompts.ts");
    // The key pair is project-scoped, so the API returns exactly this project.
    const projects = await (client as unknown as { api: { projects: { get(): Promise<{ data: Array<{ id: string }> }> } } }).api.projects.get().catch(() => ({ data: [] }));
    for (const r of results) console.log(`${r.action.padEnd(9)} ${r.name} v${r.version} [${label}]  ${promptUrl(projects.data[0]?.id, r.name)}`);
    return 0;
  }
  for (const r of await pullPrompts(client, label)) {
    console.log(`${r.changed ? "updated " : "same    "} ${r.file} ← ${r.name} v${r.version} [${label}]`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
