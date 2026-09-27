import { CircleAlert, ListChecks, Merge, X } from 'lucide-react';
import type { RecordingState, RoomState } from '../types';

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

export function ManualMergeControls({ selecting, count, reason, busy, onToggle, onMerge }: {
  selecting: boolean;
  count: number;
  reason: string;
  busy: boolean;
  onToggle: () => void;
  onMerge: () => void;
}) {
  return <>
    <div className="manual-merge-actions split-buttons">
      <button type="button" className="wide-button" disabled={busy} onClick={onToggle} aria-pressed={selecting}>
        {selecting ? <X size={18} /> : <ListChecks size={18} />}
        {selecting ? '退出多选' : '手动选择合并'}
      </button>
      {selecting ? <button type="button" className="wide-button primary" disabled={Boolean(reason) || busy}
        title={reason || '按录制时间合并，保留源文件'} onClick={onMerge}>
        <Merge size={18} />
        {busy ? '正在提交合并' : `合并所选 ${count} 段`}
      </button> : null}
    </div>
    {selecting ? reason && count >= 2 ? <div className="warning-line manual-merge-hint" role="status">
      <CircleAlert size={16} /><span>{reason}</span>
    </div> : <p className="field-help manual-merge-hint" role="status">
      {reason || '按录制时间先后合并，保留源文件；进度显示在对应房间卡片。'}
    </p> : null}
  </>;
}
