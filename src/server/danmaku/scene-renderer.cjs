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
  const duration = number(source.duration, scene.timeline && scene.timeline.end);
  const objects = scene.objects
    // Never allocate an image stream for an object wholly outside this export
    // window. Long-lived danmaku plans otherwise carry their 24-hour tail
    // into a four-second CUDA clip and exhaust WDDM filter resources.
    .filter((object) => object && object.render !== false && number(object.start, 0) < duration && number(object.end, 0) > 0)
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
    duration,
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

// FFmpeg's overlay_cuda keeps every composited image in CUDA memory.  The
// Scene assets themselves are still rasterized by the canonical Scene Graph
// filters (drawtext, rounded masks, avatar clipping), then uploaded once as
// YUVA textures.  This preserves the exact object/time semantics while moving
// the full-resolution blend, animation placement and final encoder input off
// the CPU.  YUVA is required: RGBA is not accepted by overlay_cuda.
function uploadCudaLayer(input, output, object) {
  // overlay_cuda has no timeline `enable` implementation. Bake the canonical
  // object lifetime into its alpha plane before upload instead, retaining the
  // source alpha generated by rounded corners, text glyphs and fades.
  const visible = object
    ? "if(between(T\\," + ff(object.start) + '\\,' + ff(object.end) + '),alpha(X\\,Y),0)'
    : "alpha(X\\,Y)'";
  return '[' + input + "]geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='" + visible + "',format=yuva420p,hwupload_cuda[" + output + ']';
}

function overlayCudaShape(previous, imageLabel, output, object, offset) {
  const source = offset || {};
  const xOffset = number(source.x);
  const yOffset = number(source.y);
  const x = xOffset ? '(' + motionExpression(object, 'x') + '+' + ff(xOffset) + ')' : motionExpression(object, 'x');
  const y = yOffset ? '(' + motionExpression(object, 'y') + '+' + ff(yOffset) + ')' : motionExpression(object, 'y');
  return '[' + previous + '][' + imageLabel + ']overlay_cuda=x=' + "'" + x + "'" +
    ':y=' + "'" + y + "'" +
    ':eof_action=pass:repeatlast=0:eval=frame[' + output + ']';
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
  const outputDuration = Math.max(0.001, number(source.outputDuration, duration));
  const leadingVideoPaddingSec = Math.max(0, number(source.leadingVideoPaddingSec, 0));
  const canvasWidth = Math.max(2, Math.floor(number(plan.canvas?.width, 2) / 2) * 2);
  const canvasHeight = Math.max(2, Math.floor(number(plan.canvas?.height, 2) / 2) * 2);
  const legacyAssPath = String(source.legacyAssPath || '').trim();
  const cudaTarget = plan.target === 'cuda' && !legacyAssPath;
  const cudaAssTextureTarget = plan.target === 'cuda' && Boolean(legacyAssPath);
  // Desktop FFmpeg cannot rasterise a matching CJK glyph on CUDA. For the
  // frozen legacy presets, rasterise the established ASS semantics into one
  // transparent Scene texture, then keep decoded video, texture upload,
  // alpha blend and NVENC entirely on CUDA. This is the exact compatibility
  // bridge while the native glyph kernel remains an optimisation, not a
  // second layout engine.
  if (cudaAssTextureTarget) {
    const lead = leadingVideoPaddingSec > 0.0005 ? ff(leadingVideoPaddingSec) : '0';
    const inputBase = source.cudaInput === true
      ? '[0:v]settb=AVTB,setpts=PTS-STARTPTS[scene_cuda_source]'
      : '[0:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p,hwupload_cuda[scene_cuda_source]';
    const base = leadingVideoPaddingSec > 0.0005
      ? [
          inputBase,
          'color=c=black:s=' + canvasWidth + 'x' + canvasHeight + ':r=' + ff(fps) + ':d=' + lead +
            ',format=yuv420p,hwupload_cuda,setpts=PTS-STARTPTS[scene_cuda_lead]',
          '[scene_cuda_lead][scene_cuda_source]concat=n=2:v=1:a=0,trim=duration=' + ff(outputDuration) +
            ',setpts=PTS-STARTPTS[scene_cuda_base]'
        ]
      : [inputBase.replace('[scene_cuda_source]', '[scene_cuda_base]')];
    base.push(
      'color=c=black@0.0:s=' + canvasWidth + 'x' + canvasHeight + ':r=' + ff(fps) + ':d=' + ff(outputDuration) +
        ',format=rgba,settb=AVTB,setpts=PTS-STARTPTS+' + lead + "/TB,ass=filename='" + quoteFilter(legacyAssPath) + "',format=yuva420p,hwupload_cuda[scene_cuda_ass]",
      '[scene_cuda_base][scene_cuda_ass]overlay_cuda=x=0:y=0:eof_action=pass:repeatlast=0[ vout ]'.replace('[ vout ]', '[vout]')
    );
    return { plan, script: base.join(';\n') + '\n', renderer: 'cuda-ass-texture-compatibility' };
  }
  // Preserve the exact legacy filter topology. In particular, do not
  // round-trip through RGBA before libass: that shifts antialiasing and makes
  // two otherwise identical ASS renders differ.
  if (legacyAssPath) {
    if (leadingVideoPaddingSec > 0.0005) {
      const lead = ff(leadingVideoPaddingSec);
      return {
        plan,
        script: [
          'color=c=black:s=' + canvasWidth + 'x' + canvasHeight + ':r=' + ff(fps) + ':d=' + lead +
            ',format=yuv420p,setpts=PTS-STARTPTS[scene_legacy_lead]',
          "[0:v]settb=AVTB,setpts=PTS-STARTPTS+" + lead + "/TB,ass=filename='" + quoteFilter(legacyAssPath) +
            "'[scene_legacy_source]",
          '[scene_legacy_lead][scene_legacy_source]concat=n=2:v=1:a=0,trim=duration=' + ff(outputDuration) +
            ',setpts=PTS-STARTPTS,format=yuv420p[vout]'
        ].join(';\n') + '\n',
        renderer: 'libass-legacy-compatibility'
      };
    }
    return {
      plan,
      script: "[0:v]ass=filename='" + quoteFilter(legacyAssPath) + "'[vout]\n",
      renderer: 'libass-legacy-compatibility'
    };
  }
  // Scene Graph is rendered directly on the clean-video input. If that video
  // starts later than the source audio, prepend explicit black frames here so
  // the Scene clock and final mux remain aligned. This avoids tpad, which is
  // unreliable on older Jetson FFmpeg builds, and trims back to the requested
  // output timeline instead of extending the recording.
  const cudaInput = source.cudaInput === true;
  const uploadBase = cudaTarget && !cudaInput ? ',format=yuv420p,hwupload_cuda' : '';
  const filters = leadingVideoPaddingSec > 0.0005
    ? [
        '[0:v]settb=AVTB,setpts=PTS-STARTPTS' + (cudaTarget ? uploadBase : ',format=rgba') + '[scene_source_0]',
        'color=c=black:s=' + canvasWidth + 'x' + canvasHeight + ':r=' + ff(fps) + ':d=' + ff(leadingVideoPaddingSec) +
          (cudaTarget ? ',format=yuv420p,hwupload_cuda' : ',format=rgba') + ',setpts=PTS-STARTPTS[scene_lead_0]',
        '[scene_lead_0][scene_source_0]concat=n=2:v=1:a=0,trim=duration=' + ff(outputDuration) +
          ',setpts=PTS-STARTPTS' + (cudaTarget ? '' : ',format=rgba') + '[scene_base_0]'
      ]
    : ['[0:v]settb=AVTB,setpts=PTS-STARTPTS' + (cudaTarget ? uploadBase : ',format=rgba') + '[scene_base_0]'];
  let previous = 'scene_base_0';
  let index = 0;
  let cudaLayersInBatch = 0;
  const flushCudaBatch = () => {
    if (!cudaTarget || ++cudaLayersInBatch < 16) return;
    // FFmpeg keeps frames referenced by a long overlay_cuda chain alive until
    // downstream scheduling catches up. Periodically materialize the merged
    // CUDA frame and immediately re-upload it, bounding WDDM VRAM even for a
    // dense rolling-danmaku timeline. Scene pixels are never re-rendered.
    const batch = 'scene_cuda_batch_' + index;
    filters.push('[' + previous + ']hwdownload,format=yuv420p,hwupload_cuda[' + batch + ']');
    previous = batch;
    cudaLayersInBatch = 0;
  };
  for (const object of plan.objects) {
    if (object.type === 'Text') {
      for (const variant of textVariants(object)) {
        const image = 'scene_text_image_' + index;
        const cpuImage = cudaTarget ? image + '_cpu' : image;
        const output = 'scene_text_' + index;
        filters.push(textLayerFilter(variant, cpuImage, outputDuration, fps));
        if (cudaTarget) filters.push(uploadCudaLayer(cpuImage, image, variant));
        filters.push(cudaTarget ? overlayCudaShape(previous, image, output, variant) : overlayShape(previous, image, output, variant));
        previous = output;
        index += 1;
        flushCudaBatch();
      }
      continue;
    }
    if (!['Avatar', 'Rect', 'Card', 'SuperChat', 'Gift'].includes(object.type)) continue;
    const shadow = objectShadow(object);
    if (shadow) {
      const shadowImage = 'scene_shadow_image_' + index;
      const shadowCpuImage = cudaTarget ? shadowImage + '_cpu' : shadowImage;
      const shadowOutput = 'scene_shadow_' + index;
      const padding = Math.max(1, Math.ceil(shadow.blur * 2));
      filters.push(objectShapeFilter(shadowShapeObject(object, shadow), shadowCpuImage, outputDuration, fps, { padding, blur: shadow.blur }));
      if (cudaTarget) filters.push(uploadCudaLayer(shadowCpuImage, shadowImage, object));
      filters.push(cudaTarget
        ? overlayCudaShape(previous, shadowImage, shadowOutput, object, { x: shadow.offsetX - padding, y: shadow.offsetY - padding })
        : overlayShape(previous, shadowImage, shadowOutput, object, { x: shadow.offsetX - padding, y: shadow.offsetY - padding }));
      previous = shadowOutput;
      index += 1;
      flushCudaBatch();
    }
    const image = 'scene_image_' + index;
    const cpuImage = cudaTarget ? image + '_cpu' : image;
    const output = 'scene_layer_' + index;
    filters.push(object.type === 'Avatar' ? avatarFilter(object, cpuImage, outputDuration) : objectShapeFilter(object, cpuImage, outputDuration, fps));
    if (cudaTarget) filters.push(uploadCudaLayer(cpuImage, image, object));
    filters.push(cudaTarget ? overlayCudaShape(previous, image, output, object) : overlayShape(previous, image, output, object));
    previous = output;
    index += 1;
    flushCudaBatch();
  }
  filters.push(cudaTarget ? '[' + previous + ']null[vout]' : '[' + previous + ']format=yuv420p[vout]');
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
  uploadCudaLayer,
  overlayCudaShape,
  motionExpression,
  fadeExpression,
  scaleExpression,
  createSceneRenderPlan,
  createSceneFilterScript,
  writeSceneFilterScript,
  evaluateRenderPlan
};
