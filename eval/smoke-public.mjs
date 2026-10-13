// Drive a deployed Prospector as a visitor would: profile → cards → contract → run → steps → results.
// Approves the opening strategy, declines any scope change, prints a summary. No keys needed
// (the server pays); the visitor allowance and caps apply exactly as in the browser.
//
//   node eval/smoke-public.mjs https://<host> "https://www.deposco.com" [maxCostDollars]
import { randomUUID } from "node:crypto";

const [base, input, maxCostArg] = process.argv.slice(2);
if (!base || !input) {
  console.error('usage: node eval/smoke-public.mjs <baseUrl> <website-or-sentence> [maxCostDollars]');
  process.exit(2);
}
const workspaceId = `smoke-${randomUUID().slice(0, 8)}`;
const maxCostDollars = Number(maxCostArg ?? 1);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0);

async function call(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-workspace-id": workspaceId },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const status = await call("/api/status");
console.log(`[${secs()}s] status: mode=${status.mode} liveAvailable=${status.liveAvailable} visitor=${JSON.stringify(status.visitor)} today=$${status.today?.spentDollars}`);
if (status.mode !== "live") { console.error("server is not in live mode; aborting"); process.exit(1); }

const profileRes = await call("/api/planner/profile", { input, workspaceId });
if (profileRes.candidates) { console.error("instagram candidates returned; pass a website instead"); process.exit(1); }
const profile = profileRes.profile;
console.log(`[${secs()}s] profile: ${String(profile?.offering ?? "").slice(0, 120)}`);

const { cards } = await call("/api/planner/cards", { profile, workspaceId });
console.log(`[${secs()}s] cards: who=${cards.who?.industry?.slice(0, 60)} | size ${cards.size?.min}-${cards.size?.max} | geo ${cards.geo?.hqCountries?.join(",")} | months ${cards.recency?.months} | signals ${cards.whyNow?.signalTypes?.join(",")}`);

const planRes = await call("/api/planner/plan", { cards, workspaceId });
console.log(`[${secs()}s] plan: ${planRes.plan?.signalQueries?.length} queries, est. run $${planRes.estimatedRunCost}`);

const { id } = await call("/api/runs", { plan: planRes.plan, workspaceId, targetLeads: 10, maxCostDollars });
console.log(`[${secs()}s] run ${id}`);

let last;
for (let i = 0; i < 80; i += 1) {
  const step = await call(`/api/runs/${id}/step`, {});
  last = step;
  const ev = (step.events ?? []).filter((e) => e.kind === "tool_call" || e.kind === "submit_verdict" || e.kind === "approval_request" || e.kind === "stop");
  for (const e of ev) {
    const what = e.kind === "tool_call" ? `${e.tool} ${JSON.stringify(e.input ?? {}).slice(0, 80)}` : e.kind === "submit_verdict" ? `${e.company}: ${e.code}` : e.kind === "approval_request" ? `APPROVAL ${e.tool}` : `STOP ${e.reason}`;
    console.log(`  t${step.turn} ${e.kind} ${what}`);
  }
  console.log(`[${secs()}s] turn ${step.turn} status=${step.status} spend=$${step.spend?.total?.toFixed(3)} leads=${step.leadsCount}`);
  if (step.status === "awaiting_approval") {
    const tool = step.pendingApproval?.tool;
    const approve = tool === "propose_strategy";
    const d = await call(`/api/runs/${id}/decision`, { approve, toolUseId: step.pendingApproval?.toolUseId, note: approve ? undefined : "smoke test: keep the contract" });
    console.log(`[${secs()}s] decision on ${tool}: ${approve ? "approved" : "declined"} → status=${d.status}`);
    continue;
  }
  if (step.status !== "running") break;
}

const snap = await call(`/api/runs/${id}`);
console.log(`\nRESULT status=${snap.status} stop=${snap.stopReason} turns=${snap.counters?.turns} spend=${JSON.stringify(snap.spend)} leads=${snap.leads?.length}`);
for (const l of snap.leads ?? []) console.log(`  - ${l.company} | ${l.details?.event_date ?? ""} | ${l.details?.employees ?? "?"} emp (${l.details?.size_basis ?? ""}) | ${String(l.why_now ?? "").slice(0, 90)}`);
if (snap.screened?.length) console.log("screened:", snap.screened.map((g) => `${g.code}:${g.count}`).join(" "));
if (snap.handback) console.log("handback:", JSON.stringify(snap.handback).slice(0, 300));
const after = await call("/api/status");
console.log(`visitor after: ${JSON.stringify(after.visitor)} | today $${after.today?.spentDollars}`);
