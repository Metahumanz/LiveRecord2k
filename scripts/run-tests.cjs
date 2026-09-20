'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Keep this list explicit. Shell globs have different ordering and escaping
// rules on Windows and Linux, and they made it too easy to run hardware or
// packaging tests during an ordinary development pass.
const GROUPS = {
  integration: [
    'recording-merge.test.cjs',
    'recording-stability.test.cjs',
    'merge-retry.test.cjs',
    'recording-cleanup.test.cjs',
    'nonblocking.test.cjs',
    'file-stream-lifecycle.test.cjs',
    'burn-queue.test.cjs',
    'export-queue.test.cjs',
    'preview-queue.test.cjs'
  ],
  package: [
    'linux-package.test.cjs',
    'msix-package.test.cjs'
  ],
  hardware: [
    'jetson-cuda-scene-conformance.test.cjs',
    'jetson-native-nvmm-pts.test.cjs',
    'desktop-cuda-scene-conformance.test.cjs'
  ],
  quick: [
    'ass-filter.test.cjs',
    'auth.test.cjs',
    'av-clock-regression.test.cjs',
    'avatar-capture.test.cjs',
    'client-code-splitting.test.cjs',
    'codec-selection.test.cjs',
    'danmaku-ass.test.cjs',
    'desktop-cuda-capability.test.cjs',
    'gpu-scene-conformance.test.cjs',
    'gpu-scene-renderer.test.cjs',
    'jetson-self-test.test.cjs',
    'keyframe-preview.test.cjs',
    'maintenance-confirmation.test.cjs',
    'maintenance-service.test.cjs',
    'release-notes.test.cjs',
    'room-behavior.test.cjs',
    'room-monitor-scheduler.test.cjs',
    'room-monitor-service.test.cjs',
    'room-removal.test.cjs',
    'safety.test.cjs',
    'scene-graph.test.cjs',
    'scene-legacy-conformance.test.cjs',
    'settings-draft.test.cjs',
    'settings-service.test.cjs',
    'sse-incremental.test.cjs',
    'update-service.test.cjs'
  ]
};

const GROUP_OPTIONS = {
  quick: { concurrency: 4, timeoutMs: 60_000 },
  integration: { concurrency: 2, timeoutMs: 120_000 },
  package: { concurrency: 1, timeoutMs: 120_000 },
  hardware: { concurrency: 1, timeoutMs: 120_000 }
};

function allFiles() {
  return [...new Set([...GROUPS.quick, ...GROUPS.integration, ...GROUPS.package, ...GROUPS.hardware])];
}

function validateGroups() {
  const duplicates = allFiles().length !== GROUPS.quick.length + GROUPS.integration.length + GROUPS.package.length + GROUPS.hardware.length;
  if (duplicates) throw new Error('测试分组存在重复文件，请保持分组互斥。');
  for (const file of allFiles()) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) throw new Error(`测试文件不存在：${file}`);
  }
}

function runFile(file, timeoutMs) {
  const fullPath = path.join(__dirname, file);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', fullPath], {
      cwd: path.dirname(__dirname),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ file, durationMs: Date.now() - startedAt, code: 1, timedOut, output: `${stdout}${stderr}\n${error.stack || error}` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ file, durationMs: Date.now() - startedAt, code: timedOut ? 1 : (code ?? 1), signal, timedOut, output: `${stdout}${stderr}` });
    });
  });
}

async function runGroup(group) {
  const files = group === 'all' ? allFiles() : GROUPS[group];
  if (!files) throw new Error(`未知测试分组：${group}`);
  const options = group === 'all' ? { concurrency: 2, timeoutMs: 120_000 } : GROUP_OPTIONS[group];
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const result = await runFile(file, options.timeoutMs);
      results.push(result);
      const seconds = (result.durationMs / 1000).toFixed(1);
      const status = result.timedOut ? 'TIMEOUT' : result.code === 0 ? (result.durationMs >= 10_000 ? 'SLOW' : 'PASS') : 'FAIL';
      console.log(`${status} ${file} ${seconds}s`);
      if (result.code !== 0 && result.output.trim()) {
        process.stdout.write(`${result.output.trim()}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, worker));
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  console.log('\n最慢的测试文件：');
  for (const result of slowest) console.log(`- ${(result.durationMs / 1000).toFixed(1)}s ${result.file}`);
  return results.some((result) => result.code !== 0) ? 1 : 0;
}

async function main() {
  validateGroups();
  const group = String(process.argv[2] || 'quick').toLowerCase();
  process.exitCode = await runGroup(group);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
