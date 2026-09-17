import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPromptCommand, parsePromptCommand, projectCommandsDirectory, resolvePromptCommand, userCommandsDirectory } from "./prompt-commands";

let root: string;
let environment: Record<string, string | undefined>;
const builtIn = (name: string) => name === "/undo" || name === "/help";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-commands-"));
  environment = { ARCHYMEDES_CONFIG_DIR: path.join(root, "config") };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function write(directory: string, name: string, content: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), content);
}

describe("custom slash commands", () => {
  it("reads a description from front matter and keeps the body as the prompt", () => {
    const command = parsePromptCommand("review", "---\ndescription: \"Review a diff for risk\"\n---\nReview $ARGUMENTS for data loss.\r\n", "project", "x");
    expect(command).toMatchObject({ description: "Review a diff for risk", template: "Review $ARGUMENTS for data loss." });
    expect(parsePromptCommand("plain", "Just a prompt", "user", "y")).toMatchObject({ description: "", template: "Just a prompt" });
  });

  it("substitutes arguments, or appends them when there is no placeholder", () => {
    const withPlaceholder = parsePromptCommand("r", "Review $ARGUMENTS, then $ARGUMENTS again", "user", "");
    expect(expandPromptCommand(withPlaceholder, "  src/auth.ts ")).toBe("Review src/auth.ts, then src/auth.ts again");
    const without = parsePromptCommand("t", "Write tests.", "user", "");
    expect(expandPromptCommand(without, "for parser.ts")).toBe("Write tests.\n\nfor parser.ts");
    expect(expandPromptCommand(without, "")).toBe("Write tests.");
  });

  it("resolves a project command over a user command, and never replaces a built-in", async () => {
    await write(userCommandsDirectory(environment), "review.md", "user version $ARGUMENTS");
    await write(userCommandsDirectory(environment), "undo.md", "sneaky");
    await write(projectCommandsDirectory(root), "review.md", "project version $ARGUMENTS");
    await write(projectCommandsDirectory(root), "Bad Name.md", "x");

    const resolved = await resolvePromptCommand("/review the login flow", root, environment, builtIn);
    expect(resolved).toMatchObject({ prompt: "project version the login flow", command: { source: "project" } });

    const missing = await resolvePromptCommand("/undo", root, environment, builtIn);
    expect(missing).toMatchObject({ names: ["/review"] });
    const problems = "problems" in missing ? missing.problems.join("\n") : "";
    expect(problems).toContain("/undo is a built-in command");
    expect(problems).toContain("lowercase letters, digits and dashes");
  });

  it("treats a missing directory as no commands, and skips oversized or empty files", async () => {
    expect(await resolvePromptCommand("/nothing", root, environment, builtIn)).toEqual({ problems: [], names: [] });
    await write(projectCommandsDirectory(root), "huge.md", "x".repeat(70 * 1024));
    await write(projectCommandsDirectory(root), "empty.md", "---\ndescription: nothing\n---\n");
    const result = await resolvePromptCommand("/huge", root, environment, builtIn);
    expect("problems" in result && result.problems.join("\n")).toMatch(/huge\.md: larger than 64 KB[\s\S]*empty\.md: empty|empty\.md: empty[\s\S]*huge\.md: larger/);
  });
});
