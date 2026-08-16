const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const webuiDir = path.join(releaseDir, 'webui');
const buildDir = path.join(root, 'build', 'msix');
const stageDir = path.join(buildDir, 'package');
const manifestTemplatePath = path.join(root, 'packaging', 'windows', 'msix', 'AppxManifest.xml.template');
const packageIdentityName = 'BiliRecord2K';
const applicationId = 'BiliRecord2K';
const appInstallerFileName = 'BiliRecord2K.appinstaller';

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('MSIX 只能在 Windows 构建机上生成。');
  }

  const options = readOptions(process.argv.slice(2));
  const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  const versionQuad = toMsixVersion(version, process.env.MSIX_VERSION_QUAD || '');
  const outputDir = path.resolve(options.outputDir || process.env.MSIX_OUTPUT_DIR || releaseDir);
  const feedBaseUrl = normalizeHttpsBaseUrl(options.feedBaseUrl || process.env.MSIX_FEED_BASE_URL || '');
  const allowUnsigned = options.allowUnsigned || isTruthy(process.env.MSIX_ALLOW_UNSIGNED);
  const skipAppInstaller = options.skipAppInstaller || isTruthy(process.env.MSIX_SKIP_APPINSTALLER);
  const feedDir = path.resolve(options.feedDir || process.env.MSIX_FEED_DIR || path.join(buildDir, 'feed'));
  const publisher = String(process.env.MSIX_PUBLISHER || 'CN=BiliRecord2K').trim();
  const publisherDisplayName = String(process.env.MSIX_PUBLISHER_DISPLAY_NAME || 'BiliRecord2K').trim();

  if (!publisher) {
    throw new Error('MSIX_PUBLISHER 不能为空，且必须与签名证书 Subject 完全一致。');
  }
  if (!skipAppInstaller && !feedBaseUrl) {
    throw new Error(
      'MSIX_FEED_BASE_URL 必须是 HTTPS 更新源。若仅做本地包结构验证，请显式传入 --skip-appinstaller。'
    );
  }

  const signing = await resolveSigningCertificate();
  if (!signing && !allowUnsigned) {
    throw new Error(
      '缺少 MSIX 签名证书。设置 MSIX_SIGNING_CERT_PFX_B64 或 MSIX_SIGNING_CERT_PATH；仅本地验证可显式传入 --allow-unsigned。'
    );
  }

  if (!fs.existsSync(webuiDir)) {
    if (options.skipWebuiBuild || isTruthy(process.env.MSIX_SKIP_WEBUI_BUILD)) {
      throw new Error(`找不到已构建的 Windows 程序目录：${webuiDir}`);
    }
    runNodeScript(path.join(root, 'scripts', 'build-webui.cjs'), [], { BUILD_NO_OPEN: '1' });
  }

  const makeAppx = findWindowsSdkTool('makeappx.exe', 'MSIX_MAKEAPPX_PATH');
  if (!makeAppx) {
    throw new Error('未找到 MakeAppx.exe。请安装 Windows 10/11 SDK，或设置 MSIX_MAKEAPPX_PATH。');
  }

  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });
  await fsp.cp(webuiDir, stageDir, { recursive: true });
  await writePackageMetadata(stageDir);
  await copyPackageLogos(stageDir);

  const manifestTemplate = await fsp.readFile(manifestTemplatePath, 'utf8');
  await fsp.writeFile(
    path.join(stageDir, 'AppxManifest.xml'),
    renderManifest(manifestTemplate, {
      packageIdentityName,
      applicationId,
      publisher,
      publisherDisplayName,
      versionQuad,
      displayName: '哔哩录播 2K',
      description: '本地运行的哔哩哔哩直播录制工具'
    }),
    'utf8'
  );

  const msixName = `bili-record-2k-${version}-x64.msix`;
  const msixPath = path.join(outputDir, msixName);
  const appInstallerPath = path.join(outputDir, appInstallerFileName);
  await fsp.rm(msixPath, { force: true });
  await fsp.rm(appInstallerPath, { force: true });
  runTool(makeAppx, ['pack', '/o', '/h', 'SHA256', '/d', stageDir, '/p', msixPath]);

  let signed = false;
  if (signing) {
    const signTool = findWindowsSdkTool('signtool.exe', 'MSIX_SIGNTOOL_PATH');
    if (!signTool) {
      throw new Error('未找到 SignTool.exe。请安装 Windows SDK，或设置 MSIX_SIGNTOOL_PATH。');
    }
    const certificatePublisher = readCertificatePublisher(signing.path, signing.password);
    if (certificatePublisher && !samePublisher(certificatePublisher, publisher)) {
      throw new Error(
        `MSIX_PUBLISHER 与签名证书不匹配。配置为“${publisher}”，证书为“${certificatePublisher}”。`
      );
    }
    signMsix(signTool, msixPath, signing);
    verifyMsixSignature(signTool, msixPath);
    signed = true;
  }

  if (!skipAppInstaller) {
    const packageUrl = joinUrl(feedBaseUrl, msixName);
    const appInstallerUrl = joinUrl(feedBaseUrl, appInstallerFileName);
    await fsp.writeFile(
      appInstallerPath,
      renderAppInstaller({
        packageIdentityName,
        publisher,
        versionQuad,
        packageUrl,
        appInstallerUrl
      }),
      'utf8'
    );
    await fsp.mkdir(feedDir, { recursive: true });
    await copyIfDifferent(msixPath, path.join(feedDir, msixName));
    await copyIfDifferent(appInstallerPath, path.join(feedDir, appInstallerFileName));
  }

  if (!signed) {
    console.warn('MSIX 已生成但未签名：仅可用于结构验证，不能作为面向用户的安装或更新包。');
  }
  console.log('MSIX build OK');
  console.log(`  package: ${msixPath}`);
  console.log(`  signed:  ${signed ? 'yes' : 'no'}`);
  if (!skipAppInstaller) {
    console.log(`  installer: ${appInstallerPath}`);
    console.log(`  feed:      ${feedDir}`);
  }
}

function readOptions(args) {
  return {
    allowUnsigned: args.includes('--allow-unsigned'),
    skipAppInstaller: args.includes('--skip-appinstaller'),
    skipWebuiBuild: args.includes('--skip-webui-build'),
    outputDir: readOption(args, '--output-dir'),
    feedBaseUrl: readOption(args, '--feed-base-url'),
    feedDir: readOption(args, '--feed-dir')
  };
}

function readOption(args, name) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) {
    const value = args[exactIndex + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} 缺少值。`);
    }
    return value;
  }
  const prefix = `${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : '';
}

function toMsixVersion(version, explicitVersion = '') {
  const explicit = String(explicitVersion || '').trim();
  if (explicit) {
    assertMsixVersion(explicit);
    return explicit;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version || '').trim());
  if (!match) {
    throw new Error(`package.json version 不是有效 SemVer：${version}`);
  }
  if (match[4]) {
    throw new Error('预发布版本必须显式设置单调递增的 MSIX_VERSION_QUAD（例如 0.4.8.17）。');
  }
  const result = `${match[1]}.${match[2]}.${match[3]}.0`;
  assertMsixVersion(result);
  return result;
}

function assertMsixVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 65535)) {
    throw new Error(`MSIX_VERSION_QUAD 必须是四段 0-65535 整数：${value}`);
  }
}

function normalizeHttpsBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`MSIX_FEED_BASE_URL 不是有效 URL：${text}`);
  }
  if (url.protocol !== 'https:' || !url.hostname || url.search || url.hash) {
    throw new Error('MSIX_FEED_BASE_URL 必须是不带查询参数或片段的 HTTPS 目录 URL。');
  }
  return url.href.replace(/\/+$/, '');
}

function joinUrl(baseUrl, fileName) {
  return `${baseUrl}/${encodeURIComponent(fileName)}`;
}

async function writePackageMetadata(targetDir) {
  await fsp.writeFile(
    path.join(targetDir, 'install-type.json'),
    `${JSON.stringify({ packageType: 'msix' }, null, 2)}\n`,
    'utf8'
  );
}

async function copyPackageLogos(targetDir) {
  const source = path.join(root, 'assets', 'app-icon.png');
  if (!fs.existsSync(source)) {
    throw new Error(`缺少 MSIX 图标源文件：${source}`);
  }
  const assetsDir = path.join(targetDir, 'Assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  await Promise.all(
    ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png'].map((name) => fsp.copyFile(source, path.join(assetsDir, name)))
  );
}

function renderManifest(template, values) {
  return String(template).replace(/{{([A-Z_]+)}}/g, (placeholder, key) => {
    const replacements = {
      PACKAGE_IDENTITY_NAME: values.packageIdentityName,
      APPLICATION_ID: values.applicationId,
      PUBLISHER: values.publisher,
      PUBLISHER_DISPLAY_NAME: values.publisherDisplayName,
      VERSION_QUAD: values.versionQuad,
      DISPLAY_NAME: values.displayName,
      DESCRIPTION: values.description
    };
    if (!(key in replacements)) {
      throw new Error(`AppxManifest 模板包含未知占位符：${placeholder}`);
    }
    return escapeXml(replacements[key]);
  });
}

function renderAppInstaller({ packageIdentityName, publisher, versionQuad, packageUrl, appInstallerUrl }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021" Version="${escapeXml(versionQuad)}" Uri="${escapeXml(appInstallerUrl)}">
  <MainPackage Name="${escapeXml(packageIdentityName)}" Publisher="${escapeXml(publisher)}" Version="${escapeXml(
    versionQuad
  )}" ProcessorArchitecture="x64" Uri="${escapeXml(packageUrl)}" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="0" ShowPrompt="false" UpdateBlocksActivation="false" />
    <AutomaticBackgroundTask />
  </UpdateSettings>
</AppInstaller>
`;
}

async function resolveSigningCertificate() {
  const base64 = String(process.env.MSIX_SIGNING_CERT_PFX_B64 || '').trim();
  const configuredPath = String(process.env.MSIX_SIGNING_CERT_PATH || '').trim();
  if (base64 && configuredPath) {
    throw new Error('只能设置 MSIX_SIGNING_CERT_PFX_B64 或 MSIX_SIGNING_CERT_PATH 其中之一。');
  }
  if (!base64 && !configuredPath) {
    return null;
  }
  const password = Object.prototype.hasOwnProperty.call(process.env, 'MSIX_SIGNING_CERT_PASSWORD')
    ? String(process.env.MSIX_SIGNING_CERT_PASSWORD || '')
    : undefined;
  if (configuredPath) {
    const resolvedPath = path.resolve(configuredPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`找不到 MSIX 签名证书：${resolvedPath}`);
    }
    return { path: resolvedPath, password };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 128) {
    throw new Error('MSIX_SIGNING_CERT_PFX_B64 不是有效的 PFX 内容。');
  }
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-record-2k-msix-'));
  const certificatePath = path.join(tempDirectory, 'signing-certificate.pfx');
  await fsp.writeFile(certificatePath, bytes, { mode: 0o600 });
  process.once('exit', () => {
    try {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    } catch {
      // Best effort only; the OS temp directory is the fallback cleanup boundary.
    }
  });
  return { path: certificatePath, password };
}

function readCertificatePublisher(certificatePath, password) {
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:BR2K_MSIX_CERT_PATH, $env:BR2K_MSIX_CERT_PASSWORD)',
    '[Console]::Write($cert.Subject)'
  ].join('; ');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BR2K_MSIX_CERT_PATH: certificatePath,
      BR2K_MSIX_CERT_PASSWORD: password === undefined ? '' : password
    }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取 MSIX 签名证书 Subject：${String(result.stderr || result.error?.message || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function samePublisher(left, right) {
  return normalizePublisher(left) === normalizePublisher(right);
}

function normalizePublisher(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function signMsix(signTool, msixPath, signing) {
  const args = ['sign', '/fd', 'SHA256', '/a', '/f', signing.path];
  if (signing.password !== undefined) {
    args.push('/p', signing.password);
  }
  const timestampUrl = String(process.env.MSIX_TIMESTAMP_URL || 'http://timestamp.digicert.com').trim();
  if (timestampUrl) {
    args.push('/tr', timestampUrl, '/td', 'SHA256');
  }
  args.push(msixPath);
  runTool(signTool, args, 'SignTool 签名失败。');
}

function verifyMsixSignature(signTool, msixPath) {
  runTool(signTool, ['verify', '/pa', '/all', msixPath], 'MSIX 签名验证失败。');
}

function findWindowsSdkTool(name, configuredEnvName) {
  const configured = String(process.env[configuredEnvName] || '').trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const fromPath = findCommandOnPath(name);
  if (fromPath) {
    return fromPath;
  }
  const kitRoot = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(kitRoot)) {
    return '';
  }
  const candidates = [];
  for (const entry of fs.readdirSync(kitRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    candidates.push(path.join(kitRoot, entry.name, 'x64', name));
  }
  candidates.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function findCommandOnPath(command) {
  const result = spawnSync('where.exe', [command], { encoding: 'utf8' });
  if (result.status !== 0) {
    return '';
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function runNodeScript(scriptPath, args, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} 构建失败。`);
  }
}

function runTool(command, args, failureMessage = '') {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    throw new Error(`${failureMessage || path.basename(command)} ${result.error.message}`.trim());
  }
  if (result.status !== 0) {
    throw new Error(failureMessage || `${path.basename(command)} 退出码为 ${result.status}。`);
  }
}

async function copyIfDifferent(source, target) {
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) {
    return;
  }
  await fsp.copyFile(source, target);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

module.exports = {
  readOptions,
  toMsixVersion,
  normalizeHttpsBaseUrl,
  renderManifest,
  renderAppInstaller,
  samePublisher
};
