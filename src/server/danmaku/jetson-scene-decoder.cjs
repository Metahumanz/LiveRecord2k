'use strict';

function frameRate(value) {
  const [n, d = 1] = String(value || '').split('/').map(Number);
  return n > 0 && d > 0 ? n / d : 0;
}

function selectJetsonSceneDecoder(decoder, recording, videoInfo) {
  const nominal = frameRate(videoInfo?.rFrameRate);
  const average = frameRate(videoInfo?.avgFrameRate) || Number(videoInfo?.fps) || 0;
  // On the real merged 4K VFR fixture, NVDEC paired valid PTS with pictures
  // roughly 0.3 seconds earlier. The PTS-only bridge cannot detect that.
  // Keep NVDEC for stable clocks; normalize this known input class through
  // FFmpeg before CUDA composition/NVENC, without changing the source file.
  const merged = recording?.mergedFrom?.length > 1 || recording?.timingInfo?.sourceSegments?.length > 1;
  if (decoder?.value === 'gstreamer-nvv4l2' && merged &&
      nominal > 0 && average > 0 && Math.abs(average / nominal - 1) > 0.01) {
    return { value: 'software', label: 'CPU（合并录像混合帧率）', kind: 'software', normalizedFps: Math.min(60, nominal),
      reason: `合并录像平均帧率 ${average.toFixed(3)} 与声明帧率 ${nominal.toFixed(3)} 不一致，使用 CPU 解码和恒定帧率时间轴，保留 CUDA 合成与硬件编码。` };
  }
  return decoder;
}

module.exports = { selectJetsonSceneDecoder };
