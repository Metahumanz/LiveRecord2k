'use strict';
function estimateSceneScratchBytes(graph) {
  const keys = new Set();
  let textureBytes = 0;
  for (const object of graph.objects || []) {
    if (object.render === false) continue;
    const frame = object.frame || {};
    const phase = object.type === 'Text' ? ['x', 'y'].map(axis => Number(frame[axis] || 0) - Math.floor(Number(frame[axis] || 0) + 0.5)) : [];
    const key = JSON.stringify([object.type, frame.width, frame.height, phase, object.props, object.style]);
    if (keys.has(key)) continue;
    keys.add(key);
    const bytes = Math.max(2, Math.ceil(Number(frame.width) || 2)) * Math.max(2, Math.ceil(Number(frame.height) || 2)) * 4;
    if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024 ** 2) throw new Error('Scene 单个纹理尺寸超过资源上限。');
    textureBytes += bytes;
  }
  // Include request/manifest serialization, filesystem allocation and working
  // buffers. This is conservative; the helper reports actual deduplicated bytes.
  return { textureBytes, uniqueTextures: keys.size,
    scratchBytes: Math.ceil(textureBytes * 1.15 + (graph.objects?.length || 0) * 2048 + 576 * 1024 ** 2) };
}
module.exports = { estimateSceneScratchBytes };
