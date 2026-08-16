const fs = require('node:fs');
const fsp = require('node:fs/promises');
const readline = require('node:readline');
const {
  sourceTimestampFromCommand,
  sourceIdFromCommand
} = require('./dedupe.cjs');
const DANMAKU_STYLE_PRESETS = require('../../shared/danmaku-style-presets.json');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeBurnOverlayMode(value) {
  return value === 'danmaku' ? 'danmaku' : 'danmaku-gift';
}

function guardName(level) {
  if (level >= 3) return '舰长';
  if (level === 2) return '提督';
  if (level === 1) return '总督';
  return '大航海';
}

function danmakuCommandType(command) {
  return String(command?.cmd || 'UNKNOWN').split(':')[0] || 'UNKNOWN';
}

function getDanmakuEventVideoTime(event) {
  const videoTime = Number(event?.videoTime);
  if (Number.isFinite(videoTime)) return Math.max(0, videoTime);
  const legacyTime = Number(event?.time);
  return Number.isFinite(legacyTime) ? Math.max(0, legacyTime) : 0;
}

function normalizeEventTiming(timing) {
  if (typeof timing === 'number') {
    const time = Math.max(0, (Date.now() - timing) / 1000);
    return { receivedAt: Date.now(), receivedMono: 0, videoTime: time };
  }
  const receivedAt = Number(timing?.receivedAt || Date.now());
  const receivedMono = Number(timing?.receivedMono || 0);
  const videoTime = Number(timing?.videoTime);
  return {
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
    receivedMono: Number.isFinite(receivedMono) ? receivedMono : 0,
    videoTime: Number.isFinite(videoTime) ? Math.max(0, videoTime) : 0
  };
}

function normalizeSourceMeta(command, data, timing) {
  const sourceTimestamp = sourceTimestampFromCommand(command, data);
  return {
    schemaVersion: 2,
    videoTime: timing.videoTime,
    // Keep a mirrored legacy time field so existing external JSONL readers do
    // not break.  Internal ASS generation always prefers videoTime.
    time: timing.videoTime,
    receivedAt: timing.receivedAt,
    receivedMono: timing.receivedMono,
    sourceTimestamp: sourceTimestamp || undefined,
    sourceCmd: danmakuCommandType(command),
    sourceId: sourceIdFromCommand(command, data) || undefined
  };
}

function commandData(command) {
  const raw = command?.data;
  if (Array.isArray(raw)) {
    return raw.find((item) => item && typeof item === 'object') || {};
  }
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    // USER_TOAST_MSG_V2 has appeared both as a direct payload and as a
    // wrapper around the business payload across Bilibili deployments.
    return { ...raw, ...raw.data };
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function normalizeDanmakuEvent(command, timing) {
  const type = danmakuCommandType(command);
  const normalizedTiming = normalizeEventTiming(timing);

  if (type === 'DANMU_MSG') {
    const info = command.info || [];
    const text = String(info[1] || '');
    if (!text.trim()) return null;
    const uid = Number(info[2]?.[0] || 0);
    return {
      ...normalizeSourceMeta(command, commandData(command), normalizedTiming),
      type: 'danmaku',
      uid,
      text,
      user: String(info[2]?.[1] || ''),
      color: Number(info[0]?.[3] || 0xffffff)
    };
  }

  // COMBO_SEND is an update notification for a gift already represented by
  // SEND_GIFT.  It must never become a second standalone event or it inflates
  // the count during ASS aggregation.
  if (type === 'SEND_GIFT') {
    const data = commandData(command);
    const count = Number(data.num || data.combo_num || data.combo_count || 1);
    const unitPrice = Number(data.price || data.discount_price || 0) / 1000;
    const totalPrice = Number(data.total_coin || data.total_price || 0) / 1000 || unitPrice * count;
    return {
      ...normalizeSourceMeta(command, data, normalizedTiming),
      type: 'gift',
      uid: Number(data.uid || 0),
      user: String(data.uname || data.username || ''),
      giftName: String(data.giftName || data.gift_name || '礼物'),
      giftId: String(data.gift_id || data.giftId || ''),
      count,
      unitPrice,
      totalPrice,
      price: unitPrice
    };
  }

  if (type === 'SUPER_CHAT_MESSAGE' || type === 'SUPER_CHAT_MESSAGE_JPN') {
    const data = commandData(command);
    return {
      ...normalizeSourceMeta(command, data, normalizedTiming),
      type: 'superchat',
      uid: Number(data.uid || 0),
      user: String(data.user_info?.uname || data.uname || ''),
      text: String(data.message || ''),
      price: Number(data.price || 0),
      duration: Number(data.time || data.duration || 60)
    };
  }

  if (type === 'GUARD_BUY' || type === 'USER_TOAST_MSG' || type === 'USER_TOAST_MSG_V2') {
    const data = commandData(command);
    const count = Number(data.num || 1);
    const unitPrice = Number(data.price || 0) / 1000;
    return {
      ...normalizeSourceMeta(command, data, normalizedTiming),
      type: 'guard',
      uid: Number(data.uid || 0),
      user: String(data.username || data.uname || data.user_show_info?.uname || ''),
      giftName: String(data.gift_name || data.role_name || guardName(data.guard_level)),
      count,
      guardLevel: Number(data.guard_level || 0),
      unitPrice,
      totalPrice: unitPrice * count,
      price: unitPrice
    };
  }

  return null;
}

function classifyDanmakuEventIgnore(command, event) {
  const type = danmakuCommandType(command);
  if (event) return '';
  if (type === 'COMBO_SEND') return 'deliberatelyIgnored';
  if (type === 'DANMU_MSG') return 'filteredEvent';
  if (['SEND_GIFT', 'SUPER_CHAT_MESSAGE', 'SUPER_CHAT_MESSAGE_JPN', 'GUARD_BUY', 'USER_TOAST_MSG', 'USER_TOAST_MSG_V2'].includes(type)) {
    return 'malformedEvent';
  }
  return 'unsupportedCommand';
}

const DEFAULT_CJK_FONT = process.platform === 'linux' ? 'Noto Sans CJK SC' : 'Microsoft YaHei';
const DEFAULT_DANMAKU_STYLE = {
  playWidth: 1920,
  playHeight: 1080,
  fontFamily: DEFAULT_CJK_FONT,
  danmakuFontSize: 38,
  danmakuOutline: 2,
  danmakuLanes: 8,
  danmakuDuration: 8,
  danmakuTop: 36,
  danmakuLineHeight: 46,
  boxFontSize: 29,
  panelLeft: 5,
  superChatLanes: 3,
  superChatBottom: 1070,
  superChatWidth: 375,
  superChatGap: 5,
  messageDuration: 5,
  giftLanes: 4,
  giftBottom: 922,
  giftWidth: 540,
  giftHeight: 58,
  giftAreaHeight: 260,
  giftGap: 10,
  giftRadius: 10,
  giftFontSize: 22,
  giftScrollDuration: 5
};

const DEFAULT_DANMAKU_STYLE_PRESET = 'current';
const DANMAKU_STYLE_LAYOUT_LIMITS = {
  panelLeft: [0, 2000],
  superChatBottom: [0, 4000],
  superChatWidth: [220, 1200],
  boxFontSize: [12, 80],
  danmakuTop: [0, 2000],
  danmakuFontSize: [12, 96],
  danmakuLineHeight: [16, 180]
};
const DANMAKU_STYLE_CAMEL_KEYS = {
  'superchat-lanes': 'superChatLanes',
  'superchat-bottom': 'superChatBottom',
  'superchat-width': 'superChatWidth',
  'superchat-gap': 'superChatGap'
};

const LEGACY_DEFAULT_DANMAKU_STYLE = {
  boxFontSize: 30,
  panelLeft: 34,
  superChatBottom: 618,
  giftBottom: 934,
  giftWidth: 460,
  giftHeight: 46,
  giftAreaHeight: 190,
  giftGap: 8,
  giftRadius: 12,
  giftFontSize: 18
};

function normalizeDanmakuStylePreset(value) {
  const preset = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(DANMAKU_STYLE_PRESETS, preset)
    ? preset
    : DEFAULT_DANMAKU_STYLE_PRESET;
}

function getDanmakuStylePreset(value) {
  const id = normalizeDanmakuStylePreset(value);
  return { id, ...DANMAKU_STYLE_PRESETS[id] };
}

function normalizeDanmakuStyleLayout(values = {}) {
  const source = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const layout = {};
  for (const [key, [min, max]] of Object.entries(DANMAKU_STYLE_LAYOUT_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    layout[key] = clamp(value, min, max);
  }
  return layout;
}

function resolveDanmakuStyle(values = {}, presetValue, layoutValues = {}) {
  const base = normalizeDanmakuStyle(values);
  const preset = getDanmakuStylePreset(presetValue);
  return normalizeDanmakuStyle({
    ...base,
    ...(preset.style || {}),
    ...normalizeDanmakuStyleLayout(layoutValues),
    visualPreset: preset.id
  });
}

function styleValue(values, key) {
  if (!values || typeof values !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  const camelKey = DANMAKU_STYLE_CAMEL_KEYS[key] || key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  return values[camelKey];
}

// Match DanmakuFactory's lower-left SC/guard hierarchy while keeping this renderer's ASS pipeline.
// Reference: https://github.com/hihkm/DanmakuFactory/blob/master/src/AssFile/AssFile.c
const MESSAGE_CARD = {
  maxBodyLines: 3,
  metaFontScale: 0.8,
  animationDuration: 0.25,
  defaultDuration: 5,
  maxDuration: 86400
};

const DANMAKU_DISPLAY_AREAS = {
  quarter: { label: '1/4屏', ratio: 0.25, avoidOverlap: false },
  half: { label: '半屏', ratio: 0.5, avoidOverlap: false },
  'three-quarter': { label: '3/4屏', ratio: 0.75, avoidOverlap: false },
  'no-overlap': { label: '不重叠', ratio: 1, avoidOverlap: true },
  unlimited: { label: '不限', ratio: 1, avoidOverlap: false }
};

function normalizeDanmakuDisplayArea(value) {
  const area = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(DANMAKU_DISPLAY_AREAS, area) ? area : 'half';
}

function danmakuDisplayAreaLabel(value) {
  return DANMAKU_DISPLAY_AREAS[normalizeDanmakuDisplayArea(value)].label;
}

async function readDanmakuEvents(danmakuPath) {
  const result = await inspectDanmakuFile(danmakuPath, { includeEvents: true });
  return result.events;
}

async function inspectDanmakuFile(danmakuPath, options = {}) {
  const result = { eventCount: 0, durationSec: 0, events: [] };
  if (!danmakuPath) {
    return result;
  }
  const input = fs.createReadStream(danmakuPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      result.eventCount += 1;
      try {
        const event = JSON.parse(line);
        const time = getDanmakuEventVideoTime(event);
        if (Number.isFinite(time) && time > result.durationSec) {
          result.durationSec = time;
        }
        if (options.includeEvents) {
          result.events.push(event);
        }
      } catch {
        // Keep the physical event count compatible with the previous scanner.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return result;
}

async function ensureDanmakuCss(cssPath) {
  try {
    await fsp.access(cssPath);
  } catch {
    const temporary = `${cssPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, createDefaultDanmakuCss(), { encoding: 'utf8', mode: 0o660 });
    try {
      await fsp.link(temporary, cssPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }
  return cssPath;
}

async function readDanmakuStyle(cssPath) {
  const raw = await fsp.readFile(cssPath, 'utf8').catch(() => '');
  return normalizeDanmakuStyle(parseCssVariables(raw));
}

function createDefaultDanmakuCss() {
  return `/* BiliRecord2K 弹幕烧录样式。修改后重新生成字幕/烧录即可生效。 */
:root {
  --play-width: 1920;
  --play-height: 1080;
  --font-family: ${DEFAULT_CJK_FONT};
  --danmaku-font-size: 38;
  --danmaku-outline: 2;
  --danmaku-lanes: 8;
  --danmaku-duration: 8;
  --danmaku-top: 36;
  --danmaku-line-height: 46;
  --box-font-size: 29;
  --panel-left: 5;
  --superchat-lanes: 3;
  --superchat-bottom: 1070;
  --superchat-width: 375;
  --superchat-gap: 5;
  --message-duration: 5;
  --gift-lanes: 4;
  --gift-bottom: 922;
  --gift-width: 540;
  --gift-height: 58;
  --gift-area-height: 260;
  --gift-gap: 10;
  --gift-radius: 10;
  --gift-font-size: 22;
  --gift-scroll-duration: 5;
}
`;
}

function parseCssVariables(css) {
  const values = {};
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = pattern.exec(String(css || '')))) {
    values[match[1]] = match[2].trim();
  }
  return values;
}

function normalizeDanmakuStyle(values = {}) {
  const pickNumber = (key, fallback, min, max, options = {}) => {
    const raw = styleValue(values, key);
    const numeric = Number(raw ?? fallback);
    if (
      options.upgradeLegacyDefault !== undefined &&
      raw !== undefined &&
      Number.isFinite(numeric) &&
      Math.abs(numeric - options.upgradeLegacyDefault) < 0.001
    ) {
      return clamp(fallback, min, max);
    }
    return clamp(numeric, min, max);
  };
  const fontFamily = String(styleValue(values, 'font-family') || DEFAULT_DANMAKU_STYLE.fontFamily)
    .replace(/["']/g, '')
    .trim();
  return {
    playWidth: pickNumber('play-width', DEFAULT_DANMAKU_STYLE.playWidth, 640, 7680),
    playHeight: pickNumber('play-height', DEFAULT_DANMAKU_STYLE.playHeight, 360, 4320),
    fontFamily: fontFamily || DEFAULT_DANMAKU_STYLE.fontFamily,
    danmakuFontSize: pickNumber('danmaku-font-size', DEFAULT_DANMAKU_STYLE.danmakuFontSize, 12, 96),
    danmakuOutline: pickNumber('danmaku-outline', DEFAULT_DANMAKU_STYLE.danmakuOutline, 0, 8),
    danmakuLanes: Math.round(pickNumber('danmaku-lanes', DEFAULT_DANMAKU_STYLE.danmakuLanes, 1, 24)),
    danmakuDuration: pickNumber('danmaku-duration', DEFAULT_DANMAKU_STYLE.danmakuDuration, 2, 20),
    danmakuTop: pickNumber('danmaku-top', DEFAULT_DANMAKU_STYLE.danmakuTop, 0, 2000),
    danmakuLineHeight: pickNumber('danmaku-line-height', DEFAULT_DANMAKU_STYLE.danmakuLineHeight, 16, 180),
    boxFontSize: pickNumber('box-font-size', DEFAULT_DANMAKU_STYLE.boxFontSize, 12, 80, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.boxFontSize
    }),
    panelLeft: pickNumber('panel-left', DEFAULT_DANMAKU_STYLE.panelLeft, 0, 2000, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.panelLeft
    }),
    superChatLanes: Math.round(pickNumber('superchat-lanes', DEFAULT_DANMAKU_STYLE.superChatLanes, 1, 10)),
    superChatBottom: pickNumber('superchat-bottom', DEFAULT_DANMAKU_STYLE.superChatBottom, 0, 4000, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.superChatBottom
    }),
    superChatWidth: pickNumber('superchat-width', DEFAULT_DANMAKU_STYLE.superChatWidth, 220, 1200),
    superChatGap: pickNumber('superchat-gap', DEFAULT_DANMAKU_STYLE.superChatGap, 0, 100),
    messageDuration: pickNumber('message-duration', DEFAULT_DANMAKU_STYLE.messageDuration, 0, 3600),
    giftLanes: Math.round(pickNumber('gift-lanes', DEFAULT_DANMAKU_STYLE.giftLanes, 1, 16)),
    giftBottom: pickNumber('gift-bottom', DEFAULT_DANMAKU_STYLE.giftBottom, 0, 4000, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftBottom
    }),
    giftWidth: pickNumber('gift-width', DEFAULT_DANMAKU_STYLE.giftWidth, 160, 1200, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftWidth
    }),
    giftHeight: pickNumber('gift-height', DEFAULT_DANMAKU_STYLE.giftHeight, 20, 120, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftHeight
    }),
    giftAreaHeight: pickNumber('gift-area-height', DEFAULT_DANMAKU_STYLE.giftAreaHeight, 40, 1000, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftAreaHeight
    }),
    giftGap: pickNumber('gift-gap', DEFAULT_DANMAKU_STYLE.giftGap, 0, 100, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftGap
    }),
    giftRadius: pickNumber('gift-radius', DEFAULT_DANMAKU_STYLE.giftRadius, 0, 60, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftRadius
    }),
    giftFontSize: pickNumber('gift-font-size', DEFAULT_DANMAKU_STYLE.giftFontSize, 10, 60, {
      upgradeLegacyDefault: LEGACY_DEFAULT_DANMAKU_STYLE.giftFontSize
    }),
    giftScrollDuration: pickNumber('gift-scroll-duration', DEFAULT_DANMAKU_STYLE.giftScrollDuration, 2, 20),
    visualPreset: normalizeDanmakuStylePreset(styleValue(values, 'visual-preset') || values.visualPreset)
  };
}

function prepareAssEvents(events, options = {}) {
  const overlayMode = normalizeBurnOverlayMode(options.overlayMode);
  const startTime = Number(options.startTime);
  const endTime = Number(options.endTime);
  const hasStart = Number.isFinite(startTime);
  const hasEnd = Number.isFinite(endTime);
  return [...events]
    .filter((event) => {
      if (overlayMode === 'danmaku' && event.type !== 'danmaku') {
        return false;
      }
      if (!['danmaku', 'superchat', 'gift', 'guard'].includes(event.type)) {
        return false;
      }
      const eventStart = getDanmakuEventVideoTime(event);
      const eventEnd = eventStart + getDanmakuEventDuration(event, {
        messageDuration: options.messageDuration
      });
      if (hasStart && eventEnd < startTime) {
        return false;
      }
      if (hasEnd && eventStart > endTime) {
        return false;
      }
      return true;
    })
    .map((event) => {
      const videoTime = options.shiftTime && hasStart
        ? Math.max(0, getDanmakuEventVideoTime(event) - startTime)
        : getDanmakuEventVideoTime(event);
      return { ...event, videoTime, time: videoTime };
    })
    .sort((a, b) => getDanmakuEventVideoTime(a) - getDanmakuEventVideoTime(b));
}

function getDanmakuEventDuration(event, options = {}) {
  if (event.type === 'danmaku') {
    return 8;
  }
  if (['gift', 'superchat', 'guard'].includes(event.type)) {
    const eventOverride = Number(event.cardDuration);
    if (Number.isFinite(eventOverride) && eventOverride > 0) {
      return clamp(eventOverride, 0.01, MESSAGE_CARD.maxDuration);
    }
    const globalOverride = Number(options.messageDuration);
    if (Number.isFinite(globalOverride) && globalOverride > 0) {
      return clamp(globalOverride, 0.01, MESSAGE_CARD.maxDuration);
    }
    return clamp(Number(event.duration) || MESSAGE_CARD.defaultDuration, 0.01, MESSAGE_CARD.maxDuration);
  }
  return MESSAGE_CARD.defaultDuration;
}

function resolveGiftTotalPrice(event) {
  const explicit = Number(event.totalPrice || 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const unit = Number(event.unitPrice ?? event.price ?? 0);
  const count = Number(event.count || 1);
  return Number.isFinite(unit) && unit > 0 ? unit * Math.max(1, count) : 0;
}

function createAss(events, options = {}) {
  const overlayMode = normalizeBurnOverlayMode(options.overlayMode);
  const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea);
  const style =
    Object.prototype.hasOwnProperty.call(options, 'stylePreset') || Object.prototype.hasOwnProperty.call(options, 'styleLayout')
      ? resolveDanmakuStyle(options.style, options.stylePreset, options.styleLayout)
      : normalizeDanmakuStyle(options.style);
  const sorted = prepareAssEvents(events, {
    overlayMode,
    startTime: options.startTime,
    endTime: options.endTime,
    shiftTime: options.shiftTime,
    messageDuration: style.messageDuration
  });
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${style.playWidth}`,
    `PlayResY: ${style.playHeight}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Danmaku,${style.fontFamily},${style.danmakuFontSize},&H00FFFFFF,&H000000FF,&H96000000,&H64000000,0,0,0,0,100,100,0,0,1,${style.danmakuOutline},0,7,20,20,20,1`,
    `Style: BoxText,${style.fontFamily},${style.boxFontSize},&H00FFFFFF,&H000000FF,&H32000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1`,
    'Style: Shape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const danmakuLayout = getDanmakuLayoutMetrics(style, danmakuArea);
  const danmakuRows = Array(danmakuLayout.lanes).fill(0);

  for (const event of sorted) {
    if (event.type === 'danmaku') {
      const duration = style.danmakuDuration;
      const lane = danmakuLayout.avoidOverlap
        ? chooseLaneWithoutOverlap(danmakuRows, getDanmakuEventVideoTime(event), duration)
        : {
            row: chooseLane(danmakuRows, getDanmakuEventVideoTime(event), duration),
            start: getDanmakuEventVideoTime(event)
          };
      const y = danmakuLayout.top + lane.row * style.danmakuLineHeight;
      for (const line of renderRollingDanmaku(event, style, lane.start, y, duration)) {
        lines.push(line);
      }
      continue;
    }
  }

  if (overlayMode === 'danmaku-gift') {
    // A busy multi-hour stream can produce far more lines than V8 accepts as
    // one function-call argument list. Append them one by one instead of using
    // `push(...messageLines)`, which otherwise throws RangeError here.
    for (const line of renderMessageStack(sorted.filter((event) => event.type !== 'danmaku'), style)) {
      lines.push(line);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderRollingDanmaku(event, style, start, y, duration) {
  const visualPreset = visualPresetFromStyle(style);
  const fontSize = Math.max(12, Number(style.danmakuFontSize) || DEFAULT_DANMAKU_STYLE.danmakuFontSize);
  const playWidth = Math.max(1, Number(style.playWidth) || DEFAULT_DANMAKU_STYLE.playWidth);
  const playHeight = Math.max(1, Number(style.playHeight) || DEFAULT_DANMAKU_STYLE.playHeight);
  const color = assColorFromRgb(event.color || 0xffffff);

  // Preserve the established ASS output for the default preset exactly.
  if (visualPreset === DEFAULT_DANMAKU_STYLE_PRESET) {
    const width = estimateTextWidth(event.text, style.danmakuFontSize);
    return [
      dialogue(
        1,
        start,
        start + duration,
        'Danmaku',
        `{\\1c${color}\\move(${style.playWidth + 60},${y},-${width},${y})}${assEscape(event.text)}`
      )
    ];
  }

  if (visualPreset === 'minimal') {
    const width = estimateTextWidth(event.text, fontSize);
    return [
      dialogue(
        1,
        start,
        start + duration,
        'Danmaku',
        `{\\1c${color}\\1a&H20&\\bord0\\shad0\\move(${playWidth + 44},${y},-${width},${y})}${assEscape(event.text)}`
      )
    ];
  }

  const palette = rollingDanmakuPalette(visualPreset);
  const username = String(event.user || '').trim();
  const rawText = username ? `${username} · ${String(event.text || '')}` : String(event.text || '');
  const maxTextWidth = Math.max(fontSize * 3, Math.floor(playWidth * 0.68) - palette.paddingX * 2);
  const text = truncateTextToWidth(rawText, maxTextWidth, fontSize);
  const cardWidth = Math.max(fontSize * 3, estimateTextWidth(text, fontSize) + palette.paddingX * 2);
  const cardHeight = fontSize + palette.paddingY * 2;
  const cardY = clamp(y - Math.round((cardHeight - fontSize) / 2), 0, Math.max(0, playHeight - cardHeight));
  const textY = cardY + palette.paddingY;
  const cardStartX = playWidth + 48;
  const cardEndX = -cardWidth - 48;
  const movement = { x1: cardStartX, y1: cardY, x2: cardEndX, y2: cardY };

  return [
    drawRoundedRect(1, start, start + duration, cardStartX, cardY, cardWidth, cardHeight, palette.radius, palette.background, {
      move: movement
    }),
    dialogue(
      2,
      start,
      start + duration,
      'BoxText',
      `{\\an7\\bord0\\shad0\\b${palette.bold ? 1 : 0}\\fs${assNumber(fontSize)}\\1c${palette.text}\\move(${assNumber(
        cardStartX + palette.paddingX
      )},${assNumber(textY)},${assNumber(cardEndX + palette.paddingX)},${assNumber(textY)})}${assEscape(text)}`
    )
  ];
}

function rollingDanmakuPalette(visualPreset) {
  if (visualPreset === 'h5-card') {
    return {
      background: assColorFromRgbWithAlpha(0xffe9c8, 0x08),
      text: assColorFromRgb(0x422816),
      paddingX: 18,
      paddingY: 6,
      radius: 14,
      bold: true
    };
  }
  return {
    background: assColorFromRgbWithAlpha(0x30222f, 0x1c),
    text: assColorFromRgb(0xfff5fd),
    paddingX: 16,
    paddingY: 6,
    radius: 22,
    bold: false
  };
}

function createMessageItems(events, style) {
  const items = [];
  const liveGiftByKey = new Map();
  const sorted = [...events].sort((a, b) => getDanmakuEventVideoTime(a) - getDanmakuEventVideoTime(b));

  for (const sourceEvent of sorted) {
    if (!['gift', 'superchat', 'guard'].includes(sourceEvent.type)) {
      continue;
    }
    const time = getDanmakuEventVideoTime(sourceEvent);
    const duration = getDanmakuEventDuration(sourceEvent, { messageDuration: style.messageDuration });
    if (sourceEvent.type === 'gift') {
      const key = `${sourceEvent.uid || sourceEvent.user || ''}|${sourceEvent.giftName || ''}`;
      const previous = liveGiftByKey.get(key);
      if (previous && time <= previous.end + 0.0001) {
        const lastVersion = previous.versions[previous.versions.length - 1].event;
        const count = Math.max(1, Number(lastVersion.count) || 1) + Math.max(1, Number(sourceEvent.count) || 1);
        const versionEvent = {
          ...sourceEvent,
          time,
          count,
          comboCount: Math.max(1, Number(lastVersion.comboCount) || 1) + 1,
          totalPrice: resolveGiftTotalPrice(lastVersion) + resolveGiftTotalPrice(sourceEvent)
        };
        const lastVersionTime = previous.versions[previous.versions.length - 1].time;
        if (Math.abs(lastVersionTime - time) < 0.0001) {
          previous.versions[previous.versions.length - 1] = { time, event: versionEvent };
        } else {
          previous.versions.push({ time, event: versionEvent });
        }
        previous.event = versionEvent;
        previous.end = Math.max(previous.end, time + duration);
        continue;
      }
    }

    const event = {
      ...sourceEvent,
      time,
      count: Math.max(1, Number(sourceEvent.count) || 1),
      comboCount: 1,
      totalPrice: resolveGiftTotalPrice(sourceEvent)
    };
    const item = {
      id: `message-${items.length}`,
      order: items.length,
      type: event.type,
      start: time,
      end: time + duration,
      height: getMessageItemHeight(event, style),
      event,
      versions: [{ time, event }]
    };
    items.push(item);
    if (event.type === 'gift') {
      const key = `${event.uid || event.user || ''}|${event.giftName || ''}`;
      liveGiftByKey.set(key, item);
    }
  }

  return items;
}

function getMessageItemHeight(event, style) {
  if (event.type === 'superchat') {
    return getMessageCardMetrics(style, event.text).height;
  }
  if (event.type === 'guard') {
    return getGuardCardMetrics(style).height;
  }
  return getGuardCardMetrics(style).height;
}

function createMessageTimeline(events, styleValues = {}) {
  const style = Object.prototype.hasOwnProperty.call(styleValues, 'playWidth')
    ? { ...DEFAULT_DANMAKU_STYLE, ...styleValues }
    : normalizeDanmakuStyle(styleValues);
  const items = createMessageItems(events, style);
  const boundaries = new Map();
  const addBoundary = (time, kind, item) => {
    if (!boundaries.has(time)) {
      boundaries.set(time, { time, starts: [], ends: [] });
    }
    boundaries.get(time)[kind].push(item);
  };
  for (const item of items) {
    addBoundary(item.start, 'starts', item);
    addBoundary(item.end, 'ends', item);
  }

  const active = new Map();
  const changesById = new Map(items.map((item) => [item.id, []]));
  const orderedBoundaries = [...boundaries.values()].sort((a, b) => a.time - b.time);
  for (const boundary of orderedBoundaries) {
    const before = layoutMessageItems([...active.values()], style);
    for (const item of boundary.ends) {
      active.delete(item.id);
    }
    for (const item of boundary.starts) {
      active.set(item.id, item);
    }
    const after = layoutMessageItems([...active.values()], style);
    const startedIds = new Set(boundary.starts.map((item) => item.id));
    for (const item of active.values()) {
      const toY = after.get(item.id);
      if (startedIds.has(item.id)) {
        changesById.get(item.id).push({
          time: boundary.time,
          fromY: style.superChatBottom,
          toY,
          reason: 'entry'
        });
        continue;
      }
      const fromY = before.get(item.id);
      if (Number.isFinite(fromY) && Math.abs(fromY - toY) > 0.001) {
        changesById.get(item.id).push({
          time: boundary.time,
          fromY,
          toY,
          reason: boundary.starts.length ? 'push' : 'reflow'
        });
      }
    }
  }

  for (const item of items) {
    item.changes = changesById.get(item.id);
    item.segments = buildMessageMotionSegments(item, item.changes, style);
  }
  return { style, items };
}

function layoutMessageItems(items, style) {
  const positions = new Map();
  const gap = Math.max(0, Number(style.superChatGap) || 0);
  let cursor = Number(style.superChatBottom) || DEFAULT_DANMAKU_STYLE.superChatBottom;
  const ordered = [...items].sort((a, b) => a.start - b.start || a.order - b.order);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    cursor -= item.height;
    positions.set(item.id, cursor);
    cursor -= gap;
  }
  return positions;
}

function buildMessageMotionSegments(item, changes, style) {
  if (!changes.length || item.end <= item.start) {
    return [];
  }
  const animationDuration = MESSAGE_CARD.animationDuration;
  const first = changes[0];
  let cursor = item.start;
  let state = {
    start: first.time,
    end: first.time + animationDuration,
    fromY: first.fromY,
    toY: first.toY
  };
  const ySegments = [];
  const stateY = (time) => {
    if (time <= state.start) return state.fromY;
    if (time >= state.end) return state.toY;
    return state.fromY + ((state.toY - state.fromY) * (time - state.start)) / (state.end - state.start);
  };
  const appendUntil = (limit) => {
    const safeLimit = Math.min(limit, item.end);
    if (safeLimit <= cursor) return;
    if (cursor < state.end) {
      const movingEnd = Math.min(safeLimit, state.end);
      ySegments.push({ start: cursor, end: movingEnd, y1: stateY(cursor), y2: stateY(movingEnd) });
      cursor = movingEnd;
    }
    if (cursor < safeLimit) {
      ySegments.push({ start: cursor, end: safeLimit, y1: state.toY, y2: state.toY });
      cursor = safeLimit;
    }
  };

  for (const change of changes.slice(1)) {
    appendUntil(change.time);
    const currentY = stateY(change.time);
    state = {
      start: change.time,
      end: change.time + animationDuration,
      fromY: currentY,
      toY: change.toY
    };
  }
  appendUntil(item.end);

  const splitTimes = [
    ...item.versions.slice(1).map((version) => version.time),
    Math.max(item.start, item.end - animationDuration)
  ];
  const splitSegments = splitMotionSegments(ySegments, splitTimes);
  const exitStart = Math.max(item.start, item.end - animationDuration);
  const panelLeft = Number(style.panelLeft) || 0;
  const exitWidth = Math.max(1, Number(style.superChatWidth) || DEFAULT_DANMAKU_STYLE.superChatWidth);
  const xAt = (time) => {
    if (time <= exitStart) return panelLeft;
    if (time >= item.end) return panelLeft - exitWidth;
    return panelLeft - (exitWidth * (time - exitStart)) / (item.end - exitStart);
  };
  return splitSegments.map((segment) => ({
    ...segment,
    x1: xAt(segment.start),
    x2: xAt(segment.end),
    event: messageVersionAt(item, segment.start)
  }));
}

function splitMotionSegments(segments, splitTimes) {
  const output = [];
  for (const segment of segments) {
    const cuts = splitTimes
      .filter((time) => time > segment.start + 0.0001 && time < segment.end - 0.0001)
      .sort((a, b) => a - b);
    const points = [segment.start, ...cuts, segment.end];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const ratioAt = (time) => (segment.end === segment.start ? 1 : (time - segment.start) / (segment.end - segment.start));
      output.push({
        start,
        end,
        y1: segment.y1 + (segment.y2 - segment.y1) * ratioAt(start),
        y2: segment.y1 + (segment.y2 - segment.y1) * ratioAt(end)
      });
    }
  }
  return output;
}

function messageVersionAt(item, time) {
  let event = item.versions[0].event;
  for (const version of item.versions) {
    if (version.time > time + 0.0001) break;
    event = version.event;
  }
  return event;
}

function renderMessageStack(events, style) {
  const timeline = createMessageTimeline(events, style);
  const clip = {
    x1: style.panelLeft,
    y1: 0,
    x2: style.panelLeft + style.superChatWidth,
    y2: style.superChatBottom
  };
  const lines = [];
  for (const item of timeline.items) {
    for (const segment of item.segments) {
      if (segment.end - segment.start < 0.001) continue;
      if (item.type === 'superchat') {
        lines.push(...renderSuperChatCardSegment(segment.event, style, segment, clip));
      } else if (item.type === 'guard') {
        lines.push(...renderGuardCardSegment(segment.event, style, segment, clip));
      } else {
        lines.push(...renderGiftCardSegment(segment.event, style, segment, clip));
      }
    }
  }
  return lines;
}

function segmentPositionTag(segment, offsetX = 0, offsetY = 0) {
  const x1 = segment.x1 + offsetX;
  const y1 = segment.y1 + offsetY;
  const x2 = segment.x2 + offsetX;
  const y2 = segment.y2 + offsetY;
  if (Math.abs(x1 - x2) < 0.001 && Math.abs(y1 - y2) < 0.001) {
    return `\\pos(${assNumber(x1)},${assNumber(y1)})`;
  }
  return `\\move(${assNumber(x1)},${assNumber(y1)},${assNumber(x2)},${assNumber(y2)})`;
}

function segmentShapeOptions(segment, clip, offsetX = 0, offsetY = 0, corners) {
  const x1 = segment.x1 + offsetX;
  const y1 = segment.y1 + offsetY;
  const x2 = segment.x2 + offsetX;
  const y2 = segment.y2 + offsetY;
  return {
    clip,
    fade: false,
    corners,
    move:
      Math.abs(x1 - x2) < 0.001 && Math.abs(y1 - y2) < 0.001
        ? undefined
        : { x1, y1, x2, y2 }
  };
}

function renderSuperChatCardSegment(event, style, segment, clip) {
  const metrics = getMessageCardMetrics(style, event.text);
  const palette = superChatPalette(event.price || 0, style);
  const username = truncateTextToWidth(event.user || '用户', metrics.textWidth, metrics.fontSize);
  const price = formatSuperChatPrice(event.price);
  const textTag = `${clipTag(clip)}\\an7\\bord0\\shad0`;
  const shapeX = segment.x1;
  const shapeY = segment.y1;
  return [
    drawRoundedRect(
      6,
      segment.start,
      segment.end,
      shapeX,
      shapeY,
      metrics.width,
      metrics.headerHeight,
      metrics.radius,
      palette.header,
      segmentShapeOptions(segment, clip, 0, 0, { tl: true, tr: true, br: false, bl: false })
    ),
    drawRoundedRect(
      6,
      segment.start,
      segment.end,
      shapeX,
      shapeY + metrics.headerHeight,
      metrics.width,
      metrics.bodyHeight,
      metrics.radius,
      palette.body,
      segmentShapeOptions(segment, clip, 0, metrics.headerHeight, { tl: false, tr: false, br: true, bl: true })
    ),
    dialogue(
      7,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.radius / 3)}\\fs${assNumber(
        metrics.fontSize
      )}\\1c${palette.username}\\b1}${assEscape(username)}`
    ),
    dialogue(
      7,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.fontSize + metrics.radius / 3)}\\fs${assNumber(
        metrics.metaFontSize
      )}\\1c${palette.detail || '&H00313131&'}\\b0}${assEscape(`SuperChat CNY ${price}`)}`
    ),
    dialogue(
      7,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.headerHeight)}\\fs${assNumber(
        metrics.fontSize
      )}\\1c${palette.bodyText || '&H00FFFFFF&'}\\b0}${assEscape(metrics.wrappedText)}`
    )
  ];
}

function renderGuardCardSegment(event, style, segment, clip) {
  const metrics = getGuardCardMetrics(style);
  const palette = guardCardPalette(event.guardLevel, resolveGiftTotalPrice(event), style);
  const username = truncateTextToWidth(event.user || '用户', metrics.textWidth, metrics.fontSize);
  const role = event.giftName || guardName(event.guardLevel);
  const count = Math.max(1, Number(event.count) || 1);
  const welcome = `Welcome new ${role}${count > 1 ? ` x${count}` : ''}!`;
  const textTag = `${clipTag(clip)}\\an7\\bord0\\shad0`;
  return [
    drawRoundedRect(
      6,
      segment.start,
      segment.end,
      segment.x1,
      segment.y1,
      metrics.width,
      metrics.height,
      metrics.radius,
      palette.background,
      segmentShapeOptions(segment, clip)
    ),
    dialogue(
      7,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.radius / 3)}\\fs${assNumber(
        metrics.fontSize
      )}\\1c${palette.username}\\b0}${assEscape(username)}`
    ),
    dialogue(
      7,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.fontSize + metrics.radius / 3)}\\fs${assNumber(
        metrics.metaFontSize
      )}\\1c${palette.detail || '&H00313131&'}\\b0}${assEscape(
        truncateTextToWidth(welcome, metrics.textWidth, metrics.metaFontSize)
      )}`
    )
  ];
}

function renderGiftCardSegment(event, style, segment, clip) {
  const metrics = getGuardCardMetrics(style);
  const palette = giftCardPalette(resolveGiftTotalPrice(event), style);
  const username = truncateTextToWidth(event.user || '用户', metrics.textWidth, metrics.fontSize);
  const count = Math.max(1, Number(event.count) || 1);
  const giftText = `赠送 ${event.giftName || '礼物'} x${count}`;
  const textTag = `${clipTag(clip)}\\an7\\bord0\\shad0`;
  return [
    drawRoundedRect(
      6,
      segment.start,
      segment.end,
      segment.x1,
      segment.y1,
      metrics.width,
      metrics.height,
      metrics.radius,
      palette.background,
      segmentShapeOptions(segment, clip)
    ),
    drawRoundedRect(
      7,
      segment.start,
      segment.end,
      segment.x1,
      segment.y1,
      Math.max(5, metrics.radius / 2.4),
      metrics.height,
      Math.max(2, metrics.radius / 3),
      palette.accent,
      segmentShapeOptions(segment, clip, 0, 0, { tl: true, tr: false, br: false, bl: true })
    ),
    dialogue(
      8,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.radius / 3)}\\fs${assNumber(
        metrics.fontSize
      )}\\fsp0.2\\1c${palette.username}\\b1}${assEscape(username)}`
    ),
    dialogue(
      8,
      segment.start,
      segment.end,
      'BoxText',
      `{${textTag}${segmentPositionTag(segment, metrics.insetX, metrics.fontSize + metrics.radius / 3)}\\fs${assNumber(
        metrics.metaFontSize
      )}\\fsp0.15\\1c${palette.detail}\\b0}${assEscape(
        truncateTextToWidth(giftText, metrics.textWidth, metrics.metaFontSize)
      )}`
    )
  ];
}

function getMessageCardMetrics(style, text, maxLines = MESSAGE_CARD.maxBodyLines) {
  const fontSize = Math.max(12, Number(style.boxFontSize) || DEFAULT_DANMAKU_STYLE.boxFontSize);
  const width = Math.max(220, Number(style.superChatWidth) || DEFAULT_DANMAKU_STYLE.superChatWidth);
  const radius = getCardRadius(style, fontSize, width, fontSize * 2.5);
  const insetX = radius / 2;
  const metaFontSize = Math.max(12, Math.floor(fontSize * MESSAGE_CARD.metaFontScale));
  const headerHeight = fontSize + metaFontSize + radius / 2;
  const textWidth = width - insetX * 2;
  const wrappedLines = wrapTextToWidthLines(text, textWidth, fontSize / 1.25, maxLines);
  const bodyLines = wrappedLines.length ? wrappedLines : [''];
  const bodyHeight = bodyLines.length * fontSize + radius / 2;
  return {
    width,
    height: headerHeight + bodyHeight,
    radius,
    insetX,
    fontSize,
    metaFontSize,
    headerHeight,
    bodyHeight,
    textWidth,
    wrappedText: bodyLines.join('\\N')
  };
}

function getGuardCardMetrics(style) {
  const fontSize = Math.max(12, Number(style.boxFontSize) || DEFAULT_DANMAKU_STYLE.boxFontSize);
  const width = Math.max(220, Number(style.superChatWidth) || DEFAULT_DANMAKU_STYLE.superChatWidth);
  const metaFontSize = Math.max(12, Math.floor(fontSize * MESSAGE_CARD.metaFontScale));
  const radius = getCardRadius(style, fontSize, width, fontSize + metaFontSize + fontSize / 2);
  const height = fontSize + metaFontSize + radius;
  return {
    width,
    height,
    radius,
    insetX: radius / 2,
    fontSize,
    metaFontSize,
    textWidth: width - radius
  };
}

function getCardRadius(style, fontSize, width, height) {
  if (normalizeDanmakuStylePreset(style?.visualPreset) === DEFAULT_DANMAKU_STYLE_PRESET) {
    return fontSize / 2;
  }
  const configured = Number(style?.giftRadius);
  return clamp(Number.isFinite(configured) && configured > 0 ? configured : fontSize / 2, 0, Math.min(width, height) / 2);
}

function drawRect(layer, start, end, x, y, width, height, color) {
  const shape = `m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}`;
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{\\fad(120,260)\\p1\\pos(${x},${y})\\bord0\\shad0${assShapeColorTags(color)}}${shape}`
  );
}

function drawRoundedRect(layer, start, end, x, y, width, height, radius, color, options = {}) {
  const shape = roundedRectPath(width, height, radius, options.corners);
  const position = options.move
    ? `\\move(${assNumber(options.move.x1)},${assNumber(options.move.y1)},${assNumber(options.move.x2)},${assNumber(
        options.move.y2
      )})`
    : `\\pos(${assNumber(x)},${assNumber(y)})`;
  const fade = options.fade === false ? '' : '\\fad(120,260)';
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{${fade}${clipTag(options.clip)}\\p1${position}\\bord0\\shad0${assShapeColorTags(color)}}${shape}`
  );
}

function roundedRectPath(width, height, radius, corners = {}) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const r = clamp(Number(radius) || 0, 0, Math.min(w, h) / 2);
  if (r <= 0) {
    return `m 0 0 l ${assNumber(w)} 0 l ${assNumber(w)} ${assNumber(h)} l 0 ${assNumber(h)}`;
  }
  const c = r * 0.55228475;
  const corner = {
    tl: corners.tl !== false,
    tr: corners.tr !== false,
    br: corners.br !== false,
    bl: corners.bl !== false
  };
  return [
    `m ${assNumber(corner.tl ? r : 0)} 0`,
    `l ${assNumber(corner.tr ? w - r : w)} 0`,
    corner.tr
      ? `b ${assNumber(w - r + c)} 0 ${assNumber(w)} ${assNumber(r - c)} ${assNumber(w)} ${assNumber(r)}`
      : '',
    `l ${assNumber(w)} ${assNumber(corner.br ? h - r : h)}`,
    corner.br
      ? `b ${assNumber(w)} ${assNumber(h - r + c)} ${assNumber(w - r + c)} ${assNumber(h)} ${assNumber(
          w - r
        )} ${assNumber(h)}`
      : '',
    `l ${assNumber(corner.bl ? r : 0)} ${assNumber(h)}`,
    corner.bl
      ? `b ${assNumber(r - c)} ${assNumber(h)} 0 ${assNumber(h - r + c)} 0 ${assNumber(h - r)}`
      : '',
    `l 0 ${assNumber(corner.tl ? r : 0)}`,
    corner.tl
      ? `b 0 ${assNumber(r - c)} ${assNumber(r - c)} 0 ${assNumber(r)} 0`
      : ''
  ].join(' ');
}

function getDanmakuLayoutMetrics(style, areaValue) {
  const area = DANMAKU_DISPLAY_AREAS[normalizeDanmakuDisplayArea(areaValue)];
  const top = Number(style.danmakuTop) || 0;
  const lineHeight = Math.max(1, Number(style.danmakuLineHeight) || DEFAULT_DANMAKU_STYLE.danmakuLineHeight);
  const playHeight = Math.max(lineHeight, Number(style.playHeight) || DEFAULT_DANMAKU_STYLE.playHeight);
  const bottom = clamp(playHeight * area.ratio, top + lineHeight, playHeight);
  const lanes = Math.max(1, Math.floor((bottom - top) / lineHeight));
  return {
    top,
    bottom,
    lanes,
    avoidOverlap: area.avoidOverlap
  };
}

function clipTag(clip) {
  if (!clip) {
    return '';
  }
  return `\\clip(${assNumber(clip.x1)},${assNumber(clip.y1)},${assNumber(clip.x2)},${assNumber(clip.y2)})`;
}

function assNumber(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, '').replace(/\.$/, '');
}

function assShapeColorTags(color) {
  const match = /^&H([0-9a-f]{6}|[0-9a-f]{8})&$/i.exec(String(color || ''));
  if (!match) {
    return `\\1c${color}`;
  }
  const raw = match[1].toUpperCase();
  if (raw.length === 6) {
    return `\\1c&H${raw}&`;
  }
  return `\\1c&H${raw.slice(2)}&\\1a&H${raw.slice(0, 2)}&`;
}

function dialogue(layer, start, end, style, text) {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function assTime(seconds) {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text) {
  return String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

function assColorFromRgb(rgb) {
  const value = Number(rgb) || 0xffffff;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `&H00${hex2(b)}${hex2(g)}${hex2(r)}&`;
}

function assColorFromRgbWithAlpha(rgb, alpha) {
  return assColorFromRgb(rgb).replace('&H00', `&H${hex2(clamp(alpha, 0, 255))}`);
}

function hex2(value) {
  return Number(value).toString(16).padStart(2, '0').toUpperCase();
}

function visualPresetFromStyle(style) {
  return normalizeDanmakuStylePreset(typeof style === 'string' ? style : style?.visualPreset);
}

function superChatPalette(price, style) {
  const visualPreset = visualPresetFromStyle(style);
  if (visualPreset === 'h5-card') {
    return {
      header: assColorFromRgb(0xffe9c8),
      body: assColorFromRgb(0xb85a25),
      username: assColorFromRgb(0x462a14),
      detail: assColorFromRgb(0x583b25),
      bodyText: assColorFromRgb(0xffffff)
    };
  }
  if (visualPreset === 'bubble') {
    return {
      header: assColorFromRgbWithAlpha(0x484444, 0x24),
      body: assColorFromRgbWithAlpha(0x251f24, 0x1a),
      username: assColorFromRgb(0xfdf4ff),
      detail: assColorFromRgb(0xe5cfde),
      bodyText: assColorFromRgb(0xffffff)
    };
  }
  if (visualPreset === 'minimal') {
    return {
      header: assColorFromRgbWithAlpha(0x1e1b18, 0x2a),
      body: assColorFromRgbWithAlpha(0x151412, 0x32),
      username: assColorFromRgb(0xffffff),
      detail: assColorFromRgb(0xd8d2ce),
      bodyText: assColorFromRgb(0xffffff)
    };
  }
  if (price >= 2000) {
    return { header: '&H00D8D8FF&', body: '&H00321AAB&', username: '&H001B0E5E&' };
  }
  if (price >= 1000) {
    return { header: '&H00E4E7FF&', body: '&H004D4DE5&', username: '&H00333398&' };
  }
  if (price >= 500) {
    return { header: '&H00D2EAFF&', body: '&H004394E0&', username: '&H002C6193&' };
  }
  if (price >= 100) {
    return { header: '&H00C5F1FF&', body: '&H002BB5E2&', username: '&H001C7795&' };
  }
  if (price >= 50) {
    return { header: '&H00FDFFDB&', body: '&H009E7D42&', username: '&H00514022&' };
  }
  return { header: '&H00FFF5ED&', body: '&H00B2602A&', username: '&H00653617&' };
}

function guardCardPalette(level, price, style) {
  const visualPreset = visualPresetFromStyle(style);
  if (visualPreset === 'h5-card') {
    return {
      background: assColorFromRgb(0xfbe6d0),
      username: assColorFromRgb(0x723b21),
      detail: assColorFromRgb(0x62422b)
    };
  }
  if (visualPreset === 'bubble') {
    return {
      background: assColorFromRgbWithAlpha(0x433b44, 0x20),
      username: assColorFromRgb(0xfff6fd),
      detail: assColorFromRgb(0xe8d8e3)
    };
  }
  if (visualPreset === 'minimal') {
    return {
      background: assColorFromRgbWithAlpha(0x1d1b19, 0x38),
      username: assColorFromRgb(0xffffff),
      detail: assColorFromRgb(0xd8d2ce)
    };
  }
  const rank = Number(level) || 0;
  if (rank === 1) {
    return { background: '&H00E5E5FF&', username: '&H000F0F75&' };
  }
  if (rank === 2) {
    return { background: '&H00CAF9F8&', username: '&H001A8B87&' };
  }
  if (rank >= 3) {
    return { background: '&H00FCE8D8&', username: '&H008A3619&' };
  }
  if (Number(price) >= 19998) {
    return { background: '&H00E5E5FF&', username: '&H000F0F75&' };
  }
  if (Number(price) >= 1998) {
    return { background: '&H00CAF9F8&', username: '&H001A8B87&' };
  }
  return { background: '&H00FCE8D8&', username: '&H008A3619&' };
}

function giftCardPalette(price = 0, style) {
  const visualPreset = visualPresetFromStyle(style);
  if (visualPreset === 'h5-card') {
    return {
      background: assColorFromRgbWithAlpha(0xfff2e5, 0x08),
      accent: assColorFromRgb(0xe0873a),
      username: assColorFromRgb(0x613a22),
      detail: assColorFromRgb(0x6a4a35)
    };
  }
  if (visualPreset === 'bubble') {
    return {
      background: assColorFromRgbWithAlpha(0x50444e, 0x24),
      accent: assColorFromRgb(0xe0a6d3),
      username: assColorFromRgb(0xfff7fd),
      detail: assColorFromRgb(0xe4d2e0)
    };
  }
  if (visualPreset === 'minimal') {
    return {
      background: assColorFromRgbWithAlpha(0x1d1b19, 0x36),
      accent: assColorFromRgb(0xd6cec7),
      username: assColorFromRgb(0xffffff),
      detail: assColorFromRgb(0xd8d2ce)
    };
  }
  const amount = Number(price) || 0;
  if (amount >= 1000) {
    return {
      background: '&H12FFF3DF&',
      accent: '&H003CA3FF&',
      username: '&H00562E08&',
      detail: '&H00544336&'
    };
  }
  if (amount >= 100) {
    return {
      background: '&H12F8F1FF&',
      accent: '&H00D45BFF&',
      username: '&H006A238F&',
      detail: '&H00544350&'
    };
  }
  return {
    background: '&H18F7F3FF&',
    accent: '&H00C46CFF&',
    username: '&H00502980&',
    detail: '&H0054434B&'
  };
}

function formatSuperChatPrice(value) {
  const amount = Math.max(0, Number(value) || 0);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function chooseLane(lanes, start, duration) {
  let best = 0;
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] <= start) {
      best = index;
      break;
    }
    if (lanes[index] < lanes[best]) {
      best = index;
    }
  }
  lanes[best] = start + duration;
  return best;
}

function chooseLaneWithoutOverlap(lanes, start, duration) {
  let best = 0;
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] <= start) {
      best = index;
      break;
    }
    if (lanes[index] < lanes[best]) {
      best = index;
    }
  }
  const displayStart = Math.max(start, lanes[best]);
  lanes[best] = displayStart + duration;
  return { row: best, start: displayStart };
}

function estimateTextWidth(text, fontSize) {
  const length = Array.from(String(text || '')).reduce((sum, char) => {
    return sum + glyphWidthFactor(char);
  }, 0);
  return Math.ceil(length * fontSize);
}

function glyphWidthFactor(char) {
  const codePoint = String(char || '').codePointAt(0) || 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  if (/\s/u.test(char)) {
    return 0.35;
  }
  if (
    codePoint >= 0x2e80 ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27ff)
  ) {
    return 1;
  }
  if (/[A-Z]/.test(char)) {
    return 0.66;
  }
  if (/[ilI1.,'`:;|!]/.test(char)) {
    return 0.32;
  }
  return 0.58;
}

function truncateText(text, max) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= max) {
    return text || '';
  }
  return `${chars.slice(0, max - 1).join('')}…`;
}

function truncateTextToWidth(text, maxWidth, fontSize) {
  const original = String(text || '');
  const safeWidth = Math.max(20, Number(maxWidth) || 20);
  if (estimateTextWidth(original, fontSize) <= safeWidth) {
    return original;
  }
  const chars = Array.from(original.replace(/…+$/u, ''));
  let output = '';
  for (const char of chars) {
    const next = `${output}${char}`;
    if (estimateTextWidth(`${next}…`, fontSize) > safeWidth) {
      return output ? `${output}…` : '…';
    }
    output = next;
  }
  return `${output}…`;
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const chars = Array.from(String(text || ''));
  const lines = [];
  for (let index = 0; index < chars.length && lines.length < maxLines; index += maxCharsPerLine) {
    lines.push(chars.slice(index, index + maxCharsPerLine).join(''));
  }
  if (chars.length > maxCharsPerLine * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${Array.from(lines[lines.length - 1])
      .slice(0, maxCharsPerLine - 1)
      .join('')}…`;
  }
  return lines.join('\\N');
}

function wrapTextToWidth(text, maxWidth, fontSize, maxLines) {
  return wrapTextToWidthLines(text, maxWidth, fontSize, maxLines).join('\\N');
}

function wrapTextToWidthLines(text, maxWidth, fontSize, maxLines) {
  const chars = Array.from(String(text || ''));
  const safeWidth = Math.max(20, Number(maxWidth) || 20);
  const safeMaxLines = Math.max(1, Math.floor(Number(maxLines) || 1));
  const lines = [];
  let current = '';
  let truncated = false;
  let index = 0;
  for (; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\n' || char === '\r') {
      if (char === '\r' && chars[index + 1] === '\n') {
        index += 1;
      }
      lines.push(current);
      current = '';
      if (lines.length >= safeMaxLines) {
        truncated = index < chars.length - 1;
        break;
      }
      continue;
    }
    const next = `${current}${char}`;
    if (current && estimateTextWidth(next, fontSize) > safeWidth) {
      lines.push(current);
      current = char;
      if (lines.length >= safeMaxLines) {
        truncated = true;
        break;
      }
      continue;
    }
    current = next;
  }
  if (!truncated && lines.length < safeMaxLines && current) {
    lines.push(current);
  }
  if (index < chars.length - 1) {
    truncated = true;
  }
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = truncateTextToWidth(`${lines[lines.length - 1]}…`, safeWidth, fontSize);
  }
  return lines;
}

module.exports = {
  danmakuCommandType,
  getDanmakuEventVideoTime,
  normalizeDanmakuEvent,
  classifyDanmakuEventIgnore,
  DANMAKU_DISPLAY_AREAS,
  normalizeDanmakuDisplayArea,
  danmakuDisplayAreaLabel,
  inspectDanmakuFile,
  readDanmakuEvents,
  ensureDanmakuCss,
  readDanmakuStyle,
  createDefaultDanmakuCss,
  parseCssVariables,
  normalizeDanmakuStyle,
  normalizeDanmakuStylePreset,
  getDanmakuStylePreset,
  normalizeDanmakuStyleLayout,
  resolveDanmakuStyle,
  DANMAKU_STYLE_PRESETS,
  prepareAssEvents,
  getDanmakuEventDuration,
  createMessageTimeline,
  createAss,
  drawRect,
  drawRoundedRect,
  roundedRectPath,
  getDanmakuLayoutMetrics,
  dialogue,
  assTime,
  assEscape,
  assColorFromRgb,
  assShapeColorTags,
  hex2,
  superChatPalette,
  guardCardPalette,
  giftCardPalette,
  chooseLane,
  chooseLaneWithoutOverlap,
  estimateTextWidth,
  truncateText,
  truncateTextToWidth,
  wrapText,
  wrapTextToWidth,
  wrapTextToWidthLines
};
