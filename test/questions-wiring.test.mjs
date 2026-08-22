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
import { apply } from '../src/index.js';
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
    if (seen.length < 5000) seen.push({ method, body: opts?.body ? JSON.parse(opts.body) : null });
    let payload;
    if (method === 'getMe') payload = { ok: true, result: { id: 1, is_bot: true, first_name: 'rt', username: 'rtbot' } };
    else if (method === 'getUpdates') payload = { ok: true, result: [] };
    else if (method === 'sendMessage' || method === 'editMessageText') payload = { ok: true, result: { message_id: 777, chat: { id: '1' } } };
    else payload = { ok: true, result: true };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { restore: () => { globalThis.fetch = origFetch; }, seen };
}

// Fake mux WebSocket: opens, then delivers one question/requested frame.
class FakeMuxWS {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    const frame = {
      type: 'server-request',
      rpcId: 'rpc-rt-33',
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: 'telegram-rt-33',
        questions: [{ id: 'q1', question: 'Pick one?', header: 'H', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      },
    };
    setTimeout(() => { (this.handlers.open || []).forEach((f) => f({})); }, 5);
    setTimeout(() => { (this.handlers.message || []).forEach((f) => f({ data: JSON.stringify(frame) })); }, 40);
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
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
