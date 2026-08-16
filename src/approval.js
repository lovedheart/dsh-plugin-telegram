/**
 * Tool-guard approval over Telegram (parity with QwenPaw's `tool_guard` card).
 *
 * DSH's permission model: a tool call that needs approval (sandbox escalation,
 * a `tools/pre-execute` `ask` decision) resolves through `ctx.approval.request()`,
 * which dispatches an `approval/request` to composed answerers. With no answerer
 * the ask FAILS CLOSED (the user sees nothing, the action is denied) — which is
 * exactly the bug this module fixes. It provides that answerer for the Telegram
 * agents this plugin creates: it posts an inline-keyboard card
 * (✅ 批准 / ❌ 拒绝) to the owning chat and resolves `allowed-once` /
 * `rejected` when the user taps a button, or `cancelled` on timeout / abort.
 *
 * Kept as a pure factory (`createApprovalModule`) so it is unit-testable with
 * injected mocks (client, ownership maps, timers).
 *
 * @module dsh-plugin-telegram/approval
 */

import { isTransientTelegramError } from './client.js';

// Callback_data token prefix unique to this plugin's approval cards, so the
// poller can distinguish them from any other inline button. 6 chars, leaving
// ~58 bytes for the request key (well within Telegram's 64-byte cap).
export const CALLBACK_PREFIX = 'tgapv:';

// Session-id prefix for agents this plugin creates (createTelegramAgent builds
// `telegram-<uuid>`). Only these are "ours": for every other agent we call
// next() so another answerer (e.g. the web UI) keeps its request.
export const TELEGRAM_SESSION_PREFIX = 'telegram-';

/**
 * Parse an approval card's callback_data.
 * @returns {{action:'approve'|'deny', key:string}|null} — null when the data is
 *   not one of this plugin's approval callbacks.
 */
export function parseApprovalCallback(data) {
  const s = String(data ?? '');
  if (s.startsWith(`${CALLBACK_PREFIX}a:`)) return { action: 'approve', key: s.slice(CALLBACK_PREFIX.length + 2) };
  if (s.startsWith(`${CALLBACK_PREFIX}d:`)) return { action: 'deny', key: s.slice(CALLBACK_PREFIX.length + 2) };
  return null;
}

/** Inline keyboard with Approve/Deny buttons for one request key. */
export function buildApprovalKeyboard(key) {
  return {
    inline_keyboard: [
      [
        { text: '✅ 批准', callback_data: `${CALLBACK_PREFIX}a:${key}` },
        { text: '❌ 拒绝', callback_data: `${CALLBACK_PREFIX}d:${key}` },
      ],
    ],
  };
}

/**
 * Human-readable card text. `toolName` and `reason` must be HTML-escaped by the
 * caller (they come from the model / DSH, not the user). The timeout hint is
 * only shown when timeoutSec > 0.
 */
export function buildApprovalCardText(toolName, reason, timeoutSec) {
  const reasonLine = reason ? `\n\n<code>${reason}</code>` : '';
  const timeoutLine = timeoutSec > 0
    ? `\n\n<i>如不操作，${timeoutSec} 秒后将自动取消。</i>`
    : '';
  return `🛡️ 需要授权批准\n\n工具：<code>${toolName}</code>${reasonLine}${timeoutLine}`;
}

/**
 * Resolve a friendly one-line display for a tool name (e.g. `bash` → `bash（命令执行）`).
 * Pure — exported for reuse and tests.
 */
export function toolLabel(toolName) {
  const t = String(toolName ?? 'tool');
  switch (t) {
    case 'bash': return 'bash（命令执行）';
    case 'write': return 'write（写文件）';
    case 'edit': return 'edit（编辑文件）';
    case 'read': return 'read（读文件）';
    default: return t;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create the approval answerer module.
 *
 * @param {object} deps
 * @param {object} deps.client   live TelegramClient (sendMessage/editMessageText)
 * @param {() => boolean} deps.enabled
 * @param {number} deps.timeoutMs   0 = no expiry
 * @param {(level, ...a) => void} deps.log
 * @param {(reason: string) => string} deps.escape  HTML-escape helper
 * @param {(agent) => ({chatId: string, threadId: (number|null), chatLabel: string})|null}
 *        deps.ownership  resolve the owning chat for an agent; null = not ours
 * @param {(queryId: string, toast: string) => Promise|void} deps.ackCallback
 *        ack a button click (answerCallbackQuery). Only called on a real click.
 * @param {(outcome: string) => string} deps.toastText  toast for a click
 */
export function createApprovalModule(deps) {
  const pending = new Map(); // key -> live entry
  let seq = 1;
  const makeKey = () => `p${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /**
   * Settle one pending card with an outcome (idempotent). Best-effort edits the
   * card into its resolved state and, only on a real click, acks the callback.
   * `deps.formatResolved` receives the pending entry itself (the map is already
   * cleared by the time it is called).
   * @returns the outcome, or null if the key is unknown / already settled.
   */
  function settle(key, outcome, { clickQueryId } = {}) {
    const p = pending.get(key);
    if (!p || p.outcome) return null;
    p.outcome = outcome;
    if (p.timer) { try { clearTimeout(p.timer); } catch { /* ignore */ } p.timer = undefined; }
    // Note: we deliberately do NOT remove the abort listener here — it is
    // idempotent-safe (settle early-returns once an outcome is set) and would be
    // gone with the signal when the turn ends.
    pending.delete(key);
    // Edit the card into its resolved state (best-effort; the card may already
    // be gone on a chat the bot can't edit).
    const resolved = deps.formatResolved(p, outcome);
    if (p.cardMessageId && resolved) {
      Promise.resolve().then(() => deps.client.editMessageText(p.chatId, p.cardMessageId, resolved, 'HTML'))
        .catch(() => { /* ignore */ });
    }
    // Toast only on a real button click.
    if (clickQueryId) {
      Promise.resolve().then(() => deps.ackCallback?.(clickQueryId, deps.toastText(outcome)))
        .catch(() => { /* ignore */ });
    }
    p.resolve(outcome);
    return outcome;
  }

  /**
   * The `approval/request` waterfall answerer. Return an outcome to claim the
   * request; call next() to delegate to other answerers.
   *
   * "Is this our request?" is decided ENTIRELY by `deps.ownership` — it returns
   * the owning chat for a request this plugin should answer, or null to delegate
   * (e.g. to the web UI for web-originated agents). Keeping that policy in the
   * caller keeps this module generic and unit-testable.
   */
  async function handleApprovalRequest(req, next) {
    if (!deps.enabled()) return next();
    if (req?.signal?.aborted) return 'cancelled';
    const ownership = deps.ownership(req?.agent);
    if (!ownership) return next();
    if (req?.signal?.aborted) return 'cancelled';

    const key = makeKey();
    let innerResolve;
    const promise = new Promise((r) => { innerResolve = r; });
    const entry = {
      key,
      toolName: req?.toolName ?? 'tool',
      chatId: ownership.chatId,
      threadId: ownership.threadId ?? null,
      cardMessageId: null,
      outcome: null,
      timer: undefined,
      onAbort: undefined,
      abortSignal: undefined,
      resolve: innerResolve,
    };
    pending.set(key, entry);

    // Post the card (closes over `key` for the keyboard).
    let cardMessageId = null;
    {
      const text = buildApprovalCardText(
        toolLabel(req?.toolName),
        deps.escape(String(req?.reason ?? '')),
        deps.timeoutMs > 0 ? Math.round(deps.timeoutMs / 1000) : 0,
      );
      const keyboard = buildApprovalKeyboard(key);
      const maxAttempts = 5;
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await deps.client.sendMessage({
            chatId: ownership.chatId,
            text,
            parseMode: 'HTML',
            replyMarkup: keyboard,
            messageThreadId: ownership.threadId ?? undefined,
          });
          cardMessageId = res?.messageId ?? null;
          break;
        } catch (err) {
          if (attempt >= maxAttempts || !isTransientTelegramError(err)) {
            deps.log('error', `approval card send to chat ${ownership.chatId} failed after ${attempt} attempt(s): ${err.message}`);
            cardMessageId = null;
            break;
          }
          const delayMs = Math.min(1000 * 2 ** attempt, 10_000);
          deps.log('warn', `approval card send attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
          await sleep(delayMs);
        }
      }
    }
    if (!cardMessageId) {
      pending.delete(key);
      // Could not deliver the card — delegate so another answerer (e.g. web UI)
      // may still answer; otherwise the service fails closed.
      return next();
    }
    entry.cardMessageId = cardMessageId;

    if (deps.timeoutMs > 0) {
      entry.timer = setTimeout(() => settle(key, 'cancelled'), deps.timeoutMs);
    }
    if (req?.signal) {
      const onAbort = () => settle(key, 'cancelled');
      entry.onAbort = onAbort;
      entry.abortSignal = req.signal;
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    deps.log('info', `approval card posted for tool "${req?.toolName}" (chat ${ownership.chatId}, key ${key})`);

    const outcome = await promise;
    if (entry.onAbort && entry.abortSignal) {
      try { entry.abortSignal.removeEventListener('abort', entry.onAbort); } catch { /* ignore */ }
    }
    return outcome;
  }

  /** Handle a callback_query from the poller. Returns true when consumed. */
  function handleCallbackQuery(query) {
    const parsed = parseApprovalCallback(query?.data);
    if (!parsed) return false;
    const outcome = parsed.action === 'approve' ? 'allowed-once' : 'rejected';
    const settled = settle(parsed.key, outcome, { clickQueryId: query?.id });
    if (settled === null) {
      // Unknown or already-settled key — ack so the client stops spinning.
      Promise.resolve().then(() => deps.ackCallback?.(query?.id, '⌛ 已处理或已过期'))
        .catch(() => { /* ignore */ });
      return true;
    }
    return true;
  }

  /** Cancel every pending card (plugin unload / explicit). */
  function cancelAll(outcome = 'cancelled') {
    for (const [key, p] of [...pending.entries()]) {
      if (p.outcome) continue;
      p.outcome = outcome;
      if (p.timer) { try { clearTimeout(p.timer); } catch { /* ignore */ } }
      pending.delete(key);
      const resolved = deps.formatResolved(p, outcome);
      if (p.cardMessageId && resolved) {
        Promise.resolve().then(() => deps.client.editMessageText(p.chatId, p.cardMessageId, resolved, 'HTML'))
          .catch(() => { /* ignore */ });
      }
      try { p.resolve(outcome); } catch { /* ignore */ }
    }
  }

  return {
    handleApprovalRequest,
    handleCallbackQuery,
    cancelAll,
    // exposed for tests
    _pending: pending,
    _settle: settle,
  };
}
