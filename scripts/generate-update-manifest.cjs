const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

async function main() {
  const tagName = String(process.argv[2] || process.env.RELEASE_TAG || '').trim();
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tagName)) {
    throw new Error('Release tag must look like v1.2.3.');
  }
  const version = tagName.slice(1);
  const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  if (String(packageJson.version) !== version) {
    throw new Error(`package.json version ${packageJson.version} does not match ${tagName}.`);
  }
  const repository = String(process.env.GITHUB_REPOSITORY || 'Metahumanz/LiveRecord2k').trim();
  const specs = [
    { pattern: /^bili-record-2k-setup\.exe$/, kind: 'installer', platform: 'win32', arch: 'x64' },
    { pattern: /^bili-record-2k-webui\.zip$/, kind: 'portable', platform: 'win32', arch: 'x64' },
    { pattern: new RegExp(`^bili-record-2k_${escapeRegex(version)}_(amd64|arm64)\\.deb$`), kind: 'deb', platform: 'linux' },
    {
      pattern: new RegExp(`^bili-record-2k_${escapeRegex(version)}_linux_(x64|arm64)\\.tar\\.gz$`),
      kind: 'tarball',
      platform: 'linux'
    }
  ];
  const entries = await fsp.readdir(releaseDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const spec = specs.find((candidate) => candidate.pattern.test(entry.name));
    if (!spec) continue;
    const match = entry.name.match(spec.pattern);
    const arch = normalizeArch(spec.arch || match?.[1] || 'all');
    files.push({
      name: entry.name,
      kind: spec.kind,
      platform: spec.platform,
      arch,
      url: `https://github.com/${repository}/releases/download/${tagName}/${encodeURIComponent(entry.name)}`,
      sha256: await fileSha256(path.join(releaseDir, entry.name))
    });
  }
  for (const required of [
    ['installer', 'win32', 'x64'],
    ['portable', 'win32', 'x64'],
    ['deb', 'linux', 'x64'],
    ['deb', 'linux', 'arm64'],
    ['tarball', 'linux', 'x64'],
    ['tarball', 'linux', 'arm64']
  ]) {
    const [kind, platform, arch] = required;
    if (!files.some((file) => file.kind === kind && file.platform === platform && file.arch === arch)) {
      throw new Error(`Missing ${platform}/${arch} ${kind} release package.`);
    }
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  const installer = files.find((file) => file.kind === 'installer');
  const portable = files.find((file) => file.kind === 'portable');
  const signed = {
    schemaVersion: 1,
    app: 'bili-record-2k',
    name: 'BiliRecord2K',
    version,
    tagName,
    releasedAt: new Date().toISOString(),
    files
  };
  const privateKeySource = String(process.env.UPDATE_SIGNING_PRIVATE_KEY_B64 || '').trim();
  if (!privateKeySource) {
    throw new Error('UPDATE_SIGNING_PRIVATE_KEY_B64 is required to sign an official release manifest.');
  }
  const privateKey = Buffer.from(privateKeySource, 'base64').toString('utf8');
  const signature = crypto.sign(null, Buffer.from(stableStringify(signed)), privateKey).toString('base64');
  const manifest = {
    schemaVersion: 3,
    signed,
    signatureAlgorithm: 'ed25519',
    signature,
    name: signed.name,
    version,
    tagName,
    packageType: 'installer',
    packageUrl: installer.url,
    sha256: installer.sha256,
    installerUrl: installer.url,
    installerSha256: installer.sha256,
    portableUrl: portable.url,
    portableSha256: portable.sha256,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tagName}`,
    releasedAt: signed.releasedAt,
    files
  };
  const outputPath = path.join(releaseDir, 'update.json');
  await fsp.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Generated ${outputPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeArch(value) {
  if (value === 'amd64') return 'x64';
  return value;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
