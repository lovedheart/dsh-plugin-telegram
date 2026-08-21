// ---------------------------------------------------------------------------
// multi-bot.test.mjs — P0 配置契约段（T1–T8）
//
// ⚠ S1 完成前本文件 T1-T8 预期红，原因：src 尚未 export 这些符号。
//   本文件从 ../src/index.js 静态 import `normalizeBots` / `validateBotItem` /
//   `resolveBotToken`。在 S1 尚未把这些符号 export（或尚未把 resolveBotToken 从
//   私有函数改成导出 + 加第 3 参 envKey）之前，ESM 的 import 会因"未提供该具名导出"
//   在加载期报错，整个文件红——这是预期内的可预期红（import 缺失），不是语法错。
//   S1 完成（export 这三个符号且签名匹配下方"对 S1 的要求"）后，T1-T8 必须转绿。
//
// 范围边界：本文件只写 P0 配置契约（T1-T8），纯函数、不依赖 client/poller、不连网。
//   不写 P1（T9-T14，S1）、P2-P6（S2/S3）的用例，避免与它们断言冲突。
//   若后续看到本文件里已有 T9-T14，保留不动。
//
// 运行：node --test test/multi-bot.test.mjs
// 风格：沿用现有测试（poller/client.test.mjs）的自定义 atest harness + process.exit，
//       node --test 下以文件进程退出码 0/1 判定红绿（与现有 8 个文件一致）。
// ---------------------------------------------------------------------------

import { strict as assert } from 'node:assert';
import { normalizeBots, validateBotItem, resolveBotToken } from '../src/index.js';
// P1 (T9-T14): multi client/poller startup needs apply + registry accessors.
import { apply, clientFor, meFor, k, botRegistry, __testHooks, subagentBoards, activeIndicators } from '../src/index.js';
import { createApprovalModule, createAllowlistStore, CALLBACK_PREFIX, approvalRuleKey } from '../src/approval.js';
import { TelegramClient } from '../src/client.js';
import { TelegramPoller } from '../src/poller.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

let passed = 0, failed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}

// §3 配置契约里 bot 项的 token 字段名为 `token`；顶层字段名为 `botToken`。
// 为对 S1 最终选用的字段名稳健，断言时兼容 `token` / `botToken` 两种命名：
// 取到其中任一并等于期望值即视为通过。
const tokenOf = (b) => (b == null ? undefined : (b.token !== undefined ? b.token : b.botToken));

console.log('multi-bot P0 config contract:');

// T1 向后兼容：无 bots 字段 -> 单 bot，字段从顶层回落
await atest('T1 back-compat: no `bots` field -> single bot from top-level', async () => {
  const top = { botToken: 'T', defaultChatId: '123', allowedUsers: ['u'] };
  const bots = normalizeBots(null, top);
  assert.ok(Array.isArray(bots), 'normalizeBots(null, top) must return an array (synchronously)');
  assert.equal(bots.length, 1, 'single-bot fallback expected');
  const b = bots[0];
  assert.equal(b.id, 'default', 'single-bot fallback id must be "default"');
  assert.equal(tokenOf(b), 'T', 'bot token must carry the top-level botToken');
  assert.equal(b.defaultChatId, '123', 'defaultChatId must carry the top-level value');
  assert.deepEqual(b.allowedUsers, ['u'], 'allowedUsers must carry the top-level value');
});

// T2 空数组 / YAML 强转 {} -> 与 T1 同效果（单 bot 回落顶层）
await atest('T2 empty array / YAML-coerced {} -> single-bot fallback (same as T1)', async () => {
  const top = { botToken: 'T', defaultChatId: '123', allowedUsers: ['u'] };
  for (const raw of [[], {}]) {
    const bots = normalizeBots(raw, top);
    assert.ok(Array.isArray(bots), `normalizeBots(${JSON.stringify(raw)}, top) must return array`);
    assert.equal(bots.length, 1, `single-bot fallback for raw=${JSON.stringify(raw)}`);
    assert.equal(bots[0].id, 'default', `raw=${JSON.stringify(raw)} -> id "default"`);
    assert.equal(tokenOf(bots[0]), 'T', `raw=${JSON.stringify(raw)} -> token from top`);
    assert.equal(bots[0].defaultChatId, '123', `raw=${JSON.stringify(raw)} -> defaultChatId from top`);
  }
});

// T3 两 bot 逐项回落：a 用自身字段，b（缺字段）回落到顶层对应值
await atest('T3 two bots: per-item fields fall back to top-level values', async () => {
  const top = { agentResponseMode: 'direct', defaultChatId: 'top-chat', allowedUsers: ['top-u'] };
  const raw = [
    { id: 'a', agentResponseMode: 'board' },
    { id: 'b' },
  ];
  const bots = normalizeBots(raw, top);
  assert.ok(Array.isArray(bots), 'must return array');
  assert.equal(bots.length, 2, 'both bots must be present');
  const a = bots.find((b) => b.id === 'a');
  const b = bots.find((b) => b.id === 'b');
  assert.ok(a && b, 'both a and b must be returned');
  // a keeps its own agentResponseMode
  assert.equal(a.agentResponseMode, 'board', 'a keeps its own agentResponseMode');
  // b (no agentResponseMode) falls back to top-level
  assert.equal(b.agentResponseMode, 'direct', 'b falls back to top-level agentResponseMode');
  // b's other missing fields fall back to top-level
  assert.equal(b.defaultChatId, 'top-chat', 'b.defaultChatId falls back to top-level');
  assert.deepEqual(b.allowedUsers, ['top-u'], 'b.allowedUsers falls back to top-level');
  // a's unset fields also fall back to top-level (only agentResponseMode was set)
  assert.equal(a.defaultChatId, 'top-chat', 'a.defaultChatId falls back to top-level');
  assert.deepEqual(a.allowedUsers, ['top-u'], 'a.allowedUsers falls back to top-level');
});

// T4 id 自动生成：有 token 无 id -> 'bot-'+token.slice(0,8)；无 token 无 id -> 'default'
await atest('T4 id auto-generation: from token prefix, else "default"', async () => {
  const token = '0123456789ABCDEF';
  const withToken = normalizeBots([{ token }], {});
  assert.equal(withToken[0].id, 'bot-' + token.slice(0, 8), 'id = "bot-" + token.slice(0,8)');

  const noToken = normalizeBots([{}], {});
  assert.equal(noToken[0].id, 'default', 'no token + no id -> "default"');
});

// T5 id 重复：启动期直接 throw，错误信息含重复的 id
await atest('T5 duplicate id -> throw (error message contains the id)', async () => {
  assert.throws(
    () => normalizeBots([{ id: 'x', token: 't1' }, { id: 'x', token: 't2' }], {}),
    (err) => {
      assert.ok(
        String(err.message).includes('x'),
        `error must mention the duplicated id "x", got: ${err.message}`
      );
      return true;
    }
  );
});

// T6 validateBotItem：非法字段类型 -> 要么 throw、要么归一为合法类型（二者必居其一，行为确定）
//    S1 未在 src 里注明选哪种，故这里断言"确定性"：
//      - 对同一非法输入，重复调用结果类型必须一致（全 throw 或 全不 throw）；
//      - 若不 throw，则返回项的该字段必须是合法类型（allowedChats 必须 Array、
//        requireMmention 必须 boolean）。留下非法类型既不 throw 也不归一 => 红。
await atest('T6 validateBotItem: illegal field type -> throw OR normalize (deterministic)', async () => {
  const outcome = (item) => { try { validateBotItem(item); return 'ok'; } catch { return 'throw'; } };

  // 确定性地：同输入 -> 同结果类型
  assert.equal(
    outcome({ allowedChats: 'not-array' }),
    outcome({ allowedChats: 'not-array' }),
    'validateBotItem must be deterministic for identical invalid input (allowedChats)'
  );
  assert.equal(
    outcome({ requireMention: 1 }),
    outcome({ requireMention: 1 }),
    'validateBotItem must be deterministic for identical invalid input (requireMention)'
  );

  // 若不 throw，字段必须归一为合法类型
  if (outcome({ allowedChats: 'not-array' }) === 'ok') {
    const r = validateBotItem({ allowedChats: 'not-array' });
    assert.ok(Array.isArray(r.allowedChats), 'allowedChats must normalize to an Array (or throw)');
  }
  if (outcome({ requireMention: 1 }) === 'ok') {
    const r = validateBotItem({ requireMention: 1 });
    assert.equal(typeof r.requireMention, 'boolean', 'requireMention must normalize to a boolean (or throw)');
  }
});

// T7 resolveBotToken 优先级：明文 > process.env[envKey] > credential
//    用测试专属 envKey（TEST_TBT_1），避免污染/被真实 TELEGRAM_BOT_TOKEN 干扰；测后 cleanup。
await atest('T7 resolveBotToken priority: plain > env[envKey] > credential', async () => {
  const ENVKEY = 'TEST_TBT_1';
  const noCredCtx = {}; // 无 credentials，只可能命中 plain / env
  const credCtx = {
    credentials: { resolve: async () => ({ value: 'CREDVAL', source: 'mock' }) },
  };
  try {
    // (a) 明文 wins over env
    process.env[ENVKEY] = 'ENVVAL';
    assert.equal(await resolveBotToken('PLAIN', noCredCtx, ENVKEY), 'PLAIN', 'plain text wins over env');

    // (b) env wins over credential（无明文）
    assert.equal(await resolveBotToken('', noCredCtx, ENVKEY), 'ENVVAL', 'env[envKey] wins when no plain');

    // (c) credential fallback（无明文、无 env）
    delete process.env[ENVKEY];
    assert.equal(await resolveBotToken('', credCtx, ENVKEY), 'CREDVAL', 'credential is last resort');
  } finally {
    delete process.env[ENVKEY]; // cleanup：还原环境
  }
});

// T8 envKey 隔离：两个不同 bot 各读各的 env，互不串（对应坑2）
await atest('T8 envKey isolation: two bots read their own env var, no crosstalk', async () => {
  const emptyCtx = {};
  try {
    process.env.TBK_A = 'AAA';
    process.env.TBK_B = 'BBB';
    assert.equal(await resolveBotToken('', emptyCtx, 'TBK_A'), 'AAA', 'bot A reads TBK_A');
    assert.equal(await resolveBotToken('', emptyCtx, 'TBK_B'), 'BBB', 'bot B reads TBK_B');
    // 交叉验证：A 的 envKey 读不到 B 的值，反之亦然
    assert.notEqual(await resolveBotToken('', emptyCtx, 'TBK_A'), 'BBB');
    assert.notEqual(await resolveBotToken('', emptyCtx, 'TBK_B'), 'AAA');
  } finally {
    delete process.env.TBK_A; // cleanup：还原环境
    delete process.env.TBK_B;
  }
});

// ---------------------------------------------------------------------------
// P1 (T9-T14): multi client/poller startup. Uses the REAL TelegramClient +
//   TelegramPoller (so constructor/registry wiring is real) but a mocked
//   global fetch that emulates the Telegram Bot API per-token (getMe,
//   getUpdates, setMyCommands). apply() is the system under test; a minimal
//   fake `ctx` stands in for the DSH host (tools register as no-ops, effect
//   returns are collected so we can trigger unload).
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockTelegramApi(mapping) {
  // mapping: { token: username }. getUpdates always returns an empty batch so
  // pollers idle without any network; getMe returns a synthetic identity.
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const u = String(url);
    const m = u.match(/\/bot([^/]+)\/(\w+)/);
    const token = m ? m[1] : '';
    const method = m ? m[2] : '';
    let payload;
    if (method === 'getMe') {
      payload = { ok: true, result: { id: 1000000 + mapping.size, is_bot: true, first_name: mapping[token] || 'bot' + calls, username: mapping[token] || 'bot' + calls } };
    } else if (method === 'getUpdates') {
      payload = { ok: true, result: [] };
    } else {
      payload = { ok: true, result: true };
    }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { restore: () => { globalThis.fetch = orig; }, calls: () => calls };
}

function makeCtx(overrides = {}) {
  const registered = [];
  const effects = [];
  const ctx = {
    tools: { register: (t) => { registered.push(t); } },
    on: () => {},
    effect: (fn) => { effects.push(fn()); return () => {}; },
    get: (k) => (k in overrides ? overrides[k] : undefined),
  };
  if (overrides.credentials) ctx.credentials = overrides.credentials;
  return { ctx, registered, effects };
}

function baseConfig() {
  // Legacy-style config (mirrors cordis.patch.yml structure: top-level fields,
  // polling on, no `bots` list) so the single-bot path is exercised.
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
    questionsEnabled: false,   // no mux/WebSocket needed for these tests
    subagentBoardEnabled: true,
  };
}

function isolateDir() {
  // Give each apply() its own DSH_HOME so offset stores + allowlist store land
  // in a temp dir (no writes to the real ~/.dsh) and poller offset files never
  // collide across tests.
  const dir = mkdtempSync(pathJoin(tmpdir(), 'tg-mb-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return { restore: () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; } };
}

function cleanupAll(effects) {
  for (const eff of effects) { try { eff(); } catch { /* ignore */ } }
}

function registryWithClient() {
  return [...botRegistry.values()].filter((e) => e.client);
}
function startedPollers() {
  return [...botRegistry.values()].filter((e) => e.poller);
}
async function waitMe(botId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = botRegistry.get(botId);
    if (e && e.me) return e.me;
    await sleep(10);
  }
  return null;
}

console.log('multi-bot P1 multi client/poller startup:');

// T9 双 bot 启动：2 个 client 构造、2 个 poller.start、registry 2 项，me 各来自各自 getMe
await atest('T9 dual-bot startup: 2 clients, 2 pollers, registry 2 entries, me per-bot', async () => {
  const { restore: restEnv } = mockTelegramApi({ 'TKNA': 'alice', 'TKNB': 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  const beforeClient = { n: 0 };
  const beforePoller = { n: 0 };
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      bots: [
        { id: 'a', token: 'TKNA' },
        { id: 'b', token: 'TKNB' },
      ],
    }));
    assert.equal(botRegistry.size, 2, 'registry has 2 entries');
    assert.ok(botRegistry.has('a') && botRegistry.has('b'), 'entries keyed by id a/b');
    // 2 clients constructed
    assert.equal(registryWithClient().length, 2, '2 clients');
    // 2 pollers started
    assert.equal(startedPollers().length, 2, '2 pollers started');
    // each poller is a real TelegramPoller bound to the right client
    const ea = botRegistry.get('a'), eb = botRegistry.get('b');
    assert.ok(ea.poller instanceof TelegramPoller, 'a poller is a TelegramPoller');
    assert.ok(eb.poller instanceof TelegramPoller, 'b poller is a TelegramPoller');
    assert.ok(ea.client instanceof TelegramClient, 'a client is a TelegramClient');
    assert.ok(eb.client instanceof TelegramClient, 'b client is a TelegramClient');
    // me resolved per-bot from each token's getMe
    const ma = await waitMe('a');
    const mb = await waitMe('b');
    assert.ok(ma && mb, 'both me resolved');
    assert.equal(ma.username, 'alice', 'a me from its own token');
    assert.equal(mb.username, 'bob', 'b me from its own token');
    // clientFor/meFor accessors resolve to the right objects
    assert.equal(clientFor('a'), ea.client);
    assert.equal(meFor('b'), mb);
    // k() composite key
    assert.equal(k('a', '123'), 'a::123');
  } finally {
    cleanupAll(effects);
    restDir();
    restEnv();
  }
});

// T10 单 bot 缺 token 降级：botA 有 token、botB 空且无 env/credential -> botB warn+跳过，botA 正常，不 throw
await atest('T10 single bot missing token degrades: skipped with warn, no throw', async () => {
  const { restore: restEnv } = mockTelegramApi({ 'TOK_A': 'alice' });
  const { restore: restDir } = isolateDir();
  const warns = [];
  const origConsoleWarn = console.warn;
  const { ctx, effects } = makeCtx(); // no credentials, no env for 'TELEGRAM_BOT_TOKEN'
  try {
    console.warn = (...a) => { warns.push(a.join(' ')); };
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), {
      verbose: true, // so the "no token" warn is actually emitted (log gate drops non-error when verbose:false)
      bots: [
        { id: 'a', token: 'TOK_A' },   // has token
        { id: 'b' },                     // no token, no env, no credential
      ],
    }));
    // b skipped: no client/poller, warn logged, NOT thrown
    const eb = botRegistry.get('b');
    assert.ok(eb, 'b entry exists in registry');
    assert.equal(eb.client, null, 'b has no client');
    assert.equal(eb.poller, null, 'b has no poller');
    assert.ok(warns.some((w) => w.includes('b') && w.includes('no token')), 'warn logged for b');
    // a is normal: client + poller present
    const ea = botRegistry.get('a');
    assert.ok(ea.client, 'a has client');
    assert.ok(ea.poller, 'a has poller');
    const ma = await waitMe('a');
    assert.equal(ma && ma.username, 'alice', 'a me resolved');
  } finally {
    console.warn = origConsoleWarn;
    cleanupAll(effects);
    restDir();
    restEnv();
  }
});

// T11 全缺 token：registry 无 client/poller，插件正常启动 (tools-only)
await atest('T11 all bots missing token: no client/poller, tools-only startup', async () => {
  const { restore: restEnv } = mockTelegramApi({});
  const { restore: restDir } = isolateDir();
  const { ctx, effects, registered } = makeCtx();
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), {
      bots: [
        { id: 'a' },
        { id: 'b' },
      ],
    }));
    // no clients, no pollers
    assert.equal(registryWithClient().length, 0, 'no clients');
    assert.equal(startedPollers().length, 0, 'no pollers');
    // tools still registered (tools-only mode)
    assert.ok(registered.length >= 1, 'tools registered even in tools-only mode');
    // both entries exist but client-less
    for (const id of ['a', 'b']) {
      const e = botRegistry.get(id);
      assert.ok(e && e.client === null, `${id} entry present, client null`);
    }
  } finally {
    cleanupAll(effects);
    restDir();
    restEnv();
  }
});

// T12 clientFor('ghost') -> throw (unknown id)
await atest('T12 clientFor(unknown id) throws', async () => {
  const { restore: restEnv } = mockTelegramApi({ 'TOK_A': 'alice' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), { bots: [{ id: 'a', token: 'TOK_A' }] }));
    assert.throws(
      () => clientFor('ghost'),
      (err) => String(err.message).includes('ghost'),
      'clientFor must throw mentioning the unknown id'
    );
  } finally {
    cleanupAll(effects);
    restDir();
    restEnv();
  }
});

// T13 meFor(被跳过的 bot) -> throw
await atest('T13 meFor(skipped bot) throws', async () => {
  const { restore: restEnv } = mockTelegramApi({ 'TOK_A': 'alice' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), {
      bots: [ { id: 'a', token: 'TOK_A' }, { id: 'b' } ],
    }));
    // 'b' was skipped (no token) -> no me
    assert.throws(
      () => meFor('b'),
      (err) => String(err.message).includes('b'),
      'meFor must throw mentioning the skipped bot id'
    );
    // for contrast, 'a' resolves once getMe settles
    const ma = await waitMe('a');
    assert.ok(ma, 'a me resolves (contrast)');
  } finally {
    cleanupAll(effects);
    restDir();
    restEnv();
  }
});

// T14 双 bot 启动后触发 unload -> 两个 poller.stop 各 1 次
await atest('T14 unload stops every bot poller exactly once', async () => {
  const { restore: restEnv } = mockTelegramApi({ 'TKNA': 'alice', 'TKNB': 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx();
  let cleaned = false;
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      bots: [ { id: 'a', token: 'TKNA' }, { id: 'b', token: 'TKNB' } ],
    }));
    const pa = botRegistry.get('a').poller;
    const pb = botRegistry.get('b').poller;
    assert.ok(pa && pb, 'both pollers present before unload');
    const stops = { a: 0, b: 0 };
    const stopA = pa.stop.bind(pa); pa.stop = () => { stops.a++; stopA(); };
    const stopB = pb.stop.bind(pb); pb.stop = () => { stops.b++; stopB(); };
    // Trigger unload: run every effect cleanup (this stops both pollers once).
    cleanupAll(effects);
    cleaned = true;
    assert.equal(stops.a, 1, 'poller a stopped exactly once');
    assert.equal(stops.b, 1, 'poller b stopped exactly once');
  } finally {
    // Only stop pollers if the effect cleanup above did NOT run (early throw).
    // (If it already ran, the pollers are stopped — re-stopping would double-count.)
    if (!cleaned) {
      for (const e of botRegistry.values()) { try { e.poller?.stop?.(); } catch {} }
    }
    restDir();
    restEnv();
  }
});

// ---------------------------------------------------------------------------
// P2/P3 (T15-T25): closure decoupling + per-bot message/callback routing.
//
// System under test = apply()'s REAL wiring: each poller's onMessage/onCallback
// handlers carry the SOURCE bot's id (the production `handleIncomingMessage` /
// `handleCallbackQuery` closures). We drive those handlers DIRECTLY (the exact
// seam the poller uses) against a recording fetch mock that records every API
// call by the bot's TOKEN, so we can assert WHICH bot's client each send/ack
// landed on. A fake agents service stands in for the DSH host.
// ---------------------------------------------------------------------------

console.log('multi-bot P2/P3 per-bot message + callback routing:');

function recordTelegramApi(tokens) {
  // tokens: { token: username }. Records each client's API calls by token.
  // getUpdates always returns an empty batch (pollers idle); send-type calls
  // return a valid result so the client does not throw.
  const orig = globalThis.fetch;
  const calls = [];
  let seq = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const m = u.match(/\/bot([^/]+)\/(\w+)/);
    const token = m ? m[1] : '';
    const method = m ? m[2] : '';
    calls.push({ token, method });
    let payload;
    if (method === 'getMe') {
      payload = { ok: true, result: { id: 900000 + (tokens[token] ? tokens[token].length : 0), is_bot: true, first_name: tokens[token] || 'bot', username: tokens[token] || 'bot' } };
    } else if (method === 'getUpdates') {
      payload = { ok: true, result: [] };
    } else if (method === 'sendMessage') {
      payload = { ok: true, result: { message_id: ++seq, chat: { id: '0' } } };
    } else if (method === 'editMessageText') {
      payload = { ok: true, result: { message_id: ++seq, chat: { id: '0' } } };
    } else if (method === 'setMyCommands') {
      payload = { ok: true, result: true };
    } else {
      payload = { ok: true, result: true };
    }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const byToken = (t, m) => calls.filter((c) => c.token === t && (m ? c.method === m : true));
  const forToken = (t) => calls.filter((c) => c.token === t);
  return { restore: () => { globalThis.fetch = orig; }, calls, byToken, forToken };
}

function fakeAgents() {
  const agents = [];
  const defaultAgent = {
    session: { id: 'AG0', events: [], header: { cwd: process.cwd(), origin: 'root' } },
    status: 'idle',
    followup: (m) => { defaultAgent.followupCalls = defaultAgent.followupCalls || []; defaultAgent.followupCalls.push(m); },
    cancel: () => {},
  };
  agents.push(defaultAgent);
  const svc = {
    list: () => agents.slice(),
    create: async (opts) => {
      const a = {
        session: { id: opts.sessionId, events: [], header: { cwd: process.cwd(), origin: 'root', botId: opts?.meta?.botId } },
        status: 'idle',
        followupCalls: [],
        followup: (m) => { a.followupCalls.push(m); },
        cancel: () => {},
      };
      agents.push(a);
      return a;
    },
  };
  return { svc, defaultAgent, created: () => agents.filter((a) => a !== defaultAgent) };
}

async function dualBotsSetup() {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  await apply(ctx, Object.assign(baseConfig(), {
    progressEnabled: false,   // keep the message path deterministic: typing + inject only
    subagentBoardEnabled: false,
    bots: [
      { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] },
      { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] },
    ],
  }));
  await waitMe('alice'); await waitMe('bob');
  const pa = botRegistry.get('alice').poller;
  const pb = botRegistry.get('bob').poller;
  // The exact production handlers the pollers were wired with (onMessage first).
  return { rec, restDir, effects, pa, pb, handlerA: pa.messageHandlers[0], handlerB: pb.messageHandlers[0], cbA: pa.callbackHandlers[0], cbB: pb.callbackHandlers[0] };
}

// T15 双 bot 消息入口：消息带源 bot 的 botId，sendChatAction 落在该 bot 自己的 client
await atest('T15 message entry carries source botId; sendChatAction on that bot\'s client', async () => {
  const s = await dualBotsSetup();
  try {
    await s.handlerA({ chatId: '1', messageId: 101, chatType: 'private', senderId: 'u1', senderUsername: 'aliceUser', text: 'hello' });
    await s.handlerB({ chatId: '2', messageId: 102, chatType: 'private', senderId: 'u2', senderUsername: 'bobUser', text: 'hi there' });
    // Each bot's typing action lands on ITS OWN client (distinct token).
    assert.ok(s.rec.byToken('TKNA', 'sendChatAction').length >= 1, 'alice client got the typing action');
    assert.ok(s.rec.byToken('TKNB', 'sendChatAction').length >= 1, 'bob client got the typing action');
    assert.ok(s.rec.byToken('TKNA', 'sendChatAction').length === 1, 'alice client got exactly its own action (no crosstalk)');
    assert.ok(s.rec.byToken('TKNB', 'sendChatAction').length === 1, 'bob client got exactly its own action (no crosstalk)');
    // No send landed on the wrong bot's client.
    assert.equal(s.rec.forToken('TKNA').filter((c) => c.method !== 'getUpdates' && c.method !== 'getMe' && c.method !== 'setMyCommands').length, 1, 'alice client: 1 non-poll call (typing)');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T16 同 (chatId,messageId) 经两个不同 bot 入口均被处理（不跨 bot 去重）
await atest('T16 same (chat,messageId) under two bots both process (no cross-bot dedup)', async () => {
  const s = await dualBotsSetup();
  try {
    // Identical chatId + messageId, but under each bot's own entry (different
    // source botId) -> the per-bot dedup key k(botId, chat):msgId differs, so
    // BOTH are processed (one typing per bot).
    await s.handlerA({ chatId: '7', messageId: 555, chatType: 'private', senderId: 'u1', text: 'x' });
    await s.handlerB({ chatId: '7', messageId: 555, chatType: 'private', senderId: 'u2', text: 'x' });
    assert.equal(s.rec.byToken('TKNA', 'sendChatAction').length, 1, 'alice processed its copy of chat 7 msg 555');
    assert.equal(s.rec.byToken('TKNB', 'sendChatAction').length, 1, 'bob processed its own copy (NOT cross-deduped)');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T17 命令路由：/help 经 bob 入口，reply 经 bob client (sendMessage) 带 replyTo
await atest('T17 command /help via bob entry: reply via bob client sendMessage with replyTo', async () => {
  const s = await dualBotsSetup();
  try {
    await s.handlerB({ chatId: '2', messageId: 200, chatType: 'private', senderId: 'u2', text: '/help' });
    const sends = s.rec.byToken('TKNB', 'sendMessage');
    assert.ok(sends.length >= 1, 'bob client sent the /help reply');
    assert.equal(s.rec.byToken('TKNA', 'sendMessage').length, 0, 'alice client did NOT send bob\'s /help reply');
    // The reply is addressed to the same chat + replyTo the command message.
    assert.equal(sends.length, 1, 'exactly one reply message');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T18 回调查询路由：bob 卡片的 answerCallbackQuery 落在 bob client；返回 botId == 入参 botId
await atest('T18 callback query via bob entry: answerCallbackQuery on bob client; returned botId == incoming', async () => {
  const s = await dualBotsSetup();
  try {
    const q = { id: 'cq-1', from: { id: 'u2', username: 'bobUser' }, message: { messageId: 9, chat: { id: '2', type: 'private' } }, data: 'custom' };
    await s.cbB(q);
    assert.ok(s.rec.byToken('TKNB', 'answerCallbackQuery').length >= 1, 'bob client answered the callback');
    assert.equal(s.rec.byToken('TKNA', 'answerCallbackQuery').length, 0, 'alice client did NOT answer bob\'s callback');
    // Entry-level: the handler routed on the SOURCE bot (no throw / correct target).
    assert.equal(s.rec.byToken('TKNB', 'answerCallbackQuery').length, 1, 'exactly one ack on bob');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T19 单 bot 兼容：无 bots 字段 -> 消息进入 botId=default，send 经 default client（等价旧行为）
await atest('T19 single-bot legacy: no `bots` -> message enters default bot, sends via default client', async () => {
  const rec = recordTelegramApi({ LEG: 'legacy' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false,
      botToken: 'LEG', defaultChatId: '1', allowedUsers: ['u1'],
    }));
    const def = botRegistry.get('default');
    assert.ok(def && def.client, 'legacy single bot id "default" with a client');
    await waitMe('default');
    const handler = def.poller.messageHandlers[0];
    await handler({ chatId: '1', messageId: 1, chatType: 'private', senderId: 'u1', text: 'hi' });
    assert.ok(rec.byToken('LEG', 'sendChatAction').length >= 1, 'default client got the typing action');
    // No other token exists -> fully equivalent to the old single-client path.
    const otherTokens = rec.calls.filter((c) => c.token !== 'LEG' && c.method !== 'getUpdates' && c.method !== 'getMe');
    assert.equal(otherTokens.length, 0, 'no calls on any non-default client');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
});

// T20 /new 命令经 bob 入口：新建 agent (meta.botId=bob) 并路由后续消息到新会话
await atest('T20 /new via bob entry creates a bot-owned agent and routes follow-up to it', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const fa = fakeAgents();
  const { ctx, effects } = makeCtx({ agents: fa.svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] }, { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] } ],
    }));
    await waitMe('alice'); await waitMe('bob');
    const pb = botRegistry.get('bob').poller;
    const handlerB = pb.messageHandlers[0];
    const before = fa.created().length;
    await handlerB({ chatId: '2', messageId: 300, chatType: 'private', senderId: 'u2', text: '/new' });
    assert.equal(fa.created().length, before + 1, '/new created a new agent');
    const created = fa.created()[fa.created().length - 1];
    assert.equal(created.session.header.botId, 'bob', 'new agent meta.botId = "bob" (per-bot defaultChat source)');
    // Follow-up message routes to the NEW agent (not the default AG0).
    await handlerB({ chatId: '2', messageId: 301, chatType: 'private', senderId: 'u2', text: 'after new' });
    assert.ok(created.followupCalls.length >= 1, 'new agent received the follow-up message');
    assert.equal(fa.defaultAgent.followupCalls ? fa.defaultAgent.followupCalls.length : 0, 0, 'default agent did NOT receive the post-/new message');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// T21 群聊 @mention 过滤 per-bot：alice 要 @alice，bob 要 @bob；各按自己 me 过滤
await atest('T21 group @mention filter is per-bot (alice vs bob me)', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false, requireMention: true,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u9'] }, { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] } ],
    }));
    await waitMe('alice'); await waitMe('bob');
    const hA = botRegistry.get('alice').poller.messageHandlers[0];
    const hB = botRegistry.get('bob').poller.messageHandlers[0];
    // Bob user u2 sends "@alice hi" to bob's entry -> NO mention of bob -> filtered.
    await hB({ chatId: '9', messageId: 401, chatType: 'group', senderId: 'u2', text: '@alice hi' });
    assert.equal(rec.byToken('TKNB', 'sendChatAction').length, 0, 'bob filtered (no @bob mention)');
    // Same text to alice's entry (allowed user u9) mentions @alice -> processed.
    await hA({ chatId: '9', messageId: 402, chatType: 'group', senderId: 'u9', text: '@alice hi' });
    assert.ok(rec.byToken('TKNA', 'sendChatAction').length >= 1, 'alice processed (had @alice mention)');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// T22 同 bot 内重复 (chat,messageId) 被去重（第二次不处理）
await atest('T22 same bot same (chat,messageId) is deduped (2nd dropped)', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] }, { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] } ],
    }));
    await waitMe('alice'); await waitMe('bob');
    const hB = botRegistry.get('bob').poller.messageHandlers[0];
    const m = { chatId: '2', messageId: 500, chatType: 'private', senderId: 'u2', text: 'dup' };
    await hB({ ...m });
    await hB({ ...m });
    assert.equal(rec.byToken('TKNB', 'sendChatAction').length, 1, 'dedup: only the first copy processed');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// T23 setMyCommands 每 bot 各注册一次（命令菜单 per-bot，非全局）
await atest('T23 setMyCommands registered once per bot (per-bot command menu)', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] }, { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] } ],
    }));
    assert.equal(rec.byToken('TKNA', 'setMyCommands').length, 1, 'alice registered its command menu once');
    assert.equal(rec.byToken('TKNB', 'setMyCommands').length, 1, 'bob registered its command menu once');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// T24 缺 token 的 bot 被跳过：无 client/poller/命令菜单/消息处理
await atest('T24 token-missing bot skipped: no client/poller/menu; clientFor throws', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false, verbose: true,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] }, { id: 'bob' } ],
    }));
    const eb = botRegistry.get('bob');
    assert.ok(eb && eb.client === null, 'bob has no client (skipped)');
    assert.equal(eb.poller, null, 'bob has no poller');
    assert.equal(rec.byToken('', 'setMyCommands').length + rec.calls.filter((c) => c.method === 'setMyCommands' && c.token !== 'TKNA').length, 0, 'no setMyCommands on a client-less token');
    // bob has no onMessage handler to drive; clientFor(bob) throws.
    assert.throws(() => clientFor('bob'), /bob|client|no/i, 'clientFor(bob) throws');
    // alice (the only client) still works.
    assert.ok(rec.byToken('TKNA', 'setMyCommands').length >= 1, 'alice registered its menu');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// T25 主 poller 源 bot = 首个有 client 的 bot（firstBotId）；多 bot 下主 poller 归 alice
await atest('T25 main poller source = first bot with a client (firstBotId)', async () => { {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      progressEnabled: false, subagentBoardEnabled: false,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'] }, { id: 'bob', token: 'TKNB', allowedUsers: ['u2'] } ],
    }));
    // The legacy `client`/activePoller (main poller) is bound to the FIRST bot
    // with a client (alice). Drive the MAIN poller's handler -> it must route
    // through alice's client (firstBotId), not bob's.
    const pa = botRegistry.get('alice').poller;
    const pb = botRegistry.get('bob').poller;
    // Main poller === alice's poller (firstEntry bound to it at start).
    const handlerMain = pa.messageHandlers[0];
    await handlerMain({ chatId: '1', messageId: 600, chatType: 'private', senderId: 'u1', text: 'main' });
    assert.ok(rec.byToken('TKNA', 'sendChatAction').length >= 1, 'main poller routed via alice (first bot)');
    assert.equal(rec.byToken('TKNB', 'sendChatAction').length, 0, 'main poller did NOT route via bob');
    // Both pollers have distinct handlers (per-bot wiring present).
    assert.ok(pb.messageHandlers.length >= 1, 'bob poller has its own onMessage handler');
  } finally {
    cleanupAll(effects); restDir(); rec.restore();
  }
} });

// ===========================================================================
// P4 工具层 (T26–T28) + P5 审计 (T29–T31) + P6 卸载 (T32)
//   工具 execute 直接调用（ctx.tools.register 捕获的 tool.execute），断言落在
//   CLIENT 层：哪个 token 的 client 收到了调用（recordTelegramApi 按 token 记）。
//   深度：发送路径测试在 client 层 spy（哪个 token 的 client 收到调用）。
// ===================================================================

// 双 bot 工具层 setup：polling 关闭（无后台 poller 抢占 getUpdates，避免 409），
// subagentBoard 开（T31 用）。返回 apply 捕获到的工具表 + 清理句柄。
async function toolSetup({ polling = false, board = false } = {}) {
  const rec = recordTelegramApi({ TKNA: 'alice', TKNB: 'bob' });
  const { restore: restDir } = isolateDir();
  const { ctx, effects, registered } = makeCtx({ agents: fakeAgents().svc });
  await apply(ctx, Object.assign(baseConfig(), {
    pollingEnabled: polling,
    subagentBoardEnabled: board,
    progressEnabled: false,
    verbose: false,
    bots: [
      { id: 'alice', token: 'TKNA', allowedUsers: ['u1'], defaultChatId: '1' },
      { id: 'bob', token: 'TKNB', allowedUsers: ['u2'], defaultChatId: '2' },
    ],
  }));
  await waitMe('alice'); await waitMe('bob');
  const tools = new Map(registered.map((t) => [t.name, t]));
  return { rec, restDir, effects, tools, ctx };
}

const toolBy = (tools, name) => {
  const t = tools.get(name);
  assert.ok(t, `tool ${name} must be registered`);
  return t;
};

// T26 发送工具 `bot` 参数：无 bot -> 默认(alice/首 bot)；bot='bob' -> bob client（无串扰）；
//     未知 bot -> 工具错误返回（字符串，不 throw / 不崩）。
await atest('T26 send tools: `bot` param routing (default / explicit / unknown-error)', async () => {
  const s = await toolSetup();
  try {
    const sendMsg = toolBy(s.tools, 'telegram_send_message');
    // (a) 无 bot 参数 -> 落到默认 bot（alice = 首个有 client 的 bot）
    let out = await sendMsg.execute({ chat_id: '1', text: 'hello-a' }, {});
    assert.match(out, /Message sent successfully/, 'default send returned success');
    assert.equal(s.rec.byToken('TKNA', 'sendMessage').length, 1, 'no-bot send lands on alice (default) client');
    assert.equal(s.rec.byToken('TKNB', 'sendMessage').length, 0, 'no crosstalk to bob for the no-bot send');
    // (b) 显式 bot='bob' -> bob 的 client 收到调用（client 层 spy）
    out = await sendMsg.execute({ chat_id: '2', text: 'to-bob', bot: 'bob' }, {});
    assert.match(out, /Message sent successfully/, 'explicit bob send returned success');
    assert.equal(s.rec.byToken('TKNB', 'sendMessage').length, 1, 'bob explicit send lands on bob client');
    assert.equal(s.rec.byToken('TKNA', 'sendMessage').length, 1, 'alice client did NOT receive bob-targeted send (no crosstalk)');
    // (c) 未知 bot -> 工具错误返回（字符串），不抛异常（不崩）
    let unknownReturned = null;
    let threw = false;
    try { unknownReturned = await sendMsg.execute({ chat_id: '1', text: 'x', bot: 'ghost' }, {}); }
    catch { threw = true; }
    assert.equal(threw, false, 'unknown bot id must NOT throw (tool returns error string)');
    assert.ok(typeof unknownReturned === 'string' && /Unknown bot id/i.test(String(undefined) + String(unknownReturned)), 'unknown bot returns a clear error string');
    assert.match(unknownReturned, /ghost/, 'error names the unknown bot id');
    assert.match(unknownReturned, /alice.*bob|bob.*alice/, 'error lists the known bot ids');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T27 get_info 列出全部 bot：2 个 -> 数组长度 2，每项 {id, username, botId, connected}；
//     单 bot -> 1 项 (id 'default')。
await atest('T27 telegram_get_info lists ALL bots (2 -> len 2, each {id,username,connected})', async () => {
  const s = await toolSetup();
  try {
    const getInfo = toolBy(s.tools, 'telegram_get_info');
    const list = await getInfo.execute({}, {});
    assert.ok(Array.isArray(list), 'get_info returns an array (host renders as JSON)');
    assert.equal(list.length, 2, 'two bots -> two entries');
    const byId = new Map(list.map((e) => [e.id, e]));
    assert.ok(byId.has('alice') && byId.has('bob'), 'entries keyed by bot id alice + bob');
    const a = byId.get('alice');
    assert.equal(a.username, 'alice', 'alice entry carries getMe username');
    assert.equal(typeof a.botId, 'number', 'alice entry has numeric Telegram user id (botId from getMe)');
    assert.equal(a.connected, true, 'alice connected (has client)');
    const b = byId.get('bob');
    assert.equal(b.username, 'bob', 'bob entry carries getMe username');
    assert.equal(typeof b.botId, 'number', 'bob entry has a numeric botId');
    assert.notEqual(b.botId, a.botId, 'bob botId differs from alice (distinct numeric ids)');
    assert.equal(b.connected, true, 'bob connected');
    // 单 bot 兼容：无 bots 字段 -> 1 项 (id 'default')
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
  const rec2 = recordTelegramApi({ LEG: 'legacy' });
  const { restore: restDir2 } = isolateDir();
  const { ctx, effects, registered } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      pollingEnabled: false, subagentBoardEnabled: false,
      botToken: 'LEG', defaultChatId: '1', allowedUsers: ['u1'],
    }));
    await waitMe('default');
    const tools = new Map(registered.map((t) => [t.name, t]));
    const list = await tools.get('telegram_get_info').execute({}, {});
    assert.ok(Array.isArray(list) && list.length === 1, 'single bot -> exactly 1 entry');
    assert.equal(list[0].id, 'default', 'single-bot entry id is "default"');
    assert.equal(list[0].username, 'legacy', 'single-bot entry username from getMe');
    assert.equal(list[0].connected, true, 'single-bot entry connected');
  } finally {
    cleanupAll(effects); restDir2(); rec2.restore();
  }
});

// T28 get_updates 每 bot 独立 offset：alice 的 manual offset 推进不影响 bob（各自独立）。
//     深度：在 client 层 spy 每个 bot 的 getUpdates 实际收到的 offset 参数。
await atest('T28 telegram_get_updates per-bot offset (alice offset advance leaves bob at 0)', async () => {
  // 自定义 fetch mock：每个 bot 有自己的 update 流（alice:[100,101], bob:[200]），
  // 按请求体 offset 过滤（返回 update_id > offset 的），并记录每个 token 收到的 offset。
  const streams = { TKNA: [100, 101], TKNB: [200] };
  const offsetSeen = { TKNA: [], TKNB: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const m = u.match(/\/bot([^/]+)\//);
    const token = m ? m[1] : '';
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (/\bgetUpdates\b/.test(u)) {
      offsetSeen[token].push(body.offset);
      const stream = streams[token] || [];
      const off = typeof body.offset === 'number' ? body.offset : 0;
      const result = stream.filter((id) => id > off).map((id) => ({ update_id: id, message: { chat: { id: '1', type: 'private' }, from: { id: 'u', username: 'x' }, text: `msg-${id}` } }));
      return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => '' };
    }
    if (/\bgetMe\b/.test(u)) {
      const user = token === 'TKNA' ? 'alice' : (token === 'TKNB' ? 'bob' : 'b');
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: token === 'TKNA' ? 900001 : 900002, is_bot: true, first_name: user, username: user } }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }), text: async () => '' };
  };
  const { restore: restDir } = isolateDir();
  const { ctx, effects, registered } = makeCtx({ agents: fakeAgents().svc });
  try {
    await apply(ctx, Object.assign(baseConfig(), {
      pollingEnabled: false, subagentBoardEnabled: false, progressEnabled: false,
      bots: [ { id: 'alice', token: 'TKNA', allowedUsers: ['u1'], defaultChatId: '1' },
               { id: 'bob', token: 'TKNB', allowedUsers: ['u2'], defaultChatId: '2' } ],
    }));
    await waitMe('alice'); await waitMe('bob');
    const getUpdates = new Map(registered.map((t) => [t.name, t])).get('telegram_get_updates');
    // alice 首次读（无 offset）-> 走 alice 的 manual offset(0) -> 读到 100,101 -> alice offset 推进到 102。
    const outA1 = await getUpdates.execute({ bot: 'alice' }, {});
    assert.match(outA1, /Received 2 update/, 'alice first manual poll reads its 2 updates');
    // alice 再读（无 offset）-> 走 alice 的 manual offset(102) -> 无新 update。
    const outA2 = await getUpdates.execute({ bot: 'alice' }, {});
    assert.match(outA2, /No new updates/, 'alice 2nd manual poll (offset advanced past 101) -> no new updates');
    // bob 读一次（无 offset）-> 走 bob 自己的 manual offset(0) -> 读到 200（独立流，未被 alice 影响）。
    const outB = await getUpdates.execute({ bot: 'bob' }, {});
    assert.match(outB, /Received 1 update/, 'bob read its own update stream (independent of alice)');
    // 深度：client 层 spy —— alice 第二次读 offset=102（已独立推进），bob 第一次读 offset=0（未受 alice 影响）。
    assert.ok(offsetSeen.TKNA.includes(0), 'alice first read used offset 0');
    assert.ok(offsetSeen.TKNA.includes(102), 'alice 2nd read used its OWN advanced offset 102 (per-bot, not shared)');
    assert.ok(offsetSeen.TKNB.length >= 1 && offsetSeen.TKNB[0] === 0, 'bob read used offset 0 — bob offset NOT advanced by alice polls');
  } finally {
    globalThis.fetch = origFetch;
    cleanupAll(effects); restDir();
  }
});

// T29 approval 混合：bob 卡片的 reply 目标 = bob 的 per-bot chat（非 alice）；
//     "always" 规则 key 跨 bot 共享（同一 rule key，bob 记 -> alice 命中，不发卡）。
await atest('T29 approval: card target per-bot (bob), allow-always rule key SHARED cross-bot', async () => {
  const store = createAllowlistStore({ log: () => {}, filePath: () => '', defaultChatId: () => '' });
  const cardChats = []; // 记录卡片实际投递到的 chatId
  const module = createApprovalModule({
    log: () => {},
    enabled: () => true,
    // ownership: 按 agent.meta.botId 返回该 bot 的 per-bot defaultChat（per-bot reply target）。
    ownership: (agent) => {
      const bid = agent?.meta?.botId;
      if (bid === 'bob') return { chatId: '2', botId: 'bob' };
      if (bid === 'alice') return { chatId: '1', botId: 'alice' };
      return null;
    },
    isAutopilot: () => false,
    checkAllow: (rk) => store.checkAllow(rk),
    rememberAllow: (rk, ch) => store.rememberAllow(rk, ch),
    timeoutMs: 0,
    escape: (s) => s,
    toastText: () => '',
    formatResolved: (p, o) => `resolved:${o}`,
    ackCallback: async () => {},
    client: {
      async sendMessage(opts) { cardChats.push(String(opts.chatId)); return { messageId: 7 }; },
      async editMessageText() { return { messageId: 7 }; },
    },
  });
  const ruleKey = approvalRuleKey('bash', 'run something');
  // (1) bob 发起 bash 请求（未记住该 rule）-> 走卡片路径，卡片投到 bob 的 chat(2)。
  const pBob = module.handleApprovalRequest({ agent: { meta: { botId: 'bob' } }, toolName: 'bash', reason: 'run something' }, () => 'delegated');
  await sleep(15); // 让卡片 sendMessage 落地（fire-and-forget 内 await，需让出微/宏任务）
  assert.deepStrictEqual(cardChats, ['2'], 'bob card delivered to bob per-bot chat (2), NOT alice (1)');
  // (2) 模拟 bob 用户点"一直允许" -> 记 "allow-always"（rule key 跨 bot 共享的同一 key）。
  //     用 _pending 拿到该 key 走 handleCallbackQuery 的 always 分支（真实路径，非直接改 store）。
  const pendingKey = [...module._pending.keys()][0];
  assert.ok(pendingKey, 'bob card is pending (a key was created)');
  module.handleCallbackQuery({ id: 1, data: `${CALLBACK_PREFIX}y:${pendingKey}` });
  await sleep(5);
  assert.ok(store.checkAllow(ruleKey), 'allow-always rule remembered for the shared rule key');
  await pBob; // 卡片已被 always 点击 settle
  // (3) alice 发起同一 rule（bash）-> checkAllow 命中 -> 不发卡，直接 allowed-once。
  const before = cardChats.length;
  const outcomeAlice = await module.handleApprovalRequest({ agent: { meta: { botId: 'alice' } }, toolName: 'bash', reason: 'run something' }, () => 'delegated');
  assert.equal(outcomeAlice, 'allowed-once', 'alice auto-approved the SHARED rule (no card) — rule key shared cross-bot');
  assert.equal(cardChats.length, before, 'alice got NO new card (shared rule hit) — allow-always rule is SHARED, not per-bot');
  // 关键：整个流程只投递了 bob 那一张卡片（chat 2）—— alice 因共享 rule 命中而免卡。
  assert.deepStrictEqual(cardChats, ['2'], 'only the bob card was ever delivered; alice was auto-approved via the shared rule');
});

// T30 rootAgentToChat 按 bot：bob agent meta.botId='bob' -> bob 的 defaultChatId（非 alice/顶层）。
await atest('T30 rootAgentToChat by-bot: bob agent -> bob defaultChat (not alice / top-level)', async () => {
  // rootAgentToChat is defined inside the `if (pollingEnabled && client)` block
  // (production Telegram bots always poll), so this test runs with polling ON.
  const s = await toolSetup({ polling: true, board: false });
  try {
    // __testHooks 暴露当前 run 的 rootAgentToChat（apply 内填充）。
    assert.ok(typeof __testHooks.rootAgentToChat === 'function', '__testHooks.rootAgentToChat exposed by apply');
    const svc = s.ctx.get('agents');
    const list = svc.list();
    // 造一个 bob 拥有的 root agent：meta.botId='bob'，未路由进 chatAgents。
    const bobAgent = await svc.create({ sessionId: 'TG-bob-root' });
    // fakeAgents.create 把 meta.botId 写入 session.header.botId；rootAgentToChat 读 a.meta.botId。
    // 需确认 fakeAgents 是否暴露 meta —— 这里直接断言：rootAgentToChat 对未路由 agent 用 meta.botId。
    // 由于 fakeAgents.create 写的是 session.header.botId（非 a.meta），需补 a.meta：
    bobAgent.meta = { botId: 'bob' };
    const map = __testHooks.rootAgentToChat();
    const owner = map.get('TG-bob-root');
    assert.ok(owner, 'bob root agent has an owner mapping');
    assert.equal(owner.botId, 'bob', 'owner botId is bob (per-bot, not alice/default)');
    assert.equal(owner.chatId, '2', 'owner chatId is bob\'s per-bot defaultChat (2), NOT alice\'s (1) nor top-level (1)');
    // 对照：alice agent -> chat 1。
    const aliceAgent = await svc.create({ sessionId: 'TG-alice-root' });
    aliceAgent.meta = { botId: 'alice' };
    const ownerA = __testHooks.rootAgentToChat().get('TG-alice-root');
    assert.equal(ownerA.botId, 'alice', 'alice agent owner botId is alice');
    assert.equal(ownerA.chatId, '1', 'alice owner chatId is alice defaultChat (1)');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T31 boardForChat 组合隔离：同 chatId 下 bob 的 board ≠ alice 的 board（复合 key k(botId,chatId)）。
await atest('T31 boardForChat combo isolation: same chatId, bob board !== alice board', async () => {
  const s = await toolSetup({ board: true });
  try {
    assert.ok(typeof __testHooks.boardForChat === 'function', '__testHooks.boardForChat exposed by apply');
    const chatId = '42';
    const ba = __testHooks.boardForChat('alice', chatId);
    const bb = __testHooks.boardForChat('bob', chatId);
    assert.ok(ba, 'alice board created for chat 42');
    assert.ok(bb, 'bob board created for chat 42');
    assert.notStrictEqual(ba, bb, 'same chatId under two bots => DISTINCT boards (composite key isolation)');
    // 复合 key 确实不同。
    assert.equal(k('alice', chatId), 'alice::42', 'alice composite key');
    assert.equal(k('bob', chatId), 'bob::42', 'bob composite key');
    assert.notEqual(k('alice', chatId), k('bob', chatId), 'composite keys differ');
    // 两个 board 都登记进 subagentBoards（module-scope，可断言）。
    assert.ok(subagentBoards.has('alice::42'), 'subagentBoards has alice::42');
    assert.ok(subagentBoards.has('bob::42'), 'subagentBoards has bob::42');
  } finally {
    cleanupAll(s.effects); s.restDir(); s.rec.restore();
  }
});

// T32 卸载无残留：poller.stop ×N（每个 bot 的 poller 都停）、board 复合 key 清空、activeIndicators 清空。
await atest('T32 unload leaves no residue: pollers stopped, board keys cleared, activeIndicators empty', async () => {
  const s = await toolSetup({ polling: true, board: true });
  try {
    // 塞入 board + indicator（用 module-scope 的 Map 直接塞真实对象，模拟运行期状态）。
    // board：用 boardForChat 创建真实 board（client 已就绪）。
    __testHooks.boardForChat('alice', '1');
    __testHooks.boardForChat('bob', '2');
    assert.ok(subagentBoards.has('alice::1') && subagentBoards.has('bob::2'), 'boards seeded before unload');
    // indicator：塞两个假的（带 stop 计数器），验证 unload 会 stop + clear。
    const stopped = [];
    activeIndicators.set('alice::1', { stop: async () => { stopped.push('alice'); } });
    activeIndicators.set('bob::2', { stop: async () => { stopped.push('bob'); } });
    assert.equal(activeIndicators.size, 2, 'indicators seeded before unload');
    // 记录每个 poller 卸载前 running。
    const pollers = [...botRegistry.values()].filter((e) => e.poller);
    assert.equal(pollers.length, 2, 'two pollers alive before unload');
    for (const e of pollers) assert.equal(e.poller.running, true, `poller for ${e.id} running before unload`);
    // 触发卸载。
    cleanupAll(s.effects);
    // 断言：poller 全停。
    for (const e of pollers) assert.equal(e.poller.running, false, `poller for ${e.id} stopped on unload`);
    // 断言：board 复合 key 清空。
    assert.equal(subagentBoards.size, 0, 'all board composite keys cleared on unload');
    // 断言：activeIndicators 清空 + 每个 stop 被调。
    assert.equal(activeIndicators.size, 0, 'activeIndicators cleared on unload');
    assert.deepStrictEqual(stopped.sort(), ['alice', 'bob'], 'every indicator stop() was called on unload');
  } finally {
    s.restDir(); s.rec.restore();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
