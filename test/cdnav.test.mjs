// Unit tests for the /cd browse card + recent-directory MRU (v0.7.6).
// Run: node test/cdnav.test.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCdCallback, cdCallbackData, pickSubdirs, rememberRecent, buildCdCard,
  createCdNavModule, createRecentStore, CALLBACK_PREFIX, RECENT_LIMIT,
} from '../src/cdnav.js';

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      passed++; console.log(`  ok    ${name}`);
    } catch (e) {
      failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
    }
  };
  pending.push(run());
}
async function finish() {
  await Promise.all(pending);
  console.log(`\ncdnav: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---- pure helpers ---------------------------------------------------------

test('parseCdCallback accepts our namespace only', () => {
  assert.deepEqual(parseCdCallback(`${CALLBACK_PREFIX}abcd1234:g:3`), { token: 'abcd1234', action: 'g', index: 3 });
  assert.deepEqual(parseCdCallback(`${CALLBACK_PREFIX}abcd1234:c`), { token: 'abcd1234', action: 'c', index: -1 });
  for (const a of ['u', 'h', 's', 'x']) {
    assert.equal(parseCdCallback(`${CALLBACK_PREFIX}t:${a}`).action, a);
  }
  assert.equal(parseCdCallback('tgapv2:a:1'), null);   // approval card
  assert.equal(parseCdCallback('tgcd:t:zzz'), null);   // unknown action
  assert.equal(parseCdCallback('tgcd:t:g:9999'), null); // index out of range
  assert.equal(parseCdCallback('tgcd::c'), null);
  assert.equal(parseCdCallback(undefined), null);
});

test('callback_data stays inside Telegram\'s 64-byte cap', () => {
  const d = cdCallbackData('abcd1234', 'g', 42);
  assert.ok(Buffer.byteLength(d, 'utf8') <= 64, d);
});

test('pickSubdirs: dirs only, dotfiles hidden, sorted, capped', () => {
  const d = (name, dir = true) => ({ name, isDirectory: () => dir });
  assert.deepEqual(pickSubdirs([d('b'), d('a'), d('.git'), d('f.txt', false), null]), ['a', 'b']);
  assert.deepEqual(pickSubdirs([]), []);
  assert.equal(pickSubdirs(Array.from({ length: 50 }, (_, i) => d(`d${i}`)), 30).length, 30);
  // numeric-aware so src2 sorts before src10
  assert.deepEqual(pickSubdirs([d('src10'), d('src2')]), ['src2', 'src10']);
});

test('rememberRecent: MRU order, dedup, blank ignored, limit', () => {
  assert.deepEqual(rememberRecent([], '/a'), ['/a']);
  assert.deepEqual(rememberRecent(['/a', '/b'], '/a'), ['/a', '/b']);
  assert.deepEqual(rememberRecent(['/a', '/b'], '/c'), ['/c', '/a', '/b']);
  assert.deepEqual(rememberRecent(['/a'], ''), ['/a']);
  assert.deepEqual(rememberRecent(null, '/a'), ['/a']);
  const many = Array.from({ length: 40 }, (_, i) => `/p${i}`);
  assert.equal(rememberRecent(many, '/x').length, RECENT_LIMIT);
  assert.equal(rememberRecent(many, '/x')[0], '/x');
});

test('buildCdCard: recent rows then subdir rows, nav + commit row', () => {
  const recents = ['/home/u/alpha', '/srv/alpha'];   // same basename → both labelled with parent
  const entries = [{ label: 'src', path: '/home/u/alpha/src' }];
  const { text, keyboard } = buildCdCard({
    root: '/home/u/alpha', sessionCwd: '/home/u/alpha', recents, entries,
    canCommit: true, token: 't1', escape: (s) => s,
  });
  assert.match(text, /\/home\/u\/alpha/);
  assert.equal(keyboard[0][0].text, '1️⃣ u/alpha');
  assert.equal(keyboard[1][0].text, '2️⃣ srv/alpha');
  // entry index accounts for the recents block, so a tap resolves the right path
  assert.equal(keyboard[2][0].callback_data, `${CALLBACK_PREFIX}t1:g:2`);
  const flat = keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.some((c) => c.endsWith(':u')) && flat.some((c) => c.endsWith(':h')));
  assert.ok(flat.some((c) => c.endsWith(':c')) && flat.some((c) => c.endsWith(':x')));
  // no 📍 row while already sitting on the session directory
  assert.ok(!flat.some((c) => c.endsWith(':s')));
});

test('buildCdCard: 📍 appears off-session, no commit row without a service', () => {
  const { text, keyboard } = buildCdCard({
    root: '/tmp', sessionCwd: '/home/u/x', recents: [], entries: [],
    canCommit: false, token: 't2', escape: (s) => s,
  });
  assert.match(text, /（无子目录）/);
  const flat = keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.some((c) => c.endsWith(':s')));
  assert.ok(!flat.some((c) => c.endsWith(':c')));
});

// ---- module flow ----------------------------------------------------------

function makeFixture(overrides = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cdnav-'));
  mkdirSync(join(base, 'src'), { recursive: true });
  mkdirSync(join(base, 'docs'), { recursive: true });
  writeFileSync(join(base, 'README.md'), 'x');

  const sent = [], edits = [], acks = [], deleted = [];
  const client = {
    sendMessage: async (o) => { sent.push(o); return { messageId: 900 + sent.length, chatId: o.chatId }; },
    editMessageText: async (chatId, mid, text, pm, markup) => { edits.push({ chatId, mid, text, markup }); return true; },
    deleteMessage: async (chatId, mid) => { deleted.push({ chatId, mid }); return true; },
    answerCallbackQuery: async (id, text) => { acks.push({ id, text }); return true; },
  };
  const agent = { id: 'a1', session: { id: 'telegram-1', header: { cwd: base } } };
  const committed = [];
  const mod = createCdNavModule({
    client,
    home: () => '/home/tester',
    escape: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    resolveAgent: () => agent,
    effectiveCwd: () => overrides.cwd ?? base,
    setCwd: async (_a, p) => { if (!p) throw new Error('empty'); committed.push(p); return p; },
    recents: () => overrides.recents ?? [],
    ...overrides.deps,
  });
  return { base, mod, client, sent, edits, acks, deleted, committed, agent };
}

const callbackFrom = (data, chatId = '42') => ({ id: 'q1', data, message: { chat: { id: chatId } } });
const tokenOf = (sentMsg) => {
  const m = /tgcd:([0-9a-f]+):/.exec(sentMsg.replyMarkup.inline_keyboard.flat()[0].callback_data);
  return m[1];
};

test('openCard posts a browse card for the session cwd (browsing does not switch)', async () => {
  const f = makeFixture();
  await f.mod.openCard('b', '42', f.base);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].parseMode, 'HTML');
  assert.match(f.sent[0].text, /README|src|docs|当前/);
  assert.equal(f.committed.length, 0, 'opening a card must never change the cwd');
  const labels = f.sent[0].replyMarkup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.includes('src')) && labels.some((l) => l.includes('docs')));
});

test('tapping a subdirectory repaints the same card one level down', async () => {
  const f = makeFixture();
  await f.mod.openCard('b', '42', f.base);
  const token = tokenOf(f.sent[0]);
  const srcBtn = f.sent[0].replyMarkup.inline_keyboard.flat().find((b) => b.text.includes('src'));
  assert.equal(await f.mod.handleCallbackQuery('b', callbackFrom(srcBtn.callback_data)), true);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].mid, 901, 'the card is edited in place, not re-sent');
  assert.equal(f.sent.length, 1);
  assert.match(f.edits[0].text, new RegExp(`${f.base}/src`.replace(/[/\\]/g, '[/\\\\]')));
  assert.equal(f.committed.length, 0);
  assert.equal(f.acks.length, 1);
});

test('✅ commits the browsed root, ✖️ closes without committing', async () => {
  const f = makeFixture();
  await f.mod.openCard('b', '42', f.base);
  const t1 = tokenOf(f.sent[0]);
  const srcBtn = f.sent[0].replyMarkup.inline_keyboard.flat().find((b) => b.text.includes('src'));
  await f.mod.handleCallbackQuery('b', callbackFrom(srcBtn.callback_data));
  const commitBtn = f.edits[0].markup.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':c'));
  await f.mod.handleCallbackQuery('b', callbackFrom(commitBtn.callback_data));
  assert.deepEqual(f.committed, [join(f.base, 'src')]);
  assert.match(f.edits[1].text, /已切换工作目录/);
  assert.equal(f.edits[1].markup, undefined, 'committed card drops the keyboard');
  // the new token is spent — a replay is acked as expired, not executed
  const before = f.committed.length;
  await f.mod.handleCallbackQuery('b', callbackFrom(commitBtn.callback_data));
  assert.equal(f.committed.length, before);
  assert.match(f.acks.at(-1).text, /过期/);

  await f.mod.openCard('b', '42', f.base);
  const t2 = tokenOf(f.sent.at(-1));
  const closeBtn = `${CALLBACK_PREFIX}${t2}:x`;
  await f.mod.handleCallbackQuery('b', callbackFrom(closeBtn));
  assert.deepEqual(f.deleted, [{ chatId: '42', mid: 902 }]);
  assert.equal(f.committed.length, 1, 'closing must not commit');
  void t1;
});

test('⬆️ / 🏠 / 📍 navigate; a tap from another chat is refused', async () => {
  const f = makeFixture();
  await f.mod.openCard('b', '42', f.base);
  const upBtn = f.sent[0].replyMarkup.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':u'));
  await f.mod.handleCallbackQuery('b', callbackFrom(upBtn.callback_data));
  // The repaint issues a FRESH token; a tap carrying it from another chat must
  // be refused, and must not repaint the card.
  const liveToken = tokenOf({ replyMarkup: f.edits[0].markup });
  const homeBtn = f.edits[0].markup.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':h'));
  assert.equal(await f.mod.handleCallbackQuery('b', callbackFrom(homeBtn.callback_data, '99')), true);
  assert.match(f.acks.at(-1).text, /原会话/);
  assert.equal(f.edits.length, 1, 'a cross-chat tap must not repaint the card');
  void liveToken;

  await f.mod.handleCallbackQuery('b', callbackFrom(homeBtn.callback_data));
  assert.match(f.edits.at(-1).text, /\/home\/tester/);

  const backBtn = f.edits.at(-1).markup.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':s'));
  assert.ok(backBtn, '📍 shows while off the session dir');
  await f.mod.handleCallbackQuery('b', callbackFrom(backBtn.callback_data));
  assert.match(f.edits.at(-1).text, new RegExp(f.base.replace(/[/\\]/g, '[/\\\\]')));
});

test('unknown + expired tokens are acked, foreign callback_data ignored', async () => {
  const f = makeFixture();
  assert.equal(await f.mod.handleCallbackQuery('b', callbackFrom('tgapv2:a:xyz')), false, 'must not swallow approval taps');
  assert.equal(f.acks.length, 0);
  assert.equal(await f.mod.handleCallbackQuery('b', callbackFrom(`${CALLBACK_PREFIX}deadbeef:c`)), true);
  assert.match(f.acks.at(-1).text, /过期/);
});

test('a failing setCwd surfaces as a toast and keeps the card usable', async () => {
  const f = makeFixture({ deps: { setCwd: async () => { throw new Error('目标目录不存在'); } } });
  await f.mod.openCard('b', '42', f.base);
  const cBtn = f.sent[0].replyMarkup.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':c'));
  await f.mod.handleCallbackQuery('b', callbackFrom(cBtn.callback_data));
  assert.match(f.acks.at(-1).text, /目标目录不存在/);
  assert.equal(f.edits.length, 0);
});

// ---- persistent MRU store -------------------------------------------------

test('recent store persists, dedupes to MRU and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdrecent-'));
  const file = join(dir, 'telegram-cd-recent.json');
  const s = createRecentStore(file);
  assert.deepEqual(s.list(), []);
  s.remember('/a'); s.remember('/b'); s.remember('/a');
  assert.deepEqual(s.list(), ['/a', '/b']);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(raw.recent, ['/a', '/b']);
  assert.deepEqual(createRecentStore(file).list(), ['/a', '/b']);
  s.remember('  ');
  assert.deepEqual(s.list(), ['/a', '/b']);
  rmSync(dir, { recursive: true, force: true });
});

test('recent store tolerates a missing / corrupt file and caps at RECENT_LIMIT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdrecent-'));
  const missing = join(dir, 'nope', 'r.json');
  const s = createRecentStore(missing);
  assert.deepEqual(s.list(), []);
  s.remember('/x');
  assert.ok(JSON.parse(readFileSync(missing, 'utf8')).recent.includes('/x'), 'creates parent dirs');
  writeFileSync(missing, '{ not json');
  assert.deepEqual(createRecentStore(missing).list(), []);
  const s2 = createRecentStore(join(dir, 'cap.json'));
  for (let i = 0; i < 40; i++) s2.remember(`/p${i}`);
  assert.equal(s2.list().length, RECENT_LIMIT);
  assert.equal(s2.list()[0], '/p39');
  rmSync(dir, { recursive: true, force: true });
});

void finish();

