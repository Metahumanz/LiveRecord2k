# Windows MSIX 单用户安装与静默更新

> 此流程要求 Windows 10 2004（19041）或更新版本，以及已安装的 Windows App Installer。

MSIX 版是单用户安装：由 Windows 安装到受保护的包目录，应用数据仍保留在当前用户的 `%APPDATA%\BiliRecord2K`。首次安装和后续更新不需要管理员权限，但公开分发的 MSIX 必须使用目标电脑信任的代码签名证书。

## 工作方式

`scripts/build-msix.cjs` 将现有 `release/webui` 打包为 x64 MSIX，并生成稳定名称的 `BiliRecord2K.appinstaller`。该 App Installer 使用 2021 架构，配置为：

- 每次启动检查更新；
- 不显示更新提示、不阻塞启动；
- Windows 在后台每 8 小时检查一次。

因此 MSIX 用户不使用应用内下载器。Windows App Installer 在适当时机下载和安装新包，不会由应用强制中断正在进行的录制或烧录任务。

## 首次配置

在 GitHub 仓库配置以下 Variables：

```text
MSIX_FEED_BASE_URL=https://updates.example.com/bili-record-2k
MSIX_PUBLISHER=CN=与你的代码签名证书 Subject 完全一致
MSIX_PUBLISHER_DISPLAY_NAME=BiliRecord2K
```

并配置以下 Secrets：

```text
MSIX_SIGNING_CERT_PFX_B64=<base64 编码的 PFX 文件>
MSIX_SIGNING_CERT_PASSWORD=<PFX 密码，可为空>
```

`MSIX_PUBLISHER` 必须和签名证书的 Subject 匹配；不要在已发布后随意更换 Publisher，否则 Windows 会把它视为另一个应用。时间戳服务器可通过 `MSIX_TIMESTAMP_URL` 覆盖，默认使用 DigiCert RFC 3161 时间戳服务。

更新源必须是 HTTPS 静态站点，并正确返回 `Content-Length` 与下列 MIME 类型：

```text
.msix          application/msix
.appinstaller  application/appinstaller
```

GitHub Release 可以保存归档附件，但不应作为唯一的 App Installer 更新源；应使用能明确配置 MIME 类型的对象存储、CDN 或 Web 服务器。

## 发布顺序

1. 推送版本 tag，GitHub Actions 构建并签名 `bili-record-2k-版本-x64.msix` 与 `BiliRecord2K.appinstaller`。
2. 先把新的 `.msix` 上传到 `MSIX_FEED_BASE_URL`。
3. 确认新包 URL 可下载且签名有效后，再覆盖稳定地址 `BiliRecord2K.appinstaller`。
4. 新用户从该稳定 `.appinstaller` 安装；已有用户会由 Windows App Installer 自动发现后续版本。

包和 App Installer 均会保留在 GitHub Release 里方便审计；实际更新源部署由你的静态托管发布步骤负责。CI 同时上传 `msix-feed` 构件，可直接交给该发布步骤同步。

## 本地构建

生产构建：

```powershell
$env:MSIX_FEED_BASE_URL = 'https://updates.example.com/bili-record-2k'
$env:MSIX_PUBLISHER = 'CN=你的证书 Subject'
$env:MSIX_SIGNING_CERT_PATH = 'C:\secure\bili-record-2k.pfx'
$env:MSIX_SIGNING_CERT_PASSWORD = '你的 PFX 密码'
npm run build:msix
```

只验证包结构、不产生可分发安装包：

```powershell
npm run build
node scripts\build-msix.cjs --skip-webui-build --allow-unsigned --skip-appinstaller --output-dir build\msix-smoke
```

预发布版本的 `package.json` 使用 SemVer 预发布标记时，额外设置单调递增的四段版本号，例如：

```powershell
$env:MSIX_VERSION_QUAD = '0.4.8.17'
```

MSIX 版本只接受四段 0–65535 的整数。稳定版 `0.4.8` 自动映射为 `0.4.8.0`。
