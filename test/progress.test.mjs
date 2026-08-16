// Unit tests for the Telegram progress indicator (tool calls + thinking).
// Run: node test/progress.test.mjs
import { strict as assert } from 'node:assert';
import { summarizeToolArgs, tailOf, ProgressIndicator } from '../src/index.js';

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

// A recording mock of the Telegram client the indicator talks to.
function makeClient() {
  const calls = { send: 0, edits: [], deletes: [], typing: 0 };
  let nextId = 1000;
  return {
    calls,
    async sendMessage(opts) { calls.send++; return { messageId: ++nextId }; },
    async editMessageText(_chat, id, text) { calls.edits.push({ id, text }); return true; },
    async deleteMessage(_chat, id) { calls.deletes.push(id); return true; },
    sendChatAction() { calls.typing++; },
  };
}

function makeOpts(overrides = {}) {
  return Object.assign({
    chatId: '123',
    threadId: undefined,
    agent: { session: { events: [] } },
    baseline: 0,
    startedAt: Date.now(),
    client: makeClient(),
    log: () => {},
    delayMs: 0,          // post immediately in tests
    intervalMs: 4000,    // large so manual push() is not throttled unexpectedly
    tailChars: 40,
    timeoutMs: 60_000,
  }, overrides);
}

// ---- pure helpers ---------------------------------------------------------
await (async () => {
console.log('summarizeToolArgs:');
await test('object args -> single line', () => {
  const s = summarizeToolArgs({ command: 'ls\n-la\n/home', description: 'x' });
  assert.equal(s.includes('\n'), false);
  assert.ok(s.includes('command'));
});
await test('string args kept + truncated', () => {
  const s = summarizeToolArgs('a'.repeat(300), 50);
  assert.ok(s.length <= 51);
  assert.ok(s.endsWith('…'));
});
await test('null args -> empty', () => {
  assert.equal(summarizeToolArgs(null), '');
});
console.log('tailOf:');
await test('short string unchanged', () => {
  assert.equal(tailOf('hello', 40), 'hello');
});
await test('long string -> ellipsis + tail', () => {
  const s = tailOf('x'.repeat(100) + 'TAIL', 40);
  assert.ok(s.startsWith('…'));
  assert.ok(s.endsWith('TAIL'));
  assert.equal(s.length, 41);
});

// ---- buildStatusLine priority ---------------------------------------------
console.log('buildStatusLine:');
await test('default line when idle', () => {
  const ind = new ProgressIndicator(makeOpts());
  assert.equal(ind.buildStatusLine(), '⏳ 正在处理，请稍候…');
});
await test('thinking shown when reasoning is the latest activity', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.lastKind = 'reasoning';
  ind.reasoningBuf = 'let me think about it a lot';
  assert.ok(ind.buildStatusLine().includes('💭 思考中'));
});
await test('tool shown when tool is the latest activity', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.lastKind = 'tool';
  ind.currentTool = { name: 'bash', args: '{"command":"ls -la /home"}' };
  const line = ind.buildStatusLine();
  assert.ok(line.includes('🔧 正在调用工具 bash'));
  assert.ok(line.includes('ls -la /home'));
});
await test('reply shown when reply is the latest activity', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.lastKind = 'text';
  ind.replyBuf = 'and this is the answer'.repeat(3);
  assert.ok(ind.buildStatusLine().includes('✍️ 正在写回复'));
});
await test('most-recent activity wins over earlier thinking (no stale 💭)', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.lastKind = 'reasoning';
  ind.reasoningBuf = 'some thinking';
  // Model finished thinking and started the reply.
  ind.lastKind = 'text';
  ind.replyBuf = 'the final answer text';
  const line = ind.buildStatusLine();
  assert.ok(line.includes('✍️ 正在写回复'), `expected reply line, got: ${line}`);
  assert.ok(!line.includes('💭 思考中'), 'stale thinking must not be shown');
});

// ---- processEvents --------------------------------------------------------
console.log('processEvents:');
await test('parses reasoning + tool + text chronologically (last activity wins)', () => {
  const ind = new ProgressIndicator(makeOpts({ baseline: 0 }));
  const events = [
    { seq: 1, type: 'reasoning-chunks', data: { texts: ['Let', ' me'] } },
    { seq: 2, type: 'tool-call-chunks', data: { name: 'bash', args: ['{', '"command":"ls"}'] } },
    { seq: 3, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la"}' } },
    { seq: 4, type: 'text-chunks', data: { texts: ['Done.'] } },
  ];
  const done = ind.processEvents(events);
  assert.equal(done, false);
  assert.equal(ind.reasoningBuf, 'Let me');
  assert.equal(ind.replyBuf, 'Done.');
  // text-chunks came after the tool/call, so the model has moved on to writing
  // the reply — the indicator reflects the latest activity (not the tool).
  assert.equal(ind.lastKind, 'text');
  assert.ok(ind.buildStatusLine().includes('✍️ 正在写回复'));
  // Re-processing the same log must not change state (idempotent watermark).
  ind.processEvents(events);
  assert.equal(ind.reasoningBuf, 'Let me');
  assert.equal(ind.replyBuf, 'Done.');
});
await test('tool/call as the last activity is the top-priority line', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvents([
    { seq: 1, type: 'reasoning-chunks', data: { texts: ['thinking'] } },
    { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la"}' } },
  ]);
  assert.deepEqual(ind.currentTool, { name: 'bash', args: '{"command":"ls -la"}' });
  assert.ok(ind.buildStatusLine().includes('🔧 正在调用工具 bash'));
  assert.ok(ind.buildStatusLine().includes('ls -la'));
});
await test('ignores events at/below baseline', () => {
  const ind = new ProgressIndicator(makeOpts({ baseline: 5 }));
  const done = ind.processEvents([
    { seq: 5, type: 'reasoning-chunks', data: { texts: ['old'] } },
    { seq: 6, type: 'reasoning-chunks', data: { texts: ['new'] } },
  ]);
  assert.equal(done, false);
  assert.equal(ind.reasoningBuf, 'new');
});
await test('turn/end returns true', () => {
  const ind = new ProgressIndicator(makeOpts());
  const done = ind.processEvents([{ seq: 1, type: 'turn/end', data: { kind: 'complete' } }]);
  assert.equal(done, true);
});
await test('a reply after a tool shows the reply, not the stale tool', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvents([
    { seq: 1, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
    { seq: 2, type: 'text-chunks', data: { texts: ['now writing'] } },
  ]);
  // lastKind now points at the reply; the stale tool is not shown.
  assert.equal(ind.lastKind, 'text');
  assert.ok(ind.buildStatusLine().includes('✍️ 正在写回复'));
  assert.ok(!ind.buildStatusLine().includes('🔧 正在调用工具'));
});
await test('after tool/result the line is neutral until the next block', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvents([
    { seq: 1, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { seq: 2, type: 'tool/result', data: {} },
  ]);
  assert.equal(ind.lastKind, null);
  assert.equal(ind.buildStatusLine(), '⏳ 正在处理，请稍候…');
  // The next block (thinking) replaces the neutral line.
  ind.processEvents([{ seq: 3, type: 'reasoning-chunks', data: { texts: ['next'] } }]);
  assert.equal(ind.lastKind, 'reasoning');
  assert.ok(ind.buildStatusLine().includes('💭 思考中'));
});

// ---- full lifecycle with a mock client ------------------------------------
console.log('lifecycle:');
await test('posts message, edits on activity, deletes on turn/end', async () => {
  const client = makeClient();
  const events = [];
  const ind = new ProgressIndicator(makeOpts({
    client,
    agent: { session: { get events() { return events; } } },
    intervalMs: 20,
    delayMs: 0,
  }));
  ind.start();
  await sleep(30);
  assert.ok(client.calls.send >= 1, 'indicator message was posted');
  // Push some activity.
  events.push(
    { seq: 1, type: 'reasoning-chunks', data: { texts: ['thinking...'] } },
    { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la /home"}' } },
  );
  await sleep(60);
  assert.ok(client.calls.edits.length >= 1, 'status was edited in place');
  const lastEdit = client.calls.edits[client.calls.edits.length - 1].text;
  assert.ok(lastEdit.includes('🔧 正在调用工具 bash'), `expected tool line, got: ${lastEdit}`);
  // Turn ends -> indicator stops and the message is deleted.
  events.push({ seq: 3, type: 'turn/end', data: { kind: 'complete' } });
  await sleep(60);
  assert.equal(ind.stopped, true, 'indicator stopped after turn/end');
  assert.ok(client.calls.deletes.length >= 1, 'indicator message was deleted');
});

await test('no indicator posted for a turn that ends immediately', async () => {
  const client = makeClient();
  const events = [{ seq: 1, type: 'turn/end', data: { kind: 'complete' } }];
  const ind = new ProgressIndicator(makeOpts({
    client,
    agent: { session: { events } },
    intervalMs: 20,
    delayMs: 40,   // turn ends before the delay elapses
  }));
  ind.start();
  await sleep(30);
  assert.equal(client.calls.send, 0, 'no message posted for an instant turn');
  assert.equal(ind.stopped, true, 'indicator stopped');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
