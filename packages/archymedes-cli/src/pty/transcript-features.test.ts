import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess, type SpawnArchymedesOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * The reading experience, driven through a real terminal.
 *
 * Everything these features do is decided by pure functions covered elsewhere; what a pty adds is
 * the only question those tests cannot answer — whether the CLI actually *reaches* them. A code
 * panel that renders perfectly in a unit test and is never printed because the event never carried
 * the arguments is exactly the failure this catches.
 */

const PROMPT = /›|auto >/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";

/**
 * Assertions read the transcript the way a person does — colour is not content. Waiting patterns,
 * on the other hand, run against the raw buffer, so they must never straddle a colour boundary.
 */
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("what the transcript shows, under a real pty", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-view-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-view-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(options: Partial<SpawnArchymedesOptions> = {}): ArchymedesProcess {
    proc = spawnArchymedes({
      cwd,
      cols: 100,
      rows: 40,
      args: ["--currency", "USD", "--auto", ...(options.args ?? [])],
      env: {
        ANTHROPIC_API_KEY: ANTHROPIC_TEST_KEY,
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        TZ: "UTC",
        ...options.env,
      },
    });
    return proc;
  }

  it("shows the measured reliability direction on every interactive startup", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const output = plain(p.output());
    expect(output).toMatch(/bundled benchmark \d+\/100/);
    expect(output).toMatch(/measured \d{4}-\d{2}-\d{2}/);
  }, 60_000);

  it("shows the code a write actually contained, not only that a write happened", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    stub.enqueue({
      kind: "tool_call",
      toolName: "write_file",
      input: {
        path: "hello.ts",
        content: 'export const greeting = "hi";\nexport const answer = 42;\n',
      },
    });
    stub.enqueue({ kind: "text", text: "Done." });

    // Waiting on a span that syntax highlighting does not colour part-way through: `42` arrives
    // wrapped in its own escape codes, so `answer = 42` never appears contiguously in the raw pty
    // buffer even though that is exactly what the terminal draws.
    p.writeLine("write the greeting file");
    await p.waitFor(/answer = /, { timeoutMs: 30_000 });
    await p.waitFor(/summary/, { timeoutMs: 30_000 });
    const output = plain(p.output());
    expect(output).toContain("hello.ts");
    expect(output).toContain("tool activity");
    expect(output).toContain("new file");
    expect(output).toContain("summary");
    expect(output).toContain('greeting = "hi";');
    expect(output).toContain("answer = 42;");
    // Numbered, because the next thing anyone says about written code is a line number.
    expect(output).toMatch(/1\s+export const greeting/);
    expect(output.indexOf("tool activity")).toBeLessThan(output.indexOf("new file"));
    expect(output.indexOf("new file")).toBeLessThan(output.lastIndexOf("summary"));
  }, 60_000);

  it("folds a long write and expands it again on request, in the same scrolling transcript", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const content = Array.from(
      { length: 60 },
      (_unused, index) => `const value${index} = ${index};`,
    ).join("\n");
    stub.enqueue({
      kind: "tool_call",
      toolName: "write_file",
      input: { path: "big.ts", content },
    });
    stub.enqueue({ kind: "text", text: "Written." });

    const turnStarted = p.output().length;
    p.writeLine("write the big file");
    await p.waitFor(/more lines hidden/, {
      timeoutMs: 30_000,
      since: turnStarted,
    });
    expect(p.output()).not.toContain("value59");

    // The folded panel is printed during the tool call, before the model's final response and the
    // prompt. Sending /expand at that intermediate frame becomes input to the active turn rather
    // than the next command, so wait until Archymedes is ready to read it.
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: turnStarted });

    const before = p.output().length;
    p.writeLine("/expand");
    await p.waitFor(/value59/, { timeoutMs: 20_000, since: before });
  }, 60_000);

  it("shows the whole task — request, changed file, and its command handles — on /task", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "slug.ts", content: "export const slug = (s: string) => s;\n" } });
    stub.enqueue({ kind: "text", text: "Added the slug helper." });
    const turnStarted = p.output().length;
    p.writeLine("add a slug helper");
    await p.waitFor(/turn complete|needs attention|verification (needed|not run)/, { timeoutMs: 30_000, since: turnStarted });
    await p.waitFor(PROMPT, { timeoutMs: 20_000, since: turnStarted });

    const before = p.output().length;
    p.writeLine("/task");
    await p.waitFor(/changed .* \/diff/, { timeoutMs: 20_000, since: before });
    const view = plain(p.output().slice(before));
    expect(view).toContain("add a slug helper");
    expect(view).toContain("slug.ts");
    expect(view).toMatch(/changed .* \/diff .* \/undo/);
  }, 60_000);

  it("remembers a fact typed with # and keeps it in a file the user can read", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    p.writeLine("# we use bun, not npm");
    await p.waitFor(/remembered/, { timeoutMs: 20_000 });
    const stored = await readFile(path.join(cwd, ".archymedes", "memory.md"), "utf8");
    expect(stored).toContain("- we use bun, not npm");

    const before = p.output().length;
    p.writeLine("/memory");
    await p.waitFor(/project memory/, { timeoutMs: 20_000, since: before });
    expect(p.output().slice(before)).toContain("we use bun, not npm");
  }, 60_000);

  it("draws with ASCII only when the terminal is declared unable to do better", async () => {
    const p = boot({ args: ["--ascii"] });
    // Waits for the input bar, which is the last thing drawn — assert any earlier and the banner
    // may not have finished printing, so "no non-ASCII yet" would mean "not yet drawn".
    //
    // It waits on the *bar*, not on "auto >", because the prompt has not looked like that since the
    // input line gained a box: the mode moved to the status line and the caret now sits inside a
    // frame, as `| >`. The old pattern could therefore never match, and the test timed out for
    // thirty seconds before failing — reported as a broken ASCII mode when ASCII mode was fine.
    // Both cells are coloured separately, hence the escapes between them.
    await p.waitFor(/\|(?:\x1b\[[0-9;]*m)*\s*(?:\x1b\[[0-9;]*m)*>/, {
      timeoutMs: 30_000,
    });
    const banner = p.output();
    // Nothing above the ASCII range reaches a terminal that asked for ASCII.
    const nonAscii = [
      ...new Set(
        [...banner].filter(
          (character) => (character.codePointAt(0) ?? 0) > 127,
        ),
      ),
    ];
    expect(nonAscii).toEqual([]);
  }, 60_000);

  it("draws a PNG named to /cat in the fixed workspace, as coloured half-blocks", async () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4, 0);
    header.writeUInt32BE(4, 4);
    header[8] = 8;
    header[9] = 6;
    const chunk = (type: string, data: Buffer) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, "ascii");
      data.copy(out, 8);
      return out;
    };
    const raw = Buffer.from(Array.from({ length: 4 }, () => [0, ...Array.from({ length: 4 }, () => [255, 64, 0, 255]).flat()]).flat());
    await writeFile(path.join(cwd, "logo.png"), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]));
    const p = boot({ env: { COLORTERM: "truecolor", NO_COLOR: undefined } });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const before = p.output().length;
    p.writeLine("/cat logo.png");
    await p.waitFor(/4×4/, { timeoutMs: 20_000, since: before });
    await p.waitFor("\x1b[38;2;255;64;0m", { timeoutMs: 20_000, since: before });
    expect(p.output().slice(before)).toContain("▀");
  }, 60_000);

  it("reports and changes the spending pace without ending the session", async () => {
    const p = boot({ args: ["--slow"] });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const before = p.output().length;
    p.writeLine("/slow");
    await p.waitFor(/model rounds/, { timeoutMs: 20_000, since: before });

    const afterShow = p.output().length;
    p.writeLine("/slow off");
    await p.waitFor(/full speed/, { timeoutMs: 20_000, since: afterShow });
  }, 60_000);
});
