'use strict';

// Scene Graph -> ASS compiler. It is intentionally a capability-limited
// target: semantic Scene data stays untouched and the compiler reports the
// effects it had to approximate (notably raster avatars).

const { buildSceneGraph, assertSceneGraph, evaluateSceneObject } = require('./scene-graph.cjs');

function assNumber(value) {
  const number = Number(value) || 0;
  return Number(number.toFixed(3)).toString();
}

function assTime(value) {
  const total = Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + seconds.toFixed(2).padStart(5, '0');
}

function assEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

function hexByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, '0').toUpperCase();
}

function assColor(value, alpha) {
  const source = String(value || '#ffffff').trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(source);
  const color = match ? match[1] : 'FFFFFF';
  const red = parseInt(color.slice(0, 2), 16);
  const green = parseInt(color.slice(2, 4), 16);
  const blue = parseInt(color.slice(4, 6), 16);
  const opacity = alpha === undefined ? 1 : Math.max(0, Math.min(1, Number(alpha)));
  return '&H' + hexByte((1 - opacity) * 255) + hexByte(blue) + hexByte(green) + hexByte(red) + '&';
}

function dialogue(layer, start, end, style, content) {
  return 'Dialogue: ' + Math.max(0, Math.floor(Number(layer) || 0)) + ',' + assTime(start) + ',' + assTime(end) + ',' + style + ',,0,0,0,,' + content;
}

function roundedRectPath(width, height, radius) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const r = Math.max(0, Math.min(Math.min(w, h) / 2, Number(radius) || 0));
  if (r < 0.5) return 'm 0 0 l ' + assNumber(w) + ' 0 l ' + assNumber(w) + ' ' + assNumber(h) + ' l 0 ' + assNumber(h) + ' c 0 ' + assNumber(h) + ' 0 ' + assNumber(h) + ' 0 0';
  const k = r * 0.55228475;
  return [
    'm ' + assNumber(r) + ' 0',
    'l ' + assNumber(w - r) + ' 0',
    'b ' + assNumber(w - r + k) + ' 0 ' + assNumber(w) + ' ' + assNumber(r - k) + ' ' + assNumber(w) + ' ' + assNumber(r),
    'l ' + assNumber(w) + ' ' + assNumber(h - r),
    'b ' + assNumber(w) + ' ' + assNumber(h - r + k) + ' ' + assNumber(w - r + k) + ' ' + assNumber(h) + ' ' + assNumber(w - r) + ' ' + assNumber(h),
    'l ' + assNumber(r) + ' ' + assNumber(h),
    'b ' + assNumber(r - k) + ' ' + assNumber(h) + ' 0 ' + assNumber(h - r + k) + ' 0 ' + assNumber(h - r),
    'l 0 ' + assNumber(r),
    'b 0 ' + assNumber(r - k) + ' ' + assNumber(r - k) + ' 0 ' + assNumber(r) + ' 0'
  ].join(' ');
}

function ellipsePath(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const rx = w / 2;
  const ry = h / 2;
  const k = 0.55228475;
  return [
    'm ' + assNumber(rx) + ' 0',
    'b ' + assNumber(rx + rx * k) + ' 0 ' + assNumber(w) + ' ' + assNumber(ry - ry * k) + ' ' + assNumber(w) + ' ' + assNumber(ry),
    'b ' + assNumber(w) + ' ' + assNumber(ry + ry * k) + ' ' + assNumber(rx + rx * k) + ' ' + assNumber(h) + ' ' + assNumber(rx) + ' ' + assNumber(h),
    'b ' + assNumber(rx - rx * k) + ' ' + assNumber(h) + ' 0 ' + assNumber(ry + ry * k) + ' 0 ' + assNumber(ry),
    'b 0 ' + assNumber(ry - ry * k) + ' ' + assNumber(rx - rx * k) + ' 0 ' + assNumber(rx) + ' 0'
  ].join(' ');
}

function objectBoundaries(object) {
  const values = [Number(object.start), Number(object.end)];
  for (const animation of Array.isArray(object.animations) ? object.animations : []) {
    if (animation.type === 'Move' || animation.type === 'Fade' || animation.type === 'Scale') {
      values.push(Number(animation.start), Number(animation.end));
    }
  }
  for (const keyframe of Array.isArray(object.props && object.props.textKeyframes) ? object.props.textKeyframes : []) {
    values.push(Number(keyframe.time));
  }
  return Array.from(new Set(values.filter(Number.isFinite).filter((value) => value >= Number(object.start) && value <= Number(object.end)))).sort((left, right) => left - right);
}

function objectSegments(object) {
  const boundaries = objectBoundaries(object);
  const output = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end - start < 0.001) continue;
    const from = evaluateSceneObject(object, start);
    const to = evaluateSceneObject(object, Math.max(start, end - 0.00001));
    if (!from.visible && !to.visible) continue;
    output.push({ start, end, from, to });
  }
  return output;
}

function positionTag(segment) {
  if (Math.abs(segment.from.x - segment.to.x) < 0.001 && Math.abs(segment.from.y - segment.to.y) < 0.001) {
    return '\\pos(' + assNumber(segment.from.x) + ',' + assNumber(segment.from.y) + ')';
  }
  return '\\move(' + assNumber(segment.from.x) + ',' + assNumber(segment.from.y) + ',' + assNumber(segment.to.x) + ',' + assNumber(segment.to.y) + ')';
}

function opacityTag(opacity) {
  const alpha = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)));
  return '\\1a&H' + hexByte(alpha) + '&';
}

function scaleTag(state) {
  const x = Math.max(0, Number(state.scaleX) || 1) * 100;
  const y = Math.max(0, Number(state.scaleY) || 1) * 100;
  return '\\fscx' + assNumber(x) + '\\fscy' + assNumber(y);
}

// An ASS dialogue is emitted for every Scene animation boundary.  Within a
// boundary span, use ASS transforms for Fade/Scale so the exported track keeps
// the canonical Scene timing instead of jumping to the end state.
function transitionTags(segment) {
  const durationMs = Math.max(1, Math.round((Number(segment.end) - Number(segment.start)) * 1000));
  const tags = [];
  if (Math.abs(Number(segment.from.opacity) - Number(segment.to.opacity)) >= 0.002) {
    tags.push('\\t(0,' + durationMs + ',' + opacityTag(segment.to.opacity) + ')');
  }
  if (
    Math.abs(Number(segment.from.scaleX) - Number(segment.to.scaleX)) >= 0.002 ||
    Math.abs(Number(segment.from.scaleY) - Number(segment.to.scaleY)) >= 0.002
  ) {
    tags.push('\\t(0,' + durationMs + ',' + scaleTag(segment.to) + ')');
  }
  return tags.join('');
}

function textAt(object, time) {
  let value = String(object.props && object.props.text || '');
  for (const keyframe of Array.isArray(object.props && object.props.textKeyframes) ? object.props.textKeyframes : []) {
    if (Number(keyframe.time) <= time + 0.0001) value = String(keyframe.text || '');
  }
  return value;
}

function renderText(object, segment) {
  const props = object.props || {};
  const style = object.style || {};
  const fontSize = Math.max(1, Number(props.fontSize) || 20);
  const border = Math.max(0, Number(style.strokeWidth) || 0);
  const shadow = style.shadow || {};
  const tags = [
    '\\an7',
    positionTag(segment),
    scaleTag(segment.from),
    '\\fn' + String(props.fontFamily || 'Arial').replace(/[,{}\\]/g, ''),
    '\\fs' + assNumber(fontSize),
    '\\1c' + assColor(style.fill || '#ffffff'),
    opacityTag(segment.from.opacity),
    transitionTags(segment),
    '\\bord' + assNumber(border),
    '\\3c' + assColor(style.stroke || '#000000'),
    '\\shad' + assNumber(Number(shadow.offsetY) || 0)
  ];
  return dialogue(object.zIndex || 30, segment.start, segment.end, 'SceneText', '{' + tags.join('') + '}' + assEscape(textAt(object, segment.start)));
}

function renderShape(object, segment, path, degradation) {
  const style = object.style || {};
  const tags = [
    '\\an7',
    positionTag(segment),
    scaleTag(segment.from),
    opacityTag(segment.from.opacity),
    transitionTags(segment),
    '\\p1',
    '\\bord0',
    '\\shad0',
    '\\1c' + assColor(style.fill || '#ffffff')
  ];
  if (style.shadow && Number(style.shadow.opacity) > 0) degradation.add('shadow');
  return dialogue(object.zIndex || 10, segment.start, segment.end, 'SceneShape', '{' + tags.join('') + '}' + path);
}

function compileSceneToAss(graph, options) {
  assertSceneGraph(graph);
  const source = options || {};
  const font = String(graph.style && graph.style.fontFamily || source.fontFamily || 'Arial').replace(/[,{}\\]/g, '');
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: ' + Math.round(Number(graph.canvas.width)),
    'PlayResY: ' + Math.round(Number(graph.canvas.height)),
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: SceneText,' + font + ',28,&H00FFFFFF,&H000000FF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    'Style: SceneShape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const degradation = new Set();
  const visible = graph.objects.filter((object) => object.render !== false).slice().sort((left, right) => Number(left.zIndex || 0) - Number(right.zIndex || 0) || String(left.id).localeCompare(String(right.id)));
  for (const object of visible) {
    for (const segment of objectSegments(object)) {
      if (object.type === 'Text') {
        lines.push(renderText(object, segment));
        continue;
      }
      if (object.type === 'Avatar') {
        if (object.props && object.props.assetId) degradation.add('avatar-raster');
        lines.push(renderShape(object, segment, ellipsePath(object.frame.width, object.frame.height), degradation));
        continue;
      }
      if (object.type === 'Card' || object.type === 'Rect' || object.type === 'SuperChat' || object.type === 'Gift') {
        lines.push(renderShape(object, segment, roundedRectPath(object.frame.width, object.frame.height, Number(object.style && object.style.cornerRadius)), degradation));
      }
    }
  }
  return {
    ass: lines.join('\n') + '\n',
    degradedEffects: Array.from(degradation).sort(),
    objectCount: visible.length
  };
}

function createAssFromScene(graph, options) {
  return compileSceneToAss(graph, options).ass;
}

function createSceneAssTracks(events, options) {
  const source = options || {};
  const presets = Array.isArray(source.presets) && source.presets.length ? source.presets : ['current', 'h5-card', 'bubble', 'minimal'];
  const tracks = {};
  for (const preset of presets) {
    const graph = buildSceneGraph(events, Object.assign({}, source, { stylePreset: preset }));
    tracks[preset] = Object.assign({ graph }, compileSceneToAss(graph, source));
  }
  return tracks;
}

module.exports = {
  assTime,
  assEscape,
  assColor,
  roundedRectPath,
  objectSegments,
  transitionTags,
  compileSceneToAss,
  createAssFromScene,
  createSceneAssTracks
};
