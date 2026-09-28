'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function snapshotManualMergeArtifacts(segments, artifacts) {
  const result = {};
  const visit = async target => {
    const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('源配套文件包含符号链接，不能自动清理。');
    result[path.resolve(target)] = [stat.size, stat.mtimeMs, stat.isDirectory()];
    if (stat.isDirectory()) for (const entry of await fs.readdir(target)) await visit(path.join(target, entry));
  };
  for (const target of new Set(segments.flatMap(artifacts))) await visit(target);
  return result;
}

async function deleteManualMergeSources({ root, outputPath, segments, expected, artifacts, artifactSnapshot, isBusy = () => false, onValidated = () => {} }) {
  const rootReal = await fs.realpath(root);
  const inside = value => { const relative = path.relative(rootReal, value); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
  const outputReal = await fs.realpath(outputPath);
  if (!inside(outputReal) || !(await fs.stat(outputReal)).isFile()) throw new Error('合并成片路径无效，源文件保留。');
  const plans = [];
  for (const segment of segments) {
    if (isBusy(segment.cleanPath)) throw new Error('源录像仍有录制、预览或导出任务，源文件保留。');
    const source = await fs.lstat(segment.cleanPath);
    const fingerprint = expected[segment.cleanPath];
    if (!fingerprint || source.isSymbolicLink() || !source.isFile() || source.size !== fingerprint.size || source.mtimeMs !== fingerprint.mtimeMs) {
      throw new Error(`源录像在合并期间发生变化，源文件保留：${path.basename(segment.cleanPath)}；大小 ${fingerprint?.size} → ${source.size}，mtime ${fingerprint?.mtimeMs} → ${source.mtimeMs}。`);
    }
    for (const target of artifacts(segment)) {
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) continue;
      const real = await fs.realpath(target);
      const sourceDirectory = await fs.realpath(path.dirname(segment.cleanPath));
      if (stat.isSymbolicLink() || !inside(real) || real === outputReal || path.dirname(real) !== sourceDirectory) throw new Error('源配套文件不在受保护的清理范围内，源文件保留。');
      plans.push({ target, real, directory: stat.isDirectory() });
    }
  }
  // Validate every source and exact sidecar before deleting any of them.
  if (artifactSnapshot) {
    const current = await snapshotManualMergeArtifacts(segments, artifacts);
    const keys = Object.keys(current).sort(), originalKeys = Object.keys(artifactSnapshot).sort();
    if (JSON.stringify(keys) !== JSON.stringify(originalKeys) || keys.some(key => JSON.stringify(current[key]) !== JSON.stringify(artifactSnapshot[key]))) {
      throw new Error('源配套文件在合并期间发生变化，源文件保留。');
    }
  }
  if (segments.some(segment => isBusy(segment.cleanPath))) throw new Error('源录像开始被其它任务使用，源文件保留。');
  await onValidated();
  let deleted = 0;
  for (const plan of new Map(plans.map(item => [item.real, item])).values()) {
    if (segments.some(segment => isBusy(segment.cleanPath))) throw new Error('源录像开始被其它任务使用，剩余源文件保留。');
    await fs.rm(plan.target, { recursive: plan.directory, force: true });
    deleted += 1;
  }
  return deleted;
}
module.exports = { deleteManualMergeSources, snapshotManualMergeArtifacts };
