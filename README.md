# dsh-plugin-telegram

DeepSeek Harness (DSH) plugin for Telegram Bot integration. Provides tools for sending and receiving Telegram messages, with optional long-polling for incoming messages.

Based on the Telegram channel implementation from [QwenPaw](https://github.com/Quantum-Gizmo/QwenPaw), adapted for the DSH Cordis plugin framework.

## Features

- **Send messages** with Markdown/HTML formatting
- **Send photos and documents** via file_id or URL
- **Edit and delete** existing messages
- **Long-polling** for incoming messages (optional)
- **Agent integration**: Inject Telegram messages into DSH agent loop for AI-powered conversations
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
| `telegram_get_info` | Get bot info and config status |
| `telegram_get_updates` | Manually poll for new updates |

## Installation

### 1. 设置 Token（三种方式，优先级从高到低）

**方式一：DSH Credentials 系统（推荐，最安全）**

通过 DSH Web UI 的 Models/Credentials 页面设置，或使用命令行：
```bash
# 写入 $DSH_HOME/.credentials.yaml（权限 0600，只有所有者可读）
dsh credential set TELEGRAM_BOT_TOKEN '你的token'
```

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
| `verbose` | boolean | `false` | Enable debug and info logs (default: errors only) |

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
│   ├── index.js        # Main plugin entry (tools + polling setup)
│   ├── client.js       # Telegram Bot API HTTP client
│   └── poller.js       # Long-polling background service
└── lib/                # Built output (copy of src/)
    ├── index.js
    ├── client.js
    └── poller.js
```

## References

- [QwenPaw Telegram Channel](https://github.com/Quantum-Gizmo/QwenPaw/blob/main/src/qwenpaw/app/channels/telegram/channel.py) - Original implementation
- [DSH Plugin Tutorial](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) - Cordis plugin framework
- [Telegram Bot API](https://core.telegram.org/bots/api) - Official API documentation

## License

MIT
