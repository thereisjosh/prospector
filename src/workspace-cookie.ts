/** Edge-safe workspace-cookie helpers. Do not add Node imports here: middleware uses this module. */
export const WORKSPACE_COOKIE_NAME = "pw_ws";
export const LEGACY_ADOPTION_UNTIL = "2026-12-31";
export const WORKSPACE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const DEV_SECRET = "prospector-development-workspace-cookie-key";
let warnedAboutDevSecret = false;

export type WorkspaceCookieEnvironment = Record<string, string | undefined>;

function envValue(env?: WorkspaceCookieEnvironment): string | undefined {
  return (env ?? process.env).WORKSPACE_COOKIE_SECRET;
}

export function workspaceCookieSecret(env?: WorkspaceCookieEnvironment): string | undefined {
  const configured = envValue(env);
  if (configured) return configured;
  if ((env ?? process.env).NODE_ENV === "production") return undefined;
  if (!warnedAboutDevSecret) {
    warnedAboutDevSecret = true;
    console.warn("[workspace-cookie] WORKSPACE_COOKIE_SECRET is not set; using the development key");
  }
  return DEV_SECRET;
}

export function workspaceCookieSecretMissing(env?: WorkspaceCookieEnvironment): boolean {
  return !workspaceCookieSecret(env);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Always scan both complete inputs. HMAC output has a fixed expected length,
  // but keep this safe for malformed values too.
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

async function signature(workspaceId: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(workspaceId)));
}

export async function signWorkspaceId(workspaceId: string, env?: WorkspaceCookieEnvironment): Promise<string | undefined> {
  const secret = workspaceCookieSecret(env);
  if (!secret) return undefined;
  return `${workspaceId}.${base64url(await signature(workspaceId, secret))}`;
}

export async function verifyWorkspaceCookie(value: string | undefined, isWorkspaceId: (value: unknown) => value is string, env?: WorkspaceCookieEnvironment): Promise<string | undefined> {
  const secret = workspaceCookieSecret(env);
  if (!secret || !value) return undefined;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return undefined;
  const workspaceId = value.slice(0, dot);
  if (!isWorkspaceId(workspaceId)) return undefined;
  const received = fromBase64url(value.slice(dot + 1));
  if (!received) return undefined;
  const expected = await signature(workspaceId, secret);
  return equalBytes(received, expected) ? workspaceId : undefined;
}

export function legacyAdoptionAllowed(now = new Date()): boolean {
  return now.toISOString().slice(0, 10) <= LEGACY_ADOPTION_UNTIL;
}
