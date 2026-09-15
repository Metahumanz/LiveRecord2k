/*
 * BiliRecord2K private GStreamer element for Jetson.
 *
 * It receives NVMM from nvv4l2decoder/nvvidconv, imports the dmabuf as an
 * EGLImage, updates the NV12 surface with CUDA in place, then returns that
 * same NVMM buffer to nvv4l2{h264,h265}enc. There is no CPU frame mapping.
 *
 * This is the small, independently testable primitive compositor used by the
 * Scene Graph CUDA backend.  Scene textures and animation scheduling are
 * layered above it; keeping the surface bridge here makes the zero-copy
 * contract observable with gst-launch.
 */

#include <gst/gst.h>
#include <gst/base/gstbasetransform.h>
#include <gst/video/video.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <cuda.h>
#include <cudaEGL.h>
#include <cuda_runtime.h>
#include <nvbufsurface.h>

typedef struct _Br2kCudaTexture {
  gchar *path;
  guint width, height;
  uchar4 *device;
} Br2kCudaTexture;

typedef struct _Br2kTimelineEntry {
  gdouble start, end;
  gdouble x0, y0, width0, height0, alpha0;
  gdouble x1, y1, width1, height1, alpha1;
  Br2kCudaTexture *texture;
} Br2kTimelineEntry;

typedef struct _GstBr2kCudaOverlay {
  GstBaseTransform parent;
  GstVideoInfo info;
  guint x, y, width, height;
  guint luma, chroma_u, chroma_v;
  gboolean enabled;
  gchar *timeline_file;
  GPtrArray *timeline;
  GHashTable *textures;
  gboolean timeline_loaded;
} GstBr2kCudaOverlay;

typedef struct _GstBr2kCudaOverlayClass {
  GstBaseTransformClass parent_class;
} GstBr2kCudaOverlayClass;

/*
 * JetPack's nvv4l2 elements expose NVMM as GstV4l2Memory rather than the
 * generic GstDmaBufMemory wrapper. The upstream 1.24 ABI stores dmafd after
 * GstMemory, plane, group and data. We never retain this view; it is used only
 * to obtain the FD while the input GstBuffer is held by transform_ip.
 */
typedef struct _Br2kV4l2MemoryView {
  GstMemory memory;
  gint plane;
  gpointer group;
  gpointer data;
  gint dmafd;
} Br2kV4l2MemoryView;

#define GST_TYPE_BR2K_CUDA_OVERLAY (gst_br2k_cuda_overlay_get_type())
#define GST_BR2K_CUDA_OVERLAY(obj) (G_TYPE_CHECK_INSTANCE_CAST((obj), GST_TYPE_BR2K_CUDA_OVERLAY, GstBr2kCudaOverlay))

G_DEFINE_TYPE(GstBr2kCudaOverlay, gst_br2k_cuda_overlay, GST_TYPE_BASE_TRANSFORM)

enum {
  PROP_0,
  PROP_X,
  PROP_Y,
  PROP_WIDTH,
  PROP_HEIGHT,
  PROP_LUMA,
  PROP_CHROMA_U,
  PROP_CHROMA_V,
  PROP_ENABLED,
  PROP_TIMELINE_FILE,
};

__global__ static void paint_nv12_rect(
    unsigned char *y_plane, unsigned char *uv_plane, int y_pitch, int uv_pitch,
    int frame_width, int frame_height, int left, int top, int rect_width,
    int rect_height, unsigned char luma, unsigned char chroma_u,
    unsigned char chroma_v) {
  const int px = blockIdx.x * blockDim.x + threadIdx.x;
  const int py = blockIdx.y * blockDim.y + threadIdx.y;
  if (px >= rect_width || py >= rect_height) return;
  const int x = left + px;
  const int y = top + py;
  if (x < 0 || y < 0 || x >= frame_width || y >= frame_height) return;
  y_plane[y * y_pitch + x] = luma;
  if ((x & 1) == 0 && (y & 1) == 0) {
    unsigned char *uv = uv_plane + (y / 2) * uv_pitch + x;
    uv[0] = chroma_u;
    uv[1] = chroma_v;
  }
}

__global__ static void paint_nv12_array_rect(
    cudaSurfaceObject_t y_surface, cudaSurfaceObject_t uv_surface,
    int frame_width, int frame_height, int left, int top, int rect_width,
    int rect_height, unsigned char luma, unsigned char chroma_u,
    unsigned char chroma_v) {
  const int px = blockIdx.x * blockDim.x + threadIdx.x;
  const int py = blockIdx.y * blockDim.y + threadIdx.y;
  if (px >= rect_width || py >= rect_height) return;
  const int x = left + px;
  const int y = top + py;
  if (x < 0 || y < 0 || x >= frame_width || y >= frame_height) return;
  surf2Dwrite<unsigned char>(luma, y_surface, x, y);
  if ((x & 1) == 0 && (y & 1) == 0) {
    surf2Dwrite<uchar2>(make_uchar2(chroma_u, chroma_v), uv_surface, x, y / 2);
  }
}

__global__ static void blend_rgba_nv12_array(
    cudaSurfaceObject_t y_surface, cudaSurfaceObject_t uv_surface,
    const uchar4 *texture, int texture_width, int texture_height,
    int frame_width, int frame_height, int left, int top, int draw_width,
    int draw_height, float opacity) {
  const int px = blockIdx.x * blockDim.x + threadIdx.x;
  const int py = blockIdx.y * blockDim.y + threadIdx.y;
  if (px >= draw_width || py >= draw_height) return;
  const int x = left + px, y = top + py;
  if (x < 0 || y < 0 || x >= frame_width || y >= frame_height) return;
  const int source_x = min(texture_width - 1, max(0, px * texture_width / max(1, draw_width)));
  const int source_y = min(texture_height - 1, max(0, py * texture_height / max(1, draw_height)));
  const uchar4 source = texture[source_y * texture_width + source_x];
  const float alpha = (source.w / 255.0f) * opacity;
  if (alpha <= 0.0001f) return;
  const float luma = 16.0f + 0.257f * source.x + 0.504f * source.y + 0.098f * source.z;
  const unsigned char prior_y = surf2Dread<unsigned char>(y_surface, x, y);
  surf2Dwrite<unsigned char>((unsigned char)(prior_y * (1.0f - alpha) + luma * alpha), y_surface, x, y);
  if ((x & 1) == 0 && (y & 1) == 0) {
    const float u = 128.0f - 0.148f * source.x - 0.291f * source.y + 0.439f * source.z;
    const float v = 128.0f + 0.439f * source.x - 0.368f * source.y - 0.071f * source.z;
    const uchar2 prior_uv = surf2Dread<uchar2>(uv_surface, x, y / 2);
    surf2Dwrite<uchar2>(make_uchar2((unsigned char)(prior_uv.x * (1.0f - alpha) + u * alpha),
                                    (unsigned char)(prior_uv.y * (1.0f - alpha) + v * alpha)), uv_surface, x, y / 2);
  }
}

static void br2k_cuda_texture_free(gpointer value) {
  Br2kCudaTexture *texture = (Br2kCudaTexture *)value;
  if (!texture) return;
  if (texture->device) cudaFree(texture->device);
  g_free(texture->path);
  g_free(texture);
}

static void br2k_timeline_entry_free(gpointer value) { g_free(value); }

static void br2k_clear_timeline(GstBr2kCudaOverlay *self) {
  if (self->timeline) g_ptr_array_set_size(self->timeline, 0);
  if (self->textures) g_hash_table_remove_all(self->textures);
  self->timeline_loaded = FALSE;
}

static gboolean br2k_load_timeline(GstBr2kCudaOverlay *self) {
  if (self->timeline_loaded || !self->timeline_file || !*self->timeline_file) return TRUE;
  gchar *contents = NULL;
  gsize length = 0;
  GError *error = NULL;
  if (!g_file_get_contents(self->timeline_file, &contents, &length, &error)) {
    GST_ERROR_OBJECT(self, "unable to read Scene timeline: %s", error ? error->message : "unknown error");
    if (error) g_error_free(error);
    return FALSE;
  }
  gchar **lines = g_strsplit(contents, "\n", -1);
  for (guint line_index = 0; lines[line_index]; line_index++) {
    if (!*lines[line_index]) continue;
    gchar **field = g_strsplit(lines[line_index], "\t", 15);
    if (g_strv_length(field) != 15) {
      GST_ERROR_OBJECT(self, "invalid Scene timeline row %u", line_index + 1);
      g_strfreev(field); g_strfreev(lines); g_free(contents); br2k_clear_timeline(self); return FALSE;
    }
    const guint texture_width = (guint)g_ascii_strtoull(field[13], NULL, 10);
    const guint texture_height = (guint)g_ascii_strtoull(field[14], NULL, 10);
    Br2kCudaTexture *texture = (Br2kCudaTexture *)g_hash_table_lookup(self->textures, field[12]);
    if (!texture) {
      gchar *raw = NULL; gsize raw_length = 0;
      if (!texture_width || !texture_height || !g_file_get_contents(field[12], &raw, &raw_length, NULL) ||
          raw_length != (gsize)texture_width * texture_height * 4) {
        GST_ERROR_OBJECT(self, "invalid Scene RGBA texture at row %u", line_index + 1);
        g_free(raw); g_strfreev(field); g_strfreev(lines); g_free(contents); br2k_clear_timeline(self); return FALSE;
      }
      texture = g_new0(Br2kCudaTexture, 1);
      texture->path = g_strdup(field[12]); texture->width = texture_width; texture->height = texture_height;
      if (cudaMalloc((void **)&texture->device, raw_length) != cudaSuccess ||
          cudaMemcpy(texture->device, raw, raw_length, cudaMemcpyHostToDevice) != cudaSuccess) {
        GST_ERROR_OBJECT(self, "CUDA upload of Scene texture failed at row %u", line_index + 1);
        g_free(raw); br2k_cuda_texture_free(texture); g_strfreev(field); g_strfreev(lines); g_free(contents); br2k_clear_timeline(self); return FALSE;
      }
      g_free(raw);
      g_hash_table_insert(self->textures, g_strdup(texture->path), texture);
    }
    Br2kTimelineEntry *entry = g_new0(Br2kTimelineEntry, 1);
    entry->start = g_ascii_strtod(field[0], NULL); entry->end = g_ascii_strtod(field[1], NULL);
    entry->x0 = g_ascii_strtod(field[2], NULL); entry->y0 = g_ascii_strtod(field[3], NULL);
    entry->width0 = g_ascii_strtod(field[4], NULL); entry->height0 = g_ascii_strtod(field[5], NULL); entry->alpha0 = g_ascii_strtod(field[6], NULL);
    entry->x1 = g_ascii_strtod(field[7], NULL); entry->y1 = g_ascii_strtod(field[8], NULL);
    entry->width1 = g_ascii_strtod(field[9], NULL); entry->height1 = g_ascii_strtod(field[10], NULL); entry->alpha1 = g_ascii_strtod(field[11], NULL);
    entry->texture = texture;
    if (entry->end > entry->start) g_ptr_array_add(self->timeline, entry); else g_free(entry);
    g_strfreev(field);
  }
  g_strfreev(lines); g_free(contents);
  self->timeline_loaded = TRUE;
  return TRUE;
}

static gboolean gst_br2k_cuda_overlay_set_caps(
    GstBaseTransform *base, GstCaps *in_caps, GstCaps *out_caps) {
  GstBr2kCudaOverlay *self = GST_BR2K_CUDA_OVERLAY(base);
  (void)out_caps;
  if (!gst_video_info_from_caps(&self->info, in_caps)) return FALSE;
  return GST_VIDEO_INFO_FORMAT(&self->info) == GST_VIDEO_FORMAT_NV12;
}

static GstFlowReturn gst_br2k_cuda_overlay_transform_ip(
    GstBaseTransform *base, GstBuffer *buffer) {
  GstBr2kCudaOverlay *self = GST_BR2K_CUDA_OVERLAY(base);
  if (!self->enabled || self->width == 0 || self->height == 0) return GST_FLOW_OK;
  if (gst_buffer_n_memory(buffer) < 1) {
    GST_ERROR_OBJECT(self, "expected an NVMM buffer");
    return GST_FLOW_NOT_NEGOTIATED;
  }
  GstMemory *memory = gst_buffer_peek_memory(buffer, 0);
  if (!memory->allocator || g_strcmp0(memory->allocator->mem_type, "V4l2Memory") != 0) {
    GST_ERROR_OBJECT(self, "NVMM buffer is not Jetson V4l2Memory (allocator=%s)",
        memory->allocator ? memory->allocator->mem_type : "unknown");
    return GST_FLOW_NOT_NEGOTIATED;
  }
  const int fd = ((Br2kV4l2MemoryView *)memory)->dmafd;
  NvBufSurface *surface = NULL;
  if (fd < 0 || NvBufSurfaceFromFd(fd, (void **)&surface) != 0 || !surface) {
    GST_ERROR_OBJECT(self, "unable to obtain NvBufSurface from NVMM dmabuf");
    return GST_FLOW_ERROR;
  }
  if (surface->surfaceList[0].mappedAddr.eglImage == NULL &&
      NvBufSurfaceMapEglImage(surface, 0) != 0) {
    GST_ERROR_OBJECT(self, "NvBufSurfaceMapEglImage failed");
    return GST_FLOW_ERROR;
  }
  // Establish the primary CUDA context before registering Jetson's EGL image.
  if (cudaFree(0) != cudaSuccess) {
    GST_ERROR_OBJECT(self, "failed to initialize CUDA primary context");
    NvBufSurfaceUnMapEglImage(surface, 0);
    return GST_FLOW_ERROR;
  }
  if (!br2k_load_timeline(self)) {
    NvBufSurfaceUnMapEglImage(surface, 0);
    return GST_FLOW_ERROR;
  }
  CUgraphicsResource resource = NULL;
  CUeglFrame egl_frame;
  CUresult driver_result = cuGraphicsEGLRegisterImage(&resource,
      (EGLImageKHR)surface->surfaceList[0].mappedAddr.eglImage,
      CU_GRAPHICS_MAP_RESOURCE_FLAGS_NONE);
  if (driver_result != CUDA_SUCCESS) {
    GST_ERROR_OBJECT(self, "cuGraphicsEGLRegisterImage failed: %d", (int)driver_result);
    NvBufSurfaceUnMapEglImage(surface, 0);
    return GST_FLOW_ERROR;
  }
  driver_result = cuGraphicsResourceGetMappedEglFrame(&egl_frame, resource, 0, 0);
  if (driver_result != CUDA_SUCCESS) {
    GST_ERROR_OBJECT(self, "CUDA EGL frame mapping failed: %d", (int)driver_result);
    cuGraphicsUnregisterResource(resource);
    NvBufSurfaceUnMapEglImage(surface, 0);
    return GST_FLOW_ERROR;
  }
  const int width = (int)surface->surfaceList[0].width;
  const int height = (int)surface->surfaceList[0].height;
  const dim3 block(16, 16);
  const dim3 grid((self->width + block.x - 1) / block.x,
                  (self->height + block.y - 1) / block.y);
  cudaSurfaceObject_t y_surface = 0;
  cudaSurfaceObject_t uv_surface = 0;
  const gboolean draw_default_rect = !self->timeline_file || !*self->timeline_file;
  if (egl_frame.frameType == CU_EGL_FRAME_TYPE_PITCH && draw_default_rect) {
    paint_nv12_rect<<<grid, block>>>(
        (unsigned char *)egl_frame.frame.pPitch[0],
        (unsigned char *)egl_frame.frame.pPitch[1],
        (int)egl_frame.pitch, (int)egl_frame.pitch, width, height,
        (int)self->x, (int)self->y, (int)self->width, (int)self->height,
        (unsigned char)self->luma, (unsigned char)self->chroma_u,
        (unsigned char)self->chroma_v);
  } else if (egl_frame.frameType == CU_EGL_FRAME_TYPE_ARRAY && egl_frame.planeCount >= 2) {
    cudaResourceDesc descriptor = {};
    descriptor.resType = cudaResourceTypeArray;
    descriptor.res.array.array = (cudaArray_t)egl_frame.frame.pArray[0];
    cudaError_t surface_result = cudaCreateSurfaceObject(&y_surface, &descriptor);
    descriptor.res.array.array = (cudaArray_t)egl_frame.frame.pArray[1];
    if (surface_result == cudaSuccess)
      surface_result = cudaCreateSurfaceObject(&uv_surface, &descriptor);
    if (surface_result != cudaSuccess) {
      if (y_surface) cudaDestroySurfaceObject(y_surface);
      GST_ERROR_OBJECT(self, "could not create CUDA surfaces: %s", cudaGetErrorString(surface_result));
      cuGraphicsUnregisterResource(resource);
      NvBufSurfaceUnMapEglImage(surface, 0);
      return GST_FLOW_ERROR;
    }
    if (draw_default_rect) {
      paint_nv12_array_rect<<<grid, block>>>(y_surface, uv_surface, width, height,
          (int)self->x, (int)self->y, (int)self->width, (int)self->height,
          (unsigned char)self->luma, (unsigned char)self->chroma_u,
          (unsigned char)self->chroma_v);
    }
    const GstClockTime pts = GST_BUFFER_PTS(buffer);
    const gdouble seconds = GST_CLOCK_TIME_IS_VALID(pts) ? ((gdouble)pts / GST_SECOND) : 0;
    for (guint index = 0; index < self->timeline->len; index++) {
      Br2kTimelineEntry *entry = (Br2kTimelineEntry *)g_ptr_array_index(self->timeline, index);
      if (seconds < entry->start || seconds > entry->end) continue;
      const gdouble progress = MIN(1.0, MAX(0.0, (seconds - entry->start) / (entry->end - entry->start)));
      const int item_width = MAX(1, (int)(entry->width0 + (entry->width1 - entry->width0) * progress + 0.5));
      const int item_height = MAX(1, (int)(entry->height0 + (entry->height1 - entry->height0) * progress + 0.5));
      const int item_x = (int)(entry->x0 + (entry->x1 - entry->x0) * progress + 0.5);
      const int item_y = (int)(entry->y0 + (entry->y1 - entry->y0) * progress + 0.5);
      const float item_alpha = (float)MIN(1.0, MAX(0.0, entry->alpha0 + (entry->alpha1 - entry->alpha0) * progress));
      const dim3 item_grid((item_width + block.x - 1) / block.x, (item_height + block.y - 1) / block.y);
      blend_rgba_nv12_array<<<item_grid, block>>>(y_surface, uv_surface, entry->texture->device,
          entry->texture->width, entry->texture->height, width, height, item_x, item_y,
          item_width, item_height, item_alpha);
    }
  } else {
    GST_ERROR_OBJECT(self, "unsupported CUDA EGL frame type=%d planes=%u",
        (int)egl_frame.frameType, egl_frame.planeCount);
    cuGraphicsUnregisterResource(resource);
    NvBufSurfaceUnMapEglImage(surface, 0);
    return GST_FLOW_ERROR;
  }
  cudaError_t result = cudaGetLastError();
  if (result == cudaSuccess) result = cudaStreamSynchronize(0);
  if (y_surface) cudaDestroySurfaceObject(y_surface);
  if (uv_surface) cudaDestroySurfaceObject(uv_surface);
  cuGraphicsUnregisterResource(resource);
  NvBufSurfaceUnMapEglImage(surface, 0);
  if (result != cudaSuccess) {
    GST_ERROR_OBJECT(self, "CUDA Scene primitive failed: %s", cudaGetErrorString(result));
    return GST_FLOW_ERROR;
  }
  return GST_FLOW_OK;
}

static void gst_br2k_cuda_overlay_set_property(
    GObject *object, guint id, const GValue *value, GParamSpec *spec) {
  GstBr2kCudaOverlay *self = GST_BR2K_CUDA_OVERLAY(object);
  switch (id) {
    case PROP_X: self->x = g_value_get_uint(value); break;
    case PROP_Y: self->y = g_value_get_uint(value); break;
    case PROP_WIDTH: self->width = g_value_get_uint(value); break;
    case PROP_HEIGHT: self->height = g_value_get_uint(value); break;
    case PROP_LUMA: self->luma = g_value_get_uint(value); break;
    case PROP_CHROMA_U: self->chroma_u = g_value_get_uint(value); break;
    case PROP_CHROMA_V: self->chroma_v = g_value_get_uint(value); break;
    case PROP_ENABLED: self->enabled = g_value_get_boolean(value); break;
    case PROP_TIMELINE_FILE:
      g_free(self->timeline_file);
      self->timeline_file = g_value_dup_string(value);
      br2k_clear_timeline(self);
      break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void gst_br2k_cuda_overlay_get_property(
    GObject *object, guint id, GValue *value, GParamSpec *spec) {
  GstBr2kCudaOverlay *self = GST_BR2K_CUDA_OVERLAY(object);
  switch (id) {
    case PROP_X: g_value_set_uint(value, self->x); break;
    case PROP_Y: g_value_set_uint(value, self->y); break;
    case PROP_WIDTH: g_value_set_uint(value, self->width); break;
    case PROP_HEIGHT: g_value_set_uint(value, self->height); break;
    case PROP_LUMA: g_value_set_uint(value, self->luma); break;
    case PROP_CHROMA_U: g_value_set_uint(value, self->chroma_u); break;
    case PROP_CHROMA_V: g_value_set_uint(value, self->chroma_v); break;
    case PROP_ENABLED: g_value_set_boolean(value, self->enabled); break;
    case PROP_TIMELINE_FILE: g_value_set_string(value, self->timeline_file); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void gst_br2k_cuda_overlay_finalize(GObject *object) {
  GstBr2kCudaOverlay *self = GST_BR2K_CUDA_OVERLAY(object);
  br2k_clear_timeline(self);
  if (self->timeline) g_ptr_array_unref(self->timeline);
  if (self->textures) g_hash_table_unref(self->textures);
  g_free(self->timeline_file);
  G_OBJECT_CLASS(gst_br2k_cuda_overlay_parent_class)->finalize(object);
}

static void gst_br2k_cuda_overlay_class_init(GstBr2kCudaOverlayClass *klass) {
  GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
  GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
  GstBaseTransformClass *base_class = GST_BASE_TRANSFORM_CLASS(klass);
  gobject_class->set_property = gst_br2k_cuda_overlay_set_property;
  gobject_class->get_property = gst_br2k_cuda_overlay_get_property;
  gobject_class->finalize = gst_br2k_cuda_overlay_finalize;
#define UINT_PROP(name, nick, blurb, prop, def) \
  g_object_class_install_property(gobject_class, prop, g_param_spec_uint(name, nick, blurb, 0, G_MAXUINT, def, (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)))
  UINT_PROP("x", "X", "Rectangle X coordinate", PROP_X, 0);
  UINT_PROP("y", "Y", "Rectangle Y coordinate", PROP_Y, 0);
  UINT_PROP("width", "Width", "Rectangle width", PROP_WIDTH, 320);
  UINT_PROP("height", "Height", "Rectangle height", PROP_HEIGHT, 80);
  UINT_PROP("luma", "Luma", "NV12 Y colour component", PROP_LUMA, 235);
  UINT_PROP("chroma-u", "Chroma U", "NV12 U colour component", PROP_CHROMA_U, 128);
  UINT_PROP("chroma-v", "Chroma V", "NV12 V colour component", PROP_CHROMA_V, 128);
#undef UINT_PROP
  g_object_class_install_property(gobject_class, PROP_ENABLED,
      g_param_spec_boolean("enabled", "Enabled", "Enable CUDA drawing", TRUE,
          (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
  g_object_class_install_property(gobject_class, PROP_TIMELINE_FILE,
      g_param_spec_string("timeline-file", "Scene timeline", "TSV manifest of pre-rendered RGBA Scene textures", NULL,
          (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
  gst_element_class_set_static_metadata(element_class,
      "BiliRecord2K CUDA/NVMM Scene primitive", "Filter/Effect/Video",
      "In-place CUDA Scene primitive compositor for NVMM", "BiliRecord2K");
  GstCaps *caps = gst_caps_from_string(
      "video/x-raw(memory:NVMM), format=(string)NV12, "
      "width=(int)[ 2, MAX ], height=(int)[ 2, MAX ], "
      "framerate=(fraction)[ 0/1, MAX ]");
  gst_element_class_add_pad_template(element_class,
      gst_pad_template_new("sink", GST_PAD_SINK, GST_PAD_ALWAYS, caps));
  gst_element_class_add_pad_template(element_class,
      gst_pad_template_new("src", GST_PAD_SRC, GST_PAD_ALWAYS, caps));
  base_class->set_caps = gst_br2k_cuda_overlay_set_caps;
  base_class->transform_ip = gst_br2k_cuda_overlay_transform_ip;
}

static void gst_br2k_cuda_overlay_init(GstBr2kCudaOverlay *self) {
  self->width = 320;
  self->height = 80;
  self->luma = 235;
  self->chroma_u = 128;
  self->chroma_v = 128;
  self->enabled = TRUE;
  self->timeline = g_ptr_array_new_with_free_func(br2k_timeline_entry_free);
  self->textures = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, br2k_cuda_texture_free);
  gst_base_transform_set_in_place(GST_BASE_TRANSFORM(self), TRUE);
  gst_base_transform_set_passthrough(GST_BASE_TRANSFORM(self), FALSE);
}

static gboolean plugin_init(GstPlugin *plugin) {
  return gst_element_register(plugin, "br2kcudaoverlay", GST_RANK_NONE,
      GST_TYPE_BR2K_CUDA_OVERLAY);
}

#ifndef PACKAGE
#define PACKAGE "bili-record-2k"
#endif
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, br2kcudaoverlay,
    "BiliRecord2K CUDA/NVMM Scene primitive", plugin_init, "0.1.0", "LGPL",
    "BiliRecord2K", "https://github.com/BiliRecord/BiliRecord2K")
