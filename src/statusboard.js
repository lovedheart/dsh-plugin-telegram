// Status board + /goal + /plan helpers (v0.7.0).
//
// Three pieces live here, all dependency-free (no DSH imports) so the plugin
// keeps loading in a bare Node host and everything here is unit-testable:
//
//   • parseGoalCommand — the `/goal` grammar, ported from
//     @deepseek-ai/dsh-command-goal so the Telegram replies read like the web
//     `/goal` output (show/create/edit/pause/resume/clear).
//   • goalViewLine / goalHint / formatGoalReport — render a goal *view*
//     (the shape returned by the goals service: {id, revision, objective,
//     phase, maxGoalRounds, blockedReason?} + roundsStarted/activation) into
//     plain text. The plugin never imports dsh-goal; it reads the view the
//     running service hands back and only validates the fields it prints.
//   • StatusBoard — the pinned "session status" message (one per bot+chat).
//     A snapshot is {sessionId, plan: {active, pending}, goal: view|null,
//     autopilot: bool}; renderStatus turns it into plain text and tells the
//     caller whether the chat still needs the pinned message at all.

const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete']);

// ---------------------------------------------------------------------------
// /goal grammar (mirrors @deepseek-ai/dsh-command-goal parseGoalCommand)
// ---------------------------------------------------------------------------

// Parse only the control words `/goal` owns; anything else is an objective.
export function parseGoalCommand(rawInput) {
  const input = String(rawInput ?? '').trim();
  if (input.length === 0) return { kind: 'show' };
  const lower = input.toLowerCase();
  if (lower === 'clear') return { kind: 'clear' };
  if (lower === 'pause') return { kind: 'pause' };
  if (lower === 'resume') return { kind: 'resume' };
  if (lower === 'edit') return { kind: 'invalid-edit' };
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() };
  return { kind: 'create', objective: input };
}

export const GOAL_USAGE = '用法：/goal [<目标>|edit <目标>|pause|resume|clear]';

// Chinese labels for the four durable goal phases (the view carries English).
export function phaseLabel(phase) {
  switch (phase) {
    case 'active': return '进行中';
    case 'paused': return '已暂停';
    case 'blocked': return '受阻';
    case 'complete': return '已完成';
    default: return String(phase ?? '?');
  }
}

// Commands meaningful from one live goal state (same table as the web /goal).
export function goalHint(goal) {
  if (!goal) return GOAL_USAGE;
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <目标> · /goal pause · /goal clear'
      : '/goal edit <目标> · /goal resume（重新武装自动续跑）· /goal clear';
  }
  if (goal.phase === 'paused' || goal.phase === 'blocked') return '/goal edit <目标> · /goal resume · /goal clear';
  if (goal.phase === 'complete') return '/goal <新目标> 开始下一个 · /goal clear';
  return GOAL_USAGE;
}

// Multi-line report for /goal replies (plain text; the caller HTML-escapes).
export function formatGoalReport(title, goal) {
  if (!goal) return `${title}\n（没有目标）`;
  const lines = [
    title,
    `状态：${phaseLabel(goal.phase)}（${goal.phase}）`,
  ];
  if (goal.phase === 'blocked' && goal.blockedReason) {
    lines.push(`受阻原因：${goal.blockedReason.code ?? ''} ${goal.blockedReason.message ?? ''}`.trim());
  }
  lines.push(`目标：${goal.objective}`);
  const rounds = Number.isFinite(goal.roundsStarted) ? goal.roundsStarted : 0;
  lines.push(`轮次：${rounds}/${goal.maxGoalRounds ?? '?'}`);
  if (goal.activation) lines.push(`自动续跑：${goal.activation === 'armed' ? '已武装' : '未武装'}`);
  lines.push(`操作：${goalHint(goal)}`);
  return lines.join('\n');
}

// One compact line for the pinned status board. Objective clipped so a long
// goal can never push the board past Telegram's 4096-char message limit.
export function goalViewLine(goal, maxObjectiveChars = 120) {
  if (!goal) return null;
  const obj = String(goal.objective ?? '').replace(/\s+/g, ' ').trim();
  const clipped = obj.length > maxObjectiveChars ? `${obj.slice(0, maxObjectiveChars - 1)}…` : obj;
  const rounds = Number.isFinite(goal.roundsStarted) ? goal.roundsStarted : 0;
  return `🎯 目标［${phaseLabel(goal.phase)}］：${clipped}（${rounds}/${goal.maxGoalRounds ?? '?'} 轮）`;
}

// ---------------------------------------------------------------------------
// Status snapshot → pinned message text
// ---------------------------------------------------------------------------

// Is there anything worth pinning? Neutral chats (default mode, no goal,
// autopilot off) get NO pinned message — the board self-cleans via teardown.
// A git line counts as meaningful too: with `statusBoardGit` on, a workspace
// repo is itself the reason to pin (that's the coding dashboard — branch +
// dirty count), while a non-git workspace still self-cleans.
export function statusIsMeaningful(snapshot) {
  return !!(snapshot?.plan?.active || snapshot?.plan?.pending
    || snapshot?.goal
    || snapshot?.autopilot
    || snapshot?.gitLine);
}

// Render the pinned status message (plain text — a goal objective may contain
// raw < > & characters, so the board always sends/edits with no parse_mode).
// Returns { text, meaningful }.
// Last path segment of a workspace cwd, for the one-line 📁 row. Trailing
// slashes stripped first so `/a/b/` reads `b`; root and empty stay as-is.
export function workspaceLabel(cwd) {
  const raw = String(cwd ?? '').trim();
  const stripped = raw.replace(/[/\\]+$/, '');
  if (!stripped) return raw.includes('/') ? '/' : '';
  return stripped.split(/[/\\]/).filter(Boolean).pop() || stripped;
}

export function renderStatus(snapshot) {
  const plan = snapshot?.plan ?? {};
  const goal = snapshot?.goal ?? null;
  const lines = [];
  const sid = String(snapshot?.sessionId ?? '').trim();
  lines.push(`📌 会话状态${snapshot?.sessionShort ? ` <${snapshot.sessionShort}>` : ''}`);
  // Which project folder this session is working in (basename only — a full
  // path wraps on a phone). Like gitLine, it rides along and never justifies
  // pinning the board by itself.
  if (snapshot?.workspace) lines.push(`📁 ${snapshot.workspace}`);
  // Optional workspace git line (branch / dirty / ahead-behind). Rides along
  // when present; never decides whether the board exists (see
  // statusIsMeaningful) — a plain chat must still self-clean.
  if (snapshot?.gitLine) lines.push(snapshot.gitLine);
  if (plan.active) {
    lines.push(`🗺️ 计划模式：${plan.pending === false ? '退出中（下一步生效）' : '开启'}${plan.pending === true ? '（下一步生效）' : ''}`);
  } else {
    lines.push(plan.pending === true ? '🗺️ 计划模式：进入中（下一步生效）' : '🗺️ 计划模式：关闭');
  }
  const goalLine = goalViewLine(goal);
  if (goalLine) lines.push(goalLine);
  else lines.push('🎯 目标：无（/goal <目标> 设置长任务目标）');
  lines.push(snapshot?.autopilot ? '🤖 Autopilot：开启（免审批+自动答题）' : '🤖 Autopilot：关闭');
  if (sid) lines.push(`会话：${sid}`);
  return { text: lines.join('\n'), meaningful: statusIsMeaningful(snapshot) };
}

// ---------------------------------------------------------------------------
// StatusBoard — one pinned status message per (bot, chat)
// ---------------------------------------------------------------------------
//
// Same lifecycle contract as SubagentBoard: send once → pin → edit in place;
// a deleted/uneditable message is re-posted on the next refresh; teardown()
// (generation bump) unpin+deletes and invalidates in-flight flushes. Unlike
// the subagent board there is no ticker-owned state: refresh(snapshot) is
// idempotent — identical text is a no-op, so a 5 s poll costs nothing.
export class StatusBoard {
  constructor(deps) {
    this.chatId = String(deps.chatId);
    // deps: sendText(text, opts) -> Promise<messageId|number[]>;
    //       editText(messageId, text) -> Promise<boolean>;
    //       pin(messageId) -> Promise<boolean>;
    //       unpin(messageId) -> Promise<boolean>;
    //       deleteMessage(messageId) -> Promise;
    //       pinEnabled, log(level, ...args)
    this.sendText = deps.sendText;
    this.editText = deps.editText;
    this.pin = deps.pin || (async () => false);
    this.unpin = deps.unpin || (async () => false);
    this.deleteMessage = typeof deps.deleteMessage === 'function' ? deps.deleteMessage : null;
    this.pinEnabled = deps.pinEnabled !== false;
    this.log = deps.log || (() => {});
    this.messageId = null;
    this.lastRendered = '';
    this.flushInFlight = false;
    this._gen = 0;
  }

  // Push the current snapshot. When the chat has nothing to report, tear the
  // board down (unpin + delete) so stale pins never linger. Best-effort:
  // Telegram failures are swallowed (the next refresh retries).
  async refresh(snapshot) {
    const { text, meaningful } = renderStatus(snapshot);
    if (!meaningful) {
      if (this.messageId) await this.teardown();
      this.lastRendered = '';
      return;
    }
    if (this.flushInFlight) return; // a concurrent refresh is enough for both
    if (text === this.lastRendered && Number.isFinite(this.messageId) && this.messageId > 0) return;
    this.flushInFlight = true;
    const gen = this._gen;
    try {
      if (!(Number.isFinite(this.messageId) && this.messageId > 0)) {
        const sent = await this.sendText(text, { disableNotification: true });
        const first = Array.isArray(sent) ? sent[0] : sent;
        this.messageId = Number.isFinite(Number(first)) && Number(first) > 0 ? Number(first) : null;
        if (this._gen !== gen) {
          // Torn down during the send — delete the orphan instead of adopting.
          if (this.messageId && this.deleteMessage) {
            try { await this.deleteMessage(this.messageId); } catch { /* best-effort */ }
          }
          this.messageId = null;
          return;
        }
        if (this.messageId && this.pinEnabled) {
          try { await this.pin(this.messageId); } catch { /* best-effort */ }
        }
      } else {
        const ok = await this.editText(this.messageId, text);
        if (this._gen !== gen) return;
        if (!ok) { this.messageId = null; return; } // deleted externally → re-post next time
      }
      if (this._gen !== gen) return;
      this.lastRendered = text;
    } catch (err) {
      this.log('warn', `status board refresh failed: ${err?.message ?? String(err)}`);
    } finally {
      this.flushInFlight = false;
    }
  }

  // Unpin + delete the pinned status message (on teardown / chat reset /
  // unload). The generation bump makes in-flight refreshes drop their result.
  async teardown() {
    this._gen = (this._gen || 0) + 1;
    const id = this.messageId;
    this.messageId = null;
    this.lastRendered = '';
    if (!id) return;
    try { await this.unpin(id); } catch { /* best-effort */ }
    try { if (this.deleteMessage) await this.deleteMessage(id); } catch { /* best-effort */ }
  }
}
