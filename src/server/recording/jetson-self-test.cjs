const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createAssFilter,
  createAvatarOverlayFilterScript,
  createBurnEncodedVideoMuxArgs,
  createBurnRawVideoArgs,
  createJetsonGstreamerEncodeArgs,
  runFfmpegToGstreamerJob
} = require('./ffmpeg.cjs');

const SOURCE_DURATION_SEC = 2.5;
const SELF_TEST_LEAD_INS = [0, 1.019];
const STAGE_LABELS = {
  nativeDecode: '原生解码',
  assLibass: 'ASS + libass',
  font: '真实字体',
  leadingFilter: '前导滤镜',
  avatarImage: '头像图片处理',
  rawBridge: 'FFmpeg → I420 raw bridge',
  nvvidconv: 'nvvidconv',
  nvv4l2Encoder: 'nvv4l2 编码',
  parser: 'H26x parser',
  finalMux: '最终 MP4 mux + ffprobe'
};

function isHevcCodec(codec) {
  return /(?:hevc|h265|x265)/i.test(String(codec || ''));
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 900);
}

function createStage(label) {
  return { status: 'pending', label, message: '等待自检' };
}

function createJetsonStageResults() {
  return Object.fromEntries(Object.entries(STAGE_LABELS).map(([key, label]) => [key, createStage(label)]));
}

function setStage(stage, status, message, details) {
  if (!stage) return;
  stage.status = status;
  stage.message = compact(message);
  if (details !== undefined) stage.details = details;
}

function createJetsonSelfTestPlan(codec) {
  const value = String(codec || '').trim().toLowerCase();
  const hevc = isHevcCodec(value);
  return {
    codec: value,
    sourceCodec: hevc ? 'hevc' : 'h264',
    sourceEncoder: hevc ? 'libx265' : 'libx264',
    nativeDecoder: hevc ? 'hevc_nvv4l2dec' : 'h264_nvv4l2dec',
    encoderElement: hevc ? 'nvv4l2h265enc' : 'nvv4l2h264enc',
    parserElement: hevc ? 'h265parse' : 'h264parse',
    encodedExtension: hevc ? 'h265' : 'h264'
  };
}

function createProbeAss(fontFamily) {
  const family = String(fontFamily || 'sans-serif').replace(/[,\r\n]/g, ' ').trim() || 'sans-serif';
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 320',
    'PlayResY: 180',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Probe,' + family + ',24,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,12,12,12,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    'Dialogue: 0,0:00:00.000,0:00:02.400,Probe,,0,0,0,,Jetson ASS + 真实字体'
  ].join('\n') + '\n';
}

function createAvatarCircleFilter(size) {
  const edge = Math.max(8, Math.min(512, Math.round(Number(size) || 48)));
  return 'scale=' + edge + ':' + edge + ':force_original_aspect_ratio=increase,crop=' + edge + ':' + edge +
    ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)'";
}

function isCommandSuccess(result) {
  return Boolean(result && result.status === 0 && !result.error && !result.timedOut);
}

function commandReason(result, fallback) {
  if (!result) return fallback;
  if (result.timedOut) return fallback + '超时';
  return compact(result.stderr || result.stdout || result.error?.message || fallback + '失败，退出码 ' + String(result.status));
}

async function runCommand(runProcess, command, args, options = {}) {
  const result = await runProcess(command, args, {
    timeoutMs: Number(options.timeoutMs || 20_000),
    maxOutputBytes: Number(options.maxOutputBytes || 128 * 1024)
  });
  if (!isCommandSuccess(result)) {
    const error = new Error(commandReason(result, options.label || command));
    error.result = result;
    throw error;
  }
  return result;
}

async function findActualFont(runProcess) {
  const preferred = await runProcess('fc-match', ['-f', '%{family}\n%{file}\n', 'Noto Sans CJK SC'], {
    timeoutMs: 5000,
    maxOutputBytes: 16 * 1024
  }).catch(() => null);
  const fallback = isCommandSuccess(preferred)
    ? preferred
    : await runProcess('fc-match', ['-f', '%{family}\n%{file}\n', 'sans-serif'], {
        timeoutMs: 5000,
        maxOutputBytes: 16 * 1024
      }).catch(() => null);
  if (!isCommandSuccess(fallback)) {
    throw new Error(commandReason(fallback, '未能找到 Fontconfig 字体'));
  }
  const lines = String(fallback.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const family = lines[0] || '';
  const filePath = lines[1] || '';
  const exists = filePath ? await fsp.stat(filePath).then((stat) => stat.isFile()).catch(() => false) : false;
  if (!family || !exists) throw new Error('Fontconfig 没有返回可读取的真实字体文件。');
  return { family, filePath };
}

function resolveFfprobePath(ffmpegPath, configuredPath) {
  if (String(configuredPath || '').trim()) return String(configuredPath).trim();
  const source = String(ffmpegPath || '').trim();
  const fileName = path.basename(source);
  if (/^ffmpeg(?:\.exe)?$/i.test(fileName)) {
    const sibling = path.join(path.dirname(source), fileName.replace(/ffmpeg/i, 'ffprobe'));
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'ffprobe';
}

function avatarExtension(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('png')) return '.png';
  if (value.includes('webp')) return '.webp';
  if (value.includes('gif')) return '.gif';
  return '.jpg';
}

async function fileSize(filePath) {
  return fsp.stat(filePath).then((stat) => (stat.isFile() ? stat.size : 0)).catch(() => 0);
}

function summarizeJetsonStages(stages) {
  return Object.entries(stages || {})
    .filter(([, stage]) => stage?.status === 'failed')
    .map(([, stage]) => (stage.label || '未知阶段') + '：' + (stage.message || '失败'))
    .join('；');
}

async function runJetsonEndToEndSelfTest(options = {}) {
  const plan = createJetsonSelfTestPlan(options.codec || options.codecInfo?.value);
  const stages = createJetsonStageResults();
  const platform = String(options.platform || process.platform);
  const runProcess = options.runProcess;
  const ffmpegPath = String(options.ffmpegPath || '').trim();
  const result = { ok: false, codec: plan.codec, converter: '', stages, reason: '' };
  const finish = () => {
    result.reason = summarizeJetsonStages(stages);
    const required = ['nativeDecode', 'assLibass', 'font', 'leadingFilter', 'rawBridge', 'nvvidconv', 'nvv4l2Encoder', 'parser', 'finalMux'];
    result.ok = required.every((key) => stages[key]?.status === 'passed');
    if (!result.reason && !result.ok) result.reason = 'Jetson 端到端烧录自检未完整通过。';
    return result;
  };
  if (platform !== 'linux' || !/^(?:h264|hevc)_nvv4l2$/.test(plan.codec)) {
    for (const stage of Object.values(stages)) setStage(stage, 'skipped', '仅在 Linux Jetson nvv4l2 后端执行');
    return finish();
  }
  if (typeof runProcess !== 'function' || !ffmpegPath) {
    for (const stage of Object.values(stages)) setStage(stage, 'failed', '端到端自检缺少 FFmpeg 或命令执行器');
    return finish();
  }
  // Avoid creating media samples or making the avatar network request on a
  // generic Linux host. The actual Jetson encoder element is the cheapest
  // authoritative gate before the expensive end-to-end probe begins.
  const encoderPresence = await runProcess('gst-inspect-1.0', [plan.encoderElement], {
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024
  }).catch(() => null);
  if (!isCommandSuccess(encoderPresence)) {
    setStage(stages.nvv4l2Encoder, 'failed', commandReason(encoderPresence, '未找到 ' + plan.encoderElement));
    for (const [key, stage] of Object.entries(stages)) {
      if (key !== 'nvv4l2Encoder') setStage(stage, 'skipped', '未检测到 Jetson nvv4l2 编码器');
    }
    return finish();
  }

  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-jetson-e2e-'));
  const sourcePath = path.join(temporaryDir, 'source-' + plan.sourceCodec + '.mp4');
  const assPath = path.join(temporaryDir, 'probe.ass');
  try {
    let font = null;
    try {
      font = await findActualFont(runProcess);
      setStage(stages.font, 'passed', font.family + ' · ' + font.filePath);
      await fsp.writeFile(assPath, createProbeAss(font.family), 'utf8');
    } catch (error) {
      setStage(stages.font, 'failed', error.message);
    }

    try {
      await runCommand(runProcess, ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', String(SOURCE_DURATION_SEC),
        '-shortest', '-c:v', plan.sourceEncoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
      ], { label: plan.sourceCodec.toUpperCase() + ' 测试源生成' });
      await runCommand(runProcess, ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-c:v', plan.nativeDecoder, '-i', sourcePath,
        '-frames:v', '1', '-f', 'null', '-'
      ], { label: plan.nativeDecoder + ' 原生解码' });
      setStage(stages.nativeDecode, 'passed', plan.sourceCodec.toUpperCase() + ' 2.5 秒测试源已由 ' + plan.nativeDecoder + ' 解码');
    } catch (error) {
      setStage(stages.nativeDecode, 'failed', error.message);
    }

    if (stages.nativeDecode.status === 'passed' && stages.font.status === 'passed') {
      try {
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vf', createAssFilter(assPath),
          '-frames:v', '1', '-f', 'null', '-'
        ], { label: 'ASS + libass + 真实字体' });
        setStage(stages.assLibass, 'passed', '真实 ASS 与 ' + font.family + ' 已渲染');
      } catch (error) {
        setStage(stages.assLibass, 'failed', error.message);
      }
    } else {
      setStage(stages.assLibass, 'skipped', '原生解码或字体阶段未通过');
    }

    const inspect = async (element, stage) => {
      try {
        await runCommand(runProcess, 'gst-inspect-1.0', [element], { timeoutMs: 5000, label: 'GStreamer ' + element });
        stage.message = element + ' 已找到，等待完整管线验证';
        return true;
      } catch (error) {
        setStage(stage, 'failed', error.message);
        return false;
      }
    };
    const rawParserReady = await inspect('rawvideoparse', stages.rawBridge);
    let converter = '';
    for (const candidate of [options.converter, 'nvvidconv', 'nvvideoconvert']) {
      const value = String(candidate || '').trim();
      if (!value || converter) continue;
      try {
        await runCommand(runProcess, 'gst-inspect-1.0', [value], { timeoutMs: 5000, label: 'GStreamer ' + value });
        converter = value;
        stages.nvvidconv.message = value + ' 已找到，等待完整管线验证';
      } catch (error) {
        stages.nvvidconv.message = compact(error.message);
      }
    }
    if (!converter) setStage(stages.nvvidconv, 'failed', stages.nvvidconv.message || '未找到 nvvidconv 或 nvvideoconvert');
    const encoderReady = await inspect(plan.encoderElement, stages.nvv4l2Encoder);
    const parserReady = await inspect(plan.parserElement, stages.parser);

    const avatarChecks = {};
    const testAvatar = async (name, imagePath) => {
      const croppedPath = path.join(temporaryDir, name + '-circle.png');
      const scriptPath = path.join(temporaryDir, name + '-overlay.ffscript');
      try {
        await runCommand(runProcess, ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-frames:v', '1', '-f', 'null', '-'], {
          label: name + ' 头像解码'
        });
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-frames:v', '1', '-vf', createAvatarCircleFilter(48),
          '-pix_fmt', 'rgba', croppedPath
        ], { label: name + ' 头像圆形裁切' });
        const script = createAvatarOverlayFilterScript({
          assPath,
          fps: 30,
          duration: SOURCE_DURATION_SEC,
          avatarOverlay: {
            panel: { left: 224, width: 96, height: 180 },
            videoWidth: 320,
            videoHeight: 180,
            entries: [{ imagePath: croppedPath, segments: [{ start: 0, end: 2.2, x1: 8, x2: 28, y1: 64, y2: 64 }] }]
          }
        });
        if (!script) throw new Error(name + ' 头像 overlay 滤镜为空');
        await fsp.writeFile(scriptPath, script, 'utf8');
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-filter_complex_script', scriptPath, '-map', '[vout]',
          '-frames:v', '1', '-f', 'null', '-'
        ], { label: name + ' 头像 overlay' });
        return { status: 'passed', message: '下载/解码/裁圆/overlay 通过' };
      } catch (error) {
        return { status: 'failed', message: compact(error.message) };
      }
    };
    if (stages.nativeDecode.status === 'passed' && stages.assLibass.status === 'passed') {
      const builtInPath = String(options.builtInAvatarPath || '').trim();
      if (builtInPath && (await fileSize(builtInPath)) > 0) {
        avatarChecks.builtinPng = await testAvatar('builtin', builtInPath);
      } else {
        avatarChecks.builtinPng = { status: 'failed', message: '未找到内置 PNG 头像资源' };
      }
      try {
        const asset = await options.downloadAvatar?.(String(options.remoteAvatarUrl || ''));
        const body = Buffer.isBuffer(asset?.body) ? asset.body : null;
        if (!body?.length) throw new Error('远程头像没有返回图片数据');
        const remotePath = path.join(temporaryDir, 'remote-avatar' + avatarExtension(asset.contentType));
        await fsp.writeFile(remotePath, body);
        avatarChecks.remoteAvatar = await testAvatar('remote', remotePath);
      } catch (error) {
        avatarChecks.remoteAvatar = { status: 'failed', message: compact(error.message || '远程头像下载失败') };
      }
      const avatarPassed = Object.values(avatarChecks).every((item) => item.status === 'passed');
      setStage(stages.avatarImage, avatarPassed ? 'passed' : 'failed', avatarPassed ? '内置 PNG 与远程 Bilibili 头像均已处理' : '头像失败将回退通用头像，不阻断视频导出', avatarChecks);
    } else {
      setStage(stages.avatarImage, 'skipped', 'ASS 或测试视频未通过，无法执行头像 overlay', avatarChecks);
    }

    const pipelineReady = rawParserReady && Boolean(converter) && encoderReady && parserReady &&
      stages.nativeDecode.status === 'passed' && stages.assLibass.status === 'passed';
    const leadResults = {};
    if (pipelineReady) {
      for (const leadIn of SELF_TEST_LEAD_INS) {
        const key = leadIn > 0 ? 'lead_1_019' : 'lead_0';
        const outputDuration = SOURCE_DURATION_SEC + leadIn;
        const encodedPath = path.join(temporaryDir, key + '.' + plan.encodedExtension);
        const muxPath = path.join(temporaryDir, key + '.mp4');
        try {
          const gstreamerArgs = createJetsonGstreamerEncodeArgs({
            codec: plan.codec, width: 320, height: 180, fps: 30, quality: 28, outputPath: encodedPath, converter
          });
          await runFfmpegToGstreamerJob({
            ffmpegPath,
            ffmpegArgs: createBurnRawVideoArgs({
              cleanPath: sourcePath, assPath, fps: 30, duration: outputDuration, decoder: plan.nativeDecoder,
              sourceCodec: plan.sourceCodec, timelineOffset: leadIn, leadingVideoPaddingSec: leadIn, videoWidth: 320, videoHeight: 180
            }),
            gstreamerArgs,
            gstreamerOutputPath: encodedPath,
            timeoutMs: 45_000,
            noProgressTimeoutMs: 15_000
          });
          if ((await fileSize(encodedPath)) < 256) throw new Error('GStreamer 没有写出有效临时 H26x 文件');
          await runCommand(runProcess, ffmpegPath, createBurnEncodedVideoMuxArgs({
            encodedVideoPath: encodedPath, cleanPath: sourcePath, outputPath: muxPath, codec: plan.codec, fps: 30,
            duration: outputDuration, container: 'mp4', leadingAudioPaddingSec: leadIn, includeAudio: true
          }), { timeoutMs: 30_000, label: key + ' 最终 MP4 mux' });
          const probe = await runCommand(runProcess, resolveFfprobePath(ffmpegPath, options.ffprobePath), [
            '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', muxPath
          ], { timeoutMs: 15_000, label: key + ' ffprobe' });
          const metadata = JSON.parse(String(probe.stdout || '{}'));
          const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
          const video = streams.find((stream) => stream.codec_type === 'video');
          const audio = streams.find((stream) => stream.codec_type === 'audio');
          const actualDuration = Number(metadata.format?.duration);
          const durationDrift = Math.abs(actualDuration - outputDuration);
          if (
            !video ||
            !audio ||
            !(actualDuration > 0) ||
            String(video.codec_name || '').toLowerCase() !== plan.sourceCodec ||
            durationDrift > 0.35
          ) {
            throw new Error(
              `ffprobe 未确认最终 MP4 的 ${plan.sourceCodec.toUpperCase()} 视频、音频与前导时长（实际 ${
                Number.isFinite(actualDuration) ? actualDuration.toFixed(3) : '未知'
              } 秒，期望约 ${outputDuration.toFixed(3)} 秒）。`
            );
          }
          leadResults[key] = { status: 'passed', message: leadIn + ' 秒前导：FFmpeg → I420 → GStreamer → mux → ffprobe 通过' };
        } catch (error) {
          leadResults[key] = { status: 'failed', message: compact(error.message), primaryProcess: error.primaryProcess || '' };
        }
      }
    }
    const leadPassed = Object.values(leadResults).length === SELF_TEST_LEAD_INS.length &&
      Object.values(leadResults).every((item) => item.status === 'passed');
    if (leadPassed) {
      setStage(stages.leadingFilter, 'passed', '0 秒与 1.019 秒前导均完成真实管线', leadResults);
      setStage(stages.rawBridge, 'passed', 'FFmpeg 实际持续输出 I420，并被 GStreamer 消费');
      setStage(stages.nvvidconv, 'passed', converter + ' 已在两条真实管线中完成 NVMM 转换');
      setStage(stages.nvv4l2Encoder, 'passed', plan.encoderElement + ' 已在两条真实管线中编码');
      setStage(stages.parser, 'passed', plan.parserElement + ' 已输出可被 FFmpeg mux 的 H26x');
      setStage(stages.finalMux, 'passed', '两条最终 MP4 均已由 ffprobe 验证音视频流');
      result.converter = converter;
    } else if (pipelineReady) {
      setStage(stages.leadingFilter, 'failed', '0 秒或 1.019 秒前导管线失败', leadResults);
      const failure = Object.values(leadResults).find((item) => item.status === 'failed');
      setStage(stages.rawBridge, 'failed', failure?.message || 'FFmpeg → I420 → GStreamer bridge 失败');
      for (const stage of [stages.nvvidconv, stages.nvv4l2Encoder, stages.parser, stages.finalMux]) {
        if (stage.status === 'pending') setStage(stage, 'skipped', '端到端 bridge 未完成：' + (failure?.message || '未知原因'));
      }
    } else {
      for (const stage of [stages.leadingFilter, stages.rawBridge, stages.finalMux]) {
        if (stage.status === 'pending') setStage(stage, 'skipped', '前置阶段未通过，未启动端到端管线');
      }
      for (const stage of [stages.nvvidconv, stages.nvv4l2Encoder, stages.parser]) {
        if (stage.status === 'pending') setStage(stage, 'skipped', 'GStreamer 元素预检未通过');
      }
    }
    return finish();
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  SOURCE_DURATION_SEC,
  SELF_TEST_LEAD_INS,
  STAGE_LABELS,
  createJetsonStageResults,
  createJetsonSelfTestPlan,
  summarizeJetsonStages,
  runJetsonEndToEndSelfTest
};
