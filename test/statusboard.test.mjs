// Unit tests for src/statusboard.js — /goal grammar, status rendering, and
// the pinned StatusBoard lifecycle.
// Run: node test/statusboard.test.mjs
import { strict as assert } from 'node:assert';
import {
  parseGoalCommand, formatGoalReport, goalHint, goalViewLine,
  renderStatus, statusIsMeaningful, StatusBoard, GOAL_USAGE, phaseLabel, workspaceLabel,
} from '../src/statusboard.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}

console.log('parseGoalCommand:');
await test('empty -> show', () => assert.equal(parseGoalCommand('').kind, 'show'));
await test('clear/pause/resume (case-insensitive)', () => {
  assert.equal(parseGoalCommand('CLEAR').kind, 'clear');
  assert.equal(parseGoalCommand(' Pause ').kind, 'pause');
  assert.equal(parseGoalCommand('resume').kind, 'resume');
});
await test('bare "edit" -> invalid-edit; "edit x" -> edit', () => {
  assert.equal(parseGoalCommand('edit').kind, 'invalid-edit');
  assert.deepEqual(parseGoalCommand('edit ship v7'), { kind: 'edit', objective: 'ship v7' });
});
await test('arbitrary text -> create with objective', () => {
  assert.deepEqual(parseGoalCommand('write tests'), { kind: 'create', objective: 'write tests' });
});

console.log('\nrendering:');
const goal = {
  id: 'goal-1', revision: 2, objective: 'ship v7', phase: 'active',
  maxGoalRounds: 8, roundsStarted: 3, activation: 'armed',
};
await test('formatGoalReport includes phase/objective/rounds/hint', () => {
  const t = formatGoalReport('T', goal);
  assert.match(t, /进行中/);
  assert.match(t, /ship v7/);
  assert.match(t, /3\/8/);
  assert.match(t, /pause/);
});
await test('blocked goal shows reason', () => {
  const t = formatGoalReport('T', { ...goal, phase: 'blocked', blockedReason: { code: 'no-access', message: 'host down' } });
  assert.match(t, /no-access host down/);
});
await test('goalHint complete -> new objective', () => {
  assert.match(goalHint({ phase: 'complete' }), /\/goal <新目标>/);
});
await test('goalViewLine clips long objectives', () => {
  const line = goalViewLine({ ...goal, objective: 'x'.repeat(300) }, 120);
  assert.ok(line.length < 200, 'line stays short');
  assert.match(line, /…（3\/8 轮）$/);
});
await test('phaseLabel passthrough unknown', () => assert.equal(phaseLabel('weird'), 'weird'));

console.log('\nrenderStatus:');
await test('neutral chat is not meaningful', () => {
  assert.equal(statusIsMeaningful({ plan: { active: false }, goal: null, autopilot: false }), false);
  const { meaningful } = renderStatus({ plan: { active: false } });
  assert.equal(meaningful, false);
});
await test('plan active -> board with plan line', () => {
  const { text, meaningful } = renderStatus({ sessionId: 'abc', plan: { active: true }, goal: null, autopilot: false });
  assert.ok(meaningful);
  assert.match(text, /🗺️ 计划模式：开启/);
});
await test('pending enter shows 下一步生效', () => {
  const { text } = renderStatus({ plan: { active: false, pending: true } });
  assert.match(text, /进入中（下一步生效）/);
});
await test('goal + autopilot lines', () => {
  const { text, meaningful } = renderStatus({ sessionId: 's', plan: { active: false }, goal, autopilot: true });
  assert.ok(meaningful);
  assert.match(text, /🎯 目标［进行中］：ship v7（3\/8 轮）/);
  assert.match(text, /Autopilot：开启/);
});

await test('git line renders under the header and justifies pinning', () => {
  const { text, meaningful } = renderStatus({ plan: { active: false }, goal: null, autopilot: false, gitLine: '🌿 main · 2 未提交 · ↑7' });
  assert.ok(meaningful, 'a git workspace alone justifies the board');
  const lines = text.split('\n');
  assert.equal(lines[0], '📌 会话状态');
  assert.equal(lines[1], '🌿 main · 2 未提交 · ↑7');
});
await test('no git line -> board unchanged (non-git workspace)', () => {
  const { text } = renderStatus({ plan: { active: true }, gitLine: '' });
  assert.ok(!text.includes('🌿'));
});

console.log('\nworkspace folder row:');
await test('workspace row shows the folder name under the header', () => {
  const { text } = renderStatus({ plan: { active: false }, workspace: workspaceLabel('/home/me/sglang-fork-dev') });
  const lines = text.split('\n');
  assert.equal(lines[1], '📁 sglang-fork-dev');
});
await test('workspace label takes the last segment, ignores trailing slash', () => {
  assert.equal(workspaceLabel('/home/me/Documents/'), 'Documents');
  assert.equal(workspaceLabel(''), '');
  assert.equal(workspaceLabel(undefined), '');
  assert.equal(workspaceLabel('/'), '/');
});
await test('a folder name alone does not justify pinning the board', () => {
  const { meaningful } = renderStatus({ plan: { active: false }, goal: null, autopilot: false, workspace: 'docs' });
  assert.ok(!meaningful, 'workspace row rides along, never pins by itself');
});

console.log('\nStatusBoard lifecycle:');
function fakeDeps() {
  const calls = [];
  let msgSeq = 100;
  let editable = true;
  return {
    calls, editable: () => editable, setEditable: (v) => { editable = v; },
    deps: {
      chatId: '42',
      sendText: async (text) => { calls.push(['send', text]); return ++msgSeq; },
      editText: async (id, text) => { calls.push(['edit', id, text]); return editable; },
      pin: async (id) => { calls.push(['pin', id]); return true; },
      unpin: async (id) => { calls.push(['unpin', id]); return true; },
      deleteMessage: async (id) => { calls.push(['delete', id]); return true; },
    },
  };
}
const activeSnap = { sessionId: 's1', plan: { active: true }, goal, autopilot: false };

await test('first meaningful refresh: send + pin', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap);
  assert.deepEqual(f.calls.map((c) => c[0]), ['send', 'pin']);
});
await test('unchanged snapshot is a no-op', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap);
  f.calls.length = 0;
  await b.refresh(activeSnap);
  assert.equal(f.calls.length, 0);
});
await test('changed snapshot edits in place (no re-pin)', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap);
  f.calls.length = 0;
  await b.refresh({ ...activeSnap, autopilot: true });
  assert.deepEqual(f.calls.map((c) => c[0]), ['edit']);
});
await test('deleted message (edit false) re-posts next refresh', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap);
  f.setEditable(false);
  f.calls.length = 0;
  await b.refresh({ ...activeSnap, autopilot: true });
  assert.deepEqual(f.calls.map((c) => c[0]), ['edit']); // failed edit drops the id
  f.setEditable(true);
  f.calls.length = 0;
  await b.refresh({ ...activeSnap, autopilot: true });
  assert.deepEqual(f.calls.map((c) => c[0]), ['send', 'pin']); // re-posted
});
await test('neutral snapshot tears board down (unpin+delete)', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap);
  f.calls.length = 0;
  await b.refresh({ plan: { active: false }, goal: null, autopilot: false });
  assert.deepEqual(f.calls.map((c) => c[0]), ['unpin', 'delete']);
  assert.equal(b.messageId, null);
});
await test('teardown invalidates in-flight refresh (orphan deleted)', async () => {
  const f = fakeDeps();
  const b = new StatusBoard(f.deps);
  let resolveSend;
  b.sendText = () => new Promise((r) => { resolveSend = r; });
  b.deleteMessage = async (id) => { f.calls.push(['delete', id]); };
  const inflight = b.refresh(activeSnap);
  await b.teardown();
  resolveSend(555);
  await inflight;
  assert.ok(f.calls.some((c) => c[0] === 'delete' && c[1] === 555), 'orphan message deleted');
  assert.equal(b.messageId, null);
});
await test('pin failure never blocks refresh', async () => {
  const f = fakeDeps();
  f.deps.pin = async () => { throw new Error('bot is not admin'); };
  const b = new StatusBoard(f.deps);
  await b.refresh(activeSnap); // must not throw
  assert.ok(b.messageId > 0);
});
await test('pinEnabled false skips pin', async () => {
  const f = fakeDeps();
  const b = new StatusBoard({ ...f.deps, pinEnabled: false });
  await b.refresh(activeSnap);
  assert.deepEqual(f.calls.map((c) => c[0]), ['send']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
