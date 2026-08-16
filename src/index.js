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
import {
  createApprovalModule,
  createAllowlistStore,
  parseApprovalCallback,
  buildApprovalKeyboard,
  buildApprovalCardText,
  toolLabel,
  describeRuleKey,
  TELEGRAM_SESSION_PREFIX,
} from './approval.js';
import {
  createQuestionModule,
  createMuxSubscriber,
  parseSseFrames,
  parseQuestionCallback,
} from './questions.js';
import { chunkText, markdownToTelegramHtml, guardConvertedLength } from './text.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  agentResponseMode: 'tool',  // 'tool' = agent uses telegram_send_message, 'direct' = auto-capture & send
  replyPrefix: '',            // Prefix added to agent's direct reply
  // direct mode: ABSOLUTE safety cap (seconds) for waiting on a turn's final
  // assistant message before giving up on auto-forwarding. The watcher is
  // busy-aware — it follows the agent while `running` and exits early the
  // moment it is idle with a fresh reply (or idle with nothing to forward,
  // after a short grace) — so this cap only bounds pathological hangs.
  // Default 1h: long tool-call turns can run many minutes.
  directReplyTimeoutSec: 3600,
  // direct mode progress indicator: if a turn is still running after
  // directReplyProgressDelaySec, post a "working…" message (replied to the
  // user's message) and refresh it every directReplyProgressIntervalSec.
  // It is deleted as soon as the final reply is sent (or turned into a
  // timeout notice if the wait is abandoned). Short turns that finish
  // before the delay see no indicator at all. Purely best-effort: a failed
  // indicator send never blocks or drops the final reply.
  directReplyProgressDelaySec: 45,
  directReplyProgressIntervalSec: 30,
  // Live trajectory (tool calls + thinking) — in BOTH 'direct' and 'tool'
  // response modes. While the agent works on a Telegram message, keep a single
  // editable message alive showing a ROLLING TRAIL of its recent activity —
  // the streaming reasoning (💭) and each tool call (🔧 name + args) —
  // tail-truncated so the newest items stay visible, plus a live "typing…"
  // chat action, so the user is never left staring at silence. Modelled on
  // QwenPaw's Telegram channel edit-in-place streaming. The message is deleted
  // as soon as the turn ends (turn/end); progressTimeoutSec is an absolute
  // self-cleaning cap. Short turns that finish before progressDelaySec never
  // show it. The final reply is NOT shown here — it is sent separately at
  // turn end. progressPerBlockChars caps each line; progressMaxChars caps the
  // whole message.
  progressEnabled: true,
  progressDelaySec: 5,          // only post the indicator if still busy after this
  progressIntervalMs: 1200,     // min gap between message edits (Telegram ~1/s/msg)
  progressPerBlockChars: 240,   // max chars per trajectory line (reasoning/tool)
  progressMaxChars: 1500,       // max chars of the whole trajectory message
  progressTimeoutSec: 3600,  // absolute cap before the indicator self-cleans
  // Tool-guard approval (parity with QwenPaw's Telegram tool_guard card). When
  // the agent's permission policy is 'ask' and a tool call needs an approval
  // decision (sandbox escalation, guarded pre-execute), DSH dispatches an
  // 'approval/request' to composed answerers. This plugin registers an answerer
  // for the Telegram agents it created (session id prefix 'telegram-'): it posts
  // an inline-keyboard card (✅ 批准 / ❌ 拒绝) to the owning chat and resolves
  // 'allowed-once' / 'rejected' when the user taps a button. Without this
  // answerer the ask fails closed (the user sees nothing and the action is
  // denied) — which is the reported bug. approvalTimeoutSec bounds how long the
  // card waits for a tap before expiring (→ 'cancelled'); 0 disables the cap.
  approvalEnabled: true,
  approvalTimeoutSec: 1800,
  // Before /new, a plain Telegram message routes to the deployment's DEFAULT
  // (shared web) agent, not a telegram-* one. approvalForDefaultAgent (default
  // true, only used when defaultChatId is set) also surfaces that shared
  // agent's asks to the phone, so the user gets the card in the state they
  // actually test in. Set false to restrict cards to agents this plugin
  // explicitly created (telegram-*), leaving the default agent's asks to web.
  approvalForDefaultAgent: true,
  // "Allow always" (🔁 一直允许 button on the approval card). When the user
  // taps it, the rule key for that ask is remembered and matching future asks
  // are auto-approved without a card. Remembers are persisted to this file
  // (atomic write, survives reload); manage them via /approval. '' = default
  // location under $DSH_HOME; set an absolute path to relocate.
  approvalAlwaysPath: '',
  // ask_user_question answerer (v0.4.4). When the agent calls ask_user_question
  // (pick an option / type your own), the web host owns the single UI provider
  // and only the BROWSER sees the prompt — a phone-only user waits forever. This
  // plugin subscribes to the web host's /api/events.mux over loopback and posts
  // an inline-keyboard card for questions belonging to our Telegram agents (or,
  // when questionsForDefaultAgent is true, the default shared agent); answers go
  // back via /api/respond. A plain-text reply to a single-question card is
  // consumed as a custom answer. questionsForDefaultAgent mirrors
  // approvalForDefaultAgent (default true, only when defaultChatId is set).
  questionsEnabled: true,
  questionsForDefaultAgent: true,
  // Web host base URL the plugin reaches over loopback. Normally derived from
  // DSH_WEB_URL (the plugin runs inside the `dsh web` process); set to
  // override (e.g. a non-default port) or empty to force the 3080 default.
  webUrl: '',
  // Voice (TTS) — used by telegram_send_voice.
  ttsEndpoint: 'http://127.0.0.1:8890', // local Qwen3-TTS service
  ttsLang: 'Chinese',                   // default language label for synthesis
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
  directReplyProgressDelaySec: ['number'],
  directReplyProgressIntervalSec: ['number'],
  progressEnabled: ['boolean'],
  progressDelaySec: ['number'],
  progressIntervalMs: ['number'],
  progressPerBlockChars: ['number'],
  progressMaxChars: ['number'],
  progressTimeoutSec: ['number'],
  approvalEnabled: ['boolean'],
  approvalTimeoutSec: ['number'],
  approvalForDefaultAgent: ['boolean'],
  approvalAlwaysPath: ['string'],
  questionsEnabled: ['boolean'],
  questionsForDefaultAgent: ['boolean'],
  webUrl: ['string'],
  ttsEndpoint: ['string'],
  ttsLang: ['string'],
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
// Progress indicator — tool calls + thinking, visible on Telegram while the
// agent works. Modelled on QwenPaw's Telegram channel:
//   • a continuous "typing…" chat action (refreshed every ~4 s so it never
//     expires — Telegram typing indicators last ~5 s), and
//   • ONE editable message that describes the current activity in place
//     (throttled because Telegram rate-limits edits to roughly one per second
//     per message).
// It shows, in priority order: an in-flight tool call (with a compact argument
// preview) → active thinking (reasoning tail) → the reply being drafted (text
// tail). It is deleted as soon as the turn ends (a turn/end event), and it
// self-cleans if the turn ever runs past its timeout. Short turns that finish
// before the delay never post the indicator at all. Purely best-effort: any
// Telegram failure is swallowed and never affects the real reply path.
//
// These helpers live at module scope (and are exported) so they can be unit
// tested without booting the whole plugin.
// ---------------------------------------------------------------------------

/** Compact, single-line preview of a tool call's arguments. */
export function summarizeToolArgs(args, max = 110) {
  let s = typeof args === 'string'
    ? args
    : (args == null ? '' : JSON.stringify(args));
  s = String(s).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/** Keep only the trailing `max` chars, prefixed with an ellipsis if truncated. */
export function tailOf(str, max) {
  str = String(str);
  return str.length > max ? '…' + str.slice(-max) : str;
}

/** Collapse runs of whitespace to a single space and trim. */
export function compactText(str) {
  return String(str ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Live Telegram trajectory indicator for one agent turn. Modelled on QwenPaw's
 * Telegram channel: ONE message that is edited in place (throttled) to show a
 * rolling trail of the agent's recent activity — the streaming reasoning (💭)
 * and each tool call (🔧 name + args) — tail-truncated to a character budget so
 * the most recent items stay visible. The final reply is NOT shown here; it is
 * sent separately by the normal reply path when the turn ends.
 *
 * The indicator reads the durable, growing session log
 * (`agent.session.events`) and folds only events with `seq > baseline` (this
 * turn). It understands the live event shapes:
 *   • `assistant/chunk` with `data.chunk.type === 'reasoning-delta'` — a
 *     reasoning token (`.text`);
 *   • `assistant/chunk` with `data.chunk.type === 'block-end'` — a completed
 *     block (`.block` = `{type:'reasoning'|'text'|'tool-call', …}`);
 *   • `tool/call` — the authoritative tool call (`name`, `arguments`,
 *     `callId`).
 * (The persisted `reasoning-chunks`/`tool-call-chunks` packed rows are also
 * understood for robustness, though they normally only appear in the on-disk
 * encoding, not in `Session.events`.)
 *
 * Options `o`: { chatId, threadId, agent, baseline, startedAt, client, log,
 * delayMs, intervalMs, perBlockChars, maxChars, timeoutMs }. `client` is a
 * TelegramClient (or a test double exposing sendMessage/editMessageText/
 * deleteMessage/sendChatAction). `log` is a `(level, ...args)` logger.
 */
export class ProgressIndicator {
  constructor(o) {
    this.o = o;
    this.active = false;
    this.msgId = null;
    this.stopped = false;
    this.lastEditAt = 0;
    this.lastText = '';
    this.lastTypingAt = 0;
    this.loop = null;
    // Rolling trail of activity blocks, newest last:
    //   { kind:'reasoning', text }  or  { kind:'tool', name, args, id }
    this.trace = [];
    // Tool-call ids already recorded (block-end and tool/call both carry the
    // same id — this dedupes so a tool is not shown twice).
    this.seenToolIds = new Set();
    // Watermark: only events with seq strictly greater than this are new. We
    // fold the whole log on every tick but skip already-seen events, so state
    // is never double-applied.
    this.processedSeq = this.o.baseline ?? 0;
  }

  /** Record a completed tool call, deduped by id. */
  _addTool(name, args, id) {
    if (id && this.seenToolIds.has(id)) return;
    if (id) this.seenToolIds.add(id);
    this.trace.push({ kind: 'tool', name: String(name || 'tool'), args: args ?? '' });
    this._capTrace();
  }

  /** Append reasoning text, merging into the trailing reasoning block. */
  _addReasoning(text) {
    const t = String(text ?? '');
    if (!t) return;
    const last = this.trace[this.trace.length - 1];
    if (last && last.kind === 'reasoning') last.text += t;
    else this.trace.push({ kind: 'reasoning', text: t });
    this._capTrace();
  }

  /** Bound the in-memory trail (block count + per-reasoning length). */
  _capTrace() {
    const MAX_BLOCKS = 40;
    if (this.trace.length > MAX_BLOCKS) this.trace.splice(0, this.trace.length - MAX_BLOCKS);
    for (const b of this.trace) {
      if (b.kind === 'reasoning' && b.text.length > 4000) b.text = b.text.slice(-2000);
    }
  }

  /**
   * Render the full rolling-trajectory message: a header plus one line per
   * recent activity block (💭 reasoning / 🔧 tool), tail-truncated to
   * `maxChars` so the newest items survive. Plain text (no HTML), so any model
   * content is safe to post verbatim.
   */
  buildTraceText() {
    const per = this.o.perBlockChars ?? 240;
    const parts = [];
    for (const b of this.trace) {
      if (b.kind === 'reasoning') {
        const t = compactText(b.text);
        if (t) parts.push('💭 ' + tailOf(t, per));
      } else {
        const arg = summarizeToolArgs(b.args, per);
        parts.push('🔧 ' + b.name + (arg ? '：' + arg : ''));
      }
    }
    const header = '📜 运行轨迹（最新）\n';
    if (!parts.length) return header + '⏳ 正在处理，请稍候…';
    const max = this.o.maxChars ?? 1500;
    let body = parts.join('\n');
    if ((header + body).length > max) {
      const budget = max - header.length;
      body = '…' + body.slice(-(budget - 1));
    }
    return header + body;
  }

  /** Post the indicator message (once); returns its id or null. */
  async ensureMessage() {
    if (this.msgId) return this.msgId;
    try {
      const res = await this.o.client.sendMessage({
        chatId: this.o.chatId,
        text: '⏳ 正在处理，请稍候…',
        parseMode: undefined,
        messageThreadId: this.o.threadId,
        disableNotification: true,
      });
      this.msgId = res?.messageId ?? null;
    } catch (err) {
      this.o.log?.('warn', `Progress indicator: failed to post message: ${err.message}`);
      this.msgId = null;
    }
    return this.msgId;
  }

  /** Edit-in-place, throttled; skips when the text is unchanged. */
  async push(force) {
    if (this.stopped || !this.msgId) return;
    const now = Date.now();
    const text = this.buildTraceText();
    if (!force && (text === this.lastText || now - this.lastEditAt < this.o.intervalMs)) return;
    this.lastEditAt = now;
    this.lastText = text;
    try {
      await this.o.client.editMessageText(this.o.chatId, this.msgId, text, undefined);
    } catch (err) {
      this.o.log?.('warn', `Progress indicator: edit failed: ${err.message}`);
    }
  }

  /** Refresh the "typing…" chat action at most once per 4 s. */
  typing() {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastTypingAt < 4000) return;
    this.lastTypingAt = now;
    try { this.o.client.sendChatAction(this.o.chatId, 'typing', this.o.threadId); } catch { /* best-effort */ }
  }

  /**
   * Fold one session event into the trail. `assistant/chunk` is the live shape
   * (delta streaming + block-end completion); `tool/call` is the authoritative
   * tool record; the packed `*-chunks` rows are accepted for robustness.
   * The final assistant reply (text) is deliberately NOT shown — it is sent
   * separately at turn end.
   */
  processEvent(evt) {
    const type = evt?.type;
    const d = evt?.data || {};
    if (type === 'assistant/chunk') {
      const chunk = d.chunk || {};
      if (chunk.type === 'reasoning-delta') {
        this._addReasoning(chunk.text);
      } else if (chunk.type === 'block-end' && chunk.block) {
        const blk = chunk.block;
        if (blk.type === 'reasoning') this._addReasoning(blk.text);
        else if (blk.type === 'tool-call') this._addTool(blk.name, blk.arguments, blk.id);
        // text blocks are the final reply — handled by the reply path, not here.
      }
      // text-delta / tool-call-delta / block-start / usage / finish: ignored.
    } else if (type === 'tool/call') {
      this._addTool(d.name, d.arguments, d.callId);
    } else if (type === 'reasoning-chunks') {
      if (Array.isArray(d.texts)) this._addReasoning(d.texts.join(''));
    } else if (type === 'tool-call-chunks') {
      if (d.name) this._addTool(d.name, Array.isArray(d.args) ? d.args.join('') : d.args, undefined);
    }
  }

  /**
   * Fold new session events into the trail, in chronological order. Only events
   * with seq > processedSeq are applied, so the full log can be passed on every
   * tick without re-processing. Returns true when the turn has ended
   * (a turn/end was seen).
   */
  processEvents(events) {
    for (const evt of events) {
      if (!evt || typeof evt.seq !== 'number' || evt.seq <= this.processedSeq) continue;
      this.processedSeq = evt.seq;
      if (evt.type === 'turn/end') return true;
      this.processEvent(evt);
    }
    return false;
  }

  /** Stop all timers and clean up the indicator message (delete after a final "done" edit). */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.loop) clearInterval(this.loop); } catch { /* ignore */ }
    try {
      if (this.msgId) {
        try { await this.o.client.editMessageText(this.o.chatId, this.msgId, '✅ 完成', undefined); } catch { /* ignore */ }
        try { await this.o.client.deleteMessage(this.o.chatId, this.msgId); } catch { /* ignore */ }
        this.msgId = null;
      }
    } catch { /* ignore */ }
  }

  /** Begin polling the session log and driving the indicator. */
  start() {
    if (this.active) return;
    this.active = true;
    const deadline = Date.now() + this.o.timeoutMs;
    const tick = async () => {
      if (this.stopped) return;
      this.typing();
      // Always fold the session log first: if the turn already ended we stop
      // right away (and never post the indicator for an instant turn).
      const evts = this.o.agent?.session?.events;
      if (Array.isArray(evts)) {
        const done = this.processEvents(evts);
        if (done) { await this.stop(); return; }
      }
      if (!this.msgId) {
        // Only post the indicator once the turn has been going long enough.
        if (Date.now() - this.o.startedAt >= this.o.delayMs) {
          await this.ensureMessage();
          if (this.msgId) await this.push(true);
        }
        return;
      }
      if (Date.now() > deadline) {
        this.o.log?.('warn', 'Progress indicator: hit progressTimeoutSec cap; self-cleaning');
        await this.stop();
        return;
      }
      await this.push(false);
    };
    this.loop = setInterval(() => { void tick(); }, this.o.intervalMs);
    // Kick off immediately so a long turn is picked up without waiting a full
    // interval for the first poll.
    void tick();
  }
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

  // Tool-guard approval (see defaults). 'ask' decisions for the Telegram agents
  // this plugin creates are surfaced to the owning chat as an inline-keyboard
  // card; the tap resolves the DSH 'approval/request' waterfall.
  const approvalEnabled = c.approvalEnabled !== false;
  const approvalTimeoutMs = Math.max(0, Number(c.approvalTimeoutSec) || 0) * 1000;
  const approvalForDefaultAgent = c.approvalForDefaultAgent !== false;

  // ask_user_question answerer (v0.4.4): surfaces the agent's "pick an option
  // / type your own" prompts on Telegram. We subscribe to the web host's
  // /api/events.mux over loopback and answer via /api/respond. `webUrl` is the
  // dsh web base URL — the plugin runs inside the SAME process, so
  // process.env.DSH_WEB_URL (set by `dsh web`) is authoritative; the config
  // key only exists as an override for unusual deployments.
  // `questionsForDefaultAgent` mirrors `approvalForDefaultAgent`: before /new a
  // plain Telegram message routes to the deployment's DEFAULT (shared) agent,
  // so its questions must also reach the phone by default.
  const questionsEnabled = c.questionsEnabled !== false;
  const questionsForDefaultAgent = c.questionsForDefaultAgent !== false;
  const webUrl =
    (typeof c.webUrl === 'string' && c.webUrl.trim() ? c.webUrl.trim()
      : process.env.DSH_WEB_URL || '') || 'http://127.0.0.1:3080';

  // Allow-always store: remembers rule keys the user has approved-with-remember
  // so matching future asks auto-approve. The file path is resolved lazily
  // (DSH_HOME may be known only at store-creation time). Empty path = disabled
  // (the module then falls back to no-op, so "always" simply never persists).
  const approvalStorePath =
    typeof c.approvalAlwaysPath === 'string' && c.approvalAlwaysPath.trim()
      ? c.approvalAlwaysPath.trim()
      : join(
          process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh'),
          'telegram-approval-always.json',
        );
  const approvalStore = approvalEnabled
    ? createAllowlistStore({ log, filePath: () => approvalStorePath, defaultChatId: String(defaultChatId || '') })
    : null;

  // Progress indicator options (tool calls + thinking), shared by both
  // 'direct' and 'tool' response modes.
  const progressEnabled = c.progressEnabled !== false;
  const progressDelayMs = Math.max(0, Number(c.progressDelaySec) || 5) * 1000;
  const progressIntervalMs = Math.max(400, Number(c.progressIntervalMs) || 1200);
  const progressPerBlockChars = Math.max(40, Number(c.progressPerBlockChars) || 240);
  const progressMaxChars = Math.max(120, Number(c.progressMaxChars) || 1500);
  const progressTimeoutMs = Math.max(30, Number(c.progressTimeoutSec) || 3600) * 1000;

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
  // Set inside the polling block (where client/ownership live) so the global
  // cleanup effect can cancel in-flight approval cards on unload, and the
  // callback handler can route button taps. Null when approval is disabled.
  let approvalCancel = null;
  let approvalHandleQuery = null;
  // ask_user_question answerer handles (v0.4.4) — same pattern: set inside the
  // polling block so the callback + message handlers and cleanup can reach them.
  let questionCancel = null;
  let questionHandleQuery = null;
  let questionConsumeText = null;
  let muxStop = null;

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

  // -----------------------------------------------------------------------
  // Voice helpers: text → TTS(WAV) → ffmpeg(OGG Opus) → upload
  //
  // Telegram voice messages must be OGG Opus. We synthesize with the local
  // Qwen3-TTS service (returns 24 kHz mono PCM WAV) and transcode with
  // ffmpeg. Both the WAV and the OGG are written to a temp dir that is
  // cleaned up after the send (best-effort).
  // -----------------------------------------------------------------------
  const ttsEndpoint = (c.ttsEndpoint || 'http://127.0.0.1:8890').replace(/\/+$/, '');

  /**
   * Transcode a WAV to OGG Opus (Telegram voice format) using ffmpeg.
   * @returns {Promise<{ oggPath: string, duration: number }>}
   */
  function wavToOgg(wavPath, workDir, signal) {
    return new Promise((resolve, reject) => {
      const oggPath = join(workDir, 'voice.ogg');
      const ff = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', wavPath,
        '-c:a', 'libopus', '-b:a', '32k', '-ar', '24000',
        oggPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      const killer = signal ? signal.addEventListener('abort', () => { try { ff.kill('SIGKILL'); } catch {} }) : null;
      ff.on('error', (err) => { if (killer) signal?.removeEventListener('abort', killer); reject(new Error(`ffmpeg not found or failed to start: ${err.message}`)); });
      ff.on('close', (code) => {
        if (killer) signal?.removeEventListener('abort', killer);
        if (code !== 0) { reject(new Error(`ffmpeg transcode failed (exit ${code}): ${stderr.slice(0, 300)}`)); return; }
        // Parse duration from the WAV header (byte rate at offset 28) without
        // a second ffprobe call.
        let duration = 0;
        try {
          const buf = readFileSync(wavPath);
          if (buf.length > 32) {
            const byteRate = buf.readUInt32LE(28);
            if (byteRate > 0) duration = Math.max(0, (buf.length - 44) / byteRate);
          }
        } catch { duration = 0; }
        resolve({ oggPath, duration });
      });
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

      // 1) Let the turn finish — busy-aware wait:
      //    • while the agent is `running`, keep following it (long
      //      multi-tool-call turns can run many minutes; the original bug
      //      was a hard 5-minute cap that orphaned such replies);
      //    • the instant it is `idle` with a fresh assistant message →
      //      forward it (short replies still go out within seconds);
      //    • if it goes `idle` with nothing forwardable after a short
      //      grace (15 s) → stop, don't idle until the cap.
      // `directReplyTimeoutSec` (default 1h) is an ABSOLUTE safety cap for
      // pathological hangs only, never a per-turn timeout.
      const hardCap = Date.now() + directReplyTimeoutMs;
      const idleGraceMs = 15_000;
      let lastBusy = Date.now();
      let sawBusy = false;
      let ready = false;
      let gaveUpIdle = false;
      while (Date.now() < hardCap) {
        const evts = session?.events;
        const hasAssistant = Array.isArray(evts) && hasAssistantMessage(evts, baseline);
        const busy = agent.status === 'running';
        if (busy) { sawBusy = true; lastBusy = Date.now(); }
        if (hasAssistant && !busy) { ready = true; break; }
        // Early-exit only once we've seen the turn actually run and it has
        // gone quiet with nothing forwardable. Before the turn starts the
        // agent is also idle, so we must NOT treat that pre-start window as
        // "done" — just keep following until the cap.
        if (!hasAssistant && !busy && sawBusy && Date.now() - lastBusy >= idleGraceMs) {
          gaveUpIdle = true;
          break;
        }
        await sleep(300);
      }
      if (!ready) {
        log('warn', `Direct mode: no forwardable reply for chat ${chatId} (${gaveUpIdle ? 'agent idle without a fresh assistant message' : 'hit directReplyTimeoutSec cap'})`);
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
  // Progress indicator wiring (module-scope class + helpers above). A chat has
  // at most one indicator at a time — the plugin routes each chat to a single
  // active agent, so we key by chatId.
  // -----------------------------------------------------------------------
  const activeIndicators = new Map(); // chatId (string) -> ProgressIndicator

  function startProgressForAgent(agent, chatId, baseline, threadId) {
    if (!progressEnabled) return;
    const chatKey = String(chatId);
    const prev = activeIndicators.get(chatKey);
    if (prev) {
      // A previous turn's indicator is still alive (e.g. user re-sent while
      // busy) — stop it before starting a fresh one for this turn.
      void prev.stop();
    }
    const ind = new ProgressIndicator({
      chatId,
      threadId,
      agent,
      baseline,
      startedAt: Date.now(),
      client,
      log,
      delayMs: progressDelayMs,
      intervalMs: progressIntervalMs,
      perBlockChars: progressPerBlockChars,
      maxChars: progressMaxChars,
      timeoutMs: progressTimeoutMs,
    });
    activeIndicators.set(chatKey, ind);
    ind.start();
    log('info', `Progress indicator started for chat ${chatKey} (agent ${agent?.session?.id})`);
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
  // Tool: telegram_send_voice
  // Synthesizes text to speech via the local Qwen3-TTS service, transcodes
  // to OGG Opus, and sends it as a Telegram voice message.
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_voice',
    description:
      'Send a voice message to a Telegram chat. The text is synthesized to speech ' +
      'via the local Qwen3-TTS service and sent as an OGG Opus voice note. ' +
      'Use this when the user wants to hear a reply instead of reading it.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID. Defaults to the configured default chat.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'The text to speak. Keep it concise — very long texts take longer to synthesize.',
      },
      lang: {
        type: 'string',
        description: 'Language label for the TTS voice, e.g. "Chinese" or "English". Defaults to the configured tts_lang.',
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
      if (!args.text || !String(args.text).trim()) {
        throw new Error('text is required for voice synthesis.');
      }

      const text = String(args.text).trim();
      const lang = args.lang || c.ttsLang || 'Chinese';
      // Rebuild the TTS call with the per-request lang (helper uses config default).
      const workDir = mkdtempSync(join(tmpdir(), 'dsh-voice-'));
      try {
        // TTS with the requested language.
        const wavPath = join(workDir, 'tts_out.wav');
        const resp = await fetch(`${ttsEndpoint}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang }),
          signal: exec?.signal,
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`TTS service failed (${resp.status}): ${body.slice(0, 200)}`);
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 1000 || !(buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)) {
          throw new Error(`TTS did not return a valid WAV (${buf.length} bytes). Is the model loaded?`);
        }
        writeFileSync(wavPath, buf);

        const { oggPath, duration } = await wavToOgg(wavPath, workDir, exec?.signal);
        const result = await client.sendVoiceFile({
          chatId,
          filePath: oggPath,
          duration,
          messageThreadId: args.message_thread_id,
          signal: exec?.signal,
        });
        return `Voice message sent (message_id: ${result.messageId}, ${Math.round(duration)}s). Text: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`;
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
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
              '• /approval — 查看/管理「一直允许」授权（/approval clear 清空）',
              '• /help — 显示本帮助',
              '',
              '直接发普通消息即可对话。',
              '需要授权时（如写工作区外文件），会收到带 ✅ 批准 / 🔁 一直允许 / ❌ 拒绝 的卡片。',
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

          case '/approval': {
            if (!approvalStore) {
              await reply('（审批功能已禁用，`approvalEnabled: false`）');
              return true;
            }
            const rules = approvalStore.all();
            if (!args) {
              if (rules.length === 0) {
                await reply('🛡️ 暂无「一直允许」记忆。\n\n当某次授权卡片出现时点「🔁 一直允许」，同类请求之后会自动批准。\n管理：/approval clear 清空全部。');
                return true;
              }
              const lines = rules.map((k) => `• <code>${escapeHtml(k)}</code>\n   ${escapeHtml(describeRuleKey(k))}`);
              await reply(`🛡️ 已记住的授权（${rules.length}）— 命中后自动批准，不再弹卡：\n\n${lines.join('\n')}\n\n清空全部：/approval clear`);
              return true;
            }
            if (args === 'clear') {
              const n = rules.length;
              for (const k of rules) approvalStore.clearRule(k);
              await reply(n ? `✅ 已清空 ${n} 条「一直允许」记忆。` : '（当前没有可清空的记忆）');
              return true;
            }
            // /approval <ruleKey> — clear one rule by its exact key (e.g. sandbox:write:danger-full-access)
            const removed = approvalStore.clearRule(args.trim());
            await reply(removed
              ? `✅ 已移除记忆：<code>${escapeHtml(args.trim())}</code>`
              : `❌ 未找到该规则 <code>${escapeHtml(args.trim())}</code>（用 /approval 查看现有 key）`);
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

      // ask_user_question custom answer (v0.4.4): if the agent is waiting on a
      // single-question card for this chat and the user replies with plain text
      // (ideally replying to the card), consume it as that question's custom
      // answer instead of injecting it as a new agent message. Multi-question
      // cards answer via buttons only (consumeTextReply returns false).
      if (message.text && questionConsumeText && questionConsumeText(message.chatId, message.text)) {
        log('info', `Chat ${message.chatId}: plain-text reply consumed as ask_user_question answer`);
        return;
      }

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

            // Baseline = number of events before we inject this message. The
            // progress indicator only watches events with seq > baseline so it
            // reflects this turn (tool calls / thinking) and not old history.
            const baseline = currentAgent.session && Array.isArray(currentAgent.session.events)
              ? currentAgent.session.events.length
              : 0;

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

            // Live progress indicator (tool calls + thinking) — works in both
            // response modes; it self-cleans when the turn ends.
            startProgressForAgent(currentAgent, message.chatId, baseline, message.messageThreadId);

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

    // ---------------------------------------------------------------------
    // Tool-guard approval (parity with QwenPaw's tool_guard card).
    //
    // DSH resolves permission asks (sandbox escalation, guarded pre-execute)
    // through an `approval/request` waterfall of answerers. The web host
    // (dsh-host-apiproxy) already registers an answerer that routes to the
    // BROWSER — so without our own answerer, a Telegram agent's ask would be
    // claimed by the web UI and the phone would see nothing (fail-closed from
    // the user's perspective). We register OUR answerer with `prepend` so it
    // runs first, claim only the agents we created (session id `telegram-*`,
    // resolvable to a chat), and `next()` the rest so the web answerer keeps
    // working for web-originated agents. The card is an inline keyboard; the
    // poller's callback handler below resolves the promise when the user taps.
    // ---------------------------------------------------------------------
    // Shared ownership policy: does this agent's session belong to us, and to
    // which Telegram chat does it route? Used by BOTH the approval answerer
    // (v0.4.1) and the ask_user_question answerer (v0.4.4).
    //   `allowDefault` gates case 2 (the deployment's DEFAULT/shared agent):
    //   approval passes `approvalForDefaultAgent`, questions passes
    //   `questionsForDefaultAgent`.
    // Returns {chatId, threadId} or null (null → the web UI keeps it).
    const telegramAgentOwnership = (sessionIdLike, { allowDefault = true } = {}) => {
      const all = ctx.get?.('agents')?.list?.() ?? [];
      const askId =
        typeof sessionIdLike === 'string'
          ? sessionIdLike
          : (sessionIdLike?.id ?? sessionIdLike?.session?.id);
      const hit = all.find((a) => String(a?.id) === String(askId) || String(a?.session?.id) === String(askId));
      const sidStr = String(hit?.session?.id ?? askId ?? '');

        // Case 1 — this plugin's own agents (session id `telegram-*`, created
        // by /new or a fresh chat). Route to the owning chat, else default.
        if (sidStr.startsWith(TELEGRAM_SESSION_PREFIX)) {
          let chatId = null;
          for (const [cid, csid] of chatAgents) {
            if (String(csid) === sidStr) { chatId = String(cid); break; }
          }
          if (!chatId && defaultChatId) chatId = String(defaultChatId);
          if (!chatId) return null;
          return { chatId, threadId: null };
        }

        // Case 2 — the deployment's DEFAULT (shared web) agent. Before /new a
        // plain Telegram message routes here (resolveChatAgent falls back to
        // all[0]), so its asks must also reach the phone or the user gets no
        // card. Only when a default chat is configured and the user opted in
        // (per-caller: approvalForDefaultAgent / questionsForDefaultAgent).
        if (allowDefault && defaultChatId && hit === all[0]) {
          return { chatId: String(defaultChatId), threadId: null };
        }

        // Anything else (other web agents) → delegate to the web answerer.
        return null;
      };

    if (approvalEnabled && typeof ctx.on === 'function') {
      const approvalModule = createApprovalModule({
        client,
        enabled: () => approvalEnabled,
        timeoutMs: approvalTimeoutMs,
        log,
        escape: (s) => escapeHtml(s),
        ownership: (agent) => telegramAgentOwnership(agent?.id ?? agent?.session?.id, { allowDefault: approvalForDefaultAgent }),
        ackCallback: (qid, toast) => {
          if (qid) return client.answerCallbackQuery(qid, toast);
          return Promise.resolve();
        },
        toastText: (outcome) =>
          outcome === 'allowed-once' ? '✅ 已批准'
          : outcome === 'rejected' ? '❌ 已拒绝'
          : '⌛ 已取消',
        // Allow-always: auto-approve when the rule is already remembered, and
        // persist the rule when the user taps "一直允许".
        checkAllow: (ruleKey) => approvalStore?.checkAllow(ruleKey) ?? false,
        rememberAllow: (ruleKey, chatId) => { try { approvalStore?.rememberAllow(ruleKey, chatId); } catch { /* ignore */ } },
        formatResolved: (entry, outcome) => {
          const status =
            outcome === 'allowed-once' ? '✅ 已批准'
            : outcome === 'rejected' ? '🚫 已拒绝'
            : '⌛ 已取消/过期';
          const alwaysLine = (entry.remembered && outcome === 'allowed-once')
            ? `\n\n<i>🔁 已记住「${escapeHtml(describeRuleKey(entry.ruleKey))}」，之后同类请求将自动批准（/approval 管理）。</i>`
            : '';
          return `🛡️ 工具授权：${escapeHtml(toolLabel(entry.toolName))}\n\n${status}${alwaysLine}`;
        },
      });

      // Registered `prepend` so it runs before the web answerer; self-filters
      // to our Telegram agents and delegates everything else via next().
      ctx.on('approval/request', async (req, next) => approvalModule.handleApprovalRequest(req, next), { prepend: true });
      approvalCancel = () => { try { approvalModule.cancelAll(); } catch { /* ignore */ } };
      approvalHandleQuery = (q) => approvalModule.handleCallbackQuery(q);
      log('info', 'Approval (tool-guard) answerer registered for Telegram agents.');
    }

    // ---------------------------------------------------------------------
    // ask_user_question answerer (v0.4.4).
    //
    // The agent can pause to ask the user to pick an option (or type their own
    // prompt) via the `ask_user_question` tool. DSH's web host owns the single
    // UI provider and only the BROWSER sees the prompt — a phone-only user waits
    // forever. We subscribe to the web host's /api/events.mux over loopback
    // (same process), claim the questions that belong to our Telegram agents
    // (same ownership policy as approval), post an inline-keyboard card, and
    // answer via /api/respond. A plain-text reply to a single-question card is
    // consumed as a custom answer. Best-effort: a loopback failure never
    // affects the real reply — the web UI keeps working.
    // ---------------------------------------------------------------------
    if (questionsEnabled && client) {
      const respondQuestion = async (body) => {
        const res = await fetch(`${webUrl.replace(/\/$/, '')}/api/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return json; // { accepted: true } | { accepted: false, reason }
      };
      const questionModule = createQuestionModule({
        log,
        escape: (s) => escapeHtml(s),
        client,
        ownership: (sessionId) => telegramAgentOwnership(sessionId, { allowDefault: questionsForDefaultAgent }),
        respond: respondQuestion,
      });
      questionHandleQuery = questionModule.handleCallbackQuery;
      questionConsumeText = (chatId, text) => questionModule.consumeTextReply(chatId, text);
      questionCancel = () => { try { questionModule.cancelAll(); } catch { /* ignore */ } };
      muxStop = createMuxSubscriber({
        url: webUrl,
        log,
        onFrame: (frame) => questionModule.handleFrame(frame),
      });
      log('info', `ask_user_question answerer registered (subscribed to ${webUrl}/api/events.mux).`);
    }

    poller.onCallbackQuery(async (query) => {
      log('info', `Callback query from ${query.from.username || query.from.id}: data="${query.data}"`);
      // Route button taps to the owning module (each acks its own callback).
      // Tool-guard approval first, then ask_user_question. Anything else falls
      // through to a plain ack.
      if (approvalHandleQuery && approvalHandleQuery(query)) return;
      if (questionHandleQuery && (await questionHandleQuery(query))) return;
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
        { command: 'approval', description: '查看/管理「一直允许」授权（/approval clear 清空）' },
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
      // Cancel any in-flight approval cards so their answerer promises settle
      // (cancelled) rather than hanging after unload.
      try { approvalCancel?.(); } catch { /* ignore */ }
      approvalCancel = null;
      approvalHandleQuery = null;
      // Stop the ask_user_question answerer: drop the mux subscription and
      // forget pending cards (no network — the web host keeps working).
      try { muxStop?.(); } catch { /* ignore */ }
      muxStop = null;
      try { questionCancel?.(); } catch { /* ignore */ }
      questionCancel = null;
      questionHandleQuery = null;
      questionConsumeText = null;
      // Stop any in-flight progress indicators so no stray "working…" message
      // is left behind on unload.
      for (const ind of activeIndicators.values()) {
        try { void ind.stop(); } catch { /* ignore */ }
      }
      activeIndicators.clear();
      // Dispose any agents this plugin created (frees their sessions).
      for (const h of ownedHandles) {
        try { void h.dispose(); } catch { /* ignore */ }
      }
      ownedHandles.length = 0;
      log('info', 'Telegram plugin unloaded.');
    };
  });
}
