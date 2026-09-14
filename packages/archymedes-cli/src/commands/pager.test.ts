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

  it("honours $PAGER and reports a pager that cannot run", async () => {
    const result = await runPager({ lines: [], pending: "", dropped: 0 }, { PAGER: "most -s" }, async () => { throw new Error("not found"); });
    expect(result).toEqual({ opened: false, reason: "Could not run most: not found" });
  });
});
