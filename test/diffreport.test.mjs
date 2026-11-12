// Unit tests for /diff's collector + formatters (src/diffreport.js).
// Run: node test/diffreport.test.mjs
import { strict as assert } from 'node:assert';
import { collectDiff, formatDiffSummary, shouldSendPatch } from '../src/diffreport.js';

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

// Fake git: answer by argv signature. Records every invocation for assertions.
function fakeGit(responses, calls = []) {
  return async (file, args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    for (const [match, out] of responses) {
      if (key.includes(match)) return { stdout: out, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

const STAT = ` src/a.js | 3 +++
 src/b.js | 1 -
 2 files changed, 3 insertions(+), 1 deletion(-)
`;
const PATCH = `diff --git a/src/a.js b/src/a.js\nindex 111..222 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n`;

console.log('collectDiff:');
await test('collects branch, stat, patch and untracked', async () => {
  const calls = [];
  const info = await collectDiff('/repo', {
    execFileImpl: fakeGit([
      ['rev-parse --show-toplevel', '/repo\n'],
      ['rev-parse --abbrev-ref HEAD', 'main\n'],
      ['rev-parse --verify', ''],
      ['--stat --summary', STAT],
      ['--no-color', PATCH],
      ['status --porcelain=v2', '# branch.head main\n? src/new.ts\n'],
    ], calls),
    tmpDir: '/tmp',
  });
  assert.equal(info.ok, true);
  assert.equal(info.branch, 'main');
  assert.equal(info.files, 2);
  assert.equal(info.insertions, 3);
  assert.equal(info.deletions, 1);
  assert.deepEqual(info.untracked, ['src/new.ts']);
  assert.match(info.patchName, /^\/tmp\/dsh-diff-/);
  // The untracked file is emitted as an addition so it is reviewable.
  assert.ok(calls.some((c) => c.includes('diff --no-index')), 'untracked must be diffed');
});
await test('not a repo -> ok:false with reason', async () => {
  const info = await collectDiff('/tmp', { execFileImpl: async () => ({ stdout: '', stderr: 'not a git repo', code: 128 }) });
  assert.equal(info.ok, false);
  assert.equal(info.reason, 'not-a-repo');
});
await test('empty cwd -> no git call', async () => {
  let n = 0;
  const info = await collectDiff('  ', { execFileImpl: async () => { n++; return { stdout: '', code: 0 }; } });
  assert.equal(info.ok, false);
  assert.equal(n, 0);
});
await test('bad ref rejected via rev-parse --verify', async () => {
  const info = await collectDiff('/repo', {
    ref: 'no-such-thing',
    execFileImpl: async (f, args) => {
      if (args.includes('--show-toplevel')) return { stdout: '/repo\n', code: 0 };
      if (args.includes('--verify')) return { stdout: '', code: 1 };
      return { stdout: '', code: 0 };
    },
  });
  assert.equal(info.ok, false);
  assert.equal(info.reason, 'bad-ref');
});
await test('--staged diffs the index', async () => {
  const calls = [];
  await collectDiff('/repo', {
    staged: true,
    execFileImpl: fakeGit([
      ['--show-toplevel', '/repo\n'],
      ['--stat', STAT],
    ], calls),
  });
  assert.ok(calls.some((c) => c.startsWith('diff --cached')), calls.join('|'));
});
await test('clean repo -> empty flag set', async () => {
  const info = await collectDiff('/repo', {
    execFileImpl: fakeGit([['--show-toplevel', '/repo\n'], ['--abbrev-ref', 'main\n']]),
  });
  assert.equal(info.empty, true);
  assert.equal(shouldSendPatch(info), false, 'no attachment for a clean tree');
});
await test('oversized patch truncated on a line boundary with a note', async () => {
  const big = '+x\n'.repeat(5000);
  const info = await collectDiff('/repo', {
    maxBytes: 1000,
    includeUntracked: false,
    execFileImpl: fakeGit([
      ['--show-toplevel', '/repo\n'],
      ['--abbrev-ref', 'main\n'],
      ['--no-color', big],
    ]),
  });
  assert.equal(info.truncated, true);
  assert.ok(Buffer.byteLength(info.patch) < 1400, 'stays bounded');
  assert.match(info.patch, /diff 被截断/);
});

console.log('formatDiffSummary:');
await test('summary counts + per-file lines', () => {
  const t = formatDiffSummary({ ok: true, branch: 'main', target: 'HEAD', files: 2, insertions: 3, deletions: 1, untracked: [], stat: STAT, cwd: '/repo' });
  assert.match(t, /^🔀 main ↔ HEAD/);
  assert.ok(t.includes('2 个文件'), t);
  assert.ok(t.includes('src/a.js'));
});
await test('clean tree reads as clean', () => {
  const t = formatDiffSummary({ ok: true, branch: 'main', target: 'HEAD', empty: true, untracked: [], cwd: '/r' });
  assert.match(t, /工作区干净/);
});
await test('not-a-repo explained', () => {
  assert.match(formatDiffSummary({ ok: false, reason: 'not-a-repo', cwd: '/x' }), /不是 git 仓库/);
});
await test('long stat list capped with an omitted prefix line', () => {
  const stat = Array.from({ length: 30 }, (_, i) => ` f${i} | 1 +`).join('\n') + '\n30 files changed';
  const t = formatDiffSummary({ ok: true, branch: 'b', target: 'HEAD', files: 30, stat, untracked: [], cwd: '/r' }, { maxStatLines: 5 });
  assert.ok(t.includes('省略'), t);
  assert.equal(t.split('\n').filter((l) => l.includes(' | ')).length, 5);
});
await test('null-safe', () => assert.equal(formatDiffSummary(null), ''));

console.log('shouldSendPatch:');
await test('real hunks yes, empty/whitespace no', () => {
  assert.equal(shouldSendPatch({ ok: true, patch: PATCH }), true);
  assert.equal(shouldSendPatch({ ok: true, patch: '   \n\n' }), false);
  assert.equal(shouldSendPatch({ ok: true, patch: '' }), false);
  assert.equal(shouldSendPatch(null), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
