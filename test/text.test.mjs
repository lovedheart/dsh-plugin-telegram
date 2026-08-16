// Unit tests for the real pure helpers in src/text.js.
// Run: node test/text.test.mjs
import { strict as assert } from 'node:assert';
import { chunkText, markdownToTelegramHtml, guardConvertedLength } from '../src/text.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('markdownToTelegramHtml:');
test('inline code preserved, no italic bleed', () => {
  const out = markdownToTelegramHtml('see `foo_bar_baz` for details');
  assert.ok(out.includes('<code>foo_bar_baz</code>'));
  assert.ok(!out.includes('<i>'), 'no italic: ' + out);
});
test('underscore-italic active when no backtick present', () => {
  const out = markdownToTelegramHtml('a_b_c');
  assert.ok(out.includes('<i>'), 'should italicize: ' + out);
});
test('backtick presence suppresses underscore-italic message-wide', () => {
  const out = markdownToTelegramHtml('run `x` then a_b');
  assert.ok(!out.includes('<i>'), 'no italic anywhere: ' + out);
  assert.ok(out.includes('a_b'));
});
test('bold / strike / link', () => {
  const out = markdownToTelegramHtml('**bold** ~~gone~~ [link](http://x)');
  assert.ok(out.includes('<b>bold</b>'));
  assert.ok(out.includes('<s>gone</s>'));
  assert.ok(out.includes('<a href="http://x">link</a>'));
});
test('entity escaping', () => {
  const out = markdownToTelegramHtml('a & b < c > d');
  assert.ok(out.includes('&amp;') && out.includes('&lt;') && out.includes('&gt;'));
});
test('fenced block to <pre>', () => {
  const out = markdownToTelegramHtml('```\nlet x = 1\n```');
  assert.ok(out.includes('<pre>let x = 1</pre>'));
});

console.log('chunkText:');
test('short -> single chunk', () => {
  assert.deepEqual(chunkText('hi', 100), ['hi']);
});
test('empty -> []', () => {
  assert.deepEqual(chunkText('', 100), []);
});
test('long plain text: all chunks <= maxSize', () => {
  const words = Array.from({length: 2000}, (_, i) => `w${i}`).join(' ');
  const chunks = chunkText(words, 4096);
  assert.ok(chunks.length > 1, 'split: ' + chunks.length);
  for (const c of chunks) assert.ok(c.length <= 4096, `chunk ${c.length} <= 4096`);
});
test('code block spanning maxSize: balanced fences per chunk', () => {
  const code = 'line ' + Array.from({length: 3000}, (_, i) => `x${i}`).join(' ');
  const msg = 'here is a code block:\n```\n' + code + '\n```\nend of message with more text after the block to pad length further';
  assert.ok(msg.length > 4096, 'precondition: msg long enough: ' + msg.length);
  const chunks = chunkText(msg, 4096);
  assert.ok(chunks.length >= 2, 'split: ' + chunks.length);
  chunks.forEach((c, i) => {
    const fences = (c.match(/```/g) || []).length;
    assert.ok(fences % 2 === 0, `chunk ${i} balanced fences (${fences})`);
    assert.ok(c.length <= 4096 + 4, `chunk ${i} in budget: ${c.length}`);
  });
});
test('per-chunk conversion yields balanced <pre>', () => {
  const code = 'x ' + Array.from({length: 600}, (_, i) => `y${i}`).join(' ');
  const msg = 'intro\n```\n' + code + '\n```\noutro';
  const chunks = chunkText(msg, 4096);
  chunks.forEach((c, i) => {
    const html = markdownToTelegramHtml(c);
    const open = (html.match(/<pre>/g) || []).length;
    const close = (html.match(/<\/pre>/g) || []).length;
    assert.ok(open === close, `chunk ${i} <pre> balanced (${open}/${close})`);
  });
});
test('no chunk ever starts mid-word in a plain paragraph', () => {
  const words = Array.from({length: 3000}, (_, i) => `token_${i}word`).join(' ');
  const chunks = chunkText(words, 2000);
  // Each chunk (after the first) must begin with whitespace-stripped text that
  // is a whole word (the split landed on a space). We strip leading \s in the
  // chunker, so the next chunk should start at a word boundary.
  for (let i = 1; i < chunks.length; i++) {
    const firstWord = chunks[i].split(/\s+/)[0];
    assert.ok(/^token_\d+word$/.test(firstWord), `chunk ${i} starts at word boundary: '${firstWord.slice(0, 24)}'`);
  }
});

console.log('guardConvertedLength:');
test('pass-through when converted fits', () => {
  const r = guardConvertedLength('a', '<b>a</b>', 100);
  assert.equal(r.useParseMode, true);
  assert.equal(r.text, '<b>a</b>');
});
test('fallback to raw when converted too long but raw fits', () => {
  const r = guardConvertedLength('short', 'x'.repeat(200), 100);
  assert.equal(r.useParseMode, false);
  assert.equal(r.text, 'short');
});
test('truncates raw when both exceed', () => {
  const r = guardConvertedLength('z'.repeat(300), 'y'.repeat(300), 100);
  assert.equal(r.useParseMode, false);
  assert.equal(r.text.length, 100);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
