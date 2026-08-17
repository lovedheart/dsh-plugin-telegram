// ---------------------------------------------------------------------------
// Telegram answerer for `ask_user_question` (the agent asks the user to pick
// an option or type their own answer, then pauses until answered).
//
// DSH mechanism (verified against @deepseek-ai/dsh-user-questions and
// @deepseek-ai/dsh-host-apiproxy, 0.1.0-rc.x):
//   • `ask_user_question` awaits `ctx.userQuestions.ask(request)`. The web
//     host registers the SINGLE provider: it mints an rpcId, pushes a
//     `question/requested` frame into the `/api/events.mux` SSE stream and
//     waits. There is no waterfall — so a Telegram-only user never sees the
//     question (the phone just waits forever).
//   • The answer is a `client-response` POST to `/api/respond` echoing the
//     rpcId, `result: {ok: true, value: {sessionId, answer: {answers:
//     [{id, selected: [labels], custom?}]}}}`. `matchesQuestions` requires:
//     one answer per question, in order, same id; `selected` ⊆ the question's
//     option labels (empty = skipped); single-select allows at most one
//     label; single-select custom must come with empty `selected`; multi
//     select may combine selected + custom. Cancellation is
//     `result: {ok: false, error: {code: "cancelled"}}`.
//   • First answer wins: `claimQuestion` deletes the pending entry
//     synchronously, so a late Telegram answer after the web UI answered gets
//     `{accepted: false, reason: "not-pending"}`.
//   • A new mux SSE connection REPLAYS every still-pending question, so a
//     reconnecting subscriber loses nothing.
//   • When a question settles (answered anywhere, cancelled, or the agent is
//     stopped), a `question/resolved` frame is broadcast with the outcome.
//
// This module subscribes to the web host's mux over loopback HTTP (same
// process, `DSH_WEB_URL` / 127.0.0.1:3080), claims questions that belong to
// Telegram agents (ownership policy lives in index.js, same as approval),
// posts an inline-keyboard card, and answers via `/api/respond`. Plain-text
// replies to a single-question card are consumed as a custom answer — the
// user can pick a button OR type their own prompt.
//
// Pure functions are exported for unit testing; the module receives every
// side effect (telegram client, respond(), ownership, log) as deps.
// ---------------------------------------------------------------------------

/** Callback_data prefix. Bumped on any wire-format change (64-byte limit). */
export const QUESTION_CALLBACK_PREFIX = 'tgq1:';

/** Max option labels per button row (Telegram row width). */
const OPTIONS_PER_ROW = 4;

/**
 * Parse a `tgq1:<key>:<action>` callback_data.
 * Actions: `q<qi>:<oi>` (select/toggle option oi of question qi), `submit`,
 * `cancel`. Returns { key, action, qi?, oi? } or null when not ours.
 */
export function parseQuestionCallback(data) {
  if (typeof data !== 'string' || !data.startsWith(QUESTION_CALLBACK_PREFIX)) return null;
  const parts = data.slice(QUESTION_CALLBACK_PREFIX.length).split(':');
  if (parts.length < 2) return null;
  const key = parts[0];
  if (!key) return null;
  const action = parts[1];
  if (action === 'submit') return { key, action: 'submit' };
  if (action === 'cancel') return { key, action: 'cancel' };
  if (action.startsWith('q') && action.length >= 2 && parts.length >= 3) {
    const qi = Number(action.slice(1));
    const oi = Number(parts[2]);
    if (!Number.isInteger(qi) || !Number.isInteger(oi)) return null;
    return { key, action: 'option', qi, oi };
  }
  return null;
}

/**
 * Build the card {text (plain — caller escapes nothing; we escape via dep),
 * keyboard}. `escape` is injected (index.js escapeHtml) so the module stays
// transport-agnostic. Layout:
 *   header line, then per question: [Qn] header? + question + detail (italic
 *   marker kept simple: <i>..</i>), then a status line for selections.
 * Keyboard: one row per question's options (chunked), then [✅ 提交] (only
 * when needed) + [❌ 取消].
 */
export function buildQuestionCard(questions, escape, selections = new Map()) {
  const esc = escape || ((s) => String(s ?? ''));
  const parts = ['❓ 需要你回答'];
  const keyboard = [];
  const multi = questions.length > 1;
  const needsSubmit = multi || questions.some((q) => q.multiSelect);

  questions.forEach((q, qi) => {
    if (multi || q.header) parts.push('', q.header ? esc(q.header) : '');
    parts.push(`${multi ? `Q${qi + 1}：` : ''}${esc(q.question)}`);
    if (q.detail) parts.push(`📄 ${esc(q.detail)}`);
    const opts = q.options || [];
    for (let i = 0; i < opts.length; i += OPTIONS_PER_ROW) {
      const row = opts.slice(i, i + OPTIONS_PER_ROW).map((o, j) => ({
        text: String(o.label || '').slice(0, 40) || `选项 ${i + j + 1}`,
        callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:q${qi}:${i + j}`,
      }));
      keyboard.push(row);
    }
    if (q.multiSelect) {
      const chosen = selections.get(q.id) || [];
      parts.push(chosen.length ? `🔘 已选：${esc(chosen.join('，'))}` : `🔘 可多选，选完点「✅ 提交」`);
    } else if (multi) {
      // Single-select inside a multi-question card: show the current choice so
      // the user can see it before hitting 提交 (a single-question card submits
      // on tap, so it needs no status line).
      const chosen = selections.get(q.id) || [];
      parts.push(chosen.length ? `🔘 已选：${esc(chosen.join('，'))}` : `🔘 未选择`);
    }
  });

  const finalRow = [];
  if (needsSubmit) finalRow.push({ text: '✅ 提交', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:submit` });
  finalRow.push({ text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` });
  keyboard.push(finalRow);

  if (questions.length === 1) parts.push('', '💬 也可以直接回复这条消息输入你的答案。');
  else parts.push('', '💬 请点按钮回答每个问题（未答的会跳过）。');

  return { text: parts.filter((p, i) => !(p === '' && i > 0 && parts[i - 1] === '')).join('\n'), keyboard };
}

/**
 * Create the Telegram question module.
 *
 * deps: {
 *   log(level, ...), escape(s),
 *   client — TelegramClient (sendMessage/editMessageText/answerCallbackQuery),
 *   ownership(sessionId) -> { chatId, threadId } | null   (index.js policy),
 *   respond(body) -> Promise<{accepted: bool, reason?}>   (POST /api/respond),
 * }
 *
 * Returns { handleFrame, handleCallbackQuery, consumeTextReply, cancelAll }.
 * `handleFrame` receives raw mux frames (both `question/requested` and
 * `question/resolved`); only frames for chats we own are acted on.
 */
export function createQuestionModule(deps) {
  const pending = new Map(); // key -> entry
  const seenRpcIds = new Set(); // rpcIds already claimed (replay dedup)
  let seq = 1;
  const makeKey = () => `q${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

  function settle(entry, outcome, note) {
    if (entry.outcome) return;
    entry.outcome = outcome;
    pending.delete(entry.key);
    // Forget the rpcId so a future (re-asked) question with the same id — which
    // DSH mints fresh per ask, but a reconnect replay could re-deliver — still
    // can't double-post. Bounded: entries leave the set on settle.
    seenRpcIds.delete(entry.rpcId);
    const label =
      outcome === 'answered' ? `✅ 已回答${note ? `：${note}` : ''}`
      : outcome === 'cancelled' ? '⌛ 已取消'
      : '🌐 已在网页端回答';
    if (entry.cardMessageId) {
      Promise.resolve()
        .then(() => deps.client.editMessageText(entry.chatId, entry.cardMessageId, label, undefined))
        .catch(() => { /* card may already be gone */ });
    }
  }

  /** Submit answers (or a cancel) for one pending entry; settles the card. */
  async function answer(entry, { answers, custom, cancel } = {}) {
    let body;
    if (cancel) {
      body = {
        type: 'client-response',
        rpcId: entry.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'cancelled from Telegram', details: {} } },
      };
    } else {
      body = {
        type: 'client-response',
        rpcId: entry.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: entry.sessionId,
            answer: {
              answers: entry.questions.map((q) => {
                const selected = (entry.selections.get(q.id) || []).slice();
                const out = { id: q.id, selected };
                if (custom && q.id === custom.id) out.custom = custom.text;
                return out;
              }),
            },
          },
        },
      };
    }
    let receipt;
    try {
      receipt = await deps.respond(body);
    } catch (err) {
      deps.log?.('error', `Question respond failed (will let web UI settle it): ${err.message}`);
      return false;
    }
    if (receipt?.accepted) {
      const note = custom
        ? custom.text.slice(0, 60)
        : answersNote(entry);
      settle(entry, cancel ? 'cancelled' : 'answered', cancel ? undefined : note);
      return true;
    }
    // not-pending: the web UI answered first (first answer wins).
    settle(entry, 'delegated');
    return false;
  }

  function answersNote(entry) {
    return entry.questions
      .map((q) => (entry.selections.get(q.id) || []).join('，'))
      .filter(Boolean)
      .join('；')
      .slice(0, 60);
  }

  function handleFrame(frame) {
    const payload = frame?.payload || {};
    if (payload.type === 'question/requested') {
      onRequested(frame.rpcId, payload);
    } else if (payload.type === 'question/resolved') {
      onResolved(payload);
    }
  }

  function onRequested(rpcId, payload) {
    const sessionId = payload.sessionId;
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    if (!rpcId || !sessionId || questions.length === 0) return;
    // Replay dedup: the mux re-delivers every still-pending question on each
    // (re)connect, so the same rpcId can arrive more than once. Guard on the
    // rpcId (pending is keyed by a fresh short token each time, so a
    // pending.has(rpcId) check would never match).
    if (seenRpcIds.has(rpcId)) return;
    const own = deps.ownership?.(sessionId);
    if (!own) return; // web-originated agent → the web UI owns this question
    seenRpcIds.add(rpcId);
    const key = makeKey();
    const entry = {
      key,
      rpcId,
      sessionId,
      questions,
      chatId: own.chatId,
      threadId: own.threadId ?? null,
      cardMessageId: null,
      selections: new Map(),
      outcome: null,
    };
    pending.set(key, entry);
    void (async () => {
      const { text, keyboard } = buildQuestionCard(questions, deps.escape, entry.selections);
      const real = keyboard.map((row) =>
        row.map((b) => ({ ...b, callback_data: b.callback_data.replace('KEY', key) })));
      try {
        const res = await deps.client.sendMessage({
          chatId: entry.chatId,
          text,
          parseMode: 'HTML',
          messageThreadId: entry.threadId,
          replyMarkup: { inline_keyboard: real },
          disableNotification: false,
        });
        entry.cardMessageId = res?.messageId ?? null;
        deps.log?.('info', `Question card posted for ${sessionId} (chat ${entry.chatId}, ${questions.length} question(s))`);
      } catch (err) {
        // Card delivery failed — do NOT claim: the web UI can still answer, and
        // a later replay of this rpcId may still be able to post.
        pending.delete(key);
        seenRpcIds.delete(rpcId);
        deps.log?.('warn', `Question card send failed (${err.message}); leaving it to the web UI.`);
      }
    })();
  }

  function onResolved(payload) {
    const rpcId = payload.questionRpcId;
    for (const entry of [...pending.values()]) {
      if (entry.rpcId === rpcId) {
        settle(entry, payload.outcome === 'answered' ? 'delegated' : 'cancelled');
        return;
      }
    }
  }

  /** Route a callback query; returns true when it was ours (acked). */
  async function handleCallbackQuery(query) {
    const parsed = parseQuestionCallback(query?.data);
    if (!parsed) return false;
    const entry = pending.get(parsed.key);
    const ack = (t) => deps.client.answerCallbackQuery(query.id, t).catch(() => {});
    if (!entry || entry.outcome) { ack('已过期'); return true; }

    if (parsed.action === 'cancel') {
      await ack('⌛');
      await answer(entry, { cancel: true });
      return true;
    }
    if (parsed.action === 'submit') {
      const q = entry.questions;
      const allDone = q.every((qq) => (entry.selections.get(qq.id) || []).length > 0);
      await ack(allDone ? '✅ 已提交' : '✅ 已提交（未答的跳过）');
      await answer(entry, {});
      return true;
    }
    // Option tap.
    const q = entry.questions[parsed.qi];
    const opt = q?.options?.[parsed.oi];
    if (!q || !opt) { ack('无效选项'); return true; }
    const label = String(opt.label || '');
    const cur = entry.selections.get(q.id) || [];
    if (q.multiSelect) {
      entry.selections.set(q.id, cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
      await ack('🔘');
      // Refresh the card body to show the current selection.
      const { text } = buildQuestionCard(entry.questions, deps.escape, entry.selections);
      if (entry.cardMessageId) {
        deps.client.editMessageText(entry.chatId, entry.cardMessageId, text, 'HTML').catch(() => {});
      }
    } else {
      entry.selections.set(q.id, [label]);
      if (entry.questions.length === 1) {
        // Single-question card: the tap IS the answer — submit immediately.
        await ack('✅');
        await answer(entry, {});
      } else {
        // Multi-question card: only record the choice; wait for 提交. Without
        // this guard a single-select tap would submit the whole card and any
        // remaining (e.g. multi-select) questions would be silently skipped.
        await ack('🔘');
        const { text } = buildQuestionCard(entry.questions, deps.escape, entry.selections);
        if (entry.cardMessageId) {
          deps.client.editMessageText(entry.chatId, entry.cardMessageId, text, 'HTML').catch(() => {});
        }
      }
    }
    return true;
  }

  /**
   * Consume a plain-text Telegram reply as a custom answer. Only valid while
   * exactly one single-or-multi question card is pending for that chat and the
   * text is not empty. Returns true when consumed.
   */
  function consumeTextReply(chatId, text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const chatKey = String(chatId);
    // Most recent pending card for this chat.
    let entry = null;
    for (const p of [...pending.values()].reverse()) {
      if (String(p.chatId) === chatKey) { entry = p; break; }
    }
    if (!entry || entry.outcome || entry.questions.length !== 1) return false;
    void answer(entry, { custom: { id: entry.questions[0].id, text: t } });
    return true;
  }

  /** Unload: settle everything locally (fire no network — we are going down). */
  function cancelAll() {
    for (const entry of [...pending.values()]) {
      if (!entry.outcome) {
        entry.outcome = 'cancelled';
        pending.delete(entry.key);
      }
    }
  }

  return { handleFrame, handleCallbackQuery, consumeTextReply, cancelAll, pending };
}

// ---------------------------------------------------------------------------
// Loopback mux SSE subscriber (fetch + stream). Reconnects with backoff;
// pending questions are replayed on every (re)connect, so nothing is lost.
// ---------------------------------------------------------------------------

/**
 * Parse accumulated SSE text into frames. Returns { frames, rest } where
 * rest is the trailing partial event. Each event may carry several `data:`
 * lines (joined); comments (`: ...`) and non-data lines are ignored.
 */
export function parseSseFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('');
    if (!data) continue;
    try { frames.push(JSON.parse(data)); } catch { /* partial/garbage: skip */ }
  }
  return { frames, rest };
}

/**
 * Subscribe to `${url}/api/events.mux`. Every question frame is passed to
 * onFrame(frame). Returns { stop() }.
 */
export function createMuxSubscriber({ url, onFrame, log }) {
  let stopped = false;
  let attempt = 0;
  let timer = null;
  let ctrl = null;

  async function loop() {
    while (!stopped) {
      try {
        ctrl = new AbortController();
        const res = await fetch(`${url.replace(/\/$/, '')}/api/events.mux`, {
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`mux HTTP ${res.status}`);
        attempt = 0;
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          if (stopped) break;
          buf += dec.decode(chunk, { stream: true });
          const { frames, rest } = parseSseFrames(buf);
          buf = rest;
          for (const f of frames) {
            const t = f?.payload?.type ?? f?.method;
            if (t === 'question/requested' || t === 'question/resolved') {
              try { onFrame(f); } catch (err) { log?.('warn', `mux onFrame error: ${err.message}`); }
            }
          }
        }
      } catch (err) {
        if (stopped) break;
        log?.('warn', `mux subscriber disconnected (${err.message}); will reconnect`);
      }
      if (stopped) break;
      const delay = Math.min(10000, 1000 * 2 ** attempt++);
      await new Promise((r) => { timer = setTimeout(r, delay); });
    }
  }
  void loop();

  return {
    stop() {
      stopped = true;
      try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
      try { ctrl?.abort(); } catch { /* ignore */ }
    },
  };
}
