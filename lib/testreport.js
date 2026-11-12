// Test-failure detection for the Telegram reply path (v0.7.2+).
//
// Why: on a phone you cannot watch a terminal. A turn that ends with "done, but
// 3 tests fail" reads like success unless the model happens to quote the
// failures, so a red suite goes unnoticed until the next commit. This scans the
// turn's tool calls for TEST RUNS (npm test, pytest, jest, cargo test, go test,
// runtests, ...) and, when one failed, extracts the short failing-test list so
// the plugin can push one loud `🧪 测试失败` message after the reply.
//
// Pure + dependency-free: it only reads session events (`tool/call` +
// `tool/result`) and text. Never throws; anything unrecognized returns null.

// A tool call is a test run when it is a shell-ish tool whose command matches a
// known test-runner invocation. `description` is scanned too because a tool call
// may run `npm test` from a wrapper script whose intent only shows there.
const TEST_RUNNER_RE = new RegExp([
  '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b',
  '\\bnpx\\s+(jest|vitest|mocha|playwright|pytest)\\b',
  '\\b(node|deno|bun)(\\s+-\\S+)*\\s+test\\b',
  '\\b(jest|vitest|mocha|playwright\\s+test|ava)\\b',
  '\\bpytest\\b', '\\bpy\\.test\\b', '\\bruntests\\b', '\\brunperf\\b',
  '\\bcargo\\s+test\\b', '\\bgo\\s+test\\b', '\\bmake\\s+test\\b',
  '\\bctest\\b', '\\bmeson\\s+test\\b', '\\bprove\\b',
  '\\b(mvn|gradle|gradlew)\\b.*\\btest\\b',
  '\\bdotnet\\s+test\\b', '\\brspec\\b', '\\bbundle\\s+exec\\s+(rake\\s+)?test',
].join('|'), 'i');

// Shell tools whose `command` argument carries the invocation.
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'terminal', 'run_command']);

// Failure markers per ecosystem, each with a count capture. Ordered: the first
// pattern that yields a count wins, but we keep scanning for a detail block.
const FAILURE_COUNT_RES = [
  { runner: 'node:test', re: /# fail\s+(\d+)/i },
  // Custom runners that print a plain "N passed, M failed" summary (this repo's
  // own test/*.test.mjs, and many hand-rolled ones).
  { runner: 'summary', re: /(\d+)\s+passed,\s+(\d+)\s+failed/i, group: 2 },
  { runner: 'jest', re: /Tests:\s+.*?(\d+)\s+failed/i },
  { runner: 'vitest', re: /(\d+)\s+failed\b[^\n]*\btests?\b/i },
  { runner: 'pytest', re: /=+\s*(?:.*?\b(\d+)\s+(?:failed|errors?).*=+|.*failed.*)\s*$/m, alt: /(\d+)\s+failed/ },
  { runner: 'cargo', re: /test result:\s*FAILED[.\s]*(\d+)\s+failed/i },
  { runner: 'go', re: /^FAIL\b/m },
  { runner: 'generic', re: /(\d+)\s+(?:tests?|assertions?)\s+failed/i },
  // Bare trailing counters: mocha's `1 failing`, vitest/jest tails `2 failed`.
  { runner: 'generic', re: /(\d+)\s+(?:failed|failing)\b/i },
];

// Lines worth showing from a failing run: names, not the whole log.
const FAILURE_LINE_RES = [
  /^\s*(?:not ok|✕|×|✗|FAIL|FAILED|✘|❌)\s+\d*\s*[-–:]?\s*(.+)$/i, // node:test, jest, pytest, cargo
  /^\s*(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/,                  // pytest short summary
  /^\s*-\s+(.+(?:test|spec|it)\b.*)$/i,                             // vitest `- name` list
  /^(\S+\.test\.[jt]sx?)\s*$/i,                                     // bare failing file
];

function flattenToolResult(result) {
  // tool/result carries `message.content`, which is either a string or a list
  // of content blocks; some tools also expose `meta.stdout`. Accept all.
  const c = result?.content ?? result?.message?.content ?? result;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  }
  if (c && typeof c === 'object') {
    const parts = [c.stdout, c.stderr, c.text, c.output];
    return parts.filter((p) => typeof p === 'string').join('\n');
  }
  return '';
}

/**
 * Does this tool call look like a test run?
 * @param {string} name tool name
 * @param {object|string} args tool arguments (object or JSON string)
 */
export function isTestRun(name, args) {
  const n = String(name || '').toLowerCase();
  let text = '';
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    text = [args.command, args.cmd, args.script, args.description]
      .filter((v) => typeof v === 'string').join('\n');
  } else if (typeof args === 'string') text = args;
  if (!text) return false;
  // A test-runner word inside a `description` alone is NOT enough (the model
  // writes "Run the full test suite" for a build too) — require the command.
  const command = (args && typeof args === 'object')
    ? [args.command, args.cmd, args.script].filter((v) => typeof v === 'string').join('\n')
    : text;
  if (SHELL_TOOLS.has(n) || n.includes('shell') || n.includes('exec')) {
    return TEST_RUNNER_RE.test(command || text);
  }
  // Non-shell tools (e.g. a matlab runtests tool) match on the name itself.
  return /\b(runtests|test)\b/i.test(n) && TEST_RUNNER_RE.test(`${n}\n${text}`);
}

/**
 * Extract a failure report from one tool result's text.
 * @returns {null|{runner: string, failedCount: number|null, lines: string[]}}
 */
export function parseTestFailure(text, opts = {}) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  const maxLines = opts.maxLines ?? 6;

  let runner = null;
  let failedCount = null;
  for (const spec of FAILURE_COUNT_RES) {
    const m = spec.re.exec(body);
    if (!m) continue;
    const raw = spec.group ? m[spec.group] : m[1];
    const n = Number(raw);
    // `go test` prints FAIL without a count; count the FAIL lines instead.
    const count = Number.isFinite(n) ? n
      : (body.match(/^FAIL\b/gm) || []).length;
    if (count > 0) { runner = spec.runner; failedCount = count; break; }
  }

  const lines = [];
  const seen = new Set();
  for (const raw of body.split('\n')) {
    for (const re of FAILURE_LINE_RES) {
      const m = re.exec(raw);
      if (!m) continue;
      const label = [m[1], m[2]].filter(Boolean).join(' — ').trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      lines.push(label.length > 120 ? `${label.slice(0, 119)}…` : label);
      break;
    }
    if (lines.length >= maxLines) break;
  }

  // A run can report a count with no parseable names (custom reporters). Keep it
  // then too — the count alone is still the news. But a text with neither a
  // count nor any failing line is not a failure report.
  if (!runner && !lines.length) return null;
  if (!runner && lines.length) return { runner: 'generic', failedCount: null, lines };
  if (runner && !lines.length && !failedCount) return null;
  return { runner, failedCount, lines };
}

/**
 * Scan a turn's session events for failed test runs.
 * @param {Array} events session events (`sessionEvents(session)`)
 * @param {number} baseline only events after this seq belong to the turn
 * @returns {null|{runner: string, failedCount: number|null, calls: number, lines: string[]}}
 */
export function summarizeTestFailures(events, baseline = 0, opts = {}) {
  if (!Array.isArray(events) || !events.length) return null;
  const maxLines = opts.maxLines ?? 6;
  // callId → the test-run tool name, so results can be matched back.
  const runIds = new Map();
  const reports = [];
  for (let i = Math.max(0, baseline); i < events.length; i++) {
    const evt = events[i];
    if (!evt || typeof evt.type !== 'string') continue;
    if (evt.type === 'tool/call') {
      const d = evt.data || {};
      if (isTestRun(d.name, d.arguments ?? d.args)) runIds.set(String(d.callId ?? `seq:${evt.seq}`), d.name);
      continue;
    }
    if (evt.type !== 'tool/result') continue;
    const d = evt.data || {};
    const isRun = runIds.has(String(d.callId ?? ''));
    const text = flattenToolResult(d.message ?? d);
    if (!isRun) continue;
    // An errored tool result (exit != 0) is the strongest signal; a runner that
    // exits 0 on failures (pytest does not, jest sometimes piped) is caught by
    // the text patterns.
    const report = parseTestFailure(text, { maxLines });
    if (report || d.isError === true || d.message?.isError === true) {
      reports.push(report || { runner: 'generic', failedCount: null, lines: [] });
    }
  }
  if (!reports.length) return null;
  const merged = {
    runner: reports[0].runner,
    failedCount: reports.reduce((sum, r) => (r.failedCount ? sum + r.failedCount : sum), 0) || null,
    calls: reports.length,
    lines: [],
  };
  const seen = new Set();
  for (const r of reports) {
    for (const l of r.lines) {
      if (seen.has(l) || merged.lines.length >= maxLines) continue;
      seen.add(l); merged.lines.push(l);
    }
  }
  return merged;
}

/** Render the pushed notice (plain text; caller HTML-escapes). */
export function formatTestFailureNotice(summary, opts = {}) {
  if (!summary) return '';
  const maxLines = opts.maxLines ?? 6;
  const head = summary.failedCount
    ? `🧪 测试失败：${summary.failedCount} 个（${summary.runner}${summary.calls > 1 ? `，${summary.calls} 次运行` : ''}）`
    : `🧪 测试未通过（${summary.runner}）`;
  const lines = summary.lines.slice(0, maxLines);
  const out = [head];
  if (lines.length) out.push(lines.map((l) => `· ${l}`).join('\n'));
  const hidden = summary.lines.length - lines.length;
  if (hidden > 0) out.push(`… 另有 ${hidden} 条`);
  return out.join('\n');
}
