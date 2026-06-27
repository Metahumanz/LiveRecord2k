# 哔哩录播 2K

本地 WebUI 版哔哩哔哩直播录制工具。后端是 Node.js，前端是 Vite/React，不再使用 Electron 或 .NET。

## 启动

```powershell
cd C:\VScodework\LiveRecord2k
npm install
npm run dev
```

启动后打开：

```text
http://127.0.0.1:5173
```

浏览器窗口关闭不会自动停止后端。只要运行 `npm run dev` 的终端还在，监听和录制就会继续。

## 构建

```powershell
npm run build
```

产物位置：

```text
dist/
release/webui/
release/bili-record-2k-webui.zip
```

`release/webui` 是生产运行包。第一次在这个目录运行前先执行：

```powershell
npm install --omit=dev
npm start
```

也可以直接双击 `start-webui.cmd`，它会提示缺少依赖时需要先安装。

## 测试流程

1. 运行 `npm run dev`，打开 `http://127.0.0.1:5173`。
2. 右侧点击 `扫码登录`，用哔哩哔哩 App 扫码确认。
3. 保持 `源流清晰度 15000`、`录像容器 MP4`、`H.265 优先`。
4. 在输出目录输入框填写本机目录，例如 `C:\Users\你的用户名\Videos\哔哩录播2K`，点击 `保存参数`。
5. 添加一个正在直播的房间号，点击 `刷新` 确认状态。
6. 点击 `录制`，等待 30-60 秒后点击 `停止`。
7. 检查输出目录中的 `.clean.mp4`、`.danmaku.jsonl`、`.danmaku.ass`、`.danmaku.mp4`。

如果某个源流无法封装为 MP4，可以把录像容器切换为 MKV 再试。默认仍然是 MP4。

## 输出文件

```text
123456_anchor_title_20260627_142000.clean.mp4
123456_anchor_title_20260627_142000.danmaku.jsonl
123456_anchor_title_20260627_142000.danmaku.ass
123456_anchor_title_20260627_142000.danmaku.mp4
```

- `.clean.mp4`：无弹幕源流文件，使用 `-c copy` 原样写入。
- `.danmaku.jsonl`：普通弹幕、醒目留言、礼物、舰长事件。
- `.danmaku.ass`：生成后的弹幕字幕层。
- `.danmaku.mp4`：烧录弹幕后的第二份视频。

## 2K / H.265

- 高画质源流通常需要登录。
- 拉流接口会请求 H.265，并优先选择 H.265 候选源。
- 无弹幕源流文件不重新编码，会保留 B 站返回的编码和分辨率。
- MP4 源流录制使用 fragmented MP4 参数，直播过程中会逐步写入。
- 有弹幕版必须重新编码视频，因为字幕已经画进画面；音频仍然直接复制。

## 通知

WebUI 使用浏览器通知。点击 `启用通知` 并允许权限后，页面打开时可以按设置开关提示开播、下播、开始录制、结束录制、开始烧录和烧录完成。
