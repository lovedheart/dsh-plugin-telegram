# Telegram Agent Integration

This plugin now supports injecting Telegram messages directly into the DSH agent loop, enabling full AI-powered conversations via Telegram.

## How It Works

1. **Message Reception**: The Telegram poller receives incoming messages via long-polling
2. **Session Injection**: Messages are injected into the DSH session as `user/message` events via the public `agent.followup(message)` API
3. **Agent Processing**: The DSH agent processes the message and generates a response
4. **Reply Delivery** (two modes):
   - **`tool` mode** (default): the agent calls the `telegram_send_message` tool to reply
   - **`direct` mode**: the plugin watches the agent turn and auto-sends the final assistant text back to the chat (no reliance on the agent choosing the right tool)

## Configuration

Add these options to your `cordis.yml`:

```yaml
config:
  # Enable polling for incoming messages
  pollingEnabled: true
  
  # Agent integration options
  injectToAgent: true        # Inject messages to agent loop (default: true)
  agentResponseMode: 'tool'  # 'tool' = agent uses telegram_send_message, 'direct' = direct reply
  replyPrefix: ''            # Optional prefix for agent responses
```

## Message Format

When a Telegram message is injected into the agent session, it includes metadata:

```javascript
{
  role: 'user',
  content: [{
    type: 'text',
    text: `[Telegram message from @username in chat 123456789]
Your message content here

Reply to it using the telegram_send_message tool with chat_id: 123456789.`,
  }],
  source: {
    kind: 'plugin',          // DSH MessageSource kind must be user|plugin|model|tool
    plugin: 'dsh-plugin-telegram',
  },
  id: 'telegram-{timestamp}-{messageId}',
}
```

**Important**:
- `source.kind` must be a valid DSH `MessageSource` kind. This plugin uses
  `plugin` (it is the source of the message); the chat id is kept in the text
  so the agent can route replies.
- In **tool** mode the text explicitly instructs the agent to use
  `telegram_send_message`; in **direct** mode it instructs the agent to answer
  as normal text (the plugin forwards the reply automatically), to avoid a
  double reply.

## Agent Response Flow

1. User sends message to Telegram bot
2. Poller receives message via `getUpdates`
3. Message is injected: `agent.followup(userMessage)` (public API; equivalent
   to `agent.send(userMessage, 'next-turn', true)`)
4. Agent loop picks up the message and processes it
5. Reply is delivered:
   - **tool** mode: agent calls `telegram_send_message`
   - **direct** mode: plugin awaits the turn finishing (agent idle + a new
     assistant message) and calls `telegram_send_message` with the final text

## Autopilot — recommended option convention

When a chat is in **autopilot** mode (see README "Autopilot (full-auto mode)"),
the plugin auto-adopts the agent's **recommended** option for every
`ask_user_question` and commits it after a short takeover window. To make that
auto-adoption pick the *right* answer, follow this convention whenever you call
`ask_user_question`:

- Put the **recommended** option **first** in `options`.
- Tag its `label` with **`（推荐）`** (or `recommended`). Example:

  ```json
  {
    "questions": [{
      "id": "stack",
      "question": "选用哪种实现？",
      "options": [
        { "label": "方案 A（推荐）", "description": "改动小、可回滚" },
        { "label": "方案 B", "description": "更彻底但风险高" },
        { "label": "方案 C", "description": "折中" }
      ]
    }]
  }
  ```

Detection (`pickRecommended`): scan each option's `label`+`description` for
`推荐` / `recommend`; the first flagged option is auto-adopted (single-select) or
all flagged ones (multi-select). With **no** marker it falls back to the **first**
option — which is why "recommended first" is the convention. The plugin also
injects this same instruction into every forwarded message while a chat is in
autopilot, so agents see it even without reading this doc.

> If a question has **no** auto-pickable option, autopilot falls back to the
> normal interactive card instead of guessing.

## Debugging

Check the terminal output for:
- `[telegram-poller] Message from ...` - Message received
- `[telegram-plugin] Message injected to agent session (seq: ...)` - Injection successful
- Agent tool calls showing `telegram_send_message` being used

## Fallback Behavior

If `injectToAgent` is `false` or if no agent is available, the plugin falls back to echo mode for text messages:
```
Received your message: "..."
```
Non-text media (photo/document/video/audio/voice) is acknowledged with a short receipt either way — it is not yet forwarded to the agent.

## Security Considerations

- Use `allowedChats` to restrict which chats can trigger the agent
- Use `allowedUsers` to restrict which users can interact
- Use `requireMention: true` for group chats to avoid processing every message
- The Telegram sender is external, untrusted input; treat its content as such.

## Troubleshooting

**Messages not being processed by agent:**
1. Verify `injectToAgent: true` in config
2. Check `Agents service: yes` in `telegram_get_info` (resolves the `agents` ctx service)
3. Look for log lines `sent to agent for processing` / `Failed to inject message to agent`

**Agent not responding to Telegram (tool mode):**
1. The agent must actually call `telegram_send_message` — model function-calling support varies; consider `agentResponseMode: 'direct'` to remove that dependency
2. Ensure `defaultChatId` is set, or the agent extracts the chat id from the injected message
3. Check agent instructions mention the Telegram response capability

**Direct mode not replying:**
1. The agent must finish its turn (status `idle`) and produce an assistant text message
2. Watch for `Direct reply sent to Telegram chat ...` / `no assistant reply within timeout` log lines

