/**
 * Mirror `eval/datasets/*.jsonl` into Langfuse Datasets. Idempotent on item ids: an item
 * is upserted only when it is new or its input / expectedOutput / metadata / status changed
 * (every upsert creates a new dataset version, so unchanged items are never re-sent).
 * Items in Langfuse that are no longer in the file are reported, and archived only with
 * `archiveMissing` (the file is the source of truth; archiving keeps old experiment links).
 */
import type { LangfuseClient } from "@langfuse/client";
import { DATASETS, type DatasetItem, type DatasetName } from "../datasets";
import { isNotFound } from "./client";

export type SyncApi = {
  datasets: Pick<LangfuseClient["api"]["datasets"], "get" | "create">;
  datasetItems: Pick<LangfuseClient["api"]["datasetItems"], "list" | "create">;
};

export type SyncResult = {
  dataset: string;
  datasetId: string;
  createdDataset: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Active in Langfuse, absent from the file. */
  orphans: string[];
  archived: string[];
};

/** JSON with object keys sorted, so key order never counts as a change. */
export function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

type RemoteItem = { id: string; status: string; input?: unknown; expectedOutput?: unknown; metadata?: unknown; datasetName: string };

async function listAll(api: SyncApi, datasetName: string): Promise<RemoteItem[]> {
  const out: RemoteItem[] = [];
  for (let page = 1; ; page += 1) {
    const res = await api.datasetItems.list({ datasetName, page, limit: 100 });
    out.push(...(res.data as RemoteItem[]));
    if (page >= (res.meta.totalPages ?? 1) || res.data.length === 0) break;
  }
  return out;
}

export async function syncDataset(
  api: SyncApi,
  name: DatasetName,
  items: DatasetItem[],
  options: { archiveMissing?: boolean; dryRun?: boolean } = {},
): Promise<SyncResult> {
  let createdDataset = false;
  let dataset: { id: string };
  try {
    dataset = await api.datasets.get(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (options.dryRun) dataset = { id: "(dry-run)" };
    else {
      dataset = await api.datasets.create({
        name,
        description: DATASETS[name].description,
        metadata: { source: `eval/datasets/${DATASETS[name].file}`, syncedBy: "eval/langfuse-sync.ts" },
      });
    }
    createdDataset = true;
  }
  const remote = createdDataset ? [] : await listAll(api, name);
  const byId = new Map(remote.map((r) => [r.id, r]));
  const result: SyncResult = { dataset: name, datasetId: dataset.id, createdDataset, created: [], updated: [], unchanged: [], orphans: [], archived: [] };
  for (const item of items) {
    const existing = byId.get(item.id);
    const same =
      existing &&
      existing.status === "ACTIVE" &&
      canonical(existing.input) === canonical(item.input) &&
      canonical(existing.expectedOutput) === canonical(item.expectedOutput) &&
      canonical(existing.metadata) === canonical(item.metadata);
    if (same) {
      result.unchanged.push(item.id);
      continue;
    }
    if (!options.dryRun) {
      await api.datasetItems.create({ datasetName: name, id: item.id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata, status: "ACTIVE" });
    }
    (existing ? result.updated : result.created).push(item.id);
  }
  const local = new Set(items.map((i) => i.id));
  for (const r of remote) {
    if (local.has(r.id) || r.status !== "ACTIVE") continue;
    result.orphans.push(r.id);
    if (options.archiveMissing && !options.dryRun) {
      await api.datasetItems.create({ datasetName: name, id: r.id, input: r.input, expectedOutput: r.expectedOutput, metadata: r.metadata, status: "ARCHIVED" });
      result.archived.push(r.id);
    }
  }
  return result;
}
