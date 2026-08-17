// Unit tests for the real error-classification helper in src/client.js.
// Run: node test/client.test.mjs
import { strict as assert } from 'node:assert';
import { TelegramApiError, TelegramRateLimitError, isTransientTelegramError, TelegramClient } from '../src/client.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

function fetchFailed(cause) {
  const e = new TypeError('fetch failed');
  e.cause = cause;
  return e;
}
function netError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  e.syscall = 'read';
  return e;
}

console.log('isTransientTelegramError:');
test('429 rate limit -> transient', () => {
  assert.equal(isTransientTelegramError(new TelegramRateLimitError(3)), true);
});
test('429 API error -> transient', () => {
  assert.equal(isTransientTelegramError(new TelegramApiError('TL', '', 429, 429)), true);
});
test('409 conflict -> transient', () => {
  assert.equal(isTransientTelegramError(new TelegramApiError('conflict', '', 409, 409)), true);
});
test('502/503 -> transient', () => {
  assert.equal(isTransientTelegramError(new TelegramApiError('bad gateway', '', 502, 502)), true);
  assert.equal(isTransientTelegramError(new TelegramApiError('unavailable', '', 503, 503)), true);
});
test('undici fetch failed + ETIMEDOUT cause -> transient', () => {
  assert.equal(isTransientTelegramError(fetchFailed(netError('ETIMEDOUT', 'read ETIMEDOUT'))), true);
});
test('undici fetch failed + nested ECONNRESET cause -> transient', () => {
  const outer = fetchFailed(new Error('wrap'));
  outer.cause.cause = netError('ECONNRESET', 'socket hang up');
  assert.equal(isTransientTelegramError(outer), true);
});
test('top-level ECONNREFUSED -> transient', () => {
  assert.equal(isTransientTelegramError(netError('ECONNREFUSED')), true);
});
test('400 bad entities -> PERMANENT', () => {
  assert.equal(isTransientTelegramError(new TelegramApiError('can\'t parse entities', '', 400, 400)), false);
});
test('403 -> PERMANENT', () => {
  assert.equal(isTransientTelegramError(new TelegramApiError('banned', '', 403, 403)), false);
});
test('generic Error -> PERMANENT', () => {
  assert.equal(isTransientTelegramError(new Error('boom')), false);
});

// ---------------------------------------------------------------------------
// TelegramClient HTTP methods (fetch mocked). These verify the outgoing request
// body/URL and the parsed return for the media-send + file-download methods.
// ---------------------------------------------------------------------------

async function atest(name, fn) {
  try {
    await fn();
    passed++; console.log(`  ok    ${name}`);
  } catch (e) {
    failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
  }
}

// A fake global.fetch that records each call and returns a queued Response.
function makeFakeFetch() {
  const calls = [];
  let next = 1;
  const q = [];
  return {
    calls,
    enqueue(json, opts = {}) { q.push({ json, opts }); },
    fn: async (url, init) => {
      calls.push({ url: String(url), init });
      const item = q.shift() || { json: { ok: true, result: {} } };
      const body = item.opts?.raw !== undefined
        ? item.opts.raw
        : JSON.stringify(item.json);
      return new Response(body, {
        status: item.opts?.status || 200,
        headers: { 'content-type': 'application/json', ...(item.opts?.headers || {}) },
      });
    },
  };
}

const realFetch = globalThis.fetch;
const CLIENT_BASE = 'http://tg.test';

console.log('\nTelegramClient.sendVideo:');
await atest('POSTs sendVideo with chat/video/caption/parse_mode/thread_id', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 7, chat: { id: 123 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  const res = await c.sendVideo({
    chatId: 123, video: 'fileid123', caption: 'hi', parseMode: 'HTML', messageThreadId: 9,
  });
  globalThis.fetch = realFetch;
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.endsWith('/botTK/sendVideo'), f.calls[0].url);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.chat_id, '123');
  assert.equal(body.video, 'fileid123');
  assert.equal(body.caption, 'hi');
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.message_thread_id, 9);
  assert.deepEqual(res, { messageId: 7, chatId: '123' });
});
await atest('omits optional fields when not provided', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 8, chat: { id: 1 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  await c.sendVideo({ chatId: 1, video: 'vid' });
  globalThis.fetch = realFetch;
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.caption, undefined);
  assert.equal(body.message_thread_id, undefined);
  assert.equal(body.parse_mode, undefined);
});

console.log('TelegramClient.sendAudio:');
await atest('POSTs sendAudio with title/performer/duration (duration coerced to string)', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 9, chat: { id: 2 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  await c.sendAudio({
    chatId: 2, audio: 'afid', title: 'T', performer: 'P', duration: 90.6,
  });
  globalThis.fetch = realFetch;
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.audio, 'afid');
  assert.equal(body.title, 'T');
  assert.equal(body.performer, 'P');
  assert.equal(body.duration, '91'); // Math.round(90.6), stringified
});

console.log('TelegramClient.getFile:');
await atest('resolves a file_id to { filePath, fileSize, fileName }', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { file_id: 'fid', file_path: 'photos/a/b.jpg', file_size: 1234, file_name: 'shot.jpg' } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  const info = await c.getFile('fid');
  globalThis.fetch = realFetch;
  assert.ok(f.calls[0].url.endsWith('/botTK/getFile'));
  assert.equal(info.filePath, 'photos/a/b.jpg');
  assert.equal(info.fileSize, 1234);
  assert.equal(info.fileName, 'shot.jpg');
});
await atest('throws when no file_path is returned', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: {} });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  globalThis.fetch = realFetch;
  await assert.rejects(() => c.getFile('x'));
});

console.log('TelegramClient.downloadFile:');
await atest('downloads bytes to <uuid><ext> and returns { localPath, fileName, fileSize, mime }', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-'));
  try {
    const f = makeFakeFetch();
    // getFile (JSON) then the raw file bytes.
    f.enqueue({ ok: true, result: { file_id: 'fid', file_path: 'docs/r.pdf', file_name: 'report.pdf' } });
    const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    f.enqueue(null, { raw: payload, headers: { 'content-type': 'application/pdf' } });
    globalThis.fetch = f.fn;
    const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
    const dl = await c.downloadFile('fid', dir);
    globalThis.fetch = realFetch;
    // getFile then the file download = 2 calls.
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1].url.startsWith(`${CLIENT_BASE}/file/botTK/docs/r.pdf`), f.calls[1].url);
    assert.equal(dl.fileName, 'report.pdf');
    assert.equal(dl.fileSize, payload.length);
    assert.equal(dl.mime, 'application/pdf');
    // The written file's bytes match the payload.
    assert.deepEqual(fs.readFileSync(dl.localPath), payload);
    assert.ok(dl.localPath.startsWith(dir), dl.localPath);
    assert.ok(dl.localPath.endsWith('.pdf'), dl.localPath);
    assert.ok(fs.existsSync(dl.localPath), 'file was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
