'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { runCapturedProcess } = require('../src/server/shared/helpers.cjs');
const { createMergeKeyframeHeaderArgs, createConcatCopyArgs } = require('../src/server/recording/ffmpeg.cjs');

test('different H.264 parameter sets remain seekable at non-IDR keyframes after concat', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-keyframe-headers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = async args => {
    const result = await runCapturedProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 20000 });
    assert.equal(result.status, 0, result.stderr); return result;
  };
  for (let i = 0; i < 2; i++) {
    await run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-c:v', 'libx264',
      '-x264-params', 'open-gop=1:keyint=15:min-keyint=15:scenecut=0', '-bf', '1', '-refs', '1', '-coder', String(i), path.join(dir, `source-${i}.mkv`)]);
  }
  const reports = {};
  for (const repeat of [false, true]) {
    const parts = [];
    for (let i = 0; i < 2; i++) {
      const output = path.join(dir, `part-${repeat}-${i}.mkv`);
      await run(['-i', path.join(dir, `source-${i}.mkv`), '-c', 'copy', ...(repeat ? createMergeKeyframeHeaderArgs('h264') : []), output]);
      parts.push(output);
    }
    const list = path.join(dir, `concat-${repeat}.txt`), output = path.join(dir, `concat-${repeat}.mp4`);
    await fs.writeFile(list, parts.map(file => `file '${file.replace(/\\/g, '/')}'`).join('\n'));
    await runCapturedProcess(ffmpeg, createConcatCopyArgs({ concatPath: list, outputPath: output, container: 'mp4', streamCodec: 'h264' }), { timeoutMs: 20000 });
    reports[repeat] = await runCapturedProcess(ffmpeg, ['-v', 'error', '-ss', '3.25', '-i', output, '-t', '0.25',
      '-map', '0:v:0', '-an', '-vf', 'setpts=N/(30*TB)', '-fps_mode', 'passthrough', '-f', 'null', '-'], { timeoutMs: 20000 });
  }
  const baseline = await runCapturedProcess(ffmpeg, ['-v', 'error', '-ss', '1.25', '-i', path.join(dir, 'source-1.mkv'), '-t', '0.25',
    '-map', '0:v:0', '-an', '-vf', 'setpts=N/(30*TB)', '-fps_mode', 'passthrough', '-f', 'null', '-'], { timeoutMs: 20000 });
  const diagnostics = text => text.replace(/\[h264 @ [^\]]+\]/g, '[h264]').replace(/\r/g, '').trim();
  assert.notEqual(diagnostics(reports.false.stderr), diagnostics(baseline.stderr),
    'fixture must expose the obsolete PPS, beyond the original open-GOP reference diagnostics');
  assert.equal(reports.true.status, 0, reports.true.stderr);
  assert.equal(diagnostics(reports.true.stderr), diagnostics(baseline.stderr));
});

