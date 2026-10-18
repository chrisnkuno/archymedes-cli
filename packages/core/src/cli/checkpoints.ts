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
   * How many messages the conversation held at capture time; -1 once a compaction summarized that
   * point away, when only the files can be returned to it.
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

/**
 * Where a checkpoint's tree is kept reachable: one hidden ref per checkpoint, under the session.
 *
 * A tree that nothing points to is garbage to git: `git gc` prunes it once it is two weeks old (or
 * at once with `--prune=now`), and an undo that outlives the session needs the tree to still be
 * there. A ref outside `refs/heads` and `refs/tags` keeps it without showing up as a branch, in
 * `git log`, or in a push — the way T3 Code keeps its per-turn checkpoints.
 */
export const CHECKPOINT_REF_ROOT = "refs/archymedes/checkpoints";

export function checkpointRef(sessionId: string, index: number): string {
  return `${CHECKPOINT_REF_ROOT}/${sessionId}/${index + 1}`;
}

export class CheckpointStore {
  private checkpoints: Checkpoint[] = [];
  private seedAttempted = false;
  /** A `load` still checking its trees: a capture waits for it, so it cannot be overwritten. */
  private loading: Promise<void> = Promise.resolve();

  /**
   * @param session the id whose ref namespace the checkpoints are kept under; a function, since a
   *   resumed or forked session changes it after the store is built.
   */
  constructor(
    private readonly root: string,
    private readonly indexFile: string,
    private readonly git: GitRunner = runGit,
    private readonly session: () => string = () => "unsaved",
  ) {}

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /**
   * Takes over the checkpoints a stored session recorded, so `/undo` and rewinding work after a
   * resume. A tree git no longer has (a session from before refs were kept, then `git gc`) is left
   * out here rather than failing a restore later.
   */
  load(checkpoints: readonly Checkpoint[]): Promise<void> {
    this.loading = this.loading.then(() => this.loadNow(checkpoints));
    return this.loading;
  }

  private async loadNow(checkpoints: readonly Checkpoint[]): Promise<void> {
    const kept: Checkpoint[] = [];
    for (const checkpoint of checkpoints) {
      if ((await this.git(["cat-file", "-e", `${checkpoint.tree}^{tree}`], { cwd: this.root })).exitCode === 0) kept.push({ ...checkpoint });
    }
    this.checkpoints = kept;
    await this.keep();
  }

  /** The checkpoint at `index` (0 is the session's first turn). */
  at(index: number): Checkpoint | undefined {
    return Number.isInteger(index) ? this.checkpoints[index] : undefined;
  }

  /**
   * Forgets the checkpoint at `index` and every later one, with their refs: what rewinding to it
   * leaves behind. The state they recorded is in the past of a conversation that no longer exists.
   */
  async dropFrom(index: number): Promise<void> {
    if (index < 0 || index >= this.checkpoints.length) return;
    const dropped = this.checkpoints.length;
    this.checkpoints = this.checkpoints.slice(0, index);
    for (let position = index; position < dropped; position += 1) {
      await this.git(["update-ref", "-d", checkpointRef(this.session(), position)], { cwd: this.root });
    }
  }

  /**
   * Renumbers where each checkpoint cuts the conversation after a compaction rewrote its start.
   * `map` gives the new count for an old one, or -1 when that point now lies inside the summary.
   */
  remapMessages(map: (messageCount: number) => number): void {
    this.checkpoints = this.checkpoints.map((checkpoint) => ({ ...checkpoint, messageCount: checkpoint.messageCount < 0 ? -1 : map(checkpoint.messageCount) }));
  }

  /** Points this session's refs at its checkpoints (after a load, or a fork into a new id). */
  async keep(): Promise<void> {
    for (const [index, checkpoint] of this.checkpoints.entries()) {
      await this.git(["update-ref", checkpointRef(this.session(), index), checkpoint.tree], { cwd: this.root });
    }
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
    await this.loading;
    // git cannot create its index inside a directory that does not exist, so on a brand-new
    // project the very first capture failed and the first turn silently had no undo — the one
    // turn where a user is most likely to want it.
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true }).catch(() => undefined);
    const env = { GIT_INDEX_FILE: this.indexFile };
    const seeded = await this.seedIndex(env);
    let added = await this.git(["add", "--all", "--", ...EXCLUDE_ARCHYMEDES], { cwd: this.root, env });
    if (added.exitCode !== 0 && seeded) {
      // A seeded index git cannot use (split index, an unexpected format): start from empty instead.
      await fs.unlink(this.indexFile).catch(() => undefined);
      added = await this.git(["add", "--all", "--", ...EXCLUDE_ARCHYMEDES], { cwd: this.root, env });
    }
    if (added.exitCode !== 0) return undefined;
    const tree = await this.git(["write-tree"], { cwd: this.root, env });
    if (tree.exitCode !== 0) return undefined;
    const checkpoint = { tree: tree.stdout.trim(), label, createdAt: Date.now(), turnId, messageCount };
    if (!checkpoint.tree) return undefined;
    this.checkpoints.push(checkpoint);
    // Losing the ref costs only an undo after `git gc`; the checkpoint itself is still good now.
    await this.git(["update-ref", checkpointRef(this.session(), this.checkpoints.length - 1), checkpoint.tree], { cwd: this.root });
    return checkpoint;
  }

  /**
   * Makes the first capture incremental too.
   *
   * The private index is reused across turns, so from the second capture on `git add --all` only
   * re-hashes files whose stat data changed. The *first* capture used to start from an empty index
   * and hash every file in the workspace. Copying the repository's own index gives it the stat
   * cache git already maintains, so only files that differ from it are hashed; `add --all` then
   * brings every entry to the working tree, so the resulting tree is the same as from empty.
   * Done with the filesystem (no git call) and only for a plain `.git` directory; anything else
   * (worktrees, a missing index) keeps the original cold start. Returns whether it seeded.
   */
  private async seedIndex(env: Record<string, string>): Promise<boolean> {
    if (this.seedAttempted) return false;
    this.seedAttempted = true;
    if (await fs.stat(this.indexFile).then(() => true, () => false)) return false;
    try {
      await fs.copyFile(path.join(this.root, ".git", "index"), this.indexFile);
    } catch {
      return false;
    }
    // The user's index may track Friday's own state; the snapshot never includes it.
    const removed = await this.git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".archymedes"], { cwd: this.root, env });
    if (removed.exitCode !== 0) {
      await fs.unlink(this.indexFile).catch(() => undefined);
      return false;
    }
    return true;
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

  /**
   * What one turn changed: its checkpoint against the next one, or against the workspace for the
   * last turn. Empty when there is no such turn.
   */
  async turnPatch(index: number): Promise<string> {
    const checkpoint = this.at(index);
    if (!checkpoint) return "";
    const next = this.at(index + 1);
    if (!next) return this.diff(["--unified=3", "--no-color"], checkpoint);
    const result = await this.git(["diff", "--unified=3", "--no-color", checkpoint.tree, next.tree], { cwd: this.root });
    return result.exitCode === 0 ? result.stdout : "";
  }

  private async diff(format: string[], checkpoint = this.latest()): Promise<string> {
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
