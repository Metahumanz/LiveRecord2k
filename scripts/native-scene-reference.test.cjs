'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = process.env.FFMPEG_BIN || require('ffmpeg-static');
const { runFfmpegJob, probeMediaFileInfo, probeMediaClipTimelineInfo } = require('../src/server/shared/helpers.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { verifySceneOutputFrame } = require('../src/server/danmaku/scene-output-verifier.cjs');
const { clipSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');

test('native rolling reference retains a 21 ms video lead without admitting missing text', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-reference-test-'));
  const source = path.join(directory, 'source.nut');
  const candidate = path.join(directory, 'native-clock.nut');
  const graph = { schema: 'bili-record2k.scene/v1', version: 1, canvas: { width: 1280, height: 720 },
    timeline: { start: 0, end: 3 }, assets: [], style: {}, metadata: {}, objects: [{
      id: 'rolling', type: 'Text', start: 0, end: 3, frame: { x: 1000, y: 40, width: 500, height: 80 },
      style: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2 },
      props: { text: 'WIDE CLOCK', fontFamily: 'Arial', fontSize: 52, fontWeight: 400 },
      animations: [{ type: 'Move', start: 0, end: 3, from: { x: 1000, y: 40 }, to: { x: -1100, y: 40 } }]
    }] };
  const run = args => runFfmpegJob(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], () => {});
  try {
    await run(['-y', '-f', 'lavfi', '-i', 'color=0x203040:s=1280x720:r=60:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex', '[0:v]settb=1/1000000,setpts=PTS+21000[v]', '-map', '[v]', '-map', '1:a', '-t', '3',
      '-fps_mode', 'passthrough', '-enc_time_base:v', '1/1000000',
      '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', source]);
    const info = await probeMediaFileInfo(ffmpeg, source);
    const timing = await probeMediaClipTimelineInfo(ffmpeg, source, 0, 1, info);
    assert.ok(Math.abs(timing.firstVideoPts - 0.021) < 0.001, '夹具必须保留真实 21 ms 起点');
    // Independent native-clock oracle: draw from demux PTS and place the
    // moving text at the CUDA nearest-pixel coordinate, without a Scene filter.
    // Like the NVMM output, include a black frame at 0 then retain each
    // source picture's 21 ms + N/60 timestamp. Avoid AAC priming in the oracle.
    await run(['-y', '-i', source, '-vf', "drawtext=font='Arial':fontfile='Arial\\:style=Regular':text='WIDE CLOCK':fontsize=52:fontcolor=white:borderw=2:bordercolor=black:x='floor(1000-700*t+0.5)':y=40,tpad=start=1:start_mode=add,settb=1/1000000,setpts='if(eq(N,0),0,((N-1)/60+0.021)/TB)'",
      '-fps_mode', 'passthrough', '-enc_time_base:v', '1/1000000',
      '-c:v', 'ffv1', '-level', '3', '-an', candidate]);
    const blank = { ...graph, objects: [] };
    const oldReference = await writeSceneFilterScript(path.join(directory, 'old.filter'), graph, { duration: 3, fps: 60 });
    const oldClean = await writeSceneFilterScript(path.join(directory, 'old-clean.filter'), blank, { duration: 3, fps: 60 });
    const reference = await writeSceneFilterScript(path.join(directory, 'native.filter'), graph, { duration: 3, fps: 60, preserveInputClock: true, roundCoordinates: true });
    const clean = await writeSceneFilterScript(path.join(directory, 'native-clean.filter'), blank, { duration: 3, fps: 60, preserveInputClock: true, roundCoordinates: true });
    const check = (output, ref, noText, prefix) => verifySceneOutputFrame({ runJob: (...args) => runFfmpegJob(ffmpeg, ...args),
      sourcePath: source, outputPath: output, referenceScript: ref.filterScriptPath, cleanScript: noText.filterScriptPath,
      sourceStart: 0, time: 0.5, graph, directory, prefix, ffmpegPath: ffmpeg, textMask: true });
    await assert.rejects(check(candidate, oldReference, oldClean, 'old'), { code: 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' });
    assert.equal((await check(candidate, reference, clean, 'fixed')).ok, true);
    await assert.rejects(check(source, reference, clean, 'missing'), { code: 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' });
    // A later sample seeks within a source frame interval. Retain the
    // residual PTS relative to that seek instead of zeroing its first picture.
    const clipped = clipSceneGraph(graph, 0.3, 3, { shiftTime: true });
    const seekReference = await writeSceneFilterScript(path.join(directory, 'seek.filter'), clipped,
      { duration: 2.7, fps: 60, preserveInputClock: true, roundCoordinates: true });
    const seekClean = await writeSceneFilterScript(path.join(directory, 'seek-clean.filter'), { ...clipped, objects: [] },
      { duration: 2.7, fps: 60, preserveInputClock: true, roundCoordinates: true });
    assert.equal((await verifySceneOutputFrame({ runJob: (...args) => runFfmpegJob(ffmpeg, ...args),
      sourcePath: source, outputPath: candidate, referenceScript: seekReference.filterScriptPath,
      cleanScript: seekClean.filterScriptPath, sourceStart: 0.3, time: 0.5, outputTime: 0.8,
      graph: clipped, directory, prefix: 'seek', ffmpegPath: ffmpeg, textMask: true })).ok, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
