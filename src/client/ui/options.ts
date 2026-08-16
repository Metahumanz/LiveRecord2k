import danmakuStylePresetData from '../../shared/danmaku-style-presets.json';
import type { AppSettings, DanmakuStylePreset, FfmpegCodecOption } from '../types';

type DanmakuStylePresetDefinition = {
  label: string;
  shortLabel: string;
  style: Record<string, number>;
};

export const danmakuStylePresets = danmakuStylePresetData as Record<DanmakuStylePreset, DanmakuStylePresetDefinition>;

export const qnOptions = [
  { label: '4K / 超高清优先', value: 25000 },
  { label: '2K / 原画优先', value: 15000 },
  { label: '原画', value: 10000 },
  { label: '蓝光', value: 400 },
  { label: '超清', value: 250 },
  { label: '高清', value: 150 }
];

export const fallbackCodecOptions: FfmpegCodecOption[] = [
  { label: 'H.265 软件编码', value: 'libx265', kind: 'software' },
  { label: 'H.264 软件编码', value: 'libx264', kind: 'software' }
];

export const containerOptions = [
  { label: 'MP4', value: 'mp4' },
  { label: 'MKV', value: 'mkv' }
] as const;

export const settingsExportKeys: Array<keyof AppSettings> = [
  'outputDir',
  'cookie',
  'pollIntervalSec',
  'targetQn',
  'preferHevc',
  'roomImageMode',
  'outputContainer',
  'segmentMinutes',
  'autoBurnDanmaku',
  'deleteSourceAfterBurn',
  'burnOverlayMode',
  'burnDanmakuArea',
  'burnDanmakuStylePreset',
  'burnDanmakuStyleLayout',
  'burnCodec',
  'burnCrf',
  'notifyLiveStarted',
  'notifyLiveEnded',
  'notifyRecordingStarted',
  'notifyRecordingEnded',
  'notifyBurnStarted',
  'notifyBurnEnded',
  'webhookEnabled',
  'webhookUrl',
  'openBrowserOnStart',
  'hideOverviewNextStep',
  'autoUpdateEnabled',
  'updateManifestUrl',
  'serverHost',
  'serverPort',
  'accessUsername'
];

export const KEYFRAME_IMAGE_REFRESH_MS = 5000;
export const KEYFRAME_INFO_REFRESH_MS = 15000;

export const overlayModeOptions = [
  { label: '仅弹幕', value: 'danmaku' },
  { label: '弹幕和礼物', value: 'danmaku-gift' }
] as const;

export const danmakuAreaOptions = [
  { label: '1/4屏（顶部25%）', value: 'quarter' },
  { label: '半屏（顶部50%）', value: 'half' },
  { label: '3/4屏（顶部75%）', value: 'three-quarter' },
  { label: '不重叠（全屏避让）', value: 'no-overlap' },
  { label: '不限（全屏）', value: 'unlimited' }
] as const;

export const danmakuStylePresetOptions = (Object.entries(danmakuStylePresets) as Array<
  [DanmakuStylePreset, DanmakuStylePresetDefinition]
>).map(([value, definition]) => ({ value, ...definition }));

export const exportModeOptions = [
  { label: '纯净片段', value: 'clean' },
  { label: '烧录片段', value: 'burn' }
] as const;
