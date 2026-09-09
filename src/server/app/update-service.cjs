'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createUpdateDownloadSources,
  isDefaultUpdateSource,
  normalizeUpdateManifest,
  normalizeVersion,
  updatePackageLabel,
  updatePackageFileName,
  packageFileNameFromUrl,
  compareVersions,
  downloadFile,
  fileSha256,
  readTextSource,
  withTimeout,
  clamp,
  formatBytes,
  isPathInsideDirectory,
  getAppRoot,
  getAppVersion,
  getAppPackageType
} = require('../shared/helpers.cjs');

const APP_ROOT = getAppRoot();
const APP_VERSION = getAppVersion();
const APP_PACKAGE_TYPE = getAppPackageType({ platform: process.platform, appRoot: APP_ROOT });
const DEFAULT_UPDATE_MANIFEST_URL =
  process.env.BILI_RECORD_UPDATE_URL ||
  'https://github.com/Metahumanz/LiveRecord2k/releases/latest/download/update.json';
const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/Metahumanz/LiveRecord2k/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 12000;
const AUTO_UPDATE_INITIAL_DELAY_MS = 60 * 1000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

class UpdateService {
  constructor(owner) {
    this.owner = owner;
  }
}

function getPublicUpdateState() {
  return {
    ...this.updateState,
    currentVersion: APP_VERSION,
    activeJobs: this.hasActiveJobs(),
    autoApplySupported: this.supportsManagedLinuxUpdate(),
    msixManaged: this.usesMsixAppInstallerUpdate()
  };
}

function usesMsixAppInstallerUpdate() {
  return process.platform === 'win32' && APP_PACKAGE_TYPE === 'msix';
}

function createMsixUpdateMessage(version = this.updateState.latestVersion) {
  const versionLabel = String(version || '').trim();
  return versionLabel
    ? `发现新版本 ${versionLabel}。此 MSIX 安装由 Windows App Installer 在后台或后续启动时静默更新。`
    : '此 MSIX 安装由 Windows App Installer 在后台或后续启动时静默更新。';
}

async function deferMsixUpdateToAppInstaller() {
  if (!this.updateState.manifest || compareVersions(this.updateState.latestVersion, APP_VERSION) <= 0) {
    await this.checkUpdate();
  }
  if (this.updateState.manifest && compareVersions(this.updateState.latestVersion, APP_VERSION) > 0) {
    this.updateState = {
      ...this.updateState,
      status: 'available',
      queued: false,
      downloadProgress: null,
      message: this.createMsixUpdateMessage()
    };
    this.log('info', this.updateState.message);
    this.markSystemDirty();
  }
  return this.getState();
}

async function checkUpdate() {
  this.updateState = {
    ...this.updateState,
    status: 'checking',
    currentVersion: APP_VERSION,
    message: '正在检查更新...',
    checkedAt: Date.now(),
    downloadReceivedBytes: 0,
    downloadTotalBytes: 0,
    downloadProgress: null,
    updateLogPath: this.getUpdateLogPath(),
    statusPath: this.getUpdateStatusPath()
  };
  this.markSystemDirty();
  let acceptingStatus = true;
  try {
    const manifest = await withTimeout(this.fetchUpdateManifest((message) => {
      if (!acceptingStatus) {
        return;
      }
      this.updateState = {
        ...this.updateState,
        status: 'checking',
        message,
        checkedAt: Date.now()
      };
      this.markSystemDirty();
    }), 45000, '检查更新超时：45 秒内没有收到更新源响应。');
    acceptingStatus = false;
    const latestVersion = manifest.version || manifest.tagName || '';
    const hasUpdate = compareVersions(latestVersion, APP_VERSION) > 0;
    const updateMessage = hasUpdate
      ? this.usesMsixAppInstallerUpdate()
        ? this.createMsixUpdateMessage(latestVersion)
        : `发现新版本 ${latestVersion}`
      : `当前已是最新版本 ${APP_VERSION}`;
    this.updateState = {
      ...this.updateState,
      status: hasUpdate ? 'available' : 'up-to-date',
      currentVersion: APP_VERSION,
      latestVersion,
      message: updateMessage,
      checkedAt: Date.now(),
      downloadReceivedBytes: 0,
      downloadTotalBytes: 0,
      downloadProgress: null,
      manifest
    };
    this.log(hasUpdate ? 'success' : 'info', this.updateState.message);
    this.markSystemDirty();
    return this.getState();
  } catch (error) {
    acceptingStatus = false;
    this.updateState = {
      ...this.updateState,
      status: 'error',
      message: `检查更新失败：${error.message}`,
      checkedAt: Date.now(),
      downloadReceivedBytes: 0,
      downloadTotalBytes: 0,
      downloadProgress: null,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath()
    };
    this.log('error', this.updateState.message);
    this.markSystemDirty();
    return this.getState();
  }
}

async function queueUpdateAfterJobs() {
  if (!this.updateState.manifest || this.updateState.status === 'idle' || this.updateState.status === 'up-to-date') {
    await this.checkUpdate();
  }
  if (!this.updateState.manifest || compareVersions(this.updateState.latestVersion, APP_VERSION) <= 0) {
    return this.getState();
  }
  if (this.usesMsixAppInstallerUpdate()) {
    return this.deferMsixUpdateToAppInstaller();
  }
  if (!this.hasActiveJobs()) {
    return this.applyUpdate();
  }
  this.updateState = {
    ...this.updateState,
    status: 'queued',
    queued: true,
    message: this.supportsManagedLinuxUpdate()
      ? `已排队更新到 ${this.updateState.latestVersion}，全部媒体任务结束后将自动校验、安装并重启服务。`
      : `已排队更新到 ${this.updateState.latestVersion}，全部媒体任务结束后自动下载更新包。`
  };
  this.log('info', this.updateState.message);
  this.markSystemDirty();
  return this.getState();
}

async function downloadUpdateOnly() {
  if (this.updateState.queued || this.updateState.status === 'queued') {
    return this.getState();
  }
  if (!this.updateState.manifest || this.updateState.status === 'idle' || this.updateState.status === 'up-to-date') {
    await this.checkUpdate();
  }
  const manifest = this.updateState.manifest;
  if (!manifest || compareVersions(manifest.version, APP_VERSION) <= 0) {
    return this.getState();
  }
  if (this.usesMsixAppInstallerUpdate()) {
    return this.deferMsixUpdateToAppInstaller();
  }

  try {
    const usablePackagePath = await this.getUsableDownloadedPackage(manifest);
    this.updateState = {
      ...this.updateState,
      status: usablePackagePath ? 'available' : 'downloading',
      queued: false,
      message: usablePackagePath
        ? this.createManualUpdateMessage(manifest, usablePackagePath)
        : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}...`,
      downloadReceivedBytes: usablePackagePath ? this.updateState.downloadReceivedBytes : 0,
      downloadTotalBytes: usablePackagePath ? this.updateState.downloadTotalBytes : 0,
      downloadProgress: usablePackagePath ? 100 : 0,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath(),
      packagePath: usablePackagePath || ''
    };
    this.markSystemDirty();

    const packagePath = usablePackagePath || (await this.downloadUpdatePackage(manifest));
    this.updateState = {
      ...this.updateState,
      status: 'available',
      queued: false,
      message: this.createManualUpdateMessage(manifest, packagePath),
      downloadProgress: 100,
      packagePath
    };
    this.log('success', this.updateState.message);
    this.markSystemDirty();
  } catch (error) {
    this.updateState = {
      ...this.updateState,
      status: 'error',
      queued: false,
      message: `手动下载更新失败：${error.message}`,
      downloadProgress: null,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath()
    };
    this.log('error', this.updateState.message);
    this.markSystemDirty();
  }
  return this.getState();
}

async function applyUpdate() {
  if (this.updateApplyPromise) {
    return this.updateApplyPromise;
  }
  const operation = this.applyUpdateInternal();
  this.updateApplyPromise = operation;
  try {
    return await operation;
  } finally {
    if (this.updateApplyPromise === operation) {
      this.updateApplyPromise = null;
    }
  }
}

async function applyUpdateInternal() {
  if (this.usesMsixAppInstallerUpdate()) {
    return this.deferMsixUpdateToAppInstaller();
  }
  if (this.hasActiveJobs()) {
    this.updateState = {
      ...this.updateState,
      status: 'blocked',
      queued: false,
      message: '当前仍有录制或媒体处理任务，暂不安装更新；可以排队等待任务结束。'
    };
    this.markSystemDirty();
    return this.getState();
  }

  if (!this.updateState.manifest || compareVersions(this.updateState.latestVersion, APP_VERSION) <= 0) {
    await this.checkUpdate();
  }
  const manifest = this.updateState.manifest;
  if (!manifest || compareVersions(manifest.version, APP_VERSION) <= 0) {
    return this.getState();
  }

  try {
    const usablePackagePath = await this.getUsableDownloadedPackage(manifest);
    this.updateState = {
      ...this.updateState,
      status: 'downloading',
      queued: false,
      message: usablePackagePath
        ? `正在准备已下载的 ${manifest.version} ${updatePackageLabel(manifest)}...`
        : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}...`,
      downloadReceivedBytes: usablePackagePath ? this.updateState.downloadReceivedBytes : 0,
      downloadTotalBytes: usablePackagePath ? this.updateState.downloadTotalBytes : 0,
      downloadProgress: usablePackagePath ? 100 : 0,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath(),
      packagePath: usablePackagePath || ''
    };
    this.markSystemDirty();

    const packagePath = usablePackagePath || (await this.downloadUpdatePackage(manifest));
    if (process.platform === 'linux' && this.supportsManagedLinuxUpdate()) {
      const managedRequest = await this.requestManagedLinuxUpdate(manifest, packagePath);
      this.updateState = {
        ...this.updateState,
        status: 'applying',
        queued: false,
        message: managedRequest.existing
          ? `已有 ${managedRequest.version || manifest.version} root 更新请求正在处理中，未覆盖原请求。`
          : `已验证 ${manifest.version} 更新包，systemd 更新服务将自动安装并重启后台服务。`,
        downloadProgress: 100,
        packagePath
      };
      this.log('success', this.updateState.message);
      this.markSystemDirty();
      return this.getState();
    }
    this.updateState = {
      ...this.updateState,
      status: 'available',
      queued: false,
      message: this.createManualUpdateMessage(manifest, packagePath),
      downloadProgress: 100,
      packagePath
    };
    this.log('success', this.updateState.message);
    this.markSystemDirty();
  } catch (error) {
    this.updateState = {
      ...this.updateState,
      status: 'error',
      queued: false,
      message: `更新失败：${error.message}`,
      downloadProgress: null,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath()
    };
    this.log('error', this.updateState.message);
    this.markSystemDirty();
  }
  return this.getState();
}

function createManualUpdateMessage(manifest, packagePath) {
  const label = updatePackageLabel(manifest);
  const action = label === '安装器' ? '手动运行安装器' : '手动更新';
  return `${label}已下载。安装会中断监听和录制，请确认空闲后打开下载目录${action}：${packagePath}`;
}

async function getUsableDownloadedPackage(manifest) {
  const packagePath = String(this.updateState.packagePath || '').trim();
  if (!packagePath) {
    return '';
  }
  const stat = await fsp.stat(packagePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    return '';
  }
  if (manifest.sha256) {
    const actual = await fileSha256(packagePath).catch(() => '');
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      await fsp.rm(packagePath, { force: true }).catch(() => {});
      this.log('warn', `已下载更新包校验失败，重新下载：${packagePath}`);
      return '';
    }
  }
  return packagePath;
}

async function fetchUpdateManifest(onStatus) {
  const source = this.settings.updateManifestUrl || DEFAULT_UPDATE_MANIFEST_URL;
  const isOfficial = isDefaultUpdateSource(source, DEFAULT_UPDATE_MANIFEST_URL);
  const manifestAttempts = createUpdateDownloadSources(source, { officialSource: isOfficial });
  let raw = '';
  let lastError = null;
  for (let index = 0; index < manifestAttempts.length; index += 1) {
    const attempt = manifestAttempts[index];
    try {
      raw = await readTextSource(attempt.url, {
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        retries: 3,
        onRetry: ({ attempt: retryAttempt, maxAttempts, error }) => {
          onStatus?.(
            `${attempt.label}连接中断，正在重试 ${retryAttempt}/${Math.max(1, Number(maxAttempts || 1) - 1)}：${
              error.message || error
            }`
          );
        }
      });
      break;
    } catch (error) {
      lastError = error;
      if (index + 1 < manifestAttempts.length) {
        onStatus?.(`${attempt.label}连接失败，改用${manifestAttempts[index + 1].label}...`);
      }
    }
  }
  if (!raw) {
    if (!isOfficial) {
      throw lastError || new Error('更新清单获取失败。');
    }
    onStatus?.('默认更新清单连接失败，正在改用 GitHub Release API...');
    this.log('warn', `默认更新清单失败，改用 GitHub Release API：${lastError?.message || ''}`);
    raw = await readTextSource(GITHUB_LATEST_RELEASE_API, {
      timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
      retries: 3,
      onRetry: ({ attempt, maxAttempts, error: retryError }) => {
        onStatus?.(
          `GitHub Release API 连接中断，正在重试 ${attempt}/${Math.max(1, Number(maxAttempts || 1) - 1)}：${
            retryError.message || retryError
          }`
        );
      }
    });
  }
  let payload = JSON.parse(raw);
  // GitHub Release API 没有本项目的 Ed25519 签名；资产中通常带有 update.json，
  // 优先下载官方签名清单，恢复 Linux 受控自动安装，同时确保按真实架构选择安装包。
  if (Array.isArray(payload.assets) && !Array.isArray(payload.files)) {
    const updateAsset = (payload.assets || []).find((asset) => {
      const name = String(asset?.name || packageFileNameFromUrl(asset?.browser_download_url || asset?.url || ''));
      return /^update\.json$/i.test(name) || /\/update\.json$/i.test(name);
    });
    const updateAssetUrl = String(updateAsset?.browser_download_url || updateAsset?.url || '');
    if (updateAssetUrl) {
      const signedAttempts = createUpdateDownloadSources(updateAssetUrl, { officialSource: true });
      for (let signedIndex = 0; signedIndex < signedAttempts.length; signedIndex += 1) {
        const attempt = signedAttempts[signedIndex];
        try {
          const signedRaw = await readTextSource(attempt.url, {
            timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
            retries: 2,
            onRetry: ({ attempt: retryAttempt, maxAttempts, error: retryError }) => {
              onStatus?.(
                `${attempt.label}更新清单连接中断，正在重试 ${retryAttempt}/${Math.max(1, Number(maxAttempts || 1) - 1)}：${
                  retryError.message || retryError
                }`
              );
            }
          });
          const signedPayload = JSON.parse(signedRaw);
          if (Array.isArray(signedPayload.files) && signedPayload.signed) {
            payload = signedPayload;
            break;
          }
          throw new Error('更新清单资产缺少 files/signed。');
        } catch (error) {
          lastError = error;
          if (signedIndex + 1 < signedAttempts.length) {
            this.log('warn', `${attempt.label}更新清单获取失败，改用${signedAttempts[signedIndex + 1].label}：${error.message}`);
          }
        }
      }
    }
  }
  const manifest = normalizeUpdateManifest(payload);
  manifest.officialSource = isOfficial;
  if (!manifest.version || !manifest.packageUrl) {
    throw new Error('更新源缺少 version 或 packageUrl。');
  }
  return manifest;
}

async function downloadUpdatePackage(manifest) {
  const updateDir = this.getUpdateDir();
  await fsp.mkdir(updateDir, { recursive: true });
  const packagePath = path.join(updateDir, updatePackageFileName(manifest));
  this.updateState = {
    ...this.updateState,
    packagePath
  };
  this.markSystemDirty();
  let lastEmitAt = 0;
  await downloadFile(manifest.packageUrl, packagePath, (progress) => {
    if (progress.retrying) {
      this.updateState = {
        ...this.updateState,
        status: 'downloading',
        message: progress.switchingSource
          ? `GitHub 官方源下载过慢或失败，正在切换${progress.sourceLabel || '镜像源'}...`
          : `下载连接中断，正在重试 ${progress.attempt}/${Math.max(1, Number(progress.maxAttempts || 1) - 1)}：${
              progress.error?.message || progress.error || '网络错误'
            }`
      };
      this.markSystemDirty();
      return;
    }
    const receivedBytes = Number(progress.receivedBytes || 0);
    const totalBytes = Number(progress.totalBytes || 0);
    const percent = totalBytes > 0 ? clamp(Math.round((receivedBytes / totalBytes) * 100), 0, 100) : null;
    const now = Date.now();
    this.updateState = {
      ...this.updateState,
      status: 'downloading',
      message:
        percent === null
          ? `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}：已下载 ${formatBytes(receivedBytes)}`
          : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}：${percent}%（${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}）`,
      downloadReceivedBytes: receivedBytes,
      downloadTotalBytes: totalBytes,
      downloadProgress: percent
    };
    if (progress.done || now - lastEmitAt > 300) {
      lastEmitAt = now;
      this.markSystemDirty();
    }
  }, { officialSource: manifest.officialSource === true });
  this.updateState = {
    ...this.updateState,
    message: manifest.sha256 ? `${updatePackageLabel(manifest)}下载完成，正在校验...` : `${updatePackageLabel(manifest)}下载完成。`,
    downloadProgress: 100
  };
  this.markSystemDirty();
  if (manifest.sha256) {
    const actual = await fileSha256(packagePath);
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      await fsp.rm(packagePath, { force: true });
      throw new Error('更新包 SHA256 校验失败，已放弃更新。');
    }
  }
  return packagePath;
}

async function loadLastUpdateStatus() {
  const statusPath = this.getUpdateStatusPath();
  let loadedStatus = '';
  try {
    const status = JSON.parse(await fsp.readFile(statusPath, 'utf8'));
    const updateStatus = String(status.status || '');
    loadedStatus = updateStatus;
    const version = normalizeVersion(status.version || '');
    const message = String(status.message || '');
    if (updateStatus === 'error' || updateStatus === 'applying') {
      this.updateState = {
        ...this.updateState,
        status: 'error',
        latestVersion: version,
        message:
          updateStatus === 'applying'
            ? `上次旧版更新停在应用阶段，可能被文件占用或安全软件拦截。${status.logPath ? `日志：${status.logPath}` : ''}`
            : `上次更新失败：${message || '未知错误'}${status.logPath ? `，日志：${status.logPath}` : ''}`,
        checkedAt: Date.now(),
        statusPath,
        updateLogPath: status.logPath || this.getUpdateLogPath()
      };
      this.log('error', this.updateState.message);
    } else if (updateStatus === 'pending' || updateStatus === 'processing') {
      this.updateState = {
        ...this.updateState,
        status: updateStatus === 'pending' ? 'queued' : 'applying',
        queued: updateStatus === 'pending',
        latestVersion: version,
        message:
          updateStatus === 'pending'
            ? `官方签名更新 ${version || ''} 已交给 root 更新服务，等待处理。`
            : `root 更新服务正在处理 ${version || '目标版本'}；异常 processing 请求会被隔离，不会循环重复安装。`,
        checkedAt: Date.now(),
        statusPath,
        updateLogPath: status.logPath || this.getUpdateLogPath()
      };
      this.log('info', this.updateState.message);
    } else if (updateStatus === 'success') {
      if (version && compareVersions(version, APP_VERSION) > 0) {
        this.updateState = {
          ...this.updateState,
          status: 'error',
          latestVersion: version,
          message: `旧版更新流程完成到 ${version}，但当前仍是 ${APP_VERSION}。可能是旧进程没有退出，或更新包被复制到了错误目录。${
            status.logPath ? `日志：${status.logPath}` : ''
          }`,
          checkedAt: Date.now(),
          statusPath,
          updateLogPath: status.logPath || this.getUpdateLogPath()
        };
        this.log('error', this.updateState.message);
        return;
      }
      this.log('success', version ? `已更新到 ${version}。` : '更新已完成。');
      await this.cleanupUpdateDownloads(status.packagePath);
      await fsp.rm(statusPath, { force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      this.log('warn', `读取更新状态失败：${error.message}`);
    }
  }
  if (process.platform === 'linux' && process.env.BILI_RECORD_MANAGED_UPDATE === '1') {
    const activeRequest = await findManagedUpdateRequest(this.getUpdateDir()).catch(() => null);
    if (activeRequest?.phase === 'pending') {
      this.updateState = {
        ...this.updateState,
        status: 'queued',
        queued: true,
        latestVersion: activeRequest.version || this.updateState.latestVersion,
        message: `官方签名更新 ${activeRequest.version || ''} 已写入 root 更新队列，等待 systemd 处理。`,
        checkedAt: Date.now(),
        statusPath,
        updateLogPath: this.getUpdateLogPath()
      };
      this.log('info', this.updateState.message);
    } else if (activeRequest?.phase === 'processing' && isStaleManagedUpdateRequest(activeRequest)) {
      this.updateState = {
        ...this.updateState,
        status: 'error',
        queued: false,
        latestVersion: activeRequest.version || this.updateState.latestVersion,
        message: '发现超时的 processing 更新请求；它不会被 .path 反复触发，下一次受控更新会先隔离该请求。',
        checkedAt: Date.now(),
        statusPath,
        updateLogPath: this.getUpdateLogPath()
      };
      this.log('warn', this.updateState.message);
    } else if (loadedStatus === 'processing' && activeRequest?.phase !== 'processing') {
      this.log('warn', '更新状态仍为 processing，但活动请求文件已不存在；保留状态供管理员检查更新日志。');
    }
  }
}

function getUpdateStatusPath() {
  return path.join(this.getUpdateDir(), 'last-update-status.json');
}

function getUpdateLogPath() {
  return path.join(this.getUpdateDir(), 'apply-update.log');
}

function getUpdateDir() {
  if (process.platform === 'linux' && process.env.BILI_RECORD_MANAGED_UPDATE === '1') {
    return path.resolve(process.env.BILI_RECORD_UPDATE_DIR || '/var/lib/bili-record-2k-updates');
  }
  return path.join(path.dirname(this.storePath), 'updates');
}

async function cleanupUpdateDownloads(packagePath, attempt = 1) {
  const updateDir = this.getUpdateDir();
  const targets = new Set();
  const normalizedPackagePath = String(packagePath || '').trim();
  if (normalizedPackagePath && isPathInsideDirectory(normalizedPackagePath, updateDir)) {
    targets.add(path.resolve(normalizedPackagePath));
  }
  const entries = await fsp.readdir(updateDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (
      name.endsWith('.tmp') ||
      (/^bili-record-2k[-_]/.test(name) && /\.(?:exe|zip|deb|tar\.gz|tgz)$/i.test(name))
    ) {
      targets.add(path.join(updateDir, entry.name));
    }
  }
  const failed = [];
  for (const target of targets) {
    try {
      await fsp.rm(target, { force: true });
    } catch (error) {
      failed.push(target);
      if (attempt === 1) {
        this.log('warn', `更新安装包暂时无法删除，稍后重试：${target}（${error.message}）`);
      }
    }
  }
  if (failed.length > 0 && attempt < 4) {
    setTimeout(() => {
      this.cleanupUpdateDownloads(packagePath, attempt + 1).catch((error) => {
        this.log('warn', `清理更新安装包失败：${error.message}`);
      });
    }, attempt * 2500).unref?.();
    return;
  }
  if (targets.size > 0 && failed.length === 0) {
    this.log('info', '已清理更新安装包。');
  }
}

function scheduleQueuedUpdateCheck(delayMs = 1500) {
  if (!this.updateState.queued) {
    return;
  }
  clearTimeout(this.queuedUpdateTimer);
  this.queuedUpdateTimer = setTimeout(() => {
    if (!this.updateState.queued || this.hasActiveJobs()) {
      return;
    }
    this.applyUpdate().catch((error) => {
      this.updateState = {
        ...this.updateState,
        status: 'error',
        queued: false,
        message: `自动下载更新失败：${error.message}`
      };
      this.log('error', this.updateState.message);
      this.markSystemDirty();
    });
  }, delayMs);
  this.queuedUpdateTimer.unref?.();
}

function supportsManagedLinuxUpdate(manifest = this.updateState.manifest) {
  return (
    process.platform === 'linux' &&
    process.env.BILI_RECORD_MANAGED_UPDATE === '1' &&
    Boolean(manifest?.officialSource) &&
    manifest?.signatureAlgorithm === 'ed25519' &&
    Boolean(manifest?.signed && manifest?.signature)
  );
}


async function requestManagedLinuxUpdate(manifest, packagePath) {
  if (this.managedLinuxUpdateRequestPromise) {
    return this.managedLinuxUpdateRequestPromise;
  }
  const operation = this.requestManagedLinuxUpdateInternal(manifest, packagePath);
  this.managedLinuxUpdateRequestPromise = operation;
  try {
    return await operation;
  } finally {
    if (this.managedLinuxUpdateRequestPromise === operation) {
      this.managedLinuxUpdateRequestPromise = null;
    }
  }
}

async function requestManagedLinuxUpdateInternal(manifest, packagePath) {
  if (!this.supportsManagedLinuxUpdate(manifest)) {
    throw new Error('Linux root 自动安装只接受官方 Ed25519 签名更新清单；自定义或未签名更新源只能手动安装。');
  }
  const resolvedPackagePath = path.resolve(packagePath);
  if (!isPathInsideDirectory(resolvedPackagePath, this.getUpdateDir())) {
    throw new Error('更新包不在受控下载目录中，拒绝交给系统更新服务。');
  }
  const requestPath = path.join(this.getUpdateDir(), 'apply-request.json');
  const updateDir = this.getUpdateDir();
  const requestId = crypto.randomUUID();
  const request = {
    schemaVersion: 2,
    app: 'bili-record-2k',
    requestId,
    version: normalizeVersion(manifest.version),
    packageType: manifest.packageType,
    packagePath: resolvedPackagePath,
    signed: manifest.signed,
    signatureAlgorithm: manifest.signatureAlgorithm,
    signature: manifest.signature,
    requestedAt: new Date().toISOString()
  };
  await fsp.mkdir(updateDir, { recursive: true });
  const existing = await findManagedUpdateRequest(updateDir);
  if (existing && !(existing.phase === 'processing' && isStaleManagedUpdateRequest(existing))) {
    if (isSameManagedUpdateRequest(existing, request)) {
      return { ...existing, existing: true, requestId: existing.requestId || '' };
    }
    throw new Error(
      `已有 ${existing.phase === 'processing' ? '正在处理' : '等待处理'} 的系统更新请求${
        existing.version ? `（${existing.version}）` : ''
      }，不会覆盖。`
    );
  }
  const published = await publishJsonWithoutOverwrite(requestPath, request, 0o600);
  if (!published) {
    const winner = await findManagedUpdateRequest(updateDir);
    if (winner && isSameManagedUpdateRequest(winner, request)) {
      return { ...winner, existing: true, requestId: winner.requestId || '' };
    }
    throw new Error('另一个更新请求已先写入受控队列，当前请求未覆盖它。');
  }
  return { phase: 'pending', requestId, version: request.version, packagePath: resolvedPackagePath, existing: false };
}

function scheduleAutomaticUpdateCheck(delayMs = AUTO_UPDATE_INTERVAL_MS) {
  clearTimeout(this.autoUpdateTimer);
  this.autoUpdateTimer = null;
  if (!this.settings.autoUpdateEnabled || process.platform !== 'linux' || delayMs <= 0) {
    return;
  }
  this.autoUpdateTimer = setTimeout(async () => {
    try {
      await this.checkUpdate();
      if (this.updateState.manifest && compareVersions(this.updateState.latestVersion, APP_VERSION) > 0) {
        await this.queueUpdateAfterJobs();
      }
    } catch (error) {
      this.log('warn', `自动检查更新失败：${error.message}`);
    } finally {
      this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_INTERVAL_MS);
    }
  }, delayMs);
  this.autoUpdateTimer.unref?.();
}


const MANAGED_UPDATE_PROCESSING_STALE_MS = 17 * 60 * 1000;

async function findManagedUpdateRequest(updateDir) {
  for (const [phase, fileName] of [
    ['pending', 'apply-request.json'],
    ['processing', 'apply-request.processing.json']
  ]) {
    const filePath = path.join(updateDir, fileName);
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { phase, filePath, unsafe: true, requestId: '', version: '', packagePath: '', mtimeMs: Number(stat.mtimeMs || 0) };
    }
    let payload = {};
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch {
      return { phase, filePath, unsafe: true, requestId: '', version: '', packagePath: '', mtimeMs: Number(stat.mtimeMs || 0) };
    }
    return {
      phase,
      filePath,
      unsafe: false,
      requestId: normalizeManagedUpdateRequestId(payload.requestId),
      version: normalizeVersion(payload.version || payload.signed?.version || ''),
      packagePath: String(payload.packagePath || ''),
      mtimeMs: Number(stat.mtimeMs || 0)
    };
  }
  return null;
}

function normalizeManagedUpdateRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(requestId) ? requestId : '';
}

function isStaleManagedUpdateRequest(request) {
  return (
    request?.phase === 'processing' &&
    !request.unsafe &&
    Date.now() - Number(request.mtimeMs || 0) >= MANAGED_UPDATE_PROCESSING_STALE_MS
  );
}

function isSameManagedUpdateRequest(existing, request) {
  return (
    Boolean(existing) &&
    (Boolean(existing.requestId) && existing.requestId === request.requestId ||
      (existing.version === request.version && existing.packagePath === request.packagePath))
  );
}

async function publishJsonWithoutOverwrite(targetPath, value, mode = 0o600) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fsp.open(temporaryPath, flags, mode);
    await handle.chmod(mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fsp.link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}


const UPDATE_IMPLEMENTATIONS = {
  getPublicUpdateState,
  usesMsixAppInstallerUpdate,
  createMsixUpdateMessage,
  deferMsixUpdateToAppInstaller,
  checkUpdate,
  queueUpdateAfterJobs,
  downloadUpdateOnly,
  applyUpdate,
  applyUpdateInternal,
  createManualUpdateMessage,
  getUsableDownloadedPackage,
  fetchUpdateManifest,
  downloadUpdatePackage,
  loadLastUpdateStatus,
  getUpdateStatusPath,
  getUpdateLogPath,
  getUpdateDir,
  cleanupUpdateDownloads,
  scheduleQueuedUpdateCheck,
  supportsManagedLinuxUpdate,
  requestManagedLinuxUpdate,
  requestManagedLinuxUpdateInternal,
  scheduleAutomaticUpdateCheck
};

// Execute moved implementations with the LiveRecordService as `this`. That
// preserves the public compatibility methods and existing test/custom stubs
// used by cross-method calls such as checkUpdate() -> fetchUpdateManifest().
for (const [name, implementation] of Object.entries(UPDATE_IMPLEMENTATIONS)) {
  Object.defineProperty(UpdateService.prototype, name, {
    configurable: true,
    writable: true,
    value(...args) {
      return implementation.apply(this.owner, args);
    }
  });
}

module.exports = {
  UpdateService,
  AUTO_UPDATE_INITIAL_DELAY_MS,
  AUTO_UPDATE_INTERVAL_MS
};
