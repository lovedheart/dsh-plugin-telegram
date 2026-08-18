// Unit tests for the ask_user_question Telegram answerer (questions.js).
// Run: node test/questions.test.mjs
import { strict as assert } from 'node:assert';
import {
  QUESTION_CALLBACK_PREFIX,
  parseQuestionCallback,
  buildQuestionCard,
  buildQuestionCardFor,
  buildSummaryCard,
  createQuestionModule,
  parseSseFrames,
  createMuxSubscriber,
  displayWidth,
  buttonsPerRow,
  effectiveMultiSelect,
} from '../src/questions.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => { passed++; console.log(`  ok    ${name}`); },
      (e) => { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); },
    );
    passed++; console.log(`  ok    ${name}`);
  } catch (e) {
    failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Recording Telegram client the module talks to. */
function makeClient(overrides = {}) {
  const calls = { sends: [], edits: [], acks: [] };
  let nextId = 5000;
  return {
    calls,
    async sendMessage(opts) {
      calls.sends.push(opts);
      if (overrides.failSend) throw overrides.failSend(opts);
      return { messageId: ++nextId, chatId: String(opts.chatId) };
    },
    async editMessageText(chatId, id, text, parseMode, replyMarkup) { calls.edits.push({ chatId, id, text, replyMarkup }); return true; },
    async answerCallbackQuery(id, text) { calls.acks.push({ id, text }); return true; },
  };
}

/**
 * Build a question module wired to a mock client + ownership + responder.
 * Returns the module and a handle to inspect what was posted/responded.
 */
function makeModule({ ownership, failSend } = {}) {
  const client = makeClient({ failSend });
  const state = { responses: [] };
  const deps = {
    log: () => {},
    escape: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    client,
    ownership: ownership ?? ((sid) => (typeof sid === 'string' && sid.startsWith('telegram-') ? { chatId: '123', threadId: null } : null)),
    respond: async (body) => {
      state.responses.push(body);
      return { accepted: true };
    },
  };
  const mod = createQuestionModule(deps);
  return { mod, client, state };
}

// Push a `question/requested` frame and let the card-send promise flush.
// Returns the inline_keyboard that was actually posted (real keys substituted).
async function request(mod, client, rpcId, sessionId, questions) {
  mod.handleFrame({ rpcId, payload: { type: 'question/requested', sessionId, questions } });
  await sleep(0); // allow onRequested's async IIFE to schedule the send
  await sleep(1); // let the sendMessage promise resolve + set cardMessageId
  // NOTE: the real TelegramClient converts replyMarkup -> reply_markup; our
  // mock bypasses that, so read the raw `replyMarkup` option the module passes.
  const kb = client.calls.sends[client.calls.sends.length - 1]?.replyMarkup?.inline_keyboard;
  return kb;
}

// Find a posted button whose callback_data ends with the given suffix.
function btn(kb, suffix) {
  const b = kb.flat().find((x) => x.callback_data.endsWith(suffix));
  if (!b) throw new Error(`no button ending in ${suffix}`);
  return b;
}

// ---------------------------------------------------------------------------
// parseQuestionCallback
// ---------------------------------------------------------------------------

console.log('\nparseQuestionCallback:');
await test('parses option tap q<qi>:<oi>', () => {
  const p = parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}q9k1:q1:2`);
  assert.deepEqual(p, { key: 'q9k1', action: 'option', qi: 1, oi: 2 });
});
await test('parses submit', () => {
  assert.deepEqual(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}abc:submit`), { key: 'abc', action: 'submit' });
});
await test('parses cancel', () => {
  assert.deepEqual(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}abc:cancel`), { key: 'abc', action: 'cancel' });
});
await test('parses lock q<qi>', () => {
  assert.deepEqual(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}abc:lock:q2`), { key: 'abc', action: 'lock', qi: 2 });
});
await test('returns null for bad lock index', () => {
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}k:lock:x`), null);
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}k:lock`), null);
});
await test('returns null for foreign prefix', () => {
  assert.equal(parseQuestionCallback(`tgapv2:abc:approve`), null);
});
await test('returns null for non-string / missing parts', () => {
  assert.equal(parseQuestionCallback(null), null);
  assert.equal(parseQuestionCallback(''), null);
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}`), null);
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}abc`), null); // no action
});
await test('returns null for bad option indices', () => {
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}k:q1:x`), null);
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}k:q:2`), null);
});
await test('returns null for unknown action verb', () => {
  assert.equal(parseQuestionCallback(`${QUESTION_CALLBACK_PREFIX}k:noop`), null);
});

// ---------------------------------------------------------------------------
// buildQuestionCard
// ---------------------------------------------------------------------------

console.log('\nbuildQuestionCard:');
const singleQ = { id: 'lang', question: '选哪种语言？', options: [{ label: '中文' }, { label: 'English' }] };
const esc = (s) => String(s);

await test('single-select card: header, question, option buttons, cancel row', () => {
  const { text, keyboard } = buildQuestionCard([singleQ], esc);
  assert.ok(text.includes('❓ 需要你回答'));
  assert.ok(text.includes('选哪种语言？'));
  // option buttons carry the KEY placeholder (substituted by the module)
  const optBtns = keyboard.flat().filter((b) => b.callback_data.includes(':q0:'));
  assert.equal(optBtns.length, 2);
  assert.equal(optBtns[0].text, '中文');
  assert.equal(optBtns[0].callback_data, `${QUESTION_CALLBACK_PREFIX}KEY:q0:0`);
  // no submit button for single-select; cancel present
  assert.ok(!keyboard.flat().some((b) => b.callback_data.endsWith(':submit')));
  assert.ok(keyboard.flat().some((b) => b.callback_data.endsWith(':cancel')));
  // hint that plain reply works
  assert.ok(text.includes('也可以直接回复'));
});

await test('HTML chars in question are escaped via injected escape', () => {
  const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { text } = buildQuestionCard([{ id: 'x', question: 'a<b & c>?' , options: [] }], htmlEsc);
  assert.ok(text.includes('a&lt;b &amp; c&gt;?'));
});

await test('multi-question flow: each question card pairs its question with its own options', () => {
  const qs = [
    { id: 'a', question: '第一个？', options: [{ label: 'A1' }] },
    { id: 'b', question: '第二个？', options: [{ label: 'B1' }] },
  ];
  const c0 = buildQuestionCardFor(qs[0], 0, 2, esc);
  const c1 = buildQuestionCardFor(qs[1], 1, 2, esc);
  assert.ok(c0.text.includes('❓ 需要你回答（1/2）'));
  assert.ok(c0.text.includes('Q1：第一个？'));
  assert.ok(c1.text.includes('❓ 需要你回答（2/2）'));
  assert.ok(c1.text.includes('Q2：第二个？'));
  // Each card carries ONLY its own options + a per-question lock button.
  assert.ok(c0.keyboard.flat().some((b) => b.callback_data.endsWith(':q0:0')));
  assert.ok(!c0.keyboard.flat().some((b) => b.callback_data.endsWith(':q1:')));
  assert.ok(c0.keyboard.flat().some((b) => b.callback_data.endsWith(':lock:q0') && b.text === '✅ 提交本题'));
  assert.ok(c1.keyboard.flat().some((b) => b.callback_data.endsWith(':lock:q1')));
  // No global submit on per-question cards — that lives on the summary card.
  assert.ok(!c0.keyboard.flat().some((b) => b.callback_data.endsWith(':submit')));
});

await test('header appears exactly once per card (regression: printed twice)', () => {
  const count = (s, sub) => s.split(sub).length - 1;
  const q = { id: 'a', header: '第1题（多选）', question: '一？', options: [{ label: 'A1' }] };
  const single = buildQuestionCard([q], esc);
  assert.equal(count(single.text, '第1题（多选）'), 1, 'single-question card header once');
  const per = buildQuestionCardFor(q, 0, 2, esc);
  assert.equal(count(per.text, '第1题（多选）'), 1, 'per-question card header once');
});

await test('summary card shows progress and the final submit button', () => {
  const entry = {
    questions: [
      { id: 'a', header: '第1题', question: '一？' },
      { id: 'b', question: '二？' },
    ],
    locked: new Set(['a']),
  };
  const { text, keyboard } = buildSummaryCard(entry, esc);
  assert.ok(text.includes('📝 答题进度：1/2'));
  assert.ok(text.includes('✅ 第1题'));
  assert.ok(text.includes('⬜ 第2题'));
  assert.ok(keyboard.flat().some((b) => b.callback_data.endsWith(':submit') && b.text === '🏁 提交全部'));
});

await test('locked per-card disables option buttons and marks the lock button', () => {
  const q = { id: 'a', question: '一？', options: [{ label: 'A1' }, { label: 'A2' }] };
  const sel = new Map([['a', ['A1']]]);
  const { text, keyboard } = buildQuestionCardFor(q, 0, 2, esc, sel, new Set(['a']));
  assert.ok(text.includes('🔒 已提交：A1'));
  const optRows = keyboard.filter((row) => row.some((b) => b.callback_data.includes(':q0:')));
  assert.ok(optRows.length > 0);
  assert.ok(optRows.every((row) => row.every((b) => b.is_disabled === true)));
  const lockBtn = keyboard.flat().find((b) => b.callback_data.endsWith(':lock:q0'));
  assert.equal(lockBtn.is_disabled, true);
});

await test('multiSelect question marks selection and requires submit', () => {
  const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] };
  const sel = new Map([[ 'm', ['X'] ]]);
  const { text, keyboard } = buildQuestionCard([q], esc, sel);
  assert.ok(text.includes('已选：X'));
  assert.ok(keyboard.flat().some((b) => b.callback_data.endsWith(':submit')));
});

await test('detail line renders when present', () => {
  const q = { id: 'd', question: '主问题', detail: '补充说明', options: [{ label: 'O' }] };
  const { text } = buildQuestionCard([q], esc);
  assert.ok(text.includes('📄 补充说明'));
});

await test('option labels are truncated to 40 chars', () => {
  const long = 'x'.repeat(80);
  const { keyboard } = buildQuestionCard([{ id: 't', question: 'q', options: [{ label: long }] }], esc);
  const btn = keyboard.flat().find((b) => b.callback_data.endsWith(':q0:0'));
  assert.equal(btn.text.length, 40);
});

await test('empty options -> option text falls back to 选项 N', () => {
  const { keyboard } = buildQuestionCard([{ id: 'e', question: 'q', options: [{ label: '' }] }], esc);
  const btn = keyboard.flat().find((b) => b.callback_data.endsWith(':q0:0'));
  assert.equal(btn.text, '选项 1');
});

await test('long CJK labels get one button per row (no phone clipping)', () => {
  const q = { id: 'cs', question: '以下哪些说法是正确的？（可多选）', multiSelect: true, options: [
    { label: 'A. 地球自转一圈大约需要一天' },
    { label: 'B. 高海拔地区水的沸点比海平面低' },
    { label: 'C. 常温下声速在空气中约 340 米/秒' },
    { label: 'D. 空气中氧气含量比氮气多' },
  ] };
  const { keyboard } = buildQuestionCard([q], esc);
  // Option rows (exclude the trailing submit/cancel row): each must hold 1 button.
  const optRows = keyboard.filter((row) => row.some((b) => b.callback_data.includes(':q0:')));
  assert.equal(optRows.length, 4);
  for (const row of optRows) assert.equal(row.length, 1);
  // callback_data indices stay aligned with option order despite re-packing.
  assert.deepEqual(optRows.map((r) => r[0].callback_data.slice(-1)), ['0', '1', '2', '3']);
});

await test('short labels still share a row', () => {
  const { keyboard } = buildQuestionCard([{ id: 's', question: 'q', options: [{ label: '是' }, { label: '否' }, { label: 'OK' }, { label: 'No' }] }], esc);
  const optRows = keyboard.filter((row) => row.some((b) => b.callback_data.includes(':q0:')));
  assert.equal(optRows.length, 1);
  assert.equal(optRows[0].length, 4);
});

await test('medium CJK labels pack two per row', () => {
  // 10 CJK chars = 20 display units -> buttonsPerRow(20) === 2
  const mk = (p) => ({ label: p + '一二三四五六七八九' });
  const { keyboard } = buildQuestionCard([{ id: 'm', question: 'q', options: [mk('甲'), mk('乙'), mk('丙'), mk('丁')] }], esc);
  const optRows = keyboard.filter((row) => row.some((b) => b.callback_data.includes(':q0:')));
  assert.equal(optRows.length, 2);
  assert.ok(optRows.every((r) => r.length === 2));
});

await test('option descriptions render in the body, numbered by button order', () => {
  const q = { id: 'd2', question: '主问题', options: [
    { label: 'A. 地球自转一圈大约需要一天', description: '地球自转一周约需 24 小时' },
    { label: 'B. 无说明项' },
    { label: 'C. 常温下声速在空气中约 340 米/秒', description: '声音在空气中传播速度约为 340 m/s（常温）' },
  ] };
  const { text } = buildQuestionCard([q], esc);
  assert.ok(text.includes('📝 选项说明（按按钮顺序）：'));
  assert.ok(text.includes('1. A. 地球自转一圈大约需要一天：地球自转一周约需 24 小时'));
  assert.ok(text.includes('3. C. 常温下声速在空气中约 340 米/秒：声音在空气中传播速度约为 340 m/s（常温）'));
  assert.ok(!text.includes('2.'), 'options without a description get no line');
});

await test('displayWidth / buttonsPerRow thresholds', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('a中b'), 4);
  assert.equal(buttonsPerRow(10), 4);
  assert.equal(buttonsPerRow(12), 4);
  assert.equal(buttonsPerRow(13), 3);
  assert.equal(buttonsPerRow(16), 3);
  assert.equal(buttonsPerRow(17), 2);
  assert.equal(buttonsPerRow(24), 2);
  assert.equal(buttonsPerRow(25), 1);
});

await test('effectiveMultiSelect: explicit boolean always wins', () => {
  assert.equal(effectiveMultiSelect({ multiSelect: true, question: '选哪种？' }), true);
  // Explicit false is respected even when the wording looks multi — we never
  // override a deliberate model choice.
  assert.equal(effectiveMultiSelect({ multiSelect: false, question: '以下哪些（多选）？' }), false);
});

await test('effectiveMultiSelect: infers from wording only when flag is absent', () => {
  // The real-world bug: model wrote "（多选）" but omitted multi_select.
  assert.equal(effectiveMultiSelect({ question: '以下哪些说法是正确的？（多选）' }), true);
  assert.equal(effectiveMultiSelect({ header: '常识多选题', question: '哪些是正确的' }), true);
  assert.equal(effectiveMultiSelect({ question: 'Which of these apply? (multiple select)' }), true);
  // Single-select wording with no flag stays single.
  assert.equal(effectiveMultiSelect({ question: '选哪种语言？' }), false);
  assert.equal(effectiveMultiSelect({ question: '请选择一个' }), false);
});

// ---------------------------------------------------------------------------
// createQuestionModule — answer flows
// ---------------------------------------------------------------------------

console.log('\ncreateQuestionModule: single-select');
await test('option tap answers with the selected label and settles the card', async () => {
  const { mod, client, state } = makeModule();
  const kb = await request(mod, client, 'rpc-1', 'telegram-abc', [singleQ]);
  assert.equal(client.calls.sends.length, 1);
  // Tap "English" (index 1) — read the REAL key from the posted button.
  const tap = btn(kb, ':q0:1');
  assert.equal(tap.text, 'English');
  await mod.handleCallbackQuery({ id: 'cq1', data: tap.callback_data });
  assert.equal(state.responses.length, 1);
  const r = state.responses[0];
  assert.equal(r.type, 'client-response');
  assert.equal(r.rpcId, 'rpc-1');
  assert.equal(r.result.ok, true);
  assert.equal(r.result.value.sessionId, 'telegram-abc');
  assert.deepEqual(r.result.value.answer.answers, [{ id: 'lang', selected: ['English'] }]);
  // card settled → re-rendered LOCKED: the question text stays on screen, the
  // chosen option is shown, and every button is disabled (nothing re-selectable).
  await sleep(1);
  const settled = client.calls.edits.find((e) => e.text.includes('🔒 已提交：English'));
  assert.ok(settled, 'card settled to a locked state showing the chosen option');
  assert.ok(settled.text.includes(singleQ.question), 'question text is retained after submit');
  const rows = settled.replyMarkup?.inline_keyboard ?? [];
  assert.ok(rows.length >= 2, 'locked card keeps its keyboard');
  const allButtons = rows.flat();
  assert.ok(allButtons.length > 0 && allButtons.every((b) => b.is_disabled), 'all buttons disabled after submit');
  // ack sent
  assert.ok(client.calls.acks.length >= 1);
});

await test('plain-text reply is consumed as a custom answer (single question)', async () => {
  const { mod, client, state } = makeModule();
  await request(mod, client, 'rpc-2', 'telegram-abc', [singleQ]);
  const consumed = mod.consumeTextReply('123', '我想用 Go');
  assert.equal(consumed, true);
  await sleep(1);
  assert.equal(state.responses.length, 1);
  const a = state.responses[0].result.value.answer.answers[0];
  assert.deepEqual(a, { id: 'lang', selected: [], custom: '我想用 Go' });
});

await test('plain-text reply is NOT consumed for a multi-question card', async () => {
  const { mod, client, state } = makeModule();
  await request(mod, client, 'rpc-3', 'telegram-abc', [
    { id: 'a', question: '一？', options: [{ label: 'A' }] },
    { id: 'b', question: '二？', options: [{ label: 'B' }] },
  ]);
  assert.equal(mod.consumeTextReply('123', '随便'), false);
  assert.equal(state.responses.length, 0);
});

await test('plain-text reply is NOT consumed when no card is pending', async () => {
  const { mod, state } = makeModule();
  assert.equal(mod.consumeTextReply('123', 'hi'), false);
  assert.equal(state.responses.length, 0);
});

await test('cancel button sends cancelled result and settles card', async () => {
  const { mod, client, state } = makeModule();
  const kb = await request(mod, client, 'rpc-4', 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'cq4', data: btn(kb, ':cancel').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  assert.equal(state.responses[0].result.ok, false);
  assert.equal(state.responses[0].result.error.code, 'cancelled');
  assert.ok(client.calls.edits.some((e) => e.text.includes('⌛ 已取消')));
});

console.log('\ncreateQuestionModule: multiSelect');
await test('multiSelect toggles selection, submit sends all selected labels', async () => {
  const { mod, client, state } = makeModule();
  const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] };
  const kb = await request(mod, client, 'rpc-5', 'telegram-abc', [q]);
  // Tap X
  await mod.handleCallbackQuery({ id: 'm1', data: btn(kb, ':q0:0').callback_data });
  // The refresh edit must re-send the keyboard (incl. the ✅ submit row) so
  // clients re-render it — a text-only edit hid the submit button on the phone.
  const refreshEdit = client.calls.edits[client.calls.edits.length - 1];
  assert.ok(refreshEdit.replyMarkup?.inline_keyboard?.length >= 2, 'refresh edit re-sends keyboard');
  const lastRow = refreshEdit.replyMarkup.inline_keyboard.at(-1);
  assert.ok(lastRow.some((b) => b.text === '✅ 提交'), 'submit button present in refreshed keyboard');
  assert.ok(refreshEdit.text.includes('✅ 提交'), 'refreshed text keeps the submit hint after selecting');
  // Tap Y
  await mod.handleCallbackQuery({ id: 'm2', data: btn(kb, ':q0:1').callback_data });
  // No answer yet (needs submit)
  assert.equal(state.responses.length, 0);
  // Submit
  await mod.handleCallbackQuery({ id: 'm3', data: btn(kb, ':submit').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  const a = state.responses[0].result.value.answer.answers[0];
  assert.deepEqual(a.selected.sort(), ['X', 'Y']);
});

// Regression: model wrote a "（多选）" question but OMITTED multi_select: true.
// The card must still behave as multi-select (no auto-submit on first tap), not
// fall through to the single-select "tap = answer" path.
console.log('\ncreateQuestionModule: multi-select inferred from wording (regression)');
await test('single question with missing multiSelect flag + "（多选）" text does NOT auto-submit', async () => {
  const { mod, client, state } = makeModule();
  // NOTE: no `multiSelect` field — mirrors the real frame the model sent.
  const q = { id: 'quiz', header: '常识多选题', question: '以下哪些说法是正确的？（多选）', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  const kb = await request(mod, client, 'rpc-infer', 'telegram-abc', [q]);
  // Card must show a submit button (needsSubmit) because it's treated as multi.
  assert.ok(kb.flat().some((b) => b.text === '✅ 提交'), 'inferred multi-select card has a submit button');
  // Tap A → must NOT submit (still pending).
  await mod.handleCallbackQuery({ id: 'inf1', data: btn(kb, ':q0:0').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 0, 'first tap on an inferred multi-select must not auto-submit');
  // Card re-edited to show the selection + keep the submit hint.
  const lastEdit = client.calls.edits[client.calls.edits.length - 1];
  assert.ok(lastEdit.text.includes('已选'), 'selection reflected');
  assert.ok(lastEdit.replyMarkup?.inline_keyboard?.some((row) => row.some((b) => b.text === '✅ 提交')), 'submit button still present');
  // Tap B, then submit → both labels returned. The model omitted multi_select,
  // so the harness would reject >1 selected; the plugin carries them as custom.
  await mod.handleCallbackQuery({ id: 'inf2', data: btn(kb, ':q0:1').callback_data });
  await mod.handleCallbackQuery({ id: 'inf3', data: btn(kb, ':submit').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  const infA = state.responses[0].result.value.answer.answers[0];
  assert.deepEqual(infA.selected, []);
  assert.equal(infA.custom, 'A、B');
});

// Regression: a single-select tap on a per-question card must NOT submit the
// whole flow (the old bug: it answered only Q1 and silently skipped Q2). It
// records the choice + re-edits that card; locking confirms one question; only
// 🏁 提交全部 on the summary card submits.
console.log('\ncreateQuestionModule: multi-question per-card flow');
await test('multi-question flow: tap records, lock confirms, 提交全部 submits all', async () => {
  const { mod, client, state } = makeModule();
  const q1 = { id: 'lang', question: '选哪种语言？', options: [{ label: '中文' }, { label: 'English' }] };
  const q2 = { id: 'topic', question: '选哪些主题？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] };
  mod.handleFrame({ rpcId: 'rpc-mq', payload: { type: 'question/requested', sessionId: 'telegram-abc', questions: [q1, q2] } });
  await sleep(5);
  // 2 question cards + 1 summary card.
  assert.equal(client.calls.sends.length, 3);
  const kb0 = client.calls.sends[0].replyMarkup.inline_keyboard;
  const kb1 = client.calls.sends[1].replyMarkup.inline_keyboard;
  const kbS = client.calls.sends[2].replyMarkup.inline_keyboard;
  // Tap Q1 "English" — records only, no submit.
  const editsBefore = client.calls.edits.length;
  await mod.handleCallbackQuery({ id: 'mq1', data: btn(kb0, ':q0:1').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 0, 'single-select tap must not submit');
  assert.ok(client.calls.edits.length > editsBefore, 'question card re-edited to reflect the choice');
  // Lock Q1 → its card shows 🔒 + disabled options; summary progress 1/2.
  await mod.handleCallbackQuery({ id: 'mq2', data: btn(kb0, ':lock:q0').callback_data });
  await sleep(1);
  const lockEdits = client.calls.edits.slice(-2);
  assert.ok(lockEdits.some((e) => e.text.includes('🔒 已提交：English')), 'locked card shows the choice');
  assert.ok(lockEdits.some((e) => e.text.includes('答题进度：1/2')), 'summary progress updated');
  // Answer Q2 (multi) and lock it. Locks alone must not submit.
  await mod.handleCallbackQuery({ id: 'mq3', data: btn(kb1, ':q1:0').callback_data });
  await mod.handleCallbackQuery({ id: 'mq4', data: btn(kb1, ':lock:q1').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 0, 'locks alone must not submit');
  // Final submit from the summary card.
  await mod.handleCallbackQuery({ id: 'mq5', data: btn(kbS, ':submit').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  const answers = state.responses[0].result.value.answer.answers;
  assert.deepEqual(answers.find((x) => x.id === 'lang').selected, ['English']);
  assert.deepEqual(answers.find((x) => x.id === 'topic').selected, ['A']);
});

await test('option tap on a locked question is ignored (no re-edit, no submit)', async () => {
  const { mod, client, state } = makeModule();
  const q1 = { id: 'a', question: '一？', options: [{ label: 'A1' }, { label: 'A2' }] };
  const q2 = { id: 'b', question: '二？', options: [{ label: 'B1' }] };
  mod.handleFrame({ rpcId: 'rpc-lk', payload: { type: 'question/requested', sessionId: 'telegram-abc', questions: [q1, q2] } });
  await sleep(5);
  const kb0 = client.calls.sends[0].replyMarkup.inline_keyboard;
  await mod.handleCallbackQuery({ id: 'lk1', data: btn(kb0, ':lock:q0').callback_data });
  await sleep(1);
  const editsBefore = client.calls.edits.length;
  await mod.handleCallbackQuery({ id: 'lk2', data: btn(kb0, ':q0:1').callback_data });
  await sleep(1);
  assert.equal(client.calls.edits.length, editsBefore, 'no re-edit after locking');
  assert.equal(state.responses.length, 0);
  assert.ok(client.calls.acks.some((a) => String(a.text).includes('已提交')));
});

// Regression (the real-world bug): model wrote "（多选）" questions but OMITTED
// multi_select:true. The harness validates strictly against the raw args and
// rejects >1 selected ('bad-response'), leaving the agent turn blocked forever.
// The plugin must convert such picks to a custom string so the answer lands.
console.log('\ncreateQuestionModule: harness validation mismatch (regression)');
await test('inferred multi-select without multi_select flag converts >1 picks to custom', async () => {
  const { mod, client, state } = makeModule();
  const q = { id: 'quiz', header: '第1题（多选）', question: '下列哪些动物属于哺乳动物？（多选）', options: [{ label: '蝙蝠' }, { label: '企鹅' }, { label: '海豚' }, { label: '鲨鱼' }] };
  mod.handleFrame({ rpcId: 'rpc-mm', payload: { type: 'question/requested', sessionId: 'telegram-abc', questions: [q] } });
  await sleep(5);
  const kb = client.calls.sends[0].replyMarkup.inline_keyboard;
  await mod.handleCallbackQuery({ id: 'mm1', data: btn(kb, ':q0:0').callback_data }); // 蝙蝠
  await mod.handleCallbackQuery({ id: 'mm2', data: btn(kb, ':q0:2').callback_data }); // 海豚
  await mod.handleCallbackQuery({ id: 'mm3', data: btn(kb, ':submit').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  const a = state.responses[0].result.value.answer.answers[0];
  assert.deepEqual(a.selected, []);
  assert.equal(a.custom, '蝙蝠、海豚');
});

await test('explicit multi_select:true keeps selected labels (no conversion)', async () => {
  const { mod, client, state } = makeModule();
  const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] };
  const kb = await request(mod, client, 'rpc-exp', 'telegram-abc', [q]);
  await mod.handleCallbackQuery({ id: 'ex1', data: btn(kb, ':q0:0').callback_data });
  await mod.handleCallbackQuery({ id: 'ex2', data: btn(kb, ':q0:1').callback_data });
  await mod.handleCallbackQuery({ id: 'ex3', data: btn(kb, ':submit').callback_data });
  await sleep(1);
  const a = state.responses[0].result.value.answer.answers[0];
  assert.deepEqual(a.selected.sort(), ['X', 'Y']);
  assert.equal(a.custom, undefined);
});

await test('rejected respond (bad-response) settles with a warning, not the web-answer label', async () => {
  const client = makeClient();
  const state = { responses: [] };
  const mod = createQuestionModule({
    log: () => {},
    escape: esc,
    client,
    ownership: () => ({ chatId: '123', threadId: null }),
    respond: async () => ({ accepted: false, reason: 'bad-response' }),
  });
  const kb = await request(mod, client, 'rpc-rej', 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'rej1', data: btn(kb, ':cancel').callback_data });
  await sleep(1);
  assert.ok(client.calls.edits.some((e) => e.text.includes('⚠️ 提交被拒绝')));
  assert.ok(!client.calls.edits.some((e) => e.text.includes('🌐')));
});

console.log('\ncreateQuestionModule: ownership + replay + web-first');
await test('questions for a web agent (ownership null) are ignored', async () => {
  const { mod, client, state } = makeModule();
  await request(mod, client, 'rpc-web', 'web-session-xyz', [singleQ]);
  assert.equal(client.calls.sends.length, 0);
  assert.equal(state.responses.length, 0);
});

await test('replaying the same rpcId does not post a second card', async () => {
  const { mod, client } = makeModule();
  await request(mod, client, 'rpc-r', 'telegram-abc', [singleQ]);
  // Simulate an SSE reconnect replay of the same still-pending question.
  mod.handleFrame({ rpcId: 'rpc-r', payload: { type: 'question/requested', sessionId: 'telegram-abc', questions: [singleQ] } });
  await sleep(2);
  assert.equal(client.calls.sends.length, 1);
});

await test('a question/resolved frame settles our card (web answered first)', async () => {
  const { mod, client, state } = makeModule();
  await request(mod, client, 'rpc-res', 'telegram-abc', [singleQ]);
  mod.handleFrame({ payload: { type: 'question/resolved', questionRpcId: 'rpc-res', outcome: 'answered' } });
  await sleep(1);
  // Settled as delegated (web won) — NO respond() call from us. The card is
  // locked with a neutral "已作答" label (the old "🌐 已在网页端回答" wording was
  // removed) while the question stays on screen.
  assert.equal(state.responses.length, 0);
  assert.ok(client.calls.edits.some((e) => e.text.includes('🔒 已作答')));
  assert.ok(!client.calls.edits.some((e) => e.text.includes('🌐')));
});

await test('a late respond that is not-pending settles as delegated, not answered', async () => {
  const client = makeClient();
  const state = { responses: [] };
  const mod = createQuestionModule({
    log: () => {},
    escape: esc,
    client,
    ownership: () => ({ chatId: '123', threadId: null }),
    respond: async (b) => { state.responses.push(b); return { accepted: false, reason: 'not-pending' }; },
  });
  const kb = await request(mod, client, 'rpc-late', 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'late1', data: btn(kb, ':cancel').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 1);
  // not-pending ⇒ settled as delegated with a neutral label, never "🌐 网页端".
  assert.ok(client.calls.edits.some((e) => e.text.includes('🔒 已作答')));
  assert.ok(!client.calls.edits.some((e) => e.text.includes('🌐')));
});

// Regression for the reported bug: when we submit, the host ACCEPTS our
// answer and broadcasts `question/resolved` back to us (its echo of OUR
// settlement). That echo must NOT re-collapse the card into a status line —
// the card must stay locked (question retained, buttons disabled), exactly as
// our accepted-receipt settlement rendered it.
await test('the host resolved-echo of our own submit does not re-collapse the card', async () => {
  const client = makeClient();
  const state = { responses: [] };
  const mod = createQuestionModule({
    log: () => {},
    escape: esc,
    client,
    ownership: () => ({ chatId: '123', threadId: null }),
    respond: async (b) => {
      state.responses.push(b);
      // Simulate the host: accepting the answer broadcasts `question/resolved`
      // back to us (its echo of our own settlement) before the receipt returns.
      setTimeout(() => mod.handleFrame({ payload: { type: 'question/resolved', questionRpcId: b.rpcId, outcome: 'answered' } }), 0);
      return { accepted: true };
    },
  });
  const kb = await request(mod, client, 'rpc-echo', 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'ech1', data: btn(kb, ':q0:1').callback_data });
  await sleep(2);
  const settled = client.calls.edits.filter((e) => e.text.includes('🔒 已提交：English'));
  assert.ok(settled.length >= 1, 'card settles to the locked "已提交" state');
  // The echo must not have turned the card back into a bare status line.
  assert.ok(!client.calls.edits.some((e) => e.text.trim() === '🔒 已作答'), 'no bare "已作答" status line');
  assert.ok(!client.calls.edits.some((e) => e.text.includes('🌐')), 'no "已在网页端回答" wording');
  // The final card keeps the full question and a fully-disabled keyboard.
  const last = client.calls.edits.at(-1);
  assert.ok(last.text.includes(singleQ.question), 'question text retained in final card');
  const rows = last.replyMarkup?.inline_keyboard ?? [];
  assert.ok(rows.length > 0 && rows.flat().every((b) => b.is_disabled), 'all buttons disabled in final card');
});

await test('stale callback (unknown/expired key) acks but does not respond', async () => {
  const { mod, client, state } = makeModule();
  await request(mod, client, 'rpc-s', 'telegram-abc', [singleQ]);
  // A key we never issued:
  await mod.handleCallbackQuery({ id: 'stale', data: `${QUESTION_CALLBACK_PREFIX}zzz:cancel` });
  await sleep(1);
  assert.equal(state.responses.length, 0);
  assert.ok(client.calls.acks.some((a) => a.text.includes('已过期')));
});

await test('cancelAll on unload forgets pending cards without network', async () => {
  const { mod, client, state } = makeModule();
  const kb = await request(mod, client, 'rpc-u', 'telegram-abc', [singleQ]);
  mod.cancelAll();
  // After unload, a callback no longer resolves (unknown/expired key).
  await mod.handleCallbackQuery({ id: 'u1', data: btn(kb, ':cancel').callback_data });
  await sleep(1);
  assert.equal(state.responses.length, 0);
});

// ---------------------------------------------------------------------------
// parseSseFrames
// ---------------------------------------------------------------------------

console.log('\nparseSseFrames:');
await test('parses a single data frame and leaves nothing in rest', () => {
  const { frames, rest } = parseSseFrames(`: connected\ndata: {"type":"server-request","payload":{"type":"question/requested"}}\n\n`);
  assert.equal(rest, '');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.type, 'question/requested');
});

await test('ignores comment lines and non-data lines', () => {
  const { frames } = parseSseFrames(`: connected\nretry: 3000\ndata: {"a":1}\n\n`);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { a: 1 });
});

await test('keeps a trailing partial event in rest', () => {
  const { frames, rest } = parseSseFrames(`data: {"a":1}\n\ndata: {"b":2`);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { a: 1 });
  assert.equal(rest, 'data: {"b":2');
});

await test('joins multi-line data fields', () => {
  const { frames } = parseSseFrames(`data: {"x":\ndata: 1}\n\n`);
  assert.deepEqual(frames[0], { x: 1 });
});

await test('skips an unparseable data payload but keeps going', () => {
  const { frames } = parseSseFrames(`data: {not json}\n\ndata: {"ok":true}\n\n`);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { ok: true });
});

await test('handles multiple frames in one buffer', () => {
  const { frames } = parseSseFrames(`data: {"i":1}\n\ndata: {"i":2}\n\ndata: {"i":3}\n\n`);
  assert.deepEqual(frames.map((f) => f.i), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// createMuxSubscriber — integration with a fake global WebSocket.
// The real mux endpoint is WebSocket-only (HTTP GET → 426 Upgrade Required);
// each server message is one JSON text frame { type:'server-request', rpcId,
// method, payload }. The downlink is read-only.
// ---------------------------------------------------------------------------

console.log('\ncreateMuxSubscriber (fake WebSocket):');
await test('feeds question frames to onFrame and stop() closes the socket', async () => {
  const RealWebSocket = globalThis.WebSocket;
  const received = [];
  let closedByStop = false;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this._listeners = {};
      FakeWebSocket.last = this;
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    _emit(type, ev) { for (const fn of [...(this._listeners[type] || [])]) fn(ev); }
    close() { closedByStop = true; this._emit('close', { code: 1000 }); }
    // Test helpers simulating server behavior:
    _open() { this._emit('open', {}); }
    _sendFrame(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const sub = createMuxSubscriber({
      url: 'http://127.0.0.1:3080',
      log: () => {},
      onFrame: (f) => received.push(f.payload.type),
    });
    // Poll until the socket is constructed (bounded) — no fixed-timing flake.
    const deadline = Date.now() + 2000;
    while (!FakeWebSocket.last && Date.now() < deadline) await sleep(5);
    assert.ok(FakeWebSocket.last, 'subscriber should construct a WebSocket');
    assert.ok(String(FakeWebSocket.last.url).startsWith('ws://'), 'http url must be converted to ws');
    assert.ok(String(FakeWebSocket.last.url).endsWith('/api/events.mux'));
    FakeWebSocket.last._open();
    // The subscriber attaches its message listener only AFTER the open promise
    // resolves (park phase), so yield to the event loop before sending frames.
    // (With a real socket the server's replay frames arrive over the network,
    // long after listeners are attached — no such race exists in production.)
    await sleep(20);
    // Real frame shape: rpcId at the ROOT, question details in payload.
    FakeWebSocket.last._sendFrame({ type: 'server-request', rpcId: 'r1', method: 'question/requested', payload: { type: 'question/requested', sessionId: 'telegram-x', questions: [{ id: 'a', question: 'q', options: [{ label: 'L' }] }] } });
    FakeWebSocket.last._sendFrame({ type: 'server-request', rpcId: 'r1', method: 'question/resolved', payload: { type: 'question/resolved', questionRpcId: 'r1', outcome: 'answered' } });
    while (received.length < 2 && Date.now() < deadline) await sleep(5);
    assert.deepEqual(received, ['question/requested', 'question/resolved']);
    sub.stop();
    assert.equal(closedByStop, true); // stop() must close the socket
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
