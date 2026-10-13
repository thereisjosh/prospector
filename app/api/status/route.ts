import { NextResponse } from "next/server";
import { DEFAULT_LIMITS } from "../../../src/agent/config";
import { readVisitorAllowance, visitorDollarLimit, visitorRunLimit } from "../../../src/agent/quota";
import { dailySpendCapDollars, liveAvailable, livePaused, rateLimit, readDailySpend, roundCents, workspaceIdFromRequest } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = rateLimit(request);
  if (limited) return limited;
  const workspaceId = workspaceIdFromRequest(request);
  const visitor = workspaceId
    ? await readVisitorAllowance(workspaceId)
    : { remainingRuns: visitorRunLimit(), remainingDollars: visitorDollarLimit() };
  const available = await liveAvailable();
  const paused = livePaused();
  return NextResponse.json({
    mode: available ? "live" : "demo",
    ...(paused ? { reason: "paused" } : {}),
    liveAvailable: available,
    visitor: {
      remainingRuns: visitor.remainingRuns,
      remainingDollars: roundCents(visitor.remainingDollars),
    },
    caps: {
      perRun: DEFAULT_LIMITS.maxCostDollars,
      perRunMax: 5,
      visitorRuns: visitorRunLimit(),
      visitorDollars: visitorDollarLimit(),
      daily: dailySpendCapDollars(),
    },
    today: {
      spentDollars: roundCents(await readDailySpend()),
    },
  });
}
