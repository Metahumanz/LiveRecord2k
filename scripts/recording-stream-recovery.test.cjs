const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveRecordService } = require('../src/server/app/service.cjs');

function fixture() {
  const service = new LiveRecordService();
  service.log = () => {};
  service.settings.targetQn = 10000;
  service.settings.preferHevc = true;
  service.fetchBiliJson = async () => ({ code: 0, data: { playurl_info: { playurl: { stream: [
    { protocol_name: 'http_stream', format: [{ format_name: 'flv', codec: [{ codec_name: 'hevc', current_qn: 10000,
      base_url: '/video.flv', url_info: [{host: 'https://same.example'}, {host: 'https://another.example'}] }] }] },
    { protocol_name: 'http_hls', format: [{ format_name: 'fmp4', codec: [{ codec_name: 'hevc', current_qn: 10000,
      base_url: '/video.m3u8', url_info: [{host: 'https://same.example'}] }] }] }
  ] } } } });
  return service;
}

test('startup-corrupt FLV switches to HLS without penalizing the same host or retrying another FLV CDN', async () => {
  const service = fixture();
  const room = { id: '1', realRoomId: '1' };
  const first = await service.resolvePlayStream(room, {liveSessionId: 'live-a'});
  assert.equal(first.format, 'flv');
  service.recordStreamHealth('live-a', first, 'startup-corruption');
  const next = await service.resolvePlayStream(room, {liveSessionId: 'live-a'});
  assert.equal(next.format, 'fmp4');
  assert.equal(next.host, first.host);
  assert.equal(service.getStreamHealthPenalty('live-a', next), 0);
  const newLive = await service.resolvePlayStream(room, {liveSessionId: 'live-b'});
  assert.equal(newLive.format, 'flv');
});

test('ordinary CDN network failures do not blacklist the format on other hosts', async () => {
  const service = fixture();
  const room = { id: '1', realRoomId: '1' };
  const first = await service.resolvePlayStream(room, {liveSessionId: 'live-a'});
  service.recordStreamHealth('live-a', first, 'network-error');
  const next = await service.resolvePlayStream(room, {liveSessionId: 'live-a'});
  assert.equal(next.format, 'flv');
  assert.equal(next.host, 'https://another.example');
});

test('failed capture diagnostics retain the FFmpeg tail without stream URLs or tokens', async () => {
  const service = fixture();
  service.queueDiagnosticsWrite = async () => {};
  const session = {liveSessionId:'diag', startedAt:1, discardStartupSegment:true,
    ffmpegLogBuffer:'[hevc] Invalid NAL unit\nhttps://cdn.example/file?token=secret-value', containerStage:'failed'};
  await service.appendSegmentDiagnostics({id:'1'}, session, {valid:false, cleanPath:'failed.clean.mp4'});
  const result = service.liveDiagnostics.get('diag').video.segments[0];
  assert.match(result.failureDetail, /Invalid NAL unit/);
  assert.doesNotMatch(result.failureDetail, /cdn\.example|secret-value/);
  assert.equal(result.containerStage, 'failed');
});
