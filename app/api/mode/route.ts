import { NextResponse } from "next/server";
import { isDemoMode } from "../../../src/demo/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the UI whether it is running on recorded data (shows the demo badge). */
export async function GET() {
  return NextResponse.json({ demo: isDemoMode() });
}
