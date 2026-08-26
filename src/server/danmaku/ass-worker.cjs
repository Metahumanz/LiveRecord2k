const fs = require('node:fs');
const fsp = require('node:fs/promises');
const {
  readDanmakuEvents,
  readDanmakuStyle,
  resolveDanmakuStyle,
  adaptDanmakuStyleToVideo,
  createAvatarOverlayPlan,
  createAss
} = require('./ass.cjs');

const MAX_REQUEST_BYTES = 256 * 1024;

async function writeAvatarPlan(avatarPlanPath, avatarPlan) {
  const targetPath = String(avatarPlanPath || '').trim();
  if (!targetPath) {
    return false;
  }
  if (!avatarPlan) {
    await fsp.rm(targetPath, { force: true }).catch(() => {});
    return false;
  }
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, JSON.stringify(avatarPlan), 'utf8');
    await fsp.rm(targetPath, { force: true });
    await fsp.rename(temporaryPath, targetPath);
    return true;
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readWorkerRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of fs.createReadStream(null, { fd: 0, autoClose: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('字幕任务参数过大。');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text || '{}');
}

async function runAssWorker() {
  const request = await readWorkerRequest();
  const danmakuPath = String(request.danmakuPath || '').trim();
  const cssPath = String(request.cssPath || '').trim();
  const assPath = String(request.assPath || '').trim();
  const avatarPlanPath = String(request.avatarPlanPath || '').trim();
  if (!danmakuPath || !cssPath || !assPath) {
    throw new Error('字幕任务缺少输入或输出路径。');
  }
  const [events, baseStyle] = await Promise.all([readDanmakuEvents(danmakuPath), readDanmakuStyle(cssPath)]);
  const baseResolvedStyle = resolveDanmakuStyle(baseStyle, request.stylePreset, request.styleLayout);
  const style = adaptDanmakuStyleToVideo(baseResolvedStyle, request.videoInfo);
  const ass = createAss(events, {
    overlayMode: request.overlayMode,
    danmakuArea: request.danmakuArea,
    style: baseResolvedStyle,
    videoInfo: request.videoInfo,
    startTime: request.startTime,
    endTime: request.endTime,
    shiftTime: request.shiftTime
  });
  const avatarPlan = ['h5-card', 'bubble'].includes(String(style.visualPreset || ''))
    ? createAvatarOverlayPlan(events, {
        overlayMode: request.overlayMode,
        danmakuArea: request.danmakuArea,
        style: baseResolvedStyle,
        videoInfo: request.videoInfo,
        startTime: request.startTime,
        endTime: request.endTime,
        shiftTime: request.shiftTime,
        maxEntries: request.avatarOverlayMaxEntries,
        maxSegmentsPerEntry: request.avatarOverlayMaxSegmentsPerEntry
      })
    : undefined;
  const avatarPlanStored = await writeAvatarPlan(avatarPlanPath, avatarPlan);
  await fsp.writeFile(assPath, ass, 'utf8');
  const response = {
    ok: true,
    eventCount: events.length,
    playWidth: style.playWidth,
    playHeight: style.playHeight,
    portrait: style.playHeight > style.playWidth
  };
  if (avatarPlanStored) {
    response.avatarPlanStored = true;
  }
  process.stdout.write(JSON.stringify(response));
}

module.exports = { runAssWorker };
