/**
 * Web search without Exa: Brave, Tavily or a SearXNG instance when one is configured, and with
 * nothing configured, DuckDuckGo's HTML page, falling back to Stack Overflow.
 *
 * `web_search` used to exist only with an Exa key, so most sessions had no way to look anything up.
 * Measured from a home connection on 2026-10-17: DuckDuckGo's HTML endpoint answers a form POST
 * with ten results, and starts answering 202 (a bot challenge, no results) after four or five
 * quick queries, for minutes; Mojeek, Brave's page, Qwant, Ecosia and Startpage refuse a script
 * outright. Stack Exchange's API answers without a key (300 a day per address). So the keyless path
 * is paced (one DuckDuckGo request at a time, spaced), cached (a model repeats itself), steps aside
 * while DuckDuckGo is limiting rather than waiting on it, and says so. The rule throughout: a
 * search that could not be done is reported as that, with what would fix it, never as "No results"
 * — which reads as an answer, and teaches the model to stop looking.
 */

export type WebSearchHit = { title: string; url: string; snippet: string; publishedDate?: string };

export type WebSearchQuery = {
  query: string;
  numResults: number;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
};

export type WebSearchResponse = {
  /** Which backend answered, as shown to the model: "DuckDuckGo", "Brave Search", … */
  provider: string;
  results: WebSearchHit[];
  /** Said with the results, e.g. that they are a fallback's. */
  note?: string;
};

export interface WebSearchBackend {
  readonly label: string;
  search(query: WebSearchQuery): Promise<WebSearchResponse>;
}

/** Search could not be done (not: it found nothing). `reason` is said to the model as is. */
export class WebSearchUnavailable extends Error {
  constructor(readonly reason: string, readonly retryAfterMs?: number) {
    super(reason);
    this.name = "WebSearchUnavailable";
  }
}

type FetchLike = typeof fetch;

const TIMEOUT_MS = 12_000;
/** A browser's, because DuckDuckGo's HTML page answers a script's own name with a challenge. */
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function request(fetchImpl: FetchLike, url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new WebSearchUnavailable(timedOut ? `${label} did not answer within ${TIMEOUT_MS / 1000} s` : `${label} could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }
}

function refusal(label: string, response: Response, keyName?: string): WebSearchUnavailable {
  if ((response.status === 401 || response.status === 403) && keyName) return new WebSearchUnavailable(`${label} refused the key in ${keyName} (HTTP ${response.status})`);
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return new WebSearchUnavailable(`${label} is rate limiting searches (HTTP 429)`, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  return new WebSearchUnavailable(`${label} answered HTTP ${response.status}`);
}

// --- Text out of HTML -------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (ENTITIES[name] !== undefined) return ENTITIES[name];
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function domainQuery(query: WebSearchQuery): string {
  const include = (query.includeDomains ?? []).map((domain) => `site:${domain}`);
  const exclude = (query.excludeDomains ?? []).map((domain) => `-site:${domain}`);
  return [query.query.trim(), include.length > 1 ? `(${include.join(" OR ")})` : include[0], ...exclude].filter(Boolean).join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return ""; // not a URL: it matches no domain filter
  }
}

const onDomain = (url: string, domain: string) => {
  const host = hostOf(url), wanted = domain.toLowerCase().replace(/^www\./, "");
  return host === wanted || host.endsWith(`.${wanted}`) || host === `www.${wanted}`;
};

/** Applies the domain filters to what a backend returned, whether or not it honoured them itself. */
function filtered(hits: WebSearchHit[], query: WebSearchQuery): WebSearchHit[] {
  return hits
    .filter((hit) => /^https?:\/\//i.test(hit.url))
    .filter((hit) => !query.includeDomains?.length || query.includeDomains.some((domain) => onDomain(hit.url, domain)))
    .filter((hit) => !query.excludeDomains?.some((domain) => onDomain(hit.url, domain)))
    .slice(0, query.numResults);
}

// --- DuckDuckGo (no key) ----------------------------------------------------------------------

/**
 * One DuckDuckGo request at a time for the whole process, spaced, and none at all while it is
 * limiting this address: its limit is per address, so every session in the process shares it.
 */
const duckPace = { last: 0, coolUntil: 0, backoffMs: 0, queue: Promise.resolve() as Promise<unknown> };
const DUCK_GAP_MS = 1_500;
const DUCK_BACKOFF_FIRST_MS = 30_000;
const DUCK_BACKOFF_MAX_MS = 5 * 60_000;

/** For tests: forget DuckDuckGo's pacing. */
export function resetDuckDuckGoPacing(): void {
  duckPace.last = 0;
  duckPace.coolUntil = 0;
  duckPace.backoffMs = 0;
  duckPace.queue = Promise.resolve();
}

function safeDecode(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return ""; // a malformed redirect: no usable URL, so the result is dropped by `filtered`
  }
}

/** The results on a DuckDuckGo HTML page; null when the page is not one (a challenge, a redesign). */
export function parseDuckDuckGo(html: string): WebSearchHit[] | null {
  const hits: WebSearchHit[] = [];
  // Each organic result is a `result__a` title link followed by its `result__snippet`; ads point
  // at duckduckgo.com/y.js and are dropped.
  const starts = [...html.matchAll(/<div[^>]+class="([^"]*\bresult\b[^"]*)"/g)];
  for (const [index, start] of starts.entries()) {
    const block = html.slice(start.index, starts[index + 1]?.index ?? html.length);
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = decodeEntities(link[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = safeDecode(redirect[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url) || /\bresult--ad\b/.test(start[1])) continue;
    const snippet = /<(?:a|div)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(block);
    hits.push({ title: plainText(link[2]), url, snippet: snippet ? plainText(snippet[1]) : "" });
  }
  if (hits.length > 0) return hits;
  return /class="no-results"|No results\./.test(html) ? [] : null;
}

export function duckDuckGo(fetchImpl: FetchLike, now: () => number = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): WebSearchBackend {
  const label = "DuckDuckGo";
  return {
    label,
    async search(query) {
      const turn = duckPace.queue.then(async () => {
        if (now() < duckPace.coolUntil) {
          throw new WebSearchUnavailable(`${label} is limiting searches from this address`, duckPace.coolUntil - now());
        }
        const wait = duckPace.last + DUCK_GAP_MS - now();
        if (wait > 0) await sleep(wait);
        duckPace.last = now();
        const response = await request(fetchImpl, "https://html.duckduckgo.com/html/", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": BROWSER_AGENT,
            Accept: "text/html",
            "Accept-Language": "en-US,en;q=0.9",
            Origin: "https://html.duckduckgo.com",
            Referer: "https://html.duckduckgo.com/",
          },
          body: new URLSearchParams({ q: domainQuery(query), b: "", kl: "us-en" }).toString(),
        }, label);
        const html = response.ok ? await response.text() : "";
        // 202 is its challenge page: the address is being limited. Back off, and longer each time.
        const parsed = response.status === 200 ? parseDuckDuckGo(html) : null;
        if (response.status === 202 || (response.status === 200 && parsed === null && /anomaly|challenge/i.test(html))) {
          duckPace.backoffMs = Math.min(duckPace.backoffMs ? duckPace.backoffMs * 2 : DUCK_BACKOFF_FIRST_MS, DUCK_BACKOFF_MAX_MS);
          duckPace.coolUntil = now() + duckPace.backoffMs;
          throw new WebSearchUnavailable(`${label} is limiting searches from this address`, duckPace.backoffMs);
        }
        if (!response.ok) throw refusal(label, response);
        if (parsed === null) throw new WebSearchUnavailable(`${label}'s page could not be read (it may have changed)`);
        duckPace.backoffMs = 0;
        return { provider: label, results: filtered(parsed, query) };
      });
      duckPace.queue = turn.catch(() => undefined);
      return turn;
    },
  };
}

// --- Stack Overflow (no key) ------------------------------------------------------------------

type StackItem = { title?: string; question_id?: number; answer_id?: number; item_type?: string; excerpt?: string; body?: string; tags?: string[]; last_activity_date?: number; is_answered?: boolean };

export function stackOverflow(fetchImpl: FetchLike): WebSearchBackend {
  const label = "Stack Overflow";
  const ask = async (endpoint: string, params: Record<string, string>): Promise<StackItem[]> => {
    const url = `https://api.stackexchange.com/2.3/${endpoint}?${new URLSearchParams({ order: "desc", sort: "relevance", site: "stackoverflow", ...params })}`;
    const response = await request(fetchImpl, url, { headers: { Accept: "application/json" } }, label);
    const payload = await response.json().catch(() => null) as { items?: StackItem[]; error_message?: string } | null;
    if (!response.ok || !payload || !Array.isArray(payload.items)) {
      throw new WebSearchUnavailable(`${label} answered HTTP ${response.status}${payload?.error_message ? ` (${payload.error_message})` : ""}`);
    }
    return payload.items;
  };
  return {
    label,
    async search(query) {
      // Only where the question could be answered there: a search restricted to other sites is not.
      if (query.includeDomains?.length && !query.includeDomains.some((domain) => /stackoverflow\.com|stackexchange\.com/.test(domain))) {
        throw new WebSearchUnavailable(`${label} is not among the requested domains`);
      }
      const pagesize = String(Math.min(query.numResults, 10));
      // Its full-text search wants every word, so a long query often finds nothing; `similar`
      // matches question titles loosely and is asked then.
      let items = await ask("search/excerpts", { q: query.query, pagesize });
      if (items.length === 0) items = await ask("similar", { title: query.query, pagesize });
      const hits = items.map((item) => ({
        title: plainText(item.title ?? ""),
        url: item.item_type === "answer" && item.answer_id ? `https://stackoverflow.com/a/${item.answer_id}` : `https://stackoverflow.com/q/${item.question_id}`,
        snippet: (plainText(item.excerpt ?? item.body ?? "") || [item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "", item.is_answered ? "answered" : ""].filter(Boolean).join(" · ")).slice(0, 600),
        ...(item.last_activity_date ? { publishedDate: new Date(item.last_activity_date * 1000).toISOString().slice(0, 10) } : {}),
      })).filter((hit) => hit.title);
      return { provider: label, results: filtered(hits, query) };
    },
  };
}

// --- Keyed backends ---------------------------------------------------------------------------

export function braveSearch(apiKey: string, fetchImpl: FetchLike): WebSearchBackend {
  const label = "Brave Search";
  return {
    label,
    async search(query) {
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: domainQuery(query), count: String(Math.min(query.numResults, 20)) })}`;
      const response = await request(fetchImpl, url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } }, label);
      if (!response.ok) throw refusal(label, response, "BRAVE_SEARCH_API_KEY");
      const payload = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> } };
      const hits = (payload.web?.results ?? []).map((item) => ({
        title: plainText(item.title ?? ""), url: item.url ?? "", snippet: plainText(item.description ?? ""),
        ...(item.page_age ? { publishedDate: item.page_age.slice(0, 10) } : {}),
      }));
      return { provider: label, results: filtered(hits, query) };
    },
  };
}

export function tavilySearch(apiKey: string, fetchImpl: FetchLike): WebSearchBackend {
  const label = "Tavily";
  return {
    label,
    async search(query) {
      const response = await request(fetchImpl, "https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: query.query, max_results: Math.min(query.numResults, 20), search_depth: "basic",
          ...(query.includeDomains?.length ? { include_domains: query.includeDomains } : {}),
          ...(query.excludeDomains?.length ? { exclude_domains: query.excludeDomains } : {}),
        }),
      }, label);
      if (!response.ok) throw refusal(label, response, "TAVILY_API_KEY");
      const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
      const hits = (payload.results ?? []).map((item) => ({
        title: plainText(item.title ?? ""), url: item.url ?? "", snippet: plainText(item.content ?? "").slice(0, 1_500),
        ...(item.published_date ? { publishedDate: item.published_date.slice(0, 10) } : {}),
      }));
      return { provider: label, results: filtered(hits, query) };
    },
  };
}

/** A SearXNG instance, usually the person's own; its JSON output must be enabled (`search.formats`). */
export function searxngSearch(baseUrl: string, fetchImpl: FetchLike): WebSearchBackend {
  const label = "SearXNG";
  const base = baseUrl.replace(/\/+$/, "");
  return {
    label,
    async search(query) {
      const response = await request(fetchImpl, `${base}/search?${new URLSearchParams({ q: domainQuery(query), format: "json" })}`, { headers: { Accept: "application/json" } }, label);
      if (response.status === 403) throw new WebSearchUnavailable(`${label} at ${base} refused JSON output; enable "json" under search.formats in its settings.yml`);
      if (!response.ok) throw refusal(label, response);
      const payload = await response.json().catch(() => null) as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string | null }> } | null;
      if (!payload) throw new WebSearchUnavailable(`${label} at ${base} did not answer JSON`);
      const hits = (payload.results ?? []).map((item) => ({
        title: plainText(item.title ?? ""), url: item.url ?? "", snippet: plainText(item.content ?? ""),
        ...(item.publishedDate ? { publishedDate: item.publishedDate.slice(0, 10) } : {}),
      }));
      return { provider: label, results: filtered(hits, query) };
    },
  };
}

// --- Composition ------------------------------------------------------------------------------

/**
 * Tries each backend in order until one answers. An answer with no results is an answer; only a
 * search that could not be done moves on. When all fail, the error names each one's reason.
 */
export function firstAnswering(backends: readonly WebSearchBackend[], fallbackNote?: (used: WebSearchBackend, failed: string[]) => string | undefined): WebSearchBackend {
  return {
    label: backends.map((backend) => backend.label).join(", then "),
    async search(query) {
      const failed: string[] = [];
      let retryAfterMs: number | undefined;
      for (const backend of backends) {
        try {
          // The filters and the count hold whoever answered, whether or not it honoured them itself.
          const response = { ...(await backend.search(query)) };
          response.results = filtered(response.results, query);
          const note = failed.length ? fallbackNote?.(backend, failed) : undefined;
          return note ? { ...response, note } : response;
        } catch (error) {
          if (!(error instanceof WebSearchUnavailable)) throw error;
          failed.push(error.reason);
          if (error.retryAfterMs !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, error.retryAfterMs);
        }
      }
      throw new WebSearchUnavailable(failed.join("; "), retryAfterMs);
    },
  };
}

/** The same query asked again within a few minutes is answered from memory. */
export function cached(backend: WebSearchBackend, now: () => number = Date.now, ttlMs = 10 * 60_000, capacity = 100): WebSearchBackend {
  const entries = new Map<string, { at: number; response: WebSearchResponse }>();
  return {
    label: backend.label,
    async search(query) {
      const key = JSON.stringify([query.query.trim().toLowerCase(), query.numResults, [...(query.includeDomains ?? [])].sort(), [...(query.excludeDomains ?? [])].sort()]);
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.response;
      const response = await backend.search(query);
      entries.delete(key);
      entries.set(key, { at: now(), response });
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return response;
    },
  };
}

export const WEB_SEARCH_CHOICES = ["auto", "brave", "tavily", "searxng", "duckduckgo", "off"] as const;

/**
 * The search a session gets. `ARCHYMEDES_WEB_SEARCH` picks one backend (`brave`, `tavily`,
 * `searxng`, `duckduckgo`) or none (`off`); unset or `auto` uses every configured one, keyed first,
 * then the keyless pair.
 */
export function createWebSearch(
  environment: { ARCHYMEDES_WEB_SEARCH?: string; BRAVE_SEARCH_API_KEY?: string; TAVILY_API_KEY?: string; SEARXNG_URL?: string },
  fetchImpl: FetchLike | undefined = globalThis.fetch,
): WebSearchBackend | undefined {
  if (typeof fetchImpl !== "function") return undefined;
  const choice = (environment.ARCHYMEDES_WEB_SEARCH ?? "auto").trim().toLowerCase();
  if (choice === "off") return undefined;
  const brave = environment.BRAVE_SEARCH_API_KEY?.trim(), tavily = environment.TAVILY_API_KEY?.trim(), searx = environment.SEARXNG_URL?.trim();
  const keyless = [duckDuckGo(fetchImpl), stackOverflow(fetchImpl)];
  const configured: WebSearchBackend[] = [
    ...(brave ? [braveSearch(brave, fetchImpl)] : []),
    ...(tavily ? [tavilySearch(tavily, fetchImpl)] : []),
    ...(searx ? [searxngSearch(searx, fetchImpl)] : []),
  ];
  const named: Record<string, WebSearchBackend[] | undefined> = {
    brave: brave ? [braveSearch(brave, fetchImpl)] : undefined,
    tavily: tavily ? [tavilySearch(tavily, fetchImpl)] : undefined,
    searxng: searx ? [searxngSearch(searx, fetchImpl)] : undefined,
    duckduckgo: keyless,
  };
  // A named backend without its key falls back to the automatic order rather than to nothing.
  const chain = named[choice] ?? [...configured, ...keyless];
  return cached(firstAnswering(chain, (used, failed) =>
    used.label === "Stack Overflow" ? `Web search was unavailable (${failed.join("; ")}); these are Stack Overflow results only.` : `Answered by ${used.label}; ${failed.join("; ")}.`));
}

/** What to tell the model when no search could be done, and what would make one possible. */
export function unavailableMessage(error: WebSearchUnavailable): string {
  const retry = error.retryAfterMs ? ` Try again in about ${Math.max(1, Math.round(error.retryAfterMs / 1000))} s, or answer from what you have.` : "";
  const keys = /DuckDuckGo/.test(error.reason) ? " (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY or SEARXNG_URL gives a search that is not rate limited.)" : "";
  return `Web search could not be done: ${error.reason}.${retry}${keys}`;
}
