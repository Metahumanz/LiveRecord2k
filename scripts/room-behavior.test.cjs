const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Readable, Writable } = require('node:stream');

const { BusinessError, LiveRecordService } = require('../src/server/app/service.cjs');
const { handleRequest } = require('../src/server/app/routes.cjs');

function createRoomService() {
  const service = new LiveRecordService();
  service.saveStore = async () => {};
  service.emitState = () => {};
  service.log = () => {};
  return service;
}

async function invokeApi({ pathname, body, service }) {
  const request = Readable.from([Buffer.from(JSON.stringify(body || {}), 'utf8')]);
  request.method = 'POST';
  request.url = pathname;
  request.headers = { host: '127.0.0.1:3263' };
  request.socket = { remoteAddress: '127.0.0.1' };
  let statusCode = 200;
  let responseBody = '';
  const response = new Writable({
    write(chunk, _encoding, callback) {
      responseBody += chunk.toString('utf8');
      callback();
    }
  });
  response.writeHead = (status) => {
    statusCode = status;
  };
  const finished = new Promise((resolve) => response.once('finish', resolve));
  await handleRequest(service, null, 3263, request, response);
  await finished;
  return { statusCode, body: JSON.parse(responseBody) };
}

test('adding a room fetches its info once but does not begin monitoring or recording', async () => {
  const service = createRoomService();
  let fetchCount = 0;
  let monitorStartCount = 0;
  let pushMonitorStartCount = 0;
  service.fetchRoomInfo = async (id) => {
    fetchCount += 1;
    return {
      realRoomId: Number(id),
      title: '正在直播的测试间',
      anchor: '测试主播',
      liveStatus: 1
    };
  };
  service.startMonitorTimer = () => {
    monitorStartCount += 1;
  };
  service.startLivePushMonitor = async () => {
    pushMonitorStartCount += 1;
  };

  const state = await service.addRoom('https://live.bilibili.com/123456?broadcast_type=0');
  const room = state.rooms.find((item) => item.id === '123456');

  assert.equal(fetchCount, 1);
  assert.equal(monitorStartCount, 0);
  assert.equal(pushMonitorStartCount, 0);
  assert.deepEqual(
    { monitoring: room.monitoring, autoRecord: room.autoRecord, liveStatus: room.liveStatus },
    { monitoring: false, autoRecord: false, liveStatus: 1 }
  );
});

test('adding a room accepts a pure room id and common Bilibili live room URLs', async () => {
  for (const [input, expectedId] of [
    ['123456', '123456'],
    ['live.bilibili.com/234567', '234567'],
    ['https://live.bilibili.com/345678', '345678'],
    ['https://live.bilibili.com/blanc/456789?foo=bar', '456789']
  ]) {
    const service = createRoomService();
    service.fetchRoomInfo = async (id) => ({ realRoomId: Number(id), liveStatus: 0 });
    await service.addRoom(input);
    assert.equal(service.rooms.has(expectedId), true, input);
  }
});

test('invalid and duplicate room additions return explicit business errors without mutating rooms', async () => {
  const service = createRoomService();
  service.fetchRoomInfo = async (id) => ({ realRoomId: Number(id), liveStatus: 0 });

  await assert.rejects(
    service.addRoom('not-a-room'),
    (error) => error instanceof BusinessError && error.code === 'INVALID_ROOM_ID' && error.statusCode === 400
  );
  assert.equal(service.rooms.size, 0);

  await service.addRoom('123456');
  await assert.rejects(
    service.addRoom('https://live.bilibili.com/123456'),
    (error) => error instanceof BusinessError && error.code === 'ROOM_ALREADY_EXISTS' && error.statusCode === 409
  );
  assert.equal(service.rooms.size, 1);
});

test('API serializes business errors as code and message with their appropriate status', async () => {
  const service = {
    settings: {},
    authenticateAccess: () => true,
    log() {},
    async addRoom() {
      throw new BusinessError('ROOM_ALREADY_EXISTS', '该直播间已经添加', 409);
    }
  };

  const response = await invokeApi({
    pathname: '/api/rooms/add',
    body: { roomId: '123456' },
    service
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    code: 'ROOM_ALREADY_EXISTS',
    message: '该直播间已经添加'
  });
});

test('manual recording of an offline room and removing a busy room report state conflicts', async () => {
  const service = createRoomService();
  service.rooms.set('123456', service.normalizeRoom({ id: '123456', realRoomId: 123456, liveStatus: 0 }));
  service.fetchRoomInfo = async () => ({ realRoomId: 123456, liveStatus: 0 });

  await assert.rejects(
    service.startRecording('123456'),
    (error) => error instanceof BusinessError && error.code === 'ROOM_NOT_LIVE' && error.statusCode === 409
  );

  service.rooms.get('123456').recording = true;
  await assert.rejects(
    service.removeRoom('123456'),
    (error) => error instanceof BusinessError && error.code === 'ROOM_BUSY' && error.statusCode === 409
  );
  assert.equal(service.rooms.has('123456'), true);
});

test('invalid settings return a parameter business error before any settings are changed', async () => {
  const service = createRoomService();
  const originalInterval = service.settings.pollIntervalSec;

  await assert.rejects(
    service.saveSettings({ pollIntervalSec: 0 }),
    (error) => error instanceof BusinessError && error.code === 'INVALID_SETTINGS' && error.statusCode === 400
  );

  assert.equal(service.settings.pollIntervalSec, originalInterval);
});

test('invalid setting types, unknown keys, and malformed trusted proxies are rejected explicitly', async () => {
  const service = createRoomService();
  const originalSettings = { ...service.settings };

  for (const invalidPatch of [
    { autoBurnDanmaku: 'true' },
    { unknownSetting: true },
    { trustedProxies: ['not-an-ip-address'] }
  ]) {
    await assert.rejects(
      service.saveSettings(invalidPatch),
      (error) => error instanceof BusinessError && error.code === 'INVALID_SETTINGS' && error.statusCode === 400
    );
  }

  assert.deepEqual(service.settings, originalSettings);
});

test('unavailable room media actions return explicit business feedback instead of a silent no-op', async () => {
  const service = createRoomService();
  const room = service.normalizeRoom({ id: '123456', realRoomId: 123456, liveStatus: 0 });
  service.rooms.set(room.id, room);
  service.fetchRoomInfo = async () => ({ realRoomId: 123456, liveStatus: 0 });
  service.getPendingMergeGroupForRoom = async () => null;

  const expectations = [
    [() => service.startPreview(room.id), 'ROOM_NOT_LIVE', 409],
    [() => service.retryMerge(room.id), 'MERGE_TASK_NOT_FOUND', 404],
    [() => service.startBurnDanmaku(room.id), 'RECORDING_NOT_FOUND', 404],
    [() => service.prepareDanmakuForRoom(room.id), 'RECORDING_NOT_FOUND', 404],
    [() => service.startExportPreview({}), 'INVALID_PREVIEW_REQUEST', 400]
  ];

  for (const [action, code, statusCode] of expectations) {
    await assert.rejects(
      action(),
      (error) => error instanceof BusinessError && error.code === code && error.statusCode === statusCode
    );
  }
});

test('the client tracks concurrent work with a busy key set and passes it to overview room cards', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const appSource = fs.readFileSync(path.join(projectRoot, 'src/client/App.tsx'), 'utf8');
  const overviewSource = fs.readFileSync(path.join(projectRoot, 'src/client/pages/OverviewPage.tsx'), 'utf8');
  const roomCardSource = fs.readFileSync(path.join(projectRoot, 'src/client/components/rooms.tsx'), 'utf8');

  assert.match(appSource, /useState<Set<string>>\(\(\) => new Set\(\)\)/);
  assert.match(appSource, /setBusy\(\(current\) => \{[\s\S]*?new Set\(current\)[\s\S]*?\.add\(key\)/);
  assert.match(appSource, /setBusy\(\(current\) => \{[\s\S]*?new Set\(current\)[\s\S]*?\.delete\(key\)/);
  assert.doesNotMatch(overviewSource, /busy=\{null\}/);
  assert.match(roomCardSource, /busy: Set<string>/);
  assert.match(roomCardSource, /busy\.has\(`refresh-\$\{roomKey\}`\)/);
});
