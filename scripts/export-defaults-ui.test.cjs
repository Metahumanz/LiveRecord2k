const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const { LiveRecordService } = require('../src/server/app/service.cjs');

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
}
function evaluate(code, requireModule) {
  const module = { exports: {} };
  new Function('require', 'exports', 'module', code)(requireModule, module.exports, module);
  return module.exports;
}
const root = path.join(__dirname, '../src/client');
const utils = evaluate(buildSync({ entryPoints: [path.join(root, 'utils.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, require);
const queue = evaluate(transpile(path.join(root, 'settings-save-queue.ts')), require);
const appCode = transpile(path.join(root, 'App.tsx'));

// Delay every state updater until an explicit render, as React is allowed to
// do during a click. Invoke the real App handlers rather than a copy of them.
function createApp(server) {
  const states = [], refs = [], effects = [], updates = [];
  let stateIndex, refIndex, effectIndex, subscriber;
  const pendingEffects = [];
  const hook = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], update => updates.push(() => {
        states[index] = typeof update === 'function' ? update(states[index]) : update;
      })];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] || (refs[index] = { current: initial });
    },
    useEffect(effect) {
      const index = effectIndex++;
      if (!(index in effects)) { effects[index] = true; pendingEffects.push(effect); }
    },
    useMemo: callback => callback(), lazy: () => function LazyPage() {}, Suspense: 'suspense'
  };
  const recorder = {
    getInitialState: async () => structuredClone(server.state),
    onStateChanged: callback => { subscriber = callback; return () => {}; },
    saveSettings: async patch => {
      server.patches.push(structuredClone(patch));
      server.state.settings = { ...server.state.settings, ...patch };
      return structuredClone(server.state);
    }
  };
  const component = evaluate(appCode, name => {
    if (name === 'react') return hook;
    if (name === './recorderClient') return { recorder, RecorderApiError: class extends Error {} };
    if (name === './utils') return utils;
    if (name === './settings-save-queue') return queue;
    if (name === 'lucide-react' || name.startsWith('./components/')) return new Proxy({}, { get: (_, key) => String(key) });
    return require(name);
  }).default;
  return {
    render() {
      while (updates.length) updates.shift()();
      stateIndex = refIndex = effectIndex = 0;
      const tree = component();
      while (pendingEffects.length) pendingEffects.shift()();
      return tree;
    },
    pushState: state => subscriber(structuredClone(state))
  };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return; }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
async function openExport(app) {
  app.render();
  await Promise.resolve();
  const tree = app.render();
  const button = find(tree, node => node.type === 'button' && find(node.props.children, child => child.props?.children === '剪辑导出'));
  button.props.onClick();
  return find(app.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
}
function fixture() {
  return { patches: [], state: { settings: new LiveRecordService().settings, rooms: [], logs: [],
    recordings: [{ cleanPath: '/recordings/a.clean.mp4', durationSec: 60 }, { cleanPath: '/recordings/b.clean.mp4', durationSec: 90 }] } };
}
function withWindow(callback) {
  const original = global.window;
  global.window = { localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 1, clearTimeout() {} };
  return Promise.resolve().then(callback).finally(() => { global.window = original; });
}

test('set default saves burn and all current style values before React commits its settings update', () => withWindow(async () => {
  const server = fixture();
  const app = createApp(server);
  let page = await openExport(app);
  page.selectRecording(server.state.recordings[0]);
  page = find(app.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  page.setDraft({ ...page.draft, mode: 'burn', stylePreset: 'bubble', styleLayout: { panelLeft: 123 },
    overlayMode: 'danmaku', danmakuArea: 'quarter', avatarMode: 'limited' });
  page = find(app.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  await page.saveStyleAsDefault(); // No render between updateSettingsDraft and the save request.
  assert.equal(server.patches.length, 1);
  assert.deepEqual(server.patches[0], { defaultExportMode: 'burn', burnDanmakuStylePreset: 'bubble',
    sceneGraphDefaultStyle: 'bubble', burnDanmakuStyleLayout: { panelLeft: 123 }, burnAvatarMode: 'limited',
    burnOverlayMode: 'danmaku', burnDanmakuArea: 'quarter' });
  page = find(app.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  page.selectRecording(server.state.recordings[1]);
  page = find(app.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  assert.equal(page.draft.mode, 'burn');
  assert.equal(page.draft.stylePreset, 'bubble');
  const refreshedApp = createApp(server);
  let refreshed = await openExport(refreshedApp);
  assert.equal(refreshed.draft.mode, 'burn');
  refreshed.selectRecording(server.state.recordings[0]);
  refreshed = find(refreshedApp.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  assert.equal(refreshed.draft.mode, 'burn');
  // Saving clean later must override burn as well, rather than hard-coding it.
  refreshed.setDraft({ ...refreshed.draft, mode: 'clean' });
  refreshed = find(refreshedApp.render(), node => typeof node.props?.saveStyleAsDefault === 'function').props;
  await refreshed.saveStyleAsDefault();
  assert.equal(server.patches.at(-1).defaultExportMode, 'clean');
  assert.equal((await openExport(createApp(server))).draft.mode, 'clean');
}));

test('SSE state arriving before a render retains the latest uncommitted settings for explicit save', () => withWindow(async () => {
  const server = fixture(), app = createApp(server);
  const page = await openExport(app);
  const tree = app.render();
  find(tree, node => node.type === 'button' && find(node.props.children, child => child.props?.children === '录制配置')).props.onClick();
  const settings = find(app.render(), node => typeof node.props?.commitSettingsDraft === 'function').props;
  settings.updateSettingsDraft({ burnCrf: 29 }, { saveMode: 'commit' });
  app.pushState(server.state); // Old server snapshot before the queued React update runs.
  await settings.commitSettingsDraft(['burnCrf']);
  assert.equal(server.patches.at(-1).burnCrf, 29);
  assert.equal(server.state.settings.defaultExportMode, 'clean');
  assert.equal(page.draft.mode, 'clean');
}));
