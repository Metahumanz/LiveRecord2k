const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const releaseRoot = path.join(root, 'release');
const releaseDir = path.join(releaseRoot, 'webui');
const buildDir = path.join(root, 'build');
const zipPath = path.join(releaseRoot, 'bili-record-2k-webui.zip');
const setupPath = path.join(releaseRoot, 'bili-record-2k-setup.exe');
const launcherExePath = path.join(releaseDir, 'BiliRecord2K.exe');
const serviceExePath = path.join(releaseDir, 'BiliRecord2K.Service.exe');
const serverBundlePath = path.join(buildDir, 'server.bundle.cjs');
const seaConfigPath = path.join(buildDir, 'sea-config.json');
const seaBlobPath = path.join(buildDir, 'sea-prep.blob');
const installerScriptPath = path.join(root, 'scripts', 'installer.nsi');
const launcherTemplatePath = path.join(root, 'scripts', 'win-tray-launcher.c');
const launcherSourcePath = path.join(buildDir, 'launcher.c');
const launcherRcPath = path.join(buildDir, 'launcher.rc');
const launcherResPath = path.join(buildDir, 'launcher.res');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  runNodeScript(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit']);
  runNodeScript(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ['build']);

  await fsp.rm(releaseDir, { recursive: true, force: true });
  await fsp.rm(buildDir, { recursive: true, force: true });
  await fsp.mkdir(releaseDir, { recursive: true });
  await fsp.mkdir(buildDir, { recursive: true });
  await bundleServer();
  await fsp.cp(path.join(root, 'dist'), path.join(releaseDir, 'dist'), { recursive: true });
  await fsp.cp(path.join(root, 'assets'), path.join(releaseDir, 'assets'), { recursive: true });
  await writeVersionFile();

  await buildServiceExe();
  await buildLauncherExe();
  await copyFfmpegBinary();
  await fsp.rm(zipPath, { force: true });
  await fsp.rm(setupPath, { force: true });
  zipRelease();
  await buildInstaller();

  console.log('Build OK');
  console.log(`  dist:     ${path.join(root, 'dist')}`);
  console.log(`  release:  ${releaseDir}`);
  console.log(`  launcher: ${launcherExePath}`);
  console.log(`  service:  ${serviceExePath}`);
  console.log(`  zip:      ${zipPath}`);
  if (fs.existsSync(setupPath)) {
    console.log(`  setup:    ${setupPath}`);
  }
}

async function writeVersionFile() {
  const packageJson = await readPackageJson();
  await fsp.writeFile(
    path.join(releaseDir, 'version.json'),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        builtAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function readPackageJson() {
  return JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
}

async function bundleServer() {
  await fsp.mkdir(buildDir, { recursive: true });
  runNodeScript(path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
    path.join(root, 'server', 'index.cjs'),
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--external:vite',
    '--external:ffmpeg-static',
    `--outfile=${serverBundlePath}`
  ]);
}

async function buildServiceExe() {
  await fsp.writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: serverBundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  runNode(['--experimental-sea-config', seaConfigPath]);
  await fsp.copyFile(process.execPath, serviceExePath);
  runNodeScript(path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), [
    serviceExePath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--overwrite'
  ]);
}

async function buildLauncherExe() {
  if (process.platform !== 'win32') {
    await fsp.copyFile(serviceExePath, launcherExePath);
    return;
  }

  await fsp.copyFile(launcherTemplatePath, launcherSourcePath);

  const iconPath = path.join(root, 'assets', 'app-icon.ico');
  const gccArgs = [
    launcherSourcePath,
    '-municode',
    '-mwindows',
    '-Os',
    '-s',
    '-o',
    launcherExePath,
    '-lshell32',
    '-luser32',
    '-lwininet',
    '-lgdi32'
  ];
  if (fs.existsSync(iconPath)) {
    await fsp.writeFile(launcherRcPath, `1 ICON "${iconPath.replace(/\\/g, '/')}"\n`, 'utf8');
    runCommand('windres', ['-O', 'coff', '-i', launcherRcPath, '-o', launcherResPath]);
    gccArgs.splice(1, 0, launcherResPath);
  }
  runCommand('gcc', gccArgs);
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

async function buildInstaller() {
  if (process.platform !== 'win32') {
    console.log('Installer skipped: NSIS installer is only built on Windows.');
    return;
  }
  const makensis = findMakensis();
  if (!makensis) {
    const message = 'Installer skipped: makensis.exe was not found. Install NSIS or set MAKENSIS_PATH.';
    if (isTruthy(process.env.BUILD_INSTALLER_REQUIRED)) {
      throw new Error(message);
    }
    console.log(message);
    return;
  }

  const packageJson = await readPackageJson();
  const version = String(packageJson.version || '0.0.0');
  runCommand(makensis, [
    `/DAPP_VERSION=${version}`,
    `/DAPP_VERSION_QUAD=${toVersionQuad(version)}`,
    `/DRELEASE_DIR=${releaseDir}`,
    `/DOUT_FILE=${setupPath}`,
    `/DICON_PATH=${path.join(root, 'assets', 'app-icon.ico')}`,
    installerScriptPath
  ]);
}

function findMakensis() {
  const configured = String(process.env.MAKENSIS_PATH || '').trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const fromPath = findCommandOnPath('makensis.exe');
  if (fromPath) {
    return fromPath;
  }
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NSIS', 'makensis.exe')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function findCommandOnPath(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8' });
  if (result.status !== 0) {
    return '';
  }
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function toVersionQuad(version) {
  const parts = String(version || '0.0.0')
    .split(/[.-]/)
    .map((part) => Number(part) || 0)
    .slice(0, 4);
  while (parts.length < 4) {
    parts.push(0);
  }
  return parts.join('.');
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${scriptPath} ${args.join(' ')} failed with code ${result.status}`);
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} failed with code ${result.status}`);
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
  }
}

function escapePowerShellPath(value) {
  return String(value).replace(/'/g, "''");
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}
