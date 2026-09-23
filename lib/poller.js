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
// getUpdates batch size (Telegram max is 100).
const UPDATE_LIMIT = 50;

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
    this.networkErrorCount = 0;
    this.conflictCount = 0;
    this.messageHandlers = [];
    this.callbackHandlers = [];
    this._seenMessageIds = new Set();
    this._SEEN_CAP = 8192;
    // In-flight handler work, tracked so stop() can report (and tests await)
    // what was still running. Per-chat chains preserve message ordering —
    // updates from one chat are handled strictly in arrival order while
    // different chats run concurrently (the poll loop is never blocked).
    this._inflight = new Set();
    this._chatQueues = new Map();
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
    // Distinct store per bot: two pollers sharing one path would clobber each
    // other's offset (last writer wins → replay or lost updates on restart).
    const key = options.offsetKey || options.botId || 'default';
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

  /** Await all in-flight handler work (used by unload paths and tests). */
  async drain() {
    while (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  /**
   * Enqueue handler work serialized per chat. Returns immediately — the poll
   * loop is never blocked by a slow/hung handler — but unlike bare
   * fire-and-forget, ordering within one chat is preserved and rejections
   * after internal awaits are still caught (no unhandledRejection).
   */
  _enqueue(chatKey, fn) {
    const prev = this._chatQueues.get(chatKey) ?? Promise.resolve();
    const run = prev.then(() => fn()).catch((err) => {
      this._log('error', 'Handler error:', err);
    });
    // Keep the chain alive even after a rejection so the next item still runs.
    const tail = run.catch(() => {});
    this._chatQueues.set(chatKey, tail);
    const tracked = tail.then(() => {
      this._inflight.delete(tracked);
      if (this._chatQueues.get(chatKey) === tail) this._chatQueues.delete(chatKey);
    });
    this._inflight.add(tracked);
  }

  async _pollLoop(signal) {
    let delay;

    while (this.running && !signal.aborted) {
      try {
        const updates = await this.client.getUpdates(
          this.lastOffset,
          this.options.updateLimit ?? UPDATE_LIMIT,
          this.options.longPollTimeout ?? 30,
          signal,
        );

        if (signal.aborted) break;

        if (updates.length > 0) {
          this._processUpdates(updates);
          // Commit the offset only from a valid id; a bad id would serialize
          // to `null` in the store and force a full backlog replay on restart.
          let maxId = -1;
          for (const u of updates) {
            if (Number.isFinite(u?.updateId) && u.updateId > maxId) maxId = u.updateId;
          }
          if (maxId >= 0) {
            this.lastOffset = maxId + 1;
            this._saveOffset();
          } else {
            this._log('warn', 'getUpdates returned updates without valid update_ids; offset not advanced');
          }
        }

        // Backoff counters reset only AFTER a fully successful cycle — resetting
        // at the top of the loop used to wipe them every iteration, so failures
        // never escalated past the base delay (flat 2s hammering on 409s).
        this._resetRetryState();
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

  _processUpdates(updates) {
    // IMPORTANT: handler work is ENQUEUED, never awaited here. A handler that
    // stalls on a hung/flaky Telegram call (see the per-request timeout in
    // client.js) must never block the next getUpdates — that was the "bot
    // deaf during a long task" bug. Unlike the old fire-and-forget dispatch,
    // per-chat queues keep message order and every rejection (also after
    // internal awaits) is caught — no unhandledRejection can kill the process.
    for (const update of updates) {
      try {
        const msg = update.message || update.editedMessage;
        if (this.verbose) {
          this._log('debug', 'update', update.updateId, JSON.stringify({
            keys: Object.keys(update),
            chatId: msg?.chatId,
            text: String(msg?.text ?? '').slice(0, 60),
            cq: update.callbackQuery ? String(update.callbackQuery.data ?? '').slice(0, 40) : undefined,
          }));
        }
        if (msg && this.messageHandlers.length > 0) {
          // Dedup by (chat, message): protects against offset replays after a
          // restart and against edited messages re-arriving. The key is only
          // recorded once the message PASSES the policy checks below — a
          // policy-dropped message must stay eligible after the operator
          // fixes the allowlist without a restart.
          const key = `${msg.chatId}:${msg.messageId}`;
          if (this._seenMessageIds.has(key)) continue;

          // Allowlist comparisons are String-normalized on BOTH sides: config
          // entries may be numbers while ids arrive as strings, and a strict
          // includes() then silently drops every message.
          const allowedChats = this.options.allowedChats?.length
            ? this.options.allowedChats.map(String) : null;
          if (allowedChats && !allowedChats.includes(String(msg.chatId))) {
            this._log('warn', `Message from chat ${msg.chatId} dropped by allowedChats policy`);
            continue;
          }
          const allowedUsers = this.options.allowedUsers?.length
            ? this.options.allowedUsers.map(String) : null;
          if (allowedUsers && !allowedUsers.includes(String(msg.senderId))) {
            this._log('warn', `Message from sender ${msg.senderId} dropped by allowedUsers policy`);
            continue;
          }
          if (this._seenMessageIds.size >= this._SEEN_CAP) {
            // FIFO-evict the oldest entries; clearing the whole set would drop
            // the replay-dedup guarantee right when replays get likely.
            for (const old of this._seenMessageIds) {
              this._seenMessageIds.delete(old);
              if (this._seenMessageIds.size < this._SEEN_CAP / 2) break;
            }
          }
          this._seenMessageIds.add(key);

          this._enqueue(`c:${msg.chatId}`, () => Promise.all(
            this.messageHandlers.map((h) => h(msg)),
          ));
        }

        if (update.callbackQuery && this.callbackHandlers.length > 0) {
          // Serialize callbacks into the SAME chat queue so a button tap can
          // never overtake (or be overtaken by) that chat's messages.
          const cbChat = update.callbackQuery.chatId ?? update.callbackQuery.message?.chatId ?? 'cb';
          this._enqueue(`c:${cbChat}`, () => Promise.all(
            this.callbackHandlers.map((h) => h(update.callbackQuery)),
          ));
        }
      } catch (err) {
        this._log('error', 'Error processing update:', err);
      }
    }
  }

  _resetRetryState() {
    this.networkErrorCount = 0;
    this.conflictCount = 0;
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
        ['networkerror', 'timeouterror', 'aborterror', 'connectionerror', 'undicierror'].includes(name) ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(e.code) ||
        String(e.message || '').includes('fetch failed')
      );
    });
  }

  _isApiError(err) {
    // Catch Telegram API errors (e.g., 502 Bad Gateway) that are actual HTTP
    // responses but indicate server-side issues. These should be treated as
    // transient. Prefer the structured status fields — substring-matching the
    // message would also match "502" inside chat ids / timeouts and silently
    // turn hard configuration errors into endless retries.
    if (!(err instanceof TelegramApiError)) return false;
    const status = Number(err.status ?? err.errorCode ?? 0);
    if (status >= 500 && status < 600) return true;
    const msg = String(err.message || '').toLowerCase();
    const details = String(err.details || '').toLowerCase();
    const combined = msg + ' ' + details;
    return (
      combined.includes('bad gateway') ||
      combined.includes('service unavailable') ||
      combined.includes('gateway timeout')
    );
  }

  _sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
