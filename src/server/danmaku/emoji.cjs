'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
let artwork;
const materialized = new Map();
const imageRatios = new Map();

// Size against the text height, not a square letter cell. Inspect the saved
// PNG once; older recordings may omit dimensions (or advertise stale ones).
function emojiWidthFactor(asset) {
  let width = Number(asset?.width), height = Number(asset?.height);
  const filePath = asset?.filePath;
  if (filePath) {
    if (!imageRatios.has(filePath)) {
      let ratio = 0, fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(24);
        if (fs.readSync(fd, header, 0, 24, 0) === 24 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
          const w = header.readUInt32BE(16), h = header.readUInt32BE(20);
          if (w > 0 && h > 0) ratio = w / h;
        }
      } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
      if (imageRatios.size >= 8192) imageRatios.delete(imageRatios.keys().next().value);
      imageRatios.set(filePath, ratio);
    }
    const ratio = imageRatios.get(filePath);
    if (ratio) { width = ratio; height = 1; }
  }
  // Bound unusually wide banners so they cannot consume an entire card.
  return Math.max(0.25, Math.min(4, width > 0 && height > 0 ? width / height : 1));
}

function graphemes(text) {
  return Array.from(segmenter.segment(String(text || '')), item => item.segment);
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      /(^|\.)(hdslb\.com|biliimg\.com)$/.test(url.hostname)) {
      url.protocol = 'https:';
      return url.href;
    }
  } catch {}
  return '';
}

function parseObject(value) {
  if (typeof value === 'string' && value.length <= 256 * 1024) {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseEmoticons(command, text) {
  const info = command?.info || [];
  const meta = info[0] || [];
  const extra = parseObject(parseObject(meta[15]).extra);
  const data = parseObject(command?.data);
  const whole = parseObject(meta[13]);
  const candidates = [];
  if (whole.url && (Number(meta[12]) === 1 || whole.emoticon_unique)) candidates.push([text, whole]);
  for (const collection of [extra.emots, data.emots, data.emoticons, parseObject(meta[15]).emots]) {
    for (const [token, value] of Object.entries(parseObject(collection))) candidates.push([token, parseObject(value)]);
  }
  const result = new Map();
  for (const [token, value] of candidates.slice(0, 256)) {
    const url = imageUrl(value.url || value.emoticon_url);
    if (url && token && token.length <= 256 && String(text).includes(token)) {
      result.set(token, { token, url, width: Math.max(1, Math.min(1024, Number(value.width) || 1)),
        height: Math.max(1, Math.min(1024, Number(value.height) || 1)) });
    }
  }
  return Array.from(result.values());
}

function unicodeKey(text) {
  // Text-presentation symbols remain text unless VS16 asks for emoji.
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text) || text.includes('\ufe0e')) return '';
  if (!/\p{Emoji_Presentation}|\ufe0f|\u20e3/u.test(text)) return '';
  const code = Array.from(text).map(c => c.codePointAt(0).toString(16)).join('-');
  return code;
}

function loadArtwork() {
  if (!artwork) {
    const root = process.env.BILI_RECORD_APP_ROOT ||
      (fs.existsSync(path.join(__dirname, 'assets', 'emoji')) ? __dirname : path.resolve(__dirname, '../../..'));
    artwork = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'assets/emoji/twemoji-17.0.3.json.gz'))));
  }
  return artwork;
}

function unicodeAsset(text) {
  const rawCode = unicodeKey(text);
  if (!rawCode) return null;
  const images = loadArtwork();
  const code = [rawCode, rawCode.replace(/-fe0f/g, '')].find(key => images[key]);
  if (!code) return null;
  if (!materialized.has(code) || !fs.existsSync(materialized.get(code).filePath)) {
    // Acceptance tools and the system service may run as different users.
    // Each owns its private cache; never share a 0700 directory across users.
    const owner = crypto.createHash('sha1').update(os.userInfo().username).digest('hex').slice(0, 12);
    const directory = path.join(os.tmpdir(), 'br2k-emoji-twemoji-17.0.3-' + owner);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, code + '.png');
    const body = Buffer.from(images[code], 'base64');
    // Recreate a missing/corrupt cache entry; never trust externally supplied paths.
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(body)) {
      const temporary = filePath + '.' + process.pid + '.' + crypto.randomUUID();
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, filePath);
    }
    materialized.set(code, { key: 'unicode:' + code, filePath, text });
  }
  return materialized.get(code);
}

function emojiAssetId(key) {
  return 'emoji-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function resolveEmojiText(event, assets = {}) {
  let text = String(event?.text || '');
  const tokens = {};
  const reused = new Map();
  let nextToken = 0xe000;
  const add = (token, asset) => {
    const key = asset.key + '|' + token;
    if (reused.has(key)) return reused.get(key);
    while (text.includes(String.fromCodePoint(nextToken))) nextToken++;
    const placeholder = String.fromCodePoint(nextToken++);
    tokens[placeholder] = { ...asset, text: token };
    reused.set(key, placeholder);
    return placeholder;
  };
  for (const emote of (event?.emoticons || []).slice(0, 256).sort((a, b) => b.token.length - a.token.length)) {
    const url = imageUrl(emote.url);
    const supplied = assets[url] || assets[emote.url] || assets[url.replace(/^https:/, 'http:')];
    if (!emote.token || !url || !supplied?.filePath) continue;
    const placeholder = add(emote.token, { width: emote.width, height: emote.height, ...supplied, key: 'remote:' + url, url });
    text = text.split(emote.token).join(placeholder);
  }
  text = graphemes(text).map(glyph => {
    const asset = unicodeAsset(glyph);
    return asset ? add(glyph, asset) : glyph;
  }).join('');
  return { ...event, text, emojiTokens: tokens };
}

function maskEmojiText(event, assets = {}) {
  const resolved = resolveEmojiText(event, assets);
  // Keep token identities through wrapping/measurement. ASS masks them only
  // when emitting dialogue, with the same width reserved by Scene layout.
  const output = { ...resolved };
  for (const field of ['user', 'giftName']) {
    if (event[field]) output[field] = graphemes(event[field]).map(c => unicodeAsset(c) ? '\u3000' : c).join('');
  }
  return output;
}

// Old versions wrote an empty V2 notification after each real GUARD_BUY.
// Filter only that known malformed record, including in old JSONL/Scene caches.
function isEmptyGuardToast(event) {
  return event?.type === 'guard' && /^USER_TOAST_MSG(?:_V2)?$/.test(event.sourceCmd || '') &&
    !Number(event.uid) && !String(event.user || '').trim() && !Number(event.guardLevel) &&
    !Number(event.totalPrice || event.price);
}

module.exports = { graphemes, imageUrl, parseEmoticons, unicodeAsset, emojiAssetId, emojiWidthFactor, resolveEmojiText, maskEmojiText, isEmptyGuardToast };
