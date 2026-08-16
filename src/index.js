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

import { TelegramClient, TelegramRateLimitError, isTransientTelegramError } from './client.js';
import { TelegramPoller } from './poller.js';
import { chunkText, markdownToTelegramHtml, guardConvertedLength } from './text.js';
import { randomUUID } from 'node:crypto';

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
  agentResponseMode: 'tool',  // 'tool' = agent uses telegram_send_message, 'direct' = auto-capture & send
  replyPrefix: '',            // Prefix added to agent's direct reply
  // direct mode: max seconds to wait for a turn's final assistant message
  // before giving up on auto-forwarding. Long agent work (tool-call chains)
  // can easily exceed a few minutes, so the default is generous: 1 hour.
  // Short replies are still forwarded within seconds — this is only the cap.
  directReplyTimeoutSec: 3600,
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
  directReplyTimeoutSec: ['number'],
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
// Resolve bot token from config / credentials / environment.
//
// DSH's credentials service is async and returns `{ value, source }` (see
// dsh-credentials README + dsh-credentials-local resolve()). We await it and
// unwrap `.value` — the previous version treated the Promise as a string and
// therefore never picked up a credentials-based token.
// ---------------------------------------------------------------------------

function isUsableCredential(hit) {
  if (!hit) return '';
  // Shape A (real DSH credentials service): { value, source }
  if (typeof hit === 'object' && typeof hit.value === 'string' && hit.value.length > 0) {
    return hit.value;
  }
  // Shape B (defensive): a bare string
  if (typeof hit === 'string' && hit.length > 0) {
    return hit;
  }
  return '';
}

async function resolveBotToken(configToken, ctx) {
  // 1. 明文配置
  if (configToken && configToken.trim().length > 0) {
    return configToken.trim();
  }
  // 2. 环境变量
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  // 3. DSH credentials service (ctx.credentials 或 ctx.get('credentials'))
  for (const svc of [ctx.credentials, ctx.get?.('credentials')]) {
    if (!svc || typeof svc.resolve !== 'function') continue;
    try {
      const hit = await svc.resolve('TELEGRAM_BOT_TOKEN');
      const value = isUsableCredential(hit);
      if (value) return value;
    } catch {
      // 该 source 未配置或读取失败，继续下一条来源
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function apply(ctx, config) {
  const c = Object.assign({}, defaults, config);
  const botToken = await resolveBotToken(c.botToken || '', ctx);
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
  const directReplyTimeoutMs = Math.max(10, Number(c.directReplyTimeoutSec) || 3600) * 1000;

  // Logging — prefer ctx.logger when the plugin is loaded inside a full DSH
  // host; fall back to console for unit tests or standalone loads.
  const verbose = c.verbose || false;
  const namedLogger = ctx.logger ? (() => { try { return ctx.logger(name); } catch { return null; } })() : null;
  function log(level, ...args) {
    if (!verbose && level !== 'error') return;
    if (namedLogger && typeof namedLogger[level] === 'function') {
      namedLogger[level](`[${name}]`, ...args);
    } else {
      console[level](`[${name}]`, ...args);
    }
  }

  let client = null;
  let poller = null;

  // Dedup set of injected Telegram message ids (in-memory; bounded by a cap
  // below so a long-running plugin can't leak memory).
  const injectedIds = new Set();
  const INJECTED_ID_CAP = 4096;
  function rememberInjectedId(id) {
    if (injectedIds.size >= INJECTED_ID_CAP) injectedIds.clear();
    injectedIds.add(id);
  }

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
        log('error', `Failed to get bot info:`, err.message);
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

  // Send a text payload, converting + chunking + guarding as needed.
  // Returns the list of sent message ids (one per chunk).
  // opts.html: true => rawText is ALREADY valid Telegram HTML: send it as-is
  // with parse_mode=HTML (no markdown conversion / escaping). Intended for
  // short, plugin-authored messages (command replies); chunking is naive for
  // HTML so keep such messages well under maxMessageLength.
  async function sendText(chatId, rawText, opts) {
    const pMode = opts.parseMode || (opts.html ? 'HTML' : parseMode);
    const doConvert = pMode === 'HTML' && !opts.html;
    const chunks = chunkText(rawText, maxMessageLength);
    if (chunks.length === 0) return [];

    const sent = [];
    for (let i = 0; i < chunks.length; i++) {
      let finalText = chunks[i];
      let useParseMode = pMode;
      if (doConvert) {
        const guarded = guardConvertedLength(chunks[i], markdownToTelegramHtml(chunks[i]), 4096);
        finalText = guarded.text;
        useParseMode = guarded.useParseMode ? pMode : undefined;
      }
      const body = {
        chatId,
        text: finalText,
        parseMode: useParseMode,
        replyToMessageId: i === 0 ? opts.replyToMessageId : undefined,
        messageThreadId: opts.messageThreadId,
        disableNotification: opts.disableNotification,
        signal: opts.signal,
      };
      // Delivery retry: this link to api.telegram.org has been measured at
      // ~45% request timeouts, so a single failed send can silently drop an
      // agent reply. Retry transient failures (network / undici transport /
      // 429 / 409); permanent errors (400 bad entities, 403, ...) propagate.
      const maxAttempts = 5;
      let result;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await client.sendMessage(body);
          break;
        } catch (err) {
          if (attempt >= maxAttempts || !isTransientTelegramError(err)) {
            log('error', `sendMessage to chat ${chatId} failed after ${attempt} attempt(s): ${err.message}`);
            throw err;
          }
          const delayMs = err instanceof TelegramRateLimitError
            ? err.retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 10_000);
          log('warn', `sendMessage to chat ${chatId} attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
          await sleep(delayMs);
        }
      }
      sent.push(result.messageId);
    }
    return sent;
  }

  // Extract the plain text of an assistant message event (data.message).
  function textOfAssistantMessage(evt) {
    const msg = evt?.data?.message;
    if (!msg || !Array.isArray(msg.content)) return '';
    return msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // `direct` mode: after we inject a Telegram message into the agent, wait for
  // the resulting turn to finish, then send the agent's final text reply to
  // Telegram ourselves. We poll until the agent is idle AND has produced an
  // assistant message after the injection point, which avoids relying on the
  // exact timing semantics of agent.whenIdle() for work queued just before.
  async function watchDirectReply(agent, chatId, telegramMessageId) {
    try {
      const session = agent.session;
      const baseline = session && Array.isArray(session.events) ? session.events.length : 0;

      // 1) Let the turn finish: idle + an assistant message exists after baseline.
      // Long agent work (multi-tool-call turns) can run many minutes; the
      // timeout is configurable (directReplyTimeoutSec, default 1h) and is
      // only a cap — short replies are forwarded within seconds.
      const deadline = Date.now() + directReplyTimeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        const evts = session?.events;
        const hasAssistant = Array.isArray(evts) && hasAssistantMessage(evts, baseline);
        if (hasAssistant && agent.status === 'idle') { ready = true; break; }
        await sleep(300);
      }
      if (!ready) {
        log('warn', `Direct mode: no assistant reply within timeout for chat ${chatId}`);
        return;
      }

      // 2) Read the newest assistant message after baseline.
      const evts = session.events;
      let replyText = '';
      for (let i = evts.length - 1; i >= baseline; i--) {
        const evt = evts[i];
        if (evt?.type === 'assistant/message') {
          const t = textOfAssistantMessage(evt);
          if (t) { replyText = t; break; }
        }
      }
      if (!replyText) {
        log('warn', `Direct mode: agent produced no text reply for chat ${chatId}`);
        return;
      }

      // 3) Deliver it.
      const prefixed = replyPrefix ? `${replyPrefix}\n${replyText}` : replyText;
      await sendText(String(chatId), prefixed, { replyToMessageId: telegramMessageId });
      log('info', `Direct reply sent to Telegram chat ${chatId}`);
    } catch (err) {
      log('error', 'Direct-mode reply failed:', err.message);
    }
  }

  function hasAssistantMessage(events, baseline) {
    for (let i = events.length - 1; i >= baseline; i--) {
      if (events[i]?.type === 'assistant/message') return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Tool: telegram_send_message
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_message',
    description: `Send a message to a Telegram chat. Supports text, HTML formatting, and automatic message splitting for long content.

The bot must have access to the target chat. For group chats, the bot must be a member.
Markdown in the text will be converted to Telegram HTML format automatically (when parse_mode is HTML, the default).`,

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (numeric or @username). Falls back to config defaultChatId if empty.',
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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured. Set botToken in plugin config or TELEGRAM_BOT_TOKEN environment variable (or DSH credentials).');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required and no defaultChatId is configured.');
      }

      const text = args.text || '';
      const sent = await sendText(chatId, text, {
        parseMode: args.parse_mode,
        replyToMessageId: args.reply_to_message_id,
        messageThreadId: args.message_thread_id,
        disableNotification: args.disable_notification,
        signal: exec?.signal,
      });

      const summary = sent.map((id) => `message_id: ${id}`).join(', ');
      return `Message sent successfully (${sent.length} message(s)): ${summary}`;
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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }

      let caption;
      let captionParseMode = args.parse_mode || parseMode;
      if (args.caption) {
        if (captionParseMode === 'Markdown') {
          caption = args.caption;
        } else {
          const guarded = guardConvertedLength(args.caption, markdownToTelegramHtml(args.caption), 1024);
          caption = guarded.text;
          if (!guarded.useParseMode) captionParseMode = undefined;
        }
      }

      const result = await client.sendPhoto({
        chatId,
        photo: args.photo,
        caption,
        parseMode: captionParseMode,
        messageThreadId: args.message_thread_id,
        signal: exec?.signal,
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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }

      let caption;
      let captionParseMode = args.parse_mode || parseMode;
      if (args.caption) {
        if (captionParseMode === 'Markdown') {
          caption = args.caption;
        } else {
          const guarded = guardConvertedLength(args.caption, markdownToTelegramHtml(args.caption), 1024);
          caption = guarded.text;
          if (!guarded.useParseMode) captionParseMode = undefined;
        }
      }

      const result = await client.sendDocument({
        chatId,
        document: args.document,
        caption,
        parseMode: captionParseMode,
        messageThreadId: args.message_thread_id,
        signal: exec?.signal,
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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      let text;
      let pMode = args.parse_mode || parseMode;
      if (pMode === 'HTML') {
        const guarded = guardConvertedLength(args.text, markdownToTelegramHtml(args.text), 4096);
        text = guarded.text;
        if (!guarded.useParseMode) pMode = undefined;
      } else {
        text = args.text;
      }

      const success = await client.editMessageText(args.chat_id, args.message_id, text, pMode, exec?.signal);
      if (success) {
        return `Message ${args.message_id} edited successfully.`;
      }
      throw new Error(`Failed to edit message ${args.message_id}. It may have been deleted or is unchanged.`);
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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }
      const success = await client.deleteMessage(args.chat_id, args.message_id, exec?.signal);
      if (success) {
        return `Message ${args.message_id} deleted successfully.`;
      }
      throw new Error(`Failed to delete message ${args.message_id}.`);
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
        throw new Error('Telegram bot is not configured. Set botToken in plugin config, TELEGRAM_BOT_TOKEN environment variable, or the DSH credentials service.');
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
    description: 'Manually poll for new Telegram updates. Useful for checking recent messages without enabling continuous polling. NOTE: if the background poller is enabled, calling this tool will intermittently return a 409 conflict (Telegram only allows one active getUpdates consumer per bot).',

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

    async execute(args, exec) {
      if (!client) {
        throw new Error('Telegram bot is not configured.');
      }

      const offset = args.offset;
      const limit = args.limit || 20;
      let updates;
      try {
        updates = await client.getUpdates(offset, limit, 5, exec?.signal);
      } catch (err) {
        const text = String(err?.message || '') + ' ' + String(err?.details || '');
        if (/409/i.test(text) || /conflict/i.test(text) || /terminated by other/i.test(text)) {
          throw new Error('getUpdates conflict (409): another poller is already consuming this bot. Stop the background poller (pollingEnabled: false) or wait for it to finish before using this tool.');
        }
        throw err;
      }

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
  // Tool: telegram_get_last_assistant_message (test / debug helper)
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_get_last_assistant_message',
    description: 'Return the most recent assistant message from the current DSH session. Useful for verifying that a turn completed, or for inspecting what the agent said last. Returns an empty string when no assistant message has been produced yet.',

    parameters: {},

    async execute() {
      const agentsSvc = ctx.get?.('agents');
      const agents = agentsSvc?.list?.() ?? [];
      for (let i = agents.length - 1; i >= 0; i--) {
        const agent = agents[i];
        const session = agent?.session;
        if (!session || !Array.isArray(session.events)) continue;
        for (let j = session.events.length - 1; j >= 0; j--) {
          const evt = session.events[j];
          if (evt?.type === 'assistant/message') {
            return textOfAssistantMessage(evt) || '(assistant message with no text content)';
          }
        }
      }
      return '(no assistant messages yet)';
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

    // Per-chat active agent routing (Plan A):
    //   /new          -> create a fresh agent+session, route this chat to it
    //   /sessions     -> list live agents (id + status + origin)
    //   /use <id>     -> route this chat to an existing agent id
    // Regular messages go to the chat's active agent (fallback: first agent).
    // Agents created here are owned by this plugin and kept alive via the
    // handles array (so the fiber's disposal bookkeeping tracks them).
    const chatAgents = new Map(); // chatId (string) -> agent sessionId (string)
    const ownedHandles = []; // AgentHandle[] kept so created agents are not disposed

    async function createTelegramAgent(chatId) {
      const agentsSvc = ctx.get?.('agents');
      if (!agentsSvc?.create) throw new Error('agents service unavailable');
      const sessionId = `telegram-${randomUUID()}`;
      // The deployment:persona prompt section assembles {{cwd}} from the
      // session header and {{model}}/{{provider}} from agent.options. A
      // session/agent created without them fails every turn with
      // `prompt variable "{{cwd}}" / "{{model}}" has no value`.
      // Mirror the DSH host's ensureSession(): inherit cwd + provider/model
      // from the default agent; fall back to the agentDefaultModel service.
      const defaultAgent = (agentsSvc.list?.() ?? [])[0];
      const cwd = defaultAgent?.session?.header?.cwd ?? process.cwd();
      let agentOptions;
      if (defaultAgent?.options?.provider && defaultAgent?.options?.model) {
        agentOptions = { provider: defaultAgent.options.provider, model: defaultAgent.options.model };
      } else {
        try {
          const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.();
          if (sel?.provider && sel?.model) agentOptions = { provider: sel.provider, model: sel.model };
        } catch { /* leave agentOptions unset; host default will apply */ }
      }
      // The agent's tool catalog, prompt sections, and skill catalog all come
      // from the AGENT PRESET it joins at setup time (dsh-agent-presets: an
      // agent published without a preset "resolves against the empty global
      // layer" — no Read/Write/Edit/Bash). The default web agent gets its
      // preset via ensureSession()'s composeAgent(); mirror that: mount the
      // same preset id recorded in the default agent's session header,
      // falling back to the preset service's configured default.
      let presetId = defaultAgent?.session?.header?.agentPreset;
      if (!presetId) {
        try { presetId = ctx.get?.('agentPresets')?.defaultId; } catch { /* none */ }
      }
      // NOTE: the agent factory treats a non-undefined setup return value as
      // an effect it calls .commit() on (dsh-agent-loop createAgent:
      // `await raceAbort(setup?.(agent.ctx))?.commit()`). So setup must be
      // side-effect only: `await` the mount and RETURN NOTHING (undefined),
      // exactly like the host's composeAgent() setup.
      const setup = presetId
        ? async (agentCtx) => {
            const presets = ctx.get?.('agentPresets');
            if (!presets?.mount) return;
            await presets.mount(agentCtx, presetId);
          }
        : undefined;
      const handle = await agentsSvc.create({
        sessionId,
        meta: {
          cwd,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        ...(agentOptions ? { agentOptions } : {}),
        ...(setup ? { setup } : {}),
      });
      ownedHandles.push(handle);
      return String(sessionId);
    }

    function resolveChatAgent(chatId) {
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const activeId = chatAgents.get(String(chatId));
      if (activeId) {
        const hit = all.find((a) => String(a?.session?.id) === activeId);
        if (hit) return hit;
        // The active agent disappeared (disposed); fall through to first agent.
      }
      return all[0] ?? null;
    }

    // ---------------------------------------------------------------------
    // Per-chat model selection (mimics DSH's installModelSelection, inlined
    // so the plugin has no dependency on @deepseek-ai/dsh-agent internals).
    // A selection object {current, assembled} is wired into the agent's scoped
    // context: `system-prompt/assemble` snapshots current, `agent/request`
    // applies it to the resolved request config. Disposes with the agent.
    // ---------------------------------------------------------------------
    const agentModelDisposers = new Map(); // agentId -> disposer

    function currentModelOf(agent) {
      const ctxInfo = agent.session?.requestContext?.();
      if (ctxInfo?.provider && ctxInfo?.model) {
        return { provider: ctxInfo.provider, model: ctxInfo.model };
      }
      const header = agent.session?.requestHeader?.();
      if (header?.config?.provider && header?.config?.model) {
        return { provider: header.config.provider, model: header.config.model };
      }
      return null;
    }

    async function applyModelSelection(agent, provider, model) {
      const llm = ctx.get?.('llm');
      if (!llm?.resolveCallConfig) throw new Error('llm service unavailable');
      // Validate the pair (also normalizes defaults).
      await llm.resolveCallConfig({ provider, model });
      const selection = { current: { provider, model }, assembled: undefined };
      const agentCtx = agent.ctx;
      const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = selection.current;
        const assembled = await next();
        selection.assembled = selected;
        if (selected === undefined) return assembled;
        return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
      });
      const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        const selected = selection.assembled;
        if (selected === undefined) return resolved;
        return { ...resolved, provider: selected.provider, model: selected.model };
      });
      agentModelDisposers.get(String(agent.id))?.();
      agentModelDisposers.set(String(agent.id), () => { disposeAssembly(); disposeRequest(); });
    }

    function formatSessionHistory(agent, limit = 12, perMsgCap = 280) {
      const events = agent.session?.events;
      if (!Array.isArray(events)) return '（无事件）';
      const items = [];
      for (const evt of events) {
        if (evt?.type === 'user/message') {
          const data = evt.data;
          const text = Array.isArray(data?.content)
            ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
            : String(data ?? '');
          if (text) items.push({ who: '你', text, source: data?.source?.kind });
        } else if (evt?.type === 'assistant/message') {
          const text = textOfAssistantMessage(evt);
          if (text) items.push({ who: '助手', text });
        }
      }
      if (items.length === 0) return '（本会话还没有消息）';
      const tail = items.slice(-limit);
      const lines = tail.map((it, i) => {
        let t = it.text.replace(/\s+/g, ' ');
        if (t.length > perMsgCap) t = t.slice(0, perMsgCap) + '…';
        return `${i + 1}. [${it.who}] ${escapeHtml(t)}`;
      });
      return `最近 ${tail.length}/${items.length} 条：\n\n${lines.join('\n')}`;
    }

    // Minimal HTML escaping for embedding plain text inside an HTML parse_mode
    // message (command replies / /history).
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function handleCommands(message) {
      // Returns true when the message was a command (already handled).
      const text = message.text?.trim() ?? '';
      if (!text.startsWith('/')) return false;
      const chatId = String(message.chatId);
      const [cmd, ...rest] = text.split(/\s+/);
      const args = rest.join(' ').trim();
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const active = resolveChatAgent(chatId);
      // Command replies are plugin-authored Telegram HTML (tags preserved).
      const reply = (t) => sendText(chatId, t, { replyToMessageId: message.messageId, html: true });

      try {
        switch (cmd) {
          case '/start':
          case '/help': {
            await reply([
              '命令列表（参考 QwenPaw 风格）：',
              '',
              '• /new 或 /clear — 新建会话（清空上下文）',
              '• /sessions — 列出活动会话',
              '• /use &lt;id&gt; — 切换到指定会话',
              '• /stop — 停止当前正在执行的任务',
              '• /compact — 压缩当前会话历史',
              '• /history — 查看最近对话记录',
              '• /model — 查看当前模型',
              '• /model list — 列出可用模型',
              '• /model &lt;provider&gt;:&lt;model&gt; — 切换模型',
              '• /help — 显示本帮助',
              '',
              '直接发普通消息即可对话。',
            ].join('\n'));
            return true;
          }

          case '/new':
          case '/clear': {
            if (active?.status === 'running') {
              try { active.cancel({ kind: 'user' }); } catch { /* ignore */ }
            }
            const id = await createTelegramAgent(chatId);
            chatAgents.set(chatId, id);
            const short = id.length > 20 ? id.slice(0, 8) + '…' : id;
            await reply(`✅ 已开启新会话 <code>${short}</code>（完整 id 见 /sessions）。\n上下文已清空，后续消息路由到新会话。`);
            return true;
          }

          case '/sessions': {
            if (all.length === 0) { await reply('（当前没有活动会话）'); return true; }
            const activeId = chatAgents.get(chatId);
            const lines = all.map((a, i) => {
              const aid = String(a?.session?.id ?? `agent-${i}`);
              const mark = aid === activeId ? '👉 ' : (i === 0 ? '🏠 ' : '   ');
              const model = currentModelOf(a);
              const modelStr = model ? ` · ${escapeHtml(model.model)}` : '';
              return `${mark}<code>${aid.slice(0, 12)}</code> [${escapeHtml(a?.status ?? '?')}]${i === 0 ? ' (default)' : ''}${modelStr}`;
            });
            await reply(`活动会话（${all.length}）：\n\n${lines.join('\n')}\n\n👉=当前聊天会话 🏠=默认\n切换：/use &lt;id&gt;；新建：/new`);
            return true;
          }

          case '/use': {
            const targetId = args;
            if (!targetId) { await reply('用法：/use &lt;session-id&gt;（先 /sessions 查看）'); return true; }
            // Allow short-id prefix match for convenience.
            const hit = all.find((a) => {
              const aid = String(a?.session?.id);
              return aid === targetId || aid.startsWith(targetId);
            });
            if (!hit) { await reply(`❌ 未找到会话 <code>${escapeHtml(targetId)}</code>。用 /sessions 查看。`); return true; }
            chatAgents.set(chatId, String(hit.session.id));
            await reply(`✅ 已切换到会话 <code>${String(hit.session.id).slice(0, 12)}</code>。`);
            return true;
          }

          case '/stop': {
            if (!active) { await reply('（没有可停止的会话）'); return true; }
            if (active.status !== 'running') {
              await reply('⚠️ 当前会话没有在运行的任务。');
              return true;
            }
            active.cancel({ kind: 'user' });
            await reply('🛑 已停止当前任务（排队消息一并清除）。');
            return true;
          }

          case '/compact': {
            if (!active) { await reply('（没有可压缩的会话）'); return true; }
            // In web mode the host-plane compaction row is disabled and the
            // service lives in the per-session (agent) scope, so look on the
            // agent's scoped context first, then fall back to the host plane.
            const compaction = active.ctx?.get?.('compaction') ?? ctx.get?.('compaction');
            if (!compaction?.compactNow) {
              await reply('❌ compaction 服务不可用（该部署未挂载 @deepseek-ai/dsh-compaction-basic）。');
              return true;
            }
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 120_000);
            try {
              const result = await compaction.compactNow(
                {
                  session: active.session,
                  options: active.options,
                  runMaintenance: (task) => active.runMaintenance(task),
                },
                ac.signal,
              );
              if (result === null) {
                await reply('（没有可压缩的历史。）');
              } else {
                await reply('✅ 会话历史已压缩为摘要。');
              }
            } catch (err) {
              if (ac.signal.aborted) await reply('⏱ 压缩超时（120s），已取消。');
              else await reply(`❌ 压缩失败：${escapeHtml(err.message)}`);
            } finally {
              clearTimeout(timer);
            }
            return true;
          }

          case '/history': {
            if (!active) { await reply('（没有可查看的会话）'); return true; }
            const n = /^\d+$/.test(args) ? Math.max(1, Math.min(50, parseInt(args, 10))) : 12;
            await reply(`📜 <b>最近对话</b>（${String(active.session.id).slice(0, 12)}）\n\n${formatSessionHistory(active, n)}`);
            return true;
          }

          case '/model': {
            const agent = active;
            if (!args || args === 'help' || args === '-h') {
              if (!agent) { await reply('（没有当前会话）'); return true; }
              const cur = currentModelOf(agent);
              await reply(cur
                ? `🤖 当前模型：<code>${escapeHtml(cur.provider)}:${escapeHtml(cur.model)}</code>\n\n/model list 查看可用；/model &lt;provider&gt;:&lt;model&gt; 切换`
                : '（尚未发起过请求，使用全局默认模型）');
              return true;
            }
            const llm = ctx.get?.('llm');
            if (!llm) { await reply('❌ llm 服务不可用。'); return true; }
            if (args === 'list') {
              try {
                const providers = llm.listProviders?.() ?? [];
                const out = [];
                for (const p of providers.slice(0, 10)) {
                  const pid = p.id ?? p.provider;
                  if (!pid) continue;
                  let models = [];
                  try { models = (await llm.listModels?.(pid)) ?? []; } catch { /* provider may not list */ }
                  if (models.length) {
                    out.push(`<b>${escapeHtml(p.name ?? pid)}</b> (<code>${escapeHtml(pid)}</code>)\n${models.slice(0, 12).map((m) => '• ' + escapeHtml(m.id ?? m.model)).join('\n')}`);
                  }
                }
                await reply(out.length ? `可用模型：\n\n${out.join('\n\n')}\n\n切换：/model &lt;provider&gt;:&lt;model&gt;` : '（没有列出任何 provider/model）');
              } catch (err) {
                await reply(`❌ 列出模型失败：${escapeHtml(err.message)}`);
              }
              return true;
            }
            // /model <provider>:<model>
            const colon = args.indexOf(':');
            if (colon <= 0) { await reply('格式：/model &lt;provider&gt;:&lt;model&gt;（如 /model deepseek:deepseek-chat）'); return true; }
            const provider = args.slice(0, colon).trim();
            const model = args.slice(colon + 1).trim();
            if (!provider || !model) { await reply('❌ provider 和 model 不能为空。'); return true; }
            const target = active ?? (all[0] ?? null);
            if (!target) { await reply('❌ 没有可设置模型的会话。'); return true; }
            await applyModelSelection(target, provider, model);
            await reply(`✅ 会话 <code>${String(target.session.id).slice(0, 12)}</code> 的模型已切换为 <code>${escapeHtml(provider)}:${escapeHtml(model)}</code>（下一轮请求生效）。`);
            return true;
          }

          default:
            return false; // unknown command: fall through to normal processing
        }
      } catch (err) {
        log('error', `Telegram command ${cmd} failed:`, err.message);
        try { await reply(`❌ 命令执行失败：${escapeHtml(err.message)}`); } catch { /* ignore */ }
        return true;
      }
    }

    poller.onMessage(async (message) => {
      const sender = message.senderUsername || message.senderName || message.senderId;
      log('info', `Message from ${sender} in chat ${message.chatId}: ${message.text?.slice(0, 100) || '(media)'}`);

      if (allowedChats.length && !allowedChats.includes(message.chatId)) return;
      if (allowedUsers.length && !allowedUsers.includes(message.senderId)) return;

      if (requireMention && (message.chatType === 'group' || message.chatType === 'supergroup')) {
        const bot = await client.getMe();
        if (!message.text?.includes(`@${bot.username}`)) return;
      }

      // Plan A commands: /new, /sessions, /use <id>, /help
      if (message.text && await handleCommands(message)) return;

      // Dedup: skip if we already injected this message id (poller-level
      // dedup is the primary gate; this is a second line of defence for
      // handler-level retries).
      const dedupKey = `${message.chatId}:${message.messageId}`;
      if (injectedIds.has(dedupKey)) return;

      if (message.text) {
        // Show typing action
        await client.sendChatAction(message.chatId, 'typing', message.messageThreadId);

        // Inject message to agent session if enabled
        const currentAgent = resolveChatAgent(message.chatId);

        if (injectToAgent && currentAgent) {
          try {
            // DSH's MessageSource requires kind ∈ {user, plugin, model, tool}.
            // Use 'plugin' (this plugin is the source of the message) and
            // keep the chat id in the text so the agent can route replies.
            const replyInstruction =
              agentResponseMode === 'direct'
                ? `This message comes from Telegram (chat ${message.chatId}, sender ${sender}). Produce your answer as normal assistant text; the plugin will forward it back to Telegram automatically. Do NOT call telegram_send_message.`
                : `This message comes from Telegram (chat ${message.chatId}, sender ${sender}). Reply to it using the telegram_send_message tool with chat_id: ${message.chatId}.`;
            const userMessage = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[Telegram message from ${sender} in chat ${message.chatId}]
${message.text}

${replyInstruction}`,
                },
              ],
              source: {
                kind: 'plugin',
                plugin: name,
              },
              id: `telegram-${Date.now()}-${message.messageId}`,
            };

            // Public API: agent.followup(msg) === send(msg, 'next-turn', true).
            // (The previous version called the private wakeDriver() directly.)
            if (typeof currentAgent.followup === 'function') {
              currentAgent.followup(userMessage);
            } else if (typeof currentAgent.send === 'function') {
              currentAgent.send(userMessage, 'next-turn', true);
            } else {
              currentAgent.inbox.append('next-turn', userMessage);
              currentAgent.wakeDriver?.(true);
            }
            rememberInjectedId(dedupKey);
            log('info', `Telegram message ${message.messageId} sent to agent for processing (${agentResponseMode} mode)`);

            if (agentResponseMode === 'direct') {
              // Auto-capture the agent's final text for this turn and send it.
              void watchDirectReply(currentAgent, message.chatId, message.messageId);
            }
            return;
          } catch (err) {
            log('error', `Failed to inject message to agent:`, err.message);
          }
        } else if (injectToAgent) {
          log('info', 'Agent injection enabled but no agent available yet');
        }

        // Fallback: direct echo response if not injecting to agent.
        const responseText = `Received your message: "${message.text?.slice(0, 100)}"`;
        await client.sendMessage({
          chatId: message.chatId,
          text: responseText,
          parseMode: parseMode,
          replyToMessageId: message.messageId,
          messageThreadId: message.messageThreadId,
        });
      } else {
        // Non-text inbound media: acknowledge with a brief receipt so the
        // user knows the bot saw it (the message itself is not forwarded to
        // the agent yet — that would require attachment plumbing).
        const kind = message.photo ? 'photo'
          : message.document ? 'document'
          : message.video ? 'video'
          : message.audio ? 'audio'
          : message.voice ? 'voice'
          : 'media';
        try {
          await client.sendMessage({
            chatId: message.chatId,
            text: `I received a ${kind} (message_id: ${message.messageId}). Text-only interaction is currently supported.`,
            parseMode: undefined,
            replyToMessageId: message.messageId,
            messageThreadId: message.messageThreadId,
          });
        } catch (err) {
          log('warn', 'Failed to send media ack:', err.message);
        }
      }
    });

    poller.onCallbackQuery(async (query) => {
      log('info', `Callback query from ${query.from.username || query.from.id}: data="${query.data}"`);
      await client.answerCallbackQuery(query.id, 'Acknowledged');
    });

    // Register the bot command menu so Telegram clients show it in the
    // "/" autocomplete (Bot API setMyCommands). Keep in sync with
    // handleCommands below.
    try {
      await client.setMyCommands([
        { command: 'new', description: '新建会话（清空上下文）' },
        { command: 'clear', description: '同 /new：新建会话' },
        { command: 'stop', description: '停止当前任务' },
        { command: 'compact', description: '压缩会话历史为摘要' },
        { command: 'history', description: '查看最近对话记录' },
        { command: 'model', description: '查看/切换模型（/model list 列出）' },
        { command: 'sessions', description: '列出活动会话' },
        { command: 'use', description: '切换到指定会话（/use <id>）' },
        { command: 'help', description: '显示帮助' },
      ]);
      log('info', 'Registered Telegram command menu (setMyCommands).');
    } catch (err) {
      log('warn', 'setMyCommands failed (command menu may be missing):', err.message);
    }

    poller.start();
    log('info', 'Telegram poller started.');
  }

  // -----------------------------------------------------------------------
  // Cleanup on unload
  // -----------------------------------------------------------------------

  ctx.effect(() => {
    return () => {
      poller?.stop();
      // Dispose any agents this plugin created (frees their sessions).
      for (const h of ownedHandles) {
        try { void h.dispose(); } catch { /* ignore */ }
      }
      ownedHandles.length = 0;
      log('info', 'Telegram plugin unloaded.');
    };
  });
}
