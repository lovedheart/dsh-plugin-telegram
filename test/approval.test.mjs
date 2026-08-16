// Unit tests for the Telegram tool-guard approval module (approval.js).
// Run: node test/approval.test.mjs
import { strict as assert } from 'node:assert';
import {
  createApprovalModule,
  createAllowlistStore,
  parseApprovalCallback,
  buildApprovalKeyboard,
  buildApprovalCardText,
  toolLabel,
  describeRuleKey,
  approvalRuleKey,
  CALLBACK_PREFIX,
} from '../src/approval.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Recording mock of the Telegram client the module talks to.
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

function makeModule(overrides = {}) {
  const client = makeClient(overrides.client);
  const deps = Object.assign({
    client,
    enabled: () => true,
    timeoutMs: 60_000,
    log: () => {},
    escape: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    // Default ownership: route any telegram-* agent to chat 123.
    ownership: (agent) => {
      const sid = agent?.session?.id ?? '';
      return String(sid).startsWith('telegram-') ? { chatId: '123', threadId: null } : null;
    },
    ackCallback: (id, toast) => client.answerCallbackQuery(id, toast),
    toastText: (o) => (o === 'allowed-once' ? '✅ 已批准' : o === 'rejected' ? '❌ 已拒绝' : '⌛ 已取消'),
    formatResolved: (entry, o) => `resolved:${o}:${entry.toolName}`,
  }, overrides.deps || {});
  const mod = createApprovalModule(deps);
  return { client, mod, deps };
}

const tgAgent = (id = 'telegram-abc') => ({ id, session: { id } });

await (async () => {
  console.log('parseApprovalCallback:');
  await test('approve data parses', () => {
    const r = parseApprovalCallback(`${CALLBACK_PREFIX}a:KEY1`);
    assert.deepEqual(r, { action: 'approve', key: 'KEY1' });
  });
  await test('deny data parses', () => {
    const r = parseApprovalCallback(`${CALLBACK_PREFIX}d:KEY2`);
    assert.deepEqual(r, { action: 'deny', key: 'KEY2' });
  });
  await test('foreign data -> null', () => {
    assert.equal(parseApprovalCallback('other:KEY'), null);
    assert.equal(parseApprovalCallback(''), null);
    assert.equal(parseApprovalCallback(undefined), null);
  });
  await test('approve and deny share the key length budget (<64 bytes)', () => {
    const key = 'x'.repeat(50);
    assert.ok(Buffer.byteLength(`${CALLBACK_PREFIX}a:${key}`, 'utf8') <= 64);
    assert.ok(Buffer.byteLength(`${CALLBACK_PREFIX}d:${key}`, 'utf8') <= 64);
  });

  console.log('buildApprovalKeyboard / card text / toolLabel:');
  await test('keyboard has three buttons (approve / always / deny) with tgapv2 data', () => {
    const kb = buildApprovalKeyboard('K');
    const row = kb.inline_keyboard[0];
    assert.equal(row.length, 3);
    assert.equal(row[0].text, '✅ 批准');
    assert.equal(row[1].text, '🔁 一直允许');
    assert.equal(row[2].text, '❌ 拒绝');
    assert.equal(row[0].callback_data, `${CALLBACK_PREFIX}a:K`);
    assert.equal(row[1].callback_data, `${CALLBACK_PREFIX}y:K`);
    assert.equal(row[2].callback_data, `${CALLBACK_PREFIX}d:K`);
  });
  await test('always data parses to action=always', () => {
    const r = parseApprovalCallback(`${CALLBACK_PREFIX}y:KEY9`);
    assert.deepEqual(r, { action: 'always', key: 'KEY9' });
  });
  await test('v1 prefix (tgapv:) is not claimed (null)', () => {
    // Backwards-compat: a card left open across an upgrade uses the old prefix
    // and must NOT be mis-routed to the v2 handler.
    assert.equal(parseApprovalCallback('tgapv:a:OLD'), null);
  });
  await test('card text includes tool + reason + timeout hint', () => {
    const t = buildApprovalCardText('bash（命令执行）', 'needs write', 300);
    assert.ok(t.includes('bash（命令执行）'));
    assert.ok(t.includes('needs write'));
    assert.ok(t.includes('300'));
  });
  await test('card text omits timeout hint when 0', () => {
    const t = buildApprovalCardText('write', 'r', 0);
    assert.ok(!t.includes('秒后将自动取消'));
  });
  await test('toolLabel maps known tools', () => {
    assert.equal(toolLabel('bash'), 'bash（命令执行）');
    assert.equal(toolLabel('write'), 'write（写文件）');
    assert.equal(toolLabel('custom'), 'custom');
  });

  console.log('createApprovalModule: delegation');
  await test('disabled -> next() called, no card', async () => {
    const { client, mod } = makeModule({ deps: { enabled: () => false } });
    let nextCalled = 0;
    const out = await mod.handleApprovalRequest(
      { agent: tgAgent(), toolName: 'bash' }, () => { nextCalled++; return Promise.resolve('unavailable'); });
    assert.equal(nextCalled, 1);
    assert.equal(out, 'unavailable');
    assert.equal(client.calls.sends.length, 0);
  });
  await test('non-telegram agent -> next() (delegated), no card', async () => {
    const { client, mod } = makeModule();
    let nextCalled = false;
    const out = await mod.handleApprovalRequest(
      { agent: { id: 'web-1', session: { id: 'web-1' } }, toolName: 'bash' },
      () => { nextCalled = true; return Promise.resolve('unavailable'); },
    );
    assert.equal(nextCalled, true);
    assert.equal(out, 'unavailable');
    assert.equal(client.calls.sends.length, 0);
  });
  await test('telegram agent but no owning chat -> next()', async () => {
    const { client, mod } = makeModule({
      deps: { ownership: () => null },
    });
    let nextCalled = false;
    const out = await mod.handleApprovalRequest({ agent: tgAgent(), toolName: 'bash' },
      () => { nextCalled = true; return Promise.resolve('unavailable'); });
    assert.equal(nextCalled, true);
    assert.equal(out, 'unavailable');
    assert.equal(client.calls.sends.length, 0);
  });

  console.log('createApprovalModule: approve / deny flow');
  await test('approve button resolves allowed-once and acks + edits', async () => {
    const { client, mod } = makeModule();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-x'), toolName: 'bash', reason: 'need write' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15); // let the card post
    assert.equal(client.calls.sends.length, 1);
    const sent = client.calls.sends[0];
    assert.equal(sent.chatId, '123');
    assert.ok(sent.replyMarkup); // inline keyboard present
    assert.ok(sent.text.includes('bash（命令执行）'));
    assert.ok(sent.text.includes('need write'));
    // Resolve via the callback the module knows how to parse.
    const key = sent.replyMarkup.inline_keyboard[0][0].callback_data.slice(CALLBACK_PREFIX.length + 2);
    const consumed = mod.handleCallbackQuery({ id: 'q1', data: `${CALLBACK_PREFIX}a:${key}` });
    assert.equal(consumed, true);
    const outcome = await p;
    assert.equal(outcome, 'allowed-once');
    // ack + resolved edit happened
    assert.ok(client.calls.acks.some((a) => a.id === 'q1'));
    assert.ok(client.calls.edits.length >= 1);
    assert.ok(client.calls.edits[0].text.includes('allowed-once'));
  });

  await test('deny button resolves rejected', async () => {
    const { client, mod } = makeModule();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-y'), toolName: 'write', reason: 'r' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15);
    const sent = client.calls.sends[0];
    const key = sent.replyMarkup.inline_keyboard[0][2].callback_data.slice(CALLBACK_PREFIX.length + 2);
    mod.handleCallbackQuery({ id: 'q2', data: `${CALLBACK_PREFIX}d:${key}` });
    assert.equal(await p, 'rejected');
  });

  await test('double click -> second settle is a no-op (still allowed-once)', async () => {
    const { client, mod } = makeModule();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-z'), toolName: 'bash' }, () => Promise.resolve('unavailable'));
    await sleep(15);
    const sent = client.calls.sends[0];
    const key = sent.replyMarkup.inline_keyboard[0][0].callback_data.slice(CALLBACK_PREFIX.length + 2);
    mod.handleCallbackQuery({ id: 'qa', data: `${CALLBACK_PREFIX}a:${key}` });
    mod.handleCallbackQuery({ id: 'qb', data: `${CALLBACK_PREFIX}a:${key}` }); // dup
    assert.equal(await p, 'allowed-once');
  });

  await test('unknown/already-settled key is consumed + acked, does not hang', async () => {
    const { client, mod } = makeModule();
    // No pending request for this key.
    const consumed = mod.handleCallbackQuery({ id: 'qx', data: `${CALLBACK_PREFIX}a:NOPE` });
    assert.equal(consumed, true);
    await sleep(10);
    assert.ok(client.calls.acks.some((a) => a.id === 'qx'));
  });

  console.log('createApprovalModule: expiry + abort');
  await test('timeout expires -> cancelled', async () => {
    const { mod } = makeModule({ deps: { timeoutMs: 60 } });
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-t'), toolName: 'bash' }, () => Promise.resolve('unavailable'));
    assert.equal(await p, 'cancelled');
  });

  await test('abort signal -> cancelled', async () => {
    const { mod } = makeModule();
    const ac = new AbortController();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-a'), toolName: 'bash', signal: ac.signal },
      () => Promise.resolve('unavailable'));
    await sleep(15); // card posted, timer armed
    ac.abort();
    assert.equal(await p, 'cancelled');
  });

  await test('already-aborted signal -> cancelled, no card', async () => {
    const { client, mod } = makeModule();
    const ac = new AbortController();
    ac.abort();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-ab'), toolName: 'bash', signal: ac.signal },
      () => Promise.resolve('unavailable'));
    assert.equal(await p, 'cancelled');
    assert.equal(client.calls.sends.length, 0);
  });

  console.log('createApprovalModule: card send failure -> delegate');
  await test('permanent send failure -> next() (delegate), no hang', async () => {
    const permErr = new Error('Telegram API sendMessage failed: 400 bad');
    permErr.status = 400; permErr.errorCode = 400;
    const { mod } = makeModule({ client: { failSend: () => permErr } });
    let nextCalled = false;
    const out = await mod.handleApprovalRequest({ agent: tgAgent(), toolName: 'bash' },
      () => { nextCalled = true; return Promise.resolve('unavailable'); });
    assert.equal(nextCalled, true);
    assert.equal(out, 'unavailable');
  });

  console.log('createApprovalModule: cancelAll');
  await test('cancelAll resolves pending as cancelled and edits the card', async () => {
    const { client, mod } = makeModule();
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-c'), toolName: 'bash' }, () => Promise.resolve('unavailable'));
    await sleep(15);
    mod.cancelAll();
    assert.equal(await p, 'cancelled');
    assert.ok(client.calls.edits.some((e) => e.text.includes('cancelled')));
  });

  console.log('createApprovalModule: default-agent ownership (index.js policy)');
  await test('ownership may route a non-telegram agent (default agent) — module honors it', async () => {
    // Simulate index.js's approvalOwnership: route the shared default agent too.
    const { client, mod } = makeModule({
      deps: { ownership: (agent) => ({ chatId: '8367', threadId: null }) },
    });
    const p = mod.handleApprovalRequest(
      { agent: { id: 'web-default', session: { id: 'web-default' } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'));
    await sleep(15);
    assert.equal(client.calls.sends.length, 1);
    assert.equal(client.calls.sends[0].chatId, '8367');
    const key = client.calls.sends[0].replyMarkup.inline_keyboard[0][0].callback_data.slice(CALLBACK_PREFIX.length + 2);
    mod.handleCallbackQuery({ id: 'qd', data: `${CALLBACK_PREFIX}a:${key}` });
    assert.equal(await p, 'allowed-once');
  });

  console.log('approvalRuleKey / describeRuleKey:');
  await test('sandbox escalation -> sandbox:<tool>:<mode> (justification ignored)', () => {
    assert.equal(
      approvalRuleKey('bash', 'escalate sandbox to danger-full-access: need to write outside workspace'),
      'sandbox:bash:danger-full-access',
    );
    assert.equal(
      approvalRuleKey('bash', 'escalate sandbox to workspace-write: different justification'),
      'sandbox:bash:workspace-write',
    );
  });
  await test('other guarded ask -> tool:<name>', () => {
    assert.equal(approvalRuleKey('write', 'needs permission'), 'tool:write');
    assert.equal(approvalRuleKey('bash', undefined), 'tool:bash');
    assert.equal(approvalRuleKey('custom_tool', 'r'), 'tool:custom_tool');
  });
  await test('describeRuleKey renders plain text', () => {
    assert.equal(describeRuleKey('sandbox:write:danger-full-access'), 'write（写文件） 升级至 danger-full-access');
    assert.equal(describeRuleKey('tool:write'), 'write（写文件）');
    assert.equal(describeRuleKey('weird:thing'), 'weird:thing');
  });

  console.log('createAllowlistStore:');
  await test('checkAllow false before remember, true after', () => {
    const s = createAllowlistStore({ log: () => {} }); // no path = in-memory only
    assert.equal(s.checkAllow('tool:bash'), false);
    s.rememberAllow('tool:bash', '123');
    assert.equal(s.checkAllow('tool:bash'), true);
    assert.deepEqual(s.all(), ['tool:bash']);
  });
  await test('persists to disk and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-apv-'));
    const file = join(dir, 'always.json');
    try {
      const s1 = createAllowlistStore({ log: () => {}, filePath: () => file });
      s1.rememberAllow('sandbox:bash:danger-full-access', '123');
      assert.equal(s1.checkAllow('sandbox:bash:danger-full-access'), true);
      // A brand-new store on the same file must see the remembered rule.
      const s2 = createAllowlistStore({ log: () => {}, filePath: () => file });
      assert.equal(s2.checkAllow('sandbox:bash:danger-full-access'), true);
      const raw = readFileSync(file, 'utf8');
      assert.ok(raw.includes('sandbox:bash:danger-full-access'));
      assert.ok(raw.includes('123'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await test('clearRule removes + persist; unknown -> false', () => {
    const s = createAllowlistStore({ log: () => {} });
    s.rememberAllow('tool:write', '1');
    assert.equal(s.clearRule('tool:write'), true);
    assert.equal(s.checkAllow('tool:write'), false);
    assert.equal(s.clearRule('tool:write'), false);
  });
  await test('listForChat / removeForChat filter by chat', () => {
    const s = createAllowlistStore({ log: () => {} });
    s.rememberAllow('tool:a', '123');
    s.rememberAllow('tool:b', '456');
    s.rememberAllow('tool:c', '123');
    assert.deepEqual(s.listForChat('123').sort(), ['tool:a', 'tool:c']);
    assert.equal(s.removeForChat('123'), 2);
    assert.deepEqual(s.all(), ['tool:b']);
  });
  await test('corrupt file -> empty, no throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-apv-bad-'));
    const file = join(dir, 'always.json');
    try {
      writeFileSync(file, '{ not valid json');
      const s = createAllowlistStore({ log: () => {}, filePath: () => file });
      assert.deepEqual(s.all(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log('createApprovalModule: allow-always flow');
  await test('remembered rule -> auto allowed-once with NO card', async () => {
    const store = createAllowlistStore({ log: () => {} });
    store.rememberAllow('tool:bash', '123');
    const { client, mod } = makeModule({
      deps: {
        checkAllow: (k) => store.checkAllow(k),
        rememberAllow: (k, c) => store.rememberAllow(k, c),
      },
    });
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-aa'), toolName: 'bash', reason: 'r' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15);
    assert.equal(await p, 'allowed-once');
    assert.equal(client.calls.sends.length, 0); // no card posted
  });

  await test('always button grants + remembers the rule (future auto-allowed)', async () => {
    const store = createAllowlistStore({ log: () => {} });
    const { client, mod } = makeModule({
      deps: {
        checkAllow: (k) => store.checkAllow(k),
        rememberAllow: (k, c) => store.rememberAllow(k, c),
      },
    });
    // First ask: card posted, user taps "🔁 一直允许".
    const p1 = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-ab'), toolName: 'bash', reason: 'escalate sandbox to danger-full-access: w' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15);
    const sent = client.calls.sends[0];
    const alwaysBtn = sent.replyMarkup.inline_keyboard[0][1];
    assert.ok(alwaysBtn.callback_data.startsWith(`${CALLBACK_PREFIX}y:`));
    mod.handleCallbackQuery({ id: 'qy', data: alwaysBtn.callback_data });
    assert.equal(await p1, 'allowed-once');
    assert.equal(store.checkAllow('sandbox:bash:danger-full-access'), true);

    // Second identical ask: auto-approved, no new card.
    const before = client.calls.sends.length;
    const p2 = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-ab'), toolName: 'bash', reason: 'escalate sandbox to danger-full-access: other' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15);
    assert.equal(await p2, 'allowed-once');
    assert.equal(client.calls.sends.length, before); // still no new card
  });

  await test('plain approve does NOT remember (stays one-shot)', async () => {
    const store = createAllowlistStore({ log: () => {} });
    const { client, mod } = makeModule({
      deps: {
        checkAllow: (k) => store.checkAllow(k),
        rememberAllow: (k, c) => store.rememberAllow(k, c),
      },
    });
    const p = mod.handleApprovalRequest(
      { agent: tgAgent('telegram-ac'), toolName: 'write', reason: 'r' },
      () => Promise.resolve('unavailable'),
    );
    await sleep(15);
    const sent = client.calls.sends[0];
    const approveBtn = sent.replyMarkup.inline_keyboard[0][0];
    assert.ok(approveBtn.callback_data.startsWith(`${CALLBACK_PREFIX}a:`));
    mod.handleCallbackQuery({ id: 'qa', data: approveBtn.callback_data });
    assert.equal(await p, 'allowed-once');
    assert.equal(store.checkAllow('tool:write'), false); // not remembered
  });
})();

await sleep(50); // let any trailing microtasks/acks flush
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
