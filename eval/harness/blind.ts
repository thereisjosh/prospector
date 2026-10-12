import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { squashName } from "../../src/gates";
import type { Arm, LeadRecord, RunRecord } from "./types";

export type BlindLead = LeadRecord & { id: string };

type MappingEntry = {
  id: string;
  company: string;
  squashed: string;
  sources: Array<{ arm: Arm; rep: number; runId?: string }>;
};

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: string): T[] {
  const rand = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function readCells(root: string, setId: string, scenarioId: string): Promise<RunRecord[]> {
  const scenarioDir = join(root, setId, scenarioId);
  if (!existsSync(scenarioDir)) return [];
  const records: RunRecord[] = [];
  for (const arm of await readdir(scenarioDir)) {
    const armDir = join(scenarioDir, arm);
    for (const rep of await readdir(armDir).catch(() => [])) {
      const file = join(armDir, rep, "run.json");
      if (!existsSync(file)) continue;
      records.push(JSON.parse(await readFile(file, "utf8")) as RunRecord);
    }
  }
  return records;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function createBlindPool(options: {
  setId: string;
  scenarioId: string;
  resultsRoot?: string;
  seed?: string;
  records?: RunRecord[];
}): Promise<{ blind: BlindLead[]; mapping: MappingEntry[] }> {
  const root = options.resultsRoot ?? "eval/results";
  const records = options.records ?? await readCells(root, options.setId, options.scenarioId);
  const byKey = new Map<string, { lead: LeadRecord; sources: MappingEntry["sources"] }>();
  for (const record of records) {
    for (const lead of record.leads) {
      const key = squashName(lead.company);
      const existing = byKey.get(key);
      const source = { arm: record.arm, rep: record.rep, runId: record.runId };
      if (existing) existing.sources.push(source);
      else byKey.set(key, { lead, sources: [source] });
    }
  }
  const shuffled = shuffle([...byKey.entries()], options.seed ?? `${options.setId}:${options.scenarioId}`);
  const blind: BlindLead[] = [];
  const mapping: MappingEntry[] = [];
  shuffled.forEach(([squashed, entry], index) => {
    const id = `L${String(index + 1).padStart(3, "0")}`;
    blind.push({ id, ...entry.lead });
    mapping.push({ id, company: entry.lead.company, squashed, sources: entry.sources });
  });
  await writeJson(join(root, options.setId, options.scenarioId, "blind.json"), blind);
  await writeJson(join(root, options.setId, options.scenarioId, "mapping.json"), mapping);
  return { blind, mapping };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.set || !args.scenario) throw new Error("pass --set <id> --scenario <id>");
  const result = await createBlindPool({ setId: args.set, scenarioId: args.scenario, seed: args.seed });
  console.log(`blind pool: ${result.blind.length} deduped leads for ${args.scenario}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
