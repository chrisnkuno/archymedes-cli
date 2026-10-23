# Editors and ACP

Friday speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), the protocol
editors such as Zed and JetBrains IDEs use to run coding agents. `friday acp` starts the Go engine
on standard input and output; the editor draws the conversation, Friday does the work.

## Zed

Add Friday under `agent_servers` in Zed's `settings.json` (or **Settings → AI → Add Agent → Add
Custom Agent**):

```json
{
  "agent_servers": {
    "Friday": {
      "command": "friday",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Keys come from Friday's own settings (`friday settings`), so the `env` block can stay empty. Put a
key there only to use a different one inside Zed, for example
`"env": { "ARCHYMEDES_PROVIDER": "groq" }`.

Session flags work after `acp`: `["acp", "--auto"]` starts sessions in auto mode,
`["acp", "--provider", "anthropic", "--model", "claude-sonnet-5"]` picks the model.

## Other editors

Any ACP client that starts an agent as a command works the same way: the command is `friday`, its
arguments `acp` and any session flags. The engine needs nothing else: no Node.js, no port, no
login. If the TypeScript agent is installed (the npm package installs it), settings and provider
methods are answered through it; without it the engine still runs sessions.

## What an editor gets

| ACP | Friday |
| --- | --- |
| `initialize` | protocol version 1, `loadSession: true`, prompts with text and embedded context |
| `session/new` | a session in the editor's folder, with four modes: `plan`, `build` (current), `auto`, `defender` |
| `session/load` | an earlier session, with its conversation replayed |
| `session/prompt` | one turn; text, embedded files (`resource`) and file links (`resource_link`) are understood |
| `session/update` | the reply as `agent_message_chunk`; each tool call as `tool_call` (with a title such as `edit file: src/app.ts` and a kind: read, edit, search, execute, think) and `tool_call_update` (completed or failed, with the result) |
| `session/request_permission` | before a call that changes something, with up to five options: allow once, allow from now on, a broader pattern when it is safe, deny, deny from now on |
| `session/cancel` | stops the turn, and any prompt the editor sent before the cancel |
| `session/set_mode` | changes what Friday may do; standing approvals are kept |

Stop reasons are `end_turn`, `cancelled` and `max_turn_requests` (the turn's step budget ran out).

## The extension

An editor (or the Friday interface) can opt in to more with
`clientCapabilities._meta.archymedes.events: true` in `initialize`. It then also receives
`_archymedes/event` notifications: token usage per model call, retries, sub-agent activity and
thread status, compaction, test-first progress, and why a turn stopped. With
`_meta.archymedes.questions: true`, Friday can ask the person questions
(`_archymedes/session/ask`). The [Protocol reference](PROTOCOL.md) lists every method and event.

## Troubleshooting

- **Nothing happens in the editor**: run `friday acp` in a terminal and paste
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`; Friday should
  answer with one line of JSON. Anything else it prints on standard error is the reason.
- **"No model provider is configured"**: run `friday settings` once in a terminal.
- **A protocol log**: use the editor's own ACP log. (`ARCHYMEDES_ACP_TRACE` records the protocol
  only when Friday's own interface is the client.)

Sources for the Zed configuration: [Zed's agent settings](https://zed.dev/docs/preview/ai/agent-settings.html)
and the change that added custom agent servers,
[acp: Support launching custom agent servers (#36805)](https://git.secluded.site/zed/commit/61bc1cc44172d61c2fb69d8265bc5d809512f342).
