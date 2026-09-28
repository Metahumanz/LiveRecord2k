'use strict';

// Bundle with esbuild before running. Reads the real recording library but never mutates it.
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { discoverRecordingFiles } = require('../src/server/shared/helpers.cjs');
const { getSameLiveMergeSuggestions, getManualMergeSelection } = require('../src/client/components/ManualMergeControls.tsx');

async function main() {
  const outputDir = process.env.BR2K_ACCEPT_RECORDINGS;
  const stateUrl = process.env.BR2K_ACCEPT_STATE_URL;
  assert.ok(outputDir || stateUrl, 'BR2K_ACCEPT_RECORDINGS or BR2K_ACCEPT_STATE_URL is required');
  const ffmpegPath = process.env.BR2K_ACCEPT_FFMPEG || 'ffmpeg';
  const started = performance.now();
  const state = stateUrl ? await fetch(stateUrl).then(response => {
    assert.equal(response.ok, true, `state HTTP ${response.status}`);
    return response.json();
  }) : null;
  const recordings = state?.recordings || await discoverRecordingFiles(outputDir, { ffmpegPath, limit: 160, concurrency: 4 });
  const rooms = state?.rooms || [...new Set(recordings.map(recording => String(recording.roomId || '')).filter(Boolean))]
    .map(id => ({ id, recording: false }));
  const suggestions = getSameLiveMergeSuggestions(recordings, rooms);
  for (const suggestion of suggestions) {
    const paths = suggestion.recordings.map(recording => recording.cleanPath);
    assert.equal(getManualMergeSelection(recordings, paths, rooms).reason, '');
    assert.ok(suggestion.gapsSec.every(gap => gap >= -120 && gap <= 900));
    assert.ok(suggestion.recordings.every(recording => recording.valid !== false));
    const sessions = [...new Set(suggestion.recordings.map(recording => recording.liveSessionId).filter(Boolean))];
    assert.ok(sessions.length <= 1, 'suggestion spans different known live sessions');
  }
  const summary = suggestions.map(suggestion => ({
    roomId: suggestion.room.id, count: suggestion.recordings.length,
    first: path.basename(suggestion.recordings[0].cleanPath),
    last: path.basename(suggestion.recordings[suggestion.recordings.length - 1].cleanPath),
    maxGapSec: Math.round(Math.max(...suggestion.gapsSec)),
    sessions: [...new Set(suggestion.recordings.map(recording => recording.liveSessionId).filter(Boolean))].length
  }));
  console.log(JSON.stringify({ ok: true, host: os.hostname(), source: stateUrl ? 'running-service' : 'disk-scan',
    scanned: recordings.length,
    available: recordings.filter(recording => recording.valid).length,
    suggestions: summary, elapsedSec: Number(((performance.now() - started) / 1000).toFixed(3)) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
