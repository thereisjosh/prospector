import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardSet } from "../../src/planner/cards";
import Page from "../page";
import { AboutDialog } from "./AboutDialog";
import { CardsStep, cardProblems } from "./CardsStep";
import { ContractStep } from "./ContractStep";
import { DESCRIBE_PLACEHOLDER, StartStep, type StartStepProps } from "./StartStep";
import type { PlanResult, SellerProfile } from "./types";

const ROOT = join(import.meta.dirname, "..", "..");
const PLANNER = join(ROOT, "eval", "demo", "planner");
const cards = JSON.parse(readFileSync(join(PLANNER, "cards.json"), "utf8")).cards as CardSet;
const plan = JSON.parse(readFileSync(join(PLANNER, "plan.json"), "utf8")) as PlanResult;
const profile = (JSON.parse(readFileSync(join(PLANNER, "profile.json"), "utf8")) as { profile: SellerProfile }).profile;
const noop = () => undefined;
const count = (html: string, s: string) => html.split(s).length - 1;

function start(over: Partial<StartStepProps> = {}) {
  const props: StartStepProps = {
    demo: false, input: "", setInput: noop, busy: false, error: "", candidates: null, askDescription: false,
    description: "", setDescription: noop, profile: null, setProfile: noop, editing: false, setEditing: noop,
    onSubmit: noop, onPickCandidate: noop, onDescribeInstead: noop, onDescribe: noop, onContinue: noop, ...over,
  };
  return renderToStaticMarkup(h(StartStep, props));
}

describe("Describe: Prompt Input, Message, Suggestion", () => {
  it("the page opens on a Prompt Input with the same placeholder and a submit button", () => {
    const html = renderToStaticMarkup(h(Page));
    expect(html).toContain('data-slot="input-group"');
    expect(html).toMatch(/<textarea[^>]*id="seller-input"/);
    expect(html).toContain(`placeholder="${DESCRIBE_PLACEHOLDER}"`);
    expect(DESCRIBE_PLACEHOLDER).toBe("Your website, Instagram handle, or one sentence about what you sell");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
    expect(html).toContain('<label for="seller-input" class="sr-only">');
    // no attachments, no model menu
    expect(html).not.toMatch(/attach|model/i);
  });

  it("after submit: the user's words as a Bubble, the reading as the agent Message", () => {
    const html = start({ input: "We sell X to Y", profile });
    expect(html).not.toContain("seller-input");
    expect(html).toMatch(/data-slot="bubble-content"[^>]*>We sell X to Y</);
    expect(html).toContain(">Change</button>");
    expect(html).toContain("Here&#x27;s what we understood");
    expect(html).toContain("Suggest who to target");
  });

  it("while reading: one running Trace line, no spinner", () => {
    const html = start({ input: "acme.com", busy: true });
    expect(count(html, 'data-status="running"')).toBe(1);
    expect(html).toContain("Reading about your business…");
    expect(html).not.toContain("spinner");
  });

  it("Instagram candidates are one-click Suggestions, plus the describe-instead link", () => {
    const html = start({ input: "@acme", candidates: [{ domain: "acme.com" }, { domain: "acme.co.uk" }] as never });
    expect(count(html, "pr-suggestion ")).toBe(2);
    expect(html).toMatch(/>acme\.com<\/button>/);
    expect(html).toContain("None of these. I&#x27;ll describe it instead");
  });

  it("the describe fallback is a second Prompt Input", () => {
    const html = start({ input: "@acme", askDescription: true });
    expect(html).toMatch(/data-slot="input-group"[\s\S]*id="desc-input"/);
    expect(html).toContain('placeholder="We sell … to …"');
  });
});

describe("Target: one form surface with hairline rows", () => {
  const html = renderToStaticMarkup(
    h(CardsStep, { cards, base: cards, activeAlt: -1, onPickAlt: noop, onChange: noop, onContinue: noop, onBack: noop, busy: false, error: "" }),
  );

  it("renders all 8 fields as rows with their Badges, and no card grid", () => {
    expect(count(html, 'class="pr-row"')).toBe(8);
    for (const title of ["Who", "Why now", "Company size", "Stage", "Where they&#x27;re based", "How recent", "Leave out", "Who to reach"]) {
      expect(html).toMatch(new RegExp(`<h3 id="[^"]+">${title}</h3>`));
    }
    // 3 Estimated + 2 Hard filter on rows, plus one of each in the legend
    expect(count(html, 'data-kind="est"')).toBe(4);
    expect(count(html, 'data-kind="hard"')).toBe(3);
    expect(html).toContain('data-slot="badge"');
    expect(html).not.toMatch(/class="[^"]*\bcards?\b/);
  });

  it("each row has a Why this? Collapsible, and labels keep their htmlFor", () => {
    expect(count(html, 'data-slot="collapsible-trigger"')).toBe(8);
    const fors = [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]!);
    expect(fors.length).toBeGreaterThanOrEqual(7);
    for (const id of fors) expect(html).toContain(`id="${id}"`);
  });

  it("angles are Suggestions with aria-pressed", () => {
    if (cards.alternatives.length === 0) return;
    expect(html).toMatch(/aria-pressed="true"[^>]*>Suggested</);
    expect(count(html, 'aria-pressed="false"')).toBe(cards.alternatives.length);
  });

  it("cardProblems still blocks Build the plan with the same sentences", () => {
    const bad = { ...cards, whyNow: { ...cards.whyNow, description: "", signalTypes: [] } };
    expect(cardProblems(bad)).toEqual(["Describe the why-now event.", "Add at least one kind of event."]);
    const out = renderToStaticMarkup(
      h(CardsStep, { cards: bad, base: cards, activeAlt: -1, onPickAlt: noop, onChange: noop, onContinue: noop, onBack: noop, busy: false, error: "" }),
    );
    expect(out).toContain("<li>Describe the why-now event.</li>");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Build the plan<\/button>/);
  });
});

describe("Approve: the contract surface", () => {
  const render = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      h(ContractStep, {
        demo: true, cards, plan, targetLeads: 10, setTargetLeads: noop, maxSpend: 1, setMaxSpend: noop, busy: false, error: "",
        allowance: null, rememberedCount: 7, onRun: noop, onBack: noop, ...over,
      }),
    );

  it("starting search ideas are a Trace of lines, and the estimate line stays", () => {
    const html = render();
    expect(html).toContain("Starting search ideas");
    expect(html).toContain('data-slot="trace-collapsible-trigger"');
    expect(html).toContain("Estimated cost: about $0.84");
    expect(html).toContain('<label for="spend">Stop spending at</label>');
    expect(html).toContain('<label for="target">Find</label>');
    expect(html).not.toMatch(/class="[^"]*\bpanel\b/);
  });

  it("the demo line no longer tells you to clear memory", () => {
    const html = render();
    expect(html).toContain("Demo: the run that follows is a recording, so changes here won&#x27;t change it.");
    expect(html).toContain("This workspace already remembers 7 companies from an earlier run, so the recording skips them.");
    expect(html).not.toContain("clear memory");
  });

  it("validation sentences are unchanged", () => {
    expect(render({ maxSpend: 9 })).toContain("Choose a limit between $0.10 and $5.00.");
    expect(render({ targetLeads: 0 })).toContain("Ask for between 1 and 50 leads.");
    expect(render({ maxSpend: 0.5 })).toContain("The estimate is above your limit. The agent stops at the limit and tells you what it found.");
  });
});

describe("About: shadcn Dialog", () => {
  // Base UI portals the popup after mount, so SSR shows only the trigger; role/aria-modal/focus are
  // checked in the browser (.agents/scratch/step-iii/walk.mjs). Here: the trigger and the props we pass.
  it("renders its trigger, and passes aria-modal to the Dialog popup", () => {
    const html = renderToStaticMarkup(h(AboutDialog));
    expect(html).toMatch(/<button[^>]*class="rail-link"[^>]*>About this build<\/button>/);
    const src = readFileSync(join(ROOT, "app", "ui", "AboutDialog.tsx"), "utf8");
    expect(src).toMatch(/<DialogContent[^>]*aria-modal="true"/);
    expect(src).toContain('from "@/components/ui/dialog"');
  });
});

describe("no ref on shadcn components in app/page.tsx either", () => {
  it("app/page.tsx passes no ref= to an @/components/ui import", () => {
    const src = readFileSync(join(ROOT, "app", "page.tsx"), "utf8");
    const names = [...src.matchAll(/import\s*{([^}]*)}\s*from\s*"@\/components\/ui\/[^"]+"/g)].flatMap((m) =>
      m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(src).not.toMatch(new RegExp(`<${name}\\b[^>]*\\bref=`, "s"));
    expect(readdirSync(join(ROOT, "app", "ui"))).toContain("StartStep.tsx");
  });
});
