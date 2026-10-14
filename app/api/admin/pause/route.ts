import { NextResponse } from "next/server";
import { writeFileAtomic } from "../../../../src/agent/fslock";
import { pausedFile } from "../../../../src/demo/mode";
import { readJsonBody } from "../../_shared";
import { requireAdmin } from "../_auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown = {};
  try {
    body = await readJsonBody(request);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const reasonValue = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).reason : undefined;
  if (reasonValue !== undefined && (typeof reasonValue !== "string" || reasonValue.length > 200)) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }

  const pausedAt = new Date().toISOString();
  const payload = { pausedAt, ...(reasonValue ? { reason: reasonValue } : {}) };
  await writeFileAtomic(pausedFile(), JSON.stringify(payload, null, 2));
  return NextResponse.json({ paused: true, pausedAt, reason: reasonValue ?? null });
}
