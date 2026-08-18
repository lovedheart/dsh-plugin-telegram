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
test('client-side timeout (AbortError w/ TimeoutError cause) -> transient', () => {
  const cause = new Error('TimeoutError');
  cause.name = 'TimeoutError';
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  abort.cause = cause;
  // A timed-out sendMessage must be RETRIED (not dropped) — the whole point of
  // the requestTimeoutMs guard is to turn a hang into a retryable error.
  assert.equal(isTransientTelegramError(abort), true);
});
test('external AbortSignal abort (bare AbortError) -> transient', () => {
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  assert.equal(isTransientTelegramError(abort), true);
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

console.log('TelegramClient local-file upload (multipart):');
await atest('sendDocument with a local path uploads multipart with field "document"', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgup-'));
  const file = path.join(dir, 'report.pdf');
  fs.writeFileSync(file, '%PDF-1.4 fake');
  try {
    const f = makeFakeFetch();
    f.enqueue({ ok: true, result: { message_id: 42, chat: { id: 555 } } });
    globalThis.fetch = f.fn;
    const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
    const res = await c.sendDocument({ chatId: 555, document: file, caption: 'hello' });
    globalThis.fetch = realFetch;
    assert.ok(f.calls[0].url.endsWith('/botTK/sendDocument'), f.calls[0].url);
    const init = f.calls[0].init;
    assert.ok(init.body instanceof FormData, 'local path must produce a multipart FormData body');
    const entries = {};
    for (const [k, v] of init.body.entries()) entries[k] = v;
    assert.equal(entries.chat_id, '555');
    assert.equal(entries.caption, 'hello');
    const filePart = entries.document;
    assert.ok(filePart && filePart.name === 'report.pdf', 'file part must carry the basename');
    assert.equal(filePart.type, 'application/pdf', 'MIME must be inferred from the .pdf extension');
    assert.deepEqual(res, { messageId: 42, chatId: '555' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await atest('sendDocument with a URL still POSTs JSON (unchanged behavior)', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 7, chat: { id: 123 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  await c.sendDocument({ chatId: 123, document: 'https://example.com/a.pdf' });
  globalThis.fetch = realFetch;
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.document, 'https://example.com/a.pdf');
  assert.equal(body.chat_id, '123');
});
await atest('sendDocument with a file_id still POSTs JSON (unchanged behavior)', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 7, chat: { id: 123 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  await c.sendDocument({ chatId: 123, document: 'file_id_ABC-123' });
  globalThis.fetch = realFetch;
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.document, 'file_id_ABC-123');
});
await atest('sendDocument with a missing local path throws', async () => {
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  await assert.rejects(
    () => c.sendDocument({ chatId: 1, document: '/no/such/file.pdf' }),
    /not found|regular file/,
  );
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

// ---------------------------------------------------------------------------
// Per-request timeout (regression: a hung Telegram call must NOT block forever,
// which used to deafen the whole poller). We model a hang with a fetch that
// only settles when its abort signal fires, then assert the call aborts within
// the configured requestTimeoutMs.
// ---------------------------------------------------------------------------
console.log('\nTelegramClient.requestTimeoutMs (hang protection):');
await atest('a hung fetch is aborted within requestTimeoutMs', async () => {
  globalThis.fetch = async (url, init) => {
    // Simulate a network hang: never resolves until the signal aborts.
    const signal = init?.signal;
    if (!signal) return new Promise(() => {});
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => {
        const e = new Error(`The operation was aborted (aborted ${signal.reason?.name === 'TimeoutError' ? 'by timeout' : ''})`);
        e.name = 'AbortError';
        e.cause = signal.reason;
        reject(e);
      }, { once: true });
    });
  };
  // In production the loop stays alive via the WebSocket + poll loop, so
  // AbortSignal.timeout's timer fires. In this isolated test nothing else is
  // pending, so a ref'd keep-alive interval keeps the event loop open until the
  // 120ms timeout fires (mirrors that production activity).
  const keepAlive = setInterval(() => {}, 25);
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE, requestTimeoutMs: 120 });
  const t0 = Date.now();
  let threw = false;
  try {
    await c.sendMessage({ chatId: 1, text: 'hi' });
  } catch { threw = true; } finally {
    clearInterval(keepAlive);
  }
  const elapsed = Date.now() - t0;
  globalThis.fetch = realFetch;
  assert.equal(threw, true, 'hung call should have been aborted (thrown)');
  assert.ok(elapsed < 1000, `should abort within ~120ms, took ${elapsed}ms`);
});
await atest('a healthy fast response is NOT aborted by the timeout', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: true, result: { message_id: 42, chat: { id: 1 } } });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE, requestTimeoutMs: 1000 });
  const res = await c.sendMessage({ chatId: 1, text: 'hi' });
  globalThis.fetch = realFetch;
  assert.equal(res.messageId, 42);
});

// ---------------------------------------------------------------------------
// sendChatAction throwOnFailure (regression: the progress-indicator typing
// fallback needs a real reject to detect a broken feedback channel; the client
// swallows errors by default, so a plain call would never trigger the fallback).
// ---------------------------------------------------------------------------
console.log('\nTelegramClient.sendChatAction (throwOnFailure):');
await atest('swallows errors by default (best-effort)', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: false, error_code: 500, description: 'server hiccup' }, { status: 500 });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  let threw = false;
  try { await c.sendChatAction(1, 'typing'); } catch { threw = true; }
  globalThis.fetch = realFetch;
  assert.equal(threw, false, 'default call must stay best-effort (no throw)');
});
await atest('rethrows when throwOnFailure is set', async () => {
  const f = makeFakeFetch();
  f.enqueue({ ok: false, error_code: 500, description: 'server hiccup' }, { status: 500 });
  globalThis.fetch = f.fn;
  const c = new TelegramClient({ botToken: 'TK', baseUrl: CLIENT_BASE });
  let threw = false;
  try { await c.sendChatAction(1, 'typing', undefined, { throwOnFailure: true }); } catch { threw = true; }
  globalThis.fetch = realFetch;
  assert.equal(threw, true, 'throwOnFailure must surface the error so callers can detect the break');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
