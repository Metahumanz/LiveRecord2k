const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AccessAuthManager,
  hashAccessPassword,
  verifyAccessPassword,
  parseCookieHeader
} = require('../src/server/app/auth.cjs');

test('remote access passwords are salted and verified with scrypt', async () => {
  const first = await hashAccessPassword('correct horse battery staple');
  const second = await hashAccessPassword('correct horse battery staple');

  assert.notEqual(first, second);
  assert.equal(await verifyAccessPassword('correct horse battery staple', first), true);
  assert.equal(await verifyAccessPassword('wrong password', first), false);
  assert.equal(await verifyAccessPassword('anything', 'not-a-password-hash'), false);
});

test('remote access sessions can be authenticated and revoked', async () => {
  const passwordHash = await hashAccessPassword('a secure test password');
  const manager = new AccessAuthManager({ sessionTtlMs: 60_000 });
  const settings = { accessUsername: 'operator', accessPasswordHash: passwordHash };
  const session = await manager.login({
    username: 'operator',
    password: 'a secure test password',
    settings,
    remoteKey: 'test-client'
  });

  assert.equal(manager.authenticate(session.token), true);
  manager.logout(session.token);
  assert.equal(manager.authenticate(session.token), false);
  await assert.rejects(
    manager.login({ username: 'operator', password: 'wrong password', settings, remoteKey: 'test-client' }),
    /用户名或密码错误/
  );
});

test('access cookie parsing tolerates encoded values and malformed input', () => {
  assert.deepEqual(parseCookieHeader('a=1; br2k_access=hello%20world; broken'), {
    a: '1',
    br2k_access: 'hello world'
  });
});
