import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { CheckCircle2, FileCode2, FileVideo, FolderOpen, RefreshCw, Scissors, Square } from 'lucide-react';
import { recorder } from '../recorderClient';
import { JobProgress, PageHeader, PathLine } from '../components/common';
import type { AppSettings, AppState, ExportDraft, ExportResult, RecordingState } from '../types';
import { exportModeOptions, overlayModeOptions } from '../ui/options';
import {
  clampNumber,
  filename,
  formatFileSize,
  formatTimelineTime,
  mediaUrl,
  parseTimelineInput,
  recordingLabel
} from '../utils';

export function ExportPage({
  state,
  draft,
  result,
  busy,
  setDraft,
  selectRecording,
  prepareSubtitles,
  exportClip,
  run
}: {
  state: AppState;
  draft: ExportDraft;
  result: ExportResult | null;
  busy: string | null;
  setDraft: (draft: ExportDraft) => void;
  selectRecording: (recording: RecordingState) => void;
  prepareSubtitles: () => Promise<void>;
  exportClip: () => Promise<void>;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const recordings = state.recordings.filter((recording) => recording.cleanPath);
  const validRecordingCount = recordings.filter((recording) => recording.valid !== false).length;
  const selectedRecording = recordings.find((recording) => recording.cleanPath === draft.cleanPath);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [timelineDrag, setTimelineDrag] = useState<'start' | 'playhead' | 'end' | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const draftStart = parseTimelineInput(draft.startTime);
  const draftEnd = parseTimelineInput(draft.endTime);
  const recordingDuration = Number(selectedRecording?.durationSec || 0);
  const timelineDuration = mediaDuration > 0 ? mediaDuration : recordingDuration;
  const canUseTimeline = timelineDuration > 0;
  const timelineStart = Number.isFinite(draftStart) ? clampNumber(draftStart, 0, canUseTimeline ? timelineDuration : 0) : 0;
  const timelineEnd = Number.isFinite(draftEnd)
    ? clampNumber(draftEnd, 0, canUseTimeline ? timelineDuration : 0)
    : timelineDuration;
  const selectedValid = selectedRecording?.valid !== false;
  const canExport = Boolean(
    selectedValid && draft.cleanPath && Number.isFinite(draftStart) && Number.isFinite(draftEnd) && draftEnd > draftStart
  );
  const canPrepare = Boolean(canExport && draft.danmakuPath);
  const mediaSource = draft.cleanPath ? mediaUrl(draft.cleanPath) : '';
  const selectionLeft = canUseTimeline ? clampNumber((timelineStart / timelineDuration) * 100, 0, 100) : 0;
  const selectionWidth = canUseTimeline
    ? clampNumber(((timelineEnd - timelineStart) / timelineDuration) * 100, 0, 100 - selectionLeft)
    : 0;
  const playheadTime = canUseTimeline ? clampNumber(playbackTime, 0, timelineDuration) : 0;
  const playheadLeft = canUseTimeline ? clampNumber((playheadTime / timelineDuration) * 100, 0, 100) : 0;

  useEffect(() => {
    setMediaDuration(0);
    setPlaybackTime(0);
  }, [draft.cleanPath]);

  function updateTimelineStart(value: number) {
    const next = clampNumber(value, 0, Math.max(0, timelineEnd - 0.1));
    setDraft({ ...draft, startTime: formatTimelineTime(next) });
  }

  function updateTimelineEnd(value: number) {
    const next = clampNumber(value, Math.min(timelineStart + 0.1, timelineDuration || value), timelineDuration || value);
    setDraft({ ...draft, endTime: formatTimelineTime(next) });
  }

  function seekTimeline(value: number) {
    if (!canUseTimeline) {
      return;
    }
    const next = clampNumber(value, 0, timelineDuration);
    setPlaybackTime(next);
    if (videoRef.current) {
      videoRef.current.currentTime = next;
    }
  }

  function timelineValueFromPointer(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !canUseTimeline) {
      return 0;
    }
    return clampNumber(((clientX - rect.left) / rect.width) * timelineDuration, 0, timelineDuration);
  }

  function closestTimelineMarker(value: number): 'start' | 'playhead' | 'end' {
    const distances = [
      ['start', Math.abs(value - timelineStart)],
      ['playhead', Math.abs(value - playheadTime)],
      ['end', Math.abs(value - timelineEnd)]
    ] as const;
    return distances.reduce((best, item) => (item[1] < best[1] ? item : best))[0];
  }

  function updateTimelineMarker(marker: 'start' | 'playhead' | 'end', value: number) {
    if (marker === 'start') {
      updateTimelineStart(value);
      return;
    }
    if (marker === 'end') {
      updateTimelineEnd(value);
      return;
    }
    seekTimeline(value);
  }

  function startTimelineDrag(event: React.PointerEvent<HTMLElement>, marker?: 'start' | 'playhead' | 'end') {
    if (!canUseTimeline) {
      return;
    }
    const value = timelineValueFromPointer(event.clientX);
    const nextMarker = marker || closestTimelineMarker(value);
    timelineRef.current?.setPointerCapture(event.pointerId);
    setTimelineDrag(nextMarker);
    updateTimelineMarker(nextMarker, value);
  }

  function dragTimeline(event: React.PointerEvent<HTMLDivElement>) {
    if (!timelineDrag) {
      return;
    }
    updateTimelineMarker(timelineDrag, timelineValueFromPointer(event.clientX));
  }

  function endTimelineDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (timelineDrag) {
      timelineRef.current?.releasePointerCapture(event.pointerId);
    }
    setTimelineDrag(null);
  }

  return (
    <>
      <PageHeader
        title="剪辑导出"
        subtitle="选择录像，拖动入点和出点，再导出纯净片段或弹幕视频片段。"
        actions={
          <>
            <button
              className="wide-button"
              disabled={busy === 'scan-recordings'}
              onClick={() => run('scan-recordings', recorder.scanRecordings)}
            >
              <RefreshCw size={18} />
              刷新历史
            </button>
            <button className="wide-button" onClick={() => run('open-output', recorder.openOutputDir)}>
              <FolderOpen size={18} />
              打开目录
            </button>
          </>
        }
      />

      <section className="export-layout">
        <section className="inspector-card export-panel">
          <div className="card-heading">
            <div className="section-title">
              <FileVideo size={18} />
              <span>源文件</span>
            </div>
            <span className="source-count">共 {recordings.length} 个，可用 {validRecordingCount} 个</span>
          </div>

          <div className="recording-list">
            {recordings.length === 0 ? (
              <div className="empty-state compact-empty export-empty">
                <FileVideo size={34} />
                <span>输出目录里还没有可用录像。</span>
                <p>先完成一次录制，再点击刷新历史，这里会自动列出可导出的文件。</p>
              </div>
            ) : (
              recordings.map((recording) => (
                <button
                  key={recording.id || recording.cleanPath}
                  className={[
                    'recording-row',
                    recording.cleanPath === draft.cleanPath ? 'active' : '',
                    recording.valid === false ? 'invalid' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  disabled={recording.valid === false}
                  title={recording.valid === false ? recording.validReason || '文件不可用' : recording.cleanPath}
                  onClick={() => selectRecording(recording)}
                >
                  <span>{recordingLabel(recording)}</span>
                  <span className="recording-meta">
                    {filename(recording.cleanPath)}
                    {recording.fileSize ? ` · ${formatFileSize(recording.fileSize)}` : ''}
                    {recording.valid === false ? ` · ${recording.validReason || '不可用'}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>

          <label className="field">
            <span>原始录像文件</span>
            <input
              value={draft.cleanPath}
              onChange={(event) => setDraft({ ...draft, cleanPath: event.target.value })}
              placeholder="C:\Videos\xxx.clean.mp4"
            />
            <p className="field-help">从上面的历史录像选择时通常会自动填好。</p>
          </label>

          <label className="field">
            <span>弹幕记录文件</span>
            <input
              value={draft.danmakuPath}
              onChange={(event) => setDraft({ ...draft, danmakuPath: event.target.value })}
              placeholder="C:\Videos\xxx.danmaku.jsonl"
            />
            <p className="field-help">导出弹幕视频或字幕时需要这个文件；纯净片段可以不填。</p>
          </label>

          <label className="field">
            <span>弹幕样式文件</span>
            <input
              value={draft.cssPath}
              onChange={(event) => setDraft({ ...draft, cssPath: event.target.value })}
              placeholder="留空则自动生成 .danmaku.css"
            />
            <p className="field-help">留空时会自动生成默认样式。</p>
          </label>
        </section>

        <section className="inspector-card export-panel">
          <div className="card-heading">
            <div className="section-title">
              <Scissors size={18} />
              <span>片段</span>
            </div>
          </div>

          <div className="clip-preview">
            {mediaSource ? (
              <video
                ref={videoRef}
                key={draft.cleanPath}
                src={mediaSource}
                controls
                preload="metadata"
                  onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    if (!Number.isFinite(duration) || duration <= 0) {
                      return;
                    }
                    setMediaDuration(duration);
                    setPlaybackTime(event.currentTarget.currentTime || 0);
                    const currentStart = parseTimelineInput(draft.startTime);
                    const currentEnd = parseTimelineInput(draft.endTime);
                    const nextStart =
                      Number.isFinite(currentStart) && currentStart >= 0 && currentStart < duration ? currentStart : 0;
                    const needsStartUpdate = nextStart !== currentStart;
                    const needsEndUpdate =
                      !Number.isFinite(currentEnd) || currentEnd > duration || currentEnd <= nextStart;
                    if (needsStartUpdate || needsEndUpdate) {
                      setDraft({
                        ...draft,
                        startTime: needsStartUpdate ? formatTimelineTime(nextStart) : draft.startTime,
                        endTime: needsEndUpdate ? formatTimelineTime(duration) : draft.endTime
                      });
                    }
                  }}
                  onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime || 0)}
                  onSeeking={(event) => setPlaybackTime(event.currentTarget.currentTime || 0)}
                />
              ) : (
              <div className="clip-preview-empty">
                <FileVideo size={38} />
                <span>选择录像后预览</span>
              </div>
            )}
          </div>

          <div className="timeline-editor">
            <div className="timeline-summary">
              <span>{formatTimelineTime(0)}</span>
              <strong>{formatTimelineTime(Math.max(0, timelineEnd - timelineStart))}</strong>
              <span>{formatTimelineTime(timelineDuration)}</span>
            </div>
            <div
              ref={timelineRef}
              className={`cut-timeline ${canUseTimeline ? '' : 'disabled'}`}
              onPointerDown={(event) => startTimelineDrag(event)}
              onPointerMove={dragTimeline}
              onPointerUp={endTimelineDrag}
              onPointerCancel={endTimelineDrag}
            >
              <div className="cut-selection" style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }} />
              <button
                className="cut-marker start"
                type="button"
                style={{ left: `${selectionLeft}%` }}
                disabled={!canUseTimeline}
                aria-label="入点"
                title="入点"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startTimelineDrag(event, 'start');
                }}
              />
              <button
                className="cut-marker playhead"
                type="button"
                style={{ left: `${playheadLeft}%` }}
                disabled={!canUseTimeline}
                aria-label="播放点"
                title="播放点"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startTimelineDrag(event, 'playhead');
                }}
              />
              <button
                className="cut-marker end"
                type="button"
                style={{ left: `${selectionLeft + selectionWidth}%` }}
                disabled={!canUseTimeline}
                aria-label="出点"
                title="出点"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startTimelineDrag(event, 'end');
                }}
              />
            </div>
            <div className="cut-time-row">
              <label>
                <span>入点</span>
                <input
                  value={draft.startTime}
                  onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                  placeholder="00:12:30.5"
                />
              </label>
              <label>
                <span>播放</span>
                <input value={formatTimelineTime(playheadTime)} readOnly />
              </label>
              <label>
                <span>出点</span>
                <input
                  value={draft.endTime}
                  onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                  placeholder="00:18:00"
                />
              </label>
            </div>
          </div>

          <label className="field">
            <span>输出目录</span>
            <input
              value={draft.outputDir}
              onChange={(event) => setDraft({ ...draft, outputDir: event.target.value })}
              placeholder={state.settings.outputDir}
            />
          </label>

          <div className="settings-grid">
            <label className="field">
              <span>导出版本</span>
              <select
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as ExportDraft['mode'] })}
              >
                {exportModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>烧录内容</span>
              <select
                value={draft.overlayMode}
                onChange={(event) =>
                  setDraft({ ...draft, overlayMode: event.target.value as AppSettings['burnOverlayMode'] })
                }
              >
                {overlayModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="split-buttons export-actions">
            <button
              className="wide-button fill"
              disabled={!canPrepare || busy === 'export-subtitles'}
              onClick={prepareSubtitles}
            >
              <FileCode2 size={18} />
              只生成字幕
            </button>
            <button
              className="wide-button fill primary"
              disabled={!canExport || busy === 'export-clip'}
              onClick={exportClip}
            >
              <Scissors size={18} />
              导出片段
            </button>
          </div>
          {state.exportProgress ? <JobProgress progress={state.exportProgress} /> : null}
          {state.exportProgress?.status === 'running' ? (
            <button
              className="wide-button fill danger"
              type="button"
              disabled={busy === 'export-cancel'}
              onClick={() => run('export-cancel', recorder.cancelExport)}
            >
              <Square size={17} />
              中断当前导出
            </button>
          ) : null}
        </section>

        <section className="inspector-card export-panel export-result-panel">
          <div className="card-heading">
            <div className="section-title">
              <CheckCircle2 size={18} />
              <span>结果</span>
            </div>
          </div>
          {result ? (
            <div className="result-lines">
              <PathLine label="输出视频" value={result.outputPath || ''} />
              <PathLine label="样式 CSS" value={result.cssPath || ''} />
              <PathLine label="字幕 ASS" value={result.assPath || ''} />
              {typeof result.eventCount === 'number' ? (
                <PathLine label="事件数量" value={String(result.eventCount)} />
              ) : null}
              <button
                className="wide-button fill"
                type="button"
                disabled={!result.outputPath}
                onClick={() => run('open-result-dir', () => recorder.openPathDir(result.outputPath || ''))}
              >
                <FolderOpen size={18} />
                打开所在目录
              </button>
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <Scissors size={36} />
              <span>选择录像和时间段后开始导出</span>
            </div>
          )}
        </section>
      </section>
    </>
  );
}
