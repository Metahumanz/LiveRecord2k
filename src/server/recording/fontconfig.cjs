'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function windowsFontconfigXml(env, cacheDirectory) {
  const directories = [path.join(env.WINDIR || 'C:\\Windows', 'Fonts')];
  if (env.LOCALAPPDATA) directories.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n' +
    directories.map((directory) => `  <dir>${xml(directory.replace(/\\/g, '/'))}</dir>`).join('\n') +
    `\n  <cachedir>${xml(cacheDirectory.replace(/\\/g, '/'))}</cachedir>\n` +
    '  <alias><family>sans-serif</family><prefer><family>Microsoft YaHei</family><family>Segoe UI</family><family>Segoe UI Symbol</family><family>Segoe UI Emoji</family></prefer></alias>\n</fontconfig>\n';
}

// Static Windows FFmpeg distributions do not ship a working default config.
// Use explicit system/user font directories and a writable per-user cache.
// This covers drawtext as well as libass and needs no system installation.
function ffmpegEnvironment(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return env;
  if (env.FONTCONFIG_FILE && fs.existsSync(env.FONTCONFIG_FILE)) return env;
  const directory = path.join(os.tmpdir(), 'br2k-fontconfig-v1');
  const config = path.join(directory, 'fonts.conf');
  const cache = path.join(directory, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const contents = windowsFontconfigXml(env, cache);
  if (!fs.existsSync(config) || fs.readFileSync(config, 'utf8') !== contents) fs.writeFileSync(config, contents, 'utf8');
  return { ...env, FONTCONFIG_FILE: config, FONTCONFIG_PATH: directory };
}

module.exports = { windowsFontconfigXml, ffmpegEnvironment };
