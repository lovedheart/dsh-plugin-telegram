# Telegram Agent Integration

This plugin now supports injecting Telegram messages directly into the DSH agent loop, enabling full AI-powered conversations via Telegram.

## How It Works

1. **Message Reception**: The Telegram poller receives incoming messages via long-polling
2. **Session Injection**: Messages are injected into the DSH session as `user/message` events
3. **Agent Processing**: The DSH agent processes the message and generates a response
4. **Tool-based Reply**: The agent uses the `telegram_send_message` tool to send replies back to Telegram

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

Please reply to this Telegram message using telegram_send_message tool with chat_id: 123456789`,
  }],
  source: {
    kind: 'telegram',
    chatId: '123456789',
    messageId: '9876543',
    senderName: '@username',
  },
  id: 'telegram-{timestamp}-{messageId}',
}
```

**Important**:
- Messages must include the `source.kind` field
- The message text includes explicit reply instructions to guide the agent to use the `telegram_send_message` tool

## Agent Response Flow

1. User sends message to Telegram bot
2. Poller receives message via `getUpdates`
3. Message is injected to session: `session.append('user/message', message, { surfaceOp: 'push' })`
4. Agent loop picks up the message and processes it
5. Agent calls `telegram_send_message` tool with response
6. Reply is sent to the same Telegram chat

## Debugging

Check the terminal output for:
- `[telegram-poller] Message from ...` - Message received
- `[telegram-plugin] Message injected to agent session (seq: ...)` - Injection successful
- Agent tool calls showing `telegram_send_message` being used

## Fallback Behavior

If `injectToAgent` is `false` or if session/agent are unavailable, the plugin falls back to echo mode:
```
Received your message: "..."
```

## Security Considerations

- Use `allowedChats` to restrict which chats can trigger the agent
- Use `allowedUsers` to restrict which users can interact
- Use `requireMention: true` for group chats to avoid processing every message

## Troubleshooting

**Messages not being processed by agent:**
1. Verify `injectToAgent: true` in config
2. Check terminal for "Session available: yes" and "Agent available: yes" in `telegram_get_info`
3. Look for error messages about session.append failures

**Agent not responding to Telegram:**
1. The agent needs to know to use `telegram_send_message` tool
2. Ensure `defaultChatId` is set, or the agent should extract chatId from the injected message
3. Check agent instructions mention Telegram response capability

