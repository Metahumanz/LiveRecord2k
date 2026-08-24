import { Maximize2, Move, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { AppSettings, DanmakuStyleLayout, DanmakuStylePreset } from '../types';
import { danmakuStylePresets } from '../ui/options';
import { clampNumber } from '../utils';

const PLAY_WIDTH = 1920;
const PLAY_HEIGHT = 1080;
const DEFAULT_LAYOUT = {
  panelLeft: 5,
  superChatBottom: 1070,
  superChatWidth: 375,
  giftWidth: 360,
  boxFontSize: 29,
  danmakuTop: 36,
  danmakuFontSize: 38,
  danmakuLineHeight: 46,
  danmakuDuration: 8
};

type EffectiveLayout = typeof DEFAULT_LAYOUT;
type PreviewCanvas = {
  width: number;
  height: number;
  scale: number;
  portrait: boolean;
};
type PreviewFrame = {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  scale: number;
};
type Interaction = {
  kind: 'move' | 'resize';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startFontSize: number;
  cardHeight: number;
};

function numberValue(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildPreviewCanvas(videoInfo?: { width?: number; height?: number } | null): PreviewCanvas {
  const width = Math.round(Number(videoInfo?.width || 0));
  const height = Math.round(Number(videoInfo?.height || 0));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 160) {
    return { width: PLAY_WIDTH, height: PLAY_HEIGHT, scale: 1, portrait: false };
  }
  return {
    width,
    height,
    scale: Math.sqrt((width * height) / (PLAY_WIDTH * PLAY_HEIGHT)),
    portrait: height > width
  };
}

// The video element itself fills the preview box and uses object-fit: contain.
// Compute the actual painted video rectangle so the overlay follows the video
// rather than the black bars around it, especially when a portrait source is
// shown in a landscape fullscreen viewport.
function buildContainedPreviewFrame(hostWidth: number, hostHeight: number, canvas: PreviewCanvas): PreviewFrame {
  const safeHostWidth = Math.max(1, Number(hostWidth) || 1);
  const safeHostHeight = Math.max(1, Number(hostHeight) || 1);
  const aspect = Math.max(0.01, canvas.width / Math.max(1, canvas.height));
  const hostAspect = safeHostWidth / safeHostHeight;
  const width =
    hostAspect >= aspect ? safeHostHeight * aspect : safeHostWidth;
  const height = width / aspect;
  return {
    centerX: safeHostWidth / 2,
    centerY: safeHostHeight / 2,
    width,
    height,
    scale: Math.min(width / canvas.width, height / canvas.height)
  };
}

function buildEffectiveLayout(preset: DanmakuStylePreset, layout: DanmakuStyleLayout, canvas: PreviewCanvas): EffectiveLayout {
  const style = danmakuStylePresets[preset]?.style || {};
  const base = {
    panelLeft: clampNumber(numberValue(layout.panelLeft ?? style.panelLeft, DEFAULT_LAYOUT.panelLeft), 0, 2000),
    superChatBottom: clampNumber(
      numberValue(layout.superChatBottom ?? style.superChatBottom, DEFAULT_LAYOUT.superChatBottom),
      -4000,
      4000
    ),
    superChatWidth: clampNumber(
      numberValue(layout.superChatWidth ?? style.superChatWidth, DEFAULT_LAYOUT.superChatWidth),
      220,
      1200
    ),
    giftWidth: clampNumber(numberValue(style.giftWidth, DEFAULT_LAYOUT.giftWidth), 160, 1200),
    boxFontSize: clampNumber(numberValue(layout.boxFontSize ?? style.boxFontSize, DEFAULT_LAYOUT.boxFontSize), 12, 80),
    danmakuTop: clampNumber(numberValue(layout.danmakuTop ?? style.danmakuTop, DEFAULT_LAYOUT.danmakuTop), 0, 2000),
    danmakuFontSize: clampNumber(
      numberValue(layout.danmakuFontSize ?? style.danmakuFontSize, DEFAULT_LAYOUT.danmakuFontSize),
      12,
      96
    ),
    danmakuLineHeight: clampNumber(
      numberValue(layout.danmakuLineHeight ?? style.danmakuLineHeight, DEFAULT_LAYOUT.danmakuLineHeight),
      16,
      180
    ),
    danmakuDuration: clampNumber(
      numberValue(layout.danmakuDuration ?? style.danmakuDuration, DEFAULT_LAYOUT.danmakuDuration),
      2,
      20
    )
  };
  const metric = (value: number) => value * canvas.scale;
  const panelLeft = clampNumber(metric(base.panelLeft), 0, canvas.width);
  const maximumPanelWidth = Math.max(1, canvas.width - panelLeft - Math.max(8, metric(12)));
  return {
    panelLeft,
    superChatBottom: clampNumber(canvas.height - (PLAY_HEIGHT - base.superChatBottom) * canvas.scale, 0, canvas.height),
    superChatWidth: clampNumber(Math.max(Math.min(220, maximumPanelWidth), metric(base.superChatWidth)), 1, maximumPanelWidth),
    giftWidth: clampNumber(metric(base.giftWidth), 1, maximumPanelWidth),
    boxFontSize: metric(base.boxFontSize),
    danmakuTop: metric(base.danmakuTop),
    danmakuFontSize: metric(base.danmakuFontSize),
    danmakuLineHeight: Math.max(1, metric(base.danmakuLineHeight)),
    danmakuDuration: base.danmakuDuration
  };
}

function AvatarPlaceholder() {
  return (
    <span className="preview-side-avatar" aria-hidden="true">
      <svg viewBox="0 0 32 32" focusable="false">
        <circle cx="16" cy="10.5" r="5.1" fill="currentColor" fillOpacity="0.78" />
        <path d="M6.9 27c0-5.15 4.08-8.7 9.1-8.7s9.1 3.55 9.1 8.7" fill="currentColor" fillOpacity="0.78" />
      </svg>
    </span>
  );
}

function SideChatPreviewRow({
  badge,
  text,
  tone
}: {
  badge: string;
  text: string;
  tone: 'cyan' | 'blue' | 'mint';
}) {
  return (
    <div className={`preview-side-chat-row tone-${tone}`}>
      <AvatarPlaceholder />
      <div className="preview-side-chat-content">
        <small>{badge}</small>
        <strong>{text}</strong>
      </div>
    </div>
  );
}

function SideEventPreview({
  user,
  text,
  price,
  kind,
  width
}: {
  user: string;
  text: string;
  price?: string;
  kind: 'gift' | 'superchat';
  width?: number;
}) {
  return (
    <div
      className={`preview-side-event preview-side-${kind}`}
      style={width ? { width: `${width}px` } : undefined}
    >
      <AvatarPlaceholder />
      <div>
        <strong>{user}</strong>
        <small>{text}</small>
      </div>
      {price ? <em>{price}</em> : null}
    </div>
  );
}

export function DanmakuStylePreview({
  preset,
  layout,
  overlayMode,
  videoInfo,
  onLayoutChange
}: {
  preset: DanmakuStylePreset;
  layout: DanmakuStyleLayout;
  overlayMode: AppSettings['burnOverlayMode'];
  videoInfo?: { width?: number; height?: number } | null;
  onLayoutChange: (nextLayout: DanmakuStyleLayout) => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [stackHeight, setStackHeight] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewCanvas = useMemo(() => buildPreviewCanvas(videoInfo), [videoInfo?.height, videoInfo?.width]);
  const [previewFrame, setPreviewFrame] = useState<PreviewFrame>(() => ({
    centerX: PLAY_WIDTH / 2,
    centerY: PLAY_HEIGHT / 2,
    width: PLAY_WIDTH,
    height: PLAY_HEIGHT,
    scale: 1
  }));
  const effective = useMemo(
    () => buildEffectiveLayout(preset, layout, previewCanvas),
    [layout, preset, previewCanvas]
  );
  const fontScale = effective.boxFontSize / DEFAULT_LAYOUT.boxFontSize;
  const showCards = overlayMode === 'danmaku-gift';
  const sideStream = preset !== 'current';
  const estimatedCardHeight = sideStream
    ? Math.max(260, (showCards ? 460 : 300) * fontScale)
    : Math.max(170, 215 * fontScale);
  const measuredStackHeight = stackHeight > 0 ? stackHeight : estimatedCardHeight;
  const stackTop = clampNumber(
    effective.superChatBottom - measuredStackHeight,
    0,
    Math.max(0, previewCanvas.height - measuredStackHeight)
  );
  const canAdjust = sideStream || showCards;
  const previewGiftWidth = Math.min(
    Math.max(1, effective.superChatWidth * 0.88),
    Math.max(effective.boxFontSize * 8.8, effective.superChatWidth * 0.62)
  );

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    let animationFrame = 0;
    const measureFrame = () => {
      animationFrame = 0;
      const rect = element.getBoundingClientRect();
      const contained = buildContainedPreviewFrame(rect.width, rect.height, previewCanvas);
      setPreviewFrame((current) => {
        if (
          Math.abs(current.centerX - contained.centerX) < 0.1 &&
          Math.abs(current.centerY - contained.centerY) < 0.1 &&
          Math.abs(current.width - contained.width) < 0.1 &&
          Math.abs(current.height - contained.height) < 0.1
        ) {
          return current;
        }
        return contained;
      });
    };
    const scheduleMeasure = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measureFrame);
    };
    scheduleMeasure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(element);
    window.addEventListener('resize', scheduleMeasure);
    document.addEventListener('fullscreenchange', scheduleMeasure);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      document.removeEventListener('fullscreenchange', scheduleMeasure);
    };
  }, [previewCanvas.height, previewCanvas.width]);

  useEffect(() => {
    const element = stackRef.current;
    if (!element) {
      setStackHeight(0);
      return;
    }
    const updateHeight = () => {
      const nextHeight = Math.max(0, element.offsetHeight);
      setStackHeight((current) => (Math.abs(current - nextHeight) > 0.5 ? nextHeight : current));
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [effective.boxFontSize, effective.giftWidth, effective.superChatWidth, overlayMode, preset]);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === previewRef.current?.parentElement);
    };
    updateFullscreen();
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  function canvasPoint(clientX: number, clientY: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clampNumber(((clientX - rect.left) / rect.width) * previewCanvas.width, 0, previewCanvas.width),
      y: clampNumber(((clientY - rect.top) / rect.height) * previewCanvas.height, 0, previewCanvas.height)
    };
  }

  function updateLayoutFromCanvas(next: Partial<Pick<EffectiveLayout, 'panelLeft' | 'superChatBottom' | 'superChatWidth' | 'boxFontSize'>>) {
    const scale = Math.max(0.01, previewCanvas.scale);
    const updated = { ...layout };
    if (next.panelLeft !== undefined) {
      updated.panelLeft = Math.round(clampNumber(next.panelLeft / scale, 0, 2000));
    }
    if (next.superChatBottom !== undefined) {
      updated.superChatBottom = Math.round(
        clampNumber(PLAY_HEIGHT - (previewCanvas.height - next.superChatBottom) / scale, -4000, 4000)
      );
    }
    if (next.superChatWidth !== undefined) {
      updated.superChatWidth = Math.round(clampNumber(next.superChatWidth / scale, 220, 1200));
    }
    if (next.boxFontSize !== undefined) {
      updated.boxFontSize = Math.round(clampNumber(next.boxFontSize / scale, 12, 80));
    }
    onLayoutChange(updated);
  }

  function beginInteraction(event: ReactPointerEvent<HTMLElement>, kind: Interaction['kind']) {
    if (!canAdjust) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const measuredHeight = Math.max(1, stackRef.current?.offsetHeight || measuredStackHeight);
    stackRef.current?.setPointerCapture(event.pointerId);
    const nextInteraction = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: effective.panelLeft,
      startTop: stackTop,
      startWidth: effective.superChatWidth,
      startFontSize: effective.boxFontSize,
      cardHeight: measuredHeight
    };
    interactionRef.current = nextInteraction;
    setInteraction(nextInteraction);
  }

  function moveInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    const activeInteraction = interactionRef.current;
    if (!activeInteraction || activeInteraction.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY);
    const startPoint = canvasPoint(activeInteraction.startClientX, activeInteraction.startClientY);
    if (!point || !startPoint) return;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    if (activeInteraction.kind === 'move') {
      const panelLeft = clampNumber(activeInteraction.startLeft + dx, 0, previewCanvas.width - activeInteraction.startWidth);
      const top = clampNumber(
        activeInteraction.startTop + dy,
        0,
        Math.max(0, previewCanvas.height - activeInteraction.cardHeight)
      );
      updateLayoutFromCanvas({
        panelLeft: Math.round(panelLeft),
        superChatBottom: Math.round(top + activeInteraction.cardHeight)
      });
      return;
    }
    const maximumWidth = Math.max(1, previewCanvas.width - effective.panelLeft - Math.max(8, previewCanvas.scale * 12));
    const width = clampNumber(activeInteraction.startWidth + dx, Math.min(220, maximumWidth), maximumWidth);
    const boxFontSize = clampNumber(activeInteraction.startFontSize * (width / activeInteraction.startWidth), 12, 80);
    updateLayoutFromCanvas({
      superChatWidth: Math.round(width),
      boxFontSize: Math.round(boxFontSize)
    });
  }

  function endInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    const activeInteraction = interactionRef.current;
    if (activeInteraction?.pointerId === event.pointerId && stackRef.current?.hasPointerCapture(event.pointerId)) {
      stackRef.current.releasePointerCapture(event.pointerId);
    }
    interactionRef.current = null;
    setInteraction(null);
  }

  async function toggleFullscreen() {
    const host = previewRef.current?.parentElement;
    if (!host) return;
    try {
      if (document.fullscreenElement === host) {
        await document.exitFullscreen();
      } else {
        await host.requestFullscreen();
      }
    } catch {
      // Some embedded webviews may not expose the Fullscreen API. The preview
      // remains fully usable at its normal size in that case.
    }
  }

  const stackStyle = {
    left: `${effective.panelLeft}px`,
    top: `${stackTop}px`,
    width: `${effective.superChatWidth}px`,
    '--preview-font-size': `${effective.boxFontSize}px`,
    '--preview-avatar-size': `${Math.max(28, Math.round(effective.boxFontSize * 1.42))}px`
  } as CSSProperties;
  const canvasStyle = {
    left: `${previewFrame.centerX}px`,
    top: `${previewFrame.centerY}px`,
    transform: `translate(-50%, -50%) scale(${previewFrame.scale})`,
    '--preview-stage-width': `${previewCanvas.width}px`,
    '--preview-stage-height': `${previewCanvas.height}px`
  } as CSSProperties;

  return (
    <div className={`danmaku-style-preview preset-${preset}`} ref={previewRef}>
      <div
        className="danmaku-style-preview-canvas"
        ref={canvasRef}
        style={canvasStyle}
      >
        {!sideStream ? (
          <>
            <span
              className="preview-rolling-danmaku first"
              style={{
                top: `${effective.danmakuTop}px`,
                fontSize: `${effective.danmakuFontSize}px`,
                animationDuration: `${effective.danmakuDuration}s`
              }}
            >
              示例弹幕：录播顺利！
            </span>
            <span
              className="preview-rolling-danmaku second"
              style={{
                top: `${effective.danmakuTop + effective.danmakuLineHeight * 1.2}px`,
                fontSize: `${Math.max(12, effective.danmakuFontSize * 0.9)}px`,
                animationDuration: `${Math.min(20, effective.danmakuDuration * 1.08)}s`
              }}
            >
              第二条示例弹幕
            </span>
          </>
        ) : null}

        {sideStream ? (
          <div
            ref={stackRef}
            className={`preview-message-stack preview-side-stream ${interaction ? 'is-adjusting' : ''}`}
            style={stackStyle}
            onPointerMove={moveInteraction}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
          >
            <div
              className="preview-side-stream-content"
              onPointerDown={(event) => beginInteraction(event, 'move')}
              title="拖动调整侧栏位置"
            >
              <SideChatPreviewRow badge="LV.18" text="这是一条示例互动" tone="blue" />
              <SideChatPreviewRow badge="LV.25" text="点赞了直播间" tone="cyan" />
              {showCards ? (
                <SideEventPreview
                  user="观众 C"
                  text="赠送 小礼物 x1"
                  price="CNY 0.1"
                  kind="gift"
                  width={effective.giftWidth}
                />
              ) : null}
              <SideChatPreviewRow badge="LV.12" text="感谢你的支持～" tone="mint" />
              {showCards ? <SideEventPreview user="观众 E" text="加入了粉丝团" price="CNY 0.1" kind="superchat" /> : null}
            </div>
            <button
              className="preview-card-resize"
              type="button"
              aria-label="拖动调整侧栏大小"
              title="拖动调整侧栏宽度和字号"
              onPointerDown={(event) => beginInteraction(event, 'resize')}
            >
              <Maximize2 size={32} />
            </button>
          </div>
        ) : showCards ? (
          <div
            ref={stackRef}
            className={`preview-message-stack ${interaction ? 'is-adjusting' : ''}`}
            style={stackStyle}
            onPointerMove={moveInteraction}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
          >
            <div
              className="preview-card preview-superchat"
              onPointerDown={(event) => beginInteraction(event, 'move')}
              title="拖动调整互动卡片位置"
            >
              <span className="preview-card-grab" aria-hidden="true">
                <Move size={30} />
              </span>
              <strong>示例用户</strong>
              <small>SuperChat CNY 30</small>
              <p>直播顺利！</p>
            </div>
            <div
              className="preview-card preview-gift"
              style={{ width: `${previewGiftWidth}px` }}
              onPointerDown={(event) => beginInteraction(event, 'move')}
            >
              <strong>示例观众</strong>
              <small>赠送 小花花 x3</small>
            </div>
            <button
              className="preview-card-resize"
              type="button"
              aria-label="拖动调整互动卡片大小"
              title="拖动调整互动卡片宽度和字号"
              onPointerDown={(event) => beginInteraction(event, 'resize')}
            >
              <Maximize2 size={32} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="danmaku-preview-toolbar">
        <span>
          {sideStream ? '侧栏' : '卡片'} x{Math.round(effective.panelLeft)} · y{Math.round(effective.superChatBottom)} · 宽
          {Math.round(effective.superChatWidth)} · {previewCanvas.portrait ? '竖屏' : '横屏'} {previewCanvas.width}×{previewCanvas.height}
        </span>
        <button type="button" onClick={() => void toggleFullscreen()} title="全屏查看画面和弹幕">
          <Maximize2 size={14} />
          {isFullscreen ? '退出全屏' : '全屏预览'}
        </button>
        <button type="button" onClick={() => onLayoutChange({})}>
          <RotateCcw size={14} />
          恢复预设
        </button>
      </div>
    </div>
  );
}
