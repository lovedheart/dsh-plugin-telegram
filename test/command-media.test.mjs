// Unit tests for the exported pure helpers:
//   • extractCommand — bot_command entity detection + @botusername suffix
//   • sniffImageMediaType — magic-byte image type detection
// Run: node test/command-media.test.mjs
import { strict as assert } from 'node:assert';
import { extractCommand, sniffImageMediaType } from '../src/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}

console.log('extractCommand:');
test('bot_command entity with @botusername suffix -> cmd stripped of suffix', () => {
  // In a group: "/new@MyBot hello there" — the entity covers "/new@MyBot".
  const r = extractCommand({
    text: '/new@MyBot hello there',
    entities: [{ type: 'bot_command', offset: 0, length: 11 }],
  });
  assert.equal(r.cmd, '/new');
  assert.equal(r.args, 'hello there');
});
test('bot_command entity without suffix in a private chat', () => {
  const r = extractCommand({
    text: '/status',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
  });
  assert.equal(r.cmd, '/status');
  assert.equal(r.args, '');
});
test('bot_command entity with only an args tail', () => {
  const r = extractCommand({
    text: '/run  --flag value',
    entities: [{ type: 'bot_command', offset: 0, length: 4 }],
  });
  assert.equal(r.cmd, '/run');
  assert.equal(r.args, '--flag value');
});
test('leading non-command entity is ignored (falls back to /word split)', () => {
  // An entity that is NOT at offset 0 must not be treated as a command.
  const r = extractCommand({
    text: 'hi /help',
    entities: [{ type: 'bot_command', offset: 3, length: 5 }],
  });
  // Falls back to the leading-token rule: trimmed text does not start with '/',
  // so this is NOT a command.
  assert.equal(r, null);
});
test('no entity but leading /word -> fallback split', () => {
  const r = extractCommand({ text: '  /start a b c  ' });
  assert.equal(r.cmd, '/start');
  assert.equal(r.args, 'a b c');
});
test('no entity, no leading slash -> null', () => {
  assert.equal(extractCommand({ text: 'just a sentence' }), null);
});
test('empty / undefined text -> null', () => {
  assert.equal(extractCommand({}), null);
  assert.equal(extractCommand({ text: '   ' }), null);
});

console.log('\nsniffImageMediaType:');
test('JPEG (FF D8 FF)', () => {
  assert.equal(sniffImageMediaType([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg');
});
test('PNG (89 50 4E 47)', () => {
  assert.equal(sniffImageMediaType([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'image/png');
});
test('GIF (47 49 46 38)', () => {
  assert.equal(sniffImageMediaType([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif');
});
test('WEBP (RIFF....WEBP)', () => {
  // RIFF <size> WEBP
  const b = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
  assert.equal(sniffImageMediaType(b), 'image/webp');
});
test('RIFF that is not WEBP -> null', () => {
  const b = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]; // WAV
  assert.equal(sniffImageMediaType(b), null);
});
test('short / unknown bytes -> null', () => {
  assert.equal(sniffImageMediaType([0x00, 0x01, 0x02]), null);
  assert.equal(sniffImageMediaType([]), null);
  assert.equal(sniffImageMediaType(null), null);
  assert.equal(sniffImageMediaType(undefined), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
