# Protocol reference

What the Go engine speaks: ACP version 1 over JSON-RPC 2.0, one message per line, plus the
`_archymedes/*` extension the Friday interface uses. The TypeScript agent speaks the same, so a
client cannot tell the engines apart except by `_meta.archymedes.engine` (`"go"`) in session info.

Source: `internal/core/server/` (`server.go` framing and dispatch, `methods.go` methods, `ask.go`
requests to the client, `events.go` notifications). The client side the interface uses is
`internal/acp/`.

- [Framing](#framing)
- [Client → engine methods](#client--engine-methods)
- [Forwarded methods](#forwarded-methods)
- [Engine → client requests](#engine--client-requests)
- [Notifications](#notifications)
- [Extension events](#extension-events)
- [Ordering guarantees](#ordering-guarantees)
- [Toward ACP v2](#toward-acp-v2)

## Framing

- One JSON object per line, UTF-8, `\n`-terminated. Lines may be up to 64 MiB (one large tool
  result is one line).
- Requests carry `id`; the engine's own requests to the client use string ids `"friday-<n>"`, and a
  reply echoing them as a string, a bare number string or a number is accepted.
- Requests are handled concurrently: a `session/prompt` holds its reply for the whole turn while
  other requests (steering, model lists, cancel) are answered.
- Errors use JSON-RPC codes: `-32600` invalid request (including anything before `initialize`),
  `-32601` method not found, `-32602` invalid params, `-32603` internal.

## Client → engine methods

### `initialize`

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"_meta":{"archymedes":{"events":true,"questions":true}}}}}
```

`events` opts in to [extension events](#extension-events); `questions` lets the engine ask the
person (`ask_user`). The reply:

```json
{"protocolVersion":1,"authMethods":[],
 "agentCapabilities":{"loadSession":true,
   "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
   "_meta":{"archymedes":{"events":1,"engine":"go"}}}}
```

(`_meta` only when `events` was asked for.) `authenticate` is accepted and does nothing: keys come
from settings.

### `session/new`

Params: `cwd` (the project), `mcpServers` (accepted, not used yet). Opens a session with the
provider and model the [settings](CONFIGURATION.md) choose.

```json
{"sessionId":"20261023T094105Z-k3x9ab",
 "modes":{"currentModeId":"build","availableModes":[{"id":"plan","name":"plan"},{"id":"build","name":"build"},{"id":"auto","name":"auto"},{"id":"defender","name":"defender"}]},
 "_meta":{"archymedes":{"sessionId":"20261023T094105Z-k3x9ab","provider":"groq","providerLabel":"Groq",
   "model":"openai/gpt-oss-120b","mode":"build","root":"/home/me/project",
   "workspace":"local","workspaceLabel":"this computer","engine":"go"}}}
```

Fails with `-32600` and a plain message when no provider is ready or the provider is TypeScript-only.

### `session/load`

Params: `cwd`, `sessionId` (an id, or `latest`). Replays the conversation as `session/update`
(`user_message_chunk`, `agent_message_chunk`) and extension `tool_call` / `tool_result` events,
resumes any sub-agent that was running or paused, then replies with `_meta.archymedes` as above
(no `sessionId` or `modes` at the top level).

### `session/prompt`

Params: `sessionId`, `prompt` (content blocks). `text` blocks are joined; `resource` blocks become
`<context uri="…">…</context>`; `resource_link` blocks become `@<uri>`; `image` blocks (`mimeType`,
base64 `data`, optionally `uri`) go to the model with the text, at most 8 of at most 5 MB each;
others are ignored. An empty
prompt is refused before it is queued.

The prompt is accepted (given its place in line) when the request is read. It runs after every
prompt accepted before it. The reply comes when the turn ends:

```json
{"stopReason":"end_turn"}
```

| `stopReason` | When |
| --- | --- |
| `end_turn` | done, stuck, or failed (the extension's `runtime_stop` says which) |
| `cancelled` | stopped by `session/cancel`, including before it started |
| `max_turn_requests` | the turn's step or call budget ran out |

### `session/cancel` (notification)

Params: `sessionId`. Stops the running turn and every prompt accepted before this notification was
read; prompts sent after it run normally. Background sub-agents keep working.

### `session/set_mode`

Params: `sessionId`, `modeId` (`plan`, `build`, `auto`, `defender`). Standing approvals and granted
patterns are kept. Reply `{}`.

### `session/close`

Params: `sessionId`. Stops the turn and every sub-agent; background sub-agents are paused and resume
when the session is loaded again. Reply `{}`.

### `_archymedes/session/steer`

Params: `sessionId`, `text`. Hands text to the running turn, read at its next step.

```json
{"accepted":true}
```

`false` means no turn is running: send it as a prompt instead.

### `_archymedes/session/set_model`

Params: `sessionId`, `provider`, `model`. The same provider switches the model; another provider
opens its models, keeping the conversation. Replies with `_meta.archymedes` session info.
`claude` starts the person's Claude Code (signed in, or the switch is refused and the session stays
where it was), which then runs the session's turns; Codex is refused with a message (it runs on the
TypeScript engine).

### `_archymedes/session/command`

Params: `sessionId`, `command`, `argument`. Replies with a `kind` and its fields:

| `command` | Reply |
| --- | --- |
| `todos` | `{"kind":"todos","items":[{"text":"…","status":"pending|in_progress|done"}]}`, or `{"kind":"text","text":"No plan yet."}` |
| `tools` | `{"kind":"text","text":"Tools in build mode: …"}` |
| `compact` | `{"kind":"text","text":"Compacted the conversation: 12 → 3 messages."}`; `argument` is the focus to keep |
| `lsp` | `{"kind":"text","text":"gopls (gopls): running\n…"}`: each language server, installed, running or failed |
| `profile` | `{"kind":"text","text":"● work\n  home\n…"}` without `argument`; with a name (or `none`) it saves `ARCHYMEDES_PROFILE` for the sessions that follow |
| `btw` | `{"kind":"text","text":"<the answer>"}`: `argument` is a side question, answered from the conversation without tools and without adding to it; allowed while a turn runs |
| `undo` | `{"kind":"text","text":"Went back to before \"fix the parser\": the files and the conversation."}`; `argument` `code` or `conversation` restores only that; again for the turn before |
| `rewind` | the same, to before turn `N`: `argument` is `N`, then optionally `code` or `conversation` |
| `turns` | `{"kind":"turns","turns":[{"index":0,"label":"fix the parser","createdAt":1793092237461}]}`: the turns that can be gone back to |
| `diff` | `{"kind":"diff","patch":"diff --git …"}` since the last message; `argument` `stat` for a summary per file (text), `turn N` for one turn |
| `hooks` | `{"kind":"text","text":"PreToolUse [Bash]: ./scripts/guard.sh (.claude/settings.json)\n…"}`: each hook, then any file or entry skipped and why |
| `mcp` | `{"kind":"text","text":"github: 26 tools · not started (its tools are known) (.mcp.json)\n…"}`: each MCP server, its tools and state, then any declaration skipped and why |
| `skills` | `{"kind":"text","text":"release   project   Cut a release of this project\n…"}`: each skill found, where from and what for, then any skipped and why |
| `cost` | `{"kind":"text","text":"Main conversation: 12 model calls · 48,210 tokens in (30,100 from cache) · 2,300 out\n…"}`: the main conversation, each sub-agent and the total; no prices yet |
| `subagents` (also `threads`, `agents`) | `{"kind":"text","text":"t-k3x9ab  explore  done  background  4.2k tok  map the API\nSub-agents used …"}` |
| `spawn` | `{"kind":"text","text":"Started explore helper t-k3x9ab in the background; …"}`: `argument` is `[role] <brief>` (a first word naming a role picks it; otherwise `general` in a git repository outside plan mode, else `explore`). The sub-agent runs in the background with no tool call behind it: its `thread` and `subagent` events carry `parentToolCallId` `user:<id>`, and a writable one works in its own worktree. Allowed while a turn runs; `{"kind":"error",…}` when it cannot start. While Claude runs the session, the helper is a Claude Code of its own (read-only roles in plan mode, `explore` unless a role is named, at most 4 at once), and its report is told to Claude before the next prompt |
| anything else | `{"kind":"error","text":"/<command> is not in the Go engine yet. To use it, set Settings → Engine to TypeScript …"}` |

### `_archymedes/threads`

Params: `sessionId`. The session's sub-agents as stored:

```json
{"threads":[{"id":"t-k3x9ab","parent":"root","callId":"c4-0","role":"explore","brief":"map the API",
  "fork":"none","background":true,"model":"small","status":"done","report":"…",
  "createdAt":"2026-10-23T09:41:12Z","updatedAt":"2026-10-23T09:41:40Z"}]}
```

`status` is `running`, `done`, `failed`, `cancelled`, `paused` or `interrupted`; an editing
background sub-agent also has `worktree` and `branch`.

### `_archymedes/sessions`

Params: `cwd`. `[{"id":"…","title":"…","updatedAt":1761212465000,"openElsewhere":false}]`, newest
first, at most 50 (the Go engine's sessions only).

### `_archymedes/startup`

`{"notices":[…]}`: what the TypeScript agent's startup check has to say (an update is available),
when it is installed; otherwise an empty list.

### `_archymedes/suggest`

Params: `input` (what is being typed) and `options` (the completions the client found, at most
24). Jev weighs which option the input is heading for:

```json
{"ranked":true,"scores":[0.1,0.7],"none":0.2}
```

`scores` are in the order of `options`; `none` is the probability that no option fits. Without a
TypeSafe key, with `ARCHYMEDES_JEV` or `ARCHYMEDES_SUGGEST` off, or when Jev does not answer within
3 seconds, the reply is `{"ranked":false}` and the client keeps its own order.

### `_archymedes/setup/status` and `_archymedes/models`

Answered by the TypeScript agent when it is installed (it has key links and the live model
catalog). Without it, the engine answers itself: whether a provider is ready and which could be,
and one model per ready provider.

### `_archymedes/settings/list` and `_archymedes/settings/set`

The Settings list as data, for the interface to draw ([every row](CONFIGURATION.md#the-settings-list)).
`settings/list` takes no params and returns `{"file": "<path>/settings.json", "rows": [...]}`; a row
is `key`, `label`, `section`, `kind` (`choice`, `text` or `secret`), `choices` (`value` and `label`,
for a choice), `value` (masked for a secret), `isSet` and `overriddenByEnvironment`. A secret's
value never leaves the engine.

`settings/set` takes `key` and `value` and saves it; an empty value clears it. The reply is
`{"ok": true, "file", "value", "isSet"}`, or `{"ok": false, "error": "<what to enter instead>"}`
when the value is refused. The next session reads the file again.

### `_archymedes/providers` and `_archymedes/providers/connect`

Answered with the TypeScript agent's help until they are ported (WS-50.3). Claude is the engine's
own: its row in `providers` is ready when Claude Code is installed and signed in, and `connect`
with `{"provider": "claude"}` checks the sign-in here and replies `{"ok": true, "models": [...]}`,
or `{"ok": false, "error"}` saying what to do; nothing is installed. Every other provider is sent
to the TypeScript agent as it is.

## Forwarded methods

Sent to the TypeScript agent unchanged, started on first need:
`_archymedes/providers/models`, `_archymedes/providers/remember-model`, `_archymedes/setup/save`.
They only read and write the shared settings file, which the Go engine reads when the next session
opens. Without the TypeScript agent they are `-32601`.

## Engine → client requests

### `session/request_permission`

```json
{"jsonrpc":"2.0","id":"friday-3","method":"session/request_permission","params":{
  "sessionId":"…",
  "toolCall":{"toolCallId":"c2-0","title":"run npm test -- --watch=false","kind":"execute","status":"pending"},
  "options":[
    {"optionId":"allow","name":"Allow","kind":"allow_once"},
    {"optionId":"allow_always","name":"Allow this action from now on","kind":"allow_always"},
    {"optionId":"allow_pattern","name":"Always allow commands starting with \"npm test\"","kind":"allow_always"},
    {"optionId":"deny","name":"Deny","kind":"reject_once"},
    {"optionId":"deny_always","name":"Deny this action from now on","kind":"reject_always"}]}}
```

`allow_pattern` appears only when a broader rule is safe (here, commands starting with `npm test`).
For a sensitive call the title adds the safety screen's reasons, for example
`run git push origin main — deployment or package publication command`, and no pattern is offered. Both answer shapes are read: ACP's nested
`{"outcome":{"outcome":"selected","optionId":"allow"}}` and the interface's flat
`{"outcome":"selected","selectedOptionId":"allow"}`. Anything else, an error, or no answer (the
client went away) is a denial.

### `_archymedes/session/ask`

Only to a client that opted in with `questions`.

```json
{"sessionId":"…","question":"Which database?","options":["Postgres","SQLite"],"multiSelect":false}
```

Answer `{"answer":"SQLite"}`; `{"dismissed":true}` or an empty answer tells the model to decide.

## Notifications

`session/update` carries what any ACP client can draw:

| `sessionUpdate` | When |
| --- | --- |
| `agent_message_chunk` | each piece of the reply, as it streams |
| `user_message_chunk` | replay on `session/load` |
| `tool_call` | a call is about to run (before its approval), with `title`, `kind`, `status:"in_progress"`, `rawInput` |
| `tool_call_update` | its result: `status` `completed` or `failed`, and the text |

## Extension events

`_archymedes/event` with `{"sessionId":"…","event":{…}}`, to a client that opted in with `events`.

| `event.type` | Fields | Meaning |
| --- | --- | --- |
| `runtime` | `event`: a runtime event (below) | something in the main conversation's turn |
| `subagent` | `parentToolCallId`, `agent`, `event` | a sub-agent's `tool_call`, `tool_result`, `model_turn` or `provider_retry`, under the call that started it |
| `thread` | `thread`: `id`, `parentToolCallId`, `agent`, `status`, `background`, `brief`, `report`, `branch`, `model`, `usage` (every token it has used, across restarts) | a sub-agent started (`running`) or ended (`done`, `failed`, `cancelled`), with its report |
| `compaction` | `tokensBefore`, `messagesBefore`, `messagesAfter` | the conversation was summarized |
| `steering_unread` | `messages` | steering the turn accepted and ended before reading; send them as prompts |
| `rules_problems` | `problems` | command rules or role files left out, and why |
| `suggestions` | `steps`: up to 3 of `text`, `why`, `score`, `source` (`rule`, `model`) | next steps after a turn that changed files or ran a command; `score` is Jev's probability, absent when nothing judged it |
| `edit_notes` | `toolCallId`, `path`, `notes`: `text`, `kind` (`fact`, `judged`), `score` | what is worth knowing about one edit: facts found by code, and Jev's concerns at 0.7 or above |

Runtime events (`event.event.type`), the same as the TypeScript runtime's `AgentRuntimeEvent`:

| Type | Fields |
| --- | --- |
| `model_turn` | `iteration`, `model`, `toolCallCount`, `usage` (`inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`) |
| `tool_compose` | `iteration`, `index`, `toolName`, `subject` (a path or command once streamed), `chars`: a call still being written |
| `tool_call` | `toolCallId`, `toolName`, `effect` (`none`, `workspace`, `external`), `arguments` |
| `tool_result` | `toolCallId`, `toolName`, `effect`, `isError`, `content`, `data` |
| `provider_retry` | `iteration`, `nextAttempt`, `maxAttempts`, `delayMs`, `reason` (`rate_limit`, `server_error`, `timeout`, `network`) |
| `steered` | `iteration`, `count`: messages folded into this step |
| `context_shrunk` | `iteration`, `step`: compacted after the provider said the conversation was too long |
| `test_first` | `state`: `tests`, `code`, `red`, `green`, `checked` |
| `runtime_stop` | `status` (`completed`, `cancelled`, `failed`, `stuck`, `budget_exhausted`), `summary` |

`assistant_delta` is never sent here; the text already went as `agent_message_chunk`.

## Ordering guarantees

- A prompt's events are all written before its reply, except `suggestions` and `edit_notes`. They
  are worked out beside the turn and may follow its reply; a client drops `suggestions` that
  arrive once the next turn has begun.
- Prompts run in the order they were read; a cancel covers exactly the prompts read before it.
- On `session/load`, the replayed conversation comes before any event of a resumed sub-agent.
- A sub-agent's report is delivered to the main conversation once.

## Toward ACP v2

ACP v2 (a draft since July 2026) changes the prompt lifecycle: the prompt's reply acknowledges it
with a message id, and the turn's progress and end arrive as updates. The engine already works that
way inside: a prompt is accepted, runs in its slot, and ends with a status. So v2 is a change to
`internal/core/server` alone: reply on acceptance, and send the end as an update. v1 stays as long
as clients use it. See the [v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft).
