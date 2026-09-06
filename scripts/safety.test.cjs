const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AtomicJsonStore, loadAtomicStore } = require('../src/server/app/atomic-store.cjs');
const { MediaJobManager } = require('../src/server/app/media-job-manager.cjs');
const {
  getRequestNetworkContext,
  isPrivateOrSpecialAddress,
  redactObject,
  redactSensitive,
  validateRemoteUrl
} = require('../src/server/shared/security.cjs');
const { stableStringify, verifySignedRequest } = require('../packaging/linux/linux-update.cjs');

test('reverse-proxy headers are ignored unless the direct peer is explicitly trusted', () => {
  const untrusted = getRequestNetworkContext(
    {
      headers: { 'x-forwarded-for': '198.51.100.8', 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '10.1.2.3' }
    },
    ['127.0.0.1']
  );
  assert.equal(untrusted.clientAddress, '10.1.2.3');
  assert.equal(untrusted.forwardedProto, '');

  const trusted = getRequestNetworkContext(
    {
      headers: { 'x-forwarded-for': '198.51.100.8', 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '127.0.0.1' }
    },
    ['loopback']
  );
  assert.equal(trusted.clientAddress, '198.51.100.8');
  assert.equal(trusted.forwardedProto, 'https');

  const chained = getRequestNetworkContext(
    {
      headers: { 'x-forwarded-for': '192.0.2.55, 198.51.100.8' },
      socket: { remoteAddress: '127.0.0.1' }
    },
    ['loopback']
  );
  assert.equal(chained.clientAddress, '198.51.100.8');

  const ipv6Cidr = getRequestNetworkContext(
    {
      headers: { 'x-forwarded-for': '2001:4860:4860::8888' },
      socket: { remoteAddress: '2001:db8:abcd::2' }
    },
    ['2001:db8::/32']
  );
  assert.equal(ipv6Cidr.clientAddress, '2001:4860:4860::8888');
});

test('SSRF guard rejects loopback, private, credentials, and non-HTTP URLs', async () => {
  await assert.rejects(validateRemoteUrl('http://127.0.0.1/private'), /私有或保留网络/);
  await assert.rejects(validateRemoteUrl('http://10.0.0.1/private'), /私有或保留网络/);
  await assert.rejects(validateRemoteUrl('http://255.255.255.255/private'), /私有或保留网络/);
  await assert.rejects(validateRemoteUrl('http://[fec0::1]/private'), /私有或保留网络/);
  await assert.rejects(validateRemoteUrl('http://user:pass@example.com/'), /用户名或密码/);
  await assert.rejects(validateRemoteUrl('file:///etc/passwd'), /不允许访问/);
  assert.equal(isPrivateOrSpecialAddress('2001:4860:4860::8888'), false);
});

test('sensitive log values are consistently redacted', () => {
  assert.doesNotMatch(redactSensitive('Authorization: Bearer top-secret token=abc'), /top-secret|abc/);
  assert.deepEqual(redactObject({ cookie: 'SESSDATA=secret', nested: { password: 'pw', ok: 'visible' } }), {
    cookie: '[redacted]',
    nested: { password: '[redacted]', ok: 'visible' }
  });
});

test('settings writes are serialized and corrupt primary state recovers from backup', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-atomic-store-'));
  const storePath = path.join(tempDir, 'settings.json');
  try {
    const store = new AtomicJsonStore(storePath);
    await Promise.all([
      store.save({ settings: { pollIntervalSec: 1 }, rooms: [] }),
      store.save({ settings: { pollIntervalSec: 2 }, rooms: [{ id: '2' }] }),
      store.save({ settings: { pollIntervalSec: 3 }, rooms: [{ id: '3' }] })
    ]);
    assert.equal(JSON.parse(await fsp.readFile(storePath, 'utf8')).settings.pollIntervalSec, 3);
    await fsp.writeFile(storePath, '{corrupt', 'utf8');
    const recoveryStore = new AtomicJsonStore(storePath);
    const recovered = await recoveryStore.load();
    assert.equal(recovered.recoveredFromBackup, true);
    assert.equal(recovered.store.settings.pollIntervalSec, 2);
    await recoveryStore.save(recovered.store);
    await fsp.writeFile(storePath, '{corrupt-again', 'utf8');
    const recoveredAgain = await loadAtomicStore(storePath);
    assert.equal(recoveredAgain.recoveredFromBackup, true);
    assert.equal(recoveredAgain.store.settings.pollIntervalSec, 2);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('media jobs honor priority while preserving the active resource limit', async () => {
  const manager = new MediaJobManager({ limits: { cpu: 1 } });
  const active = await manager.acquire({ id: 'active', type: 'export', resource: 'cpu' });
  const order = [];
  const previewPromise = manager.acquire({ id: 'preview', type: 'preview', resource: 'cpu' }).then((lease) => {
    order.push('preview');
    lease.release();
  });
  const mergePromise = manager.acquire({ id: 'merge', type: 'merge', resource: 'cpu' }).then((lease) => {
    order.push('merge');
    lease.release();
  });
  active.release();
  await Promise.all([previewPromise, mergePromise]);
  assert.deepEqual(order, ['merge', 'preview']);
});

test('new CPU-heavy jobs wait while recording has the highest priority', async () => {
  const manager = new MediaJobManager({ limits: { cpu: 1 } });
  const releaseRecording = manager.registerExternal({ id: 'recording', type: 'recording' });
  let started = false;
  const pending = manager.acquire({ id: 'burn', type: 'burn', resource: 'cpu' }).then((lease) => {
    started = true;
    lease.release();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  releaseRecording();
  await pending;
  assert.equal(started, true);
});

test('hybrid hardware jobs reserve both CPU filters and the GPU encoder', async () => {
  const manager = new MediaJobManager({ limits: { cpu: 1, gpu: 1 } });
  const cpuLease = await manager.acquire({ id: 'cpu-preview', type: 'preview', resource: 'cpu' });
  let hybridStarted = false;
  const hybrid = manager.acquire({ id: 'nvenc-burn', type: 'burn', resource: 'hybrid' }).then((lease) => {
    hybridStarted = true;
    lease.release();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hybridStarted, false);
  cpuLease.release();
  await hybrid;
  assert.equal(hybridStarted, true);
});

test('root updater accepts only a package bound to a valid official signature', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const packageName = `bili-record-2k_4.0.0_linux_${process.arch}.tar.gz`;
  const signed = {
    app: 'bili-record-2k',
    files: [
      {
        arch: process.arch,
        kind: 'tarball',
        name: packageName,
        platform: 'linux',
        sha256: 'a'.repeat(64)
      }
    ],
    schemaVersion: 1,
    version: '4.0.0'
  };
  const signature = crypto.sign(null, Buffer.from(stableStringify(signed)), privateKey).toString('base64');
  const request = { packagePath: path.join(os.tmpdir(), packageName), signed, signature };
  const selected = await verifySignedRequest(request, { publicKey });
  assert.equal(selected.name, packageName);
  await assert.rejects(
    verifySignedRequest({ ...request, signed: { ...signed, version: '4.0.1' } }, { publicKey }),
    /签名验证失败/
  );
});
