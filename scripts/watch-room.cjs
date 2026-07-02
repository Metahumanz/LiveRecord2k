const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Emergency room watchdog used to keep a live room monitored and recording.
const ROOT = path.resolve(__dirname, '..');
const ROOM_ID = process.env.BILI_WATCH_ROOM || '883263';
const PORT = Number(process.env.BILI_RECORD_PORT || 3263);
const WATCH_HOURS = Number(process.env.BILI_WATCH_HOURS || 4);
const LOG_DIR = path.join(process.env.APPDATA || os.tmpdir(), 'BiliRecord2K');
const LOG_PATH = path.join(LOG_DIR, `codex-watch-room-${ROOM_ID}.log`);
const SERVICE_OUT = path.join(LOG_DIR, `codex-watch-room-${ROOM_ID}.service.out.log`);
const SERVICE_ERR = path.join(LOG_DIR, `codex-watch-room-${ROOM_ID}.service.err.log`);
const END_AT = Date.now() + Math.max(0.1, WATCH_HOURS) * 60 * 60 * 1000;

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(message) {
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function request(method, pathname, body) {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        timeout: 8000,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          : undefined
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            resolve(text);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function startService() {
  const out = fs.openSync(SERVICE_OUT, 'a');
  const err = fs.openSync(SERVICE_ERR, 'a');
  const child = spawn('node', ['src/server/index.cjs', '--dev', '--no-open'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true
  });
  child.unref();
  log(`started service pid=${child.pid}`);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function tick() {
  try {
    let state;
    try {
      state = await request('GET', '/api/state');
    } catch (error) {
      log(`service unavailable: ${error.message}; starting`);
      startService();
      await new Promise((resolve) => setTimeout(resolve, 6000));
      state = await request('GET', '/api/state');
    }

    await request('POST', '/api/rooms/refresh', { roomId: ROOM_ID, silent: true }).catch((error) => {
      log(`refresh failed: ${error.message}`);
    });
    state = await request('GET', '/api/state');
    const room = (state.rooms || []).find((item) => String(item.id) === ROOM_ID);
    if (!room) {
      log(`room ${ROOM_ID} missing`);
    } else if (Number(room.liveStatus) === 1 && !room.recording) {
      log('room live but not recording; starting recording');
      await request('POST', '/api/rooms/record/start', { roomId: ROOM_ID });
    } else {
      const recording = room.currentRecording || {};
      const video = recording.videoInfo ? `${recording.videoInfo.width}x${recording.videoInfo.height}` : '';
      const bytes = recording.capturePath ? fileSize(recording.capturePath) : 0;
      log(
        `status live=${room.liveStatus} monitoring=${room.monitoring} recording=${room.recording} qn=${
          room.stream?.qn || ''
        } bytes=${bytes} ${video}`
      );
    }
  } catch (error) {
    log(`watchdog error: ${error.message}`);
  }
}

async function main() {
  log(`watchdog started room=${ROOM_ID} hours=${WATCH_HOURS}`);
  while (Date.now() < END_AT) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
  }
  log('watchdog finished');
}

main().catch((error) => {
  log(`fatal: ${error.message}`);
  process.exitCode = 1;
});
