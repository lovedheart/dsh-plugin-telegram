// Unit tests for the real error-classification helper in src/client.js.
// Run: node test/client.test.mjs
import { strict as assert } from 'node:assert';
import { TelegramApiError, TelegramRateLimitError, isTransientTelegramError } from '../src/client.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
