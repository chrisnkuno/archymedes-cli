import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runControl, tokenEnvironment, type ControlContext, type Exec } from "./control";

const TOKEN = "ghs_SuperSecretInstallationToken123";
let root: string;
let remote: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-control-"));
  remote = path.join(root, "remote.git");
  cwd = path.join(root, "workspace", "app");
  const config = path.join(root, "gitconfig");
  // github.com/o/r is this directory: the clone, branch and push code paths run for real, offline.
  await fs.writeFile(config, `[user]\n\tname = Friday\n\temail = friday@example.com\n[init]\n\tdefaultBranch = main\n[url "${remote}"]\n\tinsteadOf = https://github.com/o/r\n`);
  env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "--bare", remote], { env });
  const seed = path.join(root, "seed");
  await fs.mkdir(seed);
  execFileSync("git", ["init"], { cwd: seed, env });
  await fs.writeFile(path.join(seed, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: seed, env });
  execFileSync("git", ["commit", "-m", "first"], { cwd: seed, env });
  execFileSync("git", ["push", remote, "HEAD:refs/heads/main"], { cwd: seed, env });
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const context = (overrides: Partial<ControlContext> = {}): ControlContext => ({ cwd, env, ...overrides });

describe("clone", () => {
  it("clones the repository into the agent's directory", async () => {
    const result = await runControl("clone", { url: "https://github.com/o/r", token: TOKEN }, context());
    expect(result).toEqual({ ok: true, detail: { dir: cwd } });
    expect(await fs.readFile(path.join(cwd, "README.md"), "utf8")).toBe("hello\n");
  });

  it("leaves no trace of the token in the repository", async () => {
    await runControl("clone", { url: "https://github.com/o/r", token: TOKEN }, context());
    const config = await fs.readFile(path.join(cwd, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(config).not.toContain("extraheader");
  });

  it("clones a named branch", async () => {
    git(root, "-C", remote, "branch", "release");
    const result = await runControl("clone", { url: "https://github.com/o/r", branch: "release" }, context());
    expect(result.ok).toBe(true);
    expect(git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
  });

  it("refuses anything that is not a github.com repository URL, before running git", async () => {
    const ran: string[][] = [];
    const exec: Exec = async (_file, args) => { ran.push([...args]); return { code: 0, stdout: "", stderr: "" }; };
    for (const url of ["/etc/passwd", "file:///etc", "https://evil.example/o/r", "https://github.com/o/r/../../x", "--upload-pack=touch /tmp/pwned", "git@github.com:o/r.git", "https://github.com/o", "http://github.com/o/r", "https://github.com.evil.com/o/r", ""]) {
      const result = await runControl("clone", { url }, context({ exec }));
      expect(result.ok, url).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it("refuses a branch name git would read as an option", async () => {
    for (const branch of ["--upload-pack=x", "-b", "a..b", "a b", "a:b", "a\\b", "x".repeat(300)]) {
      expect((await runControl("clone", { url: "https://github.com/o/r", branch }, context())).ok, branch).toBe(false);
    }
  });

  it("will not clone over work that is already there", async () => {
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "mine.txt"), "keep me");
    const result = await runControl("clone", { url: "https://github.com/o/r" }, context());
    expect(result).toEqual({ ok: false, detail: "the workspace is not empty" });
    expect(await fs.readFile(path.join(cwd, "mine.txt"), "utf8")).toBe("keep me");
  });

  it("reports a failed clone in words, with the token scrubbed from them", async () => {
    const exec: Exec = async () => ({ code: 128, stdout: "", stderr: `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/o/r/': 403 (Authorization: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")})` });
    const result = await runControl("clone", { url: "https://github.com/o/r", token: TOKEN }, context({ exec }));
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toContain("403");
    expect(String(result.detail)).not.toContain(TOKEN);
    expect(String(result.detail)).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
  });

  it("hands the token to git through its environment, never its arguments", async () => {
    const seen: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const exec: Exec = async (_file, args, options) => { seen.push({ args, env: options.env }); return { code: 0, stdout: "", stderr: "" }; };
    await runControl("clone", { url: "https://github.com/o/r", token: TOKEN }, context({ exec }));
    expect(seen).toHaveLength(1);
    expect(seen[0].args.join(" ")).not.toContain(TOKEN);
    expect(seen[0].args.join(" ")).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(seen[0].env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(seen[0].env.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(seen[0].env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("tokenEnvironment", () => {
  it("is empty without a token and scoped to github.com with one", () => {
    expect(tokenEnvironment(undefined)).toEqual({});
    expect(tokenEnvironment(TOKEN).GIT_CONFIG_KEY_0).toMatch(/^http\.https:\/\/github\.com\//);
  });
});

describe("branch, status and push", () => {
  beforeEach(async () => {
    await runControl("clone", { url: "https://github.com/o/r" }, context());
  });

  it("makes the working branch, and reports status on it", async () => {
    expect(await runControl("branch", { name: "friday/fix-login" }, context())).toEqual({ ok: true, detail: { branch: "friday/fix-login" } });
    const status = await runControl("status", {}, context());
    expect(status.ok).toBe(true);
    expect(String(status.detail)).toContain("## friday/fix-login");
    await fs.writeFile(path.join(cwd, "new.txt"), "x");
    expect(String((await runControl("status", {}, context())).detail)).toContain("?? new.txt");
  });

  it("refuses a branch name git would read as an option", async () => {
    for (const name of ["--orphan", "-f", "a..b", "a b", "~x", "x^", ""]) {
      expect((await runControl("branch", { name }, context())).ok, name).toBe(false);
    }
  });

  it("pushes the branch to origin", async () => {
    await runControl("branch", { name: "friday/work" }, context());
    await fs.writeFile(path.join(cwd, "feature.txt"), "feature\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "feature");
    const result = await runControl("push", { branch: "friday/work", token: TOKEN }, context());
    expect(result.ok, String(result.detail)).toBe(true);
    expect(git(root, "-C", remote, "branch", "--list", "friday/work")).toContain("friday/work");
    expect(await fs.readFile(path.join(cwd, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  it("will not push without a token, or a safe branch name", async () => {
    expect((await runControl("push", { branch: "main" }, context())).detail).toBe("push needs a token");
    expect((await runControl("push", { branch: "--delete", token: TOKEN }, context())).ok).toBe(false);
    expect((await runControl("push", { token: TOKEN }, context())).ok).toBe(false);
  });

  it("refuses an operation it does not know", async () => {
    expect(await runControl("rm-rf", {}, context())).toEqual({ ok: false, detail: "unknown operation 'rm-rf'" });
  });
});
