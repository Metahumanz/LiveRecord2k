const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const WebSocket = require('ws');

const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);
const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_PAYLOAD_BYTES = 32 * 1024 * 1024;
// A normal Bilibili batch is only one compressed layer deep and contains far
// fewer commands than these limits.  Keep decoding bounded so a malformed
// nested payload cannot exhaust the decoder queue or V8's argument stack.
const MAX_DANMAKU_NESTING_DEPTH = 4;
const MAX_DANMAKU_PACKETS_PER_PAYLOAD = 50_000;
const MAX_DECODED_DANMAKU_BODIES = 50_000;
const MAX_TOTAL_DECOMPRESSED_BYTES = MAX_DECOMPRESSED_PAYLOAD_BYTES;

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

// Wall clock can jump when the system time is corrected.  Packet ordering and
// recording alignment must therefore use a monotonic source instead.
function monotonicNowMs() {
  return performance.now();
}

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
    this.onPacketMetrics = options.onPacketMetrics;
    this.onDecodeError = options.onDecodeError;
    this.decodePacket = typeof options.decodePacket === 'function' ? options.decodePacket : decodeDanmakuPacket;
    this.nowMono = typeof options.nowMono === 'function' ? options.nowMono : monotonicNowMs;
    this.nowWall = typeof options.nowWall === 'function' ? options.nowWall : Date.now;
    this.ws = null;
    this.heartbeatTimer = null;
    this.messageQueue = Promise.resolve();
    this.queuedPackets = 0;
    this.oldestQueuedMono = 0;
    this.queuedPacketMonos = [];
    this.packetMetrics = {
      received: 0,
      processed: 0,
      decodeErrors: 0,
      maxQueueLagMs: 0,
      totalQueueLagMs: 0
    };
  }

  connect() {
    const host = this.pickHost();
    this.ws = new WebSocket(host, { maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => {
      this.onOpen?.();
      this.sendAuth();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30000);
      this.sendHeartbeat();
    });
    this.ws.on('message', (data) => this.enqueueRawPacket(data));
    this.ws.on('error', (error) => this.onError?.(error));
    this.ws.on('close', (_code, reason) => {
      clearInterval(this.heartbeatTimer);
      this.onClose?.(reason?.toString() || 'closed');
    });
  }

  enqueueRawPacket(data) {
    // Capture this before Buffer conversion, decompression, and JSON parsing.
    // A congested decoder queue must never shift a danmaku event later on the
    // media timeline merely because it was parsed later.
    const receivedMono = this.nowMono();
    const envelope = {
      buffer: Buffer.from(data),
      receivedAt: this.nowWall(),
      receivedMono
    };
    this.queuedPackets += 1;
    this.queuedPacketMonos.push(receivedMono);
    this.oldestQueuedMono = this.queuedPacketMonos[0] || 0;
    this.packetMetrics.received += 1;
    this.emitPacketMetrics('received', envelope);
    this.messageQueue = this.messageQueue
      .then(() => this.handleMessage(envelope))
      .catch((error) => {
        this.reportDecodeError(error, { phase: 'queue' }, envelope);
        this.onError?.(error);
      })
      .finally(() => this.finishQueuedPacket(envelope));
    return this.messageQueue;
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

  async handleMessage(envelope) {
    const { buffer } = envelope;
    let packets;
    try {
      packets = unpackDanmakuPackets(buffer);
    } catch (error) {
      this.reportDecodeError(error, {
        phase: 'unpack',
        bytes: buffer.length
      }, envelope);
      return;
    }
    const consumedBytes = packets.reduce((sum, packet) => sum + Number(packet.packetLength || 0), 0);
    if ((!packets.length || consumedBytes !== buffer.length) && buffer.length) {
      this.reportDecodeError(new Error('弹幕包头无效或不完整'), {
        phase: 'unpack',
        bytes: buffer.length,
        consumedBytes
      }, envelope);
    }
    for (const packet of packets) {
      if (packet.operation === DANMAKU_OP.AUTH_REPLY) {
        this.onAuthReply?.(decodeAuthReply(packet), envelope);
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
      if (![0, 1, 2, 3].includes(Number(packet.version))) {
        this.reportDecodeError(new Error(`不支持的弹幕协议版本 ${packet.version}`), packetContext(packet, 'protocol'), envelope);
        continue;
      }
      let bodies;
      try {
        bodies = await this.decodePacket(packet);
      } catch (error) {
        this.reportDecodeError(error, packetContext(packet, 'decode'), envelope);
        continue;
      }
      for (const body of bodies) {
        try {
          const command = JSON.parse(body);
          this.onCommand?.(command, envelope);
        } catch (error) {
          this.reportDecodeError(error, {
            ...packetContext(packet, 'json'),
            preview: String(body).slice(0, 180)
          }, envelope);
        }
      }
    }
  }

  finishQueuedPacket(envelope) {
    const lagMs = Math.max(0, this.nowMono() - Number(envelope?.receivedMono || this.nowMono()));
    this.packetMetrics.processed += 1;
    this.packetMetrics.totalQueueLagMs += lagMs;
    this.packetMetrics.maxQueueLagMs = Math.max(this.packetMetrics.maxQueueLagMs, lagMs);
    this.queuedPackets = Math.max(0, this.queuedPackets - 1);
    this.queuedPacketMonos.shift();
    this.oldestQueuedMono = this.queuedPacketMonos[0] || 0;
    this.emitPacketMetrics('processed', envelope, lagMs);
  }

  emitPacketMetrics(phase, envelope, latestQueueLagMs = 0) {
    const now = this.nowMono();
    const oldestPacketWaitMs = this.oldestQueuedMono ? Math.max(0, now - this.oldestQueuedMono) : 0;
    this.onPacketMetrics?.({
      phase,
      receivedAt: envelope?.receivedAt,
      receivedMono: envelope?.receivedMono,
      queueLength: this.queuedPackets,
      oldestPacketWaitMs,
      latestQueueLagMs,
      maxQueueLagMs: this.packetMetrics.maxQueueLagMs,
      averageQueueLagMs: this.packetMetrics.processed
        ? this.packetMetrics.totalQueueLagMs / this.packetMetrics.processed
        : 0,
      websocketPackets: this.packetMetrics.received,
      processedPackets: this.packetMetrics.processed,
      decodeErrors: this.packetMetrics.decodeErrors
    });
  }

  reportDecodeError(error, context, envelope) {
    this.packetMetrics.decodeErrors += 1;
    this.onDecodeError?.({
      error,
      context,
      receivedAt: envelope?.receivedAt,
      receivedMono: envelope?.receivedMono,
      decodeErrors: this.packetMetrics.decodeErrors
    });
    this.emitPacketMetrics('decode-error', envelope);
  }

  close(reason) {
    clearInterval(this.heartbeatTimer);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(1000, reason || 'closed');
    }
  }
}

function packetContext(packet, phase) {
  return {
    phase,
    operation: Number(packet?.operation || 0),
    protocolVersion: Number(packet?.version || 0),
    sequence: Number(packet?.sequence || 0),
    bytes: Number(packet?.body?.length || 0)
  };
}

function unpackDanmakuPackets(buffer, maxPackets = MAX_DANMAKU_PACKETS_PER_PAYLOAD) {
  const packets = [];
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);
    if (packetLength <= 0 || headerLength < 16 || headerLength > packetLength || offset + packetLength > buffer.length) {
      break;
    }
    if (packets.length >= maxPackets) {
      throw createDanmakuDecodeLimitError(
        'DANMAKU_PACKET_LIMIT',
        `弹幕包数量超过上限（${maxPackets}）`
      );
    }
    packets.push({
      version,
      operation,
      sequence,
      packetLength,
      body: buffer.subarray(offset + headerLength, offset + packetLength)
    });
    offset += packetLength;
  }
  return packets;
}

async function decodeDanmakuPacket(packet) {
  const bodies = [];
  await collectDanmakuPacketBodies(packet, bodies, {
    packetCount: 0,
    bodyCount: 0,
    decompressedBytes: 0
  }, 0);
  return bodies;
}

async function collectDanmakuPacketBodies(packet, bodies, state, compressionDepth) {
  if (packet.version === 0 || packet.version === 1) {
    const body = packet.body.toString('utf8');
    if (!body) return;
    if (state.bodyCount >= MAX_DECODED_DANMAKU_BODIES) {
      throw createDanmakuDecodeLimitError(
        'DANMAKU_BODY_LIMIT',
        `弹幕命令数量超过上限（${MAX_DECODED_DANMAKU_BODIES}）`
      );
    }
    state.bodyCount += 1;
    bodies.push(body);
    return;
  }
  if (packet.version !== 2 && packet.version !== 3) return;
  if (compressionDepth >= MAX_DANMAKU_NESTING_DEPTH) {
    throw createDanmakuDecodeLimitError(
      'DANMAKU_NESTING_LIMIT',
      `弹幕嵌套压缩层数超过上限（${MAX_DANMAKU_NESTING_DEPTH}）`
    );
  }

  const remainingOutputBytes = MAX_TOTAL_DECOMPRESSED_BYTES - state.decompressedBytes;
  if (remainingOutputBytes <= 0) {
    throw createDanmakuDecodeLimitError(
      'DANMAKU_DECOMPRESSED_LIMIT',
      `弹幕解压数据超过上限（${MAX_TOTAL_DECOMPRESSED_BYTES}）`
    );
  }
  const decompressed = packet.version === 2
    ? await inflate(packet.body, { maxOutputLength: Math.min(MAX_DECOMPRESSED_PAYLOAD_BYTES, remainingOutputBytes) })
    : await brotliDecompress(packet.body, { maxOutputLength: Math.min(MAX_DECOMPRESSED_PAYLOAD_BYTES, remainingOutputBytes) });
  state.decompressedBytes += decompressed.length;
  await decodeNestedDanmakuPackets(decompressed, bodies, state, compressionDepth + 1);
}

async function decodeNestedDanmakuPackets(buffer, bodies, state, compressionDepth) {
  for (const packet of unpackDanmakuPackets(buffer)) {
    if (state.packetCount >= MAX_DANMAKU_PACKETS_PER_PAYLOAD) {
      throw createDanmakuDecodeLimitError(
        'DANMAKU_PACKET_LIMIT',
        `弹幕嵌套包数量超过上限（${MAX_DANMAKU_PACKETS_PER_PAYLOAD}）`
      );
    }
    state.packetCount += 1;
    await collectDanmakuPacketBodies(packet, bodies, state, compressionDepth);
  }
}

function createDanmakuDecodeLimitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function safeDecodeDanmakuPacket(packet) {
  try {
    return await decodeDanmakuPacket(packet);
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
  monotonicNowMs,
  unpackDanmakuPackets,
  decodeDanmakuPacket,
  safeDecodeDanmakuPacket,
  decodeAuthReply
};
