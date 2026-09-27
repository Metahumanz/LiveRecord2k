'use strict';
const fs = require('node:fs/promises');
const { buildSceneGraph, clipSceneGraph } = require('./scene-graph.cjs');
async function runSceneWorker() {
  const request = JSON.parse(await fs.readFile(process.argv.at(-1), 'utf8'));
  let graph;
  try { graph = JSON.parse(await fs.readFile(request.cachePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    graph = buildSceneGraph(request.events, request.options);
    const temporary = request.cachePath + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(graph), { mode: 0o600 });
    await fs.rename(temporary, request.cachePath);
  }
  if (Number.isFinite(request.clipStart) && Number.isFinite(request.clipEnd)) {
    graph = clipSceneGraph(graph, request.clipStart, request.clipEnd, { shiftTime: false });
  }
  await fs.writeFile(request.outputPath, JSON.stringify(graph));
}
module.exports = { runSceneWorker };
