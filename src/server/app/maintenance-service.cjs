'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  deriveSiblingPath,
  isPathInsideDirectory,
  withTimeout,
  cloneRecordingState
} = require('../shared/helpers.cjs');

const CLEANUP_METADATA_SCAN_MAX_DEPTH = 4;
const CLEANUP_METADATA_SCAN_LIMIT = 2000;
const MAINTENANCE_CLEANUP_PLAN_TTL_MS = 10 * 60 * 1000;
const MAINTENANCE_CLEANUP_PREVIEW_LIMIT = 200;

function isRecordingMetadataSidecar(fileName) {
  return /\.(?:clean|merged)\.(?:mp4|mkv)\.metadata\.json$/i.test(String(fileName || ''));
}

/**
 * Owns non-recording maintenance work: cache migration, disk-space snapshots
 * and the scan/confirm lifecycle for residual merged segments. The owner
 * retains recording-domain primitives so this extraction does not alter their
 * lifecycle or public API.
 */
class MaintenanceService {
  constructor(owner, dependencies = {}) {
    this.owner = owner;
    Object.assign(this, dependencies);
  }

  getCacheStatePath() {
    return path.join(path.dirname(this.owner.storePath), this.CACHE_STATE_FILE);
  }

  async prepareVersionedCaches() {
    const owner = this.owner;
    const configRoot = path.resolve(path.dirname(owner.storePath));
    const previewCacheRoot = path.resolve(owner.previewCacheDir);
    const legacyRepairCacheRoot = path.resolve(owner.legacyRepairCacheDir);
    if (!isPathInsideDirectory(previewCacheRoot, configRoot)) {
      throw new Error(`兼容预览缓存目录不在配置目录内：${previewCacheRoot}`);
    }
    if (!isPathInsideDirectory(legacyRepairCacheRoot, configRoot)) {
      throw new Error(`旧版源流修复缓存目录不在配置目录内：${legacyRepairCacheRoot}`);
    }
    await fsp.mkdir(configRoot, { recursive: true });

    let previousState = null;
    try {
      const raw = await fsp.readFile(owner.getCacheStatePath(), 'utf8');
      previousState = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        previousState = null;
      }
    }

    const entries = await fsp.readdir(previewCacheRoot, { withFileTypes: true }).catch(() => []);
    const cacheStateMatches =
      previousState?.schemaVersion === this.CACHE_STATE_SCHEMA_VERSION &&
      previousState?.appVersion === this.APP_VERSION &&
      previousState?.previewCacheVersion === this.PREVIEW_CACHE_VERSION;
    const shouldClearPreviewCache = entries.length > 0 && !cacheStateMatches;
    const legacyRepairCacheStat = await fsp.lstat(legacyRepairCacheRoot).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    const legacyRepairEntries = legacyRepairCacheStat?.isDirectory()
      ? await fsp.readdir(legacyRepairCacheRoot, { withFileTypes: true })
      : [];
    const shouldClearLegacyRepairCache = Boolean(legacyRepairCacheStat);

    if (shouldClearPreviewCache) {
      await fsp.rm(previewCacheRoot, { recursive: true, force: true });
    }
    if (shouldClearLegacyRepairCache) {
      await fsp.rm(legacyRepairCacheRoot, { recursive: true, force: true });
    }
    await fsp.mkdir(previewCacheRoot, { recursive: true });

    const nextState = {
      schemaVersion: this.CACHE_STATE_SCHEMA_VERSION,
      appVersion: this.APP_VERSION,
      previewCacheVersion: this.PREVIEW_CACHE_VERSION,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(owner.getCacheStatePath(), `${JSON.stringify(nextState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });

    if (shouldClearPreviewCache || shouldClearLegacyRepairCache) {
      const previousVersion = String(previousState?.appVersion || '未标记版本')
        .replace(/[\r\n]/g, ' ')
        .slice(0, 64);
      const cleanedCaches = [];
      if (shouldClearPreviewCache) {
        cleanedCaches.push(`兼容预览缓存 ${entries.length} 项`);
      }
      if (shouldClearLegacyRepairCache) {
        cleanedCaches.push(`旧版源流修复缓存 ${legacyRepairEntries.length} 项`);
      }
      owner.log(
        'info',
        `检测到旧版本缓存（${previousVersion} → ${this.APP_VERSION}），已自动清理${cleanedCaches.join('、')}。`
      );
    }
    return {
      cleared: shouldClearPreviewCache || shouldClearLegacyRepairCache,
      clearedPreviewCache: shouldClearPreviewCache,
      previewEntriesRemoved: shouldClearPreviewCache ? entries.length : 0,
      clearedLegacyRepairCache: shouldClearLegacyRepairCache,
      legacyRepairEntriesRemoved: shouldClearLegacyRepairCache ? legacyRepairEntries.length : 0,
      previousVersion: String(previousState?.appVersion || ''),
      currentVersion: this.APP_VERSION
    };
  }

  async getDiskSpace(targetPath = this.owner.settings.outputDir) {
    const owner = this.owner;
    const rawPath = String(targetPath || owner.settings.outputDir || '').trim();
    if (!rawPath) {
      throw new Error('请先填写录像保存目录。');
    }
    let candidate = path.resolve(rawPath);
    let stat = await withTimeout(fsp.stat(candidate), this.PATH_PROBE_TIMEOUT_MS, '磁盘路径检查超时').catch(() => null);
    if (stat?.isFile()) {
      candidate = path.dirname(candidate);
    }
    while (!stat) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
      stat = await withTimeout(fsp.stat(candidate), this.PATH_PROBE_TIMEOUT_MS, '磁盘路径检查超时').catch(() => null);
    }
    if (!stat) {
      throw new Error(`找不到可用于检查磁盘空间的上级目录：${rawPath}`);
    }
    if (typeof fsp.statfs !== 'function') {
      throw new Error('当前 Node.js 版本不支持磁盘空间检查。');
    }
    const fsInfo = await withTimeout(
      fsp.statfs(candidate, { bigint: true }),
      this.PATH_PROBE_TIMEOUT_MS,
      '磁盘空间检查超时'
    );
    const blockSize = fsInfo.bsize || fsInfo.frsize || 0n;
    const totalBytes = blockSize * fsInfo.blocks;
    const freeBytes = blockSize * (fsInfo.bavail ?? fsInfo.bfree);
    const result = {
      requestedPath: rawPath,
      checkedPath: candidate,
      totalBytes: Number(totalBytes),
      freeBytes: Number(freeBytes),
      usedBytes: Number(totalBytes - freeBytes),
      usedPercent: totalBytes > 0n ? Number(((totalBytes - freeBytes) * 10000n) / totalBytes) / 100 : 0,
      checkedAt: Date.now()
    };
    if (path.resolve(rawPath).toLowerCase() === path.resolve(owner.settings.outputDir).toLowerCase()) {
      owner.outputDiskSpace = result;
    }
    return result;
  }

  async refreshOutputDiskSpace() {
    const owner = this.owner;
    try {
      owner.outputDiskSpace = await owner.getDiskSpace(owner.settings.outputDir);
    } catch (error) {
      owner.outputDiskSpace = {
        requestedPath: String(owner.settings.outputDir || ''),
        checkedPath: '',
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usedPercent: 0,
        checkedAt: Date.now(),
        error: error.message
      };
    }
    owner.markDiskSpaceDirty();
    return owner.outputDiskSpace;
  }

  async findRecordingMetadataSidecars() {
    const owner = this.owner;
    const rootDir = path.resolve(String(owner.settings.outputDir || ''));
    const rootStat = await fsp.stat(rootDir).catch(() => null);
    if (!rootStat?.isDirectory()) {
      return { entries: [], truncated: false };
    }
    const entries = [];
    let truncated = false;
    let directories = [rootDir];
    for (let depth = 0; depth <= CLEANUP_METADATA_SCAN_MAX_DEPTH && directories.length && !truncated; depth += 1) {
      const currentDirectories = directories;
      const nextDirectories = [];
      for (const directory of currentDirectories) {
        const directoryEntries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of directoryEntries) {
          const filePath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < CLEANUP_METADATA_SCAN_MAX_DEPTH) nextDirectories.push(filePath);
            continue;
          }
          if (!entry.isFile() || !isRecordingMetadataSidecar(entry.name)) continue;
          const metadata = await fsp.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
          entries.push({
            metadataPath: filePath,
            mediaPath: filePath.slice(0, -'.metadata.json'.length),
            metadata
          });
          if (entries.length >= CLEANUP_METADATA_SCAN_LIMIT) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      directories = nextDirectories;
    }
    return { entries, truncated };
  }

  pruneMaintenanceCleanupPlans() {
    const expiresAt = Date.now() - MAINTENANCE_CLEANUP_PLAN_TTL_MS;
    for (const [scanId, plan] of this.owner.maintenanceCleanupPlans) {
      if (Number(plan?.createdAt || 0) < expiresAt) {
        this.owner.maintenanceCleanupPlans.delete(scanId);
      }
    }
  }

  clearMaintenanceCleanupPlans() {
    const count = this.owner.maintenanceCleanupPlans.size;
    this.owner.maintenanceCleanupPlans.clear();
    return count;
  }

  async applyMaintenanceCleanupPlan(scanId) {
    const owner = this.owner;
    this.pruneMaintenanceCleanupPlans();
    const id = String(scanId || '').trim();
    const plan = owner.maintenanceCleanupPlans.get(id);
    if (!plan) {
      throw this.businessError('CLEANUP_SCAN_EXPIRED', '清理预览已过期或不存在，请先重新扫描后再确认。', 409);
    }
    owner.maintenanceCleanupPlans.delete(id);
    const fakeRoom = { id: 'maintenance', title: '维护', anchor: '历史录像' };
    let deletedCount = 0;
    let failedCount = 0;
    let groupCount = 0;
    for (const { mergedRecording, segments, cleanupId } of plan.candidates) {
      try {
        const result = await owner.cleanupMergedSegmentFiles(fakeRoom, segments, mergedRecording, { cleanupId });
        deletedCount += Number(result?.deletedCount || 0);
        failedCount += Number(result?.failedCount || 0);
        groupCount += 1;
      } catch (error) {
        failedCount += 1;
        groupCount += 1;
        owner.log('warn', `清理 ${path.basename(mergedRecording.cleanPath)} 的合并残留失败：${error.message}`);
      }
    }
    owner.log(
      deletedCount > 0 ? 'success' : 'info',
      `已执行确认的清理：扫描组 ${groupCount} 个，清理残留 ${deletedCount} 个${failedCount > 0 ? `，失败 ${failedCount} 个` : ''}。`
    );
    owner.emitState();
    return owner.getState();
  }

  async cleanupMergedSegmentResiduals(options = {}) {
    const owner = this.owner;
    if (options.confirm) {
      return this.applyMaintenanceCleanupPlan(options.scanId);
    }
    const fakeRoom = { id: 'maintenance', title: '维护', anchor: '历史录像' };
    const cleanupCandidates = new Map();
    const pathKey = (filePath) => {
      const value = String(filePath || '').trim();
      return value ? path.resolve(value).toLowerCase() : '';
    };
    const createSegmentFromPath = (cleanPath) =>
      owner.normalizeRecording({
        cleanPath,
        capturePath: this.deriveCapturePath(cleanPath),
        danmakuPath: deriveSiblingPath(cleanPath, 'danmaku', 'jsonl'),
        cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
        assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass')
      });
    const addCleanupCandidate = (mergedRecording, segments, cleanupId = '') => {
      const key = pathKey(mergedRecording?.cleanPath);
      const validSegments = Array.isArray(segments) ? segments.filter(Boolean) : [];
      if (!key || validSegments.length === 0) {
        return;
      }
      const existing = cleanupCandidates.get(key);
      if (existing) {
        const knownSegmentPaths = new Set(existing.segments.map((segment) => pathKey(segment.cleanPath)).filter(Boolean));
        for (const segment of validSegments) {
          const segmentKey = pathKey(segment.cleanPath);
          if (!segmentKey || knownSegmentPaths.has(segmentKey)) continue;
          existing.segments.push(segment);
          knownSegmentPaths.add(segmentKey);
        }
        if (!existing.cleanupId && cleanupId) existing.cleanupId = String(cleanupId);
        return;
      }
      cleanupCandidates.set(key, {
        mergedRecording,
        segments: validSegments,
        cleanupId: String(cleanupId || mergedRecording?.cleanupId || '')
      });
    };
    const isMergedRecording = (recording) => {
      const cleanPathKey = pathKey(recording?.cleanPath);
      const mergeOutputKey = pathKey(recording?.mergeOutputPath);
      return Boolean(
        recording?.segmentReason === 'merged' ||
          (cleanPathKey && mergeOutputKey && cleanPathKey === mergeOutputKey) ||
          /\.merged\.(?:mp4|mkv)$/i.test(path.basename(String(recording?.cleanPath || '')))
      );
    };
    const knownMergedRecordings = new Map();
    const rememberMergedRecording = (recording) => {
      const key = pathKey(recording?.cleanPath);
      if (key && isMergedRecording(recording) && !knownMergedRecordings.has(key)) {
        knownMergedRecordings.set(key, recording);
      }
    };
    const resolveMetadataPath = (metadataPath, value) => {
      const rawPath = String(value || '').trim();
      if (!rawPath) return '';
      const metadataDirectory = path.dirname(metadataPath);
      const resolvedPath = path.resolve(metadataDirectory, rawPath);
      return isPathInsideDirectory(resolvedPath, metadataDirectory) ? resolvedPath : '';
    };

    for (const cleanup of owner.pendingSegmentCleanups.values()) {
      rememberMergedRecording(cleanup?.mergedRecording);
      addCleanupCandidate(cleanup?.mergedRecording, cleanup?.segments, cleanup?.cleanupId);
    }

    for (const recording of owner.recordings) {
      if (!isMergedRecording(recording)) {
        continue;
      }
      rememberMergedRecording(recording);
      const mergeGroup = String(recording.mergeGroup || '');
      const segments = Array.isArray(recording.mergedFrom) && recording.mergedFrom.length > 0
        ? recording.mergedFrom.map(createSegmentFromPath).filter(Boolean)
        : mergeGroup
          ? owner.recordings.filter((candidate) => {
            const mergedPathKey = pathKey(recording.cleanPath);
            const candidatePathKey = pathKey(candidate.cleanPath);
            const candidateOutputKey = pathKey(candidate.mergeOutputPath);
            return (
              candidatePathKey &&
              candidatePathKey !== mergedPathKey &&
              !isMergedRecording(candidate) &&
              String(candidate.mergeGroup || '') === mergeGroup &&
              isPathInsideDirectory(candidate.cleanPath, path.dirname(recording.cleanPath)) &&
              (!candidateOutputKey || candidateOutputKey === mergedPathKey)
            );
          })
          : [];
      addCleanupCandidate(recording, segments, recording.cleanupId);
    }

    const metadataScan = await owner.findRecordingMetadataSidecars();
    if (metadataScan.truncated) {
      owner.log('warn', `合并残留 metadata 扫描已达到 ${CLEANUP_METADATA_SCAN_LIMIT} 个文件上限，为避免长时间阻塞，未扫描的目录暂未处理。`);
    }
    for (const entry of metadataScan.entries) {
      if (!(await this.isExistingFile(entry.mediaPath))) continue;
      const metadata = entry.metadata;
      const mergedFrom = Array.isArray(metadata.mergedFrom)
        ? metadata.mergedFrom.map((sourcePath) => resolveMetadataPath(entry.metadataPath, sourcePath)).filter(Boolean)
        : [];
      const recording = owner.normalizeRecording({
        cleanPath: entry.mediaPath,
        mergeGroup: String(metadata.mergeGroup || ''),
        mergeOutputPath: resolveMetadataPath(entry.metadataPath, metadata.mergeOutputPath) || entry.mediaPath,
        segmentReason: String(metadata.segmentReason || ''),
        mergedFrom,
        cleanupId: String(metadata.cleanupId || '')
      });
      if (!isMergedRecording(recording)) continue;
      rememberMergedRecording(recording);
      if (mergedFrom.length > 0) {
        addCleanupCandidate(recording, mergedFrom.map(createSegmentFromPath).filter(Boolean), recording.cleanupId);
      }
    }

    for (const entry of metadataScan.entries) {
      const metadata = entry.metadata;
      if (!/\.clean\.(?:mp4|mkv)$/i.test(entry.mediaPath)) continue;
      if (String(metadata.status || '').toLowerCase() === 'recording') continue;
      if (await this.isExistingFile(entry.mediaPath)) continue;
      const mergeOutputPath = resolveMetadataPath(entry.metadataPath, metadata.mergeOutputPath);
      const mergedRecording = knownMergedRecordings.get(pathKey(mergeOutputPath));
      if (!mergedRecording) continue;
      const sourceGroup = String(metadata.mergeGroup || '');
      const mergedGroup = String(mergedRecording.mergeGroup || '');
      if (sourceGroup && mergedGroup && sourceGroup !== mergedGroup) continue;
      addCleanupCandidate(mergedRecording, [createSegmentFromPath(entry.mediaPath)], mergedRecording.cleanupId);
    }

    const candidates = Array.from(cleanupCandidates.values()).map(({ mergedRecording, segments, cleanupId }) => ({
      mergedRecording: cloneRecordingState(mergedRecording),
      segments: segments.map((segment) => cloneRecordingState(segment)),
      cleanupId
    }));
    const itemByPath = new Map();
    let skippedGroupCount = 0;
    for (const { mergedRecording, segments, cleanupId } of candidates) {
      try {
        const preview = await owner.cleanupMergedSegmentFiles(fakeRoom, segments, mergedRecording, { cleanupId, preview: true });
        for (const item of preview?.items || []) {
          const key = path.resolve(String(item.path || '')).toLowerCase();
          if (key && !itemByPath.has(key)) itemByPath.set(key, item);
        }
      } catch (error) {
        skippedGroupCount += 1;
        owner.log('warn', `扫描 ${path.basename(mergedRecording.cleanPath)} 的合并残留失败：${error.message}`);
      }
    }
    const allItems = Array.from(itemByPath.values());
    const scanId = crypto.randomUUID();
    this.pruneMaintenanceCleanupPlans();
    owner.maintenanceCleanupPlans.set(scanId, { createdAt: Date.now(), candidates });
    const totalBytes = allItems.reduce((total, item) => total + Math.max(0, Number(item.sizeBytes || 0)), 0);
    owner.log(
      'info',
      `已扫描 ${candidates.length} 个合并记录或待清理任务，发现 ${allItems.length} 个可清理文件，等待确认。`
    );
    return {
      scanId,
      groupCount: candidates.length,
      skippedGroupCount,
      fileCount: allItems.length,
      totalBytes,
      items: allItems.slice(0, MAINTENANCE_CLEANUP_PREVIEW_LIMIT),
      omittedCount: Math.max(0, allItems.length - MAINTENANCE_CLEANUP_PREVIEW_LIMIT),
      truncated: metadataScan.truncated
    };
  }
}

module.exports = { MaintenanceService };
