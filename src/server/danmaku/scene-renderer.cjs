'use strict';

const fsp = require('node:fs/promises');
const { assertSceneGraph, evaluateSceneObject } = require('./scene-graph.cjs');

// This renderer emits one FFmpeg filter graph directly over clean video. It
// never turns ASS into video and never creates a transparent-video
// intermediate. The same object/time evaluator is used by browser preview and
// backend conformance tests.

function number(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number(fallback) || 0;
}

function ff(value) {
  return Number(number(value).toFixed(4)).toString();
}

function quoteFilter(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function quoteText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, '\\n');
}

function rgbaColor(color, opacity) {
  const source = String(color || '#ffffff').replace(/^#/, '');
  const normalized = /^[0-9a-f]{6}$/i.test(source) ? source : 'ffffff';
  const alpha = Math.max(0, Math.min(1, number(opacity, 1)));
  return '0x' + normalized + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function sortedMotions(object) {
  return (Array.isArray(object.animations) ? object.animations : [])
    .filter((animation) => animation && animation.type === 'Move' && Number(animation.end) > Number(animation.start))
    .slice()
    .sort((left, right) => Number(left.start) - Number(right.start));
}

function motionExpression(object, axis) {
  let expression = ff(object.frame && object.frame[axis]);
  for (const motion of sortedMotions(object)) {
    const start = number(motion.start);
    const end = Math.max(start + 0.0001, number(motion.end));
    const from = number(motion.from && motion.from[axis], expression);
    const to = number(motion.to && motion.to[axis], from);
    const linear = '(' + ff(from) + '+(' + ff(to) + '-' + ff(from) + ')*(t-' + ff(start) + ')/' + ff(end - start) + ')';
    expression = 'if(lt(t\\,' + ff(start) + ')\\,' + expression + '\\,if(lte(t\\,' + ff(end) + ')\\,' + linear + '\\,' + ff(to) + '))';
  }
  return expression;
}

function fadeExpression(object) {
  let expression = ff(number(object.style && object.style.opacity, 1));
  const fades = (Array.isArray(object.animations) ? object.animations : [])
    .filter((animation) => animation && animation.type === 'Fade' && Number(animation.end) > Number(animation.start))
    .slice()
    .sort((left, right) => Number(left.start) - Number(right.start));
  for (const fade of fades) {
    const start = number(fade.start);
    const end = Math.max(start + 0.0001, number(fade.end));
    const from = number(fade.from, 1);
    const to = number(fade.to, from);
    const linear = '(' + ff(from) + '+(' + ff(to) + '-' + ff(from) + ')*(t-' + ff(start) + ')/' + ff(end - start) + ')';
    expression = 'if(lt(t\\,' + ff(start) + ')\\,' + expression + '\\,if(lte(t\\,' + ff(end) + ')\\,' + linear + '\\,' + ff(to) + '))';
  }
  return expression;
}

function fadeFilters(object) {
  const fades = (Array.isArray(object.animations) ? object.animations : [])
    .filter((animation) => animation && animation.type === 'Fade' && Number(animation.end) > Number(animation.start))
    .slice()
    .sort((left, right) => Number(left.start) - Number(right.start));
  const filters = [];
  for (const fade of fades) {
    const start = number(fade.start);
    const end = Math.max(start + 0.0001, number(fade.end));
    const from = number(fade.from, 1);
    const to = number(fade.to, from);
    const duration = ff(end - start);
    if (from <= 0.001 && to >= 0.999) {
      filters.push(',fade=t=in:st=' + ff(start) + ':d=' + duration + ':alpha=1');
    } else if (from >= 0.999 && to <= 0.001) {
      filters.push(',fade=t=out:st=' + ff(start) + ':d=' + duration + ':alpha=1');
    }
  }
  return filters.join('');
}

function scaleExpression(object, axis) {
  let expression = '1';
  const scales = (Array.isArray(object.animations) ? object.animations : [])
    .filter((animation) => animation && animation.type === 'Scale' && Number(animation.end) > Number(animation.start))
    .slice()
    .sort((left, right) => Number(left.start) - Number(right.start));
  for (const scale of scales) {
    const start = number(scale.start);
    const end = Math.max(start + 0.0001, number(scale.end));
    const from = number(scale.from && scale.from[axis], 1);
    const to = number(scale.to && scale.to[axis], from);
    const linear = '(' + ff(from) + '+(' + ff(to) + '-' + ff(from) + ')*(t-' + ff(start) + ')/' + ff(end - start) + ')';
    expression = 'if(lt(t\\,' + ff(start) + ')\\,' + expression + '\\,if(lte(t\\,' + ff(end) + ')\\,' + linear + '\\,' + ff(to) + '))';
  }
  return expression;
}

function dynamicScaleFilter(object) {
  return ",scale=w='iw*(" + scaleExpression(object, 'x') + ")':h='ih*(" + scaleExpression(object, 'y') + ")':eval=frame";
}

function objectEnable(object) {
  return "between(t\\," + ff(object.start) + '\\,' + ff(object.end) + ')';
}

function collectSceneAssets(scene) {
  const assets = new Map();
  for (const asset of Array.isArray(scene.assets) ? scene.assets : []) {
    if (asset && asset.id) assets.set(String(asset.id), asset);
  }
  return assets;
}

function createSceneRenderPlan(scene, options) {
  assertSceneGraph(scene);
  const source = options || {};
  const assets = collectSceneAssets(scene);
  const objects = scene.objects
    .filter((object) => object && object.render !== false)
    .slice()
    .sort((left, right) => Number(left.zIndex || 0) - Number(right.zIndex || 0) || String(left.id).localeCompare(String(right.id)))
    .map((object) => {
      const asset = object.type === 'Avatar' && object.props && object.props.assetId
        ? assets.get(String(object.props.assetId)) || null
        : null;
      return {
        id: object.id,
        type: object.type,
        start: number(object.start),
        end: number(object.end),
        frame: object.frame,
        zIndex: number(object.zIndex),
        animations: object.animations || [],
        style: object.style || {},
        props: object.props || {},
        asset: asset ? { id: asset.id, path: String(asset.path || ''), url: String(asset.url || '') } : null
      };
    });
  return {
    schema: 'bili-record2k.render-plan/v1',
    target: ['software', 'cuda', 'jetson'].includes(String(source.target || '')) ? String(source.target) : 'software',
    canvas: scene.canvas,
    duration: number(source.duration, scene.timeline && scene.timeline.end),
    objects,
    metadata: {
      sourceSchema: scene.schema,
      sourceVersion: scene.version,
      directComposition: true,
      avoidsAssVideoIntermediate: true,
      avoidsTransparentVideoIntermediate: true
    }
  };
}

function roundedRectAlpha(width, height, style) {
  const requestedRadius = Math.max(0, number(style && style.cornerRadius));
  const radius = Math.min(Math.floor(Math.min(width, height) / 2), Math.round(requestedRadius));
  if (radius < 1) return '';
  const corners = style && style.corners && typeof style.corners === 'object' ? style.corners : {};
  const enabled = (name) => corners[name] !== false;
  const r = ff(radius);
  const squared = ff(radius * radius);
  const inside = (x, y) =>
    "if(lte((X-" + ff(x) + ')^2+(Y-' + ff(y) + ')^2\\,' + squared + ")\\,alpha(X\\,Y)\\,0)";
  const corner = (condition, name, x, y, fallback) =>
    enabled(name) ? "if(" + condition + '\\,' + inside(x, y) + '\\,' + fallback + ')' : fallback;
  let output = 'alpha(X\\,Y)';
  output = corner('gt(X\\,' + ff(width - radius) + ')*gt(Y\\,' + ff(height - radius) + ')', 'br', width - radius, height - radius, output);
  output = corner('lt(X\\,' + r + ')*gt(Y\\,' + ff(height - radius) + ')', 'bl', radius, height - radius, output);
  output = corner('gt(X\\,' + ff(width - radius) + ')*lt(Y\\,' + r + ')', 'tr', width - radius, radius, output);
  output = corner('lt(X\\,' + r + ')*lt(Y\\,' + r + ')', 'tl', radius, radius, output);
  return ",geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='" + output + "'";
}

function objectShapeFilter(object, label, duration, fps, options) {
  const source = options || {};
  const style = source.style || object.style || {};
  const width = Math.max(2, Math.ceil(number(object.frame && object.frame.width, 1)));
  const height = Math.max(2, Math.ceil(number(object.frame && object.frame.height, 1)));
  const opacity = number(style.opacity, 1);
  const color = rgbaColor(style.fill, opacity);
  const roundedMask = roundedRectAlpha(width, height, style);
  const padding = Math.max(0, Math.ceil(number(source.padding)));
  const blur = Math.max(0, number(source.blur));
  const padded = padding
    ? ',pad=w=iw+' + padding * 2 + ':h=ih+' + padding * 2 + ':x=' + padding + ':y=' + padding + ':color=black@0'
    : '';
  const blurred = blur > 0 ? ',boxblur=lr=' + ff(blur) + ':lp=1:cr=' + ff(blur) + ':cp=1:ar=' + ff(blur) + ':ap=1' : '';
  return 'color=c=' + color + ':s=' + width + 'x' + height + ':r=' + Math.max(1, number(fps, 30)) + ':d=' + ff(duration) +
    ',format=rgba' + roundedMask + dynamicScaleFilter(object) + fadeFilters(object) + padded + blurred + '[' + label + ']';
}

function avatarFilter(object, label, duration) {
  const width = Math.max(2, Math.ceil(number(object.frame && object.frame.width, 1)));
  const height = Math.max(2, Math.ceil(number(object.frame && object.frame.height, 1)));
  const path = object.asset && object.asset.path;
  if (!path) {
    return objectShapeFilter(
      Object.assign({}, object, {
        style: Object.assign({}, object.style || {}, { cornerRadius: Math.min(width, height) / 2 })
      }),
      label,
      duration,
      30
    );
  }
  const radius = Math.min(width, height) / 2;
  const alpha = "if(lte((X-W/2)^2+(Y-H/2)^2\\," + ff(radius * radius) + ")\\,alpha(X\\,Y)\\,0)";
  const opacity = Math.max(0, Math.min(1, number(object.style && object.style.opacity, 1)));
  return "movie='" + quoteFilter(path) + "',loop=loop=-1:size=1:start=0,trim=duration=" + ff(duration) +
    ',setpts=PTS-STARTPTS,scale=' + width + ':' + height + ',format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=' + "'" + alpha + "',colorchannelmixer=aa=" + ff(opacity) + fadeFilters(object) + dynamicScaleFilter(object) + '[' + label + ']';
}

function overlayShape(previous, imageLabel, output, object, offset) {
  const source = offset || {};
  const xOffset = number(source.x);
  const yOffset = number(source.y);
  const x = xOffset ? '(' + motionExpression(object, 'x') + '+' + ff(xOffset) + ')' : motionExpression(object, 'x');
  const y = yOffset ? '(' + motionExpression(object, 'y') + '+' + ff(yOffset) + ')' : motionExpression(object, 'y');
  return '[' + previous + '][' + imageLabel + ']overlay=x=' + "'" + x + "'" +
    ':y=' + "'" + y + "'" +
    ":enable='" + objectEnable(object) + "':eof_action=pass:repeatlast=0:format=auto[" + output + ']';
}

function objectShadow(object) {
  const shadow = object.style && object.style.shadow;
  if (!shadow || typeof shadow !== 'object') return null;
  const opacity = Math.max(0, Math.min(1, number(shadow.opacity)));
  if (opacity <= 0) return null;
  return {
    color: String(shadow.color || '#000000'),
    opacity,
    offsetX: number(shadow.offsetX),
    offsetY: number(shadow.offsetY),
    blur: Math.max(0, number(shadow.blur))
  };
}

function shadowShapeObject(object, shadow) {
  const avatarRadius = object.type === 'Avatar'
    ? Math.min(number(object.frame && object.frame.width), number(object.frame && object.frame.height)) / 2
    : number(object.style && object.style.cornerRadius);
  return Object.assign({}, object, {
    style: Object.assign({}, object.style || {}, {
      fill: shadow.color,
      opacity: shadow.opacity,
      cornerRadius: avatarRadius,
      shadow: null
    })
  });
}

function textVariants(object) {
  const props = object.props || {};
  const start = number(object.start);
  const end = Math.max(start + 0.0001, number(object.end, start + 0.0001));
  let cursor = start;
  let text = String(props.text || '');
  const variants = [];
  const keyframes = (Array.isArray(props.textKeyframes) ? props.textKeyframes : [])
    .filter((keyframe) => keyframe && Number.isFinite(Number(keyframe.time)))
    .slice()
    .sort((left, right) => Number(left.time) - Number(right.time));
  for (const keyframe of keyframes) {
    const time = number(keyframe.time);
    if (time <= start + 0.0001) {
      text = String(keyframe.text || '');
      continue;
    }
    if (time >= end) continue;
    if (time > cursor + 0.0001) {
      variants.push(Object.assign({}, object, { start: cursor, end: time, props: Object.assign({}, props, { text }) }));
    }
    cursor = time;
    text = String(keyframe.text || '');
  }
  if (end > cursor + 0.0001) {
    variants.push(Object.assign({}, object, { start: cursor, end, props: Object.assign({}, props, { text }) }));
  }
  return variants.length ? variants : [Object.assign({}, object, { props: Object.assign({}, props, { text }) })];
}

function textLayerFilter(object, label, duration, fps) {
  const props = object.props || {};
  const style = object.style || {};
  const shadow = style.shadow || {};
  const fontSize = Math.max(1, number(props.fontSize, 20));
  const font = quoteFilter(props.fontFamily || 'Arial');
  const fill = rgbaColor(style.fill || '#ffffff', 1);
  const stroke = rgbaColor(style.stroke || '#000000', 1);
  const text = quoteText(props.text || '');
  const alpha = fadeExpression(object);
  const width = Math.max(2, Math.ceil(number(object.frame && object.frame.width, fontSize)));
  const height = Math.max(2, Math.ceil(number(object.frame && object.frame.height, fontSize * 1.3)));
  return 'color=c=black@0.0:s=' + width + 'x' + height + ':r=' + Math.max(1, number(fps, 30)) + ':d=' + ff(duration) +
    ",format=rgba,drawtext=font='" + font + "':text='" + text + "':fontsize=" + ff(fontSize) +
    ':fontcolor=' + fill + ':borderw=' + ff(style.strokeWidth) + ':bordercolor=' + stroke +
    ':shadowx=' + ff(shadow.offsetX) + ':shadowy=' + ff(shadow.offsetY) +
    ':shadowcolor=' + rgbaColor(shadow.color || '#000000', number(shadow.opacity, 0)) +
    ":x=0:y=0:alpha='" + alpha + "'" + dynamicScaleFilter(object) + '[' + label + ']';
}

function createSceneFilterScript(scene, options) {
  const source = options || {};
  const plan = createSceneRenderPlan(scene, source);
  const fps = Math.max(1, number(source.fps, 30));
  const duration = Math.max(0.001, number(source.duration, plan.duration));
  const filters = ['[0:v]settb=AVTB,setpts=PTS-STARTPTS,format=rgba[scene_base_0]'];
  let previous = 'scene_base_0';
  let index = 0;
  for (const object of plan.objects) {
    if (object.type === 'Text') {
      for (const variant of textVariants(object)) {
        const image = 'scene_text_image_' + index;
        const output = 'scene_text_' + index;
        filters.push(textLayerFilter(variant, image, duration, fps));
        filters.push(overlayShape(previous, image, output, variant));
        previous = output;
        index += 1;
      }
      continue;
    }
    if (!['Avatar', 'Rect', 'Card', 'SuperChat', 'Gift'].includes(object.type)) continue;
    const shadow = objectShadow(object);
    if (shadow) {
      const shadowImage = 'scene_shadow_image_' + index;
      const shadowOutput = 'scene_shadow_' + index;
      const padding = Math.max(1, Math.ceil(shadow.blur * 2));
      filters.push(objectShapeFilter(shadowShapeObject(object, shadow), shadowImage, duration, fps, { padding, blur: shadow.blur }));
      filters.push(overlayShape(previous, shadowImage, shadowOutput, object, { x: shadow.offsetX - padding, y: shadow.offsetY - padding }));
      previous = shadowOutput;
      index += 1;
    }
    const image = 'scene_image_' + index;
    const output = 'scene_layer_' + index;
    filters.push(object.type === 'Avatar' ? avatarFilter(object, image, duration) : objectShapeFilter(object, image, duration, fps));
    filters.push(overlayShape(previous, image, output, object));
    previous = output;
    index += 1;
  }
  filters.push('[' + previous + ']format=yuv420p[vout]');
  return {
    plan,
    script: filters.join(';\n') + '\n'
  };
}

async function writeSceneFilterScript(filePath, scene, options) {
  const generated = createSceneFilterScript(scene, options);
  const target = String(filePath || '').trim();
  if (!target) throw new Error('Scene 渲染缺少滤镜脚本路径。');
  await fsp.writeFile(target, generated.script, { encoding: 'utf8', mode: 0o660 });
  return Object.assign({ filterScriptPath: target }, generated);
}

function evaluateRenderPlan(plan, time) {
  const source = plan || {};
  return (Array.isArray(source.objects) ? source.objects : [])
    .map((object) => ({ id: object.id, type: object.type, state: evaluateSceneObject(object, time), frame: object.frame, props: object.props }))
    .filter((entry) => entry.state.visible);
}

module.exports = {
  quoteFilter,
  quoteText,
  rgbaColor,
  roundedRectAlpha,
  motionExpression,
  fadeExpression,
  scaleExpression,
  createSceneRenderPlan,
  createSceneFilterScript,
  writeSceneFilterScript,
  evaluateRenderPlan
};
