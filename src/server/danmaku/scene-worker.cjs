'use strict';
const fs = require('node:fs/promises');
const { buildSceneGraph, clipSceneGraph } = require('./scene-graph.cjs');
const { writeGraph, readGraphLines } = require('./scene-graph-io.cjs');
async function runSceneWorker() {
  const request = JSON.parse(await fs.readFile(process.argv.at(-1), 'utf8'));
  let graph;
  try { graph = await readGraphLines(request.cachePath, request.clipStart, request.clipEnd); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    graph = buildSceneGraph(request.events, request.options);
    const temporary = request.cachePath + '.' + process.pid + '.tmp';
    await writeGraph(temporary, graph, true);
    await fs.rename(temporary, request.cachePath);
    await fs.rename(temporary + '.index.json', request.cachePath + '.index.json');
  }
  if (Number.isFinite(request.clipStart) && Number.isFinite(request.clipEnd)) {
    graph = clipSceneGraph(graph, request.clipStart, request.clipEnd, { shiftTime: false });
  }
  await writeGraph(request.outputPath, graph, request.resultFormat === 'jsonl');
}
module.exports = { runSceneWorker };
