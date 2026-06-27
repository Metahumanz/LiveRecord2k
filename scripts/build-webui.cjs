const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const releaseRoot = path.join(root, 'release');
const releaseDir = path.join(releaseRoot, 'webui');
const zipPath = path.join(releaseRoot, 'bili-record-2k-webui.zip');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  runNodeScript(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit']);
  runNodeScript(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ['build']);

  await fsp.rm(releaseDir, { recursive: true, force: true });
  await fsp.mkdir(releaseDir, { recursive: true });
  await fsp.cp(path.join(root, 'dist'), path.join(releaseDir, 'dist'), { recursive: true });
  await fsp.cp(path.join(root, 'server'), path.join(releaseDir, 'server'), { recursive: true });
  await fsp.cp(path.join(root, 'assets'), path.join(releaseDir, 'assets'), { recursive: true });

  const runtimePackage = {
    name: 'bili-record-2k-webui',
    version: '0.1.0',
    private: true,
    description: '哔哩录播 2K WebUI runtime package',
    scripts: {
      start: 'node server/index.cjs --prod'
    },
    dependencies: {
      'ffmpeg-static': '^5.3.0',
      qrcode: '^1.5.4',
      ws: '^8.18.0'
    }
  };
  await fsp.writeFile(
    path.join(releaseDir, 'package.json'),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    'utf8'
  );
  await fsp.writeFile(
    path.join(releaseDir, 'start-webui.cmd'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      'if not exist node_modules (',
      '  echo First run in this folder: npm install --omit=dev',
      '  echo.',
      ')',
      'node server\\index.cjs --prod',
      'pause',
      ''
    ].join('\r\n'),
    'utf8'
  );

  await copyFfmpegBinary();
  await fsp.rm(zipPath, { force: true });
  zipRelease();

  console.log('Build OK');
  console.log(`  dist:    ${path.join(root, 'dist')}`);
  console.log(`  release: ${releaseDir}`);
  console.log(`  zip:     ${zipPath}`);
}

async function copyFfmpegBinary() {
  let ffmpegStatic = null;
  try {
    ffmpegStatic = require('ffmpeg-static');
  } catch {
    return;
  }
  if (!ffmpegStatic || !fs.existsSync(ffmpegStatic)) {
    return;
  }
  const binDir = path.join(releaseDir, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const targetName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  await fsp.copyFile(ffmpegStatic, path.join(binDir, targetName));
}

function zipRelease() {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const result = spawnSync(
    command,
    [
      '-NoProfile',
      '-Command',
      `$source = Join-Path '${escapePowerShellPath(releaseDir)}' '*'; Compress-Archive -Path $source -DestinationPath '${escapePowerShellPath(
        zipPath
      )}' -Force`
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error('Zip package failed');
  }
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${scriptPath} ${args.join(' ')} failed with code ${result.status}`);
  }
}

function escapePowerShellPath(value) {
  return String(value).replace(/'/g, "''");
}
