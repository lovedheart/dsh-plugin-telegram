/**
 * `/cd` directory browsing for Telegram (v0.7.6).
 *
 * Why: Telegram clients do NOT stream the composer to the bot, so a real
 * "press space → live completions" autocomplete is impossible server-side.
 * What a phone user CAN get instead:
 *
 *   1. Static command-menu shortcuts — `/cd1` … `/cd9` registered via
 *      setMyCommands. Typing `/cd` makes Telegram itself drop the list, and
 *      the entries jump straight to the most-recently-used directories.
 *   2. A tap-to-browse inline card — a bare `/cd` posts a card
 *      listing the session's directory, its subdirectories, `..`, home and the
 *      recent list; every button moves the card, and only the explicit ✅
 *      button commits the change through the working-directory service.
 *
 * Browsing NEVER mutates the session: the card tracks its own `root`, which
 * only becomes the session's working directory on ✅ (`workingDirectory.set`).
 *
 * Callback data carries a short opaque token plus an index into the card's
 * server-side entry list — never a path. Absolute paths blow through
 * Telegram's 64-byte callback_data cap and would need escaping.
 *
 * Pure factory so tests can inject the fs, the client and the service.
 *
 * @module dsh-plugin-telegram/cdnav
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Callback-data namespace for this card family (5 chars: "tgcd:"), leaving
// ~58 bytes for `<token>:<action>[:<index>]`.
export const CALLBACK_PREFIX = 'tgcd:';

// How many subdirectories / recent dirs one card shows at most. Telegram caps
// a reply markup at 100 buttons; staying near 40 keeps the card one screen.
export const MAX_SUBDIRS = 30;
export const MAX_RECENTS = 9;
// A card stops responding after this long (its token is dropped). A stale tap
// then just reports expiry instead of switching to an old directory.
export const CARD_TTL_MS = 30 * 60 * 1000;
// Persistent recent-directories list (`/cd1`… `/cd9` resolve against it).
export const RECENT_LIMIT = 20;

/**
 * Parse a cd-card callback. Pure — exported for tests.
 * @returns {{token:string, action:string, index:number}|null}
 */
export function parseCdCallback(data) {
  const s = String(data ?? '');
  if (!s.startsWith(CALLBACK_PREFIX)) return null;
  const rest = s.slice(CALLBACK_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length < 2) return null;
  const [token, action, idx] = parts;
  if (!token || !action) return null;
  if (action === 'g') {
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= 1000) return null;
    return { token, action: 'g', index: i };
  }
  if (['u', 'h', 's', 'c', 'x'].includes(action)) return { token, action, index: -1 };
  return null;
}

/**
 * Build the callback_data for one button. Pure — exported for tests.
 * @param {string} token
 * @param {string} action
 * @param {number} [index]
 */
export function cdCallbackData(token, action, index = -1) {
  return action === 'g' ? `${CALLBACK_PREFIX}${token}:g:${index}` : `${CALLBACK_PREFIX}${token}:${action}`;
}

/**
 * Trim a directory listing to `max` sorted subdirectory names (dotfiles
 * hidden). Pure — exported for tests.
 * @param {{name:string, isDirectory:()=>boolean}[]} dirents
 * @param {number} [max]
 * @returns {string[]}
 */
export function pickSubdirs(dirents, max = MAX_SUBDIRS) {
  const dirs = (Array.isArray(dirents) ? dirents : [])
    .filter((d) => d && typeof d.name === 'string' && d.name && !d.name.startsWith('.'))
    .filter((d) => { try { return typeof d.isDirectory === 'function' ? d.isDirectory() : !!d.isDirectory; } catch { return false; } })
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return dirs.slice(0, Math.max(0, max));
}

/**
 * Normalise + merge the recent-directory MRU list. Pure — exported for tests.
 * @param {string[]} current
 * @param {string} picked  directory that was just committed
 * @param {number} [limit]
 * @returns {string[]}
 */
export function rememberRecent(current, picked, limit = RECENT_LIMIT) {
  const dir = String(picked ?? '').trim();
  const base = Array.isArray(current) ? current.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
  if (!dir) return base.slice(0, limit);
  const seen = new Set();
  const out = [];
  for (const p of [dir, ...base]) {
    const s = String(p ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Basename-ish label for a recent path, disambiguated with one parent hop. */
export function shortLabel(p, recents = []) {
  const str = String(p ?? '');
  const name = basename(str);
  if (!name) return str;
  const dupe = recents.filter((q) => basename(String(q ?? '')) === name).length > 1;
  if (!dupe) return name;
  const parent = basename(dirname(str));
  return parent ? `${parent}/${name}` : name;
}

/**
 * Render the browse card. Pure — exported for tests.
 *
 * @param {{root:string, sessionCwd:string, recents:string[],
 *          entries:{label:string,path:string}[], canCommit:boolean,
 *          note?:string, token:string, escape?:(s:string)=>string}} state
 * @returns {{text:string, keyboard:object[][]}}
 */
export function buildCdCard(state) {
  const esc = typeof state?.escape === 'function' ? state.escape : (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const root = String(state?.root ?? '');
  const entries = Array.isArray(state?.entries) ? state.entries : [];
  const recents = (Array.isArray(state?.recents) ? state.recents : []).map((s) => String(s ?? '').trim()).filter(Boolean);
  const token = String(state?.token ?? '');
  const lines = [
    `📂 <code>${esc(root || '（未知）')}</code>`,
    `会话当前：<code>${esc(state?.sessionCwd || '（未知）')}</code>`,
  ];
  if (state?.note) lines.push(`⚠️ ${esc(state.note)}`);

  const rows = [];
  if (recents.length) {
    lines.push('', '🕘 最近（也可直接发 /cd1 … /cd9 直达）');
    recents.slice(0, MAX_RECENTS).forEach((p, i) => {
      rows.push([{ text: `${i + 1}️⃣ ${shortLabel(p, recents)}`, callback_data: cdCallbackData(token, 'g', i) }]);
    });
  }
  if (entries.length) {
    lines.push('', '📁 子目录');
    entries.forEach((e, i) => {
      rows.push([{ text: `📁 ${e.label}`, callback_data: cdCallbackData(token, 'g', recents.length + i) }]);
    });
  } else {
    lines.push('', '（无子目录）');
  }

  const nav = [
    { text: '⬆️ 上级', callback_data: cdCallbackData(token, 'u') },
    { text: '🏠 主目录', callback_data: cdCallbackData(token, 'h') },
  ];
  if (root && state?.sessionCwd && root !== state.sessionCwd) {
    nav.push({ text: '📍 会话目录', callback_data: cdCallbackData(token, 's') });
  }
  rows.push(nav);
  if (state?.canCommit) {
    rows.push([
      { text: '✅ 切换到这里', callback_data: cdCallbackData(token, 'c') },
      { text: '✖️ 关闭', callback_data: cdCallbackData(token, 'x') },
    ]);
  }
  lines.push('', '点目录进入 →，确认后点 ✅ 才会切换。');
  return { text: lines.join('\n'), keyboard: rows };
}

/**
 * @param {object} deps
 * @param {object} deps.client                     client-shaped (sendMessage / editMessageText / deleteMessage / answerCallbackQuery)
 * @param {(botId:string, chatId:string)=>object|null} deps.resolveAgent
 * @param {(agent:object)=>string} deps.effectiveCwd
 * @param {(agent:object, path:string)=>Promise<string>} deps.setCwd  wraps workingDirectory.set
 * @param {()=>string[]} [deps.recents]
 * @param {(dir:string)=>void} [deps.remember]
 * @param {(botId:string, chatId:string)=>void} [deps.afterChange]    refresh the status board
 * @param {(s:string)=>string} [deps.escape]
 * @param {(level:string,msg:string,err?:any)=>void} [deps.log]
 * @param {(dir:string, opts:object)=>any[]} [deps.readdirImpl]
 * @param {()=>string} [deps.home]
 */
export function createCdNavModule(deps = {}) {
  const escape = typeof deps.escape === 'function'
    ? deps.escape
    : (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const home = () => String(typeof deps.home === 'function' ? (deps.home() || '') : (deps.home || homedir() || ''));
  const readdirImpl = deps.readdirImpl || ((d) => readdirSync(d, { withFileTypes: true }));
  /** token -> {botId, chatId, messageId, root, entries, createdAt} */
  const cards = new Map();

  function prune(now = Date.now()) {
    for (const [t, c] of cards) {
      if (!c || now - (c.createdAt || 0) > CARD_TTL_MS) cards.delete(t);
    }
  }

  function subdirs(dir) {
    if (!dir) return [];
    try {
      return pickSubdirs(readdirImpl(dir, { withFileTypes: true }), MAX_SUBDIRS)
        .map((name) => ({ label: name, path: join(dir, name) }));
    } catch {
      return [];
    }
  }

  function recents() {
    try { return (deps.recents?.() ?? []).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, MAX_RECENTS); } catch { return []; }
  }

  function agentFor(botId, chatId) {
    try { return deps.resolveAgent?.(botId, chatId) ?? null; } catch { return null; }
  }

  function cwdOf(botId, chatId) {
    try { return String(deps.effectiveCwd?.(agentFor(botId, chatId)) ?? '').trim(); } catch { return ''; }
  }

  /** Compute a card for `root` and register its token. */
  function buildCard(botId, chatId, root, note) {
    const sessionCwd = cwdOf(botId, chatId);
    const base = String(root || sessionCwd || home() || '');
    const rec = recents();
    const subs = subdirs(base);
    const token = randomUUID().replace(/-/g, '').slice(0, 8);
    cards.set(token, {
      botId,
      chatId,
      root: base,
      entries: [...rec.map((p) => ({ label: shortLabel(p, rec), path: p })), ...subs],
      createdAt: Date.now(),
    });
    const card = buildCdCard({
      root: base, sessionCwd, recents: rec, entries: subs,
      canCommit: !!deps.setCwd && !!agentFor(botId, chatId),
      note, escape, token,
    });
    return { token, card };
  }

  /** Post the browse card for a chat (bare `/cd`). */
  async function openCard(botId, chatId, root, note) {
    prune();
    const { token, card } = buildCard(botId, chatId, root, note);
    const sent = await deps.client.sendMessage({
      chatId,
      botId: botId ?? undefined,
      text: card.text,
      parseMode: 'HTML',
      replyMarkup: { inline_keyboard: card.keyboard },
    });
    const c = cards.get(token);
    if (c) c.messageId = sent?.messageId ?? null;
    return sent;
  }

  async function repaint(token, card) {
    const c = cards.get(token);
    if (!c) return;
    if (!c.messageId) return;
    try {
      await deps.client.editMessageText(c.chatId, c.messageId, card.text, 'HTML',
        { inline_keyboard: card.keyboard }, { botId: c.botId });
    } catch (err) {
      deps.log?.('warn', `cd card repaint failed: ${err?.message ?? err}`);
    }
  }

  async function ack(query, toast) {
    try { await deps.client.answerCallbackQuery(query?.id, toast); } catch { /* ignore */ }
  }

  /**
   * Handle a callback_query. Returns true when consumed.
   * @param {string} botId source bot (from the per-bot poller wrapper)
   */
  async function handleCallbackQuery(botId, query) {
    const parsed = parseCdCallback(query?.data);
    if (!parsed) return false;
    prune();
    const { token, action, index } = parsed;
    const card = cards.get(token);
    if (!card) {
      await ack(query, '⌛ 目录卡片已过期，重新发 /cd');
      return true;
    }
    // Origin check (same rule as approval cards): a tap replayed into another
    // chat must not move — or commit — someone else's directory card.
    const clickChat = String(query?.message?.chat?.id ?? '');
    if (clickChat && String(card.chatId ?? '') && clickChat !== String(card.chatId)) {
      await ack(query, '⛔ 请在原会话中操作');
      return true;
    }
    const chatId = card.chatId;
    const ownerBot = card.botId ?? botId;

    if (action === 'x') {
      cards.delete(token);
      try { await deps.client.deleteMessage(chatId, card.messageId); } catch { /* ignore */ }
      await ack(query, '已关闭');
      return true;
    }

    if (action === 'c') {
      const agent = agentFor(ownerBot, chatId);
      if (!deps.setCwd || !agent) {
        await ack(query, '❌ 无法切换：没有可用会话');
        return true;
      }
      try {
        const dir = await deps.setCwd(agent, card.root);
        // Only spend the card once the switch actually landed — on failure the
        // user keeps it and can retry (e.g. the dir was recreated meanwhile).
        cards.delete(token);
        try { deps.remember?.(dir); } catch { /* ignore */ }
        try {
          await deps.client.editMessageText(chatId, card.messageId,
            `✅ 已切换工作目录：<code>${escape(dir)}</code>`, 'HTML', undefined, { botId: ownerBot });
        } catch { /* card may already be gone */ }
        await ack(query, `✅ ${basename(dir) || dir}`);
        try { deps.afterChange?.(ownerBot, chatId); } catch { /* ignore */ }
      } catch (err) {
        await ack(query, `❌ ${String(err?.message ?? err).slice(0, 60)}`);
      }
      return true;
    }

    // Navigation: recompute the root from the OLD card, repaint in place.
    let root = card.root;
    if (action === 'u') root = dirname(String(root || '/')) || '/';
    else if (action === 'h') root = home();
    else if (action === 's') root = cwdOf(ownerBot, chatId) || home();
    else if (action === 'g') {
      const target = card.entries?.[index];
      if (!target) { await ack(query, '⌛ 该项已失效，重新发 /cd'); return true; }
      root = String(target.path);
    }
    const next = buildCard(ownerBot, chatId, root);
    // The repaint replaces the OLD message, so carry its id onto the new
    // token — a card gets a fresh token on every repaint (old taps then read
    // as expired instead of acting on a stale directory).
    const nc = cards.get(next.token);
    if (nc) nc.messageId = card.messageId;
    await repaint(next.token, next.card);
    await ack(query);
    return true;
  }

  return { openCard, handleCallbackQuery, buildCard };
}

/**
 * Recent-directory list backed by a JSON file (default
 * `$DSH_HOME/telegram-cd-recent.json`). Best-effort: a read-only home simply
 * means no persistence across restarts.
 *
 * @param {string} filePath
 */
export function createRecentStore(filePath) {
  let list = [];
  let loaded = false;

  function load() {
    if (loaded) return list;
    loaded = true;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(data?.recent)) list = data.recent.map((s) => String(s ?? '').trim()).filter(Boolean);
    } catch { /* first run / unreadable */ }
    return list;
  }

  function persist() {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ recent: list }, null, 2));
      renameSync(tmp, filePath);
    } catch { /* read-only home: memory-only */ }
  }

  return {
    list: () => load().slice(),
    remember(dir) {
      load();
      list = rememberRecent(list, dir, RECENT_LIMIT);
      persist();
    },
    /** For tests / a future reset. */
    replace(next) {
      list = (Array.isArray(next) ? next : []).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, RECENT_LIMIT);
      loaded = true;
      persist();
    },
    file: filePath,
  };
}
