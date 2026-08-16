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

export function markdownToTelegramHtml(md) {
  const hasBacktick = md.includes('`');
  let text = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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
