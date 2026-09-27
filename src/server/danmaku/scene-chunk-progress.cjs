'use strict';
const { parseFfmpegProgressTime } = require('../shared/helpers.cjs');

function createSceneChunkProgress({ onStderr, onProgress, onPhase }) {
  let phase = 'render';
  return {
    onPhase(nextPhase, options) {
      phase = nextPhase;
      onPhase?.(nextPhase, options);
    },
    onStderr(text) {
      onStderr?.(text);
      const seconds = parseFfmpegProgressTime(text);
      // A video's remux clock starts at zero again; it is not a second render.
      if (phase === 'render' && Number.isFinite(seconds)) onProgress?.(seconds);
    }
  };
}
module.exports = { createSceneChunkProgress };
