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
const PUBLIC_KEY_PATH = path.join(__dirname, 'update-public-key.pem');

function getPaths(env = process.env) {
  const configRoot = path.resolve(env.BILI_RECORD_CONFIG_DIR || '/var/lib/bili-record-2k');
  const updateDir = path.resolve(env.BILI_RECORD_UPDATE_DIR || '/var/lib/bili-record-2k-updates');
  return {
    configRoot,
    updateDir,
    requestPath: path.join(updateDir, 'apply-request.json'),
    processingPath: path.join(updateDir, 'apply-request.processing.json'),
    errorRequestPath: path.join(updateDir, 'apply-request.error.json'),
    successRequestPath: path.join(updateDir, 'apply-request.success.json'),
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
  let completed = false;
  try {
    request = await readUntrustedJsonFile(paths.processingPath);
    validateRequestShape(request, paths);
    const signedPackage = await verifySignedRequest(request);
    request.version = normalizeVersion(request.signed.version);
    request.packageType = signedPackage.kind;
    request.sha256 = signedPackage.sha256;
    request.arch = signedPackage.arch;
    await writeStatus(paths, request, 'processing', '正在验证官方签名与系统更新包。');
    await appendLog(paths, `开始处理 ${request.version} ${request.packageType} 更新请求。`);

    if (normalizeVersion(readInstalledVersion()) === normalizeVersion(request.version)) {
      await appendLog(paths, '检测到目标版本已经安装，正在恢复更新完成状态。');
      await runCommand('systemctl', ['daemon-reload'], { allowFailure: true, paths });
      await runCommand('systemctl', ['start', SERVICE_NAME], { allowFailure: true, paths });
      await writeStatus(paths, request, 'success', `已恢复到 ${request.version}。`);
      completed = true;
      return;
    }

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
    completed = true;
  } catch (error) {
    await appendLog(paths, `更新失败：${error.stack || error.message || error}`);
    await writeStatus(paths, request || {}, 'error', error.message || String(error));
    if (serviceStopped) {
      await runCommand('systemctl', ['daemon-reload'], { allowFailure: true, paths });
      await runCommand('systemctl', ['start', SERVICE_NAME], { allowFailure: true, paths });
    }
    throw error;
  } finally {
    const archivePath = completed ? paths.successRequestPath : paths.errorRequestPath;
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    await fsp.rename(paths.processingPath, archivePath).catch(() => {});
    if (temporaryPackage) await fsp.rm(temporaryPackage, { force: true }).catch(() => {});
    if (extractionDir) await fsp.rm(extractionDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimRequest(paths) {
  const processing = await fsp.lstat(paths.processingPath).catch(() => null);
  if (processing?.isFile() && !processing.isSymbolicLink()) {
    await appendLog(paths, '检测到上次中断的 processing 请求，正在恢复。');
    return;
  }
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
  if (!request || request.schemaVersion !== 2 || request.app !== APP_PACKAGE) {
    throw new Error('更新请求格式无效。');
  }
  if (!request.signed || request.signatureAlgorithm !== 'ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(request.signature || ''))) {
    throw new Error('更新请求缺少官方 Ed25519 签名清单。');
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
}

async function verifySignedRequest(request, options = {}) {
  const signed = request.signed;
  if (!signed || signed.schemaVersion !== 1 || signed.app !== APP_PACKAGE) {
    throw new Error('官方签名清单格式无效。');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(signed.version || ''))) {
    throw new Error('官方签名清单版本号无效。');
  }
  const publicKey = options.publicKey || (await fsp.readFile(options.publicKeyPath || PUBLIC_KEY_PATH, 'utf8'));
  const signature = Buffer.from(String(request.signature || ''), 'base64');
  const verified = crypto.verify(null, Buffer.from(stableStringify(signed)), publicKey, signature);
  if (!verified) throw new Error('官方更新清单签名验证失败。');
  const packageName = path.basename(request.packagePath);
  const selected = Array.isArray(signed.files) ? signed.files.find((file) => file?.name === packageName) : null;
  if (!selected || selected.platform !== 'linux' || !['deb', 'tarball'].includes(selected.kind)) {
    throw new Error('签名清单中找不到当前 Linux 更新包。');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(selected.sha256 || ''))) throw new Error('签名清单中的 SHA-256 无效。');
  const expectedArch = process.arch;
  if (!['all', expectedArch].includes(String(selected.arch || ''))) {
    throw new Error(`签名清单架构不匹配：当前 ${expectedArch}，包为 ${selected.arch || '空'}`);
  }
  return { ...selected, sha256: String(selected.sha256).toLowerCase() };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function copyUntrustedPackage(source, target) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const sourceHandle = await fsp.open(source, fs.constants.O_RDONLY | noFollow);
  let targetHandle = null;
  try {
    const stat = await sourceHandle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024 * 1024) {
      throw new Error('更新包不是大小合理的普通文件。');
    }
    targetHandle = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let readPosition = 0;
    while (readPosition < stat.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, stat.size - readPosition), readPosition);
      if (!bytesRead) break;
      let writeOffset = 0;
      while (writeOffset < bytesRead) {
        const { bytesWritten } = await targetHandle.write(buffer, writeOffset, bytesRead - writeOffset, null);
        if (!bytesWritten) throw new Error('复制更新包时写入被意外中断。');
        writeOffset += bytesWritten;
      }
      readPosition += bytesRead;
    }
    if (readPosition !== stat.size) throw new Error('复制更新包时读取被意外中断。');
    await targetHandle.sync();
  } finally {
    await sourceHandle.close().catch(() => {});
    if (targetHandle) await targetHandle.close().catch(() => {});
  }
}

async function readUntrustedJsonFile(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) {
      throw new Error('更新请求不是大小合理的普通文件。');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function validateDebPackage(packagePath, expectedVersion) {
  const result = await runCommand('dpkg-deb', ['-f', packagePath, 'Package', 'Version', 'Architecture']);
  const fields = parseDebFields(result.stdout);
  if (fields.Package !== APP_PACKAGE) throw new Error(`Deb 包名不正确：${fields.Package || '空'}`);
  if (normalizeVersion(fields.Version) !== normalizeVersion(expectedVersion)) {
    throw new Error(`Deb 包版本不匹配：${fields.Version || '空'}`);
  }
  const expectedArch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (!fields.Architecture || !['all', expectedArch].includes(fields.Architecture)) {
    throw new Error(`Deb 包架构不匹配：当前 ${expectedArch}，包为 ${fields.Architecture || '空'}`);
  }
}

function parseDebFields(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = {};
  for (const line of lines) {
    const match = /^(Package|Version|Architecture):\s*(.+)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  // Some dpkg-deb versions print only values even when multiple fields are requested.
  if (!fields.Package && lines.length >= 3) {
    [fields.Package, fields.Version, fields.Architecture] = lines;
  }
  return fields;
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
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalizeVersion(value));
  if (!match) throw new Error(`无效的 SemVer：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
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
  await writeRootFileAtomic(paths.statusPath, `${JSON.stringify(payload, null, 2)}\n`, 0o644);
}

async function appendLog(paths, message) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(paths.logPath, flags, 0o644);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('更新日志目标不是普通文件。');
    await handle.chmod(0o644);
    await handle.writeFile(`[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function writeRootFileAtomic(targetPath, payload, mode) {
  const temporary = `${targetPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fsp.open(temporary, flags, mode);
    await handle.chmod(mode);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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
  verifySignedRequest,
  stableStringify,
  parseDebFields,
  assertUpgradeVersion,
  compareVersions,
  normalizeVersion,
  safeEqualHex,
  appendLog,
  writeRootFileAtomic,
  copyUntrustedPackage
};
