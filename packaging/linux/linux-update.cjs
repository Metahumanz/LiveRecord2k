#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');

const APP_PACKAGE = 'bili-record-2k';
const SERVICE_NAME = 'bili-record-2k.service';
const PUBLIC_KEY_PATH = path.join(__dirname, 'update-public-key.pem');
const SERVICE_READY_TIMEOUT_MS = 60_000;
const SERVICE_READY_POLL_MS = 750;

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
    lockPath: path.join(updateDir, 'apply-request.lock'),
    statusPath: path.join(updateDir, 'last-update-status.json'),
    logPath: path.join(updateDir, 'apply-update.log')
  };
}

async function main(options = {}) {
  const runtimePlatform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  const paths = options.paths || getPaths(options.env || process.env);
  if (runtimePlatform !== 'linux' && !options.allowNonLinux) {
    throw new Error('系统更新辅助程序只能在 Linux 上运行。');
  }
  if (!options.allowNonRoot && typeof getuid === 'function' && getuid() !== 0) {
    throw new Error('系统更新辅助程序必须由 root systemd 单元运行。');
  }
  await fsp.mkdir(paths.updateDir, { recursive: true });
  const lock = await acquireUpdateLock(paths);
  if (!lock) {
    await appendLog(paths, '已有 root 更新事务正在运行，本次触发已忽略。');
    return { status: 'busy' };
  }
  try {
    return await applyPendingRequest(paths, options);
  } finally {
    await releaseUpdateLock(lock);
  }
}

async function applyPendingRequest(paths, options = {}) {
  const claim = await claimRequest(paths);
  if (!claim.claimed) {
    await appendLog(paths, claim.quarantined ? '已隔离异常 processing 请求，没有新的 pending 请求。' : '没有待处理的更新请求。');
    return { status: claim.quarantined ? 'recovered' : 'idle' };
  }
  let request = null;
  let temporaryPackage = '';
  let extractionDir = '';
  let serviceStopped = false;
  let completed = false;
  try {
    request = await readUntrustedJsonFile(paths.processingPath);
    validateRequestShape(request, paths);
    const signedPackage = await verifySignedRequest(request, options);
    request.version = normalizeVersion(request.signed.version);
    request.packageType = signedPackage.kind;
    request.sha256 = signedPackage.sha256;
    request.arch = signedPackage.arch;
    request.requestId = normalizeRequestId(request.requestId) || crypto.randomUUID();
    await writeStatus(paths, request, 'processing', '正在验证官方签名与系统更新包。');
    await appendLog(paths, `开始处理 ${request.version} ${request.packageType} 更新请求。`);

    const installed = await getInstalledPackageState(request.packageType, options);
    if (isInstalledPackageVersion(installed, request.version)) {
      await appendLog(paths, '检测到目标版本已经安装，正在恢复更新完成状态。');
      await runSystemCommand('systemctl', ['daemon-reload'], { allowFailure: true, paths }, options);
      await startAndVerifyMainService(paths, options);
      await writeStatus(paths, request, 'success', `已恢复到 ${request.version}。`);
      completed = true;
      return { status: 'success', version: request.version, recovered: true };
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
    assertUpgradeVersion(request.version, installed.configured ? installed.version : '');

    if (request.packageType === 'deb') {
      await validateDebPackage(temporaryPackage, request.version, options);
    } else if (request.packageType === 'tarball') {
      extractionDir = await validateAndExtractTarball(temporaryPackage, request.version, options);
    } else {
      throw new Error(`不支持的 Linux 更新包类型：${request.packageType}`);
    }

    await appendLog(paths, '更新包结构与版本校验通过，正在停止主服务。');
    await runSystemCommand('systemctl', ['stop', SERVICE_NAME], { paths }, options);
    serviceStopped = true;

    if (request.packageType === 'deb') {
      await runSystemCommand('dpkg', ['-i', temporaryPackage], {
        paths,
        env: { ...process.env, BILI_RECORD_UPDATE_APPLYING: '1' }
      }, options);
    } else {
      await runSystemCommand('sh', [path.join(extractionDir, 'install.sh'), '--upgrade', '--from-updater'], {
        paths,
        cwd: extractionDir,
        env: { ...process.env, BILI_RECORD_UPDATE_APPLYING: '1' }
      }, options);
    }

    await verifyInstalledPackageState(request, options);
    await runSystemCommand('systemctl', ['daemon-reload'], { paths }, options);
    await appendLog(paths, `安装完成，正在启动 ${SERVICE_NAME}。`);
    await startAndVerifyMainService(paths, options);
    serviceStopped = false;
    await writeStatus(paths, request, 'success', `已更新到 ${request.version}，主服务健康检查通过。`);
    await appendLog(paths, `更新到 ${request.version} 成功。`);
    completed = true;
    return { status: 'success', version: request.version };
  } catch (error) {
    await appendLog(paths, `更新失败：${error.stack || error.message || error}`);
    await writeStatus(paths, request || {}, 'error', error.message || String(error));
    if (serviceStopped) {
      await runSystemCommand('systemctl', ['daemon-reload'], { allowFailure: true, paths }, options);
      await runSystemCommand('systemctl', ['start', SERVICE_NAME], { allowFailure: true, paths }, options);
    }
    throw error;
  } finally {
    await archiveProcessingRequest(paths, request, completed ? 'success' : 'error');
    if (temporaryPackage) await fsp.rm(temporaryPackage, { force: true }).catch(() => {});
    if (extractionDir) await fsp.rm(extractionDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimRequest(paths) {
  const processing = await fsp.lstat(paths.processingPath).catch(() => null);
  let quarantined = false;
  if (processing) {
    await quarantineProcessingRequest(paths, processing);
    quarantined = true;
  }
  try {
    await fsp.rename(paths.requestPath, paths.processingPath);
    return { claimed: true, quarantined };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { claimed: false, quarantined };
    }
    throw error;
  }
}

async function acquireUpdateLock(paths) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await fsp.open(paths.lockPath, flags, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        'utf8'
      );
      await handle.sync();
      return { handle, path: paths.lockPath };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST' || attempt > 0 || !(await retireStaleUpdateLock(paths))) {
        return null;
      }
    }
  }
  return null;
}

async function releaseUpdateLock(lock) {
  if (!lock) return;
  await lock.handle?.close().catch(() => {});
  await fsp.unlink(lock.path).catch(() => {});
}

async function retireStaleUpdateLock(paths) {
  let payload = null;
  let stat = null;
  try {
    stat = await fsp.lstat(paths.lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    payload = await readUntrustedJsonFile(paths.lockPath);
  } catch {
    return false;
  }
  const pid = Number(payload?.pid || 0);
  if (pid > 1 && isProcessRunning(pid)) return false;
  const ageMs = Date.now() - Number(stat.mtimeMs || 0);
  if (pid > 1 && ageMs < SERVICE_READY_TIMEOUT_MS) return false;
  const archivePath = `${paths.lockPath}.stale.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fsp.rename(paths.lockPath, archivePath);
    await appendLog(paths, `已隔离无主更新锁：${path.basename(archivePath)}`);
    return true;
  } catch {
    return false;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function quarantineProcessingRequest(paths, stat) {
  const reason = stat.isSymbolicLink() || !stat.isFile()
    ? '检测到不安全的 processing 更新请求，已隔离。'
    : '检测到上次异常中断的 processing 更新请求，已隔离，不会自动重复安装。';
  let request = {};
  if (stat.isFile() && !stat.isSymbolicLink()) {
    request = await readUntrustedJsonFile(paths.processingPath).catch(() => ({}));
  }
  await appendLog(paths, reason);
  await writeStatus(paths, request, 'error', reason);
  await archiveProcessingRequest(paths, request, 'error');
}

async function archiveProcessingRequest(paths, request, outcome) {
  const requestId = normalizeRequestId(request?.requestId) || `legacy-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const archivePath = path.join(
    paths.updateDir,
    `apply-request.${outcome}.${requestId}.${crypto.randomBytes(4).toString('hex')}.json`
  );
  try {
    await fsp.rename(paths.processingPath, archivePath);
    return archivePath;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(requestId) ? requestId : '';
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
  if (request.requestId && !normalizeRequestId(request.requestId)) {
    throw new Error('更新请求 ID 无效。');
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

async function validateDebPackage(packagePath, expectedVersion, options = {}) {
  const result = await runSystemCommand('dpkg-deb', ['-f', packagePath, 'Package', 'Version', 'Architecture'], {}, options);
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

async function getInstalledPackageState(packageType, options = {}) {
  if (packageType === 'deb') {
    return queryDebPackageState(options);
  }
  const version = readInstalledVersion(options);
  return {
    packageType: 'tarball',
    status: version ? 'installed' : 'not-installed',
    version,
    configured: Boolean(version)
  };
}

async function queryDebPackageState(options = {}) {
  const result = await runSystemCommand(
    'dpkg-query',
    ['-W', '-f=${Status}\n${Version}\n', APP_PACKAGE],
    { allowFailure: true, paths: options.paths },
    options
  );
  if (result.code !== 0) {
    return { packageType: 'deb', status: 'not-installed', version: '', configured: false };
  }
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const status = lines[0] || 'unknown';
  const version = normalizeVersion(lines[1] || '');
  return {
    packageType: 'deb',
    status,
    version,
    configured: status === 'install ok installed' && Boolean(version)
  };
}

function isInstalledPackageVersion(installed, expectedVersion) {
  return Boolean(installed?.configured) && normalizeVersion(installed.version) === normalizeVersion(expectedVersion);
}

async function verifyInstalledPackageState(request, options = {}) {
  const installed = await getInstalledPackageState(request.packageType, options);
  if (request.packageType === 'deb' && !installed.configured) {
    throw new Error(
      `Deb 安装未完成：dpkg status 为 ${installed.status || '未知'}，期望 install ok installed。`
    );
  }
  if (!isInstalledPackageVersion(installed, request.version)) {
    throw new Error(
      `安装后的版本校验失败：期望 ${request.version}，实际 ${installed.version || '未安装'}。`
    );
  }
  return installed;
}

async function startAndVerifyMainService(paths, options = {}) {
  await runSystemCommand('systemctl', ['start', SERVICE_NAME], { paths }, options);
  return waitForMainServiceHealthy(paths, options);
}

async function waitForMainServiceHealthy(paths, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.serviceReadyTimeoutMs || SERVICE_READY_TIMEOUT_MS));
  const pollMs = Math.max(25, Number(options.serviceReadyPollMs || SERVICE_READY_POLL_MS));
  const startedAt = Date.now();
  let lastReason = 'systemd 尚未报告服务已启动。';
  while (Date.now() - startedAt <= timeoutMs) {
    const active = await runSystemCommand(
      'systemctl',
      ['is-active', '--quiet', SERVICE_NAME],
      { allowFailure: true, paths },
      options
    );
    if (active.code === 0) {
      const pidResult = await runSystemCommand(
        'systemctl',
        ['show', SERVICE_NAME, '--property=MainPID', '--value'],
        { allowFailure: true, paths },
        options
      );
      const mainPid = Number(String(pidResult.stdout || '').trim());
      if (pidResult.code === 0 && Number.isInteger(mainPid) && mainPid > 1) {
        const health = await probeMainService(paths, options);
        if (health.ok) {
          await appendLog(paths, `主服务健康检查通过（PID ${mainPid}）。`);
          return { mainPid, health };
        }
        lastReason = health.message || '主服务 HTTP 健康检查尚未通过。';
      } else {
        lastReason = 'systemd 未返回有效的 MainPID。';
      }
    } else {
      lastReason = String(active.stderr || active.stdout || 'systemd 尚未激活主服务。').trim();
    }
    await (options.delay || sleep)(pollMs);
  }
  throw new Error(`主服务启动后未通过健康检查：${lastReason}`);
}

async function probeMainService(paths, options = {}) {
  if (typeof options.probeService === 'function') {
    const result = await options.probeService();
    if (result === true) return { ok: true, message: '' };
    if (result && typeof result === 'object') return { ok: result.ok === true, message: String(result.message || '') };
    return { ok: false, message: '测试健康检查未返回成功。' };
  }
  const target = await getServiceHealthTarget(paths, options);
  return probeHttpService(target, Math.min(4000, Number(options.serviceProbeTimeoutMs || 2500)));
}

async function getServiceHealthTarget(paths = {}, options = {}) {
  const environmentPath = options.environmentPath || '/etc/bili-record-2k/environment';
  const values = await fsp
    .readFile(environmentPath, 'utf8')
    .then(parseEnvironmentFile)
    .catch(() => ({}));
  const settingsPath = options.settingsPath || path.join(paths.configRoot || '/var/lib/bili-record-2k', 'BiliRecord2K', 'settings.json');
  const persistedSettings = await readUntrustedJsonFile(settingsPath)
    .then((payload) => (payload?.settings && typeof payload.settings === 'object' ? payload.settings : {}))
    .catch(() => ({}));
  const configuredHost = String(persistedSettings.serverHost || values.BILI_RECORD_HOST || '127.0.0.1').trim().toLowerCase();
  const host = configuredHost === '::' || configuredHost === '::1' ? '::1' : '127.0.0.1';
  const persistedPort = normalizeServicePort(persistedSettings.serverPort);
  const environmentPort = normalizeServicePort(values.BILI_RECORD_PORT);
  return { host, port: persistedPort || environmentPort || 3263 };
}

function normalizeServicePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function parseEnvironmentFile(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

function probeHttpService(target, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: target.host, port: target.port, path: '/api/state', method: 'GET', timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve({
          ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 400,
          message: `HTTP ${response.statusCode || 0}`
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('HTTP 健康检查超时。')));
    request.on('error', (error) => resolve({ ok: false, message: error.message || String(error) }));
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function validateAndExtractTarball(packagePath, expectedVersion, options = {}) {
  const listing = await runSystemCommand('tar', ['-tzf', packagePath], {}, options);
  const entries = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!entries.length) throw new Error('Linux 更新包为空。');
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '');
    if (!normalized) continue;
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Linux 更新包包含不安全路径：${entry}`);
    }
  }
  const verbose = await runSystemCommand('tar', ['-tvzf', packagePath], {}, options);
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error('Linux 更新包包含链接或特殊文件，已拒绝安装。');
  }
  const extractionDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-record-2k-extract-'));
  await runSystemCommand('tar', ['-xzf', packagePath, '--no-same-owner', '-C', extractionDir], {}, options);
  const meta = JSON.parse(await fsp.readFile(path.join(extractionDir, 'package-meta.json'), 'utf8'));
  if (meta.name !== APP_PACKAGE || meta.packageType !== 'tarball') throw new Error('Linux 更新包元数据无效。');
  if (normalizeVersion(meta.version) !== normalizeVersion(expectedVersion)) throw new Error('Linux 更新包版本不匹配。');
  if (meta.arch !== process.arch) throw new Error(`Linux 更新包架构不匹配：当前 ${process.arch}，包为 ${meta.arch || '空'}`);
  const installStat = await fsp.stat(path.join(extractionDir, 'install.sh'));
  if (!installStat.isFile()) throw new Error('Linux 更新包缺少 install.sh。');
  return extractionDir;
}

function readInstalledVersion(options = {}) {
  try {
    const appRoot = path.resolve(options.appRoot || '/usr/lib/bili-record-2k');
    const payload = JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8'));
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
    requestId: normalizeRequestId(request.requestId),
    version: normalizeVersion(request.version || ''),
    packageType: String(request.packageType || ''),
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

async function runSystemCommand(command, args, commandOptions = {}, runtimeOptions = {}) {
  const runner = runtimeOptions.runCommand || runCommand;
  const result = await runner(command, args, commandOptions);
  return {
    code: Number.isFinite(Number(result?.code)) ? Number(result.code) : 0,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || '')
  };
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
  main,
  getPaths,
  claimRequest,
  validateRequestShape,
  verifySignedRequest,
  stableStringify,
  parseDebFields,
  queryDebPackageState,
  getInstalledPackageState,
  verifyInstalledPackageState,
  isInstalledPackageVersion,
  startAndVerifyMainService,
  waitForMainServiceHealthy,
  getServiceHealthTarget,
  assertUpgradeVersion,
  compareVersions,
  normalizeVersion,
  normalizeRequestId,
  safeEqualHex,
  appendLog,
  writeRootFileAtomic,
  copyUntrustedPackage,
  archiveProcessingRequest
};
