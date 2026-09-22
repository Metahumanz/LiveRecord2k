# Jetson 支持与诊断

## 支持范围

当前生产路径已在 Jetson AGX Orin 真实录像上验证；其他 Jetson 设备仍以运行时能力探测结果为准。BiliRecord2K 不把某个 Jetson 型号或 JetPack 版本的存在，等同于完整 CUDA Scene 一定可用。

## 依赖边界

ARM64 安装包和 `scripts/install-linux.sh` 只负责 BiliRecord2K 自己的程序、字体、FFmpeg 和通用 GStreamer 依赖。安装器会安装 GStreamer tools/base/good、FFmpeg、字体等通用依赖；不会主动 `apt install` `nvidia-l4t-*`、JetPack 或 NVIDIA 驱动。

Jetson 的 `nvv4l2decoder`、`nvv4l2h264enc`、`nvv4l2h265enc`、`nvvidconv`、`nvivafilter` 等 NVIDIA elements 来自设备已有的 JetPack/L4T，不是 BiliRecord2K 自己安装的。不要跨 JetPack 版本随意安装或替换 NVIDIA 包；这些组件必须来自彼此匹配的设备环境。

## 安装前提

安装前请确认设备已经有与驱动匹配的 JetPack/L4T 环境、可工作的 GStreamer 和硬件编解码 elements，并确认服务用户能访问所需的 `video`、`render` 等设备资源。安装完成后，服务用户是 `bili-record-2k`，安装目录通常为 `/usr/lib/bili-record-2k`。

可先检查平台和 NVIDIA elements：

```bash
cat /etc/nv_tegra_release

gst-inspect-1.0 nvv4l2decoder
gst-inspect-1.0 nvv4l2h264enc
gst-inspect-1.0 nvv4l2h265enc
gst-inspect-1.0 nvvidconv
gst-inspect-1.0 nvivafilter
```

这些 `gst-inspect-1.0` 结果用于确认设备已有的 JetPack/L4T 组件；它们不表示 BiliRecord2K 会替你安装 NVIDIA 运行时。

## 运行时 pipeline

Jetson 导出按能力从低到高有三层：

1. 兼容路径：`CPU decode / FFmpeg Scene → I420 → nvvidconv → nvv4l2 encoder`。
2. Jetson 硬件解码/编码：使用 `nvv4l2decoder`、`nvv4l2h264enc` 或 `nvv4l2h265enc`，中间可以经过兼容的 I420 Scene 路径。
3. 完整 CUDA Scene 生产路径：`NVDEC → NVMM → CUDA Scene → NVENC`。

当前真实生产日志对应的完整链路是：

```text
Jetson nvv4l2decoder
→ CUDA Scene（NVMM）
→ Jetson nvv4l2h265enc
```

Node 仍负责 Scene 请求、头像和纹理资源，以及最终音频 mux；Jetson helper 同时支持兼容 I420/GStreamer Scene 路径和完整 `qtdemux → nvv4l2decoder → NVMM → nvivafilter CUDA Scene → nvv4l2 encoder` 路径。

## 能力检查与生产准入

启动时能力探测后，BiliRecord2K 会运行 CUDA Scene runtime probe，再通过视觉一致性门禁，最后用当前真实录像做约 5 秒 preflight。只有这些检查都通过，正式任务才会连续使用 NVMM 链。

已安装版可以让实际服务用户运行 JSON probe：

```bash
sudo -u bili-record-2k \
  /usr/lib/bili-record-2k/bin/br2k-scene-gpu --probe=json
```

正常的完整 CUDA 环境重点看：

```json
"backend": "cuda-gstreamer",
"nativeNvmmScene": true
```

还可以让实际服务用户运行内置的双编码自检，并打开诊断输出：

```bash
sudo -u bili-record-2k env BR2K_NATIVE_NVMM_TRACE=1 \
  /usr/lib/bili-record-2k/bin/br2k-scene-gpu \
  --native-nvmm-self-test
```

该自检会分别测试内置 H.264 和 HEVC 样本。probe 通过只是准入的一部分，最终仍要以视觉门禁、真实源 preflight 和任务中实际显示的 pipeline 为准。

preflight 失败时，正式任务从 0 开始直接走兼容链。正式 NVMM 前 5 秒内失败时允许兼容链回退一次；已经运行超过 5 秒后失败时，任务会停止并保留明确错误，不会偷偷把整部长录像从 0 重新 CPU 渲染。这一策略同时适用于稀疏 Scene 的单段导出和密集 Scene 的连续/分段调度路径。

## 服务用户检查

确认服务用户、组和服务日志：

```bash
id bili-record-2k
getent group video
getent group render
sudo systemctl status bili-record-2k
sudo journalctl -u bili-record-2k -f
```

如果 root 下的 `gst-inspect-1.0` 正常而服务用户 probe 失败，优先检查服务用户的组权限、设备节点权限、运行环境变量和 JetPack/L4T 组件是否来自同一套系统，而不是重新安装随机版本的 NVIDIA 包。

## 常见失败

- `gst-inspect-1.0` 找不到 NVIDIA element：设备的 JetPack/L4T GStreamer 组件未安装、未匹配当前系统，或服务进程看不到系统插件目录。
- `nvv4l2decoder` 或编码器能列出但 probe 失败：可能是驱动、插件、设备权限或编码器实际初始化失败；以 `br2k-scene-gpu --probe=json` 和任务日志为准。
- `nativeNvmmScene` 为 `false`：完整 CUDA Scene 没有通过准入，任务会使用兼容路径或软件编码路径。
- preflight 失败：该任务会从开始就使用兼容链，不会先跑很久再从头重渲染。
- 正式 NVMM 中途失败：任务停止并报告错误，不会隐式切换成整片 CPU 重渲染。
- 出现空 MKV 或 EOF：重点检查 Matroska H.264/H.265 parser 协商、零帧硬解和实际输入媒体，不要只看 element 是否存在。

## 如何判断有没有真正使用 CUDA Scene

在 UI 任务进度和服务日志中看实际运行链，而不是只看启动时的能力探测：

```text
CUDA Scene（NVMM）
Jetson nvv4l2decoder
Jetson nvv4l2h265enc
```

同时看到这些信息，代表正在使用完整高速路径。

如果看到：

```text
BiliRecord2K ffmpeg-full Scene Graph
→ I420 pipe
→ Jetson nvv4l2h265enc
```

代表 Scene 已经回到兼容路径，但仍可能使用 Jetson 硬编。只有看到：

```text
软件编码
```

才表示连 Jetson 硬编也没有通过准入。
