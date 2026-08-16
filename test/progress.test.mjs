// Unit tests for the Telegram progress indicator (tool calls + thinking).
// Run: node test/progress.test.mjs
import { strict as assert } from 'node:assert';
import { summarizeToolArgs, tailOf, compactText, ProgressIndicator } from '../src/index.js';

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
    delayMs: 0,             // post immediately in tests
    intervalMs: 4000,       // large so manual push() is not throttled unexpectedly
    perBlockChars: 40,
    maxChars: 200,
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

// ---- compactText / buildTraceText -----------------------------------------
console.log('compactText:');
await test('collapses whitespace runs', () => {
  assert.equal(compactText('  a   b\n\nc  '), 'a b c');
  assert.equal(compactText(undefined), '');
});

console.log('buildTraceText:');
await test('header + neutral line when idle', () => {
  const ind = new ProgressIndicator(makeOpts());
  assert.ok(ind.buildTraceText().includes('📜 运行轨迹'));
  assert.ok(ind.buildTraceText().includes('⏳ 正在处理，请稍候…'));
});
await test('reasoning streamed into a 💭 line (tail-truncated per block)', () => {
  const ind = new ProgressIndicator(makeOpts({ perBlockChars: 10 }));
  ind.processEvent({ seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'thinking a little ' } } });
  ind.processEvent({ seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'then more' } } });
  const text = ind.buildTraceText();
  assert.ok(text.includes('💭'));
  assert.ok(text.includes('then more'), `expected tail of reasoning, got: ${text}`);
});
await test('tool call shown as 🔧 name：args', () => {
  const ind = new ProgressIndicator(makeOpts({ perBlockChars: 100 }));
  ind.processEvent({ seq: 1, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la /home"}', callId: 'c1' } });
  const text = ind.buildTraceText();
  assert.ok(text.includes('🔧 bash'));
  assert.ok(text.includes('ls -la /home'));
});
await test('block-end tool-call and tool/call dedupe by id (not shown twice)', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvent({ seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' } } } });
  ind.processEvent({ seq: 2, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } });
  const text = ind.buildTraceText();
  const count = text.split('🔧').length - 1;
  assert.equal(count, 1, `expected one tool line, got ${count}: ${text}`);
});
await test('whole message tail-truncated to maxChars (newest survives)', () => {
  const ind = new ProgressIndicator(makeOpts({ perBlockChars: 100, maxChars: 60 }));
  ind.processEvent({ seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'AAAA'.repeat(50) } } });
  ind.processEvent({ seq: 2, type: 'tool/call', data: { name: 'read', arguments: 'NEWEST', callId: 'c1' } });
  const text = ind.buildTraceText();
  assert.ok(text.length <= 60, `text too long: ${text.length}`);
  assert.ok(text.includes('NEWEST'), 'newest item must survive tail truncation');
  assert.ok(text.startsWith('…') || text.includes('…'), 'truncation marker present');
});
await test('text-delta / text block are NOT shown (reply is separate)', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvent({ seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: 'final reply body' } } });
  const text = ind.buildTraceText();
  assert.ok(!text.includes('final reply body'), 'reply text must not appear in the trajectory');
});

// ---- processEvents --------------------------------------------------------
console.log('processEvents:');
await test('folds reasoning + tool chronologically', () => {
  const ind = new ProgressIndicator(makeOpts({ baseline: 0 }));
  const events = [
    { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'Let ' } } },
    { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'me' } } },
    { seq: 3, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la"}', callId: 'c1' } },
  ];
  const done = ind.processEvents(events);
  assert.equal(done, false);
  assert.equal(ind.trace.length, 2, 'reasoning (merged) + tool');
  assert.equal(ind.trace[0].kind, 'reasoning');
  assert.equal(ind.trace[0].text, 'Let me');
  assert.equal(ind.trace[1].kind, 'tool');
  // Re-processing the same log must not change state (idempotent watermark).
  ind.processEvents(events);
  assert.equal(ind.trace.length, 2);
  assert.equal(ind.trace[0].text, 'Let me');
});
await test('ignores events at/below baseline', () => {
  const ind = new ProgressIndicator(makeOpts({ baseline: 5 }));
  const done = ind.processEvents([
    { seq: 5, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'old' } } },
    { seq: 6, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'new' } } },
  ]);
  assert.equal(done, false);
  assert.equal(ind.trace.length, 1);
  assert.equal(ind.trace[0].text, 'new');
});
await test('turn/end returns true', () => {
  const ind = new ProgressIndicator(makeOpts());
  const done = ind.processEvents([{ seq: 1, type: 'turn/end', data: { kind: 'complete' } }]);
  assert.equal(done, true);
});
await test('packed reasoning-chunks / tool-call-chunks rows are understood', () => {
  const ind = new ProgressIndicator(makeOpts());
  ind.processEvents([
    { seq: 1, type: 'reasoning-chunks', data: { texts: ['Let', ' me'] } },
    { seq: 2, type: 'tool-call-chunks', data: { name: 'bash', args: ['{"command":"ls"}'] } },
  ]);
  assert.equal(ind.trace.length, 2);
  assert.equal(ind.trace[0].text, 'Let me');
  assert.equal(ind.trace[1].kind, 'tool');
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
  // Push some activity (the live `assistant/chunk` + `tool/call` shapes).
  events.push(
    { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'thinking...' } } },
    { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la /home"}', callId: 'c1' } },
  );
  await sleep(60);
  assert.ok(client.calls.edits.length >= 1, 'trajectory was edited in place');
  const lastEdit = client.calls.edits[client.calls.edits.length - 1].text;
  assert.ok(lastEdit.includes('🔧 bash'), `expected tool line, got: ${lastEdit}`);
  assert.ok(lastEdit.includes('ls -la /home'), `expected args, got: ${lastEdit}`);
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
