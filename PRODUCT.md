# Product

<!-- Written 2026-10-15 from README.md, docs/DEMO.md, app/ and src/ by an agent that could not interview the owner.
     Lines marked (inferred) are hypotheses from the repo, not confirmed answers. Confirm or correct them before
     treating this file as settled; impeccable's init flow requires that round. -->

## Register

product

## Platform

web

## Users

The primary user is a seller at a small B2B company: a founder doing founder-led sales or a first sales hire. They know what they sell but not where to start looking, and they have been burned by bought lead lists. They sell to mid-market companies that leave a public trail: logistics and 3PLs, SaaS, funded startups, manufacturers (README intro). They arrive with one sentence or a website, approve a plan, watch a capped run for about two minutes, and leave with a CSV.

There is a second audience, and today it gets more traffic than the first (inferred). People evaluating the build (hiring managers, reviewers) open the public demo, which replays a recorded run, often while screen-sharing or presenting (docs/DEMO.md is a 3-minute talk track). They judge whether the agent is trustworthy and whether the author knows where it fails. Both audiences need the same thing from the screen: what the agent did, why each company is in or out, and what it cost.

## Product Purpose

Prospector finds companies that are ready to buy now. Each lead comes with a recent, cited "why now" event, such as a new warehouse, a funding round or an operations hire. The user approves a contract once: who to look for, what counts as a lead, and how much to spend. Inside that contract an agent searches, looks companies up and decides. Gates in code, not the model, accept or reject every company, so the agent cannot argue a bad lead into the results. Success for one run means the requested number of leads, each with a source the user can open, and an honest account of everything turned down and why. When the run falls short, the user gets a specific change to try. Success for the product means a seller trusts the list enough to email from it without re-checking every row.

## Positioning

Every lead carries its evidence, and code, not the model, decides what counts.

## Brand Personality

Evidence-first, plain-spoken, accountable. The voice already lives in app/ui/copy.ts: short declarative sentences, numbers instead of adjectives ("11 of 13 turned down on size were under 100 staff"), no internal codes ever shown to the user, and failures stated as plainly as successes ("No company passed every check."). The interface should make a skeptical user feel in control and well informed. It should not dazzle. Confidence comes from showing work, not from polish.

## Anti-references

(inferred; confirm)
- Sales-intelligence lead databases with confidence bars, intent scores and enrichment badges. They show precision they can't back up. Prospector's earlier v1 screen (docs/screenshots/demo-light.png, with "cf/fr" confidence bars and uppercase monospace column headers) went in that direction and was replaced.
- Chat-first "AI copilot" UIs with sparkle icons, purple gradients and a typing-dots persona. The agent here works inside a contract. It isn't a chat partner.
- Observability dashboards that dump raw spans and token counts. The trace is for a seller, not an SRE: plain sentences first, raw detail one level down.

## Design Principles

1. **Show the evidence, not a score.** Every accepted company opens onto the verbatim quote and the source that put it there. No number on screen stands in for a reason.
2. **Code decides, and the screen says which rule.** Every "in" and every "out" maps to a named check in plain words, with the count behind it.
3. **The contract is the unit of consent.** The user approves the goal, the bar and the budget, not each step. The agent asks again only when it wants to change one of those.
4. **Spend is always visible and always capped.** Money spent, split by what it bought, sits next to the work at all times.
5. **Say what's missing.** Unverified candidates, turned-down companies, stale checklists and lookups that were retried are shown, not hidden. A short honest list beats a long padded one.

## Accessibility & Inclusion

(inferred: the code already does most of this; confirm the target level)
- WCAG 2.2 AA: 4.5:1 body contrast in both themes, visible focus, every control reachable by keyboard.
- Live run updates announced politely, not per keystroke (the feed is `aria-live="polite"` today). Approval prompts must take focus when they appear, because the run is blocked on them.
- `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-color-scheme` are already honoured (app/globals.css:2214, :2229, :89). Keep all three.
- Status never shown by colour alone. Every state appears in words too ("Waiting for your OK", "Turned down … outside the size range").
