const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { readDanmakuEvents } = require('../danmaku/ass.cjs');

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
  return value.includes('hevc') || value.includes('h265');
}

function escapeFilterPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function createRecordingArgs({ streamUrl, headers, outputPath, maxDurationSec, streamProtocol, streamFormat }) {
  const args = [
    '-hide_banner',
    '-stats',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-rw_timeout',
    '30000000'
  ];
  args.push(
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_on_http_error',
    '4xx,5xx',
    '-reconnect_delay_max',
    '10'
  );
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

function createBurnArgs({ cleanPath, assPath, burnedPath, codec, crf, container, startTime, duration }) {
  const hasStart = Number.isFinite(Number(startTime)) && Number(startTime) > 0;
  const hasDuration = Number.isFinite(Number(duration)) && Number(duration) > 0;
  const args = ['-hide_banner', '-y', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err'];
  if (hasStart) {
    args.push('-ss', formatFfmpegSeconds(startTime));
  }
  args.push('-i', cleanPath);
  if (hasDuration) {
    args.push('-t', formatFfmpegSeconds(duration));
  }
  const videoFilter = `${hasStart || hasDuration ? 'setpts=PTS-STARTPTS,' : ''}ass='${escapeFilterPath(assPath)}'`;
  args.push('-vf', videoFilter, '-c:v', codec || 'libx265');

  if ((codec || '').includes('nvenc')) {
    args.push('-preset', 'p5', '-cq', String(crf), '-b:v', '0');
  } else if ((codec || '').includes('qsv')) {
    args.push('-global_quality', String(crf));
  } else if ((codec || '').includes('amf')) {
    args.push('-quality', 'balanced', '-qp_i', String(crf), '-qp_p', String(crf));
  } else {
    args.push('-preset', 'medium', '-crf', String(crf));
  }

  if (hasStart || hasDuration) {
    args.push('-avoid_negative_ts', 'make_zero');
  }

  if (container === 'mp4') {
    if (isHevcCodec(codec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }

  args.push('-c:a', 'copy', burnedPath);
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

function createRepairRemuxArgs({ inputPath, outputPath, container, streamCodec }) {
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
  if (container === 'mp4') {
    if (isHevcCodec(streamCodec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function createRepairTranscodeArgs({ inputPath, outputPath, container }) {
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
    '-vf',
    'setpts=PTS-STARTPTS,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-af',
    'aresample=async=1:first_pts=0',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ac',
    '2',
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

function createClipCopyArgs({ cleanPath, outputPath, startTime, duration, container }) {
  const args = [
    '-hide_banner',
    '-y',
    '-ss',
    formatFfmpegSeconds(startTime),
    '-i',
    cleanPath,
    '-t',
    formatFfmpegSeconds(duration),
    '-map',
    '0',
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero'
  ];
  if (container === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function createConcatCopyArgs({ concatPath, outputPath, container }) {
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-map', '0', '-c', 'copy'];
  if (container === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

async function writeConcatFile(concatPath, filePaths) {
  const body = filePaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n');
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
      lines.push(JSON.stringify({ ...event, time: Math.max(0, Number(event.time || 0) + offset) }));
    }
    offset += getSegmentDurationForMerge(segment, segments[index + 1]);
  }
  await fsp.writeFile(outputPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function getSegmentDurationForMerge(segment, nextSegment) {
  const duration = Number(segment.durationSec || 0);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  if (nextSegment?.startedAt && segment.startedAt) {
    return Math.max(0, (Number(nextSegment.startedAt) - Number(segment.startedAt)) / 1000);
  }
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
  createPreviewHlsArgs,
  createRepairRemuxArgs,
  createRepairTranscodeArgs,
  createClipCopyArgs,
  createConcatCopyArgs,
  writeConcatFile,
  escapeConcatPath,
  mergeDanmakuFiles,
  getSegmentDurationForMerge,
  copyFirstExistingFile
};
