import { Plus, Radio } from 'lucide-react';
import { PageHeader } from '../components/common';
import { ImageModeSwitch, RoomCard } from '../components/rooms';
import type { AppSettings, RoomState } from '../types';

export function RoomsPage({
  rooms,
  roomImageMode,
  burnOverlayMode,
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
  burnOverlayMode: AppSettings['burnOverlayMode'];
  onRoomImageModeChange: (mode: AppSettings['roomImageMode']) => Promise<void>;
  roomInput: string;
  setRoomInput: (value: string) => void;
  addRoom: () => Promise<void>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  openPreview: (roomId: string) => void;
}) {
  return (
    <>
      <PageHeader
        title="直播间"
        subtitle={`${rooms.length} 个房间`}
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
                placeholder="输入房间号"
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

      <section className="room-grid">
        {rooms.length === 0 ? (
          <div className="empty-state">
            <Radio size={38} />
            <span>暂无直播间</span>
          </div>
        ) : (
          rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              roomImageMode={roomImageMode}
              burnOverlayMode={burnOverlayMode}
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
