// Unit tests for the workspace git snapshot behind the status board's 🌿 line.
// Run: node test/gitinfo.test.mjs
import { strict as assert } from 'node:assert';
import { parseGitStatus, gitInfoLine, readGitInfo } from '../src/gitinfo.js';

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

const CLEAN = `# branch.oid 1a2b3c4
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
`;

const DIRTY = `# branch.head feature/x
# branch.upstream origin/feature/x
# branch.ab +2 -1
1 M. N... 100644 100644 100644 aaa bbb src/a.js
1 .M N... 100644 100644 100644 ccc ddd src/b.js
1 A. N... 100644 100644 100644 000 eee src/c.js
? docs/new.md
`;

console.log('parseGitStatus:');
await test('clean repo: branch + zero counts', () => {
  const i = parseGitStatus(CLEAN);
  assert.equal(i.branch, 'main');
  assert.equal(i.upstream, 'origin/main');
  assert.equal(i.ahead, 0); assert.equal(i.behind, 0);
  assert.equal(i.dirty, 0);
  assert.equal(i.detached, false);
});
await test('dirty repo: staged vs modified split + untracked', () => {
  const i = parseGitStatus(DIRTY);
  assert.equal(i.branch, 'feature/x');
  assert.equal(i.ahead, 2); assert.equal(i.behind, 1);
  assert.equal(i.staged, 2, 'M. and A. are staged');
  assert.equal(i.modified, 1, '.M is a worktree change');
  assert.equal(i.untracked, 1);
  assert.equal(i.dirty, 4, 'each changed entry counts once');
});
await test('detached HEAD flagged', () => {
  const i = parseGitStatus('# branch.head (no branch)\n# branch.oid abc\n1 .M N... 100644 100644 100644 a b f\n');
  assert.equal(i.detached, true);
  assert.equal(i.branch, '(detached)', 'git\'s "(no branch)" normalized');
  assert.equal(i.dirty, 1);
});
await test('unmerged (conflict) entry counts as dirty', () => {
  const i = parseGitStatus('# branch.head main\nu UU N... 100644 100644 100644 100644 a b c f\n');
  assert.equal(i.dirty, 1);
  assert.equal(i.staged, 1);
});
await test('empty/garbage input tolerated', () => {
  assert.equal(parseGitStatus('').dirty, 0);
  assert.equal(parseGitStatus(undefined).branch, '');
});

console.log('gitInfoLine:');
await test('clean branch still renders (that is the point)', () => {
  assert.equal(gitInfoLine(parseGitStatus(CLEAN)), '🌿 main');
});
await test('dirty + ahead/behind summarized', () => {
  const line = gitInfoLine(parseGitStatus(DIRTY));
  assert.equal(line, '🌿 feature/x · 2 已暂存 · 1 未提交 · 1 未跟踪 · ↑2 · ↓1');
});
await test('null / error -> empty line', () => {
  assert.equal(gitInfoLine(null), '');
  assert.equal(gitInfoLine({ error: true }), '');
});

console.log('readGitInfo (cached, injected runner):');
const mkExec = (stdout, calls) => async (file, args, opts) => {
  calls.n += 1;
  assert.equal(file, 'git');
  assert.ok(args.includes('--no-optional-locks'), 'must not race the agent on index.lock');
  assert.ok(args.includes('--porcelain=v2'));
  assert.ok(typeof opts.cwd === 'string' && opts.cwd.length);
  return { stdout, failed: false };
};
await test('parses git output and caches per cwd', async () => {
  const calls = { n: 0 };
  const cache = new Map();
  const now = { t: 0 };
  const a = await readGitInfo('/repo', { execFileImpl: mkExec(DIRTY, calls), cache, now: () => now.t });
  assert.equal(a.branch, 'feature/x');
  assert.equal(calls.n, 1);
  // second read inside the TTL window: served from cache, no new process
  const b = await readGitInfo('/repo', { execFileImpl: mkExec(DIRTY, calls), cache, now: () => now.t });
  assert.equal(b.branch, 'feature/x');
  assert.equal(calls.n, 1, 'cache hit must not spawn git');
  // after the TTL it refreshes
  now.t += 60_000;
  await readGitInfo('/repo', { execFileImpl: mkExec(DIRTY, calls), cache, now: () => now.t });
  assert.equal(calls.n, 2);
});
await test('not a repo -> null, cached (no git storm)', async () => {
  const calls = { n: 0 };
  const cache = new Map();
  const opts = { execFileImpl: mkExec('', calls), cache, now: () => 0 };
  assert.equal(await readGitInfo('/tmp', opts), null);
  assert.equal(await readGitInfo('/tmp', opts), null);
  assert.equal(calls.n, 1, 'non-repo result is cached too');
});
await test('empty cwd -> null without spawning git', async () => {
  const calls = { n: 0 };
  assert.equal(await readGitInfo('  ', { execFileImpl: mkExec('', calls) }), null);
  assert.equal(calls.n, 0);
});
await test('runner throwing is swallowed -> null', async () => {
  const cache = new Map();
  const info = await readGitInfo('/repo', {
    execFileImpl: async () => { throw new Error('git not found'); }, cache, now: () => 0,
  });
  assert.equal(info, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
