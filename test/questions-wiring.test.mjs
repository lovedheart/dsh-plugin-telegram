// Regression test — the v0.6.0 multi-bot wiring bug (the one that made
// ask_user_question cards invisible on the phone):
//
//   apply() handed the question (and approval) modules `activeClient: moduleClient`,
//   but both modules read `deps.client`. Result: deps.client === undefined and
//   every card send threw "Cannot read properties of undefined (reading
//   'sendMessage')" — the journal showed onRequested + ownership hit, then
//   CARD-SEND-FAIL, so the user saw nothing on Telegram.
//
// This test drives the REAL chain end to end: apply() → createMuxSubscriber
// (stubbed WebSocket) → question module → clientDispatch → TelegramClient
// → (stubbed fetch) Telegram API. It asserts the card's sendMessage actually
// reaches the wire with option buttons.
//
// Kept in its OWN process: the multi-bot suite accumulates a large live heap
// across ~32 apply() calls and a 33rd apply OOMs a 512MB test heap.

import { strict as assert } from 'node:assert';
import { apply, botRegistry, __testHooks } from '../src/index.js';
import { QUESTION_CALLBACK_PREFIX } from '../src/questions.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

let passed = 0, failed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockTelegramApi() {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const m = u.match(/\/bot([^/]+)\/(\w+)/);
    const method = m ? m[2] : '';
    // The real Telegram getUpdates long-polls for up to longPollTimeout;
    // resolve it slowly so the poll loop does NOT spin (a tight spin
    // allocates millions of objects per second and OOMs a small test heap).
    if (method === 'getUpdates') await sleep(150);
    if (seen.length < 5000) seen.push({ method, token: m ? m[1] : '', body: opts?.body ? JSON.parse(opts.body) : null });
    let payload;
    if (method === 'getMe') payload = { ok: true, result: { id: 1, is_bot: true, first_name: 'rt', username: 'rtbot' } };
    else if (method === 'getUpdates') payload = { ok: true, result: [] };
    else if (method === 'sendMessage' || method === 'editMessageText') payload = { ok: true, result: { message_id: 777, chat: { id: '1' } } };
    else payload = { ok: true, result: true };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { restore: () => { globalThis.fetch = origFetch; }, seen };
}

// The mux frame the next FakeMuxWS delivers. Defaults to the rt-33 frame;
// tests that need a different question (e.g. multi-bot routing) set it first.
let muxFrame = {
  type: 'server-request',
  rpcId: 'rpc-rt-33',
  method: 'question/requested',
  payload: {
    type: 'question/requested',
    sessionId: 'telegram-rt-33',
    questions: [{ id: 'q1', question: 'Pick one?', header: 'H', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
  },
};
const resetMuxFrame = () => {
  muxFrame = {
    type: 'server-request',
    rpcId: 'rpc-rt-33',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'telegram-rt-33',
      questions: [{ id: 'q1', question: 'Pick one?', header: 'H', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
    },
  };
};

// Fake mux WebSocket: opens, then delivers one question/requested frame.
class FakeMuxWS {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    setTimeout(() => { (this.handlers.open || []).forEach((f) => f({})); }, 5);
    setTimeout(() => { (this.handlers.message || []).forEach((f) => f({ data: JSON.stringify(muxFrame) })); }, 40);
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  close() {}
}

function makeCtx() {
  const effects = [];
  const ctx = {
    tools: { register: () => {} },
    on: () => {},
    effect: (fn) => { effects.push(fn()); return () => {}; },
    get: () => undefined,
  };
  return { ctx, effects };
}

function baseConfig() {
  return {
    pollingEnabled: true,
    longPollTimeout: 30,
    defaultChatId: '1',
    allowedUsers: ['u'],
    requireMention: true,
    agentResponseMode: 'direct',
    verbose: false,
    approvalEnabled: true,
    approvalForDefaultAgent: true,
    questionsEnabled: true,
    questionsForDefaultAgent: true,
    subagentBoardEnabled: true,
  };
}

function isolateDir() {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'tg-qw-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return { restore: () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; } };
}

console.log('questions wiring (apply → mux → module → client → wire):');

await atest('apply() wires a working client into the question module (card actually posts)', async () => {
  const api = mockTelegramApi();
  const origWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeMuxWS;
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      botToken: 'RT33',
      webUrl: 'http://127.0.0.1:9', // never dialled — the WebSocket global is stubbed
    }));
    const start = Date.now();
    let sent = null;
    while (Date.now() - start < 3000) {
      sent = api.seen.find((s) => s.method === 'sendMessage' && s.body?.text?.includes('Pick one?'));
      if (sent) break;
      await sleep(20);
    }
    assert.ok(sent, 'question card sendMessage reached the wire through the real client chain');
    const kb = sent.body.reply_markup?.inline_keyboard;
    assert.ok(Array.isArray(kb) && kb.length >= 2, 'card carries option buttons');
    assert.ok(JSON.stringify(kb).includes('Alpha') && JSON.stringify(kb).includes('Beta'), 'option labels on buttons');
  } finally {
    for (const eff of effects) { try { eff(); } catch { /* ignore */ } }
    globalThis.WebSocket = origWS;
    api.restore();
    restDir();
    resetMuxFrame();
  }
});

// Regression test — the v0.6.1 multi-bot SUBMIT bug (the one that made a tapped
// "✅ 提交" appear to do nothing on the phone):
//
//   The question module acks via deps.client.answerCallbackQuery(callbackId,
//   text). Under multi-bot, deps.client is the clientDispatch proxy. Its
//   positional heuristic read the FIRST string/number arg as a chatId, but for
//   answerCallbackQuery that arg is a callback TOKEN — so botIdForChat(token)
//   returned the 'default' sentinel, which overrode the correct active-card bot
//   and made clientFor('default') throw SYNCHRONOUSLY. The wrapper's .catch()
//   can't catch a sync throw, so the whole submit branch died before the
//   answer POST ran → the card never flipped and the agent hung. Legacy
//   single-bot masked it (botIdForChat falls back to 'default', which IS a
//   registered bot there). T18 in the multi-bot suite missed it because it
//   drives a NON-question callback that falls through to the source-bot
//   fallback (index.js answerCallbackQuery with the known botId), bypassing the
//   proxy. This test drives the REAL chain: apply(multi-bot) → question module
//   → clientDispatch proxy → answerCallbackQuery on the OWNING bot's wire.
await atest('multi-bot: tapping 提交 acks on the owning bot (clientDispatch routes answerCallbackQuery)', async () => {
  const api = mockTelegramApi();
  const origWS = globalThis.WebSocket;
  // Route the question to bob's chat (2) so ownership resolves to chatId '2'.
  muxFrame = {
    type: 'server-request',
    rpcId: 'rpc-rt-mb',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'telegram-rt-mb',
      // multiSelect (camelCase = the broadcast form; dsh-tool-ask-user maps the
      // tool's `multi_select` → `multiSelect` before pushing the frame). A
      // multi-select card carries a "✅ 提交" row; single-select has none.
      questions: [{ id: 'q1', question: 'MB pick?', header: 'H', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }],
    },
  };
  globalThis.WebSocket = FakeMuxWS;
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      // Multi-bot: NO 'default' bot exists, so the old bug (clientFor('default'))
      // throws and the ack never reaches the wire.
      bots: [
        { id: 'alice', token: 'TOK_MBA', allowedUsers: ['u1'] },
        { id: 'bob', token: 'TOK_MBB', allowedUsers: ['u2'] },
      ],
      // No top-level defaultChatId; chat routing must come from chatAgents.
      defaultChatId: null,
      webUrl: 'http://127.0.0.1:9', // never dialled — WebSocket global stubbed
    }));
    // Register the chat→bot + chat→session mapping the way /new / an inbound
    // message would, so ownership Case 1 resolves chatId '2' (bob's chat).
    __testHooks.chatAgents.set('bob::2', 'telegram-rt-mb');
    __testHooks.chatAgents.set('alice::1', 'telegram-rt-a'); // alice owns chat 1
    const start = Date.now();
    let card = null;
    while (Date.now() - start < 3000) {
      card = api.seen.find((s) => s.method === 'sendMessage' && s.body?.text?.includes('MB pick?'));
      if (card) break;
      await sleep(20);
    }
    assert.ok(card, 'question card posted to bob chat 2 through the real client chain');
    assert.equal(card.token, 'TOK_MBB', 'card went out on BOB\'s token (owning bot)');
    // The single-question submit button's callback_data carries the entry key.
    const submitBtn = (card.body.reply_markup?.inline_keyboard || [])
      .flat()
      .find((b) => String(b.callback_data).endsWith(':submit'));
    assert.ok(submitBtn, 'card has a submit button');
    const submitData = submitBtn.callback_data;
    // Drive the tap through the REAL registered poller callback handler (the
    // production wrapper that sets the active-card bot then calls the module).
    const pa = botRegistry.get('alice').poller; // firstBotId = alice (main poller)
    const cbHandler = pa.callbackHandlers[0];
    assert.ok(cbHandler, 'a callback handler is registered on the main poller');
    await cbHandler({
      id: 'cb-mb-1',
      from: { id: 'u2', username: 'u2' },
      message: { message_id: 42, chat: { id: '2', type: 'private' } },
      data: submitData,
    });
    // The ack must land on BOB's client — not throw, not on alice.
    const acks = api.seen.filter((s) => s.method === 'answerCallbackQuery' && s.body?.callback_query_id === 'cb-mb-1');
    assert.equal(acks.length, 1, 'exactly one answerCallbackQuery for the tap');
    assert.equal(acks[0].token, 'TOK_MBB', 'ack answered on BOB (owning bot), not the missing "default"');
  } finally {
    for (const eff of effects) { try { eff(); } catch { /* ignore */ } }
    globalThis.WebSocket = origWS;
    api.restore();
    restDir();
    resetMuxFrame();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
