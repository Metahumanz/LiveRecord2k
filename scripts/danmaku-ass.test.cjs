const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAss,
  createMessageTimeline,
  createAvatarOverlayPlan,
  createDefaultDanmakuCss,
  getDanmakuEventDuration,
  getRollingDanmakuDuration,
  normalizeDanmakuStyle,
  normalizeDanmakuStyleLayout,
  resolveDanmakuStyle,
  adaptDanmakuStyleToVideo,
  superChatPalette,
  guardCardPalette,
  giftCardPalette,
  wrapTextToWidthLines
} = require('../src/server/danmaku/ass.cjs');

test('default message card style matches the compact lower-left reference scale', () => {
  const css = createDefaultDanmakuCss();
  assert.match(css, /--box-font-size: 29;/);
  assert.match(css, /--panel-left: 5;/);
  assert.match(css, /--superchat-bottom: 1070;/);
  assert.match(css, /--superchat-width: 375;/);
  assert.match(css, /--gift-width: 360;/);
  assert.match(css, /--message-duration: 5;/);

  const migrated = normalizeDanmakuStyle({
    'box-font-size': '30',
    'panel-left': '34',
    'superchat-bottom': '618'
  });
  assert.equal(migrated.boxFontSize, 29);
  assert.equal(migrated.panelLeft, 5);
  assert.equal(migrated.superChatBottom, 1070);
  assert.equal(migrated.superChatWidth, 375);
});

test('style presets keep the existing CSS untouched by default and apply preview layout overrides to ASS', () => {
  const existingCssStyle = {
    'panel-left': '123',
    'superchat-bottom': '900',
    'superchat-width': '555',
    'box-font-size': '31'
  };
  const current = resolveDanmakuStyle(existingCssStyle, 'current', {});
  assert.equal(current.panelLeft, 123);
  assert.equal(current.superChatBottom, 900);
  assert.equal(current.superChatWidth, 555);
  assert.equal(current.boxFontSize, 31);

  const layout = normalizeDanmakuStyleLayout({
    panelLeft: 90,
    superChatBottom: 1000,
    superChatWidth: 500,
    boxFontSize: 34,
    ignoredField: 9999
  });
  assert.deepEqual(layout, { panelLeft: 90, superChatBottom: 1000, superChatWidth: 500, boxFontSize: 34 });

  const styled = resolveDanmakuStyle(existingCssStyle, 'h5-card', layout);
  assert.equal(styled.visualPreset, 'h5-card');
  assert.equal(styled.panelLeft, 90);
  assert.equal(styled.superChatBottom, 1000);
  assert.equal(styled.superChatWidth, 500);
  const event = { type: 'superchat', time: 1, user: '预览用户', price: 30, text: '样式预览应与烧录一致' };
  const legacyAss = createAss([event], { style: resolveDanmakuStyle(existingCssStyle, 'current', {}) });
  const currentAss = createAss([event], { stylePreset: 'current', style: existingCssStyle, styleLayout: {} });
  const styledAss = createAss([event], { style: styled });
  assert.equal(legacyAss, currentAss);
  assert.match(styledAss, /\\clip\(90,0,590,1000\)/);
  assert.match(styledAss, /\\pos\(90,/);
});

test('portrait source videos use their real ASS canvas and keep overlays inside it', () => {
  const h5Style = resolveDanmakuStyle({}, 'h5-card');
  const portrait = adaptDanmakuStyleToVideo(h5Style, { width: 1080, height: 1920 });
  assert.equal(portrait.playWidth, 1080);
  assert.equal(portrait.playHeight, 1920);
  assert.equal(portrait.panelLeft, 28);
  assert.equal(portrait.superChatWidth, 450);
  assert.equal(portrait.superChatBottom, 1880);

  const smallPortrait = adaptDanmakuStyleToVideo(h5Style, { width: 720, height: 1280 });
  assert.equal(smallPortrait.playWidth, 720);
  assert.equal(smallPortrait.playHeight, 1280);
  assert.ok(Math.abs(smallPortrait.panelLeft - 18.67) < 0.01);
  assert.ok(Math.abs(smallPortrait.superChatWidth - 300) < 0.01);
  assert.ok(Math.abs(smallPortrait.superChatBottom - 1253.33) < 0.01);

  const sideAss = createAss([{ type: 'danmaku', time: 1, user: '竖屏用户', text: '侧栏需要贴在竖屏内' }], {
    stylePreset: 'h5-card',
    videoInfo: { width: 1080, height: 1920 }
  });
  const rollingAss = createAss([{ type: 'danmaku', time: 1, text: '竖屏滚动弹幕' }], {
    videoInfo: { width: 1080, height: 1920 }
  });
  assert.match(sideAss, /PlayResX: 1080/);
  assert.match(sideAss, /PlayResY: 1920/);
  assert.match(sideAss, /\\clip\(28,0,478,1880\)/);
  assert.match(rollingAss, /\\move\(1140,36,-/);
});

test('non-default presets turn ordinary danmaku into a fixed side conversation stream', () => {
  const event = { type: 'danmaku', time: 1, user: '预览用户', text: '普通弹幕也要有样式', color: 0x70d6ff };
  const current = createAss([event], { stylePreset: 'current' });
  const h5Card = createAss([event], { stylePreset: 'h5-card' });
  const bubble = createAss([event], { stylePreset: 'bubble' });
  const minimal = createAss([event], { stylePreset: 'minimal' });

  assert.match(current, /\\move\(1980,36,-/);
  assert.doesNotMatch(current, /预览用户 · 普通弹幕也要有样式/);
  assert.match(h5Card, /\\clip\(28,0,478,1040\)/);
  assert.match(h5Card, /\\move\(28,/);
  assert.match(h5Card, /预览用户/);
  assert.match(h5Card, /\\1c&HD7CF59&\\1a&H04&/);
  assert.match(h5Card, /\\1c&HFFFFFF&\\1a&H40&/);
  assert.doesNotMatch(h5Card, /\\an5/);
  assert.match(bubble, /\\clip\(54,0,474,1018\)/);
  assert.match(bubble, /\\1c&H2F2230&\\1a&H12&/);
  assert.match(minimal, /\\clip\(24,0,384,1052\)/);
  assert.match(minimal, /预览用户\\b0 · 普通弹幕也要有样式/);
  assert.doesNotMatch(minimal, /\\1c&H191710&\\1a&H30&/);
  assert.doesNotMatch(h5Card, /\\move\(1968,/);
  assert.doesNotMatch(bubble, /\\move\(1968,/);
  assert.doesNotMatch(minimal, /\\move\(1968,/);
  assert.notEqual(h5Card, bubble);
  assert.notEqual(bubble, minimal);
});

test('side-stream presets stack chat and interaction events in one vertical timeline', () => {
  const style = resolveDanmakuStyle({}, 'h5-card');
  const events = [
    { type: 'danmaku', time: 1, user: '观众A', text: '普通聊天' },
    { type: 'gift', time: 2, user: '观众B', giftName: '足迹', count: 2, price: 0.1 },
    { type: 'danmaku', time: 3, user: '观众C', text: '又一条聊天' }
  ];
  const timeline = createMessageTimeline(events, style, { includeDanmaku: true, sideStream: true });
  const ass = createAss(events, { stylePreset: 'h5-card', overlayMode: 'danmaku-gift' });

  assert.deepEqual(timeline.items.map((item) => item.type), ['danmaku', 'gift', 'danmaku']);
  assert.ok(timeline.items.every((item) => item.segments.every((segment) => segment.x1 === segment.x2)));
  assert.ok(timeline.items[0].changes.some((change) => change.reason === 'push'));
  assert.match(ass, /观众A/);
  assert.match(ass, /投喂 足迹 x2/);
  assert.match(ass, /CNY0.2/);
});

test('side-stream entries remain queued until later entries push them out of view', () => {
  const style = resolveDanmakuStyle({}, 'h5-card');
  const timeline = createMessageTimeline(
    [
      { type: 'danmaku', time: 1, user: '观众A', text: '第一条互动' },
      { type: 'danmaku', time: 3, user: '观众B', text: '第二条互动' }
    ],
    style,
    { includeDanmaku: true, sideStream: true }
  );
  const [first] = timeline.items;

  assert.ok(first.end > 60, 'side entry must not use the old short timeout');
  assert.ok(first.changes.some((change) => change.reason === 'push'));
  assert.equal(first.changes.some((change) => change.reason === 'reflow'), false);
});

test('normal rolling danmaku keeps the chosen base speed with a small deterministic spread', () => {
  const style = normalizeDanmakuStyle({ 'danmaku-duration': 8 });
  const durations = Array.from({ length: 8 }, (_, index) =>
    getRollingDanmakuDuration({ type: 'danmaku', time: index, user: `用户${index}`, text: `示例${index}` }, style)
  );

  assert.ok(durations.every((duration) => duration >= 7.3 && duration <= 8.7));
  assert.ok(new Set(durations).size > 1, 'messages should not all travel at exactly the same speed');
});

test('superchat uses the DanmakuFactory information hierarchy and low-price palette', () => {
  const ass = createAss([
    {
      type: 'superchat',
      time: 1,
      duration: 10,
      user: '花颜、繁星',
      price: 30,
      text: '栗栗突击检查八千在干嘛。如果它睡着了，吵醒它，让它起来重睡'
    }
  ]);

  assert.match(ass, /SuperChat CNY 30/);
  assert.match(ass, /\\1c&HFFF5ED&/);
  assert.match(ass, /\\1c&HB2602A&/);
  assert.match(ass, /\\1c&H00653617&/);
  assert.match(ass, /\\pos\(5,945\.5\)/);
  assert.match(ass, /m 14\.5 0 l 360\.5 0/);
  assert.match(ass, /如果它\\N睡着了/);
  assert.doesNotMatch(ass, /￥30/);
});

test('guard events render as a membership card instead of the generic gift ticker', () => {
  const ass = createAss([
    {
      type: 'guard',
      time: 2,
      user: '舰长用户',
      giftName: '舰长',
      guardLevel: 3,
      count: 1,
      price: 138
    }
  ]);

  assert.match(ass, /Welcome new 舰长!/);
  assert.match(ass, /\\1c&HFCE8D8&/);
  assert.match(ass, /\\1c&H008A3619&/);
  assert.doesNotMatch(ass, /开通 舰长/);
  assert.doesNotMatch(ass, /\\fscx88/);
});

test('ordinary gifts share the message stack and use the compact two-line card requested for burn-in', () => {
  const events = [
    { type: 'gift', time: 1, user: '观众A', giftName: '小花花', count: 2 },
    { type: 'superchat', time: 2, duration: 4, user: '观众B', price: 30, text: '测试消息' }
  ];
  const ass = createAss(events);
  const [gift] = createMessageTimeline(events).items;

  assert.match(ass, /\\1c&HF7F3FF&\\1a&H18&/);
  assert.match(ass, /\\1c&HC46CFF&\\1a&H00&/);
  assert.match(ass, /\\1c&H00502980&\\b1}观众A/);
  assert.match(ass, /\\1c&H0054434B&\\b0}赠送 小花花 x2/);
  assert.match(ass, /\\clip\(5,0,380,1070\)/);
  assert.ok(gift.width < 300, 'short gifts should not occupy the full interaction-card width');
  assert.equal(gift.segments.at(-1).x2, 5 - gift.width, 'the exit animation follows the compact gift width');
  assert.doesNotMatch(ass, /观众A:|礼物互动|COMBO|￥/);
});

test('photo-avatar overlay plan reuses the side queue coordinates and keeps a safe fallback scope', () => {
  const events = [
    {
      type: 'danmaku',
      time: 1,
      uid: 101,
      user: '头像用户',
      text: '头像需要随队列一起移动',
      avatarUrl: 'https://i0.hdslb.com/bfs/face/avatar-a.jpg'
    },
    { type: 'gift', time: 2, uid: 202, user: '礼物用户', giftName: '小花', count: 1 }
  ];
  const plan = createAvatarOverlayPlan(events, { stylePreset: 'h5-card', maxEntries: 8 });

  assert.equal(plan.visualPreset, 'h5-card');
  assert.deepEqual(plan.panel, { left: 28, width: 450, height: 1040 });
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].avatarUrl, 'https://i0.hdslb.com/bfs/face/avatar-a.jpg');
  assert.equal(plan.entries[1].uid, 202, 'a missing recorded URL can be resolved from the public UID card later');
  assert.equal(plan.entries[1].avatarUrl, '');
  assert.ok(plan.entries[0].size > 20);
  assert.ok(plan.entries[0].segments.some((segment) => segment.y1 !== segment.y2), 'avatar follows the push animation');
  assert.ok(plan.entries[0].segments.every((segment) => segment.x1 >= plan.panel.left));
  assert.equal(createAvatarOverlayPlan(events, { stylePreset: 'current' }).entries.length, 0);
  assert.equal(createAvatarOverlayPlan(events, { stylePreset: 'minimal' }).entries.length, 0);
});

test('photo-avatar overlay samples a long side stream across its full duration rather than only at the start', () => {
  const events = Array.from({ length: 7 }, (_unused, index) => ({
    type: 'danmaku',
    time: index * 60,
    uid: index + 1,
    user: `用户${index + 1}`,
    text: `第 ${index + 1} 条`,
    avatarUrl: `https://i0.hdslb.com/bfs/face/${index + 1}.jpg`
  }));
  const plan = createAvatarOverlayPlan(events, { stylePreset: 'bubble', maxEntries: 3 });

  assert.equal(plan.candidateCount, 7);
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.truncated, true);
  assert.equal(plan.entries[0].start, 0);
  assert.equal(plan.entries.at(-1).start, 360);
});

test('gift ticker width grows only for content and stays inside its configured cap', () => {
  const [shortGift] = createMessageTimeline([{ type: 'gift', time: 1, user: '观众A', giftName: '小花', count: 1 }]).items;
  const [longGift] = createMessageTimeline([
    { type: 'gift', time: 1, user: '这是一个很长很长的昵称', giftName: '这是一个很长很长的礼物名称', count: 9999 }
  ]).items;

  assert.ok(longGift.width > shortGift.width, 'long names may use more room than a normal short gift');
  assert.ok(shortGift.width < 375, 'the ordinary ticker must be shorter than the SuperChat card');
  assert.ok(longGift.width <= 330, 'the ticker must never grow past the compact 88% card cap');
});

test('large message stacks append ASS lines without overflowing the V8 call stack', () => {
  const events = Array.from({ length: 15_000 }, (_, index) => ({
    type: 'gift',
    videoTime: index * 6,
    uid: index + 1,
    user: `用户${index}`,
    giftName: '小花花',
    count: 1,
    price: 1
  }));

  const ass = createAss(events, { overlayMode: 'danmaku-gift' });

  assert.match(ass, /用户14999/);
  assert.ok(Buffer.byteLength(ass) > 1_000_000);
});

test('gift, superchat, and guard use one push/reflow lifecycle', () => {
  const timeline = createMessageTimeline([
    { type: 'gift', time: 1, user: 'A', giftName: '花', count: 1 },
    { type: 'superchat', time: 2, cardDuration: 3, user: 'B', price: 30, text: '测试' },
    { type: 'guard', time: 3, cardDuration: 3, user: 'C', giftName: '舰长', guardLevel: 3 }
  ]);
  const [gift, superchat, guard] = timeline.items;

  assert.deepEqual(gift.changes.map((change) => change.reason), ['entry', 'push', 'push', 'reflow']);
  assert.deepEqual(superchat.changes.map((change) => change.reason), ['entry', 'push']);
  assert.deepEqual(guard.changes.map((change) => change.reason), ['entry']);
  assert.equal(gift.changes[1].time, 2);
  assert.ok(gift.changes[1].toY < gift.changes[1].fromY);
  assert.ok(gift.changes.at(-1).toY > gift.changes.at(-1).fromY);
  assert.equal(gift.segments.at(-1).x1, 5);
  assert.equal(gift.segments.at(-1).x2, 5 - gift.width);
});

test('same-user same-gift combos update in place and extend the five-second lifetime', () => {
  const events = [
    { type: 'gift', time: 1, uid: 7, user: '连击用户', giftName: '小花', count: 1 },
    { type: 'gift', time: 3, uid: 7, user: '连击用户', giftName: '小花', count: 2 }
  ];
  const timeline = createMessageTimeline(events);
  const [gift] = timeline.items;
  const ass = createAss(events);

  assert.equal(timeline.items.length, 1);
  assert.equal(gift.end, 8);
  assert.equal(gift.versions.length, 2);
  assert.equal(gift.versions[1].event.count, 3);
  assert.equal(gift.changes.length, 1);
  assert.match(ass, /小花 x1/);
  assert.match(ass, /小花 x3/);
});

test('burn-in defaults every interaction card to the five-second message-box override', () => {
  assert.equal(getDanmakuEventDuration({ type: 'gift' }), 5);
  assert.equal(getDanmakuEventDuration({ type: 'guard', guardLevel: 1 }), 5);
  assert.equal(getDanmakuEventDuration({ type: 'superchat', duration: 120 }, { messageDuration: 5 }), 5);
  assert.equal(createMessageTimeline([{ type: 'superchat', time: 1, duration: 120 }]).items[0].end, 6);
  assert.equal(
    createMessageTimeline([{ type: 'superchat', time: 1, duration: 120 }], { 'message-duration': 0 }).items[0].end,
    121
  );
  assert.equal(getDanmakuEventDuration({ type: 'guard', cardDuration: 3, guardLevel: 1 }), 3);
});

test('message palettes retain all price and membership tiers', () => {
  assert.deepEqual(superChatPalette(30), {
    header: '&H00FFF5ED&',
    body: '&H00B2602A&',
    username: '&H00653617&'
  });
  assert.equal(superChatPalette(2000).body, '&H00321AAB&');
  assert.equal(guardCardPalette(1, 0).background, '&H00E5E5FF&');
  assert.equal(guardCardPalette(2, 0).background, '&H00CAF9F8&');
  assert.equal(guardCardPalette(3, 0).background, '&H00FCE8D8&');
  assert.equal(guardCardPalette(3, 3000).background, '&H00FCE8D8&');
  assert.equal(giftCardPalette().background, '&H18F7F3FF&');
  assert.equal(giftCardPalette(200).accent, '&H00D45BFF&');
  assert.equal(giftCardPalette(2000).accent, '&H003CA3FF&');
});

test('width-aware wrapping treats CJK and emoji as full-width glyphs', () => {
  assert.deepEqual(wrapTextToWidthLines('测试🙂测试🙂', 80, 20, 3), ['测试🙂测', '试🙂']);
  assert.deepEqual(wrapTextToWidthLines('abcdefghij', 40, 20, 1), ['ab…']);
});
