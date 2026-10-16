# Research: contacts, LinkedIn, and relationship graphs for Prospector

Status: research only, nothing built. Written 2026-10-16. Every claim carries a URL; anything not confirmed on a primary source is marked *unverified*. "Not found" means I looked and found nothing.

## Answer first

1. **A contact is a named person, not an email address.**
   - Prospector should return 1 to 3 named people at each accepted lead, each holding one of the seller profile's `buyer_roles`.
   - Each is **verified** only when a verbatim title quote sits on a **non-LinkedIn page**, which code checks against the captured page text. The best such page is the company's own team page; a press release is next.
   - LinkedIn appears only as a profile link. Emails and phones are not stored by default.
2. **Exa can find the people, and I tested it** (3 live calls, $0.016 in total):
   - **People search.** One `category: "people"` search for "VP of Operations at Verst Logistics" cost **$0.007**. It returned 5 current Verst VPs and SVPs, every one a `linkedin.com/in/` URL with a structured `workHistory` (title, company, dates; `to: null` means current).
   - **Company-page search.** A plain search with `excludeDomains: ["linkedin.com"]`, also $0.007, returned Verst's own team pages. One reads "Travis French, the Senior Vice President at Verst, manages all Warehousing and Fulfillment operations". That page is quotable without touching LinkedIn.
   - **Titles disagree across sources.** The same person's LinkedIn title was "SVP. Warehousing and Fulfillment" and the company page says "Senior Vice President, Logistics". This is the staleness and consistency problem in miniature (§5.3).
   - **Cost.** Exa spend is about **$0.01–0.03 per lead**, against today's $0.07–0.14 per good lead.
3. **The YC company is Centralize (YC W24),** "the relationship intelligence platform for enterprise revenue". It raised $19M led by NEA in Jul 2026 (§2.1).
   - It builds account org charts and warm paths from CRM, email, calendar, call recordings and the reps' LinkedIn connections.
   - The graph's core is **private interaction metadata the customer authorises**.
   - The LinkedIn part is "LinkedIn warm connection sync" through a Chrome extension. How it works and whether LinkedIn sanctions it are *not disclosed*.
4. **LinkedIn: the only clean source for a small product is the member's own Connections export, uploaded by the user.**
   - The Connections API is for approved partners only, and SNAP is closed to new partners.
   - User Agreement §8.2 bans scraping and also bans using LinkedIn data obtained "through third parties (such as search tools…)". That clause is why the design does not quote or store LinkedIn profile text fetched through Exa (§3.2).
5. **Build order:**
   1. named contacts with gates;
   2. contact eval;
   3. a warm-path layer from an uploaded Connections CSV;
   4. bring-your-own-key email reveal.

   **No Gmail OAuth:** `gmail.metadata` is a Google *restricted* scope, which means a CASA security assessment and a 100-user lifetime cap until verified (§5.8).

---

## 1. What current tools deliver for "who to contact"

### 1.1 Comparison

| Tool | Contact fields | How verified | Price shape per contact | UX: one contact or a buying committee; "why this person" |
|---|---|---|---|---|
| **Clay** | Work email and mobile from a waterfall of providers; LinkedIn URL through providers; Claygent (its AI web agent) for custom fields ([waterfall](https://university.clay.com/fr/lessons/enrich-people-waterfalls-clay-101)) | Emails checked with ZeroBounce by default (Debounce optional); the "Only Safe To Send" setting drops catch-all addresses ([doc](https://clay.com/university/guide/zerobounce-integration-overview)) | Two meters: Actions and Data Credits. Free: 500 actions and 100 data credits a month. Launch from $54/mo annual. Growth from $185/mo annual ([pricing](https://www.clay.com/pricing)). Per-contact credit cost is *unverified* (third party says about 1 credit per email and 10 per direct dial: [review](https://marketintelligencetools.com/reviews/clay/)) | A table you build yourself. No native committee or "why". The reasoning is whatever you write into prompts |
| **Apollo.io** | Name, title, LinkedIn, email with a status label, mobile and direct dial | Own 7-step process; claims 91% accuracy and says it does not rely on SMTP checks alone ([KB](https://knowledge.apollo.io/hc/en-us/articles/10826699994381-How-Apollo-Verifies-Emails), returned 403 to me, so the content is relayed by a research subagent; *unverified*). Waterfall API ([docs](https://docs.apollo.io/docs/enrich-phone-and-email-using-data-waterfall)) | The pricing page shows no numbers. Third parties: Basic $49/seat/mo annual, about 1 credit per email and 8 per mobile ([landbase](https://www.landbase.com/blog/apollo-pricing), [fullenrich](https://fullenrich.com/content/apollo-pricing); *unverified*) | Database search plus a single-contact Chrome extension. Acquired Pocus (signal-based "who to contact / next step") on 19 Mar 2026 ([Apollo](https://www.apollo.io/magazine/apollo-acquires-pocus)) |
| **11x (Alice)** | Builds lists from "live web and third-party data sources"; fields not documented ([review](https://coldreach.ai/blog/11x.ai-review)) | Not documented. Reviewers report stale titles and emails | About $3,750/mo for 2,000 prospects a month, or $36K/yr from 11x's FAQ; the two conflict, *unverified* ([index](https://altitudebiz.dev/notes/ai-sdr-pricing-index)) | An autonomous SDR that picks the people and sends. No "why" output. TechCrunch reported in Mar 2025 that 11x listed customers it did not have ([TechCrunch](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have)) |
| **Artisan (Ava)** | Claims "250M+ verified contacts" with emails and direct dials ([llms-full.txt](https://www.artisan.co/llms-full.txt)) | Calls the data "verified" but does not say how | No public rate card | An autonomous SDR. Intent at account level only |
| **Unify** | Email and phone enrichment; claims 1.1B+ contacts | Waterfall across "11+ email and phone vendors" ([blog](https://www.unifygtm.com/explore/standalone-data-provider-vs-platform-enrichment)) | Base $20/seat/mo with 800 credits; Pro $60/seat/mo with 2,400. Email about 1 credit, phone about 4 ([pricing](https://www.unifygtm.com/pricing)) | Signal-driven plays. No per-person "why" found |
| **Common Room** | Prospector database "primarily links to LinkedIn profiles"; email fetched in real time; phone through premium enrichment ([docs](https://www.commonroom.io/docs/using-common-room/prospector/)) | "Our models + email validation tooling" | Essential $2,500/mo annual: 2.5K Prospector credits and 100 premium phone credits ([pricing](https://www.commonroom.io/pricing/)) | Persona filters. The pricing page lists a "Buying Committee" feature; what it does is *unverified* |
| **Warmly** | Person-level website-visitor identification; Coldly database with "verified emails + direct dials" ([Coldly](https://www.warmly.ai/p/data/coldly)) | Claims a 13+ vendor waterfall and 95%+ deliverability (self-reported) | From $10K/yr ([pricing](https://www.warmly.ai/pricing)) | **Buying committee**: contacts labelled Champion / Decision-maker / Influencer / Approver. "Why" explanations exist at account level only ([review](https://pipeline.zoominfo.com/sales/warmly-ai-review)) |
| **Pocus** | Recommended contacts and draft messaging per account | n/a (a signals layer) | Not public; now part of Apollo ([pocus.com](https://www.pocus.com/pricing)) | "Which accounts, who to contact, what to do next" |
| **Lusha** | Name, title, LinkedIn, email, phone | User contributions, public web and partners; claims about 95% email accuracy (self-reported); one third-party test found 75–80% ([review](https://bouncezero.io/lusha-review-2026)) | **Email 1 credit, phone 5 credits.** Starter $49.90/mo with 400 credits; Pro $69.90 with 600 ([pricing](https://www.lusha.com/pricing/); I checked this page) | Single-contact reveal |
| **Cognism** | Name, title, email, mobile | **Diamond Data: researchers phone each mobile to confirm the right person answers** ([Diamond](https://www.cognism.com/diamond-data), [help](https://help.cognism.com/hc/en-gb/articles/11964159607698)) | Quote-only; "1 credit = 1 revealed contact" ([pricing](https://www.cognism.com/pricing)) | Single contact, with intent-based account prioritisation |
| **ZoomInfo Copilot / GTM Workspace** | Full records with a contact accuracy score | ML accuracy score from recency, past human verification, source and completeness ([eng blog, 2019](https://engineering.zoominfo.com/machine-learning-accuracy-scores)) | Quote-only; Vendr median about $33.5K/yr (*unverified*, [cleanlist](https://www.cleanlist.ai/blog/2026-10-05-zoominfo-copilot-review)) | **Buying groups** of the people "most likely to engage", plus draft emails per contact |
| **HubSpot Prospecting Agent / Breeze** | Enrichment (Clearbit-derived); recommended leads with drafted outreach | Not documented | **Outcome-based since 14 Apr 2026: 100 HubSpot credits (= $1) per recommended lead** (third party, *unverified*: [supered](https://www.supered.io/blog/hubspot-prospecting-agent/), [growthoperationsfirm](https://www.growthoperationsfirm.com/blog/hubspot-prospecting-agent-credits-cost)) | Watches buying signals and assembles **buying groups of up to 3 contacts per company** (Sep 2026, third party, *unverified*: [cleanlist](https://www.cleanlist.ai/blog/2026-10-05-hubspot-prospecting-agent-review)) |
| **Exa** (Search `people` category, Websets, Agent API) | Search: profile URL, name, location and `workHistory` (title, company, from/to dates) in `entities` ([OpenAPI spec](https://exa.ai/docs/exa-spec.yaml), `SearchPersonEntityOutput`). No email or phone in Search. **Agent API** returns emails and phones when the output schema asks for them ([agent quickstart](https://exa.ai/docs/agent/quickstart.md)). Optional Fiber.ai data source ([Fiber](https://exa.ai/docs/agent/connect/fiber.md)) | Index of "1B+ public profiles" ([changelog, 19 Dec 2025](https://exa.ai/docs/changelog/people-search-launch)) with "more than 50 million updates a week" ([blog, 6 Oct 2026](https://exa.ai/blog/best-people-search-apis)). Email verification method **not documented** | Search: **$7 per 1K requests** (`auto`/`fast`, up to 10 results); contents $1 per 1K pages ([pricing](https://exa.ai/pricing)). Agent API: **$0.02 per email, $0.07 per phone**, plus $0.10 per compute unit and $0.005 per search ([pricing](https://exa.ai/pricing)). Fiber: $0.02/credit, 2 credits per work email up to 5 per phone ([Fiber](https://exa.ai/docs/agent/connect/fiber.md)). Websets: Core $49/mo for 8K credits; 10 credits per fully matching result ([FAQ](https://exa.ai/docs/websets/faq)) | Raw API. You can cap people per company with Websets' `maxPeoplePerCompany` (spec). Websets items carry "Short description of the relevance of the person" (spec, `WebsetItemPersonProperties`): a native "why" field |
| **Parallel (FindAll / Task API)** | FindAll returns entities, including people (name, URL, description, per-criterion output). **No email or phone documented** ([FindAll docs](https://docs.parallel.ai/findall-api/findall-quickstart)) | No contact verification. Every field carries a `basis` with citations (URL and excerpts), `reasoning` and `confidence` | FindAll Base $0.25 fixed + $0.03 per match; Core $2 + $0.15; Pro $10 + $1 ([pricing](https://parallel.ai/pricing); I checked this page) | **The strongest "why this person": cited evidence per criterion** |
| **Firecrawl** | Extracts whatever contact details are posted on public pages: team pages, emails, phones ([lead-enrichment docs](https://docs.firecrawl.dev/use-cases/lead-enrichment)) | **None** | Credits per page: Hobby $16/mo for 5K ([pricing](https://www.firecrawl.dev/pricing)) | None; a scraping primitive |

### 1.2 What the market converges on

- **Fields.** The standard set is name, title, LinkedIn URL, an email with a deliverability status, and a mobile number. A phone reveal costs about **4–10× an email** (Lusha 5×, Unify about 4×, Exa Agent 3.5×, Apollo about 8× per third parties).
- **Verification** is a waterfall across several providers plus an SMTP or validator check (ZeroBounce in Clay). Human phone verification exists only at Cognism (Diamond). Nobody publishes measured accuracy beyond self-reported figures; independent tests come out lower (Lusha 75–80% against a claimed 95%).
- **UX.** The market is moving from one contact to a **buying group of about 3–4 people with role labels** (HubSpot up to 3, Warmly's 4 labels, ZoomInfo buying groups).
- **"Why this person"** is mostly account-level, built on signals. Only Parallel FindAll attaches cited evidence to each field. Exa Websets has a relevance-description field, but it has no citation requirement.
- **Prospector's opening.** Nobody in the table pairs an evidenced why-now with an evidenced "why this person". Prospector's quote-checked gates can supply both.

---

## 2. Relationship-graph players

### 2.1 Centralize (YC W24): the company Joshua remembers

| Item | Finding | Source |
|---|---|---|
| YC batch, status | **Winter 2024, Active.** One-liner: "The relationship intelligence platform for enterprise revenue". Says it shows reps "who they know in each deal, who they're missing, and the fastest path to the decision-makers who close it", and aims to map trust relationships across B2B | [YC page](https://www.ycombinator.com/companies/centralize) |
| Founders, origin | Rachit Kataria and Will Wang (previously Facebook Shops, AtoB, Slack Huddles). Launch pitch: "AI-powered org charts for enterprise sales"; reps were "stuck making instantly outdated org charts in Powerpoint" | [YC launch](https://www.ycombinator.com/launches/LUE-centralize-ai-powered-org-charts-for-enterprise-sales) |
| What it does | "An org chart that builds itself from your CRM, email, and calls. Knows who your team knows." Stakeholder maps show who is engaged and who has "gone quiet". **Centra**, its AI assistant, answers questions like "Who actually owns the budget?" and "How do I get to the CRO?" | [usecentralize.com](https://www.usecentralize.com) |
| Data sources (official) | "Connect Salesforce, Slack, Gmail, Outlook, Google Calendar, Notion, Gong, and more." The Brex testimonial adds "warm networks". The pricing page lists **"LinkedIn warm connection sync"**, a **"Chrome extension and manual contacts"**, and "Email and calendar integrations" on the free plan; Salesforce and call-recorder or sequencer integrations are Enterprise-only | [home](https://www.usecentralize.com), [pricing](https://www.usecentralize.com/pricing) |
| Team, investor and advisor networks | The Jul 2026 funding coverage says it surfaces "introduction paths through executive, investor, and advisor networks". This comes from company announcements and is not independently verified | [pulse2](https://pulse2.com/centralize-raises-19-million-to-expand-enterprise-relationship-intelligence-platform/), [Yahoo/BusinessWire](https://finance.yahoo.com/technology/articles/centralize-raises-19m-led-nea-131500644.html) |
| Data partners | **Not found.** The Pro plan includes "1,000 email and 100 phone enrichment credits per user", but the provider is not named | [pricing](https://www.usecentralize.com/pricing) |
| How the graph and strength scores are built | **Not published.** The launch post says "Contact priorities update in real-time using AI-generated conversation insights from emails and calls". "Smart accounts" include "relationship scoring" and "missing stakeholder detection". A third-party review (12 Oct 2026) says scoring "relies heavily on passive email and calendar metadata" and can misjudge strength when executives meet offline. The method is *unverified* | [YC launch](https://www.ycombinator.com/launches/LUE-centralize-ai-powered-org-charts-for-enterprise-sales), [pricing](https://www.usecentralize.com/pricing), [martechradar](https://martechradar.ai/tools/centralize/) |
| What a warm path looks like | Per-account **org chart** with engagement state, plus "warm pathways into key accounts" (customer testimonial) and the "fastest path to decision-makers". No screenshot or API schema of a path was found. The UI shape is *unverified* | [home](https://www.usecentralize.com), [YC page](https://www.ycombinator.com/companies/centralize) |
| Pricing | **Free $0** (5 standard accounts, automatic org charts, LinkedIn warm connection sync, Chrome extension, email and calendar). **Pro $49/user/mo** (50 standard and 5 "Smart" accounts; extra Smart accounts $5/mo each; Centra, MCP access, suggested contacts, and 1,000 email + 100 phone enrichment credits). **Enterprise** custom (Salesforce, SSO) | [pricing](https://www.usecentralize.com/pricing) |
| Customers | Site logos include Amplitude, ElevenLabs, Webflow, Deepgram, Brex, LangChain, Decagon, **Exa**, Intercom, Highspot, MaintainX, Cresta, Sendoso. The funding release adds CoreWeave and Cognition | [home](https://www.usecentralize.com), [pulse2](https://pulse2.com/centralize-raises-19-million-to-expand-enterprise-relationship-intelligence-platform/) |
| Funding, 2026 status | **Alive.** $19M total announced 29 Jul 2026, led by NEA, with Salesforce Ventures and YC participating; angels include Stewart Butterfield. A free tier for individual reps launched at the same time | [Yahoo/BusinessWire](https://finance.yahoo.com/technology/articles/centralize-raises-19m-led-nea-131500644.html) |
| Security | "SOC 2 Type 2, SSO, RBAC, scoped OAuth, encryption at rest and in transit", "customer controlled data retention and deletion". The trust center and privacy-policy pages rendered empty to my fetcher | [home](https://www.usecentralize.com), [trust](https://trust.usecentralize.com/) |
| **How it gets LinkedIn data without breaking the ToS** | **Not disclosed.** Official materials say only "LinkedIn warm connection sync" and "Chrome extension". A third-party review says "LinkedIn synchronization depends on Chrome extensions and user-initiated authentications", producing stale graphs when reps don't refresh. That points to the extension reading the rep's own logged-in LinkedIn session, the pattern Homie documents ("uses your active LinkedIn session to fetch your connections", [Homie docs](https://usehomie.com/docs/chrome-extension/setup-and-sync)). It is not the Connections CSV export and not a Sales Navigator (SNAP) partnership. **I found no evidence either way that Centralize holds a LinkedIn partnership.** Reading the logged-in session with an extension sits in the zone §3 describes as prohibited by LinkedIn's User Agreement ("bots or other automated methods", "browser plugins and extensions"); how Centralize squares this is *unverified* | [pricing](https://www.usecentralize.com/pricing), [martechradar](https://martechradar.ai/tools/centralize/), §3 |

**What Prospector should take from Centralize:**
- The valuable part of its graph is **private interaction metadata the customer has authorised** (CRM, mail, calendar, calls). That is real tie strength.
- The LinkedIn part rides on a browser extension. For a portfolio product that is the riskiest part to copy.
- Centralize works on accounts a team is already selling into. Prospector finds new accounts, so the graph's job here is narrower: "do I already know anyone at this new company?"

### 2.2 Other graph players (comparison)

| Company | YC? | Sources connected | How the graph is built | Warm-path output | Pricing | 2026 status |
|---|---|---|---|---|---|---|
| **Happenstance** | **W24** ([YC](https://www.ycombinator.com/companies/happenstance), "People search powered by AI") | Gmail, Google Contacts and Calendar, LinkedIn, X, Outlook, Apple Contacts, plus friends' and groups' networks ([site](https://happenstance.ai/)) | Your accounts plus networks shared by friends and groups, searched in natural language | Ranked 1st- and 2nd-degree people, each with a "warm path in" via mutual connections and a drafted intro request. API, CLI and MCP available | Free; Pro $24/mo annual; Team $24/seat/mo ([pricing](https://happenstance.ai/pricing)) | Active |
| **The Swarm** | Not YC | LinkedIn connections, Gmail, calendar, Google Contacts, CRMs, CSV, API; Clay integration ([site](https://www.theswarm.com/), [Clay help](https://help.theswarm.com/en/articles/11844838-the-swarm-integration-in-clay)) | Your contacts plus a **public career-overlap dataset** (shared employers, schools, investors), with strength scores; claims 580M+ profiles | Intro paths from a company domain to your connectors, with strength and overlap dates; "Warm Intro Found" column in Clay | Conflicting prices on its own site ($29 vs $99/mo); *unverified* | Alive; **acquired Commsor on 23 Jul 2026** ([post](https://www.theswarm.com/insights/the-swarm-is-acquiring-commsor)) |
| **Village** (village.do, now village.ai) | Not YC (YC logo only under "Trusted by"; no YC company page) | Gmail, Outlook, LinkedIn, contacts, calendar | Synced private networks, public overlap data and other Village users' networks; "Person Rank"; claims 4.77B edges | API returns `strength` (e.g. 0.94) and an ordered `chain` (You → X → Y); UI shows "Path found: 94% match" ([site](https://village.ai/)) | Free (100 credits); Business $149/mo; a warm path costs 5 credits ([pricing](https://village.ai/landing/pricing)) | Alive |
| **Connect The Dots (ctd.ai)** | Not YC | Email headers, Salesforce/HubSpot, LinkedIn connections ([site](https://ctd.ai/)) | Two-way email exchange counts, recency and volume (one-way email scores 0); a LinkedIn connection alone is a weak signal; predicts ties from career overlap | e.g. "100 warm paths · 20 strong · 5 to the CXO suite"; API `/v1/paths?company=` | Free personal account; paid API price *unverified* | Alive; $15M Series A in 2021 ([press](https://www.ctd.ai/press/connect-the-dots-raises-15m-series-a-to-eliminate-sales-friction-by-harnessing-the-power-of-relationships-at-scale-2)) |
| **PartnerHQ** | **W24** ([YC](https://www.ycombinator.com/companies/partnerhq)) | Not disclosed | "Indexing vast quantities of relationship signals"; well-connected people are paid to make intros | A marketplace for buying warm intros ([launch](https://www.ycombinator.com/launches/Kee-partnerhq-buy-warm-intros-to-your-prospects)) | Not found | Active per YC; no 2026 news |
| **Cabal** | **S21** ([YC](https://www.ycombinator.com/companies/cabal)) | Founder's investors and advisors | A workspace where investors and advisors receive asks; no computed graph | Asks and warm intros through investors | Not found | Active |
| **Commsor** | Not YC | — | Warm intros for revenue teams | — | — | **Acquired by The Swarm on 23 Jul 2026**; products wound down ([post](https://www.theswarm.com/insights/the-swarm-is-acquiring-commsor)) |
| **Warmly** | S20 ([YC](https://www.ycombinator.com/companies/warmly)) | Website visitors, chat, email | **Not a relationship graph**: website-visitor de-anonymisation and intent | "Warm leads" | From $10K/yr | Active |
| **Clay** | — | No native graph found | Warm intros come through The Swarm's enrichment inside Clay ([livestream](https://www.clay.com/livestreams/find-warm-intros-to-your-target-accounts)) | "Warm Intro Found" column | Clay credits plus a Swarm plan | — |
| **Affinity / Introhive / 4Degrees** | Not YC | Firm-wide email, calendar and CRM | Interaction metadata across the whole firm | Relationship strength and "who knows whom" inside the CRM | Third-party estimates only (Affinity about $25–80K/yr), *unverified* ([avnir](https://www.avnir.com/answers/best-relationship-intelligence-platforms-2026)) | Alive |
| **Bardeen, Intro, Rivia, Jumper, Kintroduction** | — | — | Bardeen is browser automation, not a graph. Intro, Rivia, Jumper and Kintroduction: **not found** as B2B relationship-graph companies | — | — | — |

### 2.3 Two ways to build the graph

| | Interaction metadata (Centralize, CTD, Affinity, Introhive) | Public career overlap plus uploads (The Swarm, Village hybrid) |
|---|---|---|
| What an edge means | Two people actually exchanged email or met | Two people *could* know each other: same employer or school at the same time |
| Strength signal | Two-way message counts, recency, meetings (CTD gives one-way email a score of 0) | Overlap length, company size, seniority |
| Data cost | OAuth to mail and calendar (a restricted Google scope, §5.8) plus a data-processing agreement | Licensed people data plus user uploads |
| Honest label | "Knows" | "Likely knows" (inferred) |

For Prospector, the rule that follows is: an interaction or upload edge can be shown as **verified**; an overlap edge is **inferred**.

---

## 3. LinkedIn in 2026

### 3.1 Official APIs: none returns other people's profiles or a member's network to a small product

| Surface | What it gives | Who can get it | Source |
|---|---|---|---|
| Sign In with LinkedIn (OpenID Connect) | Scopes `openid`, `profile`, `email`. Returns the signed-in member's own name, photo, locale and email. No headline, position, company or connections | Self-serve | [Microsoft Learn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) |
| Connections API (`r_1st_connections`) | The authorising member's 1st-degree connections as person URNs, plus first and last name. "You cannot get connections of that user's connections (2nd-degree connections)." **"The use of this API is restricted to those developers approved by LinkedIn"** (I checked this page) | Approved partners only | [Microsoft Learn](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api) |
| `r_network` (old v1 scope) | Gone; v1 shut down 1 Mar 2019 | — | [Auth0 community](https://community.auth0.com/t/important-changes-in-linkedin-connections/21378) |
| Marketing / Community Management API | Organisation pages, posts, ads, analytics. Page Management APIs "may not be used to … collect or store member data" | Vetted apps, reviewed per use case | [app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2023-11), [product page](https://developer.linkedin.com/product-catalog/marketing/page-management) |
| Sales Navigator Application Platform (SNAP) | Embedded profile modules, analytics export, CRM sync. **LinkedIn is not currently accepting new partners**; CRM sync reaches Sales Navigator Advanced Plus customers through existing partners (Salesforce, HubSpot, Dynamics and others) | Closed to new partners | [SNAP docs](https://learn.microsoft.com/en-us/linkedin/sales/), [partners](https://business.linkedin.com/sales-solutions/partners) |
| Talent APIs | Recruiter and applicant-tracking integrations | Approved partners | [RSC](https://learn.microsoft.com/en-au/linkedin/talent/recruiter-system-connect) |

**Member data export ("Get a copy of your data").**
- It includes connections, but **only 1st-degree**: "You currently can't export a list of your contacts that aren't 1st-degree connections." ([help](https://www.linkedin.com/help/linkedin/answer/a566336), checked)
- "You will only see email addresses for connections who have allowed their connections to see or download their email address." (same page)
- The help page does not list the columns. Third-party guides give First Name, Last Name, URL, Email Address, Company, Position, Connected On ([linkedapi](https://linkedapi.io/guides/export-linkedin-connections)). *Unverified until checked against a real export.* Do that before building the parser.

### 3.2 What the User Agreement prohibits

User Agreement effective 3 Nov 2025, §8.2 "Don'ts" ([LinkedIn](https://www.linkedin.com/legal/user-agreement), checked):
- **No scraping.** "Develop, support or use software, devices, scripts, robots or any other means or processes (such as crawlers, browser plugins and add-ons or any other technology) to scrape or copy the Services, including profiles and other data from the Services".
- **No using LinkedIn data obtained second-hand.** "Copy, use, display or distribute any information (including content) obtained from the Services … through third parties (such as search tools or data aggregators or brokers)".
- **No monetising.** "Rent, lease, loan, trade, sell/re-sell or otherwise monetize the Services or related data".
- **No bots.** "Use bots or other unauthorized automated methods to access the Services".
- LinkedIn's prohibited-software page says accounts using scraping or automation tools may be restricted ([help](https://www.linkedin.com/help/linkedin/answer/a1341387)).

**The second-hand clause matters for Prospector.** Exa's people results are LinkedIn profiles; the live test in §5.3 returned only `linkedin.com/in/` URLs. Quoting a LinkedIn headline fetched through Exa is "information obtained from the Services through third parties such as search tools". This is a contract term binding LinkedIn members, not a statute. How it applies to a product operator who never touches LinkedIn is a legal question I cannot settle. The cautious design (§5) therefore **does not copy or store LinkedIn profile text** and takes its verified title quote from a non-LinkedIn page.

### 3.3 Enforcement

| Case | Outcome | Source |
|---|---|---|
| **hiQ Labs v. LinkedIn** (2017–2022) | LinkedIn won on breach of contract (Nov 2022). Consent judgment and permanent injunction on 8 Dec 2022: hiQ paid $500K, deleted the scraped data and code, and is barred from scraping and fake accounts. (The earlier Ninth Circuit CFAA rulings on public data did not save it on contract.) | [Proskauer](https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case), [MediaPost](https://www.mediapost.com/publications/article/380493/web-scraper-agrees-to-pay-linkedin-500000-destr.html) |
| **LinkedIn v. Nubela (Proxycurl)** (N.D. Cal., filed 24 Jan 2025) | Alleged fake accounts scraped millions of profiles. **Proxycurl shut down on 4 Jul 2025 "to comply with the legal settlement".** Reported injunction: delete all LinkedIn data. I did not read the docket | [Nubela](https://nubela.co/blog/goodbye-proxycurl/), [Social Media Today](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/) |
| **LinkedIn v. ProAPIs** (filed about Oct 2025) | Alleged a "fake account mill" scraping logged-in data and selling it for up to $15K/mo. A settlement in principle was reported around Feb 2026; terms undisclosed | [The Record](https://therecord.media/linkedin-sues-data-scraping-company), [The Linked Blog](https://thelinkedblog.com/2026/linkedin-reaches-deal-in-data-scraping-lawsuit-against-proapis-3857/) |
| **Apollo.io and Seamless.AI company pages** | Removed from LinkedIn around 6–7 Mar 2025, with no official reason. The scraping link is commentators' inference. Apollo's page was reportedly restored later | [Salesmotion](https://salesmotion.io/blog/linkedin-removed-apollo-brand-page-2025-alternatives), [LeadGenius](https://www.leadgenius.com/resources/linkedins-b2b-data-crackdown-what-changed-by-2026) |
| **HeyReach** (automation tool) | Company page and founder profiles removed around 25 Mar 2026. A claim that 40% of automation-tool accounts were restricted in Q1 2026 comes from a single vendor, *unverified* | [Wonda](https://www.wonda.sh/blog/linkedin-automation-safety-heyreach-ban), [LinkedCamp](https://www.linkedcamp.com/blog/40-percent-flagged-tools-restricted-q1-2026-post-heyreach) |
| Class actions over LinkedIn's extension scanning (Sep 2026) | LinkedIn beat two proposed class actions over its anti-scraping detection of browser extensions | [Bloomberg Law](https://news.bloomberglaw.com/litigation/linkedin-beats-privacy-suits-over-anti-scraping-browser-searches) |
| CNIL v. KASPR (data-protection side, §4) | €240,000 for a Chrome extension that pulled contact details from LinkedIn profiles | [CNIL](https://www.cnil.fr/en/data-scraping-kaspr-fined-eu240000) |

### 3.4 Legitimate paths for a small product

| Path | Verdict for Prospector | Source |
|---|---|---|
| **User uploads their own Connections.csv** | **Use.** The member exports their own data. GDPR still applies to the connections' data we hold, so drop the email column and set a retention period | [help](https://www.linkedin.com/help/linkedin/answer/a566336) |
| Sign In with LinkedIn | Only useful for login; returns no network | [Microsoft Learn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) |
| SNAP / Sales Navigator partnership | Not available (closed to new partners) | [SNAP docs](https://learn.microsoft.com/en-us/linkedin/sales/) |
| Connections API | Not available (approved partners only) | above |
| Licensed people-data vendors (People Data Labs, Coresignal) | Possible as a **user-brought key**. PDL says its data comes from warranted supplier sources plus public data, offers opt-out, and is a registered data broker in California and Vermont. Coresignal says it collects public data only, nothing behind logins. Both are self-claims, not audits | [PDL](https://docs.peopledatalabs.com/docs/data-sources), [Coresignal](https://docs.coresignal.com/introduction/data-and-compliance) |
| Exa `people` search | Use for **discovery of names only**. Exa does not publish its people-data provenance or legal terms in the docs I read (*unverified*). Do not store or display LinkedIn profile text from it (§3.2) | [changelog](https://exa.ai/docs/changelog/people-search-launch) |
| Public-web scraping precedent (Meta v. Bright Data, Jan 2024) | A district court held that logged-out scraping of public data did not breach Meta's terms. This is a district-court ruling only, and logged-in scraping stays exposed. Not a basis for building a scraper | [TechCrunch](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued) |

## 4. Email and phone data, and the law

*Research summary, not legal advice.*

### 4.1 Singapore (PDPA)

**Business contact information (BCI).**
- The PDPA defines BCI as "an individual's name, position name or title, business telephone number, business address, business electronic mail address or business fax number and any other similar information about the individual, not provided by the individual solely for his personal purposes".
- BCI is excluded from the Act's core data-protection obligations under s.4(5) ([PDPC decision citing s.2(1)](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Commissions-Decisions/grounds-of-decisions---comfort-and-citycab---230916.pdf), [SGPDPC 25 (2019)](https://www.singaporelawwatch.sg/Portals/0/Docs/Judgments/2019/[2019]%20SGPDPC%2025.pdf)).
- **The limit is purpose.** A mobile number can be BCI if it is used for business (the ComfortDelGro/CityCab decision above). Personal details given for personal purposes are not BCI.
- The current statute text was not fetched directly, because Singapore Statutes Online returned 403. *Verify the part numbering before quoting it.*

**Do Not Call rules (Part 9).**
- **B2B messages are excluded.** Eighth Schedule para 1(g) excludes "any message sent to an organisation other than an individual acting in a personal or domestic capacity, for any purpose of the receiving organisation" ([PDPC DNC Advisory Guidelines, rev. 1 Feb 2021](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/Advisory-Guidelines-on-the-DNC-Provisions-1-Feb-2021.pdf)).
- Messages that are not excluded must be checked against the register; results are valid for **21 days** (same guidelines).
- **Harvesting ban.** Sending to numbers obtained by dictionary attacks or address-harvesting software is prohibited, B2B or not (s.48B, per the same guidelines).

**Spam Control Act 2007.**
- Unsolicited commercial email sent in bulk (more than 100 similar messages in 24 h, 1,000 in 30 days, or 10,000 in a year) needs an `<ADV>` label and a working unsubscribe facility. Opt-outs must be honoured within 10 business days.
- Sending to harvested addresses is prohibited.
- Sources: [SSO](https://sso.agc.gov.sg/Act/SCA2007), [IMDA](https://imda.gov.sg/infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations).

### 4.2 EU and UK

**GDPR.**
- A named work email or a name plus title is personal data. Holding it needs a lawful basis, usually **legitimate interests (Art 6(1)(f))** backed by a documented balancing test.
- **Art 14:** when data was not obtained from the person, they must be told within one month, or at first contact if that is earlier ([Art 14](https://www.legislation.gov.uk/eur/2016/679/article/14)).
- The "disproportionate effort" exemption is read narrowly. Poland fined a scraper that relied on a website-only notice ([Covington](https://www.insideprivacy.com/data-privacy/polish-supervisory-authority-issues-gdpr-fine-for-data-scraping-without-informing-individuals/)).

**Fines against B2B data businesses.**
- **CNIL v. KASPR, 5 Dec 2024, €240,000** ([CNIL](https://www.cnil.fr/en/data-scraping-kaspr-fined-eu240000), checked). The breaches:
  - collecting details users had restricted to 1st/2nd-degree connections (Art 6);
  - renewing a five-year retention period on every update (Art 5(1)(e));
  - notifying people only four years later, in English (Arts 12/14);
  - answering access requests with a generic "publicly accessible sources" (Art 15).
- **AEPD v. Informa D&B (Spain, 2025), €1.8M** for processing data on sole traders with no documented balancing test. Press reports only, *unverified* ([ppc.land](https://ppc.land/spanish-data-protection-authority-orders-business-data-firm-to-delete-eu1-8-million-worth-of-records/)).

**UK PECR reg 22** ([ICO B2B guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/)).
- Cold email to **corporate subscribers** (companies, LLPs) needs no consent. The sender must be identified and an opt-out offered.
- **Sole traders and partnerships** count as individuals and need consent or the soft opt-in.
- UK GDPR still applies, and the right to object to direct marketing is absolute.

**UK Data (Use and Access) Act 2025.**
- Most data-protection provisions commenced on 5 Feb 2026 ([DLA Piper](https://privacymatters.dlapiper.com/2026/02/uk-commencement-of-the-data-protection-provisions-in-the-data-use-and-access-act/)).
- PECR fines rise to UK GDPR levels.
- Whether direct marketing became a "recognised legitimate interest" with no balancing test is reported inconsistently. *Unverified; read the Act before relying on it.*

**Germany.** B2B cold email needs prior consent under UWG §7, and a GDPR-compliant database does not change that ([Dealfront](https://www.dealfront.com/guides/guide-to-cold-calling-and-emailing-europe)). The paragraph numbering is *unverified*.

### 4.3 United States: CAN-SPAM

- **There is no B2B exemption** ([FTC guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)).
- Headers and subject lines must not be false or misleading. The message must be identified as an ad and must include a valid physical postal address.
- It needs a working opt-out, honoured within 10 business days.
- Penalties run up to $53,088 per email, and the sender cannot contract liability away to a vendor.

### 4.4 What providers claim (their own statements, not audits)

| Vendor | Claim | Source |
|---|---|---|
| Apollo | Legitimate-interests basis with an outside-counsel assessment; sends collection notices to EU, UK and Swiss residents; opt-out goes to a suppression list; admins can exclude EU prospects | [KB](https://knowledge.apollo.io/hc/en-us/articles/19331318468621), [GDPR settings](https://knowledge.apollo.io/hc/en-us/articles/4409141087757-Configure-GDPR-Settings-on-Apollo) |
| ZoomInfo | Says it notified 117M+ professionals by Feb 2021; runs a Privacy Center with opt-out and access requests; offers a Compliance API | [BusinessWire](https://www.businesswire.com/news/home/20210310005561/en), [privacy FAQ](https://privacy.zoominfo.com/faqs/business/is-zoominfo-legal) |
| Cognism | Sends Art 14 notices "where required"; screens phones against TPS/CTPS and other countries' DNC registries | [compliance](https://www.cognism.com/compliance) |
| Lusha | Legitimate interests; states it does not collect opt-in consent for third-party outreach, so the customer must add safeguards | [Lusha docs](https://docs.lusha.com/user-guide/privacy-and-compliance/how-can-i-ensure-compliance-with-privacy-laws-when-using-lushas-data-for-b2b-out) |

**Pattern:** every vendor puts outreach compliance on the customer. A product that shows their data inherits that position for whatever it stores.

### 4.5 What a cautious Prospector stores and shows

| Store / show | Don't |
|---|---|
| Name, title, company, the public URL of the evidence page, the verbatim title quote, capture date. In Singapore this is BCI; in the EU it is personal data under legitimate interests | LinkedIn profile text, copied or cached (§3.2) |
| Retention tied to the run, with a fixed time-to-live that is **not** renewed on update (the KASPR finding) | Emails or phones by default. Never personal (non-work) emails |
| Source of each record, so an access request can name the specific page (another KASPR finding) | Harvested emails or phones (illegal under SG s.48B and the Spam Control Act; KASPR in the EU) |
| Uploaded Connections.csv minus the email column, per user, deletable | Any automated LinkedIn access, or any extension reading a logged-in session |
| Emails only through the user's own provider key, one reveal per click, with the vendor's opt-out honoured | Outreach sending. Prospector stays a research tool, which keeps CAN-SPAM, PECR and UWG obligations with the sender |

**Art 14 exposure.** If Prospector *stores* contacts of EU/UK people beyond a single run, Art 14 notice duties arguably attach to Prospector itself. The cheapest compliant posture is to keep contacts in the run's state only, delete them with the run, and say so in the UI. Whether that is enough is a question for counsel. *Unverified.*

---

## 5. Gold standard for Prospector

### 5.1 Definition

A **contact** is a named person who meets all four conditions:
- **(a)** currently works at the lead company;
- **(b)** holds a title matching one of the seller profile's `buyer_roles` (`src/planner/profile.ts:11`; the field exists today, but no plan card exposes it);
- **(c)** has an **evidence page that is not LinkedIn** whose captured text contains the person's name, the company and the title, quoted verbatim. In order of preference: the company's own domain (team, leadership or press pages), then a dated news or press article;
- **(d)** comes with a one-line "why this person" that ties their role to the lead's why-now signal.

The LinkedIn profile URL, if known, is shown as a link only.

**Tiers:**
- **verified:** (a)–(c) pass in code.
- **inferred:** the person was found only through a people index or a LinkedIn-derived page (Exa `people` results, exa.ai/library/person mirrors, aggregators such as theorg.com or datanyze). Shown with name, link and "title unconfirmed". No copied profile text.

Up to **3 contacts per lead**, matching HubSpot's buying-group size (§1).

### 5.2 Data model (proposed)

```ts
type ContactTier = "verified" | "inferred";      // same contract as lead vs candidate

interface Contact {
  id: string;                     // hash(lead_id + normalised name)
  lead_id: string;
  name: string;
  evidence_url: string;           // non-LinkedIn page holding the quotes (verified tier); absent for inferred
  evidence_kind: "company_domain" | "press" | null;
  profile_url?: string;           // linkedin.com/in/... — shown as a link, text never stored
  found_via: "exa_people" | "web_search";
  title_quote?: string;           // verbatim, checked against evidence page text
  company_quote?: string;         // verbatim, checked against evidence page text
  buyer_role: string;             // which seller-profile role it matched
  role_match: "exact" | "synonym";
  current_since?: string;         // workHistory[i].dates.from where dates.to == null
  why_this_person: string;        // model-written, ≤ 160 chars
  why_quote?: string;             // optional verbatim support from the signal page
  page_fetched_at: string;        // our fetch time
  page_published_at?: string;     // Exa publishedDate of the evidence page, when known
  page_source: "cached" | "live"; // Exa /contents status.source
  index_title?: string;           // title from Exa people workHistory, used only to cross-check, not displayed as a quote
  tier: ContactTier;
  code?: ContactGateCode;         // why it is inferred or rejected
  // NOT stored by default: email, phone, location beyond country, photo, education
}

interface Connection {            // only from a user upload (LinkedIn Connections.csv)
  owner_user_id: string;
  name: string;
  profile_url?: string;
  company?: string;               // as the member typed it, at export time
  position?: string;
  connected_on?: string;
  // email column dropped at import (see §3/§4)
  upload_id: string;              // for deletion and retention
}

interface WarmPath {
  lead_id: string;
  contact_id?: string;            // a path to the person, or only to the company
  hops: Array<{ from: string; to: string;
                kind: "linkedin_1st" | "same_company_now" | "career_overlap";
                evidence: string }>;   // "Connections.csv row 214, connected 2023-04-02"
  tier: "verified" | "inferred";  // career_overlap is always inferred
}
```

### 5.3 Exa calls (checked against the docs and 3 live calls on 2026-10-16)

**Call A: candidate names from the people index.**
`POST /search` with `{ query: "<buyer_role> at <Company>", category: "people", type: "auto", numResults: 5 }`.
- **Constraints.** `people` rejects `startPublishedDate`, `endPublishedDate` and `excludeDomains`; "Requests that set an unsupported filter return a 400 error" ([OpenAPI spec](https://exa.ai/docs/exa-spec.yaml), `SearchRequest.category`). Recency therefore has to be checked by our gate.
- **Cost.** $7 per 1K requests, so **$0.007** ([pricing](https://exa.ai/pricing)). The live `costDollars.total` was 0.007.
- **Live result** ("VP of Operations at Verst Logistics"):
  - 5 results, all `linkedin.com/in/…`, `publishedDate` 2026-10-02 to 2026-10-12.
  - Each carried `entities[0].properties.workHistory` with a current role at Verst: "Vice President of Fulfillment Operations" (from 2022-04), "SVP. Warehousing and Fulfillment" (from 2024-02), "VP of Warehousing" (from 2008-01), and two others.
  - One spelled the employer "Verst Group Logistics", so company matching needs the normalisation `companyResultMatches` already does.
- **How to use it.** Names and `workHistory` serve as **candidates and a cross-check only**. We do not store or show profile text: a `/contents` call on one profile ($0.001) returned the LinkedIn headline from Exa's cache (`"source": "cached"`), and using that is what §3.2 warns against.

**Call B: non-LinkedIn evidence for each candidate (or the role).**
`POST /search` with `{ query: "<Company> <buyer_role> leadership team", type: "auto", numResults: 8, excludeDomains: ["linkedin.com", "exa.ai"], includeDomains?: [<lead domain>], contents: { highlights: { query: "<role words>" } } }`.
- **Cost.** $0.007. Contents for the first 10 results are included free since 3 Mar 2026 ([changelog](https://exa.ai/docs/changelog/people-search-launch)); the live call's total was $0.007.
- **Live result:**
  - `verstlogistics.com/about-us/our-team/travis-french`: "Senior Vice President, Logistics … Travis French, the Senior Vice President at Verst, manages all Warehousing and Fulfillment operations".
  - `verstlogistics.com/about-us/our-team/chris-verst`: "Vice President, Transportation".
  - Also returned, and **to be excluded** as LinkedIn mirrors or aggregators: `exa.ai/library/person/...` (an Exa-hosted mirror whose text links `linkedin.com/company/verst-logistics`), theorg.com and datanyze.com.
- **Run a second pass** with `includeDomains: [<lead domain>]` when the first pass finds no own-domain page. *Not tested.*

**Then fetch the full page text.** `/contents` on the chosen evidence URL ($0.001) so the quote check has the full page, the same pattern as lookups today.

**Optional Call C: email or phone, only with explicit user opt-in.**
- Exa Agent API with `outputSchema` fields of `format: "email"`: $0.02 per email, $0.07 per phone, plus compute ([agent quickstart](https://exa.ai/docs/agent/quickstart.md)).
- Exa does not document how it verifies these.
- Recommendation: not the default; prefer the user's own provider key (§5.9).

**Not for the default path: Websets.**
- It has a separate credit meter, and the API needs a paid Websets plan ([quickstart](https://exa.ai/docs/websets/quickstart.md)).
- Its person items are profile-based (`WebsetItemPersonProperties`), which raises the same LinkedIn-text issue.

### 5.4 Gate rules (code-checkable)

These are new `checkContact` codes, mirroring `checkLead`. Each returns `{ ok, tier, code }`.

| Code | Tier | Rule |
|---|---|---|
| `contact_linkedin_evidence` | inferred | The only evidence is `linkedin.com`, an `exa.ai/library/person` mirror, or a listed aggregator (theorg.com, datanyze.com, zoominfo.com, rocketreach.co, apollo.io/people, and others). Show the name and link only; store no quotes |
| `contact_quote_not_in_page` | reject | The name, `title_quote` or `company_quote` is not a normalised substring of the captured evidence-page text. Reuses the lead quote matcher |
| `contact_off_domain` | inferred | The evidence page is neither on the lead's registrable domain nor a dated news or press article naming the company. This uses the registrable-domain logic of FAILURES #26 |
| `contact_company_mismatch` | reject | The company named on the evidence page fails `companyResultMatches` against the lead. This also catches a different company with a similar name |
| `contact_left_company` | reject | The Exa `workHistory` for the same name shows the lead-company role ended, or a newer role elsewhere. Used as a cross-check only |
| `contact_title_conflict` | inferred | The evidence-page title and the index title map to different `buyer_roles` (the Verst case maps to the same role, so it passes) |
| `contact_role_mismatch` | reject | The title does not match any plan `buyer_roles` after synonym expansion. The model proposes the synonym list at plan time on a card the user approves |
| `contact_stale` | inferred | The evidence page is an article dated more than 18 months ago, or a team page with no date and no index confirmation that the role is current |
| `contact_unquoted_why` | inferred | `why_this_person` has no verbatim support from the evidence or signal page |
| `contact_duplicate`, `contact_cap` | reject | Same normalised name already on this lead; more than 3 contacts |

**Order of operations.**
- Contacts are attempted only for **accepted** leads, never for candidates.
- Contact results never change the lead's status or the lead precision score.
- A lead with zero verified contacts still ships, labelled "no verified contact".

### 5.5 UI

- **Lead card, under the evidence block: "Who to contact".** Up to 3 rows. Each row shows:
  - the name;
  - the title quote, linked to its evidence page (e.g. verstlogistics.com/…/travis-french);
  - a small LinkedIn icon link, if known;
  - a role chip (e.g. "Ops leader");
  - "why this person";
  - a tier badge: `Title verified on company site` or `Title unconfirmed`, plus the reason. An **inferred** contact is shown greyed with its code, the same treatment as candidate leads.
- **Warm path row**, only when the user has a connector: "You know **X** (1st-degree, connected 2023) → **X** works at Lead Co" or "**X** is the contact". Each hop has an evidence tooltip pointing to the upload row. Inferred overlap paths are labelled "possible link: worked together at Z, 2019–21".
- **Settings → Connectors**:
  - **LinkedIn connections (upload CSV)**: shows the row count, the upload date, a "delete" button and the retention date.
  - **Email provider key (BYO)**: Apollo, Lusha or similar. The email/phone column appears only if this is set, and each reveal is a click, never a bulk action.
  - **Gmail / Calendar**: shown as "not available", with a one-line reason (restricted scope, §5.8).
- **CSV export** gains `contact_name`, `contact_title`, `contact_url`, `contact_tier`, `warm_path` columns. No email or phone unless revealed through the user's own key.

### 5.6 Cost per lead

| Item | Calls | Cost |
|---|---|---|
| Call A, people index | 1–2 per lead (one per buyer role, at most 2 roles) | $0.007–0.014 |
| Call B, non-LinkedIn evidence search (highlights included) | 1–2 per lead | $0.007–0.014 |
| Full text of evidence pages | ≤ 3 | ≤ $0.003 |
| Model choice and "why" | One extra tool turn per lead, or batched at the end | about $0.01–0.03 *(estimate from the README's $0.21–0.42 of Claude spend per 10-lead run, i.e. about $0.02–0.04 per turn; not measured for this call)* |
| **Total per lead** | | **≈ $0.025–0.06**. Against $0.07–0.14 per good lead today, that adds about 30–50% |
| Optional email reveal | per click | $0.02 via Exa Agent plus compute; Lusha 1 credit ≈ $0.09–0.12 at list prices |
| Warm path | local join on the uploaded CSV | $0 |

### 5.7 Eval plan

**Labelled set.** Take the 12 good leads from `live-quotes-2026-10-14` plus the memory-eval leads, about 25 companies.
- For each, a human (Joshua) records up to 3 people in each buyer role, with their current title and the URL where he confirmed it, as of the labelling date. The human may look at LinkedIn manually; the product does not. Freeze this set before the first scored run, as `eval/RUBRIC.md` was.

**Per-contact rubric** (blind, like the lead judge):
- **C1 Exists and identity.** The evidence page is about this real person.
- **C2 Current employer** is the lead company today.
- **C3 Role fit.** The title is in `buyer_roles`.
- **C4 "Why" is supported** by a quote.

A contact is *correct* only if C1–C3 are all yes.

**Metrics:**
- **Contact precision** = correct ÷ shown verified contacts. Target ≥ 0.95, since a wrong person is worse than none.
- **Coverage** = leads with ≥ 1 verified correct contact ÷ leads.
- **Inferred-tier honesty** = the share of inferred contacts that turn out wrong. It should be high; if inferred contacts are mostly right, the gate is too strict.
- **Stale rate** = C2 "no" among verified contacts. This measures the team-page staleness risk directly.
- **Verified-tier coverage cost of the no-LinkedIn-text rule** = verified contacts ÷ (verified + `contact_linkedin_evidence`). This is the number that says what the ToS-cautious design costs. Mid-market logistics firms with team pages (like Verst) should do well; startups with no team page will not.

**Bounds.** n = 25 leads × up to 3 contacts ≈ 60 contacts. That is enough to see a 0.80 vs 0.95 gap, but not to prove 0.98 (same arithmetic as README §1).

**Cost:** about 25 × $0.05 ≈ **$1.25** for the runs, plus judge spend. Per the paid-eval rule, run `--limit 1` first and inspect the raw output.

### 5.8 Warm-path layer (optional)

**Inputs, in order of safety:**
1. **LinkedIn Connections.csv, uploaded by the user from their own data export.** This is the member's own data, given by the member; no LinkedIn API is involved. Columns and the email-column caveat: §3.
2. **Teammates' uploads (a team graph).** This is the only honest way to get "you know X who knows Y": Y must be in X's own upload. A single user's CSV holds only 1st-degree edges; LinkedIn does not export 2nd-degree connections.
3. **Gmail / Calendar metadata via OAuth: deferred.** Google classifies `gmail.metadata` ("View your email message metadata such as labels and headers, but not the email body") as a **restricted** scope ([Google scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Server-side use of restricted-scope data requires verification plus an annual CASA security assessment ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification?hl=ja), [Nango](https://docs.nango.dev/integrations/google-security-review)). Unverified apps are capped at **100 users over the project's lifetime**, a cap that cannot be reset ([Google help](https://support.google.com/cloud/answer/15549945?hl=es)). That is not worth it for a portfolio product. Calendar scope classification was not on the Calendar auth page; *unverified*.

**Computation** (all in code, no model):
- **1st degree, person.** The contact's `profile_url` matches a `Connection.profile_url` after normalisation: "You are connected to Jason Mess (since 2023-04-02)". Tier verified.
- **1st degree, company.** `Connection.company` fuzzy-matches the lead company (`companyResultMatches`): "You know Travis French at Verst Logistics (SVP Warehousing)". Tier verified *as of the export date*; show that date.
- **2nd degree via a teammate.** Same as the two rules above, over a teammate's upload: "Your teammate Ana is connected to Jason Mess". Tier verified.
- **Overlap: inferred.** The contact's `workHistory` past employer equals a connection's current company. This is weak, because the CSV holds current companies only, so show it last or not at all.

**Display.** Every hop shows its evidence (file and row, connected-on date). This follows the same rule as leads: no claim without a checkable source.

### 5.9 Risks, and what we will not build

| Risk | Mitigation |
|---|---|
| **Hallucinated people** (the model invents a plausible "VP Ops") | The name, title and company must all be verbatim on a captured page, or the contact is rejected; the model cannot introduce a name that no page contains. Same structure as `quote_not_in_page` |
| **Wrong person, same name** | Name, company and title must co-occur on one evidence page; the index `workHistory` is a cross-check |
| **Stale titles** (team pages lag; Exa content can be `cached`; live Verst test showed two titles for one person) | `contact_stale` and `contact_title_conflict` move doubtful cases to inferred; show the capture date; the eval measures the stale rate |
| **Privacy** (personal data about people who never signed up) | Store the minimum: name, title quote, evidence URL, capture date. No email, phone or photo by default. Retention tied to the run, not renewed on update (KASPR). Honour deletion requests. Art 14 exposure for EU/UK people (§4.5) |
| **Using LinkedIn data obtained through a search tool** (§3.2, clause on third parties) | No LinkedIn profile text is stored or shown. LinkedIn URLs are links only; LinkedIn-only matches are inferred. This is a judgement call on contract risk, not a legal opinion; Joshua should decide whether even showing index-derived names is acceptable (§7) |
| **Connections CSV leaks** | Process per user and never share across accounts. Drop the email column at import. Delete on request and after a fixed retention period |
| **LinkedIn ToS (scraping)** | No scraping, no extension reading logged-in sessions, no automated visits to LinkedIn, and no `/contents` calls on `linkedin.com` URLs |
| **Seller misuse** (spam) | No sending, sequencing or bulk reveal. One reveal per click through the user's own key. Agent-to-agent handoff is already out of scope (SPEC §5) |

**We will refuse to build:**
- LinkedIn scraping, `/contents` on LinkedIn URLs, or browser-extension sync of a logged-in session (the Centralize/Homie pattern);
- automated connection requests or messages;
- bulk email or phone harvesting from Firecrawl-style page scraping;
- storage of personal emails;
- inferred email patterns ("first.last@") presented as verified;
- any "2nd-degree" claim not backed by an uploaded edge.

---

## 6. Build order

| Step | What | Cost to build and evaluate | What it shows a hiring manager at an agent company |
|---|---|---|---|
| **1. Named contacts with gates** | `find_contacts` tool (Call A people index + Call B non-LinkedIn evidence + contents), `checkContact` codes from §5.4, a buyer-roles card in the plan, a "Who to contact" UI row, CSV columns, mocked unit tests for every code | About $0.05 to exercise live (`--limit 1`), then ≈ $0.025–0.06 per lead in production | The core pattern again (model proposes, code decides) on a new entity type. Quotes are checked on people as well as companies. An inferred tier instead of guessing |
| **2. Contact eval** | Freeze about 25 labelled companies; per-contact rubric C1–C4; precision, coverage, stale-rate report; replay at $0 | ≈ $1.25 of Exa and Claude plus about 2–3 h of labelling | Eval discipline: a frozen set, blind judging, and honest n. The stale rate is measured, not asserted |
| **3. Warm paths from an uploaded Connections CSV** | Upload parser (drops the email column), a `Connection` table with retention and delete, 1st-degree person and company joins, evidence tooltips; teammate uploads optional | $0 runtime (local joins) | Personal-data handling done right: user-supplied data only, minimal fields, deletable. Product judgment on what a "warm path" can honestly claim |
| **4. BYO-key email reveal** | Settings field for an Apollo or Lusha key, one reveal per click, nothing stored beyond the session unless the user exports | Users pay their provider; about $0 to us | Integration and consent design: no default contact harvesting, and the cost and accountability sit with the user's own contract |

**Deferred, with reasons:**
- **Gmail and Calendar OAuth:** a restricted scope, CASA, and the 100-user cap (§5.8).
- **Career-overlap 2nd degree:** inferred only, and needs people-data lookups for every connection.
- **A buying-committee org chart à la Centralize:** it needs CRM and call data that Prospector, which works on new accounts, does not have.

## 7. Decisions for Joshua before building

1. **Show LinkedIn-index-only names at all?**
   - The design shows them as *inferred*: name plus link, no text.
   - The stricter option shows only people verified on non-LinkedIn pages. That is lower coverage and zero reliance on LinkedIn-derived data.
   - My position: **show them, inferred, link only, no stored text.** The name and the URL are what the user would find by searching anyway, and hiding them makes the feature useless for companies without a team page. It is reversible either way: one tier filter.
2. **Retention for contacts and uploaded connections.**
   - Proposal: contacts live and die with the run; connection uploads are kept 90 days, deletable at any time, with no renewal on re-upload of the same rows.
3. **Whether to add a buyer-roles plan card now** (`buyer_roles` is already extracted but not shown). Step 1 needs it, because code can only check a title against a list the user has approved.
4. **Verify the real Connections.csv columns** from an export of your own before writing the parser (§3.1, third-party list *unverified*).

---

## Sources

Spend on live verification for this document: 3 Exa calls, $0.016 in total (`costDollars` in each response).
- <https://university.clay.com/fr/lessons/enrich-people-waterfalls-clay-101>
- <https://clay.com/university/guide/zerobounce-integration-overview>
- <https://www.clay.com/pricing>
- <https://marketintelligencetools.com/reviews/clay/>
- <https://knowledge.apollo.io/hc/en-us/articles/10826699994381-How-Apollo-Verifies-Emails>
- <https://docs.apollo.io/docs/enrich-phone-and-email-using-data-waterfall>
- <https://www.landbase.com/blog/apollo-pricing>
- <https://fullenrich.com/content/apollo-pricing>
- <https://www.apollo.io/magazine/apollo-acquires-pocus>
- <https://coldreach.ai/blog/11x.ai-review>
- <https://altitudebiz.dev/notes/ai-sdr-pricing-index>
- <https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have>
- <https://www.artisan.co/llms-full.txt>
- <https://www.unifygtm.com/explore/standalone-data-provider-vs-platform-enrichment>
- <https://www.unifygtm.com/pricing>
- <https://www.commonroom.io/docs/using-common-room/prospector/>
- <https://www.commonroom.io/pricing/>
- <https://www.warmly.ai/p/data/coldly>
- <https://www.warmly.ai/pricing>
- <https://pipeline.zoominfo.com/sales/warmly-ai-review>
- <https://www.pocus.com/pricing>
- <https://bouncezero.io/lusha-review-2026>
- <https://www.lusha.com/pricing/>
- <https://www.cognism.com/diamond-data>
- <https://help.cognism.com/hc/en-gb/articles/11964159607698>
- <https://www.cognism.com/pricing>
- <https://engineering.zoominfo.com/machine-learning-accuracy-scores>
- <https://www.cleanlist.ai/blog/2026-10-05-zoominfo-copilot-review>
- <https://www.supered.io/blog/hubspot-prospecting-agent/>
- <https://www.growthoperationsfirm.com/blog/hubspot-prospecting-agent-credits-cost>
- <https://www.cleanlist.ai/blog/2026-10-05-hubspot-prospecting-agent-review>
- <https://exa.ai/docs/exa-spec.yaml>
- <https://exa.ai/docs/agent/quickstart.md>
- <https://exa.ai/docs/agent/connect/fiber.md>
- <https://exa.ai/docs/changelog/people-search-launch>
- <https://exa.ai/blog/best-people-search-apis>
- <https://exa.ai/pricing>
- <https://exa.ai/docs/websets/faq>
- <https://docs.parallel.ai/findall-api/findall-quickstart>
- <https://parallel.ai/pricing>
- <https://docs.firecrawl.dev/use-cases/lead-enrichment>
- <https://www.firecrawl.dev/pricing>
- <https://www.ycombinator.com/companies/centralize>
- <https://www.ycombinator.com/launches/LUE-centralize-ai-powered-org-charts-for-enterprise-sales>
- <https://www.usecentralize.com>
- <https://www.usecentralize.com/pricing>
- <https://pulse2.com/centralize-raises-19-million-to-expand-enterprise-relationship-intelligence-platform/>
- <https://finance.yahoo.com/technology/articles/centralize-raises-19m-led-nea-131500644.html>
- <https://martechradar.ai/tools/centralize/>
- <https://trust.usecentralize.com/>
- <https://usehomie.com/docs/chrome-extension/setup-and-sync>
- <https://www.ycombinator.com/companies/happenstance>
- <https://happenstance.ai/>
- <https://happenstance.ai/pricing>
- <https://www.theswarm.com/>
- <https://help.theswarm.com/en/articles/11844838-the-swarm-integration-in-clay>
- <https://www.theswarm.com/insights/the-swarm-is-acquiring-commsor>
- <https://village.ai/>
- <https://village.ai/landing/pricing>
- <https://ctd.ai/>
- <https://www.ctd.ai/press/connect-the-dots-raises-15m-series-a-to-eliminate-sales-friction-by-harnessing-the-power-of-relationships-at-scale-2>
- <https://www.ycombinator.com/companies/partnerhq>
- <https://www.ycombinator.com/launches/Kee-partnerhq-buy-warm-intros-to-your-prospects>
- <https://www.ycombinator.com/companies/cabal>
- <https://www.ycombinator.com/companies/warmly>
- <https://www.clay.com/livestreams/find-warm-intros-to-your-target-accounts>
- <https://www.avnir.com/answers/best-relationship-intelligence-platforms-2026>
- <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2>
- <https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api>
- <https://community.auth0.com/t/important-changes-in-linkedin-connections/21378>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2023-11>
- <https://developer.linkedin.com/product-catalog/marketing/page-management>
- <https://learn.microsoft.com/en-us/linkedin/sales/>
- <https://business.linkedin.com/sales-solutions/partners>
- <https://learn.microsoft.com/en-au/linkedin/talent/recruiter-system-connect>
- <https://www.linkedin.com/help/linkedin/answer/a566336>
- <https://linkedapi.io/guides/export-linkedin-connections>
- <https://www.linkedin.com/legal/user-agreement>
- <https://www.linkedin.com/help/linkedin/answer/a1341387>
- <https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case>
- <https://www.mediapost.com/publications/article/380493/web-scraper-agrees-to-pay-linkedin-500000-destr.html>
- <https://nubela.co/blog/goodbye-proxycurl/>
- <https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/>
- <https://therecord.media/linkedin-sues-data-scraping-company>
- <https://thelinkedblog.com/2026/linkedin-reaches-deal-in-data-scraping-lawsuit-against-proapis-3857/>
- <https://salesmotion.io/blog/linkedin-removed-apollo-brand-page-2025-alternatives>
- <https://www.leadgenius.com/resources/linkedins-b2b-data-crackdown-what-changed-by-2026>
- <https://www.wonda.sh/blog/linkedin-automation-safety-heyreach-ban>
- <https://www.linkedcamp.com/blog/40-percent-flagged-tools-restricted-q1-2026-post-heyreach>
- <https://news.bloomberglaw.com/litigation/linkedin-beats-privacy-suits-over-anti-scraping-browser-searches>
- <https://www.cnil.fr/en/data-scraping-kaspr-fined-eu240000>
- <https://docs.peopledatalabs.com/docs/data-sources>
- <https://docs.coresignal.com/introduction/data-and-compliance>
- <https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued>
- <https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Commissions-Decisions/grounds-of-decisions---comfort-and-citycab---230916.pdf>
- <https://www.singaporelawwatch.sg/Portals/0/Docs/Judgments/2019/[2019]%20SGPDPC%2025.pdf>
- <https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/Advisory-Guidelines-on-the-DNC-Provisions-1-Feb-2021.pdf>
- <https://sso.agc.gov.sg/Act/SCA2007>
- <https://imda.gov.sg/infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations>
- <https://www.legislation.gov.uk/eur/2016/679/article/14>
- <https://www.insideprivacy.com/data-privacy/polish-supervisory-authority-issues-gdpr-fine-for-data-scraping-without-informing-individuals/>
- <https://ppc.land/spanish-data-protection-authority-orders-business-data-firm-to-delete-eu1-8-million-worth-of-records/>
- <https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/>
- <https://privacymatters.dlapiper.com/2026/02/uk-commencement-of-the-data-protection-provisions-in-the-data-use-and-access-act/>
- <https://www.dealfront.com/guides/guide-to-cold-calling-and-emailing-europe>
- <https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>
- <https://knowledge.apollo.io/hc/en-us/articles/19331318468621>
- <https://knowledge.apollo.io/hc/en-us/articles/4409141087757-Configure-GDPR-Settings-on-Apollo>
- <https://www.businesswire.com/news/home/20210310005561/en>
- <https://privacy.zoominfo.com/faqs/business/is-zoominfo-legal>
- <https://www.cognism.com/compliance>
- <https://docs.lusha.com/user-guide/privacy-and-compliance/how-can-i-ensure-compliance-with-privacy-laws-when-using-lushas-data-for-b2b-out>
- <https://exa.ai/docs/websets/quickstart.md>
- <https://developers.google.com/workspace/gmail/api/auth/scopes>
- <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification?hl=ja>
- <https://docs.nango.dev/integrations/google-security-review>
- <https://support.google.com/cloud/answer/15549945?hl=es>
