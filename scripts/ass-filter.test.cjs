const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createAssFilter, createBurnVideoFilter } = require('../src/server/recording/ffmpeg.cjs');

test('ASS filter always uses an explicit filename option and escapes cross-platform paths', () => {
  assert.equal(
    createAssFilter('C:\\Recordings\\overlay.ass'),
    "ass=filename='C\\:/Recordings/overlay.ass'"
  );
  assert.equal(
    createAssFilter('C:\\Recordings\\space name\\subtitle file.ass'),
    "ass=filename='C\\:/Recordings/space name/subtitle file.ass'"
  );
  assert.equal(
    createAssFilter("C:\\Recordings\\O'Brien.ass"),
    "ass=filename='C\\:/Recordings/O\\'Brien.ass'"
  );
  assert.equal(createAssFilter('/tmp/br2k/subtitle.ass'), "ass=filename='/tmp/br2k/subtitle.ass'");
  assert.match(createBurnVideoFilter('/tmp/br2k/subtitle.ass', 30), /ass=filename='\/tmp\/br2k\/subtitle\.ass'/);
});

async function collectProjectCodeFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectProjectCodeFiles(filePath)));
    } else if (/\.(?:cjs|mjs|js|ts|tsx)$/i.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}

test('project source does not generate anonymous ASS filters', async () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...(await collectProjectCodeFiles(path.join(root, 'src'))),
    ...(await collectProjectCodeFiles(path.join(root, 'scripts')))
  ];
  const anonymousAss = new RegExp("ass" + "=\\s*'");
  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(source, anonymousAss, filePath);
  }
});
