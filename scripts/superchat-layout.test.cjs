'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSceneGraph, evaluateSceneObject } = require('../src/server/danmaku/scene-graph.cjs');
const { estimateTextWidth, createAss } = require('../src/server/danmaku/ass.cjs');

const avatarPath = path.join(__dirname, '../public/app-icon.png');
const body = '醒目留言正文需要自动换行，头像和金额不能挡住这段文字。'.repeat(2);
const event = { type: 'superchat', time: 0, uid: 42, user: '醒目留言测试观众的长昵称', text: body, price: 1250 };

for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
  test(preset + ' SC keeps its bitmap avatar, nickname, price and multiline body in separate regions', () => {
    for (const videoInfo of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }, { width: 3840, height: 2160 }]) {
      for (const superChatWidth of [220, 375]) {
        const graph = buildSceneGraph([event], { stylePreset: preset, videoInfo, danmakuArea: 'unlimited',
          styleLayout: { superChatWidth }, avatarAssets: { 42: { filePath: avatarPath } } });
        const visible = graph.objects.filter(o => evaluateSceneObject(o, 2).visible);
        const name = visible.find(o => o.type === 'Text' && o.id.endsWith('-user'));
        const detail = visible.find(o => o.type === 'Text' && o.id.endsWith('-detail'));
        const price = visible.find(o => o.id.endsWith('-price-bg')) || visible.find(o => o.id.endsWith('-price'));
        assert.ok(name && detail && price, preset + ' 必须同时保留昵称、金额和正文');
        assert.equal(detail.props.text.replace(/\n/g, ''), body);
        assert.ok(detail.props.text.includes('\n'), '多行内容不能被截断');
        const nameState = evaluateSceneObject(name, 2), detailState = evaluateSceneObject(detail, 2), priceState = evaluateSceneObject(price, 2);
        assert.ok(nameState.y + name.props.fontSize <= detailState.y, '正文不能盖住昵称');
        const nameWidth = estimateTextWidth(name.props.text, name.props.fontSize);
        assert.ok(priceState.y >= nameState.y + name.props.fontSize || priceState.x >= nameState.x + nameWidth,
          '金额不能覆盖昵称');
        for (const avatar of visible.filter(o => o.type === 'Avatar')) {
          const state = evaluateSceneObject(avatar, 2);
          assert.ok(state.y + avatar.frame.height <= detailState.y + 0.01, '头像必须留在标题区');
          assert.ok(state.x + avatar.frame.width <= nameState.x + 0.01, '头像不能压住昵称');
        }
        if (preset !== 'minimal') assert.ok(visible.some(o => o.type === 'Avatar' && o.props.assetId), '必须验证真实位图头像路径');
        if (preset === 'current') assert.equal(name.style.fill, '#653617', '浅色标题栏必须使用深色昵称');
        assert.equal(detail.props.fontWeight, 700, 'SC 正文使用粗体');
        assert.ok(detail.props.fontSize >= name.props.fontSize, 'SC 正文不能缩小为辅助信息字号');
        if (['h5-card', 'bubble'].includes(preset)) {
          const avatar = visible.find(o => o.type === 'Avatar' && o.props.assetId);
          const avatarState = evaluateSceneObject(avatar, 2);
          assert.equal(name.props.verticalAlign, 'middle');
          assert.ok(Math.abs(nameState.y + name.frame.height / 2 - avatarState.y - avatar.frame.height / 2) < 0.01, '昵称必须与头像共用垂直中心');
        }
        if (preset !== 'current') {
          const priceText = visible.find(o => o.type === 'Text' && o.id.endsWith('-price'));
          const ps = evaluateSceneObject(priceText, 2);
          assert.equal(priceText.props.align, 'center');
          assert.equal(priceText.props.verticalAlign, 'middle');
          assert.ok(Math.abs(ps.x - priceState.x) < 0.01 && Math.abs(ps.y - priceState.y) < 0.01);
          assert.equal(priceText.frame.width, price.frame.width);
          assert.equal(priceText.frame.height, price.frame.height);
        }
      }
    }
  });
}

test('SC ASS emits one alignment anchor and emoji nicknames keep the avatar center', () => {
  for (const preset of ['h5-card', 'bubble', 'minimal']) {
    const sample = { ...event, user: '观众😀' };
    const options = { stylePreset: preset, videoInfo: { width: 720, height: 1280 }, danmakuArea: 'unlimited' };
    const ass = createAss([sample], options);
    for (const line of ass.split('\n').filter(s => s.startsWith('Dialogue:'))) {
      const tags = line.match(/\{([^}]*)\}/)?.[1] || '';
      assert.ok((tags.match(/\\an[1-9]/g) || []).length <= 1, 'libass 不能依靠后加的对齐标签覆盖首个标签');
    }
    assert.ok(ass.includes('\\an5'), '金额必须采用中心锚点');
    if (preset === 'minimal') continue;
    const graph = buildSceneGraph([sample], options);
    const visible = graph.objects.filter(o => evaluateSceneObject(o, 2).visible);
    const avatar = visible.find(o => o.type === 'Avatar');
    const emoji = visible.find(o => o.type === 'Image' && o.id.includes('-user-emoji'));
    assert.ok(emoji);
    const a = evaluateSceneObject(avatar, 2), e = evaluateSceneObject(emoji, 2);
    assert.ok(Math.abs(a.y + avatar.frame.height / 2 - e.y - emoji.frame.height / 2) < 0.01, '昵称中的 emoji 也必须与头像居中');
  }
});
