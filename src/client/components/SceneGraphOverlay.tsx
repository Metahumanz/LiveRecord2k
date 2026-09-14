import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SceneAnimation, SceneGraph, SceneObject } from '../types';

type EvaluatedSceneObject = {
  visible: boolean;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
};

function numberValue(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function pointValue(value: SceneAnimation['from'] | SceneAnimation['to'], fallbackX = 1, fallbackY = 1) {
  if (typeof value === 'number') return { x: value, y: value };
  return {
    x: numberValue(value?.x, fallbackX),
    y: numberValue(value?.y, fallbackY)
  };
}

function animationValue(animation: SceneAnimation, time: number) {
  const start = numberValue(animation.start);
  const end = Math.max(start + 0.0001, numberValue(animation.end, start + 0.0001));
  const progress = Math.min(1, Math.max(0, (time - start) / (end - start)));
  if (animation.type === 'Fade') {
    return numberValue(animation.from) + (numberValue(animation.to) - numberValue(animation.from)) * progress;
  }
  const fallback = animation.type === 'Scale' ? 1 : 0;
  const from = pointValue(animation.from, fallback, fallback);
  const to = pointValue(animation.to, fallback, fallback);
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress
  };
}

export function evaluateSceneObject(object: SceneObject, time: number): EvaluatedSceneObject {
  const visible = time >= numberValue(object.start) && time <= numberValue(object.end);
  const output: EvaluatedSceneObject = {
    visible,
    x: numberValue(object.frame.x),
    y: numberValue(object.frame.y),
    scaleX: 1,
    scaleY: 1,
    opacity: numberValue(object.style?.opacity, 1)
  };
  if (!visible) return output;
  const animations = (object.animations || [])
    .slice()
    .sort((left, right) => numberValue(left.start) - numberValue(right.start) || numberValue(left.end) - numberValue(right.end));
  for (const animation of animations) {
    if (time < numberValue(animation.start)) continue;
    const value = animationValue(animation, Math.min(time, numberValue(animation.end)));
    if (animation.type === 'Move' && typeof value !== 'number') {
      output.x = value.x;
      output.y = value.y;
    } else if (animation.type === 'Scale' && typeof value !== 'number') {
      output.scaleX *= value.x;
      output.scaleY *= value.y;
    } else if (animation.type === 'Fade' && typeof value === 'number') {
      output.opacity *= value;
    }
  }
  return output;
}

function shadowStyle(style: Record<string, unknown> | undefined) {
  const shadow = style?.shadow;
  if (!shadow || typeof shadow !== 'object') return undefined;
  const source = shadow as Record<string, unknown>;
  const opacity = Math.min(1, Math.max(0, numberValue(source.opacity, 0)));
  if (opacity <= 0) return undefined;
  const color = stringValue(source.color, '#000000');
  return numberValue(source.offsetX) + 'px ' + numberValue(source.offsetY) + 'px ' + numberValue(source.blur) + 'px ' + color + Math.round(opacity * 255).toString(16).padStart(2, '0');
}

function cornerRadiusStyle(style: Record<string, unknown> | undefined) {
  const radius = Math.max(0, numberValue(style?.cornerRadius));
  const corners = style?.corners;
  if (!corners || typeof corners !== 'object') return radius + 'px';
  const source = corners as Record<string, unknown>;
  const value = (corner: string) => (source[corner] === false ? 0 : radius) + 'px';
  return [value('tl'), value('tr'), value('br'), value('bl')].join(' ');
}

function textAt(object: SceneObject, time: number) {
  const props = object.props || {};
  let value = stringValue(props.text);
  const keyframes = Array.isArray(props.textKeyframes) ? props.textKeyframes : [];
  for (const keyframe of keyframes) {
    if (!keyframe || typeof keyframe !== 'object') continue;
    const source = keyframe as Record<string, unknown>;
    if (numberValue(source.time, Number.POSITIVE_INFINITY) <= time + 0.0001) value = stringValue(source.text);
  }
  return value;
}

function nodeStyle(object: SceneObject, state: EvaluatedSceneObject): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width: object.frame.width,
    height: object.frame.height,
    opacity: Math.max(0, Math.min(1, state.opacity)),
    zIndex: Math.round(numberValue(object.zIndex)),
    transform: 'translate(' + state.x + 'px, ' + state.y + 'px) scale(' + state.scaleX + ', ' + state.scaleY + ')',
    transformOrigin: 'top left',
    pointerEvents: 'none'
  };
}

function SceneNode({
  object,
  state,
  assets,
  time
}: {
  object: SceneObject;
  state: EvaluatedSceneObject;
  assets: Map<string, SceneGraph['assets'][number]>;
  time: number;
}) {
  const style = object.style || {};
  const props = object.props || {};
  const base = nodeStyle(object, state);
  if (object.type === 'Text') {
    return (
      <div
        key={object.id}
        className="scene-graph-text"
        style={{
          ...base,
          color: stringValue(style.fill, '#ffffff'),
          fontFamily: stringValue(props.fontFamily, 'Arial'),
          fontSize: numberValue(props.fontSize, 20),
          fontWeight: numberValue(props.fontWeight, 400),
          lineHeight: numberValue(props.lineHeight, numberValue(props.fontSize, 20) * 1.2) + 'px',
          whiteSpace: 'pre-wrap',
          WebkitTextStroke: numberValue(style.strokeWidth) + 'px ' + stringValue(style.stroke, 'transparent'),
          textShadow: shadowStyle(style)
        }}
      >
        {textAt(object, time)}
      </div>
    );
  }
  if (object.type === 'Avatar') {
    const asset = assets.get(stringValue(props.assetId));
    const borderWidth = numberValue(style.borderWidth);
    return (
      <div
        key={object.id}
        className="scene-graph-avatar"
        style={{
          ...base,
          borderRadius: '50%',
          boxSizing: 'border-box',
          background: stringValue(style.fill, '#777'),
          overflow: 'hidden',
          border: borderWidth ? borderWidth + 'px solid ' + stringValue(style.borderColor, '#fff') : undefined,
          boxShadow: shadowStyle(style)
        }}
      >
        {asset?.src || asset?.url ? (
          <img
            src={asset.src || asset.url}
            alt=""
            draggable={false}
            onError={(event) => {
              const fallback = asset.fallbackSrc || asset.url;
              if (fallback && event.currentTarget.src !== new URL(fallback, window.location.href).href) {
                event.currentTarget.src = fallback;
              } else {
                event.currentTarget.style.display = 'none';
              }
            }}
          />
        ) : (
          <span>{stringValue(props.fallbackLabel, '观')}</span>
        )}
      </div>
    );
  }
  if (!['Rect', 'Card', 'SuperChat', 'Gift'].includes(object.type)) return null;
  return (
    <div
      key={object.id}
      className={'scene-graph-shape scene-graph-' + object.type.toLowerCase()}
      style={{
        ...base,
        background: stringValue(style.fill, '#ffffff'),
        borderRadius: cornerRadiusStyle(style),
        boxShadow: shadowStyle(style),
        overflow: 'hidden'
      }}
    />
  );
}

export function SceneGraphOverlay({ scene, time }: { scene: SceneGraph | null; time: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setHostSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const assets = useMemo(() => new Map((scene?.assets || []).map((asset) => [asset.id, asset])), [scene]);
  if (!scene || scene.canvas.width < 1 || scene.canvas.height < 1) return null;
  const scale = Math.max(
    0.001,
    Math.min(
      hostSize.width > 0 ? hostSize.width / scene.canvas.width : 1,
      hostSize.height > 0 ? hostSize.height / scene.canvas.height : 1
    )
  );
  const visible = scene.objects
    .filter((object) => object.render !== false)
    .map((object) => ({ object, state: evaluateSceneObject(object, time) }))
    .filter((entry) => entry.state.visible)
    .sort((left, right) => numberValue(left.object.zIndex) - numberValue(right.object.zIndex) || left.object.id.localeCompare(right.object.id));

  return (
    <div ref={hostRef} className="scene-graph-overlay" aria-hidden="true">
      <div
        className="scene-graph-stage"
        style={{
          width: scene.canvas.width,
          height: scene.canvas.height,
          transform: 'translate(-50%, -50%) scale(' + scale + ')'
        }}
      >
        {visible.map(({ object, state }) => (
          <SceneNode key={object.id} object={object} state={state} assets={assets} time={time} />
        ))}
      </div>
    </div>
  );
}
