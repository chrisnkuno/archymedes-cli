import { describe, expect, it } from "vitest";
import { LineLog } from "../terminal/output";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runWatchCommand, type WatchCommandContext } from "./watch-command";

function context(jobs: Array<{ id: string; lines: string[] }> = []) {
  const written: string[] = [];
  const started: string[] = [];
  const entries = jobs.map((job) => {
    const log = new LineLog();
    for (const line of job.lines) log.write(`${line}\n`);
    return { stream: { id: job.id, done: false, status: "running" }, sink: { log }, objective: `do ${job.id}`, startedAt: 0 };
  });
  const same = (text: string) => text;
  const ctx = {
    watched: {
      get size() { return entries.length; },
      get all() { return entries; },
      get: (id: string) => entries.find((entry) => entry.stream.id === id),
      stop: (id: string) => entries.find((entry) => entry.stream.id === id),
      stopAll: () => undefined,
    },
    getJob: async (id: string) => (id === "job-2" ? { objective: "second" } : null),
    startWatching: async (id: string) => { started.push(id); },
    write: (text: string) => written.push(text),
    paint: { dim: same, yellow: same, cyan: same },
    style: { width: 80, depth: "none" as const },
    glyphs: UNICODE_GLYPHS,
  } as unknown as WatchCommandContext;
  return { ctx, written, started };
}

describe("/watch", () => {
  it("lists watched jobs, replays one, and starts watching a job that exists", async () => {
    const { ctx, written, started } = context([{ id: "job-1", lines: ["hello"] }]);
    await runWatchCommand("", ctx);
    expect(written.join("")).toContain("job-1");
    await runWatchCommand("show job-1", ctx);
    expect(written).toContain("hello\n");
    await runWatchCommand("job-2", ctx);
    expect(started).toEqual(["job-2"]);
  });

  it("explains an empty list, an unwatched job and a missing one", async () => {
    const { ctx, written } = context();
    await runWatchCommand("", ctx);
    await runWatchCommand("show job-9", ctx);
    await runWatchCommand("job-9", ctx);
    expect(written).toEqual([
      "  watching nothing — /watch <job id>, or /jobs to see what exists\n",
      "  not watching job-9\n",
      "  No job job-9. /jobs lists what exists.\n",
    ]);
  });
});
