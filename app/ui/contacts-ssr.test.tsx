/**
 * "Who to reach" (docs/SPEC-agent.md §5b) rendered on the server: the lead row line for verified and inferred
 * contacts, the evidence block row, the demo line, and the Target card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AcceptedLead } from "../../src/agent/state";
import type { CardSet } from "../../src/planner/cards";
import { CardsStep } from "./CardsStep";
import { EvidenceBlock } from "./RunTrace";
import { RunView, WhoToReach } from "./RunView";
import { evidenceFor, traceModel, turnReason } from "./trace-model";
import type { RunSnapshot } from "./types";

const ROOT = join(import.meta.dirname, "..", "..");
const state = JSON.parse(readFileSync(join(ROOT, "eval", "demo", "run", "state.json"), "utf8"));
const contract = state.initialContract ?? state.contract;
const cards = JSON.parse(readFileSync(join(ROOT, "eval", "demo", "planner", "cards.json"), "utf8")).cards as CardSet;
const noop = () => undefined;

const TEAM_URL = "https://www.verstlogistics.com/about-us/our-team/travis-french";
// The recording's first lead without its contacts: the "never looked up" case (the recording itself has contacts on every lead).
const { contacts: _recorded, ...bareFirst } = state.leads[0];
const base: AcceptedLead = bareFirst;
const withContacts: AcceptedLead = {
  ...base,
  contacts: {
    at: "2026-10-16T00:00:00.000Z",
    roles: ["VP of Operations"],
    cost: 0.019,
    contacts: [
      {
        name: "Travis French",
        tier: "verified",
        role: "VP of Operations",
        why: "Senior Vice President of Operations",
        profile_url: "https://www.linkedin.com/in/travis-french",
        found_via: "people_index",
        evidence: { url: TEAM_URL, quote: "Travis French, Senior Vice President of Operations", title_quote: "Senior Vice President of Operations" },
      },
      { name: "Jane Ops", tier: "inferred", role: "VP of Operations", why: "VP of Operations", profile_url: "https://www.linkedin.com/in/jane-ops", found_via: "people_index", code: "contact_unverified" },
    ],
  },
};

function run(leads: AcceptedLead[], demo: boolean) {
  const snapshot = {
    id: "run-x",
    status: "done",
    stopReason: "finish",
    spend: { claude: 0.1, exa: 0.1, total: 0.2 },
    counters: { turns: 3 },
    contract,
    leads,
    candidates: [],
    rejected: [],
    screened: [],
    todo: "",
  } as RunSnapshot;
  return renderToStaticMarkup(
    h(RunView, {
      demo,
      snapshot,
      events: [],
      screened: { skipped: [], lookedUp: [] },
      stepping: false,
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
    }),
  );
}

describe("Who to reach on a lead row", () => {
  it("verified: name · quoted title · source host (a button that opens the evidence); inferred: name · profile link · muted label", () => {
    const html = run([withContacts], false);
    expect(html).toContain('class="lrow-contacts"');
    expect(html).toContain(">Who to reach</span>");
    expect(html).toMatch(/data-tier="verified"[\s\S]*?>Travis French<[\s\S]*?“Senior Vice President of Operations”[\s\S]*?<button[^>]*aria-label="Show where verstlogistics.com says this"[^>]*>verstlogistics.com<\/button>/);
    expect(html).toMatch(/data-tier="inferred" title="Listed in a public people index under a role you approved \(VP of Operations\)\. Title not confirmed on a public page\."/);
    expect(html).toMatch(/>Jane Ops<[\s\S]*?<a href="https:\/\/www.linkedin.com\/in\/jane-ops" target="_blank" rel="noopener noreferrer nofollow">profile/);
    expect(html).toContain(">inferred from a public profile</span>");
    // A verified contact is proven by its page; the people index's profile link rides along (SPEC-agent §5b). No demo line on a live run.
    expect(html).toMatch(/>Travis French<[\s\S]*?verstlogistics.com<\/button>[\s\S]*?<a href="https:\/\/www.linkedin.com\/in\/travis-french"[^>]*>profile/);
    expect(html).not.toContain("No contacts looked up in this recording");
  });

  it("a verified contact with no profile link gets a LinkedIn people search by name and company, nothing fetched", () => {
    const first = withContacts.contacts!.contacts[0]!;
    const { profile_url: _drop, ...noProfile } = first;
    const lead: AcceptedLead = { ...withContacts, contacts: { ...withContacts.contacts!, contacts: [noProfile] } };
    const html = renderToStaticMarkup(h(WhoToReach, { lead, demo: false, onShowEvidence: noop }));
    const q = encodeURIComponent(`Travis French ${lead.company}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(html).toMatch(new RegExp(`<a href="https://www.linkedin.com/search/results/people/\\?keywords=${q}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Search LinkedIn for Travis French at [^"]+">find on LinkedIn`));
  });

  it("nothing for a live lead that was not looked up; a muted line when the lookup found no one or failed", () => {
    expect(run([base], false)).not.toContain("lrow-contacts");
    const none = renderToStaticMarkup(h(WhoToReach, { lead: { ...base, contacts: { at: "", roles: ["COO"], cost: 0.02, contacts: [] } }, demo: false, onShowEvidence: noop }));
    expect(none).toContain("Looked for people in your roles; no one found");
    const failed = renderToStaticMarkup(h(WhoToReach, { lead: { ...base, contacts: { at: "", roles: ["COO"], cost: 0, contacts: [], error: "boom" } }, demo: false, onShowEvidence: noop }));
    expect(failed).toContain("Couldn&#x27;t look up people this time");
  });

  it("the demo recording (2026-11-21) has contacts on every lead: the verified people from their sources, no 'not looked up' line", () => {
    const html = run(state.leads, true);
    expect(html).not.toContain("No contacts looked up in this recording");
    expect(html.split(">Who to reach</span>").length - 1).toBe(8);
    // J&J's first verified contact: name, the page's own title wording, and the host of the page that says it
    expect(html).toMatch(/data-tier="verified"[\s\S]*?>Stuart Runchman<[\s\S]*?“Group Head of Operations”[\s\S]*?ecommercefulfilment.com<\/button>/);
    // Porter and Hollingsworth were looked up and no one was found: said so, nothing invented
    expect(html.split("Looked for people in your roles; no one found").length - 1).toBe(2);
    expect(html.split('data-tier="verified"').length - 1).toBe(11);
    expect(html.split('data-tier="inferred"').length - 1).toBe(5);
  });

  it("a demo lead without a contacts entry shows the muted line once the replay has ended, nothing fabricated; none while it is still running", () => {
    const html = run([base, { ...base, company: "Other Co" }], true);
    expect(html.split("No contacts looked up in this recording").length - 1).toBe(2);
    expect(html).not.toContain("pr-contact-name");
    const running = renderToStaticMarkup(
      h(RunView, {
        demo: true,
        snapshot: { id: "run-x", status: "running", spend: { claude: 0, exa: 0, total: 0 }, counters: { turns: 5 }, contract, leads: [base], candidates: [], rejected: [], screened: [], todo: "" } as RunSnapshot,
        events: [],
        screened: { skipped: [], lookedUp: [] },
        stepping: false,
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
      }),
    );
    expect(running).toContain("lrow");
    expect(running).not.toContain("No contacts looked up in this recording");
  });
});

describe("Who to reach: evidence date and stale press", () => {
  const dated: AcceptedLead = {
    ...base,
    contacts: {
      at: "2026-10-16T00:00:00.000Z",
      roles: ["VP of Operations"],
      cost: 0.019,
      contacts: [
        {
          name: "Todd Johnson",
          tier: "verified",
          role: "VP of Operations",
          why: "President and COO",
          found_via: "people_index",
          evidence: { url: "https://www.prnewswire.com/news-releases/x-300836065.html", quote: "Todd Johnson has been named President and COO", title_quote: "President and COO", published: "2019-06-03" },
        },
        { name: "Pat Old", tier: "inferred", role: "VP of Operations", why: "VP of Operations", found_via: "web_page", code: "contact_stale", note: "last confirmed 2018" },
      ],
    },
  };

  it("the lead line ends name · “title” · host · Jun 2019 (muted); a stale inferred contact shows its title and 'last confirmed'", () => {
    const html = renderToStaticMarkup(h(WhoToReach, { lead: dated, demo: false, onShowEvidence: noop }));
    expect(html).toMatch(/Todd Johnson[\s\S]*?“President and COO”[\s\S]*?prnewswire.com<\/button>[\s\S]*?<span class="muted pr-contact-date">Jun 2019<\/span>/);
    expect(html).toMatch(/Pat Old[\s\S]*?“VP of Operations”[\s\S]*?<span class="muted">last confirmed 2018<\/span>/);
    expect(html).not.toContain("inferred from a public profile");
  });

  it("an index-only contact with a source note shows its role bucket unquoted: no page wrote that title", () => {
    const lead: AcceptedLead = {
      ...dated,
      contacts: {
        ...dated.contacts!,
        contacts: [{ name: "Bob Lee", tier: "inferred", role: "VP of Operations", why: "VP of Operations", profile_url: "https://www.linkedin.com/in/bob-lee", found_via: "people_index", code: "contact_unverified", note: "source not a company or news page" }],
      },
    };
    const html = renderToStaticMarkup(h(WhoToReach, { lead, demo: false, onShowEvidence: noop }));
    expect(html).toContain(">Bob Lee<");
    expect(html).not.toContain("“VP of Operations”");
    expect(html).toContain(">source not a company or news page</span>");
    expect(html).toMatch(/title="Listed in a public people index under a role you approved \(VP of Operations\)/);
  });

  it("the evidence row carries the page date next to the host; an undated page shows only the host", () => {
    const detail = evidenceFor(dated, contract);
    expect(detail.contacts).toEqual([expect.objectContaining({ source: "prnewswire.com", published: "2019-06-03" })]);
    expect(renderToStaticMarkup(h(EvidenceBlock, { detail }))).toContain("prnewswire.com · Jun 2019");
    expect(renderToStaticMarkup(h(EvidenceBlock, { detail: evidenceFor(withContacts, contract) }))).not.toContain(" · Jun ");
  });
});

describe("Who to reach in the evidence block", () => {
  it("a verified contact's page span is a row, verbatim, with its host; an inferred one adds nothing", () => {
    const detail = evidenceFor(withContacts, contract);
    expect(detail.contacts).toEqual([{ name: "Travis French", quote: "Travis French, Senior Vice President of Operations", titleQuote: "Senior Vice President of Operations", source: "verstlogistics.com", url: TEAM_URL }]);
    const html = renderToStaticMarkup(h(EvidenceBlock, { detail }));
    expect(html).toMatch(/id="who-[a-z0-9-]+-0"[\s\S]*?Who to reach[\s\S]*?Travis French[\s\S]*?“Travis French, Senior Vice President of Operations”[\s\S]*?verstlogistics.com/);
    expect(html).not.toContain("Jane Ops");
    expect(evidenceFor(base, contract).contacts).toBeUndefined();
  });
});

describe("Trace line for find_contacts", () => {
  it("names the company and the counts, not the people", () => {
    const tree = traceModel(
      [
        { kind: "tool_call", turn: 4, ts: "2026-10-16T09:00:03.000Z", runId: "r", tool: "find_contacts", input: { company: "Verst Logistics" }, toolUseId: "t1", is_error: false, exaCost: 0.019, resultSummary: "Verst Logistics: verified=1 · inferred=2 · dropped=0" } as never,
      ],
      { status: "running", leads: [], rejected: [], todo: "", contract } as never,
    );
    const line = tree.turns.flatMap((t) => t.lines).find((l) => l.kind === "contacts")!;
    expect(line).toMatchObject({ title: "Looking for people to reach at Verst Logistics", description: "1 verified · 2 inferred" });
    expect(tree.unmapped).toBe(0);
  });
});

describe("Trace line for find_contacts in the demo recording", () => {
  it("the recorded calls carry no input (the tool takes none), so each line takes its company from the result summary", () => {
    const calls = (JSON.parse(`[${readFileSync(join(ROOT, "eval", "demo", "run", "events.jsonl"), "utf8").trim().split("\n").join(",")}]`) as Array<{ kind: string; tool?: string; input?: unknown }>).filter((e) => e.kind === "tool_call" && e.tool === "find_contacts");
    expect(calls).toHaveLength(8);
    const tree = traceModel(calls as never, { status: "running", leads: [], rejected: [], todo: "", contract } as never);
    const lines = tree.turns.flatMap((t) => t.lines).filter((l) => l.kind === "contacts");
    expect(lines.map((l) => l.title).sort()).toEqual(
      ["G10 Fulfillment", "Hollingsworth Logistics", "J&J Global Fulfilment", "Jay Group", "Legacy Supply Chain", "Porter Logistics", "Spartan Logistics", "Wagner Logistics"].map((c) => `Looking for people to reach at ${c}`).sort(),
    );
    for (const none of ["Porter Logistics", "Hollingsworth Logistics"]) expect(lines.find((l) => l.title.endsWith(none))!.description).toBe("No one found in your roles");
    expect(lines.find((l) => l.title.endsWith("Spartan Logistics"))!.description).toBe("3 verified");
  });
});

describe("Target: Who to reach card", () => {
  it("chips from the card's buyer roles, with the why-text", () => {
    const html = renderToStaticMarkup(
      h(CardsStep, { cards: { ...cards, buyerRoles: ["VP of Operations", "Warehouse general manager"] }, base: cards, activeAlt: -1, onPickAlt: noop, onChange: noop, onContinue: noop, onBack: noop, busy: false, error: "" }),
    );
    expect(html).toMatch(/<h3 id="[^"]+">Who to reach<\/h3>/);
    expect(html).toContain("Roles to look for at each lead");
    expect(html).toMatch(/<li class="chip"><span>VP of Operations<\/span>/);
    expect(html).toMatch(/<li class="chip"><span>Warehouse general manager<\/span>/);
    expect(html).toContain("Add a role, e.g. Head of Operations");
  });

  it("no roles: says contacts won't be looked up", () => {
    const html = renderToStaticMarkup(h(CardsStep, { cards: { ...cards, buyerRoles: [] }, base: cards, activeAlt: -1, onPickAlt: noop, onChange: noop, onContinue: noop, onBack: noop, busy: false, error: "" }));
    expect(html).toContain("No roles: contacts won&#x27;t be looked up");
  });
});

describe("Visible agency (docs/SPEC-visible-agency.md B2, B3)", () => {
  it("a turn carries the model's first line of text as its reason, clipped and markdown-free", () => {
    const tree = traceModel(
      [
        { kind: "model_call", turn: 3, ts: "2026-11-15T09:00:00.000Z", runId: "r", response: { text: "**Reading** Northgate's site to check it ships for other brands.\nMore detail.", tool_uses: [] } } as never,
        { kind: "model_call", turn: 4, ts: "2026-11-15T09:00:05.000Z", runId: "r", response: { text: "", tool_uses: [] } } as never,
      ],
      { status: "done", leads: [], rejected: [], todo: "", contract } as never,
    );
    expect(tree.turns.find((t) => t.turn === 3)?.reason).toBe("Reading Northgate's site to check it ships for other brands.");
    expect(tree.turns.find((t) => t.turn === 4)?.reason).toBeUndefined();
    expect(turnReason("x".repeat(300))).toHaveLength(200);
  });

  it("the evidence block shows the decisive check first, with the page it was read on", () => {
    const lead = {
      company: "Northgate",
      signal_url: "https://news.example/northgate",
      why_now: "Opened a new warehouse",
      summary: { company_name: "Northgate", signal_type: "new_facility", signal_summary: "x", signal_date: "2026-10-01", signal_quote: "Northgate opened a 200,000 sq ft warehouse." },
      details: {},
      turn: 5,
      decisive_check: { question: "Does Northgate store and ship goods for other companies?", answer_quote: "Northgate provides fulfilment for more than 40 brands.", page_url: "https://northgate.example/about" },
    };
    const detail = evidenceFor(lead as never, contract);
    expect(detail.quotes[0]).toEqual({ label: "It checked: Does Northgate store and ship goods for other companies?", quote: "Northgate provides fulfilment for more than 40 brands.", source: "northgate.example" });
    expect(detail.quotes[1]?.label).toBe("Why now");
  });
});
