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
import { SubagentBoard, DEFAULT_REFRESH_MS } from './subagents.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
  progressTickMs: 1000,         // tick-loop cadence: drives the "typing…" refresh + event fold
  progressIntervalMs: 5000,     // min gap between trajectory message EDITS (was 1200; lowered frequency to cut API load / rate-limit risk)
  progressPerBlockChars: 240,   // max chars per trajectory line (reasoning/tool)
  progressMaxChars: 1500,       // max chars of the whole trajectory message
  progressTimeoutSec: 3600,  // absolute cap before the indicator self-cleans
  // Streaming reply (方案B, direct mode only). Instead of "wait for the turn to
  // end, then send the full reply", show the reply BUILDING in place: a
  // placeholder message is edited incrementally as `text-delta` events arrive
  // (live text is plain so partial markdown never breaks parsing), and at
  // turn/end the placeholder is edited in place to the final HTML render (or,
  // when it exceeds the 4096 hard limit, deleted and chunk-sent instead).
  // Only active when agentResponseMode is 'direct' — in 'tool' mode the agent
  // sends via telegram_send_message itself, so the plugin must not also send.
  // The activity-trail ProgressIndicator still runs alongside it.
  streamingReply: true,
  // Inbound media download + forward (parity with QwenPaw). When the user sends
  // a photo/document/video/audio/voice, download it to a local dir and tell the
  // agent where it is (and, for photos, optionally attach a vision block).
  forwardInboundMedia: true,
  // Attach an inbound photo as a VISION content block so a multimodal model can
  // "see" it. Default false: the current deployment model (Qwen text-only)
  // would throw UNSUPPORTED_CONTENT on an image block and break the turn. The
  // photo is still downloaded + its path told to the agent either way; flip
  // this on only when using a vision-capable model.
  inboundImageToModel: false,
  // Directory for downloaded inbound media. '' = $DSH_HOME/telegram-inbound.
  inboundMediaDir: '',
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
  // Autopilot (v0.5.0). A per-chat ON/OFF mode that makes the chat's agent run
  // "fully autonomous". While active it does two things:
  //   1. Global permissions — appends a `sandbox/mode` = autopilotSandboxMode
  //      event to the agent session (full write, no workspace confinement) AND
  //      makes the plugin's `approval/request` answerer auto-grant every ask for
  //      that agent (no inline card). Sandbox ESCALATIONS also route through
  //      that same answerer, so the agent never blocks on a permission prompt.
  //      (Note: approval/policy stays 'ask'; 'never' would REJECT asks, so we
  //      short-circuit the answerer instead.)
  //   2. Auto-answer questions — when the agent pauses to ask_user_question it
  //      AUTO-ACCEPTS the recommended option (the one labelled 推荐/recommended,
  //      else the first) instead of waiting, then posts a notice card listing
  //      ALL options and which one was chosen. The user has a short takeover
  //      window (autopilotWindowMs) to tap "✋ 接管" and re-take manual control
  //      before the answer is committed.
  // /autopilot prints an explicit security warning on enable. autopilotEnabled
  // is the master switch; the mode still only applies to agents this plugin owns.
  autopilotEnabled: true,
  // Sandbox mode autopilot switches the agent to while active. Default
  // 'danger-full-access' (true global write). Set 'workspace-write' to keep the
  // agent confined to its workspace while still auto-approving.
  autopilotSandboxMode: 'danger-full-access',
  // Takeover window (ms) before an autopilot question auto-commits the
  // recommended answer. 0 = commit immediately (post-hoc notice only).
  autopilotWindowMs: 10000,
  // Web host base URL the plugin reaches over loopback. Normally derived from
  // DSH_WEB_URL (the plugin runs inside the `dsh web` process); set to
  // override (e.g. a non-default port) or empty to force the 3080 default.
  webUrl: '',
  // Voice (TTS) — used by telegram_send_voice.
  ttsEndpoint: 'http://127.0.0.1:8890', // local Qwen3-TTS service
  ttsLang: 'Chinese',                   // default language label for synthesis
  // Inbound voice (STT). When the user sends a Telegram voice note, transcribe
  // it locally (Whisper, OpenAI-compatible) and:
  //   (a) reply with the recognized text directly UNDER the voice bubble — a
  //       reply to the voice message is the only way to show it "on the next
  //       line" (Telegram bots cannot edit other people's messages);
  //   (b) fold the SAME transcript into the note injected to the agent, so the
  //       agent already has the text and does NOT need to call transcribe_audio.
  // sttEndpoint matches the Whisper proxy dsh-tool-audio already uses.
  // Requires forwardInboundMedia (the file must be downloaded to transcribe).
  sttEndpoint: 'http://127.0.0.1:18068',
  voiceTranscribe: true,           // master switch for inbound-voice transcription
  voiceTranscribeLanguage: 'auto', // force an ISO-639-1 code, or 'auto' to detect
  voiceTranscriptToAgent: true,    // also include the transcript in the agent note
  // Live subagent board. While a session spawns subagents, keep ONE pinned
  // Telegram message per chat showing each subagent live — a short task name +
  // status (line 1) and what it is doing right now (line 2), at most two lines
  // per subagent. Rows lock when the subagent ends. See src/subagents.js.
  subagentBoardEnabled: true,     // master switch for the board
  subagentBoardPin: true,         // pin the board message (fixed at chat top)
  subagentBoardRefreshMs: 2000,   // cadence to re-read live child sessions
  subagentBoardIncludeDescendants: false, // show nested (depth>1) subagents too
  subagentBoardMaxRows: 10,       // collapse overflow into "+K more"
  // Logging
  verbose: false,             // Enable debug and info logs (default: errors only)
};

// Config schema with basic type validation
// Some YAML parsers (and Cordis) may coerce empty arrays [] to empty objects {},
// so array fields accept both 'array' and 'object'.
const schema = {
  botToken: ['string'],
  // Multi-bot list (v0.5.x). Optional; absent/[]/{}-coerced => single-bot
  // fallback to the top-level fields below (see normalizeBots). Same
  // 'array'|'object' tolerance as other array fields (YAML may coerce [] → {}).
  bots: ['array', 'object'],
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
  progressTickMs: ['number'],
  progressIntervalMs: ['number'],
  progressPerBlockChars: ['number'],
  progressMaxChars: ['number'],
  progressTimeoutSec: ['number'],
  streamingReply: ['boolean'],
  forwardInboundMedia: ['boolean'],
  inboundImageToModel: ['boolean'],
  inboundMediaDir: ['string'],
  approvalEnabled: ['boolean'],
  approvalTimeoutSec: ['number'],
  approvalForDefaultAgent: ['boolean'],
  approvalAlwaysPath: ['string'],
  questionsEnabled: ['boolean'],
  questionsForDefaultAgent: ['boolean'],
  autopilotEnabled: ['boolean'],
  autopilotSandboxMode: ['string'],
  autopilotWindowMs: ['number'],
  webUrl: ['string'],
  ttsEndpoint: ['string'],
  ttsLang: ['string'],
  sttEndpoint: ['string'],
  voiceTranscribe: ['boolean'],
  voiceTranscribeLanguage: ['string'],
  voiceTranscriptToAgent: ['boolean'],
  subagentBoardEnabled: ['boolean'],
  subagentBoardPin: ['boolean'],
  subagentBoardRefreshMs: ['number'],
  subagentBoardIncludeDescendants: ['boolean'],
  subagentBoardMaxRows: ['number'],
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

export async function resolveBotToken(configToken, ctx, envKey = 'TELEGRAM_BOT_TOKEN') {
  // 1. 明文配置
  if (configToken && configToken.trim().length > 0) {
    return configToken.trim();
  }
  // 2. 环境变量（per-bot envKey；多 bot 时各 bot 各读各的，互不串）
  const envToken = envKey ? process.env[envKey] : undefined;
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  // 3. DSH credentials service (ctx.credentials 或 ctx.get('credentials'))
  for (const svc of [ctx.credentials, ctx.get?.('credentials')]) {
    if (!svc || typeof svc.resolve !== 'function') continue;
    try {
      const hit = await svc.resolve(envKey || 'TELEGRAM_BOT_TOKEN');
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
 * Extract the command (slash + name + args) from a message, preferring the
 * `bot_command` entity — the only signal that is guaranteed to be addressed
 * to THIS bot (and to handle the `@botusername` suffix in groups, e.g.
 * `/new@MyBot` — which a naive `text.startsWith('/')` split would reject
 * because the command switch matches `/new` exactly). Falls back to the
 * leading `/word` token when the entity is absent.
 *
 * Returns { cmd, args } (cmd includes the leading slash, no `@suffix`) or null
 * when the message is not a command.
 */
export function extractCommand(message) {
  const text = message.text ?? '';
  const entities = Array.isArray(message.entities) ? message.entities : [];
  const cmdEnt = entities.find((e) => e.type === 'bot_command');
  if (cmdEnt && cmdEnt.offset === 0) {
    const token = text.slice(cmdEnt.offset, cmdEnt.offset + cmdEnt.length) || '/';
    const name = token.replace(/@.*/, ''); // strip @botusername suffix
    if (name && name[0] === '/') {
      const after = text.slice(cmdEnt.offset + cmdEnt.length).replace(/^\s+/, '');
      return { cmd: name, args: after.trim() };
    }
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [first, ...rest] = trimmed.split(/\s+/);
  return { cmd: first, args: rest.join(' ').trim() };
}

/**
 * Sniff a raster image's media type from its leading bytes (magic-number
 * detection). Returns one of 'image/jpeg' | 'image/png' | 'image/webp' |
 * 'image/gif', or null when the bytes are not a supported raster. Used to give
 * the attachments service a media type that matches the ACTUAL bytes — saveImage
 * decodes the image and rejects a mismatching declared type.
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'image/jpeg'; // JFIF / Exif
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return 'image/png';
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return 'image/gif';
  // WEBP: "RIFF"...."WEBP"
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
      && bytes.length >= 12
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
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
    this.typingFailStreak = 0;
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
    // Streaming reply (方案B, direct mode only): the SAME in-place message that
    // shows the activity trail also shows the final reply as it builds —
    // once `text-delta` events arrive, buildTraceText switches to the reply
    // (so the user watches the answer appear), and stop() finalizes it with an
    // HTML render (or a chunked send when it exceeds the 4096 hard limit).
    this.streaming = o.streaming === true;
    this.replyText = '';       // accumulated from text-delta (lossy preview)
    this.finalReplyText = '';  // authoritative full text from assistant/message
    // Most recent NON-reply activity, for the live footer: when the model is
    // NOT actively emitting text (mid tool-call / thinking), the message text
    // would otherwise be unchanged between edits and the "轨迹" appears frozen.
    // A footer showing the latest step keeps it visibly moving.
    this.lastActivityKind = null;   // 'text' | 'reasoning' | 'tool'
    this.lastActivityName = '';
    this.finalized = false;
    // Set true right before stop() when the stop was triggered by a turn/end
    // event (vs. preemption by a newer turn or the timeout cap). Decides whether
    // a failed turn should surface a notice to the phone.
    this.endedByTurnEnd = false;
  }

  /** Record a completed tool call, deduped by id. */
  _addTool(name, args, id) {
    if (id && this.seenToolIds.has(id)) return;
    if (id) this.seenToolIds.add(id);
    this.lastActivityKind = 'tool';
    this.lastActivityName = String(name || 'tool');
    this.trace.push({ kind: 'tool', name: String(name || 'tool'), args: args ?? '' });
    this._capTrace();
  }

  /** Append reasoning text, merging into the trailing reasoning block. */
  _addReasoning(text) {
    const t = String(text ?? '');
    if (!t) return;
    this.lastActivityKind = 'reasoning';
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
    const max = this.o.maxChars ?? 1500;
    // Streaming reply (方案B): once the reply starts arriving, it dominates
    // the message — show its TAIL (newest text, like live typing),
    // tail-truncated to `maxChars`. Plain text so partial markdown never
    // breaks parsing; the final HTML render happens at stop().
    //
    // A latest-activity footer (🔧 tool / 💭 reasoning) is appended so the
    // message keeps CHANGING while the model is mid tool-call or thinking —
    // during those stretches no text-delta fires, so without the footer the
    // reply tail is static, push() sees text===lastText and skips the edit,
    // and the trail appears frozen on long replies. The footer makes the text
    // differ on each new step so the edit re-fires (still capped by the
    // intervalMs throttle, so no extra API load).
    if (this.streaming) {
      const live = this.replyText;
      if (live) {
        const reply = compactText(live);
        const header = '💬 回复（生成中）\n';
        const foot = this._latestActivityLine(max);
        const bodyMax = Math.max(10, max - header.length - foot.length);
        const body = reply.length > bodyMax ? '…' + reply.slice(-(bodyMax - 1)) : reply;
        return header + body + foot;
      }
    }
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
    let body = parts.join('\n');
    if ((header + body).length > max) {
      const budget = max - header.length;
      body = '…' + body.slice(-(budget - 1));
    }
    return header + body;
  }

  /**
   * One-line "what's happening right now" footer for the streaming branch.
   * Returns '' when the model is actively emitting reply text (the live tail
   * is already changing, so a footer would just add noise); otherwise shows
   * the latest tool call or a "thinking" marker so the message text differs
   * on each new step and the edit re-fires instead of freezing.
   */
  _latestActivityLine() {
    if (this.lastActivityKind === 'text' || this.lastActivityKind === null) return '';
    let line;
    if (this.lastActivityKind === 'tool') {
      line = '🔧 ' + (this.lastActivityName || 'tool');
    } else {
      line = '💭 思考中…';
    }
    // Keep the footer to a single short line so it never balloons the message.
    if (line.length > 60) line = line.slice(0, 59) + '…';
    return '\n' + line + ' …';
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
    // sendChatAction is ASYNC — a plain try/catch would miss the reject and leave a
    // broken feedback channel completely silent (the exact "bot works but shows
    // nothing" symptom). Pass throwOnFailure so a persistently broken channel
    // actually rejects (the client swallows the error otherwise); we track
    // consecutive failures so a persistent break is loud instead of invisible.
    Promise.resolve(this.o.client.sendChatAction(this.o.chatId, 'typing', this.o.threadId, { throwOnFailure: true }))
      .then(() => { this.typingFailStreak = 0; })
      .catch((err) => {
        this.typingFailStreak += 1;
        const msg = `Progress indicator: sendChatAction(typing) failed x${this.typingFailStreak}: ${err?.message || err}`;
        // Persistent break (>=3) escalates to error so it survives verbose=false
        // and triggers the text fallback; transient blips stay at warn.
        this.o.log?.(this.typingFailStreak >= 3 ? 'error' : 'warn', msg);
        if (this.typingFailStreak === 3) void this.ensureMessage(); // fallback: show SOMETHING
      });
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
    if (type === 'assistant/message' && this.streaming) {
      // Authoritative final reply (full message). Replaces any accumulated
      // text-delta so the finalized message is never truncated/lossy.
      const msg = d.message;
      if (msg && Array.isArray(msg.content)) {
        const t = msg.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('\n').trim();
        if (t) this.finalReplyText = t;
      }
      return;
    }
    if (type === 'assistant/chunk') {
      const chunk = d.chunk || {};
      if (chunk.type === 'reasoning-delta') {
        this._addReasoning(chunk.text);
      } else if (chunk.type === 'text-delta' && this.streaming) {
        // Final-reply text increment (方案B). Accumulated so the in-place
        // message can show the reply building. (The authoritative full text is
        // re-read from the final assistant/message event at finalize time, so
        // a missed delta is harmless.)
        this.replyText += String(chunk.text ?? '');
        // Mark "actively emitting text" so the activity footer stays hidden —
        // the live reply tail is already changing, a footer would be noise.
        this.lastActivityKind = 'text';
      } else if (chunk.type === 'block-end' && chunk.block) {
        const blk = chunk.block;
        if (blk.type === 'reasoning') this._addReasoning(blk.text);
        else if (blk.type === 'tool-call') this._addTool(blk.name, blk.arguments, blk.id);
        // text blocks are the final reply — handled by the streaming path.
      }
      // tool-call-delta / block-start / usage / finish: ignored.
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

  /**
   * Stop all timers and clean up the indicator message.
   *
   * - Streaming mode (方案B): the placeholder message is FINALIZED IN PLACE —
   *   edited to the final reply (HTML-rendered when it fits the 4096 hard limit,
   *   otherwise deleted + sent as separate chunks). We do NOT append a "✅ 完成"
   *   line. The authoritative full reply text comes from the final
   *   assistant/message event (`this.finalReplyText`), falling back to the
   *   accumulated `text-delta` stream (`this.replyText`) if that event never
   *   arrived. The finalize is delegated to `o.onFinalReply(chatId, text, {
   *   messageThreadId, placeholderMessageId })`; when `placeholderMessageId` is
   *   set the callback edits it in place (or deletes + chunk-sends on overflow).
   * - Trail mode (default): delete the message after a brief "✅ 完成" edit.
   */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.loop) clearInterval(this.loop); } catch { /* ignore */ }
    try {
      if (this.streaming && typeof this.o.onFinalReply === 'function') {
        const fullText = this.finalReplyText || this.replyText;
        if (fullText.trim()) {
          // onFinalReply edits the placeholder in place (HTML when it fits the
          // 4096 limit) or deletes it and chunk-sends the reply; it returns
          // true when it consumed the placeholder so we don't delete it again.
          const consumed = await this.o.onFinalReply(this.o.chatId, fullText, {
            messageThreadId: this.o.threadId,
            placeholderMessageId: this.msgId,
          });
          if (consumed && this.msgId) this.msgId = null;
        } else if (this.endedByTurnEnd && typeof this.o.onTurnError === 'function') {
          // The turn ended but produced no reply text — most likely a provider /
          // turn error (e.g. a 400 that aborts the whole request). Surface it to
          // the phone instead of dropping silently (the failure mode that made the
          // schema-400 bug invisible). Only when we stopped because of an actual
          // turn/end, not when preempted by a newer turn or the timeout cap.
          try { await this.o.onTurnError(this.o.chatId, { messageThreadId: this.o.threadId }); } catch { /* ignore */ }
        }
        // If the reply was empty or the callback did not consume the
        // placeholder, remove the leftover indicator so we never show a stale
        // "生成中" message.
        if (this.msgId) {
          try { await this.o.client.deleteMessage(this.o.chatId, this.msgId); } catch { /* ignore */ }
          this.msgId = null;
        }
        return;
      }
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
        if (done) { this.endedByTurnEnd = true; await this.stop(); return; }
      }
      if (!this.msgId) {
        // Post the placeholder once (a) the activity trail has been going long
        // enough, or (b) in streaming mode the reply itself has started — so
        // the user watches the answer build from its first token, not only
        // after the progress delay.
        const replyStarted = this.streaming && this.replyText.length > 0;
        if (replyStarted || Date.now() - this.o.startedAt >= this.o.delayMs) {
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
    this.loop = setInterval(() => { void tick(); }, this.o.tickMs ?? this.o.intervalMs);
    // Kick off immediately so a long turn is picked up without waiting a full
    // interval for the first poll.
    void tick();
  }
}

// ---------------------------------------------------------------------------
// Multi-bot configuration (v0.5.x)
//
// `bots` is an OPTIONAL config list. Each entry is a full bot config; any
// field omitted on an entry falls back to the TOP-LEVEL config of the same
// name (so the legacy single-bot config keeps working unchanged).
//
//   bots:
//     - id: 'main'            # optional; auto-generated, see below
//       token: ''             # optional; '' -> envKey / credentialKey lookup
//       envKey: 'TELEGRAM_BOT_TOKEN'
//       credentialKey: 'TELEGRAM_BOT_TOKEN'
//       baseUrl: ''           # optional; '' -> top-level baseUrl -> TELEGRAM_BASE_URL
//       defaultChatId: ''
//       allowedChats: []
//       allowedUsers: []
//       ... (per-bot overrides of the top-level fields)
//
// Fallback contract (Phase 0):
//   - no `bots` field, or `bots` === [] / {} (YAML may coerce [] -> {}):
//       -> single bot, id 'default', built from the top-level fields
//          (token = top-level botToken, resolved later via resolveBotToken).
//   - `bots` is a non-empty array: each item is validated field-by-field.
//   - id auto-generation: item.id || (token ? 'bot-' + token.slice(0,8) : 'default')
//   - duplicate ids throw at STARTUP (before any client is created).
//
// normalizeBots is a PURE function (no ctx, no async) so it can be unit-
// tested and reused by later refactors; token RESOLUTION still happens in
// the apply() loop below (resolveBotToken is async and per-bot).
// ---------------------------------------------------------------------------

// Per-bot fields that exist on the TOP-LEVEL config and can be overridden per
// item. Each entry: [field, normalize] where normalize() coerces the value to
// a legal type (same tolerance as the top-level schema: e.g. [] may arrive
// as {} from YAML). `token` is the canonical per-bot token field; `botToken`
// is kept as an alias so either name works on an item.
const BOT_ITEM_FIELDS = {
  token: (v) => (typeof v === 'string' ? v : ''),
  botToken: (v) => (typeof v === 'string' ? v : ''),
  envKey: (v) => (typeof v === 'string' ? v : 'TELEGRAM_BOT_TOKEN'),
  credentialKey: (v) => (typeof v === 'string' ? v : 'TELEGRAM_BOT_TOKEN'),
  baseUrl: (v) => (typeof v === 'string' ? v : ''),
  defaultChatId: (v) => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '')),
  allowedChats: (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])),
  allowedUsers: (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])),
  requireMention: (v) => v === true,
  injectToAgent: (v) => v !== false,
  agentResponseMode: (v) => (typeof v === 'string' ? v : 'tool'),
  longPollTimeout: (v) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : 30),
  maxMessageLength: (v) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : 4000),
  parseMode: (v) => (typeof v === 'string' ? v : 'HTML'),
  pollingEnabled: (v) => v === true,
  replyPrefix: (v) => (typeof v === 'string' ? v : ''),
};

/**
 * Validate + normalize ONE bot item from the `bots` list.
 *
 * Contract (see test T6): INVALID field types are NORMALIZED to a legal type
 * (never throw, never pass through raw) — e.g. allowedChats:'x' -> [],
 * requireMention:1 -> false, defaultChatId:123 -> '123'. Unknown fields are
 * dropped. The returned object carries legal types for every known field
// (values left unset on the item are `undefined` — normalizeBots fills those
// in from the top-level config). Throws only for a non-object item or a
// non-empty-string id (structural errors that cannot be coerced).
 */
export function validateBotItem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('bots[] item must be an object, got ' + (item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item));
  }
  const out = {};
  for (const [field, normalize] of Object.entries(BOT_ITEM_FIELDS)) {
    out[field] = field in item ? normalize(item[field]) : undefined;
  }
  if ('id' in item) {
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`bots[].id must be a non-empty string, got ${JSON.stringify(item.id)}`);
    }
    out.id = item.id.trim();
  }
  return out;
}

/**
 * Normalize the raw `bots` config into the canonical list used by apply().
 *
 *   normalizeBots(undefined, top) -> [ { id:'default', token: top.botToken, ...top fields } ]
 *   normalizeBots([], top)        -> same single-bot fallback
 *   normalizeBots({}, top)        -> same (YAML coerces [] -> {})
 *   normalizeBots([...], top)     -> per-item validation + per-field fallback
 *
 * `top` is the merged top-level plugin config. Throws on structural errors
 * (non-array/non-object items, non-string ids, duplicate ids).
 */
export function normalizeBots(raw, topConfig) {
  const top = topConfig && typeof topConfig === 'object' ? topConfig : {};
  const singleFallback = () => {
    // Legacy single-bot path: one entry built purely from the top-level
    // fields. id is 'default' regardless of whether botToken is set, so the
    // legacy config (top-level botToken, no bots list) stays bit-compatible.
    const entry = {};
    for (const [field, normalize] of Object.entries(BOT_ITEM_FIELDS)) {
      entry[field] = field === 'token'
        ? (typeof top.botToken === 'string' ? top.botToken : '')
        : normalize(top[field]);
    }
    entry.id = 'default';
    entry.botToken = entry.token; // alias, kept in sync
    return [entry];
  };
  if (raw === undefined || raw === null) return singleFallback();
  if (Array.isArray(raw)) {
    if (raw.length === 0) return singleFallback();
  } else if (typeof raw === 'object') {
    // YAML coerced an empty list into {}: treat it as the empty list.
    if (Object.keys(raw).length === 0) return singleFallback();
    throw new Error('`bots` must be an array of bot entries, got a non-empty object');
  } else {
    throw new Error('`bots` must be an array, got ' + typeof raw);
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const entry = validateBotItem(item);
    // Per-field fallback: an item field left unset (undefined) inherits the
    // top-level value of the same field. `token` falls back to top.botToken
    // (the legacy field name).
    for (const field of Object.keys(BOT_ITEM_FIELDS)) {
      if (entry[field] === undefined) {
        entry[field] = field === 'token'
          ? (typeof top.botToken === 'string' ? top.botToken : '')
          : field === 'botToken'
            ? (entry.token ?? '')
            : BOT_ITEM_FIELDS[field](top[field]);
      }
    }
    // Keep `botToken` in sync with the canonical `token` (either name is
    // accepted on an item; downstream code may read either).
    entry.botToken = entry.botToken || entry.token;
    // id: item.id || (token ? 'bot-<first8>' : 'default')
    entry.id = entry.id || (entry.token ? 'bot-' + String(entry.token).slice(0, 8) : 'default');
    if (seen.has(entry.id)) {
      throw new Error('duplicate bot id "' + entry.id + '" in `bots` config');
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bot registry (v0.5.x)
//
// Module-level so unit tests can observe the live registry (tests import
// these exports directly — see test/multi-bot.test.mjs). apply() CLEARS it
// on entry (a reload starts from a clean slate) and repopulates it as bots
// come up.
//
//   botId -> { id, cfg, client, poller, me }
//     cfg    normalized bot entry (from normalizeBots)
//     client TelegramClient (null when the bot was skipped for a missing token)
//     poller TelegramPoller (null when not started)
//     me     getMe() result (undefined until fetched; null if the fetch failed)
// ---------------------------------------------------------------------------

export const botRegistry = new Map();
// v0.5.x P6: board / indicator state is hoisted to module scope (and exported)
// so tests can assert UNLOAD left no residue in the composite-key maps. The
// maps are cleared at the top of every apply() run (mirroring botRegistry) so
// a reload starts clean and never carries a previous run's boards/indicators.
export const subagentBoards = new Map(); // k(botId, chatId) -> SubagentBoard
export const activeIndicators = new Map(); // k(botId, chatId) -> ProgressIndicator
// v0.5.x P5/P6: test-only access to the closure-scoped per-bot ownership +
// board helpers. apply() overwrites these each run with THAT run's closures,
// so a test that does one apply() then reads the hook observes that run's
// chatAgents/rootAgentToChat/boardForChat. (Host code never reads this.)
export const __testHooks = { rootAgentToChat: null, ownerOfChildSession: null, boardForChat: null, chatAgents: null };
export function clientFor(botId) {
  const entry = botRegistry.get(botId);
  if (!entry || !entry.client) {
    throw new Error('clientFor: no Telegram client for bot id "' + botId + '" (unknown bot, or bot skipped for a missing token)');
  }
  return entry.client;
}
export function meFor(botId) {
  const entry = botRegistry.get(botId);
  if (!entry || !entry.me) {
    throw new Error('meFor: no getMe() result for bot id "' + botId + '" (unknown bot, bot not started, or getMe() failed)');
  }
  return entry.me;
}
// Composite key: the ONLY place a "botId::chatId" key is built.
export function k(botId, chatId) {
  return botId + '::' + chatId;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function apply(ctx, config) {
  const c = Object.assign({}, defaults, config);
  // Multi-bot (v0.5.x): normalize the `bots` list (or fall back to the
  // legacy single-bot top-level config). A reload starts from a clean
  // registry — any stale entries from a previous apply() are cleared.
  const bots = normalizeBots(c.bots, c);
  // A reload (apply re-run in the same process) starts from a clean registry —
  // the unload cleanup iterates this map, so a stale entry would be a dead
  // poller/client reference. Clear the board/indicator maps too (module scope,
  // P6) so a previous run's boards/indicators never linger across a reload.
  botRegistry.clear();
  subagentBoards.clear();
  activeIndicators.clear();

  // v0.5.x P4 (tool layer): the optional `bot` parameter every send/media/edit/
  // delete tool accepts (a bot id string). Resolution order:
  //   (1) explicit `bot` — must be a known, connected bot id, else a CLEAR
  //       tool error (never a throw/crash — matches the existing tool
  //       error-return style);
  //   (2) the owning bot of the target chat (composite-key reverse lookup via
  //       botIdForChat, which falls back to 'default' for the legacy config);
  //   (3) the legacy first-bot client (bit-compatible single-bot fallback).
  // Returns { botId, client, error } — exactly one of client/error is non-null.
  // NOTE: `client` / `clientFor` / `botIdForChat` are all in the same apply()
  // scope (declared below); resolveBotClient only runs at tool-execute time,
  // after they are initialized, so the closures are safe.
  function resolveBotClient(botArg, chatId) {
    if (botArg !== undefined && botArg !== null && String(botArg) !== '') {
      const bid = String(botArg);
      const entry = botRegistry.get(bid);
      if (!entry) {
        const known = [...botRegistry.keys()].join(', ') || '(none)';
        return { botId: null, client: null, error: `Unknown bot id "${bid}". Known bots: ${known}.` };
      }
      if (!entry.client) return { botId: null, client: null, error: `Bot "${bid}" is not connected (no token configured).` };
      return { botId: bid, client: entry.client, error: null };
    }
    const bid = botIdForChat(chatId);
    const entry = botRegistry.get(bid);
    if (entry && entry.client) return { botId: bid, client: entry.client, error: null };
    // No owning bot for this chat (e.g. a chat never routed through a bot
    // poller): fall back to the first/legacy client. Report its OWN id so
    // clientFor(botId) can resolve the exact entry we are returning.
    if (client) return { botId: firstBotId || 'default', client, error: null };
    return { botId: null, client: null, error: 'No connected Telegram bot is configured.' };
  }

  // The bot of the card currently being handled (set by the onCallbackQuery
  // wrapper, which knows the source bot). Default until set, so a stray
  // pre-context call falls back to the default bot. Hoisted here (above the
  // approval store) so the store's per-bot defaultChatId resolver can read it.
  let activeCardBotId = 'default';

  // v0.5.x P4: the telegram_get_updates tool advances a MANUAL poll offset that
  // is INDEPENDENT PER BOT (keyed by bot id) and independent of the background
  // poller's own offset. So consuming updates via one bot's manual poll never
  // affects another bot's offset. (Each bot has its own Telegram offset stream
  // anyway — per-bot is the only correct model.)
  const updatesOffsetByBot = new Map(); // botId -> last update_id the tool read

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
  // v0.5.x P5.1: the store's defaultChatId fallback is resolved PER BOT at the
  // moment a rule is remembered (the source card's bot), NOT frozen to the
  // top-level value at store creation. For the legacy single-bot config
  // activeCardBotId stays 'default', whose cfg.defaultChatId IS the top-level
  // defaultChatId — so single-bot behavior is bit-identical.
  const approvalStore = approvalEnabled
    ? createAllowlistStore({
        log,
        filePath: () => approvalStorePath,
        defaultChatId: () => {
          const cfg = botRegistry.get(activeCardBotId || 'default')?.cfg;
          return String(cfg?.defaultChatId || defaultChatId || '');
        },
      })
    : null;

  // Progress indicator options (tool calls + thinking), shared by both
  // 'direct' and 'tool' response modes.
  const progressEnabled = c.progressEnabled !== false;
  const progressDelayMs = Math.max(0, Number(c.progressDelaySec) || 5) * 1000;
  const progressTickMs = Math.max(500, Number(c.progressTickMs) || 1000);
  const progressIntervalMs = Math.max(1000, Number(c.progressIntervalMs) || 5000);
  const progressPerBlockChars = Math.max(40, Number(c.progressPerBlockChars) || 240);
  const progressMaxChars = Math.max(120, Number(c.progressMaxChars) || 1500);
  const progressTimeoutMs = Math.max(30, Number(c.progressTimeoutSec) || 3600) * 1000;

  // Live subagent board options (see src/subagents.js). The board tracks the
  // subagents each chat's agent spawns and renders them into a single pinned,
  // in-place-edited message.
  const subagentBoardEnabled = c.subagentBoardEnabled !== false;
  const subagentBoardPin = c.subagentBoardPin !== false;
  const subagentBoardRefreshMs = Math.max(500, Number(c.subagentBoardRefreshMs) || DEFAULT_REFRESH_MS);
  const subagentBoardIncludeDescendants = c.subagentBoardIncludeDescendants === true;
  const subagentBoardMaxRows = Math.max(1, Number(c.subagentBoardMaxRows) || 10);

  // Streaming reply (方案B) — direct mode only. The reply is shown building in
  // place (placeholder edited as text-delta arrives) and finalized in place at
  // turn end (HTML render, or chunked send on overflow).
  const streamingReplyEnabled = c.streamingReply !== false;

  // Inbound media download + forward (parity with QwenPaw).
  const forwardInboundMedia = c.forwardInboundMedia !== false;
  const inboundImageToModel = c.inboundImageToModel === true;
  const inboundMediaDir =
    (typeof c.inboundMediaDir === 'string' && c.inboundMediaDir.trim())
      ? c.inboundMediaDir.trim()
      : join(
          process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh'),
          'telegram-inbound',
        );

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
  // Forgets the per-chat "already notified" flag so a fresh /autopilot cycle
  // posts its one auto-approval notice again. Null when approval is disabled.
  let approvalClearNotice = null;
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

  // The id of the FIRST bot with a client — `client` is that bot's client
  // (legacy single-bot closures keep pointing here). For the legacy config it
  // is 'default'. Per-bot message routing uses this as the "main" bot id.
  let firstBotId = null;

  // Initialize clients (v0.5.x multi-bot loop). For each bot in the
  // normalized `bots` list: resolve its token (plain > env[envKey] >
  // credential[credentialKey]), and, ONLY when a token resolves, build a
  // TelegramClient + register it in botRegistry. A bot whose token resolves
  // to EMPTY (no plain token, no env var, no credential) is SKIPPED with a
  // warn log — it never throws. When ALL bots are skipped the plugin runs in
  // tools-only mode (tools still register; their `!client` guards throw a
  // helpful error when called). This preserves the legacy "missing token
  // degrades to tools-only" semantics exactly.
  for (const botCfg of bots) {
    // Per-bot token resolution: plain token > process.env[envKey] >
    // credential[credentialKey]. (resolveBotToken handles the env+plain
    // levels; the credential key is honored separately so each bot can use
    // a distinct credential entry.)
    const resolvedToken = (async () => {
      const fromEnv = await resolveBotToken(botCfg.token, ctx, botCfg.envKey);
      if (fromEnv) return fromEnv;
      // Plain+env both empty -> try this bot's credential key (only when it
      // differs from the env key, else resolveBotToken already tried it).
      const credKey = botCfg.credentialKey || botCfg.envKey || 'TELEGRAM_BOT_TOKEN';
      if (credKey === (botCfg.envKey || 'TELEGRAM_BOT_TOKEN')) return '';
      for (const svc of [ctx.credentials, ctx.get?.('credentials')]) {
        if (!svc || typeof svc.resolve !== 'function') continue;
        try {
          const value = isUsableCredential(await svc.resolve(credKey));
          if (value) return value;
        } catch {
          // source not configured or unreadable; continue
        }
      }
      return '';
    })();
    const token = await resolvedToken;
    if (!token) {
      log('warn', `bot "${botCfg.id}" has no token (config/env/credential all empty) — skipping; plugin runs tools-only for this bot.`);
      // Register the entry WITHOUT a client so meFor()/clientFor() can report
      // a precise "skipped" error, and the unload loop sees a consistent entry.
      botRegistry.set(botCfg.id, { id: botCfg.id, cfg: botCfg, client: null, poller: null, me: null });
      continue;
    }
    const base = botCfg.baseUrl || baseUrl || undefined;
    const aChats = Array.isArray(botCfg.allowedChats) ? botCfg.allowedChats : allowedChats;
    const aUsers = Array.isArray(botCfg.allowedUsers) ? botCfg.allowedUsers : allowedUsers;
    const mention = botCfg.requireMention !== undefined ? botCfg.requireMention : requireMention;
    const lpt = Number(botCfg.longPollTimeout) > 0 ? Number(botCfg.longPollTimeout) : longPollTimeout;
    const entry = { id: botCfg.id, cfg: botCfg, client: null, poller: null, me: undefined };
    entry.client = new TelegramClient({
      botToken: token,
      baseUrl: base,
      allowedChats: aChats && aChats.length ? aChats : undefined,
      allowedUsers: aUsers && aUsers.length ? aUsers : undefined,
      requireMention: mention,
      longPollTimeout: lpt,
    });
    // Keep the legacy single-bot closures (client/allowedChats/defaultChatId/
    // ...) pointing at the FIRST bot with a client — tools + single-bot path
    // are behaviorally unchanged for the legacy config.
    if (!client) {
      client = entry.client;
      firstBotId = botCfg.id;
    }
    // Await getMe() here (not fire-and-forget): the polling block below needs
    // entry.me synchronously for per-bot requireMention / meFor() lookups.
    try {
      const me = await entry.client.getMe();
      entry.me = me;
      log('info', `Telegram bot "${botCfg.id}" initialized: @${me.username} (ID: ${me.id})`);
    } catch (err) {
      entry.me = null;
      log('error', `Failed to get bot info for "${botCfg.id}":`, err.message);
    }
    botRegistry.set(botCfg.id, entry);
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

  // Inbound voice (STT) config. sttEndpoint defaults to the Whisper proxy that
  // dsh-tool-audio's transcribe_audio already uses. Transcription only runs
  // when the file can be downloaded, so it is gated on forwardInboundMedia at
  // the call site.
  const sttEndpoint = (c.sttEndpoint || 'http://127.0.0.1:18068').replace(/\/+$/, '');
  const voiceTranscribe = c.voiceTranscribe !== false;
  const voiceTranscribeLanguage = (typeof c.voiceTranscribeLanguage === 'string' && c.voiceTranscribeLanguage.trim())
    ? c.voiceTranscribeLanguage.trim()
    : 'auto';
  const voiceTranscriptToAgent = c.voiceTranscriptToAgent !== false;

  /**
   * Transcribe a downloaded voice file via the local Whisper (OpenAI-compatible)
   * service. Mirrors dsh-tool-audio's transcribe_audio request body. Best-effort
   * callers: on any failure this resolves to '' (logged at the call site), so a
   * dead service can never break the reply/inject path. Returns the recognized
   * text (trimmed) or '' on failure/empty.
   */
  async function transcribeVoiceFile(localPath, language, timeoutMs = 120000) {
    try {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(readFileSync(localPath))], 'voice.ogg', { type: 'audio/ogg' }));
      form.append('model', 'whisper-1');
      form.append('response_format', 'json');
      if (language && language !== 'auto') form.append('language', language);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`STT timed out after ${timeoutMs}ms`)), timeoutMs);
      let res;
      try {
        res = await fetch(`${sttEndpoint}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: controller.signal });
      } finally { clearTimeout(timer); }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        log('warn', `Voice transcription failed (HTTP ${res.status}) from ${sttEndpoint}: ${body || res.statusText}`);
        return '';
      }
      const payload = await res.json().catch(() => ({}));
      const text = String(payload?.text ?? '').trim();
      if (!text) log('warn', 'Voice transcription returned empty text (silent or unsupported audio?)');
      return text;
    } catch (err) {
      log('warn', `Voice transcription error: ${err.message}`);
      return '';
    }
  }

  /**
   * Send a plain-text message (no markdown→HTML conversion) so arbitrary
   * recognized/quoted text cannot trip Telegram's entity parser. Returns the
   * list of sent message ids (or [] on failure — callers treat as best-effort).
   */
  async function sendPlainText(botId, chatId, text, opts = {}) {
    const tgClient = clientFor(botId);
    if (!text) return [];
    const sent = [];
    for (const chunk of chunkText(text, maxMessageLength)) {
      const body = {
        chatId,
        text: chunk,
        parseMode: undefined,
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        disableNotification: opts.disableNotification,
      };
      // Single retry on transient failure (this is best-effort UI, not the
      // critical agent-reply path — keep it light).
      let result;
      for (let attempt = 1; ; attempt++) {
        try { result = await tgClient.sendMessage(body); break; }
        catch (err) {
          if (attempt >= 2 || !isTransientTelegramError(err)) {
            log('warn', `sendPlainText to chat ${chatId} failed: ${err.message}`);
            return sent;
          }
          const delayMs = err instanceof TelegramRateLimitError ? err.retryAfter * 1000 : 1000;
          await sleep(delayMs);
        }
      }
      // Only the first chunk is threaded as a reply; keep the rest plain.
      body.replyToMessageId = undefined;
      sent.push(result.messageId);
    }
    return sent;
  }

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
  //
  // `botId` (v0.5.x P2): selects the Telegram client to deliver on via
  // clientFor(). The legacy single-bot config uses botId 'default', whose
  // client is the first (only) bot — behavior unchanged. Tools that carry no
  // per-bot context pass 'default' (the tool-level default bot).
  async function sendText(botId, chatId, rawText, opts) {
    const tgClient = clientFor(botId);
    // opts.plain: send with NO parse_mode (verbatim text). Used by the
    // subagent board whose lines may contain raw `<`/`>` from tool args —
    // sending as plain avoids Telegram "bad entities" errors.
    const pMode = opts.plain ? undefined : (opts.parseMode || (opts.html ? 'HTML' : parseMode));
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
          result = await tgClient.sendMessage(body);
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
  async function watchDirectReply(agent, botId, chatId, telegramMessageId) {
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
        // Surface a turn failure (provider error, etc.) instead of staying
        // silent — a silent drop is exactly what made the schema-400 bug
        // invisible on the phone.
        const notified = await notifyTurnFailure(agent, botId, chatId, baseline, { replyToMessageId: telegramMessageId });
        if (!notified) {
          log('warn', `Direct mode: no forwardable reply for chat ${chatId} (${gaveUpIdle ? 'agent idle without a fresh assistant message' : 'hit directReplyTimeoutSec cap'})`);
          try {
            await sendText(botId, String(chatId), `⚠️ 本次没有生成回复（${gaveUpIdle ? 'agent 空闲但无新回复' : '等待超时'}）。可重试，或到 Web 端查看。`, { replyToMessageId: telegramMessageId });
          } catch (e) { log('error', 'Failed to send no-reply notice:', e.message); }
        }
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
      await sendText(botId, String(chatId), prefixed, { replyToMessageId: telegramMessageId });
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

  // Find the most recent turn/end at/after `baseline` and return its error
  // object ({ message, code }) when the turn ended with reason.kind === 'error',
  // else null. Used to surface provider/turn failures to the phone instead of
  // dropping them silently.
  function findTurnError(events, baseline) {
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= baseline; i--) {
      const evt = events[i];
      if (evt?.type !== 'turn/end') continue;
      const reason = evt.data && evt.data.reason;
      return reason && reason.kind === 'error' ? (reason.error || null) : null;
    }
    return null;
  }

  // Send a concise "turn failed" notice to a Telegram chat. Best-effort: returns
  // true when a notice was sent, false otherwise (no turn error found / send failed).
  async function notifyTurnFailure(agent, botId, chatId, baseline, opts = {}) {
    try {
      const err = findTurnError(agent?.session?.events, baseline);
      if (!err) return false;
      const brief = String(err.message || err.code || 'unknown error').replace(/\s+/g, ' ').slice(0, 400);
      const codeLine = err.code ? `\n<code>${escapeHtml(err.code)}</code>` : '';
      log('error', `Turn ended with error for chat ${chatId}: ${err.message || err.code}`);
      await sendText(botId, String(chatId), `⚠️ 处理失败，未生成回复。${codeLine}\n${escapeHtml(brief)}`, {
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
      });
      return true;
    } catch (e) {
      log('error', 'Failed to send turn-failure notice:', e.message);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Streaming reply finalize (方案B). Called by the ProgressIndicator at
  // turn/end when it is in streaming mode. The indicator has been showing the
  // reply building in place (placeholder edited as text-delta arrives); here we
  // FINALIZE that same message:
  //   • if the HTML render fits in ONE Telegram message (≤ 4096 chars after
  //     conversion) → edit the placeholder in place to the rendered reply;
  //   • otherwise (too long, or the edit failed) → delete the placeholder and
  //     send the reply as normal (fence-aware chunked) messages.
  // Returns true when the placeholder's fate is fully handled (edit-in-place or
  // delete+resend) so the indicator does not double-delete it; false when it did
  // nothing useful (empty reply / no placeholder / send failed) so the indicator
  // cleans the placeholder up.
  // -----------------------------------------------------------------------
  async function finalizeStreamingReply(botId, chatId, rawText, opts = {}) {
    const tgClient = clientFor(botId);
    const { placeholderMessageId, messageThreadId } = opts;
    const prefixed = replyPrefix ? `${replyPrefix}\n${rawText}` : rawText;
    if (!prefixed.trim()) return false;

    // Preferred: edit the placeholder in place with an HTML render, but only
    // when the converted text fits in a single message (guardConvertedLength
    // reports useParseMode:false when the HTML would exceed the 4096 limit).
    if (placeholderMessageId) {
      const guarded = guardConvertedLength(prefixed, markdownToTelegramHtml(prefixed), 4096);
      if (guarded.useParseMode) {
        try {
          const ok = await tgClient.editMessageText(chatId, placeholderMessageId, guarded.text, 'HTML');
          if (ok) {
            log('info', `Streaming reply finalized in place for chat ${chatId}`);
            return true;
          }
        } catch (err) {
          log('warn', `Streaming finalize: in-place edit failed (${err.message}); falling back to send`);
        }
      }
      // Overflow / edit failure: remove the placeholder so it doesn't linger.
      try { await tgClient.deleteMessage(chatId, placeholderMessageId); } catch { /* ignore */ }
    }

    // Fallback: normal (chunked) delivery, replying into the same thread.
    try {
      await sendText(botId, String(chatId), prefixed, { messageThreadId });
      log('info', `Streaming reply sent (chunked) for chat ${chatId}`);
      return true;
    } catch (err) {
      log('error', 'Streaming finalize send failed:', err.message);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Inbound media download + forward (parity with QwenPaw). When the user
  // sends a photo/document/video/audio/voice we:
  //   1. download it to `inboundMediaDir` (uuid-named), and
  //   2. tell the agent the LOCAL PATH so it can read it with its file tools
  //      (bash/read/glob), plus any caption.
  // For photos we MAY ALSO attach a vision content block so a multimodal model
  // can "see" it — but only when `inboundImageToModel` is true (default false:
  // a text-only model would throw UNSUPPORTED_CONTENT on an image block and
  // break the whole turn). If the attachments service is missing or saveImage
  // fails (wrong media type / model policy), we degrade to path-only and log.
  // -----------------------------------------------------------------------
  function inboundMediaKind(message) {
    return message.photo ? 'photo'
      : message.document ? 'document'
      : message.video ? 'video'
      : message.audio ? 'audio'
      : message.voice ? 'voice'
      : 'media';
  }

  /** Pick the downloadable file_id for an inbound media message (or null). */
  function inboundMediaFileId(message) {
    if (message.photo && message.photo.length) {
      // Photos come as several sizes; take the LARGEST (most detail).
      const largest = message.photo.reduce((a, b) =>
        ((a.width * a.height) >= (b.width * b.height) ? a : b));
      return largest.fileId || null;
    }
    const m = message.document || message.video || message.audio || message.voice;
    return (m && m.file_id) ? m.file_id : null;
  }

  /**
   * Download an inbound media message and build a note (+ optional vision
   * block) describing it for the agent. Always returns { note, imageBlock }.
   * Best-effort: never throws — a download failure becomes a descriptive note.
   */
  async function downloadAndDescribeInboundMedia(botId, message) {
    const tgClient = clientFor(botId);
    const kind = inboundMediaKind(message);
    const fileId = inboundMediaFileId(message);
    if (!fileId) {
      return { note: `(the user sent a ${kind} with no downloadable file)`, imageBlock: null, localPath: null };
    }
    let dl;
    try {
      dl = await tgClient.downloadFile(fileId, inboundMediaDir);
    } catch (err) {
      log('warn', `Inbound ${kind} download failed: ${err.message}`);
      return { note: `(the user sent a ${kind} but it could not be downloaded: ${err.message})`, imageBlock: null, localPath: null };
    }

    // Human/agent-facing description.
    let dims = '';
    if (message.photo && message.photo.length) {
      const p = message.photo.reduce((a, b) =>
        ((a.width * a.height) >= (b.width * b.height) ? a : b));
      if (p.width && p.height) dims = ` (${p.width}×${p.height})`;
    }
    const raw = message.document || message.video || message.audio || message.voice;
    let meta = '';
    if (raw && raw.file_name) meta += ` “${raw.file_name}”`;
    if (raw && typeof raw.file_size === 'number') meta += ` ${Math.round(raw.file_size / 1024)} KB`;
    if (raw && typeof raw.duration === 'number') meta += ` ${raw.duration}s`;

    const note =
      `The user sent a ${kind}${dims}${meta}. ` +
      `It has been saved locally to: ${dl.localPath} — you can read/process it with your file tools.` +
      (message.text ? ` Their caption: “${message.text}”` : '');

    // Optional vision block (photos only, and only when explicitly enabled).
    // The declared media type must match the ACTUAL bytes (saveImage validates
    // by decoding), so we sniff the magic bytes rather than assume jpeg.
    let imageBlock = null;
    if (kind === 'photo' && inboundImageToModel) {
      const svc =
        (ctx.attachments && typeof ctx.attachments.saveImage === 'function')
          ? ctx.attachments
          : (ctx.get ? ctx.get('attachments') : undefined);
      if (!svc || typeof svc.saveImage !== 'function') {
        log('warn', 'Inbound photo: attachments service unavailable; forwarding path only.');
      } else {
        try {
          const bytes = new Uint8Array(readFileSync(dl.localPath));
          const mediaType = sniffImageMediaType(bytes);
          if (!mediaType) {
            log('warn', 'Inbound photo: bytes are not a supported raster (png/jpeg/webp/gif); forwarding path only.');
          } else {
            const ref = await svc.saveImage({ data: bytes, mediaType, name: dl.fileName });
            imageBlock = { type: 'image', attachment: ref };
            log('info', `Inbound photo attached as vision block (${ref.mediaType}, ${ref.bytes} bytes).`);
          }
        } catch (err) {
          log('warn', `Inbound photo: saveImage failed (${err.code || err.message}); forwarding path only.`);
        }
      }
    }
    return { note, imageBlock, localPath: dl.localPath };
  }

  // -----------------------------------------------------------------------
  // Per-bot client dispatch (v0.5.x P2/P3). The approval + ask_user_question
  // modules are pure factories that hold ONE client object (their `client`
  // dep) — we keep that contract (so their unit tests keep passing) but make
  // that object dispatch to the CORRECT bot client by resolving the owning
  // bot from the (now composite-keyed) chatAgents map.
  //
  // Resolution order for each call: (a) explicit `botId` in the args, else
  // (b) a `chatId` in the args (sendMessage({chatId}) / editMessageText
  // (chatId, ...) / pin/unpin/sendChatAction), else (c) the active-card bot
  // context (set by the index's onCallbackQuery wrapper before calling the
  // module's handleCallbackQuery — needed for answerCallbackQuery(qid, toast),
  // which carries no chatId), else (d) 'default'.
  // -----------------------------------------------------------------------
  // The bot id that owns a given chatId (the part of the composite key
  // k(botId, chatId) before '::'); 'default' when no (bot, chat) route exists.
  function botIdForChat(chatId) {
    const cid = String(chatId ?? '');
    for (const key of chatAgents.keys()) {
      const bi = key.indexOf('::');
      if (bi >= 0 && key.slice(bi + 2) === cid) return key.slice(0, bi);
    }
    return 'default';
  }
  // (activeCardBotId is declared earlier in apply(), above the approval store,
  // so the store's per-bot defaultChatId resolver can read it.)
  // Set the active-card bot context. Called by the index onCallbackQuery
  // wrapper (botId known there) before invoking the module handlers.
  const setActiveCardBotId = (b) => { activeCardBotId = b || 'default'; };
  // Client-shaped object handed to the approval/question modules as their
  // `client`/`activeClient` dep. Every method dispatch to the correct bot
  // client per the resolution order above. For the legacy single-bot config
  // every call resolves to the default bot — identical to the old single
  // client object, so the modules' plain-client unit tests keep passing.
  const clientDispatch = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        let bid = null;
        for (const a of args) {
          if (a && typeof a === 'object' && !Array.isArray(a)) {
            if (a.botId != null) bid = String(a.botId);
            else if (a.chatId != null && !bid) bid = botIdForChat(a.chatId);
          }
        }
        // Positional args: first string/number that is a chatId (edit/pin/
        // unpin/sendChatAction all lead with chatId).
        if (!bid) {
          for (const a of args) {
            if (typeof a === 'string' || typeof a === 'number') { bid = botIdForChat(a); break; }
          }
        }
        return clientFor(bid || activeCardBotId || 'default')[prop](...args);
      };
    },
  });

  // -----------------------------------------------------------------------
  // Progress indicator wiring (module-scope class + helpers above). A chat has
  // at most one indicator at a time — the plugin routes each chat to a single
  // active agent, so we key by chatId.
  // (activeIndicators is module-scope, P6: exported + cleared per apply().)
  // -----------------------------------------------------------------------

  function startProgressForAgent(agent, botId, chatId, baseline, threadId) {
    if (!progressEnabled) return;
    const chatKey = k(botId, chatId);
    const prev = activeIndicators.get(chatKey);
    if (prev) {
      // A previous turn's indicator is still alive (e.g. user re-sent while
      // busy) — stop it before starting a fresh one for this turn.
      void prev.stop();
    }
    // Streaming reply (方案B): only in 'direct' mode (where the plugin owns
    // delivery) and when enabled. In 'tool' mode the agent sends via
    // telegram_send_message itself, so the indicator must NOT also send the
    // reply.
    const streaming = streamingReplyEnabled && agentResponseMode === 'direct';
    const ind = new ProgressIndicator({
      chatId,
      threadId,
      agent,
      baseline,
      startedAt: Date.now(),
      client: clientFor(botId),
      log,
      delayMs: progressDelayMs,
      tickMs: progressTickMs,
      intervalMs: progressIntervalMs,
      perBlockChars: progressPerBlockChars,
      maxChars: progressMaxChars,
      timeoutMs: progressTimeoutMs,
      streaming,
      onFinalReply: streaming ? (cid, text, o) => finalizeStreamingReply(botId, cid, text, o) : undefined,
      onTurnError: streaming ? (cid, o) => notifyTurnFailure(agent, botId, cid, baseline, { messageThreadId: o.messageThreadId }) : undefined,
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
Markdown in the text will be converted to Telegram HTML format automatically (when parse_mode is HTML, the default).

With multiple bots configured, pass the "bot" parameter to choose which bot sends (default: the bot that owns the chat, or the default/first bot).`,

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (numeric or @username). Falls back to config defaultChatId if empty.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this message (a bot id). Default: the bot that owns the chat, or the default/first bot when there is only one.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required and no defaultChatId is configured.');
      }
      const { botId, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;

      const text = args.text || '';
      // v0.5.x P4: explicit `bot` wins; else the bot that OWNS this chat
      // (composite-key lookup); 'default' for a legacy single-bot config.
      const sent = await sendText(botId, chatId, text, {
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
    description: 'Send a photo to a Telegram chat. The photo parameter can be a Telegram file_id (previously uploaded), a public URL, or an absolute local file path (uploaded via multipart). With multiple bots configured, pass `bot` to choose which bot sends.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this photo (a bot id). Default: the bot that owns the chat, or the default/first bot.',
      },
      photo: {
        type: 'string',
        required: true,
        description: 'Telegram file_id, public URL, or absolute local file path of the photo.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }
      const { client: sendClient, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;

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

      const result = await sendClient.sendPhoto({
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
    description: 'Send a document (file) to a Telegram chat. The document parameter can be a Telegram file_id or a public URL. With multiple bots configured, pass `bot` to choose which bot sends.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this document (a bot id). Default: the bot that owns the chat, or the default/first bot.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }
      const { client: sendClient, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;

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

      const result = await sendClient.sendDocument({
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
  // Tool: telegram_send_video
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_video',
    description: 'Send a video to a Telegram chat. The video parameter can be a Telegram file_id (previously uploaded) or a public URL. With multiple bots configured, pass `bot` to choose which bot sends.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this video (a bot id). Default: the bot that owns the chat, or the default/first bot.',
      },
      video: {
        type: 'string',
        required: true,
        description: 'Telegram file_id or public URL of the video.',
      },
      caption: {
        type: 'string',
        description: 'Optional video caption.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }
      const { client: sendClient, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;

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

      const result = await sendClient.sendVideo({
        chatId,
        video: args.video,
        caption,
        parseMode: captionParseMode,
        messageThreadId: args.message_thread_id,
        signal: exec?.signal,
      });

      return `Video sent successfully (message_id: ${result.messageId})`;
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_send_audio
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_send_audio',
    description: 'Send an audio file (music, podcast, etc.) to a Telegram chat. The audio parameter can be a Telegram file_id, a public URL, or an absolute local file path (uploaded via multipart). With multiple bots configured, pass `bot` to choose which bot sends.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this audio (a bot id). Default: the bot that owns the chat, or the default/first bot.',
      },
      audio: {
        type: 'string',
        required: true,
        description: 'Telegram file_id, public URL, or absolute local file path of the audio file.',
      },
      caption: {
        type: 'string',
        description: 'Optional audio caption.',
      },
      track_title: {
        type: 'string',
        description: 'Optional track title.',
      },
      performer: {
        type: 'string',
        description: 'Optional performer name.',
      },
      duration: {
        type: 'integer',
        description: 'Optional duration in seconds.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }
      const { client: sendClient, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;

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

      const result = await sendClient.sendAudio({
        chatId,
        audio: args.audio,
        caption,
        parseMode: captionParseMode,
        title: args.track_title,
        performer: args.performer,
        duration: args.duration,
        messageThreadId: args.message_thread_id,
        signal: exec?.signal,
      });

      return `Audio sent successfully (message_id: ${result.messageId})`;
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
      'via the local Qwen3-TTS service and sent as an OGG Opus voice note. '
      + 'Use this when the user is chatting on TELEGRAM (their message carries a '
      + '"This message comes from Telegram" note) and asks to hear a reply / 语音播报: '
      + 'it delivers the voice straight to the user there. Do NOT use it for the Web GUI: '
      + 'there, use text_to_speech instead so the Web can render an inline audio card.',

    parameters: {
      chat_id: {
        type: 'string',
        description: 'Target Telegram chat ID. Defaults to the configured default chat.',
      },
      bot: {
        type: 'string',
        description: 'Which bot sends this voice message (a bot id). Default: the bot that owns the chat, or the default/first bot.',
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
      const chatId = args.chat_id || defaultChatId;
      if (!chatId) {
        throw new Error('chat_id is required.');
      }
      const { client: sendClient, error } = resolveBotClient(args.bot, chatId);
      if (error) return error;
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
        const result = await sendClient.sendVoiceFile({
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
    description: 'Edit an existing Telegram message. The bot can only edit its own messages. With multiple bots configured, pass `bot` to choose which bot edits.',

    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Chat ID where the message is.',
      },
      bot: {
        type: 'string',
        description: 'Which bot performs the edit (a bot id). Default: the bot that owns the chat, or the default/first bot.',
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
      const { client: sendClient, error } = resolveBotClient(args.bot, args.chat_id);
      if (error) return error;

      let text;
      let pMode = args.parse_mode || parseMode;
      if (pMode === 'HTML') {
        const guarded = guardConvertedLength(args.text, markdownToTelegramHtml(args.text), 4096);
        text = guarded.text;
        if (!guarded.useParseMode) pMode = undefined;
      } else {
        text = args.text;
      }

      const success = await sendClient.editMessageText(args.chat_id, args.message_id, text, pMode, exec?.signal);
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
    description: 'Delete a Telegram message. The bot can delete its own messages and, if it has admin rights, other messages too. With multiple bots configured, pass `bot` to choose which bot deletes.',

    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Chat ID where the message is.',
      },
      bot: {
        type: 'string',
        description: 'Which bot performs the delete (a bot id). Default: the bot that owns the chat, or the default/first bot.',
      },
      message_id: {
        type: 'integer',
        required: true,
        description: 'Message ID to delete.',
      },
    },

    async execute(args, exec) {
      const { client: sendClient, error } = resolveBotClient(args.bot, args.chat_id);
      if (error) return error;
      const success = await sendClient.deleteMessage(args.chat_id, args.message_id, exec?.signal);
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
    description: 'Get information about the configured Telegram bot(s) — a list, one entry per bot. Each entry: id (bot id from config, e.g. "default"), username (from getMe), botId (numeric Telegram user id from getMe), connected (has a live client), name, defaultChat.',

    parameters: {},

    // v0.5.x P4: multi-bot — return ONE entry per registered bot (the registry
    // is the single source of truth). A legacy single-bot config yields exactly
    // one entry (id "default"), so single-bot callers still see one item. The
    // host renders a non-string return as indented JSON, so returning a plain
    // array is the intended contract (no JSON string round-trip).
    async execute() {
      const entries = [...botRegistry.values()];
      if (entries.length === 0) {
        throw new Error('No Telegram bot is configured. Set botToken in plugin config, TELEGRAM_BOT_TOKEN environment variable, or the DSH credentials service.');
      }
      return entries.map((entry) => {
        const me = entry.me;
        return {
          id: entry.id,
          username: me?.username ?? null,
          botId: me ? Number(me.id) : null,
          name: me?.firstName ?? null,
          connected: Boolean(entry.client),
          defaultChat: String(entry.cfg?.defaultChatId || defaultChatId || ''),
        };
      });
    },
  });

  // -----------------------------------------------------------------------
  // Tool: telegram_get_updates (manual poll)
  // -----------------------------------------------------------------------

  registerTool({
    name: 'telegram_get_updates',
    description: 'Manually poll for new Telegram updates. Useful for checking recent messages without enabling continuous polling. NOTE: if the background poller is enabled, calling this tool will intermittently return a 409 conflict (Telegram only allows one active getUpdates consumer per bot).',

    parameters: {
      bot: {
        type: 'string',
        description: 'Which bot to poll (a bot id). Default: the default/first bot. Each bot keeps its OWN manual offset, so polling one bot does not affect another.',
      },
      offset: {
        type: 'integer',
        description: 'Offset to start from (update_id). Skips already processed updates. When omitted, this bot\'s last manual-poll offset is used (independent per bot).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of updates to fetch.',
      },
    },

    async execute(args, exec) {
      // v0.5.x P4: resolve the target bot (explicit `bot` wins, else the
      // default/first bot). Each bot keeps its OWN manual poll offset so a
      // manual poll on one bot never advances another bot's stream.
      const botId = (args.bot !== undefined && args.bot !== null && String(args.bot) !== '')
        ? String(args.bot)
        : (botIdForChat(defaultChatId) || 'default');
      const entry = botRegistry.get(botId);
      if (!entry) {
        const known = [...botRegistry.keys()].join(', ') || '(none)';
        return `Unknown bot id "${botId}". Known bots: ${known}.`;
      }
      if (!entry.client) {
        return `Bot "${botId}" is not connected (no token configured).`;
      }
      const pollClient = entry.client;

      // Per-bot manual offset: an explicit arg wins; otherwise the offset this
      // bot already consumed in a prior manual poll; otherwise 0 (all avail.).
      const explicitOffset = (args.offset !== undefined && args.offset !== null) ? Number(args.offset) : undefined;
      const offset = explicitOffset !== undefined ? explicitOffset : (updatesOffsetByBot.get(botId) ?? 0);
      const limit = args.limit || 20;
      let updates;
      try {
        updates = await pollClient.getUpdates(offset, limit, 5, exec?.signal);
      } catch (err) {
        const text = String(err?.message || '') + ' ' + String(err?.details || '');
        if (/409/i.test(text) || /conflict/i.test(text) || /terminated by other/i.test(text)) {
          throw new Error(`getUpdates conflict (409) on bot "${botId}": another poller is already consuming this bot. Stop the background poller (pollingEnabled: false) or wait for it to finish before using this tool.`);
        }
        throw err;
      }

      // Advance this bot's manual offset past the highest update_id read.
      if (updates.length > 0) {
        const maxId = Math.max(...updates.map((u) => Number(u.updateId) || 0));
        updatesOffsetByBot.set(botId, maxId + 1);
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

  // Per-chat active agent routing (Plan A) + owned agent handles.
  //   chatAgents: k(botId, chatId) -> root agent sessionId. Declared at
  //   function scope (not inside the `if (pollingEnabled && client)` block)
  //   so the module-scope dispatch helpers (botIdForChat / clientDispatch,
  //   which resolve the owning bot from this map) can see it even before the
  //   poll block runs.
  //   ownedHandles: agent handles created by /new etc., kept alive so they are
  //   not disposed; cleaned up in the unload effect.
  const chatAgents = new Map(); // k(botId, chatId) -> agent sessionId (string)
  const ownedHandles = []; // AgentHandle[] kept so created agents are not disposed

  if (pollingEnabled && client) {
    // Legacy closure binding: the FIRST bot with a client. For the legacy
    // single-bot config this is the only bot, so every closure below
    // (message handler, commands, approval, questions, progress) behaves
    // EXACTLY as before. Per-bot wiring of callbacks/sendText is S2's work.
    const activeClient = client;
    let activePoller = null;
    activePoller = new TelegramPoller(activeClient, {
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
    // (chatAgents / ownedHandles are declared at function scope above.)

    async function createTelegramAgent(botId, chatId) {
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
          // v0.5.x P2: which bot created this agent. Lets rootAgentToChat()
          // resolve the per-bot defaultChat (and ownership) without hardcoding
          // the top-level default.
          botId,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        ...(agentOptions ? { agentOptions } : {}),
        ...(setup ? { setup } : {}),
      });
      ownedHandles.push(handle);
      return String(sessionId);
    }

    function resolveChatAgent(botId, chatId) {
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const activeId = chatAgents.get(k(botId, chatId));
      if (activeId) {
        const hit = all.find((a) => String(a?.session?.id) === activeId);
        if (hit) return hit;
        // The active agent disappeared (disposed); fall through to first agent.
      }
      return all[0] ?? null;
    }

    // ---------------------------------------------------------------------
    // Live subagent board (see src/subagents.js). While a chat's agent spawns
    // subagents, keep ONE pinned message per chat showing each subagent live
    // (task + status on line 1, what it is doing on line 2). Rows lock when the
    // subagent ends. Best-effort: a Telegram hiccup must never block the agent.
    //
    //   • `subagent/start` / `subagent/end` events (global listener, so the
    //     parent-scope filter is bypassed) give exact lifecycle edges.
    //   • A ticker re-reads live child sessions (agents.list()) for "what it is
    //     doing now" and, as a fallback, drives start/lock by presence when the
    //     event bus never delivers (e.g. a host without the listener seam).
    //
    // `chatAgents` (defined above in this same block) is the per-chat routing
    // map (chatId -> root agent session id); it is in scope via closure, so the
    // board helpers read it directly.
    // ---------------------------------------------------------------------
    // v0.5.x P2: keyed by k(botId, chatId) — one board per (bot, chat).
    // (subagentBoards is module-scope, P6: exported + cleared per apply().)

    // Map each root (non-subagent) agent session id to the chat that owns it:
    // the chat routed to it via chatAgents, else the default chat for the
    // first (default) agent, else null.
    // v0.5.x P2: root sid -> { chatId, botId } (the (bot, chat) that owns the
    // root agent) or null. The composite key `k(botId, chatId)` carries BOTH
    // the chat and the owning bot, so we can resolve both without hardcoding
    // the top-level default. Fallback (agent not routed in chatAgents): the
    // per-bot default chat from the agent's own meta.botId config — for the
    // legacy single-bot config that is the top-level defaultChatId (unchanged).
    function rootAgentToChat() {
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const map = new Map(); // root sid -> { chatId, botId } | null
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        const sid = a?.session?.id != null ? String(a.session.id) : (a?.id != null ? String(a.id) : null);
        if (!sid || a?.session?.header?.origin === 'subagent') continue;
        let owner = null;
        for (const [key, routed] of chatAgents) {
          if (String(routed) === sid) {
            const bi = key.indexOf('::');
            owner = { chatId: bi >= 0 ? key.slice(bi + 2) : key, botId: bi >= 0 ? key.slice(0, bi) : 'default' };
            break;
          }
        }
        if (!owner) {
          const agentBotId = a?.meta?.botId || (i === 0 ? 'default' : null);
          const agentCfg = agentBotId ? botRegistry.get(agentBotId)?.cfg : null;
          if (agentCfg?.defaultChatId) {
            owner = { chatId: String(agentCfg.defaultChatId), botId: agentBotId || 'default' };
          } else if (i === 0 && defaultChatId) {
            owner = { chatId: String(defaultChatId), botId: 'default' };
          }
        }
        map.set(sid, owner);
      }
      return map;
    }

    // The agent a chat routes to (its active one, else the default/first).
    function chatAgentOf(botId, chatId) {
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const activeId = chatAgents.get(k(botId, chatId));
      if (activeId) {
        const hit = all.find((a) => String(a?.session?.id ?? a?.id) === activeId);
        if (hit) return hit;
      }
      return all[0] ?? null;
    }

    // Route a child (subagent) session back to the chat that owns it, by
    // following header.parentSession to a root agent and looking up that root
    // in the chat map. Returns chatId or null.
    // v0.5.x P2: resolve the (botId, chatId) that owns a child session by
    // following header.parentSession up to a root agent and looking that root
    // up in rootAgentToChat(). Returns { chatId, botId } or null.
    function ownerOfChildSession(childSession) {
      if (!childSession) return null;
      const root = rootAgentToChat();
      let cur = childSession;
      const seen = new Set();
      while (cur && seen.size < 64) {
        const sid = cur?.id != null ? String(cur.id) : null;
        if (sid && seen.has(sid)) return null;
        if (sid) seen.add(sid);
        const owner = root.get(sid);
        if (owner) return owner; // { chatId, botId }
        const parentId = cur?.header?.parentSession;
        if (parentId == null) {
          // Reached a root session that has no chat owner.
          return null;
        }
        const agentsSvc = ctx.get?.('agents');
        const all = agentsSvc?.list?.() ?? [];
        const parent = all.find((a) => String(a?.session?.id ?? a?.id) === String(parentId));
        cur = parent?.session;
      }
      return null;
    }

    // True when a child belongs to this (bot, chat). Direct child = the parent
    // is one of this chat's root agents; otherwise (descendants enabled) the
    // parent chain resolves up to one of them.
    function childBelongsToChat(childSession, botId, chatId) {
      if (!childSession || childSession.header?.origin !== 'subagent') return false;
      const chatRoots = new Set();
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const activeId = chatAgents.get(k(botId, chatId));
      if (activeId) chatRoots.add(activeId);
      if (all[0] && all[0].session?.id != null) chatRoots.add(String(all[0].session.id));
      const targetRoot = (sid) => chatRoots.has(String(sid));
      // Direct child: its immediate parent is a root of this chat.
      if (childSession.header.parentSession != null && targetRoot(childSession.header.parentSession)) {
        return true;
      }
      if (!subagentBoardIncludeDescendants) return false;
      // Descendant: walk up to a root of this chat.
      let cur = childSession;
      const seen = new Set();
      while (cur && seen.size < 64) {
        const sid = cur?.id != null ? String(cur.id) : null;
        if (sid && seen.has(sid)) return false;
        if (sid) seen.add(sid);
        const parentId = cur?.header?.parentSession;
        if (parentId == null) return targetRoot(sid);
        if (targetRoot(parentId)) return true;
        const parent = all.find((a) => String(a?.session?.id ?? a?.id) === String(parentId));
        cur = parent?.session;
      }
      return false;
    }

    // v0.5.x P2: one board per (bot, chat). The composite key k(botId, chatId)
    // keeps boards for the same chatId under different bots separate, and the
    // board's send/edit/pin bindings use the OWNING bot's client (not the
    // first bot). board.chatId stores the raw chatId; the (bot, chat) identity
    // lives in the map key.
    function boardForChat(botId, chatId) {
      const key = k(botId, chatId);
      const cid = String(chatId);
      let b = subagentBoards.get(key);
      if (!b) {
        const bClient = clientFor(botId);
        b = new SubagentBoard({
          chatId: cid,
          pinEnabled: subagentBoardPin,
          maxRows: subagentBoardMaxRows,
          sendText: (text, opts) => sendText(botId, cid, text, { ...opts, plain: true }),
          editText: (messageId, text) => bClient.editMessageText(cid, messageId, text, undefined),
          pin: (messageId) => bClient.pinChatMessage(cid, messageId),
          unpin: (messageId) => bClient.unpinChatMessage(cid, messageId),
          listAgents: () => (ctx.get?.('agents')?.list?.() ?? []),
          log: (level, ...args) => log(level, ...args),
        });
        subagentBoards.set(key, b);
      }
      return b;
    }

    let subagentBoardTicker = null;

    // Ensure a live subagent child is represented on its board (idempotent) and
    // re-read its current work. Returns the board, or null when not ours.
    function ensureChildOnBoard(childSession, agent) {
      const sid = childSession?.id != null ? String(childSession.id)
        : (agent?.id != null ? String(agent.id) : null);
      if (!sid) return null;
      const owner = ownerOfChildSession(childSession);
      if (!owner || !childBelongsToChat(childSession, owner.botId, owner.chatId)) return null;
      const board = boardForChat(owner.botId, owner.chatId);
      if (!board.entries.has(sid)) board.onStart({ id: sid });
      // If the child is no longer running, lock it (presence-based end).
      const e = board.entries.get(sid);
      if (e && e.status === 'working' && agent?.status && agent.status !== 'running') {
        board.onEnd({ id: sid, stopReason: agent.status === 'error' ? 'error' : 'completed' });
      }
      return board;
    }

    // Polling fallback sweep: scan live agents for subagent children under our
    // chats and reconcile each board (start new, keep working, lock finished).
    function sweepSubagentsByPresence() {
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      for (const a of all) {
        const session = a?.session;
        if (!session || session.header?.origin !== 'subagent') continue;
        ensureChildOnBoard(session, a);
      }
    }

    function tickBoards() {
      try {
        // Presence sweep: idempotent backstop that (a) starts any child the
        // event bus missed and (b) feeds the per-entry grace lock. Always run —
        // cheap, and it keeps the board correct even when no event fired.
        sweepSubagentsByPresence();
        // Drive live refresh + throttled flush for every active board.
        // key = k(botId, chatId); board.chatId holds the raw chatId.
        for (const [key, board] of [...subagentBoards]) {
          board.prune(Date.now());
          if (board.isEmpty) { subagentBoards.delete(key); continue; }
          if (board.hasWorking) {
            const bi = key.indexOf('::');
            const boardBotId = bi >= 0 ? key.slice(0, bi) : 'default';
            const parentSession = chatAgentOf(boardBotId, board.chatId)?.session;
            board.refresh(parentSession);
          }
          void board.flush();
        }
      } catch (err) {
        log('warn', `subagent board tick failed: ${err.message}`);
      }
    }

    function ensureBoardTicker() {
      // Run the global board ticker whenever ANY bot has a client (the tick
      // loop is per-(bot,chat) via the composite key; `client` is the first
      // bot's client and is non-null iff at least one bot is up).
      if (!subagentBoardEnabled || !client || subagentBoardTicker) return;
      subagentBoardTicker = setInterval(() => tickBoards(), subagentBoardRefreshMs);
      try { if (typeof subagentBoardTicker.unref === 'function') subagentBoardTicker.unref(); } catch { /* ignore */ }
    }

    function stopBoardTicker() {
      if (subagentBoardTicker) {
        try { clearInterval(subagentBoardTicker); } catch { /* ignore */ }
        subagentBoardTicker = null;
      }
    }

    // Wire the lifecycle listeners (global, so the parent-scope filter is
    // bypassed). They give precise start/end edges; the presence sweep
    // (sweepSubagentsByPresence, every tick) is the always-on backstop that
    // keeps the board correct even if an edge event never reaches us.
    if (subagentBoardEnabled && client) {
      // Find the child in the live agents list (its session id === info.id).
      const findChild = (sid) => {
        const all = ctx.get?.('agents')?.list?.() ?? [];
        return all.find((a) => String(a?.session?.id ?? a?.id) === sid) ?? null;
      };
      // A (bot, chat) board that already tracks this child (by entry id).
      // key = k(botId, chatId).
      const boardTracking = (sid) => {
        for (const [key, board] of subagentBoards) {
          if (board.entries.has(sid)) {
            const bi = key.indexOf('::');
            return { botId: bi >= 0 ? key.slice(0, bi) : 'default', chatId: bi >= 0 ? key.slice(bi + 2) : key, board };
          }
        }
        return null;
      };
      const handleLifecycle = (phase) => (info) => {
        const sid = info?.id != null ? String(info.id) : null;
        if (!sid) return;
        const child = findChild(sid);
        const viaParent = child ? ownerOfChildSession(child.session) : null;
        const tracked = viaParent || boardTracking(sid) || null;
        if (phase === 'start' && !child) {
          // Child not (yet) in the live list: defer to the presence sweep, which
          // will start it on the right chat — avoid a phantom row on the default.
          return;
        }
        if (!tracked) return;
        const board = boardForChat(tracked.botId, tracked.chatId);
        if (phase === 'start') board.onStart(info);
        else board.onEnd(info);
        ensureBoardTicker();
        void board.flush(true);
      };
      try {
        ctx.on('subagent/start', handleLifecycle('start'), { global: true });
        ctx.on('subagent/end', handleLifecycle('end'), { global: true });
      } catch (err) {
        log('warn', `subagent board: could not subscribe to lifecycle events (${err.message}); falling back to polling`);
      }
      // Start the presence-sweep ticker now (idempotent): it is the backstop for
      // a host where the lifecycle events never reach us, and it also drives the
      // live refresh + throttled edits. Idle when no subagents are present.
      ensureBoardTicker();
    }

    // Tear down a (bot, chat) board (unpin + delete) — called on /new and unload.
    async function teardownBoardForChat(botId, chatId) {
      const key = k(botId, chatId);
      const board = subagentBoards.get(key);
      if (board) {
        subagentBoards.delete(key);
        try { await board.teardown(); } catch { /* best-effort */ }
      }
    }

    // Board lives only while polling is on, so its teardown is registered here
    // (the top-level unload effect below is out of scope for these bindings).
    // On unload: stop the ticker and unpin/delete every live board.
    // keys are composite k(botId, chatId); get/delete by the same key.
    ctx.effect(() => {
      return () => {
        stopBoardTicker();
        for (const key of [...subagentBoards.keys()]) {
          const b = subagentBoards.get(key);
          subagentBoards.delete(key);
          try { void b.teardown(); } catch { /* best-effort */ }
        }
      };
    });

    // ---------------------------------------------------------------------
    // Autopilot (v0.5.0) — per-chat fully-autonomous mode.
    //
    //   • Global permissions: while a chat is in autopilot, its agent's session
    //     gets a `sandbox/mode` override (full write) and the plugin's
    //     `approval/request` answerer auto-grants every ask for that agent.
    //     Sandbox ESCALATIONS also route through that answerer, so the agent
    //     never blocks on a permission prompt. Approval policy stays 'ask'
    //     ('never' would REJECT, not allow).
    //   • Auto-answer questions: the ask_user_question answerer auto-accepts the
    //     recommended option and posts a notice (see questions.js).
    //
    // State is in-memory (per chat) and restored on /autopilot off by re-appending
    // the previous sandbox/mode event. Only agents this plugin owns are affected
    // (ownership is checked by the approval/question answerers themselves).
    // ---------------------------------------------------------------------
    const autopilotChats = new Map(); // chatId (string) -> { on, prevSandbox, agentId, since }

    // Effective sandbox mode folded from a session's event log (last sandbox/mode
    // wins); undefined when the session never switched (the deployment default
    // applies). Mirrors dsh-sandbox-policy's effectiveSandboxMode so we can capture
    // the "previous" mode to restore later without importing that package.
    function effectiveSandboxModeOf(agent) {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'sandbox/mode') return events[i].data?.mode;
      }
      return undefined;
    }

    // Append the sandbox/mode override to the agent's session. Pure log append —
    // the same write path dsh-sandbox-policy exposes; takes effect on the session's
    // next confined (bash/fs) call.
    function setAgentSandboxMode(agent, mode) {
      try { agent?.session?.append?.('sandbox/mode', { mode }); } catch { /* ignore */ }
    }

    // v0.5.x P2: autopilotChats is keyed by k(botId, chatId). The module-facing
    // helpers (isAutopilotChat / autopilotStateFor) are called with a RAW chatId
    // (the approval/question modules only know the chatId, not the bot), so they
    // scan every (bot, chatId) key sharing that chatId. A chat is "in autopilot"
    // if ANY bot has it on. This is correct because the ownership() that feeds
    // them already resolved the chat from a specific agent.
    function autopilotStateFor(chatId) {
      const cid = String(chatId);
      for (const [key, state] of autopilotChats) {
        const bi = key.indexOf('::');
        const keyChat = bi >= 0 ? key.slice(bi + 2) : key;
        if (keyChat === cid && state?.on) return state;
      }
      return null;
    }

    function isAutopilotChat(chatId) {
      return !!autopilotStateFor(chatId);
    }

    // Enable autopilot for a (bot, chat) agent: capture the current sandbox mode,
    // then switch the agent to the configured full-write mode. Returns state entry.
    function enableAutopilot(botId, chatId, agent) {
      const key = k(botId, chatId);
      const prev = effectiveSandboxModeOf(agent);
      setAgentSandboxMode(agent, c.autopilotSandboxMode || 'danger-full-access');
      const state = {
        on: true,
        prevSandbox: prev, // undefined => deployment default (nothing to re-append)
        agentId: String(agent?.session?.id ?? agent?.id ?? ''),
        since: Date.now(),
      };
      autopilotChats.set(key, state);
      // Fresh cycle → allow exactly one autopilot approval notice this session
      // (later auto-grants stay silent; see approval.js).
      approvalClearNotice?.(chatId);
      return state;
    }

    // Disable autopilot for a (bot, chat): restore the captured sandbox mode (if
    // the deployment default was in force, re-append 'workspace-write' to drop any
    // override). Returns the prior state.
    function disableAutopilot(botId, chatId, agent) {
      const key = k(botId, chatId);
      const state = autopilotChats.get(key) ?? null;
      autopilotChats.delete(key);
      approvalClearNotice?.(chatId); // cleanup: no notice state lingers
      if (state?.on && agent) {
        const restore = state.prevSandbox ?? 'workspace-write';
        // Only re-append if the agent's current override differs, so we don't
        // spam a redundant event when it is already at the target mode.
        if (effectiveSandboxModeOf(agent) !== restore) setAgentSandboxMode(agent, restore);
      }
      return state;
    }

    // The `isAutopilot` dependency handed to the ask_user_question answerer.
    // Returns { chatId, threadId } when the question's session belongs to an
    // autopilot chat we own, else null (the normal wait-for-user flow runs).
    function autopilotOwnership(sessionId) {
      const all = ctx.get?.('agents')?.list?.() ?? [];
      const sidStr = String(sessionId ?? '');
      const hit = all.find((a) => String(a?.id) === sidStr || String(a?.session?.id) === sidStr);
      const hitSid = String(hit?.session?.id ?? sidStr ?? '');
      for (const [key, csid] of chatAgents) {
        if (String(csid) === hitSid) {
          const bi = key.indexOf('::');
          const chatPart = bi >= 0 ? key.slice(bi + 2) : key;
          if (isAutopilotChat(chatPart)) {
            return { chatId: chatPart, threadId: null };
          }
        }
      }
      if (defaultChatId && isAutopilotChat(defaultChatId)) {
        const defId = String(all[0]?.session?.id ?? '');
        if (defId && hitSid === defId) return { chatId: String(defaultChatId), threadId: null };
      }
      return null;
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

    async function handleCommands(botId, message) {
      // Returns true when the message was a command (already handled).
      const extracted = await extractCommand(message);
      if (!extracted) return false;
      const { cmd, args } = extracted;
      const chatId = String(message.chatId);
      const agentsSvc = ctx.get?.('agents');
      const all = agentsSvc?.list?.() ?? [];
      const active = resolveChatAgent(botId, chatId);
      // Command replies are plugin-authored Telegram HTML (tags preserved).
      const reply = (t) => sendText(botId, chatId, t, { replyToMessageId: message.messageId, html: true });

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
              '• /autopilot — 全自动模式：全局写权限+自动放行授权+自动采纳推荐方案（on|off|status；⚠️ 有安全隐患）',
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
            // Drop this chat's subagent board so stale rows from the old
            // session don't linger; a fresh board appears as the new session
            // spawns subagents.
            try { await teardownBoardForChat(botId, chatId); } catch { /* best-effort */ }
            const id = await createTelegramAgent(botId, chatId);
            chatAgents.set(k(botId, chatId), id);
            const short = id.length > 20 ? id.slice(0, 8) + '…' : id;
            await reply(`✅ 已开启新会话 <code>${short}</code>（完整 id 见 /sessions）。\n上下文已清空，后续消息路由到新会话。`);
            return true;
          }

          case '/sessions': {
            if (all.length === 0) { await reply('（当前没有活动会话）'); return true; }
            const activeId = chatAgents.get(k(botId, chatId));
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
            chatAgents.set(k(botId, chatId), String(hit.session.id));
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
            // In web mode the preset mounts compaction inside an `isolate` realm.
            // Per dsh-agent-presets such a realm is invisible to everything
            // outside the group — including the host AND the agent's own scoped
            // context — so `active.ctx?.compaction` is always undefined here.
            // The correct read-addressing API is agentPresets.serviceFor(agent,
            // name), which a caller holding the agent uses to read one of its
            // preset-mounted services (the same trick dsh-host-apiproxy uses for
            // goals/skills). Fall back to the direct property for deployments
            // that don't isolate it (e.g. CLI host plane).
            let compaction;
            try {
              compaction = ctx.get?.('agentPresets')?.serviceFor?.(active, 'compaction')
                ?? active.ctx?.compaction;
            } catch { /* not available */ }
            if (!compaction?.compactNow) {
              await reply('❌ compaction 服务不可用（该 agent 的 preset 未挂载 compaction，如 minimal preset）。');
              return true;
            }
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 120_000);
            try {
              const result = await compaction.compactNow(active, ac.signal);
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

          case '/autopilot': {
            if (c.autopilotEnabled === false) {
              await reply('（autopilot 已被禁用：`autopilotEnabled: false`）');
              return true;
            }
            const agent = active;
            const arg = (args || '').trim().toLowerCase();
            const wantOn = arg === '' || arg === 'on' || arg === 'enable' || arg === '1';
            const wantOff = arg === 'off' || arg === 'disable' || arg === '0';
            const wantStatus = arg === 'status' || arg === 'state';

            if (wantStatus) {
              const s = autopilotStateFor(chatId);
              if (s?.on) {
                await reply(`🤖 <b>Autopilot：开启中</b>\n会话：<code>${escapeHtml((agent?.session?.id ?? '').slice(0, 12))}</code>\n沙箱：<code>${escapeHtml(c.autopilotSandboxMode || 'danger-full-access')}</code>（全局写）+ 免审批\n自动答题窗口：${Number(c.autopilotWindowMs) || 0}ms\n停止：/autopilot off`);
              } else {
                await reply('🤖 Autopilot：未开启。开启：/autopilot（或 /autopilot on）');
              }
              return true;
            }

            if (wantOff) {
              const s = autopilotStateFor(chatId);
              if (!s?.on) {
                await reply('（autopilot 当前未开启）');
                return true;
              }
              disableAutopilot(botId, chatId, agent);
              await reply(`🛡️ 已关闭 autopilot（会话 <code>${escapeHtml((agent?.session?.id ?? '').slice(0, 12))}</code>）。\n权限已恢复为 <code>${escapeHtml(s.prevSandbox ?? 'workspace-write')}</code> + 需审批，提问会重新等待你选择。`);
              return true;
            }

            // wantOn
            if (autopilotStateFor(chatId)?.on) {
              await reply('（autopilot 已在该会话开启中；停止：/autopilot off）');
              return true;
            }
            if (!agent) {
              await reply('❌ 没有可用会话。请先 /new 新建会话，再 /autopilot 开启。');
              return true;
            }
            enableAutopilot(botId, chatId, agent);
            const short = String(agent?.session?.id ?? '').slice(0, 12);
            // Explicit security warning (required by the feature spec).
            await reply([
              '⚠️ <b>Autopilot 已开启 — 安全警告</b>',
              '',
              '本会话现在运行在<b>全自动</b>模式：',
              `• 沙箱权限 → <code>${escapeHtml(c.autopilotSandboxMode || 'danger-full-access')}</code>（<b>全局写</b>：可读写工作区外文件、执行危险命令）`,
              '• 所有工具授权 / 沙箱升级 <b>自动放行</b>，不再弹审批卡',
              '• 我需要向你提问时，会<b>自动采纳推荐方案</b>并通知你（' + `${Number(c.autopilotWindowMs) || 0}ms` + ' 内可 ✋ 接管）',
              '',
              '<b>⚠️ 安全隐患：agent 拥有全局写权限且无人逐步把关，可能误改/误删工作区外的文件，或执行不可逆操作。请谨慎使用，重要操作前确认任务描述准确。</b>',
              '',
              `会话：<code>${escapeHtml(short)}</code>　停止：<code>/autopilot off</code>　中断任务：<code>/stop</code>`,
            ].join('\n'));
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

    // v0.5.x P3: per-bot message handler. botId is the SOURCE bot of the
    // message; all filters / client calls / sends / agent routing below use
    // THAT bot's config + client (not the top-level single-bot bindings).
    async function handleIncomingMessage(botId, message) {
      const bEntry = botRegistry.get(botId) ?? {};
      const bCfg = bEntry.cfg || {};
      // Per-bot filter config (fall back to the top-level values for the legacy
      // single-bot config, where bCfg is the 'default' bot carrying those).
      const bAllowedChats = Array.isArray(bCfg.allowedChats) ? bCfg.allowedChats : allowedChats;
      const bAllowedUsers = Array.isArray(bCfg.allowedUsers) ? bCfg.allowedUsers : allowedUsers;
      const bRequireMention = bCfg.requireMention !== undefined ? bCfg.requireMention : requireMention;
      const sender = message.senderUsername || message.senderName || message.senderId;
      log('info', `Message from ${sender} in chat ${message.chatId} (bot=${botId}): ${message.text?.slice(0, 100) || '(media)'}`);

      if (bAllowedChats.length && !bAllowedChats.includes(message.chatId)) return;
      if (bAllowedUsers.length && !bAllowedUsers.includes(message.senderId)) return;

      if (bRequireMention && (message.chatType === 'group' || message.chatType === 'supergroup')) {
        const bot = meFor(botId);
        if (!message.text?.includes(`@${bot.username}`)) return;
      }

      // Plan A commands: /new, /sessions, /use <id>, /help
      if (message.text && await handleCommands(botId, message)) return;

      // ask_user_question custom answer (v0.4.4): if the agent is waiting on a
      // single-question card for this chat and the user replies with plain text
      // (ideally replying to the card), consume it as that question's custom
      // answer instead of injecting it as a new agent message. Multi-question
      // cards answer via buttons only (consumeTextReply returns false).
      if (message.text && questionConsumeText && questionConsumeText(message.chatId, message.text)) {
        log('info', `Chat ${message.chatId}: plain-text reply consumed as ask_user_question answer`);
        return;
      }

      // Dedup: skip if we already injected this message id (poller-level dedup
      // is the primary gate; this is a second line of defence for handler-level
      // retries). Per-bot: the key is scoped to the source bot via k() so the
      // same (chatId, messageId) arriving under two bots is not cross-deduped.
      const dedupKey = `${k(botId, message.chatId)}:${message.messageId}`;
      if (injectedIds.has(dedupKey)) return;

      const hasMedia = !!(message.photo || message.document || message.video
        || message.audio || message.voice);
      if (message.text || hasMedia) {
        // Show typing action (source bot's client).
        const bClient = clientFor(botId);
        await bClient.sendChatAction(message.chatId, 'typing', message.messageThreadId);

        // Inject message to agent session if enabled
        const currentAgent = resolveChatAgent(botId, message.chatId);

        // If the agent is already running a (long) task, a new message is
        // queued as a next-turn follow-up and won't be answered until that
        // task finishes. Without an ack the user stares at silence for the
        // whole duration — that read as "the bot isn't responding". Send a
        // single, quiet "queued" notice (back to the SOURCE bot) so the wait
        // is visible.
        if (injectToAgent && currentAgent && currentAgent.status === 'running') {
          void sendText(
            botId,
            String(message.chatId),
            '⏳ 正在处理上一个任务，这条消息已加入队列，完成后会接着回复。',
            { replyToMessageId: message.messageId, messageThreadId: message.messageThreadId, disableNotification: true },
          ).catch((e) => log('warn', `Failed to send queued-ack: ${e.message}`));
        }
        if (injectToAgent && currentAgent) {
          try {
            // Inbound media: download + forward the LOCAL PATH to the agent so
            // it can read/process the file with its tools. (A photo MAY also be
            // attached as a vision block when inboundImageToModel is on.)
            let mediaNote = '';
            let imageBlock = null;
            if (hasMedia && forwardInboundMedia) {
              const fm = await downloadAndDescribeInboundMedia(botId, message);
              mediaNote = fm.note;
              imageBlock = fm.imageBlock;

              // Inbound voice: transcribe ONCE, then (a) reply with the text
              // directly under the voice bubble — the only way to show it "on the
              // next line" in Telegram — and (b) reuse the SAME transcript in the
              // agent note so it already has the words (no 2nd transcribe_audio).
              if (inboundMediaKind(message) === 'voice' && voiceTranscribe && fm.localPath) {
                const transcript = await transcribeVoiceFile(fm.localPath, voiceTranscribeLanguage);
                if (transcript) {
                  void sendPlainText(botId, String(message.chatId), `🎧 ${transcript}`, {
                    replyToMessageId: message.messageId,
                    messageThreadId: message.messageThreadId,
                    disableNotification: true,
                  });
                  if (voiceTranscriptToAgent) {
                    mediaNote += ` Whisper transcription (already read; do NOT call transcribe_audio): “${transcript}”`;
                  }
                }
              }
            }

            // DSH's MessageSource requires kind ∈ {user, plugin, model, tool}.
            // Use 'plugin' (this plugin is the source of the message) and
            // keep the chat id in the text so the agent can route replies.
            const voiceInstruction = ` If the user asks for a spoken / audio reply (语音播报 / 语音 / 朗读 / read aloud), use the telegram_send_voice tool with chat_id: ${message.chatId} — do NOT use text_to_speech, whose output would not reach Telegram.`;
            const fileInstruction = ` To send the user a file you have locally (a PDF, image, video, audio, or any document), pass its ABSOLUTE local path directly to telegram_send_document / telegram_send_photo / telegram_send_video / telegram_send_audio — the plugin uploads it to Telegram via multipart; do NOT upload it to a public host first.`;
            // Autopilot convention: when this chat is in autopilot, tell the
            // agent to mark its recommended option so the auto-answerer can lock
            // onto it (see questions.js pickRecommended). Documentation-level
            // convention (README/AGENT_INTEGRATION) plus this per-message hint.
            const autopilotHint = isAutopilotChat(message.chatId)
              ? ` NOTE: Autopilot is ON for this chat. When you need to ask the user a question (ask_user_question), put your RECOMMENDED option FIRST and tag its label with "（推荐）" (e.g. "Plan A（推荐）") — the plugin will auto-select the recommended option and notify the user, so phrase each option so the recommended one is genuinely the one you would pick.`
              : '';
            const replyInstruction =
              agentResponseMode === 'direct'
                ? `This message comes from Telegram (chat ${message.chatId}, sender ${sender}). Produce your answer as normal assistant text; the plugin will forward it back to Telegram automatically. Do NOT call telegram_send_message.` + voiceInstruction + fileInstruction + autopilotHint
                : `This message comes from Telegram (chat ${message.chatId}, sender ${sender}). Reply to it using the telegram_send_message tool with chat_id: ${message.chatId}.` + voiceInstruction + fileInstruction + autopilotHint;

            const bodyParts = [];
            if (message.text) {
              bodyParts.push(`[Telegram message from ${sender} in chat ${message.chatId}]\n${message.text}`);
            }
            if (hasMedia) {
              bodyParts.push(forwardInboundMedia ? mediaNote : `The user sent a ${inboundMediaKind(message)}.`);
            }
            bodyParts.push(replyInstruction);
            const textBlock = { type: 'text', text: bodyParts.join('\n\n') };

            const userMessage = {
              role: 'user',
              content: imageBlock ? [imageBlock, textBlock] : [textBlock],
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
            startProgressForAgent(currentAgent, botId, message.chatId, baseline, message.messageThreadId);

            if (agentResponseMode === 'direct' && !streamingReplyEnabled) {
              // Auto-capture the agent's final text for this turn and send it.
              // (When streaming is enabled the ProgressIndicator finalizes the
              // reply in place — see onFinalReply — so we must NOT double-send.)
              void watchDirectReply(currentAgent, botId, message.chatId, message.messageId);
            }
            return;
          } catch (err) {
            log('error', `Failed to inject message to agent:`, err.message);
          }
        } else if (injectToAgent) {
          log('info', 'Agent injection enabled but no agent available yet');
        }

        // Fallback (no agent / injection off): brief echo so the user knows
        // the bot saw it. Sent via the SOURCE bot's client.
        const echoText = message.text
          ? `Received your message: "${message.text.slice(0, 100)}"`
          : `I received a ${inboundMediaKind(message)}.`;
        await clientFor(botId).sendMessage({
          chatId: message.chatId,
          text: echoText,
          parseMode: parseMode,
          replyToMessageId: message.messageId,
          messageThreadId: message.messageThreadId,
        });
      }
    }

    activePoller.onMessage(async (message) => handleIncomingMessage(firstBotId, message));

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
    // activePoller's callback handler below resolves the promise when the user taps.
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
        // by /new or a fresh chat). Route to the owning (bot, chat); the
        // composite key carries both, so the chat part is the routing target.
        if (sidStr.startsWith(TELEGRAM_SESSION_PREFIX)) {
          let chatId = null;
          for (const [key, csid] of chatAgents) {
            if (String(csid) === sidStr) {
              const bi = key.indexOf('::');
              chatId = bi >= 0 ? key.slice(bi + 2) : key;
              break;
            }
          }
          // v0.5.x P2: fall back to the per-bot default of the agent's own bot
          // (meta.botId), NOT the top-level default. For the legacy config the
          // default bot's defaultChatId IS the top-level defaultChatId.
          if (!chatId && hit?.meta?.botId) {
            const cfg = botRegistry.get(hit.meta.botId)?.cfg;
            if (cfg?.defaultChatId) chatId = String(cfg.defaultChatId);
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

    // v0.5.x P2/P3: the modules take ONE client (their `client` dep). We hand
    // them clientDispatch — a client-shaped object that resolves the owning
    // bot per call via the pending card's chatId (composite key). For the
    // legacy single-bot config this always resolves to the default bot, i.e.
    // exactly the old `activeClient` — behavior unchanged.
    const moduleClient = clientDispatch;

    if (approvalEnabled && typeof ctx.on === 'function') {
      const approvalModule = createApprovalModule({
        activeClient: moduleClient,
        enabled: () => approvalEnabled,
        timeoutMs: approvalTimeoutMs,
        log,
        escape: (s) => escapeHtml(s),
        ownership: (agent) => telegramAgentOwnership(agent?.id ?? agent?.session?.id, { allowDefault: approvalForDefaultAgent }),
        // Autopilot: auto-grant every ask for a chat in autopilot mode (no card).
        isAutopilot: (chatId) => isAutopilotChat(chatId),
        // ackCallback routes through the per-bot dispatch (the module holds
        // clientDispatch as its `activeClient`); answerCallbackQuery carries
        // no chatId, so the dispatch falls back to the active-card bot context
        // (set in onCallbackQuery). Legacy config → always the default bot.
        ackCallback: (qid, toast) => {
          if (qid) return clientDispatch.answerCallbackQuery(qid, toast);
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
      approvalClearNotice = (chatId) => { try { approvalModule.clearAutopilotNotice(chatId); } catch { /* ignore */ } };
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
    if (questionsEnabled && activeClient) {
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
        // v0.5.x P3: per-bot client dispatch (the module holds ONE client dep;
        // clientDispatch routes each call to the owning bot via the card's
        // chatId / active-card context). Legacy config → always default bot.
        activeClient: moduleClient,
        ownership: (sessionId) => telegramAgentOwnership(sessionId, { allowDefault: questionsForDefaultAgent }),
        respond: respondQuestion,
        // Autopilot (v0.5.0): auto-adopt the recommended option when the owning
        // chat is in autopilot mode, then commit after the takeover window.
        isAutopilot: (chatId) => isAutopilotChat(chatId),
        // The module only knows the chatId; resolve the owning bot from the
        // composite-keyed chatAgents map, then (bot, chat)-scoped disable.
        autopilotTakeover: (chatId) => {
          const bid = botIdForChat(chatId);
          const ag = resolveChatAgent(bid, chatId);
          disableAutopilot(bid, chatId, ag);
        },
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

    // Per-bot callback handler (v0.5.x P3): the SOURCE bot is derived from the
    // query's chat (button cards carry their chat). Setting the active-card
    // bot context routes the modules' chat-less client calls (answerCallback
    // Query) to the right bot. Legacy config → always 'default'.
    const handleCallbackQuery = async (botId, query) => {
      const qChat = query?.message?.chat?.id;
      if (qChat != null) setActiveCardBotId(botIdForChat(qChat) || botId);
      log('info', `Callback query from ${query.from.username || query.from.id} (bot=${botId}): data="${query.data}"`);
      // Route button taps to the owning module (each acks its own callback).
      // Tool-guard approval first, then ask_user_question. Anything else falls
      // through to a plain ack on the SOURCE bot.
      if (approvalHandleQuery && approvalHandleQuery(query)) return;
      if (questionHandleQuery && (await questionHandleQuery(query))) return;
      await clientFor(botId).answerCallbackQuery(query.id, 'Acknowledged');
    };

    activePoller.onCallbackQuery(async (query) => handleCallbackQuery(firstBotId, query));

    // Register the bot command menu so Telegram clients show it in the
    // "/" autocomplete (Bot API setMyCommands). Keep in sync with
    // handleCommands below. v0.5.x P3: register on EVERY bot's own client
    // (a menu is per-bot, not global) — each bot that has a client gets its
    // own setMyCommands; failures are non-fatal (menu just missing).
    const commandMenu = [
      { command: 'new', description: '新建会话（清空上下文）' },
      { command: 'clear', description: '同 /new：新建会话' },
      { command: 'stop', description: '停止当前任务' },
      { command: 'compact', description: '压缩会话历史为摘要' },
      { command: 'history', description: '查看最近对话记录' },
      { command: 'model', description: '查看/切换模型（/model list 列出）' },
      { command: 'sessions', description: '列出活动会话' },
      { command: 'use', description: '切换到指定会话（/use <id>）' },
      { command: 'approval', description: '查看/管理「一直允许」授权（/approval clear 清空）' },
      { command: 'autopilot', description: '全自动模式：全局写权限+自动放行授权（/autopilot on|off|status）' },
      { command: 'help', description: '显示帮助' },
    ];
    for (const entry of botRegistry.values()) {
      if (!entry.client) continue; // token-missing bot is skipped (no client)
      try {
        await entry.client.setMyCommands(commandMenu);
        log('info', `Registered Telegram command menu (setMyCommands) for bot "${entry.id}".`);
      } catch (err) {
        log('warn', `setMyCommands failed for bot "${entry.id}" (command menu may be missing):`, err.message);
      }
    }

    activePoller.start();
    log('info', 'Telegram poller started.');
    // Link this poller into the registry for the first bot, and keep the
    // legacy `poller` binding (used by the top-level unload effect below).
    const firstEntry = [...botRegistry.values()].find((e) => e.client === activeClient);
    if (firstEntry) {
      firstEntry.poller = activePoller;
      poller = activePoller;
    }

    // Multi-bot (v0.5.x): start a poller for EVERY OTHER bot that has a
    // client (the first one above is the legacy/single-bot path). Each poller
    // uses its own bot's per-bot config. The first bot's poller keeps the
    // existing top-level config so the legacy single-bot path is unchanged.
    for (const entry of botRegistry.values()) {
      if (!entry.client || entry.client === activeClient) continue;
      const bcfg = entry.cfg;
      const bPoller = new TelegramPoller(entry.client, {
        allowedChats: (Array.isArray(bcfg.allowedChats) && bcfg.allowedChats.length) ? bcfg.allowedChats : undefined,
        allowedUsers: (Array.isArray(bcfg.allowedUsers) && bcfg.allowedUsers.length) ? bcfg.allowedUsers : undefined,
        requireMention: bcfg.requireMention !== undefined ? bcfg.requireMention : requireMention,
        longPollTimeout: Number(bcfg.longPollTimeout) > 0 ? Number(bcfg.longPollTimeout) : longPollTimeout,
        verbose,
        // Per-bot offset store so each bot tracks its own update cursor
        // (defaults to $DSH_HOME/telegram-poller-offset-<botId>.json).
        offsetKey: bcfg.id,
      });
      entry.poller = bPoller;
      // v0.5.x P3: each non-first bot's poller routes its messages + callback
      // queries through the SAME handlers, but with THAT bot's id as the
      // source (filters/client/sends/agent routing all use entry.id).
      bPoller.onMessage((msg) => handleIncomingMessage(entry.id, msg));
      bPoller.onCallbackQuery((q) => handleCallbackQuery(entry.id, q));
      bPoller.start();
      log('info', `Telegram poller started for bot "${bcfg.id}".`);
    }
    // v0.5.x P5/P6: expose this run's closure-scoped per-bot ownership + board
    // helpers to tests (see __testHooks). MUST live inside the
    // `if (pollingEnabled && client)` block — these helpers are block-scoped
    // and defined above, so the assignment is only in scope here.
    __testHooks.rootAgentToChat = rootAgentToChat;
    __testHooks.ownerOfChildSession = ownerOfChildSession;
    __testHooks.boardForChat = boardForChat;
    __testHooks.chatAgents = chatAgents;
  }

  // -----------------------------------------------------------------------
  // Cleanup on unload
  // -----------------------------------------------------------------------

  ctx.effect(() => {
    return () => {
      // Multi-bot (v0.5.x): stop EVERY poller registered for every bot. The
      // legacy single `poller` binding is now one of these registry entries,
      // so this covers the legacy single-bot path AND any extra bots. (The
      // remaining cleanup below is unchanged.)
      for (const entry of botRegistry.values()) {
        try { entry.poller?.stop?.(); } catch { /* ignore */ }
      }
      // Cancel any in-flight approval cards so their answerer promises settle
      // (cancelled) rather than hanging after unload.
      try { approvalCancel?.(); } catch { /* ignore */ }
      approvalCancel = null;
      approvalHandleQuery = null;
      approvalClearNotice = null;
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
      // Autopilot state is in-memory per chat. The sessions it upgraded are
      // disposed along with their agents (ownedHandles) above, so there is
      // nothing to restore on unload — just forget the map so a reload starts
      // clean.
      autopilotChats.clear();
      log('info', 'Telegram plugin unloaded.');
    };
  });
}
