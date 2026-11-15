import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceIdFromRequest } from "../app/api/_shared";
import { anthropicKeyHealth, exaKeyHealth, noteExaResponse, resetKeyHealthForTests, setAnthropicProbeForTests } from "../src/key-health";
import { signWorkspaceId } from "../src/workspace-cookie";
import { workspaceForRequest } from "../middleware";

const env = { NODE_ENV: "test", WORKSPACE_COOKIE_SECRET: "a test workspace cookie key" };

afterEach(() => {
  resetKeyHealthForTests();
  vi.restoreAllMocks();
  delete process.env.WORKSPACE_COOKIE_SECRET;
});

describe("workspace cookie identity", () => {
  it("rejects a forged cookie, adopts a valid legacy id before the cutoff, and ignores it after", async () => {
    process.env.WORKSPACE_COOKIE_SECRET = env.WORKSPACE_COOKIE_SECRET;
    const forged = new NextRequest("https://example.test/api/runs", { headers: { cookie: "pw_ws=known.bad-signature", "x-legacy-workspace-id": "legacy-ws" } });
    const rejected = await workspaceForRequest(forged, new Date("2026-06-01T00:00:00Z"));
    expect(rejected).toMatchObject({ workspaceId: "legacy-ws", minted: true });

    const afterCutoff = new NextRequest("https://example.test/api/runs", { headers: { "x-legacy-workspace-id": "legacy-ws" } });
    expect(await workspaceForRequest(afterCutoff, new Date("2027-01-01T00:00:00Z"))).toMatchObject({ minted: true });
    expect((await workspaceForRequest(afterCutoff, new Date("2027-01-01T00:00:00Z"))).workspaceId).not.toBe("legacy-ws");
  });

  it("keeps a valid signed id stable", async () => {
    process.env.WORKSPACE_COOKIE_SECRET = env.WORKSPACE_COOKIE_SECRET;
    const value = await signWorkspaceId("stable-ws");
    const request = new NextRequest("https://example.test/api/status", { headers: { cookie: `pw_ws=${value}` } });
    expect(await workspaceForRequest(request)).toEqual({ workspaceId: "stable-ws", minted: false });
  });

  it("does not use a body or query workspace id", () => {
    const request = new Request("http://x/api/runs?workspaceId=query-attacker", { headers: { "x-workspace-id": "cookie-owner" } });
    expect(workspaceIdFromRequest(request)).toBe("cookie-owner");
    expect(workspaceIdFromRequest(new Request("http://x/api/runs?workspaceId=query-attacker"))).toBeUndefined();
  });
});

describe("key health", () => {
  it("caches Anthropic probes and tracks Exa responses passively", async () => {
    const probe = vi.fn(async () => new Response("{}", { status: 200 }));
    setAnthropicProbeForTests(probe);
    expect(await anthropicKeyHealth(1_000, { ANTHROPIC_API_KEY: "key" })).toBe("ok");
    expect(await anthropicKeyHealth(1_001, { ANTHROPIC_API_KEY: "key" })).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(1);
    noteExaResponse(403, 2_000);
    expect(exaKeyHealth(2_001, { EXA_API_KEY: "key" })).toBe("invalid");
    noteExaResponse(200, 2_002);
    expect(exaKeyHealth(2_003, { EXA_API_KEY: "key" })).toBe("ok");
  });
});
