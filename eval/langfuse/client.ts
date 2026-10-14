/**
 * Langfuse API access for the eval tooling (datasets, experiments, scores). JS/TS SDK v5
 * (`@langfuse/client`), loaded lazily. Everything here is $0: no model or Exa calls.
 */
import type { LangfuseClient } from "@langfuse/client";

/** Environment for everything the eval tooling emits (traces, experiment items, scores). */
export const EVAL_ENVIRONMENT = "eval";

export function langfuseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

export function baseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
}

export async function createLangfuseClient(): Promise<LangfuseClient> {
  if (!langfuseConfigured()) throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set (see .env)");
  const { LangfuseClient } = await import("@langfuse/client");
  return new LangfuseClient();
}

/** The project the keys belong to (keys are project-scoped). */
export async function projectId(client: Pick<LangfuseClient, "api">): Promise<string> {
  const projects = await client.api.projects.get();
  const id = projects.data[0]?.id;
  if (!id) throw new Error("the Langfuse keys resolve to no project");
  return id;
}

export function uiLink(project: string, path: string, env: Record<string, string | undefined> = process.env): string {
  return `${baseUrl(env)}/project/${project}/${path.replace(/^\//, "")}`;
}

/** True for a Langfuse 404 (the SDK throws NotFoundError / an error with statusCode 404). */
export function isNotFound(error: unknown): boolean {
  const e = error as { statusCode?: unknown; name?: unknown } | null;
  return !!e && (e.statusCode === 404 || e.name === "NotFoundError");
}
