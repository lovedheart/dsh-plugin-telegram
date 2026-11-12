// Unit tests for the failed-test detector behind the 🧪 notice (src/testreport.js).
// Run: node test/testreport.test.mjs
import { strict as assert } from 'node:assert';
import {
  isTestRun, parseTestFailure, summarizeTestFailures, formatTestFailureNotice,
} from '../src/testreport.js';

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

const call = (seq, name, args, callId = `c${seq}`) => ({ seq, type: 'tool/call', data: { name, arguments: args, callId } });
const result = (seq, callId, text, isError = false) => ({ seq, type: 'tool/result', data: { callId, message: { content: text, isError } } });

console.log('isTestRun:');
await test('npm test / pnpm test / node --test', () => {
  assert.ok(isTestRun('bash', { command: 'npm test 2>&1 | tail -40' }));
  assert.ok(isTestRun('bash', { command: 'pnpm run test:unit' }));
  assert.ok(isTestRun('bash', { command: 'node --test test/x.test.mjs' }));
  assert.ok(isTestRun('bash', { command: 'pytest -q tests/' }));
  assert.ok(isTestRun('bash', { command: 'cargo test --release' }));
});
await test('description alone is not a test run', () => {
  // The model writes "Run the full test suite" for builds too — only the
  // command decides.
  assert.equal(isTestRun('bash', { command: 'npm run build', description: 'Run the full test suite' }), false);
});
await test('unrelated shell call is not a test run', () => {
  assert.equal(isTestRun('bash', { command: 'ls -la' }), false);
  assert.equal(isTestRun('read', { file_path: 'a.js' }), false);
});
await test('JSON-string args tolerated', () => {
  assert.ok(isTestRun('bash', '{"command":"npm test"}'));
});

console.log('parseTestFailure:');
await test('node:test "# fail N" + not-ok lines', () => {
  const out = `# tests 41\n# pass 39\n# fail 2\nnot ok 7 - renders the board\nnot ok 12 - clips labels\n`;
  const r = parseTestFailure(out);
  assert.equal(r.runner, 'node:test');
  assert.equal(r.failedCount, 2);
  assert.deepEqual(r.lines, ['renders the board', 'clips labels']);
});
await test('"N passed, M failed" summary runner', () => {
  const r = parseTestFailure('✓ ok\n✗ board width\n21 passed, 1 failed');
  assert.equal(r.failedCount, 1);
  assert.ok(r.lines.includes('board width'));
});
await test('jest failed list', () => {
  const r = parseTestFailure('FAIL src/a.test.js\n  ✕ handles null\n  ✕ retries\nTests: 2 failed, 40 passed, 42 total');
  assert.equal(r.failedCount, 2);
  assert.ok(r.lines.includes('handles null'));
});
await test('pytest short summary', () => {
  const r = parseTestFailure('FAILED tests/test_a.py::test_one - assert 1 == 2\nFAILED tests/test_b.py::test_two\n=== 2 failed, 9 passed in 1.2s ===');
  assert.equal(r.failedCount, 2);
  assert.ok(r.lines.some((l) => l.includes('test_one')));
});
await test('clean run returns null', () => {
  assert.equal(parseTestFailure('41 passed, 0 failed'), null);
  assert.equal(parseTestFailure('# tests 5\n# pass 5\n# fail 0'), null);
  assert.equal(parseTestFailure(''), null);
});
await test('maxLines caps the detail list', () => {
  const out = Array.from({ length: 20 }, (_, i) => `not ok ${i} - test ${i}`).join('\n');
  assert.equal(parseTestFailure(out, { maxLines: 3 }).lines.length, 3);
});

console.log('summarizeTestFailures:');
await test('pairs tool/call with its tool/result', () => {
  const events = [
    call(1, 'bash', { command: 'echo hi' }, 'c1'),
    result(2, 'c1', 'hi'),
    call(3, 'bash', { command: 'npm test' }, 'c2'),
    result(4, 'c2', 'not ok 1 - x\n1 passed, 1 failed'),
  ];
  const s = summarizeTestFailures(events, 0);
  assert.equal(s.failedCount, 1);
  assert.equal(s.calls, 1);
  assert.deepEqual(s.lines, ['x']);
});
await test('only the current turn counts (baseline)', () => {
  const events = [call(1, 'bash', { command: 'npm test' }, 'c1'), result(2, 'c1', 'not ok 1 - old\n1 failed')];
  assert.equal(summarizeTestFailures(events, 5), null);
  assert.ok(summarizeTestFailures(events, 0));
});
await test('non-test tool failing does not report', () => {
  const events = [call(1, 'bash', { command: 'ls /nope' }, 'c1'), result(2, 'c1', 'No such file', true)];
  assert.equal(summarizeTestFailures(events, 0), null);
});
await test('two test runs merge, lines deduped', () => {
  const events = [
    call(1, 'bash', { command: 'npm test' }, 'c1'),
    result(2, 'c1', 'not ok 1 - shared\n1 failed'),
    call(3, 'bash', { command: 'npm run test:unit' }, 'c2'),
    result(4, 'c2', 'not ok 1 - shared\nnot ok 2 - extra\n2 failed'),
  ];
  const s = summarizeTestFailures(events, 0);
  assert.equal(s.calls, 2);
  assert.equal(s.failedCount, 3);
  assert.deepEqual(s.lines, ['shared', 'extra']);
});
await test('content-block arrays and stdout meta flattened', () => {
  const events = [call(1, 'bash', { command: 'npm test' }, 'c1')];
  events.push({ seq: 2, type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: 'not ok 9 - deep\n1 failed' }] } } });
  assert.deepEqual(summarizeTestFailures(events, 0).lines, ['deep']);
});
await test('empty/garbage events tolerated', () => {
  assert.equal(summarizeTestFailures(undefined), null);
  assert.equal(summarizeTestFailures([null, {}, { type: 'x' }], 0), null);
});

console.log('formatTestFailureNotice:');
await test('count + names + overflow line', () => {
  const t = formatTestFailureNotice({ runner: 'node:test', failedCount: 9, calls: 1, lines: ['a', 'b', 'c'] }, { maxLines: 2 });
  assert.match(t, /^🧪 测试失败：9 个（node:test）/);
  assert.ok(t.includes('· a'));
  assert.ok(t.includes('另有 1 条'));
});
await test('count only (no parseable names)', () => {
  assert.equal(formatTestFailureNotice({ runner: 'go', failedCount: 3, calls: 1, lines: [] }), '🧪 测试失败：3 个（go）');
});
await test('null -> empty', () => assert.equal(formatTestFailureNotice(null), ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
