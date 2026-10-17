'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { normalizeDanmakuEvent, prepareAssEvents, createAss, resolveDanmakuStyle, getSideInteractionCardMetrics, getMinimalSideInteractionMetrics, wrapTextToWidthLines, estimateTextWidth } = require('../src/server/danmaku/ass.cjs');
const { graphemes, unicodeAsset, imageUrl, emojiWidthFactor, resolveEmojiText } = require('../src/server/danmaku/emoji.cjs');
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

test('historical HTTP emotes match HTTPS snapshots through capture, merge, Scene and ASS', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-emoji-http-'));
  try {
    const service = new LiveRecordService();
    const png = await fs.readFile(unicodeAsset('😀').filePath);
    service.fetchAvatarImageAsset = async () => ({ body: png, contentType: 'image/png' });
    const session = { cleanPath: path.join(directory, 'source.clean.mp4') };
    const event = { type: 'danmaku', time: 0, text: '晚上好[测试]', emoticons: [{ token: '[测试]', url: url.replace('https:', 'http:') }] };
    assert.equal(imageUrl(event.emoticons[0].url), url);
    assert.equal(imageUrl('//i0.hdslb.com/bfs/emote/test.png'), url);
    service.queueRecordingEmojiCapture(session, event);
    assert.equal(await service.flushAvatarCapture(session), true);
    await service.scheduleAvatarManifestWrite(session, 'completed');
    const merged = { cleanPath: path.join(directory, 'merged.mp4'), avatarManifestPath: path.join(directory, 'merged.danmaku.avatars.json') };
    await service.mergeAvatarManifests([session], merged.avatarManifestPath);
    const assets = await service.getSceneAvatarAssets(merged);
    const resolved = resolveEmojiText(event, assets);
    assert.equal(Object.keys(resolved.emojiTokens).length, 1);
    assert.ok(!resolved.text.includes('[测试]'));
    service.readSceneEventsForRecording = async () => [event];
    service.settings.burnDanmakuStylePreset = 'h5-card';
    const result = await service.buildSceneGraphForRecording(merged, { stylePreset: 'h5-card', avatarAssets: assets });
    assert.ok(result.graph.objects.some(o => o.type === 'Image' && o.props.alt === '[测试]'));
    assert.deepEqual(result.graph.metadata.imageEmotes, { recorded: 1, matched: 1, missing: 0 });
    assert.ok(result.events[0]._emojiAssets[url]?.filePath, '兼容 ASS 必须复用同一快照');
    const ass = createAss(result.events, { stylePreset: 'h5-card', renderEmojiImages: true });
    assert.ok(!ass.includes('[测试]'), 'ASS 不能把已匹配图片重复画成文字');
    const oldAssets = { [event.emoticons[0].url]: assets[url] };
    assert.equal(Object.keys(resolveEmojiText(event, oldAssets).emojiTokens).length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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

test('Unicode bitmap cache recovers after temporary-file cleanup in the same process', async () => {
  const asset = unicodeAsset('🛸');
  const png = await fs.readFile(asset.filePath);
  try {
    await fs.rm(asset.filePath);
    const graph = buildSceneGraph([{ type: 'danmaku', time: 0, text: '🛸' }], { videoInfo: { width: 640, height: 360 } });
    const image = graph.assets.find(item => item.type === 'emoji');
    assert.deepEqual(await fs.readFile(image.path), png);
  } finally { await fs.writeFile(asset.filePath, png, { mode: 0o600 }); }
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

test('FFmpeg burns wide emotes at text height and reserves room for following text in all styles', async () => {
  const executable = process.env.FFMPEG_BIN || require('ffmpeg-static');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-emoji-ratio-'));
  try {
    const assetPath = path.join(directory, 'wide.png');
    await run(executable, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x60', '-frames:v', '1', assetPath]);
    for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
    const events = [{ type: 'danmaku', time: 0, text: '中[宽图]文😀字', emoticons: [{ token: '[宽图]', url, width: 1, height: 1 }] }];
    const options = { stylePreset: preset, styleLayout: { superChatWidth: 1200, boxFontSize: 48 },
      videoInfo: { width: 640, height: 360 }, emojiAssets: { [url]: { filePath: assetPath } } };
    const graph = buildSceneGraph(events, options);
    const image = graph.objects.find(o => o.type === 'Image' && evaluateSceneObject(o, 2).visible);
    assert.equal(image.props.objectFit, 'contain');
    const suffix = graph.objects.find(o => o.type === 'Text' && o.props.text === '文' && evaluateSceneObject(o, 2).visible);
    assert.ok(suffix, preset + ' must retain the text after the emote');
    assert.ok(Math.abs(image.frame.height - suffix.props.fontSize) < 0.01, preset + ' emote height must match the text font size');
    assert.ok(Math.abs(suffix.frame.x - image.frame.x - image.frame.width) < 0.02, preset + ' must reserve the actual emote width');
    assert.equal(emojiWidthFactor({ filePath: assetPath, width: 1, height: 1 }), 200/60, 'saved PNG must override stale/absent protocol size');
    const unicode = graph.objects.find(o => o.type === 'Image' && o.props.alt === '😀' && evaluateSceneObject(o, 2).visible);
    assert.equal(unicode.frame.height, suffix.props.fontSize, preset + ' Unicode emoji must also use full text height');
    const filter = path.join(directory, preset + '.filter');
    const assPath = path.join(directory, preset + '.ass');
    const ass = createAss(events, { ...options, renderEmojiImages: true });
    assert.ok(!/[\ue000-\uf8ff]/u.test(ass), 'private placeholders must never reach libass');
    assert.ok(!ass.includes('br2k-emoji:'), 'internal image markers must be completely resolved into ASS runs');
    await fs.writeFile(assPath, ass);
    await fs.writeFile(filter, createSceneFilterScript(graph, { target: 'software', duration: 4, fps: 25,
      ...(preset === 'current' ? {} : { legacyAssPath: assPath }) }).script);
    const output = path.join(directory, 'actual.rgb');
    await run(executable, ['-v','error','-y','-filter_complex_threads','1','-f','lavfi','-i','color=c=black:s=640x360:r=25:d=4',
      '-filter_complex_script',filter,'-map','[vout]','-ss','2','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',output]);
    const pixels = await fs.readFile(output), state = evaluateSceneObject(image, 2);
    if (process.env.BR2K_EMOJI_TEST_FRAMES) {
      const target = path.resolve(process.env.BR2K_EMOJI_TEST_FRAMES);
      await fs.mkdir(target, { recursive: true });
      await run(executable, ['-v','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size','640x360','-i',output,'-frames:v','1',path.join(target,preset+'.png')]);
      await fs.writeFile(path.join(target,preset+'.json'), JSON.stringify(graph, null, 2));
      await fs.writeFile(path.join(target,preset+'.ass'), ass);
    }
    let left=640,right=0,top=360,bottom=0;
    for(let y=Math.max(0,Math.floor(state.y));y<Math.min(360,Math.ceil(state.y+image.frame.height));y++) {
      for(let x=Math.max(0,Math.floor(state.x));x<Math.min(640,Math.ceil(state.x+image.frame.width));x++) {
        const i=(y*640+x)*3;
        if(pixels[i]>180 && pixels[i+1]<80 && pixels[i+2]<80) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      }
    }
    assert.ok(right>left && bottom>top);
    assert.ok((right-left+1)/(bottom-top+1)>2.5, '200×60 表情不能挤成正方形');
    assert.ok(bottom-top+1 >= image.frame.height * 0.85, preset + ' wide emote must not shrink to a third of text height');
    const suffixState = evaluateSceneObject(suffix, 2);
    let textPixels = 0;
    for(let y=Math.max(0,Math.floor(suffixState.y));y<Math.min(360,Math.ceil(suffixState.y+suffix.props.fontSize*1.3));y++) {
      for(let x=Math.max(0,Math.floor(suffixState.x));x<Math.min(640,Math.ceil(suffixState.x+suffix.props.fontSize));x++) {
        const i=(y*640+x)*3;
        if(pixels[i]>150 && pixels[i+1]>150 && pixels[i+2]>150) textPixels++;
      }
    }
    assert.ok(textPixels >= 6, preset + ' must burn the following Chinese glyph in its reserved position, actual ' + textPixels);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('SC wrapping accounts for wide emotes without splitting or overlapping them', () => {
  for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
    const events = [{ type: 'superchat', time: 0, user: '测试', price: 30, text: '中[宽图]文'.repeat(8),
      emoticons: [{ token: '[宽图]', url, width: 200, height: 60 }] }];
    const options = { stylePreset: preset, styleLayout: { superChatWidth: 300 },
      videoInfo: { width: 1920, height: 1080 }, emojiAssets: { [url]: { filePath: unicodeAsset('😀').filePath, width: 200, height: 60 } } };
    // Use metadata fallback with an unavailable header: old non-PNG snapshots
    // have the same layout contract, while PNG dimensions take precedence.
    options.emojiAssets[url].filePath = 'missing-wide-snapshot.png';
    const graph = buildSceneGraph(events, options);
    const images = graph.objects.filter(o => o.type === 'Image' && o.props.alt === '[宽图]' && evaluateSceneObject(o, 2).visible);
    assert.equal(images.length, 8, preset);
    assert.ok(new Set(images.map(o => o.frame.y)).size > 1, preset + ' must wrap');
    for (const image of images) assert.ok(Math.abs(image.frame.width / image.frame.height - 200/60) < 0.001);
  }
});
