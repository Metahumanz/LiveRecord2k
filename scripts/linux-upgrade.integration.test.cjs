const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const enabled = process.platform === 'linux' && process.env.BILI_RECORD_RUN_LINUX_UPGRADE_INTEGRATION === '1';
const debPackage = String(process.env.BILI_RECORD_LINUX_DEB_PACKAGE || '').trim();
const tarballPackage = String(process.env.BILI_RECORD_LINUX_TARBALL_PACKAGE || '').trim();
const releaseVersion = String(process.env.BILI_RECORD_LINUX_UPGRADE_VERSION || '0.4.2').trim();
const oldVersion = '0.4.1';

test(
  'real Linux upgrade installs old Deb/tarball, applies the managed update, and keeps the service healthy',
  { skip: !enabled, timeout: 12 * 60_000 },
  async () => {
    assert.ok(fs.existsSync(debPackage), `缺少 Deb 测试包：${debPackage}`);
    assert.ok(fs.existsSync(tarballPackage), `缺少 tarball 测试包：${tarballPackage}`);
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-linux-upgrade-integration-'));
    try {
      const newDeb = path.join(tempDir, 'new.deb');
      const oldDeb = path.join(tempDir, 'old.deb');
      const newTarball = path.join(tempDir, 'new.tar.gz');
      const oldTarball = path.join(tempDir, 'old.tar.gz');
      await Promise.all([
        fsp.copyFile(debPackage, newDeb),
        fsp.copyFile(tarballPackage, newTarball)
      ]);
      await createOldDeb(newDeb, oldDeb, oldVersion);
      await createOldTarball(newTarball, oldTarball, oldVersion);

      for (const scenario of [
        { kind: 'deb', oldPackage: '/artifacts/old.deb', newPackage: '/artifacts/new.deb' },
        { kind: 'tarball', oldPackage: '/artifacts/old.tar.gz', newPackage: '/artifacts/new.tar.gz' }
      ]) {
        const containerName = `br2k-upgrade-${scenario.kind}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
        await run(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            containerName,
            '-v',
            `${tempDir}:/artifacts:ro`,
            '-v',
            `${path.join(root, 'scripts', 'linux-upgrade-container.sh')}:/runner.sh:ro`,
            'debian:bookworm',
            'sh',
            '/runner.sh',
            scenario.kind,
            scenario.oldPackage,
            scenario.newPackage,
            oldVersion,
            releaseVersion
          ],
          { timeoutMs: 10 * 60_000 }
        );
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
);

async function createOldDeb(sourcePath, targetPath, version) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-old-deb-'));
  try {
    await run('dpkg-deb', ['-R', sourcePath, tempDir]);
    const controlPath = path.join(tempDir, 'DEBIAN', 'control');
    const control = await fsp.readFile(controlPath, 'utf8');
    await fsp.writeFile(controlPath, control.replace(/^Version:\s*.+$/m, `Version: ${version}`), 'utf8');
    await rewritePackageVersion(path.join(tempDir, 'usr', 'lib', 'bili-record-2k', 'version.json'), version);
    await run('dpkg-deb', ['--build', '--root-owner-group', tempDir, targetPath]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function createOldTarball(sourcePath, targetPath, version) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-old-tar-'));
  try {
    await run('tar', ['-xzf', sourcePath, '-C', tempDir]);
    await rewritePackageVersion(path.join(tempDir, 'payload', 'usr', 'lib', 'bili-record-2k', 'version.json'), version);
    await rewritePackageVersion(path.join(tempDir, 'package-meta.json'), version);
    await run('tar', ['-czf', targetPath, '-C', tempDir, '.']);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function rewritePackageVersion(filePath, version) {
  const payload = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  payload.version = version;
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, Number(options.timeoutMs || 120_000));
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} 失败（${signal || `退出码 ${code}`}）：${stderr || stdout}`));
    });
  });
}
