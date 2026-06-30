# 哔哩录播 2K

本地 WebUI 版哔哩哔哩直播录制工具。后端是 Node.js，前端是 Vite/React。

## 项目结构

```text
src/client/   React/Vite 前端界面
src/server/   本地 Node.js 后端、录制、更新、预览代理
scripts/      构建、安装器和 Windows 托盘启动器脚本
assets/       应用图标等静态资源
dist/         Vite 前端构建产物
release/      可运行发布包、zip 和安装器
```

这里的 `server` 不是一个单独项目，也不是另一套语言，只是 Node 后端源码。开发时 `npm run dev` 会启动 `src/server/index.cjs`，后端再托管前端页面和本地 API。

## 启动

```powershell
cd C:\VScodework\LiveRecord2k
npm install
npm run dev
```

启动后会自动打开：

```text
http://127.0.0.1:3263
```

浏览器窗口关闭不会自动停止后端。只要运行 `npm run dev` 的终端还在，监听和录制就会继续。

## 构建

```powershell
npm run build
```

构建成功后，Windows 会自动打开资源管理器并选中生成的安装器；如果不想自动打开，可以设置 `BUILD_NO_OPEN=1`。

产物位置：

```text
dist/
release/webui/
release/webui/BiliRecord2K.exe
release/webui/BiliRecord2K.Service.exe
release/bili-record-2k-setup.exe
release/bili-record-2k-webui.zip
```

`release/webui` 是生产运行包，双击 `BiliRecord2K.exe` 即可启动并自动打开浏览器。这个入口是无窗口托盘程序，后台服务进程是 `BiliRecord2K.Service.exe`，正常使用时不需要手动打开它。

Windows 发布流程会额外生成 `release/bili-record-2k-setup.exe` 安装器。应用内更新会优先下载安装器并启动它，由安装器停止旧进程、覆盖安装目录并重启应用；便携 zip 仍保留给手动下载使用。本地没有安装 NSIS 时会跳过安装器构建，GitHub Actions 发布会强制安装 NSIS 并生成安装器。

托盘图标支持：

- 单击：打开主界面。
- 右键：打开主界面、退出程序。
- 鼠标悬停：查看当前监听、录制、烧录和端口状态。

设置页里可以开启开机自启。开机自启会写入当前用户的 Windows Run 注册表项，并以后台参数启动，不会自动弹浏览器。

正式版没有控制台黑框。需要退出后台服务时，可以右键托盘图标点击 `退出程序`，也可以进入 `设置` 点击 `退出后台服务`。

默认端口是 `3263`，可以在设置页修改服务端口，保存后重启生效。也可以用命令行临时指定：

```powershell
.\release\webui\BiliRecord2K.exe --port=3264
npm run dev -- --port=3264
```

## 测试流程

1. 运行 `npm run dev`，浏览器会自动打开 `http://127.0.0.1:3263`。
2. 进入 `设置`，点击 `扫码登录`，用哔哩哔哩 App 扫码确认。
3. 保持 `源流清晰度优先级 15000`、`最终输出容器 MP4`、`H.265 优先`。
4. 在输出目录输入框填写本机目录，例如 `C:\Users\你的用户名\Videos\哔哩录播2K`，点击 `保存参数`。
5. 进入 `直播间`，添加一个正在直播的房间号，点击 `刷新` 确认状态。
6. 点击 `录制`，等待 30-60 秒后点击 `停止`。
7. 检查输出目录中的 `.clean.mp4`、`.danmaku.jsonl`、`.danmaku.ass`、`.danmaku.mp4`。

如果某个源流无法封装为 MP4，可以把最终输出容器切换为 MKV 再试。默认最终输出仍然是 MP4。

## 输出文件

```text
123456_anchor_title_20260627_142000.clean.mp4
123456_anchor_title_20260627_142000.danmaku.jsonl
123456_anchor_title_20260627_142000.danmaku.ass
123456_anchor_title_20260627_142000.danmaku.mp4
```

- `.recording.mkv`：MP4 模式录制中的临时文件，停止录制后会自动封装为 `.clean.mp4`，成功后删除。
- `.clean.mp4`：无弹幕最终文件，默认由临时 MKV 使用 `-c copy` 重新封装得到。
- `.danmaku.jsonl`：可烧录事件，包括普通弹幕、醒目留言、礼物、舰长事件；其它互动包只用于诊断计数。
- `.danmaku.ass`：生成后的弹幕字幕层。
- `.danmaku.mp4`：烧录弹幕后的第二份视频。

## 2K / H.265

- 高画质源流通常需要登录。
- 清晰度选项表示优先请求，不保证一定拿到；房间卡片会显示请求清晰度、接口选中 qn 和实际写入分辨率。
- 拉流接口会请求 H.265，并优先选择 H.265 候选源。
- 无弹幕源流文件不重新编码，会保留 B 站返回的编码和分辨率。
- MP4 是最终输出容器。为了避免异常中断留下极小损坏 MP4，直播过程中先写 `.recording.mkv`，录制结束后再封装为 `.clean.mp4`。
- 有弹幕版必须重新编码视频，因为字幕已经画进画面；音频仍然直接复制。

## 通知

通知由本地后端产生事件，再交给常驻托盘程序显示 Windows 通知。只要 `BiliRecord2K.exe` 正在运行，即使 WebUI 页面没有打开，也可以按设置开关提示开播、下播、开始录制、结束录制、开始烧录和烧录完成。

设置页里可以点击 `测试 Windows 通知` 立刻发送一条系统通知。
