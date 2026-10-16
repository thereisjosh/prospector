import { describe, expect, it, vi } from "vitest";
import { isBlockedAddress, safeFetch, SafeFetchError, type SafeFetchOptions } from "../src/net/safe-fetch";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const html = (body = "<p>hi</p>", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

function opts(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<SafeFetchOptions> = {}, dns: Record<string, string[]> = {}): SafeFetchOptions {
  return {
    fetchImpl: fetchImpl as never,
    lookup: async (host) => (dns[host] ? dns[host]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) : PUBLIC),
    ...extra,
  };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError);
    return (error as SafeFetchError).reason;
  }
  return "no_error";
}

describe("isBlockedAddress", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "127.255.255.254", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "not-an-ip",
  ];
  for (const a of blocked) it(`blocks ${a}`, () => expect(isBlockedAddress(a)).toBe(true));
  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"];
  for (const a of allowed) it(`allows ${a}`, () => expect(isBlockedAddress(a)).toBe(false));
});

describe("safeFetch URL checks", () => {
  const never = vi.fn(async () => html());
  it.each([
    ["ftp://a.example/x", "blocked_scheme"],
    ["file:///etc/passwd", "blocked_scheme"],
    ["https://user:pw@a.example/", "blocked_credentials"],
    ["https://a.example:8443/", "blocked_port"],
    ["not a url", "invalid_url"],
    ["http://127.0.0.1/admin", "blocked_address"],
    ["http://2130706433/", "blocked_address"],
    ["http://0x7f.1/", "blocked_address"],
    ["http://[::1]/", "blocked_address"],
    ["http://[::ffff:127.0.0.1]/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
    ["http://localhost/", "blocked_address"],
    ["http://svc.internal/", "blocked_address"],
  ])("%s -> %s", async (url, expected) => {
    expect(await reason(safeFetch(url, {}, opts(never as never)))).toBe(expected);
    expect(never).not.toHaveBeenCalled();
  });

  it("allows a listed non-default port", async () => {
    const res = await safeFetch("https://a.example:8443/", {}, opts((async () => html()) as never, { allowedPorts: [8443] }));
    expect(res.ok).toBe(true);
  });

  it("rejects a hostname when ANY resolved address is private (v4 and v6 forms)", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:192.168.0.1"]) {
      const fetchImpl = vi.fn(async () => html());
      const o = opts(fetchImpl as never, {}, { "rebind.example": ["93.184.216.34", bad] });
      expect(await reason(safeFetch("https://rebind.example/", {}, o))).toBe("blocked_address");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("reports dns failure", async () => {
    const o: SafeFetchOptions = { fetchImpl: vi.fn() as never, lookup: async () => { throw new Error("ENOTFOUND"); } };
    expect(await reason(safeFetch("https://nx.example/", {}, o))).toBe("dns_failed");
  });

  it("rejects non-GET/HEAD methods", async () => {
    expect(await reason(safeFetch("https://a.example/", { method: "POST" }, opts(never as never)))).toBe("bad_method");
  });
});

describe("safeFetch redirects", () => {
  it("follows a public redirect and reports hops and the final url", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: unknown) => (url === "https://a.example/" ? redirect("/next") : html("ok")));
    const res = await safeFetch("https://a.example/", {}, opts(fetchImpl as never));
    expect(res).toMatchObject({ ok: true, status: 200, url: "https://a.example/next", text: "ok", bytes: 2, hops: 1 });
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it.each(["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.1.2.3/x", "http://[::ffff:7f00:1]/"])("rejects a redirect to %s", async (target) => {
    const fetchImpl = vi.fn(async (url: string) => (url === "https://a.example/" ? redirect(target) : html("secret")));
    expect(await reason(safeFetch("https://a.example/", {}, opts(fetchImpl as never)))).toBe("blocked_address");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a hostname that resolves private", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url === "https://a.example/" ? redirect("https://evil.example/") : html()));
    const o = opts(fetchImpl as never, {}, { "evil.example": ["10.0.0.9"] });
    expect(await reason(safeFetch("https://a.example/", {}, o))).toBe("blocked_address");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a non-http scheme", async () => {
    const fetchImpl = vi.fn(async () => redirect("file:///etc/passwd"));
    expect(await reason(safeFetch("https://a.example/", {}, opts(fetchImpl as never)))).toBe("bad_redirect");
  });

  it("allows 3 hops and rejects the 4th", async () => {
    const chain = (n: number) => vi.fn(async (url: string) => {
      const i = Number(new URL(url).pathname.slice(1) || 0);
      return i < n ? redirect(`/${i + 1}`) : html("end");
    });
    expect((await safeFetch("https://a.example/", {}, opts(chain(3) as never))).hops).toBe(3);
    expect(await reason(safeFetch("https://a.example/", {}, opts(chain(4) as never)))).toBe("too_many_redirects");
  });

  it("drops credentials headers on a cross-origin hop", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return url === "https://a.example/" ? redirect("https://b.example/") : html();
    });
    await safeFetch("https://a.example/", { headers: { Authorization: "Bearer x", Accept: "text/html" } }, opts(fetchImpl as never));
    expect(seen[0]).toHaveProperty("Authorization");
    expect(seen[1]).not.toHaveProperty("Authorization");
    expect(seen[1]).toHaveProperty("Accept");
  });
});

describe("safeFetch limits", () => {
  it("rejects a body over the cap while streaming", async () => {
    const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)); } }), { status: 200, headers: { "content-type": "text/plain" } });
    expect(await reason(safeFetch("https://a.example/", {}, opts((async () => big) as never, { maxBytes: 1000 })))).toBe("too_large");
  });

  it("rejects an oversized content-length without reading", async () => {
    const fetchImpl = async () => html("x", { "content-length": "999999999" });
    expect(await reason(safeFetch("https://a.example/", {}, opts(fetchImpl as never)))).toBe("too_large");
  });

  it("accepts a body exactly at the cap", async () => {
    const res = await safeFetch("https://a.example/", {}, opts((async () => html("x".repeat(100))) as never, { maxBytes: 100 }));
    expect(res.bytes).toBe(100);
  });

  it("times out a hanging fetch", async () => {
    const fetchImpl = (_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await reason(safeFetch("https://a.example/", {}, opts(fetchImpl as never, { timeoutMs: 30 })))).toBe("timeout");
  });

  it("times out a body that stalls", async () => {
    const stalled = new Response(new ReadableStream({ pull() { return new Promise(() => undefined); } }), { status: 200, headers: { "content-type": "text/html" } });
    expect(await reason(safeFetch("https://a.example/", {}, opts((async () => stalled) as never, { timeoutMs: 30 })))).toBe("timeout");
  });

  it.each(["application/json", "image/png", "application/octet-stream", ""])("rejects content-type %j", async (type) => {
    const res = new Response(new Uint8Array([123, 125]), { status: 200, headers: type ? { "content-type": type } : {} });
    expect(await reason(safeFetch("https://a.example/", {}, opts((async () => res) as never)))).toBe("bad_content_type");
  });

  it.each(["text/html", "text/plain; charset=utf-8", "application/xhtml+xml"])("accepts content-type %s", async (type) => {
    const res = await safeFetch("https://a.example/", {}, opts((async () => new Response("ok", { status: 200, headers: { "content-type": type } })) as never));
    expect(res.text).toBe("ok");
  });

  it("returns ok:false with the status for an HTTP error", async () => {
    const res = await safeFetch("https://a.example/", {}, opts((async () => new Response("no", { status: 404 })) as never));
    expect(res).toMatchObject({ ok: false, status: 404, text: "" });
  });

  it("maps a thrown transport error to network", async () => {
    expect(await reason(safeFetch("https://a.example/", {}, opts((async () => { throw new TypeError("fetch failed"); }) as never)))).toBe("network");
  });
});
