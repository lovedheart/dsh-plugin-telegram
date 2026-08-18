# Changelog

All notable changes to this project will be documented in this file.

## [0.4.9] - 2026-08-18

### Changed
- **Answered question cards stay on screen (locked) instead of collapsing.**
  When a question is settled, the card was previously edited down to a single
  status line (`✅ 已回答：…` / `🌐 已在网页端回答`), so the question and its
  options disappeared from the chat. Now `settle()` re-renders each card with
  its options retained but **disabled** (`is_disabled` — Telegram greys them
  out and tapping fires no callback), a final status line showing what was
  chosen (`🔒 已提交：…`), and all control buttons locked. The question is
  readable and nothing can be re-selected.

### Fixed
- **The user's own submit no longer mislabels the card "已在网页端回答".**
  Submitting via Telegram makes the web host accept the answer and broadcast a
  `question/resolved` frame back to us; `onResolved` used to settle the card
  as "delegated" from that echo, racing the legitimate `respond()` receipt.
  The entry is now flagged `settling` across the `respond()` await, so the
  host's echo of our own settlement is ignored and the authoritative receipt
  decides the label.
- **Removed the "🌐 已在网页端回答" wording.** When the web GUI answers first
  (we never submitted), the locked card now shows a neutral `🔒 已作答`.

### Added
- `lockedKeyboard(kind, key, qi)` helper and `settled` state on the card
  builders; regression test for the resolved-echo race.
- **Inbound voice transcription (🎧).** When the user sends a voice note, the
  plugin transcribes it via the local Whisper service (`sttEndpoint`, default
  the same `http://127.0.0.1:18068` proxy `transcribe_audio` uses) and, in the
  same step: (1) replies with the recognized text **directly under the voice
  bubble** — a reply to the voice message is the only way to show it "on the
  next line" (Telegram bots cannot edit another user's message); and (2) reuses
  the same transcript in the note injected to the agent, so it already has the
  spoken words and does **not** re-run `transcribe_audio`. The transcript is
  shown verbatim (no LLM re-phrase) so display is fast and cost-free. The
  whole feature is best-effort — a dead service or silent audio still injects
  and answers the voice note normally, just without a transcript line. New
  config: `sttEndpoint`, `voiceTranscribe` (default `true`),
  `voiceTranscribeLanguage` (default `auto`), `voiceTranscriptToAgent`
  (default `true`). Requires `forwardInboundMedia`.

## [0.4.8] - 2026-08-18

### Fixed
- **`/compact` now finds the compaction service in web mode.** When the preset
  mounts compaction inside an `isolate` realm, the service is invisible to the
  host plane and to the agent's own scoped context, so `active.ctx?.compaction`
  was always `undefined` and the command reported the service as unavailable.
  The lookup now goes through `agentPresets.serviceFor(agent, 'compaction')`
  (falling back to the direct property for non-isolated deployments), and
  `compactNow` is called with the agent directly.

## [0.4.7] - 2026-06-29

### Fixed
- **Live trajectory no longer freezes on long replies / tool calls.** When the
  model is mid tool-call or thinking, no `text-delta` fires, so the streaming
  reply tail was static and the in-place message edit stopped re-firing — the
  "轨迹" looked frozen. `ProgressIndicator` now tracks the latest non-reply
  activity and appends a one-line footer (🔧 tool / 💭 思考中…) to the
  streaming branch, so the text differs on each new step and the edit
  re-fires (still throttled by `intervalMs`, no extra API load). The footer
  hides while reply text is actively streaming.

## [0.4.6] - 2026-06-29

### Changed
- **`telegram_send_voice` now scopes itself to Telegram.** The tool
  description and the per-message injected instruction make clear it is for
  when the user is on TELEGRAM and asks to hear a reply / 语音播报 — and that
  for the Web GUI the agent should use `text_to_speech` instead so the Web can
  render an inline audio card. No behavior change on Telegram; this stops the
  model reaching for the Telegram voice tool when the reply is destined for the
  browser.

## [0.4.5] - 2026-06-29

### Added
- **Local files can now be sent straight to Telegram** (no more public-host
  round-trip). `telegram_send_document` / `telegram_send_photo` /
  `telegram_send_video` / `telegram_send_audio` now accept an **absolute local
  file path** in their media parameter — in addition to a Telegram file_id or a
  public URL. Local paths are uploaded to the Bot API via
  `multipart/form-data`, with the MIME type inferred from the file extension
  (PDF, Office, images, audio, video, text, archives; fallback
  `application/octet-stream`).
- `src/client.js`: new shared helper `tgUploadFile()` (multipart POST with
  429/5xx/timeout handling identical to the JSON path), plus `isLocalFilePath()`
  and `mimeOf()` for reference-vs-upload dispatch. `sendDocument` /
  `sendPhoto` / `sendVideo` / `sendAudio` transparently route local paths
  through it; URLs and file_ids keep the unchanged JSON behavior.
  `sendVoiceFile` now reuses `tgUploadFile` (same OGG multipart semantics, no
  duplicated fetch/error code).
- `src/index.js`: tool descriptions and parameter docs updated so the model
  knows a local absolute path is accepted; the injected per-message instruction
  now tells the agent to pass local file paths directly to the media tools
  instead of uploading them to a public host first.
- `sendVideo` / `sendAudio` now forward `exec.signal` (interrupt/abort
  propagation, previously only on text/photo/document).

### Tests
- `test/client.test.mjs`: new "local-file upload (multipart)" suite — asserts a
  local path produces a `FormData` body with the right field name, basename and
  inferred MIME; URL/file_id references still POST JSON (regression); a missing
  local path throws.

## [0.4.4] - 2026-08-16

### Added
- **`ask_user_question` on Telegram — pick an option OR type your own answer**
  — when the agent pauses to ask the user a question (the `ask_user_question`
  tool), DSH's web host owns the single UI provider and **only the browser**
  sees the prompt, so a phone-only user waits forever. A new `questions.js`
  answerer subscribes to the web host's `/api/events.mux` over loopback (same
  process, `DSH_WEB_URL` / 127.0.0.1:3080), claims the questions that belong to
  our Telegram agents (same ownership policy as approval, incl. the default
  shared agent), and posts an **inline-keyboard card** to the owning chat:
  - **Single-select**: tap an option to answer instantly, **or just reply the
    card with plain text** — the text becomes the question's custom answer
    (this is the "type my own prompt" path the user asked for).
  - **Multi-select**: toggle options, then tap **✅ 提交** to submit the chosen
    labels (multi-question cards are button-only; unanswered questions are
    skipped).
  - **❌ 取消** cancels the ask. If the web UI answers first, the card flips to
    "已在网页端回答" (first answer wins — a late phone answer is dropped, not
    double-submitted). Reconnects are safe: the mux replays pending questions.
  - Web-originated agents (not ours) are left to the browser — no double cards.
- New module `src/questions.js`: `parseQuestionCallback`, `buildQuestionCard`,
  `createQuestionModule`, `parseSseFrames`, `createMuxSubscriber`. All side
  effects (client, respond, ownership, log) are dependency-injected.
- Config keys: **`questionsEnabled`** (default `true`),
  **`questionsForDefaultAgent`** (default `true`, mirrors
  `approvalForDefaultAgent`), **`webUrl`** (loopback base URL override;
  defaults to `DSH_WEB_URL` then `http://127.0.0.1:3080`).
- `telegramAgentOwnership` was extracted from the approval block and is now
  shared by both the approval and question answerers (each passes its own
  `allowDefault` flag).

### Tests
- `npm test` now **110 items** (questions 33): callback parsing, card layout
  (single/multi/multiSelect, escaping, truncation), single-select / multiSelect
  / custom-text / cancel answer flows, ownership gating, replay dedup,
  web-first settlement, `not-pending` handling, SSE frame parsing, and the
  mux subscriber against a fake `fetch` SSE stream.

## [0.4.3] - 2026-08-16

### Changed
- **Live trajectory on Telegram (QwenPaw-style edit-in-place streaming)**
  — the v0.4.0 progress indicator showed only a single "what's happening now"
  line. It is now a **rolling trail of the agent's recent activity**, edited in
  place (throttled) and tail-truncated so the newest items stay visible:
  - Each recent item is one line: `💭 <reasoning 片段>` (streamed as the model
    thinks) and `🔧 <tool>：<参数预览>` (each tool call, name + compact args).
  - The whole message is capped at `progressMaxChars` (default 1500); each line
    is separately capped at `progressPerBlockChars` (default 240).
  - Tool calls are deduped by `callId` (a tool is shown once, not twice from
    the streaming `block-end` + the authoritative `tool/call`).
  - The **final reply is not shown** in the trajectory — it is sent as its own
    message at turn end, as before.
  - The indicator now consumes the live `assistant/chunk` events
    (`reasoning-delta` / `block-end`) in addition to `tool/call`, and still
    understands the packed `*-chunks` rows for robustness.
- Config keys: `progressTailChars` → **`progressPerBlockChars`**, and new
  **`progressMaxChars`**. (`progressEnabled` / `progressDelaySec` /
  `progressIntervalMs` / `progressTimeoutSec` unchanged.)

### Tests
- `npm test` now **77 items** (progress 18): rolling-trail rendering, per-line
  and whole-message truncation, tool dedup, reply exclusion, watermark
  idempotency, packed-row handling, and the full lifecycle.

## [0.4.2] - 2026-08-16

### Added
- **"Allow always" (🔁 一直允许) on the approval card**
  — DSH's approval service has no native "allow always" primitive (its outcome
  vocabulary is `allowed-once | rejected | cancelled | unavailable`, and its
  policy is only `ask | never`), so the "always" is implemented plugin-side:
  - The card gains a third button **🔁 一直允许** (approve-and-remember). Tapping
    it grants the current ask **and** remembers a stable rule key for that kind
    of ask; the resolved card notes the rule was remembered.
  - Matching future asks are **auto-approved without posting a card** until the
    rule is cleared.
  - Rule keys are normalized: a sandbox escalation (`escalate sandbox to
    <mode>: <justification>`) keys on the stable `<tool>:<mode>` pair (the free
    justification changes per call) → `sandbox:<tool>:<mode>`; any other guarded
    ask keys on the whole tool → `tool:<name>`.
  - Remembers are **persisted** to a JSON file (atomic tmp+rename, survives a
    plugin reload) under `$DSH_HOME/telegram-approval-always.json` (relocatable
    via the new `approvalAlwaysPath` config key).
- **`/approval` command** — list remembered rules (`/approval`), clear all
  (`/approval clear`), or clear one by its exact key (`/approval <ruleKey>`).
  Registered in the bot command menu and documented in `/help`.

### Changed
- Approval callback prefix bumped `tgapv:` → `tgapv2:` so a card still open
  across a plugin upgrade (with only the old two buttons) is not mis-routed;
  such a card simply expires via its timeout.

### Tests
- `npm test` now **72 items** (approval 21 → 34): rule-key normalization,
  describeRuleKey, the allowlist store (check/remember/clear/persist/reload/
  corrupt-file/chat filtering), and the always-flow (remembered rule auto-
  approves with no card; the always button remembers; a plain approve stays
  one-shot).

## [0.4.1] - 2026-08-16

### Added
- **Tool-guard approval over Telegram (parity with QwenPaw's `tool_guard` card)**
  — previously, when the agent's permission policy is `ask` and a tool call needs
  a decision (e.g. a sandbox escalation like writing outside the workspace), DSH
  dispatches an `approval/request` to composed answerers. The Telegram plugin
  registered **none**, so the ask was either claimed by the web host (the browser
  UI, invisible on the phone) or failed closed — the user got no prompt at all.
  This release adds an answerer that surfaces the ask to the phone:
  - Registers an `approval/request` waterfall answerer with `prepend` so it runs
    **before** the web answerer, then self-filters: it claims the agents it owns
    (its `telegram-*` sessions, and — by default — the deployment's shared default
    agent, which is where a plain message routes before `/new`) and delegates
    everything else via `next()` so the web UI keeps working.
  - Posts an inline-keyboard card to the owning chat:
    `🛡️ 需要授权批准` + tool name + the reason DSH gave, with **✅ 批准 / ❌ 拒绝**
    buttons (mirrors QwenPaw's tool_guard card).
  - Resolves `allowed-once` (approve) / `rejected` (deny) when the user taps, and
    `cancelled` on timeout, turn abort, or plugin unload. The card is edited in
    place to show the outcome, and the button click is acked.
  - Card delivery is retried like every other send; if it cannot be delivered the
    ask is delegated (→ web UI or fail-closed), never silently swallowed.
- **New config**: `approvalEnabled` (default `true`), `approvalTimeoutSec`
  (default `1800`, `0` = no expiry), `approvalForDefaultAgent` (default `true`).

### Tests
- `test/approval.test.mjs` (21 cases): callback parse/keyboard/card/label,
  delegation (disabled / non-owned agent / no chat), approve→`allowed-once` +
  ack + resolved edit, deny→`rejected`, double-click no-op, unknown-key no-hang,
  timeout→`cancelled`, abort→`cancelled`, pre-aborted→`cancelled` (no card),
  send-failure→delegate, `cancelAll`, and default-agent ownership routing.

## [0.4.0] - 2026-08-16

### Added
- **Live progress indicator (tool calls + thinking) on Telegram** — modelled on
  QwenPaw's Telegram channel streaming/typing hooks. While the agent works on a
  Telegram message (in BOTH `direct` and `tool` response modes), the plugin keeps
  a single editable message alive that shows what it is doing right now, plus a
  continuous "typing…" chat action (refreshed every ~4 s so it never expires):
  - `🔧 正在调用工具 <name>：<args 预览>` while a tool call is in flight;
  - `💭 思考中：<reasoning 末尾>` while the model is thinking;
  - `✍️ 正在写回复：<文本末尾>` while the reply is being drafted;
  - `⏳ 正在处理，请稍候…` as a neutral fallback (e.g. right after a `tool/result`,
    before the next block starts).
  The status reflects the **most recent** activity (recency, not fixed priority),
  so once the model stops thinking and starts the reply the thinking line does
  not linger. It is **deleted as soon as the turn ends** (`turn/end`), and it
  self-cleans if a turn ever runs past `progressTimeoutSec`. Short turns that
  finish before `progressDelaySec` never post the indicator at all. Purely
  best-effort: a Telegram failure never affects the real reply path.

  Implementation: a `ProgressIndicator` class (module-scope, unit-tested) polls
  the agent's durable session log (`agent.session.events`) for this turn's events
  (seq > the pre-injection baseline) using a `processedSeq` watermark so state is
  never double-applied. New config options: `progressEnabled` (default true),
  `progressDelaySec` (5), `progressIntervalMs` (1200), `progressTailChars` (240),
  `progressTimeoutSec` (3600).

## [0.3.8] - 2026-08-16

### Changed
- **`watchDirectReply` is now busy-aware** (hardening the 0.3.7 fix):
  previously the loop was a blind "poll until idle-with-reply, up to the cap".
  Now it follows the agent's live `status` (dsh-agent-loop `get status()`):
  - while the agent is `running` it keeps waiting (long multi-tool-call
    turns, the 0.3.7 root cause, no longer race a fixed wall-clock window);
  - the instant it is not running with a fresh assistant message → forward
    it (short replies still go out within seconds);
  - if it goes quiet with nothing forwardable **after a short 15 s grace**,
    it stops instead of idling until the cap — the grace is gated on having
    seen the turn run, so the pre-start idle window is never mistaken for
    "done".
  - `directReplyTimeoutSec` (default 1 h) is now an **absolute safety cap**
    for pathological hangs only, never a per-turn timeout.

## [0.3.7] - 2026-08-16

### Fixed
- **Second (long-running) message's reply never reached Telegram — "I can only
  receive 1 message"**: in `direct` mode, after injecting a Telegram message
  the plugin runs `watchDirectReply`, which polls until the agent is idle AND
  a new assistant message appears after the injection baseline, then forwards
  it. That loop had a **hard-coded 5-minute deadline**. A short reply (e.g. a
  25-second turn) made it in time; a long multi-tool-call turn (measured: an
  819 s / 13 m 39 s session that built a whole plugin across 62 tool calls)
  outlived the deadline, so the watcher gave up and the final reply was
  orphaned — visible on the web UI (mux event stream) but never sent to
  Telegram. The cap is now configurable as `directReplyTimeoutSec` (default
  `3600` = 1 h); it is only a ceiling, short replies are still forwarded
  within seconds.

### Added
- `directReplyTimeoutSec` config (schema + defaults + apply) for the direct-mode
  reply-forward deadline.

## [0.3.6] - 2026-08-16

### Fixed
- **Agent replies silently dropped to Telegram on transient network
  failures** (user symptom: tool calls visible on the web UI but the
  final reply never arrived on the phone): the direct-mode relay's final
  `sendMessage` was a single attempt, and this host's link to
  api.telegram.org times out ~45% of the time, so replies were lost
  whenever that one send happened to fail. `sendText` now retries each
  chunk on transient failures (undici transport errors / `fetch failed`
  cause chains, 429 with `retry_after`, 409, 5xx) with exponential
  backoff (1s→10s cap, max 5 attempts); permanent errors (400 bad
  entities, 403) propagate immediately. Classification lives in
  `client.js` as `isTransientTelegramError`, covered by 10 new unit
  tests (`test/client.test.mjs`).

## [0.3.5] - 2026-08-16

### Fixed
- **`/new` / `/clear` failed with
  `(intermediate value)?.commit is not a function`**: the agent factory
  treats a non-`void` return from `CreateAgentOptions.setup` as an
  `AgentSetupCommit` handle it invokes
  (`await raceAbort(setup?.(agent.ctx))?.commit()` in dsh-agent-loop
  `createAgent`; type contract:
  `AgentSetup = (ctx) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`).
  The v0.3.4 setup callback returned `presets.mount(...)`'s Promise, so the
  factory called `.commit()` on the resolved preset object. The setup is now
  side-effect-only (`await` the mount, return `void`) — matching the host's
  `composeAgent()` contract.

## [0.3.4] - 2026-08-16

### Fixed
- **Sessions created via `/new` had no tools (Read/Write/Edit/Bash all
  missing)**: an agent's tool catalog, prompt sections, and skill catalog
  come from the agent preset it joins at setup time; dsh-agent-presets
  warns that an agent published without a preset "resolves against the
  empty global layer". `createTelegramAgent` now mirrors the DSH host's
  `ensureSession()`/`composeAgent()` path: it reads the preset id from the
  default agent's session header (`meta.agentPreset`, e.g. `standard` for
  web) — falling back to `agentPresets.defaultId` — records it in the new
  session's `meta` (so resume keeps it), and mounts it in `setup`:
  `presets.mount(agentCtx, presetId)`. Existing tool-less sessions cannot
  be fixed in place (presets bind at setup time); issue `/new` after the
  restart to get a fully-featured session.

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
