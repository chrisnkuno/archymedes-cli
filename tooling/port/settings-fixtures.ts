/**
 * WS-50.2: captures the TypeScript settings catalog for the Go port, once.
 *
 *   bun run tooling/port/settings-fixtures.ts
 *
 * Writes internal/core/settings/testdata/{rows,validate}.json: the rows `listSettings` returns
 * with nothing stored, and what `validateSetting` answers for inputs that reach every branch. The
 * Go package is tested against them, so the contract outlives the TypeScript code (deleted in
 * WS-50.10, with this script).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { listSettings } from "../../packages/friday-cli/src/server/settings";
import { SETTING_FIELDS, validateSetting, type SettingKey } from "../../packages/friday-cli/src/platform/settings";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../internal/core/settings/testdata");
mkdirSync(out, { recursive: true });

const empty = mkdtempSync(path.join(os.tmpdir(), "friday-settings-"));
const { rows } = await listSettings({ ARCHYMEDES_CONFIG_DIR: empty });
// Theme choices come from the interface's own themes in Go; the rest is the contract.
const contract = rows.map(({ value: _value, isSet: _isSet, overriddenByEnvironment: _o, ...row }) =>
  row.key === "ARCHYMEDES_THEME" ? { ...row, choices: undefined, kind: "text" } : row);
writeFileSync(path.join(out, "rows.json"), `${JSON.stringify(contract, null, 2)}\n`);

const inputs = [
  "", "  ON ", "off", "bogus", "auto", "ask", "always", "install", "high", "theme",
  "https://Api.Example.com/v1/", "https://x.y", "http://localhost:11434/v1", "http://x.y", "not a url",
  "rw", "XX", "ke", "usd", "eur", "zzz", "-1", "0.5", "2", "12.75", "1000", "abc",
  "openrouter/free", "a/b:free", "gpt-4", "openai:gpt-5", "groq/llama", "nope:x",
  "Dark_1", "bad theme", "GO", "ts", "claude", "Codex", "groq", "fr", "xx",
];
const cases: Array<{ key: string; input: string; value?: string; error?: string }> = [];
for (const field of SETTING_FIELDS) {
  for (const input of inputs) {
    try {
      cases.push({ key: field.key, input, value: validateSetting(field.key as SettingKey, input) });
    } catch (error) {
      cases.push({ key: field.key, input, error: (error as Error).message });
    }
  }
}
writeFileSync(path.join(out, "validate.json"), `${JSON.stringify(cases)}\n`);
console.log(`${contract.length} rows, ${cases.length} validation cases → ${out}`);
