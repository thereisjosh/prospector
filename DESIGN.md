---
name: Prospector
description: B2B lead finding where every lead carries its evidence and code decides what counts.
colors:
  accent: "#2f5cf0"
  accent-ink: "#ffffff"
  accent-soft: "#2f5cf017"
  accent-line: "#2f5cf038"
  accent-dark: "#6f8dff"
  accent-ink-dark: "#0a0b0f"
  canvas: "#f5f6f8"
  surface: "#ffffff"
  panel: "#eef0f4"
  panel-hover: "#e9ebf1"
  ink: "#14161c"
  muted: "#565d6d"
  faint: "#878e9e"
  line: "#e5e7ee"
  line-soft: "#eef0f4"
  canvas-dark: "#08090c"
  surface-dark: "#101218"
  panel-dark: "#191c24"
  ink-dark: "#eceef4"
  muted-dark: "#99a0b2"
  faint-dark: "#656c7d"
  line-dark: "#23262f"
  green: "#0f9d58"
  amber: "#b26a00"
  red: "#d23b3b"
  green-dark: "#35c47c"
  amber-dark: "#d99a3f"
  red-dark: "#e56a6a"
  rail-bg: "#0d0e13"
  rail-panel: "#191b23"
  rail-ink: "#edeef4"
  rail-muted: "#9195a5"
  rail-faint: "#676c7d"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "-0.01em"
  body-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.375rem"
    letterSpacing: "-0.005em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "0"
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
    letterSpacing: "0"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.78125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
    letterSpacing: "0"
rounded:
  sm: "8px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  surface-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
  rail:
    backgroundColor: "{colors.rail-bg}"
    textColor: "{colors.rail-ink}"
    width: "244px"
    padding: "20px 16px"
---

# Design System: Prospector

<!-- Scanned 2026-10-15 from app/globals.css (tokens at lines 1-111) and app/ui/*. Hex values are the
     project's canonical format; the frontmatter is normative. Items marked (rework) are decisions for the
     PHASE 2 rework in docs/UI-REWORK.md and are not yet in the code. -->

## 1. Overview

**Creative North Star: "The Instrument and the Ledger"**

Prospector is a measuring instrument with a ledger beside it. The dark rail is the instrument housing: constant, heavy, always in the same place. It holds where you are in the contract (Describe, Target, Approve, Run) and what the agent remembers between runs. The light canvas is the ledger: this run's work, written line by line, with every entry traceable to a source. Nothing on the canvas is decoration. If an element doesn't record an action, a decision, a cost or a piece of evidence, it doesn't belong there.

**The scene that sets the theme.** A founder or first sales hire at a 20-person B2B company, at a desk mid-morning between calls, on a 13–14" laptop in daylight and overhead office light. They are running one $1 search and watching it for two minutes, with the guarded hope of someone who has paid for bad lead lists before. They read quoted sentences and company names closely and then export a CSV. Long close reading in a lit room calls for a light canvas. The second scene is the same screen shared on a call or a projector during a demo, where dark UIs lose their mid-tones and light ones hold up. The dark rail stays dark in both themes because it is structure, not content: the heavier material marks the region that persists, and the lighter one marks the work in front of you.

This system rejects the sales-intelligence look (confidence bars, intent scores, enrichment badges), the chat-copilot look (sparkles, purple gradients, typing dots) and the raw observability look (spans and token dumps up front). See PRODUCT.md, Anti-references.

**Key Characteristics:**
- One system sans for everything. Monospace only for verbatim captured text (quotes, search queries) and figures that line up.
- Restrained colour: tinted cool neutrals and one blue accent. Green, amber and red are state words, never decoration.
- Flat surfaces with hairline separation. Depth comes from the material difference between rail and canvas, not from shadows on every box (rework).
- Density is allowed. A run produces 40 to 60 trace lines and 50+ turned-down companies, and the layout must hold that without card soup.
- Motion only conveys state. There is exactly one continuous indicator, the shimmer on the running trace line (rework).

## 2. Colors: The Ledger Palette

Cool, quiet neutrals tinted a few degrees toward the accent's blue, one saturated blue for action and selection, and three state hues. **Strategy: Restrained.** Product register, one accent at ≤10% of any screen, kept from the existing code. The colours are committed brand values and the product gives no reason to change them.

### Primary
- **Ledger Blue** (accent, #2f5cf0; dark theme #6f8dff): primary actions (Run agent, Approve, Apply and run again), the current step, focus rings, links, and the "AI reasoning" half of the spend meter. Contrast is 5.37:1 on white and 6.18:1 on the dark surface. Its soft (9% alpha) and line (22% alpha) variants mark selected chips and the "Hard filter" badge.

### Neutral
- **Ink** (#14161c / #eceef4): all primary text. 18:1 on white.
- **Muted Ink** (#565d6d / #99a0b2): secondary text, descriptions, trace lines at rest. 6.6:1 on white, 7.2:1 on the dark surface.
- **Faint** (#878e9e / #656c7d): non-text only, meaning dots, borders on hover and disabled glyphs. As text it fails, at 3.28:1 on white and 2.88:1 on Panel (see Do's and Don'ts).
- **Canvas** (#f5f6f8 / #08090c): the page behind the work.
- **Surface** (#ffffff / #101218): where the ledger is written (lists, the trace, the leads table).
- **Panel** (#eef0f4 / #191c24) and **Panel Hover** (#e9ebf1 / #20232d): table headers, the empty spend track, hover rows.
- **Line** (#e5e7ee / #23262f) and **Line Soft** (#eef0f4 / #191c23): hairlines between rows and sections.
- **Rail** (bg #0d0e13, panel #191b23, ink #edeef4, muted #9195a5, faint #676c7d): constant in both themes.

### State
- **Fit Green** (#0f9d58 / #35c47c): accepted, "fits", web-research spend. At 3.51:1 on white, use it for dots, icons and bars, never for small text.
- **Waiting Amber** (#b26a00 / #d99a3f): needs your OK, estimated, demo. 4.24:1 on white and 3.75:1 on its own soft tint, so small amber text fails (rework: add an amber text token, #965a00, which measures 5.59:1 on white and 4.94:1 on the tint).
- **Turned-down Red** (#d23b3b / #e56a6a): rejected, errors, Decline. 4.74:1 on white.

### Named Rules
**The One Voice Rule.** Ledger Blue covers ≤10% of any screen. It marks what you can do next or where you are. It never decorates a heading, a border stripe or an empty state.

**The State Words Rule.** Green, amber and red always come with a word. A dot without a sentence is not a status.

## 3. Typography

**Body Font:** the system stack (-apple-system, SF Pro Text, Segoe UI, Roboto), via `--sans`.
**Mono Font:** the system mono stack (ui-monospace, SF Mono, Menlo), via `--mono`.

**Character:** One well-tuned system sans carries headings, controls and data, which is the product register's default and matches the instrument metaphor. Mono is reserved for text the agent captured verbatim, so a reader can tell "the page said this" from "we are telling you this" at a glance.

### Hierarchy
Fixed rem scale, roughly 1.07–1.3 between steps, the same six sizes as `--t-xs`…`--t-xl`. Tracking and leading are size-specific (rework: today every size uses `line-height: 1.5` and tracking is set ad hoc per selector):
- **Headline** (600, 22px, 28px leading, −0.02em): page title, outcome headline ("Found 6 of the 10 leads you asked for"), spend total in tabular figures.
- **Title** (600, 17px, 24px, −0.01em): section titles, the approval question.
- **Body Large** (400, 15px, 22px, −0.005em): text inputs, the prompt field, company names in the leads table.
- **Body** (400, 14px, 20px, 0): default UI text, trace titles, terms of the plan. Prose caps at 68ch.
- **Small** (400, 13px, 18px, 0): descriptions, trace descriptions, table cells, rail links.
- **Label** (500, 12px, 16px, +0.01em, sentence case): badges, column headers, meta such as "Quoted from a source".
- **Mono** (400, 12.5px, 18px, 0): evidence quotes in Code Block, search queries, figures in a column.

### Named Rules
**The Verbatim Rule.** Monospace means "captured from a page or sent to a tool, word for word." Never use it for labels, numbers in prose or decoration.

**The Sentence Case Rule.** No uppercase tracked labels. Column headers and badges are sentence case at Label size.

## 4. Elevation

Today almost every block is a white box with a 1px border and a soft 24px-blur drop shadow (`--shadow`, app/globals.css:55). The panel, card, approval, outcome, results, rejections and candidates all use it, so nothing ranks above anything else. **Rework: flat by default.** Surfaces separate by tone (canvas vs surface) and hairlines. A shadow appears only on things that float above the page: the sticky topbar's translucent material, the About dialog, and popovers.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgba(16,22,45,.04), 0 8px 24px -16px rgba(16,22,45,.18)`, today's `--shadow`): rework, popovers and menus only, never paired with a 1px border.
- **Dialog** (`box-shadow: 0 24px 60px -28px rgba(16,22,45,.42)`, today's `--shadow-lg`): the About dialog only.
- **Topbar material** (`background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(20px) saturate(180%)`): the one translucent layer, because content scrolls under it. It goes solid under `prefers-reduced-transparency`.

### Named Rules
**The Flat Ledger Rule.** A surface sitting in the page flow has a border or a tone change, never both plus a shadow. Shadows are for things that float.

## 5. Components

### Buttons
- **Shape:** gently rounded (10px), pill only for chips and the demo badge.
- **Primary:** Ledger Blue fill, white text, 10px 20px, weight 560. One per view.
- **Ghost:** surface fill, 1px Line border, ink text. Hover darkens the border to Faint.
- **Danger ghost:** ghost with red text (Decline, Clear memory).
- **Press:** every pressable scales to 0.97 on pointer-down (`:active`) over 100ms. Today only the primary and search buttons do this (app/globals.css:377, :494).

### Chips
- **Style:** Panel fill, pill, 13px. Remove (×) is a 20px hit area inside the chip.
- **Selected (angle chips):** accent-soft fill, accent-line border, accent text, with `aria-pressed`.

### Badges ("Hard filter" / "Estimated")
- Pill, Label size. "Hard filter" is accent-soft with accent text. "Estimated" is amber-soft with amber text (rework: amber text token).

### Inputs / Fields
- **Style:** surface fill, 1px Line border, 10px radius, Body Large.
- **Focus:** border goes to accent-line, plus a 3px accent-soft ring.
- **Error:** an inline sentence in red under the field with `role="alert"`. Never colour alone.

### Navigation (the rail)
- 244px dark rail with brand, numbered steps, memory and footer links. The active step is rail-panel fill with rail-ink text (rework: drop the 2px inset accent stripe, app/globals.css:667, and mark the active step by fill plus an accent-coloured step number).
- At ≤900px the rail becomes a top band and the steps become a horizontally scrolling tab row with a 2px bottom indicator.

### The Trace (signature component, rework)
The run's ledger. One line per action: icon, a one-sentence title in plain words, and a description for cost or count. Lines nest turn → tool call → verdict → evidence. Evidence opens into a small Code Block of verbatim quotes with the source host. Only the line currently running shimmers. Turned-down companies are a normal outcome, not an error: neutral line, red icon, reason in words.

### Spend meter
A 8px pill track holding two segments, AI reasoning (accent) and web research (green), against the cap. The figures always add up on screen (RunView.tsx:228). `role="meter"` with a text value.

## 6. Do's and Don'ts

### Do:
- **Do** keep the canvas light and the rail dark in both themes. The rail is structure, the canvas is the work.
- **Do** put every status in words next to its colour ("Waiting for your OK", "Turned down Verst Logistics: size not confirmed").
- **Do** render verbatim evidence in mono inside a Code Block, with the source host and date beside it.
- **Do** use Muted Ink (#565d6d) or darker for any text. For text quieter than Muted Ink, use the rework faint-ink token #636b7b, which measures 5.36:1 on white and 4.70:1 on Panel.
- **Do** keep one shimmer on screen at most: the running trace line.
- **Do** honour reduced motion with instant or opacity-only changes, and reduced transparency with a solid topbar.

### Don't:
- **Don't** look like a sales-intelligence lead database: no confidence bars, intent scores or enrichment badges (PRODUCT.md anti-reference; the v1 screen in docs/screenshots/demo-light.png did this).
- **Don't** look like a chat copilot: no sparkle icons, purple gradients, typing dots or avatar persona (PRODUCT.md anti-reference).
- **Don't** dump raw spans, token counts or internal codes on the first level. Plain sentence first, raw detail one click down (PRODUCT.md anti-reference; eval/ui-copy.test.ts enforces "no internal codes").
- **Don't** use a `border-left`, `border-right` or inset box-shadow wider than 1px as a coloured accent on cards or nav items (today at app/globals.css:667, :1445, :1710, :1714).
- **Don't** pair a 1px border with a soft wide shadow on in-flow surfaces (today `--shadow` plus `border` on 10 surfaces; see docs/UI-REWORK.md §6).
- **Don't** nest a bordered tinted box inside a bordered card (today the demo note inside the approval card, and suggestions inside the outcome card).
- **Don't** use Faint (#878e9e) for text, placeholders or column headers. It measures 3.28:1 on white and 2.88:1 on Panel.
- **Don't** pulse anything forever. The demo badge's 2.4s infinite pulse (app/globals.css:276) goes.
- **Don't** round cards beyond 14px. The About dialog's 18px (app/globals.css:534) is the outlier.
