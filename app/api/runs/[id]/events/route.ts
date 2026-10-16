import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { openEventStream, readRunAccess } from "../../../../../src/agent/live";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoRunAccess } from "../../../../../src/demo/replay";
import { rateLimit, requireRunOwner } from "../../../_shared";

// Long-lived stream: Node runtime (fs.watch, the in-process live bus), never cached or prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/runs/:id/events?after=<seq>[&workspaceId=<id>]: Server-Sent Events (src/agent/live.ts).
 * The workspace must own the run: `x-workspace-id` header, or `workspaceId` in the query because
 * EventSource cannot set headers. A reconnecting EventSource's Last-Event-ID wins when it is later.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const owner = await requireRunOwner(request, params.id, { allowQuery: true });
    if (owner instanceof NextResponse) return owner;
    const url = new URL(request.url);
    const after = Math.max(seqParam(url.searchParams.get("after")), seqParam(request.headers.get("last-event-id")));
    const readStatus = async () => (isDemoRunId(params.id) ? await demoRunAccess(params.id) : await readRunAccess(params.id))?.status;
    const stream = openEventStream({ runId: params.id, after, readStatus, signal: request.signal });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        // no-transform also keeps Next's gzip off this response (compression buffers frames).
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Reverse proxies (nginx-style, Railway's edge) must not buffer the stream.
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs/:id/events] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

function seqParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
