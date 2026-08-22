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

import { readFileSync } from 'node:fs';

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


// ---------------------------------------------------------------------------
// Multi-bot configuration (v0.5.x)
//
// `bots` is an OPTIONAL config list. Each entry is a full bot config; any
// field omitted on an entry falls back to the TOP-LEVEL config of the same
// name (so the legacy single-bot config keeps working unchanged).
//
//   bots:
//     - id: 'main'            # optional; auto-generated, see below
//       token: ''             # optional; '' -> envKey / credentialKey lookup
//       envKey: 'TELEGRAM_BOT_TOKEN'
//       credentialKey: 'TELEGRAM_BOT_TOKEN'
//       baseUrl: ''           # optional; '' -> top-level baseUrl -> TELEGRAM_BASE_URL

/**
 * Build the inbound-media module. deps:
 *   clientFor(botId) -> TelegramClient | throws
 *   log(level, ...args)
 *   inboundMediaDir: string   local dir downloaded files land in
 *   inboundImageToModel: bool attach a vision block for photos (default false)
 */
export function createInboundMediaModule({ clientFor, log, inboundMediaDir, inboundImageToModel }) {
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
    return message.photo ? 'photo'
      : message.document ? 'document'
      : message.video ? 'video'
      : message.audio ? 'audio'
      : message.voice ? 'voice'
      : 'media';
  }

  /** Pick the downloadable file_id for an inbound media message (or null). */
  function inboundMediaFileId(message) {
    if (message.photo && message.photo.length) {
      // Photos come as several sizes; take the LARGEST (most detail).
      const largest = message.photo.reduce((a, b) =>
        ((a.width * a.height) >= (b.width * b.height) ? a : b));
      return largest.fileId || null;
    }
    const m = message.document || message.video || message.audio || message.voice;
    return (m && m.file_id) ? m.file_id : null;
  }

  /**
   * Download an inbound media message and build a note (+ optional vision
   * block) describing it for the agent. Always returns { note, imageBlock }.
   * Best-effort: never throws — a download failure becomes a descriptive note.
   */
  async function downloadAndDescribeInboundMedia(botId, message) {
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

    // Human/agent-facing description.
    let dims = '';
    if (message.photo && message.photo.length) {
      const p = message.photo.reduce((a, b) =>
        ((a.width * a.height) >= (b.width * b.height) ? a : b));
      if (p.width && p.height) dims = ` (${p.width}×${p.height})`;
    }
    const raw = message.document || message.video || message.audio || message.voice;
    let meta = '';
    if (raw && raw.file_name) meta += ` “${raw.file_name}”`;
    if (raw && typeof raw.file_size === 'number') meta += ` ${Math.round(raw.file_size / 1024)} KB`;
    if (raw && typeof raw.duration === 'number') meta += ` ${raw.duration}s`;

    const note =
      `The user sent a ${kind}${dims}${meta}. ` +
      `It has been saved locally to: ${dl.localPath} — you can read/process it with your file tools.` +
      (message.text ? ` Their caption: “${message.text}”` : '');

    // Optional vision block (photos only, and only when explicitly enabled).
    // The declared media type must match the ACTUAL bytes (saveImage validates
    // by decoding), so we sniff the magic bytes rather than assume jpeg.
    let imageBlock = null;
    if (kind === 'photo' && inboundImageToModel) {
      const svc =
        (ctx.attachments && typeof ctx.attachments.saveImage === 'function')
          ? ctx.attachments
          : (ctx.get ? ctx.get('attachments') : undefined);
      if (!svc || typeof svc.saveImage !== 'function') {
        log('warn', 'Inbound photo: attachments service unavailable; forwarding path only.');
      } else {
        try {
          const bytes = new Uint8Array(readFileSync(dl.localPath));
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
  }
  return { inboundMediaKind, inboundMediaFileId, downloadAndDescribeInboundMedia };
}
