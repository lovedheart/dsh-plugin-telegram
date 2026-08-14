/**
 * DSH Telegram plugin - main entry point.
 *
 * Provides tools for sending Telegram messages and a background polling
 * service for receiving updates. Modelled after QwenPaw's TelegramChannel
 * but adapted for the DSH Cordis plugin framework.
 *
 * No external dependencies — uses only Cordis ctx API.
 *
 * @module dsh-plugin-telegram
 */

import { TelegramClient } from './client.js';
import { TelegramPoller } from './poller.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export const name = 'dsh-plugin-telegram';
export const inject = ['tools', 'credentials'];

// ---------------------------------------------------------------------------
// Default configuration (applied before merging with user config)
// ---------------------------------------------------------------------------

const defaults = {
  botToken: '',
  baseUrl: '',
  allowedChats: [],
  allowedUsers: [],
  requireMention: false,
  pollingEnabled: false,
  longPollTimeout: 30,
  defaultChatId: '',
  maxMessageLength: 4000,
  parseMode: 'HTML',
  // Agent integration options
  injectToAgent: true,        // Whether to inject messages to agent loop
  agentResponseMode: 'tool',  // 'tool' = use telegram_send_message tool, 'direct' = direct reply
  replyPrefix: '',            // Prefix added to agent's response
  // Logging
  verbose: false,             // Enable debug and info logs (default: errors only)
};

// Config schema with basic type validation
// Some YAML parsers (and Cordis) may coerce empty arrays [] to empty objects {},
// so array fields accept both 'array' and 'object'.
const schema = {
  botToken: ['string'],
  baseUrl: ['string'],
  allowedChats: ['array', 'object'],
  allowedUsers: ['array', 'object'],
  requireMention: ['boolean'],
  pollingEnabled: ['boolean'],
  longPollTimeout: ['number'],
  defaultChatId: ['string'],
  maxMessageLength: ['number'],
  parseMode: ['string'],
  injectToAgent: ['boolean'],
  agentResponseMode: ['string'],
  replyPrefix: ['string'],
  verbose: ['boolean'],
};
export const Config = {
  '~standard': {
    validate: (raw) => {
      const cfg = raw ?? {};
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        throw new Error('Plugin config must be an object');
      }
      const errors = [];
      for (const [key, expectedTypes] of Object.entries(schema)) {
        if (key in cfg) {
          const actual = typeof cfg[key];
          if (!expectedTypes.includes(actual)) {
            errors.push(`config.${key}: expected ${expectedTypes.join('|')}, got ${actual}`);
          }
        }
      }
      if (errors.length) {
        throw new Error(`Invalid plugin config:\n  - ${errors.join('\n  - ')}`);
      }
      return { value: cfg };
    },
  },
};

// ---------------------------------------------------------------------------
// Resolve bot token from config / credentials / environment
// ---------------------------------------------------------------------------

function resolveBotToken(configToken, ctx) {
  // 1. 如果配置了明文值，直接使用
  if (configToken && configToken.trim().length > 0) {
    return configToken.trim();
  }

  // 2. 尝试从环境变量 TELEGRAM_BOT_TOKEN 读取
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  // 3. 尝试从 DSH credentials 服务读取 (ctx.credentials)
  if (ctx.credentials) {
    try {
      const resolved = ctx.credentials.resolve?.('TELEGRAM_BOT_TOKEN');
      if (resolved && resolved.length > 0) {
        return resolved;
      }
    } catch {
      // credentials 未配置该 key
    }
  }

  // 4. 尝试从 ctx.get('credentials') 读取
  const credentialsSvc = ctx.get?.('credentials');
  if (credentialsSvc) {
    try {
      const resolved = credentialsSvc.resolve?.('TELEGRAM_BOT_TOKEN');
      if (resolved && resolved.length > 0) {
        return resolved;
      }
    } catch {
      // credentials 未配置该 key
    }
  }

  // 5. 最后尝试直接读取 DSH .credentials.yaml 文件
  try {
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');
    const credsPath = join(dshHome, '.credentials.yaml');
    const content = readFileSync(credsPath, 'utf8');
    const match = content.match(/^TELEGRAM_BOT_TOKEN:\s*(.+)$/m);
    if (match) {
      let value = match[1].trim();
      // Strip YAML quotes (single or double)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value.length > 0) {
        return value;
      }
    }
  } catch {
    // 无法读取文件，忽略
  }

  return '';
}

// ---------------------------------------------------------------------------
// Text chunking (Telegram limit: 4096 chars per message)
// ---------------------------------------------------------------------------

function chunkText(text, maxSize) {
  if (!text || text.length <= maxSize) return text ? [text] : [];
  const chunks = [];
  let rest = text;
  while (rest) {
    if (rest.length <= maxSize) {
      chunks.push(rest);
      break;
    }
    let chunk = rest.slice(0, maxSize);
    const half = Math.floor(maxSize / 2);
    const lastNewline = chunk.lastIndexOf('\n', maxSize - 1);
    if (lastNewline > half) {
      chunk = chunk.slice(0, lastNewline + 1);
    } else {
      const lastSpace = chunk.lastIndexOf(' ', maxSize - 1);
      if (lastSpace > half) {
        chunk = chunk.slice(0, lastSpace + 1);
      }
    }
    chunks.push(chunk);
    rest = rest.slice(chunk.length).replace(/^\s+/, '');
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Markdown to Telegram HTML conversion
// ---------------------------------------------------------------------------

function markdownToTelegramHtml(md) {
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, __, code) => `<pre>${code.trim()}</pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return text;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const c = Object.assign({}, defaults, config);
  const botToken = resolveBotToken(c.botToken || '', ctx);
  const baseUrl = c.baseUrl || process.env.TELEGRAM_BASE_URL || '';
  const allowedChats = c.allowedChats || [];
  const allowedUsers = c.allowedUsers || [];
  const requireMention = c.requireMention || false;
  const pollingEnabled = c.pollingEnabled || false;
  const longPollTimeout = c.longPollTimeout || 30;
  const defaultChatId = c.defaultChatId || '';
  const maxMessageLength = c.maxMessageLength || 4000;
  const parseMode = c.parseMode || 'HTML';

  // Agent integration options
  const injectToAgent = c.injectToAgent !== false;
  const agentResponseMode = c.agentResponseMode || 'tool';
  const replyPrefix = c.replyPrefix || '';

  // Logging
  const verbose = c.verbose || false;
  function log(level, ...args) {
    if (verbose || level === 'error') {
      console[level](`[${name}]`, ...args);
    }
  }

  let client = null;
  let poller = null;

  // Initialize client if botToken is provided
  if (botToken) {
    client = new TelegramClient({
      botToken,
      baseUrl: baseUrl || undefined,
      allowedChats: allowedChats.length ? allowedChats : undefined,
      allowedUsers: allowedUsers.length ? allowedUsers : undefined,
      requireMention,
      longPollTimeout,
    });

    client.getMe()
      .then((me) => {
        log('info', `Telegram bot initialized: @${me.username} (ID: ${me.id})`);
      })
      .catch((err) => {
        log('error', `Failed to get bot info:`, err);
      });
  }

  // -----------------------------------------------------------------------
  // Helper: register a tool on ctx.tools
  // -----------------------------------------------------------------------
  function registerTool(toolDef) {
    ctx.tools.register({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters,
      execute: toolDef.execute,
      output: {
        schema: {
          type: 'string',
        },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
    });
  }

  // -----------------------------------------------------------------------
  // Tool: telegram_send_message
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_message',
    description: `Send a message to a Telegram chat. Supports text, HTML formatting, and automatic message splitting for long content.

The bot must have access to the target chat. For group chats, the bot must be a member.
Markdown in the text will be converted to Telegram HTML format automatically.`,

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (numeric or @username). Falls back to config default_chat_id if empty.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Message text content. Supports Markdown formatting.',
      },
      parse_mode: {
        type: 'string',
        enum: ['HTML', 'Markdown'],
        description: 'Parse mode for the message text.',
      },
      reply_to_message_id: {
        type: 'integer',
        description: 'Message ID to reply to.',
      },
      message_thread_id: {
        type: 'integer',
        description: 'For forum topics: the thread ID to reply in.',
      },
      disable_notification: {
        type: 'boolean',
        description: 'Send the message silently without notification.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured. Set botToken in plugin config or TELEGRAM_BOT_TOKEN environment variable.');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required and no default_chat_id is configured.');
      }

      const text = args.text || '';
      const pMode = args.parse_mode || parseMode;
      const chunks = chunkText(text, maxMessageLength);

      const sentMessages = [];
      for (let i = 0; i < chunks.length; i++) {
        let finalText = chunks[i];
        if (pMode === 'HTML') {
          finalText = markdownToTelegramHtml(chunks[i]);
        }

        const result = await client.sendMessage({
          chatId,
          text: finalText,
          parseMode: pMode,
          replyToMessageId: i === 0 ? args.reply_to_message_id : undefined,
          messageThreadId: args.message_thread_id,
          disableNotification: args.disable_notification,
        });

        sentMessages.push(result.messageId);
      }

      const summary = sentMessages.map((id) => `message_id: ${id}`).join(', ');
      return `Message sent successfully (${sentMessages.length} message(s)): ${summary}`;
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_send_photo
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_photo',
    description: 'Send a photo to a Telegram chat. The photo parameter can be a Telegram file_id (previously uploaded) or a public URL.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      photo: {
        type: 'string',
        required: true,
        description: 'Telegram file_id or public URL of the photo.',
      },
      caption: {
        type: 'string',
        description: 'Optional photo caption.',
      },
      parse_mode: {
        type: 'string',
        enum: ['HTML', 'Markdown'],
        description: 'Parse mode for the caption.',
      },
      message_thread_id: {
        type: 'integer',
        description: 'For forum topics: the thread ID.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }

      const caption = args.caption ? (
        args.parse_mode === 'Markdown'
          ? args.caption
          : markdownToTelegramHtml(args.caption)
      ) : undefined;

      const result = await client.sendPhoto({
        chatId,
        photo: args.photo,
        caption,
        parseMode: args.parse_mode || parseMode,
        messageThreadId: args.message_thread_id,
      });

      return `Photo sent successfully (message_id: ${result.messageId})`;
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_send_document
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_document',
    description: 'Send a document (file) to a Telegram chat. The document parameter can be a Telegram file_id or a public URL.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      document: {
        type: 'string',
        required: true,
        description: 'Telegram file_id or public URL of the document.',
      },
      caption: {
        type: 'string',
        description: 'Optional document caption.',
      },
      parse_mode: {
        type: 'string',
        enum: ['HTML', 'Markdown'],
        description: 'Parse mode for the caption.',
      },
      message_thread_id: {
        type: 'integer',
        description: 'For forum topics: the thread ID.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }

      const caption = args.caption ? (
        args.parse_mode === 'Markdown'
          ? args.caption
          : markdownToTelegramHtml(args.caption)
      ) : undefined;

      const result = await client.sendDocument({
        chatId,
        document: args.document,
        caption,
        parseMode: args.parse_mode || parseMode,
        messageThreadId: args.message_thread_id,
      });

      return `Document sent successfully (message_id: ${result.messageId})`;
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_edit_message
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_edit_message',
    description: 'Edit an existing Telegram message. The bot can only edit its own messages.',

    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Chat ID where the message is.',
      },
      message_id: {
        type: 'integer',
        required: true,
        description: 'Message ID to edit.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'New message text.',
      },
      parse_mode: {
        type: 'string',
        enum: ['HTML', 'Markdown'],
        description: 'Parse mode for the new text.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const text = args.parse_mode === 'Markdown'
        ? args.text
        : markdownToTelegramHtml(args.text);

      const success = await client.editMessageText(
        args.chat_id,
        args.message_id,
        text,
        args.parse_mode || parseMode,
      );

      if (success) {
        return `Message ${args.message_id} edited successfully.`;
      } else {
        throw new Error(`Failed to edit message ${args.message_id}. It may have been deleted or is unchanged.`);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_delete_message
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_delete_message',
    description: 'Delete a Telegram message. The bot can delete its own messages and, if it has admin rights, other messages too.',

    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Chat ID where the message is.',
      },
      message_id: {
        type: 'integer',
        required: true,
        description: 'Message ID to delete.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const success = await client.deleteMessage(args.chat_id, args.message_id);
      if (success) {
        return `Message ${args.message_id} deleted successfully.`;
      } else {
        throw new Error(`Failed to delete message ${args.message_id}.`);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_get_info
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_get_info',
    description: 'Get information about the Telegram bot (username, ID) and current configuration status.',

    parameters: {},

    async execute() {
      if (!client) {
        throw new Error('Telegram bot is not configured. Set botToken in plugin config or TELEGRAM_BOT_TOKEN environment variable.');
      }

      const me = await client.getMe();
      return [
        'Telegram Bot Info:',
        `- ID: ${me.id}`,
        `- Username: @${me.username}`,
        `- Name: ${me.firstName}`,
        '',
        'Configuration:',
        `- Polling: ${pollingEnabled ? 'enabled' : 'disabled'}`,
        `- Default chat: ${defaultChatId || 'not set'}`,
        `- Parse mode: ${parseMode}`,
        `- Allowed chats: ${allowedChats.length ? allowedChats.join(', ') : 'all'}`,
        `- Allowed users: ${allowedUsers.length ? allowedUsers.join(', ') : 'all'}`,
        `- Require mention in groups: ${requireMention}`,
        '',
        'Agent Integration:',
        `- Inject to agent: ${injectToAgent ? 'enabled' : 'disabled'}`,
        `- Response mode: ${agentResponseMode}`,
        `- Sessions service: ${ctx.get?.('sessions') ? 'yes' : 'no'}`,
        `- Agents service: ${ctx.get?.('agents') ? 'yes' : 'no'}`,
      ].join('\n');
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_get_updates (manual poll)
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_get_updates',
    description: 'Manually poll for new Telegram updates. Useful for checking recent messages without enabling continuous polling.',

    parameters: {
      offset: {
        type: 'integer',
        description: 'Offset to start from (update_id). Skips already processed updates.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of updates to fetch.',
      },
    },

    async execute(args) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const offset = args.offset;
      const limit = args.limit || 20;
      const updates = await client.getUpdates(offset, limit, 5);

      if (updates.length === 0) {
        return 'No new updates.';
      }

      const lines = updates.map((u) => {
        const msg = u.message || u.editedMessage;
        if (msg) {
          return `Update #${u.updateId}: [${msg.chatType}] from ${msg.senderUsername || msg.senderId} in chat ${msg.chatId}: ${msg.text?.slice(0, 200) || '(media message)'}`;
        }
        if (u.callbackQuery) {
          return `Update #${u.updateId}: Callback from ${u.callbackQuery.from.username || u.callbackQuery.from.id}: data="${u.callbackQuery.data?.slice(0, 200)}"`;
        }
        return `Update #${u.updateId}: (unknown type)`;
      });

      return `Received ${updates.length} update(s):\n${lines.join('\n')}`;
    },
  });

  // -----------------------------------------------------------------------
  // Background polling service
  // -----------------------------------------------------------------------

  if (pollingEnabled && client) {
    poller = new TelegramPoller(client, {
      allowedChats: allowedChats.length ? allowedChats : undefined,
      allowedUsers: allowedUsers.length ? allowedUsers : undefined,
      requireMention,
      longPollTimeout,
      verbose,
    });

    poller.onMessage(async (message) => {
      const sender = message.senderUsername || message.senderName || message.senderId;
      log('info', `Message from ${sender} in chat ${message.chatId}: ${message.text?.slice(0, 100) || '(media)'}`);

      if (allowedChats.length && !allowedChats.includes(message.chatId)) return;
      if (allowedUsers.length && !allowedUsers.includes(message.senderId)) return;

      if (requireMention && (message.chatType === 'group' || message.chatType === 'supergroup')) {
        const bot = await client.getMe();
        if (!message.text?.includes(`@${bot.username}`)) return;
      }

      if (message.text) {
        // Show typing action
        await client.sendChatAction(message.chatId, 'typing', message.messageThreadId);

        // Inject message to agent session if enabled
        // Note: session and agent are looked up dynamically since they're created at runtime
        // Service names: 'sessions' and 'agents' (plural, per Cordis convention)
        const agentsSvc = ctx.get?.('agents');
        const sessionsSvc = ctx.get?.('sessions');

        // Get current agent from list (typically only one agent per session)
        // Using list() since currentInitiator() only works within agent's async context
        const allAgents = agentsSvc?.list?.() ?? [];
        const currentAgent = allAgents[0] ?? null;

        // Agent has a .session property that gives us the session
        const currentSession = currentAgent?.session;

        if (injectToAgent && currentSession && currentAgent) {
          try {
            // Create user message in DSH format with clear reply instructions
            const userMessage = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[Telegram message from ${sender} in chat ${message.chatId}]
${message.text}

Please reply to this Telegram message using telegram_send_message tool with chat_id: ${message.chatId}`,
                },
              ],
              source: {
                kind: 'telegram',
                chatId: String(message.chatId),
                messageId: String(message.messageId),
                senderName: sender,
              },
              id: `telegram-${Date.now()}-${message.messageId}`,
            };

            // Queue message in agent inbox and wake the driver
            currentAgent.inbox.append('next-turn', userMessage);
            if (currentAgent.wakeDriver) {
              currentAgent.wakeDriver(false);
            }

            log('info', 'Telegram message sent to agent for processing');

            // The agent will process the message and respond using tools
            // We don't need to send a reply here - the agent will use telegram_send_message tool
            return;
          } catch (err) {
            log('error', `Failed to inject message to agent:`, err.message);
          }
        } else if (injectToAgent) {
          log('info', 'Agent injection enabled but session/agent not available yet');
        }

        // Fallback: direct echo response if not injecting to agent
        const responseText = `Received your message: "${message.text?.slice(0, 100)}"`;
        await client.sendMessage({
          chatId: message.chatId,
          text: responseText,
          parseMode: parseMode,
          replyToMessageId: message.messageId,
          messageThreadId: message.messageThreadId,
        });
      }
    });

    poller.onCallbackQuery(async (query) => {
      log('info', `Callback query from ${query.from.username || query.from.id}: data="${query.data}"`);
      await client.answerCallbackQuery(query.id, 'Acknowledged');
    });

    poller.start();
    log('info', 'Telegram poller started.');
  }

  // -----------------------------------------------------------------------
  // Cleanup on unload
  // -----------------------------------------------------------------------

  ctx.effect(() => {
    return () => {
      poller?.stop();
      log('info', 'Telegram plugin unloaded.');
    };
  });
}
