// Regression tests — the v0.6.4 dual bug fix:
//
//   BUG 1 (web questions leaked to the phone): telegramAgentOwnership Case 2
//   claimed the deployment's DEFAULT (shared web) agent whenever
//   `hit === all[0]`, a premise from before v0.6.2's per-(bot,chat) isolation
//   (resolveChatAgent used to fall back to all[0]). Since v0.6.2 inbound
//   Telegram messages auto-create telegram-* agents, so the shared agent is
//   only Telegram-owned when a chatAgents entry actually routes a chat to it
//   (e.g. via /use). Un-routed → the web UI keeps the question card.
//
//   BUG 2 (telegram sessions invisible in the web sidebar): agents created by
//   this plugin go through the agents service, never the host's session.create
//   route, so no workspace ever claimed them → "Ungrouped"; and the injected
//   messages carry source.kind 'plugin', which the title service ignores →
//   title stays null. Fix: attachSession via workspaceRegistry at creation
//   and seed a display title from the first Telegram text via
//   sessionTitle.rename (never overwriting an existing title).
//
// Own process: keeps the multi-bot suite's heap budget intact (see that
// suite's OOM note).

import { strict as assert } from 'node:assert';
import { apply, botRegistry, __testHooks } from '../src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

let passed = 0, failed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitMe(id) {
  const start = Date.now();
  while (!botRegistry.get(id)?.me && Date.now() - start < 2000) await sleep(10);
}

function mockTelegramApi() {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const m = u.match(/\/bot([^/]+)\/(\w+)/);
    const method = m ? m[2] : '';
    if (method === 'getUpdates') await sleep(120);
    if (seen.length < 5000) seen.push({ method, token: m ? m[1] : '', body: opts?.body ? JSON.parse(opts.body) : null });
    let payload;
    if (method === 'getMe') payload = { ok: true, result: { id: 1, is_bot: true, first_name: 'rt', username: 'rtbot' } };
    else if (method === 'getUpdates') payload = { ok: true, result: [] };
    else if (method === 'sendMessage' || method === 'editMessageText') payload = { ok: true, result: { message_id: 888, chat: { id: '1' } } };
    else payload = { ok: true, result: true };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { restore: () => { globalThis.fetch = origFetch; }, seen };
}

function makeAgents() {
  const agents = [];
  const defaultAgent = {
    session: { id: 'AG0', events: [], header: { cwd: process.cwd ? process.cwd() : process.cwd(), origin: 'root' } },
    status: 'idle',
    followupCalls: [],
    followup(m) { defaultAgent.followupCalls.push(m); },
    cancel() {},
  };
  agents.push(defaultAgent);
  const svc = {
    list: () => agents.slice(),
    create: async (opts) => {
      const a = {
        session: { id: opts.sessionId, events: [], header: { cwd: process.cwd(), origin: 'root', botId: opts?.meta?.botId } },
        status: 'idle',
        followupCalls: [],
        followup(m) { a.followupCalls.push(m); },
        cancel() {},
      };
      agents.push(a);
      return a;
    },
  };
  return { svc, defaultAgent, created: () => agents.filter((a) => a !== defaultAgent) };
}

function makeCtx(overrides = {}) {
  const effects = [];
  const listeners = []; // { event, fn } — v0.7.0: in-process waterfall registrations
  const ctx = {
    tools: { register: () => {} },
    on: (event, fn) => { listeners.push({ event, fn }); },
    effect: (fn) => { effects.push(fn()); return () => {}; },
    get: (k) => (k in overrides ? overrides[k] : undefined),
  };
  // Fire the `user-questions/request` waterfall the way dsh 0.1.3-alpha.2
  // does: answerer first (prepend), then a `next()` standing in for the web
  // answerer. Returns the answerer's promise (or next()'s outcome when
  // delegated).
  const fireQuestion = (request) => {
    const entry = listeners.find((l) => l.event === 'user-questions/request');
    if (!entry) throw new Error('no user-questions/request listener registered');
    let nextCalled = false;
    const next = async () => { nextCalled = true; return { answers: [] }; };
    const p = entry.fn(request, next);
    p.nextCalled = () => nextCalled;
    return p;
  };
  return { ctx, effects, fireQuestion };
}

function baseConfig() {
  return {
    pollingEnabled: true, longPollTimeout: 30, defaultChatId: '1',
    allowedUsers: ['u'], requireMention: false, agentResponseMode: 'direct',
    verbose: false, approvalEnabled: false, questionsEnabled: false,
    questionsForDefaultAgent: true, progressEnabled: false, subagentBoardEnabled: false,
  };
}

function isolateDir() {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'tg-own-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return { restore: () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; } };
}
function cleanupAll(effects) { for (const eff of effects) { try { eff(); } catch { /* ignore */ } } }

console.log('ownership & visibility fixes (v0.6.4):');

// ---- Bug 1: the shared WEB agent's questions must NOT reach the phone ----
await atest('question from unrouted shared default agent → no card (web keeps it)', async () => {
  const api = mockTelegramApi();
  const { restore: restDir } = isolateDir();
  const ag = makeAgents();
  const { ctx, effects, fireQuestion } = makeCtx({ agents: ag.svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      botToken: 'OWN1', questionsEnabled: true, questionsForDefaultAgent: true,
    }));
    // v0.7.0: the ask arrives through the in-process waterfall with the live
    // calling agent — here the shared (web) default agent, session id AG0.
    const p = fireQuestion({
      questions: [{ id: 'q1', question: 'WEB-ONLY question?', header: 'H', options: [{ label: 'A' }] }],
      agent: ag.defaultAgent,
    });
    p.catch(() => {});
    const ans = await p;
    assert.deepEqual(ans, { answers: [] }, 'delegated to the web answerer via next()');
    assert.ok(p.nextCalled(), 'next() was called (web keeps the question)');
    const card = api.seen.find((s) => s.method === 'sendMessage' && s.body?.text?.includes('WEB-ONLY question?'));
    assert.ok(!card, 'shared default agent question NOT claimed (no chatAgents route to it)');
  } finally {
    cleanupAll(effects); api.restore(); restDir();
  }
});

await atest('chat explicitly /use-routed to the shared agent → card on the phone', async () => {
  const api = mockTelegramApi();
  const { restore: restDir } = isolateDir();
  const ag = makeAgents();
  const { ctx, effects, fireQuestion } = makeCtx({ agents: ag.svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      botToken: 'OWN2', questionsEnabled: true, questionsForDefaultAgent: true,
    }));
    // Simulate `/use AG0`: this chat explicitly routes to the shared agent.
    __testHooks.chatAgents.set('default::1', 'AG0');
    const p = fireQuestion({
      questions: [{ id: 'q1', question: 'ROUTED question?', header: 'H', options: [{ label: 'A' }] }],
      agent: ag.defaultAgent,
    });
    p.catch(() => {});
    assert.ok(!p.nextCalled(), 'routed shared agent is claimed, not delegated');
    const start = Date.now();
    let card = null;
    while (Date.now() - start < 3000) {
      card = api.seen.find((s) => s.method === 'sendMessage' && s.body?.text?.includes('ROUTED question?'));
      if (card) break;
      await sleep(20);
    }
    assert.ok(card, 'explicitly routed shared agent IS claimed (old /use behavior preserved)');
    assert.equal(String(card.body.chat_id), '1', 'card went to the routed chat');
  } finally {
    __testHooks.chatAgents.delete('default::1');
    cleanupAll(effects); api.restore(); restDir();
  }
});

// ---- Bug 2: created agents attach to the workspace + get a display title ----
await atest('/new agent attaches to the workspace (visible in web sidebar)', async () => {
  const rec = mockTelegramApi();
  const { restore: restDir } = isolateDir();
  const fa = makeAgents();
  const attached = [];
  const wsSvc = { resolveByPath: async (p) => ({ path: p, attachSession: async (id) => { attached.push(id); } }) };
  const { ctx, effects } = makeCtx({ agents: fa.svc, workspaceRegistry: wsSvc });
  try {
    await apply(ctx, Object.assign(baseConfig(), { botToken: "OWNT" }));
    await waitMe('default');
    const h = botRegistry.get('default').poller.messageHandlers[0];
    await h({ chatId: '1', messageId: 900, chatType: 'private', senderId: 'u', text: '/new' });
    const created = fa.created()[fa.created().length - 1];
    assert.ok(created.session.id.startsWith('telegram-'), 'created a telegram-* agent');
    assert.deepEqual(attached, [created.session.id], 'workspaceRegistry.attachSession called once with the new session id');
  } finally { cleanupAll(effects); restDir(); rec.restore(); }
});

await atest('first message seeds the session title; existing titles untouched; seeds once', async () => {
  const rec = mockTelegramApi();
  const { restore: restDir } = isolateDir();
  const fa = makeAgents();
  const titles = new Map();
  const renames = [];
  const titleSvc = {
    get: (s) => (titles.has(s.id) ? { title: titles.get(s.id) } : undefined),
    rename: (s, t) => { renames.push([s.id, t]); titles.set(s.id, t); },
  };
  const { ctx, effects } = makeCtx({ agents: fa.svc, sessionTitle: titleSvc });
  try {
    await apply(ctx, Object.assign(baseConfig(), { botToken: "OWNT" }));
    await waitMe('default');
    const h = botRegistry.get('default').poller.messageHandlers[0];
    await h({ chatId: '1', messageId: 910, chatType: 'private', senderId: 'u', text: '/new' });
    const created = fa.created()[fa.created().length - 1];
    await h({ chatId: '1', messageId: 911, chatType: 'private', senderId: 'u', text: 'how do I   fix\nthe telegram bridge?' });
    assert.equal(renames.length, 1, 'rename called exactly once for the first message');
    assert.equal(renames[0][0], created.session.id, 'rename targeted the telegram session');
    assert.equal(renames[0][1], 'how do I fix the telegram bridge?', 'title = collapsed first-message text');
    await h({ chatId: '1', messageId: 912, chatType: 'private', senderId: 'u', text: 'second message' });
    assert.equal(renames.length, 1, 'existing title never overwritten');
  } finally { cleanupAll(effects); restDir(); rec.restore(); }
});

await atest('web session with a real title is never renamed by injection', async () => {
  const rec = mockTelegramApi();
  const { restore: restDir } = isolateDir();
  const fa = makeAgents();
  const renames = [];
  const titleSvc = {
    get: (s) => (s.id === 'AG0' ? { title: 'web-title' } : undefined),
    rename: (s, t) => { renames.push([s.id, t]); },
  };
  const { ctx, effects } = makeCtx({ agents: fa.svc, sessionTitle: titleSvc });
  try {
    await apply(ctx, Object.assign(baseConfig(), { botToken: "OWNT" }));
    await waitMe('default');
    // Route the chat to the shared agent the way /use does (since v0.6.2 an
    // unrouted chat auto-creates a telegram-* agent instead).
    __testHooks.chatAgents.set('default::1', 'AG0');
    const h = botRegistry.get('default').poller.messageHandlers[0];
    await h({ chatId: '1', messageId: 920, chatType: 'private', senderId: 'u', text: 'hello default agent' });
    assert.ok(fa.defaultAgent.followupCalls.length >= 1, 'message still injected into the default agent');
    assert.equal(renames.length, 0, 'non-telegram / titled session never renamed');
  } finally { cleanupAll(effects); restDir(); rec.restore(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
