/**
 * Telegram long-polling service.
 *
 * Continuously polls the Telegram Bot API for new updates and dispatches
 * them to registered handlers. Includes automatic reconnection, rate-limit
 * backoff, and conflict detection.
 *
 * @module dsh-plugin-telegram/poller
 */

import { TelegramApiError, TelegramRateLimitError } from './client.js';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const RECONNECT_INITIAL_S = 2;
const RECONNECT_MAX_S = 30;
const RECONNECT_FACTOR = 1.8;
const NETWORK_RETRY_BASE_S = 10;
const NETWORK_RETRY_MAX_S = 120;
const UNEXPECTED_RETRY_BASE_S = 10;
const UNEXPECTED_RETRY_MAX_S = 120;

/**
 * Background long-polling loop for Telegram Bot API updates.
 */
export class TelegramPoller {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.verbose = options.verbose ?? false;
    this.abortController = null;
    this.running = false;
    this.lastOffset = undefined;
    this.reconnectDelay = RECONNECT_INITIAL_S;
    this.networkErrorCount = 0;
    this.conflictCount = 0;
    this.messageHandlers = [];
    this.callbackHandlers = [];
    this._seenMessageIds = new Set();
    this._SEEN_CAP = 8192;
    // Persist the polling offset across restarts so already-delivered updates
    // (and their agent injections) are not replayed. Off by default only if
    // the host is read-only; failures to read/write are non-fatal.
    this._offsetPath = this._resolveOffsetPath(options);
    this.lastOffset = this._loadOffset();
  }

  _resolveOffsetPath(options) {
    if (options.offsetStorePath) return options.offsetStorePath;
    const dshHome = process.env.DSH_HOME
      || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');
    const key = options.offsetKey || 'default';
    return join(dshHome, `telegram-poller-offset-${key}.json`);
  }

  _loadOffset() {
    try {
      const raw = readFileSync(this._offsetPath, 'utf8');
      const data = JSON.parse(raw);
      if (Number.isFinite(data?.offset)) return data.offset;
    } catch {
      // Missing or corrupt store: start fresh (Telegram will return the most
      // recent batch, which the dedup set still guards against double-inject).
    }
    return undefined;
  }

  _saveOffset() {
    if (this.lastOffset === undefined) return;
    try {
      const dir = dirname(this._offsetPath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this._offsetPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ offset: this.lastOffset, at: Date.now() }));
      renameSync(tmp, this._offsetPath);
    } catch {
      // Persistence is best-effort; a read-only host just loses the offset.
    }
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  onCallbackQuery(handler) {
    this.callbackHandlers.push(handler);
  }

  _log(level, ...args) {
    if (this.verbose || level === 'error') {
      console[level]('[telegram-poller]', ...args);
    }
  }

  start() {
    if (this.running) {
      this._log('warn', 'Already running');
      return;
    }
    this.running = true;
    this.abortController = new AbortController();
    this._pollLoop(this.abortController.signal).catch((err) => {
      if (this.running) {
        this._log('error', 'Unhandled error in poll loop:', err);
      }
    });
    this._log('info', 'Started');
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this._log('info', 'Stopped');
  }

  async _pollLoop(signal) {
    let delay = RECONNECT_INITIAL_S;

    while (this.running && !signal.aborted) {
      try {
        this._resetRetryState();

        const updates = await this.client.getUpdates(
          this.lastOffset,
          50,
          this.options.longPollTimeout ?? 30,
          signal,
        );

        if (signal.aborted) break;

        if (updates.length > 0) {
          await this._processUpdates(updates);
          this.lastOffset = updates[updates.length - 1].updateId + 1;
          this._saveOffset();
        }

        delay = RECONNECT_INITIAL_S;
      } catch (err) {
        if (signal.aborted || !this.running) break;

        if (this._isConflictError(err)) {
          this.conflictCount++;
          this.networkErrorCount = 0;
          delay = Math.min(
            RECONNECT_INITIAL_S * (RECONNECT_FACTOR ** (this.conflictCount - 1)),
            RECONNECT_MAX_S,
          );
          this._log(
            'warn',
            `Conflict detected (attempt ${this.conflictCount}), retrying in ${delay}s:`,
            err.message,
          );
        } else if (this._isRateLimitError(err)) {
          delay = Math.max(err.retryAfter ?? 5, 1);
          this._log('warn', `Rate limited, waiting ${delay}s`);
        } else if (this._isNetworkError(err)) {
          this.networkErrorCount++;
          this.conflictCount = 0;
          delay = Math.min(
            NETWORK_RETRY_BASE_S * (2 ** (this.networkErrorCount - 1)),
            NETWORK_RETRY_MAX_S,
          );
          this._log(
            'warn',
            `Network error (attempt ${this.networkErrorCount}), retrying in ${delay}s:`,
            err.message,
          );
        } else if (this._isApiError(err)) {
          // Telegram API errors (e.g., 502 Bad Gateway) — treat as transient server errors
          this.networkErrorCount++;
          this.conflictCount = 0;
          delay = Math.min(
            NETWORK_RETRY_BASE_S * (2 ** (this.networkErrorCount - 1)),
            NETWORK_RETRY_MAX_S,
          );
          this._log(
            'warn',
            `API error (attempt ${this.networkErrorCount}), retrying in ${delay}s:`,
            err.message,
          );
        } else {
          this._log('error', 'Unexpected error:', err);
          delay = UNEXPECTED_RETRY_BASE_S;
        }

        await this._sleep(delay * 1000, signal);
      }
    }
  }

  async _processUpdates(updates) {
    for (const update of updates) {
      try {
        const msg = update.message || update.editedMessage;
        if (msg && this.messageHandlers.length > 0) {
          // Dedup by (chat, message): protects against offset replays after a
          // restart and against edited messages re-arriving.
          const key = `${msg.chatId}:${msg.messageId}`;
          if (this._seenMessageIds.has(key)) continue;
          if (this._seenMessageIds.size >= this._SEEN_CAP) this._seenMessageIds.clear();
          this._seenMessageIds.add(key);

          if (this.options.allowedChats?.length && !this.options.allowedChats.includes(msg.chatId)) {
            continue;
          }
          if (this.options.allowedUsers?.length && !this.options.allowedUsers.includes(msg.senderId)) {
            continue;
          }
          await Promise.allSettled(this.messageHandlers.map((h) => h(msg)));
        }

        if (update.callbackQuery && this.callbackHandlers.length > 0) {
          await Promise.allSettled(
            this.callbackHandlers.map((h) => h(update.callbackQuery)),
          );
        }
      } catch (err) {
        this._log('error', 'Error processing update:', err);
      }
    }
  }

  _resetRetryState() {
    this.networkErrorCount = 0;
    this.conflictCount = 0;
    this.reconnectDelay = RECONNECT_INITIAL_S;
  }

  _isConflictError(err) {
    // Structured detection first (from the parsed Telegram error body):
    if (err?.errorCode === 409 || err?.status === 409) return true;
    const text = String(err.message || '').toLowerCase();
    const details = String(err.details || '').toLowerCase();
    const combined = text + ' ' + details;
    return (
      combined.includes('terminated by other getupdates request') ||
      combined.includes('another bot instance is running') ||
      combined.includes('conflict')
    );
  }

  _isRateLimitError(err) {
    if (err instanceof TelegramRateLimitError) return true;
    if (err?.errorCode === 429 || err?.status === 429) return true;
    const text = String(err.message || '').toLowerCase();
    return text.includes('too many requests') || text.includes('rate limit');
  }

  _isNetworkError(err) {
    // Node's global fetch (undici) wraps transport failures as
    // `TypeError: fetch failed` with the real error (e.g. ETIMEDOUT) in
    // `err.cause`. Check both the top-level error and the cause chain so a
    // plain network hiccup is classified as a network error (warn + backoff)
    // instead of an "Unexpected error".
    const chain = [err, err?.cause, err?.cause?.cause].filter(Boolean);
    return chain.some((e) => {
      const name = (e.name || e.constructor?.name || '').toLowerCase();
      return (
        ['networkerror', 'timeouterror', 'operatingerror', 'connectionerror', 'undicierror'].includes(name) ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(e.code) ||
        String(e.message || '').includes('fetch failed')
      );
    });
  }

  _isApiError(err) {
    // Catch Telegram API errors (e.g., 502 Bad Gateway) that are actual HTTP responses
    // but indicate server-side issues. These should be treated as transient.
    if (!(err instanceof TelegramApiError)) return false;
    const msg = String(err.message || '').toLowerCase();
    const details = String(err.details || '').toLowerCase();
    const combined = msg + ' ' + details;
    return (
      combined.includes('502') ||
      combined.includes('503') ||
      combined.includes('504') ||
      combined.includes('bad gateway') ||
      combined.includes('service unavailable') ||
      combined.includes('gateway timeout')
    );
  }

  _sleep(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
