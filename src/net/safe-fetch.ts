/**
 * safeFetch: the only way server-side code may fetch a URL that came from model output or a third-party
 * page (SSRF guard). The caller never sees a response from a loopback, private, link-local, metadata or
 * otherwise non-public address.
 *
 * What it enforces:
 *   - http/https only; no credentials in the URL; default port only unless `allowedPorts` lists it.
 *   - the hostname is resolved (dns.lookup, all addresses) and the request is refused if ANY address is
 *     non-public (loopback, RFC1918, CGNAT 100.64/10, link-local incl. 169.254.169.254, 0/8, multicast,
 *     reserved, benchmarking/doc ranges; v6: ::1, ::, fc00::/7, fe80::/10, ff00::/8, and v4-in-v6 forms
 *     ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96, 2002::/16, whose embedded v4 is checked the same way).
 *     IP-literal hosts (incl. decimal/hex/octal forms, which WHATWG URL normalises) are classified directly.
 *   - redirects are followed manually, at most 3 hops, and every Location is re-validated the same way;
 *     a redirect to a non-http(s) scheme is refused. Auth headers are dropped on a cross-origin hop.
 *   - one 10 s deadline for the whole call (all hops and the body read), a 2 MB body cap enforced while
 *     streaming, and a content-type allowlist (text/html, text/plain, application/xhtml+xml).
 *
 * TOCTOU / DNS rebinding: with the default transport the validated address is pinned. The connection is
 * made with node:http(s) and a `lookup` that returns only the addresses already validated, so a second
 * DNS answer between check and connect cannot redirect the socket (TLS SNI/cert checks still use the
 * hostname). No new dependency: `undici` is only a transitive dependency, so it is not imported.
 * Residual risk: when a test or caller injects `fetchImpl`, that transport is not pinned (the
 * pre-connect check still runs); in production never inject one for untrusted URLs. Egress firewalling
 * to the metadata endpoint remains the defence in depth for a compromised resolver.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export const SAFE_FETCH_TIMEOUT_MS = 10_000;
export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_MAX_HOPS = 3;
export const SAFE_FETCH_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

export type SafeFetchReason =
  | "invalid_url"
  | "blocked_scheme"
  | "blocked_credentials"
  | "blocked_port"
  | "blocked_address"
  | "bad_method"
  | "dns_failed"
  | "too_many_redirects"
  | "bad_redirect"
  | "timeout"
  | "too_large"
  | "bad_content_type"
  | "network";

export class SafeFetchError extends Error {
  constructor(readonly reason: SafeFetchReason, readonly url: string, detail?: string) {
    super(`safeFetch ${reason}: ${url}${detail ? ` (${detail})` : ""}`);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchResult = { ok: boolean; status: number; url: string; text: string; bytes: number; hops: number };

export type ResolvedAddress = { address: string; family: number };

export type SafeFetchOptions = {
  /** Test seam / override; NOT address-pinned (see header). Default: pinned node:http(s) transport. */
  fetchImpl?: typeof fetch;
  /** Test seam. Default dns.promises.lookup(host, { all: true }). */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxHops?: number;
  /** Non-default ports that may be used (e.g. [8443]). */
  allowedPorts?: number[];
  /** Lowercase media types accepted for a 2xx body; `null` disables the check. */
  allowedContentTypes?: string[] | null;
};

// ---------- address classification ----------

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function blockedV4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** 8 x 16-bit groups, or null when not a valid IPv6 text form. Handles `::` and a trailing dotted v4. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = s.slice(s.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    s = `${s.slice(0, s.lastIndexOf(":") + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function blockedV6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return blockedV4(v4From(g6, g7)); // ::ffff:v4 and ::v4
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedV4(v4From(g6, g7)); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // local-use NAT64
  if (g0 === 0x2002) return blockedV4(v4From(g1, g2)); // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when `address` is anything other than a public unicast address. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind === 4) {
    const p = parseV4(bare);
    return p ? blockedV4(p) : true;
  }
  if (kind === 6) {
    const g = parseV6(bare);
    return g ? blockedV6(g) : true;
  }
  return true;
}

// ---------- URL validation ----------

const BLOCKED_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

async function resolve(host: string, lookup: NonNullable<SafeFetchOptions["lookup"]>, url: string): Promise<ResolvedAddress[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind) {
    if (isBlockedAddress(bare)) throw new SafeFetchError("blocked_address", url, bare);
    return [{ address: bare, family: kind }];
  }
  if (BLOCKED_NAME.test(bare.toLowerCase().replace(/\.$/, ""))) throw new SafeFetchError("blocked_address", url, "reserved name");
  let addrs: ResolvedAddress[];
  try {
    addrs = await lookup(bare);
  } catch (error) {
    throw new SafeFetchError("dns_failed", url, error instanceof Error ? error.message : undefined);
  }
  if (addrs.length === 0) throw new SafeFetchError("dns_failed", url, "no addresses");
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new SafeFetchError("blocked_address", url, bad.address);
  return addrs;
}

async function validate(raw: string, opts: Required<Pick<SafeFetchOptions, "lookup" | "allowedPorts">>, kind: "invalid_url" | "bad_redirect"): Promise<{ url: URL; addrs: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError(kind, raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError(kind === "bad_redirect" ? "bad_redirect" : "blocked_scheme", raw, url.protocol);
  if (url.username || url.password) throw new SafeFetchError("blocked_credentials", raw);
  if (url.port !== "" && !opts.allowedPorts.includes(Number(url.port))) throw new SafeFetchError("blocked_port", raw, url.port);
  return { url, addrs: await resolve(url.hostname, opts.lookup, raw) };
}

// ---------- pinned transport ----------

const NULL_BODY = new Set([101, 204, 205, 304]);

/** node:http(s) request whose socket can only connect to `addrs` (already validated). */
function pinnedFetch(rawUrl: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }, addrs: ResolvedAddress[]): Promise<Response> {
  const url = new URL(rawUrl);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolveResponse, reject) => {
    const req = mod.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        lookup: ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (options?.all) cb(null, addrs);
          else cb(null, addrs[0]!.address, addrs[0]!.family);
        }) as never,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, item);
        const status = res.statusCode ?? 0;
        const body = init.method === "HEAD" || NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        if (body === null) res.resume();
        resolveResponse(new Response(body, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------- safeFetch ----------

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export async function safeFetch(rawUrl: string, init: { method?: string; headers?: Record<string, string> } = {}, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const lookup = options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family })));
  const allowedPorts = options.allowedPorts ?? [];
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxHops = options.maxHops ?? SAFE_FETCH_MAX_HOPS;
  const types = options.allowedContentTypes === undefined ? SAFE_FETCH_CONTENT_TYPES : options.allowedContentTypes;
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new SafeFetchError("bad_method", rawUrl, method);
  const signal = AbortSignal.timeout(options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  let headers = { ...(init.headers ?? {}) };
  let current = rawUrl;
  try {
    for (let hops = 0; ; hops += 1) {
      const { url, addrs } = await validate(current, { lookup, allowedPorts }, hops === 0 ? "invalid_url" : "bad_redirect");
      const req = { method, headers, signal, redirect: "manual" as const };
      let res: Response;
      try {
        res = await Promise.race([options.fetchImpl ? options.fetchImpl(url.toString(), req) : pinnedFetch(url.toString(), req, addrs), abortPromise(signal)]);
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        if (signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) throw new SafeFetchError("timeout", current);
        throw new SafeFetchError("network", current, error instanceof Error ? error.message : undefined);
      }
      if (REDIRECT.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new SafeFetchError("bad_redirect", current, "no Location");
        if (hops >= maxHops) throw new SafeFetchError("too_many_redirects", current, `> ${maxHops}`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError("bad_redirect", current, location);
        }
        if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
        current = next.toString();
        continue;
      }
      if (!res.ok || method === "HEAD") {
        await res.body?.cancel().catch(() => undefined);
        return { ok: res.ok, status: res.status, url: current, text: "", bytes: 0, hops };
      }
      if (types !== null) {
        const media = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!types.includes(media)) {
          await res.body?.cancel().catch(() => undefined);
          throw new SafeFetchError("bad_content_type", current, media || "missing");
        }
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new SafeFetchError("too_large", current, `content-length ${declared}`);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), abortPromise(signal)]);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) throw new SafeFetchError("too_large", current, `> ${maxBytes} bytes`);
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
      return { ok: true, status: res.status, url: current, text, bytes, hops };
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new SafeFetchError("timeout", current);
    throw new SafeFetchError("network", current, error instanceof Error ? error.message : undefined);
  }
}
