// Workspace git snapshot for the pinned status board (v0.7.2+).
//
// Why: from a phone you approve edits and answer questions, but the status
// board never said WHERE you are — which branch, how much is uncommitted,
// whether you're ahead of the remote. One line of that turns the board into a
// real coding dashboard.
//
// Contract:
//   • Best-effort and never throws. No git, no repo, a timeout, or a weird
//     locale all collapse to `null` / a partial record — the board just omits
//     the line. A status board must never break a chat.
//   • Cheap + cached. The status ticker polls every ~5 s per chat, so `git
//     status` runs at most once per cache window per cwd. Reads are also
//     de-duplicated while one is in flight.
//   • Non-interfering: `--no-optional-locks` so a read never creates or
//     refreshes `.git/index.lock` while the AGENT is mid-commit.
//
// `execFileImpl` is injected so tests (and a host without child_process) can
// supply their own runner.

import { execFile as nodeExecFile } from 'node:child_process';

// Default cache window (ms). Matches the status ticker's cadence, so the board
// stays live without spawning a git process per chat per tick.
export const GIT_CACHE_TTL_MS = 5000;
// Hard cap for one `git status`. A cold cache on a huge repo must not stall the
// ticker; on timeout we serve the previous value (or nothing).
export const GIT_TIMEOUT_MS = 3000;

/**
 * Parse `git status --porcelain=v2 --branch -uall` output.
 * Pure — exported for tests.
 *
 * @returns {{branch: string, upstream: string|null, ahead: number, behind: number,
 *            staged: number, modified: number, untracked: number,
 *            dirty: number, detached: boolean}}
 */
export function parseGitStatus(stdout) {
  const out = {
    branch: '', upstream: null, ahead: 0, behind: 0,
    staged: 0, modified: 0, untracked: 0, dirty: 0, detached: false,
  };
  const text = String(stdout ?? '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      // `(no branch)` = detached; `detached@<sha>` on some git versions.
      if (!head || head === '(detached)' || head === '(no branch)' || head.startsWith('detached@')) {
        out.detached = true;
        out.branch = head === '(detached)' || head === '(no branch)' ? '(detached)' : head;
      } else {
        out.branch = head;
      }
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim() || null;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      // `# branch.ab +A -B`  (ahead, behind)
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith('! ')) continue; // conflicted but unmerged summary noise
    // Changed entries: `1 <XY> …` (ordinary) / `2 …` (renamed) / `u …` (unmerged)
    // Untracked: `? <path>`. Everything else (the `#` header block, ignored
    // files) is skipped.
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      // XY is the second space-separated field; index side staged, worktree
      // side modified. Both counted as "dirty" either way — split only so the
      // board can say `2 staged / 5 modified` when that matters.
      const xy = line.split(' ')[1] ?? '??';
      if (xy[0] !== '.') out.staged += 1;
      if (xy[1] !== '.') out.modified += 1;
      out.dirty += 1;
    } else if (kind === 'u') {
      // Unmerged (conflict) — counts as dirty and is worth surfacing loudly.
      out.staged += 1;
      out.dirty += 1;
    } else if (kind === '?') {
      out.untracked += 1;
      out.dirty += 1;
    }
  }
  return out;
}

/**
 * One-line git summary for the status board. Returns '' when there is nothing
 * worth saying (no info, or a clean repo on a branch with nothing to report).
 * Pure — exported for tests.
 */
export function gitInfoLine(info) {
  if (!info || info.error) return '';
  const bits = [];
  bits.push(info.detached ? '(detached)' : (info.branch || '?'));
  if (info.staged) bits.push(`${info.staged} 已暂存`);
  if (info.modified) bits.push(`${info.modified} 未提交`);
  if (info.untracked) bits.push(`${info.untracked} 未跟踪`);
  if (info.ahead) bits.push(`↑${info.ahead}`);
  if (info.behind) bits.push(`↓${info.behind}`);
  // A pristine working tree still gets a line — knowing WHICH branch you're on
  // is the whole point of the board.
  return `🌿 ${bits.join(' · ')}`;
}

const GIT_ARGV = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-uall'];

function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { encoding: 'utf8', ...opts }, (err, stdout) => {
      // `git status` exits 0 inside a repo; non-zero means "not a repo" (or a
      // broken repo). Surface stdout anyway — porcelain v2 still prints the
      // branch header in some failure modes.
      resolve({ stdout: String(stdout ?? ''), failed: !!err });
    });
  });
}

/**
 * Read (cached) git info for `cwd`.
 *
 * @param {string} cwd
 * @param {{execFileImpl?: Function, cacheTtlMs?: number, timeoutMs?: number,
 *           now?: () => number, cache?: Map}} opts
 * @returns {Promise<object|null>} null when unavailable / not a repo
 */
export async function readGitInfo(cwd, opts = {}) {
  const dir = String(cwd ?? '').trim();
  if (!dir) return null;
  const {
    execFileImpl = defaultExecFile,
    cacheTtlMs = GIT_CACHE_TTL_MS,
    timeoutMs = GIT_TIMEOUT_MS,
    now = () => Date.now(),
    cache = globalThis.__dshTelegramGitCache ||= new Map(),
  } = opts;

  const hit = cache.get(dir);
  const t = now();
  if (hit && (t - hit.at) < cacheTtlMs) return hit.info; // serves stale during a slow git
  if (hit?.pending) return hit.pending; // de-dupe concurrent reads for the same cwd

  const pending = (async () => {
    try {
      const { stdout, failed } = await execFileImpl('git', GIT_ARGV, { cwd: dir, timeout: timeoutMs });
      if (!stdout || !stdout.includes('# branch.head')) {
        // Not a repo (or git missing/timed out): cache null briefly so a
        // non-repo workspace doesn't spawn git on every tick.
        cache.set(dir, { at: now(), info: null });
        return null;
      }
      const info = parseGitStatus(stdout);
      info.cwd = dir;
      if (failed) info.partial = true;
      cache.set(dir, { at: now(), info });
      return info;
    } catch {
      cache.set(dir, { at: now(), info: null });
      return null;
    } finally {
      const cur = cache.get(dir);
      if (cur?.pending === pending) cache.set(dir, { ...cur, pending: undefined });
    }
  })();

  cache.set(dir, { ...(hit || { at: 0, info: null }), pending });
  return pending;
}
