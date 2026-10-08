import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "../cli/backends";
import { SkillToolProvider } from "./provider";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-skills-provider-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const validSchema = { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"], additionalProperties: false as const };

describe("SkillToolProvider", () => {
  it("executes a skill's command through the workspace and reports real stdout/exit code", async () => {
    await fs.mkdir(path.join(root, ".archymedes/skills/greet"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".archymedes/skills/greet/skill.json"),
      // `echo` is a cmd builtin on Windows, not a program, so it needs `cmd /c` there; Unix has it on PATH.
      JSON.stringify({ name: "greet", description: "Greets someone by name.", command: process.platform === "win32" ? "cmd /c echo hello world" : "echo hello world", inputSchema: validSchema }),
    );
    const provider = new SkillToolProvider("local-skills", ".archymedes/skills", new LocalWorkspace(root));
    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    const result = await tools[0].invoke({ name: "world" });
    expect(result).toEqual({ content: "exit 0\nhello world", isError: false });
  });

  it("rejects arguments the skill's own schema does not accept, before the command ever runs", async () => {
    await fs.mkdir(path.join(root, ".archymedes/skills/greet"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".archymedes/skills/greet/skill.json"),
      JSON.stringify({ name: "greet", description: "d", command: "cmd /c echo hello world", inputSchema: validSchema }),
    );
    const provider = new SkillToolProvider("local-skills", ".archymedes/skills", new LocalWorkspace(root));
    const [tool] = await provider.listTools();
    await expect(tool.invoke({})).rejects.toThrow(/requires name/);
  });
});
