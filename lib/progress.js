/**
 * Live Telegram progress indicator (the in-place "activity trail" message) plus
 * the small text helpers it renders with. Extracted from index.js so the
 * indicator and its helpers can be unit-tested in isolation.
 *
 * @module dsh-plugin-telegram/progress
 */

/** Compact, single-line preview of a tool call's arguments. */
export function summarizeToolArgs(args, max = 110) {
  let s;
  if (typeof args === 'string') s = args;
  else if (args === undefined || args === null) s = '';
  else {
    try { s = JSON.stringify(args); } catch { s = String(args); } // circular / BigInt
  }
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

/**
 * Session event-log accessor compatible with both dsh-session APIs:
 *   • ≤ 0.1.1-rc.x: `session.events` getter (frozen snapshot of the log)
 *   • 0.1.2-rc.1+:  the getter was REMOVED; `session.snapshotEvents()` is
 *     the equivalent. Reading `.events` yields undefined on the new class.
 */
export function sessionEvents(session) {
  if (!session) return undefined;
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents(); } catch { return undefined; }
  }
  return undefined;
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
    // Streaming mode: how many recent activity lines (💭/🔧) to show under the
    // 回复（生成中） body. 1 = the old single-line trail; 0 disables the block.
    const _tl = Number(this.o.trailLines);
    this.trailLines = Number.isFinite(_tl)
      ? Math.max(0, Math.min(5, Math.floor(_tl)))
      : 3;
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
    const MAX_BLOCK_CHARS = 4000;
    const KEEP_CHARS = 2000;
    if (this.trace.length > MAX_BLOCKS) this.trace.splice(0, this.trace.length - MAX_BLOCKS);
    for (const b of this.trace) {
      if (b.kind === 'reasoning' && typeof b.text === 'string' && b.text.length > MAX_BLOCK_CHARS) {
        b.text = b.text.slice(-KEEP_CHARS);
      } else if (b.kind === 'tool' && typeof b.args === 'string' && b.args.length > MAX_BLOCK_CHARS) {
        // Tool args were kept VERBATIM for the whole turn — a base64 blob or
        // huge write payload pinned megabytes and got re-walked every tick.
        b.args = b.args.slice(-KEEP_CHARS);
      }
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
        const foot = this._latestActivityLines();
        const bodyMax = Math.max(10, max - header.length - foot.length);
        const body = reply.length > bodyMax ? '…' + reply.slice(-(bodyMax - 1)) : reply;
        const full = header + body + foot;
        // A large perBlockChars config can make the FOOTER alone overshoot;
        // an over-4096 edit fails every time and freezes the trail. Clamp.
        return full.length > max ? '…' + full.slice(-(max - 1)) : full;
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
    let full = header + body;
    if (full.length > max) full = '…' + full.slice(-(max - 1));
    return full;
  }

  /**
   * "Recent activity" footer for the streaming branch: up to `this.trailLines`
   * most-recent activity lines (💭 reasoning / 🔧 tool + args) taken from the
   * tail of the trail, oldest first, each tail-truncated to `perBlockChars`.
   *
   * The footer is shown even while the model is actively emitting reply text —
   * the reply tail already changes, but the user asked for a persistent 2-3 line
   * trail here so they can still watch tool calls / thinking scroll underneath.
   * It always shows the NEWEST activity (a live "thinking…" line when no block
   * is recorded yet, or a 🔧 line for the latest tool) so the message text
   * differs on each new step and the edit re-fires instead of freezing.
   */
  _latestActivityLines() {
    const n = this.trailLines;
    if (!n) return '';
    const per = this.o.perBlockChars ?? 240;
    const lines = [];
    // Newest block first; render oldest→newest below.
    for (let i = this.trace.length - 1; i >= 0 && lines.length < n; i--) {
      const b = this.trace[i];
      if (b.kind === 'reasoning') {
        const t = compactText(b.text);
        if (t) lines.push('💭 ' + tailOf(t, per));
      } else {
        const arg = summarizeToolArgs(b.args, per);
        lines.push('🔧 ' + b.name + (arg ? '：' + arg : ''));
      }
    }
    lines.reverse();
    // No activity blocks yet: fall back to the live one-liner so the footer is
    // never empty before the first reasoning/tool event lands.
    if (!lines.length) {
      if (this.lastActivityKind === 'tool') lines.push('🔧 ' + (this.lastActivityName || 'tool'));
      else if (this.lastActivityKind === 'reasoning') lines.push('💭 思考中…');
      else return '';
    }
    const headerLine = n > 1 ? '最近活动（最新）：' : '最近活动：';
    let inner = headerLine + '\n' + lines.join('\n');
    // Safety net: the per-line caps already bound this, but a pathologically
    // long tool name could still overshoot — drop OLDEST lines to fit.
    const budget = n * (per + 8) + 16;
    if (inner.length > budget) {
      while (lines.length > 1 && inner.length > budget) {
        lines.shift();
        inner = headerLine + '\n' + lines.join('\n');
      }
    }
    return '\n' + inner;
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
      if (this.stopped && this.msgId) {
        // stop() ran while the send was in flight — don't leave an orphan.
        try { await this.o.client.deleteMessage(this.o.chatId, this.msgId); } catch { /* ignore */ }
        this.msgId = null;
      }
    } catch (err) {
      this.o.log?.('warn', `Progress indicator: failed to post message: ${err.message}`);
      this.msgId = null;
    }
    return this.msgId;
  }

  /** Edit-in-place, throttled; skips when the text is unchanged. */
  async push(force) {
    if (this.stopped || !this.msgId) return;
    const throttleMs = Number(this.o.intervalMs) > 0 ? Number(this.o.intervalMs) : 1000;
    const now = Date.now();
    const text = this.buildTraceText();
    if (!force && (text === this.lastText || now - this.lastEditAt < throttleMs)) return;
    try {
      await this.o.client.editMessageText(this.o.chatId, this.msgId, text, undefined);
      // Commit only on SUCCESS: committing before the edit made a failed
      // edit permanent (text === lastText short-circuits every later tick —
      // the classic "progress never updates" freeze).
      this.lastEditAt = now;
      this.lastText = text;
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
          // A REJECT here must not skip the placeholder cleanup below — a
          // throw used to leave a permanent "回复（生成中）" on screen.
          try {
            const consumed = await this.o.onFinalReply(this.o.chatId, fullText, {
              messageThreadId: this.o.threadId,
              placeholderMessageId: this.msgId,
            });
            if (consumed && this.msgId) this.msgId = null;
          } catch (err) {
            this.o.log?.('warn', `Progress indicator: onFinalReply failed: ${err?.message ?? err}`);
          }
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
    const posNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
    const deadline = Date.now() + posNum(this.o.timeoutMs, 3_600_000);
    const tickMs = posNum(this.o.tickMs ?? this.o.intervalMs, 1500);
    const tick = async () => {
      if (this.stopped || this._tickBusy) return; // never overlap ticks (duplicate placeholders)
      this._tickBusy = true;
      try {
      this.typing();
      // Always fold the session log first: if the turn already ended we stop
      // right away (and never post the indicator for an instant turn).
      const evts = sessionEvents(this.o.agent?.session);
      if (Array.isArray(evts)) {
        const done = this.processEvents(evts);
        if (done) { this.endedByTurnEnd = true; await this.stop(); return; }
      }
      // Deadline FIRST: with msgId still null (ensureMessage keeps failing —
      // bot kicked, chat migrated) the old order returned before the check
      // and the loop polled + warned forever, leaking the interval.
      if (Date.now() > deadline) {
        this.o.log?.('warn', 'Progress indicator: hit progressTimeoutSec cap; self-cleaning');
        await this.stop();
        return;
      }
      if (!this.msgId) {
        // Post the placeholder once (a) the activity trail has been going long
        // enough, or (b) in streaming mode the reply itself has started — so
        // the user watches the answer build from its first token, not only
        // after the progress delay.
        const replyStarted = this.streaming && this.replyText.length > 0;
        const delayMs = Number(this.o.delayMs) > 0 ? Number(this.o.delayMs) : 0;
        if (replyStarted || Date.now() - (Number(this.o.startedAt) || 0) >= delayMs) {
          await this.ensureMessage();
          if (!this.stopped && this.msgId) await this.push(true);
        }
        return;
      }
      await this.push(false);
      } finally {
        this._tickBusy = false;
      }
    };
    this.loop = setInterval(() => { void tick(); }, tickMs);
    // Kick off immediately so a long turn is picked up without waiting a full
    // interval for the first poll.
    void tick();
  }
}
