# dsh-plugin-telegram

DeepSeek Harness (DSH) plugin for Telegram Bot integration. Provides tools for sending and receiving Telegram messages, with optional long-polling for incoming messages.

Based on the Telegram channel implementation from [QwenPaw](https://github.com/Quantum-Gizmo/QwenPaw), adapted for the DSH Cordis plugin framework.

## Features

- **Send messages** with Markdown/HTML formatting
- **Send photos and documents** via file_id or URL
- **Edit and delete** existing messages
- **Long-polling** for incoming messages (optional)
- **Agent integration**: Inject Telegram messages into DSH agent loop for AI-powered conversations
- **Multi-bot**: run several Telegram bots in one plugin instance (`bots:` config, per-bot tokens/routing, isolated state)
- **Live subagent board**: pinned real-time subagent status (🧩) per chat
- **`/autopilot`**: per-chat fully-autonomous mode (global write + auto-approve + auto-adopt)
- **Access control** via allowed chats/users lists
- **Automatic reconnection** with exponential backoff
- **Rate limit handling** with Telegram API compliance
- **Message chunking** for content exceeding Telegram's 4096-char limit

## Tools Provided

| Tool | Description |
|------|-------------|
| `telegram_send_message` | Send a text message to a chat |
| `telegram_send_photo` | Send a photo to a chat |
| `telegram_send_document` | Send a document to a chat |
| `telegram_edit_message` | Edit an existing message |
| `telegram_delete_message` | Delete a message |
| `telegram_get_info` | Get info about all configured bot(s) — returns an array, one entry per bot |
| `telegram_get_updates` | Manually poll for new updates |
| `telegram_get_last_assistant_message` | Read the latest assistant message of the current session (debug/test helper) |

### Telegram 会话管理命令（直接发给 bot）

参考 QwenPaw 的命令风格实现：

| 命令 | 作用 |
|---|---|
| `/new` 或 `/clear` | 新建会话并路由过去（清空上下文；若当前会话在运行会先停止） |
| `/sessions` | 列出活动会话（👉=当前，🏠=默认），含状态和模型 |
| `/use <id>` | 切换到指定会话（支持短 id 前缀匹配） |
| `/stop` | 停止当前会话正在执行的任务 |
| `/compact` | 压缩当前会话历史为摘要（走 DSH compaction 服务） |
| `/history [n]` | 查看最近 n 条对话（默认 12） |
| `/model` | 查看当前会话的模型 |
| `/model list` | 列出可用 provider/model |
| `/model <provider>:<model>` | 为当前会话切换模型（下一轮请求生效） |
| `/approval` | 查看已记住的「一直允许」授权（`/approval clear` 清空全部，`/approval <ruleKey>` 清单条） |
| `/autopilot` | 全自动模式（`on`/`off`/`status`）：全局写权限 + 自动放行授权 + 自动采纳推荐方案（⚠️ 有安全隐患） |
| `/start` 或 `/help` | 显示帮助 |

普通消息路由到当前聊天的 active 会话；无显式路由时落到默认（第一个）会话。
`/new` 创建的会话继承默认会话的工作目录（`cwd`）、模型（`provider`/`model`，
来自 `agent.options`）和 agent preset（`meta.agentPreset`，setup 时
`agentPresets.mount` 挂载）——preset 决定工具目录（Read/Write/Edit/Bash 等）、
提示段和 skill 清单，随插件卸载一起销毁。

命令菜单在 poller 启动时通过 Bot API `setMyCommands` 注册，Telegram 客户端
输入 `/` 即可看到全部命令的自动补全。

## Installation

### 1. 设置 Token（三种方式，优先级从高到低）

**方式一：DSH Credentials 系统（推荐，最安全）**

编辑 `$DSH_HOME/.credentials.yaml`（权限 0600，只有所有者可读）。
该文件是顶层 YAML mapping：key 为凭据引用名，value 为字符串（建议加引号）：
```yaml
TELEGRAM_BOT_TOKEN: "你的token"
```
也可在 DSH Web UI 的 Credentials 设置页写入。插件启动时通过
`ctx.credentials.resolve('TELEGRAM_BOT_TOKEN')` 读取。
> 注：DSH 没有 `dsh credential set` 子命令。

**方式二：环境变量**

```bash
# 一次性传入
TELEGRAM_BOT_TOKEN='你的token' dsh web --patch ./cordis.yml

# 或写入 ~/.bashrc / ~/.zshrc
export TELEGRAM_BOT_TOKEN='你的token'
```

**方式三：写在 cordis.yml 中（不推荐，会明文存储）**

```yaml
config:
  botToken: '你的token'  # 不推荐
```

#### 多 bot：设置多个 token

配置 `bots:` 数组跑多个 bot 时，**每个 bot 一个 token，互相隔离**。隔离的关键是
让每个 bot 指向**不同的来源键**——否则两个 bot 都会默认读同一个
`TELEGRAM_BOT_TOKEN`，第二个 bot 会错误地拿到第一个 bot 的 token。

三种方式的多 bot 写法（优先级从高到低，与单 bot 一致：
`bots[].token`（明文）→ 环境变量 `process.env[envKey]` → DSH credentials）：

**方式一：DSH Credentials 系统（推荐）** — 在 `$DSH_HOME/.credentials.yaml`
里为每个 bot 写一条独立的凭据（key 名自取），再让每个 bot 的 `envKey`
指向对应的 key：

```yaml
# $DSH_HOME/.credentials.yaml
TELEGRAM_BOT_TOKEN: "alice的token"
TELEGRAM_BOT_TOKEN_BOB: "bob的token"
```

```yaml
# cordis.yml
config:
  pollingEnabled: true
  bots:
    - id: alice
      envKey: 'TELEGRAM_BOT_TOKEN'        # 默认值，可省略
    - id: bob
      envKey: 'TELEGRAM_BOT_TOKEN_BOB'    # 指向自己的凭据 key
```

**方式二：环境变量** — 同样每个 bot 一个变量，`envKey` 指向它：

```bash
export TELEGRAM_BOT_TOKEN='alice的token'
export TELEGRAM_BOT_TOKEN_BOB='bob的token'
```

```yaml
config:
  bots:
    - id: alice        # envKey 默认 TELEGRAM_BOT_TOKEN
    - id: bob
      envKey: 'TELEGRAM_BOT_TOKEN_BOB'
```

**方式三：明文写在 cordis.yml 的 `bots[].token`（不推荐）**

```yaml
config:
  bots:
    - id: alice
      token: '123456...:AA...'
    - id: bob
      token: '789012...:BB...'
```

要点：

- **不填 `envKey` 的 bot 一律读 `TELEGRAM_BOT_TOKEN`**——多 bot 时除了第一个
  bot，其余每个都必须给 `envKey`（或 `credentialKey`）指定不同的键。
- 某个 bot 的 token 三个来源（明文 / 环境变量 / credentials）都取不到时，
  该 bot **跳过并打 warn 日志**（不报错）；全部 bot 都取不到时插件降级为
  tools-only（工具仍注册，调用时返回提示）。
- 每个 bot 的完整字段与回退规则见下方 "Multi-Bot Configuration"。

### 2. Configure in cordis.yml

```yaml
- insert:
    - id: telegram
      name: '/path/to/dsh-plugin-telegram/lib/index.js'
      config:
        # botToken 可以不填，插件按以下优先级自动查找：
        # 1. config.botToken（明文，不推荐）
        # 2. 环境变量 TELEGRAM_BOT_TOKEN
        # 3. DSH Credentials 系统中的 TELEGRAM_BOT_TOKEN
        defaultChatId: '123456789'
        pollingEnabled: false
```

### 3. Start DSH with the plugin

```bash
dsh web --patch ./cordis.yml
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `botToken` | string | `""` | Bot Token。可留空，插件会按优先级查找：config → 环境变量 → DSH Credentials |
| `baseUrl` | string | `""` | Custom Telegram API base URL |
| `allowedChats` | string[] | `[]` | Allowed chat IDs (empty = all) |
| `allowedUsers` | string[] | `[]` | Allowed user IDs (empty = all) |
| `requireMention` | boolean | `false` | Require @mention in groups |
| `pollingEnabled` | boolean | `false` | Enable long-polling |
| `longPollTimeout` | number | `30` | Polling timeout in seconds |
| `defaultChatId` | string | `""` | Default chat ID for messages |
| `maxMessageLength` | number | `4000` | Max chars before splitting |
| `parseMode` | string | `"HTML"` | Parse mode (HTML or Markdown) |
| `injectToAgent` | boolean | `true` | Inject messages to agent loop |
| `agentResponseMode` | string | `"tool"` | Response mode: `'tool'` or `'direct'` |
| `replyPrefix` | string | `""` | Optional prefix for agent responses |
| `directReplyTimeoutSec` | number | `3600` | (direct mode) Absolute safety cap (seconds) for the reply-forward watcher. The watcher is busy-aware — it follows the agent while it runs (long tool-call turns are fine) and forwards the reply the moment the agent goes idle with a fresh message; this cap only bounds pathological hangs. Short replies are still forwarded within seconds. |
| `progressEnabled` | boolean | `true` | Show a live trajectory (tool calls + thinking) on Telegram while the agent works. Works in both `direct` and `tool` response modes. |
| `progressDelaySec` | number | `5` | Only post the trajectory if the turn is still running after this many seconds (short turns show nothing). |
| `progressIntervalMs` | number | `1200` | Minimum gap between in-place edits (Telegram rate-limits edits to ~1/s per message). |
| `progressPerBlockChars` | number | `240` | Max chars per trajectory line (a reasoning block or a tool call). |
| `progressMaxChars` | number | `1500` | Max chars of the whole trajectory message (tail-truncated, so the newest items survive). |
| `progressTimeoutSec` | number | `3600` | Absolute cap before the trajectory self-cleans (pathological hangs only). |
| `approvalEnabled` | boolean | `true` | When the agent's permission policy is `ask` and a tool call needs a decision (e.g. a sandbox escalation), post an inline-keyboard approval card (✅ 批准 / 🔁 一直允许 / ❌ 拒绝) to the owning chat instead of failing closed. See "Tool-guard approval" below. |
| `approvalTimeoutSec` | number | `1800` | How long an approval card waits for a tap before expiring (`cancelled`). `0` = no expiry. |
| `approvalForDefaultAgent` | boolean | `true` | Also surface asks from the deployment's **shared default agent** to the phone. Before `/new`, a plain Telegram message routes to that agent, so this is what makes the card appear in the state you usually test in. Set `false` to limit cards to agents this plugin explicitly created (`telegram-*`). Requires `defaultChatId`. |
| `approvalAlwaysPath` | string | `''` | File where "🔁 一直允许" remembers are persisted (defaults to `$DSH_HOME/telegram-approval-always.json`). Set an absolute path to relocate. |
| `questionsEnabled` | boolean | `true` | When the agent calls `ask_user_question` (pick an option / type your own), post an inline-keyboard question card to the owning chat and answer via the web host, so a phone-only user isn't left waiting on the browser. See "Question cards" below. |
| `questionsForDefaultAgent` | boolean | `true` | Also surface questions from the deployment's **shared default agent** to the phone (mirrors `approvalForDefaultAgent`). Set `false` to limit cards to agents this plugin explicitly created (`telegram-*`). Requires `defaultChatId`. |
| `autopilotEnabled` | boolean | `true` | Whether the `/autopilot` command is available. Set `false` to disable full-auto mode entirely. See "Autopilot (full-auto mode)" below. |
| `autopilotSandboxMode` | string | `danger-full-access` | Sandbox mode appended to the session while a chat is in autopilot (the "global write" half). Defaults to full disk access. |
| `autopilotWindowMs` | number | `10000` | How long an autopilot `ask_user_question` notice waits before auto-committing the recommended option (`0` = commit immediately). Gives you a window to tap `✋ 接管` to take over. |
| `webUrl` | string | `''` | Loopback base URL of the `dsh web` host the plugin reaches for question events/responses. Defaults to `DSH_WEB_URL` (set by `dsh web`), then `http://127.0.0.1:3080`. Override only for non-default ports. |
| `sttEndpoint` | string | `http://127.0.0.1:18068` | OpenAI-compatible Whisper base URL used to transcribe inbound voice notes (same service `dsh-tool-audio`'s `transcribe_audio` hits). |
| `voiceTranscribe` | boolean | `true` | When the user sends a voice note, transcribe it and reply with the text under the voice bubble (🎧). Requires `forwardInboundMedia`. |
| `voiceTranscribeLanguage` | string | `auto` | Force a language code (e.g. `zh`/`en`) for transcription, or `auto` to let Whisper detect it. |
| `voiceTranscriptToAgent` | boolean | `true` | Also include the transcript in the message injected to the agent, so it already has the words and does NOT re-run `transcribe_audio`. |
| `subagentBoardEnabled` | boolean | `true` | While a session spawns subagents, keep ONE pinned message per chat showing each subagent live (task + status, and what it is doing). See "Live subagent board" below. |
| `subagentBoardPin` | boolean | `true` | Pin the board message so it stays at the top of the chat (the "fixed" part). |
| `subagentBoardRefreshMs` | number | `2000` | How often the board re-reads live child sessions and re-renders (edits are throttled to ~1.5 s regardless). |
| `subagentBoardIncludeDescendants` | boolean | `false` | When `true`, also show nested subagents (a subagent that spawns another). Default shows only direct children. |
| `subagentBoardMaxRows` | number | `10` | Cap on subagents shown before the overflow collapses into a `… 另有 K 个未显示` line (keeps the message under Telegram's 4096-char limit). |
| `verbose` | boolean | `false` | Enable debug and info logs (default: errors only) |

### Multi-Bot Configuration

Run **multiple Telegram bots** in one plugin instance. Add a top-level `bots:`
array; every item is one bot. This is a v0.6.0 feature — the legacy single-bot
config (top-level fields, no `bots`) keeps working unchanged (see "Backward
compatibility" below).

Each `bots[]` item supports the same per-bot fields as the top-level config. An
item field left **unset falls back to the top-level value** of the same field, so
you only spell out what differs per bot.

| Field | Type | Default (when unset) | Description |
|-------|------|----------------------|-------------|
| `id` | string | auto | Bot id used for routing (see "id auto-generation"). Must be **unique** across `bots` (duplicates throw at startup). |
| `token` | string | top-level `botToken` | Bot token. `botToken` is an accepted alias (either name works on an item). |
| `envKey` | string | `"TELEGRAM_BOT_TOKEN"` | Env var to read the token from (per-bot, so two bots read two different vars — no crosstalk). |
| `credentialKey` | string | same as `envKey` | DSH credentials key to fall back to for this bot's token. |
| `baseUrl` | string | top-level `baseUrl` | Per-bot custom API base URL. |
| `defaultChatId` | string | top-level `defaultChatId` | Per-bot default chat (used for card/approval routing and `/new` follow-ups). |
| `allowedChats` | string[] | top-level `allowedChats` | Per-bot allowed chat ids (empty = all). |
| `allowedUsers` | string[] | top-level `allowedUsers` | Per-bot allowed user ids (empty = all). |
| `requireMention` | boolean | top-level `requireMention` | Per-bot group @mention requirement (filtered against **that bot's** `getMe`). |
| `injectToAgent` | boolean | top-level `injectToAgent` | Per-bot message injection into the agent loop. |
| `agentResponseMode` | string | top-level `agentResponseMode` | Per-bot `'tool'` / `'direct'` reply mode. |

Other top-level fields (`longPollTimeout`, `maxMessageLength`, `parseMode`,
`pollingEnabled`, `replyPrefix`, …) are also readable per item when set.

**id auto-generation** — when an item has no `id`:
- it has a resolvable `token` → id = `"bot-" + token.slice(0, 8)`;
- otherwise (no token) → id = `"default"`.
- The legacy single-bot fallback (no `bots` field) always yields id `"default"`.

**Backward compatibility** — omit `bots` (or set `bots: []` / a YAML-coerced
`{}`): the plugin builds **one** bot, id `"default"`, entirely from the
top-level fields. Existing single-bot `cordis.yml` files need **no change** and
behave bit-identically.

**Missing-token degradation** — a bot whose token resolves to nothing
(config + `envKey` + `credentialKey` all empty) is **skipped with a warn log**;
it never throws. It is still registered (so `clientFor`/`meFor` report a precise
"skipped" error) but gets no client/poller/command-menu. If **all** bots are
skipped the plugin runs **tools-only** (tools still register; their `!client`
guards return a helpful error when called) — the same "missing token → tools-only"
semantics as the legacy path.

**Per-bot token resolution priority** (per item, in order):
`token` (plain) → `process.env[envKey]` → DSH credentials `envKey` → DSH
credentials `credentialKey` (the last one only when it differs from `envKey`).
Using a distinct `envKey` per bot is the recommended way to avoid a second bot
accidentally picking up the first bot's token.

#### Sending tools & `telegram_get_info` under multi-bot

- Every **send/edit/delete/media tool** (`telegram_send_message`, `telegram_send_photo`,
  `telegram_send_document`, `telegram_edit_message`, `telegram_delete_message`, …) now
  accepts an **optional `bot` parameter** (a bot id). Resolution order:
  (1) explicit `bot` — must be a known, connected bot, else a clear tool error;
  (2) the **owning bot of the target chat** (composite-key reverse lookup, the
  bot whose poller last routed a message for that chat);
  (3) the first/legacy bot. A single-bot config is unaffected.
- **`telegram_get_info` now returns an ARRAY — one entry per configured bot**:
  `{ id, username, botId, name, connected, defaultChat }`. A legacy single-bot
  config returns exactly one entry (`id: "default"`), so single-bot callers see
  one item as before.
- **`telegram_get_updates`** accepts a `bot` parameter; each bot keeps its **own
  manual poll offset** (independent per bot, and independent of that bot's
  background poller), so a manual poll on one bot never advances another's stream.

#### Two-bot example

```yaml
- insert:
    - id: telegram
      name: '/path/to/dsh-plugin-telegram/lib/index.js'
      config:
        pollingEnabled: true
        longPollTimeout: 30
        # Top-level values act as the per-bot defaults (inherited when an item omits a field).
        requireMention: true
        agentResponseMode: 'direct'
        bots:
          - id: alice
            token: '123456...:AA...'        # or leave empty + envKey below
            defaultChatId: '100000000'
            allowedUsers: ['100000000']
          - id: bob
            envKey: 'TELEGRAM_BOT_TOKEN_BOB' # reads its own env var (no token on the item)
            defaultChatId: '200000000'
            allowedUsers: ['200000000']
```

#### Multi-bot caveats

- **`chatId` is NOT globally unique across bots** — the same numeric `chatId` can
  exist under two bots. So all per-chat state (dedup, board, indicator, agent
  routing) is keyed by the **composite key `k(botId, chatId)`** (`"botId::chatId"`),
  never by bare `chatId`. Messages are therefore **not cross-deduped** across bots:
  the same `(chatId, messageId)` delivered through two different bots is processed
  once per bot.
- **Isolate tokens with `envKey`** so a second bot does not inherit the first
  bot's `TELEGRAM_BOT_TOKEN` (the default `envKey`/`credentialKey` is the same
  `TELEGRAM_BOT_TOKEN`; point each extra bot at its own key).
- **`getUpdates` offset is per-bot** (Telegram maintains one update stream per
  bot) — the plugin tracks a separate manual offset per bot for the
  `telegram_get_updates` tool, and each background poller tracks its own cursor
  (offset file `telegram-poller-offset-<botId>.json`).

### Inbound voice transcription (🎧)

When the user sends a **voice note**, the plugin transcribes it via the local
Whisper service (`sttEndpoint`, default the same proxy `transcribe_audio` uses)
and, in the same step:

1. **Replies with the recognized text directly under the voice bubble** — a reply
   to the voice message is the only way to show it "on the next line" (Telegram
   bots cannot edit another user's message). It is a quiet, plain-text message
   (`🎧 …`) so arbitrary recognized text can't trip the entity parser.
2. **Reuses that transcript in the note injected to the agent**, so the agent
   already has the spoken words and does **not** need to call `transcribe_audio`
   again (saves a round-trip and lets the agent answer immediately).

Requires `forwardInboundMedia: true` (the file must be downloaded to transcribe).
The transcript is shown verbatim — no LLM re-phrase — so display is fast and
cost-free. The whole feature is best-effort: if the service is down or the audio
is silent, the voice note is still injected and answered normally (just no
transcript line). Set `voiceTranscribe: false` to turn it off.

### Live trajectory (tool calls + thinking)

While the agent works on a Telegram message, a single **editable message shows a
rolling trail of its recent activity** (in both `direct` and `tool` modes), plus a
continuous "typing…" chat action. Modelled on QwenPaw's Telegram channel edit-in-place
streaming. Each recent item is one line:

- `💭 <reasoning 片段>` — a chunk of the model's thinking (streamed as it happens);
- `🔧 <tool>：<参数预览>` — a tool call (name + a compact argument preview).

The whole message is **tail-truncated to `progressMaxChars`**, so the **newest** items
stay visible and the oldest scroll off (each line is separately capped at
`progressPerBlockChars`). The **final reply is not shown here** — it is sent as its own
message when the turn ends.

It is deleted the moment the turn ends (`turn/end`), self-cleans after
`progressTimeoutSec`, and never shows for turns that finish before `progressDelaySec`.
Set `progressEnabled: false` to turn it off. It is purely best-effort — a Telegram
failure never affects the real reply.

### Live subagent board (🧩)

When a session spawns **subagents** (via the `subagent` / `subagent_fork` tools), the
plugin keeps a **single pinned message per chat** that shows, in real time, every
subagent currently working — and each finished one, locked in place. Each subagent
occupies **at most two lines**:

```
🧩 子代理看板 · 2 工作中 / 1 完成
🟢 重构认证模块 · 工作中
🔧 read src/auth/session.js
🟢 跑集成测试 · 工作中
正在启动…
✅ 整理依赖 · 已完成
已完成 · 用时 42s
```

- **Line 1** — status emoji + a short task name + status word (`工作中` / `已完成` / …).
  The task name comes from the child's `subagent/descriptor` label (or the `subagent`
  tool call's `description`), truncated to fit.
- **Line 2** — what it is doing **right now**: the child's most recent tool call
  (`🔧 name + args`), else its latest reasoning, else `正在启动…` until activity appears.
- **Real-time** — a ticker re-reads the live child sessions every
  `subagentBoardRefreshMs` (default 2 s) and edits the same message in place
  (edits are throttled to ~1.5 s so Telegram's edit rate limit is never hit).
- **Pinned** — the board message is pinned on first subagent (the "fixed" part) so it
  stays at the top of the chat; `subagentBoardPin: false` disables pinning.
- **Locked on end** — when a subagent finishes (`subagent/end`), its row **freezes**
  with the terminal state and elapsed time and is never re-read. A re-start (a
  continuable child waking for a new epoch) re-opens the row as working.

Lifecycle edges come from DSH's `subagent/start` / `subagent/end` events (a global
listener, so the parent-scope filter is bypassed). A **presence sweep** of the live
`agents.list()` runs on the same ticker as a backstop: it starts any child the event
bus missed and locks any that vanished (after a short grace), so the board stays
correct even on a host where the events never reach the plugin. Only **direct
children** are shown by default; set `subagentBoardIncludeDescendants: true` to include
nested subagents. The overflow beyond `subagentBoardMaxRows` collapses into a
`… 另有 K 个未显示` line to keep the message under Telegram's 4096-char limit.

`/new` (or `/clear`) tears down the chat's board (unpin + delete); the board is also
torn down on plugin unload. Set `subagentBoardEnabled: false` to turn the feature off.
Like the progress indicator it is purely best-effort — a Telegram hiccup never
affects the real reply or the subagents themselves.

### Tool-guard approval (permission prompts on the phone)

When the agent's permission policy is `ask` (the default) and a tool call needs a
decision — for example a **sandbox escalation** like writing a file outside the
workspace, or a guarded `pre-execute` check — DSH resolves it through an
`approval/request` waterfall of *answerers*. If no answerer claims the request it
**fails closed**: the user sees nothing and the action is denied.

Before this feature, the Telegram plugin registered no answerer, so a Telegram
agent's ask was claimed by the web host (the browser UI, invisible on the phone)
or failed closed — the reported "no permission prompt on the phone" bug. This
release adds one, modelled on QwenPaw's `tool_guard` card:

- The plugin registers an `approval/request` answerer (run **before** the web
  answerer) that claims the requests it owns — its own `telegram-*` agents and, by
  default, the shared default agent — and delegates the rest so the web UI keeps
  working.
- It posts an inline-keyboard card to the owning chat: `🛡️ 需要授权批准` + the tool
  name + the reason DSH supplied, with **✅ 批准 / ❌ 拒绝** buttons.
- Tapping resolves the request: approve → `allowed-once`, deny → `rejected`.
  A timeout (`approvalTimeoutSec`), a turn abort, or an unload resolves it as
  `cancelled`. The card is edited in place to show the outcome and the button
  click is acked.

#### Allow always (🔁 一直允许)

DSH's approval service has no native "allow always" — the only grant it knows is
a one-shot `allowed-once`. This plugin adds it on top:

- The card carries a third button **🔁 一直允许** (approve-and-remember). Tapping
  it grants the current ask **and** remembers a stable rule key for that kind of
  ask. Matching future asks are then **auto-approved without posting a card**.
- Rule keys are normalized so a repeated ask maps to the same key even though the
  free-text reason changes: a sandbox escalation (`escalate sandbox to <mode>: …`)
  keys on `<tool>:<mode>` → `sandbox:<tool>:<mode>`; any other guarded ask keys on
  the whole tool → `tool:<name>`.
- Remembers persist to `$DSH_HOME/telegram-approval-always.json` (atomic write,
  survives a plugin reload). Manage them with the **`/approval`** command:
  `/approval` lists remembered rules, `/approval clear` clears all, and
  `/approval <ruleKey>` clears one by its exact key.

> ⚠️ "Always" is broad — a `sandbox:<tool>:<mode>` rule auto-approves every future
> escalation to that mode for the owning chat until you clear it. Use it for
> rules you genuinely want to stop being asked about.

Set `approvalEnabled: false` to turn it off entirely. If the card cannot be
delivered the request is delegated (to the web UI, or it fails closed) — it is
never silently dropped.

### Question cards (`ask_user_question` on the phone)

Sometimes the agent stops to **ask the user a question** — pick one of several
options, or type your own answer (the `ask_user_question` tool). In DSH the web
host owns the single UI provider for these asks, so **only the browser** sees
the prompt; a phone-only user would wait forever with nothing on screen. This
plugin adds a Telegram answerer:

1. It subscribes to the web host's `/api/events.mux` over loopback (the plugin
   runs inside the same `dsh web` process, reached via `DSH_WEB_URL` /
   `http://127.0.0.1:3080`).
2. When a `question/requested` frame arrives for **an agent this plugin owns**
   (or, with `questionsForDefaultAgent`, the shared default agent), it posts an
   **inline-keyboard card** to the owning chat.
3. Your answer goes back to the web host via `/api/respond`.

**How you answer:**
- **Single-choice question** — tap the option to answer instantly, **or just
  reply the card with plain text**: your text becomes the question's custom
  answer (this is the "type my own prompt" path).
- **Multi-choice question** — tap options to toggle them, then tap **✅ 提交**
  to submit. A question with several sub-questions is button-only; any
  sub-question you leave unanswered is skipped.
- **❌ 取消** cancels the ask.
- If the **web UI answers first**, the card flips to "已在网页端回答" — the first
  answer wins, so a late phone tap is dropped rather than double-submitted.
- Reconnecting the bot is safe: the mux replays still-pending questions, so a
  card is never lost on a drop.

Questions from **other (web-only) agents** are left to the browser — you won't
see duplicate cards. Set `questionsEnabled: false` to turn this off.

### Autopilot (full-auto mode)

`/autopilot` turns on a per-chat "reach the goal without hand-holding" mode —
the Telegram counterpart of a global `/goal`. It is **opt-in per chat** and
**explicitly warned** on enable, because it grants real power:

1. **Global write permission.** Enabling autopilot appends a
   `sandbox/mode = danger-full-access` event to the session, so bash/fs calls run
   with full disk access until you turn it off. On `/autopilot off`, the
   previously-captured mode is re-applied (default `workspace-write`).
2. **No permission prompts.** While a chat is in autopilot, the plugin's
   `approval/request` answerer auto-grants every ask instead of posting a card.
   Sandbox **escalations** route through the same answerer, so the agent reaches
   full write without ever blocking on a prompt. A short silent notice is posted
   so you can see what was auto-approved.
3. **Auto-adopt recommended answers.** While autopilot is on, an
   `ask_user_question` card auto-selects the agent's **recommended** option and
   commits after the `autopilotWindowMs` takeover window (default `10s`). The
   notice card lists all options + the one locked, with `⏩ 立即采纳` (commit now)
   and `✋ 接管` (stop autopilot for the chat + answer manually).

**Commands:** `/autopilot` or `/autopilot on` enable; `/autopilot off` disables
(and restores the prior sandbox mode); `/autopilot status` reports state.

> **Security warning.** Autopilot grants global write + auto-approves tool and
> sandbox escalations and auto-answers questions. There is a real risk of
> unintended, hard-to-reverse actions. Only enable it in a chat/session you trust
> and watch the silent notices. Set `autopilotEnabled: false` to remove the
> command entirely.
>
> **How the auto-allow works (not the `danger-full-access` preset).** The plugin
> does **not** switch to the `danger-full-access` permission preset or set
> `approval/policy: 'never'` — `never` *rejects* asks before dispatch rather than
> auto-allowing, which would break approvals. The auto-allow lives in this plugin's
> own `approval/request` answerer; the approval policy stays `ask`.

**Recommended-option convention.** For auto-adoption to pick the right answer,
the agent should put its **recommended** option **first** and tag its label with
`（推荐）` / `recommended`. While a chat is in autopilot the plugin injects this
instruction into every forwarded message (see [AGENT_INTEGRATION](AGENT_INTEGRATION.md)).
`pickRecommended` locks on the `推荐`/`recommended` marker, else falls back to the
first option.

## Creating a Telegram Bot

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the instructions
3. Copy the bot token
4. Add the bot to your target chat/group
5. Grant necessary permissions (admin rights for deleting messages)

## Usage Examples

### Send a message

Use `telegram_send_message` with:
- `chat_id`: "123456789"
- `text`: "Hello from DSH!"

### Send a photo

Use `telegram_send_photo` with:
- `chat_id`: "123456789"
- `photo`: "https://example.com/image.jpg"
- `caption`: "Check this out!"

### Get bot info

Use `telegram_get_info` to see the bot's username, ID, and current configuration.

### Manually check for updates

Use `telegram_get_updates` with `limit: 10` to fetch the latest 10 updates.

## Agent Integration

The plugin can inject Telegram messages directly into the DSH agent loop, enabling AI-powered conversations through Telegram.

### Quick Start

1. Enable polling and agent injection in `cordis.yml`:
```yaml
config:
  pollingEnabled: true
  injectToAgent: true
  agentResponseMode: 'tool'
```

2. Restart DSH:
```bash
dsh web --patch ./cordis.yml
```

3. Send a message to your Telegram bot — the agent will process it and respond automatically!

### How It Works

1. **Message Reception**: Poller receives Telegram messages via `getUpdates`
2. **Session Injection**: Messages are appended to the DSH session as `user/message` events
3. **Agent Processing**: The agent loop picks up the message and generates a response
4. **Tool-based Reply**: The agent uses `telegram_send_message` to send the reply

### Message Format

Injected messages include metadata:
```
[Telegram from @username in chat 123456789]
Your message content here
```

The agent can use this metadata to personalize responses and know which chat to reply to.

### Configuration Options

| Option | Description |
|--------|-------------|
| `injectToAgent: true` | Enable message injection to agent loop |
| `agentResponseMode: 'tool'` | Agent uses `telegram_send_message` tool (recommended) |
| `agentResponseMode: 'direct'` | Agent responds directly without tool |

For detailed documentation, see [AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   DSH Agent Loop                     │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │           Cordis Plugin (index.js)              │  │
│  │                                                │  │
│  │  ┌──────────────┐  ┌────────────────────────┐  │  │
│  │  │  Tools       │  │  Background Poller     │  │  │
│  │  │  · send_msg  │  │  · getUpdates loop     │  │  │
│  │  │  · send_photo│  │  · dispatch messages   │  │  │
│  │  │  · edit_msg  │  │  · reconnect on error  │  │  │
│  │  │  · delete_msg│  │  · rate limit backoff  │  │  │
│  │  └──────┬───────┘  └───────────┬────────────┘  │  │
│  │         │                      │                │  │
│  └─────────┼──────────────────────┼────────────────┘  │
│            │                      │                   │
└────────────┼──────────────────────┼───────────────────┘
             │                      │
             ▼                      ▼
    ┌──────────────────────────────────────┐
    │     Telegram Bot HTTP API            │
    │     (api.telegram.org)               │
    └──────────────────────────────────────┘
```

## File Structure

```
dsh-plugin-telegram/
├── CHANGELOG.md        # Version history
├── LICENSE             # MIT license
├── cordis.yml          # Sample cordis.yml patch for loading the plugin
├── package.json        # Package metadata
├── README.md           # This file
├── src/
│   ├── index.js        # Main plugin entry (tools + bot registry + polling + agent injection)
│   ├── client.js       # Telegram Bot API HTTP client (incl. pin/unpin, multipart upload)
│   ├── poller.js       # Long-polling background service (per-bot)
│   ├── text.js         # Pure text helpers (Markdown→HTML, fence-aware chunking)
│   ├── approval.js     # Tool-guard approval cards (incl. "allow always" remember-rules)
│   ├── questions.js    # ask_user_question cards (web-host mux bridge)
│   └── subagents.js    # Live subagent board (state, render, throttled flush)
├── test/
│   ├── text.test.mjs           # Pure text helpers (chunking, Markdown→HTML)
│   ├── client.test.mjs         # Transient-error classification, local-file upload
│   ├── poller.test.mjs         # Poller loop / offset / dedup
│   ├── progress.test.mjs       # Live-trajectory indicator
│   ├── approval.test.mjs       # Approval cards + allow-always rules
│   ├── questions.test.mjs      # Question cards + mux bridge
│   ├── subagents.test.mjs      # Subagent board
│   ├── command-media.test.mjs  # Command media helpers
│   └── multi-bot.test.mjs      # Multi-bot config contract + routing (T1–T32)
└── lib/                # Built output (copy of src/; `npm run prepare`)
    ├── index.js
    ├── client.js
    ├── poller.js
    ├── text.js
    ├── approval.js
    ├── questions.js
    └── subagents.js
```

## References

- [QwenPaw Telegram Channel](https://github.com/Quantum-Gizmo/QwenPaw/blob/main/src/qwenpaw/app/channels/telegram/channel.py) - Original implementation
- [DSH Plugin Tutorial](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) - Cordis plugin framework
- [Telegram Bot API](https://core.telegram.org/bots/api) - Official API documentation

## License

MIT
