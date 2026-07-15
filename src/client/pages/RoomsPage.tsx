import { Plus, Radio } from 'lucide-react';
import { HelpBox, PageHeader, StepList } from '../components/common';
import { ImageModeSwitch, RoomCard } from '../components/rooms';
import type { AppSettings, RoomState } from '../types';

export function RoomsPage({
  rooms,
  roomImageMode,
  onRoomImageModeChange,
  roomInput,
  setRoomInput,
  addRoom,
  busy,
  run,
  openPreview
}: {
  rooms: RoomState[];
  roomImageMode: AppSettings['roomImageMode'];
  onRoomImageModeChange: (mode: AppSettings['roomImageMode']) => Promise<void>;
  roomInput: string;
  setRoomInput: (value: string) => void;
  addRoom: () => Promise<void>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<boolean>;
  openPreview: (roomId: string) => void;
}) {
  return (
    <>
      <PageHeader
        title="直播间"
        subtitle="把常看的直播间添加到这里，之后就能刷新状态、开启监听或直接录制。"
        actions={
          <div className="rooms-toolbar">
            <ImageModeSwitch
              value={roomImageMode}
              busy={busy === 'image-mode'}
              onChange={onRoomImageModeChange}
            />
            <div className="add-room page-add-room">
              <input
                value={roomInput}
                onChange={(event) => setRoomInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addRoom();
                  }
                }}
                inputMode="numeric"
                placeholder="例如 22625025"
              />
              <button
                className="wide-button primary"
                disabled={busy === 'add-room'}
                onClick={addRoom}
              >
                <Plus size={18} />
                添加
              </button>
            </div>
          </div>
        }
      />

      <HelpBox title="录制一个直播间">
        <StepList
          steps={[
            { title: '添加房间号', body: '从 B 站直播间地址里复制数字房间号，粘贴到右上角输入框。' },
            { title: '刷新状态', body: '添加后先刷新一次，确认标题、主播和直播状态是否正确。' },
            { title: '监听或录制', body: '想等开播提醒就开启监听；已经开播时可以直接点击录制。' }
          ]}
        />
      </HelpBox>

      <section className="room-grid">
        {rooms.length === 0 ? (
          <div className="empty-state">
            <Radio size={38} />
            <span>还没有添加直播间。</span>
            <p>打开 B 站直播间页面，从地址里复制房间号，例如 live.bilibili.com/22625025。</p>
          </div>
        ) : (
          rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              roomImageMode={roomImageMode}
              busy={busy}
              run={run}
              openPreview={openPreview}
            />
          ))
        )}
      </section>
    </>
  );
}
