import { CircleAlert, ListChecks, Merge, X, Square, RotateCcw } from 'lucide-react';
import type { RecordingState, RoomState } from '../types';
import { JobProgress } from './common';

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
