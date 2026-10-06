import { describe, expect, it } from "vitest";
import { fetchPublicText, isPublicAddress } from "./safe-fetch";

const publicHost = async () => ["93.184.216.34"];

describe("which addresses web_fetch may reach", () => {
  it("allows public addresses and refuses private, local and reserved ones", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1", "100.128.0.1",
      "2002:0808:0808::", "::ffff:0808:0808", "64:ff9b::0808:0808", "64:ff9b::8.8.8.8"]) expect(isPublicAddress(address), address).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "[::1]", "fe80::1%eth0", "not-an-ip",
      // A trailing dot is not an address: without the empty-segment check it reads as .0, public.
      "1.2.3.",
      // Transition mechanisms route to the embedded IPv4 address, so the wrapper never
      // launders a private one: hex-mapped, 6to4, NAT64, Teredo, documentation, discard,
      // benchmarking ranges, and the deprecated compatible form all fail closed.
      "::ffff:0a00:0001", "2002:0a00:0001::", "64:ff9b::0a00:0001", "64:ff9b::10.0.0.1",
      "2001::1", "2001:db8::1", "100::1", "2001:2::8", "::10.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("fetching model-chosen urls", () => {
  it("checks every redirect hop, so a public page cannot bounce the request inward", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return url.startsWith("https://docs.test") ? new Response(null, { status: 302, headers: { location: "http://intranet.test/secret" } }) : new Response("secret");
    }) as unknown as typeof fetch;
    const result = await fetchPublicText("https://docs.test/page", { fetchImpl, resolveHost: async (host) => (host === "intranet.test" ? ["192.168.0.10"] : ["93.184.216.34"]) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("intranet.test resolves to a private") });
    expect(seen).toEqual(["https://docs.test/page"]);
  });

  it("follows public redirects, caps the body, and refuses credentials and bad schemes", async () => {
    const fetchImpl = (async (url: string) => url.endsWith("/old")
      ? new Response(null, { status: 301, headers: { location: "/new" } })
      : new Response("x".repeat(5000))) as unknown as typeof fetch;
    const result = await fetchPublicText("https://site.test/old", { fetchImpl, resolveHost: publicHost, maxBytes: 1000 });
    expect(result).toEqual({ ok: true, url: "https://site.test/new", status: 200, text: "x".repeat(1000), truncated: true });
    expect(await fetchPublicText("https://user:pw@site.test/", { fetchImpl, resolveHost: publicHost })).toMatchObject({ ok: false, error: expect.stringContaining("credentials") });
    expect(await fetchPublicText("ftp://site.test/", { fetchImpl, resolveHost: publicHost })).toMatchObject({ ok: false });
    const loop = (async () => new Response(null, { status: 302, headers: { location: "/again" } })) as unknown as typeof fetch;
    expect(await fetchPublicText("https://site.test/", { fetchImpl: loop, resolveHost: publicHost })).toEqual({ ok: false, error: "too many redirects" });
  });

  it("allows private destinations only when explicitly permitted", async () => {
    const fetchImpl = (async () => new Response("local docs")) as unknown as typeof fetch;
    expect(await fetchPublicText("http://localhost:3000/docs", { fetchImpl, resolveHost: async () => ["127.0.0.1"] })).toMatchObject({ ok: false });
    expect(await fetchPublicText("http://localhost:3000/docs", { fetchImpl, allowPrivate: true })).toMatchObject({ ok: true, text: "local docs" });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("héllo wörld");
    const split = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.enqueue(bytes.subarray(3));
        controller.close();
      },
    }));
    const fetchImpl = (async () => split) as unknown as typeof fetch;
    const result = await fetchPublicText("https://site.test/page", { fetchImpl, resolveHost: publicHost });
    // The split falls inside "é": a boundary-unaware decode yields h\ufffdllo.
    expect(result).toMatchObject({ ok: true, text: "héllo wörld", truncated: false });
  });
});
