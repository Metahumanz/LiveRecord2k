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
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const effective = useMemo(() => buildEffectiveLayout(preset, layout), [layout, preset]);
  const fontScale = effective.boxFontSize / DEFAULT_LAYOUT.boxFontSize;
  const estimatedCardHeight = Math.max(114, 150 * fontScale);
  const stackTop = clampNumber(effective.superChatBottom - estimatedCardHeight, 0, PLAY_HEIGHT - 34);
  const stackWidthPercent = (effective.superChatWidth / PLAY_WIDTH) * 100;
  const stackLeftPercent = (effective.panelLeft / PLAY_WIDTH) * 100;
  const stackTopPercent = (stackTop / PLAY_HEIGHT) * 100;
  const showCards = overlayMode === 'danmaku-gift';
  const rollingIncludesUsername = preset === 'h5-card' || preset === 'bubble';

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
    if (!showCards) return;
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
    setInteraction({
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: effective.panelLeft,
      startTop: clampNumber(effective.superChatBottom - measuredHeight, 0, PLAY_HEIGHT - measuredHeight),
      startWidth: effective.superChatWidth,
      startFontSize: effective.boxFontSize,
      cardHeight: measuredHeight
    });
  }

  function moveInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const startPoint = canvasPoint(interaction.startClientX, interaction.startClientY);
    if (!startPoint) return;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    if (interaction.kind === 'move') {
      const panelLeft = clampNumber(interaction.startLeft + dx, 0, PLAY_WIDTH - interaction.startWidth);
      const top = clampNumber(interaction.startTop + dy, 0, PLAY_HEIGHT - interaction.cardHeight);
      onLayoutChange({
        ...layout,
        panelLeft: Math.round(panelLeft),
        superChatBottom: Math.round(top + interaction.cardHeight)
      });
      return;
    }
    const width = clampNumber(interaction.startWidth + dx, 220, 1200);
    const boxFontSize = clampNumber(interaction.startFontSize * (width / interaction.startWidth), 12, 80);
    onLayoutChange({
      ...layout,
      superChatWidth: Math.round(width),
      boxFontSize: Math.round(boxFontSize)
    });
  }

  function endInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    if (interaction?.pointerId === event.pointerId && stackRef.current?.hasPointerCapture(event.pointerId)) {
      stackRef.current.releasePointerCapture(event.pointerId);
    }
    setInteraction(null);
  }

  return (
    <div className={`danmaku-style-preview preset-${preset}`} ref={previewRef}>
      <span
        className="preview-rolling-danmaku first"
        style={{ top: `${(effective.danmakuTop / PLAY_HEIGHT) * 100}%`, fontSize: `${Math.max(11, effective.danmakuFontSize * 0.34)}px` }}
      >
        {rollingIncludesUsername ? '小紫 · ' : ''}这个样式很适合录播！
      </span>
      <span
        className="preview-rolling-danmaku second"
        style={{
          top: `${((effective.danmakuTop + effective.danmakuLineHeight * 1.2) / PLAY_HEIGHT) * 100}%`,
          fontSize: `${Math.max(10, effective.danmakuFontSize * 0.31)}px`
        }}
      >
        {rollingIncludesUsername ? '观众A · ' : ''}弹幕预览 ✨
      </span>

      {showCards ? (
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
          卡片：x {Math.round(effective.panelLeft)} · y {Math.round(effective.superChatBottom)} · 宽 {Math.round(effective.superChatWidth)}
        </span>
        <button type="button" onClick={() => onLayoutChange({})}>
          <RotateCcw size={14} />
          恢复预设位置
        </button>
      </div>
    </div>
  );
}
