/**
 * Telegram Bot API client.
 *
 * Wraps the Telegram Bot HTTP API for sending messages, media, and receiving
 * updates via long-polling. Modelled after the QwenPaw TelegramChannel.
 *
 * @module dsh-plugin-telegram/client
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_LONG_POLL_TIMEOUT = 30;
// Client-side cap on a single HTTP request (ms). The Telegram link is flaky
// (~45% request timeouts measured); without a cap a request that *hangs*
// (never resolves, never errors) blocks the caller forever — and because the
// poll loop awaits its handlers, one hung call deafens the whole bot. A
// bounded timeout converts that into a retryable transport error.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000; // file downloads can be large/slow

// Combine an optional external signal with a per-request timeout signal so a
// hung fetch always aborts within `timeoutMs`. Returns undefined when there is
// nothing to combine (no external signal, no timeout).
function withTimeout(signal, timeoutMs) {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && signal) return AbortSignal.any([signal, timeout]);
  return timeout || signal || undefined;
}

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

/**
 * True when a failed Telegram API call is worth retrying:
 * - transient transport failures (undici wraps them as `TypeError:
 *   fetch failed` with the real error in `err.cause`, sometimes nested),
 * - 429 rate limits, 409 conflicts (another getUpdates consumer),
 * - 5xx API responses (server-side hiccup),
 * - client-side aborts/timeouts (our per-request AbortSignal.timeout fires as
 *   an `AbortError` whose cause is a `TimeoutError`; an external AbortSignal
 *   abort surfaces as a bare `AbortError`). A timeout means "too slow" → retry;
 *   a shutdown-abort is harmless here because callers already stop on
 *   `signal.aborted` / `running === false` before any retry loop runs.
 * Permanent errors (400 bad entities, 403 banned, ...) return false and
 * must propagate to the caller.
 */
export function isTransientTelegramError(err) {
  if (err instanceof TelegramRateLimitError) return true;
  if (err instanceof TelegramApiError) {
    const code = err.errorCode ?? err.status;
    if (code === 429 || code === 409) return true;
    if (Number.isFinite(code) && code >= 500) return true;
    return false;
  }
  const chain = [err, err?.cause, err?.cause?.cause].filter(Boolean);
  return chain.some((e) =>
    // Client-side timeout / abort (our requestTimeoutMs guard or an external
    // AbortSignal). name-based check because undici/node use 'AbortError' and
    // 'TimeoutError' as constructor names.
    e?.name === 'AbortError' || e?.name === 'TimeoutError' ||
    (e.constructor?.name === 'TypeError' && String(e.message || '').includes('fetch failed')) ||
    ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(e.code),
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function tgFetch(baseUrl, botToken, method, body, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const url = `${baseUrl}/bot${botToken}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: withTimeout(signal, timeoutMs),
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

async function tgFetchOk(baseUrl, botToken, method, body, signal, timeoutMs) {
  const data = await tgFetch(baseUrl, botToken, method, body, signal, timeoutMs);
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Unexpected response from Telegram API ${method}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Local-file upload helpers (multipart/form-data)
//
// The JSON _api channel cannot upload a local binary to the Bot API; for that
// we POST multipart/form-data. This is the same mechanism sendVoiceFile used
// inline; it is now a shared helper so document/photo/video/audio can all send
// local files too (previously only voice could, forcing the agent to upload
// documents to a public host first).
// ---------------------------------------------------------------------------

const MEDIA_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.log': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** MIME type for a filename by extension; falls back to application/octet-stream. */
function mimeOf(filename) {
  return MEDIA_MIME[extname(String(filename)).toLowerCase()] || 'application/octet-stream';
}

/**
 * True when `value` denotes a LOCAL file (not a Telegram file_id, not a URL).
 * A file_id is a bare opaque token (no scheme, no path separator); a URL has
 * an http(s) scheme; anything else we treat as a local path.
 */
function isLocalFilePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/^https?:\/\//i.test(value)) return false;       // URL → send by reference
  if (/^[A-Za-z0-9_=-]+$/.test(value)) return false;    // looks like a file_id
  return true;                                          // local path
}

/**
 * POST a local file to a Bot API media method via multipart/form-data.
 * @param {string} baseUrl
 * @param {string} botToken
 * @param {string} method      e.g. 'sendDocument'
 * @param {string} field       Bot API media field, e.g. 'document'
 * @param {string} chatId
 * @param {string} filePath    Absolute local file path.
 * @param {object} [extra]     Optional extra form fields (caption, title, ...).
 * @param {string} [extra.caption]
 * @param {string} [extra.parseMode]
 * @param {number} [extra.messageThreadId]
 * @param {string} [extra.title]
 * @param {string} [extra.performer]
 * @param {number} [extra.duration]
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ messageId: number, chatId: string }>}
 */
async function tgUploadFile(baseUrl, botToken, method, field, chatId, filePath, extra = {}, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const data = readFileSync(filePath);
  const fileName = basename(filePath) || 'upload';
  const mime = mimeOf(fileName);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (extra.messageThreadId) form.append('message_thread_id', String(extra.messageThreadId));
  if (extra.caption) {
    form.append('caption', extra.caption);
    if (extra.parseMode) form.append('parse_mode', extra.parseMode);
  }
  if (extra.title) form.append('title', extra.title);
  if (extra.performer) form.append('performer', extra.performer);
  if (extra.duration != null && Number.isFinite(Number(extra.duration))) {
    form.append('duration', String(Math.round(Number(extra.duration))));
  }
  form.append(field, new Blob([data], { type: mime }), fileName);

  const url = `${baseUrl}/bot${botToken}/${method}`;
  const resp = await fetch(url, { method: 'POST', body: form, signal: withTimeout(signal, timeoutMs) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const errorCode = parsed && typeof parsed.error_code === 'number' ? parsed.error_code : undefined;
    const description = parsed?.description || `${resp.status} ${resp.statusText}`;
    if (errorCode === 429 || resp.status === 429) {
      const retryAfter = parsed?.parameters?.retry_after;
      throw new TelegramRateLimitError(Number(retryAfter) > 0 ? Number(retryAfter) : 5);
    }
    throw new TelegramApiError(`Telegram API ${method} (upload) failed: ${description}`, text, resp.status, errorCode);
  }
  const data2 = await resp.json();
  const msg = data2?.result;
  if (!msg) throw new Error(`${method} (upload) returned no result`);
  return { messageId: Number(msg.message_id), chatId: String(msg.chat?.id ?? chatId) };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TelegramClient {
  constructor(config) {
    this.botToken = config.botToken;
    this.baseUrl = (config.baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL);
    this._me = null;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (!this.botToken) {
      throw new Error('Telegram bot token is required');
    }
  }

  // ---- Identity -----------------------------------------------------------

  // Thin wrapper over tgFetchOk that applies the client's per-request timeout
  // so a hung Telegram call always aborts instead of blocking the caller (and,
  // with the poller's fire-and-forget dispatch, instead of deafening the bot).
  async _api(method, body, signal, timeoutMs = this.requestTimeoutMs) {
    return tgFetchOk(this.baseUrl, this.botToken, method, body, signal, timeoutMs);
  }

  async getMe() {
    if (this._me) return this._me;
    const resp = await this._api('getMe');
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
    // Inline keyboard (e.g. tool-guard approval buttons). The plugin passes a
    // plain Telegram InlineKeyboardMarkup object ({inline_keyboard: [...]}) and
    // we forward it verbatim.
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;

    const resp = await this._api('sendMessage', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendMessage returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async editMessageText(chatId, messageId, text, parseMode, replyMarkup) {
    try {
      const body = {
        chat_id: String(chatId),
        message_id: messageId,
        text,
      };
      if (parseMode) body.parse_mode = parseMode;
      // Re-sending the keyboard forces clients to re-render it (a text-only
      // edit can leave stale/missing keyboard rows on some clients).
      if (replyMarkup) body.reply_markup = replyMarkup;
      await this._api('editMessageText', body);
      return true;
    } catch (err) {
      if (err.message?.includes('Message is not modified')) return true;
      return false;
    }
  }

  /**
   * Ensure a media reference is a usable local path. Returns an absolute path
   * when `ref` is a local file, or null when it is a URL / file_id (sent by
   * reference). Throws for a local path that does not point at a regular file.
   */
  _localPathOr(ref) {
    if (!isLocalFilePath(ref)) return null;
    const abs = resolve(ref);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Error(`local file not found or not a regular file: ${abs}`);
    return abs;
  }

  async sendPhoto(opts) {
    const local = this._localPathOr(opts.photo);
    if (local) {
      return tgUploadFile(this.baseUrl, this.botToken, 'sendPhoto', 'photo',
        opts.chatId, local, { caption: opts.caption, parseMode: opts.parseMode, messageThreadId: opts.messageThreadId }, opts.signal);
    }
    const body = {
      chat_id: String(opts.chatId),
      photo: opts.photo,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    const resp = await this._api('sendPhoto', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendPhoto returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async sendDocument(opts) {
    const local = this._localPathOr(opts.document);
    if (local) {
      return tgUploadFile(this.baseUrl, this.botToken, 'sendDocument', 'document',
        opts.chatId, local, { caption: opts.caption, parseMode: opts.parseMode, messageThreadId: opts.messageThreadId }, opts.signal);
    }
    const body = {
      chat_id: String(opts.chatId),
      document: opts.document,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    const resp = await this._api('sendDocument', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendDocument returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async sendVideo(opts) {
    const local = this._localPathOr(opts.video);
    if (local) {
      return tgUploadFile(this.baseUrl, this.botToken, 'sendVideo', 'video',
        opts.chatId, local, { caption: opts.caption, parseMode: opts.parseMode, messageThreadId: opts.messageThreadId }, opts.signal);
    }
    const body = {
      chat_id: String(opts.chatId),
      video: opts.video,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    const resp = await this._api('sendVideo', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendVideo returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  async sendAudio(opts) {
    const local = this._localPathOr(opts.audio);
    if (local) {
      return tgUploadFile(this.baseUrl, this.botToken, 'sendAudio', 'audio',
        opts.chatId, local,
        { caption: opts.caption, parseMode: opts.parseMode, messageThreadId: opts.messageThreadId, title: opts.title, performer: opts.performer, duration: opts.duration },
        opts.signal);
    }
    const body = {
      chat_id: String(opts.chatId),
      audio: opts.audio,
    };
    if (opts.messageThreadId) body.message_thread_id = opts.messageThreadId;
    if (opts.caption) {
      body.caption = opts.caption;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
    }
    if (opts.title) body.title = opts.title;
    if (opts.performer) body.performer = opts.performer;
    if (opts.duration != null && Number.isFinite(Number(opts.duration))) {
      body.duration = String(Math.round(Number(opts.duration)));
    }
    const resp = await this._api('sendAudio', body);
    const msg = resp.result;
    if (!msg) throw new Error('sendAudio returned no result');
    return {
      messageId: Number(msg.message_id),
      chatId: String(msg.chat?.id ?? opts.chatId),
    };
  }

  /**
   * Send a voice message (OGG Opus) by uploading a local file via multipart.
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {string} opts.filePath  Absolute path to an .ogg (Opus) file.
   * @param {number} [opts.duration] Optional audio duration in seconds.
   * @param {string} [opts.caption] Optional caption.
   * @param {number} [opts.messageThreadId]
   * @param {AbortSignal} [opts.signal]
   */
  async sendVoiceFile(opts) {
    // Voice is always a local OGG file (produced by the plugin's TTS/transcode
    // step), so it always goes through the multipart uploader.
    return tgUploadFile(this.baseUrl, this.botToken, 'sendVoice', 'voice',
      opts.chatId, opts.filePath,
      { caption: opts.caption, messageThreadId: opts.messageThreadId, duration: opts.duration },
      opts.signal);
  }

  async answerCallbackQuery(queryId, text, showAlert) {
    await this._api('answerCallbackQuery', {
      callback_query_id: queryId,
      text,
      show_alert: showAlert,
    });
    return true;
  }

  async deleteMessage(chatId, messageId) {
    try {
      await this._api('deleteMessage', {
        chat_id: String(chatId),
        message_id: messageId,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Inbound media (getFile / download) ---------------------------------
  //
  // Telegram's getFile returns a RELATIVE file_path (e.g. "photos/.../1.jpg");
  // the actual bytes live at {baseUrl}/file/bot{token}/{file_path}. These two
  // helpers let the plugin download inbound attachments to a local dir so they
  // can be forwarded to the agent as content blocks.

  /**
   * Resolve a file_id to Telegram's file metadata (relative path + size).
   * @returns {{ filePath: string, fileSize: number|undefined, fileName?: string }}
   */
  async getFile(fileId) {
    const resp = await this._api('getFile', { file_id: fileId });
    const f = resp.result;
    if (!f?.file_path) throw new Error(`getFile returned no file_path for ${fileId}`);
    return {
      filePath: String(f.file_path),
      fileSize: typeof f.file_size === 'number' ? f.file_size : undefined,
      fileName: f.file_name || undefined,
    };
  }

  /**
   * Download a file_id's bytes to a local file under `destDir`, named
   * `<uuid><ext>` (extension preserved from the Telegram path/file_name).
   * @param {string} fileId Telegram file_id.
   * @param {string} destDir Absolute directory to write into (created if needed).
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {{ localPath: string, fileName: string, fileSize: number, mime: string }}
   */
  async downloadFile(fileId, destDir, opts = {}) {
    const info = await this.getFile(fileId);
    const srcName = info.fileName || info.filePath.split('/').pop() || 'file';
    const ext = extname(srcName) || extname(info.filePath) || '';
    const base = `${randomUUID()}${ext}`;
    const localPath = join(destDir, base);
    mkdirSync(dirname(localPath), { recursive: true });

    const url = `${this.baseUrl}/file/bot${this.botToken}/${info.filePath}`;
    const resp = await fetch(url, { signal: withTimeout(opts.signal, DEFAULT_DOWNLOAD_TIMEOUT_MS) });
    if (!resp.ok || !resp.body) {
      const errCode = resp.status;
      throw new TelegramApiError(`Telegram file download failed (${errCode})`, '', errCode);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(localPath, buf);
    return {
      localPath,
      fileName: srcName,
      fileSize: buf.length,
      mime: resp.headers.get('content-type') || '',
    };
  }

  // ---- Receiving ----------------------------------------------------------

  async getUpdates(offset, limit, timeout, signal) {
    limit = limit ?? 50;
    timeout = timeout ?? DEFAULT_LONG_POLL_TIMEOUT;
    const body = { limit, timeout };
    if (offset !== undefined && offset !== null) body.offset = offset;

    // The long-poll legitimately HOLDS for `timeout` seconds on Telegram's side
    // before returning an empty batch, so the client-side abort must exceed
    // that or we'd cancel every healthy long-poll. Use the larger of the
    // configured request timeout and (long-poll hold + 10s headroom).
    const reqTimeoutMs = Math.max(this.requestTimeoutMs, (timeout * 1000) + 10_000);
    const resp = await this._api('getUpdates', body, signal, reqTimeoutMs);
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
    await this._api('setMyCommands', {
      commands: commands.map((c) => ({ command: c.command, description: c.description })),
    });
    return true;
  }

  // ---- Chat action --------------------------------------------------------

  async sendChatAction(chatId, action, messageThreadId, opts = {}) {
    const body = { chat_id: String(chatId), action };
    if (messageThreadId) body.message_thread_id = messageThreadId;
    try {
      await this._api('sendChatAction', body);
    } catch (err) {
      // Best-effort by default; the progress-indicator typing fallback passes
      // throwOnFailure so a persistently broken feedback channel can be detected
      // and surfaced (a silently-swallowed reject left the bot "working but
      // showing nothing", which reads as unresponsive).
      if (opts.throwOnFailure) throw err;
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
      // Raw entities (type/offset/length). The `bot_command` type marks a
      // command addressed to THIS bot (incl. the `@botusername` suffix in
      // groups) — a more reliable command signal than `text.startsWith('/')`.
      entities: Array.isArray(raw.entities)
        ? raw.entities.map((e) => ({ type: e.type, offset: e.offset, length: e.length }))
        : undefined,
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
