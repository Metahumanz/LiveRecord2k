'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const readline = require('node:readline');
const crypto = require('node:crypto');
const {
  LayoutEngine,
  MESSAGE_ANIMATION_SEC,
  SCENE_STYLE_PRESETS,
  eventTime,
  resolvePalette,
  totalGiftPrice,
  round
} = require('./layout-engine.cjs');
const {
  getSideChatMetrics,
  getMinimalSideChatMetrics,
  getSideInteractionCardMetrics,
  getMinimalSideInteractionMetrics,
  getSideAvatarPlacement,
  sideChatPalette,
  sideInteractionPalette,
  sideAvatarColor,
  sideInteractionText,
  sideInteractionPrice,
  truncateTextToWidth,
  estimateTextWidth
} = require('./ass.cjs');

const SCENE_GRAPH_SCHEMA = 'bili-record2k.scene/v1';
const SCENE_GRAPH_VERSION = 1;
const SCENE_CACHE_SCHEMA = 'bili-record2k.scene-cache/v1';
const SCENE_OBJECT_TYPES = new Set(['Text', 'Avatar', 'Rect', 'Card', 'SuperChat', 'Gift']);
const SCENE_ANIMATION_TYPES = new Set(['Move', 'Fade', 'Scale']);

function stableId(prefix, source) {
  const hash = crypto.createHash('sha1').update(String(source || '')).digest('hex').slice(0, 12);
  return String(prefix || 'node') + '-' + hash;
}

function number(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number(fallback) || 0;
}

function frame(x, y, width, height) {
  return {
    x: round(x),
    y: round(y),
    width: Math.max(0, round(width)),
    height: Math.max(0, round(height))
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function animationMotions(entry, offsetX, offsetY) {
  const motions = Array.isArray(entry && entry.motions)
    ? entry.motions
    : Array.isArray(entry && entry.segments)
      ? entry.segments.map((segment) => ({
          start: segment.start,
          end: segment.end,
          from: { x: segment.x1, y: segment.y1 },
          to: { x: segment.x2, y: segment.y2 }
        }))
      : [];
  return motions
    .filter((motion) => Number.isFinite(Number(motion.start)) && Number.isFinite(Number(motion.end)) && Number(motion.end) > Number(motion.start))
    .map((motion) => ({
      type: 'Move',
      start: round(motion.start, 4),
      end: round(motion.end, 4),
      from: { x: round(number(motion.from && motion.from.x, motion.x1) + number(offsetX)), y: round(number(motion.from && motion.from.y, motion.y1) + number(offsetY)) },
      to: { x: round(number(motion.to && motion.to.x, motion.x2) + number(offsetX)), y: round(number(motion.to && motion.to.y, motion.y2) + number(offsetY)) },
      easing: 'linear'
    }));
}

function commonAnimations(entry, offsetX, offsetY) {
  const start = number(entry && entry.start);
  const end = Math.max(start + 0.001, number(entry && entry.end, start + 0.001));
  const fadeInEnd = Math.min(end, start + 0.12);
  const fadeOutStart = Math.max(start, end - 0.22);
  return animationMotions(entry, offsetX, offsetY).concat([
    { type: 'Fade', start, end: fadeInEnd, from: 0, to: 1, easing: 'ease-out' },
    { type: 'Fade', start: fadeOutStart, end, from: 1, to: 0, easing: 'ease-in' },
    { type: 'Scale', start, end: Math.min(end, start + MESSAGE_ANIMATION_SEC), from: { x: 0.96, y: 0.96 }, to: { x: 1, y: 1 }, easing: 'ease-out' }
  ]);
}

function sceneObject(type, id, entry, value) {
  const source = value || {};
  const object = {
    id,
    type,
    start: round(number(source.start, entry && entry.start), 4),
    end: round(number(source.end, entry && entry.end), 4),
    zIndex: Math.round(number(source.zIndex, entry && entry.zIndex)),
    frame: source.frame || frame(0, 0, 0, 0),
    animations: Array.isArray(source.animations) ? source.animations : [],
    props: source.props && typeof source.props === 'object' ? source.props : {},
    style: source.style && typeof source.style === 'object' ? source.style : {}
  };
  if (source.parentId) object.parentId = source.parentId;
  if (source.render === false) object.render = false;
  return object;
}

function avatarAsset(graph, event, avatarAssets) {
  const uid = Math.floor(Number(event && event.uid) || 0);
  const avatarUrl = String(event && event.avatarUrl || '').trim();
  const key = uid > 0 ? 'uid:' + uid : avatarUrl ? 'url:' + avatarUrl : '';
  if (!key) return '';
  const id = stableId('avatar', key);
  if (!graph.assets.some((asset) => asset.id === id)) {
    const supplied = avatarAssets && (avatarAssets[uid] || avatarAssets[avatarUrl]) || {};
    graph.assets.push({
      id,
      type: 'avatar',
      uid: uid || undefined,
      url: avatarUrl || String(supplied.url || ''),
      path: String(supplied.filePath || supplied.path || ''),
      integrity: String(supplied.integrity || '')
    });
  }
  return id;
}

function textObject(graph, entry, id, parentId, text, x, y, textFrame, style, props) {
  graph.objects.push(sceneObject('Text', id, entry, {
    parentId,
    zIndex: number(style.zIndex, 40),
    frame: frame(x, y, textFrame.width, textFrame.height),
    animations: commonAnimations(entry, x - number(entry && entry.frame && entry.frame.x), y - number(entry && entry.frame && entry.frame.y)),
    props: Object.assign({
      text: String(text || ''),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight || 400,
      lineHeight: style.lineHeight || style.fontSize * 1.2,
      align: style.align || 'left'
    }, props || {}),
    style: {
      fill: style.fill || '#ffffff',
      stroke: style.stroke || '',
      strokeWidth: number(style.strokeWidth),
      shadow: style.shadow || null
    }
  }));
}

function addRollingNode(graph, entry, style) {
  const event = entry.event || {};
  const id = stableId('text', entry.id + '|' + eventTime(event));
  graph.objects.push(sceneObject('Text', id, entry, {
    zIndex: entry.zIndex || 20,
    frame: entry.frame,
    animations: animationMotions(entry, 0, 0),
    props: {
      text: String(event.text || ''),
      fontFamily: style.fontFamily,
      fontSize: style.danmakuFontSize,
      fontWeight: 600,
      lineHeight: style.danmakuFontSize * 1.2,
      align: 'left'
    },
    style: {
      fill: rgbColor(event.color, '#ffffff'),
      stroke: '#000000',
      strokeWidth: style.danmakuOutline,
      shadow: { color: '#000000', blur: Math.max(1, style.danmakuOutline), offsetX: 0, offsetY: 1, opacity: 0.55 }
    }
  }));
}

function rgbColor(value, fallback) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return fallback || '#ffffff';
  return '#' + Math.max(0, Math.min(0xffffff, Math.floor(raw))).toString(16).padStart(6, '0');
}

function legacyAssColor(value, fallback) {
  const match = /^&H([0-9a-f]{8})&$/i.exec(String(value || ''));
  if (!match) return { fill: fallback || '#ffffff', opacity: 1 };
  const raw = match[1];
  const alpha = parseInt(raw.slice(0, 2), 16);
  return {
    fill: '#' + raw.slice(6, 8) + raw.slice(4, 6) + raw.slice(2, 4),
    opacity: round(1 - alpha / 255, 4)
  };
}

function legacySegmentAnimations(segment, offsetX, offsetY) {
  const x = number(offsetX);
  const y = number(offsetY);
  if (Math.abs(number(segment.x1) - number(segment.x2)) < 0.001 && Math.abs(number(segment.y1) - number(segment.y2)) < 0.001) {
    return [];
  }
  return [{
    type: 'Move',
    start: round(segment.start, 4),
    end: round(segment.end, 4),
    from: { x: round(number(segment.x1) + x), y: round(number(segment.y1) + y) },
    to: { x: round(number(segment.x2) + x), y: round(number(segment.y2) + y) },
    easing: 'linear'
  }];
}

function legacyShape(graph, id, segment, x, y, width, height, color, radius, zIndex, corners) {
  const appearance = legacyAssColor(color);
  graph.objects.push(sceneObject('Card', id, { start: segment.start, end: segment.end, zIndex }, {
    zIndex,
    frame: frame(number(segment.x1) + x, number(segment.y1) + y, width, height),
    animations: legacySegmentAnimations(segment, x, y),
    props: { role: 'legacy-ass-shape' },
    style: {
      fill: appearance.fill,
      opacity: appearance.opacity,
      cornerRadius: radius,
      corners: corners || undefined,
      // Legacy ASS shapes have no implicit Scene fade/scale or synthetic
      // shadow.  This is deliberately explicit: it keeps the CPU and CUDA
      // render plans anchored to the v0.6.7 appearance.
      shadow: null
    }
  }));
}

function legacyText(graph, id, segment, x, y, text, fontSize, color, zIndex, weight) {
  const appearance = legacyAssColor(color);
  const sourceText = String(text || '').replace(/\\N/g, '\n');
  const lines = sourceText.split('\n');
  const width = Math.max(2, Math.ceil(Math.max(...lines.map((line) => estimateTextWidth(line, fontSize)), 1) + fontSize));
  graph.objects.push(sceneObject('Text', id, { start: segment.start, end: segment.end, zIndex }, {
    zIndex,
    frame: frame(number(segment.x1) + x, number(segment.y1) + y, width, Math.max(1, fontSize * 1.25 * lines.length)),
    animations: legacySegmentAnimations(segment, x, y),
    props: {
      text: sourceText,
      fontFamily: process.platform === 'linux' ? 'Noto Sans CJK SC' : 'Microsoft YaHei',
      fontSize,
      fontWeight: weight || 400,
      lineHeight: fontSize * 1.13,
      align: 'left'
    },
    style: { fill: appearance.fill, opacity: appearance.opacity, stroke: '', strokeWidth: 0, shadow: null }
  }));
}

function addLegacyAvatar(graph, prefix, event, style, segment, avatarAssets) {
  const placement = getSideAvatarPlacement(event, style, segment);
  if (!placement) return;
  const outer = '&H88FFFFFF&';
  const inner = sideAvatarColor(event);
  const softWhite = '&H40FFFFFF&';
  const size = placement.size;
  const headSize = Math.max(4, size * 0.29);
  const shouldersWidth = Math.max(6, size * 0.64);
  const shouldersHeight = Math.max(4, size * 0.3);
  legacyShape(graph, prefix + '-avatar-ring', segment, placement.offsetX, placement.offsetY, size, size, outer, size / 2, 20);
  legacyShape(graph, prefix + '-avatar-fill', segment, placement.offsetX + placement.ringInset, placement.offsetY + placement.ringInset, placement.innerSize, placement.innerSize, inner, placement.innerSize / 2, 21);
  legacyShape(graph, prefix + '-avatar-head', segment, placement.offsetX + (size - headSize) / 2, placement.offsetY + size * 0.21, headSize, headSize, softWhite, headSize / 2, 22);
  legacyShape(graph, prefix + '-avatar-shoulders', segment, placement.offsetX + (size - shouldersWidth) / 2, placement.offsetY + size * 0.58, shouldersWidth, shouldersHeight, softWhite, shouldersHeight / 2, 22);
  // v0.6.7 rendered this vector avatar as the safe ASS fallback, then placed
  // a fetched headshot on top when one was available.  Keep both layers: a
  // missing or failed download preserves the exact fallback, while a local
  // asset retains the circular headshot in CPU and CUDA Scene paths.
  const uid = Math.floor(Number(event.uid) || 0);
  const avatarUrl = String(event.avatarUrl || '');
  const supplied = avatarAssets && (avatarAssets[uid] || avatarAssets[avatarUrl]);
  const assetPath = String(supplied && (supplied.filePath || supplied.path) || '');
  if (assetPath) {
    const assetId = avatarAsset(graph, event, avatarAssets);
    graph.objects.push(sceneObject('Avatar', prefix + '-avatar-raster', { start: segment.start, end: segment.end, zIndex: 23 }, {
      zIndex: 23,
      frame: frame(number(segment.x1) + placement.offsetX + placement.ringInset, number(segment.y1) + placement.offsetY + placement.ringInset, placement.innerSize, placement.innerSize),
      animations: legacySegmentAnimations(segment, placement.offsetX + placement.ringInset, placement.offsetY + placement.ringInset),
      props: { assetId, uid: uid || undefined, shape: 'circle', role: 'legacy-ass-avatar-raster' },
      style: { fill: '#707070', opacity: 1, cornerRadius: placement.innerSize / 2, shadow: null }
    }));
  }
}

function addLegacySideChat(graph, prefix, event, style, segment, avatarAssets) {
  if (style.visualPreset === 'minimal') {
    const metrics = getMinimalSideChatMetrics(style, event.text);
    const username = truncateTextToWidth(event.user || '观众', metrics.textWidth * 0.35, metrics.fontSize);
    const detail = truncateTextToWidth(event.text || '', metrics.textWidth - estimateTextWidth(username, metrics.fontSize), metrics.fontSize);
    const dotY = Math.max(0, (metrics.height - metrics.dotSize) / 2);
    legacyShape(graph, prefix + '-dot', segment, 0, dotY, metrics.dotSize, metrics.dotSize, sideAvatarColor(event), metrics.dotSize / 2, 20);
    legacyText(graph, prefix + '-text', segment, metrics.dotSize + metrics.gap, 0, username + ' · ' + detail, metrics.fontSize, '&H00DCE8E8&', 23, 700);
    return;
  }
  const metrics = getSideChatMetrics(style, event.text);
  const palette = sideChatPalette(style);
  const username = truncateTextToWidth(event.user || '观众', metrics.contentWidth * 0.72, metrics.metaFontSize);
  const nameWidth = Math.min(metrics.contentWidth * 0.78, Math.max(metrics.metaFontSize * 2.3, estimateTextWidth(username, metrics.metaFontSize) + metrics.metaFontSize));
  addLegacyAvatar(graph, prefix, event, style, segment, avatarAssets);
  if (metrics.metaHeight > 0) {
    legacyShape(graph, prefix + '-meta-bg', segment, metrics.contentX, 0, nameWidth, metrics.metaHeight, metrics.metaHeight / 2, palette.metaBackground, 15);
    legacyText(graph, prefix + '-meta', segment, metrics.contentX + metrics.metaFontSize / 2, Math.max(0, (metrics.metaHeight - metrics.metaFontSize) / 2), username, metrics.metaFontSize, palette.metaText, 23, 700);
  }
  legacyShape(graph, prefix + '-bubble', segment, metrics.contentX, metrics.bubbleTop, metrics.bubbleWidth, metrics.bubbleHeight, palette.bubbleBackground, palette.radius, 16);
  legacyText(graph, prefix + '-body', segment, metrics.contentX + metrics.paddingX, metrics.bubbleTop + metrics.paddingY, metrics.wrappedText, metrics.fontSize, palette.bubbleText, 23, 700);
}

function addLegacySideInteraction(graph, prefix, event, style, segment, avatarAssets) {
  if (style.visualPreset === 'minimal') {
    const metrics = getMinimalSideInteractionMetrics(style, event);
    const price = sideInteractionPrice(event);
    const textWidth = price ? metrics.textWidthWithPrice : metrics.textWidth;
    const username = truncateTextToWidth(event.user || '观众', textWidth * 0.35, metrics.fontSize);
    const detail = truncateTextToWidth(sideInteractionText(event), textWidth - estimateTextWidth(username, metrics.fontSize), metrics.fontSize);
    const dotY = Math.max(0, (metrics.height - metrics.dotSize) / 2);
    legacyShape(graph, prefix + '-card', segment, 0, 0, metrics.width, metrics.height, '&H250D1416&', metrics.radius, 16);
    legacyShape(graph, prefix + '-dot', segment, metrics.gap, dotY, metrics.dotSize, metrics.dotSize, sideAvatarColor(event), metrics.dotSize / 2, 20);
    legacyText(graph, prefix + '-body', segment, metrics.dotSize + metrics.gap * 2, metrics.paddingY, username + ' · ' + detail, metrics.fontSize, '&H00FFFFFF&', 23, 700);
    if (price) {
      const priceWidth = Math.max(54, estimateTextWidth(price, metrics.fontSize) + metrics.fontSize);
      const priceX = metrics.width - priceWidth;
      legacyShape(graph, prefix + '-price-bg', segment, priceX, metrics.paddingY, priceWidth, metrics.fontSize, '&H10E9EFED&', metrics.fontSize / 2, 24);
      legacyText(graph, prefix + '-price', segment, priceX + metrics.fontSize / 2, metrics.paddingY, price, metrics.fontSize * 0.82, '&H00323026&', 25, 700);
    }
    return;
  }
  const metrics = getSideInteractionCardMetrics(style, event);
  const palette = sideInteractionPalette(style, event);
  const price = sideInteractionPrice(event);
  const textWidth = price ? metrics.textWidthWithPrice : metrics.textWidth;
  const username = truncateTextToWidth(event.user || '观众', textWidth, metrics.fontSize);
  const detail = truncateTextToWidth(sideInteractionText(event), textWidth, metrics.metaFontSize);
  const textY = metrics.padding + Math.max(0, Math.floor((metrics.avatarSize - metrics.fontSize - metrics.metaFontSize) / 2));
  legacyShape(graph, prefix + '-card', segment, 0, 0, metrics.width, metrics.height, palette.background, metrics.radius, 16);
  addLegacyAvatar(graph, prefix, event, style, segment, avatarAssets);
  legacyText(graph, prefix + '-user', segment, metrics.contentX, textY, username, metrics.fontSize, palette.username, 23, 700);
  legacyText(graph, prefix + '-detail', segment, metrics.contentX, textY + metrics.fontSize, detail, metrics.metaFontSize, palette.detail, 23);
  if (price) {
    const priceWidth = Math.max(72, estimateTextWidth(price, metrics.metaFontSize) + metrics.metaFontSize * 1.2);
    const priceX = metrics.width - metrics.padding - priceWidth;
    legacyShape(graph, prefix + '-price-bg', segment, priceX, metrics.padding, priceWidth, metrics.metaFontSize + metrics.padding, palette.priceBackground, (metrics.metaFontSize + metrics.padding) / 2, 24);
    legacyText(graph, prefix + '-price', segment, priceX + metrics.metaFontSize * 0.6, metrics.padding + metrics.padding / 2, price, metrics.metaFontSize, palette.priceText, 25, 700);
  }
}

function addLegacySideEntry(graph, entry, style, avatarAssets) {
  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  segments.forEach((segment, index) => {
    if (number(segment.end) - number(segment.start) < 0.001) return;
    const event = segment.event || entry.event || {};
    const prefix = stableId('legacy', entry.id + '|' + index + '|' + number(segment.start));
    if (event.type === 'danmaku') addLegacySideChat(graph, prefix, event, style, segment, avatarAssets);
    else addLegacySideInteraction(graph, prefix, event, style, segment, avatarAssets);
  });
}

function addMessageNode(graph, entry, layout, avatarAssets) {
  const event = entry.event || {};
  const metrics = entry.metrics || {};
  const firstSegment = Array.isArray(entry.segments) && entry.segments.length ? entry.segments[0] : null;
  const base = firstSegment
    ? frame(firstSegment.x1, firstSegment.y1, entry.width, entry.height)
    : frame(layout.style.panelLeft, layout.style.superChatBottom - entry.height, entry.width, entry.height);
  const sharedEntry = Object.assign({}, entry, { frame: base });
  const eventId = stableId('event', entry.id + '|' + eventTime(event) + '|' + String(event.uid || event.user || ''));
  const semanticType = event.type === 'superchat' ? 'SuperChat' : event.type === 'gift' ? 'Gift' : 'Card';
  const palette = resolvePalette(event, layout.style);
  const motion = commonAnimations(sharedEntry, 0, 0);
  graph.objects.push(sceneObject(semanticType, eventId, sharedEntry, {
    zIndex: 10,
    frame: base,
    animations: motion,
    render: false,
    props: {
      eventType: event.type,
      uid: Number(event.uid || 0) || undefined,
      user: String(event.user || ''),
      sourceId: String(event.sourceId || ''),
      sourceTime: eventTime(event)
    }
  }));

  const cardId = eventId + '-card';
  graph.objects.push(sceneObject('Card', cardId, sharedEntry, {
    parentId: eventId,
    zIndex: 12,
    frame: base,
    animations: motion,
    props: { role: layout.sideStream ? 'side-card' : 'interaction-card', eventType: event.type },
    style: {
      fill: palette.background,
      opacity: layout.style.visualPreset === 'minimal' ? 0.86 : 0.94,
      cornerRadius: number(metrics.radius, layout.style.giftRadius),
      shadow: { color: '#000000', blur: Math.max(3, number(metrics.radius) * 0.7), offsetX: 0, offsetY: 2, opacity: 0.23 },
      clip: layout.sideStream ? { x: layout.style.panelLeft, y: 0, width: layout.style.superChatWidth, height: layout.style.superChatBottom } : null
    }
  }));

  const isSideChat = layout.sideStream && event.type === 'danmaku';
  const isGift = event.type === 'gift';
  const isSuperChat = event.type === 'superchat';
  const isGuard = event.type === 'guard';
  if (isSuperChat && !layout.sideStream) {
    graph.objects.push(sceneObject('Rect', eventId + '-header', sharedEntry, {
      parentId: eventId,
      zIndex: 14,
      frame: frame(base.x, base.y, base.width, number(metrics.headerHeight)),
      animations: commonAnimations(sharedEntry, 0, 0),
      props: { role: 'superchat-header' },
      style: { fill: palette.header, opacity: 1, cornerRadius: number(metrics.radius), corners: { tl: true, tr: true, bl: false, br: false } }
    }));
  }
  if (isGift) {
    graph.objects.push(sceneObject('Rect', eventId + '-accent', sharedEntry, {
      parentId: eventId,
      zIndex: 15,
      frame: frame(base.x, base.y, Math.max(5, number(metrics.radius) / 2.4), base.height),
      animations: commonAnimations(sharedEntry, 0, 0),
      props: { role: 'gift-accent' },
      style: { fill: palette.accent, opacity: 1, cornerRadius: Math.max(2, number(metrics.radius) / 3) }
    }));
  }

  const hasAvatar = layout.sideStream || isGift || isSuperChat || isGuard;
  const avatarSize = number(metrics.avatar, Math.max(24, number(metrics.fontSize) * 1.3));
  const gap = number(metrics.gap, 8);
  const contentX = hasAvatar ? avatarSize + gap * 1.5 : number(metrics.inset, number(metrics.radius) / 2);
  if (hasAvatar) {
    const assetId = avatarAsset(graph, event, avatarAssets);
    graph.objects.push(sceneObject('Avatar', eventId + '-avatar', sharedEntry, {
      parentId: eventId,
      zIndex: 25,
      frame: frame(base.x + gap, base.y + Math.max(0, (base.height - avatarSize) / 2), avatarSize, avatarSize),
      animations: commonAnimations(sharedEntry, gap, Math.max(0, (base.height - avatarSize) / 2)),
      props: { assetId, uid: Number(event.uid || 0) || undefined, fallbackLabel: String(event.user || '观众').slice(0, 1), shape: layout.style.visualPreset === 'minimal' ? 'dot' : 'circle' },
      style: { fill: palette.accent, borderColor: '#ffffff', borderWidth: 1, shadow: { color: '#000000', blur: 2, offsetX: 0, offsetY: 1, opacity: 0.25 } }
    }));
  }

  const textX = base.x + contentX;
  const user = String(event.user || '用户');
  const fontSize = number(metrics.fontSize, layout.style.boxFontSize);
  const metaFontSize = number(metrics.metaFontSize, Math.max(12, fontSize * 0.8));
  const topPadding = Math.max(4, number(metrics.radius) / 3);
  textObject(graph, sharedEntry, eventId + '-user', eventId, user, textX, base.y + topPadding, frame(0, 0, Math.max(1, base.width - contentX - gap), fontSize * 1.2), {
    fontFamily: layout.style.fontFamily,
    fontSize,
    fontWeight: 700,
    fill: palette.text,
    zIndex: 30
  });

  let detail = '';
  if (isSideChat) {
    detail = (metrics.lines || [String(event.text || '')]).join('\n');
  } else if (isGift) {
    detail = '赠送 ' + String(event.giftName || '礼物') + ' x' + Math.max(1, Number(event.count) || 1);
  } else if (isSuperChat) {
    detail = (metrics.lines || [String(event.text || '')]).join('\n');
  } else if (isGuard) {
    detail = (metrics.lines || ['Welcome new ' + String(event.giftName || '大航海') + '!']).join('\n');
  }
  const detailY = isSuperChat && !layout.sideStream
    ? base.y + number(metrics.headerHeight)
    : base.y + topPadding + fontSize * 1.15;
  const detailSize = isSuperChat && !layout.sideStream ? fontSize : metaFontSize;
  const detailColor = isSuperChat && !layout.sideStream ? '#ffffff' : palette.detail;
  textObject(graph, sharedEntry, eventId + '-detail', eventId, detail, textX, detailY, frame(0, 0, Math.max(1, base.width - contentX - gap), Math.max(detailSize * 1.3, base.height - (detailY - base.y))), {
    fontFamily: layout.style.fontFamily,
    fontSize: detailSize,
    fontWeight: 400,
    fill: detailColor,
    zIndex: 31
  }, {
    textKeyframes: (entry.versions || []).map((version) => ({
      time: number(version.time),
      text: event.type === 'gift'
        ? '赠送 ' + String(version.event.giftName || '礼物') + ' x' + Math.max(1, Number(version.event.count) || 1)
        : detail
    }))
  });
}

function buildSceneGraph(events, options) {
  const source = options || {};
  const layout = new LayoutEngine(source).layout(events);
  const graph = {
    schema: SCENE_GRAPH_SCHEMA,
    version: SCENE_GRAPH_VERSION,
    coordinateSpace: 'pixel',
    canvas: layout.canvas,
    timeline: { start: 0, end: 0 },
    style: {
      preset: layout.style.visualPreset,
      overlayMode: layout.overlayMode,
      displayArea: layout.displayArea,
      fontFamily: layout.style.fontFamily
    },
    assets: [],
    objects: [],
    metadata: {
      generator: 'LayoutEngine',
      generatedAt: new Date().toISOString(),
      sourceEventCount: Array.isArray(events) ? events.length : 0,
      layoutVersion: 1
    }
  };
  for (const entry of layout.entries) {
    if (entry.kind === 'rolling') addRollingNode(graph, entry, layout.style);
    else if (entry.kind === 'legacy-side') addLegacySideEntry(graph, entry, layout.style, source.avatarAssets);
    else addMessageNode(graph, entry, layout, source.avatarAssets);
  }
  graph.timeline.end = round(graph.objects.reduce((maximum, object) => Math.max(maximum, number(object.end)), 0), 4);
  return graph;
}

function sceneCacheRecord(event, options) {
  const source = options || {};
  const time = eventTime(event);
  const semantic = event && event.type === 'superchat' ? 'SuperChat' : event && event.type === 'gift' ? 'Gift' : event && event.type === 'danmaku' ? 'Text' : 'Card';
  return {
    schema: SCENE_CACHE_SCHEMA,
    version: SCENE_GRAPH_VERSION,
    op: 'append',
    recordedAt: Date.now(),
    event: Object.assign({}, event, { videoTime: time, time }),
    seed: {
      id: stableId('source', String(event && event.sourceId || '') + '|' + time + '|' + String(event && event.uid || '') + '|' + String(event && event.text || event && event.giftName || '')),
      type: semantic,
      start: time,
      props: { layout: 'deferred', stylePreset: source.stylePreset || '' },
      animations: [{ type: 'Fade', start: time, end: time + 0.12, from: 0, to: 1, easing: 'ease-out' }]
    }
  };
}

async function readSceneCacheEvents(cachePath) {
  const events = [];
  const target = String(cachePath || '').trim();
  if (!target) return events;
  const stream = fs.createReadStream(target, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.schema === SCENE_CACHE_SCHEMA && record.op === 'append' && record.event) events.push(record.event);
      } catch {
        // A partially written final line must not invalidate an otherwise
        // useful capture cache.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  return events;
}

async function writeSceneGraph(scenePath, graph) {
  const target = String(scenePath || '').trim();
  if (!target) throw new Error('Scene Graph 缺少输出路径。');
  assertSceneGraph(graph);
  const temporary = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    await fsp.writeFile(temporary, JSON.stringify(graph, null, 2) + '\n', { encoding: 'utf8', mode: 0o660 });
    // Windows cannot atomically replace an existing destination with rename.
    // The Scene Graph is a derived cache; raw JSONL and media remain untouched.
    await fsp.rm(target, { force: true });
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return target;
}

async function readSceneGraph(scenePath) {
  const target = String(scenePath || '').trim();
  if (!target) return null;
  try {
    const graph = JSON.parse(await fsp.readFile(target, 'utf8'));
    assertSceneGraph(graph);
    return graph;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function compactSceneCache(cachePath, scenePath, options) {
  const events = await readSceneCacheEvents(cachePath);
  let graph = buildSceneGraph(events, options);
  const requestedDuration = number(options && options.durationSec);
  if (requestedDuration > 0) {
    graph = clipSceneGraph(graph, 0, requestedDuration, { shiftTime: false });
  }
  await writeSceneGraph(scenePath, graph);
  return { graph, eventCount: events.length };
}

function assertSceneGraph(graph) {
  if (!graph || typeof graph !== 'object' || graph.schema !== SCENE_GRAPH_SCHEMA || Number(graph.version) !== SCENE_GRAPH_VERSION) {
    throw new Error('Scene Graph 格式或版本无效。');
  }
  const canvas = graph.canvas || {};
  if (!Number.isFinite(Number(canvas.width)) || !Number.isFinite(Number(canvas.height)) || Number(canvas.width) < 1 || Number(canvas.height) < 1) {
    throw new Error('Scene Graph 缺少有效画布。');
  }
  if (!Array.isArray(graph.objects)) throw new Error('Scene Graph 缺少对象数组。');
  for (const object of graph.objects) {
    if (!object || !SCENE_OBJECT_TYPES.has(object.type) || !String(object.id || '').trim()) {
      throw new Error('Scene Graph 存在不支持的对象。');
    }
    if (!Number.isFinite(Number(object.start)) || !Number.isFinite(Number(object.end)) || Number(object.end) < Number(object.start)) {
      throw new Error('Scene Graph 对象持续时间无效。');
    }
    if (!object.frame || !Number.isFinite(Number(object.frame.x)) || !Number.isFinite(Number(object.frame.y))) {
      throw new Error('Scene Graph 对象坐标无效。');
    }
    for (const animation of Array.isArray(object.animations) ? object.animations : []) {
      if (!animation || !SCENE_ANIMATION_TYPES.has(animation.type)) throw new Error('Scene Graph 存在不支持的动画。');
    }
  }
  return true;
}

function animationValue(animation, time) {
  const start = number(animation.start);
  const end = Math.max(start + 0.0001, number(animation.end, start + 0.0001));
  const progress = Math.max(0, Math.min(1, (time - start) / (end - start)));
  if (animation.type === 'Move') {
    return {
      x: number(animation.from && animation.from.x) + (number(animation.to && animation.to.x) - number(animation.from && animation.from.x)) * progress,
      y: number(animation.from && animation.from.y) + (number(animation.to && animation.to.y) - number(animation.from && animation.from.y)) * progress
    };
  }
  if (animation.type === 'Scale') {
    return {
      x: number(animation.from && animation.from.x, 1) + (number(animation.to && animation.to.x, 1) - number(animation.from && animation.from.x, 1)) * progress,
      y: number(animation.from && animation.from.y, 1) + (number(animation.to && animation.to.y, 1) - number(animation.from && animation.from.y, 1)) * progress
    };
  }
  return number(animation.from) + (number(animation.to) - number(animation.from)) * progress;
}

function evaluateSceneObject(object, time) {
  const value = {
    visible: number(time) >= number(object.start) && number(time) <= number(object.end),
    x: number(object.frame && object.frame.x),
    y: number(object.frame && object.frame.y),
    scaleX: 1,
    scaleY: 1,
    opacity: number(object.style && object.style.opacity, 1)
  };
  if (!value.visible) return value;
  const animations = (Array.isArray(object.animations) ? object.animations : [])
    .filter((animation) => animation && SCENE_ANIMATION_TYPES.has(animation.type))
    .slice()
    .sort((left, right) => number(left.start) - number(right.start) || number(left.end) - number(right.end));
  for (const animation of animations) {
    if (time < number(animation.start)) continue;
    // Scene animations retain their end state until a later animation changes
    // it. This is important for multi-step card reflow and matches the direct
    // renderer's FFmpeg expressions.
    const animationState = animationValue(animation, Math.min(number(time), number(animation.end)));
    if (animation.type === 'Move') {
      value.x = animationState.x;
      value.y = animationState.y;
    } else if (animation.type === 'Scale') {
      value.scaleX *= animationState.x;
      value.scaleY *= animationState.y;
    } else if (animation.type === 'Fade') {
      value.opacity *= animationState;
    }
  }
  return value;
}

function clipAnimation(animation, start, end, shift) {
  const sourceStart = number(animation.start);
  const sourceEnd = number(animation.end);
  if (sourceEnd < start || sourceStart > end) return null;
  const clippedStart = Math.max(start, sourceStart);
  const clippedEnd = Math.min(end, sourceEnd);
  const next = clone(animation);
  if (animation.type === 'Move' || animation.type === 'Scale') {
    const atStart = animationValue(animation, clippedStart);
    const atEnd = animationValue(animation, clippedEnd);
    next.from = atStart;
    next.to = atEnd;
  } else if (animation.type === 'Fade') {
    next.from = animationValue(animation, clippedStart);
    next.to = animationValue(animation, clippedEnd);
  }
  next.start = round(clippedStart - shift, 4);
  next.end = round(clippedEnd - shift, 4);
  return next;
}

function clipSceneGraph(graph, startTime, endTime, options) {
  assertSceneGraph(graph);
  const start = Math.max(0, number(startTime));
  const end = Math.max(start, number(endTime, graph.timeline && graph.timeline.end));
  const shift = options && options.shiftTime === false ? 0 : start;
  // A long recording may contain thousands of objects. Do not deep-clone the
  // whole graph before retaining only one time window: that turns Scene Graph
  // chunking into quadratic work and can itself delay the first frame.
  const output = Object.assign({}, graph, {
    canvas: clone(graph.canvas || {}),
    assets: clone(graph.assets || []),
    metadata: Object.assign({}, graph.metadata || {}),
    timeline: { start: round(start - shift, 4), end: round(end - shift, 4) }
  });
  output.objects = graph.objects
    .filter((object) => number(object.end) >= start && number(object.start) <= end)
    .map((object) => {
      const next = clone(object);
      const objectStart = Math.max(start, number(object.start));
      const objectEnd = Math.min(end, number(object.end));
      const state = evaluateSceneObject(object, objectStart);
      next.start = round(objectStart - shift, 4);
      next.end = round(objectEnd - shift, 4);
      next.frame.x = round(state.x);
      next.frame.y = round(state.y);
      next.animations = (object.animations || [])
        .map((animation) => clipAnimation(animation, objectStart, objectEnd, shift))
        .filter(Boolean);
      return next;
    });
  output.metadata = Object.assign({}, output.metadata, { clippedFrom: { start, end, shift } });
  return output;
}

function sceneTrackStyles(value) {
  if (SCENE_STYLE_PRESETS.includes(String(value || ''))) return [String(value)];
  return SCENE_STYLE_PRESETS.slice();
}

module.exports = {
  SCENE_GRAPH_SCHEMA,
  SCENE_GRAPH_VERSION,
  SCENE_CACHE_SCHEMA,
  SCENE_OBJECT_TYPES,
  SCENE_ANIMATION_TYPES,
  SCENE_STYLE_PRESETS,
  stableId,
  sceneCacheRecord,
  buildSceneGraph,
  writeSceneGraph,
  readSceneGraph,
  readSceneCacheEvents,
  compactSceneCache,
  assertSceneGraph,
  evaluateSceneObject,
  animationValue,
  clipSceneGraph,
  sceneTrackStyles
};
