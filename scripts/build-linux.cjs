const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packagingRoot = path.join(root, 'packaging', 'linux');
const buildRoot = path.join(root, 'build', 'linux');
const releaseRoot = path.join(root, 'release');

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('Linux 安装包必须在 Linux 构建机上生成，请运行 GitHub Release workflow 或在 Linux 中执行 npm run build:linux。');
  }
  const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '0.0.0');
  const nodeArch = normalizeNodeArch(process.arch);
  const debArch = normalizeDebArch(process.arch);
  const debName = `bili-record-2k_${version}_${debArch}.deb`;
  const tarName = `bili-record-2k_${version}_linux_${nodeArch}.tar.gz`;
  const debPath = path.join(releaseRoot, debName);
  const tarPath = path.join(releaseRoot, tarName);

  runNodeScript(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit']);
  runNodeScript(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ['build']);
  await fsp.rm(buildRoot, { recursive: true, force: true });
  await fsp.mkdir(buildRoot, { recursive: true });
  await fsp.mkdir(releaseRoot, { recursive: true });
  await fsp.rm(debPath, { force: true });
  await fsp.rm(tarPath, { force: true });

  const serverBundle = path.join(buildRoot, 'server.bundle.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(root, 'src', 'server', 'index.cjs')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['vite', 'ffmpeg-static'],
    outfile: serverBundle
  });

  const debRoot = path.join(buildRoot, 'deb-root');
  await populatePayload(debRoot, { version, packageType: 'deb', arch: nodeArch, serverBundle });
  await writeDebianMetadata(debRoot, { version, debArch });
  runCommand('dpkg-deb', ['--build', '--root-owner-group', debRoot, debPath], {
    SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || String(Math.floor(Date.now() / 1000))
  });

  const tarRoot = path.join(buildRoot, 'tar-root');
  const tarPayload = path.join(tarRoot, 'payload');
  await populatePayload(tarPayload, { version, packageType: 'tarball', arch: nodeArch, serverBundle });
  await copyExecutable(path.join(packagingRoot, 'install.sh'), path.join(tarRoot, 'install.sh'));
  await copyExecutable(path.join(packagingRoot, 'uninstall.sh'), path.join(tarRoot, 'uninstall.sh'));
  await fsp.writeFile(
    path.join(tarRoot, 'package-meta.json'),
    `${JSON.stringify({ name: 'bili-record-2k', version, packageType: 'tarball', platform: 'linux', arch: nodeArch }, null, 2)}\n`,
    'utf8'
  );
  runCommand('tar', [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    tarPath,
    '-C',
    tarRoot,
    '.'
  ], { SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || String(Math.floor(Date.now() / 1000)) });

  console.log('Linux build OK');
  console.log(`  deb:     ${debPath}`);
  console.log(`  tarball: ${tarPath}`);
}

async function populatePayload(targetRoot, { version, packageType, arch, serverBundle }) {
  const appDir = path.join(targetRoot, 'usr', 'lib', 'bili-record-2k');
  const binDir = path.join(appDir, 'bin');
  const systemBinDir = path.join(targetRoot, 'usr', 'bin');
  const unitDir = path.join(targetRoot, 'usr', 'lib', 'systemd', 'system');
  const docDir = path.join(targetRoot, 'usr', 'share', 'doc', 'bili-record-2k');
  await Promise.all([
    fsp.mkdir(binDir, { recursive: true }),
    fsp.mkdir(systemBinDir, { recursive: true }),
    fsp.mkdir(unitDir, { recursive: true }),
    fsp.mkdir(docDir, { recursive: true })
  ]);
  await fsp.copyFile(serverBundle, path.join(appDir, 'server.bundle.cjs'));
  await fsp.cp(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
  await fsp.cp(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });
  await fsp.copyFile(process.execPath, path.join(binDir, 'node'));
  await copyExecutable(path.join(packagingRoot, 'linux-update.cjs'), path.join(appDir, 'linux-update.cjs'));
  await copyTextFile(path.join(packagingRoot, 'update-public-key.pem'), path.join(appDir, 'update-public-key.pem'), 0o644);
  await copyExecutable(path.join(packagingRoot, 'provision.sh'), path.join(appDir, 'provision.sh'));
  await copyExecutable(path.join(packagingRoot, 'bootstrap-config.cjs'), path.join(appDir, 'bootstrap-config.cjs'));
  await copyExecutable(path.join(packagingRoot, 'bili-record-2k.sh'), path.join(systemBinDir, 'bili-record-2k'));
  await copyExecutable(path.join(packagingRoot, 'bili-record-2k-update.sh'), path.join(systemBinDir, 'bili-record-2k-update'));
  for (const name of ['bili-record-2k.service', 'bili-record-2k-update.service', 'bili-record-2k-update.path']) {
    await copyTextFile(path.join(packagingRoot, name), path.join(unitDir, name), 0o644);
  }
  await copyTextFile(path.join(root, 'README.md'), path.join(docDir, 'README.md'), 0o644);
  await copyTextFile(path.join(root, 'CHANGELOG.md'), path.join(docDir, 'CHANGELOG.md'), 0o644);
  const nodeLicense = path.resolve(path.dirname(process.execPath), '..', 'LICENSE');
  if (fs.existsSync(nodeLicense)) {
    await copyTextFile(nodeLicense, path.join(docDir, 'NODE-LICENSE'), 0o644);
  }
  await fsp.writeFile(
    path.join(appDir, 'version.json'),
    `${JSON.stringify({ name: 'live-record-2k', version, packageType, platform: 'linux', arch, builtAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );
  await fsp.chmod(path.join(binDir, 'node'), 0o755);
}

async function writeDebianMetadata(debRoot, { version, debArch }) {
  const debianDir = path.join(debRoot, 'DEBIAN');
  await fsp.mkdir(debianDir, { recursive: true });
  const control = [
    'Package: bili-record-2k',
    `Version: ${version}`,
    'Section: video',
    'Priority: optional',
    `Architecture: ${debArch}`,
    'Maintainer: Metahumanz',
    'Depends: ffmpeg, ca-certificates, openssl, passwd, util-linux, tar, fontconfig, fonts-noto-cjk',
    'Homepage: https://github.com/Metahumanz/LiveRecord2k',
    'Description: Bilibili live recording service with a WebUI',
    ' Records live streams and danmaku, and can render danmaku into exported video.',
    ''
  ].join('\n');
  await fsp.writeFile(path.join(debianDir, 'control'), control, 'utf8');
  for (const name of ['postinst', 'prerm', 'postrm']) {
    await copyExecutable(path.join(packagingRoot, name), path.join(debianDir, name));
  }
}

async function copyExecutable(source, target) {
  await copyTextFile(source, target, 0o755);
}

async function copyTextFile(source, target, mode) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const body = (await fsp.readFile(source, 'utf8')).replace(/\r\n/g, '\n');
  await fsp.writeFile(target, body, { encoding: 'utf8', mode });
  await fsp.chmod(target, mode);
}

function normalizeNodeArch(value) {
  if (value === 'x64') return 'x64';
  if (value === 'arm64') return 'arm64';
  throw new Error(`不支持的 Linux Node 架构：${value}`);
}

function normalizeDebArch(value) {
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  throw new Error(`不支持的 Debian 架构：${value}`);
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed with code ${result.status}`);
}

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
}
