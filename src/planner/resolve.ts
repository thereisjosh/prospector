import { CostGuard, exaSearch, type ExaCredentials } from "../exa";

export type ClassifiedInput =
  | { kind: "url"; value: string }
  | { kind: "instagram"; value: string }
  | { kind: "text"; value: string };

export type InstagramCandidate = {
  domain: string;
  score: number;
  evidence: string[];
};

export type ResolveDeps = {
  credentials?: ExaCredentials;
  guard?: CostGuard;
  exaSearch?: typeof exaSearch;
};

const SOCIAL_HOSTS = new Set([
  "instagram.com",
  "facebook.com",
  "linktr.ee",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "linkedin.com",
]);

export function classifyInput(raw: string): ClassifiedInput {
  const value = raw.trim();
  const instagram = instagramHandle(value);
  if (instagram) return { kind: "instagram", value: instagram };
  if (/^https?:\/\//i.test(value) || (!/\s/.test(value) && value.includes("."))) {
    return { kind: "url", value };
  }
  return { kind: "text", value };
}

export async function resolveInstagram(handle: string, deps: ResolveDeps = {}) {
  const cleanHandle = handle.replace(/^@/, "").replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "").split(/[/?#]/)[0] ?? "";
  const search = deps.exaSearch ?? exaSearch;
  const response = await search(
    { query: `instagram.com/${cleanHandle} official website`, numResults: 5 },
    deps.credentials,
    deps.guard,
  );
  const byDomain = new Map<string, InstagramCandidate>();
  for (const result of response.results ?? []) {
    const url = typeof result.url === "string" ? result.url : undefined;
    if (!url) continue;
    const domain = domainFromUrl(url);
    if (!domain || isSocialDomain(domain)) continue;
    const existing = byDomain.get(domain) ?? { domain, score: 0, evidence: [] };
    existing.score += 1;
    existing.evidence.push(url);
    byDomain.set(domain, existing);
  }

  const matchNeedle = cleanHandle.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const candidate of byDomain.values()) {
    if (hasFourCharOverlap(candidate.domain.replace(/[^a-z0-9]/g, ""), matchNeedle)) {
      candidate.score += 2;
    }
  }

  return {
    candidates: [...byDomain.values()].sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain)),
  };
}

function instagramHandle(value: string): string | undefined {
  if (value.startsWith("@")) return value.slice(1).trim();
  const match = value.match(/(?:^|https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i);
  return match?.[1];
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function isSocialDomain(domain: string): boolean {
  return [...SOCIAL_HOSTS].some((host) => domain === host || domain.endsWith(`.${host}`));
}

function hasFourCharOverlap(domain: string, handle: string): boolean {
  if (handle.length < 4) return false;
  for (let i = 0; i <= handle.length - 4; i += 1) {
    if (domain.includes(handle.slice(i, i + 4))) return true;
  }
  return false;
}
