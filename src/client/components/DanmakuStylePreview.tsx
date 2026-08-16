import { Maximize2, Move, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AppSettings, DanmakuStyleLayout, DanmakuStylePreset } from '../types';
import { danmakuStylePresets } from '../ui/options';
import { clampNumber } from '../utils';

const PLAY_WIDTH = 1920;
const PLAY_HEIGHT = 1080;
const DEFAULT_LAYOUT = {
  panelLeft: 5,
  superChatBottom: 1070,
  superChatWidth: 375,
  boxFontSize: 29,
  danmakuTop: 36,
  danmakuFontSize: 38,
  danmakuLineHeight: 46
};

type EffectiveLayout = typeof DEFAULT_LAYOUT;
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

function buildEffectiveLayout(preset: DanmakuStylePreset, layout: DanmakuStyleLayout): EffectiveLayout {
  const style = danmakuStylePresets[preset]?.style || {};
  return {
    panelLeft: clampNumber(numberValue(layout.panelLeft ?? style.panelLeft, DEFAULT_LAYOUT.panelLeft), 0, 2000),
    superChatBottom: clampNumber(
      numberValue(layout.superChatBottom ?? style.superChatBottom, DEFAULT_LAYOUT.superChatBottom),
      0,
      4000
    ),
    superChatWidth: clampNumber(
      numberValue(layout.superChatWidth ?? style.superChatWidth, DEFAULT_LAYOUT.superChatWidth),
      220,
      1200
    ),
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
    )
  };
}

function SideChatPreviewRow({
  user,
  badge,
  text,
  tone
}: {
  user: string;
  badge: string;
  text: string;
  tone: 'cyan' | 'blue' | 'mint';
}) {
  return (
    <div className={`preview-side-chat-row tone-${tone}`}>
      <span className="preview-side-avatar" aria-hidden="true">
        {user.slice(0, 1)}
      </span>
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
  kind
}: {
  user: string;
  text: string;
  price?: string;
  kind: 'gift' | 'superchat';
}) {
  return (
    <div className={`preview-side-event preview-side-${kind}`}>
      <span className="preview-side-avatar" aria-hidden="true">
        {user.slice(0, 1)}
      </span>
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
  onLayoutChange
}: {
  preset: DanmakuStylePreset;
  layout: DanmakuStyleLayout;
  overlayMode: AppSettings['burnOverlayMode'];
  onLayoutChange: (nextLayout: DanmakuStyleLayout) => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const effective = useMemo(() => buildEffectiveLayout(preset, layout), [layout, preset]);
  const fontScale = effective.boxFontSize / DEFAULT_LAYOUT.boxFontSize;
  const showCards = overlayMode === 'danmaku-gift';
  const sideStream = preset !== 'current';
  const estimatedCardHeight = sideStream
    ? Math.max(196, (showCards ? 520 : 340) * fontScale)
    : Math.max(114, 150 * fontScale);
  const stackTop = clampNumber(effective.superChatBottom - estimatedCardHeight, 0, PLAY_HEIGHT - 34);
  const stackWidthPercent = (effective.superChatWidth / PLAY_WIDTH) * 100;
  const stackLeftPercent = (effective.panelLeft / PLAY_WIDTH) * 100;
  const stackTopPercent = (stackTop / PLAY_HEIGHT) * 100;
  const canAdjust = sideStream || showCards;

  function canvasPoint(clientX: number, clientY: number) {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * PLAY_WIDTH,
      y: ((clientY - rect.top) / rect.height) * PLAY_HEIGHT,
      scaleX: PLAY_WIDTH / rect.width,
      scaleY: PLAY_HEIGHT / rect.height
    };
  }

  function beginInteraction(event: ReactPointerEvent<HTMLElement>, kind: Interaction['kind']) {
    if (!canAdjust) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const previewRect = previewRef.current?.getBoundingClientRect();
    const stackRect = stackRef.current?.getBoundingClientRect();
    const measuredHeight =
      previewRect && stackRect && previewRect.height > 0
        ? (stackRect.height / previewRect.height) * PLAY_HEIGHT
        : estimatedCardHeight;
    stackRef.current?.setPointerCapture(event.pointerId);
    const nextInteraction = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: effective.panelLeft,
      startTop: clampNumber(effective.superChatBottom - measuredHeight, 0, PLAY_HEIGHT - measuredHeight),
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
    if (!point) return;
    const startPoint = canvasPoint(activeInteraction.startClientX, activeInteraction.startClientY);
    if (!startPoint) return;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    if (activeInteraction.kind === 'move') {
      const panelLeft = clampNumber(activeInteraction.startLeft + dx, 0, PLAY_WIDTH - activeInteraction.startWidth);
      const top = clampNumber(activeInteraction.startTop + dy, 0, PLAY_HEIGHT - activeInteraction.cardHeight);
      onLayoutChange({
        ...layout,
        panelLeft: Math.round(panelLeft),
        superChatBottom: Math.round(top + activeInteraction.cardHeight)
      });
      return;
    }
    const width = clampNumber(activeInteraction.startWidth + dx, 220, 1200);
    const boxFontSize = clampNumber(activeInteraction.startFontSize * (width / activeInteraction.startWidth), 12, 80);
    onLayoutChange({
      ...layout,
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

  return (
    <div className={`danmaku-style-preview preset-${preset}`} ref={previewRef}>
      {!sideStream ? (
        <>
          <span
            className="preview-rolling-danmaku first"
            style={{
              top: `${(effective.danmakuTop / PLAY_HEIGHT) * 100}%`,
              fontSize: `${Math.max(11, effective.danmakuFontSize * 0.34)}px`
            }}
          >
            这个样式很适合录播！
          </span>
          <span
            className="preview-rolling-danmaku second"
            style={{
              top: `${((effective.danmakuTop + effective.danmakuLineHeight * 1.2) / PLAY_HEIGHT) * 100}%`,
              fontSize: `${Math.max(10, effective.danmakuFontSize * 0.31)}px`
            }}
          >
            弹幕预览 ✨
          </span>
        </>
      ) : null}

      {sideStream ? (
        <div
          ref={stackRef}
          className={`preview-message-stack preview-side-stream ${interaction ? 'is-adjusting' : ''}`}
          style={{ left: `${stackLeftPercent}%`, top: `${stackTopPercent}%`, width: `${stackWidthPercent}%` }}
          onPointerMove={moveInteraction}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
        >
          <div
            className="preview-side-stream-content"
            onPointerDown={(event) => beginInteraction(event, 'move')}
            title="拖动调整侧边互动流的位置"
          >
            <SideChatPreviewRow user="加勒比海没有香" badge="加油比海没有香" text="开播吧，胖胖小紫！" tone="blue" />
            <SideChatPreviewRow user="千里当甘甘" badge="千里当甘甘" text="点赞了直播间 30 次" tone="cyan" />
            {showCards ? <SideEventPreview user="影帝紫定能行" text="投喂 足迹 x1" price="CNY0.1" kind="gift" /> : null}
            <SideChatPreviewRow user="小紫的贤鱼" badge="小紫的贤鱼" text="感谢你的足迹，啾咪～" tone="mint" />
            {showCards ? <SideEventPreview user="影帝紫定能行" text="投喂 粉丝团灯牌 x1" price="CNY0.1" kind="superchat" /> : null}
          </div>
          <button
            className="preview-card-resize"
            type="button"
            aria-label="拖动调整侧边互动流大小"
            title="拖动调整侧边互动流的宽度和字号"
            onPointerDown={(event) => beginInteraction(event, 'resize')}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      ) : showCards ? (
        <div
          ref={stackRef}
          className={`preview-message-stack ${interaction ? 'is-adjusting' : ''}`}
          style={{ left: `${stackLeftPercent}%`, top: `${stackTopPercent}%`, width: `${stackWidthPercent}%` }}
          onPointerMove={moveInteraction}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
        >
          <div
            className="preview-card preview-superchat"
            onPointerDown={(event) => beginInteraction(event, 'move')}
            title="拖动调整互动卡片的位置"
          >
            <span className="preview-card-grab" aria-hidden="true">
              <Move size={14} />
            </span>
            <strong>小电视同学</strong>
            <small>SuperChat CNY 30</small>
            <p>直播顺利！</p>
          </div>
          <div className="preview-card preview-gift" onPointerDown={(event) => beginInteraction(event, 'move')}>
            <strong>录播观众</strong>
            <small>赠送 小花花 x3</small>
          </div>
          <button
            className="preview-card-resize"
            type="button"
            aria-label="拖动调整互动卡片大小"
            title="拖动调整互动卡片的宽度和字号"
            onPointerDown={(event) => beginInteraction(event, 'resize')}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      ) : null}

      <div className="danmaku-preview-toolbar">
        <span>
          {sideStream ? '侧栏' : '卡片'}：x {Math.round(effective.panelLeft)} · y {Math.round(effective.superChatBottom)} · 宽{' '}
          {Math.round(effective.superChatWidth)}
        </span>
        <button type="button" onClick={() => onLayoutChange({})}>
          <RotateCcw size={14} />
          恢复预设位置
        </button>
      </div>
    </div>
  );
}
