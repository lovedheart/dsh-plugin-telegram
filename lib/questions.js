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
// Wide-char-aware display width: CJK / fullwidth / emoji ≈ 2 columns, others 1.
// Used to decide how many option buttons fit one phone-screen row without their
// text being clipped (a fixed 4-per-row layout truncated long CJK labels).
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

// Max buttons per row given the widest label in the group. A button in an
// N-wide row gets roughly (screen − paddings)/N of the width; these
// conservative thresholds keep labels unclipped on a typical phone.
export function buttonsPerRow(maxWidth) {
  if (maxWidth <= 12) return 4;
  if (maxWidth <= 16) return 3;
  if (maxWidth <= 24) return 2;
  return 1;
}

// Resolve a question's effective multi-select flag. An explicit boolean always
// wins (the model said so). Only when the flag is ABSENT do we infer intent
// from the wording — models frequently write a "（多选）/以下哪些…" question but
// forget `multi_select: true`, which made the card behave as single-select and
// auto-submit on the first tap. We never override an explicit `false`.
export function effectiveMultiSelect(q) {
  if (typeof q?.multiSelect === 'boolean') return q.multiSelect;
  const text = `${q?.header || ''} ${q?.question || ''}`;
  return /多选|可多选|可勾|哪些|任选|选择所有|select all|multiple[- ]select/i.test(text);
}

// Autopilot (v0.5.0): pick the option(s) to auto-adopt for one question.
// The convention (README/AGENT_INTEGRATION + the per-message hint the plugin
// injects) is that the agent puts its RECOMMENDED option first and tags its
// label with 推荐 / recommended. We scan label+description for that marker and
// lock onto it; with no marker we fall back to the FIRST option (the convention
// says the recommended one goes first). Returns RAW option labels (the harness
// validates submitted `selected` against the raw labels, so the truncated
// display text must NOT be used). Multi-select returns every flagged option;
// single-select returns at most one. Empty array = nothing to auto-pick (the
// caller then falls back to the normal wait-for-user card).
export function pickRecommended(q) {
  const opts = Array.isArray(q?.options) ? q.options : [];
  const labels = opts.map((o) => (typeof o?.label === 'string' && o.label ? o.label : ''));
  const flagged = [];
  opts.forEach((o, i) => {
    const hay = `${o?.label || ''} ${o?.description || ''}`;
    if (labels[i] && /推荐|recommend/i.test(hay)) flagged.push(labels[i]);
  });
  if (flagged.length) {
    return effectiveMultiSelect(q) ? flagged : flagged.slice(0, 1);
  }
  const first = labels.find((l) => l) || '';
  return first ? [first] : [];
}

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
  if (action === 'adopt') return { key, action: 'adopt' }; // autopilot: commit now
  if (action === 'takeover') return { key, action: 'takeover' }; // autopilot: go manual
  if (action === 'lock' && parts.length >= 3 && parts[2].startsWith('q')) {
    const qi = Number(parts[2].slice(1));
    if (!Number.isInteger(qi)) return null;
    return { key, action: 'lock', qi };
  }
  if (action.startsWith('q') && action.length >= 2 && parts.length >= 3) {
    const qi = Number(action.slice(1));
    const oi = Number(parts[2]);
    if (!Number.isInteger(qi) || !Number.isInteger(oi)) return null;
    return { key, action: 'option', qi, oi };
  }
  return null;
}

// Shared option-label preparation (40-char truncation + description capture).
function labeledOptions(q) {
  const opts = q.options || [];
  return opts.map((o, idx) => ({
    idx,
    text: String(o?.label || '').slice(0, 40) || `选项 ${idx + 1}`,
    desc: o?.description ? String(o.description) : '',
  }));
}

// Adaptive row packing: long CJK labels get one button per row (never clipped
// on a phone); short labels (是/否/OK) still share a row.
function optionRows(qi, labeled, disabled) {
  const perRow = labeled.length
    ? buttonsPerRow(Math.max(...labeled.map((o) => displayWidth(o.text))))
    : 1;
  const rows = [];
  for (let i = 0; i < labeled.length; i += perRow) {
    rows.push(labeled.slice(i, i + perRow).map((o) => ({
      text: o.text,
      callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:q${qi}:${o.idx}`,
      ...(disabled ? { is_disabled: true } : {}),
    })));
  }
  return rows;
}

// Locked keyboard for a SETTLED card: the control buttons stay on screen but
// disabled (is_disabled), so Telegram renders them greyed-out and tapping fires
// no callback — the question "freezes" in place with its choices visible and
// nothing re-selectable. The option rows keep their real labels (so the
// question still reads normally); only the final control row is locked.
//   kind 'single'  → single-question card  → [🔒 已提交]
//   kind 'multiq'  → one card in a multi-question flow → [🔒 已提交本题]
//   kind 'summary' → progress/summary card   → [🔒 已提交全部]
// `qi` only disambiguates the lock callback_data on the per-question card.
export function lockedKeyboard(kind, key, qi = 0) {
  const cb = (a) => `${QUESTION_CALLBACK_PREFIX}${key || 'KEY'}:${a}`;
  const lock = kind === 'summary'
    ? { text: '🔒 已提交全部', callback_data: cb('submit') }
    : kind === 'multiq'
      ? { text: '🔒 已提交本题', callback_data: cb(`lock:q${qi}`) }
      : { text: '🔒 已提交', callback_data: cb('lock:q0') };
  return [
    [{ ...lock, is_disabled: true }],
    [{ text: '❌ 取消', callback_data: cb('cancel'), is_disabled: true }],
  ];
}

// Question body lines: question, detail?, numbered option descriptions
// (models frequently put the real substance in option.description — it used
// to be silently dropped, making cards look "incomplete". Numbering follows
// button order.) NOTE: the header is NOT included here — both card builders
// push it themselves (including it here too printed 「第N题」 twice).
function questionBodyParts(q, qi, multi, esc) {
  const parts = [];
  parts.push(`${multi ? `Q${qi + 1}：` : ''}${esc(q.question)}`);
  if (q.detail) parts.push(`📄 ${esc(q.detail)}`);
  const withDesc = labeledOptions(q).filter((o) => o.desc);
  if (withDesc.length) {
    parts.push('📝 选项说明（按按钮顺序）：');
    for (const o of withDesc) parts.push(`${o.idx + 1}. ${esc(o.text)}：${esc(o.desc)}`);
  }
  return parts;
}

const joinLines = (parts) => parts.filter((p, i) => !(p === '' && i > 0 && parts[i - 1] === '')).join('\n');

// One-line status for a SETTLED card. `settled` = { outcome, note }; `chosen`
// is the question's selected labels (per-question scope). The question text
// and options stay on screen (see the builders); this line just records the
// final state. Note: when the web GUI answered first (delegated) we say a
// neutral "已作答" — the resolved frame carries no per-option payload and
// pointing the user at the web UI was the source of the "题目消失" complaint.
function settleStatusLine(esc, settled, chosen) {
  if (settled.outcome === 'answered') {
    const what = chosen.length ? esc(chosen.join('，')) : (settled.note ? esc(settled.note) : '');
    return what ? `🔒 已提交：${what}` : '🔒 已提交';
  }
  if (settled.outcome === 'cancelled') return '⌛ 已取消';
  if (settled.outcome === 'rejected') return '⚠️ 提交被拒绝，请重新提问';
  return '🔒 已作答';
}

/**
 * Build a SINGLE-question card {text (plain — caller escapes nothing; we
 * escape via dep), keyboard}. `escape` is injected (index.js escapeHtml) so
 * the module stays transport-agnostic. Layout: header line, then question +
 * detail + option descriptions, then a status line for selections. Keyboard:
 * adaptive option rows, then [✅ 提交] (only when multi-select) + [❌ 取消].
 * A plain-text reply to this card is consumed as a custom answer.
 */
export function buildQuestionCard(questions, escape, selections = new Map(), settled = null) {
  const esc = escape || ((s) => String(s ?? ''));
  const q = questions[0];
  const parts = ['❓ 需要你回答'];
  const keyboard = [];
  if (q.header) parts.push('', esc(q.header));
  parts.push(...questionBodyParts(q, 0, false, esc));
  const chosen = selections.get(q.id) || [];
  if (settled) {
    // Card is final: keep the question and the chosen options on screen,
    // disable every button (nothing can be re-selected), drop the type-a-reply
    // hint (a reply would only be treated as a fresh custom answer).
    keyboard.push(...optionRows(0, labeledOptions(q), true));
    parts.push(settleStatusLine(esc, settled, chosen));
    keyboard.push(...lockedKeyboard('single', 'KEY'));
  } else {
    keyboard.push(...optionRows(0, labeledOptions(q), false));
    if (q.multiSelect) {
      // Keep the "how to finish" hint visible AFTER selecting too — otherwise
      // the user taps an option, sees only "已选：xxx", and has no idea the
      // answer still needs an explicit 提交 tap.
      parts.push(chosen.length
        ? `🔘 已选：${esc(chosen.join('，'))}（可继续点选，完成后点「✅ 提交」）`
        : `🔘 可多选，选完点「✅ 提交」`);
    }
    const finalRow = [];
    if (q.multiSelect) finalRow.push({ text: '✅ 提交', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:submit` });
    finalRow.push({ text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` });
    keyboard.push(finalRow);
    parts.push('', '💬 也可以直接回复这条消息输入你的答案。');
  }
  return { text: joinLines(parts), keyboard };
}

/**
 * Build ONE question's card in a MULTI-question flow {text, keyboard}. Each
 * question gets its own message so its option buttons sit directly under its
 * own text — Telegram renders an inline keyboard below the WHOLE message, so
 * a combined card listed all questions first and all option buttons after,
 * which read as "questions and options separated". The card carries a
 * per-question lock button (✅ 提交本题); the shared 🏁 提交全部 lives on the
 * summary card (buildSummaryCard).
 */
export function buildQuestionCardFor(q, qi, total, escape, selections = new Map(), locked = new Set(), settled = null) {
  const esc = escape || ((s) => String(s ?? ''));
  const isLocked = locked.has(q.id);
  const parts = [`❓ 需要你回答（${qi + 1}/${total}）`];
  if (q.header) parts.push('', esc(q.header));
  parts.push(...questionBodyParts(q, qi, true, esc));
  const chosen = selections.get(q.id) || [];
  const keyboard = optionRows(qi, labeledOptions(q), Boolean(settled) || isLocked);
  if (settled) {
    // Final state: keep the question + chosen options on screen, lock every
    // button. Per-question status depends on the outcome (see settleStatusLine).
    parts.push(settleStatusLine(esc, settled, chosen));
    keyboard.push(...lockedKeyboard('multiq', 'KEY', qi));
  } else if (isLocked) {
    parts.push(chosen.length ? `🔒 已提交：${esc(chosen.join('，'))}` : '🔒 未作答（已跳过）');
    keyboard.push([{ text: '🔒 已提交本题', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:lock:q${qi}`, is_disabled: true }, { text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` }]);
  } else if (q.multiSelect) {
    parts.push(chosen.length
      ? `🔘 已选：${esc(chosen.join('，'))}（可继续点选，然后点「✅ 提交本题」）`
      : `🔘 可多选，选完点「✅ 提交本题」`);
    keyboard.push([{ text: '✅ 提交本题', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:lock:q${qi}` }, { text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` }]);
  } else {
    parts.push(chosen.length ? `🔘 已选：${esc(chosen.join('，'))}` : '🔘 未选择');
    keyboard.push([{ text: '✅ 提交本题', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:lock:q${qi}` }, { text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` }]);
  }
  return { text: joinLines(parts), keyboard };
}

/**
 * Build the progress/summary card for a MULTI-question flow {text, keyboard}.
 * Posted after all per-question cards (so it sits at the bottom of the chat).
 * Its 🏁 提交全部 button submits whatever has been selected so far —
 * unanswered questions go back empty (skipped).
 */
export function buildSummaryCard(entry, escape, settled = null) {
  const esc = escape || ((s) => String(s ?? ''));
  const total = entry.questions.length;
  const done = entry.questions.filter((q) => entry.locked.has(q.id)).length;
  if (settled) {
    // Final progress card: every question is done, so mark all ✅, drop the
    // instructional hint, and lock the submit row.
    const parts = [`📝 答题进度：${total}/${total}`];
    entry.questions.forEach((q, qi) => {
      parts.push(`✅ ${esc(q.header || `第${qi + 1}题`)}`);
    });
    parts.push('', settleStatusLine(esc, settled, []));
    const keyboard = [
      [{ text: '🔒 已提交全部', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:submit`, is_disabled: true }],
      [{ text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel`, is_disabled: true }],
    ];
    return { text: joinLines(parts), keyboard };
  }
  const parts = [`📝 答题进度：${done}/${total}`];
  entry.questions.forEach((q, qi) => {
    parts.push(`${entry.locked.has(q.id) ? '✅' : '⬜'} ${esc(q.header || `第${qi + 1}题`)}`);
  });
  parts.push('', '💬 逐题点「✅ 提交本题」确认；完成后点「🏁 提交全部」交卷。');
  const keyboard = [[
    { text: '🏁 提交全部', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:submit` },
    { text: '❌ 取消', callback_data: `${QUESTION_CALLBACK_PREFIX}KEY:cancel` },
  ]];
  return { text: joinLines(parts), keyboard };
}

/**
 * Send via client.sendMessage, retrying Telegram rate limits (429 carries
 * retryAfter). Multi-question flows post several messages in a burst, which
 * can trip per-chat flood control. Non-rate-limit errors propagate at once.
 */
async function sendWithRetry(sendFn, log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      const retryAfter = Number(err?.retryAfter);
      if (!(Number.isFinite(retryAfter) && retryAfter > 0) || attempt >= 3) throw err;
      log?.('warn', `Telegram rate limited (${err.message}); retrying in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
    }
  }
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
    // Keep the question on screen: instead of collapsing each card to a single
    // status line (the old behaviour made the whole question "disappear"),
    // re-render it with its options disabled (locked — nothing can be
    // re-selected) and a final status line showing what was chosen. The web
    // answer path (delegated) no longer says "已在网页端回答" — it uses a
    // neutral label, per the user's request.
    const settled = { outcome, note };
    const edit = (mid, text, kb) => {
      if (!mid) return;
      Promise.resolve()
        .then(() => deps.client.editMessageText(entry.chatId, mid, text, 'HTML', kb ? { inline_keyboard: kb } : undefined))
        .catch(() => { /* card may already be gone */ });
    };
    const subKey = (kb) => kb.map((row) =>
      row.map((b) => ({ ...b, callback_data: b.callback_data.replace('KEY', entry.key) })));
    if (entry.questions.length === 1) {
      const { text, keyboard } = buildQuestionCard(entry.questions, deps.escape, entry.selections, settled);
      edit(entry.cardMessageIds[0], text, subKey(keyboard));
    } else {
      entry.questions.forEach((q, qi) => {
        const { text, keyboard } = buildQuestionCardFor(entry.questions[qi], qi, entry.questions.length, deps.escape, entry.selections, entry.locked, settled);
        edit(entry.cardMessageIds[qi], text, subKey(keyboard));
      });
      const s = buildSummaryCard(entry, deps.escape, settled);
      edit(entry.summaryMessageId, s.text, subKey(s.keyboard));
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
                const out = { id: q.id };
                if (q.rawMultiSelect !== true && selected.length > 1) {
                  // The harness validates answers strictly against the RAW tool
                  // args: a question without explicit multi_select:true rejects
                  // >1 selected ('bad-response') and the agent turn stays
                  // blocked forever. We render such questions as multi-select
                  // when the wording says so (effectiveMultiSelect), so carry
                  // the full answer as a custom string instead of dropping
                  // picks.
                  out.selected = [];
                  out.custom = selected.join('、');
                } else {
                  out.selected = selected;
                }
                if (custom && q.id === custom.id) out.custom = custom.text;
                return out;
              }),
            },
          },
        },
      };
    }
    let receipt;
    // We are about to POST our answer. The web host, upon accepting it,
    // broadcasts a `question/resolved` frame back to us — that echo is OUR own
    // settlement, not the web UI answering. Keep `settling` true across the
    // whole await + settle so onResolved ignores the frame: the respond()
    // receipt (below) is the authoritative signal for our own submit, so a
    // racing frame can neither mislabel it "已作答" nor win the race. The flag
    // is intentionally NOT cleared afterwards — the entry leaves `pending` in
    // settle(), so the flag becomes inert.
    entry.settling = true;
    try {
      receipt = await deps.respond(body);
    } catch (err) {
      // Respond failed: we never settled, so a LATER web-first frame must be
      // allowed to settle the card — clear the guard (the entry stays pending).
      entry.settling = false;
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
    // not-pending: the web UI answered first (first answer wins). Anything else
    // (e.g. bad-response) means OUR payload was rejected — say so instead of
    // the misleading "answered elsewhere" label.
    settle(entry, receipt?.reason === 'not-pending' ? 'delegated' : 'rejected');
    return false;
  }

  function answersNote(entry) {
    return entry.questions
      .map((q) => (entry.selections.get(q.id) || []).join('，'))
      .filter(Boolean)
      .join('；')
      .slice(0, 60);
  }

  // ---------------------------------------------------------------------
  // Autopilot (v0.5.0) — auto-adopt the recommended option for a question the
  // agent asked while its chat is in autopilot mode. Posts a notice card
  // listing ALL options + which one was auto-locked, then auto-commits after a
  // short takeover window (deps.autopilotWindowMs; 0 = immediate). The user can
  // tap "⏩ 立即采纳" (commit now) or "✋ 接管" (disable autopilot + answer
  // manually) before the window elapses. First action wins (host is
  // first-answer-wins). If no option can be auto-picked we fall back to the
  // normal interactive card.
  // ---------------------------------------------------------------------
  function autopilotSubKey(kb, key) {
    return kb.map((row) => row.map((b) => ({ ...b, callback_data: b.callback_data.replace('KEY', key) })));
  }

  function autopilotKeyboard(key, totalQ) {
    return [
      [{ text: '🔒 已自动采纳', callback_data: `${QUESTION_CALLBACK_PREFIX}${key}:lock:q0`, is_disabled: true }],
      [
        { text: '⏩ 立即采纳', callback_data: `${QUESTION_CALLBACK_PREFIX}${key}:adopt` },
        { text: '✋ 接管(停止autopilot)', callback_data: `${QUESTION_CALLBACK_PREFIX}${key}:takeover` },
      ],
    ];
  }

  function autopilotStatusLine(esc, chosen, windowSec) {
    const what = chosen.length ? esc(chosen.join('，')) : '';
    const base = `🤖 Autopilot 已锁定推荐方案${what ? `：${what}` : ''}`;
    return windowSec > 0 ? `${base}\n${windowSec}s 内可点「✋ 接管」改手动选择，或「⏩ 立即采纳」立即交卷。` : `${base}\n点「✋ 接管」可改手动选择。`;
  }

  function buildAutopilotCard(q, qi, total, escape, chosen, key, windowMs) {
    const esc = escape || ((s) => String(s ?? ''));
    const win = Math.round((windowMs || 0) / 1000);
    const parts = [total > 1 ? `🤖 Autopilot 自动答题（${qi + 1}/${total}）` : '🤖 Autopilot 自动答题'];
    if (q.header) parts.push('', esc(q.header));
    parts.push(...questionBodyParts(q, qi, total > 1, esc));
    parts.push('', autopilotStatusLine(esc, chosen, win));
    return { text: joinLines(parts), keyboard: autopilotKeyboard(key, total) };
  }

  // Auto-adopt for one pending entry. Pre-fills the recommended selections,
  // posts a per-question notice card, then schedules the auto-commit. Returns
  // false (→ caller uses the normal interactive flow) when no option can be
  // auto-picked.
  async function autopilotAdopt(entry) {
    const win = Math.max(0, Number(deps.autopilotWindowMs) || 0);
    // Fill selections with the recommended option(s); bail if any question has
    // none (never auto-submit a partial / empty answer).
    for (const q of entry.questions) {
      const picked = pickRecommended(q);
      if (!picked.length) return false;
      entry.selections.set(q.id, picked);
    }
    entry.autopilot = true;
    const send = (text, kb) => deps.client.sendMessage({
      chatId: entry.chatId, text, parseMode: 'HTML',
      messageThreadId: entry.threadId,
      replyMarkup: { inline_keyboard: autopilotSubKey(kb, entry.key) },
      disableNotification: false,
    });
    try {
      if (entry.questions.length === 1) {
        const q = entry.questions[0];
        const { text, keyboard } = buildAutopilotCard(q, 0, 1, deps.escape, entry.selections.get(q.id), entry.key, win);
        const res = await sendWithRetry(() => send(text, keyboard), deps.log);
        entry.cardMessageIds = [res?.messageId ?? null];
      } else {
        for (let qi = 0; qi < entry.questions.length; qi++) {
          const q = entry.questions[qi];
          const { text, keyboard } = buildAutopilotCard(q, qi, entry.questions.length, deps.escape, entry.selections.get(q.id), entry.key, win);
          const res = await sendWithRetry(() => send(text, keyboard), deps.log);
          entry.cardMessageIds.push(res?.messageId ?? null);
        }
      }
    } catch (err) {
      // Card delivery failed — leave it to the web UI / normal flow.
      pending.delete(entry.key);
      seenRpcIds.delete(entry.rpcId);
      entry.autopilot = false;
      deps.log?.('warn', `Autopilot question card send failed (${err.message}); leaving it to the web UI.`);
      return false;
    }
    // Schedule the auto-commit.
    if (win > 0) {
      entry.autopilotTimer = setTimeout(() => {
        entry.autopilotTimer = undefined;
        if (entry.outcome) return;
        void answer(entry, {});
      }, win);
    } else {
      entry.autopilotTimer = undefined;
      void answer(entry, {});
    }
    deps.log?.('info', `Autopilot auto-adopted question for ${entry.sessionId} (chat ${entry.chatId}, window ${win}ms)`);
    return true;
  }

  // "✋ 接管": stop autopilot for this chat and hand the question back to manual
  // answering (re-render the normal interactive card). Does NOT cancel the ask.
  async function autopilotTakeover(entry) {
    clearTimeout(entry.autopilotTimer); entry.autopilotTimer = undefined;
    try { deps.autopilotTakeover?.(entry.chatId); } catch { /* ignore */ }
    entry.autopilot = false;
    const send = (mid, text, kb) => {
      if (!mid) return;
      deps.client.editMessageText(entry.chatId, mid, text, 'HTML', { inline_keyboard: autopilotSubKey(kb, entry.key) }).catch(() => {});
    };
    if (entry.questions.length === 1) {
      const { text, keyboard } = buildQuestionCard(entry.questions, deps.escape, entry.selections);
      send(entry.cardMessageIds[0], text, keyboard);
    } else {
      entry.questions.forEach((q, qi) => {
        const { text, keyboard } = buildQuestionCardFor(q, qi, entry.questions.length, deps.escape, entry.selections, entry.locked);
        send(entry.cardMessageIds[qi], text, keyboard);
      });
      const s = buildSummaryCard(entry, deps.escape);
      send(entry.summaryMessageId, s.text, s.keyboard);
    }
    deps.log?.('info', `Autopilot takeover: manual control restored for chat ${entry.chatId}`);
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
    // Normalize multi-select: an explicit boolean is kept as-is; a missing flag
    // is inferred from the wording (see effectiveMultiSelect) so a "（多选）"
    // question that omitted `multi_select: true` still renders + submits as
    // multi-select instead of auto-submitting on the first tap.
    const questions = (Array.isArray(payload.questions) ? payload.questions : []).map((q) => ({
      ...q,
      // Keep the RAW flag: the harness validates answers strictly against the
      // tool args (multi_select omitted ⇒ single-select enforced), while we
      // may render more permissively from the wording (effectiveMultiSelect).
      rawMultiSelect: typeof q?.multiSelect === 'boolean' ? q.multiSelect : null,
      multiSelect: effectiveMultiSelect(q),
    }));
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
      cardMessageIds: [],    // one per question (single-question flow: length 1)
      summaryMessageId: null, // progress card (multi-question flows only)
      selections: new Map(),
      locked: new Set(),     // question ids confirmed via 提交本题
      outcome: null,
    };
    pending.set(key, entry);
    void (async () => {
      const subKey = (kb) => kb.map((row) =>
        row.map((b) => ({ ...b, callback_data: b.callback_data.replace('KEY', key) })));
      const send = async (text, kb) => sendWithRetry(() => deps.client.sendMessage({
        chatId: entry.chatId,
        text,
        parseMode: 'HTML',
        messageThreadId: entry.threadId,
        replyMarkup: { inline_keyboard: subKey(kb) },
        disableNotification: false,
      }), deps.log);
      // Autopilot (v0.5.0): when this chat is in autopilot mode, auto-adopt the
      // recommended option and schedule the commit instead of waiting for a
      // tap. Returns true when it handled the question (autopilot card posted +
      // timer scheduled) — we then skip the normal interactive flow below.
      if (deps.isAutopilot?.(own.chatId)) {
        const adopted = await autopilotAdopt(entry);
        if (adopted) return;
        // autopilotAdopt returned false (no auto-pickable option or card send
        // failed) — fall through to the normal interactive card.
      }
      try {
        if (questions.length === 1) {
          const { text, keyboard } = buildQuestionCard(questions, deps.escape, entry.selections);
          const res = await send(text, keyboard);
          entry.cardMessageIds = [res?.messageId ?? null];
        } else {
          // One message per question so each question's options sit directly
          // under its own text, then a progress card with the final submit.
          for (let qi = 0; qi < questions.length; qi++) {
            const { text, keyboard } = buildQuestionCardFor(questions[qi], qi, questions.length, deps.escape, entry.selections, entry.locked);
            const res = await send(text, keyboard);
            entry.cardMessageIds.push(res?.messageId ?? null);
          }
          const s = buildSummaryCard(entry, deps.escape);
          const resS = await send(s.text, s.keyboard);
          entry.summaryMessageId = resS?.messageId ?? null;
        }
        deps.log?.('info', `Question card(s) posted for ${sessionId} (chat ${entry.chatId}, ${questions.length} question(s))`);
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
      if (entry.rpcId !== rpcId) continue;
      // Skip the host's echo of OUR OWN settlement: while we're POSTing our
      // answer (and settling on its receipt), the host's accepted-claim
      // broadcasts a `question/resolved: answered` frame back to us. Treating
      // it as "web GUI answered first" would mislabel the user's own submit.
      // The respond() receipt (in answer()) is the authoritative signal here.
      if (entry.settling) return;
      // A frame that reaches us when we are NOT submitting our own answer means
      // the web GUI answered first — lock the card with a neutral "已作答".
      settle(entry, payload.outcome === 'answered' ? 'delegated' : 'cancelled');
      return;
    }
  }

  // Re-render a card's text AND keyboard after a selection/lock changes.
  // Re-sending reply_markup forces Telegram clients to re-render the keyboard
  // — a text-only editMessageText can leave stale/missing keyboard rows on
  // some clients, which hid the trailing submit row and left users unable to
  // submit. In multi-question flows `qi` targets one question card; the
  // summary card is refreshed whenever progress can change.
  function refreshEntry(entry, qi) {
    const subKey = (kb) => kb.map((row) =>
      row.map((b) => ({ ...b, callback_data: b.callback_data.replace('KEY', entry.key) })));
    const edit = (mid, text, kb) => {
      if (!mid) return;
      deps.client.editMessageText(entry.chatId, mid, text, 'HTML', { inline_keyboard: subKey(kb) }).catch(() => {});
    };
    if (entry.questions.length === 1) {
      const { text, keyboard } = buildQuestionCard(entry.questions, deps.escape, entry.selections);
      edit(entry.cardMessageIds[0], text, keyboard);
      return;
    }
    if (typeof qi === 'number' && qi >= 0 && qi < entry.questions.length) {
      const { text, keyboard } = buildQuestionCardFor(entry.questions[qi], qi, entry.questions.length, deps.escape, entry.selections, entry.locked);
      edit(entry.cardMessageIds[qi], text, keyboard);
    }
    const s = buildSummaryCard(entry, deps.escape);
    edit(entry.summaryMessageId, s.text, s.keyboard);
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
    // Autopilot notice-card actions.
    if (parsed.action === 'adopt') {
      if (!entry.autopilot) { ack('已过期'); return true; }
      clearTimeout(entry.autopilotTimer); entry.autopilotTimer = undefined;
      await ack('⏩ 已采纳推荐方案');
      await answer(entry, {});
      return true;
    }
    if (parsed.action === 'takeover') {
      if (!entry.autopilot) { ack('已过期'); return true; }
      await ack('✋ 已交还手动选择');
      await autopilotTakeover(entry);
      return true;
    }
    if (parsed.action === 'submit') {
      const q = entry.questions;
      const allDone = q.every((qq) => (entry.selections.get(qq.id) || []).length > 0);
      await ack(allDone ? '✅ 已提交' : '✅ 已提交（未答的跳过）');
      await answer(entry, {});
      return true;
    }
    if (parsed.action === 'lock') {
      const q = entry.questions[parsed.qi];
      if (!q) { ack('无效题目'); return true; }
      if (entry.locked.has(q.id)) { ack('🔒 该题已提交'); return true; }
      entry.locked.add(q.id);
      await ack('🔒');
      refreshEntry(entry, parsed.qi); // question card + summary progress
      return true;
    }
    // Option tap.
    const q = entry.questions[parsed.qi];
    const opt = q?.options?.[parsed.oi];
    if (!q || !opt) { ack('无效选项'); return true; }
    if (entry.locked.has(q.id)) { ack('🔒 该题已提交'); return true; }
    const label = String(opt.label || '');
    const cur = entry.selections.get(q.id) || [];
    if (q.multiSelect) {
      entry.selections.set(q.id, cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
      await ack('🔘');
      refreshEntry(entry, entry.questions.length > 1 ? parsed.qi : undefined); // text + keyboard re-render
    } else {
      entry.selections.set(q.id, [label]);
      if (entry.questions.length === 1) {
        // Single-question card: the tap IS the answer — submit immediately.
        await ack('✅');
        await answer(entry, {});
      } else {
        // Per-question card: only record the choice; wait for 提交本题 / 提交全部.
        // Without this guard a single-select tap would submit the whole flow.
        await ack('🔘');
        refreshEntry(entry, parsed.qi); // text + keyboard re-render
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
 * Subscribe to `${url}/api/events.mux` over WebSocket. Every question frame is
 * passed to onFrame(frame). Returns { stop() }.
 *
 * The web host's mux endpoint is WebSocket-only: a plain HTTP GET is answered
 * with `426 Upgrade Required` by the client/connection gateway, so an SSE/fetch
 * subscriber can never receive frames (this is why ask_user_question cards
 * silently never reached the phone). Each server message is one JSON text frame
 * shaped { type:'server-request', rpcId, method, payload }; the downlink is
 * read-only (sending anything makes the host close with 1008). Pending
 * questions are replayed on (re)connect, so reconnects are safe. Node >= 21
 * provides a global WebSocket client (dsh runs on Node 22).
 */
export function createMuxSubscriber({ url, onFrame, log }) {
  let stopped = false;
  let attempt = 0;
  let timer = null;
  let ws = null;

  function toWsUrl(httpUrl) {
    return String(httpUrl).replace(/^http/i, 'ws').replace(/\/+$/, '') + '/api/events.mux';
  }

  async function loop() {
    while (!stopped) {
      try {
        if (typeof WebSocket === 'undefined') {
          throw new Error('global WebSocket unavailable (Node >= 21 required)');
        }
        ws = new WebSocket(toWsUrl(url));
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(new Error('websocket connect failed')), { once: true });
        });
        attempt = 0;
        // Park until the socket closes; dispatch question frames as they arrive.
        await new Promise((resolve) => {
          ws.addEventListener('message', (ev) => {
            if (stopped) return;
            let f;
            try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
            const t = f?.payload?.type ?? f?.method;
            if (t === 'question/requested' || t === 'question/resolved') {
              try { onFrame(f); } catch (err) { log?.('warn', `mux onFrame error: ${err.message}`); }
            }
          });
          ws.addEventListener('close', () => resolve(), { once: true });
        });
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
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
