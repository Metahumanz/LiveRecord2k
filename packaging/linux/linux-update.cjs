#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_PACKAGE = 'bili-record-2k';
const SERVICE_NAME = 'bili-record-2k.service';

function getPaths(env = process.env) {
  const configRoot = path.resolve(env.BILI_RECORD_CONFIG_DIR || '/var/lib/bili-record-2k');
  const updateDir = path.join(configRoot, 'BiliRecord2K', 'updates');
  return {
    configRoot,
    updateDir,
    requestPath: path.join(updateDir, 'apply-request.json'),
    processingPath: path.join(updateDir, 'apply-request.processing.json'),
    statusPath: path.join(updateDir, 'last-update-status.json'),
    logPath: path.join(updateDir, 'apply-update.log')
  };
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('系统更新辅助程序只能在 Linux 上运行。');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('系统更新辅助程序必须由 root systemd 单元运行。');
  }
  const paths = getPaths();
  await fsp.mkdir(paths.updateDir, { recursive: true });
  await claimRequest(paths);
  let request = null;
  let temporaryPackage = '';
  let extractionDir = '';
  let serviceStopped = false;
  try {
    request = JSON.parse(await fsp.readFile(paths.processingPath, 'utf8'));
    validateRequestShape(request, paths);
    await writeStatus(paths, request, 'applying', '正在进行系统级更新校验。');
    await appendLog(paths, `开始处理 ${request.version} ${request.packageType} 更新请求。`);

    temporaryPackage = path.join(
      os.tmpdir(),
      `bili-record-2k-update-${process.pid}-${crypto.randomBytes(6).toString('hex')}${packageExtension(request.packageType)}`
    );
    await copyUntrustedPackage(request.packagePath, temporaryPackage);
    const actualSha256 = await fileSha256(temporaryPackage);
    if (!safeEqualHex(actualSha256, request.sha256)) {
      throw new Error(`SHA-256 校验失败：期望 ${request.sha256}，实际 ${actualSha256}`);
    }
    assertUpgradeVersion(request.version, readInstalledVersion());

    if (request.packageType === 'deb') {
      await validateDebPackage(temporaryPackage, request.version);
    } else if (request.packageType === 'tarball') {
      extractionDir = await validateAndExtractTarball(temporaryPackage, request.version);
    } else {
      throw new Error(`不支持的 Linux 更新包类型：${request.packageType}`);
    }

    await appendLog(paths, '更新包结构与版本校验通过，正在停止主服务。');
    await runCommand('systemctl', ['stop', SERVICE_NAME], { paths });
    serviceStopped = true;

    if (request.packageType === 'deb') {
      await runCommand('dpkg', ['-i', temporaryPackage], {
        paths,
        env: { ...process.env, BILI_RECORD_UPDATE_APPLYING: '1' }
      });
    } else {
      await runCommand('sh', [path.join(extractionDir, 'install.sh'), '--upgrade', '--from-updater'], {
        paths,
        cwd: extractionDir,
        env: { ...process.env, BILI_RECORD_UPDATE_APPLYING: '1' }
      });
    }

    await runCommand('systemctl', ['daemon-reload'], { paths });
    await writeStatus(paths, request, 'success', `已更新到 ${request.version}。`);
    await appendLog(paths, `安装完成，正在启动 ${SERVICE_NAME}。`);
    await runCommand('systemctl', ['start', SERVICE_NAME], { paths });
    serviceStopped = false;
    await appendLog(paths, `更新到 ${request.version} 成功。`);
  } catch (error) {
    await appendLog(paths, `更新失败：${error.stack || error.message || error}`);
    await writeStatus(paths, request || {}, 'error', error.message || String(error));
    if (serviceStopped) {
      await runCommand('systemctl', ['daemon-reload'], { allowFailure: true, paths });
      await runCommand('systemctl', ['start', SERVICE_NAME], { allowFailure: true, paths });
    }
    throw error;
  } finally {
    await fsp.rm(paths.processingPath, { force: true }).catch(() => {});
    if (temporaryPackage) await fsp.rm(temporaryPackage, { force: true }).catch(() => {});
    if (extractionDir) await fsp.rm(extractionDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimRequest(paths) {
  await fsp.rm(paths.processingPath, { force: true });
  try {
    await fsp.rename(paths.requestPath, paths.processingPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('没有待处理的更新请求。');
    }
    throw error;
  }
}

function validateRequestShape(request, paths) {
  if (!request || request.schemaVersion !== 1 || request.app !== APP_PACKAGE) {
    throw new Error('更新请求格式无效。');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(request.version || ''))) {
    throw new Error('更新请求版本号无效。');
  }
  if (!['deb', 'tarball'].includes(request.packageType)) {
    throw new Error('更新请求包类型无效。');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(request.sha256 || ''))) {
    throw new Error('更新请求缺少有效 SHA-256。');
  }
  const resolvedPackage = path.resolve(String(request.packagePath || ''));
  const relative = path.relative(paths.updateDir, resolvedPackage);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('更新包必须是受控更新目录中的直接文件。');
  }
  if (path.dirname(resolvedPackage) !== path.resolve(paths.updateDir)) {
    throw new Error('更新包不能位于更新目录的子目录中。');
  }
  request.packagePath = resolvedPackage;
  request.sha256 = String(request.sha256).toLowerCase();
}

async function copyUntrustedPackage(source, target) {
  const stat = await fsp.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error('更新包不是有效的普通文件。');
  }
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(target, 0o600);
}

async function validateDebPackage(packagePath, expectedVersion) {
  const result = await runCommand('dpkg-deb', ['-f', packagePath, 'Package', 'Version', 'Architecture']);
  const fields = result.stdout.trim().split(/\r?\n/);
  if (fields[0] !== APP_PACKAGE) throw new Error(`Deb 包名不正确：${fields[0] || '空'}`);
  if (normalizeVersion(fields[1]) !== normalizeVersion(expectedVersion)) {
    throw new Error(`Deb 包版本不匹配：${fields[1] || '空'}`);
  }
  const expectedArch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (!fields[2] || !['all', expectedArch].includes(fields[2])) {
    throw new Error(`Deb 包架构不匹配：当前 ${expectedArch}，包为 ${fields[2] || '空'}`);
  }
}

async function validateAndExtractTarball(packagePath, expectedVersion) {
  const listing = await runCommand('tar', ['-tzf', packagePath]);
  const entries = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!entries.length) throw new Error('Linux 更新包为空。');
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '');
    if (!normalized) continue;
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Linux 更新包包含不安全路径：${entry}`);
    }
  }
  const verbose = await runCommand('tar', ['-tvzf', packagePath]);
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error('Linux 更新包包含链接或特殊文件，已拒绝安装。');
  }
  const extractionDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-record-2k-extract-'));
  await runCommand('tar', ['-xzf', packagePath, '--no-same-owner', '-C', extractionDir]);
  const meta = JSON.parse(await fsp.readFile(path.join(extractionDir, 'package-meta.json'), 'utf8'));
  if (meta.name !== APP_PACKAGE || meta.packageType !== 'tarball') throw new Error('Linux 更新包元数据无效。');
  if (normalizeVersion(meta.version) !== normalizeVersion(expectedVersion)) throw new Error('Linux 更新包版本不匹配。');
  if (meta.arch !== process.arch) throw new Error(`Linux 更新包架构不匹配：当前 ${process.arch}，包为 ${meta.arch || '空'}`);
  const installStat = await fsp.stat(path.join(extractionDir, 'install.sh'));
  if (!installStat.isFile()) throw new Error('Linux 更新包缺少 install.sh。');
  return extractionDir;
}

function readInstalledVersion() {
  try {
    const payload = JSON.parse(fs.readFileSync('/usr/lib/bili-record-2k/version.json', 'utf8'));
    return normalizeVersion(payload.version || '');
  } catch {
    return '';
  }
}

function assertUpgradeVersion(nextVersion, currentVersion) {
  if (currentVersion && compareVersions(nextVersion, currentVersion) <= 0) {
    throw new Error(`拒绝降级或重复安装：当前 ${currentVersion}，请求 ${nextVersion}`);
  }
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(/[.-]/).map((part) => Number(part) || 0);
  const b = normalizeVersion(right).split(/[.-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function packageExtension(packageType) {
  return packageType === 'deb' ? '.deb' : '.tar.gz';
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || '').toLowerCase(), 'utf8');
  const b = Buffer.from(String(right || '').toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function writeStatus(paths, request, status, message) {
  const payload = {
    status,
    version: normalizeVersion(request.version || ''),
    packagePath: request.packagePath || '',
    message,
    logPath: paths.logPath,
    updatedAt: new Date().toISOString()
  };
  const temporary = `${paths.statusPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await fsp.rename(temporary, paths.statusPath);
  await fsp.chmod(paths.statusPath, 0o644);
}

async function appendLog(paths, message) {
  await fsp.appendFile(paths.logPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8', mode: 0o644 });
  await fsp.chmod(paths.logPath, 0o644).catch(() => {});
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      if (options.paths) {
        if (stdout.trim()) await appendLog(options.paths, `${command}: ${stdout.trim()}`);
        if (stderr.trim()) await appendLog(options.paths, `${command} stderr: ${stderr.trim()}`);
      }
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${stderr.trim() || stdout.trim()}`));
    });
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  getPaths,
  validateRequestShape,
  assertUpgradeVersion,
  compareVersions,
  normalizeVersion,
  safeEqualHex
};
