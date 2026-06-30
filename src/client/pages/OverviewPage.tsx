import { HardDrive, ListVideo, MessageSquareText, MonitorDot, Plus, Radio, RefreshCw, Video } from 'lucide-react';
import { recorder } from '../recorderClient';
import { BigMetric, PageHeader, UpdateNotice } from '../components/common';
import { RoomCard } from '../components/rooms';
import type { AppState, Page } from '../types';
import { getStats, qnLabel } from '../utils';

export function OverviewPage({
  state,
  stats,
  busy,
  setPage,
  run,
  openPreview
}: {
  state: AppState;
  stats: ReturnType<typeof getStats>;
  busy: string | null;
  setPage: (page: Page) => void;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  openPreview: (roomId: string) => void;
}) {
  const activeRooms = state.rooms.filter((room) => room.liveStatus === 1 || room.recording);

  return (
    <>
      <PageHeader
        title="总览"
        subtitle={`${state.settings.outputContainer.toUpperCase()} · ${
          state.settings.preferHevc ? 'H.265 优先' : 'H.264 优先'
        } · ${qnLabel(state.settings.targetQn)} · ${state.settings.segmentMinutes} 分钟分段`}
        actions={
          <>
            <button
              className="wide-button"
              disabled={busy === 'update-check'}
              onClick={() => run('update-check', recorder.checkUpdate)}
            >
              <RefreshCw size={18} />
              检查更新
            </button>
            <button className="wide-button" onClick={() => run('open-output', recorder.openOutputDir)}>
              <HardDrive size={18} />
              打开目录
            </button>
            <button className="wide-button primary" onClick={() => setPage('rooms')}>
              <Plus size={18} />
              添加直播间
            </button>
          </>
        }
      />

      <section className="overview-grid">
        <BigMetric icon={<ListVideo size={22} />} label="直播间" value={stats.rooms} />
        <BigMetric icon={<Radio size={22} />} label="直播中" value={stats.live} />
        <BigMetric icon={<Video size={22} />} label="录制中" value={stats.recording} />
        <BigMetric icon={<MessageSquareText size={22} />} label="可烧录事件" value={stats.events} />
      </section>

      <UpdateNotice state={state} stats={stats} busy={busy} run={run} />

      <section className="panel-band">
        <div className="band-heading">
          <div className="section-title">
            <MonitorDot size={18} />
            <span>活动直播间</span>
          </div>
        </div>
        {activeRooms.length === 0 ? (
          <div className="empty-state compact-empty">暂无活动直播间</div>
        ) : (
          <div className="room-grid overview-rooms">
            {activeRooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                roomImageMode={state.settings.roomImageMode}
                burnOverlayMode={state.settings.burnOverlayMode}
                busy={null}
                run={run}
                openPreview={openPreview}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
