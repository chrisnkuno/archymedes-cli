import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnArchymedes } from "./harness";
import { SETTING_FIELDS } from "../platform/settings";

/**
 * Navigating settings with the arrow keys, against a real terminal.
 *
 * The chooser's logic is unit-tested; what only a pty can show is that the keys reach it. Arrow
 * keys arrive as escape sequences that readline would otherwise read as history recall, so "the
 * menu moved" is a claim about borrowing the keyboard correctly, not about the state machine.
 */

const ESCAPE = String.fromCharCode(27);
const DOWN = `${ESCAPE}[B`;
const UP = `${ESCAPE}[A`;
const ENTER = "\r";
/** Arrow presses from the top of the field list to a setting — derived, so reordering the menu cannot silently retarget a test. */
const downTo = (key: string) => DOWN.repeat(SETTING_FIELDS.findIndex((field) => field.key === key));

let stub: AnthropicStub; let cwd: string;
beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-arrows-"));
});
afterAll(async () => { await stub.close(); });

async function boot() {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-arrowscfg-"));
  const p = spawnArchymedes({ cwd, args: [], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
    ARCHYMEDES_CONFIG_DIR: configDir, ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC", ARCHYMEDES_FX_FROM: "USD", ARCHYMEDES_FX_TO: "RWF", ARCHYMEDES_FX_RATE: "1300",
  }});
  await p.waitFor(/›/, { timeoutMs: 30_000 });
  return { p, configDir };
}

describe("settings under a real pty", () => {
  it("opens as a navigable list showing each setting's current value", async () => {
    const { p } = await boot();
    const mark = p.output().length;
    p.write(`/settings${ENTER}`);
    const seen = await p.waitFor(/Enter edit/, { timeoutMs: 20_000, since: mark });
    // The first rows are the Appearance section, which is what most people open settings to change.
    expect(seen.slice(mark)).toContain("Appearance");
    expect(seen.slice(mark)).toContain("Theme");
    // Values are on the rows, so the menu answers "what is set?" without opening each field.
    expect(seen.slice(mark)).toContain("not set");
    p.kill();
  }, 90_000);

  it("moves the highlight with the arrow keys", async () => {
    const { p } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter edit/, { timeoutMs: 20_000 });

    const moved = p.output().length;
    p.write(DOWN);
    // Repainted with the cursor somewhere new — proof the escape sequence reached the chooser
    // rather than being read as history recall by readline.
    const seen = await p.waitFor(/❯/, { timeoutMs: 15_000, since: moved });
    expect(seen.slice(moved)).toContain("❯");
    p.kill();
  }, 90_000);

  it("picks a location from a named list, without anyone needing to know the code", async () => {
    const { p, configDir } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter edit/, { timeoutMs: 20_000 });

    // Location sits in the Money section; arrow down to it, then open it.
    const opened = p.output().length;
    p.write(`${downTo("ARCHYMEDES_COUNTRY")}${ENTER}`);
    // The country list, not the field list: both advertise filtering in their legends, so wait for
    // a row only the country list can show. Sorted by name, so the window opens on the A's — Rwanda
    // is below the fold, which is exactly why the list filters rather than expecting anyone to page
    // to it.
    await p.waitFor(/Australia \(AU\) — AUD/, { timeoutMs: 15_000, since: opened });

    // Type to narrow, then take it.
    const filtered = p.output().length;
    p.write("rwanda");
    // Lowercase, so this matches the echoed query rather than the "Rwanda (RW)" label. The styled
    // frame puts a reset sequence between "filter:" and the text, so the label is not anchored to.
    await p.waitFor(/rwanda/, { timeoutMs: 15_000, since: filtered });
    p.write(ENTER);
    // Back on the field list, with the location it just took shown on its row.
    const back = await p.waitFor(/Enter edit/, { timeoutMs: 15_000, since: filtered });
    expect(back.slice(filtered)).toContain("RW");

    // Leaving the menu is what saves and applies it.
    const left = p.output().length;
    p.write(ESCAPE);
    await p.waitFor(/settings saved/, { timeoutMs: 20_000, since: left });
    await p.waitFor(/costs now shown in RWF/, { timeoutMs: 20_000, since: left });
    p.kill();

    expect(JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"))).toMatchObject({ ARCHYMEDES_COUNTRY: "RW" });
  }, 120_000);

  it("still honours a typed number, the accessible path", async () => {
    // Arrows were added beside the numbers, not over them: a screen reader announces "2. Location"
    // perfectly well and a moving highlight badly.
    const { p } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter edit/, { timeoutMs: 20_000 });

    const jumped = p.output().length;
    p.write("2");
    await p.waitFor(/❯/, { timeoutMs: 15_000, since: jumped });
    p.write(ENTER);
    // Row 2 is Code colours, so typing its number opened the same list arrowing to it would have.
    // The field list itself advertises filtering too, so only a row of the opened list proves it.
    const seen = await p.waitFor(/VS Code colours/, { timeoutMs: 15_000, since: jumped });
    expect(seen.slice(jumped)).toContain("Dark+ or Light+");
    p.kill();
  }, 90_000);

  it("leaves the menu on Escape without saving a change nobody made", async () => {
    const { p } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter edit/, { timeoutMs: 20_000 });

    const dismissed = p.output().length;
    p.write(ESCAPE);
    const seen = await p.waitFor(/settings saved|›/, { timeoutMs: 20_000, since: dismissed });
    expect(seen.slice(dismissed)).not.toContain("cleared");
    p.kill();
  }, 90_000);

  it("returns to the field list after setting a value, rather than dropping out", async () => {
    const { p } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter edit/, { timeoutMs: 20_000 });

    const opened = p.output().length;
    p.write(`${downTo("ARCHYMEDES_PROVIDER")}${ENTER}`);  // Default provider
    // "Anthropic API key" is already visible in the parent list. Wait for a row unique to the
    // provider chooser so Enter cannot race the submenu opening and select the parent row again.
    await p.waitFor(/Clear this setting/, { timeoutMs: 15_000, since: opened });
    const chosen = p.output().length;
    p.write(ENTER);
    // Back on the field list, with the value it just took shown on the row.
    const seen = await p.waitFor(/Enter edit/, { timeoutMs: 15_000, since: chosen });
    expect(seen.slice(chosen)).toContain("Default provider");
    p.write(UP);
    p.kill();
  }, 90_000);
});
