/**
 * Ctrl-C interrupts the turn rather than the process, so a long tool loop can be stopped without
 * losing the session that produced it.
 *
 * Moved out of `main()` unchanged.
 */
import type { Interface } from "node:readline/promises";
import type { SessionState } from "./session-state";
import { activity, out, spinner, statusBar, style } from "./transcript";

export function createSigintHandling(options: {
  readline: Interface;
  state: Pick<SessionState, "turnActive" | "agent" | "currentTurnAbort" | "pendingReadAbort" | "exitRequested">;
  /** The session's teardown as it is when Ctrl+C arrives on an empty prompt. */
  exitCleanly: () => void;
}): { bindSigint: () => void; unbindSigint: () => void } {
  const { readline, state } = options;
  const handleSigint = () => {
    if (state.turnActive) {
      state.agent.cancel();
      // `agent.cancel()` alone only flips a flag `BoundedAgentRuntime` checks between steps. If
      // this turn is actually blocked inside the approval prompt's `readline.question()` — not a
      // step the runtime loop is between — nothing else would ever unblock it.
      state.currentTurnAbort?.abort();
      activity.awaitingFirstDelta = false;
      spinner?.stop();
      statusBar.clear();
      const stopping = activity.phase === "operation" ? "stopping the current tool" : "stopping the current model request";
      out.write(style.yellow(`\n  interrupted — ${stopping}\n`));
      return;
    }
    if (state.pendingReadAbort) {
      state.pendingReadAbort.abort();
      state.pendingReadAbort = undefined;
      return;
    }
    // Nothing is running, so this is the prompt. A half-typed message must survive a stray
    // Ctrl+C: every other REPL (bash, python, node) clears the line here rather than quitting,
    // and losing a paragraph you were still composing to one keystroke is the worst possible
    // reading of "I changed my mind". Only an already-empty line means the session itself.
    const pending = (readline as { line?: string }).line ?? "";
    if (pending !== "") {
      // Kill to the start of the line and then to the end, so the line clears whole wherever the
      // cursor happened to sit. Both are ordinary `rl.write(null, key)` calls — the public API —
      // rather than a reach into readline's private redraw internals.
      readline.write(null, { ctrl: true, name: "u" });
      readline.write(null, { ctrl: true, name: "k" });
      return;
    }
    state.exitRequested = true;
    options.exitCleanly();
  };
  // Node's readline puts a TTY into raw mode, which disables the kernel's own ISIG handling — so a
  // real Ctrl+C keypress in an interactive session never reaches the process as an OS signal at
  // all; readline reads the byte itself and re-emits it as the *interface's* own "SIGINT" event.
  // `process`'s "SIGINT" only fires for a genuine external signal (`kill -INT`, a piped/non-TTY
  // run). Both are registered so either source reaches the same handler.
  const bindSigint = () => { process.on("SIGINT", handleSigint); readline.on("SIGINT", handleSigint); };
  const unbindSigint = () => { process.off("SIGINT", handleSigint); readline.off("SIGINT", handleSigint); };
  return { bindSigint, unbindSigint };
}
