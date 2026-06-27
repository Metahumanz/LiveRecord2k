const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const QRCode = require('qrcode');

let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch {
  ffmpegStatic = null;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DANMAKU_OP = {
  HEARTBEAT: 2,
  MESSAGE: 5,
  AUTH: 7
};

const STORE_FILE = 'settings.json';
const PORT = clamp(Number(process.env.PORT || 5173), 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const DEV_MODE = process.argv.includes('--dev') || !process.argv.includes('--prod');

class LiveRecordService {
  constructor() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    this.storePath = path.join(appData, 'BiliRecord2K', STORE_FILE);
    this.settings = this.createDefaultSettings();
    this.rooms = new Map();
    this.logs = [];
    this.monitorTimers = new Map();
    this.recordingSessions = new Map();
    this.burnSessions = new Map();
    this.clients = new Set();
    this.loginSession = null;
    this.ffmpegPath = findFfmpegPath();
  }

  createDefaultSettings() {
    return {
      outputDir: path.join(os.homedir(), 'Videos', '哔哩录播2K'),
      cookie: '',
      pollIntervalSec: 15,
      targetQn: 15000,
      preferHevc: true,
      outputContainer: 'mp4',
      autoBurnDanmaku: true,
      burnCodec: 'libx265',
      burnCrf: 24,
      notifyLiveStarted: true,
      notifyLiveEnded: true,
      notifyRecordingStarted: true,
      notifyRecordingEnded: true,
      notifyBurnStarted: true,
      notifyBurnEnded: true
    };
  }

  async init() {
    await this.loadStore();
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    for (const room of this.rooms.values()) {
      if (room.monitoring) {
        this.startMonitorTimer(room.id);
      }
    }
    this.log('success', `WebUI 后端已启动，ffmpeg: ${this.ffmpegPath}`);
  }

  async loadStore() {
    try {
      const raw = await fsp.readFile(this.storePath, 'utf8');
      const store = JSON.parse(raw);
      this.settings = this.normalizeSettings({ ...this.settings, ...(store.settings || {}) });
      for (const savedRoom of store.rooms || []) {
        const room = this.normalizeRoom(savedRoom);
        this.rooms.set(room.id, room);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('warn', `读取配置失败，将使用默认配置：${error.message}`);
      }
    }
  }

  async saveStore() {
    await fsp.mkdir(path.dirname(this.storePath), { recursive: true });
    const rooms = Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      realRoomId: room.realRoomId,
      shortId: room.shortId,
      title: room.title,
      anchor: room.anchor,
      cover: room.cover,
      liveStatus: room.liveStatus,
      monitoring: room.monitoring
    }));
    await fsp.writeFile(
      this.storePath,
      JSON.stringify({ settings: this.settings, rooms }, null, 2),
      'utf8'
    );
  }

  normalizeSettings(settings) {
    return {
      ...this.createDefaultSettings(),
      ...settings,
      outputContainer: normalizeContainer(settings.outputContainer),
      pollIntervalSec: clamp(Number(settings.pollIntervalSec || 15), 5, 300),
      targetQn: Number(settings.targetQn || 15000),
      burnCrf: clamp(Number(settings.burnCrf || 24), 16, 35),
      preferHevc: Boolean(settings.preferHevc),
      autoBurnDanmaku: Boolean(settings.autoBurnDanmaku),
      notifyLiveStarted: settings.notifyLiveStarted !== false,
      notifyLiveEnded: settings.notifyLiveEnded !== false,
      notifyRecordingStarted: settings.notifyRecordingStarted !== false,
      notifyRecordingEnded: settings.notifyRecordingEnded !== false,
      notifyBurnStarted: settings.notifyBurnStarted !== false,
      notifyBurnEnded: settings.notifyBurnEnded !== false
    };
  }

  normalizeRoom(room) {
    return {
      id: String(room.id || '').trim(),
      realRoomId: room.realRoomId,
      shortId: room.shortId,
      title: room.title,
      anchor: room.anchor,
      cover: room.cover,
      liveStatus: room.liveStatus,
      monitoring: Boolean(room.monitoring),
      recording: false,
      burning: false,
      lastCheckedAt: room.lastCheckedAt,
      lastError: undefined,
      stream: undefined,
      currentRecording: undefined
    };
  }

  getState() {
    return {
      settings: { ...this.settings },
      rooms: Array.from(this.rooms.values()).map((room) => ({
        ...room,
        stream: room.stream ? { ...room.stream, url: '[hidden]' } : undefined
      })),
      logs: this.logs,
      login: this.getPublicLoginState(),
      ffmpegPath: this.ffmpegPath
    };
  }

  getPublicLoginState() {
    if (!this.loginSession) {
      return undefined;
    }
    return {
      status: this.loginSession.status,
      message: this.loginSession.message,
      qrImageDataUrl: this.loginSession.qrImageDataUrl,
      expiresAt: this.loginSession.expiresAt
    };
  }

  addClient(response) {
    this.clients.add(response);
    this.writeSseState(response);
    response.on('close', () => this.clients.delete(response));
  }

  emitState() {
    for (const response of this.clients) {
      this.writeSseState(response);
    }
  }

  writeSseState(response) {
    try {
      response.write(`data: ${JSON.stringify(this.getState())}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }

  log(level, message) {
    this.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: Date.now(),
      level,
      message
    });
    if (this.logs.length > 400) {
      this.logs.splice(0, this.logs.length - 400);
    }
    this.emitState();
  }

  async chooseOutputDir() {
    this.log('info', 'WebUI 模式请直接填写输出目录路径。');
    return undefined;
  }

  async openOutputDir() {
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    openPath(this.settings.outputDir);
  }

  async startQrLogin() {
    this.clearLoginTimer();
    try {
      const { json } = await requestBiliJsonWithCookies(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
      );
      if (json.code !== 0 || !json.data?.url || !json.data?.qrcode_key) {
        throw new Error(json.message || '二维码生成失败');
      }

      const qrImageDataUrl = await QRCode.toDataURL(json.data.url, {
        width: 260,
        margin: 1,
        color: {
          dark: '#10201f',
          light: '#ffffff'
        }
      });

      this.loginSession = {
        qrcodeKey: json.data.qrcode_key,
        qrImageDataUrl,
        status: 'waiting',
        message: '请使用哔哩哔哩 App 扫码',
        expiresAt: Date.now() + 180000,
        timer: null,
        polling: false
      };
      this.loginSession.timer = setInterval(() => {
        this.pollQrLogin().catch((error) => {
          if (!this.loginSession) {
            return;
          }
          this.loginSession.status = 'error';
          this.loginSession.message = error.message;
          this.clearLoginTimer(false);
          this.log('error', `扫码登录失败：${error.message}`);
          this.emitState();
        });
      }, 2200);
      this.log('info', '扫码登录二维码已生成。');
    } catch (error) {
      this.loginSession = {
        status: 'error',
        message: error.message,
        qrImageDataUrl: undefined,
        expiresAt: undefined,
        timer: null,
        polling: false
      };
      this.log('error', `扫码登录启动失败：${error.message}`);
    }
    this.emitState();
    return this.getState();
  }

  async pollQrLogin() {
    const session = this.loginSession;
    if (!session || session.polling || !session.qrcodeKey) {
      return;
    }
    if (session.expiresAt && Date.now() > session.expiresAt) {
      session.status = 'expired';
      session.message = '二维码已过期，请重新生成';
      this.clearLoginTimer(false);
      this.emitState();
      return;
    }

    session.polling = true;
    try {
      const { json, cookies } = await requestBiliJsonWithCookies(
        `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
          session.qrcodeKey
        )}`
      );
      const data = json.data || {};
      const code = Number(data.code);

      if (json.code !== 0) {
        throw new Error(json.message || `登录轮询失败，接口状态码 ${json.code}`);
      }

      if (code === 0) {
        const mergedCookie = mergeCookieString(this.settings.cookie, cookies);
        if (!mergedCookie) {
          throw new Error('登录成功但没有收到登录凭证');
        }
        this.settings.cookie = mergedCookie;
        await this.saveStore();
        session.status = 'success';
        session.message = '登录成功，登录凭证已写入设置';
        this.clearLoginTimer(false);
        this.log('success', 'B 站扫码登录成功。');
        this.emitState();
        setTimeout(() => {
          if (this.loginSession?.status === 'success') {
            this.loginSession = null;
            this.emitState();
          }
        }, 1800);
        return;
      }

      if (code === 86090) {
        session.status = 'scanned';
        session.message = '已扫码，请在手机上确认登录';
      } else if (code === 86101) {
        session.status = 'waiting';
        session.message = '请使用哔哩哔哩 App 扫码';
      } else if (code === 86038) {
        session.status = 'expired';
        session.message = '二维码已过期，请重新生成';
        this.clearLoginTimer(false);
      } else {
        session.status = 'error';
        session.message = data.message || json.message || `未知登录状态，状态码 ${code}`;
        this.clearLoginTimer(false);
      }
      this.emitState();
    } finally {
      if (this.loginSession) {
        this.loginSession.polling = false;
      }
    }
  }

  async cancelQrLogin() {
    this.clearLoginTimer();
    this.loginSession = null;
    this.log('info', '扫码登录已取消。');
    this.emitState();
    return this.getState();
  }

  clearLoginTimer(clearSession = true) {
    if (this.loginSession?.timer) {
      clearInterval(this.loginSession.timer);
      this.loginSession.timer = null;
    }
    if (clearSession) {
      this.loginSession = null;
    }
  }

  async saveSettings(nextSettings) {
    const oldPollInterval = this.settings.pollIntervalSec;
    this.settings = this.normalizeSettings({
      ...this.settings,
      ...nextSettings
    });
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    await this.saveStore();
    if (oldPollInterval !== this.settings.pollIntervalSec) {
      for (const room of this.rooms.values()) {
        if (room.monitoring) {
          this.startMonitorTimer(room.id);
        }
      }
    }
    this.log('success', '设置已保存。');
    this.emitState();
    return this.getState();
  }

  async addRoom(roomId) {
    const id = String(roomId || '').trim();
    if (!/^\d+$/.test(id)) {
      this.log('error', '房间号必须是数字。');
      return this.getState();
    }
    if (this.rooms.has(id)) {
      this.log('warn', `房间 ${id} 已经在列表里。`);
      return this.getState();
    }
    const room = this.normalizeRoom({ id, monitoring: true });
    this.rooms.set(id, room);
    await this.saveStore();
    this.log('info', `已添加房间 ${id}。`);
    this.emitState();
    await this.refreshRoom(id);
    await this.setMonitoring(id, true);
    return this.getState();
  }

  async removeRoom(roomId) {
    const room = this.getRoom(roomId);
    if (room.recording) {
      await this.stopRecording(room.id);
    }
    this.stopMonitorTimer(room.id);
    this.rooms.delete(room.id);
    await this.saveStore();
    this.log('info', `已移除房间 ${room.id}。`);
    this.emitState();
    return this.getState();
  }

  async refreshRoom(roomId) {
    const room = this.getRoom(roomId);
    try {
      const previousLiveStatus = room.liveStatus;
      const info = await this.fetchRoomInfo(room.id);
      Object.assign(room, info, {
        lastCheckedAt: Date.now(),
        lastError: undefined
      });
      await this.saveStore();
      if (previousLiveStatus !== undefined && previousLiveStatus !== room.liveStatus) {
        this.log(
          room.liveStatus === 1 ? 'success' : 'info',
          `${roomLabel(room)}：${room.liveStatus === 1 ? '开播' : '下播'}`
        );
      } else {
        this.log(
          info.liveStatus === 1 ? 'success' : 'info',
          `${roomLabel(room)}：${info.liveStatus === 1 ? '正在直播' : '未开播'}`
        );
      }
    } catch (error) {
      room.lastCheckedAt = Date.now();
      room.lastError = error.message;
      this.log('error', `${roomLabel(room)} 刷新失败：${error.message}`);
    }
    this.emitState();
    return this.getState();
  }

  async setMonitoring(roomId, enabled) {
    const room = this.getRoom(roomId);
    room.monitoring = Boolean(enabled);
    if (room.monitoring) {
      this.startMonitorTimer(room.id);
      this.log('info', `${roomLabel(room)} 已开始监听。`);
      this.tickRoom(room.id);
    } else {
      this.stopMonitorTimer(room.id);
      this.log('info', `${roomLabel(room)} 已停止监听。`);
    }
    await this.saveStore();
    this.emitState();
    return this.getState();
  }

  startMonitorTimer(roomId) {
    this.stopMonitorTimer(roomId);
    const timer = setInterval(() => {
      this.tickRoom(roomId);
    }, this.settings.pollIntervalSec * 1000);
    this.monitorTimers.set(roomId, timer);
  }

  stopMonitorTimer(roomId) {
    const timer = this.monitorTimers.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.monitorTimers.delete(roomId);
    }
  }

  async tickRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.monitoring) {
      return;
    }
    try {
      await this.refreshRoom(room.id);
      if (room.liveStatus === 1 && !room.recording) {
        await this.startRecording(room.id, true);
      }
    } catch (error) {
      this.log('error', `${roomLabel(room)} 监听异常：${error.message}`);
    }
  }

  async fetchRoomInfo(roomId) {
    const roomInit = await this.fetchBiliJson(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`
    );
    if (roomInit.code !== 0) {
      throw new Error(roomInit.message || `房间初始化接口返回状态码 ${roomInit.code}`);
    }

    const realRoomId = Number(roomInit.data.room_id);
    const info = await this.fetchBiliJson(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${realRoomId}`
    );
    if (info.code !== 0) {
      throw new Error(info.message || `房间信息接口返回状态码 ${info.code}`);
    }

    return {
      realRoomId,
      shortId: Number(roomInit.data.short_id || 0),
      liveStatus: Number(roomInit.data.live_status ?? info.data?.room_info?.live_status ?? 0),
      title: info.data?.room_info?.title || roomInit.data.title || `直播间 ${realRoomId}`,
      anchor: info.data?.anchor_info?.base_info?.uname || '',
      cover: info.data?.room_info?.cover || info.data?.room_info?.keyframe || ''
    };
  }

  async fetchBiliJson(url) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://live.bilibili.com/',
        'User-Agent': USER_AGENT,
        Cookie: sanitizeHeaderValue(this.settings.cookie)
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`接口返回不是 JSON：${text.slice(0, 120)}`);
    }
  }

  async resolvePlayStream(room) {
    if (!room.realRoomId) {
      Object.assign(room, await this.fetchRoomInfo(room.id));
    }

    const params = new URLSearchParams({
      room_id: String(room.realRoomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      qn: String(this.settings.targetQn),
      platform: 'web',
      ptype: '8',
      dolby: '5',
      panorama: '1'
    });
    const playInfo = await this.fetchBiliJson(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params.toString()}`
    );
    if (playInfo.code !== 0) {
      throw new Error(playInfo.message || `直播流接口返回状态码 ${playInfo.code}`);
    }

    const streams = playInfo.data?.playurl_info?.playurl?.stream || [];
    const candidates = [];
    for (const stream of streams) {
      for (const format of stream.format || []) {
        for (const codec of format.codec || []) {
          const baseUrl = codec.base_url || codec.baseUrl || '';
          for (const urlInfo of codec.url_info || []) {
            const host = urlInfo.host || '';
            const extra = urlInfo.extra || '';
            if (!host || !baseUrl) {
              continue;
            }
            candidates.push({
              url: `${host}${baseUrl}${extra}`,
              codec: String(codec.codec_name || codec.codec || 'unknown').toLowerCase(),
              qn: Number(codec.current_qn || codec.qn || 0),
              protocol: String(stream.protocol_name || 'unknown'),
              format: String(format.format_name || 'unknown'),
              host
            });
          }
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error('没有拿到可用直播流，可能未登录、未开播或清晰度受限。');
    }

    candidates.sort((a, b) => streamScore(b, this.settings) - streamScore(a, this.settings));
    room.stream = candidates[0];
    this.log(
      'success',
      `${roomLabel(room)} 选中直播流：编码 ${displayCodecName(room.stream.codec)}，清晰度码 ${room.stream.qn}，协议 ${room.stream.protocol}/${room.stream.format}`
    );
    return room.stream;
  }

  async startRecording(roomId, autoStart = false) {
    const room = this.getRoom(roomId);
    if (room.recording) {
      return this.getState();
    }

    try {
      if (!room.realRoomId || room.liveStatus !== 1) {
        Object.assign(room, await this.fetchRoomInfo(room.id));
      }
      if (room.liveStatus !== 1) {
        this.log('warn', `${roomLabel(room)} 当前未开播，未开始录制。`);
        this.emitState();
        return this.getState();
      }

      const stream = await this.resolvePlayStream(room);
      await fsp.mkdir(this.settings.outputDir, { recursive: true });

      const timestamp = formatTimestamp(new Date());
      const baseName = sanitizeFilename(
        `${room.realRoomId || room.id}_${room.anchor || 'anchor'}_${room.title || 'live'}_${timestamp}`
      );
      const container = normalizeContainer(this.settings.outputContainer);
      const cleanPath = path.join(this.settings.outputDir, `${baseName}.clean.${container}`);
      const danmakuPath = path.join(this.settings.outputDir, `${baseName}.danmaku.jsonl`);
      const assPath = path.join(this.settings.outputDir, `${baseName}.danmaku.ass`);
      const burnedPath = path.join(this.settings.outputDir, `${baseName}.danmaku.${container}`);

      const args = createRecordingArgs({
        streamUrl: stream.url,
        headers: this.createFfmpegHeaders(room),
        outputPath: cleanPath,
        container,
        streamCodec: stream.codec
      });

      const ffmpeg = spawn(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      });

      const eventStream = fs.createWriteStream(danmakuPath, { flags: 'a' });
      const session = {
        roomId: room.id,
        ffmpeg,
        eventStream,
        danmakuClient: null,
        startedAt: Date.now(),
        cleanPath,
        danmakuPath,
        assPath,
        burnedPath,
        eventCount: 0,
        stopping: false
      };

      room.recording = true;
      room.currentRecording = {
        startedAt: session.startedAt,
        cleanPath,
        danmakuPath,
        assPath,
        burnedPath,
        eventCount: 0
      };
      this.recordingSessions.set(room.id, session);
      this.log(
        'success',
        `${roomLabel(room)} ${autoStart ? '开播自动' : '手动'}开始录制：${path.basename(cleanPath)}`
      );

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (/error|failed|invalid|403|404/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 录制进程：${compactLogLine(text)}`);
        }
      });

      ffmpeg.on('error', (error) => {
        this.log('error', `${roomLabel(room)} 录制进程启动失败：${error.message}`);
      });

      ffmpeg.on('close', async (code, signal) => {
        await this.finishRecording(room.id, code, signal);
      });

      this.startDanmakuCapture(room, session).catch((error) => {
        this.log('warn', `${roomLabel(room)} 弹幕连接失败：${error.message}`);
      });

      this.emitState();
    } catch (error) {
      room.lastError = error.message;
      room.recording = false;
      this.log('error', `${roomLabel(room)} 开始录制失败：${error.message}`);
      this.emitState();
    }
    return this.getState();
  }

  async startDanmakuCapture(room, session) {
    const info = await this.fetchBiliJson(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${room.realRoomId}&type=0`
    );
    if (info.code !== 0) {
      throw new Error(info.message || `弹幕服务器接口返回状态码 ${info.code}`);
    }
    const client = new DanmakuClient({
      roomId: room.realRoomId,
      token: info.data?.token || '',
      hosts: info.data?.host_list || [],
      onOpen: () => this.log('success', `${roomLabel(room)} 弹幕通道已连接。`),
      onClose: (reason) => this.log('warn', `${roomLabel(room)} 弹幕通道已断开：${reason}`),
      onError: (error) => this.log('warn', `${roomLabel(room)} 弹幕通道错误：${error.message}`),
      onCommand: (command) => {
        const event = normalizeDanmakuEvent(command, session.startedAt);
        if (!event) {
          return;
        }
        session.eventCount += 1;
        room.currentRecording.eventCount = session.eventCount;
        session.eventStream.write(`${JSON.stringify(event)}\n`);
        if (session.eventCount % 50 === 0) {
          this.emitState();
        }
      }
    });
    session.danmakuClient = client;
    client.connect();
  }

  async stopRecording(roomId) {
    const room = this.getRoom(roomId);
    const session = this.recordingSessions.get(room.id);
    if (!session) {
      return this.getState();
    }
    session.stopping = true;
    session.danmakuClient?.close('手动停止');
    if (session.ffmpeg.stdin && !session.ffmpeg.stdin.destroyed) {
      try {
        session.ffmpeg.stdin.write('q');
      } catch {
        session.ffmpeg.kill();
      }
    } else {
      session.ffmpeg.kill();
    }
    setTimeout(() => {
      if (!session.ffmpeg.killed && room.recording) {
        session.ffmpeg.kill();
      }
    }, 5000);
    this.log('info', `${roomLabel(room)} 正在停止录制。`);
    this.emitState();
    return this.getState();
  }

  async finishRecording(roomId, code, signal) {
    const room = this.rooms.get(roomId);
    const session = this.recordingSessions.get(roomId);
    if (!room || !session) {
      return;
    }

    session.danmakuClient?.close('录制结束');
    await new Promise((resolve) => session.eventStream.end(resolve));
    room.recording = false;
    if (room.currentRecording) {
      room.currentRecording.eventCount = session.eventCount;
    }
    this.recordingSessions.delete(roomId);

    if (code === 0 || session.stopping) {
      this.log(
        'success',
        `${roomLabel(room)} 录制结束：${path.basename(session.cleanPath)}，弹幕事件 ${session.eventCount} 条。`
      );
    } else {
      this.log('error', `${roomLabel(room)} 录制进程异常退出：退出码 ${code}，信号 ${signal || '-'}`);
    }

    this.emitState();

    if (this.settings.autoBurnDanmaku && session.eventCount > 0) {
      setTimeout(() => {
        this.startBurnDanmaku(roomId).catch((error) => {
          this.log('error', `${roomLabel(room)} 自动烧录失败：${error.message}`);
        });
      }, 500);
    }
  }

  async startBurnDanmaku(roomId) {
    const room = this.getRoom(roomId);
    if (room.burning) {
      return this.getState();
    }
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      this.log('warn', `${roomLabel(room)} 没有可烧录的最近录像。`);
      return this.getState();
    }

    try {
      await this.generateAss(recording);
      const burnedPath = recording.burnedPath || deriveSiblingPath(recording.cleanPath, 'danmaku');
      recording.burnedPath = burnedPath;

      const args = createBurnArgs({
        cleanPath: recording.cleanPath,
        assPath: recording.assPath,
        burnedPath,
        codec: this.settings.burnCodec,
        crf: this.settings.burnCrf,
        container: getContainerFromPath(burnedPath)
      });
      const ffmpeg = spawn(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      room.burning = true;
      this.burnSessions.set(room.id, ffmpeg);
      this.log('info', `${roomLabel(room)} 正在生成有弹幕版：${path.basename(burnedPath)}`);

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (/error|failed|invalid/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 烧录：${compactLogLine(text)}`);
        }
      });
      ffmpeg.on('error', (error) => {
        this.log('error', `${roomLabel(room)} 烧录进程启动失败：${error.message}`);
      });
      ffmpeg.on('close', (code, signal) => {
        room.burning = false;
        this.burnSessions.delete(room.id);
        if (code === 0) {
          this.log('success', `${roomLabel(room)} 有弹幕版已生成：${path.basename(burnedPath)}`);
        } else {
          this.log('error', `${roomLabel(room)} 烧录失败：退出码 ${code}，信号 ${signal || '-'}`);
        }
        this.emitState();
      });
    } catch (error) {
      room.burning = false;
      this.log('error', `${roomLabel(room)} 生成弹幕版失败：${error.message}`);
    }
    this.emitState();
    return this.getState();
  }

  async generateAss(recording) {
    const raw = await fsp.readFile(recording.danmakuPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const events = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const ass = createAss(events);
    recording.assPath = recording.assPath || deriveSiblingPath(recording.cleanPath, 'danmaku', 'ass');
    await fsp.writeFile(recording.assPath, ass, 'utf8');
    return recording.assPath;
  }

  createFfmpegHeaders(room) {
    const lines = [
      `Referer: https://live.bilibili.com/${room.realRoomId || room.id}`,
      'Origin: https://live.bilibili.com'
    ];
    const cookie = sanitizeHeaderValue(this.settings.cookie);
    if (cookie) {
      lines.push(`Cookie: ${cookie}`);
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  async clearLogs() {
    this.logs = [];
    this.emitState();
    return this.getState();
  }

  getRoom(roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room) {
      throw new Error(`找不到房间 ${roomId}`);
    }
    return room;
  }

  shutdown() {
    this.clearLoginTimer();
    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();
    for (const room of this.rooms.values()) {
      const session = this.recordingSessions.get(room.id);
      session?.danmakuClient?.close('服务退出');
      if (session?.ffmpeg && !session.ffmpeg.killed) {
        try {
          session.ffmpeg.stdin?.write('q');
        } catch {
          session.ffmpeg.kill();
        }
      }
    }
  }
}

class DanmakuClient {
  constructor(options) {
    this.roomId = options.roomId;
    this.token = options.token;
    this.hosts = options.hosts;
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
    this.onError = options.onError;
    this.onCommand = options.onCommand;
    this.ws = null;
    this.heartbeatTimer = null;
  }

  connect() {
    const host = this.pickHost();
    this.ws = new WebSocket(host);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => {
      this.onOpen?.();
      this.sendAuth();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30000);
      this.sendHeartbeat();
    });
    this.ws.on('message', (data) => this.handleMessage(Buffer.from(data)));
    this.ws.on('error', (error) => this.onError?.(error));
    this.ws.on('close', (_code, reason) => {
      clearInterval(this.heartbeatTimer);
      this.onClose?.(reason?.toString() || 'closed');
    });
  }

  pickHost() {
    const list = Array.isArray(this.hosts) ? this.hosts : [];
    const best = list.find((item) => item.wss_port) || list[0];
    if (best?.host) {
      return `wss://${best.host}:${best.wss_port || 443}/sub`;
    }
    return 'wss://broadcastlv.chat.bilibili.com:443/sub';
  }

  sendAuth() {
    this.sendPacket(
      DANMAKU_OP.AUTH,
      JSON.stringify({
        uid: 0,
        roomid: this.roomId,
        protover: 3,
        platform: 'web',
        type: 2,
        key: this.token
      })
    );
  }

  sendHeartbeat() {
    this.sendPacket(DANMAKU_OP.HEARTBEAT, '');
  }

  sendPacket(operation, body) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = Buffer.from(body || '', 'utf8');
    const buffer = Buffer.alloc(16 + payload.length);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.writeUInt16BE(16, 4);
    buffer.writeUInt16BE(1, 6);
    buffer.writeUInt32BE(operation, 8);
    buffer.writeUInt32BE(1, 12);
    payload.copy(buffer, 16);
    this.ws.send(buffer);
  }

  handleMessage(buffer) {
    for (const packet of unpackDanmakuPackets(buffer)) {
      if (packet.operation !== DANMAKU_OP.MESSAGE) {
        continue;
      }
      for (const body of decodeDanmakuPacket(packet)) {
        try {
          const command = JSON.parse(body);
          this.onCommand?.(command);
        } catch {
          // Bilibili occasionally sends non-JSON payloads.
        }
      }
    }
  }

  close(reason) {
    clearInterval(this.heartbeatTimer);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(1000, reason || 'closed');
    }
  }
}

async function start() {
  const service = new LiveRecordService();
  await service.init();
  const vite = DEV_MODE ? await createViteMiddleware() : null;

  const server = http.createServer((request, response) => {
    handleRequest(service, vite, request, response).catch((error) => {
      writeJson(response, 500, { error: error.message || String(error) });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`哔哩录播 2K WebUI 已启动: http://${HOST}:${PORT}`);
    console.log('浏览器关闭后，保持这个 Node 进程运行即可继续监听/录制。');
  });

  const shutdown = () => {
    service.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function createViteMiddleware() {
  const { createServer } = await import('vite');
  return createServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
}

async function handleRequest(service, vite, request, response) {
  const parsed = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (parsed.pathname.startsWith('/api/')) {
    await handleApi(service, parsed.pathname, request, response);
    return;
  }

  if (vite) {
    vite.middlewares(request, response, () => {
      writeJson(response, 404, { error: 'Not found' });
    });
    return;
  }

  await serveStatic(parsed.pathname, response);
}

async function handleApi(service, pathname, request, response) {
  if (request.method === 'GET' && pathname === '/api/state') {
    writeJson(response, 200, service.getState());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    service.addClient(response);
    return;
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const body = await readJsonBody(request);
  const routes = {
    '/api/auth/qr/start': () => service.startQrLogin(),
    '/api/auth/qr/cancel': () => service.cancelQrLogin(),
    '/api/settings/choose-output-dir': () => service.chooseOutputDir(),
    '/api/settings/save': () => service.saveSettings(body.settings || body),
    '/api/rooms/add': () => service.addRoom(body.roomId),
    '/api/rooms/remove': () => service.removeRoom(body.roomId),
    '/api/rooms/refresh': () => service.refreshRoom(body.roomId),
    '/api/rooms/monitor': () => service.setMonitoring(body.roomId, body.enabled),
    '/api/rooms/record/start': () => service.startRecording(body.roomId, false),
    '/api/rooms/record/stop': () => service.stopRecording(body.roomId),
    '/api/rooms/burn': () => service.startBurnDanmaku(body.roomId),
    '/api/logs/clear': () => service.clearLogs(),
    '/api/shell/open-output': () => service.openOutputDir()
  };

  const action = routes[pathname];
  if (!action) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const result = await action();
    writeJson(response, 200, result === undefined ? { ok: true } : result);
  } catch (error) {
    service.log('error', error.message || String(error));
    writeJson(response, 500, { error: error.message || String(error) });
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function serveStatic(pathname, response) {
  const root = path.resolve(process.cwd(), 'dist');
  const decodedPath = decodeURIComponent(pathname);
  const safePath = decodedPath === '/' ? '/index.html' : decodedPath;
  let filePath = path.resolve(root, `.${safePath}`);

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    response.end(data);
  } catch (error) {
    writeJson(response, 404, { error: `dist 未构建或文件不存在：${error.message}` });
  }
}

function unpackDanmakuPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);
    if (packetLength <= 0 || offset + packetLength > buffer.length) {
      break;
    }
    packets.push({
      version,
      operation,
      sequence,
      body: buffer.subarray(offset + headerLength, offset + packetLength)
    });
    offset += packetLength;
  }
  return packets;
}

function decodeDanmakuPacket(packet) {
  if (packet.version === 0 || packet.version === 1) {
    return [packet.body.toString('utf8')].filter(Boolean);
  }
  if (packet.version === 2) {
    const inflated = zlib.inflateSync(packet.body);
    return unpackDanmakuPackets(inflated).flatMap(decodeDanmakuPacket);
  }
  if (packet.version === 3) {
    const decompressed = zlib.brotliDecompressSync(packet.body);
    return unpackDanmakuPackets(decompressed).flatMap(decodeDanmakuPacket);
  }
  return [];
}

async function requestBiliJsonWithCookies(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://passport.bilibili.com/',
      Origin: 'https://passport.bilibili.com',
      'User-Agent': USER_AGENT
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回不是 JSON：${text.slice(0, 120)}`);
  }
  return {
    json,
    cookies: getSetCookieHeaders(response.headers)
  };
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  if (!combined) {
    return [];
  }
  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(header) {
  return String(header)
    .split(/,(?=\s*[^;,=\s]+=[^;]+)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCookieString(existingCookie, setCookieHeaders) {
  const jar = new Map();
  for (const part of String(existingCookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0) {
      jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
    }
  }

  for (const header of setCookieHeaders || []) {
    const pair = String(header).split(';')[0]?.trim();
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  return Array.from(jar.entries())
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function normalizeDanmakuEvent(command, startedAt) {
  const type = String(command.cmd || '').split(':')[0];
  const time = Math.max(0, (Date.now() - startedAt) / 1000);

  if (type === 'DANMU_MSG') {
    const info = command.info || [];
    return {
      type: 'danmaku',
      time,
      text: String(info[1] || ''),
      user: String(info[2]?.[1] || ''),
      color: Number(info[0]?.[3] || 0xffffff)
    };
  }

  if (type === 'SEND_GIFT') {
    const data = command.data || {};
    return {
      type: 'gift',
      time,
      user: String(data.uname || ''),
      giftName: String(data.giftName || data.gift_name || '礼物'),
      count: Number(data.num || 1),
      price: Number(data.price || data.discount_price || 0) / 1000
    };
  }

  if (type === 'SUPER_CHAT_MESSAGE') {
    const data = command.data || {};
    return {
      type: 'superchat',
      time,
      user: String(data.user_info?.uname || data.uname || ''),
      text: String(data.message || ''),
      price: Number(data.price || 0),
      duration: Number(data.time || data.duration || 60)
    };
  }

  if (type === 'GUARD_BUY') {
    const data = command.data || {};
    return {
      type: 'guard',
      time,
      user: String(data.username || data.uname || ''),
      giftName: String(data.gift_name || guardName(data.guard_level)),
      count: Number(data.num || 1),
      price: Number(data.price || 0) / 1000
    };
  }

  return null;
}

function createAss(events) {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Danmaku,Microsoft YaHei,38,&H00FFFFFF,&H000000FF,&H96000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,7,20,20,20,1',
    'Style: BoxText,Microsoft YaHei,30,&H00FFFFFF,&H000000FF,&H32000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1',
    'Style: Shape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const danmakuRows = Array(8).fill(0);
  const scRows = Array(3).fill(0);
  const giftRows = Array(4).fill(0);

  for (const event of sorted) {
    if (event.type === 'danmaku') {
      const duration = 8;
      const row = chooseLane(danmakuRows, event.time, duration);
      const y = 36 + row * 46;
      const width = estimateTextWidth(event.text, 38);
      const color = assColorFromRgb(event.color || 0xffffff);
      lines.push(
        dialogue(
          1,
          event.time,
          event.time + duration,
          'Danmaku',
          `{\\1c${color}\\move(1980,${y},-${width},${y})}${assEscape(event.text)}`
        )
      );
      continue;
    }

    if (event.type === 'superchat') {
      const duration = clamp(Number(event.duration || 60), 30, 180);
      const row = chooseLane(scRows, event.time, duration);
      const x = 34;
      const y = 618 - row * 132;
      const palette = superChatPalette(event.price || 0);
      const title = `${event.user || '用户'}  ￥${event.price || 0}`;
      lines.push(drawRect(7, event.time, event.time + duration, x, y, 570, 42, palette.header));
      lines.push(drawRect(6, event.time, event.time + duration, x, y + 42, 570, 88, palette.body));
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 8})\\fs27\\b1}${assEscape(title)}`
        )
      );
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 54})\\fs24\\b0}${assEscape(wrapText(event.text, 28, 2))}`
        )
      );
      continue;
    }

    if (event.type === 'gift' || event.type === 'guard') {
      const duration = event.type === 'guard' ? 8 : 5;
      const row = chooseLane(giftRows, event.time, duration);
      const x = 34;
      const y = 934 - row * 56;
      const label =
        event.type === 'guard'
          ? `${event.user || '用户'} 开通 ${event.giftName || '舰长'} x${event.count || 1}`
          : `${event.user || '用户'} 送出 ${event.giftName || '礼物'} x${event.count || 1}`;
      lines.push(drawRect(5, event.time, event.time + duration, x, y, 500, 44, '&H8A2A1B12&'));
      lines.push(
        dialogue(
          6,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 16},${y + 8})\\fs24}${assEscape(truncateText(label, 36))}`
        )
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function createRecordingArgs({ streamUrl, headers, outputPath, container, streamCodec }) {
  const args = [
    '-hide_banner',
    '-stats',
    '-y',
    '-rw_timeout',
    '15000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '10',
    '-user_agent',
    USER_AGENT,
    '-headers',
    headers,
    '-i',
    streamUrl,
    '-map',
    '0',
    '-c',
    'copy'
  ];

  if (container === 'mp4') {
    if (isHevcCodec(streamCodec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', outputPath);
    return args;
  }

  args.push('-f', 'matroska', outputPath);
  return args;
}

function createBurnArgs({ cleanPath, assPath, burnedPath, codec, crf, container }) {
  const args = ['-hide_banner', '-y', '-i', cleanPath, '-vf', `ass='${escapeFilterPath(assPath)}'`, '-c:v', codec || 'libx265'];

  if ((codec || '').includes('nvenc')) {
    args.push('-preset', 'p5', '-cq', String(crf), '-b:v', '0');
  } else if ((codec || '').includes('qsv')) {
    args.push('-global_quality', String(crf));
  } else if ((codec || '').includes('amf')) {
    args.push('-quality', 'balanced', '-qp_i', String(crf), '-qp_p', String(crf));
  } else {
    args.push('-preset', 'medium', '-crf', String(crf));
  }

  if (container === 'mp4') {
    if (isHevcCodec(codec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }

  args.push('-c:a', 'copy', burnedPath);
  return args;
}

function drawRect(layer, start, end, x, y, width, height, color) {
  const shape = `m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}`;
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{\\fad(120,260)\\p1\\pos(${x},${y})\\bord0\\shad0\\1c${color}}${shape}`
  );
}

function dialogue(layer, start, end, style, text) {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function assTime(seconds) {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text) {
  return String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

function assColorFromRgb(rgb) {
  const value = Number(rgb) || 0xffffff;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `&H00${hex2(b)}${hex2(g)}${hex2(r)}&`;
}

function hex2(value) {
  return Number(value).toString(16).padStart(2, '0').toUpperCase();
}

function superChatPalette(price) {
  if (price >= 1000) {
    return { header: '&H002D35E5&', body: '&H00503D8B&' };
  }
  if (price >= 500) {
    return { header: '&H00344BD9&', body: '&H00475AAE&' };
  }
  if (price >= 100) {
    return { header: '&H0000A5FF&', body: '&H002B8FE6&' };
  }
  if (price >= 50) {
    return { header: '&H0000C8B8&', body: '&H0033B9B0&' };
  }
  return { header: '&H00D88B2D&', body: '&H00B87931&' };
}

function chooseLane(lanes, start, duration) {
  let best = 0;
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] <= start) {
      best = index;
      break;
    }
    if (lanes[index] < lanes[best]) {
      best = index;
    }
  }
  lanes[best] = start + duration;
  return best;
}

function estimateTextWidth(text, fontSize) {
  const length = Array.from(String(text || '')).reduce((sum, char) => {
    return sum + (/[\u4e00-\u9fa5]/.test(char) ? 1 : 0.58);
  }, 0);
  return Math.ceil(length * fontSize);
}

function truncateText(text, max) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= max) {
    return text || '';
  }
  return `${chars.slice(0, max - 1).join('')}…`;
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const chars = Array.from(String(text || ''));
  const lines = [];
  for (let index = 0; index < chars.length && lines.length < maxLines; index += maxCharsPerLine) {
    lines.push(chars.slice(index, index + maxCharsPerLine).join(''));
  }
  if (chars.length > maxCharsPerLine * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${Array.from(lines[lines.length - 1])
      .slice(0, maxCharsPerLine - 1)
      .join('')}…`;
  }
  return lines.join('\\N');
}

function sanitizeFilename(name) {
  return String(name || 'recording')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function normalizeContainer(value) {
  return value === 'mkv' ? 'mkv' : 'mp4';
}

function getContainerFromPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.mkv' ? 'mkv' : 'mp4';
}

function deriveSiblingPath(filePath, suffix, extension) {
  const parsed = path.parse(filePath);
  const ext = extension || parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  return path.join(parsed.dir, `${base}.${suffix}.${ext}`);
}

function isHevcCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('hevc') || value.includes('h265') || value.includes('x265');
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function streamScore(stream, settings) {
  const codec = String(stream.codec || '').toLowerCase();
  const hevc = codec.includes('hevc') || codec.includes('h265');
  const avc = codec.includes('avc') || codec.includes('h264');
  const codecScore = settings.preferHevc ? (hevc ? 1_000_000 : avc ? 100_000 : 0) : avc ? 1_000_000 : 0;
  const protocolScore = stream.protocol.includes('hls') ? 10_000 : 5_000;
  const formatScore = stream.format.includes('fmp4') ? 2_000 : stream.format.includes('flv') ? 1_000 : 0;
  return codecScore + protocolScore + formatScore + Number(stream.qn || 0);
}

function displayCodecName(codec) {
  const value = String(codec || '').toLowerCase();
  if (value.includes('hevc') || value.includes('h265')) {
    return 'H.265';
  }
  if (value.includes('avc') || value.includes('h264')) {
    return 'H.264';
  }
  return String(codec || '未知').toUpperCase();
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function compactLogLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, number));
}

function roomLabel(room) {
  return `${room.anchor || room.title || '直播间'}(${room.realRoomId || room.id})`;
}

function guardName(level) {
  if (Number(level) === 1) {
    return '总督';
  }
  if (Number(level) === 2) {
    return '提督';
  }
  return '舰长';
}

function findFfmpegPath() {
  const localBinary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    path.join(process.cwd(), 'bin', localBinary),
    path.join(process.cwd(), localBinary),
    ffmpegStatic,
    'ffmpeg'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      return candidate;
    }
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep trying.
    }
  }
  return 'ffmpeg';
}

function openPath(targetPath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp'
    }[ext] || 'application/octet-stream'
  );
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
