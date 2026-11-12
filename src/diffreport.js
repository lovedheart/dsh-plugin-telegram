// Workspace diff report for the Telegram `/diff` command (v0.7.2+).
//
// Why: the point of coding from a phone is reviewing what the agent changed,
// and a prose "I updated 3 files" is not reviewable. This collects the same
// information `git status` + `git diff` give on a terminal, and hands back a
// short summary plus a real patch the caller uploads as a Telegram document.
//
// Contract:
//   • Never throws. No git / no repo / a timeout all collapse to `{ ok: false }`
//     with a reason the command can show verbatim.
//   • No shell: everything goes through execFile with an argv array, so a
//     user-supplied ref can never inject a command line. The ref is still
//     verified with `git rev-parse --verify` first.
//   • Bounded: `maxBytes` caps the patch (the summary always survives), and a
//     truncated patch says so — a silently cut diff is worse than no diff.
//   • Untracked files are included (`git diff --no-index /dev/null <path>`),
//     otherwise brand-new files — the ones most worth reviewing — vanish.

import { execFile as nodeExecFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Default patch cap (bytes). Telegram allows far more, but a multi-MB patch is
// unreadable on a phone and usually means the wrong thing was diffed.
export const DEFAULT_MAX_PATCH_BYTES = 900_000;
// Per-git-call ceiling. A cold `git diff` on a huge repo must not hang the bot.
export const GIT_TIMEOUT_MS = 10_000;

function runImpl(file, args, opts = {}) {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        // git diff exits 1 when there ARE differences (and 128 for a bad ref),
        // so `err` alone never means failure. Callers look at stdout + code.
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        });
      });
  });
}

/**
 * Collect a reviewable diff for `cwd`.
 *
 * @param {string} cwd workspace directory (the agent's session cwd)
 * @param {{ref?: string, staged?: boolean, includeUntracked?: boolean,
 *           execFileImpl?: Function, maxBytes?: number, timeoutMs?: number,
 *           tmpDir?: string}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, cwd: string, branch?: string,
 *           target?: string, stat?: string, files?: number, insertions?: number,
 *           deletions?: number, untracked?: string[], patch?: string,
 *           truncated?: boolean, statOnly?: boolean}>}
 */
export async function collectDiff(cwd, opts = {}) {
  const dir = String(cwd ?? '').trim();
  if (!dir) return { ok: false, reason: 'no-cwd', cwd: dir };
  const {
    execFileImpl = runImpl,
    maxBytes = DEFAULT_MAX_PATCH_BYTES,
    timeoutMs = GIT_TIMEOUT_MS,
    tmpDir = tmpdir(),
    includeUntracked = true,
  } = opts;
  const git = (args) => execFileImpl('git', args, { cwd: dir, timeout: timeoutMs });

  const root = await git(['rev-parse', '--show-toplevel']);
  if (root.code !== 0 || !root.stdout.trim()) {
    return { ok: false, reason: 'not-a-repo', cwd: dir };
  }
  // Resolve the diff target: an explicit ref (verified), or HEAD (working tree
  // vs last commit), or the index for --staged.
  const wanted = String(opts.ref ?? '').trim();
  let target = 'HEAD';
  if (opts.staged) target = '--cached';
  else if (wanted) {
    const check = await git(['rev-parse', '--verify', '--quiet', wanted]);
    if (check.code !== 0) return { ok: false, reason: 'bad-ref', cwd: dir, target: wanted };
    target = wanted;
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || '?';
  const diffArgs = target === '--cached'
    ? ['diff', '--cached']
    : ['diff', target];

  const [statRes, patchRes, statusRes] = await Promise.all([
    git([...diffArgs, '--stat', '--summary']),
    git([...diffArgs, '--no-color']),
    // porcelain v2 with untracked files: what a plain `git diff` cannot show.
    git(['--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all']),
  ]);

  const untracked = [];
  for (const line of String(statusRes.stdout ?? '').split('\n')) {
    if (line.startsWith('? ')) untracked.push(line.slice(2).trim());
    else if (line.startsWith('! ')) continue;
  }

  let patch = String(patchRes.stdout ?? '');
  let truncated = false;

  // Untracked files: emit each as a whole-file addition. `--no-index` is the
  // only way to diff something git isn't tracking, and it exits 1 on success
  // (differences found), so the exit code is ignored here.
  if (includeUntracked && untracked.length && !opts.staged) {
    const parts = [patch];
    for (const file of untracked.slice(0, 200)) {
      const extra = await git(['diff', '--no-index', '--no-color', '--', '/dev/null', file]);
      const body = String(extra.stdout ?? '');
      if (body) parts.push(body);
    }
    patch = parts.filter(Boolean).join('\n');
  }

  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes > maxBytes) {
    // Cut on a line boundary so the patch stays syntactically parseable.
    let cut = patch.lastIndexOf('\n', maxBytes);
    if (cut <= 0) cut = maxBytes;
    patch = patch.slice(0, cut)
      + `\n\n… diff 被截断（共 ${Math.round(bytes / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB）`
      + '：请在电脑上用 git 查看完整改动。\n';
    truncated = true;
  }

  const stat = String(statRes.stdout ?? '').trim();
  const summary = String(statRes.stdout ?? '').split('\n').filter(Boolean).pop() || '';
  const counts = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(summary);

  return {
    ok: true,
    cwd: dir,
    root: root.stdout.trim(),
    branch,
    target: opts.staged ? 'staged' : (wanted || 'HEAD'),
    stat,
    patch,
    files: counts ? Number(counts[1]) : (stat ? stat.split('\n').length : 0),
    insertions: counts ? Number(counts[2] || 0) : 0,
    deletions: counts ? Number(counts[3] || 0) : 0,
    untracked,
    truncated,
    empty: !patch.trim(),
    // Suggested filename for the uploaded patch.
    patchName: join(tmpDir, `dsh-diff-${randomUUID().slice(0, 8)}.patch`),
  };
}

/**
 * Plain-text summary shown as the `/diff` reply (the caller HTML-escapes it).
 * Pure — exported for tests.
 */
export function formatDiffSummary(info, opts = {}) {
  if (!info) return '';
  if (!info.ok) {
    if (info.reason === 'not-a-repo') return `🔀 ${info.cwd || '当前工作目录'} 不是 git 仓库，没有 diff 可看。`;
    if (info.reason === 'bad-ref') return `🔀 找不到引用 <${info.target}>。用 /diff <分支|提交> 指定一个存在的引用。`;
    return '🔀 无法读取 git 状态。';
  }
  const head = `🔀 ${info.branch} ↔ ${info.target}`;
  if (info.empty && !info.untracked.length) return `${head}\n工作区干净，没有未提交的改动。`;
  const bits = [];
  if (info.files) bits.push(`${info.files} 个文件`);
  if (info.insertions) bits.push(`+${info.insertions}`);
  if (info.deletions) bits.push(`−${info.deletions}`);
  if (info.untracked.length) bits.push(`${info.untracked.length} 个未跟踪新文件`);
  const lines = [head, bits.length ? bits.join(' · ') : '（无统计行）'];
  // Per-file lines: the most useful part on a phone, so keep the tail (newest
  // hunks) only when the stat list is long.
  const statLines = (info.stat || '').split('\n').filter((l) => l && !/changed/.test(l));
  const cap = opts.maxStatLines ?? 15;
  if (statLines.length) {
    const shown = statLines.slice(-cap);
    if (statLines.length > shown.length) lines.push(`… 前 ${statLines.length - shown.length} 项省略`);
    lines.push(...shown);
  }
  if (info.truncated) lines.push('⚠️ patch 附件被截断，完整改动请在电脑上 git diff。');
  return lines.join('\n');
}

/**
 * Does this diff warrant a patch attachment? An empty diff does not, and a
 * whitespace-only patch would just be noise in the chat.
 */
export function shouldSendPatch(info) {
  return !!(info && info.ok && info.patch && info.patch.trim() && /\+\+\+|^diff /m.test(info.patch));
}
