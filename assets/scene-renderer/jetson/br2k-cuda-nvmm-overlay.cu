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

typedef struct _GstBr2kCudaOverlay {
  GstBaseTransform parent;
  GstVideoInfo info;
  guint x, y, width, height;
  guint luma, chroma_u, chroma_v;
  gboolean enabled;
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
  if (gst_buffer_n_memory(buffer) != 1) {
    GST_ERROR_OBJECT(self, "expected exactly one NVMM buffer");
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
  if (egl_frame.frameType == CU_EGL_FRAME_TYPE_PITCH) {
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
    paint_nv12_array_rect<<<grid, block>>>(y_surface, uv_surface, width, height,
        (int)self->x, (int)self->y, (int)self->width, (int)self->height,
        (unsigned char)self->luma, (unsigned char)self->chroma_u,
        (unsigned char)self->chroma_v);
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
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void gst_br2k_cuda_overlay_class_init(GstBr2kCudaOverlayClass *klass) {
  GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
  GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
  GstBaseTransformClass *base_class = GST_BASE_TRANSFORM_CLASS(klass);
  gobject_class->set_property = gst_br2k_cuda_overlay_set_property;
  gobject_class->get_property = gst_br2k_cuda_overlay_get_property;
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
