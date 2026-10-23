# Extending the engine

How to add to the Go engine without breaking what it promises. Read
[Architecture](ARCHITECTURE.md) first; the working method (track, change in compartments, recheck)
is [`docs/continuation/WORKFLOW.md`](../continuation/WORKFLOW.md).

- [Ground rules](#ground-rules)
- [Add a tool](#add-a-tool)
- [Add a built-in role](#add-a-built-in-role)
- [Add a provider](#add-a-provider)
- [Add an ACP method or session command](#add-an-acp-method-or-session-command)
- [Add an event](#add-an-event)
- [Port a TypeScript feature](#port-a-typescript-feature)
- [Make a session fall back to TypeScript](#make-a-session-fall-back-to-typescript)
- [Tests to write](#tests-to-write)
- [Checklist](#checklist)

## Ground rules

Everything below is built to [the mechanism design system](../mechanisms/README.md): its names,
words and measures are checked by `go test -run '^TestConform' ./...`, which `bun run recheck` runs
every time.

- **Same meaning on both engines.** A mode, an approval, a tool name and its arguments, an event's
  JSON: the TypeScript agent is the reference until a feature is ported. The interface must not be
  able to tell the engines apart. When the meaning must change, change both.
- **Layering is enforced.** Each `internal/core/<pkg>` may import only what
  `tooling/check/go-sections.json` lists for `core/<pkg>`. A new dependency between packages is a
  design change: update the matrix, [Architecture](ARCHITECTURE.md#packages) and
  [`GO_ENGINE.md`](../continuation/GO_ENGINE.md) together.
- **No file over 800 lines** (the `size` guard). Split by what the parts do.
- **Never quietly drop a limit.** A flag, setting or rule the engine cannot honour is refused, or
  sends the session to the TypeScript engine; it is never ignored.
- **Every user-visible word says what it does.** Command descriptions, tool descriptions, error
  messages: a reader who has not read the docs should know what happens and what to do next.

## Add a tool

1. Write it in `internal/core/tools/` as a method on `*Workspace` returning `*tool.Tool`, in the file
   of its family (or a new `<family>.go`):

```go
func (w *Workspace) countLines() *tool.Tool {
	return &tool.Tool{
		Name:        "count_lines",
		Description: "Count the lines of a file. Use it before reading a very large file in windows.",
		Schema: tool.ObjectSchema(map[string]any{
			"path": map[string]any{"type": "string"},
		}, "path"),
		Capability:   tool.CapRead,      // which modes have it (policy.CapabilitiesForMode)
		Effect:       tool.EffectNone,   // none: never asks; workspace: asks; external: asks
		ParallelSafe: true,              // may run beside other effect-free calls in one step
		Run: func(ctx context.Context, tc tool.Context, args tool.Args) tool.Result {
			abs, rel, err := w.resolve(tool.StringArg(args, "path")) // refuses paths outside the project
			if err != nil {
				return tool.Error(err.Error())
			}
			// … do the work; respect ctx for anything slow …
			return tool.Result{Content: rel + ": 42 lines", Data: map[string]any{"path": rel, "lines": 42}}
		},
	}
}
```

2. Add it to `Builtins()` in `workspace.go`.
3. Decide:
   - **Effect.** If whether it changes something depends on its arguments, set `EffectFor` (see
     `run_command`): the ledger and the loop's batching use the per-call effect.
   - **Errors are results.** Return `tool.Error("what went wrong and what to do")`; never panic
     (the loop recovers a panic into an error result, but the message is worse).
   - **Evidence.** If a successful run proves something works, set `Result.Evidence`
     (`tool.EvidenceCheck` < `Tests` < `Smoke` < `Behavior`); if it can fail as a test run, set
     `Data["verificationKind"]` so the gate can see red.
   - **Deferred?** If most turns never need it, add its name to `rarelyNeeded` in
     `agents/session.go`; it is then found with `tool_search`.
   - **Sub-agents.** Read-only roles get it only if its effect is none and it is parallel-safe;
     role files can name it in `tools:`. If no sub-agent should ever have it, add it to
     `roles.NeverDelegated`.
4. Interface: for the card to show what the call is about ("count lines src/app.go"), add a case
   for the tool to `DescribeToolCall` in `internal/render/toolcall.go`. Editors get a title from
   the first of `path`, `command`, `pattern`, `query`, `task` it has (`server.toolTitle`).
5. Document it in [Tools](TOOLS.md).

## Add a built-in role

Add a `Profile` to `builtIn()` in `internal/core/roles/roles.go`: name, a description the model
reads beside the name, instructions, `ReadOnly`, `Model` (`ModelMain` or `ModelSmall`), limits, and
`Tools` (an allow list) or `Without` (a deny list). Extend `DelegationGuidance` if the main
conversation needs to know when to use it. Document it in [Sub-agents](SUBAGENTS.md#roles). A role
a project needs but Friday should not ship is a role file, not a built-in.

## Add a provider

1. Add a `Provider` to `llm.Providers` in `providers.go` in the TypeScript agent's catalog order:
   id, label, required variables, default model, `Kind`, and `BaseURL` for a compatible endpoint.
   Keep it identical to `packages/core/src/providers/provider-specs.ts` and `agent-matrix.ts`.
2. If it speaks Chat Completions, `KindCompatible` is all it needs. Otherwise add a case to
   `OpenModel` in `models.go`. Prefer a small native client (as `anthropic.go`) over a dependency
   that brings SDKs Friday does not use; check the binary size before and after
   (`go build -trimpath -ldflags="-s -w"`).
3. A native client must stream, yielding text, tool-call start, input deltas, the tool call, and a
   finish with usage. It yields a keepalive for events that carry nothing; the idle watchdog depends
   on it. It returns failures as `*fantasy.ProviderError` with `StatusCode`, lower-cased
   `ResponseHeaders`, and `ContextTooLargeErr` when the provider says the prompt is too long.
4. Tests: `llm_test.go` for selection, an `httptest` server replaying the provider's real stream for
   the client (see `anthropic_test.go`).
5. Document it in [Configuration](CONFIGURATION.md#providers-and-keys).

## Add an ACP method or session command

- **A method**: a case in `server.dispatch` (`methods.go`) and a handler. A method that only reads
  or writes shared settings can stay forwarded (`forwarded`). Add the client call to
  `internal/acp/client.go` if the interface needs it. Document it in [Protocol](PROTOCOL.md).
- **A session command** (`/name` in the interface): a case in `server.command`, replying with a
  `kind` the interface already renders (`text`, `todos`, `diff`, `turns`, `review`, `error`).
  Register the interface's side in `internal/tui/cmd_registry.go` (one row: name, argument hint, a
  description that says what it does) with its handler in the `cmd_` file of its family.
- `prompt` is special: it is accepted on the reading goroutine (`acceptPrompt`), so its order and
  cancel behaviour hold. Anything else that must keep its place in line goes through
  `Session.inTurn` (as `/compact` does).

## Add an event

Runtime events are `loop.Event`, whose JSON is the TypeScript runtime's `AgentRuntimeEvent`. A new
event type must be added to the TypeScript side's type too, or the interface must tolerate it
(`internal/acp/types.go` `RuntimeEvent`, `internal/tui/core_events.go`). Session-level events are
`agents.Notice` kinds, turned into `_archymedes/event` by `server.extensionEvent`. Document both in
[Protocol](PROTOCOL.md#extension-events).

## Port a TypeScript feature

1. Find the TypeScript module and its tests. Port the tests first: the cases are the specification.
2. Keep names, texts the model reads, argument names and JSON shapes; change only what Go requires.
   Where JavaScript and Go differ (regular expressions, sorting, number formatting), make the Go
   behave like the JavaScript and test the difference against Node.
3. Remove it from "not in the Go engine yet": the list in [README](README.md#what-the-go-engine-does-not-have-yet),
   [`GO_ENGINE.md`](../continuation/GO_ENGINE.md), and, if it was a reason to fall back, the rule in
   `chooseEngine` and its test.
4. Record it in the tracker.

## Make a session fall back to TypeScript

When a session needs something the Go engine cannot do yet, add a rule to `chooseEngine` in
`cmd/friday/engine.go` with a `why` a person can read, and a case to
`TestTheGoEngineIsTheDefaultAndTheTypeScriptOneTakesWhatOnlyItCanDo`. A flag the engine cannot
honour belongs in `engineOptions`, which refuses it (and so falls back). Document it in the
[README table](README.md#which-engine-runs).

## Tests to write

| Change | Test |
| --- | --- |
| A tool | its behaviour, refusals and limits in `tools_test.go`; its effect per call |
| Policy | table cases ported from TypeScript, plus Node-checked cases for any rewrite |
| The loop | a scripted model (`loop_test.go`): the events, the result, what the next request contained |
| The coordinator | the fake model harness (`agents/fake_test.go`); `-race`, and `-count=10` for anything timing-related |
| The protocol | `cmd/friday/engine_test.go`, through `acp.Client`, as the interface uses it |
| What a person sees | `packages/friday-cli/src/pty/go-engine.test.ts`, the real binary against a stub |
| A provider | an `httptest` server replaying the real stream; and once, live, with `FRIDAY_LIVE=1` |

A test that depends on goroutine timing must wait for the condition it checks (`waitUntil`), never
for a status that is set a moment before it.

## Checklist

- [ ] Task added to the tracker before the code
- [ ] `go test -race ./internal/core/... ./cmd/friday` and `bun run recheck` pass
- [ ] Layering matrix and docs updated if a package dependency changed
- [ ] Both engines mean the same thing, or the difference is documented
- [ ] User-visible words say what happens and what to do
- [ ] Docs in `docs/engine/` updated; evidence recorded in the tracker
