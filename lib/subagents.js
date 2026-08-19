// ---------------------------------------------------------------------------
// Live subagent board — a single pinned Telegram message that shows, in
// real time, every subagent the current session has spawned: for each one a
// short task name + status (line 1) and what it is doing right now (line 2),
// at most two lines per subagent.
//
// Data sources (verified against the DSH checkout):
//   • `subagent/start` / `subagent/end` events — the lifecycle edges. The
//     payload's `id` is the child session id, which equals the child agent id
//     (SubagentRun.id === childAgent.id === childSessionId). These are
//     scope-filtered to the parent, so the plugin subscribes with
//     `ctx.on(name, fn, { global: true })` to receive them regardless of scope.
//   • `ctx.get('agents').list()` — subagent children are created via
//     `parent.ctx.agents.create(...)`, so they are registered agents that appear
//     here with their own live `session` (in-memory event log) and `status`
//     ('running' / 'idle' / ...). `session.header` carries `origin: 'subagent'`
//     and `parentSession`, which maps a child back to its parent (our chat).
//   • "what it is doing" = the most recent `tool/call` (name + short arg) or
//     the latest reasoning/text delta in the child's own `session.events`.
//   • a short task name = the child's `subagent/descriptor` event `label`
//     (model-hidden, turn-enclosed in the child's first turn), falling back to
//     the parent's `subagent`/`subagent_fork` tool-call `description`, else a
//     truncated session id.
//
// Pure functions are exported for unit testing; the class receives every
// side effect (telegram send/edit, agents list, clock, log) as deps.
// ---------------------------------------------------------------------------

// Max display-width (in "columns", CJK ≈ 2) for the per-subagent work line so
// the board stays phone-friendly and well under Telegram's 4096-char limit.
export const DEFAULT_MAX_WORK_WIDTH = 74;
// Max subagents rendered before collapsing the overflow into a "+K more" line.
export const DEFAULT_MAX_ROWS = 10;
// How often (ms) the board re-reads live child sessions while one is working.
export const DEFAULT_REFRESH_MS = 2000;
// How long (ms) to throttle Telegram edit calls (Telegram rate-limits edits).
export const DEFAULT_THROTTLE_MS = 1500;
// A working entry not observed in the live agents list for this many ticks is
// treated as ended (locked) — the backstop for when a subagent/end event is
// missed or the child is disposed before the event lands.
export const GRACE_TICKS = 3;

// Wide-char-aware display width: CJK / fullwidth / emoji ≈ 2 columns, others 1.
// Mirrors questions.js so the two renderers agree on clipping.
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

// Truncate a string to `maxWidth` display columns, appending an ellipsis when
// clipped. Never widens the result past maxWidth.
export function truncateDisplay(s, maxWidth) {
  const str = String(s ?? '');
  if (displayWidth(str) <= maxWidth) return str;
  const ellipsis = '…';
  const budget = maxWidth - displayWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = ch.codePointAt(0) > 0x2e7f ? 2 : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

// Emoji per status. working is "in flight"; the terminal states map from the
// subagent stopReason (completed / aborted / error / cancelled / ...).
export function statusEmoji(status) {
  if (status === 'working') return '🟢';
  if (status === 'completed' || status === 'done') return '✅';
  if (status === 'error') return '❌';
  if (status === 'aborted' || status === 'cancelled' || status === 'canceled') return '⏹️';
  return '⚪';
}

// Human status word (kept short so it fits on line 1 next to the label).
export function statusWord(status) {
  if (status === 'working') return '工作中';
  if (status === 'completed' || status === 'done') return '已完成';
  if (status === 'error') return '出错';
  if (status === 'aborted') return '已中止';
  if (status === 'cancelled' || status === 'canceled') return '已取消';
  return status || '?';
}

// Normalize a raw subagent stopReason into a board status.
export function normalizeStopReason(stopReason) {
  const r = String(stopReason || '').toLowerCase();
  if (r === 'completed') return 'completed';
  if (r === 'aborted' || r === 'cancelled' || r === 'canceled') return r;
  if (r === 'error' || r === 'failed') return 'error';
  return r || 'completed';
}

// Pull the short task label out of a child session: the `subagent/descriptor`
// event's `label` (versioned, model-hidden). Returns '' when absent.
export function labelFromSession(session) {
  const events = session?.events;
  if (!Array.isArray(events)) return '';
  for (const evt of events) {
    if (evt?.type === 'subagent/descriptor' && typeof evt?.data?.label === 'string') {
      const l = evt.data.label.trim();
      if (l) return l;
    }
  }
  return '';
}

// Shorten an arbitrary description/task string to a compact label (≤ width).
// Used when a subagent tool-call `description` is available but no descriptor.
export function labelFromDescription(desc, width = 24) {
  const s = String(desc ?? '').replace(/\s+/g, ' ').trim();
  return truncateDisplay(s, width);
}

// Summarize one tool-call argument into a short fragment (the most
// identifying value) for the "what it is doing" line.
function summarizeArgs(args) {
  if (args == null) return '';
  let s;
  if (typeof args === 'string') s = args;
  else if (Array.isArray(args)) s = args.join(' ');
  else {
    try { s = JSON.stringify(args); } catch { s = String(args); }
  }
  s = String(s).replace(/"/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

// Scan a child session's events (newest meaningful activity first) and return
// a compact "what it is doing right now" string. Prefers the latest tool call,
// then the latest reasoning, then the latest assistant text. `sinceSeq` skips
// already-seen events (pass 0 to scan the whole log).
export function latestActivity(session, sinceSeq = 0) {
  const events = session?.events;
  if (!Array.isArray(events)) return '';
  let tool = '';
  let reasoning = '';
  let text = '';
  for (const evt of events) {
    if (!evt || typeof evt.seq !== 'number' || evt.seq <= sinceSeq) continue;
    const type = evt.type;
    const d = evt?.data || {};
    if (type === 'tool/call') {
      const name = d.name || 'tool';
      const a = summarizeArgs(d.arguments ?? d.args);
      tool = a ? `${name} ${a}` : String(name);
    } else if (type === 'assistant/chunk') {
      const chunk = d.chunk || {};
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoning = (reasoning + chunk.text);
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning' && chunk.block.text) {
        reasoning = String(chunk.block.text);
      }
    } else if (type === 'reasoning-chunks' && Array.isArray(d.texts)) {
      reasoning = d.texts.join('');
    } else if (type === 'assistant/message') {
      const msg = d.message;
      if (msg && Array.isArray(msg.content)) {
        const t = msg.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join(' ').trim();
        if (t) text = t;
      }
    }
  }
  if (tool) return tool;
  if (reasoning) return reasoning.trim();
  if (text) return text;
  return '';
}

// Build the full board text from a list of entries (already ordered) and the
// current clock. Pure — safe to unit test. Each subagent occupies at most
// two lines; the overflow beyond maxRows collapses into one "+K more" line.
export function renderBoardText(entries, opts = {}) {
  const {
    working = 0,
    done = 0,
    now = 0,
    maxRows = DEFAULT_MAX_ROWS,
    maxWorkWidth = DEFAULT_MAX_WORK_WIDTH,
    startWall = {},
  } = opts;

  const rows = [];
  const shown = entries.slice(0, maxRows);
  for (const e of shown) {
    const emoji = statusEmoji(e.status);
    const label = truncateDisplay(e.label || e.id, 26);
    const word = statusWord(e.status);
    // Line 1: status + label + status word.
    const line1 = `${emoji} ${label} · ${word}`;
    rows.push(line1);
    // Line 2: the work content (only while working, or a terminal reason).
    const work = e.status === 'working'
      ? (e.work || '正在启动…')
      : terminalReason(e, startWall, now);
    if (work) rows.push(truncateDisplay(work, maxWorkWidth));
  }

  const hidden = entries.length - shown.length;
  const out = [];
  out.push(`🧩 子代理看板 · ${working} 工作中 / ${done} 完成`);
  out.push(rows.join('\n'));
  if (hidden > 0) out.push(`… 另有 ${hidden} 个未显示`);
  return out.filter((l) => l.length > 0).join('\n');
}

// A short one-line note for a terminal row (why it ended + how long it took).
function terminalReason(e, startWall, now) {
  const reason = e.status === 'error' ? '执行出错'
    : e.status === 'aborted' ? '被中止'
    : (e.status === 'cancelled' || e.status === 'canceled') ? '被取消'
    : '已完成';
  const startMs = startWall[e.id];
  const endMs = e.endedAt || now;
  if (startMs && endMs && endMs >= startMs) {
    const secs = Math.max(0, Math.round((endMs - startMs) / 1000));
    const t = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
    return `${reason} · 用时 ${t}`;
  }
  return reason;
}

// Map a child's `subagent`/`subagent_fork` tool call (found in the PARENT
// session) to a short description, keyed by the child session id when it can
// be matched, else the last such call's description. Returns { byId, last }.
export function parentSubagentDescriptions(session) {
  const events = session?.events;
  const byId = new Map();
  let last = '';
  if (!Array.isArray(events)) return { byId, last };
  for (const evt of events) {
    if (evt?.type !== 'tool/call') continue;
    const name = String(evt?.data?.name || '');
    if (name !== 'subagent' && name !== 'subagent_fork') continue;
    const args = evt.data?.arguments ?? evt.data?.args;
    let obj = args;
    if (typeof args === 'string') { try { obj = JSON.parse(args); } catch { obj = {}; } }
    const desc = obj && typeof obj.description === 'string' ? obj.description.trim() : '';
    const id = obj && typeof obj.subagent_id === 'string' ? obj.subagent_id : '';
    if (id) byId.set(id, desc);
    if (desc) last = desc;
  }
  return { byId, last };
}

// ---------------------------------------------------------------------------
// SubagentBoard — per-chat state + throttled Telegram flush.
//
// One board instance per chat. Entries are keyed by child session id. The
// board is "live" while any entry is working; it is "settled" when all are
// terminal (locked). A settled board stops being re-read (no further edits)
// until a new subagent starts, at which point it re-opens.
// ---------------------------------------------------------------------------
export class SubagentBoard {
  constructor(deps) {
    this.chatId = String(deps.chatId);
    // deps: sendText(text, opts) -> Promise<messageId|number>;
    //       editText(messageId, text) -> Promise<boolean>;
    //       pin(messageId) -> Promise<boolean>;
    //       unpin(messageId) -> Promise<boolean>;
    //       listAgents() -> Agent[];
    //       clock() -> number (ms);
    //       log(level, ...args);
    this.sendText = deps.sendText;
    this.editText = deps.editText;
    this.pin = deps.pin || (async () => false);
    this.unpin = deps.unpin || (async () => false);
    this.listAgents = deps.listAgents || (() => []);
    this.clock = deps.clock || (() => Date.now());
    this.log = deps.log || (() => {});
    this.pinEnabled = deps.pinEnabled !== false;
    this.maxRows = deps.maxRows || DEFAULT_MAX_ROWS;
    this.maxWorkWidth = deps.maxWorkWidth || DEFAULT_MAX_WORK_WIDTH;

    this.entries = new Map(); // childId -> entry
    this.startWall = new Map(); // childId -> wall-clock ms at start
    this.messageId = null; // the pinned board message id (null = not posted)
    this.lastRendered = '';
    this.lastFlushAt = 0;
    this.flushInFlight = false;
    this.dirty = false;
  }

  _entry(id) {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        id: String(id),
        label: '',
        status: 'working',
        work: '',
        locked: false,
        startedAt: this.clock(),
        endedAt: 0,
        stopReason: '',
      };
      this.entries.set(id, e);
      this.startWall.set(id, e.startedAt);
    }
    return e;
  }

  // `subagent/start` handler. A re-start of a locked entry (a continuable
  // child waking for a new epoch, or a re-spawn) re-opens it as working.
  onStart(info) {
    const id = info?.id != null ? String(info.id) : '';
    if (!id) return;
    const e = this._entry(id);
    e.status = 'working';
    e.locked = false;
    e.work = '';
    e.stopReason = '';
    e.endedAt = 0;
    this.startWall.set(id, this.clock());
    this.markDirty();
  }

  // `subagent/end` handler. Locks the row so it stops refreshing.
  onEnd(info) {
    const id = info?.id != null ? String(info.id) : '';
    if (!id) return;
    const e = this._entry(id);
    e.status = normalizeStopReason(info?.stopReason);
    e.locked = true;
    e.endedAt = this.clock();
    e.stopReason = String(info?.stopReason || '');
    // Capture a final "what it did" from the last assistant message, if any.
    const lastMsg = info?.lastAssistantMessage;
    if (Array.isArray(lastMsg)) {
      const t = lastMsg
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join(' ').trim();
      if (t) e.work = t;
    }
    this.markDirty();
  }

  // Re-read live child sessions for every working entry and refresh `work` +
  // a short label (from the child's descriptor or the parent's tool call).
  // Called by the ticker. No-op when nothing is working.
  refresh(parentSession) {
    let anyWorking = false;
    for (const e of this.entries.values()) if (e.status === 'working') { anyWorking = true; break; }
    if (!anyWorking) return;

    let agents;
    try { agents = this.listAgents() || []; } catch { agents = []; }
    // The board's entry key is the child session id (SubagentRun.id ===
    // childSessionId), so index the live agents by their session id, with the
    // raw agent id as a fallback when a session id is absent.
    const byId = new Map();
    for (const a of agents) {
      const sid = a?.session?.id ?? a?.id;
      if (sid != null) byId.set(String(sid), a);
      if (a?.id != null && !byId.has(String(a.id))) byId.set(String(a.id), a);
    }

    // Parent's subagent tool-call descriptions (fallback labels).
    const parentDesc = parentSession ? parentSubagentDescriptions(parentSession) : { byId: new Map(), last: '' };

    for (const e of this.entries.values()) {
      if (e.status !== 'working') continue;
      const child = byId.get(e.id);
      if (child) {
        e.missedTicks = 0;
        const session = child.session;
        // Status: a child that is no longer running is effectively done
        // (its end event may still be in flight; lock it conservatively).
        if (child.status && child.status !== 'running') {
          if (e.status === 'working') e.status = child.status === 'error' ? 'error' : 'completed';
          e.locked = e.status !== 'working';
          e.endedAt = e.endedAt || this.clock();
        }
        const label = labelFromSession(session) || parentDesc.byId.get(e.id) || parentDesc.last || e.label || e.id;
        e.label = label;
        e.work = latestActivity(session, 0);
      } else {
        // Not in the live list this tick. Give it a short grace period (the
        // child may still be materializing, or the end event is in flight);
        // after that, treat it as ended and lock the row.
        e.missedTicks = (e.missedTicks || 0) + 1;
        if (e.missedTicks >= GRACE_TICKS) {
          e.status = 'completed';
          e.locked = true;
          e.endedAt = this.clock();
          if (!e.work) e.work = '已结束';
        } else if (!e.work) {
          e.work = '正在启动…';
        }
        if (!e.label) e.label = parentDesc.last || e.id;
      }
    }
    this.markDirty();
  }

  // Drop entries that are terminal and were started before `now` by more than
  // a grace period — keeps the map bounded over very long sessions. Optional.
  prune(now) {
    const GRACE_MS = 30 * 60 * 1000;
    for (const [id, e] of this.entries) {
      if (e.locked && e.endedAt && now - e.endedAt > GRACE_MS) {
        this.entries.delete(id);
        this.startWall.delete(id);
      }
    }
  }

  get workingCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === 'working') n++;
    return n;
  }
  get doneCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.locked) n++;
    return n;
  }
  get hasWorking() { return this.workingCount > 0; }
  get isEmpty() { return this.entries.size === 0; }

  // Order: working first (oldest start first), then terminal (oldest end first).
  orderedEntries() {
    const working = [...this.entries.values()].filter((e) => e.status === 'working')
      .sort((a, b) => a.startedAt - b.startedAt);
    const done = [...this.entries.values()].filter((e) => e.locked)
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    return [...working, ...done];
  }

  render() {
    return renderBoardText(this.orderedEntries(), {
      working: this.workingCount,
      done: this.doneCount,
      now: this.clock(),
      maxRows: this.maxRows,
      maxWorkWidth: this.maxWorkWidth,
      startWall: this.startWall,
    });
  }

  markDirty() { this.dirty = true; }

  // Throttled flush: ensure the board message exists (send+pin), then edit it
  // when the rendered text changed and the throttle window has passed. Never
  // throws — a Telegram hiccup must never break the agent turn.
  async flush(force = false) {
    if (this.isEmpty) return;
    const text = this.render();
    const now = this.clock();
    const changed = text !== this.lastRendered;
    const windowOpen = now - this.lastFlushAt >= DEFAULT_THROTTLE_MS;
    if (!force && (!changed || !windowOpen)) {
      // Remember we want to push this later (the ticker will retry).
      if (changed) this.dirty = true;
      return;
    }
    if (this.flushInFlight) { this.dirty = true; return; }
    this.flushInFlight = true;
    try {
      if (!this.messageId) {
        const id = await this.sendText(text, { disableNotification: true });
        this.messageId = id != null ? Number(id) : null;
        if (this.messageId && this.pinEnabled) {
          try { await this.pin(this.messageId); } catch { /* best-effort */ }
        }
      } else {
        const ok = await this.editText(this.messageId, text);
        if (!ok) {
          // The board message was deleted (or otherwise uneditable): drop the id
          // so the next flush re-posts (and re-pins) a fresh board. (The client
          // treats "Message is not modified" as a success, so a no-op edit won't
          // get here.)
          this.messageId = null;
          return;
        }
      }
      this.lastRendered = text;
      this.lastFlushAt = this.clock();
      this.dirty = false;
    } catch (err) {
      this.log('warn', `subagent board flush failed: ${err.message}`);
      this.dirty = true;
    } finally {
      this.flushInFlight = false;
    }
  }

  // Teardown: unpin + delete the board message (e.g. on /new or session reset).
  async teardown() {
    const id = this.messageId;
    this.entries.clear();
    this.startWall.clear();
    this.messageId = null;
    this.lastRendered = '';
    this.dirty = false;
    if (!id) return;
    try { await this.unpin(id); } catch { /* best-effort */ }
  }
}
