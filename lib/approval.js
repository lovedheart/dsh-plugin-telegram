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
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// Callback_data token prefix unique to this plugin's approval cards, so the
// poller can distinguish them from any other inline button. 7 chars ("tgapv2:"),
// leaving ~57 bytes for the request key (well within Telegram's 64-byte cap).
// Bumped from v1 "tgapv:" so any card still open across a plugin upgrade that
// lacks a third button is not mis-routed; old cards simply expire via timeout.
export const CALLBACK_PREFIX = 'tgapv2:';

// Session-id prefix for agents this plugin creates (createTelegramAgent builds
// `telegram-<uuid>`). Only these are "ours": for every other agent we call
// next() so another answerer (e.g. the web UI) keeps its request.
export const TELEGRAM_SESSION_PREFIX = 'telegram-';

/**
 * Parse an approval card's callback_data.
 * @returns {{action:'approve'|'deny'|'always', key:string}|null} — null when the
 *   data is not one of this plugin's approval callbacks. The single-character
 *   action token is `a` (approve) / `d` (deny) / `y` (approve-and-remember).
 */
export function parseApprovalCallback(data) {
  const s = String(data ?? '');
  if (s.startsWith(`${CALLBACK_PREFIX}a:`)) return { action: 'approve', key: s.slice(CALLBACK_PREFIX.length + 2) };
  if (s.startsWith(`${CALLBACK_PREFIX}d:`)) return { action: 'deny', key: s.slice(CALLBACK_PREFIX.length + 2) };
  if (s.startsWith(`${CALLBACK_PREFIX}y:`)) return { action: 'always', key: s.slice(CALLBACK_PREFIX.length + 2) };
  return null;
}

/**
 * Derive a stable "allow-always" rule key from an approval request. This is the
 * unit a user grants when they tap "一直允许": a later ask with the same key is
 * auto-approved (no card) until the rule is cleared.
 *
 * DSH's `req` has no structured sandbox-mode field — only a free-text `reason` —
 * so the key is normalized:
 *   • sandbox escalation (reason `escalate sandbox to <mode>: <justification>`):
 *     the justification changes per call, so match on the STABLE pair
 *     `<toolName>:<mode>` → `sandbox:<toolName>:<mode>`;
 *   • any other guarded ask: the whole tool → `tool:<toolName>`.
 *
 * Pure — exported for tests.
 * @param {string} [toolName]
 * @param {string} [reason]
 * @returns {string} the rule key (always non-empty).
 */
export function approvalRuleKey(toolName, reason) {
  const tool = String(toolName ?? 'tool');
  const r = String(reason ?? '');
  // mode is a token like `workspace-write` / `danger-full-access` — stop at the
  // next whitespace OR colon (the `: ` that precedes the free-text justification).
  const m = /^escalate sandbox to ([^\s:]+)/.exec(r);
  if (m) return `sandbox:${tool}:${m[1]}`;
  return `tool:${tool}`;
}

/** Inline keyboard with Approve / Deny / Approve-and-remember buttons. */
export function buildApprovalKeyboard(key) {
  return {
    inline_keyboard: [
      [
        { text: '✅ 批准', callback_data: `${CALLBACK_PREFIX}a:${key}` },
        { text: '🔁 一直允许', callback_data: `${CALLBACK_PREFIX}y:${key}` },
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

/**
 * Human-readable PLAIN-TEXT form of an allow-always rule key (for /approval
 * listings and the resolved card). Callers HTML-escape the result.
 * `sandbox:write:danger-full-access` → `write 升级至 danger-full-access`；
 * `tool:write` → `write（写文件）`.
 * Pure — exported for tests.
 */
export function describeRuleKey(key) {
  const k = String(key ?? '');
  if (k.startsWith('sandbox:')) {
    const parts = k.split(':'); // ['sandbox', tool, mode]
    const tool = parts[1] ?? '';
    const mode = parts.slice(2).join(':');
    return `${toolLabel(tool)} 升级至 ${mode}`;
  }
  if (k.startsWith('tool:')) return toolLabel(k.slice('tool:'.length));
  return k;
}

/**
 * Persisted allow-always store. Backs the "🔁 一直允许" button: once a rule key
 * is remembered, matching future asks are auto-approved without a card.
 *
 * DSH itself has no "allow always" primitive (the approval service's outcome
 * vocabulary is `allowed-once | rejected | cancelled | unavailable` and its
 * policy is only `ask | never`), so the "always" is implemented plugin-side as
 * a set of remembered rule keys. Each rule also records which chat created it
 * so /approval can list them per-chat.
 *
 * State is a JSON file (atomic tmp+rename write, like the poller offset) so the
 * remember survives a plugin reload. Best-effort: a read-only host just loses
 * persistence, and a malformed file is treated as empty.
 *
 * @param {object} deps
 * @param {(level, ...a) => void} deps.log
 * @param {string} [deps.path]   absolute path to the store file; '' = no-op (tests)
 * @param {() => string} [deps.filePath]  lazily-resolved path (preferred)
 * @param {string} [deps.defaultChatId]  fallback chatId when a rule is created
 *   without one
 * @returns {{
 *   checkAllow: (ruleKey: string) => boolean,
 *   rememberAllow: (ruleKey: string, chatId: (string|null)) => void,
 *   clearRule: (ruleKey: string) => boolean,
 *   listForChat: (chatId: string) => string[],
 *   listAll: () => string[],
 *   removeForChat: (chatId: string) => number,
 *   all: () => string[],
 * }}
 */
export function createAllowlistStore({ log, path: staticPath, filePath, defaultChatId } = {}) {
  let rules = new Map(); // ruleKey -> { chatId, at }
  let storePath = '';

  const _path = () => (typeof filePath === 'function' ? (filePath() || '') : (staticPath || ''));

  function load() {
    storePath = _path();
    if (!storePath) return;
    try {
      const raw = readFileSync(storePath, 'utf8');
      const data = JSON.parse(raw);
      const list = Array.isArray(data?.rules) ? data.rules : [];
      rules = new Map();
      for (const r of list) {
        if (r && typeof r.key === 'string') {
          rules.set(r.key, { chatId: typeof r.chatId === 'string' ? r.chatId : (defaultChatId || null), at: Number(r.at) || Date.now() });
        }
      }
    } catch {
      rules = new Map(); // missing/corrupt → start empty
    }
  }

  function persist() {
    if (!storePath) return;
    try {
      const dir = dirname(storePath);
      mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        at: Date.now(),
        rules: [...rules.entries()].map(([key, v]) => ({ key, chatId: v.chatId, at: v.at })),
      };
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, storePath);
    } catch (err) {
      log?.('warn', `allow-always store persist failed (path ${storePath}): ${err.message}`);
    }
  }

  load();

  function checkAllow(ruleKey) {
    return rules.has(String(ruleKey));
  }
  function rememberAllow(ruleKey, chatId) {
    const k = String(ruleKey);
    if (!k) return;
    rules.set(k, { chatId: (chatId || defaultChatId || null), at: Date.now() });
    persist();
  }
  function clearRule(ruleKey) {
    const k = String(ruleKey);
    if (!rules.has(k)) return false;
    rules.delete(k);
    persist();
    return true;
  }
  function listForChat(chatId) {
    const c = String(chatId ?? '');
    return [...rules.entries()].filter(([, v]) => String(v.chatId ?? '') === c).map(([k]) => k);
  }
  function all() {
    return [...rules.keys()];
  }
  function removeForChat(chatId) {
    const c = String(chatId ?? '');
    let n = 0;
    for (const [k, v] of [...rules.entries()]) {
      if (String(v.chatId ?? '') === c) { rules.delete(k); n += 1; }
    }
    if (n) persist();
    return n;
  }

  return { checkAllow, rememberAllow, clearRule, listForChat, all, removeForChat };
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
 * @param {(chatId: string) => boolean} [deps.isAutopilot]
 *        autopilot (v0.5.0): true when the owning chat is in autopilot mode —
 *        every ask is auto-granted (no card), the "no prompts" half of global
 *        permissions. Omit to disable.
 * @param {(queryId: string, toast: string) => Promise|void} deps.ackCallback
 *        ack a button click (answerCallbackQuery). Only called on a real click.
 * @param {(outcome: string) => string} deps.toastText  toast for a click
 * @param {(ruleKey: string) => boolean} deps.checkAllow
 *        allow-always: return true when this rule is already remembered (the
 *        ask is auto-approved without a card). A no-op returning false disables
 *        the feature (e.g. approval disabled / no store).
 * @param {(ruleKey: string, chatId: (string|null)) => void} deps.rememberAllow
 *        allow-always: persist the rule key (called when the user taps the
 *        "一直允许" button). No-op when the feature is disabled.
 */
export function createApprovalModule(deps) {
  const pending = new Map(); // key -> live entry
  // Autopilot notices are deduped per chat: the FIRST auto-allowed ask in a
  // session posts the "已自动批准" line, later ones are silent (the user only
  // wants to see it once). enableAutopilot() clears the entry via
  // clearAutopilotNotice() so each /autopilot cycle gets exactly one notice.
  const autopilotNotified = new Set(); // chatIds already notified
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

  // Best-effort one-line notice that an autopilot ask was auto-allowed. No
  // buttons (there is nothing to tap) — purely informational. Never throws.
  function postAutopilotNotice(ownership, label, deps) {
    if (!deps.client?.sendMessage) return;
    const cid = String(ownership.chatId ?? '');
    if (cid) {
      if (autopilotNotified.has(cid)) return; // already announced this autopilot cycle
      autopilotNotified.add(cid);
    }
    const text = `🤖 <b>Autopilot</b>：已自动批准工具授权 <code>${deps.escape(label)}</code>（全局权限模式，无人逐步把关）`;
    Promise.resolve()
      .then(() => deps.client.sendMessage({
        chatId: ownership.chatId,
        text,
        parseMode: 'HTML',
        messageThreadId: ownership.threadId ?? undefined,
        disableNotification: true,
      }))
      .catch(() => { /* ignore */ });
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

    // Autopilot (v0.5.0): when the owning chat is in autopilot, auto-grant every
    // ask without a card. This is the "no permission prompts" half of global
    // permissions — sandbox ESCALATIONS also flow through this answerer, so the
    // agent reaches full write without blocking on a prompt. A short notice is
    // posted so the user can see what was auto-allowed.
    if (deps.isAutopilot?.(ownership.chatId)) {
      const label = toolLabel(req?.toolName);
      deps.log?.('info', `approval auto-allowed (autopilot) for tool "${req?.toolName ?? 'tool'}" (chat ${ownership.chatId})`);
      postAutopilotNotice(ownership, label, deps);
      return 'allowed-once';
    }

    // Allow-always: if this rule was already remembered (the user tapped
    // "一直允许" for it before), approve immediately without posting a card.
    const ruleKey = approvalRuleKey(req?.toolName, req?.reason);
    if (deps.checkAllow?.(ruleKey)) {
      deps.log?.('info', `approval auto-allowed (allow-always) for rule "${ruleKey}" (chat ${ownership.chatId})`);
      return 'allowed-once';
    }

    const key = makeKey();
    let innerResolve;
    const promise = new Promise((r) => { innerResolve = r; });
    const entry = {
      key,
      toolName: req?.toolName ?? 'tool',
      ruleKey,
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
    let outcome;
    if (parsed.action === 'deny') outcome = 'rejected';
    else {
      // 'approve' and 'always' both grant; 'always' additionally remembers the
      // rule so future identical asks auto-approve without a card.
      outcome = 'allowed-once';
      if (parsed.action === 'always') {
        const entry = pending.get(parsed.key);
        if (entry) entry.remembered = true;
        const ruleKey = entry?.ruleKey ?? null;
        if (ruleKey) {
          try { deps.rememberAllow?.(ruleKey, entry?.chatId ?? null); } catch { /* ignore */ }
          deps.log?.('info', `approval rule "${ruleKey}" remembered (chat ${entry?.chatId ?? '?'})`);
        }
      }
    }
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

  /**
   * Forget the "already notified" flag for a chat so the next auto-allowed ask
   * posts the notice again. Called by enableAutopilot (fresh /autopilot cycle)
   * and disableAutopilot (cleanup).
   */
  function clearAutopilotNotice(chatId) {
    autopilotNotified.delete(String(chatId));
  }

  return {
    handleApprovalRequest,
    handleCallbackQuery,
    cancelAll,
    clearAutopilotNotice,
    // exposed for tests
    _pending: pending,
    _settle: settle,
    _autopilotNotified: autopilotNotified,
  };
}
