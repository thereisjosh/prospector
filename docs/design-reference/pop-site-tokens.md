# pop.site design tokens

Source: https://styles.refero.design/style/e7d4a7de-aeaf-4d49-8c0c-0dedd05a8992 (Refero extraction of https://pop.site, extractedAt 2026-06-03T17:27:29Z, viewport 1440x900, 886 elements). Live capture 2026-10-16. No login needed. Screenshots in `pop-screenshots/` (originals in /var/folders/t0/8vv42s3s18zbp3ppd0q24r740000gn/T/claude-chrome-screenshots-TEDZkC/).

Refero tabs: DESIGN.md, Tailwind v4, CSS Variables, Design Tokens (each has Compact/Extended). Tailwind, CSS Variables and Design Tokens render the same data in three syntaxes, so values are listed once under CSS Variables and the tab differences noted.

## Tab 1: DESIGN.md
Screenshot: pop-screenshots/refero-1-design-md.jpg
- North star: "Stark typographic gallery — monumental black headlines floating on white walls, with one blue dot of intent." Theme: light.
- Quick colour reference: background #ffffff; text/primary #171717; text/muted #5e5e5e or #6e6e73; border #171717 or #000000; accent #3b82f6; primary action #3b82f6.
- Colours (name, hex, role): Page White #ffffff (page bg, card surfaces, button text on blue); Ink Black #000000 (headings, heavy borders, icon fills); Charcoal #171717 (body, nav, secondary borders); Granite #5e5e5e (muted helper text); Slate #6e6e73 (tertiary text, disabled, metadata); Mist #d2d2d7 (hairline dividers); Wash Blue #e3eeff (highlight surface); Signal Blue #3b82f6 (primary CTA, active link borders); Link Blue #6ea5ff (link text, secondary outlined actions).
- Surfaces: Canvas #ffffff L0; Card #ffffff L1 (hairline border, no shadow); Highlight Wash #e3eeff L2.
- Type scale: caption 12/1.2/0; body 15/1.4/0; subheading 21/1.3/-0.63px; heading 53/1.2/-2.44px; display 93/1/-4.65px; display-xl 120/0.9/-7.08px.
- Fonts: Satoshi (custom, 400/500/700, 153 uses; substitutes Inter, General Sans, Switzer); Inter (google, 400, inputs only, 14px); sans-serif/system-ui (12px fallback, 675 uses). Detected scale: Minor Third, ratio 1.2, base 18.
- Spacing/layout: unit 4px, density comfortable, elementGap 12-16px, sectionGap 80px, cardPadding 20px, pageMaxWidth 1200px.
- Radius: cards 8px, images 22px, inputs 8px, buttons 9999px, smallImages 42px, featureCards 22px, secondaryButtons 26px.
- Elevation: none on main site; depth from 1px borders (#171717/#000000) and radii. Floating elements at most `0 2px 8px rgba(0,0,0,0.08)`. Phone mockups `0 20px 40px rgba(0,0,0,0.12)`.
- Gradients (extracted, 4): `linear-gradient(0deg, rgb(23, 23, 23) 0%, rgb(0, 0, 0) 100%)`; `radial-gradient(100% 62% at 4.1% 0px, rgb(54, 56, 54) 0%, rgb(0, 0, 0) 100%)`; `radial-gradient(50% 65% at 50% 0px, rgb(199, 43, 0) 0%, rgb(0, 0, 0) 100%)`; `radial-gradient(50% 50% at 75.6% 50%, rgb(224, 233, 255) 0%, rgb(255, 255, 255) 100%)`.
- Components (12): Primary Pill Button (bg #3b82f6, text #fff, Satoshi 500 15px, radius 9999px, padding 12px 24px, no border, hover #2f6fd6); Secondary Pill Button (bg #fff, 1px solid #171717, text #171717, radius 9999px, padding 10px 20px); Tertiary Rounded Button (radius 26px); Inline Claim Form (white pill, 1px #171717 border, borderless input 'yourname', '.pop.site' suffix, blue CTA); Social Proof Badge (Satoshi 13px 400, radius 9999px, 1px #d2d2d7); Hero Phone Mockup Carousel (22px radius frames, shadow 0 20px 40px rgba(0,0,0,0.12)); Section Showcase Card (white, 8px radius, 1px #171717 border, 20px padding, preview bg #f5f5f7, title Satoshi 500 21px, desc 13px 400 #5e5e5e, 3-col grid 16-20px gap); Phone Preview Frame (22px outer, 18-20px inner); Navigation Bar (white, no border/shadow, wordmark 'pop site*' Satoshi 700 ~18px, text links 13-15px 400, 13px gap); Section Heading Block (centered, 53-93px, lh 1.0-1.1, 40-60px vertical margins); Footer (white, 13px links); Floating Action Widget (40px circle, #171717).
- Do: Satoshi 700 at 53-120px headlines; #3b82f6 only for CTAs/active links; 1px #171717/#000 borders not shadows; 9999px radius for primary buttons/badges/form containers; letter-spacing -0.05em or tighter at 53px+; phone mockups as imagery; body Satoshi 400 15px #171717.
- Don't: any chromatic colour except #3b82f6; shadows on cards/buttons/sections; display below 53px for section headlines; more than one blue button per viewport; 4-8px button radius; gradients as page backgrounds; serif/mono/decorative fonts.
- Similar: Linear, Framer, Carrd, Vercel.

## Tab 2: Tailwind v4
Screenshot: pop-screenshots/refero-2-tailwind.jpg
Same data as CSS Variables below, emitted as `@theme { --color-page-white: #ffffff; ... --font-satoshi: ...; --text-caption: 12px; ... }` (names identical to the CSS Variables tab). Tokens: 9 colours, 4 font families, 6 type sizes with leading/tracking, 3 weights, spacing, 7 radii + 7 named radii, 3 surfaces.

## Tab 3: CSS Variables
Screenshot: pop-screenshots/refero-3-css-variables.jpg
```css
:root {
  /* Colors */
  --color-page-white: #ffffff;
  --color-ink-black: #000000;
  --color-charcoal: #171717;
  --color-granite: #5e5e5e;
  --color-slate: #6e6e73;
  --color-mist: #d2d2d7;
  --color-wash-blue: #e3eeff;
  --color-signal-blue: #3b82f6;
  --color-link-blue: #6ea5ff;

  /* Typography — Font Families */
  --font-sans-serif: 'sans-serif', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-satoshi: 'Satoshi', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-inter: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-system-ui: 'system-ui', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-caption: 12px;  --leading-caption: 1.2;  --tracking-caption: 0px;
  --text-body: 15px;  --leading-body: 1.4;  --tracking-body: 0px;
  --text-subheading: 21px;  --leading-subheading: 1.3;  --tracking-subheading: -0.63px;
  --text-heading: 53px;  --leading-heading: 1.2;  --tracking-heading: -2.44px;
  --text-display: 93px;  --leading-display: 1;  --tracking-display: -4.65px;
  --text-display-xl: 120px;  --leading-display-xl: 0.9;  --tracking-display-xl: -7.08px;

  /* Typography — Weights */
  --font-weight-regular: 400;  --font-weight-medium: 500;  --font-weight-bold: 700;

  /* Spacing */
  --spacing-unit: 4px;
  --spacing-8: 8px; --spacing-12: 12px; --spacing-16: 16px; --spacing-20: 20px; --spacing-24: 24px;
  --spacing-36: 36px; --spacing-40: 40px; --spacing-60: 60px; --spacing-80: 80px; --spacing-120: 120px;

  /* Layout */
  --page-max-width: 1200px; --section-gap: 80px; --card-padding: 20px; --element-gap: 12-16px;

  /* Border Radius */
  --radius-md: 4px; --radius-lg: 8px; --radius-2xl: 22px; --radius-3xl: 26px; --radius-3xl-2: 42px;
  --radius-full: 999px; --radius-full-2: 9999px;

  /* Named Radii */
  --radius-cards: 8px; --radius-images: 22px; --radius-inputs: 8px; --radius-buttons: 9999px;
  --radius-smallimages: 42px; --radius-featurecards: 22px; --radius-secondarybuttons: 26px;

  /* Surfaces */
  --surface-canvas: #ffffff; --surface-card: #ffffff; --surface-highlight-wash: #e3eeff;
}
```
(Layout of declarations condensed onto shared lines here; names and values are verbatim.)
Raw extracted spacing values (22): 2,3,5,6,7,8,9,10,12,13,15,16,19,20,24,33,36,40,60,80,120,126. Raw radii (7): 8, 22, 9999 (asymmetric 0/9999/9999/0), 26, 42, 4, 999 (asymmetric). Raw shadows: 0.

## Tab 4: Design Tokens
Screenshot: pop-screenshots/refero-4-design-tokens.jpg
W3C-style JSON (`"color": { "page-white": { "$value": "#ffffff", "$type": "color", "$description": "Page White — Page background, card surfaces, button text on blue" }, ... }`) carrying the same colours, typography, spacing, radii and surfaces as above. Full content is in pop-site-tokens.json.

Token counts: colours 9 named (11 raw), font families 4 (3 raw), type sizes 6 named (10 raw steps), weights 3, spacing named 10 + unit (22 raw), radii 7 + 7 named, shadows 0 extracted, surfaces 3, gradients 4, components 12.

## Computed from pop.site (live, 2026-10-16, 1430px viewport)
Screenshots: pop-screenshots/popsite-hero.jpg, popsite-mid.jpg, popsite-footer.jpg
- body: bg rgb(255, 255, 255); color rgb(0, 0, 0); font sans-serif 12px (text elements set Satoshi individually).
- h1: Satoshi, "Satoshi Placeholder", sans-serif; 69px; weight 500; letter-spacing -3.92px; line-height 62.1px (0.9); color rgb(23, 23, 23). One section h1 at 64px / -3.22px / 57.6px. h3: 28px / 500 / -0.84px / 33.6px.
- Subhead paragraph: Satoshi 21px 500, -0.63px, lh 29.4px, color rgb(84, 84, 84).
- Primary button ("Claim your site"): background-image linear-gradient(110deg, rgb(0, 168, 245) 0%, rgb(59, 130, 246) 100%); text rgb(255, 255, 255); radius 26px; padding 16px 24px; height 40px; Satoshi 500 15px, letter-spacing -0.45px; no border, no shadow.
- Claim input: Satoshi 500 15px, 40px high, 149px wide; wrapper radius 999px 0 0 999px, padding-left 20px; ".pop.site" suffix Satoshi 500 15px rgb(23, 23, 23). Input/suffix sit in a hairline-bordered pill (visible in screenshot, not a computed border on the element).
- Secondary/outline button: none present as a button; nearest equivalents are the pill input + suffix and nav text links (no fill, no border).
- Links (nav): rgb(23, 23, 23), 15px, 500, no underline. Footer links: 13px 400 rgb(23, 23, 23).
- Badge ("Join 10K+ People"): Satoshi 500 15px, letter-spacing -0.45px, rgb(23, 23, 23), in a bordered pill with a blue cursor icon.
- Card (Testimonials/Shop/etc.): bg rgb(255, 255, 255); radius 10px; padding 20px; width ~327px; box-shadow none; border drawn by ::after `1px solid rgba(34, 34, 34, 0.1)`.
- FAQ row: bg rgb(250, 250, 252); radius 12px; padding 24px; 792x76; no border; circular grey "+" toggle.
- Nav: 72px high, transparent, 1px hairline under it visible; wordmark "pop site" italic with sparkle; right-aligned text links with a vertical divider before Create Account.
- Layout: centered column; containers capped at 600/750/800/1000px (cards grid ~1000px, 3 columns, ~9px gap); section padding-top 80/80/60px; sections separated by whitespace plus occasional 1px hairline; 12 headline blocks, nearly all h1 at 64-69px; total page height 11747px.
- Mood in fact: white canvas, near-black Satoshi headlines at 69px with tight negative tracking, one blue gradient CTA per viewport, phone mockups as the only imagery. Cards and FAQ rows are low-contrast (hairline or 2%-grey fill) with no shadows except the phone frames.

Live vs Refero differences: live h1 is 69px/500 (Refero: 93-120px/500, doc says 700); live primary button is a blue gradient with 26px radius and 16px 24px padding (Refero: flat #3b82f6, 9999px, 12px 24px); live cards are 10px radius with 10%-alpha hairline (Refero: 8px, 1px #171717). The site has been updated since 2026-06-03, or Refero normalised values.

## Observations
- Type: one family (Satoshi) in 3 weights (400/500/700), but live site uses 500 almost everywhere. About 6 sizes (12/13/15/21/53-69/93-120). Headline-to-body jump is 21px to 53px+ with no mid sizes; tracking tightens proportionally (-0.03em body to -0.06em display).
- Colour: monochrome neutrals (#000, #171717, #5e5e5e, #6e6e73, #d2d2d7) plus one blue (#3b82f6, with #6ea5ff link and #e3eeff wash). Colour appears only on CTA and links; live CTA adds a cyan-to-blue gradient (#00a8f5 to #3b82f6).
- Surfaces: white on white, separated by hairline borders (1px, #171717 per Refero, 10%-alpha on live) or a 2% grey fill (#fafafc). No shadows except phone-frame mockups. Extracted shadows: none.
- Shape: pills for actions and inputs, 8-12px for cards/rows, 22-42px for images/frames. Radius scale: 4/8/22/26/42/999/9999.
- Spacing: 4px base; section gaps 60-80px; card padding 20px; gaps 12-16px; 1200px max page width (Refero), 600-1000px content columns (live).
- Layout: centered single column, one idea per section (badge, headline, subhead, visual), whitespace as separator, text-only nav and footer.
