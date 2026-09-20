'use strict';

// Opt-in end-to-end regression for a real clean source and exported style
// outputs. Set BR2K_AV_CLOCK_SOURCE, BR2K_AV_CLOCK_FFPROBE and
// BR2K_AV_CLOCK_STYLE_OUTPUTS (JSON object: {"h5-card":"...mp4",...}) on
// Orin. The normal CI run skips because it has no recording library.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-12000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)));
  });
}

async function durationOf(ffprobe, filePath) {
  const output = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
  return Number(String(output).trim());
}

async function packetAt(ffprobe, filePath, selector, time) {
  const start = Math.max(0, Number(time) - 0.05);
  const output = await run(ffprobe, [
    '-v', 'error', '-read_intervals', `${start}%+0.40`, '-select_streams', selector,
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', filePath
  ]);
  const values = String(output).split(/\r?\n/).map(Number).filter(Number.isFinite);
  const future = values.find((value) => value >= Number(time) - 0.01);
  return future ?? values.at(-1) ?? null;
}

async function avDeltaAt(ffprobe, filePath, time) {
  const [video, audio] = await Promise.all([
    packetAt(ffprobe, filePath, 'v:0', time),
    packetAt(ffprobe, filePath, 'a:0', time)
  ]);
  return Number.isFinite(video) && Number.isFinite(audio) ? audio - video : null;
}

test('real clean/output files keep one A/V source clock at long-range checkpoints', async (t) => {
  const source = process.env.BR2K_AV_CLOCK_SOURCE;
  const ffprobe = process.env.BR2K_AV_CLOCK_FFPROBE || '/usr/lib/bili-record-2k/bin/ffprobe-full';
  const outputs = process.env.BR2K_AV_CLOCK_STYLE_OUTPUTS ? JSON.parse(process.env.BR2K_AV_CLOCK_STYLE_OUTPUTS) : null;
  if (!source || !outputs || typeof outputs !== 'object') {
    return t.skip('设置 BR2K_AV_CLOCK_SOURCE 与 BR2K_AV_CLOCK_STYLE_OUTPUTS 后在 Orin 执行');
  }
  const sourceDuration = await durationOf(ffprobe, source);
  const points = [...new Set([0, 60, 600, 1800, Math.max(0, sourceDuration - 0.5)].filter((point) => point <= sourceDuration))];
  const sourceDeltas = new Map();
  for (const point of points) sourceDeltas.set(point, await avDeltaAt(ffprobe, source, point));
  for (const [style, output] of Object.entries(outputs)) {
    const outputDuration = await durationOf(ffprobe, output);
    assert.ok(outputDuration > 0, `${style}: output duration must be positive`);
    for (const point of points.filter((value) => value <= outputDuration)) {
      const actual = await avDeltaAt(ffprobe, output, point);
      const expected = sourceDeltas.get(point);
      assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${style}@${point}s: missing A/V packet PTS`);
      assert.ok(Math.abs(actual - expected) <= 0.12, `${style}@${point}s: A/V delta drift ${actual - expected}s`);
    }
  }
});

