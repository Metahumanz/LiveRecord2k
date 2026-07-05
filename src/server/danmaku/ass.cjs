const fsp = require('node:fs/promises');

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

function normalizeDanmakuEvent(command, startedAt) {
  const type = danmakuCommandType(command);
  const time = Math.max(0, (Date.now() - startedAt) / 1000);

  if (type === 'DANMU_MSG') {
    const info = command.info || [];
    return {
      type: 'danmaku',
      time,
      text: String(info[1] || ''),
      user: String(info[2]?.[1] || ''),
      color: Number(info[0]?.[3] || 0xffffff)
    };
  }

  if (type === 'SEND_GIFT' || type === 'COMBO_SEND') {
    const data = command.data || {};
    const count = Number(data.num || data.combo_num || data.combo_count || 1);
    const unitPrice = Number(data.price || data.discount_price || 0) / 1000;
    const totalPrice = Number(data.total_coin || data.total_price || 0) / 1000 || unitPrice * count;
    return {
      type: 'gift',
      time,
      uid: Number(data.uid || 0),
      user: String(data.uname || data.username || ''),
      giftName: String(data.giftName || data.gift_name || '礼物'),
      count,
      unitPrice,
      totalPrice,
      price: unitPrice
    };
  }

  if (type === 'SUPER_CHAT_MESSAGE' || type === 'SUPER_CHAT_MESSAGE_JPN') {
    const data = command.data || {};
    return {
      type: 'superchat',
      time,
      uid: Number(data.uid || 0),
      user: String(data.user_info?.uname || data.uname || ''),
      text: String(data.message || ''),
      price: Number(data.price || 0),
      duration: Number(data.time || data.duration || 60)
    };
  }

  if (type === 'GUARD_BUY' || type === 'USER_TOAST_MSG') {
    const data = command.data || {};
    const count = Number(data.num || 1);
    const unitPrice = Number(data.price || 0) / 1000;
    return {
      type: 'guard',
      time,
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

const DEFAULT_DANMAKU_STYLE = {
  playWidth: 1920,
  playHeight: 1080,
  fontFamily: 'Microsoft YaHei',
  danmakuFontSize: 38,
  danmakuOutline: 2,
  danmakuLanes: 8,
  danmakuDuration: 8,
  danmakuTop: 36,
  danmakuLineHeight: 46,
  boxFontSize: 30,
  panelLeft: 34,
  superChatLanes: 3,
  superChatBottom: 618,
  giftLanes: 4,
  giftBottom: 934,
  giftWidth: 460,
  giftHeight: 46,
  giftAreaHeight: 190,
  giftGap: 8,
  giftRadius: 12,
  giftFontSize: 18,
  giftScrollDuration: 5
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
  const raw = await fsp.readFile(danmakuPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function ensureDanmakuCss(cssPath) {
  try {
    await fsp.access(cssPath);
  } catch {
    await fsp.writeFile(cssPath, createDefaultDanmakuCss(), 'utf8');
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
  --font-family: Microsoft YaHei;
  --danmaku-font-size: 38;
  --danmaku-outline: 2;
  --danmaku-lanes: 8;
  --danmaku-duration: 8;
  --danmaku-top: 36;
  --danmaku-line-height: 46;
  --box-font-size: 30;
  --panel-left: 34;
  --superchat-lanes: 3;
  --superchat-bottom: 618;
  --gift-lanes: 4;
  --gift-bottom: 934;
  --gift-width: 460;
  --gift-height: 46;
  --gift-area-height: 190;
  --gift-gap: 8;
  --gift-radius: 12;
  --gift-font-size: 18;
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
  const pickNumber = (key, fallback, min, max) => clamp(Number(values[key] ?? fallback), min, max);
  const fontFamily = String(values['font-family'] || DEFAULT_DANMAKU_STYLE.fontFamily)
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
    boxFontSize: pickNumber('box-font-size', DEFAULT_DANMAKU_STYLE.boxFontSize, 12, 80),
    panelLeft: pickNumber('panel-left', DEFAULT_DANMAKU_STYLE.panelLeft, 0, 2000),
    superChatLanes: Math.round(pickNumber('superchat-lanes', DEFAULT_DANMAKU_STYLE.superChatLanes, 1, 10)),
    superChatBottom: pickNumber('superchat-bottom', DEFAULT_DANMAKU_STYLE.superChatBottom, 0, 4000),
    giftLanes: Math.round(pickNumber('gift-lanes', DEFAULT_DANMAKU_STYLE.giftLanes, 1, 16)),
    giftBottom: pickNumber('gift-bottom', DEFAULT_DANMAKU_STYLE.giftBottom, 0, 4000),
    giftWidth: pickNumber('gift-width', DEFAULT_DANMAKU_STYLE.giftWidth, 160, 1200),
    giftHeight: pickNumber('gift-height', DEFAULT_DANMAKU_STYLE.giftHeight, 20, 120),
    giftAreaHeight: pickNumber('gift-area-height', DEFAULT_DANMAKU_STYLE.giftAreaHeight, 40, 1000),
    giftGap: pickNumber('gift-gap', DEFAULT_DANMAKU_STYLE.giftGap, 0, 100),
    giftRadius: pickNumber('gift-radius', DEFAULT_DANMAKU_STYLE.giftRadius, 0, 60),
    giftFontSize: pickNumber('gift-font-size', DEFAULT_DANMAKU_STYLE.giftFontSize, 10, 60),
    giftScrollDuration: pickNumber('gift-scroll-duration', DEFAULT_DANMAKU_STYLE.giftScrollDuration, 2, 20)
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
      const eventStart = Number(event.time || 0);
      const eventEnd = eventStart + getDanmakuEventDuration(event);
      if (hasStart && eventEnd < startTime) {
        return false;
      }
      if (hasEnd && eventStart > endTime) {
        return false;
      }
      return true;
    })
    .map((event) => ({
      ...event,
      time: options.shiftTime && hasStart ? Math.max(0, Number(event.time || 0) - startTime) : Number(event.time || 0)
    }))
    .sort((a, b) => a.time - b.time);
}

function getDanmakuEventDuration(event) {
  if (event.type === 'superchat') {
    return clamp(Number(event.duration || 60), 30, 180);
  }
  if (event.type === 'danmaku') {
    return 8;
  }
  return event.type === 'guard' ? 8 : 5;
}

function mergeGiftCombos(events) {
  const result = [];
  const lastByKey = new Map();
  for (const event of events) {
    if (event.type !== 'gift' && event.type !== 'guard') {
      result.push(event);
      continue;
    }
    const key = `${event.type}|${event.uid || event.user || ''}|${event.giftName || ''}`;
    const last = lastByKey.get(key);
    if (last && Number(event.time || 0) - Number(last.lastComboTime || last.time || 0) <= 6) {
      const count = Number(event.count || 1);
      last.count = Number(last.count || 1) + count;
      last.totalPrice = Number(last.totalPrice || 0) + resolveGiftTotalPrice(event);
      last.comboCount = Number(last.comboCount || 1) + 1;
      last.lastComboTime = Number(event.time || 0);
      continue;
    }
    const next = {
      ...event,
      totalPrice: resolveGiftTotalPrice(event),
      comboCount: 1,
      lastComboTime: Number(event.time || 0)
    };
    result.push(next);
    lastByKey.set(key, next);
  }
  return result.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
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
  const style = normalizeDanmakuStyle(options.style);
  const sorted = mergeGiftCombos(prepareAssEvents(events, {
    overlayMode,
    startTime: options.startTime,
    endTime: options.endTime,
    shiftTime: options.shiftTime
  }));
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
  const scRows = Array(style.superChatLanes).fill(0);
  const giftScroll = getGiftScrollMetrics(style);
  let nextGiftStart = 0;

  for (const event of sorted) {
    if (event.type === 'danmaku') {
      const duration = style.danmakuDuration;
      const lane = danmakuLayout.avoidOverlap
        ? chooseLaneWithoutOverlap(danmakuRows, event.time, duration)
        : { row: chooseLane(danmakuRows, event.time, duration), start: event.time };
      const y = danmakuLayout.top + lane.row * style.danmakuLineHeight;
      const width = estimateTextWidth(event.text, style.danmakuFontSize);
      const color = assColorFromRgb(event.color || 0xffffff);
      lines.push(
        dialogue(
          1,
          lane.start,
          lane.start + duration,
          'Danmaku',
          `{\\1c${color}\\move(${style.playWidth + 60},${y},-${width},${y})}${assEscape(event.text)}`
        )
      );
      continue;
    }

    if (event.type === 'superchat') {
      const duration = clamp(Number(event.duration || 60), 30, 180);
      const row = chooseLane(scRows, event.time, duration);
      const x = style.panelLeft;
      const y = style.superChatBottom - row * 132;
      const palette = superChatPalette(event.price || 0);
      const title = `${event.user || '用户'}  ￥${event.price || 0}`;
      lines.push(drawRect(7, event.time, event.time + duration, x, y, 570, 42, palette.header));
      lines.push(drawRect(6, event.time, event.time + duration, x, y + 42, 570, 88, palette.body));
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 8})\\fs27\\b1}${assEscape(title)}`
        )
      );
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 54})\\fs24\\b0}${assEscape(wrapText(event.text, 28, 2))}`
        )
      );
      continue;
    }

    if (event.type === 'gift' || event.type === 'guard') {
      const duration = giftScroll.duration;
      const displayStart = Math.max(event.time, nextGiftStart);
      const displayEnd = displayStart + duration;
      nextGiftStart = displayStart + giftScroll.minStartGap;
      const x = style.panelLeft;
      const totalPrice = resolveGiftTotalPrice(event);
      const priceLabel = totalPrice > 0 ? `￥${formatGiftPrice(totalPrice)}` : '';
      const comboLabel = Number(event.comboCount || 0) > 1 ? ` COMBO ${event.comboCount}` : '';
      const label =
        event.type === 'guard'
          ? `${event.user || '用户'} 开通 ${event.giftName || guardName(event.guardLevel)} x${event.count || 1}${comboLabel}`
          : `${event.user || '用户'} 送出 ${event.giftName || '礼物'} x${event.count || 1}${comboLabel}`;
      const subLabel = priceLabel || (event.type === 'guard' ? '大航海' : '礼物互动');
      lines.push(
        drawRoundedRect(
          5,
          displayStart,
          displayEnd,
          x,
          giftScroll.startY,
          style.giftWidth,
          style.giftHeight,
          style.giftRadius,
          event.type === 'guard' ? '&HB8422514&' : '&HAE2A1B12&',
          {
            clip: giftScroll.clip,
            move: { x1: x, y1: giftScroll.startY, x2: x, y2: giftScroll.endY }
          }
        )
      );
      lines.push(
        drawRoundedRect(
          6,
          displayStart,
          displayEnd,
          x + 9,
          giftScroll.startY + 7,
          32,
          32,
          16,
          event.type === 'guard' ? '&H00D8C36E&' : '&H0079DED5&',
          {
            clip: giftScroll.clip,
            move: { x1: x + 9, y1: giftScroll.startY + 7, x2: x + 9, y2: giftScroll.endY + 7 }
          }
        )
      );
      lines.push(
        dialogue(
          7,
          displayStart,
          displayEnd,
          'BoxText',
          `{\\fad(120,260)${clipTag(giftScroll.clip)}\\move(${assNumber(x + 52)},${assNumber(
            giftScroll.startY + 5
          )},${assNumber(x + 52)},${assNumber(giftScroll.endY + 5)})\\fs${assNumber(
            style.giftFontSize
          )}\\b1}${assEscape(truncateTextToWidth(label, style.giftWidth - 112, style.giftFontSize))}`
        )
      );
      lines.push(
        dialogue(
          7,
          displayStart,
          displayEnd,
          'BoxText',
          `{\\fad(120,260)${clipTag(giftScroll.clip)}\\move(${assNumber(x + 52)},${assNumber(
            giftScroll.startY + 25
          )},${assNumber(x + 52)},${assNumber(giftScroll.endY + 25)})\\fs${assNumber(
            Math.max(12, style.giftFontSize - 4)
          )}\\1c&H00D8C36E&}${assEscape(truncateTextToWidth(subLabel, style.giftWidth - 112, style.giftFontSize - 4))}`
        )
      );
    }
  }

  return `${lines.join('\n')}\n`;
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
  const shape = roundedRectPath(width, height, radius);
  const position = options.move
    ? `\\move(${assNumber(options.move.x1)},${assNumber(options.move.y1)},${assNumber(options.move.x2)},${assNumber(
        options.move.y2
      )})`
    : `\\pos(${assNumber(x)},${assNumber(y)})`;
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{\\fad(120,260)${clipTag(options.clip)}\\p1${position}\\bord0\\shad0${assShapeColorTags(color)}}${shape}`
  );
}

function roundedRectPath(width, height, radius) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const r = clamp(Number(radius) || 0, 0, Math.min(w, h) / 2);
  if (r <= 0) {
    return `m 0 0 l ${assNumber(w)} 0 l ${assNumber(w)} ${assNumber(h)} l 0 ${assNumber(h)}`;
  }
  const c = r * 0.55228475;
  return [
    `m ${assNumber(r)} 0`,
    `l ${assNumber(w - r)} 0`,
    `b ${assNumber(w - r + c)} 0 ${assNumber(w)} ${assNumber(r - c)} ${assNumber(w)} ${assNumber(r)}`,
    `l ${assNumber(w)} ${assNumber(h - r)}`,
    `b ${assNumber(w)} ${assNumber(h - r + c)} ${assNumber(w - r + c)} ${assNumber(h)} ${assNumber(
      w - r
    )} ${assNumber(h)}`,
    `l ${assNumber(r)} ${assNumber(h)}`,
    `b ${assNumber(r - c)} ${assNumber(h)} 0 ${assNumber(h - r + c)} 0 ${assNumber(h - r)}`,
    `l 0 ${assNumber(r)}`,
    `b 0 ${assNumber(r - c)} ${assNumber(r - c)} 0 ${assNumber(r)} 0`
  ].join(' ');
}

function getGiftScrollMetrics(style) {
  const width = Math.max(1, Number(style.giftWidth) || DEFAULT_DANMAKU_STYLE.giftWidth);
  const height = Math.max(1, Number(style.giftHeight) || DEFAULT_DANMAKU_STYLE.giftHeight);
  const gap = Math.max(0, Number(style.giftGap) || 0);
  const areaHeight = Math.max(height + gap, Number(style.giftAreaHeight) || DEFAULT_DANMAKU_STYLE.giftAreaHeight);
  const duration = Math.max(0.1, Number(style.giftScrollDuration) || DEFAULT_DANMAKU_STYLE.giftScrollDuration);
  const x = Number(style.panelLeft) || DEFAULT_DANMAKU_STYLE.panelLeft;
  const areaBottom = Number(style.giftBottom || 0) + height;
  const areaTop = Math.max(0, areaBottom - areaHeight);
  const startY = areaBottom;
  const endY = areaTop - height;
  const travel = Math.max(1, startY - endY);
  const minStartGap = ((height + gap) / travel) * duration;
  return {
    startY,
    endY,
    duration,
    minStartGap,
    textOffsetY: Math.max(3, Math.round((height - Number(style.giftFontSize || 0)) / 2) - 1),
    clip: {
      x1: x,
      y1: areaTop,
      x2: x + width,
      y2: areaBottom
    }
  };
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

function hex2(value) {
  return Number(value).toString(16).padStart(2, '0').toUpperCase();
}

function superChatPalette(price) {
  if (price >= 1000) {
    return { header: '&H002D35E5&', body: '&H00503D8B&' };
  }
  if (price >= 500) {
    return { header: '&H00344BD9&', body: '&H00475AAE&' };
  }
  if (price >= 100) {
    return { header: '&H0000A5FF&', body: '&H002B8FE6&' };
  }
  if (price >= 50) {
    return { header: '&H0000C8B8&', body: '&H0033B9B0&' };
  }
  return { header: '&H00D88B2D&', body: '&H00B87931&' };
}

function formatGiftPrice(value) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount >= 10000) {
    return `${(amount / 10000).toFixed(amount >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`;
  }
  if (amount >= 100) {
    return amount.toFixed(0);
  }
  return amount.toFixed(2).replace(/\.00$/, '');
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
    return sum + (/[\u4e00-\u9fa5]/.test(char) ? 1 : 0.58);
  }, 0);
  return Math.ceil(length * fontSize);
}

function truncateText(text, max) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= max) {
    return text || '';
  }
  return `${chars.slice(0, max - 1).join('')}…`;
}

function truncateTextToWidth(text, maxWidth, fontSize) {
  const chars = Array.from(String(text || ''));
  const safeWidth = Math.max(20, Number(maxWidth) || 20);
  let output = '';
  for (let index = 0; index < chars.length; index += 1) {
    const suffix = index < chars.length - 1 ? '…' : '';
    const next = `${output}${chars[index]}`;
    if (estimateTextWidth(`${next}${suffix}`, fontSize) > safeWidth) {
      return output ? `${output}…` : '…';
    }
    output = next;
  }
  return output;
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

module.exports = {
  danmakuCommandType,
  normalizeDanmakuEvent,
  DANMAKU_DISPLAY_AREAS,
  normalizeDanmakuDisplayArea,
  danmakuDisplayAreaLabel,
  readDanmakuEvents,
  ensureDanmakuCss,
  readDanmakuStyle,
  createDefaultDanmakuCss,
  parseCssVariables,
  normalizeDanmakuStyle,
  prepareAssEvents,
  getDanmakuEventDuration,
  createAss,
  drawRect,
  drawRoundedRect,
  roundedRectPath,
  getDanmakuLayoutMetrics,
  getGiftScrollMetrics,
  dialogue,
  assTime,
  assEscape,
  assColorFromRgb,
  assShapeColorTags,
  hex2,
  superChatPalette,
  chooseLane,
  chooseLaneWithoutOverlap,
  estimateTextWidth,
  truncateText,
  truncateTextToWidth,
  wrapText
};
