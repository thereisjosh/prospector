import { NextResponse } from "next/server";
import demoResults from "../../../data/demo-results.json";
import { ExaHttpError } from "../../../src/exa";
import { runProspect } from "../../../src/pipeline";
import type { IcpId, ProspectRow } from "../../../src/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type DemoResults = Record<string, { rows: ProspectRow[]; costDollars: number }>;

function parseIcpId(value: unknown): IcpId | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      icpId?: unknown;
      apiKey?: unknown;
      query?: unknown;
    };
    const icpId = parseIcpId(body.icpId);
    if (!icpId) {
      return NextResponse.json({ error: "Unknown ICP." }, { status: 400 });
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      const cached = (demoResults as DemoResults)[String(icpId)];
      return NextResponse.json({
        rows: cached.rows,
        costDollars: cached.costDollars,
      });
    }

    const query = typeof body.query === "string" ? body.query.trim() : undefined;
    const result = await runProspect(icpId, {
      exaKey: apiKey,
      signalQuery: query,
      numResults: 12,
      maxCandidates: 12,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ExaHttpError) {
      if (error.status === 401) {
        return NextResponse.json({ error: "invalid key" }, { status: 401 });
      }
      if (error.status === 402) {
        return NextResponse.json({ error: "out of credits" }, { status: 402 });
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
