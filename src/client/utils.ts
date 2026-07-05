import type { AppSettings, AppState, ExportDraft, FfmpegCodecOption, RecordingState, RoomState } from './types';
import { fallbackCodecOptions, qnOptions, settingsExportKeys } from './ui/options';

export function getStats(rooms: RoomState[]) {
  return {
    rooms: rooms.length,
    live: rooms.filter((room) => room.liveStatus === 1).length,
    monitoring: rooms.filter((room) => room.monitoring).length,
    recording: rooms.filter((room) => room.recording).length,
    burning: rooms.filter((room) => room.burning).length,
    events: rooms.reduce(
      (sum, room) => sum + (room.currentRecording?.capturedDanmakuCount ?? room.currentRecording?.eventCount ?? 0),
      0
    )
  };
}

export function hydrateExportDraft(current: ExportDraft, state: AppState): ExportDraft {
  const recordings = state.recordings.filter((recording) => recording.cleanPath);
  const currentRecording = current.cleanPath
    ? recordings.find((recording) => recording.cleanPath === current.cleanPath)
    : undefined;
  if (current.cleanPath && currentRecording) {
    return {
      ...current,
      danmakuPath: current.danmakuPath || currentRecording.danmakuPath || '',
      cssPath: current.cssPath || currentRecording.cssPath || '',
      overlayMode: current.overlayMode || state.settings.burnOverlayMode,
      danmakuArea: current.danmakuArea || state.settings.burnDanmakuArea,
      outputDir: current.outputDir || state.settings.outputDir
    };
  }
  return {
    ...current,
    cleanPath: '',
    danmakuPath: '',
    cssPath: '',
    endTime: '',
    overlayMode: state.settings.burnOverlayMode,
    danmakuArea: state.settings.burnDanmakuArea,
    outputDir: current.outputDir || state.settings.outputDir
  };
}

export function pickSettings(source: Partial<AppSettings> | Record<string, unknown>): Partial<AppSettings> {
  const sourceRecord = source as Record<string, unknown>;
  const picked: Partial<AppSettings> = {};
  const pickedRecord = picked as Record<string, unknown>;
  for (const key of settingsExportKeys) {
    if (Object.prototype.hasOwnProperty.call(sourceRecord, key)) {
      pickedRecord[key] = sourceRecord[key];
    }
  }
  return picked;
}

export function parseSettingsImport(text: string): Partial<AppSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('设置文件不是有效 JSON。');
  }
  const source = isRecord(parsed) && isRecord(parsed.settings) ? parsed.settings : parsed;
  if (!isRecord(source)) {
    throw new Error('设置文件格式不正确。');
  }
  const importedSettings = pickSettings(source);
  if (Object.keys(importedSettings).length === 0) {
    throw new Error('设置文件里没有可导入的设置项。');
  }
  return importedSettings;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function burnCodecOptions(detected: FfmpegCodecOption[] | undefined, selected: string) {
  const options = detected?.length ? detected : fallbackCodecOptions;
  if (selected && !options.some((option) => option.value === selected)) {
    return [
      ...options,
      {
        value: selected,
        label: `${selected}（当前不可用）`,
        kind: 'software' as const,
        reason: '当前 ffmpeg 环境未通过探测'
      }
    ];
  }
  return options;
}

export function burnCodecSummary(options: FfmpegCodecOption[]) {
  const hardware = options.filter((option) => option.kind === 'hardware');
  const software = options.filter((option) => option.kind === 'software');
  if (hardware.length) {
    return `硬件 ${hardware.map((option) => option.label).join(' / ')}；软件 ${software
      .map((option) => option.label)
      .join(' / ')}`;
  }
  return `软件 ${software.map((option) => option.label).join(' / ')}`;
}

export function videoAdapterSummary(state: AppState) {
  const adapters = state.ffmpegCapabilities?.videoAdapters || [];
  return adapters.length ? adapters.map((adapter) => adapter.name).join(' / ') : '未检测到';
}

export function ffmpegCodecSummary(state: AppState) {
  const capabilities = state.ffmpegCapabilities;
  if (!capabilities) {
    return '未探测';
  }
  if (capabilities.probeError) {
    return `探测失败：${capabilities.probeError}`;
  }
  return capabilities.burnCodecs.length
    ? capabilities.burnCodecs.map((codec) => codec.label).join(' / ')
    : '未探测到可用编码';
}

export function settingsExportStamp() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

export function recordingLabel(recording: RecordingState) {
  const title = recording.roomTitle || recording.anchor || filename(recording.cleanPath);
  const merged = recording.mergedFrom?.length ? '合并' : '源流';
  return `${formatDateTime(recording.startedAt)} · ${merged} · ${title}`;
}

export function qnLabel(qn: number) {
  const option = qnOptions.find((item) => item.value === Number(qn));
  return option ? `${option.label}(${option.value})` : `清晰度 ${qn}`;
}

export function containerStageLabel(recording: RecordingState) {
  if (recording.containerStage === 'finalizing') {
    return '正在封装 MP4';
  }
  if (recording.containerStage === 'ready') {
    return '已生成最终文件';
  }
  if (recording.containerStage === 'failed') {
    return '封装失败，已保留可诊断文件';
  }
  if (recording.capturePath && recording.capturePath !== recording.cleanPath) {
    return `写入临时 MKV：${filename(recording.capturePath)}`;
  }
  return '正在写入源流文件';
}

export function commandCountsSummary(counts?: Record<string, number>) {
  const entries = Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3);
  return entries.map(([name, count]) => `${name} ${count}`).join(' · ');
}

export function overlayModeLabel(mode: AppSettings['burnOverlayMode']) {
  return mode === 'danmaku' ? '仅弹幕' : '弹幕和礼物';
}

export function getRoomStatus(room: RoomState) {
  if (room.recording) {
    return { label: '录制中', kind: 'recording' };
  }
  if (room.liveStatus === 1) {
    return { label: '直播中', kind: 'live' };
  }
  if (room.liveStatus === 2) {
    return { label: '轮播', kind: 'loop' };
  }
  return { label: '未开播', kind: 'offline' };
}

export function formatClock(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(time);
}

export function formatDateTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}

export function filename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function displayCodec(codec: string) {
  const value = codec.toLowerCase();
  if (value.includes('hevc') || value.includes('h265')) {
    return 'H.265';
  }
  if (value.includes('avc') || value.includes('h264')) {
    return 'H.264';
  }
  return codec.toUpperCase();
}

export function formatVideoInfo(videoInfo: NonNullable<RoomState['currentRecording']>['videoInfo'], fallbackCodec?: string) {
  if (!videoInfo) {
    return fallbackCodec ? displayCodec(fallbackCodec) : '正在探测';
  }
  const codec = displayCodec(fallbackCodec || videoInfo.codec || '');
  const fps = videoInfo.fps ? ` · ${videoInfo.fps}fps` : '';
  return `${codec} · ${videoInfo.width}x${videoInfo.height}${fps}`;
}

export function imageProxyUrl(url: string, version?: number) {
  let targetUrl = url;
  if (version) {
    try {
      const target = new URL(url);
      target.searchParams.set('_br2k_preview', String(version));
      targetUrl = target.toString();
    } catch {
      targetUrl = url;
    }
  }
  const params = new URLSearchParams({ url: targetUrl });
  if (version) {
    params.set('v', String(version));
  }
  return `/api/image?${params.toString()}`;
}

export function mediaUrl(filePath: string, version?: number) {
  const params = new URLSearchParams({ path: filePath });
  if (version) {
    params.set('v', String(version));
  }
  return `/api/media?${params.toString()}`;
}

export function parseTimelineInput(value: string) {
  const text = String(value || '').trim();
  if (!text) {
    return Number.NaN;
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parts = text.split(':').map((part) => Number(part));
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return Number.NaN;
  }
  while (parts.length < 3) {
    parts.unshift(0);
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function formatTimelineTime(value: number) {
  const totalTenths = Math.max(0, Math.round((Number(value) || 0) * 10));
  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  const secondText = `${String(seconds).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secondText}`;
}

export function clampNumber(value: number, min: number, max: number) {
  const safeMax = Math.max(min, max);
  return Math.min(safeMax, Math.max(min, Number(value) || 0));
}

export function formatFileSize(bytes: number) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value)} B`;
}

export function parseChangelog(markdown: string) {
  const entries: Array<{ version: string; items: string[] }> = [];
  let current: { version: string; items: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { version: heading[1], items: [] };
      entries.push(current);
      continue;
    }
    const item = /^-\s+(.+)$/.exec(line);
    if (item && current) {
      current.items.push(item[1]);
    }
  }
  return entries.slice(0, 6);
}

export function loginStatusLabel(status: NonNullable<AppState['login']>['status']) {
  if (status === 'waiting') {
    return '等待扫码';
  }
  if (status === 'scanned') {
    return '等待确认';
  }
  if (status === 'success') {
    return '登录成功';
  }
  if (status === 'expired') {
    return '已过期';
  }
  return '登录异常';
}

export function isAppState(value: unknown): value is AppState {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'settings' in value &&
      'rooms' in value &&
      'logs' in value
  );
}
