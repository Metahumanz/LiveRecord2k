const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAss,
  createMessageTimeline,
  createDefaultDanmakuCss,
  getDanmakuEventDuration,
  normalizeDanmakuStyle,
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
  const ass = createAss([
    { type: 'gift', time: 1, user: '观众A', giftName: '小花花', count: 2 },
    { type: 'superchat', time: 2, duration: 4, user: '观众B', price: 30, text: '测试消息' }
  ]);

  assert.match(ass, /\\1c&HF4F0FF&/);
  assert.match(ass, /\\1c&H006B4EB5&\\b0}观众A/);
  assert.match(ass, /\\1c&H004F3B43&\\b0}赠送 小花花 x2/);
  assert.match(ass, /\\clip\(5,0,380,1070\)/);
  assert.match(ass, /\\move\(5,1003\.5,5,903\)/);
  assert.doesNotMatch(ass, /观众A:|礼物互动|COMBO|￥/);
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
  assert.equal(gift.segments.at(-1).x2, -370);
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
  assert.equal(giftCardPalette().background, '&H00F4F0FF&');
});

test('width-aware wrapping treats CJK and emoji as full-width glyphs', () => {
  assert.deepEqual(wrapTextToWidthLines('测试🙂测试🙂', 80, 20, 3), ['测试🙂测', '试🙂']);
  assert.deepEqual(wrapTextToWidthLines('abcdefghij', 40, 20, 1), ['ab…']);
});
