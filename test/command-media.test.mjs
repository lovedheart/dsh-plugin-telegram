// Unit tests for the exported pure helpers:
//   • extractCommand — bot_command entity detection + @botusername suffix
//   • sniffImageMediaType — magic-byte image type detection
// Run: node test/command-media.test.mjs
import { strict as assert } from 'node:assert';
import { extractCommand, sniffImageMediaType, formatSkillCatalog } from '../src/index.js';

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

console.log('\nformatSkillCatalog:');
const SKILLS = [
  { name: 'matlab-core', description: 'Build MATLAB apps.', invocation: { userInvocable: true, modelInvocable: true } },
  { name: 'bili-say', description: 'B站AI原生助手。深度理解视频。', invocation: { userInvocable: true, modelInvocable: true } },
  { name: 'ocr-code-review', whenToUse: 'Run AI code reviews.', invocation: { userInvocable: false, modelInvocable: true } },
];
test('no filter -> all listed with head count', () => {
  const t = formatSkillCatalog(SKILLS, '');
  assert.match(t, /可用 skill（3）：/);
  assert.match(t, /^• matlab-core — Build MATLAB apps\.$/m);
  assert.match(t, /^• ocr-code-review — Run AI code reviews\.$/m);
});
test('filter matches name, description and whenToUse (case-insensitive)', () => {
  assert.match(formatSkillCatalog(SKILLS, 'MATLAB'), /匹配 1\/3/);
  assert.match(formatSkillCatalog(SKILLS, 'ocr'), /• ocr-code-review/);
  assert.match(formatSkillCatalog(SKILLS, 'B站'), /• bili-say/);
});
test('no match -> empty message keeps total', () => {
  assert.match(formatSkillCatalog(SKILLS, 'zzz-nope'), /没有名字\/描述含 “zzz-nope” 的 skill，共 3 个/);
});
test('empty catalog', () => {
  assert.match(formatSkillCatalog([], ''), /当前没有可用 skill/);
  assert.match(formatSkillCatalog(null, ''), /当前没有可用 skill/);
});
test('long description clipped to 100 chars', () => {
  const t = formatSkillCatalog([{ name: 'x', description: 'y'.repeat(300) }], '');
  assert.match(t, /^• x — y{100}…$/m);
});
test('short description not clipped', () => {
  const t = formatSkillCatalog([{ name: 'x', description: 'z'.repeat(50) }], '');
  assert.match(t, /^• x — z{50}$/m);
});
test('overflow collapses into +K more line', () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ name: `s-${i}`, description: 'd' }));
  const t = formatSkillCatalog(many, '');
  assert.match(t, /另有 10 个未列出/);
  assert.ok(t.split('\n').length <= 65, 'row cap holds the reply small');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
