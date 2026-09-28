import { CircleAlert, ListChecks, Merge, X, Square, RotateCcw } from 'lucide-react';
import type { RecordingState, RoomState } from '../types';
import { filename, formatDateTime, formatTimelineTime } from '../utils';
import { JobProgress } from './common';

const MAX_SAME_LIVE_GAP_MS = 15 * 60 * 1000;
const MAX_SAME_LIVE_OVERLAP_MS = 2 * 60 * 1000;

export type SameLiveMergeSuggestion = {
  room: RoomState;
  recordings: RecordingState[];
  gapsSec: number[];
};

// Time adjacency is a suggestion, not proof of a single broadcast. The user
// checks the exact source list before the existing manual merge API is called.
export function getSameLiveMergeSuggestions(recordings: RecordingState[], rooms: RoomState[]): SameLiveMergeSuggestion[] {
  const mergedSources = new Set(recordings.flatMap(recording => recording.mergedFrom || []).map(path => path.toLowerCase()));
  const byRoom = new Map<string, { room: RoomState; recordings: RecordingState[] }>();
  for (const recording of recordings) {
    const room = rooms.find(candidate => [candidate.id, candidate.realRoomId, candidate.shortId]
      .some(id => id != null && String(id) === String(recording.roomId || '').trim()));
    const startedAt = Number(recording.startedAt);
    const durationSec = Number(recording.durationSec);
    if (!room || recording.valid === false || ['capturing', 'finalizing'].includes(recording.containerStage || '') ||
      mergedSources.has(recording.cleanPath.toLowerCase()) ||
      !Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) continue;
    const group = byRoom.get(room.id) || { room, recordings: [] };
    group.recordings.push(recording);
    byRoom.set(room.id, group);
  }
  const suggestions: SameLiveMergeSuggestion[] = [];
  for (const { room, recordings: roomRecordings } of byRoom.values()) {
    roomRecordings.sort((a, b) => a.startedAt - b.startedAt || a.cleanPath.localeCompare(b.cleanPath));
    let current: RecordingState[] = [];
    let gapsSec: number[] = [];
    let currentSessionId = '';
    const flush = () => {
      if (current.length >= 2) suggestions.push({ room, recordings: current, gapsSec });
      current = [];
      gapsSec = [];
      currentSessionId = '';
    };
    for (const recording of roomRecordings) {
      const previous = current[current.length - 1];
      const gapMs = previous ? recording.startedAt - previous.startedAt - Number(previous.durationSec) * 1000 : 0;
      const differentSession = currentSessionId && recording.liveSessionId &&
        currentSessionId !== recording.liveSessionId;
      const overlappingMergedOutput = (previous?.mergedFrom?.length || recording.mergedFrom?.length) && gapMs < -2000;
      if (previous && (differentSession || current.length >= 160 ||
        overlappingMergedOutput || gapMs < -MAX_SAME_LIVE_OVERLAP_MS || gapMs > MAX_SAME_LIVE_GAP_MS)) flush();
      if (current.length) gapsSec.push(gapMs / 1000);
      current.push(recording);
      currentSessionId ||= recording.liveSessionId || '';
    }
    flush();
  }
  return suggestions.sort((a, b) => b.recordings[0].startedAt - a.recordings[0].startedAt);
}

export function SameLiveMergeSuggestions({ suggestions, recordings, rooms, busy, onChoose }: {
  suggestions: SameLiveMergeSuggestion[];
  recordings: RecordingState[];
  rooms: RoomState[];
  busy: boolean;
  onChoose: (paths: string[]) => void;
}) {
  if (!suggestions.length) return null;
  return <div className="same-live-suggestions">
    <div className="same-live-heading"><strong>疑似同场直播</strong><span>同房间、已知会话不冲突、相邻间隔不超过 15 分钟</span></div>
    {suggestions.map(suggestion => {
      const paths = suggestion.recordings.map(recording => recording.cleanPath);
      const { reason } = getManualMergeSelection(recordings, paths, rooms);
      const first = suggestion.recordings[0];
      const last = suggestion.recordings[suggestion.recordings.length - 1];
      return <div className="same-live-suggestion" key={paths.join('\u0000')}>
        <div className="same-live-summary">
          <strong>{suggestion.room.anchor || suggestion.room.title || suggestion.room.id} · {paths.length} 段</strong>
          <span>{formatDateTime(first.startedAt)} → {formatDateTime(last.startedAt + Number(last.durationSec) * 1000)}</span>
        </div>
        <button type="button" className="wide-button primary" disabled={busy || Boolean(reason)}
          title={reason || '先核对片段和删除源文件选项，再确认合并'} onClick={() => onChoose(paths)}>
          <Merge size={16} />一键合并
        </button>
        {reason ? <span className="same-live-reason">{reason}</span> : null}
      </div>;
    })}
    <p className="field-help">仅按时间推测，可能跨越两次开播；提交前请核对每段录像。</p>
  </div>;
}

export function MergeConfirmation({ selected, reason, deleteSources, busy, onDeleteSourcesChange, onCancel, onConfirm }: {
  selected: RecordingState[];
  reason: string;
  deleteSources: boolean;
  busy: boolean;
  onDeleteSourcesChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="merge-confirm-backdrop"><div className="merge-confirmation" role="dialog" aria-modal="true"
    aria-labelledby="merge-confirm-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel(); }}>
    <h3 id="merge-confirm-title">确认合并 {selected.length} 段录像</h3>
    <p className="field-help">请核对是否属于同一场直播。系统会按开始时间排序；时间相近不能保证是同场。</p>
    <ol className="merge-confirm-list">{selected.map((recording, index) => {
      const previous = selected[index - 1];
      const gapSec = previous ? (recording.startedAt - previous.startedAt) / 1000 - Number(previous.durationSec || 0) : null;
      return <li key={recording.cleanPath}>
        <span>{formatDateTime(recording.startedAt)} · {formatTimelineTime(Number(recording.durationSec || 0))}</span>
        <strong title={recording.cleanPath}>{filename(recording.cleanPath)}</strong>
        {gapSec != null ? <small>{gapSec >= 0 ? `与上一段间隔 ${formatTimelineTime(gapSec)}` : `与上一段重叠 ${formatTimelineTime(-gapSec)}`}</small> : null}
      </li>;
    })}</ol>
    <label className="field-help merge-confirm-delete">
      <input type="checkbox" checked={deleteSources} disabled={busy}
        onChange={event => onDeleteSourcesChange(event.target.checked)} />
      合并验证成功后删除所选源录像及配套弹幕、头像和 Scene 文件
    </label>
    {reason ? <div className="warning-line" role="status"><CircleAlert size={16} /><span>{reason}</span></div> : null}
    <div className="split-buttons merge-confirm-actions">
      <button type="button" className="wide-button" disabled={busy} onClick={onCancel} autoFocus>返回核对</button>
      <button type="button" className="wide-button primary" disabled={busy || Boolean(reason)} onClick={onConfirm}>
        <Merge size={18} />{busy ? '正在提交合并' : `确认合并 ${selected.length} 段`}
      </button>
    </div>
  </div></div>;
}

export function ManualMergeProgress({ rooms, busy, onCancel, onRetry }: {
  rooms: RoomState[];
  busy: Set<string>;
  onCancel: (roomId: string, jobId: string) => void;
  onRetry: (roomId: string) => void;
}) {
  return <>{rooms.filter(room => room.mergeProgress && (room.mergeProgress.manual ||
    ['queued', 'running', 'retrying'].includes(room.mergeProgress.status))).map(room => {
    const progress = room.mergeProgress!;
    const active = ['queued', 'running', 'retrying'].includes(progress.status);
    return <div key={room.id} className="manual-merge-hint">
      <p className="field-help">{room.anchor || room.title || room.id} · 房间号 {room.id}</p>
      <JobProgress progress={progress} />
      {active && !progress.cleanupStarted ? <button type="button" className="wide-button danger fill"
        disabled={busy.has(`cancel-merge-${room.id}`)} onClick={() => onCancel(room.id, progress.id)}>
        <Square size={18} />中断合并
      </button> : ['error', 'cancelled'].includes(progress.status) ? <button type="button" className="wide-button fill"
        disabled={busy.has(`retry-merge-${room.id}`)} onClick={() => onRetry(room.id)}>
        <RotateCcw size={18} />重试合并
      </button> : null}
    </div>;
  })}</>;
}

export function getManualMergeSelection(recordings: RecordingState[], paths: string[], rooms: RoomState[]) {
  const selected = recordings.filter(recording => paths.includes(recording.cleanPath))
    .sort((a, b) => a.startedAt - b.startedAt || a.cleanPath.localeCompare(b.cleanPath));
  const ownerOf = (recording: RecordingState) => rooms.find(room =>
    [room.id, room.realRoomId, room.shortId].some(id => id != null && String(id) === String(recording.roomId || '').trim()));
  const owner = selected[0] && ownerOf(selected[0]);
  const roomId = (recording: RecordingState) => String(ownerOf(recording)?.id || recording.roomId || '').trim();
  const reason = selected.length < 2 ? '请选择至少两段已完成的录像。'
    : selected.length > 160 ? '一次最多合并 160 段录像。'
      : selected.some(recording => recording.valid === false || ['capturing', 'finalizing'].includes(recording.containerStage || ''))
        ? '所选录像尚未完成或未通过完整性检查。'
        : selected.some(recording => !roomId(recording) || roomId(recording) !== roomId(selected[0]))
          ? '一次只能合并同一直播间的录像。'
          : !owner ? '请先添加这些录像所属的直播间。'
            : owner.recording || ['running', 'queued', 'retrying'].includes(owner.mergeProgress?.status || '')
              ? '该房间正在录制或合并，请等待完成。'
              : '';
  return { selected, reason };
}

export function ManualMergeControls({ selecting, count, reason, busy, onToggle, onMerge, deleteSources = false, onDeleteSourcesChange }: {
  selecting: boolean;
  count: number;
  reason: string;
  busy: boolean;
  onToggle: () => void;
  onMerge: () => void;
  deleteSources?: boolean;
  onDeleteSourcesChange?: (value: boolean) => void;
}) {
  return <>
    <div className="manual-merge-actions split-buttons">
      <button type="button" className="wide-button" disabled={busy} onClick={onToggle} aria-pressed={selecting}>
        {selecting ? <X size={18} /> : <ListChecks size={18} />}
        {selecting ? '退出多选' : '手动选择合并'}
      </button>
      {selecting ? <button type="button" className="wide-button primary" disabled={Boolean(reason) || busy}
        title={reason || (deleteSources ? '合并验证成功后删除所选源录像及配套弹幕、头像和 Scene 文件' : '按录制时间合并，保留源文件')} onClick={onMerge}>
        <Merge size={18} />
        {busy ? '正在提交合并' : `合并所选 ${count} 段`}
      </button> : null}
    </div>
    {selecting ? <label className="field-help manual-merge-hint">
      <input type="checkbox" checked={deleteSources} disabled={busy}
        onChange={event => onDeleteSourcesChange?.(event.target.checked)} /> 合并完成后删除源文件
      <span>（仅验证成功后删除所选录像及配套弹幕、头像和 Scene 文件；合并失败或取消保留）</span>
    </label> : null}
    {selecting ? reason && count >= 2 ? <div className="warning-line manual-merge-hint" role="status">
      <CircleAlert size={16} /><span>{reason}</span>
    </div> : <p className="field-help manual-merge-hint" role="status">
      {reason || `按录制时间先后合并，${deleteSources ? '验证成功后删除所选源文件' : '保留源文件'}；进度显示在本页和对应直播间卡片。`}
    </p> : null}
  </>;
}
