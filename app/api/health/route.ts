import { NextResponse } from "next/server";
import { liveAvailable } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  return NextResponse.json({
    ok: true,
    mode: (await liveAvailable()) ? "live" : "demo",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
