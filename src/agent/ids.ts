/**
 * Run and workspace ids become directory names under RUNS_DIR / WORKSPACES_DIR,
 * so the storage functions validate them themselves (routes also map the error
 * to a 400). Anything with a path separator or ".." cannot match these shapes.
 */
export class InvalidIdError extends Error {
  constructor(kind: "run" | "workspace") {
    super(`invalid ${kind} id`);
    this.name = "InvalidIdError";
  }
}

const RUN_ID_RE = /^(demo-)?[0-9a-f-]{36}$/;
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

export function isWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && WORKSPACE_ID_RE.test(id);
}

export function assertRunId(id: unknown): string {
  if (!isRunId(id)) throw new InvalidIdError("run");
  return id;
}

export function assertWorkspaceId(id: unknown): string {
  if (!isWorkspaceId(id)) throw new InvalidIdError("workspace");
  return id;
}
