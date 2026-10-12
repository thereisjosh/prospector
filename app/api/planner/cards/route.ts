import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { suggestCards, type SellerProfile } from "../../../../src/planner";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { profile?: unknown };
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const client = new Anthropic();
    const result = await suggestCards(body.profile as SellerProfile, { client });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/planner/cards] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
