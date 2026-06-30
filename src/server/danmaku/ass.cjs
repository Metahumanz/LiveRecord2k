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
    return {
      type: 'gift',
      time,
      user: String(data.uname || data.username || ''),
      giftName: String(data.giftName || data.gift_name || '礼物'),
      count: Number(data.num || data.combo_num || data.combo_count || 1),
      price: Number(data.price || data.discount_price || 0) / 1000
    };
  }

  if (type === 'SUPER_CHAT_MESSAGE' || type === 'SUPER_CHAT_MESSAGE_JPN') {
    const data = command.data || {};
    return {
      type: 'superchat',
      time,
      user: String(data.user_info?.uname || data.uname || ''),
      text: String(data.message || ''),
      price: Number(data.price || 0),
      duration: Number(data.time || data.duration || 60)
    };
  }

  if (type === 'GUARD_BUY' || type === 'USER_TOAST_MSG') {
    const data = command.data || {};
    return {
      type: 'guard',
      time,
      user: String(data.username || data.uname || data.user_show_info?.uname || ''),
      giftName: String(data.gift_name || data.role_name || guardName(data.guard_level)),
      count: Number(data.num || 1),
      price: Number(data.price || 0) / 1000
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
  giftBottom: 934
};

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
    giftBottom: pickNumber('gift-bottom', DEFAULT_DANMAKU_STYLE.giftBottom, 0, 4000)
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

function createAss(events, options = {}) {
  const overlayMode = normalizeBurnOverlayMode(options.overlayMode);
  const style = normalizeDanmakuStyle(options.style);
  const sorted = prepareAssEvents(events, {
    overlayMode,
    startTime: options.startTime,
    endTime: options.endTime,
    shiftTime: options.shiftTime
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

  const danmakuRows = Array(style.danmakuLanes).fill(0);
  const scRows = Array(style.superChatLanes).fill(0);
  const giftRows = Array(style.giftLanes).fill(0);

  for (const event of sorted) {
    if (event.type === 'danmaku') {
      const duration = style.danmakuDuration;
      const row = chooseLane(danmakuRows, event.time, duration);
      const y = style.danmakuTop + row * style.danmakuLineHeight;
      const width = estimateTextWidth(event.text, style.danmakuFontSize);
      const color = assColorFromRgb(event.color || 0xffffff);
      lines.push(
        dialogue(
          1,
          event.time,
          event.time + duration,
          'Danmaku',
          `{\\1c${color}\\move(1980,${y},-${width},${y})}${assEscape(event.text)}`
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
      const duration = event.type === 'guard' ? 8 : 5;
      const row = chooseLane(giftRows, event.time, duration);
      const x = style.panelLeft;
      const y = style.giftBottom - row * 56;
      const label =
        event.type === 'guard'
          ? `${event.user || '用户'} 开通 ${event.giftName || '舰长'} x${event.count || 1}`
          : `${event.user || '用户'} 送出 ${event.giftName || '礼物'} x${event.count || 1}`;
      lines.push(drawRect(5, event.time, event.time + duration, x, y, 500, 44, '&H8A2A1B12&'));
      lines.push(
        dialogue(
          6,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 16},${y + 8})\\fs24}${assEscape(truncateText(label, 36))}`
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
    `{\\fad(120,260)\\p1\\pos(${x},${y})\\bord0\\shad0\\1c${color}}${shape}`
  );
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
  dialogue,
  assTime,
  assEscape,
  assColorFromRgb,
  hex2,
  superChatPalette,
  chooseLane,
  estimateTextWidth,
  truncateText,
  wrapText
};
