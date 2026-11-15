export type KeyHealth = "ok" | "invalid" | "missing" | "unchecked";

type AnthropicProbe = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AnthropicCache = { value: KeyHealth; checkedAt: number } | undefined;

let anthropicCache: AnthropicCache;
let fetchImpl: AnthropicProbe | undefined;
let exaLast: { status: number; at: number } | undefined;
const TEN_MINUTES = 10 * 60_000;
const DAY = 24 * 60 * 60_000;

export function setAnthropicProbeForTests(probe?: AnthropicProbe): void {
  fetchImpl = probe;
  anthropicCache = undefined;
}

export function resetKeyHealthForTests(): void {
  anthropicCache = undefined;
  exaLast = undefined;
  fetchImpl = undefined;
}

export async function anthropicKeyHealth(now = Date.now(), env: Record<string, string | undefined> = process.env): Promise<KeyHealth> {
  if (!env.ANTHROPIC_API_KEY) return "missing";
  if (anthropicCache && now - anthropicCache.checkedAt < TEN_MINUTES) return anthropicCache.value;
  try {
    const response = await (fetchImpl ?? fetch)("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    const value: KeyHealth = response.status === 401 || response.status === 403 ? "invalid" : response.ok ? "ok" : "unchecked";
    anthropicCache = { value, checkedAt: now };
    return value;
  } catch {
    anthropicCache = { value: "unchecked", checkedAt: now };
    return "unchecked";
  }
}

export function noteExaResponse(status: number, now = Date.now()): void {
  exaLast = { status, at: now };
}

export function exaKeyHealth(now = Date.now(), env: Record<string, string | undefined> = process.env): KeyHealth {
  if (!env.EXA_API_KEY) return "missing";
  if (!exaLast || now - exaLast.at > DAY) return "unchecked";
  if (exaLast.status >= 200 && exaLast.status < 300) return "ok";
  return exaLast.status === 401 || exaLast.status === 402 || exaLast.status === 403 ? "invalid" : "unchecked";
}
