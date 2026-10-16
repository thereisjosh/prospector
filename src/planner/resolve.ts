import { CostGuard, exaPost, exaSearch, type ExaCredentials } from "../exa";

/**
 * Describe-step input resolution: every realistic thing a seller pastes becomes either a page we can
 * profile directly (website, marketplace storefront, carrd/pop.site page), a business name / social
 * handle we resolve to candidate websites ("Is this you?"), or a specific refusal.
 * Contract: docs/SPEC-v2.md section 2 [0].
 */

/* ------------------------------ host lists ------------------------------ */

/** Social networks and messengers. Never a seller's own site. */
export const SOCIAL_HOSTS = [
  "instagram.com", "facebook.com", "fb.com", "fb.me", "tiktok.com", "x.com", "twitter.com", "t.co",
  "youtube.com", "youtu.be", "linkedin.com", "threads.net", "threads.com", "pinterest.com", "snapchat.com",
  "reddit.com", "tumblr.com", "twitch.tv", "telegram.me", "t.me", "wa.me", "whatsapp.com", "line.me",
  "weibo.com", "xiaohongshu.com", "discord.com", "discord.gg", "medium.com",
] as const;

/** Marketplaces. A storefront on one is profiled with its path; the marketplace itself is never a candidate. */
export const MARKETPLACE_HOSTS = [
  "shopee.sg", "shopee.com", "shopee.co.id", "shopee.ph", "shopee.com.my", "shopee.tw", "shopee.vn", "shopee.co.th",
  "lazada.sg", "lazada.com", "lazada.com.my", "lazada.co.id", "lazada.co.th", "lazada.com.ph", "lazada.vn",
  "carousell.sg", "carousell.com", "carousell.com.hk", "carousell.com.my", "etsy.com",
  "amazon.com", "amazon.sg", "amazon.co.uk", "amazon.in", "amazon.de", "amazon.com.au", "ebay.com", "ebay.co.uk",
  "qoo10.sg", "qoo10.com", "tokopedia.com", "aliexpress.com", "alibaba.com", "1688.com", "taobao.com", "tmall.com",
  "rakuten.com", "walmart.com", "mercadolibre.com", "grabfood.com", "foodpanda.sg", "fave.co",
] as const;

/** Shopify's own subdomain. A storefront (profiled with its path) but, unlike MARKETPLACE_HOSTS, a legitimate candidate. */
export const SHOPIFY_STOREFRONT_HOST = "myshopify.com";

/** Map and business-listing sites. google.com/maps is matched by path (see isMapsUrl). */
export const MAPS_HOSTS = [
  "maps.google.com", "g.page", "goo.gl", "maps.app.goo.gl", "maps.apple.com", "yelp.com", "yelp.com.sg", "yelp.ca",
  "yelp.co.uk", "tripadvisor.com", "tripadvisor.com.sg", "tripadvisor.co.uk", "tripadvisor.in", "tripadvisor.com.au",
  "foursquare.com", "waze.com", "openstreetmap.org", "mapcarta.com", "hungrygowhere.com", "burpple.com",
] as const;

/** Link-in-bio pages: not the seller's site; their outbound links are. */
export const BIOLINK_HOSTS = [
  "linktr.ee", "linktree.com", "beacons.ai", "bio.site", "lnk.bio", "linkin.bio", "campsite.bio", "solo.to",
  "taplink.cc", "allmylinks.com", "msha.ke", "direct.me", "hoo.be", "flow.page", "bio.link", "stan.store",
  "linkpop.com", "tap.bio",
] as const;

/** Site builders whose pages ARE the seller's site (subdomain required): profiled directly with the full URL. */
export const SITE_BUILDER_HOSTS = ["carrd.co", "pop.site"] as const;

const CONTACT_HOSTS = ["wa.me", "wa.link", "api.whatsapp.com"] as const;

function inList(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/* -------------------------------- types --------------------------------- */

export type SiteCandidate = {
  domain: string;
  score: number;
  evidence: string[];
};
/** @deprecated alias kept for one release; use SiteCandidate. */
export type InstagramCandidate = SiteCandidate;

export type ResolveSource = "social" | "biolink" | "maps" | "name";

export type UnusableReason = "contact_link" | "marketplace_home";

export type ClassifiedInput =
  | { kind: "url"; value: string }
  | { kind: "social"; platform: string; handle?: string; value: string }
  | { kind: "biolink"; platform: string; handle?: string; value: string }
  | { kind: "marketplace"; platform: string; value: string }
  | { kind: "maps"; value: string; name?: string }
  | { kind: "name"; value: string }
  | { kind: "text"; value: string }
  | { kind: "unusable"; reason: UnusableReason; value: string };

export type ResolveDeps = {
  credentials?: ExaCredentials;
  guard?: CostGuard;
  exaSearch?: typeof exaSearch;
  exaPost?: typeof exaPost;
  /** Country name (e.g. "Singapore") from the browser locale. A soft ranking hint, never a filter. */
  countryHint?: string;
};

/** Region subtag (upper case) to country name, plus the TLDs that signal that country. Unknown region: no hint. */
export const COUNTRY_TABLE: Record<string, { name: string; tlds: string[] }> = {
  SG: { name: "Singapore", tlds: [".sg", ".com.sg"] },
  MY: { name: "Malaysia", tlds: [".my", ".com.my"] },
  ID: { name: "Indonesia", tlds: [".id", ".co.id"] },
  PH: { name: "Philippines", tlds: [".ph", ".com.ph"] },
  TH: { name: "Thailand", tlds: [".th", ".co.th"] },
  VN: { name: "Vietnam", tlds: [".vn", ".com.vn"] },
  HK: { name: "Hong Kong", tlds: [".hk", ".com.hk"] },
  AU: { name: "Australia", tlds: [".au", ".com.au"] },
  NZ: { name: "New Zealand", tlds: [".nz", ".co.nz"] },
  IN: { name: "India", tlds: [".in", ".co.in"] },
  GB: { name: "United Kingdom", tlds: [".uk", ".co.uk"] },
  US: { name: "United States", tlds: [".us"] },
  CA: { name: "Canada", tlds: [".ca"] },
  JP: { name: "Japan", tlds: [".jp", ".co.jp"] },
  KR: { name: "South Korea", tlds: [".kr", ".co.kr"] },
  TW: { name: "Taiwan", tlds: [".tw", ".com.tw"] },
  CN: { name: "China", tlds: [".cn", ".com.cn"] },
  AE: { name: "United Arab Emirates", tlds: [".ae"] },
  DE: { name: "Germany", tlds: [".de"] },
  FR: { name: "France", tlds: [".fr"] },
};

/** "en-SG" / "en_sg" / "zh-Hans-SG" to "Singapore"; undefined for no region or an unknown one. */
export function countryFromLocale(locale: string | null | undefined): string | undefined {
  return regionEntry(locale)?.name;
}

function regionEntry(locale: string | null | undefined) {
  if (!locale) return undefined;
  const region = locale.split(/[-_]/).slice(1).find((t) => /^[A-Za-z]{2}$/.test(t));
  return region ? COUNTRY_TABLE[region.toUpperCase()] : undefined;
}

export type ResolveResult = {
  source: ResolveSource;
  /** social platform ("facebook") or bio-link host ("linktr.ee"); absent for maps and name. */
  platform?: string;
  candidates: SiteCandidate[];
  /** No usable name or handle could be read from the input: ask the seller what the business is called. */
  askName?: boolean;
};

/* ------------------------------ classification --------------------------- */

const VERBS = new Set([
  "sell", "sells", "selling", "offer", "offers", "offering", "provide", "provides", "providing", "make", "makes",
  "build", "builds", "help", "helps", "run", "runs", "do", "does", "we", "our", "i", "my", "are", "is", "need",
  "want", "looking", "deliver", "delivers", "supply", "supplies", "manufacture", "manufactures", "operate",
  "operates", "serve", "serves", "specialise", "specialize", "specialises", "specializes", "create", "creates",
  "design", "designs", "teach", "teaches", "repair", "repairs", "install", "installs", "fix", "fixes",
]);
const CONNECTORS = new Set(["&", "and", "of", "the", "de", "la", "van", "von", "for", "by", "pte", "ltd", "co", "sdn", "bhd"]);
const CORP_SUFFIX = /\b(ltd|pte|inc|llc|gmbh|co|corp|plc|sdn bhd|pty)\.?,?$/i;

export function classifyInput(raw: string, opts: { asName?: boolean } = {}): ClassifiedInput {
  const value = raw.trim();
  if (opts.asName) return { kind: "name", value };

  // contact links, bare emails, phone numbers
  if (/^(mailto|tel|sms):/i.test(value)) return { kind: "unusable", reason: "contact_link", value };
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(value)) return { kind: "unusable", reason: "contact_link", value };
  if (/^\+?[\d\s().-]{7,}$/.test(value) && (value.match(/\d/g) ?? []).length >= 7) return { kind: "unusable", reason: "contact_link", value };

  if (/^@[\w.]+$/.test(value)) return { kind: "social", platform: "instagram", handle: value.slice(1), value };

  const looksLikeUrl = /^https?:\/\//i.test(value) || (!/\s/.test(value) && value.includes("."));
  if (looksLikeUrl) {
    const url = parseUrl(value);
    if (url && url.hostname.includes(".")) return classifyUrl(value, url);
  }
  if (isBareCompanyName(value)) return { kind: "name", value };
  return { kind: "text", value };
}

function classifyUrl(value: string, url: URL): ClassifiedInput {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segs = url.pathname.split("/").filter(Boolean).map(safeDecode);

  if (inList(host, CONTACT_HOSTS)) return { kind: "unusable", reason: "contact_link", value };
  if (inList(host, SOCIAL_HOSTS)) {
    const platform = socialPlatform(host);
    return { kind: "social", platform, handle: socialHandle(platform, segs), value };
  }
  if (inList(host, BIOLINK_HOSTS)) {
    return { kind: "biolink", platform: baseHost(host, BIOLINK_HOSTS), handle: segs[0]?.replace(/^@/, ""), value };
  }
  if (isMapsUrl(host, url)) return { kind: "maps", value, name: mapsName(host, url, segs) };
  if (inList(host, MARKETPLACE_HOSTS) || host.endsWith(`.${SHOPIFY_STOREFRONT_HOST}`)) {
    if (segs.length === 0 && !host.endsWith(`.${SHOPIFY_STOREFRONT_HOST}`)) {
      return { kind: "unusable", reason: "marketplace_home", value };
    }
    return { kind: "marketplace", platform: marketplacePlatform(host), value };
  }
  return { kind: "url", value };
}

function isBareCompanyName(value: string): boolean {
  if (!value || /[/@:?#]/.test(value) || /^[a-z]/.test(value[0] ?? "")) return false;
  const words = value.split(/\s+/);
  if (words.length > 6) return false;
  if (words.some((w) => VERBS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return false;
  const suffixed = CORP_SUFFIX.test(value);
  const titleCase = words.every((w) => CONNECTORS.has(w.toLowerCase()) || /^[A-Z0-9][\w&'’.-]*,?$/.test(w));
  if (!titleCase && !suffixed) return false;
  // a sentence ends in a full stop; a company name only does so after Inc./Ltd./Co.
  if (/[.!?]$/.test(value) && !suffixed) return false;
  return true;
}

function socialPlatform(host: string): string {
  const map: Record<string, string> = {
    "instagram.com": "instagram", "facebook.com": "facebook", "fb.com": "facebook", "fb.me": "facebook",
    "tiktok.com": "tiktok", "x.com": "x", "twitter.com": "x", "t.co": "x", "youtube.com": "youtube",
    "youtu.be": "youtube", "linkedin.com": "linkedin", "threads.net": "threads", "threads.com": "threads",
  };
  const base = SOCIAL_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? host;
  return map[base] ?? base.split(".")[0] ?? base;
}

const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "accounts", "stories", "tv", "direct"]);
const FB_RESERVED = new Set(["profile.php", "sharer", "sharer.php", "share", "watch", "groups", "events", "marketplace", "photo", "photos", "reel", "story.php", "permalink.php", "login", "dialog", "plugins", "hashtag", "gaming"]);
const X_RESERVED = new Set(["home", "i", "intent", "share", "search", "hashtag", "explore", "settings", "messages", "notifications"]);

function socialHandle(platform: string, segs: string[]): string | undefined {
  const first = segs[0];
  const strip = (s: string | undefined) => (s ? s.replace(/^@/, "") : undefined) || undefined;
  switch (platform) {
    case "instagram":
      return first && !IG_RESERVED.has(first.toLowerCase()) ? strip(first) : undefined;
    case "facebook":
      if (first === "pages" || first === "people") return slugName(segs[1]);
      if (first === "p") return slugName(segs[1]?.replace(/-\d+$/, ""));
      return first && !FB_RESERVED.has(first.toLowerCase()) ? first : undefined;
    case "tiktok":
    case "threads":
      return first?.startsWith("@") ? strip(first) : undefined;
    case "x":
      return first && !X_RESERVED.has(first.toLowerCase()) ? first : undefined;
    case "youtube":
      if (first?.startsWith("@")) return strip(first);
      if ((first === "c" || first === "user") && segs[1]) return segs[1];
      return undefined;
    case "linkedin":
      return ["company", "school", "showcase", "in"].includes(first ?? "") ? segs[1] : undefined;
    default:
      return strip(first);
  }
}

function slugName(s: string | undefined): string | undefined {
  const out = s?.replace(/[+_-]+/g, " ").trim();
  return out || undefined;
}

function marketplacePlatform(host: string): string {
  if (host.endsWith(`.${SHOPIFY_STOREFRONT_HOST}`)) return "shopify";
  const base = MARKETPLACE_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? host;
  return base.split(".")[0] ?? base;
}

function baseHost(host: string, list: readonly string[]): string {
  return list.find((h) => host === h || host.endsWith(`.${h}`)) ?? host;
}

/** A site-builder page (acme.carrd.co, acme.pop.site): the seller's own site, profiled with the full URL. */
export function isSiteBuilderPage(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return SITE_BUILDER_HOSTS.some((h) => host.endsWith(`.${h}`));
}

/* ---------------------------------- maps ---------------------------------- */

function isMapsUrl(host: string, url: URL): boolean {
  if (inList(host, MAPS_HOSTS)) {
    // goo.gl is also a generic shortener; only its /maps links are map links
    return host !== "goo.gl" || url.pathname.startsWith("/maps");
  }
  return /^google\.[a-z.]+$/.test(host) && url.pathname.startsWith("/maps");
}

function mapsName(host: string, url: URL, segs: string[]): string | undefined {
  const clean = (s: string | undefined) => {
    const out = s?.replace(/[+_]+/g, " ").replace(/\s+/g, " ").trim();
    return out && !/^[\d\s.,@-]+$/.test(out) ? out : undefined;
  };
  if (host === "g.page") {
    const slug = segs[0] === "r" ? undefined : segs[0];
    return clean(slug?.replace(/-/g, " "));
  }
  if (host.startsWith("yelp.") || host.includes(".yelp.")) {
    const i = segs.indexOf("biz");
    return clean(segs[i + 1]?.replace(/-\d+$/, "").replace(/-/g, " "));
  }
  if (host.startsWith("tripadvisor.") || host.includes(".tripadvisor.")) {
    const m = (segs.at(-1) ?? "").match(/-Reviews-([^.]+)\.html$/i);
    const name = m?.[1]?.split("-")[0];
    return clean(name);
  }
  const q = url.searchParams.get("q") ?? url.searchParams.get("query");
  if (q) return clean(q);
  const place = segs.indexOf("place");
  if (place >= 0) return clean(segs[place + 1]);
  const search = segs.indexOf("search");
  if (search >= 0) return clean(segs[search + 1]);
  return undefined;
}

/* -------------------------------- resolving ------------------------------- */

export async function resolveToSite(input: ClassifiedInput, deps: ResolveDeps = {}): Promise<ResolveResult> {
  switch (input.kind) {
    case "social": {
      if (!input.handle) return { source: "social", platform: input.platform, candidates: [], askName: true };
      return { source: "social", platform: input.platform, candidates: await searchCandidates(socialQuery(input.platform, input.handle), input.handle, deps) };
    }
    case "biolink": {
      const fromPage = await bioLinkCandidates(input.value, input.handle, deps);
      if (fromPage.length > 0) return { source: "biolink", platform: input.platform, candidates: fromPage };
      if (!input.handle) return { source: "biolink", platform: input.platform, candidates: [], askName: true };
      return {
        source: "biolink",
        platform: input.platform,
        candidates: await searchCandidates(`${input.platform}/${input.handle} official website`, input.handle, deps),
      };
    }
    case "maps": {
      if (!input.name) return { source: "maps", candidates: [], askName: true };
      return { source: "maps", candidates: await searchCandidates(`${input.name} official website`, input.name, deps) };
    }
    case "name":
      return { source: "name", candidates: await searchCandidates(`${input.value} official website`, input.value, deps) };
    default:
      throw new Error(`resolveToSite: "${input.kind}" input is profiled directly, not resolved`);
  }
}

function socialQuery(platform: string, handle: string): string {
  const spaced = /\s/.test(handle);
  const path: Record<string, string> = {
    instagram: `instagram.com/${handle}`,
    facebook: `facebook.com/${handle}`,
    tiktok: `tiktok.com/@${handle}`,
    x: `x.com/${handle}`,
    youtube: `youtube.com/@${handle}`,
    linkedin: `linkedin.com/company/${handle}`,
    threads: `threads.net/@${handle}`,
  };
  return `${spaced || !path[platform] ? `${platform} ${handle}` : path[platform]} official website`;
}

/** Candidates shown to the seller. */
export const MAX_CANDIDATES = 3;
/** Raw results requested: social/marketplace/maps hosts are filtered out, so ask for more than we show. */
const SEARCH_RESULTS = 10;

async function searchCandidates(query: string, needleSource: string, deps: ResolveDeps): Promise<SiteCandidate[]> {
  const search = deps.exaSearch ?? exaSearch;
  const country = deps.countryHint?.trim() || undefined;
  const q = country ? `${query} ${country}` : query;
  const response = await search({ query: q, numResults: SEARCH_RESULTS }, deps.credentials, deps.guard);
  const byDomain = new Map<string, SiteCandidate>();
  const mentions = new Set<string>();
  for (const result of (response.results ?? []).slice(0, SEARCH_RESULTS)) {
    const url = typeof result.url === "string" ? result.url : undefined;
    if (!url) continue;
    const domain = acceptableDomain(url);
    if (!domain) continue;
    const existing = byDomain.get(domain) ?? { domain, score: 0, evidence: [] };
    existing.score += 1;
    existing.evidence.push(url);
    byDomain.set(domain, existing);
    if (country && mentionsCountry(result, country)) mentions.add(domain);
  }
  for (const domain of mentions) byDomain.get(domain)!.score += 1;
  return rank(byDomain, needleSource, country);
}

function mentionsCountry(result: { title?: unknown; text?: unknown; highlights?: unknown; summary?: unknown }, country: string): boolean {
  const parts = [result.title, result.text, typeof result.summary === "string" ? result.summary : undefined];
  if (Array.isArray(result.highlights)) parts.push(...result.highlights);
  const hay = parts.filter((p): p is string => typeof p === "string").join(" ").toLowerCase();
  return hay.includes(country.toLowerCase());
}

function tldMatches(domain: string, country: string): boolean {
  const entry = Object.values(COUNTRY_TABLE).find((c) => c.name === country);
  return !!entry && entry.tlds.some((t) => domain.endsWith(t));
}

/** Ranking: +2 for a 4-character name overlap, +1 for a country-TLD match, +1 per result that mentions the country. Never filters. */
function rank(byDomain: Map<string, SiteCandidate>, needleSource: string, country?: string): SiteCandidate[] {
  const needle = needleSource.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const candidate of byDomain.values()) {
    if (hasFourCharOverlap(candidate.domain.replace(/[^a-z0-9]/g, ""), needle)) candidate.score += 2;
    if (country && tldMatches(candidate.domain, country)) candidate.score += 1;
  }
  return [...byDomain.values()]
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
    .slice(0, MAX_CANDIDATES);
}

async function bioLinkCandidates(url: string, handle: string | undefined, deps: ResolveDeps): Promise<SiteCandidate[]> {
  const post = deps.exaPost ?? exaPost;
  const target = parseUrl(url)?.toString() ?? url;
  const response = await post(
    "/contents",
    { urls: [target], text: { maxCharacters: 20000 }, livecrawl: "fallback" },
    deps.credentials,
    deps.guard,
  );
  const first = (response.results ?? [])[0] as { text?: unknown } | undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  const byDomain = new Map<string, SiteCandidate>();
  let order = 0;
  for (const link of text.match(/https?:\/\/[^\s)"'<>\]\\]+/gi) ?? []) {
    const domain = acceptableDomain(link.replace(/[.,;]+$/, ""));
    if (!domain || byDomain.has(domain)) continue;
    // first link wins: earlier on the page scores higher
    byDomain.set(domain, { domain, score: Math.max(1, 3 - order), evidence: [link] });
    order += 1;
    if (byDomain.size >= 3) break;
  }
  return rank(byDomain, handle ?? "", deps.countryHint?.trim() || undefined);
}

/** Registrable-ish domain of a result URL, or undefined when it is a social/marketplace/maps/bio-link page. */
function acceptableDomain(url: string): string | undefined {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return undefined;
  if (inList(host, SOCIAL_HOSTS) || inList(host, MARKETPLACE_HOSTS) || inList(host, MAPS_HOSTS) || inList(host, BIOLINK_HOSTS)) return undefined;
  if (/^google\.[a-z.]+$/.test(host) && parsed.pathname.startsWith("/maps")) return undefined;
  return host;
}

/* --------------------------------- helpers -------------------------------- */

export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hasFourCharOverlap(domain: string, handle: string): boolean {
  if (handle.length < 4) return false;
  for (let i = 0; i <= handle.length - 4; i += 1) {
    if (domain.includes(handle.slice(i, i + 4))) return true;
  }
  return false;
}
