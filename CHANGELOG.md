# Changelog

All notable changes to this project will be documented in this file.

## [0.3.3] - 2026-08-16

### Fixed
- **Misclassified network errors as "Unexpected error"**: Node's global
  `fetch` (undici) reports transport failures as `TypeError: fetch failed`
  with the real cause (`ETIMEDOUT`, `ECONNRESET`, ...) nested in
  `err.cause`. `_isNetworkError` only inspected the top-level error, so a
  plain network hiccup during `getUpdates` fell into the generic error
  branch (loud `error` log, flat 10 s retry) instead of the network-error
  branch (warn + exponential backoff, silent with `verbose: false`). The
  check now walks `err` → `err.cause` → `err.cause.cause` and matches
  undici error names/codes (`UND_ERR_*`, `UndiciError`, `TimeoutError`,
  `EAI_AGAIN`, ...). The poll loop itself was always resilient (catch +
  retry); this only fixes classification and log noise.

## [0.3.0] - 2026-08-16

### Added
- **Per-chat session routing (Plan A)**: the poller now tracks an
  *active agent per Telegram chat*. Regular messages are injected into the
  chat's active agent (falls back to the first agent when none is set).
- **QwenPaw-style command set** (sent directly to the bot):
  - `/new` and `/clear` — create a fresh agent+session (via
    `agents.create()`) and route the current chat to it; a running turn is
    cancelled first. DSH has no in-place history-truncation API, so
    "clearing context" means a new session (the `SessionStartSource:
    'clear'` semantics).
  - `/sessions` — list live agents with id prefix, status, and current
    model; markers 👉 (active for this chat) and 🏠 (default/first).
  - `/use <id>` — switch the chat to an existing agent (short-id prefix
    matching supported).
  - `/stop` — cancel the active turn of the chat's agent
    (`agent.cancel({kind:'user'})`, clears the inbox too).
  - `/compact` — run the DSH `compaction.compactNow()` maintenance
    operation on the chat's idle agent (120 s timeout).
  - `/history [n]` — render the last n user/assistant messages of the
    chat's session (HTML-escaped, per-message truncation).
  - `/model`, `/model list`, `/model <provider>:<model>` — inspect and
    switch the model per session. Switching replicates DSH's
    `installModelSelection` pattern (scoped `system-prompt/assemble` +
    `agent/request` waterfall listeners on `agent.ctx`), validated via
    `llm.resolveCallConfig`; applies from the next request.
  - `/start` and `/help` — command help.
- **`sendText` `html: true` option**: send plugin-authored Telegram HTML
  verbatim (no markdown conversion/escaping) for command replies.
- README: documented the Telegram commands.

### Changed
- `telegram_get_last_assistant_message` still scans all agents (debug helper).
- Plugin unload now disposes any agents it created.

### Fixed
- **`{{cwd}}` prompt variable failure after `/new`**: sessions created via
  `agents.create()` without `meta.cwd` make every turn fail with
  `prompt variable "{{cwd}}" has no value for this assembly (section
  "deployment:persona")`. New Telegram sessions now inherit `cwd` from the
  default agent's session header (fallback: process cwd).
- **`{{model}}` prompt variable failure after `/new`**: the same persona
  section reads `{{model}}`/`{{provider}}` from `agent.options`; an agent
  created without `agentOptions` fails every turn with
  `prompt variable "{{model}}" has no value`. New Telegram agents now
  inherit `provider`/`model` from the default agent (fallback: the
  `agentDefaultModel.currentSelection()` service) — mirroring the DSH
  host's `ensureSession()` path.
- **Missing `/` autocomplete menu**: the command menu is now registered
  via Bot API `setMyCommands` at poller start, so Telegram clients list
  all commands in the "/" autocomplete.
- **`/compact` reported "compaction 服务不可用" on web profiles**: in web
  mode the host-plane `compaction-basic` row is `disabled: true`; the
  service lives in the per-session (agent) scope. The command now looks it
  up on `agent.ctx.get('compaction')` first, falling back to the host
  plane.
- **`/use` / `/sessions` / `/help` / `/model` failed with
  `can't parse entities: Unsupported start tag "id"`**: command replies are
  sent with `parse_mode=HTML`, and literal placeholders like `<id>`,
  `<session-id>`, `<provider>:<model>` in the copy were parsed as HTML
  tags. All such text is now `&lt;...&gt;`-escaped, and every dynamic
  value interpolated into HTML replies (error messages, provider/model
  names, ids, status) goes through `escapeHtml`.

## [0.2.0] - 2026-08-16

### Fixed
- **DSH credentials token resolution**: `resolveBotToken` now `await`s the
  async `credentials.resolve()` call and unwraps `{ value }`. Previously the
  returned Promise was treated as a string (`resolved.length > 0` was always
  false), so the credentials source — documented as the *recommended, safest*
  method — never actually worked. Verified end-to-end: a token stored only in
  `$DSH_HOME/.credentials.yaml` now resolves and authenticates.
- **Code-block-safe chunking**: `chunkText` (now in `text.js`) splits on
  fence-balanced boundaries so every chunk contains an even number of ```
  fences. Previously a long fenced block could be split mid-block, producing
  an unclosed `<pre>` and a `can't parse entities` failure from Telegram.
- **Markdown underscore mangling**: the `_..._` italic rule is now disabled
  whenever the message contains any backtick, so identifiers like
  `snake_case_var` are no longer mangled into `<i>` spans (a common
  `can't parse entities` source for agent output with code).
- **Post-conversion length guard**: chunks are re-checked against the 4096
  limit *after* HTML conversion (escaping can grow text); over-long chunks
  fall back to plain text with no parse_mode instead of failing.
- **Rate-limit classification**: `TelegramClient` parses the error body and
  throws `TelegramRateLimitError` with `retryAfter` for 429s, instead of a
  generic error whose message the poller could not match.
- **Conflict (409) detection**: the poller now keys off the structured
  `errorCode`/`status` fields (409) in addition to message text.
- **Offset persistence**: the poller persists `lastOffset` to
  `$DSH_HOME/telegram-poller-offset-<key>.json` and dedups by (chat, message)
  id, so a restart no longer replays already-delivered updates into the agent.
- **`get_updates` tool** now gives a clear error when it collides with the
  background poller (single-consumer 409) instead of a raw API error.

### Added
- **`agentResponseMode: 'direct'` is now implemented**: after injecting a
  Telegram message, the plugin watches the agent turn and auto-sends the
  final assistant text back to the chat (using `replyPrefix` if set). The
  injected prompt in direct mode tells the agent *not* to call
  `telegram_send_message` (to avoid double-replying).
- **`telegram_get_last_assistant_message`** tool: read the latest assistant
  message of the current session (test/debug helper).
- **Tool `exec.signal`** is now threaded through send/edit/delete/getUpdates
  so operations can be cancelled by DSH.
- **`src/text.js`** module + **`test/text.test.mjs`** unit tests (`npm test`)
  covering chunking fence balance and the Markdown→HTML conversion.
- Inbound non-text media now gets a brief acknowledgement receipt.
- Logging uses `ctx.logger` when available (falls back to `console`).

### Changed
- Agent injection now uses the **public** `agent.followup(message)` API
  (equivalent to `send(message, 'next-turn', true)`) instead of the private
  `agent.wakeDriver()`.
- Injected messages use a **valid** `source: { kind: 'plugin', plugin:
  'dsh-plugin-telegram' }` (DSH `MessageSource` does not accept `kind:
  'telegram'`), with the chat id retained in the text for reply routing.
- `chunkText` / `markdownToTelegramHtml` / `guardConvertedLength` moved from
  `index.js` to `text.js` so they are unit-testable.

### Verified
- Second DSH instance booted on an alternate port with the plugin enabled;
  token resolved from DSH credentials; `getMe` OK; a short message and a
  16 KB / 5-chunk code-block message were delivered to the owner's chat via
  the real `TelegramClient`.

### Known Limitations
- Single-agent assumption: messages are injected into `agents.list()[0]`.
- Agent (tool mode) may not always call `telegram_send_message`; model
  function-calling support varies. Direct mode removes this dependency.
- Inbound media is acknowledged but not yet forwarded to the agent (would
  need attachment plumbing).
- `Config.validate` does not reject unknown keys (only type-checks known ones).

---

## [0.1.0] - 2025-01-15

### Initial Release
- Telegram Bot integration for DSH (DeepSeek Harness)
- Based on QwenPaw's TelegramChannel, adapted for Cordis plugin framework
- 6 tools registered via `ctx.tools.register()`
- Background poller with automatic reconnection
- Agent message injection via `inbox.append()` and `wakeDriver()`
