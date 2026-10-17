import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "../cli/backends";
import { createArchymedesTools, TodoList } from "../cli/tools";
import {
  braveSearch, cached, createWebSearch, decodeEntities, duckDuckGo, firstAnswering, parseDuckDuckGo, resetDuckDuckGoPacing,
  searxngSearch, stackOverflow, tavilySearch, unavailableMessage, WebSearchUnavailable, type WebSearchBackend, type WebSearchResponse,
} from "./web-search";

afterEach(() => resetDuckDuckGoPacing());

/** The shape of html.duckduckgo.com's results page, as fetched on 2026-10-17. */
function duckPage(results: Array<{ url: string; title: string; snippet?: string; ad?: boolean; redirect?: boolean }>): string {
  return `<html><body><div id="links" class="results">${results.map((result) => {
    const href = result.ad ? "https://duckduckgo.com/y.js?ad_domain=x" : result.redirect ? `//duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}&amp;rut=abc` : result.url;
    return `<div class="result results_links results_links_deep ${result.ad ? "result--ad " : "web-result "}">
      <div class="links_main links_deep result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${result.title}</a></h2>
        <a class="result__url" href="${href}">${result.url}</a>
        ${result.snippet !== undefined ? `<a class="result__snippet" href="${href}">${result.snippet}</a>` : ""}
      </div></div>`;
  }).join("\n")}</div></body></html>`;
}

const NO_RESULTS = `<html><body><div class="no-results">No results.</div></body></html>`;
const CHALLENGE = `<html><body><form id="challenge-form" action="//duckduckgo.com/anomaly.js">Unfortunately, bots use DuckDuckGo too.</form></body></html>`;

type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

const query = (text: string, extra: Partial<Parameters<WebSearchBackend["search"]>[0]> = {}) => ({ query: text, numResults: 5, ...extra });

describe("reading DuckDuckGo's page", () => {
  it("takes title, link and snippet from each organic result, unwrapping redirects and dropping ads", () => {
    const hits = parseDuckDuckGo(duckPage([
      { url: "https://ads.example.com", title: "Buy now", ad: true },
      { url: "https://pkg.go.dev/x?a=1&b=2", title: "Package <b>x</b> &amp; friends", snippet: "It&#39;s a <b>package</b>.", redirect: true },
      { url: "https://github.com/charmbracelet/bubbletea", title: "Bubble Tea", snippet: "A TUI framework" },
      { url: "https://example.com/no-snippet", title: "Bare" },
    ]));
    expect(hits).toEqual([
      { title: "Package x & friends", url: "https://pkg.go.dev/x?a=1&b=2", snippet: "It's a package." },
      { title: "Bubble Tea", url: "https://github.com/charmbracelet/bubbletea", snippet: "A TUI framework" },
      { title: "Bare", url: "https://example.com/no-snippet", snippet: "" },
    ]);
  });

  it("tells an empty answer from a page it cannot read", () => {
    expect(parseDuckDuckGo(NO_RESULTS)).toEqual([]);
    expect(parseDuckDuckGo(CHALLENGE)).toBeNull();
    expect(parseDuckDuckGo("<html>redesigned</html>")).toBeNull();
  });

  it("decodes named and numeric entities, and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#x41;&#66; &bogus; &#xFFFFFFF;")).toBe("a & b <c> AB &bogus; &#xFFFFFFF;");
  });
});

describe("DuckDuckGo, paced", () => {
  it("asks with a form POST, domain filters as operators, and returns what it found", async () => {
    const fetch = fakeFetch(() => new Response(duckPage([{ url: "https://docs.python.org/3/a", title: "A", snippet: "s" }, { url: "https://other.org/b", title: "B" }]), { status: 200 }));
    const result = await duckDuckGo(fetch.impl).search(query("asyncio gather", { includeDomains: ["docs.python.org", "peps.python.org"], excludeDomains: ["w3schools.com"] }));
    expect(fetch.calls[0].init?.method).toBe("POST");
    expect(new URLSearchParams(String(fetch.calls[0].init?.body)).get("q")).toBe("asyncio gather (site:docs.python.org OR site:peps.python.org) -site:w3schools.com");
    // The filter holds even for what the engine returned against it.
    expect(result).toEqual({ provider: "DuckDuckGo", results: [{ title: "A", url: "https://docs.python.org/3/a", snippet: "s" }] });
  });

  it("spaces its requests, and after a challenge stops asking until the backoff has passed, longer each time", async () => {
    let clock = 1_000_000;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); clock += ms; };
    const pages = [duckPage([{ url: "https://a.org", title: "a" }]), CHALLENGE, duckPage([{ url: "https://b.org", title: "b" }])];
    const fetch = fakeFetch((_call, index) => new Response(pages[Math.min(index, pages.length - 1)], { status: index === 1 ? 202 : 200 }));
    const duck = duckDuckGo(fetch.impl, () => clock, sleep);
    await duck.search(query("one"));
    const limited = await duck.search(query("two")).catch((error: unknown) => error);
    expect(slept).toEqual([1_500]); // the second waited for the gap
    expect(limited).toBeInstanceOf(WebSearchUnavailable);
    expect((limited as WebSearchUnavailable).retryAfterMs).toBe(30_000);
    // While cooling down, it does not even ask.
    clock += 10_000;
    await expect(duck.search(query("three"))).rejects.toThrow(/limiting/);
    expect(fetch.calls).toHaveLength(2);
    clock += 21_000;
    expect((await duck.search(query("four"))).results[0].url).toBe("https://b.org");
    expect(fetch.calls).toHaveLength(3);
  });

  it("runs one request at a time even when several are asked at once", async () => {
    let inFlight = 0, most = 0;
    const fetch = fakeFetch(async () => {
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(duckPage([{ url: "https://a.org", title: "a" }]));
    });
    const duck = duckDuckGo(fetch.impl, Date.now, async () => undefined);
    await Promise.all([1, 2, 3, 4].map((n) => duck.search(query(`q${n}`))));
    expect(most).toBe(1);
  });

  it("calls a page it cannot read unavailable, not empty", async () => {
    const fetch = fakeFetch(() => new Response("<html>redesigned</html>"));
    await expect(duckDuckGo(fetch.impl, Date.now, async () => undefined).search(query("x"))).rejects.toThrow(/could not be read/);
  });
});

describe("the other backends", () => {
  it("Stack Overflow: questions and answers by link, entities decoded; not asked for other sites", async () => {
    const fetch = fakeFetch(() => Response.json({ items: [
      { item_type: "question", question_id: 7, title: "errgroup &amp; context", excerpt: "How do I <span class=\"highlight\">cancel</span>?", last_activity_date: 1_700_000_000 },
      { item_type: "answer", question_id: 7, answer_id: 9, title: "errgroup &amp; context", excerpt: "Use WithContext." },
    ] }));
    const result = await stackOverflow(fetch.impl).search(query("errgroup cancel"));
    expect(result.results).toEqual([
      { title: "errgroup & context", url: "https://stackoverflow.com/q/7", snippet: "How do I cancel?", publishedDate: "2023-11-14" },
      { title: "errgroup & context", url: "https://stackoverflow.com/a/9", snippet: "Use WithContext." },
    ]);
    await expect(stackOverflow(fetch.impl).search(query("x", { includeDomains: ["docs.python.org"] }))).rejects.toThrow(/not among/);
    expect(fetch.calls).toHaveLength(1);
  });

  it("Stack Overflow: a long query its full-text search cannot match is asked of question titles instead", async () => {
    const fetch = fakeFetch((call) => Response.json({ items: call.url.includes("/similar?") ? [{ question_id: 3, title: "golang errgroup example", tags: ["go", "errgroup"], is_answered: true }] : [] }));
    const result = await stackOverflow(fetch.impl).search(query("golang errgroup WithContext cancel"));
    expect(result.results).toEqual([{ title: "golang errgroup example", url: "https://stackoverflow.com/q/3", snippet: "Tags: go, errgroup · answered" }]);
    expect(new URL(fetch.calls[1].url).searchParams.get("title")).toBe("golang errgroup WithContext cancel");
  });

  it("Brave and Tavily send their key their own way, and a refused key is named", async () => {
    const brave = fakeFetch(() => Response.json({ web: { results: [{ title: "T", url: "https://t.org", description: "<strong>d</strong>", page_age: "2026-01-02T00:00:00" }] } }));
    expect((await braveSearch("bk", brave.impl).search(query("q"))).results).toEqual([{ title: "T", url: "https://t.org", snippet: "d", publishedDate: "2026-01-02" }]);
    expect(new Headers(brave.calls[0].init?.headers).get("X-Subscription-Token")).toBe("bk");
    const tavily = fakeFetch(() => Response.json({ results: [{ title: "T", url: "https://t.org", content: "c" }] }));
    await tavilySearch("tk", tavily.impl).search(query("q", { includeDomains: ["t.org"] }));
    expect(new Headers(tavily.calls[0].init?.headers).get("Authorization")).toBe("Bearer tk");
    expect(JSON.parse(String(tavily.calls[0].init?.body))).toMatchObject({ query: "q", include_domains: ["t.org"] });
    const refused = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(braveSearch("bad", refused.impl).search(query("q"))).rejects.toThrow("refused the key in BRAVE_SEARCH_API_KEY");
    await expect(tavilySearch("bad", refused.impl).search(query("q"))).rejects.toThrow("refused the key in TAVILY_API_KEY");
  });

  it("SearXNG: says how to turn its JSON on when it is off", async () => {
    const off = fakeFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(searxngSearch("http://localhost:8888/", off.impl).search(query("q"))).rejects.toThrow(/enable "json" under search.formats/);
    expect(off.calls[0].url).toBe("http://localhost:8888/search?q=q&format=json");
  });

  it("a backend that does not answer in time is unavailable", async () => {
    const hung = (async (_url: string | URL, init?: RequestInit) => {
      throw Object.assign(new Error("timed out"), { name: init?.signal ? "TimeoutError" : "Error" });
    }) as typeof fetch;
    await expect(braveSearch("k", hung).search(query("q"))).rejects.toThrow(/did not answer within/);
  });
});

describe("putting them together", () => {
  const answering = (label: string, response: Partial<WebSearchResponse> | Error, calls?: string[]): WebSearchBackend => ({
    label,
    async search() {
      calls?.push(label);
      if (response instanceof Error) throw response;
      return { provider: label, results: [], ...response };
    },
  });

  it("moves past a backend that could not search, stops at one that answered (even with nothing), and says it fell back", async () => {
    const calls: string[] = [];
    const chain = firstAnswering([
      answering("Brave Search", new WebSearchUnavailable("Brave Search answered HTTP 500"), calls),
      answering("DuckDuckGo", { results: [] }, calls),
      answering("Stack Overflow", { results: [{ title: "t", url: "https://so.com", snippet: "" }] }, calls),
    ], (used, failed) => `${used.label} after ${failed.length}`);
    expect(await chain.search(query("q"))).toEqual({ provider: "DuckDuckGo", results: [], note: "DuckDuckGo after 1" });
    expect(calls).toEqual(["Brave Search", "DuckDuckGo"]);
  });

  it("names every reason when none could search, keeps the longest wait, and lets a real bug through", async () => {
    const chain = firstAnswering([
      answering("DuckDuckGo", new WebSearchUnavailable("DuckDuckGo is limiting searches from this address", 30_000)),
      answering("Stack Overflow", new WebSearchUnavailable("Stack Overflow answered HTTP 502", 5_000)),
    ]);
    const error = await chain.search(query("q")).catch((caught: unknown) => caught) as WebSearchUnavailable;
    expect(error.reason).toBe("DuckDuckGo is limiting searches from this address; Stack Overflow answered HTTP 502");
    expect(error.retryAfterMs).toBe(30_000);
    expect(unavailableMessage(error)).toMatch(/^Web search could not be done: .*Try again in about 30 s.*BRAVE_SEARCH_API_KEY/);
    await expect(firstAnswering([answering("x", new TypeError("bug"))]).search(query("q"))).rejects.toThrow(TypeError);
  });

  it("answers a repeated query from memory until it is stale", async () => {
    let clock = 0;
    const calls: string[] = [];
    const memo = cached(answering("b", { results: [] }, calls), () => clock, 1_000);
    await memo.search(query("Same Thing", { includeDomains: ["b.org", "a.org"] }));
    await memo.search(query("same thing ", { includeDomains: ["a.org", "b.org"] }));
    expect(calls).toHaveLength(1);
    clock = 1_001;
    await memo.search(query("same thing", { includeDomains: ["a.org", "b.org"] }));
    expect(calls).toHaveLength(2);
    // A failure is not remembered: the next ask tries again.
    let fail = true;
    const flaky = cached({ label: "f", search: async () => { if (fail) throw new WebSearchUnavailable("down"); return { provider: "f", results: [] }; } });
    await expect(flaky.search(query("q"))).rejects.toThrow("down");
    fail = false;
    await expect(flaky.search(query("q"))).resolves.toMatchObject({ provider: "f" });
  });

  it("chooses backends from the settings: keyed first, a named one alone, off is off", async () => {
    const fetch = fakeFetch((call) => call.url.includes("brave") ? Response.json({ web: { results: [] } }) : new Response(NO_RESULTS));
    expect(createWebSearch({ ARCHYMEDES_WEB_SEARCH: "off" }, fetch.impl)).toBeUndefined();
    expect(createWebSearch({}, fetch.impl)?.label).toBe("DuckDuckGo, then Stack Overflow");
    expect(createWebSearch({ BRAVE_SEARCH_API_KEY: "k", SEARXNG_URL: "http://s" }, fetch.impl)?.label).toBe("Brave Search, then SearXNG, then DuckDuckGo, then Stack Overflow");
    expect(createWebSearch({ ARCHYMEDES_WEB_SEARCH: "Brave", BRAVE_SEARCH_API_KEY: "k" }, fetch.impl)?.label).toBe("Brave Search");
    // Named without its key: the automatic order, not nothing.
    expect(createWebSearch({ ARCHYMEDES_WEB_SEARCH: "tavily" }, fetch.impl)?.label).toBe("DuckDuckGo, then Stack Overflow");
    expect(createWebSearch({ ARCHYMEDES_WEB_SEARCH: "duckduckgo", BRAVE_SEARCH_API_KEY: "k" }, fetch.impl)?.label).toBe("DuckDuckGo, then Stack Overflow");
  });
});

/** mulberry32, as the runtime invariants use. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("web_search invariants under random backends", () => {
  /**
   * Seeded random backends — answering with good, off-domain and malformed links, answering nothing,
   * refusing, or failing outright — behind the real tool, asked random queries with random filters.
   * Whatever happens: the tool never lets an outage read as "no results", never returns a link that
   * is not http(s) or that breaks the domain filters, never more than asked (or 10), and never
   * crashes on an outage.
   */
  it("holds for every seed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-inv-"));
    const DOMAINS = ["docs.python.org", "github.com", "stackoverflow.com", "example.org"];
    const URLS = ["https://docs.python.org/3/x", "https://github.com/a/b", "https://sub.github.com/z", "https://stackoverflow.com/q/1", "https://example.org", "http://evil.test/github.com", "javascript:alert(1)", "not a url", "//github.com/x", "https://notgithub.com"];
    let outages = 0, answers = 0, empties = 0;
    try {
      for (let seed = 1; seed <= 300; seed += 1) {
        const next = random(seed);
        const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)];
        const backends: WebSearchBackend[] = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => {
          const roll = next();
          return {
            label: `b${index}`,
            async search(asked) {
              if (roll < 0.35) throw new WebSearchUnavailable(`b${index} is down`, next() < 0.5 ? Math.floor(next() * 60_000) : undefined);
              const count = roll < 0.45 ? 0 : 1 + Math.floor(next() * 25);
              return { provider: `b${index}`, results: Array.from({ length: count }, (_, i) => ({ title: `t${i}`, url: pick(URLS), snippet: next() < 0.5 ? "" : "s" })).filter(() => true).slice(0, roll < 0.7 ? asked.numResults : 99) };
            },
          };
        });
        const chain = firstAnswering(backends);
        const tools = await createArchymedesTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), webSearch: chain });
        const tool = tools.find((candidate) => candidate.name === "web_search")!;
        const include = next() < 0.3 ? [pick(DOMAINS)] : undefined;
        const exclude = next() < 0.2 ? [pick(DOMAINS)] : undefined;
        const asked = next() < 0.2 ? undefined : Math.floor(next() * 40) - 5;
        const args = { query: `q${seed}`, ...(asked === undefined ? {} : { numResults: asked }), ...(include ? { includeDomains: include } : {}), ...(exclude ? { excludeDomains: exclude } : {}) };
        const result = await tool.execute(args, { taskId: "t", runId: "r", stepId: "s" });
        const where = `seed ${seed}`;
        const urls = ((result.data as { urls?: string[] } | undefined)?.urls) ?? [];
        if ((result.data as { unavailable?: string } | undefined)?.unavailable) {
          outages += 1;
          expect(result.isError, where).toBe(true);
          expect(result.content, where).toMatch(/^Web search could not be done: /);
          expect(result.content, where).not.toMatch(/no results/i);
          continue;
        }
        expect(result.isError ?? false, where).toBe(false);
        urls.length === 0 ? empties += 1 : answers += 1;
        expect(urls.length, where).toBeLessThanOrEqual(Math.min(Math.max(asked ?? 5, 1), 10));
        for (const url of urls) {
          expect(url, where).toMatch(/^https?:\/\//);
          const host = new URL(url).hostname;
          if (include) expect(host === include[0] || host.endsWith(`.${include[0]}`), `${where}: ${url} outside ${include[0]}`).toBe(true);
          if (exclude) expect(host === exclude[0] || host.endsWith(`.${exclude[0]}`), `${where}: ${url} is excluded`).toBe(false);
          expect(result.content, where).toContain(url);
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    // A random suite that only takes one path proves nothing.
    expect(outages).toBeGreaterThan(20);
    expect(answers).toBeGreaterThan(50);
    expect(empties).toBeGreaterThan(20);
  });
});
