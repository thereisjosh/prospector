---
name: Prospector
description: B2B lead finding where every lead carries its evidence and code decides what counts.
reference: https://pop.site (tokens in docs/design-reference/pop-site-tokens.md and .json)
colors:
  page-white: "#ffffff"
  ink-black: "#000000"
  charcoal: "#171717"
  granite: "#5e5e5e"
  slate: "#6e6e73"
  mist: "#d2d2d7"
  card-line: "rgba(34, 34, 34, 0.1)"
  cloud: "#f5f5f7"
  wash-blue: "#e3eeff"
  signal-blue: "#3b82f6"
  signal-fill: "#2f6fd6"
  signal-fill-hover: "#2a62bf"
  dark-canvas: "#0a0a0a"
  dark-ink: "#ededed"
  dark-ink-strong: "#ffffff"
  dark-granite: "#a1a1a6"
  dark-slate: "#8e8e93"
  dark-mist: "#2c2c2e"
  dark-card-line: "rgba(255, 255, 255, 0.12)"
  dark-cloud: "#161618"
  dark-wash: "#0f172a"
typography:
  caption:
    fontFamily: "Satoshi, General Sans, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0"
  small:
    fontFamily: "Satoshi, General Sans, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0"
  body:
    fontFamily: "Satoshi, General Sans, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0"
  subheading:
    fontFamily: "Satoshi, General Sans, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.63px"
  heading:
    fontFamily: "Satoshi, General Sans, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(36px, 9vw, 53px)"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-2.44px (scaled: -0.046em)"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
rounded:
  inputs: "8px"
  cards: "10px"
  feature: "22px"
  secondary-pill: "26px"
  buttons: "9999px"
spacing:
  unit: "4px"
  element-gap: "12px–16px"
  card-padding: "20px"
  block-gap: "40px"
  section-gap: "60px–80px"
  page-max-width: "1200px"
components:
  button-primary:
    backgroundColor: "{colors.signal-fill}"
    textColor: "{colors.page-white}"
    rounded: "{rounded.buttons}"
    padding: "12px 24px"
    font: "Satoshi 500 15px"
  button-secondary:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.charcoal}"
    border: "1px solid {colors.charcoal}"
    rounded: "{rounded.buttons}"
    padding: "10px 20px"
  suggestion:
    backgroundColor: "{colors.page-white}"
    border: "1px solid {colors.mist}"
    rounded: "{rounded.secondary-pill}"
    selected: "wash-blue fill, 1px signal-blue border, charcoal text"
  input:
    backgroundColor: "{colors.page-white}"
    border: "1px solid {colors.mist}"
    rounded: "{rounded.inputs}"
    font: "Satoshi 400 15px"
  card:
    backgroundColor: "{colors.page-white}"
    border: "1px solid {colors.card-line}"
    rounded: "{rounded.cards}"
    padding: "20px"
  feature-surface:
    note: "the approval Plan card (1px charcoal border, white) and the evidence Code Block (wash fill, no border)"
    rounded: "{rounded.feature}"
  nav:
    backgroundColor: "{colors.page-white}"
    height: "72px"
    border: "none"
---

# Design System: Prospector

<!-- Rebuilt 2026-10-16 on the pop.site reference (docs/design-reference/). The frontmatter is normative.
     Implementation: app/globals.css (the only stylesheet; legacy.css is gone). -->

## 1. Overview

**Creative North Star: "Ink on white, one blue dot of intent"** (adapted from the reference's own line, "monumental black headlines floating on white walls, with one blue dot of intent").

Prospector is a contract, then a ledger. You state what you want in big, plain words; the agent works inside that; every lead it keeps carries the sentence it was kept for. The visual system is borrowed wholesale from pop.site and bent only where a product UI has to do things a marketing page never does (dense tables, a streaming log, a dark theme). The page is white. Type is black and large. Colour is one blue and it means "this is the thing to press" or "you are here". Everything else is said with weight, size, icons and words.

**The scene that sets the theme.** A founder or first sales hire at a 20-person B2B company, at a desk mid-morning between calls, on a 13–14" laptop in daylight. They run one $1 search and watch it for two minutes with the guarded hope of someone who has paid for bad lead lists before. They read quoted sentences and company names closely, then export a CSV. Long close reading in a lit room calls for a white canvas and black type. The second scene is the same screen shared on a call: a 53px step title reads across a room, a 22px one doesn't.

**What this replaces, and why.** Before 2026-10-16 the app was a dark navigation rail beside a pale-grey canvas, a system sans, grey hairline boxes and a single blue button: the default look of an AI tool, which is what made it read as generated. The structure (Trace ledger, Confirmation/Plan, Queue, Checkpoint, memory sections, Suggestion) and all motion (M1–M12) stay; only the visual system changed.

This system still rejects the sales-intelligence look (confidence bars, intent scores, enrichment badges), the chat-copilot look (sparkles, purple gradients, typing dots) and the raw observability look (spans and token dumps up front). See PRODUCT.md, Anti-references.

**Key characteristics**
- One canvas, white, everywhere. No rail, no tinted page background.
- One family, Satoshi, in three weights; headings at 53px with tight tracking. Monospace only for literal data (§3).
- One chromatic colour. State is ink weight plus an icon plus a word, never green/amber/red.
- No shadows in the page flow. Depth is a 1px line or a radius.
- Big gaps between major blocks (60–80px), tight gaps inside them (12–16px).

## 2. Colour: Committed, ink on white with one signal blue

**Strategy: Committed.** The palette is the reference's, unchanged in hue: five neutrals and one blue with its wash. This is a deliberate narrowing from the previous "restrained" palette, which also carried green, amber and red.

### Neutrals (light, the primary theme)
| Token | Hex | Role | Contrast on white |
|---|---|---|---|
| `--color-page-white` | #ffffff | canvas, cards, text on blue | — |
| `--color-ink-black` | #000000 | page headings (53px), the outcome line, error and turned-down emphasis | 21:1 |
| `--color-charcoal` | #171717 | body, nav, secondary-button border, the approval card border | 17.9:1 |
| `--color-granite` | #5e5e5e | muted text, subheadings, trace lines at rest | 6.48:1 (5.54:1 on wash) |
| `--color-slate` | #6e6e73 | tertiary text, metadata, step numbers | 5.07:1 (4.66:1 on cloud; **4.33:1 on wash, so never on wash**) |
| `--color-mist` | #d2d2d7 | standalone dividers, input and badge borders | non-text |
| `--color-card-line` | rgba(34,34,34,.1) | card edges and the rows inside cards | non-text |
| `--color-cloud` | #f5f5f7 | hover fill on secondary controls, the spend track | — |

### The one colour
- **Signal Blue** `--color-signal-blue` #3b82f6: active step-tab underline, focus ring (2px, offset 2px; 3.68:1 on white, passes 1.4.11), the selected Suggestion's border.
- **Signal fill** `--color-signal-fill` #2f6fd6 (the reference's own hover value): the fill of the one primary button. **Departure:** white 15px text on #3b82f6 measures 3.68:1 and fails AA, so the button rests on the darker reference value (4.81:1) and hovers to #2a62bf (5.84:1). Same hue, same token family.
- **Wash Blue** `--color-wash-blue` #e3eeff: the highlight surface. Used for exactly three things: the running/waiting line at the top of the run, the selected Suggestion, and the evidence Code Block's background. Text on wash is charcoal (15.3:1) or granite (5.54:1). Blue text on wash is 3.14:1, so blue is never used as text on it.

### Named rules
**The One Blue Button Rule.** At most one filled blue button per viewport: Continue / Suggest who to target / Build the plan / Run agent / Approve / Approve with this change / Try again. Results has none (its actions are Suggestions and secondary pills).

**The Ink States Rule.** "Fits", "turned down", "needs your OK", "error" are said in words, with an icon, and with ink weight: a passing verdict's check is charcoal, a turned-down x is granite (quieter, because it is a normal outcome), an error is black with an alert glyph and medium weight. No green, amber or red anywhere, including the spend meter (AI reasoning = charcoal, web research = slate, both labelled).

**The Gradient Choice.** The live site's CTA gradient (#00a8f5 → #3b82f6) is **not** used: its cyan end measures under 3:1 with white text. The primary button is flat.

### Dark theme (secondary, an inverted derivation)
Ink and white swap; wash becomes a deep navy. canvas #0a0a0a, body #ededed (16.9:1), headings #ffffff, granite #a1a1a6 (7.70:1), slate #8e8e93 (6.07:1), mist #2c2c2e, card line rgba(255,255,255,.12), cloud #161618, wash #0f172a (granite on it 6.94:1). The primary fill stays #2f6fd6 with white text; the focus ring #3b82f6 is 5.38:1 on the dark canvas. Secondary buttons border in #ededed.

## 3. Typography

**Family:** Satoshi 400/500/700 from Fontshare (`https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap`, linked in app/layout.tsx with preconnects), falling back to General Sans, Inter, then the system stack.

**Inputs use Satoshi, not Inter.** Refero lists Inter 14px for inputs, but the live site's claim input computes to Satoshi 500 15px; Inter there is a stale artefact. One family also means one font request and no metric jump between a label and the field under it. Inputs are Satoshi 400 15px.

**Weights:** the live site sets almost everything at 500; we use 500 for headings, buttons, labels and company names, and 400 for reading text so long passages (why-now sentences, quotes' surroundings, the summary) stay light. 700 is loaded for the wordmark only.

### Scale (the reference's, with one interpolated step)
- **Heading** 53px / 1.2 / −2.44px, weight 500, ink-black: every step title ("What do you sell?", "Who should we look for?", "Approve the plan", "Finding leads") and, on Results, the outcome line ("Found 8 of the 10 leads you asked for"). Clamped to 36px at phone width (`clamp(36px, 9vw, 53px)`, tracking −0.046em) so no title overflows at 390.
- **Subheading** 21px / 1.3 / −0.63px, weight 500: the line under a step title (granite), section titles (Leads, What it's doing, Spend, Considered but not added), the approval question, company names are *not* this size (they are body 500).
- **Body** 15px / 1.4: default text, inputs, buttons, trace titles.
- **Small** 13px / 1.4: descriptions, trace descriptions, table cells, footer links. (13px is in the reference's extracted steps: badges, card descriptions, footer.)
- **Caption** 12px / 1.2, weight 500: badges, counts, column headers, meta. Sentence case, never tracked uppercase.

**One heading of 53px per screen.** On Results the 53px goes to the outcome line, because it is the answer; the page's "Results" h1 steps down to the subheading treatment above it. Semantics are unchanged (h1 is still "Results").

### Mono: the one deliberate departure
The reference bans mono. We keep it for **literal data only**: verbatim evidence quotes (Code Block), search queries the agent sent ("Searching: …", the plan's first searches and starting search ideas), and the raw tool payload one click down. A reader must be able to tell "the page said this" from "we are telling you this" at a glance, and mono is the cheapest honest signal for that. Everything else that used mono before (event dates, source hosts, candidate domains) is now Satoshi with tabular figures.

## 4. Layout and spacing

- **Shell:** one centred column, max 1200px, 24px side gutters (16px at ≤600). Top nav 72px: wordmark left, the four step tabs centred as text links (the active one has a 1px signal-blue underline), Live/Demo badge and theme toggle right. White, no border, no shadow, not sticky (nothing scrolls under it, so no translucent material is needed).
- **"What I remember" sits directly under the nav as a full-width collapsible row** between two mist hairlines. Chosen over a right-hand column because the Run screen's right column at ≥1100px already belongs to the run's own live state (Spend, the agent's checklist); memory is cross-run state and appears on every step, including Describe/Target/Approve, which are single narrow columns with no side column to put it in. Open, its three sections (Companies already seen, Your feedback, What the agent learned) sit side by side at ≥900px and stack below that.
- **Step columns** are centred: Describe 680px (title centred, like the reference hero), Target 880px, Approve 760px, Run/Results the full 1200px.
- **Rhythm:** 4px unit. Inside a block 12–16px; card padding 20px; title-to-content 40px; between major blocks (outcome, leads, the run grid, considered-but-not-added) 64px; page bottom 80px.
- **Footer:** text links only (About this build, View source), 13px, after an 80px gap and a mist hairline.

## 5. Surfaces and radii

- **No shadows in the page flow.** The single exception is the floating "Jump to latest" button over the live trace: `0 2px 8px rgba(0,0,0,.08)`, the reference's floating-element ceiling.
- **Cards: the live site's hairline, not Refero's charcoal border.** Card edge = 1px rgba(34,34,34,.1) at **10px** radius, rows inside cards divided by the same line. Why this one: a working screen stacks five to seven bordered surfaces (target form, contract, leads table, ledger, sections, suggestions); a 1px #171717 on every one of them turns the page into a black wireframe and recreates the box soup in a darker ink. The live site already made the same call. The charcoal border is kept for the two places the reference uses it on purpose: secondary pill buttons and the one surface that must be answered (the approval card).
- **Feature surfaces, 22px:** the approval Plan card (white, 1px charcoal, 28px padding) and the evidence Code Block (wash fill, no border). The About dialog uses the same 22px feature treatment.
- **Inputs 8px**, 1px mist, focus = signal-blue border + 1px blue outline (no halo). The Describe prompt is the reference's claim form: 1px charcoal, 22px radius, pill button inside.
- **Buttons 9999px.** Secondary pills (Suggestions) 26px. Badges and chips are full pills with a 1px mist border.

## 6. Components

- **Primary button:** signal fill, white, Satoshi 500 15px, 12px 24px, pill. Press scales to 0.97 (M2).
- **Secondary button:** white, 1px charcoal, charcoal text, 10px 20px (small: 6px 14px, 13px), pill; hover fills cloud. "Decline", "Clear memory" are secondary pills; the word carries the danger.
- **Link button:** charcoal 500 with a 1px underline at 3px offset. Not blue.
- **Suggestion:** white pill, 1px mist, 13px; hover border charcoal; selected = wash fill + 1px signal-blue border + charcoal 500 text, `aria-pressed`.
- **Badges:** "Hard filter" = 1px charcoal pill (exact), "Estimated" = 1px dashed slate pill with granite text (approximate). Caption size.
- **Nav step tab:** 15px 500 charcoal text with a slate tabular step number; active = 1px signal-blue bottom border; unreachable steps are slate.
- **Trace (the run ledger):** granite lines, charcoal titles for turns, verdict icons in ink per the Ink States Rule; queries in mono. The live ledger is a card; the run header above it is a wash pill holding the one shimmering line (M1).
- **Spend:** total at 21px subheading, an 8px pill track in cloud with a charcoal AI segment and a slate web segment, each named in the legend.
- **Outcome:** stop sentence (body, granite), the 53px outcome line, summary at body, then the handback rows as Suggestions.

## 7. Do's and Don'ts

### Do
- Keep the canvas white and the step title at 53px.
- Put every status in words beside its icon ("Waiting for your OK", "Turned down Verst Logistics: size not confirmed").
- Render verbatim evidence in mono on wash inside a 22px Code Block.
- Use granite or darker for text on wash; slate only on white or cloud.
- Keep one shimmer on screen at most (the run header), and honour reduced motion.

### Don't
- Don't add a second chromatic colour, a second filled blue button in a viewport, or blue text on wash.
- Don't use green, amber or red for state.
- Don't put a shadow on anything that sits in the page flow; don't pair a border with a shadow.
- Don't use gradients as backgrounds, gradient text (the M1 shimmer is the only `background-clip:text`, on one line, off under reduced motion), serif or decorative faces.
- Don't use mono for labels, dates, hosts or numbers.
- Don't round cards above 10px or feature surfaces above 22px; don't use 4–8px radii on buttons.
- Don't use tracked uppercase eyebrows. The step numbers in the nav are a real sequence and stay.
