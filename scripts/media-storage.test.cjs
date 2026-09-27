const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { assertDiskSpace, selectSceneMediaWorkspace, atomicReplaceFile } = require('../src/server/recording/media-safety.cjs');
const GiB = 1024 ** 3;

async function volumes(t, localFree = 30 * GiB, remoteFree = 1000 * GiB, sameVolume = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), destination = path.join(root, 'destination');
  await fs.mkdir(cache); await fs.mkdir(destination);
  const output = path.join(destination, 'output.mp4');
  const originalStat = fs.stat.bind(fs);
  t.mock.method(fs, 'statfs', async dir => {
    const free = String(dir).startsWith(destination) ? remoteFree : localFree;
    return { bavail: free / 4096, bsize: 4096, blocks: 2000 * GiB / 4096 };
  });
  t.mock.method(fs, 'stat', async name => {
    const value = await originalStat(name);
    value.dev = sameVolume ? 1 : String(name).startsWith(destination) ? 2 : 1;
    return value;
  });
  return { root, cache, destination, output };
}

test('long export stages media on another output filesystem when local storage cannot hold both copies', async t => {
  const { cache, destination, output } = await volumes(t);
  const workspace = await selectSceneMediaWorkspace(output, cache, { mediaPeakBytes: 40 * GiB,
    outputBytes: 20 * GiB, scratchBytes: GiB, allowDestinationMedia: true });
  assert.equal(workspace.separateMediaDirectory, true);
  assert.equal(path.dirname(workspace.mediaDirectory), destination);
  assert.match(workspace.localSpaceError, /30.00 GiB.*41.00 GiB.*2.00 GiB.*43.00 GiB/);
  const temporary = path.join(workspace.mediaDirectory, 'completed.mp4');
  await fs.writeFile(temporary, 'verified export'); await fs.writeFile(output, 'old video');
  await atomicReplaceFile(temporary, output);
  assert.equal(await fs.readFile(output, 'utf8'), 'verified export');
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
});

test('short export retains local intermediates when sufficient space is available', async t => {
  const { cache, output } = await volumes(t);
  const workspace = await selectSceneMediaWorkspace(output, cache, { mediaPeakBytes: GiB,
    outputBytes: GiB / 2, scratchBytes: GiB, allowDestinationMedia: true });
  assert.deepEqual(workspace, { mediaDirectory: cache, separateMediaDirectory: false });
});

test('moving within the same volume cannot bypass the disk protection', async t => {
  const { cache, output } = await volumes(t, 30 * GiB, 1000 * GiB, true);
  await assert.rejects(selectSceneMediaWorkspace(output, cache, { mediaPeakBytes: 40 * GiB,
    outputBytes: 20 * GiB, scratchBytes: GiB, allowDestinationMedia: true }), error =>
    error.code === 'BR2K_DISK_SPACE_INSUFFICIENT' && error.targetPath === cache);
});

test('destination staging still protects local scratch and destination peak usage', async t => {
  const { cache, output } = await volumes(t, 2 * GiB, 1000 * GiB);
  await assert.rejects(selectSceneMediaWorkspace(output, cache, { mediaPeakBytes: 40 * GiB,
    outputBytes: 20 * GiB, scratchBytes: GiB, allowDestinationMedia: true }), { code: 'BR2K_DISK_SPACE_INSUFFICIENT' });
});

test('insufficient output space reports the actual path, estimate and reserve', async t => {
  const { destination, output } = await volumes(t, 30 * GiB, 25 * GiB);
  await assert.rejects(assertDiskSpace(output, { estimatedBytes: 30 * GiB }), error => {
    assert.equal(error.targetPath, destination); assert.equal(error.requiredBytes, 32 * GiB);
    assert.match(error.message, /25.00 GiB.*30.00 GiB.*2.00 GiB.*32.00 GiB/);
    return error.code === 'BR2K_DISK_SPACE_INSUFFICIENT';
  });
});

test('unsupported render paths and unrelated I/O errors cannot silently switch workspaces', async t => {
  const { cache, output } = await volumes(t);
  await assert.rejects(selectSceneMediaWorkspace(output, cache, { mediaPeakBytes: 40 * GiB,
    outputBytes: 20 * GiB, scratchBytes: GiB, allowDestinationMedia: false }), { code: 'BR2K_DISK_SPACE_INSUFFICIENT' });
  t.mock.method(fs, 'statfs', async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
  await assert.rejects(selectSceneMediaWorkspace(output, cache, { allowDestinationMedia: true }), { code: 'EACCES' });
});
