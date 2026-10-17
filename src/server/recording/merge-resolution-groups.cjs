'use strict';
const { createConcatStreamSignature } = require('./ffmpeg.cjs');

function planResolutionMergeGroups(segments, mediaInfos) {
  const groups = [];
  for (let index = 0; index < segments.length; index++) {
    const media = mediaInfos[index] || {}, video = media.videoInfo || {};
    const known = Number(video.width) > 0 && Number(video.height) > 0;
    const unstable = media.streamHeaders?.parameterSetsStable === false;
    const unknownHeaders = Boolean(media.streamHeaders?.error);
    const isolated = !known || unstable;
    const signature = isolated ? `isolated-${index}` : createConcatStreamSignature(media);
    const label = unstable ? (unknownHeaders ? '码流参数待确认' : '段内参数变化') : known ? `${video.width}×${video.height}` : '分辨率未知';
    const previous = groups.at(-1);
    if (!isolated && previous?.signature === signature) {
      previous.indices.push(index); previous.sourcePaths.push(segments[index].cleanPath);
    } else groups.push({ signature, label, width: Number(video.width) || 0, height: Number(video.height) || 0,
      indices: [index], sourcePaths: [segments[index].cleanPath],
      reason: unknownHeaders ? '无法确认段内规格稳定，独立保留原录像。' : unstable ? '段内 SPS/PPS 变化，独立保留原录像，避免强制重编码。' : !known ? '无法确认分辨率，独立保留原录像。' : '' });
  }
  return { groups: groups.map(({ signature, ...group }, index) => ({ ...group, index: index + 1,
    action: group.indices.length >= 2 ? 'merge' : 'keep', sourceCount: group.indices.length })),
    sourceCount: segments.length };
}

module.exports = { planResolutionMergeGroups };
