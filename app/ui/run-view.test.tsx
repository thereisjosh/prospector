import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events";
import { Candidates } from "./Candidates";
import { RunConfirmation } from "./RunConfirmation";
import { EvidenceBlock } from "./RunTrace";
import { RunView } from "./RunView";
import { evidenceFor } from "./trace-model";
import type { RunSnapshot } from "./types";

const ROOT = join(import.meta.dirname, "..", "..");
const DEMO = join(ROOT, "eval", "demo", "run");
const events = readFileSync(join(DEMO, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
const state = JSON.parse(readFileSync(join(DEMO, "state.json"), "utf8"));
const contract = state.initialContract ?? state.contract;

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "demo-x",
    status: "running",
    spend: { claude: 0.12, exa: 0.24, total: 0.36 },
    counters: { turns: 6 },
    contract,
    leads: state.leads.slice(0, 2),
    candidates: [],
    rejected: [],
    screened: [],
    todo: "",
    ...over,
  } as RunSnapshot;
}

const noop = () => undefined;
function render(snap: RunSnapshot, evs: AgentEvent[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(RunView, {
      demo: true,
      snapshot: snap,
      events: evs,
      screened: { skipped: [], lookedUp: [] },
      stepping: true,
      pausedByUser: false,
      runError: "",
      deciding: false,
      decisionError: "",
      onStop: noop,
      onResume: noop,
      onDecide: noop,
      feedback: {},
      onFeedback: noop,
      cards: null,
      maxSpend: 1,
      onApply: noop,
      applying: false,
      onEditTargeting: noop,
      onNewSearch: noop,
      ...extra,
    }),
  );
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RunView (SSR)", () => {
  const upToTurn = (t: number) => events.filter((e) => e.turn <= t);

  it("while running: exactly one running (shimmer) line, the run header, and Stop", () => {
    const html = render(snapshot(), upToTurn(5));
    expect(count(html, 'data-status="running"')).toBe(1);
    expect(html).toContain('data-testid="run-status"');
    expect(html).toContain(">Stop</button>");
    expect(html).toContain("What it&#x27;s doing");
    expect(html).toContain("Step 5");
  });

  it("while waiting for approval: no shimmer, a Confirmation with the plan and its buttons", () => {
    const request = events.find((e) => e.kind === "approval_request")!;
    const html = render(
      snapshot({ status: "awaiting_approval", pendingApproval: { toolUseId: "u1", tool: String(request.tool), input: request.input } }),
      events.slice(0, events.indexOf(request) + 1),
    );
    expect(count(html, 'data-status="running"')).toBe(0);
    expect(html).toContain("Waiting for your OK");
    expect(html).toContain("Here&#x27;s how the agent plans to start");
    expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*class="pr-confirm-title"/);
    const input = request.input as { angles: string[]; first_queries: string[] };
    for (const a of input.angles) expect(html).toContain(a);
    for (const q of input.first_queries) expect(html).toContain(q);
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Decline</button>");
    expect(html).toContain("Its estimate for the whole run:");
    expect(html).not.toContain("Needs your OK"); // §6: the eyebrow is gone
  });

  it("after the run: outcome first, no shimmer, provenance trace with the step count", () => {
    const html = render(snapshot({ status: "stopped", stopReason: "budget", leads: state.leads, rejected: state.rejected, spend: state.spend, handback: state.handback }), events, { stepping: false });
    expect(count(html, 'data-status="running"')).toBe(0);
    expect(html.indexOf("Found 8 of the 10 leads you asked for")).toBeLessThan(html.indexOf('id="leads-h"'));
    expect(html).toContain("How it got here");
    expect(html).toContain("15 steps · $0.85");
    expect(html).toContain("Considered but not added");
  });

  it("a pause is a checkpoint with resume, not a shimmer", () => {
    const html = render(snapshot(), upToTurn(5), { stepping: false, pausedByUser: true });
    expect(count(html, 'data-status="running"')).toBe(0);
    expect(html).toContain("Paused by you at step 6 · $0.36 spent");
    expect(html).toContain(">Keep going</button>");
  });
});

describe("RunConfirmation (SSR)", () => {
  it("renders a scope change with its summary and the three actions", () => {
    const html = renderToStaticMarkup(
      h(RunConfirmation, {
        demo: false,
        pending: { tool: "request_scope_change", input: { change: { field: "months", value: 6 }, reason: "Few recent events" } },
        contract,
        deciding: false,
        error: "",
        onDecide: noop,
      }),
    );
    expect(html).toContain("The agent wants to change your targeting");
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Decline</button>");
  });
});

describe("evidence Code Block (SSR)", () => {
  it("renders the verbatim quotes with labels, source and date", () => {
    const lead = state.leads[0];
    const html = renderToStaticMarkup(h(EvidenceBlock, { detail: evidenceFor(lead, contract) }));
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain("Evidence · choosealbany.com · published Sep 18, 2026");
    for (const label of ["Why now", "When", "Size", "Based in", "Must be true"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain(`“${lead.summary.signal_quote}”`.replace(/'/g, "&#x27;").replace(/"/g, "&quot;"));
    expect(html).toContain("quoted · within 100–1,000");
  });

  it("says so when a quote is missing, and never makes one up", () => {
    const bare = { company: "X", signal_url: "https://x.com/a", why_now: "w", details: {}, turn: 1 } as never;
    const html = renderToStaticMarkup(h(EvidenceBlock, { detail: evidenceFor(bare, contract) }));
    expect(count(html, "No quote captured")).toBe(4);
    expect(html).not.toContain("“");
  });
});

describe("Candidates (SSR)", () => {
  it("sections by missing fact with counts, one disclosure per company", () => {
    const html = renderToStaticMarkup(
      h(Candidates, {
        contract,
        candidates: [
          { company: "A Co", signal_url: "https://a.com/x", why_now: "New site", code: "quote_not_in_page", missing: "date not on a.com" },
          { company: "B Co", signal_url: "https://b.com/x", why_now: "Hiring", code: "quote_not_in_page", missing: "size not on b.com" },
          { company: "C Co", signal_url: "https://c.com", why_now: "Expansion", code: "required_gate:is_third_party_logistics", missing: "3PL not stated" },
        ],
      }),
    );
    expect(html).toMatch(/A quote wasn&#x27;t found on the page <span class="count">2<\/span>/);
    expect(html).toMatch(/Page doesn&#x27;t state: provides warehousing[^<]* <span class="count">1<\/span>/);
    expect(count(html, 'data-slot="trace-collapsible-trigger"')).toBe(3);
    expect(html).not.toContain("To do"); // not Queue wording
  });
});

describe("no ref on shadcn components (React 18 drops it; UI-REWORK.md §4 error 9)", () => {
  it("no app/ui file passes ref= to a component imported from @/components/ui", () => {
    const dir = join(ROOT, "app", "ui");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))) {
      const src = readFileSync(join(dir, file), "utf8");
      const names = [...src.matchAll(/import\s*{([^}]*)}\s*from\s*"@\/components\/ui\/[^"]+"/g)].flatMap((m) =>
        m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean),
      );
      for (const name of names) {
        const re = new RegExp(`<${name}\\b[^>]*\\bref=`, "s");
        if (re.test(src)) offenders.push(`${file}: <${name} ref=…>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
