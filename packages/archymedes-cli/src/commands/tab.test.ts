import { describe, expect, it } from "vitest";
import { WorkspaceController } from "../session/tabs";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runTabCommand, type TabCommandContext, type TabPayloadShape } from "./tab";

type Payload = TabPayloadShape & { name: string; disposed: string[] };
type Wanted = { model: string };

function setup() {
  const events: string[] = [];
  const written: string[] = [];
  const tabs = new WorkspaceController<Payload>();
  const payload = (name: string, backend: Payload["backend"], ownsWorkspace: boolean): Payload => {
    let live = true;
    const disposed: string[] = [];
    return {
      name, backend, ownsWorkspace, disposed,
      agent: { dispose: async () => { disposed.push("agent"); } },
      workspace: { dispose: async () => { disposed.push("workspace"); } },
      sink: { get isLive() { return live; }, setLive: (value: boolean) => { live = value; } },
    };
  };
  tabs.adopt("main", payload("main", "local", false));
  let explained = false;
  const ctx: TabCommandContext<Payload, Wanted, string> = {
    tabs,
    resolve: (request) => request.model === "bad" ? { error: "unknown model bad" } : { model: request.model ?? "default-model" },
    sessionWorkspace: "session-ws",
    startWorkspace: async (backend) => backend === "docker" ? { error: "docker is not running" } : { workspace: `${backend}-ws` },
    openTab: async (title, wanted, workspace, backend) => {
      events.push(`open ${title} ${wanted.model} ${workspace}`);
      return tabs.open(title, () => payload(title, backend ?? "local", workspace !== "session-ws"));
    },
    stashActiveTab: () => events.push("stash"),
    enterTab: (tab, options) => events.push(`enter ${tab.title}${options?.replay ? " replay" : ""}`),
    switchTab: (id) => id === 1,
    showTabs: () => events.push("show"),
    describeLocation: (backend) => `on ${backend}`,
    firstTabExplanation: () => !explained && (explained = true),
    write: (text) => written.push(text),
    paint: { dim: (t) => t, yellow: (t) => t, cyan: (t) => t },
    glyphs: UNICODE_GLYPHS,
  };
  return { ctx, events, written, tabs };
}

describe("/tab", () => {
  it("opens a tab on the shared workspace, or its own sandbox, and explains sequential tabs once", async () => {
    const { ctx, events, written, tabs } = setup();
    await runTabCommand({ kind: "new", title: "review" }, ctx);
    expect(events).toEqual(["stash", "open review default-model session-ws", "enter review", "show"]);
    await runTabCommand({ kind: "new", title: "risky", backend: "e2b", model: "fast" }, ctx);
    expect(events).toContain("open risky fast e2b-ws");
    expect(tabs.active.payload.ownsWorkspace).toBe(true);
    expect(written.filter((line) => line.includes("only the tab in front runs"))).toHaveLength(1);
  });

  it("refuses a bad model or an unavailable sandbox before touching the session", async () => {
    const { ctx, events, written, tabs } = setup();
    await runTabCommand({ kind: "new", model: "bad" }, ctx);
    await runTabCommand({ kind: "new", backend: "docker" }, ctx);
    expect(events).toEqual([]);
    expect(written).toEqual(["  unknown model bad\n", "  docker is not running\n"]);
    expect(tabs.size).toBe(1);
  });

  it("closes a tab, stopping only a sandbox it started, and replays only when it was in front", async () => {
    const { ctx, events, written, tabs } = setup();
    await runTabCommand({ kind: "new", title: "risky", backend: "e2b" }, ctx);
    const risky = tabs.active;
    events.length = 0;
    await runTabCommand({ kind: "close" }, ctx);
    expect(risky.payload.disposed).toEqual(["agent", "workspace"]);
    expect(written.join("")).toContain("stopping on e2b");
    expect(events).toEqual(["enter main replay", "show"]);
    await runTabCommand({ kind: "select", id: 9 }, ctx);
    expect(written.at(-1)).toBe("  No tab 9.\n");
  });
});
