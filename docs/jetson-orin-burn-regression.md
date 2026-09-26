# AGX Orin 真实录像烧录回归

2026-09-26，使用用户指定的 AGX Orin Developer Kit、L4T R39.2.1，在独立目录 `/var/tmp/br2k-orin-ca15664/` 运行当前 dev 服务代码。使用机器已安装的 Node、ffmpeg-full 和 CUDA 插件，单独上传修复后的 Python helper。没有替换 `/usr/lib/bili-record-2k` 正式安装、没有调用服务 init，也没有启动录制、监控或自动烧录。

## 复现和修复

同源录像 `883263_真栗_20260925_211006.clean.mp4`，2560×1440、HEVC、8759.91 秒，9283 条原始弹幕事件。通过 `/mnt/zzzz/哔哩录播2K/` 读取。沿用现有 h5-card、quarter、H.265 Jetson 硬编、CRF 24、真实头像及用户拖动坐标。

1. 原生 NVMM 解码器对这份文件协商的帧率是 `0/1`，表示未知。helper 只检查分母，把零写入 `BR2K_CUDA_SCENE_FPS`；CUDA 库又将零夹到 1 fps。每处理一帧就跳过一秒弹幕时间，视频仍继续硬编并成功导出。真实 30 秒成片在 2/10/20 秒均无弹幕。独立诊断库测得 `fps env=0 parsed=1.000000`，5 秒源的 320 次 CUDA 回调平均仅有 0.338 个活跃对象。
2. 现在拒绝非正的协商帧率。协商值未知时，优先采用源文件 `r_frame_rate`，再采用请求帧率。不能采用含首帧空缺的容器平均帧率作为稳定 Scene 时钟：本例平均约 59.904，实际帧时钟为 `60/1`。仅防止零帧率后，5 分钟尾段文字匹配仍只有 10.7%；采用 `60/1` 后恢复到 99.91%。
3. Scene 在缩放和转为旧样式时重新套用了预设，丢失用户拖动坐标。本例 `panelLeft: 0` 被重新变成预设左边距。保留已解析的覆盖值，空区域边界不再被当成数值零。
4. ASS 的旧侧栏样式没有应用所选弹幕区域，而 Scene/CUDA 已应用。现在 ASS、真实头像队列和 Scene 使用相同区域边界。三种样式、三种区域、零坐标和缩放都有回归覆盖。
5. 带 1.019 秒前导的合成测试曾比较不同事件时钟和不同物理帧。现在对测试专用事件做前导平移，两个有限视频源采用相同整数帧前导；生产录像事件不做这项测试平移。保持原来的 RGB/像素差阈值。
6. 视觉报告契约更新为 `ass-compat-v2`，拒绝旧布局和前导时钟生成的 v1 成功报告。

## 实测结果

实际运行链路：`Jetson nvv4l2decoder → CUDA Scene/NVMM → nvv4l2h265enc → 封装源音频`。正式 5 分钟任务使用连续 NVMM 链路，没有 CPU 重跑。

| 样本 | 导出耗时 | 含外部验收耗时 | 导出有效 fps | Node RSS 采样峰值 | 整机统一 RAM 采样峰值 | 文字匹配 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 30 秒，最终可复用 CLI | 32.935 秒 | 36.458 秒 | 54.65 | 999.8 MiB | 4817 MiB | 99.90% |
| 5 分钟，修复帧率漂移后 | 157.628 秒 | 162.368 秒 | 114.19 | 1071.8 MiB | 5128 MiB | 开头 99.90%，中段 99.74%，尾段 99.91% |

导出耗时包含构图、真实源预检、纹理准备、编码和音频封装；外部抽帧/全流时间戳检查另计。5 分钟最后报告的管线速率约 189 fps。验证既用实际文字边缘与去文字控制帧对照，也人工查看抽帧，没有把播放器能打开等同于弹幕成功。

Orin 使用统一内存。`tegrastats` 的 RAM 峰值包含系统、其他进程和缓存，不是本任务独占显存，也不能与桌面 NVIDIA 独立显存直接比较。Node RSS 每 2 秒采样，可能漏掉瞬时峰值。早期某轮进程树采样失败显示零，已排除该无效指标。

输出 5 分钟视频时长约 300.004 秒，音频约 299.989 秒，全流检查没有损坏包和时间戳倒退。原 MP4 大小/修改时间以及 JSONL、Scene JSON/JSONL、头像清单的大小、修改时间和 SHA-256 均保持不变。

**验收范围：**本次已验证真实弹幕和容器内部时间戳，不包含完整 8759.91 秒长片或 5060 Ti 的硬件实测。源文件 FFmpeg 首视频 PTS 为 1.014 秒，当前 qtdemux/NVMM 输出视频起点约 0.021 秒；内部 PTS 健康不能证明保留了源音视频的绝对起点关系，口型与原片的绝对同步仍需另行对照，不应据本报告宣布该项完成。

## 回归和交付

- 本地快速 30 个测试文件、集成 9 个文件、打包 3 个文件通过。
- Orin 六组 ASS/CUDA 对照（三个样式 × 普通/前导）通过：最大平均 RGB 差 1.104，最大变化像素比例 1.95%，门限仍为 2 / 2%。
- Orin 原生 PTS、真实黑场前导和未知/有理帧率测试通过。
- 测试视频与报告：`/mnt/zzzz/哔哩录播2K/Orin修复验证_20260926/`，Windows 共享映射为 `X:\哔哩录播2K\Orin修复验证_20260926\`。
- 失败样本、原生 CUDA 诊断、配置白名单、原始采样和抽帧留在 `/var/tmp/br2k-orin-ca15664/`。
- 自动烧录在现有配置中已经为 false，本次没有更改它。正式服务尚未升级，因此运行中的旧版本尚未获得这些修复。

## 重复执行

`scripts/jetson-burn-regression.cjs` 是选择性实机工具，不调用 init，不读写账号凭据，不写源录像 sidecar。Windows 可以先用 esbuild 打包为 arm64 Node 也可执行的单个 CJS，上传到独立测试目录。目录内需要 `bin/br2k-scene-gpu`（LF 换行、可执行）、当前通过的 `cuda-scene-conformance.json` 和 `profile.json`（仅 settings 白名单与 ffmpegCapabilities）。不能使用过期门禁报告代替真实设备测试。

```sh
ROOT=/var/tmp/br2k-orin-ca15664
NODE=/usr/lib/bili-record-2k/bin/node
SOURCE='/mnt/zzzz/哔哩录播2K/883263-真栗/20260925_205728-明天在重庆和平精英吃鸡节/883263_真栗_20260925_211006.clean.mp4'
$NODE "$ROOT/jetson-burn-regression.bundle.cjs" --input "$SOURCE" --profile "$ROOT/profile.json" --output-dir "$ROOT" --duration 30
$NODE "$ROOT/jetson-burn-regression.bundle.cjs" --input "$SOURCE" --profile "$ROOT/profile.json" --output-dir "$ROOT" --duration 300
$NODE "$ROOT/jetson-burn-regression.bundle.cjs" --input "$SOURCE" --profile "$ROOT/profile.json" --output-dir "$ROOT" --duration 300 --sample-from 145 --verify-existing true
$NODE "$ROOT/jetson-burn-regression.bundle.cjs" --input "$SOURCE" --profile "$ROOT/profile.json" --output-dir "$ROOT" --duration 300 --sample-from 275 --verify-existing true
```

`--verify-existing true` 只检查已经生成的结果；该次耗时和资源采样属于验收，不是烧录吞吐量。工具使用软件 ASS 作为独立文字参考，并保留不含文字的同布局控制帧；只输出指定目录内的成片和诊断。
