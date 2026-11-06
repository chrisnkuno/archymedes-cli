# The phone link

How Friday on a computer and the Friday page on a phone talk through a relay that cannot read them.
The sealing is in `internal/phone/seal.go`. The vectors in `internal/phone/testdata/vectors.json`
pin it; the phone's JavaScript must reproduce them byte for byte.

- [Pairing](#pairing)
- [The relay](#the-relay)
- [Frames](#frames)
- [Messages to the phone](#messages-to-the-phone)
- [Messages to the computer](#messages-to-the-computer)
- [Rules both ends keep](#rules-both-ends-keep)

## Pairing

`/phone` makes a 32-byte secret, keeps it in `<config>/phone.json` (mode 0600), and shows a QR code
of `https://archymedes.xyz/phone#k=<secret>`. The secret is base64url without padding. It sits
after `#`, which a browser never sends to a server. The page keeps it in the phone's local storage.
`/phone new` makes a new secret, which unpairs every phone. `/phone off` deletes it.

Both ends derive from the secret with HKDF-SHA256, salt `friday-phone v1`:

| Info | Length | Use |
| --- | --- | --- |
| `room` | 16 bytes | The relay room, as base64url: 22 characters |
| `key c2p` | 32 bytes | AES-256-GCM key for frames from the computer to the phone |
| `key p2c` | 32 bytes | AES-256-GCM key for frames from the phone to the computer |

## The relay

A Cloudflare Worker with one Durable Object per room. It forwards frames and reads none of them.

- The computer connects to `wss://archymedes.xyz/phone/relay/<room>?role=computer`.
- A phone connects to `wss://archymedes.xyz/phone/relay/<room>?role=phone`.
- One computer per room: a new one replaces the old, which is closed with code 4001.
- At most four phones per room: a fifth is refused with code 4002.
- A frame from the computer goes to every phone. A frame from a phone goes to the computer only.
- The relay keeps nothing. A phone that joins asks the computer for the whole state.
- A text message over 400,000 bytes, or more than 60 messages a second from one socket, closes it
  with code 4003.

The relay also says, in plain JSON that is never trusted for content, who is there:

- `{"relay":"phones","count":2}` to the computer when phones come or go.
- `{"relay":"computer","online":false}` to the phones when the computer leaves, and `true` when it
  is back.

## Frames

Every other message is a frame, as JSON text:

```json
{"v":1,"e":"<sender epoch>","n":7,"c":"<base64url(nonce ‖ ciphertext ‖ tag)>"}
```

- `e` is 8 random bytes in base64url, 11 characters, new for each connection of a sender.
- `n` starts at 1 and rises by one with every frame the sender seals.
- The nonce is 12 random bytes.
- The additional data is the text `friday-phone v1|<direction>|<e>|<n>`, with direction `c2p` or
  `p2c`.
- The plaintext is `{"t":<unix ms when sealed>,"m":<the message>}`.

An opener refuses a frame that does not open with its direction's key. It refuses one whose `n` is
not above the last `n` it opened from that `e`. It refuses one whose `t` is more than five minutes
from its own clock. It remembers at most 32 senders. A message is at most 256 KiB of JSON.

## Messages to the phone

Each is a JSON object with a `type`.

`state` is the whole picture. It is sent when a phone says `hello` or `resync`:

```json
{"type":"state","rev":41,
 "session":{"title":"Port the parser","project":"friday-cli","branch":"feat/x","model":"claude-sonnet-5","mode":"build","ctx":"ctx 46%"},
 "phase":"busy","since":1793900000000,
 "items":[{"id":"i7","kind":"tool","title":"run_command go test ./...","status":"running","text":"ok  internal/x\n…","stuck":false}],
 "approval":null,"queue":[{"id":"q1","text":"also the lexer"}],
 "plan":{"done":1,"total":4,"left":"≈6m"},
 "activity":[{"id":"cmd1","command":"npm run dev","status":"running","stuck":false}]}
```

`patch` changes it. It has the next `rev` and only the parts that changed. `items` in a patch are
added or replaced by `id`, and `removed` lists ids that went. A phone that sees a `rev` that is not
one above its own asks for `resync`.

- `phase` is `starting`, `ready`, `busy` or `failed`.
- `session.theme` is the session's theme as hex colours (`primary`, `accent`, `bg`, `surface`,
  `text`, `muted`, `success`, `warning`, `error`, `border`), so the page draws as Friday does.
- `commands` lists the Friday commands the phone may run: `name`, `args`, `help` and `needsArg`.
- A queued message has `id`, `text`, `sending`, `retry` (offered again at the turn's next step)
  and `due` (Unix ms when it goes into the running turn, or `null` for the next turn).
- A tool item may have `added` and `removed` (an edit's lines). A helper item has `helper` (its id)
  and `working`.
- An item's `kind` is `user`, `assistant`, `tool`, `helper` or `notice`. Its `status` is `running`,
  `done` or `failed`. Its `text` is at most 4,000 characters: the end of what it said or printed,
  or its diff.
- `approval` is what waits for an answer, or `null`:

```json
{"id":"a3","kind":"approval","title":"run_command","command":"git push --force origin main",
 "risk":["force push"],"options":[{"id":"allow","label":"Allow"},{"id":"deny","label":"Deny"}]}
```

A question has `"kind":"question"`, its `text`, its `options`, `multi` when several can be chosen,
and `free` when a typed answer is allowed.

`ack` answers a phone's request: `{"type":"ack","of":"<request id>","ok":true,"text":"Queued"}`.

`notice` is a line to show briefly: `{"type":"notice","text":"CI failed: test · Run go test"}`.

## Messages to the computer

Every request from the phone has an `id`, which its `ack` names.

| Message | Does |
| --- | --- |
| `{"type":"hello","id":"r1","device":"iPhone"}` | Joins; the computer sends `state` |
| `{"type":"resync","id":"r2"}` | Asks for `state` again |
| `{"type":"send","id":"r3","text":"…"}` | A message, as typed in the terminal: queued while Friday works |
| `{"type":"answer","id":"r4","approval":"a3","choice":"allow"}` | Answers an approval, or a question by option |
| `{"type":"answer","id":"r5","approval":"a4","choices":["1","3"]}` | Answers a question that takes several |
| `{"type":"answer","id":"r6","approval":"a4","text":"…"}` | Answers a question in words |
| `{"type":"stop","id":"r7"}` | Stops the turn, as esc does |
| `{"type":"undo","id":"r8"}` | `/undo` |
| `{"type":"mode","id":"r9","mode":"auto"}` | Switches the mode |
| `{"type":"command","id":"r10","command":"cmd1","action":"stop"}` | Stops a command; `restart` runs it again |
| `{"type":"slash","id":"r11","command":"compact","arg":"…"}` | Runs one of the commands in `commands`, as typed in the terminal |
| `{"type":"queue","id":"r12","item":"q3","action":"up"}` | Works a queued message: `up`, `down`, `send` (now) or `drop` |
| `{"type":"helper","id":"r13","helper":"t-1","action":"stop"}` | Stops a helper; `send` with `text` tells it something |

A line the terminal shows as a toast is sent as a `notice` too.

## Rules both ends keep

- The computer acts on nothing the relay says, only on frames that open.
- An answer counts only for the approval waiting now. The first answer wins, here or there.
- The phone shows a risky approval's whole command and its risk before Allow.
- Nothing the computer sends carries the pairing secret, an API key or a setting's value.
