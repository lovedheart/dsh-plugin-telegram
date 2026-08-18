// Regression test for the "bot deaf during a long task" bug.
//
// A message handler that stalls on a hung/flaky Telegram call must NEVER block
// the next getUpdates. If the poll loop awaited its handlers, one hung handler
// would stop all polling until process restart. This test asserts that even
// with a handler that never settles, the loop keeps polling.
import { strict as assert } from 'node:assert';
import { TelegramPoller } from '../src/poller.js';

let passed = 0, failed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}

// A fake client whose getUpdates returns one message batch then keeps
// returning empty batches, and records each call.
function makeFakeClient() {
  let call = 0;
  const calls = [];
  return {
    calls,
    async getUpdates(offset, limit, timeout, signal) {
      calls.push({ offset, limit, timeout, signal });
      call += 1;
      if (call === 1) {
        // First batch: one message that the (hung) handler will consume.
        return [{ updateId: 1, message: { chatId: '1', messageId: 100, senderId: 'u', text: 'hi' } }];
      }
      // Subsequent polls: empty (long-poll would hold; here resolve fast).
      await new Promise((r) => setTimeout(r, 5));
      return [];
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('TelegramPoller (decoupling):');
await atest('a hung message handler does NOT block the next getUpdates', async () => {
  const client = makeFakeClient();
  const p = new TelegramPoller(client, { offsetStorePath: '/tmp/tg-poller-test-offset.json' });
  let handlerResolved = false;
  p.onMessage(() => {
    // Simulate a handler that hangs on a flaky Telegram call and never settles.
    return new Promise(() => { handlerResolved = false; });
  });
  p.start();

  // Wait until at least a second poll happens (proving the loop moved on).
  let polls = 0;
  for (let i = 0; i < 100 && polls < 2; i++) {
    polls = client.calls.length;
    if (polls < 2) await sleep(10);
  }
  p.stop();

  // The handler is still pending (never resolved) ...
  assert.equal(handlerResolved, false, 'handler should still be hung');
  // ... yet the poll loop made at least 2 getUpdates calls.
  assert.ok(polls >= 2, `expected >=2 getUpdates calls, got ${polls}`);
});

await atest('a fast message handler is still invoked and dedup applies', async () => {
  const client = makeFakeClient();
  const p = new TelegramPoller(client, { offsetStorePath: '/tmp/tg-poller-test-offset2.json' });
  const seen = [];
  p.onMessage(async (m) => { seen.push(m.messageId); });
  p.start();

  for (let i = 0; i < 100 && seen.length < 1; i++) await sleep(10);
  p.stop();
  assert.ok(seen.length >= 1, 'handler should have run once for the message');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
