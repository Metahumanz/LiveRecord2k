import { HardDrive, ListVideo, MessageSquareText, MonitorDot, Plus, Radio, RefreshCw, Video } from 'lucide-react';
import { recorder } from '../recorderClient';
import { BigMetric, HelpBox, PageHeader, UpdateNotice } from '../components/common';
import { RoomCard } from '../components/rooms';
import type { AppState, Page } from '../types';
import { getStats } from '../utils';

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
  const loggedIn = state.settings.cookie.includes('SESSDATA=');
  const hasOutputDir = Boolean(state.settings.outputDir.trim());
  const anyMonitoring = state.rooms.some((room) => room.monitoring);
  const liveRooms = state.rooms.filter((room) => room.liveStatus === 1);
  const recordingRooms = state.rooms.filter((room) => room.recording);
  const nextStep = (() => {
    if (!loggedIn) {
      return {
        title: '先完成扫码登录',
        body: '登录后更容易拿到高画质源流。打开设置页，点击扫码登录，用哔哩哔哩 App 确认。',
        action: '去设置',
        page: 'settings' as Page
      };
    }
    if (!hasOutputDir) {
      return {
        title: '设置录像保存位置',
        body: '选择一个空间充足的文件夹，后续录像、弹幕记录和弹幕视频都会放在那里。',
        action: '去设置',
        page: 'settings' as Page
      };
    }
    if (state.rooms.length === 0) {
      return {
        title: '添加第一个直播间',
        body: '复制 B 站直播间链接里的房间号，添加后就可以刷新状态、监听开播或手动录制。',
        action: '添加直播间',
        page: 'rooms' as Page
      };
    }
    if (!anyMonitoring) {
      return {
        title: '开启直播间监听',
        body: '监听开启后，应用会按设置里的间隔刷新直播状态，并在开播、下播时发出通知。',
        action: '去直播间',
        page: 'rooms' as Page
      };
    }
    if (liveRooms.length > 0 && recordingRooms.length === 0) {
      return {
        title: '直播间正在开播',
        body: '可以进入直播间页面点击录制。录制结束后会生成原始录像和弹幕记录。',
        action: '开始录制',
        page: 'rooms' as Page
      };
    }
    if (recordingRooms.length > 0) {
      return {
        title: '正在录制',
        body: '录制过程中可以保持页面打开，也可以关闭浏览器，后台服务会继续工作。',
        action: '查看直播间',
        page: 'rooms' as Page
      };
    }
    return {
      title: '等待直播开播',
      body: '保持监听开启即可。开播后可以手动录制，或者根据你的通知设置收到提醒。',
      action: '查看直播间',
      page: 'rooms' as Page
    };
  })();

  return (
    <>
      <PageHeader
        title="总览"
        subtitle="从这里确认下一步操作、查看当前录制状态，并快速进入常用页面。"
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

      <HelpBox title="下一步">
        <div className="next-step">
          <div>
            <h3>{nextStep.title}</h3>
            <p>{nextStep.body}</p>
          </div>
          <button className="wide-button primary" type="button" onClick={() => setPage(nextStep.page)}>
            <Plus size={18} />
            {nextStep.action}
          </button>
        </div>
      </HelpBox>

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
          <div className="empty-state compact-empty">
            <Radio size={34} />
            <span>还没有正在直播或录制的房间。</span>
          </div>
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
