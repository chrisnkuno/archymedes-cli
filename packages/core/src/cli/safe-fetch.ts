/**
 * Fetching a URL the model chose, without letting it reach this machine's own network.
 *
 * `web_fetch` takes a URL from model output, and model output can be steered by any page or file the
 * agent has read. Unchecked, that is a request to `http://localhost:8080/admin`, a router on
 * `192.168.1.1`, or a cloud metadata service on `169.254.169.254` — with the response handed back
 * to the model. So the destination must be a public address: the hostname is resolved and every
 * address checked, redirects are followed by hand so each hop is checked again, and the body is
 * read up to a byte cap instead of whole.
 *
 * DNS can still change between the check and the connection (rebinding); closing that needs a
 * connection-level hook this runtime does not expose. The check blocks the direct and redirect
 * routes, which are the ones a prompt injection can take by writing a URL.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolveHost = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Parts(ip: string): number[] | undefined {
  const segments = ip.split(".");
  // Empty segments must fail, not read as zero: without this "1.2.3." parses as a
  // public 1.2.3.0, and a trailing-dot literal is not an address at all.
  if (segments.length !== 4 || segments.some((segment) => segment.length === 0)) return undefined;
  const parts = segments.map(Number);
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

/**
 * Expands any IPv6 literal to eight hextet numbers, or undefined when malformed.
 *
 * A dotted-quad tail (the mapped `::ffff:1.2.3.4` and NAT64 forms) stands for the
 * last two hextets. It is rewritten to hex *before* the "::" split, so the split
 * always sees one uniform literal — splitting first would eat the "::" whenever
 * the quad directly follows it, as in the NAT64 form `64:ff9b::8.8.8.8`.
 */
function expandIPv6(ip: string): number[] | undefined {
  const clean = ip.toLowerCase();
  let literal = clean;
  const dotAt = clean.lastIndexOf(".");
  if (dotAt !== -1) {
    const lastColon = clean.lastIndexOf(":", dotAt);
    if (lastColon === -1) return undefined;
    const quad = clean.slice(lastColon + 1).split(".");
    if (quad.length !== 4 || quad.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
    const [a, b, c, d] = quad.map(Number);
    // The quad attaches at a hextet boundary: head ends in the plain colon that
    // separated it, or in the first colon of a "::" — appending ":h:h" restores
    // the right separator in both cases.
    literal = `${clean.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = literal.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const out: number[] = [];
    for (const group of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!left || !right) return undefined;
  const full = [...left, ...right];
  // Without "::" all eight must be present; with it, at least one group is
  // compressed away, so fewer than eight may remain.
  if (halves.length === 1 ? full.length !== 8 : full.length >= 8) return undefined;
  // The "::" gap fills in the middle: left, then zeros, then everything after it —
  // so "::1" is seven zeros followed by one, not the other way around.
  return [...left, ...new Array(8 - full.length).fill(0), ...right];
}

/** Reads an embedded IPv4 address out of two hextets, for transition mechanisms. */
function embeddedIPv4(high: number, low: number): string {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

/** False for loopback, private, link-local, transition, multicast, reserved and unspecified addresses. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && v4[2] === 0)
      || (a === 198 && (b === 18 || b === 19)));
  }
  const groups = expandIPv6(ip);
  if (!groups) return false;
  // Transition mechanisms carry a real IPv4 address inside the IPv6 one, and the inner
  // address is what gets routed to. Judge the inner address, not the wrapper.
  // v4-mapped ::ffff:0:0/96, in hex as well as dotted form.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isPublicAddress(embeddedIPv4(groups[6], groups[7]));
  }
  // 6to4 2002::/16 embeds the destination in hextets one and two.
  if (groups[0] === 0x2002) return isPublicAddress(embeddedIPv4(groups[1], groups[2]));
  // NAT64 well-known prefix 64:ff9b::/96 embeds it in the last 32 bits.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isPublicAddress(embeddedIPv4(groups[6], groups[7]));
  }
  // Everything else in ::/8 routes nowhere public: unspecified, loopback, the
  // deprecated v4-compatible form (::10.0.0.1 — its inner address would have
  // to be judged, but the form has been deprecated since 2006 and an
  // allowlist that cannot trust a parse must refuse it), and the reserved
  // remainder. Mapped above is the only ::/8 form that can carry a public
  // destination, and it has already been decided.
  if (groups[0] === 0) return false;
  // No inner address to judge, and none of these route publicly anyway: Teredo
  // 2001::/32 (client bits obfuscated), documentation 2001:db8::/32,
  // benchmarking 2001:2::/48, discard 100::/64.
  if (groups[0] === 0x2001 && groups[1] === 0x0) return false;
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x2) return false;
  if (groups[0] === 0x100 && groups[1] === 0x0 && groups[2] === 0x0 && groups[3] === 0x0) return false;
  const first = groups[0];
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00);
}

export type SafeFetchOptions = {
  fetchImpl?: typeof fetch;
  resolveHost?: ResolveHost;
  /** `ARCHYMEDES_WEB_FETCH_ALLOW_PRIVATE=1`: for someone deliberately reading local documentation. */
  allowPrivate?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type SafeFetchResult =
  | { ok: true; url: string; status: number; text: string; truncated: boolean }
  | { ok: false; error: string };

/** Why a URL must not be fetched, or undefined when its destination is public. */
export async function checkDestination(url: URL, options: SafeFetchOptions): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http or https";
  if (url.username || url.password) return "urls with credentials are not fetched";
  if (options.allowPrivate) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (options.resolveHost ?? defaultResolveHost)(host);
  } catch {
    return `could not resolve ${host}`;
  }
  if (addresses.length === 0) return `could not resolve ${host}`;
  const blocked = addresses.find((address) => !isPublicAddress(address));
  return blocked ? `${host} resolves to a private or local address (${blocked}); only public addresses are fetched` : undefined;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  // Decoded streaming: a multi-byte character split across two chunks must not become a
  // replacement character at the boundary. The byte cap still counts bytes, not characters.
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const room = maxBytes - size;
      if (next.value.byteLength > room) {
        text += decoder.decode(next.value.subarray(0, room), { stream: true });
        truncated = true;
        break;
      }
      text += decoder.decode(next.value, { stream: true });
      size += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: text + decoder.decode(), truncated };
}

export async function fetchPublicText(input: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let url: URL;
  try { url = new URL(input); } catch { return { ok: false, error: "url is not valid" }; }
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    const problem = await checkDestination(url, options);
    if (problem) return { ok: false, error: problem };
    const response = await fetchImpl(url.href, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      try { url = new URL(location, url); } catch { return { ok: false, error: "redirect to an invalid url" }; }
      continue;
    }
    const { text, truncated } = await readCapped(response, options.maxBytes ?? 2 * 1024 * 1024);
    return { ok: true, url: url.href, status: response.status, text, truncated };
  }
  return { ok: false, error: "too many redirects" };
}
