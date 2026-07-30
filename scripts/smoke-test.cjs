const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const { createAss } = require('../src/server/danmaku/ass.cjs');

const outDir = path.join(process.cwd(), 'smoke-output');
const cleanPath = path.join(outDir, 'sample.clean.mp4');
const jsonlPath = path.join(outDir, 'sample.danmaku.jsonl');
const assPath = path.join(outDir, 'sample.danmaku.ass');
const burnedPath = path.join(outDir, 'sample.danmaku.mp4');
const previewFrames = [
  { time: '2.50', path: path.join(outDir, 'sample.danmaku.preview-push.png') },
  { time: '3.65', path: path.join(outDir, 'sample.danmaku.preview-stack.png') },
  { time: '8.02', path: path.join(outDir, 'sample.danmaku.preview-reflow.png') },
  { time: '8.55', path: path.join(outDir, 'sample.danmaku.preview-after-expiry.png') }
];

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
  for (const preview of previewFrames) {
    await fs.rm(preview.path, { force: true });
  }

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
    '12',
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
    { type: 'gift', time: 1.6, uid: 11, user: '观众A', giftName: '小花花', count: 1, price: 0.6 },
    { type: 'gift', time: 2, uid: 11, user: '观众A', giftName: '小花花', count: 5, price: 0.6 },
    {
      type: 'superchat',
      time: 2.4,
      user: '花颜、繁星',
      text: '栗栗突击检查八千在干嘛。如果它睡着了，吵醒它，让它起来重睡',
      price: 30,
      duration: 60,
      cardDuration: 6
    },
    {
      type: 'guard',
      time: 3.4,
      cardDuration: 4.5,
      user: '观众C',
      giftName: '舰长',
      guardLevel: 3,
      count: 1,
      price: 138
    },
    { type: 'gift', time: 4.5, uid: 12, user: '观众D', giftName: '牛哇牛哇', count: 3 },
    { type: 'danmaku', time: 4.1, text: '录制完成后会烧录成有弹幕版 MP4', user: 'tester', color: 0xf4c173 }
  ];

  await fs.writeFile(jsonlPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  await fs.writeFile(assPath, createAss(events, { overlayMode: 'danmaku-gift', danmakuArea: 'half' }), 'utf8');

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

  for (const preview of previewFrames) {
    run(`render overlay preview at ${preview.time}s`, [
      '-hide_banner',
      '-y',
      '-ss',
      preview.time,
      '-i',
      burnedPath,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-update',
      '1',
      preview.path
    ]);
  }

  console.log(`Smoke test OK:
  clean:   ${cleanPath}
  jsonl:   ${jsonlPath}
  ass:     ${assPath}
  burned:  ${burnedPath}
  previews: ${previewFrames.map((preview) => preview.path).join('\n            ')}`);
}

function run(label, args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${label} failed with code ${result.status}`);
  }
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
