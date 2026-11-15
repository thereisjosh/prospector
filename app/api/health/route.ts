import { NextResponse } from "next/server";
import { liveAvailable } from "../_shared";
import { anthropicKeyHealth, exaKeyHealth } from "../../../src/key-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  const keys = {
    anthropic: await anthropicKeyHealth(),
    exa: exaKeyHealth(),
  };
  const available = await liveAvailable();
  return NextResponse.json({
    ok: true,
    mode: available ? "live" : "demo",
    keys,
    liveReady: available && keys.anthropic !== "invalid" && keys.anthropic !== "missing" && keys.exa !== "invalid" && keys.exa !== "missing",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.APP_VERSION ?? "dev",
  });
}
