/*
 * BiliRecord2K CUDA customer library for Jetson's nvivafilter.
 *
 * nvivafilter owns the NVMM buffer plumbing (including the nvfilter allocator
 * produced by nvvidconv).  This library only receives its EGLImage and draws
 * cached Scene Graph RGBA textures in place.  It is deliberately separate
 * from the br2kcudaoverlay GStreamer element: the latter is useful for direct
 * V4L2 decoder tests, while this is the production CPU-I420 -> NVMM bridge.
 *
 * Environment supplied by the isolated renderer process:
 *   BR2K_CUDA_SCENE_TIMELINE  piecewise-linear TSV emitted by the helper
 *   BR2K_CUDA_SCENE_FPS       raw-I420 frame rate used as Scene time base
 */

#include <cuda.h>
#include <cudaEGL.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" {
typedef enum { COLOR_FORMAT_Y8 = 0, COLOR_FORMAT_U8_V8, COLOR_FORMAT_RGBA, COLOR_FORMAT_NONE } ColorFormat;
typedef struct {
  void (*fGPUProcess)(EGLImageKHR image, void **userPtr);
  void (*fPreProcess)(void **, unsigned int *, unsigned int *, unsigned int *, unsigned int *, ColorFormat *, unsigned int, void **);
  void (*fPostProcess)(void **, unsigned int *, unsigned int *, unsigned int *, unsigned int *, ColorFormat *, unsigned int, void **);
} CustomerFunction;
}

struct Texture {
  std::string path;
  unsigned width = 0, height = 0;
  uchar4 *device = nullptr;
};

struct TimelineEntry {
  double start, end;
  double x0, y0, width0, height0, alpha0;
  double x1, y1, width1, height1, alpha1;
  double clip_x, clip_y, clip_width, clip_height;
  Texture *texture;
};

struct SceneState {
  std::vector<TimelineEntry> entries;
  std::unordered_map<std::string, Texture> textures;
  double fps = 30.0;
  unsigned long long frame = 0;
  bool ready = false;
  std::mutex lock;

  ~SceneState() {
    for (auto &pair : textures) if (pair.second.device) cudaFree(pair.second.device);
  }
};

static SceneState g_scene;

__global__ static void blend_rgba_nv12_array(
    cudaSurfaceObject_t y_surface, cudaSurfaceObject_t uv_surface,
    const uchar4 *texture, int texture_width, int texture_height,
    int frame_width, int frame_height, int left, int top, int draw_width,
    int draw_height, float opacity, int clip_x, int clip_y, int clip_width, int clip_height) {
  const int px = blockIdx.x * blockDim.x + threadIdx.x;
  const int py = blockIdx.y * blockDim.y + threadIdx.y;
  if (px >= draw_width || py >= draw_height) return;
  const int x = left + px, y = top + py;
  if (x < 0 || y < 0 || x >= frame_width || y >= frame_height) return;
  if (clip_width > 0 && clip_height > 0 &&
      (x < clip_x || y < clip_y || x >= clip_x + clip_width || y >= clip_y + clip_height)) return;
  const int source_x = min(texture_width - 1, max(0, px * texture_width / max(1, draw_width)));
  const int source_y = min(texture_height - 1, max(0, py * texture_height / max(1, draw_height)));
  const uchar4 source = texture[source_y * texture_width + source_x];
  const float alpha = (source.w / 255.0f) * opacity;
  if (alpha <= 0.0001f) return;
  const float luma = 16.0f + 0.257f * source.x + 0.504f * source.y + 0.098f * source.z;
  const unsigned char prior_y = surf2Dread<unsigned char>(y_surface, x, y);
  surf2Dwrite<unsigned char>((unsigned char)(prior_y * (1.0f - alpha) + luma * alpha), y_surface, x, y);
  // NV12 stores one U/V pair for a 2x2 luma cell.  Sampling only this
  // thread's top-left texel gives coloured glyph edges and rounded corners
  // the wrong chroma.  Own every partially covered global 2x2 cell once,
  // then blend U/V from all covered texels by their actual alpha.
  const int uv_x = x & ~1, uv_y = y & ~1;
  const bool owns_uv_x = x == uv_x || px == 0;
  const bool owns_uv_y = y == uv_y || py == 0;
  if (owns_uv_x && owns_uv_y) {
    float alpha_sum = 0.0f, u_sum = 0.0f, v_sum = 0.0f;
    for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) {
      const int sample_x = uv_x + dx, sample_y = uv_y + dy;
      const int texture_x = sample_x - left, texture_y = sample_y - top;
      if (texture_x < 0 || texture_y < 0 || texture_x >= draw_width || texture_y >= draw_height ||
          sample_x < 0 || sample_y < 0 || sample_x >= frame_width || sample_y >= frame_height ||
          (clip_width > 0 && clip_height > 0 &&
           (sample_x < clip_x || sample_y < clip_y || sample_x >= clip_x + clip_width || sample_y >= clip_y + clip_height))) continue;
      const int tex_x = min(texture_width - 1, max(0, texture_x * texture_width / max(1, draw_width)));
      const int tex_y = min(texture_height - 1, max(0, texture_y * texture_height / max(1, draw_height)));
      const uchar4 texel = texture[tex_y * texture_width + tex_x];
      const float texel_alpha = (texel.w / 255.0f) * opacity;
      alpha_sum += texel_alpha;
      u_sum += (128.0f - 0.148f * texel.x - 0.291f * texel.y + 0.439f * texel.z) * texel_alpha;
      v_sum += (128.0f + 0.439f * texel.x - 0.368f * texel.y - 0.071f * texel.z) * texel_alpha;
    }
    if (alpha_sum > 0.0001f) {
      const float cell_alpha = min(1.0f, alpha_sum * 0.25f);
      const uchar2 prior_uv = surf2Dread<uchar2>(uv_surface, uv_x, uv_y / 2);
      surf2Dwrite<uchar2>(make_uchar2((unsigned char)(prior_uv.x * (1.0f - cell_alpha) + u_sum * 0.25f),
                                      (unsigned char)(prior_uv.y * (1.0f - cell_alpha) + v_sum * 0.25f)), uv_surface, uv_x, uv_y / 2);
    }
  }
}

__global__ static void blend_rgba_nv12_pitch(
    unsigned char *y_plane, unsigned char *uv_plane, int y_pitch, int uv_pitch,
    const uchar4 *texture, int texture_width, int texture_height,
    int frame_width, int frame_height, int left, int top, int draw_width,
    int draw_height, float opacity, int clip_x, int clip_y, int clip_width, int clip_height) {
  const int px = blockIdx.x * blockDim.x + threadIdx.x;
  const int py = blockIdx.y * blockDim.y + threadIdx.y;
  if (px >= draw_width || py >= draw_height) return;
  const int x = left + px, y = top + py;
  if (x < 0 || y < 0 || x >= frame_width || y >= frame_height) return;
  if (clip_width > 0 && clip_height > 0 &&
      (x < clip_x || y < clip_y || x >= clip_x + clip_width || y >= clip_y + clip_height)) return;
  const int source_x = min(texture_width - 1, max(0, px * texture_width / max(1, draw_width)));
  const int source_y = min(texture_height - 1, max(0, py * texture_height / max(1, draw_height)));
  const uchar4 source = texture[source_y * texture_width + source_x];
  const float alpha = (source.w / 255.0f) * opacity;
  if (alpha <= 0.0001f) return;
  const float luma = 16.0f + 0.257f * source.x + 0.504f * source.y + 0.098f * source.z;
  unsigned char *y_ptr = y_plane + y * y_pitch + x;
  *y_ptr = (unsigned char)(*y_ptr * (1.0f - alpha) + luma * alpha);
  const int uv_x = x & ~1, uv_y = y & ~1;
  const bool owns_uv_x = x == uv_x || px == 0;
  const bool owns_uv_y = y == uv_y || py == 0;
  if (owns_uv_x && owns_uv_y) {
    float alpha_sum = 0.0f, u_sum = 0.0f, v_sum = 0.0f;
    for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) {
      const int sample_x = uv_x + dx, sample_y = uv_y + dy;
      const int texture_x = sample_x - left, texture_y = sample_y - top;
      if (texture_x < 0 || texture_y < 0 || texture_x >= draw_width || texture_y >= draw_height ||
          sample_x < 0 || sample_y < 0 || sample_x >= frame_width || sample_y >= frame_height ||
          (clip_width > 0 && clip_height > 0 &&
           (sample_x < clip_x || sample_y < clip_y || sample_x >= clip_x + clip_width || sample_y >= clip_y + clip_height))) continue;
      const int tex_x = min(texture_width - 1, max(0, texture_x * texture_width / max(1, draw_width)));
      const int tex_y = min(texture_height - 1, max(0, texture_y * texture_height / max(1, draw_height)));
      const uchar4 texel = texture[tex_y * texture_width + tex_x];
      const float texel_alpha = (texel.w / 255.0f) * opacity;
      alpha_sum += texel_alpha;
      u_sum += (128.0f - 0.148f * texel.x - 0.291f * texel.y + 0.439f * texel.z) * texel_alpha;
      v_sum += (128.0f + 0.439f * texel.x - 0.368f * texel.y - 0.071f * texel.z) * texel_alpha;
    }
    if (alpha_sum > 0.0001f) {
      const float cell_alpha = min(1.0f, alpha_sum * 0.25f);
      uchar2 *uv_ptr = (uchar2 *)(uv_plane + (uv_y / 2) * uv_pitch + uv_x);
      *uv_ptr = make_uchar2((unsigned char)(uv_ptr->x * (1.0f - cell_alpha) + u_sum * 0.25f),
                            (unsigned char)(uv_ptr->y * (1.0f - cell_alpha) + v_sum * 0.25f));
    }
  }
}

static bool parse_row(const std::string &line, std::vector<std::string> *fields) {
  fields->clear();
  size_t begin = 0;
  while (true) {
    const size_t end = line.find('\t', begin);
    fields->push_back(line.substr(begin, end == std::string::npos ? end : end - begin));
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  return fields->size() == 19;
}

static double as_number(const std::string &text) { return std::strtod(text.c_str(), nullptr); }

static unsigned as_unsigned(const std::string &text) { return (unsigned)std::strtoul(text.c_str(), nullptr, 10); }

static bool load_scene() {
  const char *timeline_path = std::getenv("BR2K_CUDA_SCENE_TIMELINE");
  const char *fps_value = std::getenv("BR2K_CUDA_SCENE_FPS");
  if (fps_value && *fps_value) g_scene.fps = std::max(1.0, std::strtod(fps_value, nullptr));
  if (!timeline_path || !*timeline_path) {
    std::fprintf(stderr, "br2k CUDA Scene: BR2K_CUDA_SCENE_TIMELINE is not set\n");
    return false;
  }
  std::ifstream file(timeline_path);
  if (!file) {
    std::fprintf(stderr, "br2k CUDA Scene: cannot open timeline %s\n", timeline_path);
    return false;
  }
  std::string line;
  std::vector<std::string> field;
  unsigned line_number = 0;
  while (std::getline(file, line)) {
    ++line_number;
    if (line.empty()) continue;
    if (!parse_row(line, &field)) {
      std::fprintf(stderr, "br2k CUDA Scene: invalid timeline row %u\n", line_number);
      return false;
    }
    const unsigned width = as_unsigned(field[13]), height = as_unsigned(field[14]);
    if (!width || !height) return false;
    auto existing = g_scene.textures.find(field[12]);
    if (existing == g_scene.textures.end()) {
      std::ifstream raw(field[12], std::ios::binary | std::ios::ate);
      const size_t expected = (size_t)width * height * 4;
      if (!raw || (size_t)raw.tellg() != expected) {
        std::fprintf(stderr, "br2k CUDA Scene: invalid RGBA texture at row %u\n", line_number);
        return false;
      }
      std::vector<unsigned char> bytes(expected);
      raw.seekg(0); raw.read((char *)bytes.data(), (std::streamsize)bytes.size());
      Texture texture; texture.path = field[12]; texture.width = width; texture.height = height;
      if (cudaMalloc((void **)&texture.device, expected) != cudaSuccess ||
          cudaMemcpy(texture.device, bytes.data(), expected, cudaMemcpyHostToDevice) != cudaSuccess) {
        if (texture.device) cudaFree(texture.device);
        std::fprintf(stderr, "br2k CUDA Scene: texture upload failed at row %u\n", line_number);
        return false;
      }
      existing = g_scene.textures.emplace(texture.path, texture).first;
    }
    TimelineEntry entry = {as_number(field[0]), as_number(field[1]), as_number(field[2]), as_number(field[3]),
      as_number(field[4]), as_number(field[5]), as_number(field[6]), as_number(field[7]), as_number(field[8]),
      as_number(field[9]), as_number(field[10]), as_number(field[11]), as_number(field[15]), as_number(field[16]),
      as_number(field[17]), as_number(field[18]), &existing->second};
    if (entry.end > entry.start) g_scene.entries.push_back(entry);
  }
  g_scene.ready = true;
  return true;
}

static void gpu_process(EGLImageKHR image, void **) {
  std::lock_guard<std::mutex> guard(g_scene.lock);
  if (!g_scene.ready && !load_scene()) return;
  const double seconds = (double)g_scene.frame++ / g_scene.fps;
  // nvivafilter can invoke fGPUProcess from a worker thread different from
  // init(). Make the Runtime primary context current on this callback thread
  // before using the Driver API's EGL interop entry points. Without this,
  // JetPack 6.2 returns CUDA_ERROR_INVALID_CONTEXT for every frame.
  const cudaError_t context_result = cudaFree(0);
  if (context_result != cudaSuccess) {
    std::fprintf(stderr, "br2k CUDA Scene: cannot bind CUDA context: %s\n", cudaGetErrorString(context_result));
    return;
  }
  CUgraphicsResource resource = nullptr;
  CUeglFrame egl_frame = {};
  CUresult egl_result = cuGraphicsEGLRegisterImage(&resource, image, CU_GRAPHICS_MAP_RESOURCE_FLAGS_NONE);
  if (egl_result == CUDA_SUCCESS) {
    egl_result = cuGraphicsResourceGetMappedEglFrame(&egl_frame, resource, 0, 0);
  }
  if (egl_result != CUDA_SUCCESS) {
    const char *error_name = "unknown";
    cuGetErrorName(egl_result, &error_name);
    std::fprintf(stderr, "br2k CUDA Scene: failed to import nvivafilter EGLImage: %s (%d)\n", error_name, (int)egl_result);
    if (resource) cuGraphicsUnregisterResource(resource);
    return;
  }
  if (egl_frame.planeCount < 2) {
    std::fprintf(stderr, "br2k CUDA Scene: nvivafilter returned CUDA frame with too few planes\n");
    cuGraphicsUnregisterResource(resource);
    return;
  }
  cudaSurfaceObject_t y_surface = 0, uv_surface = 0;
  cudaError_t result = cudaSuccess;
  if (egl_frame.frameType == CU_EGL_FRAME_TYPE_ARRAY) {
    cudaResourceDesc descriptor = {};
    descriptor.resType = cudaResourceTypeArray;
    descriptor.res.array.array = (cudaArray_t)egl_frame.frame.pArray[0];
    result = cudaCreateSurfaceObject(&y_surface, &descriptor);
    descriptor.res.array.array = (cudaArray_t)egl_frame.frame.pArray[1];
    if (result == cudaSuccess) result = cudaCreateSurfaceObject(&uv_surface, &descriptor);
  } else if (egl_frame.frameType != CU_EGL_FRAME_TYPE_PITCH) {
    std::fprintf(stderr, "br2k CUDA Scene: unsupported CUDA frame type=%d\n", (int)egl_frame.frameType);
    cuGraphicsUnregisterResource(resource);
    return;
  }
  if (result == cudaSuccess) {
    const dim3 block(16, 16);
    for (const TimelineEntry &entry : g_scene.entries) {
      if (seconds < entry.start || seconds > entry.end) continue;
      const double progress = std::min(1.0, std::max(0.0, (seconds - entry.start) / (entry.end - entry.start)));
      const int width = std::max(1, (int)std::lround(entry.width0 + (entry.width1 - entry.width0) * progress));
      const int height = std::max(1, (int)std::lround(entry.height0 + (entry.height1 - entry.height0) * progress));
      const int x = (int)std::lround(entry.x0 + (entry.x1 - entry.x0) * progress);
      const int y = (int)std::lround(entry.y0 + (entry.y1 - entry.y0) * progress);
      const float alpha = (float)std::min(1.0, std::max(0.0, entry.alpha0 + (entry.alpha1 - entry.alpha0) * progress));
      const int clip_x = (int)std::lround(entry.clip_x);
      const int clip_y = (int)std::lround(entry.clip_y);
      const int clip_width = (int)std::lround(entry.clip_width);
      const int clip_height = (int)std::lround(entry.clip_height);
      const dim3 grid((width + block.x - 1) / block.x, (height + block.y - 1) / block.y);
      if (egl_frame.frameType == CU_EGL_FRAME_TYPE_ARRAY) {
        blend_rgba_nv12_array<<<grid, block>>>(y_surface, uv_surface, entry.texture->device,
            entry.texture->width, entry.texture->height, (int)egl_frame.width, (int)egl_frame.height,
            x, y, width, height, alpha, clip_x, clip_y, clip_width, clip_height);
      } else {
        blend_rgba_nv12_pitch<<<grid, block>>>((unsigned char *)egl_frame.frame.pPitch[0],
            (unsigned char *)egl_frame.frame.pPitch[1], (int)egl_frame.pitch, (int)egl_frame.pitch,
            entry.texture->device, entry.texture->width, entry.texture->height,
            (int)egl_frame.width, (int)egl_frame.height, x, y, width, height, alpha, clip_x, clip_y, clip_width, clip_height);
      }
    }
    result = cudaGetLastError();
    if (result == cudaSuccess) result = cudaStreamSynchronize(0);
  }
  if (y_surface) cudaDestroySurfaceObject(y_surface);
  if (uv_surface) cudaDestroySurfaceObject(uv_surface);
  cuGraphicsUnregisterResource(resource);
  if (result != cudaSuccess) std::fprintf(stderr, "br2k CUDA Scene: kernel failed: %s\n", cudaGetErrorString(result));
}

extern "C" void init(CustomerFunction *functions) {
  cudaFree(0);
  g_scene.frame = 0;
  functions->fGPUProcess = gpu_process;
  functions->fPreProcess = nullptr;
  functions->fPostProcess = nullptr;
}

extern "C" void deinit(void) {}
