'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService, pipeLocalFileToResponse } = require('../src/server/app/service.cjs');

const DEFAULT_FILE_SIZE = 16 * 1024 * 1024;

// 拦截 fs.createReadStream，记录每个 ReadStream 的 destroy 时机，
// 以验证“客户端断开时必须在流自然结束前 destroy”。
function trackCreateReadStream() {
  const original = fs.createReadStream;
  const records = [];
  fs.createReadStream = function (...args) {
    const stream = original.apply(this, args);
    const record = {
      stream,
      destroyCalls: [],
      closedPromise: new Promise((resolve) => stream.once('close', resolve))
    };
    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = (...destroyArgs) => {
      record.destroyCalls.push({
        readableEnded: stream.readableEnded,
        closed: stream.closed
      });
      return originalDestroy(...destroyArgs);
    };
    records.push(record);
    return stream;
  };
  return {
    records,
    restore() {
      fs.createReadStream = original;
    }
  };
}

async function createFileServer({ size = DEFAULT_FILE_SIZE } = {}) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-file-stream-'));
  const filePath = path.join(tempDir, 'sample.clean.mp4');
  await fsp.writeFile(filePath, Buffer.alloc(size, 0x5a));
  const tracker = trackCreateReadStream();

  const server = http.createServer((request, response) => {
    const total = size;
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    const range = String(request.headers.range || '');
    if (!range) {
      response.writeHead(200, { ...headers, 'Content-Length': String(total) });
      pipeLocalFileToResponse(filePath, request, response);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    });
    pipeLocalFileToResponse(filePath, request, response, { start, end });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    filePath,
    tempDir,
    size,
    records: tracker.records,
    port: server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      tracker.restore();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function waitForStreamClosed(record, timeoutMs = 15000) {
  if (record.stream.closed) return;
  let timer;
  await Promise.race([
    record.closedPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ReadStream 未在限定时间内关闭')), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function abortRequest(port, headers = {}, pathname = '/') {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (response) => {
      response.once('data', () => request.destroy());
      response.on('error', () => {});
    });
    request.on('error', () => {});
    request.on('close', resolve);
  });
}

function readFullResponse(port, pathname = '/') {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.on('end', () => resolve(bytes));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('完整 MP4 请求中途断开：ReadStream 必须关闭', async () => {
  const fixture = await createFileServer();
  try {
    await abortRequest(fixture.port);
    assert.equal(fixture.records.length, 1);
    const record = fixture.records[0];
    await waitForStreamClosed(record);
    assert.ok(
      record.destroyCalls.some((call) => call.readableEnded === false),
      '客户端断开时应立即 destroy（不能在流自然结束后才关闭）'
    );
  } finally {
    await fixture.close();
  }
});

test('Range 请求中途断开：ReadStream 必须关闭', async () => {
  const fixture = await createFileServer();
  try {
    await abortRequest(fixture.port, { Range: 'bytes=4194304-10485759' });
    assert.equal(fixture.records.length, 1);
    const record = fixture.records[0];
    await waitForStreamClosed(record);
    assert.ok(
      record.destroyCalls.some((call) => call.readableEnded === false),
      '客户端断开时应立即 destroy（不能在流自然结束后才关闭）'
    );
  } finally {
    await fixture.close();
  }
});

test('连续多个 Range 请求全部断开：不能残留文件句柄', async () => {
  const fixture = await createFileServer();
  try {
    const ranges = Array.from({ length: 8 }, (_, index) => {
      const start = index * 2 * 1024 * 1024;
      const end = (index + 1) * 2 * 1024 * 1024 - 1;
      return `bytes=${start}-${end}`;
    });
    await Promise.all(ranges.map((Range) => abortRequest(fixture.port, { Range })));
    assert.equal(fixture.records.length, ranges.length);
    await Promise.all(fixture.records.map((record) => waitForStreamClosed(record)));
    for (const record of fixture.records) {
      assert.ok(
        record.destroyCalls.some((call) => call.readableEnded === false),
        '每个断开的 Range 请求都必须立即释放 ReadStream'
      );
    }
    // 在 Windows 上文件重命名可以证明没有任何残留句柄。
    const moved = `${fixture.filePath}.released`;
    await fsp.rename(fixture.filePath, moved);
    await fsp.rename(moved, fixture.filePath);
  } finally {
    await fixture.close();
  }
});

test('正常播放完整下载：不能误提前 destroy', async () => {
  const fixture = await createFileServer({ size: 2 * 1024 * 1024 });
  try {
    const receivedBytes = await readFullResponse(fixture.port);
    assert.equal(receivedBytes, fixture.size);
    assert.equal(fixture.records.length, 1);
    const record = fixture.records[0];
    await waitForStreamClosed(record);
    assert.ok(
      record.destroyCalls.every((call) => call.readableEnded === true),
      '正常完成时不允许在可读结束前调用 destroy'
    );
  } finally {
    await fixture.close();
  }
});

test('兼容预览 .ts 分片中途断开：统一生命周期生效', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-preview-stream-'));
  const previewDir = path.join(tempDir, 'a');
  await fsp.mkdir(previewDir, { recursive: true });
  await fsp.writeFile(path.join(previewDir, 'segment_00000.ts'), Buffer.alloc(8 * 1024 * 1024, 0x21));
  const service = new LiveRecordService();
  service.previewCacheDir = tempDir;
  const tracker = trackCreateReadStream();
  const server = http.createServer(async (request, response) => {
    await service.serveExportPreview(new URL(request.url, 'http://127.0.0.1'), request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await abortRequest(port, {}, '/api/export/preview/a/segment_00000.ts');
    assert.equal(tracker.records.length, 1);
    const record = tracker.records[0];
    await waitForStreamClosed(record);
    assert.ok(
      record.destroyCalls.some((call) => call.readableEnded === false),
      '预览分片断开时必须立即 destroy'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    tracker.restore();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('兼容预览 .m3u8 正常读取：不误提前释放', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-preview-m3u8-'));
  const previewDir = path.join(tempDir, 'a');
  await fsp.mkdir(previewDir, { recursive: true });
  const playlistPath = path.join(previewDir, 'index.m3u8');
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nsegment_00000.ts\n#EXT-X-ENDLIST\n';
  await fsp.writeFile(playlistPath, playlist, 'utf8');
  const service = new LiveRecordService();
  service.previewCacheDir = tempDir;
  const tracker = trackCreateReadStream();
  const server = http.createServer(async (request, response) => {
    await service.serveExportPreview(new URL(request.url, 'http://127.0.0.1'), request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const expectedBytes = Buffer.byteLength(playlist, 'utf8');
    const receivedBytes = await readFullResponse(port, '/api/export/preview/a/index.m3u8');
    assert.equal(receivedBytes, expectedBytes);
    assert.equal(tracker.records.length, 1);
    const record = tracker.records[0];
    await waitForStreamClosed(record);
    assert.ok(
      record.destroyCalls.every((call) => call.readableEnded === true),
      '预览清单正常读取时不允许提前 destroy'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    tracker.restore();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('多客户端同时读取：一个关闭不能影响其他连接', async () => {
  const fixture = await createFileServer({ size: 8 * 1024 * 1024 });
  try {
    const normalBytesPromise = readFullResponse(fixture.port);
    const abortPromise = abortRequest(fixture.port);
    const [normalBytes] = await Promise.all([normalBytesPromise, abortPromise]);
    assert.equal(normalBytes, fixture.size);
    assert.equal(fixture.records.length, 2);
    await Promise.all(fixture.records.map((record) => waitForStreamClosed(record)));

    const abortedRecord = fixture.records.find((record) =>
      record.destroyCalls.some((call) => call.readableEnded === false)
    );
    const normalRecord = fixture.records.find((record) => record !== abortedRecord);
    assert.ok(abortedRecord, '应有一个被中断的连接');
    assert.ok(normalRecord, '应有一个正常完成的连接');
    assert.ok(
      normalRecord.destroyCalls.every((call) => call.readableEnded === true),
      '并发读取时正常连接不能被另一个连接的中断影响'
    );
    assert.ok(
      abortedRecord.destroyCalls.some((call) => call.readableEnded === false),
      '断开的连接必须立即 destroy'
    );
  } finally {
    await fixture.close();
  }
});
