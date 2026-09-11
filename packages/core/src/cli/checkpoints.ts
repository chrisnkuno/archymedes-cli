import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Undo for an agent that edits real files.
 *
 * Both Cline and OpenCode converged on snapshotting the workspace around every effectful step, and
 * OpenCode's mechanism is the one used here: git's plumbing (`write-tree`/`read-tree`) against a
 * private index file. It is the right tool because the repository already stores content
 * efficiently, and because a snapshot costs one tree object rather than a copy of the workspace.
 *
 * The private index (`GIT_INDEX_FILE`) is what keeps this invisible: staging the workspace into
 * Archymedes's own index never touches the user's staged changes, so a checkpoint taken mid-review does
 * not silently `git add` their work.
 */

/**
 * Archymedes's own state is excluded from every snapshot.
 *
 * `.archymedes` holds the checkpoint index itself and the session transcripts, and it lives inside the
 * workspace. Staging it means git writes the index file into the tree it is currently building —
 * which corrupts it ("index file smaller than expected") — and restoring then deletes the session
 * history along with the code. Both were observed before this exclusion existed.
 */
const EXCLUDE_ARCHYMEDES = [".", ":(exclude).archymedes"];

export type Checkpoint = {
  /** Tree object id — the workspace content at this moment. */
  tree: string;
  label: string;
  createdAt: number;
  /** The turn this checkpoint was captured before, so it can be cross-referenced against the journal. */
  turnId: string;
  /**
   * How many messages the conversation held at capture time.
   *
   * The number, not a copy of the messages themselves — `ArchymedesAgent` already holds the transcript
   * and is the only thing that can safely truncate it back to this point, in step with its own
   * session file and journal. A checkpoint's job is to remember *where* to cut, not to carry a
   * second copy of what gets cut.
   */
  messageCount: number;
};

export type GitRunner = (args: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const runGit: GitRunner = (args, options) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

export class CheckpointStore {
  private readonly checkpoints: Checkpoint[] = [];

  constructor(
    private readonly root: string,
    private readonly indexFile: string,
    private readonly git: GitRunner = runGit,
  ) {}

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** True when this workspace is a git repository, which is the only place checkpoints work. */
  async isAvailable(): Promise<boolean> {
    const result = await this.git(["rev-parse", "--git-dir"], { cwd: this.root });
    return result.exitCode === 0;
  }

  /**
   * Snapshots the current workspace.
   *
   * Returns undefined rather than throwing when checkpointing is impossible (no repository, git
   * missing): losing undo is a reduction in comfort, and failing the user's task over it would be
   * a reduction in function.
   */
  async capture(label: string, turnId: string, messageCount: number): Promise<Checkpoint | undefined> {
    // git cannot create its index inside a directory that does not exist, so on a brand-new
    // project the very first capture failed and the first turn silently had no undo — the one
    // turn where a user is most likely to want it.
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true }).catch(() => undefined);
    const env = { GIT_INDEX_FILE: this.indexFile };
    const added = await this.git(["add", "--all", "--", ...EXCLUDE_ARCHYMEDES], { cwd: this.root, env });
    if (added.exitCode !== 0) return undefined;
    const tree = await this.git(["write-tree"], { cwd: this.root, env });
    if (tree.exitCode !== 0) return undefined;
    const checkpoint = { tree: tree.stdout.trim(), label, createdAt: Date.now(), turnId, messageCount };
    if (!checkpoint.tree) return undefined;
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Restores the workspace to a checkpoint.
   *
   * `read-tree -u --reset` only removes files the index knows about, so the staging step is not
   * optional: without it, a file the agent *created* after the snapshot is untracked in Archymedes's
   * private index and survives the undo. That was the actual behaviour before this step existed —
   * modified files reverted, newly created ones stayed, and the workspace ended up in a state that
   * had never existed. Staging first makes every new file known, so `--reset` can remove it.
   */
  async restore(tree: string): Promise<boolean> {
    const env = { GIT_INDEX_FILE: this.indexFile };
    const staged = await this.git(["add", "--all", "--", ...EXCLUDE_ARCHYMEDES], { cwd: this.root, env });
    if (staged.exitCode !== 0) return false;
    const result = await this.git(["read-tree", "-u", "--reset", tree], { cwd: this.root, env });
    return result.exitCode === 0;
  }

  /** The most recent checkpoint taken before the current step, for `/undo`. */
  latest(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /**
   * The actual patch since the last checkpoint, for `/diff`.
   *
   * Three lines of context rather than git's default of three-with-function-headers off: the
   * function header (`-W` would give the whole function) is what makes a hunk locatable without
   * opening the file, and costs one line per hunk.
   */
  async diffPatch(): Promise<string> {
    return this.diff(["--unified=3", "--no-color"]);
  }

  /** A stat summary of what changed since the last checkpoint, for `/diff`. Empty before any turn. */
  async diffStat(): Promise<string> {
    return (await this.diff(["--stat"])).trim();
  }

  private async diff(format: string[]): Promise<string> {
    const checkpoint = this.latest();
    if (!checkpoint) return "";
    // Include newly created files without changing the user's staging area or racing the
    // checkpoint index. Seed from the snapshot so tracked files remain tracked if now ignored.
    const index = `${this.indexFile}.diff-${randomUUID()}`;
    const options = { cwd: this.root, env: { GIT_INDEX_FILE: index } };
    try {
      if ((await this.git(["read-tree", checkpoint.tree], options)).exitCode !== 0) return "";
      if ((await this.git(["add", "--all", "--", ...EXCLUDE_ARCHYMEDES], options)).exitCode !== 0) return "";
      const result = await this.git(["diff", "--cached", ...format, checkpoint.tree, "--", ...EXCLUDE_ARCHYMEDES], options);
      return result.exitCode === 0 ? result.stdout : "";
    } finally {
      await fs.unlink(index).catch(() => undefined);
    }
  }
}
