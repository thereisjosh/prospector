import { createHash } from "node:crypto";

/**
 * The one place prompts are fetched from Langfuse Prompt Management (docs/prompts.md).
 *
 * - Fetch by label (`LANGFUSE_PROMPT_LABEL`, default `production`) through the SDK's own
 *   client-side cache: 60 s TTL, stale-while-revalidate, which is the documented default
 *   (https://langfuse.com/docs/prompt-management/features/caching).
 * - The in-repo text is the fallback: used when the Langfuse keys are unset, when the
 *   first fetch of a process fails (SDK `fallback`, docs: guaranteed-availability), or
 *   when the fetched prompt is not a text prompt.
 * - Callers pin the result: an agent run stores the whole `PinnedPrompt` in RunState on
 *   its first step and never re-resolves it, so a label move mid-run cannot change the
 *   cached system prefix or desync the append-only history.
 */

export const PROMPT_CACHE_TTL_SECONDS = 60;
/** Bounds the first (uncached) fetch of a process; after that the cache answers instantly. */
const FETCH_TIMEOUT_MS = 3000;
const FETCH_MAX_RETRIES = 1;

export type PromptConfig = Record<string, unknown>;

/** A prompt as the repo defines it: the fallback text and the config stored with it in Langfuse. */
export type PromptDef = {
  /** Langfuse prompt name. */
  name: string;
  text: string;
  config: PromptConfig;
  /** PROMPT_VERSION-style id used when the repo text is what runs. */
  repoVersionId: string;
};

export type PinnedPrompt = {
  name: string;
  /** Langfuse version number, or null when the in-repo text is used. */
  version: number | null;
  /** Label it was resolved by (null for the repo fallback). */
  label: string | null;
  source: "langfuse" | "repo";
  /** `name@version` when fetched, else the def's repoVersionId. Goes into every event's promptVersion. */
  id: string;
  text: string;
  sha256: string;
};

/** The minimal slice of `LangfuseClient` this module uses (mocked in tests). */
export type PromptClient = {
  prompt: {
    get(
      name: string,
      options: { label?: string; type?: "text"; cacheTtlSeconds?: number; fallback?: string; maxRetries?: number; fetchTimeoutMs?: number },
    ): Promise<{ name: string; version: number; type: string; prompt: unknown; isFallback: boolean }>;
  };
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Prompt management is on when both Langfuse keys are set (same rule as tracing), unless
 * `LANGFUSE_PROMPTS=off` forces the in-repo text (kill switch; the mocked test suite sets it).
 */
export function promptsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) && env.LANGFUSE_PROMPTS !== "off";
}

export function promptLabel(env: Record<string, string | undefined> = process.env): string {
  return env.LANGFUSE_PROMPT_LABEL?.trim() || "production";
}

export function repoPin(def: PromptDef): PinnedPrompt {
  return { name: def.name, version: null, label: null, source: "repo", id: def.repoVersionId, text: def.text, sha256: sha256Hex(def.text) };
}

/** What a generation carries to link it to a prompt version; none for the repo fallback (docs: link-to-traces). */
export function promptLink(pin: PinnedPrompt | undefined): { name: string; version: number } | undefined {
  return pin && pin.source === "langfuse" && pin.version !== null ? { name: pin.name, version: pin.version } : undefined;
}

let clientPromise: Promise<PromptClient> | undefined;
let testClient: PromptClient | undefined;

/** Tests only: replace the Langfuse client (undefined restores the real one). */
export function __setPromptClientForTests(client: PromptClient | undefined): void {
  testClient = client;
  clientPromise = undefined;
}

async function client(): Promise<PromptClient> {
  if (testClient) return testClient;
  clientPromise ??= import("@langfuse/client").then(({ LangfuseClient }) => new LangfuseClient() as unknown as PromptClient);
  return clientPromise;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[prompt-store] ${message}`);
}

/**
 * Resolve the prompt to use now. Never throws: any failure yields the repo pin.
 * The result is meant to be pinned by the caller for the whole unit of work.
 */
export async function resolvePrompt(def: PromptDef, opts: { label?: string; env?: Record<string, string | undefined> } = {}): Promise<PinnedPrompt> {
  const env = opts.env ?? process.env;
  if (!promptsEnabled(env)) return repoPin(def);
  const label = opts.label ?? promptLabel(env);
  try {
    const fetched = await (await client()).prompt.get(def.name, {
      label,
      type: "text",
      cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
      fallback: def.text,
      maxRetries: FETCH_MAX_RETRIES,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
    });
    if (fetched.isFallback) {
      warnOnce(`${def.name}:fallback`, `Langfuse prompt "${def.name}" (label ${label}) unavailable; using the in-repo text.`);
      return repoPin(def);
    }
    if (fetched.type !== "text" || typeof fetched.prompt !== "string" || !Number.isInteger(fetched.version)) {
      warnOnce(`${def.name}:type`, `Langfuse prompt "${def.name}" is not a text prompt; using the in-repo text.`);
      return repoPin(def);
    }
    const text = fetched.prompt;
    return { name: def.name, version: fetched.version, label, source: "langfuse", id: `${def.name}@${fetched.version}`, text, sha256: sha256Hex(text) };
  } catch (error) {
    warnOnce(`${def.name}:error`, `Langfuse prompt "${def.name}" fetch failed (${error instanceof Error ? error.message : "error"}); using the in-repo text.`);
    return repoPin(def);
  }
}
