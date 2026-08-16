const fs = require('fs');
const path = require('path');

const INSTALLATION_NOTES = `## 安装说明

Windows：新用户使用 \`bili-record-2k-setup.exe\`；免安装使用 \`bili-record-2k-webui.zip\`。

Debian/Ubuntu x64 或 ARM64：下载架构匹配的 \`.deb\` 后运行 \`sudo apt install ./bili-record-2k_版本_架构.deb\`。

其他使用 systemd 的 x64/ARM64 Linux：下载架构匹配的 \`_linux_架构.tar.gz\`，解压后运行 \`sudo ./install.sh\`。

Linux 包会安装 systemd 主服务和独立的受控更新服务。官方自动更新必须通过 Ed25519 签名验证；自定义更新源不会交给 root 自动安装。

Linux 一键安装：\`curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh | sudo sh\``;

function normalizeVersionFromTag(tag) {
  const version = String(tag || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`无效的发布标签：${tag || '(空)'}`);
  }
  return version;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChangelogEntry(changelog, version) {
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s+-\\s+[^\\r\\n]+)?\\s*$`, 'm').exec(changelog);
  if (!heading || heading.index === undefined) {
    throw new Error(`在 CHANGELOG.md 中找不到 ${version} 的更新日志`);
  }
  const afterHeading = changelog.slice(heading.index + heading[0].length).replace(/^\r?\n+/, '');
  const nextHeadingIndex = afterHeading.search(/^##\s+/m);
  const entry = (nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex)).trim();
  if (!entry) {
    throw new Error(`${version} 的更新日志不能为空`);
  }
  return entry;
}

function generateReleaseNotes(changelog, tag) {
  const version = normalizeVersionFromTag(tag);
  const entry = extractChangelogEntry(changelog, version);
  return `## 更新日志\n\n${entry}\n\n${INSTALLATION_NOTES}\n`;
}

function main() {
  const tag = process.argv[2];
  const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  process.stdout.write(generateReleaseNotes(changelog, tag));
}

if (require.main === module) {
  main();
}

module.exports = {
  extractChangelogEntry,
  generateReleaseNotes,
  normalizeVersionFromTag
};
