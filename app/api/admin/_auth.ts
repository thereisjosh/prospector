import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { rateLimit } from "../_shared";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function requireAdmin(request: Request): Response | undefined {
  const limited = rateLimit(request);
  if (limited) return limited;

  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 32) {
    return NextResponse.json({ error: "admin_disabled" }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const provided = match[1]!;
  const ok = timingSafeEqual(digest(provided), digest(token));
  return ok ? undefined : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
