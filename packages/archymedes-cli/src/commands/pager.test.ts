import { describe, expect, it } from "vitest";
import { runPager } from "./pager";

describe("/pager", () => {
  it("hands the pager the transcript with colour kept and cursor movement removed", async () => {
    const calls: Array<{ command: string; args: readonly string[]; input: string }> = [];
    const result = await runPager(
      { lines: ["\x1b[32mok\x1b[0m", "spin\x1b[1A\x1b[2Kdone"], pending: "partial", dropped: 3 },
      {},
      async (command, args, input) => { calls.push({ command, args, input }); return 0; },
    );
    expect(result).toEqual({ opened: true });
    expect(calls[0].command).toBe("less");
    expect(calls[0].args).toEqual(["-R"]);
    expect(calls[0].input).toBe("[3 earlier lines are not in this view]\n\n\x1b[32mok\x1b[0m\nspindone\npartial");
  });

  it("uses the built-in pager on Windows, and when less will not start", async () => {
    const shown: string[] = [];
    const internal = async (text: string) => { shown.push(text); };
    const spawned: string[] = [];
    const windows = await runPager({ lines: ["hello"], pending: "", dropped: 0 }, {}, async (command) => { spawned.push(command); return 0; }, { internal, platform: "win32" });
    expect(windows).toEqual({ opened: true, internal: true });
    expect(spawned).toEqual([]);
    expect(shown[0]).toContain("hello");

    const missing = await runPager({ lines: ["again"], pending: "", dropped: 0 }, {}, async () => { throw new Error("spawn less ENOENT"); }, { internal, platform: "linux" });
    expect(missing).toEqual({ opened: true, internal: true });
    expect(shown[1]).toContain("again");

    // A pager someone configured is theirs: no fallback hides it failing.
    const configured = await runPager({ lines: [], pending: "", dropped: 0 }, { PAGER: "most" }, async () => { throw new Error("not found"); }, { internal, platform: "win32" });
    expect(configured.opened).toBe(false);
  });

  it("honours $PAGER and reports a pager that cannot run", async () => {
    const result = await runPager({ lines: [], pending: "", dropped: 0 }, { PAGER: "most -s" }, async () => { throw new Error("not found"); });
    expect(result).toEqual({ opened: false, reason: "Could not run most: not found" });
  });
});
