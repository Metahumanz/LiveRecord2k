'use strict';
// Opt-in real Jetson export regression. Never calls service.init(), starts
// monitors, or writes recording sidecars. Use an isolated output directory
// containing the candidate helper in bin/br2k-scene-gpu and its visual report.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, list) => {
  if (item.startsWith('--')) pairs.push([item.slice(2), list[index + 1]]);
  return pairs;
}, []));
if (!args.input || !args.profile || !args['output-dir']) throw new Error('需要 --input、--profile（不含凭据的配置与能力快照）、--output-dir（独立测试目录）；可选 --duration 30/300、--native-chunk-seconds、--sample-from、--verify-existing、--ffmpeg、--app-root。');
const root = path.resolve(args['output-dir']);
process.env.BILI_RECORD_CONFIG_DIR = path.join(root, 'config');
process.env.BILI_RECORD_APP_ROOT = args['app-root'] || '/usr/lib/bili-record-2k';
process.env.BILI_RECORD_CUDA_SCENE_CONFORMANCE_REPORT = path.join(root, 'cuda-scene-conformance.json');
process.resourcesPath = root;
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { clipSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { selectSceneSample } = require('../src/server/danmaku/desktop-scene-policy.cjs');
const { verifySceneOutputFrame } = require('../src/server/danmaku/scene-output-verifier.cjs');
const { createGpuSceneRenderRequest } = require('../src/server/danmaku/gpu-scene-renderer.cjs');
const { runFfmpegJob, probeMediaFileInfo, probeMediaTimelineHealth } = require('../src/server/shared/helpers.cjs');

async function signature(file, hash = false) {
  const stat = await fs.stat(file);
  return { size:stat.size, mtimeMs:stat.mtimeMs, ...(hash ? {sha256:crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')} : {}) };
}
async function memory(pid) {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024;
    const children = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    return rss + (await Promise.all(children.map(memory))).reduce((a,b)=>a+b,0);
  } catch { return 0; }
}
async function main() {
  const duration = Number(args.duration || 30);
  const clipStart = Number(args['clip-start'] || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration 必须是正数');
  if (!Number.isFinite(clipStart) || clipStart < 0) throw new Error('clip-start 必须为非负数');
  const sampleMinimum = Number(args['sample-from'] || 0);
  const existing = args['verify-existing'] === 'true';
  const directory = path.join(root, `${duration}s`, ...(existing ? [`check-${sampleMinimum}`] : []));
  await fs.mkdir(directory, {recursive:true});
  await fs.mkdir(path.join(root,'config','BiliRecord2K'), {recursive:true});
  const cleanPath = path.resolve(args.input);
  const stem = cleanPath.replace(/(?:\.clean)?\.mp4$/, '');
  const files = [cleanPath, `${stem}.danmaku.jsonl`, `${stem}.scene.json`, `${stem}.scene.jsonl`, `${stem}.danmaku.avatars.json`];
  const before = await Promise.all(files.map((file,index)=>signature(file,index>0).catch(error => {
    if (index > 1 && error.code === 'ENOENT') return null;
    throw error;
  })));
  const profile = JSON.parse(await fs.readFile(path.resolve(args.profile),'utf8'));
  const settingKeys = ['outputDir','sceneGraphDefaultStyle','burnDanmakuStylePreset','burnOverlayMode',
    'burnDanmakuArea','burnCodec','burnCrf','burnDanmakuStyleLayout','burnAvatarMode'];
  profile.settings = Object.fromEntries(settingKeys.filter(key => Object.hasOwn(profile.settings || {}, key))
    .map(key => [key, profile.settings[key]]));
  const service = new LiveRecordService();
  service.settings = {...service.settings,...profile.settings, autoBurnDanmaku:false, autoUpdateEnabled:false};
  service.ffmpegPath = args.ffmpeg || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  service.ffmpegCapabilities = profile.ffmpegCapabilities;
  service.ffmpegCapabilities.sceneGpuRenderer = await service.probeGpuSceneRenderer();
  // The isolated config directory has no copy of the installed visual report.
  // Reuse the live report only when it was produced for the exact same helper.
  const installedRenderer = profile.ffmpegCapabilities.sceneGpuRenderer;
  const installedVisualReport = profile.ffmpegCapabilities.sceneGpuVisualConformance;
  if (installedRenderer?.helper === service.ffmpegCapabilities.sceneGpuRenderer.helper && installedVisualReport?.passed) {
    service.ffmpegCapabilities.sceneGpuRenderer.visualConformance = installedVisualReport;
  }
  service.ffmpegCapabilities.sceneGpuVisualConformance = service.ffmpegCapabilities.sceneGpuRenderer.visualConformance;
  await fs.writeFile(path.join(directory,'capabilities.json'),JSON.stringify(service.ffmpegCapabilities.sceneGpuRenderer,null,2));
  if (!service.ffmpegCapabilities.sceneGpuRenderer.visualConformance?.passed) throw new Error('当前真实 CUDA 画面门禁未通过，停止正式测试');
  service.saveStore = async ()=>{};
  service.writeRecordingMetadata = async ()=>{throw new Error('隔离测试禁止写源录像元数据')};
  service.log = (level,message)=>console.log(JSON.stringify({level,message}));
  service.emitState = ()=>{};
  const report = { duration, source:cleanPath, settings:profile.settings, memoryPeakBytes:0, unifiedRamPeakMiB:0,
    metrics:[], startedAt:new Date().toISOString(), hardware:'AGX Orin', build:args['build-id'] || 'working-tree' };
  let sceneResult;
  const build = service.buildSceneGraphForRecording.bind(service);
  service.buildSceneGraphForRecording = async (...args)=>{
    sceneResult = await build(...args);
    const selected = clipSceneGraph(sceneResult.graph,clipStart,clipStart+duration,{shiftTime:true});
    report.scene = {rawEvents:sceneResult.eventCount, clipObjects:selected.objects.length};
    return sceneResult;
  };
  const transcode = service.runJetsonCudaSceneGraphTranscode.bind(service);
  if (Number(args['native-chunk-seconds']) > 0) {
    const chunked = service.runChunkedJetsonSceneGraphExport.bind(service);
    service.runChunkedJetsonSceneGraphExport = options => chunked({
      ...options, nativeChunkSeconds: Number(args['native-chunk-seconds'])
    });
  }
  service.runJetsonCudaSceneGraphTranscode = async (options)=>{
    const debug = createGpuSceneRenderRequest(options.graph,{backend:'cuda-gstreamer',inputPath:cleanPath,
      outputPath:path.join(directory,'diagnostic.mkv'),codec:options.codec,width:options.width,height:options.height,
      fps:options.fps,duration:5,container:'mkv'});
    debug.input.codec=options.nativeDecode?.sourceCodec || 'hevc';debug.input.startTime=0;
    await fs.writeFile(path.join(directory,'diagnostic-request.json'),JSON.stringify(debug));
    return transcode({...options,
      nativeIdleTimeoutMs: Number(args['native-idle-timeout-ms']) || undefined,
      onStageMetrics:(value)=>{
    report.metrics.push(value); options.onStageMetrics?.(value);
  }, onPipeline:(value)=>{report.pipeline=value;options.onPipeline?.(value)}});
  };
  const preflight = service.probeJetsonNativeSceneForSource.bind(service);
  service.probeJetsonNativeSceneForSource = async (options)=>{report.preflight=await preflight(options);return report.preflight};
  let busy = false;
  let last = '';
  const timer = setInterval(async ()=>{
    if(busy)return;busy=true;
    try {
      report.memoryPeakBytes = Math.max(report.memoryPeakBytes,process.memoryUsage().rss,await memory(process.pid));
      const progress = service.exportProgress;
      const state = {stage:progress?.stageLabel,media:progress?.currentTimeSec,percent:progress?.percent,
        pipeline:progress?.activePipeline, fps:progress?.fps};
      const key=JSON.stringify(state);
      if(key!==last){console.log(JSON.stringify(state));last=key;}
    } finally {busy=false;}
  },2000);
  const stats = spawn('/usr/bin/tegrastats',['--interval','1000'],{stdio:['ignore','pipe','ignore']});
  let telemetry='';
  stats.stdout.on('data',chunk=>{
    const text=chunk.toString();telemetry+=text;
    for(const match of text.matchAll(/RAM (\d+)\//g))report.unifiedRamPeakMiB=Math.max(report.unifiedRamPeakMiB,Number(match[1]));
  });
  const started=Date.now();
  const outputPath=path.join(root,`${duration}s`,'result.mp4');
  try {
    if(existing){const sourceMedia=await probeMediaFileInfo(service.ffmpegPath,cleanPath);
      sceneResult=await service.buildSceneGraphForRecording({cleanPath,danmakuPath:files[1]},
        {stylePreset:profile.settings.burnDanmakuStylePreset,videoInfo:sourceMedia.videoInfo,durationSec:duration});
    }else report.export=await service.runExportClipNow({recording:{cleanPath,danmakuPath:files[1]},mode:'burn',startTime:clipStart,endTime:clipStart+duration,
      stylePreset:profile.settings.burnDanmakuStylePreset,codec:profile.settings.burnCodec,crf:profile.settings.burnCrf,
      outputPath,outputDir:directory});
    if (!existing) report.exportSeconds=(Date.now()-started)/1000;
    const media = await probeMediaFileInfo(service.ffmpegPath,outputPath);
    report.media=media;
    report.timeline=await probeMediaTimelineHealth(service.ffmpegPath,outputPath,media,{packetSampleDurationSec:2});
    const graph=clipSceneGraph(sceneResult.graph,clipStart,clipStart+duration,{shiftTime:true});
    const fps=media.videoInfo.fps;
    const sample=selectSceneSample({...graph,objects:graph.objects.filter(x=>x.start>=sampleMinimum)},duration);
    sample.time=Math.round(sample.time*fps)/fps;sample.outputTime=sample.start+sample.time;
    report.sample=sample;
    const sampleGraph=clipSceneGraph(graph,sample.start,sample.start+sample.duration,{shiftTime:true});
    const assPath=await service.writeLegacySceneCompatibilityAss(path.join(directory,'reference.ass'),sceneResult.events,
      {...profile.settings, stylePreset:profile.settings.burnDanmakuStylePreset,styleLayout:profile.settings.burnDanmakuStyleLayout,
        overlayMode:profile.settings.burnOverlayMode,danmakuArea:profile.settings.burnDanmakuArea,
        videoInfo:media.videoInfo,startTime:clipStart+sample.start,endTime:clipStart+sample.start+sample.duration,shiftTime:true});
    const textless=path.join(directory,'no-text.ass');
    await fs.writeFile(textless,(await fs.readFile(assPath,'utf8')).split(/\r?\n/).filter(line=>
      !line.startsWith('Dialogue:') || /^Dialogue:\s*[^,]*,[^,]*,[^,]*,Shape,/.test(line)).join('\n'));
    const reference=await writeSceneFilterScript(path.join(directory,'reference.filter'),sampleGraph,{duration:sample.duration,fps,target:'software',legacyAssPath:assPath});
    const clean=await writeSceneFilterScript(path.join(directory,'clean.filter'),{...sampleGraph,objects:sampleGraph.objects.filter(x=>x.type!=='Text')},
      {duration:sample.duration,fps,target:'software',legacyAssPath:textless});
    report.pixels=await verifySceneOutputFrame({runJob:(...args)=>runFfmpegJob(service.ffmpegPath,...args),sourcePath:cleanPath,outputPath,
      referenceScript:reference.filterScriptPath,cleanScript:clean.filterScriptPath,sourceStart:clipStart+sample.start,time:sample.time,
      outputTime:sample.outputTime,graph:sampleGraph,directory,prefix:'final',ffmpegPath:service.ffmpegPath,textMask:true});
    report.ok=true;
  } catch(error) {
    report.ok=false;report.error={message:error.message,code:error.code,verification:error.verification};process.exitCode=1;
  } finally {
    clearInterval(timer);clearTimeout(service.exportProgressClearTimer);stats.kill();
    await fs.writeFile(path.join(directory,'tegrastats.log'),telemetry);
    report.totalSeconds=(Date.now()-started)/1000;
    if (!existing) report.effectiveFps=duration*(report.media?.videoInfo?.fps||59.9)/report.exportSeconds;
    const after=await Promise.all(files.map((file,index)=>signature(file,index>0).catch(error => {
      if (index > 1 && error.code === 'ENOENT') return null;
      throw error;
    })));
    report.sourcePreserved=JSON.stringify(before)===JSON.stringify(after);
    report.sourceSignatures=before;
    await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
    for(const name of ['final-actual','final-reference','final-clean']) {
      try {await runFfmpegJob(service.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24',
        '-s',`${report.media?.videoInfo?.width || 2560}x${report.media?.videoInfo?.height || 1440}`,'-i',path.join(directory,`${name}.rgb`),'-frames:v','1',path.join(directory,`${name}.png`)]);} catch{}
    }
    console.log(JSON.stringify({ok:report.ok,exportSeconds:report.exportSeconds,fps:report.effectiveFps,
      memoryPeakMiB:report.memoryPeakBytes/1048576,unifiedRamPeakMiB:report.unifiedRamPeakMiB,pixels:report.pixels,
      preserved:report.sourcePreserved,error:report.error}));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
