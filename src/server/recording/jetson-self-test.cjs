const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createAssFilter,
  createBurnEncodedVideoMuxArgs,
  createBurnRawVideoArgs,
  createJetsonGstreamerEncodeArgs,
  runFfmpegToGstreamerJob
} = require('./ffmpeg.cjs');
const { buildSceneGraph } = require('../danmaku/scene-graph.cjs');
const { writeSceneFilterScript } = require('../danmaku/scene-renderer.cjs');

const SOURCE_DURATION_SEC = 2.5;
const SELF_TEST_LEAD_INS = [0, 1.019];
const STAGE_LABELS = {
  nativeDecode: '原生解码',
  cpuDecode: 'CPU 解码回退',
  assLibass: 'ASS + libass',
  font: '真实字体',
  sceneFilters: 'Scene Graph 滤镜',
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
    sampleFile: hevc ? 'hevc-sample.mp4' : 'h264-sample.mp4',
    nativeDecoder: hevc ? 'hevc_nvv4l2dec' : 'h264_nvv4l2dec',
    encoderElement: hevc ? 'nvv4l2h265enc' : 'nvv4l2h264enc',
    parserElement: hevc ? 'h265parse' : 'h264parse',
    encodedExtension: hevc ? 'h265' : 'h264'
  };
}

const REQUIRED_SCENE_FILTERS = ['drawtext', 'overlay', 'scale', 'geq', 'color', 'movie', 'boxblur', 'trim', 'concat', 'setpts', 'settb', 'format'];

function createSelfTestSceneGraph(videoInfo, avatarPath) {
  return buildSceneGraph(
    [
      { type: 'danmaku', time: 0.15, uid: 901, user: 'Scene文字', text: 'Jetson Scene Graph 文字', color: 0xffffff, avatarUrl: 'builtin:avatar' },
      { type: 'superchat', time: 0.45, uid: 901, user: 'Scene卡片', text: 'Scene Graph 卡片与动画', price: 30, avatarUrl: 'builtin:avatar' },
      { type: 'gift', time: 1.1, uid: 901, user: 'Scene头像', giftName: '测试礼物', count: 1, price: 1, avatarUrl: 'builtin:avatar' }
    ],
    {
      stylePreset: 'h5-card',
      overlayMode: 'danmaku-gift',
      danmakuArea: 'half',
      videoInfo,
      durationSec: SOURCE_DURATION_SEC,
      avatarAssets: { 901: { path: avatarPath } }
    }
  );
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
  if (/^ffmpeg(?:-full)?(?:\.exe)?$/i.test(fileName)) {
    const sibling = path.join(path.dirname(source), fileName.replace(/^ffmpeg/i, 'ffprobe'));
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

function escapeFilterPath(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function createSceneFilterProbeCommands(sourcePath, avatarPath, fontPath) {
  const base = ['-hide_banner', '-loglevel', 'error', '-i', sourcePath];
  const frame = ['-frames:v', '1', '-f', 'null', '-'];
  const filter = (name, expression) => ({ name, args: [...base, '-vf', expression, ...frame] });
  const complex = (name, expression) => ({ name, args: [...base, '-filter_complex', expression, '-map', '[probe_out]', ...frame] });
  const avatar = escapeFilterPath(avatarPath);
  return [
    filter('drawtext', `drawtext=fontfile='${escapeFilterPath(fontPath)}':text='Scene':fontsize=12:x=2:y=2`),
    complex('overlay', '[0:v][0:v]overlay=x=0:y=0[probe_out]'),
    filter('scale', 'scale=160:90'),
    filter('geq', "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'") ,
    complex('color', 'color=c=black:s=16x16:r=30:d=0.1[probe_color];[0:v][probe_color]overlay=x=0:y=0[probe_out]'),
    complex('movie', `movie='${avatar}',trim=duration=0.1,setpts=PTS-STARTPTS[probe_avatar];[0:v][probe_avatar]overlay=x=0:y=0[probe_out]`),
    filter('boxblur', 'boxblur=lr=1:lp=1'),
    complex('trim', '[0:v]trim=duration=0.1,setpts=PTS-STARTPTS[probe_out]'),
    complex('concat', '[0:v]trim=duration=0.1,setpts=PTS-STARTPTS[probe_a];[0:v]trim=start=0.1:duration=0.1,setpts=PTS-STARTPTS[probe_b];[probe_a][probe_b]concat=n=2:v=1:a=0[probe_out]'),
    filter('setpts', 'setpts=PTS-STARTPTS'),
    filter('settb', 'settb=AVTB'),
    filter('format', 'format=yuv420p')
  ];
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
    // Jetson 的最小烧录链是 CPU 解码 → Scene Graph → I420 → nvvidconv
    // → nvv4l2 → mux。硬解和 ASS 都是可观测的附加能力，不得阻断它。
    const required = ['cpuDecode', 'font', 'sceneFilters', 'leadingFilter', 'rawBridge', 'nvvidconv', 'nvv4l2Encoder', 'parser', 'finalMux'];
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
  const sourcePath = String(options.samplePath || '').trim();
  if ((await fileSize(sourcePath)) < 1024) {
    setStage(stages.nativeDecode, 'failed', `未找到内置 ${plan.sourceCodec.toUpperCase()} 测试样本：${sourcePath || plan.sampleFile}`);
    for (const [key, stage] of Object.entries(stages)) {
      if (key !== 'nativeDecode') setStage(stage, 'failed', '缺少安装包内置测试样本，无法运行独立验证');
    }
    return finish();
  }
  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-jetson-e2e-'));
  const assPath = path.join(temporaryDir, 'probe.ass');
  const sceneFilterPath = path.join(temporaryDir, 'scene.filter');
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
        '-hide_banner', '-loglevel', 'error', '-c:v', plan.sourceCodec, '-i', sourcePath,
        '-frames:v', '1', '-f', 'null', '-'
      ], { label: plan.sourceCodec + ' CPU 解码' });
      setStage(stages.cpuDecode, 'passed', plan.sourceCodec.toUpperCase() + ' 内置样本已由 FFmpeg CPU 解码');
    } catch (error) {
      setStage(stages.cpuDecode, 'failed', error.message);
    }

    if (stages.font.status === 'passed') {
      try {
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-c:v', plan.sourceCodec, '-i', sourcePath, '-vf', createAssFilter(assPath),
          '-frames:v', '1', '-f', 'null', '-'
        ], { label: 'ASS + libass + 真实字体' });
        setStage(stages.assLibass, 'passed', '真实 ASS 与 ' + font.family + ' 已由 CPU 解码路径渲染');
      } catch (error) {
        setStage(stages.assLibass, 'failed', error.message);
      }
    } else {
      setStage(stages.assLibass, 'failed', '未找到真实字体，无法执行 ASS + libass 验证');
    }

    const builtInSceneAvatarPath = String(options.builtInAvatarPath || '').trim();
    const filterResults = {};
    if (stages.cpuDecode.status === 'passed' && font?.filePath && (await fileSize(builtInSceneAvatarPath)) > 0) {
      for (const probe of createSceneFilterProbeCommands(sourcePath, builtInSceneAvatarPath, font.filePath)) {
        try {
          await runCommand(runProcess, ffmpegPath, ['-c:v', plan.sourceCodec, ...probe.args], {
            timeoutMs: 12_000,
            label: 'Scene Graph 滤镜 ' + probe.name
          });
          filterResults[probe.name] = { status: 'passed' };
        } catch (error) {
          filterResults[probe.name] = { status: 'failed', message: compact(error.message) };
        }
      }
      const missing = REQUIRED_SCENE_FILTERS.filter((name) => filterResults[name]?.status !== 'passed');
      setStage(
        stages.sceneFilters,
        missing.length ? 'failed' : 'passed',
        missing.length ? 'Scene Graph 实命令失败：' + missing.join('、') : 'Scene Graph 所需滤镜均由真实命令渲染通过',
        { required: REQUIRED_SCENE_FILTERS, probes: filterResults, missing }
      );
    } else {
      setStage(stages.sceneFilters, 'failed', 'CPU 解码、字体或内置头像资源未通过，无法执行 Scene Graph 滤镜实命令验证', { required: REQUIRED_SCENE_FILTERS, probes: filterResults });
    }

    let sceneLayer = null;
    if (stages.cpuDecode.status === 'passed' && (await fileSize(builtInSceneAvatarPath)) > 0) {
      try {
        const graph = createSelfTestSceneGraph({ width: 320, height: 180, fps: 30 }, builtInSceneAvatarPath);
        sceneLayer = await writeSceneFilterScript(sceneFilterPath, graph, {
          duration: SOURCE_DURATION_SEC,
          fps: 30,
          target: 'jetson'
        });
      } catch (error) {
        setStage(stages.sceneFilters, 'failed', 'Scene Graph → scene.filter 失败：' + error.message);
      }
    } else if (stages.sceneFilters.status === 'passed') {
      setStage(stages.sceneFilters, 'failed', 'Scene Graph 缺少可用的内置头像资源，无法生成包含头像的 scene.filter。');
    }

    const rawProbePath = path.join(temporaryDir, 'cpu-i420.yuv');
    const encodedProbePath = path.join(temporaryDir, 'gstreamer-probe.' + plan.encodedExtension);
    const rawCaps = ['rawvideoparse', 'format=i420', 'width=320', 'height=180', 'framerate=30/1'];
    let rawReady = false;
    if (stages.cpuDecode.status === 'passed') {
      try {
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-c:v', plan.sourceCodec, '-i', sourcePath,
          '-frames:v', '1', '-vf', 'scale=320:180,format=yuv420p', '-f', 'rawvideo', rawProbePath
        ], { label: 'CPU I420 测试帧' });
        await runCommand(runProcess, 'gst-launch-1.0', ['-q', 'filesrc', 'location=' + rawProbePath, '!', ...rawCaps, '!', 'fakesink', 'sync=false'], {
          timeoutMs: 10_000,
          label: 'GStreamer rawvideoparse'
        });
        rawReady = true;
        setStage(stages.rawBridge, 'passed', 'CPU 解码 I420 已由 rawvideoparse 实际消费');
      } catch (error) {
        setStage(stages.rawBridge, 'failed', error.message);
      }
    } else {
      setStage(stages.rawBridge, 'failed', 'CPU 解码未通过，无法生成 I420 输入');
    }

    let converter = '';
    for (const candidate of [options.converter, 'nvvidconv', 'nvvideoconvert']) {
      const value = String(candidate || '').trim();
      if (!value || converter) continue;
      try {
        await runCommand(runProcess, 'gst-launch-1.0', ['-q', 'filesrc', 'location=' + rawProbePath, '!', ...rawCaps, '!', value, '!', 'fakesink', 'sync=false'], {
          timeoutMs: 12_000,
          label: 'GStreamer ' + value
        });
        converter = value;
        setStage(stages.nvvidconv, 'passed', value + ' 已独立完成 I420 → NVMM 转换');
      } catch (error) {
        stages.nvvidconv.message = compact(error.message);
      }
    }
    if (!converter) setStage(stages.nvvidconv, 'failed', stages.nvvidconv.message || 'nvvidconv / nvvideoconvert 独立测试失败');

    let encoderReady = false;
    try {
      await runCommand(runProcess, 'gst-launch-1.0', [
        '-q', 'filesrc', 'location=' + rawProbePath, '!', ...rawCaps, '!', converter || 'nvvidconv', '!', plan.encoderElement,
        'bitrate=1000000', '!', plan.parserElement, '!', 'filesink', 'location=' + encodedProbePath
      ], { timeoutMs: 15_000, label: 'GStreamer ' + plan.encoderElement });
      encoderReady = (await fileSize(encodedProbePath)) >= 256;
      if (!encoderReady) throw new Error(plan.encoderElement + ' 未写出有效 H26x 测试文件');
      setStage(stages.nvv4l2Encoder, 'passed', plan.encoderElement + ' 已独立编码 CPU I420 测试帧');
    } catch (error) {
      setStage(stages.nvv4l2Encoder, 'failed', error.message);
    }

    try {
      if (!encoderReady) throw new Error('没有可供 ' + plan.parserElement + ' 解析的 H26x 测试文件');
      await runCommand(runProcess, 'gst-launch-1.0', ['-q', 'filesrc', 'location=' + encodedProbePath, '!', plan.parserElement, '!', 'fakesink', 'sync=false'], {
        timeoutMs: 10_000,
        label: 'GStreamer ' + plan.parserElement
      });
      setStage(stages.parser, 'passed', plan.parserElement + ' 已独立解析 nvv4l2 输出');
    } catch (error) {
      setStage(stages.parser, 'failed', error.message);
    }

    const avatarChecks = {};
    const testAvatar = async (name, imagePath) => {
      const croppedPath = path.join(temporaryDir, name + '-circle.png');
      try {
        await runCommand(runProcess, ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-frames:v', '1', '-f', 'null', '-'], {
          label: name + ' 头像解码'
        });
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-frames:v', '1', '-vf', createAvatarCircleFilter(48),
          '-pix_fmt', 'rgba', croppedPath
        ], { label: name + ' 头像圆形裁切' });
        await runCommand(runProcess, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-c:v', plan.sourceCodec, '-i', sourcePath,
          '-loop', '1', '-i', croppedPath,
          '-filter_complex', '[0:v]scale=320:180,format=yuv420p[base];[1:v]scale=40:40,format=rgba[avatar];[base][avatar]overlay=272:64:shortest=1[vout]',
          '-map', '[vout]',
          '-frames:v', '1', '-f', 'null', '-'
        ], { label: name + ' 头像 overlay' });
        return { status: 'passed', message: '下载/解码/裁圆/overlay 通过' };
      } catch (error) {
        return { status: 'failed', message: compact(error.message) };
      }
    };
    if (stages.cpuDecode.status === 'passed' && stages.sceneFilters.status === 'passed') {
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
      setStage(stages.avatarImage, 'failed', 'CPU 解码或 Scene Graph 滤镜未通过，无法执行头像 overlay', avatarChecks);
    }

    const pipelineReady = rawReady && Boolean(converter) && encoderReady && stages.parser.status === 'passed' && Boolean(sceneLayer?.filterScriptPath) &&
      stages.cpuDecode.status === 'passed' && stages.sceneFilters.status === 'passed';
    const leadResults = {};
    if (pipelineReady) {
      for (const leadIn of SELF_TEST_LEAD_INS) {
        const key = leadIn > 0 ? 'lead_1_019' : 'lead_0';
        // The source audio clock remains at zero. A 1.019-second video lead
        // replaces the tail with black/video alignment; it must not lengthen
        // the recording or add a second artificial audio lead.
        const outputDuration = SOURCE_DURATION_SEC;
        const encodedPath = path.join(temporaryDir, key + '.' + plan.encodedExtension);
        const muxPath = path.join(temporaryDir, key + '.mp4');
        try {
          sceneLayer = await writeSceneFilterScript(sceneFilterPath, createSelfTestSceneGraph({ width: 320, height: 180, fps: 30 }, builtInSceneAvatarPath), {
            duration: outputDuration,
            outputDuration,
            leadingVideoPaddingSec: leadIn,
            fps: 30,
            target: 'jetson'
          });
          const gstreamerArgs = createJetsonGstreamerEncodeArgs({
            codec: plan.codec, width: 320, height: 180, fps: 30, quality: 28, outputPath: encodedPath, converter
          });
          await runFfmpegToGstreamerJob({
            ffmpegPath,
            ffmpegArgs: createBurnRawVideoArgs({
              cleanPath: sourcePath, assPath: '', avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath }, fps: 30, duration: outputDuration, decoder: 'software',
              sourceCodec: plan.sourceCodec, timelineOffset: 0, leadingVideoPaddingSec: 0, videoWidth: 320, videoHeight: 180
            }),
            gstreamerArgs,
            gstreamerOutputPath: encodedPath,
            timeoutMs: 45_000,
            noProgressTimeoutMs: 15_000
          });
          if ((await fileSize(encodedPath)) < 256) throw new Error('GStreamer 没有写出有效临时 H26x 文件');
          await runCommand(runProcess, ffmpegPath, createBurnEncodedVideoMuxArgs({
            encodedVideoPath: encodedPath, cleanPath: sourcePath, outputPath: muxPath, codec: plan.codec, sourceCodec: plan.sourceCodec, fps: 30,
            duration: outputDuration, container: 'mp4', leadingAudioPaddingSec: 0, includeAudio: true
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
        if (stage.status === 'pending') setStage(stage, 'failed', '端到端 bridge 未完成：' + (failure?.message || '未知原因'));
      }
    } else {
      for (const stage of [stages.leadingFilter, stages.rawBridge, stages.finalMux]) {
        if (stage.status === 'pending') setStage(stage, 'failed', '独立阶段未通过，无法启动完整 CPU 解码 → Scene Graph → I420 → nvv4l2 管线');
      }
      for (const stage of [stages.nvvidconv, stages.nvv4l2Encoder, stages.parser]) {
        if (stage.status === 'pending') {
          setStage(
            stage,
            'failed',
            `${stage.message || 'GStreamer 元素独立命令未运行'}；未完成独立验证`
          );
        }
      }
    }
    // The CPU path above is the Jetson admission gate. Only after it has
    // completed do we probe native decode as an optional acceleration.
    try {
      await runCommand(runProcess, ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-c:v', plan.nativeDecoder, '-i', sourcePath,
        '-frames:v', '1', '-f', 'null', '-'
      ], { label: plan.nativeDecoder + ' 原生解码' });
      setStage(stages.nativeDecode, 'passed', plan.sourceCodec.toUpperCase() + ' 内置样本已由 ' + plan.nativeDecoder + ' 解码；生产烧录可额外启用硬解加速');
    } catch (error) {
      setStage(stages.nativeDecode, 'failed', error.message + '；CPU 解码烧录链不受影响');
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
  REQUIRED_SCENE_FILTERS,
  createJetsonStageResults,
  createJetsonSelfTestPlan,
  createSelfTestSceneGraph,
  resolveFfprobePath,
  summarizeJetsonStages,
  runJetsonEndToEndSelfTest
};
