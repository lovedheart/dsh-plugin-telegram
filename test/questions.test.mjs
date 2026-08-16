// Unit tests for the ask_user_question Telegram answerer (questions.js).
// Run: node test/questions.test.mjs
import { strict as assert } from 'node:assert';
import {
  QUESTION_CALLBACK_PREFIX,
  parseQuestionCallback,
  buildQuestionCard,
  createQuestionModule,
  parseSseFrames,
  createMuxSubscriber,
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
    async editMessageText(chatId, id, text, parseMode) { calls.edits.push({ chatId, id, text }); return true; },
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

await test('multi-question card labels Q1/Q2 and shows a submit button', () => {
  const qs = [
    { id: 'a', question: '第一个？', options: [{ label: 'A1' }] },
    { id: 'b', question: '第二个？', options: [{ label: 'B1' }] },
  ];
  const { text, keyboard } = buildQuestionCard(qs, esc);
  assert.ok(text.includes('Q1：第一个？'));
  assert.ok(text.includes('Q2：第二个？'));
  assert.ok(keyboard.flat().some((b) => b.callback_data.endsWith(':submit')));
  assert.ok(!text.includes('也可以直接回复')); // multi → buttons only
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
  // card settled → edited to answered state
  await sleep(1);
  assert.ok(client.calls.edits.some((e) => e.text.includes('✅ 已回答')));
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
  // Settled as delegated (web won) — NO respond() call from us.
  assert.equal(state.responses.length, 0);
  assert.ok(client.calls.edits.some((e) => e.text.includes('🌐')));
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
  assert.ok(client.calls.edits.some((e) => e.text.includes('🌐')));
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
// createMuxSubscriber — integration with a fake global fetch (SSE stream)
// ---------------------------------------------------------------------------

console.log('\ncreateMuxSubscriber (fake fetch):');
await test('feeds question frames to onFrame and stop() halts it', async () => {
  const realFetch = globalThis.fetch;
  const received = [];
  let aborted = false;
  const enc = new TextEncoder();
  // Real frame shape: { type, rpcId, method, payload } — rpcId sits at the
  // ROOT, payload carries the question details.
  const chunk1 = enc.encode(`: connected\ndata: {"type":"server-request","rpcId":"r1","method":"question/requested","payload":{"type":"question/requested","sessionId":"telegram-x","questions":[{"id":"a","question":"q","options":[{"label":"L"}]}]}}\n\n`);
  const chunk2 = enc.encode(`data: {"type":"server-request","rpcId":"r1","payload":{"type":"question/resolved","questionRpcId":"r1","outcome":"answered"}}\n\n`);
  globalThis.fetch = async (url, opts) => {
    assert.ok(String(url).endsWith('/api/events.mux'));
    return {
      ok: true,
      body: (async function* () {
        yield chunk1;
        yield chunk2;
        // Stay open (like a real SSE stream) until the controller aborts, so
        // the test is deterministic — the subscriber only leaves via stop().
        if (opts.signal) {
          if (opts.signal.aborted) return;
          await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
          aborted = true;
        }
      })(),
    };
  };
  try {
    const sub = createMuxSubscriber({
      url: 'http://127.0.0.1:3080',
      log: () => {},
      onFrame: (f) => received.push(f.payload.type),
    });
    // Poll until both frames are in (bounded) — no fixed-timing flake.
    const deadline = Date.now() + 2000;
    while (received.length < 2 && Date.now() < deadline) await sleep(5);
    assert.deepEqual(received, ['question/requested', 'question/resolved']);
    sub.stop();
    await sleep(1); // let the abort listener (microtask) mark aborted
    assert.equal(aborted, true); // stop() must abort the controller
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
