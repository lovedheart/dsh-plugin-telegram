/**
 * Telegram Bot API client.
 *
 * Wraps the Telegram Bot HTTP API for sending messages, media, and receiving
 * updates via long-polling. Modelled after the QwenPaw TelegramChannel.
 *
 * @module dsh-plugin-telegram/client
 */

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_LONG_POLL_TIMEOUT = 30;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class TelegramApiError extends Error {
  /**
   * @param message human-readable error message.
   * @param details raw response body / diagnostic string.
   * @param status HTTP status code, when the failure was an HTTP response.
   * @param errorCode Telegram `error_code`, when present in the JSON body.
   */
  constructor(message, details, status, errorCode) {
    super(message);
    this.name = 'TelegramApiError';
    this.details = details;
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class TelegramRateLimitError extends TelegramApiError {
  constructor(retryAfter) {
    super(`Rate limited. Retry after ${retryAfter}s`);
    this.name = 'TelegramRateLimitError';
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function tgFetch(baseUrl, botToken, method, body, signal) {
  const url = `${baseUrl}/bot${botToken}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Telegram error bodies are JSON: {"ok":false,"error_code":N,"description":
    // "...","parameters":{"retry_after":S}}. Parse them so the poller can
    // distinguish rate limits (429) and conflicts (409) from other failures.
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const errorCode = parsed && typeof parsed.error_code === 'number' ? parsed.error_code : undefined;
    const description = parsed && parsed.description ? parsed.description : `${resp.status} ${resp.statusText}`;

    if (errorCode === 429 || resp.status === 429) {
      const retryAfter = parsed?.parameters?.retry_after;
      throw new TelegramRateLimitError(Number(retryAfter) > 0 ? Number(retryAfter) : 5);
    }
    throw new TelegramApiError(`Telegram API ${method} failed: ${description}`, text, resp.status, errorCode);
  }

  return resp.json();
}

async function tgFetchOk(baseUrl, botToken, method, body, signal) {
  const data = await tgFetch(baseUrl, botToken, method, body, signal);
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Unexpected response from Telegram API ${method}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TelegramClient {
  constructor(config) {
    this.botToken = config.botToken;
    this.baseUrl = (config.baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL);
    this._me = null;

    if (!this.botToken) {
      throw new Error('Telegram bot token is required');
    }
  }

  // ---- Identity -----------------------------------------------------------

  async getMe() {
    if (this._me) return this._me;
    const resp = await tgFetchOk(this.baseUrl, this.botToken, 'getMe');
    const result = resp.result;
    if (!result) throw new Error('getMe returned no result');
    this._me = {
      id: String(result.id),
      username: String(result.username || ''),
      firstName: String(result.first_name || ''),
    };
    return this._me;
  }

  // ---- Sending ------------------------------------------------------------

  async sendMessage(opts) {
    const body = {
      chat_id: String(opts.chatId),
      text: opts.text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;
    if (opts.disableNotification) body.disable_notification = opts.disableNotification;

    const resp = await tgFetchOk(this.baseUrl, this.botToken, 'sendMessage', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendMessage returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async editMessageText(chatId, messageId, text, parseMode) {
    try {
      const body = {
        chat_id: String(chatId),
        message_id: messageId,
        text,
      };
      if (parseMode) body.parse_mode = parseMode;
      await tgFetchOk(this.baseUrl, this.botToken, 'editMessageText', body);
      return true;
    } catch (err) {
      if (err.message?.includes('Message is not modified')) return true;
      return false;
    }
  }

  async sendPhoto(opts) {
    const body = {
      chat_id: String(opts.chatId),
      photo: opts.photo,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    const resp = await tgFetchOk(this.baseUrl, this.botToken, 'sendPhoto', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendPhoto returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async sendDocument(opts) {
    const body = {
      chat_id: String(opts.chatId),
      document: opts.document,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    const resp = await tgFetchOk(this.baseUrl, this.botToken, 'sendDocument', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendDocument returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async answerCallbackQuery(queryId, text, showAlert) {
    await tgFetchOk(this.baseUrl, this.botToken, 'answerCallbackQuery', {
      callback_query_id: queryId,
      text,
      show_alert: showAlert,
    });
    return true;
  }

  async deleteMessage(chatId, messageId) {
    try {
      await tgFetchOk(this.baseUrl, this.botToken, 'deleteMessage', {
        chat_id: String(chatId),
        message_id: messageId,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Receiving ----------------------------------------------------------

  async getUpdates(offset, limit, timeout, signal) {
    limit = limit ?? 50;
    timeout = timeout ?? DEFAULT_LONG_POLL_TIMEOUT;
    const body = { limit, timeout };
    if (offset !== undefined && offset !== null) body.offset = offset;

    const resp = await tgFetchOk(this.baseUrl, this.botToken, 'getUpdates', body, signal);
    const results = resp.result;
    if (!results || !Array.isArray(results)) return [];

    return results.map((u) => ({
      updateId: Number(u.update_id),
      message: u.message ? this._parseMessage(u.message) : undefined,
      editedMessage: u.edited_message ? this._parseMessage(u.edited_message) : undefined,
      callbackQuery: u.callback_query ? this._parseCallbackQuery(u.callback_query) : undefined,
    }));
  }

  /**
   * Register the bot's command menu (Telegram Bot API setMyCommands).
   * After this, Telegram clients show the commands in the / autocomplete
   * menu. commands: [{command, description}] (command has no leading slash).
   */
  async setMyCommands(commands) {
    await tgFetchOk(this.baseUrl, this.botToken, 'setMyCommands', {
      commands: commands.map((c) => ({ command: c.command, description: c.description })),
    });
    return true;
  }

  // ---- Chat action --------------------------------------------------------

  async sendChatAction(chatId, action, messageThreadId) {
    try {
      const body = { chat_id: String(chatId), action };
      if (messageThreadId) body.message_thread_id = messageThreadId;
      await tgFetchOk(this.baseUrl, this.botToken, 'sendChatAction', body);
    } catch {
      // Best-effort
    }
  }

  // ---- Parsing ------------------------------------------------------------

  _parseMessage(raw) {
    const chat = raw.chat || {};
    const from = raw.from || {};
    const photo = Array.isArray(raw.photo)
      ? raw.photo.map((p) => ({
          fileId: p.file_id || '',
          fileSize: p.file_size,
          width: p.width || 0,
          height: p.height || 0,
          filePath: p.file_path,
        }))
      : undefined;

    return {
      messageId: Number(raw.message_id),
      chatId: String(chat.id),
      chatType: chat.type || 'private',
      senderId: String(from.id),
      senderUsername: from.username,
      senderName: (from.first_name || from.last_name)
        ? `${from.first_name || ''} ${from.last_name || ''}`.trim()
        : undefined,
      text: raw.text || raw.caption,
      photo,
      document: raw.document || undefined,
      video: raw.video || undefined,
      audio: raw.audio || undefined,
      voice: raw.voice || undefined,
      replyToMessageId: raw.reply_to_message?.message_id,
      messageThreadId: raw.message_thread_id,
      timestamp: Number(raw.date) * 1000,
    };
  }

  _parseCallbackQuery(raw) {
    return {
      id: raw.id || '',
      from: {
        id: String(raw.from?.id || ''),
        username: raw.from?.username,
      },
      message: {
        messageId: Number(raw.message?.message_id || 0),
        chat: {
          id: String(raw.message?.chat?.id || ''),
          type: raw.message?.chat?.type || '',
        },
      },
      data: raw.data || '',
      chatInstance: raw.chat_instance || '',
    };
  }
}
