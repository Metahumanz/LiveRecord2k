# 哔哩录播 2K

哔哩录播 2K 是一个在本机运行的哔哩哔哩直播录制工具。它提供 WebUI 界面，可以添加直播间、监听开播、录制源流、保存弹幕记录，并在需要时生成带弹幕的视频。

后端使用 Node.js，前端使用 Vite 和 React。普通用户不需要理解这些实现细节，只要启动应用并打开浏览器页面即可使用。

## 适合谁

- 想保存哔哩哔哩直播源流的用户。
- 想同时保留无弹幕录像和弹幕记录的用户。
- 想在录制后生成带弹幕视频或剪辑片段的用户。
- 想在 Windows 本机用浏览器界面管理录制任务的用户。

## Windows 快速开始

### 普通用户下载哪个文件

打开 GitHub Release 页面后，一般只需要看这几个附件：

- 新用户推荐下载 `bili-record-2k-setup.exe`：这是 Windows 安装器，双击安装后从开始菜单或桌面入口启动。
- 不想安装或想便携使用时，下载 `bili-record-2k-webui.zip`：解压到固定文件夹，双击里面的 `BiliRecord2K.exe` 启动。
- `update.json` 是应用内更新检测用的清单文件，不需要手动下载或打开。

浏览器窗口关闭不会停止录制。只要后台服务还在运行，监听和录制会继续工作；右下角托盘图标可用于重新打开界面或退出后台服务。

### 免安装包启动

1. 解压 `bili-record-2k-webui.zip`。
2. 打开解压后的文件夹。
3. 双击 `BiliRecord2K.exe`。
4. 浏览器会自动打开 WebUI。

### 开发环境启动

```powershell
cd C:\VScodework\LiveRecord2k
npm install
npm run dev
```

启动后会自动打开：

```text
http://127.0.0.1:3263
```

## 第一次使用

1. 进入 `录制配置`。
2. 点击 `扫码登录`，用哔哩哔哩 App 扫码并确认。
3. 在 `录像保存目录` 里选择一个空间充足的文件夹，例如：

```text
C:\Users\你的用户名\Videos\哔哩录播2K
```

4. 点击 `保存录制配置`。
5. 进入 `直播间`。
6. 输入直播间房间号，例如 `22625025`，点击 `添加`。
7. 点击房间卡片里的 `刷新`，确认标题、主播和直播状态正确。
8. 如果想等待开播提醒，点击 `监听`。
9. 如果直播间已经开播，点击 `录制`。
10. 录制结束时点击 `停止`，应用会生成录像文件和弹幕记录。

## 常用操作

### 添加直播间

打开 B 站直播间页面，从地址里复制数字房间号：

```text
https://live.bilibili.com/22625025
```

把 `22625025` 填到 `直播间` 页右上角输入框，点击 `添加`。

### 开启监听

监听开启后，应用会保持直播弹幕服务器连接，并在收到开播推送时立即准备录制；设置中的 HTTP 轮询间隔只作为推送断线或漏消息时的兜底。开播、下播、开始录制、结束录制等事件可以通过 Windows 通知或通用 Webhook 提醒。

### 开始录制

直播间显示 `直播中` 时，可以点击 `录制`。录制期间可以关闭浏览器窗口，后台服务会继续录制。

### 生成弹幕视频

录制结束后，房间卡片会显示 `生成字幕` 和 `生成弹幕视频`。也可以在 `剪辑导出` 页面选择历史录像，导出纯净片段或弹幕视频片段。

### 打开输出目录

在 `总览`、`剪辑导出` 或 `录制配置` 页面点击 `打开目录`，可以直接打开录像保存文件夹。

## 输出文件

一次录制通常会生成这些文件：

```text
123456_anchor_title_20260627_142000.clean.mp4
123456_anchor_title_20260627_142000.danmaku.jsonl
123456_anchor_title_20260627_142000.danmaku.ass
123456_anchor_title_20260627_142000.danmaku.mp4
```

- `.clean.mp4`：无弹幕原始录像，默认最终文件。
- `.danmaku.jsonl`：弹幕和互动事件记录。
- `.danmaku.ass`：根据弹幕记录生成的字幕文件。
- `.danmaku.mp4`：烧录弹幕后生成的视频。
- `.recording.mkv`：MP4 模式录制中的临时文件，正常停止并封装成功后会自动删除。

如果某个源流无法封装成 MP4，可以在 `录制配置` 里把最终输出容器切换为 MKV 后再试。

## 画质和登录

- 高画质源流通常需要登录。
- `清晰度优先级` 表示优先请求，不保证一定能拿到对应清晰度。
- 开播初期暂时没有目标清晰度时，会先录制当前能拿到的最佳画质，并周期性检查和切换到后续出现的 2K/4K。
- 开启 `H.265 优先` 后，应用会优先选择 H.265 源流；实际编码仍以 B 站返回结果为准。
- 规格一致的无弹幕分段会快速无损合并；如果前后分段的分辨率、帧率或编码不同，会保留全部内容并统一到本场出现过的最高分辨率后合并。
- 合并前会逐段扫描视频和音频时间轴，合并后再复查一次。发现某段音视频时长差或累计漂移时，会改用安全转码，并把每段音频补齐或裁到对应视频长度；检查结果会写入日志和录像技术详情。
- 带弹幕视频需要重新编码，因为弹幕已经画进画面。

## 通知和后台

应用会通过后台服务产生事件。Windows 桌面版可由托盘程序显示系统通知；Windows 和 Linux 都可由服务端发送通用 Webhook，浏览器关闭后仍然有效。

托盘图标支持：

- 单击：打开主界面。
- 右键：打开主界面或退出程序。
- 鼠标悬停：查看监听、录制、弹幕视频生成和端口状态。

开机自启可以在 `录制配置` 里开启。开启后会写入当前用户的 Windows Run 注册表项，并以后台方式启动。

### 通用 Webhook

在 `录制配置` 的“监听与通知”区域填写接收地址、按需填写 Bearer Token，启用并保存后，再点击 `发送 Webhook 测试`。公网接收地址必须使用 HTTPS；本机和私有 IP 地址可使用 HTTP。

服务端按事件发生顺序发送 `POST application/json`。接收端返回任意 2xx 状态码即视为成功；超时或非 2xx 会有限重试，最终失败会写入应用日志，但不会阻塞录制、合并或烧录任务。可用事件类型：

- `live.started` / `live.ended`
- `recording.started` / `recording.completed` / `recording.failed`
- `burn.started` / `burn.completed` / `burn.failed`
- `test`（只在手动测试时发送）

示例请求体：

```json
{
  "id": "1722600000000-1",
  "event": "recording.completed",
  "title": "录制结束",
  "message": "主播 / 直播标题 可烧录事件 1234 条",
  "occurredAt": "2026-08-02T12:00:00.000Z",
  "source": {
    "name": "BiliRecord2K",
    "version": "0.3.2"
  },
  "data": {
    "roomId": "123456",
    "roomTitle": "直播标题",
    "anchor": "主播",
    "fileName": "123456_anchor_title.clean.mp4",
    "eventCount": 1234
  }
}
```

配置了 Token 时，请求会带上 `Authorization: Bearer <Token>`。Token 只保存在服务端配置中，不会通过 WebUI 状态接口回传，也不会写入设置导出文件。各通知事件开关同时控制 Windows 通知和 Webhook。

## 局域网访问

默认只允许本机访问：

```text
http://127.0.0.1:3263
```

如果要从同一局域网的其它电脑打开 WebUI：

1. 进入 `软件维护` -> `运行信息`。
2. 设置至少 8 位的远程访问密码；用户名默认是 `admin`。
3. 将 `监听地址` 改为 `外部网络 0.0.0.0`。
4. 保存运行配置并重启后台服务。
5. 在其它电脑浏览器中打开：

```text
http://本机局域网IP:3263
```

例如：

```text
http://192.168.1.23:3263
```

如果其它电脑无法打开，请检查 Windows 防火墙是否允许该端口入站访问。远端会先看到独立登录页；会话使用 HttpOnly Cookie，连续登录失败会被临时限速。公网使用时仍必须在前面配置 HTTPS 反向代理，不建议直接暴露明文 HTTP 端口。

## Linux 云服务器安装

正式发布会同时提供 Debian 安装包和通用 systemd 压缩包。两种包都自带 Node.js 运行时，服务器只需要能安装 `ffmpeg` 等系统依赖。

### 一键自动安装

在支持 systemd 的 Linux 云服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh | sudo sh
```

脚本只会交互询问并确认一次 WebUI 管理密码，其余步骤自动完成：识别发行版和 CPU 架构、安装依赖、读取最新 Release、选择 Deb 或通用包、验证 SHA-256、写入鉴权配置、启用 systemd、启动服务并检查 `/api/state`。默认监听 `0.0.0.0:3263`，完成后会打印访问地址。

安装包默认通过 `https://gh-proxy.com/` 镜像下载；版本与 SHA-256 仍取自 GitHub 官方发布清单，镜像下载失败或校验不通过时会自动回退 GitHub 官方源。可以指定其他兼容的 GitHub 代理前缀，或关闭镜像直连：

```bash
# 改用其他镜像
curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh \
  | sudo env BILI_RECORD_DOWNLOAD_MIRROR=https://ghfast.top/ sh

# 关闭镜像，直接从 GitHub 下载
curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh \
  | sudo env BILI_RECORD_DOWNLOAD_MIRROR=direct sh
```

脚本不会擅自修改云厂商安全组或主机防火墙；外部无法访问时，需要自行放行对应 TCP 端口。公网长期使用仍应配置 HTTPS 反向代理。

无桌面环境的 Linux WebUI 会隐藏原生目录选择、打开文件管理器、Windows 通知和桌面进程退出等操作，并提供由服务端后台发送的通用 Webhook。路径需要填写服务器上的绝对路径，服务重启、停止和日志查看通过 `systemctl`、`journalctl` 完成。远程扫码登录成功后，页面只显示登录状态，不会把 Cookie 明文回传到浏览器。

无人值守安装可以预先传入密码：

```bash
curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh \
  | sudo env BILI_RECORD_AUTH_PASSWORD='替换成至少8位的密码' sh
```

如果只通过本机反向代理或 SSH 隧道访问：

```bash
curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh \
  | sudo env BILI_RECORD_HOST=127.0.0.1 sh
```

### Debian / Ubuntu

从 GitHub Release 下载与服务器架构一致的 `.deb`，然后运行：

```bash
sudo apt install ./bili-record-2k_版本_amd64.deb
sudo systemctl status bili-record-2k
```

### 其他使用 systemd 的 Linux

```bash
mkdir bili-record-2k-install
tar -xzf bili-record-2k_版本_linux_x64.tar.gz -C bili-record-2k-install
cd bili-record-2k-install
sudo ./install.sh
sudo systemctl status bili-record-2k
```

安装器会创建无登录权限的 `bili-record-2k` 系统用户，程序安装到 `/usr/lib/bili-record-2k`，配置保存在 `/etc/bili-record-2k`，录像和运行状态保存在 `/var/lib/bili-record-2k`。第一次安装会生成随机管理员密码：

```bash
sudo cat /etc/bili-record-2k/initial-admin-password
```

服务默认只监听 `127.0.0.1:3263`。可以通过 SSH 端口转发访问，也可以让 Caddy/Nginx 反向代理到这个地址并提供 HTTPS。运行参数位于：

```text
/etc/bili-record-2k/environment
```

修改后重启：

```bash
sudo systemctl restart bili-record-2k
sudo journalctl -u bili-record-2k -f
```

如果确实要直接监听所有网卡，把 `BILI_RECORD_HOST` 改成 `0.0.0.0`；这时仍应只通过防火墙开放 HTTPS 反向代理端口，不应把明文 WebUI 直接暴露到公网。录像目录改到挂载盘时，需要让 `bili-record-2k` 用户拥有目标目录写权限。

### systemd 与自动更新

安装包会启用以下单元：

```text
bili-record-2k.service         主录制服务
bili-record-2k-update.path     监听经过校验的更新请求
bili-record-2k-update.service  使用 root 安装更新并重启主服务
```

Linux 安装版默认每 6 小时检查一次更新。存在录制、合并、烧录或导出任务时会等待任务全部结束；空闲后下载与当前平台、架构和安装方式匹配的包，校验 SHA-256，再由独立的 systemd 更新单元复查包路径、包名、版本和摘要后安装。可以在“软件维护”页面关闭自动更新，也可以手动检查和安装。

卸载 Debian 包时使用 `sudo apt remove bili-record-2k`。通用包使用解压目录中的 `sudo ./uninstall.sh`。两种卸载方式都会保留 `/etc/bili-record-2k` 和 `/var/lib/bili-record-2k`，避免误删配置与录像。

## 常见问题

### 浏览器关了，录制会停止吗？

不会。浏览器只是控制界面，后台服务仍会继续录制。需要退出时，请右键托盘图标选择退出，或在 `软件维护` 中点击 `退出后台服务`。

### 为什么拿不到 2K 或 H.265？

清晰度和编码由 B 站接口返回结果决定。登录、高画质优先级和 H.265 优先可以提高拿到目标源流的概率，但不能保证一定成功。

### 为什么有 `.recording.mkv`？

MP4 模式下，为了降低异常中断造成损坏文件的风险，录制时会先写入临时 MKV。停止录制后再封装为最终 `.clean.mp4`。

### 录像盘取消挂载后，为什么会打开其他目录？

选择或打开路径前会先限时检测当前盘符。原目录已删除时会打开最近仍存在的上级目录；整个盘符断开时会回退到 Windows 系统盘，并显示警告。这个回退只影响本次选择或打开操作，不会自动改写已保存的录像目录；需要在录制配置中选择新目录并保存后，新录制才会改用该目录。

### 弹幕视频为什么生成比较慢？

带弹幕视频需要重新编码画面，耗时取决于视频长度、CPU/GPU 性能和选择的编码器。

### 修改端口后为什么没生效？

服务端口需要保存运行配置并重启后台服务后才会生效。默认端口是 `3263`。

## 开发与构建

开发启动：

```powershell
npm run dev
```

构建发布包：

```powershell
npm run build
```

Linux 构建必须在 Linux x64/arm64 构建机运行：

```bash
npm ci
npm run build:linux
```

构建产物：

```text
dist/
release/webui/
release/webui/BiliRecord2K.exe
release/webui/BiliRecord2K.Service.exe
release/bili-record-2k-setup.exe
release/bili-record-2k-webui.zip
release/bili-record-2k_版本_amd64.deb
release/bili-record-2k_版本_linux_x64.tar.gz
release/install-linux.sh
release/update.json
```

如果不想构建结束后自动打开资源管理器，可以设置：

```powershell
$env:BUILD_NO_OPEN=1
npm run build
```

临时指定端口：

```powershell
.\release\webui\BiliRecord2K.exe --port=3264
npm run dev -- --port=3264
```

临时允许局域网访问：

```powershell
.\release\webui\BiliRecord2K.exe --host=0.0.0.0 --port=3264
npm run dev -- --host=0.0.0.0 --port=3264
```

## 项目结构

```text
src/client/   React/Vite 前端界面
src/server/   本地 Node.js 后端、录制、弹幕、预览和更新逻辑
scripts/      构建脚本、安装器脚本和 Windows 托盘启动器脚本
assets/       应用图标等静态资源
dist/         Vite 前端构建产物
release/      可运行发布包、zip 和安装器
```
