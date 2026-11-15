import { NextRequest, NextResponse } from "next/server";
import { isWorkspaceId } from "./src/agent/ids";
import {
  LEGACY_ADOPTION_UNTIL,
  WORKSPACE_COOKIE_MAX_AGE,
  WORKSPACE_COOKIE_NAME,
  legacyAdoptionAllowed,
  signWorkspaceId,
  verifyWorkspaceCookie,
  workspaceCookieSecretMissing,
} from "./src/workspace-cookie";

export { LEGACY_ADOPTION_UNTIL };

type RequestLike = Pick<NextRequest, "headers" | "cookies">;

/** Exported for deterministic middleware tests (the clock can be supplied by callers). */
export async function workspaceForRequest(request: RequestLike, now = new Date()): Promise<{ workspaceId?: string; minted: boolean }> {
  const cookie = request.cookies.get(WORKSPACE_COOKIE_NAME)?.value;
  const existing = await verifyWorkspaceCookie(cookie, isWorkspaceId);
  if (existing) return { workspaceId: existing, minted: false };
  const legacy = request.headers.get("x-legacy-workspace-id");
  if (legacyAdoptionAllowed(now) && isWorkspaceId(legacy)) return { workspaceId: legacy, minted: true };
  return { workspaceId: crypto.randomUUID(), minted: true };
}

export async function middleware(request: NextRequest) {
  if (workspaceCookieSecretMissing()) {
    return NextResponse.json({ error: "workspace cookie secret not set" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  // This value is an internal capability, never a client-supplied one.
  headers.delete("x-workspace-id");
  headers.delete("x-legacy-workspace-id");
  const resolved = await workspaceForRequest(request);
  if (!resolved.workspaceId) return NextResponse.next({ request: { headers } });
  headers.set("x-workspace-id", resolved.workspaceId);
  const forwarded = NextResponse.next({ request: { headers } });
  if (resolved.minted) {
    const value = await signWorkspaceId(resolved.workspaceId);
    if (value) {
      forwarded.cookies.set(WORKSPACE_COOKIE_NAME, value, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: WORKSPACE_COOKIE_MAX_AGE,
      });
    }
  }
  return forwarded;
}

export const config = {
  matcher: ["/api/((?!health(?:/|$)|admin(?:/|$)).*)"],
};
