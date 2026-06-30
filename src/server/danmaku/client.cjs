const zlib = require('node:zlib');
const WebSocket = require('ws');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DANMAKU_OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
};

class DanmakuClient {
  constructor(options) {
    this.roomId = options.roomId;
    this.uid = options.uid || 0;
    this.buvid = options.buvid || '';
    this.token = options.token;
    this.hosts = options.hosts;
    this.onOpen = options.onOpen;
    this.onAuthReply = options.onAuthReply;
    this.onHeartbeat = options.onHeartbeat;
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
        uid: this.uid,
        roomid: this.roomId,
        protover: 2,
        platform: 'web',
        type: 2,
        key: this.token,
        buvid: this.buvid
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
      if (packet.operation === DANMAKU_OP.AUTH_REPLY) {
        this.onAuthReply?.(decodeAuthReply(packet));
        continue;
      }
      if (packet.operation === DANMAKU_OP.HEARTBEAT_REPLY) {
        if (packet.body.length >= 4) {
          this.onHeartbeat?.(packet.body.readUInt32BE(0));
        }
        continue;
      }
      if (packet.operation !== DANMAKU_OP.MESSAGE) {
        continue;
      }
      for (const body of safeDecodeDanmakuPacket(packet)) {
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

function safeDecodeDanmakuPacket(packet) {
  try {
    return decodeDanmakuPacket(packet);
  } catch {
    return [];
  }
}

function decodeAuthReply(packet) {
  const text = packet.body.toString('utf8').trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { code: text };
    }
  }
  if (packet.body.length >= 4) {
    return { code: packet.body.readUInt32BE(0) };
  }
  return { code: 0 };
}

module.exports = {
  DanmakuClient,
  unpackDanmakuPackets,
  decodeDanmakuPacket,
  safeDecodeDanmakuPacket,
  decodeAuthReply
};
