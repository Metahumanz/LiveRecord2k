import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Activity,
  CircleAlert,
  Clock3,
  Cpu,
  FileCode2,
  FileVideo,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  ListVideo,
  MessageSquareText,
  MonitorDot,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Video,
  X
} from 'lucide-react';
import { recorder } from '../recorderClient';
import { JobProgress } from './common';
import type { AppSettings, AppState, RoomState } from '../types';
import { KEYFRAME_IMAGE_REFRESH_MS, KEYFRAME_INFO_REFRESH_MS, danmakuAreaOptions, overlayModeOptions } from '../ui/options';
import {
  commandCountsSummary,
  containerStageLabel,
  displayCodec,
  filename,
  formatClock,
  formatVideoInfo,
  getRoomStatus,
  imageProxyUrl,
  loginStatusLabel,
  mediaUrl,
  overlayModeLabel,
  qnLabel
} from '../utils';

export function ImageModeSwitch({
  value,
  busy,
  onChange
}: {
  value: AppSettings['roomImageMode'];
  busy: boolean;
  onChange: (mode: AppSettings['roomImageMode']) => Promise<void>;
}) {
  return (
    <div className="preview-switch" aria-label="卡片画面模式">
      <button
        className={value === 'cover' ? 'active' : ''}
        disabled={busy}
        onClick={() => onChange('cover')}
        title="卡片只显示直播间封面"
      >
        <ImageIcon size={17} />
        <span>封面</span>
      </button>
      <button
        className={value === 'keyframe' ? 'active' : ''}
        disabled={busy}
        onClick={() => onChange('keyframe')}
        title="卡片显示 B 站预览图"
      >
        <MonitorDot size={17} />
        <span>预览图</span>
      </button>
    </div>
  );
}

export function RoomPreview({
  room,
  roomImageMode,
  status,
  onPreview
}: {
  room: RoomState;
  roomImageMode: AppSettings['roomImageMode'];
  status: ReturnType<typeof getRoomStatus>;
  onPreview: (roomId: string) => void;
}) {
  const rawImageUrl = roomImageMode === 'cover' ? room.cover : room.keyframe;
  const [previewVersion, setPreviewVersion] = useState(Date.now());
  const shouldRefreshRoomInfo = roomImageMode === 'keyframe' && (room.liveStatus === 1 || room.recording);
  useEffect(() => {
    if (roomImageMode !== 'keyframe') {
      return;
    }
    setPreviewVersion(Date.now());
    const timer = window.setInterval(() => setPreviewVersion(Date.now()), KEYFRAME_IMAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [rawImageUrl, roomImageMode]);
  useEffect(() => {
    if (!shouldRefreshRoomInfo) {
      return;
    }
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) {
        recorder.refreshRoom(room.id, { silent: true }).catch(() => {});
      }
    };
    refresh();
    const timer = window.setInterval(refresh, KEYFRAME_INFO_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [room.id, shouldRefreshRoomInfo]);
  const imageVersion = roomImageMode === 'keyframe' ? previewVersion : room.lastCheckedAt;
  const imageUrl = rawImageUrl ? imageProxyUrl(rawImageUrl, imageVersion) : '';
  const imageKey = rawImageUrl ? `${rawImageUrl}:${imageVersion || 0}` : '';
  const [failedSrc, setFailedSrc] = useState('');
  const canShowImage = Boolean(rawImageUrl && imageUrl && failedSrc !== imageKey);
  const canPreview = room.liveStatus === 1 || room.recording;

  return (
    <div className="room-cover">
      {canShowImage ? (
        <img src={imageUrl} alt="" onError={() => setFailedSrc(imageKey)} />
      ) : (
        <div className="cover-fallback">
          <Radio size={32} />
          <span>{roomImageMode === 'cover' ? '无封面' : '无预览图'}</span>
        </div>
      )}
      <span className={`status-pill ${status.kind}`}>{status.label}</span>
      <button
        className="preview-open-button"
        title={canPreview ? '打开实时预览' : '未开播，无法实时预览'}
        disabled={!canPreview}
        onClick={() => onPreview(room.id)}
      >
        <Video size={18} />
      </button>
    </div>
  );
}

export function RoomCard({
  room,
  roomImageMode,
  burnOverlayMode,
  burnDanmakuArea,
  showDanmakuActions = true,
  busy,
  run,
  openPreview
}: {
  room: RoomState;
  roomImageMode: AppSettings['roomImageMode'];
  burnOverlayMode: AppSettings['burnOverlayMode'];
  burnDanmakuArea: AppSettings['burnDanmakuArea'];
  showDanmakuActions?: boolean;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  openPreview: (roomId: string) => void;
}) {
  const status = getRoomStatus(room);
  const liveStatusLabel = room.liveStatus === 1 ? '直播中' : room.liveStatus === 2 ? '轮播' : '未开播';
  const roomKey = room.id;
  const requestedText = room.stream?.requestedQn ? qnLabel(room.stream.requestedQn) : '未请求';
  const selectedText = room.stream ? `${displayCodec(room.stream.codec)} · qn ${room.stream.qn}` : '未选流';
  const actualText = room.currentRecording?.videoInfo
    ? formatVideoInfo(room.currentRecording.videoInfo, room.stream?.codec)
    : room.recording
      ? '正在探测实际分辨率'
      : '尚未写入';
  const danmakuCommandSummary = commandCountsSummary(room.currentRecording?.danmakuCommandCounts);
  const [cardOverlayMode, setCardOverlayMode] = useState<AppSettings['burnOverlayMode']>(burnOverlayMode);
  const [cardDanmakuArea, setCardDanmakuArea] = useState<AppSettings['burnDanmakuArea']>(burnDanmakuArea);

  useEffect(() => {
    setCardOverlayMode(burnOverlayMode);
  }, [burnOverlayMode]);
  useEffect(() => {
    setCardDanmakuArea(burnDanmakuArea);
  }, [burnDanmakuArea]);

  return (
    <article className={`room-card ${room.recording ? 'is-recording' : ''}`}>
      <RoomPreview room={room} roomImageMode={roomImageMode} status={status} onPreview={openPreview} />

      <div className="room-content">
        <div className="room-heading">
          <div>
            <h3>{room.title || `直播间 ${room.realRoomId || room.id}`}</h3>
            <p>{room.anchor || `房间 ${room.realRoomId || room.id}`}</p>
          </div>
          <button
            className="icon-button danger"
            title="移除直播间"
            disabled={room.recording || busy === `remove-${roomKey}`}
            onClick={() => run(`remove-${roomKey}`, () => recorder.removeRoom(room.id))}
          >
            <Trash2 size={18} />
          </button>
        </div>

        <div className="badge-row">
          <span className={room.liveStatus === 1 ? 'badge hot' : 'badge'}>{liveStatusLabel}</span>
          <span className={room.monitoring ? 'badge on' : 'badge'}>{room.monitoring ? '已监听' : '未监听'}</span>
          <span className={room.recording ? 'badge hot' : 'badge'}>{room.recording ? '录制中' : '未录制'}</span>
          {room.burning ? <span className="badge work">生成弹幕视频中</span> : null}
        </div>

        {room.qualityWarning ? (
          <div className="warning-line">
            <CircleAlert size={16} />
            <span>{room.qualityWarning}</span>
          </div>
        ) : null}

        {room.lastError ? (
          <div className="error-line">
            <CircleAlert size={16} />
            <span>{room.lastError}</span>
          </div>
        ) : null}

        {room.burnProgress ? <JobProgress progress={room.burnProgress} /> : null}
        {room.burnProgress?.status === 'running' ? (
          <button
            className="wide-button danger fill"
            type="button"
            disabled={busy === `cancel-burn-${roomKey}`}
            onClick={() => run(`cancel-burn-${roomKey}`, () => recorder.cancelBurnDanmaku(room.id))}
          >
            <Square size={17} />
            中断生成弹幕视频
          </button>
        ) : null}

        <details className="technical-details">
          <summary>技术详情</summary>
          <div className="room-meta">
            <span>
              <Clock3 size={15} />
              上次刷新 {room.lastCheckedAt ? formatClock(room.lastCheckedAt) : '未刷新'}
            </span>
            <span>
              <Cpu size={15} />
              请求 {requestedText}
            </span>
            <span>
              <Gauge size={15} />
              接口 {selectedText}
            </span>
            <span>
              <Video size={15} />
              实际 {actualText}
            </span>
          </div>

          {room.currentRecording ? (
            <div className="recording-info">
              <span>
                <HardDrive size={15} />
                {containerStageLabel(room.currentRecording)}
              </span>
              <span>
                <MessageSquareText size={15} />
                可烧录事件 {room.currentRecording.capturedDanmakuCount ?? room.currentRecording.eventCount}
              </span>
              <span>
                <Radio size={15} />
                {room.currentRecording.danmakuMessage || '弹幕通道准备中'}
              </span>
              <span>
                <Activity size={15} />
                互动包 {room.currentRecording.rawDanmakuCount ?? 0} · 未烧录 {room.currentRecording.ignoredDanmakuCount ?? 0} · 热度{' '}
                {room.currentRecording.danmakuPopularity ?? 0}
              </span>
              {danmakuCommandSummary ? (
                <span title={danmakuCommandSummary}>
                  <ListVideo size={15} />
                  命令 {danmakuCommandSummary}
                </span>
              ) : null}
              {room.currentRecording.validReason ? (
                <span title={room.currentRecording.validReason}>
                  <CircleAlert size={15} />
                  {room.currentRecording.validReason}
                </span>
              ) : null}
              {room.currentRecording.capturePath ? (
                <span title={room.currentRecording.capturePath}>
                  <FileVideo size={15} />
                  临时 {filename(room.currentRecording.capturePath)}
                </span>
              ) : null}
              <span title={room.currentRecording.cleanPath}>
                <FileVideo size={15} />
                最终 {filename(room.currentRecording.cleanPath)}
              </span>
            </div>
          ) : (
            <p className="technical-empty">开始录制后会显示源流、分辨率、弹幕通道和输出文件信息。</p>
          )}
        </details>

        <div className="action-row">
          <button
            className="wide-button"
            title="刷新状态"
            disabled={busy === `refresh-${roomKey}`}
            onClick={() => run(`refresh-${roomKey}`, () => recorder.refreshRoom(room.id))}
          >
            <RefreshCw size={18} />
            刷新
          </button>
          <button
            className={room.monitoring ? 'wide-button active' : 'wide-button'}
            disabled={busy === `monitor-${roomKey}`}
            onClick={() =>
              run(`monitor-${roomKey}`, () => recorder.setMonitoring(room.id, !room.monitoring))
            }
          >
            <MonitorDot size={18} />
            {room.monitoring ? '监听中' : '监听'}
          </button>
          {room.recording ? (
            <button
              className="wide-button danger"
              disabled={busy === `stop-${roomKey}`}
              onClick={() => run(`stop-${roomKey}`, () => recorder.stopRecording(room.id))}
            >
              <Square size={17} />
              停止
            </button>
          ) : (
            <button
              className="wide-button primary"
              disabled={busy === `record-${roomKey}`}
              onClick={() => run(`record-${roomKey}`, () => recorder.startRecording(room.id))}
            >
              <Play size={17} />
              录制
            </button>
          )}
          {showDanmakuActions ? (
            <>
              <select
                className="action-select"
                value={cardOverlayMode}
                disabled={!room.currentRecording || room.recording || room.burning}
                title="弹幕版内容"
                onChange={(event) => setCardOverlayMode(event.target.value as AppSettings['burnOverlayMode'])}
              >
                {overlayModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                className="action-select"
                value={cardDanmakuArea}
                disabled={!room.currentRecording || room.recording || room.burning}
                title="弹幕显示区域"
                onChange={(event) => setCardDanmakuArea(event.target.value as AppSettings['burnDanmakuArea'])}
              >
                {danmakuAreaOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                className="wide-button"
                title={`只生成字幕文件（${overlayModeLabel(cardOverlayMode)}，${
                  danmakuAreaOptions.find((option) => option.value === cardDanmakuArea)?.label || '半屏'
                }）`}
                disabled={!room.currentRecording || room.recording || room.burning}
                onClick={() =>
                  run(`subtitles-${roomKey}`, () =>
                    recorder.prepareDanmaku(room.id, { overlayMode: cardOverlayMode, danmakuArea: cardDanmakuArea })
                  )
                }
              >
                <FileCode2 size={18} />
                生成字幕
              </button>
              <button
                className="wide-button"
                title={`生成弹幕版（${overlayModeLabel(cardOverlayMode)}，${
                  danmakuAreaOptions.find((option) => option.value === cardDanmakuArea)?.label || '半屏'
                }）`}
                disabled={!room.currentRecording || room.recording || room.burning}
                onClick={() =>
                  run(`burn-${roomKey}`, () =>
                    recorder.burnDanmaku(room.id, { overlayMode: cardOverlayMode, danmakuArea: cardDanmakuArea })
                  )
                }
              >
                <Sparkles size={18} />
                生成弹幕视频
              </button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function LivePreviewModal({ room, onClose }: { room: RoomState; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const temporaryPath = room.currentRecording?.capturePath || '';
  const canPreviewTemporary = Boolean(temporaryPath);
  const [previewMode, setPreviewMode] = useState<'recording' | 'live'>('live');
  const [temporaryPreviewVersion, setTemporaryPreviewVersion] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const temporarySegmentIndex = Number(room.currentRecording?.mergeSequence || 0);

  useEffect(() => {
    if (!canPreviewTemporary && previewMode === 'recording') {
      setPreviewMode('live');
    }
  }, [canPreviewTemporary, previewMode]);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const player = video;

    async function start() {
      setError('');
      setLoading(true);
      try {
        hlsRef.current?.destroy();
        hlsRef.current = null;
        player.pause();
        player.removeAttribute('src');
        player.load();

        if (previewMode === 'recording') {
          if (!temporaryPath) {
            setError('当前还没有可预览的临时 MKV。');
            return;
          }
          player.muted = false;
          player.autoplay = false;
          player.playsInline = true;
          player.src = mediaUrl(temporaryPath, temporaryPreviewVersion);
          player.load();
          setLoading(false);
          return;
        }

        const nextPreview = await recorder.startPreview(room.id);
        if (cancelled) {
          return;
        }
        player.muted = true;
        player.autoplay = true;
        player.playsInline = true;

        if (Hls.isSupported()) {
          const hls = new Hls({
            lowLatencyMode: true,
            backBufferLength: 30,
            liveSyncDurationCount: 3
          });
          hlsRef.current = hls;
          hls.attachMedia(player);
          hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            hls.loadSource(nextPreview.previewUrl);
          });
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            player.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setLoading(false);
              setError(`实时预览播放失败：${data.details || data.type}`);
            }
          });
          return;
        }

        if (player.canPlayType('application/vnd.apple.mpegurl')) {
          player.src = nextPreview.previewUrl;
          setLoading(false);
          player.play().catch(() => {});
          return;
        }

        setError('当前浏览器不支持 HLS 实时预览。');
      } catch (err) {
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && previewMode !== 'live') {
          setLoading(false);
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
    };
  }, [room.id, previewMode, temporaryPath, temporaryPreviewVersion]);

  return (
    <div className="preview-backdrop">
      <div className="preview-panel">
        <div className="preview-header">
          <div>
            <h3>{room.title || `直播间 ${room.realRoomId || room.id}`}</h3>
            <p>
              {previewMode === 'recording' && temporaryPath
                ? `临时 MKV${temporarySegmentIndex > 0 ? ` · 第 ${temporarySegmentIndex + 1} 段` : ''} · ${filename(
                    temporaryPath
                  )}`
                : room.anchor || `房间 ${room.realRoomId || room.id}`}
            </p>
          </div>
          <button className="icon-button" title="关闭实时预览" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="preview-mode-tabs">
          <button
            className={previewMode === 'recording' ? 'active' : ''}
            disabled={!canPreviewTemporary}
            title={canPreviewTemporary ? '打开或刷新正在写入的临时 MKV' : '当前没有临时 MKV'}
            onClick={() => {
              setTemporaryPreviewVersion(Date.now());
              setPreviewMode('recording');
            }}
          >
            <RefreshCw size={14} />
            临时 MKV
          </button>
          <button
            className={previewMode === 'live' ? 'active' : ''}
            title="预览直播流"
            onClick={() => setPreviewMode('live')}
          >
            直播流
          </button>
        </div>
        <div className="live-preview">
          <video
            ref={videoRef}
            controls
            muted={previewMode === 'live'}
            playsInline
            preload="metadata"
            onError={() => {
              setLoading(false);
              setError((current) =>
                current ||
                (previewMode === 'recording'
                  ? '浏览器通常无法直接播放正在写入的临时 MKV，请用直播流预览确认画面，或稍后查看最终 MP4。'
                  : '实时预览播放失败。')
              );
            }}
          />
          {loading && !error ? (
            <div className="live-preview-status">
              <Activity className="spin" size={24} />
              <span>{previewMode === 'recording' ? '正在打开临时 MKV' : '正在连接实时画面'}</span>
            </div>
          ) : null}
          {error ? (
            <div className="live-preview-status error">
              <CircleAlert size={24} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function QrLoginPanel({
  login,
  busy,
  run
}: {
  login: NonNullable<AppState['login']>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <div className="qr-backdrop">
      <div className="qr-panel">
        <div className="qr-header">
          <div>
            <h3>扫码登录</h3>
            <p>{login.message}</p>
          </div>
          <button
            className="icon-button"
            title="关闭"
            disabled={busy === 'cancel-login'}
            onClick={() => run('cancel-login', recorder.cancelQrLogin)}
          >
            <X size={18} />
          </button>
        </div>
        <div className={`qr-box ${login.status}`}>
          {login.qrImageDataUrl ? (
            <img src={login.qrImageDataUrl} alt="哔哩哔哩登录二维码" />
          ) : (
            <QrCode size={74} />
          )}
        </div>
        <div className="qr-footer">
          <span className={`login-status ${login.status}`}>{loginStatusLabel(login.status)}</span>
          {login.status === 'expired' || login.status === 'error' ? (
            <button
              className="wide-button primary"
              disabled={busy === 'qr-login'}
              onClick={() => run('qr-login', recorder.startQrLogin)}
            >
              <RefreshCw size={17} />
              重新生成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
