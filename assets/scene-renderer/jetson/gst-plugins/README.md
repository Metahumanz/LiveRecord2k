# Jetson private GPU plugins

The ARM64 Linux package installs the sibling shared libraries into
`/usr/lib/bili-record-2k/gst-plugins`. They are private to BiliRecord2K and
are discovered only when its GPU Scene backend supplies that directory through
`GST_PLUGIN_PATH_1_0`.

`libgstbr2kcudaoverlay.so` is the direct `NVMM -> EGLImage -> CUDA -> NVMM`
primitive compositor. It intentionally does not depend on the unavailable
`cudacompositor` element in JetPack's GStreamer 1.24 runtime.
`libbr2k-scene-cuda-process.so` is the production `nvivafilter` customer
library. It accepts the NVMM allocator emitted by `nvvidconv` through NVIDIA's
official CUDA callback ABI, then draws the pre-rendered Scene texture timeline
without mapping video frames to CPU memory.

## 依赖边界

这些 `.so` 是 BiliRecord2K 私有组件。它们不会替代 JetPack 提供的：

- `libcuda`
- `nvivafilter`
- `nvvidconv`
- `nvv4l2decoder`
- `nvv4l2h264enc`
- `nvv4l2h265enc`

`GST_PLUGIN_PATH_1_0` 只用于暴露 BiliRecord2K 私有插件目录，不会修改系统 JetPack 插件目录。
