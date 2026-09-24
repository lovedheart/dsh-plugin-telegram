/**
 * Inbound media handling: detect the kind of an inbound media message, pick
 * its downloadable file_id, download it, and build a note (+ optional vision
 * block) describing it for the agent. Also holds the pure image
 * magic-number sniffer used to declare a media type that matches the actual
 * bytes (the attachments service rejects a mismatching type).
 *
 * Extracted from index.js so the inbound-media path can be unit-tested in
 * isolation.
 *
 * @module dsh-plugin-telegram/inbound-media
 */

import { readFile } from 'node:fs/promises';

/**
 * Sniff a raster image's media type from its leading bytes (magic-number
 * detection). Returns one of 'image/jpeg' | 'image/png' | 'image/webp' |
 * 'image/gif', or null when the bytes are not a supported raster.
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'image/jpeg'; // JFIF / Exif
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return 'image/png';
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return 'image/gif';
  // WEBP: "RIFF"...."WEBP"
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
      && bytes.length >= 12
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/** Ordered media kinds; first present key on the message wins. */
const INBOUND_MEDIA_KEYS = [
  ['photo', 'photo'],
  ['document', 'document'],
  ['video', 'video'],
  ['audio', 'audio'],
  ['voice', 'voice'],
];

/**
 * Make attacker-controlled text (captions / file names come straight from any
 * Telegram user) safe to interpolate into the agent-facing note: collapse all
 * whitespace/control chars to single spaces (no fake multi-line turns, no
 * terminal escapes) and cap the length (no unbounded context bloat).
 */
export function sanitizeForNote(text, maxLen = 500) {
  const s = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/** Pick the largest size of a photo array (most detail), or null. */
function pickLargestPhoto(message) {
  const sizes = Array.isArray(message?.photo) ? message.photo.filter(Boolean) : [];
  if (!sizes.length) return null;
  const area = (p) => (Number(p.width) || 0) * (Number(p.height) || 0);
  return sizes.reduce((a, b) => (area(b) > area(a) ? b : a));
}

/**
 * Build the inbound-media module. deps:
 *   clientFor(botId) -> TelegramClient | throws
 *   log(level, ...args)
 *   inboundMediaDir: string   local dir downloaded files land in
 *   inboundImageToModel: bool attach a vision block for photos (default false)
 *   ctx:                      plugin ctx, used to resolve the `attachments`
 *                             service for the optional vision block (optional)
 */
export function createInboundMediaModule({ clientFor, log = () => {}, inboundMediaDir, inboundImageToModel, ctx }) {
  // -----------------------------------------------------------------------
  // Inbound media download + forward (parity with QwenPaw). When the user
  // sends a photo/document/video/audio/voice we:
  //   1. download it to `inboundMediaDir` (uuid-named), and
  //   2. tell the agent the LOCAL PATH so it can read it with its file tools
  //      (bash/read/glob), plus any caption.
  // For photos we MAY ALSO attach a vision content block so a multimodal model
  // can "see" it — but only when `inboundImageToModel` is true (default false:
  // a text-only model would throw UNSUPPORTED_CONTENT on an image block and
  // break the whole turn). If the attachments service is missing or saveImage
  // fails (wrong media type / model policy), we degrade to path-only and log.
  // -----------------------------------------------------------------------
  function inboundMediaKind(message) {
    for (const [key, kind] of INBOUND_MEDIA_KEYS) {
      if (message?.[key]) return kind;
    }
    return 'media';
  }

  /** Pick the downloadable file_id for an inbound media message (or null). */
  function inboundMediaFileId(message) {
    const largest = pickLargestPhoto(message);
    if (largest) return largest.fileId || null;
    const m = message?.document || message?.video || message?.audio || message?.voice;
    return (m && m.file_id) ? m.file_id : null;
  }

  /**
   * Download an inbound media message and build a note (+ optional vision
   * block) describing it for the agent. Always returns { note, imageBlock }.
   * Best-effort: NEVER throws — any failure becomes a descriptive note so a
   * broken media item can never abort the inbound turn.
   */
  async function downloadAndDescribeInboundMedia(botId, message) {
    try {
      const tgClient = clientFor(botId);
      const kind = inboundMediaKind(message);
      const fileId = inboundMediaFileId(message);
      if (!fileId) {
        return { note: `(the user sent a ${kind} with no downloadable file)`, imageBlock: null, localPath: null };
      }
      let dl;
      try {
        dl = await tgClient.downloadFile(fileId, inboundMediaDir);
      } catch (err) {
        log('warn', `Inbound ${kind} download failed: ${err.message}`);
        return { note: `(the user sent a ${kind} but it could not be downloaded: ${err.message})`, imageBlock: null, localPath: null };
      }
      if (!dl || !dl.localPath) {
        return { note: `(the user sent a ${kind} but it could not be downloaded)`, imageBlock: null, localPath: null };
      }

      // Human/agent-facing description. Attacker-controlled fields
      // (file_name, caption) are sanitized before interpolation — they would
      // otherwise let any Telegram user inject control text into the agent.
      const photo = pickLargestPhoto(message);
      const dims = (photo?.width && photo?.height) ? ` (${photo.width}×${photo.height})` : '';
      const raw = message.document || message.video || message.audio || message.voice;
      let meta = '';
      if (raw && raw.file_name) meta += ` “${sanitizeForNote(raw.file_name, 200)}”`;
      if (raw && typeof raw.file_size === 'number') meta += ` ${Math.round(raw.file_size / 1024)} KB`;
      if (raw && typeof raw.duration === 'number') meta += ` ${raw.duration}s`;

      const note =
        `The user sent a ${kind}${dims}${meta}. ` +
        `It has been saved locally to: ${dl.localPath} — you can read/process it with your file tools.` +
        (message.text ? ` Their caption: “${sanitizeForNote(message.text, 500)}”` : '');

      // Optional vision block (photos only, and only when explicitly enabled).
      // The declared media type must match the ACTUAL bytes (saveImage validates
      // by decoding), so we sniff the magic bytes rather than assume jpeg.
      let imageBlock = null;
      if (kind === 'photo' && inboundImageToModel) {
        const svc =
          (ctx?.attachments && typeof ctx.attachments.saveImage === 'function')
            ? ctx.attachments
            : (typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined);
        if (!svc || typeof svc.saveImage !== 'function') {
          log('warn', 'Inbound photo: attachments service unavailable; forwarding path only.');
        } else {
          try {
            const bytes = new Uint8Array(await readFile(dl.localPath));
            const mediaType = sniffImageMediaType(bytes);
            if (!mediaType) {
              log('warn', 'Inbound photo: bytes are not a supported raster (png/jpeg/webp/gif); forwarding path only.');
            } else {
              const ref = await svc.saveImage({ data: bytes, mediaType, name: dl.fileName });
              imageBlock = { type: 'image', attachment: ref };
              log('info', `Inbound photo attached as vision block (${ref.mediaType}, ${ref.bytes} bytes).`);
            }
          } catch (err) {
            log('warn', `Inbound photo: saveImage failed (${err.code || err.message}); forwarding path only.`);
          }
        }
      }
      return { note, imageBlock, localPath: dl.localPath };
    } catch (err) {
      // Never throw: a media failure must degrade to a note, not kill the turn.
      log('warn', `Inbound media handling failed: ${err?.message ?? err}`);
      return { note: '(the user sent media that could not be processed)', imageBlock: null, localPath: null };
    }
  }
  return { inboundMediaKind, inboundMediaFileId, downloadAndDescribeInboundMedia };
}
