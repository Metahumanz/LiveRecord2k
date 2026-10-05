'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { normalizeDanmakuEvent, prepareAssEvents, createAss, resolveDanmakuStyle, getSideInteractionCardMetrics, getMinimalSideInteractionMetrics, wrapTextToWidthLines, estimateTextWidth } = require('../src/server/danmaku/ass.cjs');
const { graphemes, unicodeAsset } = require('../src/server/danmaku/emoji.cjs');
const { buildSceneGraph, evaluateSceneObject } = require('../src/server/danmaku/scene-graph.cjs');
const { createSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { SessionEventDeduper } = require('../src/server/danmaku/dedupe.cjs');
const { selectSceneSample } = require('../src/server/danmaku/desktop-scene-policy.cjs');

const timing = { receivedAt: 1791031951997, videoTime: 0.5 };
const url = 'https://i0.hdslb.com/bfs/emote/test.png';

function command(text, whole = false) {
  const meta = [0, 1, 25, 0xffffff];
  if (whole) { meta[12] = 1; meta[13] = { url, width: 128, height: 128, emoticon_unique: 'test' }; }
  else meta[15] = { extra: JSON.stringify({ emots: { '[测试]': { url, width: 128, height: 128 } } }) };
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [meta, text, [42, '测试观众']] };
}

test('empty V2 toast never becomes an anonymous guard card, including old recordings', () => {
  const buy = { cmd: 'GUARD_BUY', data: { uid: 42, username: '真实舰长', guard_level: 3, price: 198000, start_time: 1791031951 } };
  const first = normalizeDanmakuEvent(buy, timing);
  assert.equal(normalizeDanmakuEvent({ cmd: 'USER_TOAST_MSG_V2', data: { unsupported_notification: {} } }, timing), null);
  const old = { type: 'guard', uid: 0, user: '', guardLevel: 0, price: 0, sourceCmd: 'USER_TOAST_MSG_V2', time: 0.63 };
  assert.equal(prepareAssEvents([first, old]).length, 1);
  const graph = buildSceneGraph([first, old], { stylePreset: 'h5-card' });
  assert.ok(graph.objects.some(o => o.props.text === '真实舰长'));
  assert.ok(!JSON.stringify(graph).includes('Welcome new 大航海'));
  // A real user named 观众 or a second purchase must be retained.
  assert.equal(prepareAssEvents([{ ...old, uid: 7, user: '观众', guardLevel: 3 }]).length, 1);
  const deduper = new SessionEventDeduper();
  assert.equal(deduper.checkAndRemember(first, buy, timing.receivedAt).duplicate, false);
  const next = { ...buy, data: { ...buy.data, start_time: 1791031952 } };
  assert.equal(deduper.checkAndRemember(normalizeDanmakuEvent(next, timing), next, timing.receivedAt + 1000).duplicate, false);
});

test('nested guard identity includes UID, username and trusted face', () => {
  const event = normalizeDanmakuEvent({ cmd: 'USER_TOAST_MSG_V2', data: { uinfo: { uid: 42, base: { name: '嵌套舰长', face: url } }, guard_level: 3 } }, timing);
  assert.equal(event.uid, 42); assert.equal(event.user, '嵌套舰长'); assert.equal(event.avatarUrl, url);
});

test('DANMU_MSG stores single and embedded Bilibili emotes, rejects arbitrary hosts', () => {
  for (const [text, whole] of [['[测试]', true], ['中文[测试]😀', false]]) {
    const event = normalizeDanmakuEvent(command(text, whole), timing);
    assert.equal(event.text, text); assert.equal(event.emoticons[0].token, '[测试]'); assert.equal(event.emoticons[0].url, url);
  }
  const invalid = command('[测试]', true); invalid.info[0][13].url = 'http://127.0.0.1/private.png';
  assert.equal(normalizeDanmakuEvent(invalid, timing).emoticons, undefined);
});

test('grapheme wrapping keeps flags, skin tones, ZWJ families and keycaps together', () => {
  const glyphs = ['😀', '👍🏽', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '❤️'];
  for (const glyph of glyphs) {
    assert.equal(graphemes(glyph).length, 1);
    assert.ok(unicodeAsset(glyph)?.filePath, glyph);
    assert.equal(estimateTextWidth(glyph, 20), 20);
  }
  assert.equal(unicodeAsset('©'), null);
  assert.equal(unicodeAsset('❤︎'), null);
  assert.deepEqual(wrapTextToWidthLines(glyphs.join(''), 40, 20, 10), [glyphs.slice(0, 2).join(''), glyphs.slice(2, 4).join(''), glyphs.slice(4).join('')]);
});

test('emoji-only messages participate in the visible-output gate and share bitmap assets', () => {
  const graph = buildSceneGraph([{ type: 'danmaku', time: 0, text: '😀😀😀' }], { videoInfo: { width: 640, height: 360 } });
  assert.ok(graph.objects.every(o => o.type === 'Image'));
  assert.equal(graph.assets.length, 1);
  assert.ok(selectSceneSample(graph, 10).objectId);
});

test('long superchat wraps its complete body in all four styles', () => {
  const text = '这是醒目留言，正文必须完整自动换行。'.repeat(4);
  for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
    const event = { type: 'superchat', time: 0, user: '测试', text, price: 30 };
    const style = resolveDanmakuStyle({}, preset, { superChatWidth: 300 });
    if (preset !== 'current') {
      const metrics = preset === 'minimal' ? getMinimalSideInteractionMetrics(style, event) : getSideInteractionCardMetrics(style, event);
      assert.ok(metrics.detailLines.length > 1, preset);
      assert.equal(metrics.detailLines.join(''), text);
    }
    const graph = buildSceneGraph([event], { stylePreset: preset, styleLayout: { superChatWidth: 300 }, videoInfo: { width: 1920, height: 1080 } });
    const body = graph.objects.find(o => o.type === 'Text' && o.props.text.includes('这是'));
    assert.ok(body.props.text.includes('\n'), preset);
    assert.equal(body.props.text.replace(/\n/g, ''), text, preset);
    assert.match(createAss([event], { stylePreset: preset, styleLayout: { superChatWidth: 300 } }), /\\N/, preset);
  }
});

test('emoji rich text preserves aggregated gift-count updates', () => {
  const graph = buildSceneGraph([
    { type: 'gift', time: 0, uid: 1, user: '用户', giftName: '礼物😀', count: 1, price: 1 },
    { type: 'gift', time: 1, uid: 1, user: '用户', giftName: '礼物😀', count: 2, price: 1 }
  ], { stylePreset: 'current' });
  for (const [time, count] of [[0.5, 1], [1.5, 3]]) {
    const visible = graph.objects.filter(o => evaluateSceneObject(o, time).visible);
    assert.ok(visible.some(o => o.type === 'Text' && o.props.text === ' x' + count));
    assert.equal(visible.filter(o => o.type === 'Image').length, 1);
  }
});

test('custom emoji snapshots survive merge and render without network or audience avatars', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-emoji-capture-'));
  try {
    const service = new LiveRecordService();
    const png = await fs.readFile(unicodeAsset('😀').filePath);
    service.fetchAvatarImageAsset = async () => ({ body: png, contentType: 'image/png' });
    const cleanPath = path.join(directory, 'source.clean.mp4');
    const event = normalizeDanmakuEvent(command('中文[测试]😀'), timing);
    const session = { cleanPath };
    service.queueRecordingEmojiCapture(session, event);
    service.queueRecordingEmojiCapture(session, event);
    assert.equal(await service.flushAvatarCapture(session), true);
    await service.scheduleAvatarManifestWrite(session, 'completed');
    const manifest = await service.loadAvatarManifestForRecording(session);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].uid, 0);
    const merged = { cleanPath: path.join(directory, 'merged.clean.mp4'), avatarManifestPath: path.join(directory, 'merged.danmaku.avatars.json') };
    await service.mergeAvatarManifests([session], merged.avatarManifestPath);
    const assets = await service.getSceneAvatarAssets(merged);
    assert.ok(assets[url].filePath);
    const graph = buildSceneGraph([event], { stylePreset: 'h5-card', avatarAssets: assets });
    assert.ok(graph.assets.some(a => a.type === 'emoji' && a.url === url));
    assert.ok(graph.objects.some(o => o.type === 'Image' && o.props.alt === '[测试]'));
    assert.ok(!graph.objects.some(o => o.type === 'Text' && /[\ue000-\uf8ff]/u.test(o.props.text)));
    const missing = buildSceneGraph([event], { stylePreset: 'h5-card' });
    assert.ok(missing.objects.some(o => o.type === 'Text' && o.props.text.includes('[测试]')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('FFmpeg actually burns visible color emoji through direct and ASS compatibility paths', async () => {
  const executable = process.env.FFMPEG_BIN || require('ffmpeg-static');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-emoji-pixels-'));
  try {
    for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
      const events = [{ type: 'danmaku', time: 0, user: '用户', text: '😀中文👍🏽', color: 0xffffff }];
      const graph = buildSceneGraph(events, { stylePreset: preset, videoInfo: { width: 640, height: 360 } });
      const assPath = path.join(directory, preset + '.ass');
      await fs.writeFile(assPath, createAss(events, { stylePreset: preset, videoInfo: graph.canvas, renderEmojiImages: true }));
      const options = { duration: 4, fps: 25, target: 'software', ...(preset === 'current' ? {} : { legacyAssPath: assPath }) };
      const { script } = createSceneFilterScript(graph, options);
      const filter = path.join(directory, preset + '.filter'); await fs.writeFile(filter, script);
      const output = path.join(directory, preset + '.rgb');
      await run(executable, ['-v', 'error', '-y', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=4', '-filter_complex_script', filter, '-map', '[vout]', '-ss', '2', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output]);
      const pixels = await fs.readFile(output);
      const image = graph.objects.find(o => o.type === 'Image' && o.props.alt === '😀' && evaluateSceneObject(o, 2).visible);
      const state = evaluateSceneObject(image, 2);
      let yellow = 0;
      for (let y = Math.max(0, Math.floor(state.y)); y < Math.min(360, Math.ceil(state.y + image.frame.height)); y++) {
        for (let x = Math.max(0, Math.floor(state.x)); x < Math.min(640, Math.ceil(state.x + image.frame.width)); x++) {
          const i = (y * 640 + x) * 3;
          if (pixels[i] > 180 && pixels[i + 1] > 100 && pixels[i + 2] < 100) yellow++;
        }
      }
      assert.ok(yellow >= 8, preset + ' 必须在预期表情位置烧录出彩色像素，实际 ' + yellow);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
