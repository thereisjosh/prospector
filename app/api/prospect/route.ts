import { NextResponse } from "next/server";
import { ExaHttpError } from "../../../src/exa";
import { runProspect } from "../../../src/pipeline";
import type { IcpId } from "../../../src/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseIcpId(value: unknown): IcpId | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

export async function POST(request: Request) {
  // The Exa key lives only on the server (.env / deploy env var). The browser
  // never sends or holds it — every run uses the server-side key.
  if (!process.env.EXA_API_KEY) {
    return NextResponse.json(
      { error: "The server has no EXA_API_KEY configured. Add it to .env." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as { icpId?: unknown; query?: unknown };
    const icpId = parseIcpId(body.icpId);
    if (!icpId) {
      return NextResponse.json({ error: "Unknown scenario." }, { status: 400 });
    }

    const query = typeof body.query === "string" ? body.query.trim() : undefined;
    const result = await runProspect(icpId, {
      signalQuery: query,
      numResults: 12,
      maxCandidates: 12,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ExaHttpError) {
      if (error.status === 401) {
        return NextResponse.json(
          { error: "The server's Exa API key was rejected." },
          { status: 502 },
        );
      }
      if (error.status === 402) {
        return NextResponse.json(
          { error: "The Exa account is out of credits — top up at exa.ai." },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { error: `Exa request failed (${error.status}).` },
        { status: 502 },
      );
    }

    const message = error instanceof Error ? error.message : "Request failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
