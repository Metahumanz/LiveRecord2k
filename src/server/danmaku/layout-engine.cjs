'use strict';

// The layout engine is deliberately renderer-neutral. It owns the parts that
// used to be intertwined with ASS tags: text metrics, wrapping, card geometry,
// lane allocation, collision handling, z-order and temporal motion. ASS,
// browser and direct FFmpeg renderers consume its output rather than making
// their own placement decisions.

const STYLE_PRESETS = require('../../shared/danmaku-style-presets.json');
const {
  createMessageTimeline: createLegacyMessageTimeline,
  getMessageItemMetrics: getLegacyMessageItemMetrics,
  resolveDanmakuStyle: resolveLegacyDanmakuStyle,
  adaptDanmakuStyleToVideo: adaptLegacyDanmakuStyleToVideo
} = require('./ass.cjs');

const DEFAULT_STYLE = {
  playWidth: 1920,
  playHeight: 1080,
  fontFamily: process.platform === 'linux' ? 'Noto Sans CJK SC' : 'Microsoft YaHei',
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
  giftWidth: 360,
  giftHeight: 58,
  giftAreaHeight: 260,
  giftGap: 10,
  giftRadius: 10,
  giftFontSize: 22,
  giftScrollDuration: 5,
  visualPreset: 'current'
};

// Keep the legacy/default rolling style in the Scene Graph.  The three
// side-stream styles are additions, not replacements.
const SCENE_STYLE_PRESETS = ['current', 'h5-card', 'bubble', 'minimal'];
const MESSAGE_ANIMATION_SEC = 0.25;
const MAX_SCENE_DURATION_SEC = 86400;

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
}

function round(value, places) {
  const multiplier = Math.pow(10, Number(places) || 2);
  return Math.round((Number(value) || 0) * multiplier) / multiplier;
}

function normalizeStylePreset(value) {
  const preset = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(STYLE_PRESETS, preset) ? preset : 'current';
}

function normalizeOverlayMode(value) {
  return value === 'danmaku' ? 'danmaku' : 'danmaku-gift';
}

function normalizeDisplayArea(value) {
  return ['quarter', 'half', 'three-quarter', 'no-overlap', 'unlimited'].includes(String(value || ''))
    ? String(value)
    : 'half';
}

function toFinite(value, fallback, minimum, maximum, integer) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  const bounded = clamp(safe, minimum, maximum);
  return integer ? Math.round(bounded) : bounded;
}

function resolveStyle(styleValues, presetValue, layoutValues) {
  const preset = normalizeStylePreset(presetValue || styleValues && styleValues.visualPreset);
  const source = styleValues && typeof styleValues === 'object' ? styleValues : {};
  const overrides = layoutValues && typeof layoutValues === 'object' ? layoutValues : {};
  const presetStyle = STYLE_PRESETS[preset] && STYLE_PRESETS[preset].style ? STYLE_PRESETS[preset].style : {};
  const merged = Object.assign({}, DEFAULT_STYLE, source, presetStyle, overrides, { visualPreset: preset });
  return {
    playWidth: toFinite(merged.playWidth, DEFAULT_STYLE.playWidth, 160, 16384, true),
    playHeight: toFinite(merged.playHeight, DEFAULT_STYLE.playHeight, 160, 16384, true),
    fontFamily: String(merged.fontFamily || DEFAULT_STYLE.fontFamily).replace(/["']/g, '').trim() || DEFAULT_STYLE.fontFamily,
    danmakuFontSize: toFinite(merged.danmakuFontSize, DEFAULT_STYLE.danmakuFontSize, 12, 160),
    danmakuOutline: toFinite(merged.danmakuOutline, DEFAULT_STYLE.danmakuOutline, 0, 12),
    danmakuLanes: toFinite(merged.danmakuLanes, DEFAULT_STYLE.danmakuLanes, 1, 48, true),
    danmakuDuration: toFinite(merged.danmakuDuration, DEFAULT_STYLE.danmakuDuration, 2, 30),
    danmakuTop: toFinite(merged.danmakuTop, DEFAULT_STYLE.danmakuTop, 0, 4000),
    danmakuLineHeight: toFinite(merged.danmakuLineHeight, DEFAULT_STYLE.danmakuLineHeight, 16, 240),
    boxFontSize: toFinite(merged.boxFontSize, DEFAULT_STYLE.boxFontSize, 12, 128),
    panelLeft: toFinite(merged.panelLeft, DEFAULT_STYLE.panelLeft, 0, 4000),
    superChatLanes: toFinite(merged.superChatLanes, DEFAULT_STYLE.superChatLanes, 1, 20, true),
    superChatBottom: toFinite(merged.superChatBottom, DEFAULT_STYLE.superChatBottom, -4000, 8000),
    superChatWidth: toFinite(merged.superChatWidth, DEFAULT_STYLE.superChatWidth, 120, 2400),
    superChatGap: toFinite(merged.superChatGap, DEFAULT_STYLE.superChatGap, 0, 160),
    messageDuration: toFinite(merged.messageDuration, DEFAULT_STYLE.messageDuration, 0, MAX_SCENE_DURATION_SEC),
    giftLanes: toFinite(merged.giftLanes, DEFAULT_STYLE.giftLanes, 1, 24, true),
    giftBottom: toFinite(merged.giftBottom, DEFAULT_STYLE.giftBottom, 0, 8000),
    giftWidth: toFinite(merged.giftWidth, DEFAULT_STYLE.giftWidth, 120, 2400),
    giftHeight: toFinite(merged.giftHeight, DEFAULT_STYLE.giftHeight, 20, 400),
    giftAreaHeight: toFinite(merged.giftAreaHeight, DEFAULT_STYLE.giftAreaHeight, 20, 2000),
    giftGap: toFinite(merged.giftGap, DEFAULT_STYLE.giftGap, 0, 160),
    giftRadius: toFinite(merged.giftRadius, DEFAULT_STYLE.giftRadius, 0, 200),
    giftFontSize: toFinite(merged.giftFontSize, DEFAULT_STYLE.giftFontSize, 10, 96),
    giftScrollDuration: toFinite(merged.giftScrollDuration, DEFAULT_STYLE.giftScrollDuration, 2, 30),
    visualPreset: preset
  };
}

function normalizeCanvas(videoInfo) {
  const width = Math.round(Number(videoInfo && videoInfo.width || 0));
  const height = Math.round(Number(videoInfo && videoInfo.height || 0));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 160 || width > 16384 || height > 16384) {
    return null;
  }
  return { width, height };
}

function adaptStyleToCanvas(styleValues, videoInfo) {
  const style = resolveStyle(styleValues, styleValues && styleValues.visualPreset);
  const canvas = normalizeCanvas(videoInfo);
  if (!canvas) return style;
  const baseWidth = Math.max(1, Number(style.playWidth) || DEFAULT_STYLE.playWidth);
  const baseHeight = Math.max(1, Number(style.playHeight) || DEFAULT_STYLE.playHeight);
  const scale = Math.sqrt((canvas.width * canvas.height) / (baseWidth * baseHeight));
  const metric = (value) => round(Math.max(0, Number(value) || 0) * scale);
  const panelLeft = clamp(metric(style.panelLeft), 0, canvas.width);
  const rightMargin = Math.max(8, metric(12));
  const maximumPanelWidth = Math.max(1, canvas.width - panelLeft - rightMargin);
  const minimumPanelWidth = Math.min(220, maximumPanelWidth);
  const anchorFromBottom = (value) => clamp(canvas.height - (baseHeight - (Number(value) || 0)) * scale, 0, canvas.height);
  return Object.assign({}, style, {
    playWidth: canvas.width,
    playHeight: canvas.height,
    danmakuFontSize: metric(style.danmakuFontSize),
    danmakuOutline: metric(style.danmakuOutline),
    danmakuTop: metric(style.danmakuTop),
    danmakuLineHeight: Math.max(1, metric(style.danmakuLineHeight)),
    boxFontSize: metric(style.boxFontSize),
    panelLeft,
    superChatBottom: anchorFromBottom(style.superChatBottom),
    superChatWidth: clamp(Math.max(minimumPanelWidth, metric(style.superChatWidth)), 1, maximumPanelWidth),
    superChatGap: metric(style.superChatGap),
    giftBottom: anchorFromBottom(style.giftBottom),
    giftWidth: clamp(metric(style.giftWidth), 1, maximumPanelWidth),
    giftHeight: Math.max(1, metric(style.giftHeight)),
    giftAreaHeight: Math.max(1, metric(style.giftAreaHeight)),
    giftGap: metric(style.giftGap),
    giftRadius: metric(style.giftRadius),
    giftFontSize: metric(style.giftFontSize)
  });
}

function eventTime(event) {
  const preferred = Number(event && event.videoTime);
  if (Number.isFinite(preferred)) return Math.max(0, preferred);
  const legacy = Number(event && event.time);
  return Number.isFinite(legacy) ? Math.max(0, legacy) : 0;
}

function eventDuration(event, style) {
  if (event && event.type === 'danmaku') {
    return clamp(Number(style && style.danmakuDuration) || DEFAULT_STYLE.danmakuDuration, 0.01, MAX_SCENE_DURATION_SEC);
  }
  const override = Number(event && event.cardDuration);
  if (Number.isFinite(override) && override > 0) return clamp(override, 0.01, MAX_SCENE_DURATION_SEC);
  const configured = Number(style && style.messageDuration);
  if (Number.isFinite(configured) && configured > 0) return clamp(configured, 0.01, MAX_SCENE_DURATION_SEC);
  const sourceDuration = Number(event && event.duration);
  return clamp(sourceDuration > 0 ? sourceDuration : DEFAULT_STYLE.messageDuration, 0.01, MAX_SCENE_DURATION_SEC);
}

function glyphWidthFactor(character) {
  if (!character) return 0;
  const code = character.codePointAt(0) || 0;
  if (/\s/.test(character)) return 0.34;
  if (code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) return 1;
  if (code >= 0x2e80 || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) return 1;
  if (/[A-Z0-9]/.test(character)) return 0.64;
  if (/[il.,'!:;]/.test(character)) return 0.3;
  if (/[mwMW@#%&]/.test(character)) return 0.88;
  return 0.56;
}

function measureText(text, fontSize) {
  const size = Math.max(1, Number(fontSize) || 1);
  return round(Array.from(String(text || '')).reduce((total, character) => total + glyphWidthFactor(character) * size, 0));
}

function truncateTextToWidth(text, maximumWidth, fontSize) {
  const source = String(text || '');
  const width = Math.max(1, Number(maximumWidth) || 1);
  if (measureText(source, fontSize) <= width) return source;
  const ellipsis = '…';
  let output = '';
  for (const character of Array.from(source)) {
    const candidate = output + character;
    if (measureText(candidate + ellipsis, fontSize) > width) break;
    output = candidate;
  }
  return output ? output + ellipsis : ellipsis;
}

function wrapTextToWidthLines(text, maximumWidth, fontSize, maximumLines) {
  const source = String(text || '');
  const width = Math.max(1, Number(maximumWidth) || 1);
  const maxLines = Math.max(1, Math.floor(Number(maximumLines) || 1));
  const lines = [];
  let line = '';
  let truncated = false;
  for (const character of Array.from(source)) {
    if (character === '\n') {
      lines.push(line);
      line = '';
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      continue;
    }
    const candidate = line + character;
    if (line && measureText(candidate, fontSize) > width) {
      lines.push(line);
      line = character;
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      continue;
    }
    line = candidate;
  }
  if (!truncated && lines.length < maxLines && line) lines.push(line);
  if (truncated && lines.length) lines[lines.length - 1] = truncateTextToWidth(lines[lines.length - 1] + '…', width, fontSize);
  return lines.length ? lines : [''];
}

function rollingVariation(event) {
  const source = String(event && event.uid || '') + '|' + String(event && event.user || '') + '|' + String(event && event.text || '') + '|' + eventTime(event).toFixed(3);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return [0.92, 0.96, 1, 1.04, 1.08][Math.abs(hash) % 5];
}

function rollingDuration(event, style) {
  return round(clamp((Number(style.danmakuDuration) || DEFAULT_STYLE.danmakuDuration) * rollingVariation(event), 2, 20));
}

function displayAreaMetrics(style, area) {
  const ratios = {
    quarter: 0.25,
    half: 0.5,
    'three-quarter': 0.75,
    'no-overlap': 1,
    unlimited: 1
  };
  const normalized = normalizeDisplayArea(area);
  const usableHeight = Math.max(style.danmakuLineHeight, style.playHeight * ratios[normalized] - style.danmakuTop);
  return {
    top: style.danmakuTop,
    lanes: Math.max(1, Math.min(style.danmakuLanes, Math.floor(usableHeight / Math.max(1, style.danmakuLineHeight)) || 1)),
    avoidOverlap: normalized === 'no-overlap'
  };
}

function layoutRolling(events, style, area) {
  const metrics = displayAreaMetrics(style, area);
  const rows = Array(metrics.lanes).fill(null);
  const serializedRows = Array(metrics.lanes).fill(0);
  const output = [];
  for (const event of events) {
    if (event.type !== 'danmaku') continue;
    const requestedStart = eventTime(event);
    const duration = rollingDuration(event, style);
    const textWidth = Math.max(1, measureText(event.text, style.danmakuFontSize));
    const travel = Math.max(1, style.playWidth + 60 + textWidth);
    const velocity = travel / duration;
    let candidate = { row: 0, start: requestedStart, score: Number.POSITIVE_INFINITY };
    for (let row = 0; row < rows.length; row += 1) {
      let start = requestedStart;
      if (metrics.avoidOverlap) {
        start = Math.max(start, serializedRows[row]);
      } else if (rows[row]) {
        const previous = rows[row];
        const clearAt = previous.start + previous.duration * previous.textWidth / previous.travel;
        start = velocity <= previous.velocity + 0.001
          ? Math.max(start, clearAt)
          : Math.max(start, previous.start + previous.duration);
      }
      if (start < candidate.score - 0.0001) candidate = { row, start, score: start };
    }
    rows[candidate.row] = { start: candidate.start, duration, textWidth, travel, velocity };
    serializedRows[candidate.row] = candidate.start + duration;
    output.push({
      kind: 'rolling',
      id: 'rolling-' + output.length,
      event,
      start: candidate.start,
      end: candidate.start + duration,
      frame: { x: style.playWidth + 60, y: metrics.top + candidate.row * style.danmakuLineHeight, width: textWidth, height: style.danmakuFontSize * 1.2 },
      motions: [{ start: candidate.start, end: candidate.start + duration, from: { x: style.playWidth + 60, y: metrics.top + candidate.row * style.danmakuLineHeight }, to: { x: -textWidth, y: metrics.top + candidate.row * style.danmakuLineHeight } }],
      zIndex: 20
    });
  }
  return output;
}

function totalGiftPrice(event) {
  const explicit = Number(event && event.totalPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const unit = Number(event && (event.unitPrice === undefined ? event.price : event.unitPrice));
  const count = Math.max(1, Number(event && event.count) || 1);
  return Number.isFinite(unit) && unit > 0 ? unit * count : 0;
}

function cardRadius(style, fontSize, width, height) {
  const configured = Number(style.giftRadius);
  return clamp(Number.isFinite(configured) && configured > 0 ? configured : fontSize / 2, 0, Math.min(width, height) / 2);
}

function messageMetrics(event, style, sideStream) {
  const preset = style.visualPreset;
  const panelWidth = Math.max(120, style.superChatWidth);
  if (sideStream && event.type === 'danmaku') {
    const fontSize = preset === 'minimal'
      ? Math.max(14, Math.floor(style.boxFontSize * 0.72))
      : Math.max(16, Math.floor(style.boxFontSize * 0.92));
    const avatar = preset === 'minimal' ? Math.max(8, Math.round(fontSize * 0.55)) : Math.max(28, Math.round(fontSize * 1.42));
    const gap = Math.max(5, Math.round(fontSize * 0.3));
    const textWidth = Math.max(fontSize * 4, panelWidth - avatar - gap * 3);
    const lines = preset === 'minimal'
      ? [truncateTextToWidth(event.text, textWidth, fontSize / 1.22)]
      : wrapTextToWidthLines(event.text, textWidth, fontSize / 1.22, 2);
    const lineHeight = Math.max(fontSize, Math.round(fontSize * 1.14));
    const height = preset === 'minimal'
      ? Math.max(avatar, Math.round(fontSize * 1.25))
      : Math.max(avatar, lines.length * lineHeight + Math.round(fontSize * 0.6));
    return { width: panelWidth, height, fontSize, metaFontSize: Math.max(12, Math.floor(fontSize * 0.64)), avatar, gap, radius: cardRadius(style, fontSize, panelWidth, height), lines, textWidth };
  }
  if (event.type === 'gift') {
    const fontSize = Math.max(12, Math.min(style.boxFontSize, style.giftFontSize));
    const metaFontSize = Math.max(12, Math.floor(fontSize * 0.8));
    const maximum = Math.max(120, Math.min(style.giftWidth, panelWidth * 0.88));
    const inset = Math.max(fontSize * 0.58, style.giftRadius / 2);
    const detail = '赠送 ' + String(event.giftName || '礼物') + ' x' + Math.max(1, Number(event.count) || 1);
    const desired = Math.max(measureText(event.user || '用户', fontSize), measureText(detail, metaFontSize)) + inset * 2 + fontSize * 0.55;
    const width = clamp(Math.ceil(desired), Math.min(maximum, Math.max(156, fontSize * 8.8)), maximum);
    const height = Math.max(style.giftHeight, fontSize + metaFontSize + style.giftRadius);
    return { width, height, fontSize, metaFontSize, avatar: Math.max(24, Math.round(fontSize * 1.25)), gap: Math.max(6, Math.round(fontSize * 0.3)), radius: cardRadius(style, fontSize, width, height), lines: [detail], textWidth: width - inset * 2 };
  }
  if (event.type === 'guard') {
    const fontSize = Math.max(12, style.boxFontSize);
    const metaFontSize = Math.max(12, Math.floor(fontSize * 0.8));
    const height = fontSize + metaFontSize + style.giftRadius;
    return { width: panelWidth, height, fontSize, metaFontSize, avatar: Math.max(26, Math.round(fontSize * 1.3)), gap: 8, radius: cardRadius(style, fontSize, panelWidth, height), lines: ['Welcome new ' + String(event.giftName || '大航海') + '!'], textWidth: panelWidth - style.giftRadius };
  }
  const fontSize = Math.max(12, style.boxFontSize);
  const metaFontSize = Math.max(12, Math.floor(fontSize * 0.8));
  const inset = Math.max(style.giftRadius / 2, fontSize / 2);
  const lines = wrapTextToWidthLines(event.text, panelWidth - inset * 2, fontSize / 1.25, 3);
  const headerHeight = fontSize + metaFontSize + style.giftRadius / 2;
  const bodyHeight = lines.length * fontSize + style.giftRadius / 2;
  return { width: panelWidth, height: headerHeight + bodyHeight, fontSize, metaFontSize, avatar: Math.max(26, Math.round(fontSize * 1.3)), gap: 8, radius: cardRadius(style, fontSize, panelWidth, headerHeight + bodyHeight), headerHeight, bodyHeight, lines, textWidth: panelWidth - inset * 2, inset };
}

function createMessageItems(events, style, sideStream) {
  const items = [];
  const liveGiftByKey = new Map();
  for (const sourceEvent of events) {
    const allowed = ['gift', 'superchat', 'guard'].includes(sourceEvent.type) || (sideStream && sourceEvent.type === 'danmaku');
    if (!allowed) continue;
    const time = eventTime(sourceEvent);
    const duration = sourceEvent.type === 'danmaku' ? Math.max(2, style.danmakuDuration) : eventDuration(sourceEvent, style);
    if (sourceEvent.type === 'gift') {
      const key = String(sourceEvent.uid || sourceEvent.user || '') + '|' + String(sourceEvent.giftName || '');
      const previous = liveGiftByKey.get(key);
      if (previous && time <= previous.end + 0.0001) {
        const prior = previous.versions[previous.versions.length - 1].event;
        const version = Object.assign({}, sourceEvent, {
          time,
          videoTime: time,
          count: Math.max(1, Number(prior.count) || 1) + Math.max(1, Number(sourceEvent.count) || 1),
          comboCount: Math.max(1, Number(prior.comboCount) || 1) + 1,
          totalPrice: totalGiftPrice(prior) + totalGiftPrice(sourceEvent)
        });
        previous.event = version;
        previous.versions.push({ time, event: version });
        previous.end = Math.max(previous.end, time + duration);
        const nextMetrics = messageMetrics(version, style, sideStream);
        previous.width = Math.max(previous.width, nextMetrics.width);
        previous.height = Math.max(previous.height, nextMetrics.height);
        continue;
      }
    }
    const event = Object.assign({}, sourceEvent, { time, videoTime: time, count: Math.max(1, Number(sourceEvent.count) || 1), comboCount: 1, totalPrice: totalGiftPrice(sourceEvent) });
    const metrics = messageMetrics(event, style, sideStream);
    const item = { id: 'message-' + items.length, order: items.length, type: event.type, start: time, end: time + duration, width: metrics.width, height: metrics.height, event, versions: [{ time, event }], metrics };
    items.push(item);
    if (event.type === 'gift') liveGiftByKey.set(String(event.uid || event.user || '') + '|' + String(event.giftName || ''), item);
  }
  return items;
}

function itemPositions(items, style) {
  const positions = new Map();
  let cursor = style.superChatBottom;
  const ordered = items.slice().sort((left, right) => left.start - right.start || left.order - right.order);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    cursor -= item.height;
    positions.set(item.id, cursor);
    cursor -= style.superChatGap;
  }
  return positions;
}

function valueAtMotion(motion, time) {
  if (time <= motion.start) return motion.fromY;
  if (time >= motion.end) return motion.toY;
  return motion.fromY + (motion.toY - motion.fromY) * (time - motion.start) / Math.max(0.0001, motion.end - motion.start);
}

function splitSegments(segments, times) {
  const output = [];
  for (const segment of segments) {
    const cuts = times.filter((time) => time > segment.start + 0.0001 && time < segment.end - 0.0001).sort((left, right) => left - right);
    const points = [segment.start].concat(cuts, [segment.end]);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const ratio = (time) => (time - segment.start) / Math.max(0.0001, segment.end - segment.start);
      output.push({ start, end, y1: segment.y1 + (segment.y2 - segment.y1) * ratio(start), y2: segment.y1 + (segment.y2 - segment.y1) * ratio(end) });
    }
  }
  return output;
}

function versionAt(item, time) {
  let selected = item.versions[0].event;
  for (const version of item.versions) {
    if (version.time > time + 0.0001) break;
    selected = version.event;
  }
  return selected;
}

function motionSegments(item, changes, style, sideStream) {
  if (!changes.length || item.end <= item.start) return [];
  let cursor = item.start;
  let motion = { start: changes[0].time, end: changes[0].time + MESSAGE_ANIMATION_SEC, fromY: changes[0].fromY, toY: changes[0].toY };
  const ySegments = [];
  const appendUntil = (limit) => {
    const safe = Math.min(limit, item.end);
    if (safe <= cursor) return;
    if (cursor < motion.end) {
      const end = Math.min(safe, motion.end);
      ySegments.push({ start: cursor, end, y1: valueAtMotion(motion, cursor), y2: valueAtMotion(motion, end) });
      cursor = end;
    }
    if (cursor < safe) {
      ySegments.push({ start: cursor, end: safe, y1: motion.toY, y2: motion.toY });
      cursor = safe;
    }
  };
  for (const change of changes.slice(1)) {
    appendUntil(change.time);
    const current = valueAtMotion(motion, change.time);
    motion = { start: change.time, end: change.time + MESSAGE_ANIMATION_SEC, fromY: current, toY: change.toY };
  }
  appendUntil(item.end);
  const exitStart = Math.max(item.start, item.end - MESSAGE_ANIMATION_SEC);
  const segments = splitSegments(ySegments, item.versions.slice(1).map((itemVersion) => itemVersion.time).concat([exitStart]));
  const xAt = (time) => {
    if (sideStream || time <= exitStart) return style.panelLeft;
    if (time >= item.end) return style.panelLeft - item.width;
    return style.panelLeft - item.width * (time - exitStart) / Math.max(0.0001, item.end - exitStart);
  };
  return segments.map((segment) => Object.assign({}, segment, {
    x1: xAt(segment.start),
    x2: xAt(segment.end),
    event: versionAt(item, segment.start)
  }));
}

function layoutMessages(events, style, sideStream) {
  const items = createMessageItems(events, style, sideStream);
  const changesById = new Map(items.map((item) => [item.id, []]));
  if (sideStream) {
    const starts = new Map();
    for (const item of items) {
      item.end = item.start + MAX_SCENE_DURATION_SEC;
      const at = starts.get(item.start) || [];
      at.push(item);
      starts.set(item.start, at);
    }
    const active = new Map();
    for (const pair of Array.from(starts.entries()).sort((left, right) => left[0] - right[0])) {
      const time = pair[0];
      const started = pair[1];
      for (const item of Array.from(active.values())) if (item.end <= time + 0.0001) active.delete(item.id);
      const before = itemPositions(Array.from(active.values()), style);
      for (const item of started) active.set(item.id, item);
      const after = itemPositions(Array.from(active.values()), style);
      const startedIds = new Set(started.map((item) => item.id));
      for (const item of active.values()) {
        const toY = after.get(item.id);
        if (startedIds.has(item.id)) {
          changesById.get(item.id).push({ time, fromY: style.superChatBottom, toY, reason: 'entry' });
        } else {
          const fromY = before.get(item.id);
          if (Number.isFinite(fromY) && Math.abs(fromY - toY) > 0.001) changesById.get(item.id).push({ time, fromY, toY, reason: 'push' });
        }
      }
      for (const item of active.values()) {
        const top = after.get(item.id);
        if (Number.isFinite(top) && top + item.height <= 0) item.end = Math.min(item.end, time + MESSAGE_ANIMATION_SEC);
      }
    }
  } else {
    const boundaries = new Map();
    const add = (time, kind, item) => {
      if (!boundaries.has(time)) boundaries.set(time, { starts: [], ends: [] });
      boundaries.get(time)[kind].push(item);
    };
    for (const item of items) {
      add(item.start, 'starts', item);
      add(item.end, 'ends', item);
    }
    const active = new Map();
    for (const pair of Array.from(boundaries.entries()).sort((left, right) => left[0] - right[0])) {
      const time = pair[0];
      const boundary = pair[1];
      const before = itemPositions(Array.from(active.values()), style);
      for (const item of boundary.ends) active.delete(item.id);
      for (const item of boundary.starts) active.set(item.id, item);
      const after = itemPositions(Array.from(active.values()), style);
      const startedIds = new Set(boundary.starts.map((item) => item.id));
      for (const item of active.values()) {
        const toY = after.get(item.id);
        if (startedIds.has(item.id)) {
          changesById.get(item.id).push({ time, fromY: style.superChatBottom, toY, reason: 'entry' });
        } else {
          const fromY = before.get(item.id);
          if (Number.isFinite(fromY) && Math.abs(fromY - toY) > 0.001) changesById.get(item.id).push({ time, fromY, toY, reason: boundary.starts.length ? 'push' : 'reflow' });
        }
      }
    }
  }
  return items.map((item) => {
    const changes = changesById.get(item.id) || [];
    return Object.assign(item, { changes, segments: motionSegments(item, changes, style, sideStream) });
  });
}

function resolvePalette(event, style) {
  const preset = style.visualPreset;
  if (event.type === 'superchat') return { background: '#B2602A', header: '#FFF5ED', accent: '#653617', text: '#FFFFFF', detail: '#313131' };
  if (event.type === 'guard') return { background: '#FCE8D8', header: '#FCE8D8', accent: '#8A3619', text: '#005029', detail: '#005443' };
  if (event.type === 'gift') return { background: '#E8F3F7', header: '#E8F3F7', accent: '#C46CFF', text: '#005029', detail: '#005443' };
  if (preset === 'bubble') return { background: '#F7E5FA', header: '#F7E5FA', accent: '#2F2230', text: '#2F2230', detail: '#514355' };
  if (preset === 'minimal') return { background: '#E9EFED', header: '#E9EFED', accent: '#323026', text: '#323026', detail: '#323026' };
  return { background: '#D7CF59', header: '#D7CF59', accent: '#3864D7', text: '#243B6B', detail: '#49618E' };
}

class LayoutEngine {
  constructor(options) {
    const source = options || {};
    this.overlayMode = normalizeOverlayMode(source.overlayMode);
    this.displayArea = normalizeDisplayArea(source.danmakuArea);
    this.sourceStyle = resolveStyle(source.style, source.stylePreset, source.styleLayout);
    this.style = adaptStyleToCanvas(this.sourceStyle, source.videoInfo);
    this.videoInfo = source.videoInfo;
  }

  layout(events) {
    const sorted = (Array.isArray(events) ? events : [])
      .filter((event) => event && ['danmaku', 'gift', 'superchat', 'guard'].includes(event.type))
      .filter((event) => this.overlayMode === 'danmaku' ? event.type === 'danmaku' : true)
      .map((event) => Object.assign({}, event, { videoTime: eventTime(event), time: eventTime(event) }))
      .sort((left, right) => eventTime(left) - eventTime(right));
    const sideStream = this.style.visualPreset !== 'current' && SCENE_STYLE_PRESETS.includes(this.style.visualPreset);
    // The three alternate styles originated in the ASS renderer.  Their
    // spacing, fixed queue lifetime and future reflow rules are observable
    // output semantics, so do not approximate them in a second layout engine.
    // Use the legacy timeline as the single source of truth and let Scene
    // Graph only translate that resolved geometry into renderer primitives.
    const legacyStyle = adaptLegacyDanmakuStyleToVideo(
      resolveLegacyDanmakuStyle(this.sourceStyle, this.sourceStyle.visualPreset),
      this.videoInfo || { width: this.style.playWidth, height: this.style.playHeight }
    );
    const entries = sideStream
      ? createLegacyMessageTimeline(sorted, legacyStyle, { includeDanmaku: true, sideStream: true }).items.map((item) => Object.assign(item, {
          kind: 'legacy-side',
          metrics: getLegacyMessageItemMetrics(item.event, legacyStyle, { sideStream: true })
        }))
      : layoutRolling(sorted, this.style, this.displayArea).concat(layoutMessages(sorted.filter((event) => event.type !== 'danmaku'), this.style, false));
    return {
      canvas: { width: this.style.playWidth, height: this.style.playHeight },
      style: sideStream ? legacyStyle : this.style,
      overlayMode: this.overlayMode,
      displayArea: this.displayArea,
      sideStream,
      entries
    };
  }
}

module.exports = {
  DEFAULT_STYLE,
  SCENE_STYLE_PRESETS,
  MESSAGE_ANIMATION_SEC,
  MAX_SCENE_DURATION_SEC,
  LayoutEngine,
  clamp,
  round,
  normalizeStylePreset,
  normalizeOverlayMode,
  normalizeDisplayArea,
  resolveStyle,
  adaptStyleToCanvas,
  normalizeCanvas,
  eventTime,
  eventDuration,
  glyphWidthFactor,
  measureText,
  truncateTextToWidth,
  wrapTextToWidthLines,
  rollingDuration,
  displayAreaMetrics,
  messageMetrics,
  layoutRolling,
  layoutMessages,
  resolvePalette,
  totalGiftPrice
};
