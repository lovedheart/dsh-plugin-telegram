// Unit tests for the live subagent board (src/subagents.js).
// Run: node test/subagents.test.mjs
import { strict as assert } from 'node:assert';
import {
  SubagentBoard,
  displayWidth,
  truncateDisplay,
  statusEmoji,
  statusWord,
  normalizeStopReason,
  labelFromSession,
  labelFromDescription,
  latestActivity,
  renderBoardText,
  parentSubagentDescriptions,
} from '../src/subagents.js';

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

// ---- pure helpers ---------------------------------------------------------
console.log('displayWidth:');
await test('counts CJK as 2 columns', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中a'), 3);
});

console.log('truncateDisplay:');
await test('short string unchanged', () => {
  assert.equal(truncateDisplay('hello', 10), 'hello');
});
await test('long ASCII -> ellipsis, within width', () => {
  const s = truncateDisplay('x'.repeat(50), 10);
  assert.ok(s.endsWith('…'));
  assert.ok(displayWidth(s) <= 10);
});
await test('CJK clipping stays within width', () => {
  const s = truncateDisplay('中'.repeat(20), 10);
  assert.ok(s.endsWith('…'));
  assert.ok(displayWidth(s) <= 10);
});

console.log('status emoji / word / reason:');
await test('emoji mapping', () => {
  assert.equal(statusEmoji('working'), '🟢');
  assert.equal(statusEmoji('completed'), '✅');
  assert.equal(statusEmoji('error'), '❌');
  assert.equal(statusEmoji('aborted'), '⏹️');
});
await test('word mapping (Chinese)', () => {
  assert.equal(statusWord('working'), '工作中');
  assert.equal(statusWord('completed'), '已完成');
  assert.equal(statusWord('error'), '出错');
});
await test('normalizeStopReason', () => {
  assert.equal(normalizeStopReason('completed'), 'completed');
  assert.equal(normalizeStopReason('failed'), 'error');
  assert.equal(normalizeStopReason('cancelled'), 'cancelled');
  assert.equal(normalizeStopReason(''), 'completed');
});

console.log('labelFromSession:');
await test('extracts subagent/descriptor label', () => {
  const session = {
    events: [
      { seq: 1, type: 'assistant/chunk', data: {} },
      { seq: 2, type: 'subagent/descriptor', data: { label: 'Refactor auth module' } },
    ],
  };
  assert.equal(labelFromSession(session), 'Refactor auth module');
});
await test('no descriptor -> empty', () => {
  assert.equal(labelFromSession({ events: [] }), '');
  assert.equal(labelFromSession(undefined), '');
});

console.log('labelFromDescription:');
await test('collapses whitespace + truncates', () => {
  assert.equal(labelFromDescription('  run   the  tests  ', 20), 'run the tests');
  const s = labelFromDescription('x'.repeat(50), 10);
  assert.ok(displayWidth(s) <= 10);
});

console.log('latestActivity:');
await test('prefers most recent tool call', () => {
  const session = {
    events: [
      { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'thinking…' } } },
      { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls -la' } } },
    ],
  };
  const a = latestActivity(session);
  assert.ok(a.startsWith('bash'), `got: ${a}`);
  assert.ok(a.includes('ls -la'));
});
await test('falls back to reasoning', () => {
  const session = {
    events: [
      { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'analy' } } },
      { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'zing' } } },
    ],
  };
  assert.equal(latestActivity(session), 'analyzing');
});
await test('respects sinceSeq', () => {
  const session = {
    events: [
      { seq: 1, type: 'tool/call', data: { name: 'read', arguments: { file_path: 'a' } } },
      { seq: 2, type: 'tool/call', data: { name: 'write', arguments: { file_path: 'b' } } },
    ],
  };
  assert.ok(latestActivity(session, 1).startsWith('write'));
});
await test('empty session -> empty', () => {
  assert.equal(latestActivity(undefined), '');
  assert.equal(latestActivity({ events: [] }), '');
});

console.log('parentSubagentDescriptions:');
await test('collects subagent tool-call descriptions', () => {
  const session = {
    events: [
      { seq: 1, type: 'tool/call', data: { name: 'subagent', arguments: { description: 'research X', subagent_id: 'c1' } } },
      { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls' } } },
      { seq: 3, type: 'tool/call', data: { name: 'subagent_fork', arguments: { description: 'refactor Y' } } },
    ],
  };
  const { byId, last } = parentSubagentDescriptions(session);
  assert.equal(byId.get('c1'), 'research X');
  assert.equal(last, 'refactor Y');
});

// ---- renderBoardText ------------------------------------------------------
function entry(id, over = {}) {
  return Object.assign({
    id, label: id, status: 'working', work: '', locked: false,
    startedAt: 1000, endedAt: 0, stopReason: '',
  }, over);
}
console.log('renderBoardText:');
await test('header shows working/done counts', () => {
  const t = renderBoardText([entry('a'), entry('b', { status: 'completed', locked: true, endedAt: 2000 })],
    { working: 1, done: 1, now: 3000 });
  assert.ok(t.includes('1 工作中 / 1 完成'));
});
await test('working row has 2 lines (status + work)', () => {
  const t = renderBoardText([entry('a', { label: 'task A', work: 'running tests' })], { working: 1, done: 0, now: 0 });
  const lines = t.split('\n');
  assert.ok(lines.some((l) => l.includes('task A') && l.includes('工作中')));
  assert.ok(lines.some((l) => l.includes('running tests')));
});
await test('terminal row shows reason + elapsed', () => {
  const t = renderBoardText([entry('a', { status: 'completed', locked: true, endedAt: 16000 })],
    { working: 0, done: 1, now: 16000, startWall: { a: 10000 } });
  assert.ok(t.includes('已完成'));
  assert.ok(t.includes('用时'));
});
await test('maxRows collapses overflow into +K more', () => {
  const entries = ['a', 'b', 'c'].map((id) => entry(id, { label: id }));
  const t = renderBoardText(entries, { working: 3, done: 0, now: 0, maxRows: 2 });
  assert.ok(t.includes('另有 1 个未显示'));
});
await test('working with no work shows placeholder', () => {
  const t = renderBoardText([entry('a', { work: '' })], { working: 1, done: 0, now: 0 });
  assert.ok(t.includes('正在启动…'));
});

// ---- SubagentBoard state machine -----------------------------------------
function makeBoard(overrides = {}) {
  let now = 1_000_000;
  const board = new SubagentBoard(Object.assign({
    chatId: '42',
    sendText: async () => 1001,
    editText: async () => true,
    pin: async () => true,
    unpin: async () => true,
    listAgents: () => [],
    clock: () => now,
    log: () => {},
  }, overrides));
  board._advance = (ms) => { now += ms; };
  return board;
}
console.log('SubagentBoard lifecycle:');
await test('onStart creates a working entry; counts work', () => {
  const b = makeBoard();
  b.onStart({ id: 'c1' });
  assert.equal(b.workingCount, 1);
  assert.equal(b.doneCount, 0);
  assert.equal(b.hasWorking, true);
});
await test('onEnd locks the row and counts done', () => {
  const b = makeBoard();
  b.onStart({ id: 'c1' });
  b.onEnd({ id: 'c1', stopReason: 'completed' });
  assert.equal(b.workingCount, 0);
  assert.equal(b.doneCount, 1);
  assert.equal(b.entries.get('c1').locked, true);
  assert.equal(b.hasWorking, false);
});
await test('restart of a locked entry re-opens it as working', () => {
  const b = makeBoard();
  b.onStart({ id: 'c1' });
  b.onEnd({ id: 'c1', stopReason: 'completed' });
  b.onStart({ id: 'c1' });
  assert.equal(b.entries.get('c1').locked, false);
  assert.equal(b.workingCount, 1);
});
await test('onEnd captures lastAssistantMessage text as work', () => {
  const b = makeBoard();
  b.onStart({ id: 'c1' });
  b.onEnd({ id: 'c1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done: 3 files' }] });
  assert.equal(b.entries.get('c1').work, 'done: 3 files');
});
await test('orderedEntries: working first, then done', () => {
  const b = makeBoard();
  b.onStart({ id: 'done1' }); b.onEnd({ id: 'done1', stopReason: 'completed' });
  b.onStart({ id: 'work1' });
  const order = b.orderedEntries().map((e) => e.id);
  assert.deepEqual(order, ['work1', 'done1']);
});

console.log('SubagentBoard refresh (live read):');
await test('refresh pulls label + work from the live child session', () => {
  const childSession = {
    events: [
      { seq: 1, type: 'subagent/descriptor', data: { label: 'Audit config' } },
      { seq: 2, type: 'tool/call', data: { name: 'read', arguments: { file_path: '/cfg.yaml' } } },
    ],
  };
  // The board indexes agents by session.id (SubagentRun.id === childSessionId).
  const b = makeBoard({
    listAgents: () => [{ session: { id: 'c1', header: { origin: 'subagent' }, events: childSession.events }, status: 'running' }],
  });
  b.onStart({ id: 'c1' });
  b.refresh(undefined);
  const e = b.entries.get('c1');
  assert.equal(e.label, 'Audit config');
  assert.ok(e.work.startsWith('read'));
});
await test('refresh locks a child that left the running state', () => {
  const b = makeBoard({
    listAgents: () => [{ session: { id: 'c1', header: { origin: 'subagent' }, events: [] }, status: 'idle' }],
  });
  b.onStart({ id: 'c1' });
  b.refresh(undefined);
  assert.equal(b.entries.get('c1').status, 'completed');
  assert.equal(b.entries.get('c1').locked, true);
});
await test('refresh grace: missing child locks after GRACE_TICKS', () => {
  const b = makeBoard({ listAgents: () => [] }); // child never appears
  b.onStart({ id: 'c1' });
  b.refresh(undefined); b.refresh(undefined);
  assert.equal(b.entries.get('c1').locked, false, 'not yet locked within grace');
  b.refresh(undefined);
  assert.equal(b.entries.get('c1').locked, true, 'locked after grace');
});

console.log('SubagentBoard render + flush:');
await test('render() produces board text with counts', () => {
  const b = makeBoard();
  b.onStart({ id: 'c1' }); b.entries.get('c1').label = 'task A';
  b.entries.get('c1').work = 'ls -la';
  const t = b.render();
  assert.ok(t.includes('1 工作中 / 0 完成'));
  assert.ok(t.includes('task A'));
  assert.ok(t.includes('ls -la'));
});
await test('flush() sends + pins on first flush, then edits', async () => {
  let sent = 0, edits = 0, pins = 0;
  const b = makeBoard({
    sendText: async () => { sent++; return 555; },
    editText: async () => { edits++; return true; },
    pin: async () => { pins++; return true; },
  });
  b.onStart({ id: 'c1' }); b.entries.get('c1').label = 'A'; b.entries.get('c1').work = 'w1';
  await b.flush(true);
  assert.equal(sent, 1);
  assert.equal(pins, 1);
  assert.equal(b.messageId, 555);
  // Change work, advance past the throttle window, flush again -> edit, not send.
  b.entries.get('c1').work = 'w2';
  b._advance(2000);
  await b.flush();
  assert.equal(sent, 1, 'no second send');
  assert.equal(edits, 1, 'edited in place');
});
await test('flush() is throttled (no edit within window for unchanged text)', async () => {
  let edits = 0;
  const b = makeBoard({ editText: async () => { edits++; return true; } });
  b.onStart({ id: 'c1' }); b.entries.get('c1').label = 'A'; b.entries.get('c1').work = 'w';
  await b.flush(true);
  // Same text again immediately -> no new edit.
  await b.flush();
  assert.equal(edits, 0);
});
await test('flush() re-posts (sends again) after a failed edit', async () => {
  let sent = 0, editFail = true;
  const b = makeBoard({
    sendText: async () => { sent++; return 777; },
    editText: async () => { if (editFail) { editFail = false; return false; } return true; },
  });
  b.onStart({ id: 'c1' }); b.entries.get('c1').label = 'A'; b.entries.get('c1').work = 'w';
  await b.flush(true);
  assert.equal(b.messageId, 777);
  b.entries.get('c1').work = 'w2';
  b._advance(2000);
  await b.flush(); // edit fails -> id dropped
  assert.equal(b.messageId, null, 'dropped after failed edit');
  b._advance(2000);
  await b.flush(true);
  assert.equal(sent, 2, 're-posted a fresh board');
});

console.log('SubagentBoard teardown + prune:');
await test('teardown() unpins and clears state', async () => {
  let unpins = 0;
  const b = makeBoard({ unpin: async () => { unpins++; return true; } });
  b.onStart({ id: 'c1' }); b.messageId = 999;
  await b.teardown();
  assert.equal(unpins, 1);
  assert.equal(b.messageId, null);
  assert.equal(b.isEmpty, true);
});
await test('prune() drops terminal entries older than grace window', () => {
  const b = makeBoard();
  b.onStart({ id: 'old' }); b.onEnd({ id: 'old', stopReason: 'completed' });
  // endedAt is the board clock at end time (long ago); prune far in the future.
  b.prune(b.clock() + 40 * 60 * 1000);
  assert.equal(b.entries.has('old'), false, 'settled entry pruned after grace window');
  // A still-working entry is never pruned.
  b.onStart({ id: 'live' });
  b.prune(b.clock() + 40 * 60 * 1000);
  assert.equal(b.entries.has('live'), true, 'working entry kept');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
