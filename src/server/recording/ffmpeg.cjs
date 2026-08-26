const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { readDanmakuEvents, getDanmakuEventVideoTime } = require('../danmaku/ass.cjs');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, '');
}

function formatFfmpegSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return seconds.toFixed(3).replace(/\.?0+$/, '') || '0';
}

function isHevcCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('hevc') || value.includes('h265') || value.includes('x265');
}

function escapeFilterPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function formatFilterNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toFixed(3).replace(/\.?0+$/, '') || '0';
}

function normalizeAvatarOverlayEntries(avatarOverlay) {
  const entries = Array.isArray(avatarOverlay?.entries) ? avatarOverlay.entries : [];
  return entries
    .map((entry) => {
      const imagePath = String(entry?.imagePath || '').trim();
      const segments = Array.isArray(entry?.segments)
        ? entry.segments
            .map((segment) => ({
              start: Number(segment?.start),
              end: Number(segment?.end),
              x1: Number(segment?.x1),
              x2: Number(segment?.x2),
              y1: Number(segment?.y1),
              y2: Number(segment?.y2)
            }))
            .filter(
              (segment) =>
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.end > segment.start &&
                [segment.x1, segment.x2, segment.y1, segment.y2].every(Number.isFinite)
            )
        : [];
      return { imagePath, segments };
    })
    .filter((entry) => entry.imagePath && entry.segments.length);
}

function avatarMotionExpression(segments, axis, offset = 0) {
  const coordinateOne = axis === 'x' ? 'x1' : 'y1';
  const coordinateTwo = axis === 'x' ? 'x2' : 'y2';
  const ordered = [...segments].sort((left, right) => left.start - right.start || left.end - right.end);
  const motionAt = (segment) => {
    const from = Number(segment[coordinateOne]) - offset;
    const to = Number(segment[coordinateTwo]) - offset;
    if (Math.abs(to - from) < 0.001 || segment.end - segment.start < 0.001) {
      return formatFilterNumber(from);
    }
    return `${formatFilterNumber(from)}+(${formatFilterNumber(to)}-${formatFilterNumber(from)})*(t-${formatFilterNumber(
      segment.start
    )})/${formatFilterNumber(segment.end - segment.start)}`;
  };
  let expression = motionAt(ordered[ordered.length - 1]);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const segment = ordered[index];
    expression = `if(between(t\\,${formatFilterNumber(segment.start)}\\,${formatFilterNumber(segment.end)})\\,${motionAt(
      segment
    )}\\,${expression})`;
  }
  return expression;
}

function avatarGpuMotionExpression(segments, axis, offset = 0) {
  const ordered = [...segments].sort((left, right) => left.start - right.start || left.end - right.end);
  const start = Math.min(...ordered.map((segment) => segment.start));
  const end = Math.max(...ordered.map((segment) => segment.end));
  // overlay_cuda does not expose FFmpeg's timeline `enable` switch. Keep the
  // source texture off-canvas outside its own queue lifetime instead; x/y are
  // still evaluated on the 60fps main timeline, so motion remains identical.
  const hidden = axis === 'x' ? '-overlay_w' : '-overlay_h';
  return `if(between(t\\,${formatFilterNumber(start)}\\,${formatFilterNumber(end)})\\,${avatarMotionExpression(
    ordered,
    axis,
    offset
  )}\\,${hidden})`;
}

function createLeadingVideoPaddingFilter(leadingVideoPaddingSec, outputDuration) {
  const padding = Math.max(0, Number(leadingVideoPaddingSec) || 0);
  if (padding <= 0.0005) return '';
  const filters = [
    `tpad=start_duration=${formatFilterNumber(padding)}:start_mode=add:color=black`
  ];
  const duration = Math.max(0, Number(outputDuration) || 0);
  // The source can begin with audio while its first decodable video frame is
  // later.  Once the black lead-in is added, trim back to the requested clip
  // length so the next independently-rendered chunk still starts on time.
  if (duration > 0) {
    filters.push(`trim=duration=${formatFilterNumber(duration)}`, 'setpts=PTS-STARTPTS');
  }
  return `,${filters.join(',')}`;
}

function createBurnVideoFilter(assPath, fps, options = {}) {
  // Independently rendered chunks already carry the source's frame cadence.
  // Re-applying fps=... per chunk can round the last presentation timestamps
  // differently in every encoder process, which then becomes cumulative A/V
  // drift when the chunks are joined. Keep the original frame clock for that
  // path and only normalize FPS for a single, whole-file render.
  const targetFps = options.preserveSourceFrameTiming ? 0 : normalizeMergeFps(fps);
  const fpsFilter = targetFps ? `,fps=${targetFps}:start_time=0` : '';
  const timelineOffset = Math.max(0, Number(options.timelineOffset) || 0);
  const leadingVideoPaddingSec = Math.max(0, Number(options.leadingVideoPaddingSec) || 0);
  const inputTrimStartSec = Math.max(0, Number(options.inputTrimStartSec) || 0);
  const rawInputTrimEndSec = Number(options.inputTrimEndSec);
  const inputTrimEndSec = Number.isFinite(rawInputTrimEndSec) && rawInputTrimEndSec > inputTrimStartSec ? rawInputTrimEndSec : 0;
  const inputTrimFilter =
    inputTrimStartSec > 0.0005 || inputTrimEndSec > 0.0005
      ? `,trim=start=${formatFilterNumber(inputTrimStartSec)}${
          inputTrimEndSec > 0.0005 ? `:end=${formatFilterNumber(inputTrimEndSec)}` : ''
        },setpts=PTS-STARTPTS`
      : '';
  const selectFilter = options.skipInitialKeyframeGuard
    ? "select='1'"
    : "select='if(isnan(prev_selected_t)\\,key\\,1)'";
  const sourceClockFilter = timelineOffset
    ? `,settb=AVTB,setpts=PTS-STARTPTS+${formatFilterNumber(timelineOffset)}/TB`
    : '';
  const outputClockFilter = options.resetOutputTimestamps || leadingVideoPaddingSec > 0 ? ',setpts=PTS-STARTPTS' : '';
  const leadingPaddingFilter = createLeadingVideoPaddingFilter(leadingVideoPaddingSec, options.outputDuration);
  return (
    `settb=AVTB,setpts=PTS-STARTPTS${inputTrimFilter},${selectFilter}${fpsFilter}${sourceClockFilter},` +
    `ass='${escapeFilterPath(assPath)}'${outputClockFilter}${leadingPaddingFilter}`
  );
}

function avatarSegmentAt(segment, time, coordinateOne, coordinateTwo) {
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  const from = Number(segment?.[coordinateOne]);
  const to = Number(segment?.[coordinateTwo]);
  if (![start, end, from, to].every(Number.isFinite) || end <= start) {
    return Number.isFinite(from) ? from : 0;
  }
  const ratio = Math.max(0, Math.min(1, (time - start) / (end - start)));
  return from + (to - from) * ratio;
}

function clipAvatarSegments(segments, start, end) {
  return segments
    .map((segment) => {
      const segmentStart = Number(segment.start);
      const segmentEnd = Number(segment.end);
      const clippedStart = Math.max(start, segmentStart);
      const clippedEnd = Math.min(end, segmentEnd);
      if (!Number.isFinite(clippedStart) || !Number.isFinite(clippedEnd) || clippedEnd <= clippedStart) {
        return null;
      }
      return {
        start: clippedStart,
        end: clippedEnd,
        x1: avatarSegmentAt(segment, clippedStart, 'x1', 'x2'),
        x2: avatarSegmentAt(segment, clippedEnd, 'x1', 'x2'),
        y1: avatarSegmentAt(segment, clippedStart, 'y1', 'y2'),
        y2: avatarSegmentAt(segment, clippedEnd, 'y1', 'y2')
      };
    })
    .filter(Boolean);
}

function clipAvatarOverlayEntries(avatarOverlay, start, end) {
  return normalizeAvatarOverlayEntries(avatarOverlay)
    .map((entry) => ({ ...entry, segments: clipAvatarSegments(entry.segments, start, end) }))
    .filter((entry) => entry.segments.length);
}

function createChunkedAvatarOverlayFilterScript({ assPath, fps, avatarOverlay, entries, duration, chunkDuration }) {
  const safeChunkDuration = Math.max(1, Number(chunkDuration) || 0);
  if (!safeChunkDuration) return '';
  const maxSegmentEnd = Math.max(
    0,
    ...entries.flatMap((entry) => entry.segments.map((segment) => Number(segment.end)).filter(Number.isFinite))
  );
  const timelineDuration = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : maxSegmentEnd;
  const chunkCount = Math.max(1, Math.ceil(timelineDuration / safeChunkDuration));
  const panel = avatarOverlay?.panel || {};
  const panelLeft = Math.max(0, Number(panel.left) || 0);
  const panelWidth = Math.max(1, Math.ceil(Number(panel.width) || 1));
  const panelHeight = Math.max(1, Math.ceil(Number(panel.height) || 1));
  const layerFps = normalizeMergeFps(fps) || 30;
  const filters = [];
  const splitLabels = Array.from({ length: chunkCount }, (_unused, index) => `[avatar_chunk_input_${index}]`).join('');
  filters.push(`[0:v]${createBurnVideoFilter(assPath, fps)},split=${chunkCount}${splitLabels}`);
  const outputLabels = [];

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunkStart = chunkIndex * safeChunkDuration;
    const chunkEnd = Math.min(timelineDuration, (chunkIndex + 1) * safeChunkDuration);
    const chunkBase = `avatar_chunk_base_${chunkIndex}`;
    const chunkOutput = `avatar_chunk_output_${chunkIndex}`;
    outputLabels.push(`[${chunkOutput}]`);
    filters.push(
      `[avatar_chunk_input_${chunkIndex}]trim=start=${formatFilterNumber(chunkStart)}:end=${formatFilterNumber(chunkEnd)}[${chunkBase}]`
    );
    const chunkEntries = entries
      .map((entry) => ({ ...entry, segments: clipAvatarSegments(entry.segments, chunkStart, chunkEnd) }))
      .filter((entry) => entry.segments.length);

    if (!chunkEntries.length) {
      filters.push(`[${chunkBase}]format=yuv420p,setpts=PTS-STARTPTS[${chunkOutput}]`);
      continue;
    }

    const firstLayer = `avatar_chunk_layer_${chunkIndex}_0`;
    filters.push(
      `color=c=black@0.0:s=${panelWidth}x${panelHeight}:r=${layerFps},format=rgba,settb=AVTB,setpts=PTS-STARTPTS+${formatFilterNumber(
        chunkStart
      )}/TB[${firstLayer}]`
    );
    let previousLayer = firstLayer;
    for (let entryIndex = 0; entryIndex < chunkEntries.length; entryIndex += 1) {
      const entry = chunkEntries[entryIndex];
      const imageLabel = `avatar_chunk_image_${chunkIndex}_${entryIndex}`;
      const nextLayer = `avatar_chunk_layer_${chunkIndex}_${entryIndex + 1}`;
      const start = Math.min(...entry.segments.map((segment) => segment.start));
      const end = Math.max(...entry.segments.map((segment) => segment.end));
      filters.push(
        `movie='${escapeFilterPath(entry.imagePath)}',settb=AVTB,setpts=PTS-STARTPTS,format=rgba,loop=loop=-1:size=1:start=0[${imageLabel}]`
      );
      filters.push(
        `[${previousLayer}][${imageLabel}]overlay=` +
          `x='${avatarMotionExpression(entry.segments, 'x', panelLeft)}':` +
          `y='${avatarMotionExpression(entry.segments, 'y')}':` +
          `enable='between(t\\,${formatFilterNumber(start)}\\,${formatFilterNumber(end)})':` +
          `eof_action=pass:repeatlast=1:format=auto[${nextLayer}]`
      );
      previousLayer = nextLayer;
    }
    filters.push(
      `[${chunkBase}][${previousLayer}]overlay=x=${formatFilterNumber(panelLeft)}:y=0:` +
        'eof_action=pass:repeatlast=0:format=auto,format=yuv420p,setpts=PTS-STARTPTS' +
        `[${chunkOutput}]`
    );
  }

  filters.push(`${outputLabels.join('')}concat=n=${chunkCount}:v=1:a=0,format=yuv420p[vout]`);
  return `${filters.join(';\n')}\n`;
}

// CPU rendering builds avatar artwork in a transparent side-panel stream and
// composites it once above ASS. CUDA's overlay filter cannot chain a
// transparent alpha main input, so its path composites the same circles
// directly onto the already-rendered ASS video. The vector portrait beneath
// remains the failure fallback in both cases.
function createAvatarOverlayFilterScript({
  assPath,
  fps,
  avatarOverlay,
  gpuComposite = false,
  duration,
  chunkDuration,
  timelineOffset = 0,
  resetOutputTimestamps = false,
  leadingVideoPaddingSec = 0,
  outputDuration = 0,
  skipInitialKeyframeGuard = false,
  inputTrimStartSec = 0,
  inputTrimEndSec = 0,
  preserveSourceFrameTiming = false
} = {}) {
  const entries = normalizeAvatarOverlayEntries(avatarOverlay);
  if (!entries.length) return '';
  if (!gpuComposite && Number(chunkDuration) > 0) {
    return createChunkedAvatarOverlayFilterScript({ assPath, fps, avatarOverlay, entries, duration, chunkDuration });
  }
  const sourceClockOffset = Math.max(0, Number(timelineOffset) || 0);
  const panelClockFilter = sourceClockOffset
    ? `settb=AVTB,setpts=PTS-STARTPTS+${formatFilterNumber(sourceClockOffset)}/TB`
    : 'settb=AVTB,setpts=PTS-STARTPTS';
  const imageClockFilter = sourceClockOffset
    ? `,settb=AVTB,setpts=PTS-STARTPTS+${formatFilterNumber(sourceClockOffset)}/TB`
    : '';
  const leadingVideoPadding = Math.max(0, Number(leadingVideoPaddingSec) || 0);
  const outputClockFilter = resetOutputTimestamps || sourceClockOffset || leadingVideoPadding > 0 ? ',setpts=PTS-STARTPTS' : '';
  const leadingPaddingFilter = createLeadingVideoPaddingFilter(leadingVideoPadding, outputDuration);
  const panel = avatarOverlay?.panel || {};
  const panelLeft = Math.max(0, Number(panel.left) || 0);
  const panelWidth = Math.max(1, Math.ceil(Number(panel.width) || 1));
  const panelHeight = Math.max(1, Math.ceil(Number(panel.height) || 1));
  const layerFps = normalizeMergeFps(fps) || 30;
  const filters = [
    gpuComposite
      ? `[0:v]${createBurnVideoFilter(assPath, fps, {
        timelineOffset: sourceClockOffset,
        skipInitialKeyframeGuard,
        inputTrimStartSec,
        inputTrimEndSec,
        preserveSourceFrameTiming
      })},hwupload_cuda[avatar_layer_0]`
      : `[0:v]${createBurnVideoFilter(assPath, fps, {
          timelineOffset: sourceClockOffset,
          skipInitialKeyframeGuard,
          inputTrimStartSec,
          inputTrimEndSec,
          preserveSourceFrameTiming
        })}[burn_base]`
  ];
  if (!gpuComposite) {
    filters.push(
      `color=c=black@0.0:s=${panelWidth}x${panelHeight}:r=${layerFps},format=rgba,${panelClockFilter}[avatar_layer_0]`
    );
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const imageLabel = `avatar_image_${index}`;
    const previousLayer = `avatar_layer_${index}`;
    const nextLayer = `avatar_layer_${index + 1}`;
    const start = Math.min(...entry.segments.map((segment) => segment.start));
    const end = Math.max(...entry.segments.map((segment) => segment.end));
    filters.push(
      `movie='${escapeFilterPath(entry.imagePath)}',settb=AVTB,setpts=PTS-STARTPTS,format=rgba${
        gpuComposite ? ',loop=loop=-1:size=1:start=0' : ',loop=loop=-1:size=1:start=0'
      }${imageClockFilter}${gpuComposite ? ',hwupload_cuda' : ''}[${imageLabel}]`
    );
    if (gpuComposite) {
      filters.push(
        `[${previousLayer}][${imageLabel}]overlay_cuda=` +
          `x='${avatarGpuMotionExpression(entry.segments, 'x')}':` +
          `y='${avatarGpuMotionExpression(entry.segments, 'y')}':` +
          `eof_action=pass:repeatlast=1[${nextLayer}]`
      );
    } else {
      filters.push(
        `[${previousLayer}][${imageLabel}]overlay=` +
          `x='${avatarMotionExpression(entry.segments, 'x', panelLeft)}':` +
          `y='${avatarMotionExpression(entry.segments, 'y')}':` +
          `enable='between(t\\,${formatFilterNumber(start)}\\,${formatFilterNumber(end)})':` +
          `eof_action=pass:repeatlast=1:format=auto[${nextLayer}]`
      );
    }
  }
  filters.push(
    gpuComposite
      ? `[avatar_layer_${entries.length}]scale_cuda=format=yuv420p${
          leadingPaddingFilter ? ',hwdownload,format=yuv420p' : ''
        }${outputClockFilter}${leadingPaddingFilter}[vout]`
      : `[burn_base][avatar_layer_${entries.length}]overlay=x=${formatFilterNumber(panelLeft)}:y=0:` +
          `eof_action=pass:repeatlast=0:format=auto,format=yuv420p${outputClockFilter}${leadingPaddingFilter}[vout]`
  );
  return `${filters.join(';\n')}\n`;
}

// Build only the filter graph needed for one source-time window.  This is
// intentionally separate from the legacy all-in-one chunk graph above: long
// recordings must not make FFmpeg parse thousands of windows in one process.
function createAvatarOverlayChunkFilterScript({
  assPath,
  fps,
  avatarOverlay,
  chunkStart,
  chunkEnd,
  timelineOffset,
  leadingVideoPaddingSec = 0,
  outputDuration = 0,
  inputTrimStartSec = 0,
  inputTrimEndSec = 0,
  preserveSourceFrameTiming = true,
  gpuComposite = false
} = {}) {
  const start = Math.max(0, Number(chunkStart) || 0);
  const end = Number(chunkEnd);
  const entries = clipAvatarOverlayEntries(avatarOverlay, start, end);
  const sourceClockOffset = Math.max(0, Number.isFinite(Number(timelineOffset)) ? Number(timelineOffset) : start);
  if (!entries.length) {
    return (
      `[0:v]${createBurnVideoFilter(assPath, fps, {
        timelineOffset: sourceClockOffset,
        skipInitialKeyframeGuard: true,
        resetOutputTimestamps: true,
        leadingVideoPaddingSec,
        outputDuration,
        inputTrimStartSec,
        inputTrimEndSec,
        preserveSourceFrameTiming
      })},format=yuv420p[vout]\n`
    );
  }
  return createAvatarOverlayFilterScript({
    assPath,
    fps,
    avatarOverlay: { ...(avatarOverlay || {}), entries },
    gpuComposite,
    timelineOffset: sourceClockOffset,
    resetOutputTimestamps: true,
    leadingVideoPaddingSec,
    outputDuration,
    skipInitialKeyframeGuard: true,
    inputTrimStartSec,
    inputTrimEndSec,
    preserveSourceFrameTiming
  });
}

function createRecordingArgs({ streamUrl, headers, outputPath, maxDurationSec, streamProtocol, streamFormat }) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:2',
    '-y',
    '-fflags',
    '+discardcorrupt',
    '-rw_timeout',
    '30000000'
  ];
  // Do not let FFmpeg transparently reconnect into the same Matroska file.
  // A reconnect can restart source timestamps and make one segment internally
  // discontinuous.  The service owns reconnects and starts a fresh segment.
  args.push('-user_agent', USER_AGENT, '-headers', headers, '-i', streamUrl);
  if (Number.isFinite(Number(maxDurationSec)) && Number(maxDurationSec) > 0) {
    args.push('-t', formatFfmpegSeconds(maxDurationSec));
  }
  args.push(
    '-ignore_unknown',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-dn',
    '-sn',
    '-f',
    'matroska',
    outputPath
  );
  return args;
}

function createMp4FinalizeArgs({ inputPath, outputPath, streamCodec }) {
  const args = [
    '-hide_banner',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-i',
    inputPath,
    '-ignore_unknown',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-dn',
    '-sn',
    '-avoid_negative_ts',
    'make_zero'
  ];
  if (isHevcCodec(streamCodec)) {
    args.push('-tag:v', 'hvc1');
  }
  args.push('-movflags', '+faststart', outputPath);
  return args;
}

function createBurnArgs({
  cleanPath,
  assPath,
  burnedPath,
  codec,
  crf,
  container,
  startTime,
  duration,
  fps,
  avatarOverlay,
  inputSeek = false,
  inputSeekPrerollSec = 0,
  inputTrimStartSec = 0,
  inputTrimEndSec = 0,
  timelineOffset = 0,
  leadingVideoPaddingSec = 0,
  leadingAudioPaddingSec = 0,
  includeAudio = true
}) {
  const hasStart = Number.isFinite(Number(startTime)) && Number(startTime) > 0;
  const hasDuration = Number.isFinite(Number(duration)) && Number(duration) > 0;
  // For independently rendered chunks, seek close to the boundary quickly.
  // The generated filter graph trims this short preroll before assigning the
  // source clock, so a preceding long-GOP keyframe cannot leak into a chunk.
  const inputSeekPreroll = inputSeek && hasStart
    ? Math.min(Number(startTime), Math.max(0, Number(inputSeekPrerollSec) || 0))
    : 0;
  const inputSeekStart = Math.max(0, Number(startTime) - inputSeekPreroll);
  const hasFilterScript = Boolean(String(avatarOverlay?.filterScriptPath || '').trim());
  const avatarEntries = hasFilterScript ? normalizeAvatarOverlayEntries(avatarOverlay) : [];
  const gpuAvatarComposite = Boolean(avatarEntries.length && avatarOverlay?.gpuComposite && String(codec || '').includes('nvenc'));
  const args = ['-hide_banner', '-y', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err'];
  if (gpuAvatarComposite) {
    args.push('-init_hw_device', 'cuda=br2k_avatar:0', '-filter_hw_device', 'br2k_avatar');
  }
  if (inputSeek && hasStart) {
    args.push('-ss', formatFfmpegSeconds(inputSeekStart));
  }
  args.push('-i', cleanPath);
  if (!inputSeek && hasStart) {
    args.push('-ss', formatFfmpegSeconds(startTime));
  }
  if (hasDuration) {
    args.push('-t', formatFfmpegSeconds(duration));
  }
  if (hasFilterScript) {
    args.push('-filter_complex_script', avatarOverlay.filterScriptPath, '-map', '[vout]');
    if (includeAudio) args.push('-map', '0:a?');
  } else {
    args.push('-map', '0:v:0');
    if (includeAudio) args.push('-map', '0:a?');
    args.push(
      '-vf',
      createBurnVideoFilter(assPath, fps, {
        timelineOffset,
        resetOutputTimestamps: Boolean(inputSeek) || Math.max(0, Number(leadingVideoPaddingSec) || 0) > 0,
        leadingVideoPaddingSec,
        outputDuration: duration,
        skipInitialKeyframeGuard: Boolean(inputSeek),
        inputTrimStartSec,
        inputTrimEndSec
      })
    );
  }
  args.push('-c:v', codec || 'libx265');

  if ((codec || '').includes('nvenc')) {
    args.push('-preset', 'p5', '-cq', String(crf), '-b:v', '0');
  } else if ((codec || '').includes('qsv')) {
    args.push('-global_quality', String(crf));
  } else if ((codec || '').includes('amf')) {
    args.push('-quality', 'balanced', '-qp_i', String(crf), '-qp_p', String(crf));
  } else {
    args.push('-preset', 'medium', '-crf', String(crf));
  }

  args.push('-avoid_negative_ts', 'make_zero');

  if (container === 'mp4') {
    if (isHevcCodec(codec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }

  if (includeAudio) {
    const audioPaddingMs = Math.max(0, Math.round((Number(leadingAudioPaddingSec) || 0) * 1000));
    const audioFilters = ['aresample=48000:async=1:first_pts=0', 'asetpts=PTS-STARTPTS'];
    if (audioPaddingMs > 0) audioFilters.push(`adelay=${audioPaddingMs}:all=1`);
    audioFilters.push('asetpts=PTS-STARTPTS');
    args.push(
      '-af',
      audioFilters.join(','),
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ac',
      '2'
    );
  } else {
    args.push('-an');
  }
  args.push(burnedPath);
  return args;
}

function createBurnAudioMuxArgs({
  concatPath,
  cleanPath,
  outputPath,
  codec,
  crf,
  startTime,
  duration,
  container,
  leadingAudioPaddingSec = 0,
  includeAudio = true
}) {
  const hasStart = Number.isFinite(Number(startTime)) && Number(startTime) > 0;
  const hasDuration = Number.isFinite(Number(duration)) && Number(duration) > 0;
  const args = [
    '-hide_banner',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath
  ];
  if (includeAudio) {
    if (hasStart) args.push('-ss', formatFfmpegSeconds(startTime));
    args.push('-i', cleanPath);
  }
  if (hasDuration) args.push('-t', formatFfmpegSeconds(duration));
  args.push('-map', '0:v:0');
  if (includeAudio) {
    const audioPaddingMs = Math.max(0, Math.round((Number(leadingAudioPaddingSec) || 0) * 1000));
    const audioFilters = ['aresample=48000:async=1:first_pts=0', 'asetpts=PTS-STARTPTS'];
    if (audioPaddingMs > 0) audioFilters.push(`adelay=${audioPaddingMs}:all=1`);
    if (hasDuration) audioFilters.push(`atrim=duration=${formatFfmpegSeconds(duration)}`);
    audioFilters.push('asetpts=PTS-STARTPTS');
    args.push(
      '-map',
      '1:a?',
      '-af',
      audioFilters.join(','),
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ac',
      '2',
      '-shortest'
    );
  } else {
    args.push('-an');
  }
  args.push('-c:v', 'copy', '-dn', '-sn', '-avoid_negative_ts', 'make_zero');
  if (container === 'mp4') {
    if (isHevcCodec(codec)) args.push('-tag:v', 'hvc1');
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function createPreviewHlsArgs({ inputPath, playlistPath, segmentPattern }) {
  return [
    '-hide_banner',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    'scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-dn',
    '-sn',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    segmentPattern,
    playlistPath
  ];
}

function createClipCopyArgs({ cleanPath, outputPath, startTime, duration, container }) {
  const args = [
    '-hide_banner',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-i',
    cleanPath,
    '-ss',
    formatFfmpegSeconds(startTime),
    '-t',
    formatFfmpegSeconds(duration),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-dn',
    '-sn',
    '-avoid_negative_ts',
    'make_zero'
  ];
  if (container === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function createConcatCopyArgs({ concatPath, outputPath, container, streamCodec }) {
  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-map', '0', '-c', 'copy'];
  if (container === 'mp4') {
    if (isHevcCodec(streamCodec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function resolveMergePixelFormat(targetVideoInfo, videoCodec) {
  const sourcePixelFormat = String(targetVideoInfo?.pixelFormat || '').toLowerCase();
  const hardwareCodec = /(?:nvenc|qsv|amf)/.test(String(videoCodec || ''));
  const bitDepth = Number(targetVideoInfo?.bitDepth || 8);
  const softwarePixelFormats = new Set([
    'yuv420p', 'yuv422p', 'yuv444p',
    'yuv420p10le', 'yuv422p10le', 'yuv444p10le',
    'yuv420p12le', 'yuv422p12le', 'yuv444p12le'
  ]);
  if (hardwareCodec && bitDepth > 8) {
    return 'p010le';
  }
  if (softwarePixelFormats.has(sourcePixelFormat)) {
    return sourcePixelFormat;
  }
  return bitDepth > 8 ? 'yuv420p10le' : 'yuv420p';
}

function appendMergeEncodeArgs(args, { container, targetVideoInfo, videoCodec, softwareThreads = 4 }) {
  const codec = String(videoCodec || '').trim() || 'libx264';
  args.push('-c:v', codec);
  if (codec.includes('nvenc')) {
    args.push('-preset', 'p5', '-cq', isHevcCodec(codec) ? '24' : '20', '-b:v', '0');
  } else if (codec.includes('qsv')) {
    args.push('-global_quality', isHevcCodec(codec) ? '24' : '20');
  } else if (codec.includes('amf')) {
    const qp = isHevcCodec(codec) ? '24' : '20';
    args.push('-quality', 'balanced', '-qp_i', qp, '-qp_p', qp);
  } else {
    args.push('-preset', 'veryfast', '-crf', isHevcCodec(codec) ? '24' : '20', '-threads', String(Math.max(1, Number(softwareThreads) || 4)));
  }
  if (targetVideoInfo?.colorPrimaries) args.push('-color_primaries', String(targetVideoInfo.colorPrimaries));
  if (targetVideoInfo?.colorTransfer) args.push('-color_trc', String(targetVideoInfo.colorTransfer));
  if (targetVideoInfo?.colorSpace) args.push('-colorspace', String(targetVideoInfo.colorSpace));
  args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-dn', '-sn', '-avoid_negative_ts', 'make_zero');
  if (container === 'mp4') {
    if (isHevcCodec(codec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }
  return codec;
}

function createNormalizeSegmentArgs({
  inputPath,
  outputPath,
  container,
  durationSec,
  hasAudio,
  targetVideoInfo,
  videoCodec,
  softwareThreads = 4
}) {
  const width = makeEvenDimension(targetVideoInfo?.width);
  const height = makeEvenDimension(targetVideoInfo?.height);
  if (!inputPath || !outputPath) {
    throw new Error('规范化分段缺少输入或输出路径。');
  }
  if (!width || !height) {
    throw new Error('规范化分段缺少有效的目标分辨率。');
  }

  // This is intentionally a single-input graph.  Feeding every reconnect
  // segment into one concat filter keeps one decoder and several frame queues
  // alive per source, which can push a long 2K merge over the host memory
  // limit.  The service normalizes segments one at a time, then concat-copies
  // the uniform intermediates.
  const args = [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:2',
    '-y',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    '-threads',
    '2',
    '-fflags',
    '+genpts+discardcorrupt',
    '-i',
    inputPath
  ];
  const targetFps = normalizeMergeFps(targetVideoInfo?.fps);
  const fpsFilter = targetFps ? `,fps=${targetFps}` : '';
  const normalizedDuration = Number(durationSec);
  const videoDurationFilter = normalizedDuration > 0 ? `trim=duration=${formatFfmpegSeconds(normalizedDuration)},` : '';
  const audioDurationFilter = normalizedDuration > 0 ? `apad,atrim=duration=${formatFfmpegSeconds(normalizedDuration)},` : '';
  const pixelFormat = resolveMergePixelFormat(targetVideoInfo, videoCodec);
  const filters = [
    `[0:v:0]${videoDurationFilter}settb=AVTB,setpts=PTS-STARTPTS,` +
      `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${fpsFilter},format=${pixelFormat}[vout]`
  ];
  if (hasAudio) {
    filters.push(
      `[0:a:0]aresample=48000:async=1:first_pts=0,${audioDurationFilter}` +
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[aout]'
    );
  } else {
    const fallbackDurationSec = Math.max(0.001, normalizedDuration || 0.001);
    filters.push(
      `anullsrc=r=48000:cl=stereo,atrim=duration=${formatFfmpegSeconds(fallbackDurationSec)},asetpts=PTS-STARTPTS[aout]`
    );
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  appendMergeEncodeArgs(args, { container, targetVideoInfo, videoCodec, softwareThreads });
  args.push(outputPath);
  return args;
}

function createConcatTranscodeArgs({ segments, outputPath, container, targetVideoInfo, videoCodec, softwareThreads = 4 }) {
  const width = makeEvenDimension(targetVideoInfo?.width);
  const height = makeEvenDimension(targetVideoInfo?.height);
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new Error('统一规格合并至少需要两个视频分段。');
  }
  if (!width || !height) {
    throw new Error('统一规格合并缺少有效的目标分辨率。');
  }

  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-y', '-fflags', '+genpts+discardcorrupt'];
  for (const segment of segments) {
    args.push('-i', segment.filePath);
  }

  const targetFps = normalizeMergeFps(targetVideoInfo?.fps);
  const pixelFormat = resolveMergePixelFormat(targetVideoInfo, videoCodec);
  const filters = [];
  const concatInputs = [];
  segments.forEach((segment, index) => {
    const fpsFilter = targetFps ? `,fps=${targetFps}` : '';
    const videoDurationFilter = Number(segment.durationSec) > 0
      ? `trim=duration=${formatFfmpegSeconds(segment.durationSec)},`
      : '';
    const audioDurationFilter = Number(segment.durationSec) > 0
      ? `apad,atrim=duration=${formatFfmpegSeconds(segment.durationSec)},`
      : '';
    filters.push(
      `[${index}:v:0]${videoDurationFilter}settb=AVTB,setpts=PTS-STARTPTS,` +
        `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${fpsFilter},format=${pixelFormat}[v${index}]`
    );
    if (segment.hasAudio) {
      filters.push(
        `[${index}:a:0]aresample=48000:async=1:first_pts=0,${audioDurationFilter}` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`
      );
    } else {
      const durationSec = Math.max(0.001, Number(segment.durationSec) || 0.001);
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${formatFfmpegSeconds(durationSec)},` +
          `asetpts=PTS-STARTPTS[a${index}]`
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`);

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  appendMergeEncodeArgs(args, { container, targetVideoInfo, videoCodec, softwareThreads });
  args.push(outputPath);
  return args;
}

function createAudioAlignArgs({ inputPath, outputPath, container, videoDurationSec }) {
  const duration = Number(videoDurationSec || 0);
  if (!duration) throw new Error('音画对齐缺少有效的视频时长。');
  const args = [
    '-hide_banner', '-nostats', '-progress', 'pipe:2', '-y', '-i', inputPath,
    '-filter_complex', `[0:a:0]aresample=48000:async=1:first_pts=0,apad,atrim=duration=${formatFfmpegSeconds(duration)},asetpts=PTS-STARTPTS[aout]`,
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-dn', '-sn', '-avoid_negative_ts', 'make_zero'
  ];
  if (container === 'mp4') args.push('-movflags', '+faststart');
  args.push(outputPath);
  return args;
}

function selectHighestResolutionVideoInfo(mediaInfos) {
  const candidates = (mediaInfos || [])
    .map((mediaInfo) => mediaInfo?.videoInfo || mediaInfo)
    .filter((videoInfo) => Number(videoInfo?.width) > 0 && Number(videoInfo?.height) > 0);
  if (!candidates.length) {
    return null;
  }
  const highestResolution = candidates.reduce((best, candidate) => {
    const bestPixels = Number(best.width) * Number(best.height);
    const candidatePixels = Number(candidate.width) * Number(candidate.height);
    if (candidatePixels !== bestPixels) {
      return candidatePixels > bestPixels ? candidate : best;
    }
    if (Number(candidate.width) !== Number(best.width)) {
      return Number(candidate.width) > Number(best.width) ? candidate : best;
    }
    return Number(candidate.height) > Number(best.height) ? candidate : best;
  });
  return {
    ...highestResolution,
    width: makeEvenDimension(highestResolution.width),
    height: makeEvenDimension(highestResolution.height),
    fps: highestResolution.fps
  };
}

function shouldTranscodeConcat(mediaInfos) {
  const infos = Array.isArray(mediaInfos) ? mediaInfos : [];
  if (infos.length < 2 || infos.some((mediaInfo) => !mediaInfo?.videoInfo)) {
    return infos.length >= 2;
  }
  const signatures = new Set(infos.map(createConcatStreamSignature));
  return signatures.size > 1;
}

function assertSafeMergeTargetProfile(mediaInfos, targetVideoInfo, options = {}) {
  const videoInfos = (mediaInfos || []).map((item) => item?.videoInfo || item).filter(Boolean);
  if (!videoInfos.length || !targetVideoInfo) throw new Error('缺少可验证的合并视频 profile。');
  const hdrModes = new Set(videoInfos.map((info) => Boolean(info.hdr)));
  if (hdrModes.size > 1) {
    throw new Error('分段同时包含 HDR 与 SDR；为避免错误色彩转换，已拒绝自动合并并保留所有源分段。');
  }
  const bitDepth = (info) => Math.max(8, Number(info?.bitDepth || 8));
  const chromaRank = (info) => {
    const pixelFormat = String(info?.pixelFormat || '').toLowerCase();
    if (pixelFormat.includes('444')) return 3;
    if (pixelFormat.includes('422')) return 2;
    return 1;
  };
  const maxBitDepth = Math.max(...videoInfos.map(bitDepth));
  const maxChromaRank = Math.max(...videoInfos.map(chromaRank));
  if (bitDepth(targetVideoInfo) < maxBitDepth || chromaRank(targetVideoInfo) < maxChromaRank) {
    throw new Error(
      `真实目标 profile 无法同时覆盖源分段的 ${maxBitDepth}bit/色度规格；已拒绝静默降质并保留所有源分段。`
    );
  }
  for (const field of ['colorPrimaries', 'colorTransfer', 'colorSpace']) {
    const knownValues = new Set(
      videoInfos
        .map((info) => String(info?.[field] || '').trim().toLowerCase())
        .filter((value) => value && value !== 'unknown' && value !== 'unspecified')
    );
    if (knownValues.size > 1) {
      throw new Error(`分段 ${field} 不一致；已拒绝未经验证的色彩转换并保留所有源分段。`);
    }
  }
  if (Boolean(targetVideoInfo.hdr) && options.requiresVideoTranscode) {
    throw new Error('跨规格 HDR 合并需要重编码且可能丢失 mastering metadata；已拒绝静默降质并保留所有源分段。');
  }
  return true;
}

function createConcatStreamSignature(mediaInfo) {
  const videoInfo = mediaInfo?.videoInfo || {};
  const audioInfo = mediaInfo?.audioInfo || null;
  const videoCodec = normalizeCodecFamily(videoInfo.codec);
  const audioCodec = audioInfo ? normalizeCodecFamily(audioInfo.codec) : 'none';
  return [
    videoCodec,
    `${Number(videoInfo.width) || 0}x${Number(videoInfo.height) || 0}`,
    normalizeMergeFps(videoInfo.fps) || 'unknown-fps',
    String(videoInfo.profile || '').toLowerCase(),
    String(videoInfo.pixelFormat || '').toLowerCase(),
    Number(videoInfo.bitDepth || 0),
    String(videoInfo.colorSpace || '').toLowerCase(),
    String(videoInfo.colorPrimaries || '').toLowerCase(),
    String(videoInfo.colorTransfer || '').toLowerCase(),
    videoInfo.hdr ? 'hdr' : 'sdr',
    audioCodec,
    Number(audioInfo?.sampleRate) || 0,
    String(audioInfo?.channelLayout || '')
  ].join('|');
}

function normalizeCodecFamily(codec) {
  const value = String(codec || '').toLowerCase();
  if (isHevcCodec(value)) {
    return 'hevc';
  }
  if (value.includes('h264') || value.includes('avc')) {
    return 'h264';
  }
  if (value.includes('aac')) {
    return 'aac';
  }
  return value.split(/[\s,(]/)[0] || 'unknown';
}

function makeEvenDimension(value) {
  const dimension = Math.floor(Number(value) || 0);
  return dimension > 0 ? dimension - (dimension % 2) : 0;
}

function normalizeMergeFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return Number(fps.toFixed(3));
}

async function writeConcatFile(concatPath, filePaths, options = {}) {
  const durations = Array.isArray(options?.durations) ? options.durations : [];
  const body = filePaths
    .map((filePath, index) => {
      const duration = Number(durations[index]);
      const lines = [`file '${escapeConcatPath(filePath)}'`];
      // H.26x B-frames make a container's final decode timestamp earlier than
      // its final presentation timestamp. The concat demuxer otherwise uses
      // that shortened value as the next chunk's origin, advancing video a
      // few frames at every boundary. The caller supplies the exact source
      // time window when it is known.
      if (Number.isFinite(duration) && duration > 0) {
        lines.push(`duration ${formatFfmpegSeconds(duration)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  await fsp.writeFile(concatPath, `${body}\n`, 'utf8');
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function mergeDanmakuFiles(segments, outputPath) {
  const lines = [];
  let offset = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const events = await readDanmakuEvents(segment.danmakuPath);
    for (const event of events) {
      const videoTime = Math.max(0, getDanmakuEventVideoTime(event) + offset);
      lines.push(JSON.stringify({ ...event, videoTime, time: videoTime }));
    }
    offset += getSegmentDurationForMerge(segment, segments[index + 1]);
  }
  await fsp.writeFile(outputPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function getSegmentDurationForMerge(segment, nextSegment) {
  const duration = Number(
    segment?.timelineHealth?.videoDurationSec ||
      segment?.timingInfo?.videoDurationSec ||
      segment?.durationSec ||
      0
  );
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  // Wall-clock gaps include reconnect/network wait and must never become media
  // timeline gaps. Keep unknown duration at zero until a media probe fills it.
  return 0;
}

async function copyFirstExistingFile(candidates, outputPath, fallbackText) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        await fsp.copyFile(candidate, outputPath);
        return outputPath;
      }
    } catch {
      // Keep looking.
    }
  }
  await fsp.writeFile(outputPath, fallbackText, 'utf8');
  return outputPath;
}

module.exports = {
  createRecordingArgs,
  createMp4FinalizeArgs,
  createBurnArgs,
  createBurnAudioMuxArgs,
  createAvatarOverlayFilterScript,
  createAvatarOverlayChunkFilterScript,
  clipAvatarOverlayEntries,
  createPreviewHlsArgs,
  createClipCopyArgs,
  createConcatCopyArgs,
  createNormalizeSegmentArgs,
  createConcatTranscodeArgs,
  createAudioAlignArgs,
  selectHighestResolutionVideoInfo,
  shouldTranscodeConcat,
  assertSafeMergeTargetProfile,
  createConcatStreamSignature,
  writeConcatFile,
  escapeConcatPath,
  mergeDanmakuFiles,
  getSegmentDurationForMerge,
  copyFirstExistingFile
};
