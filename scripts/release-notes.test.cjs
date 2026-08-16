const assert = require('node:assert/strict');
const test = require('node:test');
const { generateReleaseNotes } = require('./generate-release-notes.cjs');

const CHANGELOG = `# 更新日志

## 1.2.3 - 2026-08-16

- 新功能。
- 修复问题。

## 1.2.2 - 2026-08-15

- 旧版本内容。`;

test('release notes include only the matching changelog entry and installation notes', () => {
  const notes = generateReleaseNotes(CHANGELOG, 'v1.2.3');

  assert.match(notes, /^## 更新日志/m);
  assert.match(notes, /- 新功能。/);
  assert.match(notes, /- 修复问题。/);
  assert.doesNotMatch(notes, /旧版本内容/);
  assert.match(notes, /^## 安装说明/m);
  assert.match(notes, /bili-record-2k-setup\.exe/);
});

test('release notes reject a missing or invalid version', () => {
  assert.throws(() => generateReleaseNotes(CHANGELOG, 'v1.2.4'), /找不到/);
  assert.throws(() => generateReleaseNotes(CHANGELOG, 'preview'), /无效的发布标签/);
});
