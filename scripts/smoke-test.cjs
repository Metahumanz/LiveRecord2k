const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');

const outDir = path.join(process.cwd(), 'smoke-output');
const cleanPath = path.join(outDir, 'sample.clean.mp4');
const jsonlPath = path.join(outDir, 'sample.danmaku.jsonl');
const assPath = path.join(outDir, 'sample.danmaku.ass');
const burnedPath = path.join(outDir, 'sample.danmaku.mp4');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(cleanPath, { force: true });
  await fs.rm(jsonlPath, { force: true });
  await fs.rm(assPath, { force: true });
  await fs.rm(burnedPath, { force: true });

  run('generate clean mp4', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000',
    '-t',
    '8',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    cleanPath
  ]);

  const events = [
    { type: 'danmaku', time: 0.6, text: '普通弹幕测试 2K/HEVC 链路', user: 'tester', color: 0xffffff },
    { type: 'danmaku', time: 1.2, text: '这条会从右往左飘过去', user: 'tester', color: 0x76dad0 },
    { type: 'gift', time: 1.6, user: '观众A', giftName: '小花花', count: 6, price: 0.6 },
    { type: 'superchat', time: 2.2, user: '观众B', text: 'SC 醒目留言测试，左下角消息框应该出现。', price: 50, duration: 5 },
    { type: 'guard', time: 3.4, user: '观众C', giftName: '舰长', count: 1, price: 138 },
    { type: 'danmaku', time: 4.1, text: '录制完成后会烧录成有弹幕版 MP4', user: 'tester', color: 0xf4c173 }
  ];

  await fs.writeFile(jsonlPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  await fs.writeFile(assPath, createAss(events), 'utf8');

  run('burn danmaku mp4', [
    '-hide_banner',
    '-y',
    '-i',
    cleanPath,
    '-vf',
    `ass='${escapeFilterPath(assPath)}'`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    burnedPath
  ]);

  console.log(`Smoke test OK:
  clean:   ${cleanPath}
  jsonl:   ${jsonlPath}
  ass:     ${assPath}
  burned:  ${burnedPath}`);
}

function run(label, args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${label} failed with code ${result.status}`);
  }
}

function createAss(events) {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1280',
    'PlayResY: 720',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Danmaku,Microsoft YaHei,28,&H00FFFFFF,&H000000FF,&H96000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,7,20,20,20,1',
    'Style: BoxText,Microsoft YaHei,22,&H00FFFFFF,&H000000FF,&H32000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1',
    'Style: Shape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  for (const event of events) {
    if (event.type === 'danmaku') {
      lines.push(
        dialogue(
          1,
          event.time,
          event.time + 6,
          'Danmaku',
          `{\\move(1320,${38 + event.time * 30},-620,${38 + event.time * 30})}${assEscape(event.text)}`
        )
      );
    }
    if (event.type === 'superchat') {
      lines.push(drawRect(7, event.time, event.time + event.duration, 24, 430, 420, 34, '&H0000C8B8&'));
      lines.push(drawRect(6, event.time, event.time + event.duration, 24, 464, 420, 70, '&H0033B9B0&'));
      lines.push(dialogue(8, event.time, event.time + event.duration, 'BoxText', `{\\fad(120,260)\\pos(40,438)\\b1}${assEscape(event.user)}  ￥${event.price}`));
      lines.push(dialogue(8, event.time, event.time + event.duration, 'BoxText', `{\\fad(120,260)\\pos(40,474)}${assEscape(event.text)}`));
    }
    if (event.type === 'gift' || event.type === 'guard') {
      const label =
        event.type === 'guard'
          ? `${event.user} 开通 ${event.giftName} x${event.count}`
          : `${event.user} 送出 ${event.giftName} x${event.count}`;
      lines.push(drawRect(5, event.time, event.time + 4, 24, 616, 360, 36, '&H8A2A1B12&'));
      lines.push(dialogue(6, event.time, event.time + 4, 'BoxText', `{\\fad(120,260)\\pos(38,623)}${assEscape(label)}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

function drawRect(layer, start, end, x, y, width, height, color) {
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{\\fad(120,260)\\p1\\pos(${x},${y})\\bord0\\shad0\\1c${color}}m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}`
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
  return String(text || '').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
