// Unit tests for the ask_user_question Telegram answerer (questions.js).
// Drives the in-process `user-questions/request` waterfall API (v0.7.0):
// `handleRequest(request, next)` claims requests for chats we own (returns a
// promise the card taps settle) and delegates everything else via next().
// Run: node test/questions.test.mjs
import { strict as assert } from 'node:assert';
import {
  QUESTION_CALLBACK_PREFIX,
  parseQuestionCallback,
  buildQuestionCard,
  buildQuestionCardFor,
  buildSummaryCard,
  createQuestionModule,
  displayWidth,
  buttonsPerRow,
  effectiveMultiSelect,
  pickRecommended,
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

// Await a promise and hand back its rejection (or null when it resolved).
async function rejection(p) {
  try { await p; return null; } catch (e) { return e; }
}

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

// The web answerer standing behind us in the waterfall. Tests assert on
// `nextCalls` when they need to know whether an ask was delegated.
let nextCalls = 0;
const webNext = async () => { nextCalls++; return { answers: [] }; };

/**
 * Build a question module wired to a mock client + ownership.
 * Ownership keys off the live calling agent (the waterfall hands us
 * `request.agent`); by default only `telegram-*` agents are ours.
 */
function makeModule({ ownership, failSend, isAutopilot, autopilotWindowMs = 0, autopilotTakeover, timeoutMs = 0 } = {}) {
  const client = makeClient({ failSend });
  nextCalls = 0;
  const deps = {
    log: () => {},
    escape: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    client,
    ownership: ownership ?? ((agent) => (String(agent?.session?.id ?? '').startsWith('telegram-') ? { chatId: '123', botId: 'a', threadId: null } : null)),
    timeoutMs,
  };
  if (typeof isAutopilot === 'function') {
    deps.isAutopilot = isAutopilot;
    deps.autopilotWindowMs = autopilotWindowMs;
    if (typeof autopilotTakeover === 'function') deps.autopilotTakeover = autopilotTakeover;
  }
  const mod = createQuestionModule(deps);
  return { mod, client };
}

// Drive one ask through the waterfall answerer and let the card-send promise
// flush. Returns { p, kb }: p is the promise the caller (ask_user_question)
// awaits, kb the inline_keyboard of the last posted card (real keys
// substituted). `sessionId` is the asking agent's session id.
async function ask(mod, client, sessionId, questions, opts = {}) {
  const request = {
    questions,
    agent: { id: sessionId, session: { id: sessionId } },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const p = mod.handleRequest(request, opts.next ?? webNext);
  await sleep(0); // allow postQuestionCards' async send to start
  await sleep(1); // let the sendMessage promise resolve + set cardMessageIds
  // NOTE: the real TelegramClient converts replyMarkup -> reply_markup; our
  // mock bypasses that, so read the raw `replyMarkup` option the module passes.
  const kb = client.calls.sends[client.calls.sends.length - 1]?.replyMarkup?.inline_keyboard;
  // Keep a no-op catch attached so an unawaited rejection can never surface
  // as an unhandled rejection from the harness itself. Tests re-await p.
  p.catch(() => {});
  return { p, kb };
}

// Find a posted button whose callback_data ends with the given suffix.
function btn(kb, suffix) {
  const b = kb.flat().find((x) => x.callback_data.endsWith(suffix));
  if (!b) throw new Error(`no button ending in ${suffix}`);
  return b;
}

// True while the promise has not settled (checked after a small grace).
async function isPending(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await sleep(5);
  return !done;
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
// pickRecommended — autopilot auto-adopt option selection
// ---------------------------------------------------------------------------
console.log('\npickRecommended:');
await test('returns the flagged 推荐 option even when not first', () => {
  const q = { id: 'x', question: 'q', options: [
    { label: 'A. 慢' },
    { label: 'B. 快（推荐）', description: '更快' },
    { label: 'C. 最慢' },
  ] };
  assert.deepEqual(pickRecommended(q), ['B. 快（推荐）']);
});
await test('matches the English "recommended" marker in the description', () => {
  const q = { id: 'x', question: 'q', options: [
    { label: 'A' },
    { label: 'B', description: '(recommended)' },
  ] };
  assert.deepEqual(pickRecommended(q), ['B']);
});
await test('falls back to the FIRST option when nothing is flagged', () => {
  const q = { id: 'x', question: 'q', options: [{ label: 'First' }, { label: 'Second' }] };
  assert.deepEqual(pickRecommended(q), ['First']);
});
await test('single-select caps at one option even with multiple flags', () => {
  const q = { id: 'x', question: 'q', options: [
    { label: 'A（推荐）' },
    { label: 'B（推荐）' },
  ] };
  assert.deepEqual(pickRecommended(q), ['A（推荐）']);
});
await test('multi-select returns every flagged option', () => {
  const q = { id: 'x', question: 'q', multiSelect: true, options: [
    { label: 'A' },
    { label: 'B（推荐）' },
    { label: 'C（推荐）' },
  ] };
  assert.deepEqual(pickRecommended(q), ['B（推荐）', 'C（推荐）']);
});
await test('returns [] when there are no options', () => {
  assert.deepEqual(pickRecommended({ id: 'x', question: 'q', options: [] }), []);
  assert.deepEqual(pickRecommended({ id: 'x', question: 'q' }), []);
});
await test('returns raw labels (not truncated display text)', () => {
  const long = 'y'.repeat(80);
  const q = { id: 'x', question: 'q', options: [{ label: long }] };
  assert.deepEqual(pickRecommended(q), [long]);
});

// ---------------------------------------------------------------------------
// createQuestionModule — waterfall answer flows
// ---------------------------------------------------------------------------

console.log('\ncreateQuestionModule: single-select');
await test('option tap answers with the selected label and settles the card', async () => {
  const { mod, client } = makeModule();
  const { p, kb } = await ask(mod, client, 'telegram-abc', [singleQ]);
  assert.equal(client.calls.sends.length, 1);
  // Tap "English" (index 1) — read the REAL key from the posted button.
  const tap = btn(kb, ':q0:1');
  assert.equal(tap.text, 'English');
  await mod.handleCallbackQuery({ id: 'cq1', data: tap.callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['English'] }]);
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
  // never delegated
  assert.equal(nextCalls, 0);
});

await test('plain-text reply is consumed as a custom answer (single question)', async () => {
  const { mod, client } = makeModule();
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ]);
  const consumed = mod.consumeTextReply('123', 'a', '我想用 Go');
  assert.equal(consumed, true);
  const ans = await p;
  assert.deepEqual(ans.answers[0], { id: 'lang', selected: [], custom: '我想用 Go' });
});

await test('plain-text reply is NOT consumed for a multi-question card', async () => {
  const { mod, client } = makeModule();
  const { p } = await ask(mod, client, 'telegram-abc', [
    { id: 'a', question: '一？', options: [{ label: 'A' }] },
    { id: 'b', question: '二？', options: [{ label: 'B' }] },
  ]);
  assert.equal(mod.consumeTextReply('123', 'a', '随便'), false);
  assert.ok(await isPending(p), 'ask still pending');
});

await test('plain-text reply is NOT consumed when no card is pending', async () => {
  const { mod } = makeModule();
  assert.equal(mod.consumeTextReply('123', 'a', 'hi'), false);
});

await test('cancel button rejects the ask with ASK_CANCELLED and settles the card', async () => {
  const { mod, client } = makeModule();
  const { p, kb } = await ask(mod, client, 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'cq4', data: btn(kb, ':cancel').callback_data });
  const err = await rejection(p);
  assert.ok(err, 'the ask rejects on cancel');
  assert.equal(err.name, 'UserQuestionError');
  assert.equal(err.code, 'ASK_CANCELLED');
  assert.ok(client.calls.edits.some((e) => e.text.includes('⌛ 已取消')));
});

console.log('\ncreateQuestionModule: multiSelect');
await test('multiSelect toggles selection, submit settles with all selected labels', async () => {
  const { mod, client } = makeModule();
  const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] };
  const { p, kb } = await ask(mod, client, 'telegram-abc', [q]);
  // Tap X
  await mod.handleCallbackQuery({ id: 'm1', data: btn(kb, ':q0:0').callback_data });
  // The refresh edit must re-send the keyboard (incl. the ✅ submit row) so
  // clients re-render it — a text-only edit hid the submit button on the phone.
  const refreshEdit = client.calls.edits[client.calls.edits.length - 1];
  assert.ok(refreshEdit.replyMarkup?.inline_keyboard?.length >= 2, 'refresh edit re-sends keyboard');
  const lastRow = refreshEdit.replyMarkup.inline_keyboard.at(-1);
  assert.ok(lastRow.some((b) => b.text === '✅ 提交'), 'submit button present in refreshed keyboard');
  assert.ok(refreshEdit.text.includes('✅ 提交'), 'refreshed text keeps the submit hint after selecting');
  // Tap Y — still pending (needs submit).
  await mod.handleCallbackQuery({ id: 'm2', data: btn(kb, ':q0:1').callback_data });
  assert.ok(await isPending(p), 'no settle before 提交');
  // Submit
  await mod.handleCallbackQuery({ id: 'm3', data: btn(kb, ':submit').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers[0].selected.sort(), ['X', 'Y']);
});

// Regression: model wrote a "（多选）" question but OMITTED multi_select: true.
// The card must still behave as multi-select (no auto-submit on first tap), not
// fall through to the single-select "tap = answer" path.
console.log('\ncreateQuestionModule: multi-select inferred from wording (regression)');
await test('single question with missing multiSelect flag + "（多选）" text does NOT auto-submit', async () => {
  const { mod, client } = makeModule();
  // NOTE: no `multiSelect` field — mirrors the real request the model sent.
  const q = { id: 'quiz', header: '常识多选题', question: '以下哪些说法是正确的？（多选）', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  const { p, kb } = await ask(mod, client, 'telegram-abc', [q]);
  // Card must show a submit button (needsSubmit) because it's treated as multi.
  assert.ok(kb.flat().some((b) => b.text === '✅ 提交'), 'inferred multi-select card has a submit button');
  // Tap A → must NOT settle (still pending).
  await mod.handleCallbackQuery({ id: 'inf1', data: btn(kb, ':q0:0').callback_data });
  assert.ok(await isPending(p), 'first tap on an inferred multi-select must not auto-submit');
  // Card re-edited to show the selection + keep the submit hint.
  const lastEdit = client.calls.edits[client.calls.edits.length - 1];
  assert.ok(lastEdit.text.includes('已选'), 'selection reflected');
  assert.ok(lastEdit.replyMarkup?.inline_keyboard?.some((row) => row.some((b) => b.text === '✅ 提交')), 'submit button still present');
  // Tap B, then submit → both labels land as a custom string. The model
  // omitted multi_select, so the harness would reject >1 selected; we carry
  // them as custom instead.
  await mod.handleCallbackQuery({ id: 'inf2', data: btn(kb, ':q0:1').callback_data });
  await mod.handleCallbackQuery({ id: 'inf3', data: btn(kb, ':submit').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers[0].selected, []);
  assert.equal(ans.answers[0].custom, 'A、B');
});

// Regression: a single-select tap on a per-question card must NOT settle the
// whole flow (the old bug: it answered only Q1 and silently skipped Q2). It
// records the choice + re-edits that card; locking confirms one question; only
// 🏁 提交全部 on the summary card submits.
console.log('\ncreateQuestionModule: multi-question per-card flow');
await test('multi-question flow: tap records, lock confirms, 提交全部 settles all', async () => {
  const { mod, client } = makeModule();
  const q1 = { id: 'lang', question: '选哪种语言？', options: [{ label: '中文' }, { label: 'English' }] };
  const q2 = { id: 'topic', question: '选哪些主题？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] };
  const { p } = await ask(mod, client, 'telegram-abc', [q1, q2]);
  // 2 question cards + 1 summary card.
  assert.equal(client.calls.sends.length, 3);
  const kb0 = client.calls.sends[0].replyMarkup.inline_keyboard;
  const kb1 = client.calls.sends[1].replyMarkup.inline_keyboard;
  const kbS = client.calls.sends[2].replyMarkup.inline_keyboard;
  // Tap Q1 "English" — records only, no settle.
  const editsBefore = client.calls.edits.length;
  await mod.handleCallbackQuery({ id: 'mq1', data: btn(kb0, ':q0:1').callback_data });
  assert.ok(await isPending(p), 'single-select tap must not settle');
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
  assert.ok(await isPending(p), 'locks alone must not settle');
  // Final submit from the summary card.
  await mod.handleCallbackQuery({ id: 'mq5', data: btn(kbS, ':submit').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers.find((x) => x.id === 'lang').selected, ['English']);
  assert.deepEqual(ans.answers.find((x) => x.id === 'topic').selected, ['A']);
});

await test('option tap on a locked question is ignored (no re-edit, no settle)', async () => {
  const { mod, client } = makeModule();
  const q1 = { id: 'a', question: '一？', options: [{ label: 'A1' }, { label: 'A2' }] };
  const q2 = { id: 'b', question: '二？', options: [{ label: 'B1' }] };
  const { p } = await ask(mod, client, 'telegram-abc', [q1, q2]);
  const kb0 = client.calls.sends[0].replyMarkup.inline_keyboard;
  await mod.handleCallbackQuery({ id: 'lk1', data: btn(kb0, ':lock:q0').callback_data });
  await sleep(1);
  const editsBefore = client.calls.edits.length;
  await mod.handleCallbackQuery({ id: 'lk2', data: btn(kb0, ':q0:1').callback_data });
  await sleep(1);
  assert.equal(client.calls.edits.length, editsBefore, 'no re-edit after locking');
  assert.ok(await isPending(p));
  assert.ok(client.calls.acks.some((a) => String(a.text).includes('已提交')));
});

// Regression (the real-world bug): model wrote "（多选）" questions but OMITTED
// multi_select:true. The harness validates strictly against the raw args and
// rejects >1 selected ('bad-response'), leaving the agent turn blocked forever.
// The plugin must convert such picks to a custom string so the answer lands.
console.log('\ncreateQuestionModule: harness validation mismatch (regression)');
await test('inferred multi-select without multi_select flag converts >1 picks to custom', async () => {
  const { mod, client } = makeModule();
  const q = { id: 'quiz', header: '第1题（多选）', question: '下列哪些动物属于哺乳动物？（多选）', options: [{ label: '蝙蝠' }, { label: '企鹅' }, { label: '海豚' }, { label: '鲨鱼' }] };
  const { p, kb } = await ask(mod, client, 'telegram-abc', [q]);
  await mod.handleCallbackQuery({ id: 'mm1', data: btn(kb, ':q0:0').callback_data }); // 蝙蝠
  await mod.handleCallbackQuery({ id: 'mm2', data: btn(kb, ':q0:2').callback_data }); // 海豚
  await mod.handleCallbackQuery({ id: 'mm3', data: btn(kb, ':submit').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers[0].selected, []);
  assert.equal(ans.answers[0].custom, '蝙蝠、海豚');
});

await test('explicit multi_select:true keeps selected labels (no conversion)', async () => {
  const { mod, client } = makeModule();
  const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] };
  const { p, kb } = await ask(mod, client, 'telegram-abc', [q]);
  await mod.handleCallbackQuery({ id: 'ex1', data: btn(kb, ':q0:0').callback_data });
  await mod.handleCallbackQuery({ id: 'ex2', data: btn(kb, ':q0:1').callback_data });
  await mod.handleCallbackQuery({ id: 'ex3', data: btn(kb, ':submit').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers[0].selected.sort(), ['X', 'Y']);
  assert.equal(ans.answers[0].custom, undefined);
});

console.log('\ncreateQuestionModule: delegation + signals');
await test('questions for a web agent (ownership null) go to next()', async () => {
  const { mod, client } = makeModule();
  const { p } = await ask(mod, client, 'web-session-xyz', [singleQ]);
  assert.equal(client.calls.sends.length, 0, 'no card posted');
  assert.equal(nextCalls, 1, 'delegated to the web answerer');
  const ans = await p;
  assert.deepEqual(ans, { answers: [] }, "next()'s outcome flows through to the caller");
});

await test('card send failure delegates the ask to next() (web UI keeps it)', async () => {
  const client = makeClient({ failSend: new Error('Telegram down') });
  nextCalls = 0;
  const mod = createQuestionModule({
    log: () => {},
    escape: esc,
    client,
    ownership: () => ({ chatId: '123', botId: 'a', threadId: null }),
  });
  const webAnswer = { answers: [{ id: 'lang', selected: ['Web'] }] };
  const p = mod.handleRequest(
    { questions: [singleQ], agent: { id: 'telegram-abc', session: { id: 'telegram-abc' } } },
    async () => { nextCalls++; return webAnswer; },
  );
  p.catch(() => {});
  const ans = await p;
  assert.equal(nextCalls, 1, 'failed send delegates to next()');
  assert.deepEqual(ans, webAnswer, "next()'s outcome resolves our promise");
  assert.equal(client.calls.edits.length, 0, 'no card edits after delegation');
  assert.equal(mod.pending.size, 0, 'entry left pending — a stale tap cannot double-settle');
});

await test('already-aborted signal rejects with ASK_ABORTED and posts no card', async () => {
  const { mod, client } = makeModule();
  const ac = new AbortController();
  ac.abort();
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ], { signal: ac.signal });
  const err = await rejection(p);
  assert.ok(err, 'the ask rejects');
  assert.equal(err.code, 'ASK_ABORTED');
  assert.equal(client.calls.sends.length, 0, 'no card for an already-aborted ask');
  assert.equal(nextCalls, 0);
});

await test('abort mid-flight rejects with ASK_ABORTED and settles the card', async () => {
  const { mod, client } = makeModule();
  const ac = new AbortController();
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ], { signal: ac.signal });
  ac.abort();
  const err = await rejection(p);
  assert.equal(err.code, 'ASK_ABORTED');
  assert.ok(client.calls.edits.length >= 1, 'card settled');
  assert.equal(mod.pending.size, 0, 'abort listener cleaned + entry dropped');
});

await test('stale callback (unknown/expired key) acks without settling', async () => {
  const { mod, client } = makeModule();
  const { p, kb } = await ask(mod, client, 'telegram-abc', [singleQ]);
  // A key we never issued:
  await mod.handleCallbackQuery({ id: 'stale', data: `${QUESTION_CALLBACK_PREFIX}zzz:cancel` });
  await sleep(1);
  assert.ok(client.calls.acks.some((a) => a.text.includes('已过期')));
  assert.ok(await isPending(p), 'ask unaffected');
  // A tap on the REAL card still works afterwards.
  await mod.handleCallbackQuery({ id: 'real', data: btn(kb, ':q0:1').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['English'] }]);
});

// ---------------------------------------------------------------------------
// Auto-cancel timeout (questionsTimeoutSec)
// ---------------------------------------------------------------------------
console.log('\ncreateQuestionModule: auto-cancel timeout');
await test('timeoutMs>0: card auto-cancels after timeout, settles with ⏰ label', async () => {
  const { mod, client } = makeModule({ timeoutMs: 1000 });
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ]);
  // Posted card shows the timeout hint.
  assert.ok(client.calls.sends[0].text.includes('⏰ 1 秒后自动取消'), `card text: ${client.calls.sends[0].text}`);
  const err = await rejection(p);
  assert.ok(err, 'timed-out ask rejects');
  assert.equal(err.code, 'ASK_CANCELLED');
  assert.ok(client.calls.edits.some((e) => e.text.includes('⏰ 已超时自动取消')));
});

await test('timeoutMs=0: no auto-cancel (default behaviour unchanged)', async () => {
  const { mod, client } = makeModule({ timeoutMs: 0 });
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ]);
  await sleep(50);
  assert.ok(await isPending(p), 'no timeout when disabled');
  assert.ok(!client.calls.sends[0].text.includes('自动取消'), 'no timeout hint when disabled');
});

await test('answering before timeout clears the timer (no late auto-cancel)', async () => {
  const { mod, client } = makeModule({ timeoutMs: 80 });
  const { p, kb } = await ask(mod, client, 'telegram-abc', [singleQ]);
  await mod.handleCallbackQuery({ id: 'to3', data: btn(kb, ':q0:0').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['中文'] }]);
  await sleep(150); // past the timeout — nothing further happens
  assert.equal(client.calls.edits.filter((e) => e.text.includes('已超时')).length, 0);
});

await test('cancelAll settles pending asks silently (no card edits, ASK_CANCELLED)', async () => {
  const { mod, client } = makeModule({ timeoutMs: 60 });
  const { p } = await ask(mod, client, 'telegram-abc', [singleQ]);
  const editsBefore = client.calls.edits.length;
  mod.cancelAll();
  const err = await rejection(p);
  assert.equal(err.code, 'ASK_CANCELLED');
  await sleep(150); // past the (now-cleared) timeout
  assert.equal(client.calls.edits.length, editsBefore, 'silent unload — no network');
  assert.equal(mod.pending.size, 0);
});

await test('cancelAll on unload forgets pending cards', async () => {
  const { mod, client } = makeModule();
  const { p, kb } = await ask(mod, client, 'telegram-abc', [singleQ]);
  mod.cancelAll();
  await rejection(p);
  // After unload, a callback no longer resolves anything (unknown/expired key).
  await mod.handleCallbackQuery({ id: 'u1', data: btn(kb, ':cancel').callback_data });
  await sleep(1);
  assert.ok(client.calls.acks.some((a) => a.text.includes('已过期')));
});

// ---------------------------------------------------------------------------
// Autopilot auto-adopt (v0.5.0)
// ---------------------------------------------------------------------------
const apQ = { id: 'lang', question: '选哪种语言？', options: [
  { label: '中文（推荐）' },
  { label: 'English' },
] };

console.log('\ncreateQuestionModule: autopilot');
await test('window=0: autopilot posts the auto card and commits the recommended option', async () => {
  const { mod, client } = makeModule({ isAutopilot: () => true, autopilotWindowMs: 0 });
  const { p } = await ask(mod, client, 'telegram-abc', [apQ]);
  // One autopilot notice card posted.
  assert.equal(client.calls.sends.length, 1);
  const kb = client.calls.sends[0].replyMarkup.inline_keyboard;
  assert.ok(kb.flat().some((b) => b.callback_data.endsWith(':adopt') && b.text === '⏩ 立即采纳'));
  assert.ok(kb.flat().some((b) => b.callback_data.endsWith(':takeover')));
  // Committed automatically with the recommended (first) option.
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['中文（推荐）'] }]);
  // Card settled to a locked state.
  await sleep(1);
  assert.ok(client.calls.edits.length >= 1);
});
await test('window>0: schedules the commit; ✋ takeover goes manual + re-renders the interactive card', async () => {
  let tookOver = null;
  const { mod, client } = makeModule({
    isAutopilot: () => true, autopilotWindowMs: 60_000, autopilotTakeover: (c) => { tookOver = c; },
  });
  const { p } = await ask(mod, client, 'telegram-abc', [apQ]);
  const kb = client.calls.sends[0].replyMarkup.inline_keyboard;
  // Not yet answered (window pending).
  assert.ok(await isPending(p));
  // Tap ✋ 接管 → calls autopilotTakeover, re-renders the normal interactive card.
  await mod.handleCallbackQuery({ id: 'ap1t', data: btn(kb, ':takeover').callback_data });
  await sleep(5);
  assert.equal(tookOver, '123', 'takeover disables autopilot for the chat');
  assert.ok(await isPending(p), 'takeover must NOT settle');
  // The card is now the interactive one (option buttons back, no adopt button).
  const lastEdit = client.calls.edits.at(-1);
  const rows = lastEdit.replyMarkup?.inline_keyboard ?? [];
  assert.ok(rows.flat().some((b) => b.callback_data.endsWith(':q0:0')), 'interactive option buttons restored');
  assert.ok(!rows.flat().some((b) => b.callback_data.endsWith(':adopt')), 'adopt button gone');
  // Manual answer finishes the ask.
  await mod.handleCallbackQuery({ id: 'ap1o', data: btn(rows, ':q0:1').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['English'] }]);
});
await test('window>0: ⏩ 立即采纳 commits immediately with the recommended option', async () => {
  const { mod, client } = makeModule({ isAutopilot: () => true, autopilotWindowMs: 60_000 });
  const { p } = await ask(mod, client, 'telegram-abc', [apQ]);
  const kb = client.calls.sends[0].replyMarkup.inline_keyboard;
  assert.ok(await isPending(p));
  await mod.handleCallbackQuery({ id: 'ap2a', data: btn(kb, ':adopt').callback_data });
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'lang', selected: ['中文（推荐）'] }]);
});
await test('autopilot falls back to the normal card when no option is auto-pickable', async () => {
  const noPick = { id: 'x', question: 'q', options: [] }; // empty options → pickRecommended []
  const { mod, client } = makeModule({ isAutopilot: () => true, autopilotWindowMs: 0 });
  const { p } = await ask(mod, client, 'telegram-abc', [noPick]);
  // No autopilot card (no auto-pick) → normal interactive card instead.
  assert.equal(client.calls.sends.length, 1);
  const kb = client.calls.sends[0].replyMarkup.inline_keyboard;
  assert.ok(!kb.flat().some((b) => b.callback_data.endsWith(':adopt')), 'no autopilot adopt button');
  assert.ok(await isPending(p), 'must not auto-submit an empty answer');
});
await test('non-autopilot chat: isAutopilot false → normal interactive card (no adopt)', async () => {
  const { mod, client } = makeModule({ isAutopilot: () => false });
  const { kb } = await ask(mod, client, 'telegram-abc', [apQ]);
  assert.ok(!kb.flat().some((b) => b.callback_data.endsWith(':adopt')), 'no autopilot button when off');
  assert.ok(kb.flat().some((b) => b.callback_data.endsWith(':q0:0')), 'normal option buttons present');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
