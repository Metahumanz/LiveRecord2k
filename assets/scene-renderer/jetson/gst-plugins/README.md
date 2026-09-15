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
