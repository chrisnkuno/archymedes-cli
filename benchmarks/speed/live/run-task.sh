#!/bin/bash
# One live run of a benchmark task against a real model, in a fresh directory, with an objective pass/fail.
#
#   benchmarks/speed/live/run-task.sh <wordcount|debug> <model> <effort|default|auto> [seconds]
#
# Prints one line: task, model, effort, PASS/FAIL, wall seconds, and where the event log is. Run
# `bun run benchmarks/speed/analyze-session.ts <log>` on the log for the model/tool split and the
# effort the agent chose on each call. Interleave settings and repeat: single runs vary by 2-4x.
#
# Spends free requests (about 15-40 a run); the free tier allows 1000 a day per key.
set -u
TASK="${1:?task: wordcount or debug}"; MODEL="${2:?model, e.g. cohere/north-mini-code:free}"; EFFORT="${3:-default}"; LIMIT="${4:-290}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${BENCH_DIR:-${TMPDIR:-/tmp}/archymedes-bench}"; NAME="$(echo "$TASK-$MODEL-$EFFORT" | tr '/:' '__')"
DIR="$OUT/$NAME"; rm -rf "$DIR"; mkdir -p "$DIR"; LOG="$OUT/$NAME.jsonl"

case "$TASK" in
  wordcount)
    PROMPT="Create a small Node.js CLI in this directory: wordcount.js prints the number of lines, words and characters of the file given as its argument (like wc), and exports a function countText(text) that returns {lines, words, chars}. Add test.js using node:test that covers it. Run 'node --test' and make sure it passes." ;;
  debug)
    cp "$HERE/debug-fixture/util.js" "$DIR/util.js"; cp "$HERE/debug-fixture/util.test.js.fixture" "$DIR/util.test.js"
    SUM="$(sha256sum "$DIR/util.test.js" | cut -c1-16)"
    PROMPT="Running 'node --test' in this directory fails. Find out why and fix the code in util.js. Do not change util.test.js." ;;
  *) echo "unknown task $TASK" >&2; exit 2 ;;
esac
(cd "$DIR" && git init -q && git add -A 2>/dev/null; git -c user.email=b@b -c user.name=b commit -qm seed --allow-empty)

cd "$REPO"
if [ "$EFFORT" = default ]; then unset ARCHYMEDES_REASONING; else export ARCHYMEDES_REASONING="$EFFORT"; fi
START=$(date +%s)
FREE_MODEL="$MODEL" timeout "$LIMIT" bun run packages/friday-cli/src/friday.ts --free --auto --cwd "$DIR" --json "$PROMPT" > "$LOG" 2>/dev/null
END=$(date +%s)

cd "$DIR"
if [ "$TASK" = debug ]; then
  [ "$(sha256sum util.test.js | cut -c1-16)" = "$SUM" ] && node --test >/dev/null 2>&1 && RESULT=PASS || RESULT=FAIL
else
  [ -f wordcount.js ] && [ -f test.js ] && node --test >/dev/null 2>&1 && RESULT=PASS || RESULT=FAIL
fi
echo "$TASK $MODEL $EFFORT $RESULT wall=$((END-START))s log=$LOG"
