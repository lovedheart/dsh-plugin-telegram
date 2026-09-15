/**
 * Pure text helpers for the Telegram plugin: Markdown→Telegram HTML
 * conversion, fence-aware message chunking, and a post-conversion length
 * guard. Extracted from index.js so they can be unit-tested in isolation.
 *
 * @module dsh-plugin-telegram/text
 */

// ---------------------------------------------------------------------------
// Text chunking (Telegram hard limit: 4096 chars per message)
//
// Fence-aware: splits are made on newline/space boundaries OUTSIDE code
// blocks (detected by counting ``` toggles). This guarantees every chunk
// produced contains balanced ``` fences, so per-chunk markdown-to-HTML
// conversion yields well-formed <pre> blocks and Telegram accepts them.
//
// If a single code block is longer than `maxSize`, the block is hard-split
// and the continuation is re-fenced so it still renders as code. The
// post-conversion length guard (see guardConvertedLength) remains a safety
// net for edge cases.
// ---------------------------------------------------------------------------

export function chunkText(text, maxSize) {
  if (!text) return [];
  if (text.length <= maxSize) return [text];

  const chunks = [];
  const half = Math.floor(maxSize / 2);
  let rest = text;

  while (rest.length > maxSize) {
    const window = rest.slice(0, maxSize);
    // Scan the window, tracking code-fence parity. A split position is
    // "balanced" when the number of ``` fences in rest[0..pos] is even — then
    // the chunk has balanced fences and per-chunk HTML is well-formed.
    // Candidate balanced positions in [half, maxSize]:
    //   - right after a CLOSING fence (even parity)
    //   - a newline / space at even parity (i.e. outside a code block)
    let fenceCount = 0;
    let lastFenceClose = -1;
    let lastEvenNl = -1;
    let lastEvenSp = -1;
    const re = /\n| |```/g;
    let m;
    while ((m = re.exec(window)) !== null) {
      if (m[0] === '```') {
        fenceCount++;
        if (fenceCount % 2 === 0) {
          const end = m.index + 3;
          if (end > half) lastFenceClose = end; // a closing fence
        }
        continue;
      }
      const pos = m.index + 1;
      if (fenceCount % 2 === 0 && pos > half) {
        if (m[0] === '\n') lastEvenNl = pos;
        else lastEvenSp = pos;
      }
    }

    const boundary = Math.max(lastFenceClose, lastEvenNl, lastEvenSp);
    if (boundary > half) {
      // Split at a fence-balanced boundary closest to the window end.
      const chunk = rest.slice(0, boundary);
      chunks.push(chunk);
      rest = rest.slice(boundary).replace(/^\s+/, '');
    } else {
      // No balanced boundary in [half, maxSize]: a single code block longer
      // than maxSize. Hard-split, close the block here, re-open in the next
      // chunk so both render as code. Reserve 4 chars for the '```\n' we add.
      const cut = maxSize - 4;
      const chunk = rest.slice(0, cut) + '```\n';
      chunks.push(chunk);
      rest = '```\n' + rest.slice(cut).replace(/^\s+/, '');
    }
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

// ---------------------------------------------------------------------------
// Markdown to Telegram HTML conversion
//
// The italic rules are GATED on the input not containing a backtick: any
// backtick (inline code or fenced block) disables the `_..._` italic rule.
// This keeps identifiers like `snake_case_var` and `foo_bar` from being
// mangled into italic spans — the original version converted them and
// produced `can't parse entities` failures for any agent output with code.
//
// The escape pass runs first, so the guard is evaluated against the user's
// raw input (backticks survive the escape pass because it only touches
// &, <, >).
// ---------------------------------------------------------------------------

/**
 * Wrap GFM tables in code fences so the fence rule renders them as <pre>
 * (monospaced, pipe layout preserved) instead of sending raw pipe lines
 * that Telegram displays as plain unformatted text.
 *
 * Minimal detection: a line containing `|` immediately followed by a
 * separator line (only `-`, `|`, `:`, whitespace; must contain `-` and `|`)
 * starts a table; the table ends at the first line not starting with `|`.
 * Lines inside existing ``` fences are never touched.
 */
function fenceGfmTables(text) {
  const isSeparator = (l) =>
    l.includes('-') && l.includes('|') && !/[^\s:|-]/.test(l);
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      out.push(lines[i]);
      continue;
    }
    if (inFence) {
      out.push(lines[i]);
      continue;
    }
    const isHeader =
      lines[i].includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1]);
    if (!isHeader) {
      out.push(lines[i]);
      continue;
    }
    const start = i;
    i += 2; // header + separator
    while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
    out.push('```\n' + lines.slice(start, i).join('\n') + '\n```');
  }
  return out.join('\n');
}

export function markdownToTelegramHtml(md) {
  const hasBacktick = md.includes('`');
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // GFM tables -> code fences (rendered as <pre> by the next rule).
  text = fenceGfmTables(text);

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, __, code) => `<pre>${code.trim()}</pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  if (!hasBacktick) {
    text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');
  }
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return text;
}

// After conversion, ensure the chunk fits Telegram's hard limit.
// If it doesn't, return the original (unconverted) chunk and let the caller
// omit parse_mode for that chunk (HTML parse failures would be worse).
export function guardConvertedLength(raw, converted, maxSize) {
  if (converted.length <= maxSize) return { text: converted, useParseMode: true };
  if (raw.length <= maxSize) return { text: raw, useParseMode: false };
  return { text: raw.slice(0, maxSize), useParseMode: false };
}

// ---------------------------------------------------------------------------
// Session list display helpers (used by /sessions, /new, /use)
//
// Session ids look like `telegram-<uuid>`; showing the first 12 chars wastes
// 9 of them on the `telegram-` prefix and leaves ~5 ambiguous chars. These
// helpers render a compact, collision-safe `s-xxxx` handle and wrap a session
// title onto at most two display lines.
// ---------------------------------------------------------------------------

// Wide-char-aware display width: CJK / fullwidth / emoji ≈ 2 columns, others 1.
// Mirrors questions.js / subagents.js so all renderers agree on clipping.
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

// Hex-ish core of a session id: the longest hex run (uuid/hash segments),
// else the id stripped of its `name-` prefix and punctuation.
function shortIdCore(id) {
  const s = String(id ?? '');
  const runs = s.match(/[0-9a-f]{4,}/gi);
  if (runs?.length) return runs[0].toLowerCase();
  return (s.replace(/^[a-z]+-/i, '').replace(/[^0-9a-z]/gi, '') || s.toLowerCase()).toLowerCase();
}

/**
 * Map each session id to a short `s-xxxx` display handle.
 * Length grows (4 → 6 → 8 …) only for prefixes that collide with another id,
 * so ids stay short while remaining unambiguous.
 * @returns {Map<string, string>} original id → display handle
 */
export function sessionShortIds(ids) {
  const cores = new Map(); // id → { core, tail }
  for (const id of ids) {
    const key = String(id ?? '');
    const core = shortIdCore(key);
    // Keep the full sanitized id as extra entropy for collision resolution.
    cores.set(key, { core, tail: (core + key.replace(/[^0-9a-z]/gi, '').toLowerCase()) });
  }
  const out = new Map();
  for (const [id, { core, tail }] of cores) {
    let len = Math.min(4, tail.length);
    let prefix = tail.slice(0, len);
    while (len < tail.length && [...cores.keys()].some((other) => other !== id && cores.get(other).tail.startsWith(prefix))) {
      len += 2;
      prefix = tail.slice(0, len);
    }
    out.set(id, { short: `s-${prefix}`, core });
  }
  return out;
}

/**
 * Wrap `text` into at most `maxLines` lines of `width` display columns.
 * Prefers whitespace breaks; hard-breaks over-long tokens. Overflow past
 * maxLines is truncated with an ellipsis on the last line.
 * @returns {string[]} 1..maxLines lines
 */
export function wrapDisplay(text, width, maxLines = 2) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const lines = [];
  let line = '';
  const pushHard = (token) => {
    for (const ch of token) {
      const cw = ch.codePointAt(0) > 0x2e7f ? 2 : 1;
      if (displayWidth(line) + cw > width) {
        lines.push(line);
        line = '';
        if (lines.length >= maxLines) return;
      }
      line += ch;
    }
  };
  outer: for (const token of src.split(' ')) {
    const gap = line ? 1 : 0;
    if (displayWidth(line) + gap + displayWidth(token) <= width) {
      line = line ? `${line} ${token}` : token;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
      if (lines.length >= maxLines) break;
    }
    pushHard(token);
    if (lines.length >= maxLines) break outer;
  }
  if (lines.length < maxLines && line) lines.push(line);

  // Truncate anything that spilled past the line budget with an ellipsis.
  if (lines.length >= maxLines) {
    const reconst = lines.slice(0, maxLines).join(' ');
    if (src.length > reconst.length) {
      const last = lines[maxLines - 1];
      let cut = '';
      for (const ch of last) {
        if (displayWidth(cut) + (ch.codePointAt(0) > 0x2e7f ? 2 : 1) > width - 1) break;
        cut += ch;
      }
      lines[maxLines - 1] = `${cut}…`;
    }
    return lines.slice(0, maxLines);
  }
  return lines;
}
