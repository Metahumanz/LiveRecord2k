#!/usr/bin/python3
"""BiliRecord2K GPU Scene Graph renderer for Jetson.

The helper reads I420 frames from stdin, composes cached Scene Graph textures
with GStreamer's GL mixer, then hands I420 to nvvidconv/nvv4l2 for hardware
encoding.  It intentionally accepts a JSON request file rather than command
fragments.  The Node service stays responsible for downloading avatars and
for final audio muxing.
"""

import argparse
import ctypes
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction

# Private GPU plugins are packaged outside the system GStreamer directory so
# an application update never mutates JetPack's files.
PRIVATE_GST_PLUGIN_DIR = '/usr/lib/bili-record-2k/gst-plugins'
if os.path.isdir(PRIVATE_GST_PLUGIN_DIR):
    existing_plugin_path = os.environ.get('GST_PLUGIN_PATH_1_0', '')
    if PRIVATE_GST_PLUGIN_DIR not in existing_plugin_path.split(os.pathsep):
        os.environ['GST_PLUGIN_PATH_1_0'] = PRIVATE_GST_PLUGIN_DIR + (os.pathsep + existing_plugin_path if existing_plugin_path else '')

try:
    import gi
    gi.require_version('Gst', '1.0')
    gi.require_version('GstController', '1.0')
    from gi.repository import GLib, Gst, GstController
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except Exception as error:  # pragma: no cover - executed on the Jetson only
    print('GPU Scene runtime import failed: ' + str(error), file=sys.stderr)
    sys.exit(2)

PROTOCOL = 'bili-record2k.gpu-scene-render/v1'
CAPABILITIES = ['Text', 'Avatar', 'Rect', 'Card', 'SuperChat', 'Gift', 'Move', 'Fade', 'Scale']
REQUIRED_ELEMENTS = ['appsrc', 'glupload', 'glvideomixer', 'gldownload', 'videoconvert', 'nvvidconv', 'nvv4l2h264enc', 'nvv4l2h265enc']
# nvivafilter is Jetson's supported CUDA callback bridge for NVMM allocated by
# nvvidconv.  Do not insert the direct V4l2Memory-only test element here.
CUDA_NVMM_REQUIRED_ELEMENTS = [
    'appsrc', 'videotestsrc', 'concat', 'queue', 'nvvidconv', 'nvivafilter', 'nvv4l2h264enc', 'nvv4l2h265enc'
]
# A test-only override lets the Orin visual gate exercise a freshly compiled
# CUDA customer library before it replaces the packaged production binary.
CUDA_SCENE_CUSTOMER_LIBRARY = str(os.environ.get('BR2K_CUDA_SCENE_CUSTOMER_LIBRARY') or '').strip() or os.path.join(
    PRIVATE_GST_PLUGIN_DIR, 'libbr2k-scene-cuda-process.so'
)


def fail(message):
    raise RuntimeError(message)


def native_nvmm_trace(message):
    """Opt-in diagnostics for the native NVMM admission probe."""
    if os.environ.get('BR2K_NATIVE_NVMM_TRACE') == '1':
        print('[native-nvmm] ' + str(message), file=sys.stderr, flush=True)


def number(value, default=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def fps_caps(value):
    fraction = Fraction(max(1.0, number(value, 30))).limit_denominator(1001)
    return '%d/%d' % (fraction.numerator, fraction.denominator)


def rgba(value, opacity=1.0):
    text = str(value or '#ffffff').lstrip('#')
    if len(text) != 6 or any(char not in '0123456789abcdefABCDEF' for char in text):
        text = 'ffffff'
    alpha = max(0, min(255, round(number(opacity, 1) * 255)))
    return tuple(int(text[offset:offset + 2], 16) for offset in (0, 2, 4)) + (alpha,)


def ass_rgba(value):
    match = __import__('re').match(r'^&H([0-9a-fA-F]{8})&$', str(value or ''))
    if not match:
        return rgba(value, 1)
    raw = match.group(1)
    return (int(raw[6:8], 16), int(raw[4:6], 16), int(raw[2:4], 16), 255 - int(raw[0:2], 16))


def font_for(props, size):
    family = str(props.get('fontFamily') or 'sans-serif').replace('\n', ' ').replace('\r', ' ').strip() or 'sans-serif'
    # Fontconfig resolves both the CJK face within a TTC and its weight.  PIL
    # otherwise silently loads face 0 (Japanese for NotoSansCJK) and regular
    # weight for every node, which visibly diverges from libass on Chinese
    # glyphs, usernames and price pills.
    weight = number(props.get('fontWeight'), 400)
    pattern = family + (':style=Bold' if weight >= 600 else ':style=Regular')
    path, face_index = '', 0
    try:
        result = subprocess.run(['fc-match', '-f', '%{file}\t%{index}', pattern], capture_output=True, text=True, timeout=3, check=False)
        fields = result.stdout.strip().split('\t', 1)
        path = fields[0]
        face_index = int(fields[1]) if len(fields) > 1 and fields[1].isdigit() else 0
    except Exception:
        pass
    fallback = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc' if weight >= 600 else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
    for candidate, index in [(path, face_index), (fallback, 2), ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 0)]:
        try:
            if candidate and os.path.isfile(candidate):
                return ImageFont.truetype(candidate, max(1, round(size)), index=index)
        except Exception:
            pass
    return ImageFont.load_default()


class AssImage(ctypes.Structure):
    pass


AssImage._fields_ = [
    ('w', ctypes.c_int), ('h', ctypes.c_int), ('stride', ctypes.c_int), ('bitmap', ctypes.POINTER(ctypes.c_ubyte)),
    ('color', ctypes.c_uint32), ('dst_x', ctypes.c_int), ('dst_y', ctypes.c_int), ('next', ctypes.POINTER(AssImage)),
    ('type', ctypes.c_int)
]


class LibassTextRenderer:
    """Render text through the same libass rasterizer as the frozen oracle.

    CUDA only receives the resulting immutable RGBA glyph texture and still
    performs every per-frame blend/animation.  This avoids Pillow selecting a
    different TTC face or using different CJK hinting from ASS.
    """
    def __init__(self):
        self.lib = ctypes.CDLL('libass.so.9')
        self.lib.ass_library_init.restype = ctypes.c_void_p
        self.lib.ass_renderer_init.argtypes = [ctypes.c_void_p]
        self.lib.ass_renderer_init.restype = ctypes.c_void_p
        self.lib.ass_set_frame_size.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        self.lib.ass_set_fonts.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        self.lib.ass_read_memory.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
        self.lib.ass_read_memory.restype = ctypes.c_void_p
        self.lib.ass_render_frame.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_longlong, ctypes.POINTER(ctypes.c_int)]
        self.lib.ass_render_frame.restype = ctypes.POINTER(AssImage)
        self.lib.ass_free_track.argtypes = [ctypes.c_void_p]
        self.library = self.lib.ass_library_init()
        self.renderer = self.lib.ass_renderer_init(self.library)
        if not self.library or not self.renderer:
            fail('无法初始化 libass 文字栅格器。')
        self.lib.ass_set_fonts(self.renderer, None, b'Noto Sans CJK SC', 1, None, 1)

    @staticmethod
    def escape(value):
        return str(value or '').replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}').replace('\n', '\\N')

    @staticmethod
    def ass_color(value):
        red, green, blue, alpha = rgba(value, 1)
        return '&H%02X%02X%02X%02X&' % (255 - alpha, blue, green, red)

    @staticmethod
    def drawing_color(value, fallback='#ffffff'):
        """Return the exact \1c/\1a form used by legacy ASS vector lines."""
        match = __import__('re').match(r'^&H([0-9a-fA-F]{6}|[0-9a-fA-F]{8})&$', str(value or ''))
        if match:
            raw = match.group(1).upper()
            if len(raw) == 8:
                return r'\1c&H%s&\1a&H%s&' % (raw[2:], raw[:2])
            return r'\1c&H%s&' % raw
        return r'\1c%s&' % LibassTextRenderer.ass_color(value or fallback)

    def render_script(self, script, width, height):
        encoded = script.encode('utf-8')
        track = self.lib.ass_read_memory(self.library, encoded, len(encoded), None)
        if not track:
            fail('libass 无法读取文字纹理脚本。')
        try:
            self.lib.ass_set_frame_size(self.renderer, width, height)
            changed = ctypes.c_int(0)
            image_ptr = self.lib.ass_render_frame(self.renderer, track, 0, ctypes.byref(changed))
            output = Image.new('RGBA', (width, height), (0, 0, 0, 0))
            while image_ptr:
                item = image_ptr.contents
                if item.w > 0 and item.h > 0 and item.bitmap:
                    raw = ctypes.string_at(item.bitmap, item.stride * item.h)
                    coverage = Image.frombytes('L', (item.w, item.h), raw, 'raw', 'L', item.stride, 1)
                    color = item.color
                    red, green, blue = (color >> 24) & 255, (color >> 16) & 255, (color >> 8) & 255
                    transparency = color & 255
                    if transparency:
                        coverage = coverage.point(lambda value: value * (255 - transparency) // 255)
                    glyph = Image.new('RGBA', (item.w, item.h), (red, green, blue, 0))
                    glyph.putalpha(coverage)
                    output.alpha_composite(glyph, (item.dst_x, item.dst_y))
                image_ptr = item.next
            return output
        finally:
            self.lib.ass_free_track(track)

    def render(self, props, style, width, height, offset_x=0.0, offset_y=0.0):
        family = str(props.get('fontFamily') or 'Noto Sans CJK SC').replace(',', ' ').strip() or 'Noto Sans CJK SC'
        size = max(1, number(props.get('fontSize'), 20))
        bold = -1 if number(props.get('fontWeight'), 400) >= 600 else 0
        stroke = max(0, number(style.get('strokeWidth'), 0))
        primary = self.ass_color(style.get('fill') or '#ffffff')
        outline = self.ass_color(style.get('stroke') or '#000000')
        content = str(props.get('assText') or self.escape(props.get('text')))
        script = '''[Script Info]
ScriptType: v4.00+
PlayResX: %d
PlayResY: %d
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: SceneText,%s,%.4f,%s,&H00000000&,%s,&H00000000&,%d,0,0,0,100,100,0,0,1,%.4f,0,7,0,0,0,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:01.00,SceneText,,0,0,0,,{\\an7\\pos(%.4f,%.4f)\\bord%.4f\\shad0}%s
''' % (width, height, family, size, primary, outline, bold, stroke, offset_x, offset_y, stroke, content)
        return self.render_script(script, width, height)

    def render_drawings(self, drawings, width, height):
        lines = [
            '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: %d' % width, 'PlayResY: %d' % height,
            '[V4+ Styles]',
            'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
            'Style: SceneShape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
            '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
        ]
        for drawing in drawings:
            path = str(drawing.get('path') or '').strip()
            if not path:
                continue
            layer = max(0, int(number(drawing.get('layer'), 0)))
            x, y = number(drawing.get('x')), number(drawing.get('y'))
            tags = r'{\an7\p1\pos(%s,%s)\bord0\shad0%s}' % (x, y, self.drawing_color(drawing.get('color')))
            lines.append('Dialogue: %d,0:00:00.00,0:00:01.00,SceneShape,,0,0,0,,%s%s' % (layer, tags, path))
        return self.render_script('\n'.join(lines) + '\n', width, height)


try:
    LIBASS_TEXT = LibassTextRenderer()
except Exception:
    # Keep the helper usable on a deliberately minimal recovery image.  The
    # runtime probe/conformance gate will keep this fallback out of production.
    LIBASS_TEXT = None


def draw_texture(entry, work_dir):
    frame = entry.get('frame') or {}
    props = entry.get('props') or {}
    style = entry.get('style') or {}
    width = max(2, math.ceil(number(frame.get('width'), 2)))
    height = max(2, math.ceil(number(frame.get('height'), 2)))
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    kind = str(entry.get('type') or '')
    if kind == 'Text':
        font_size = max(1, number(props.get('fontSize'), 20))
        stroke = max(0, round(number(style.get('strokeWidth'), 0)))
        if LIBASS_TEXT:
            # The CUDA callback places Scene objects at rounded NV12 pixels,
            # while the ASS oracle rasterises at fractional \pos coordinates.
            # Preserve that residual phase inside the libass texture so glyph
            # coverage does not jump a third of a pixel from the oracle.
            phase_x = number(frame.get('x')) - math.floor(number(frame.get('x')) + 0.5)
            phase_y = number(frame.get('y')) - math.floor(number(frame.get('y')) + 0.5)
            image = LIBASS_TEXT.render(props, style, width, height, phase_x, phase_y)
        else:
            font = font_for(props, font_size)
            draw.multiline_text((0, 0), str(props.get('text') or ''), font=font,
                                fill=rgba(style.get('fill'), 1), stroke_width=stroke, stroke_fill=rgba(style.get('stroke'), 1), spacing=0)
    elif kind == 'Avatar':
        vector = props.get('vector') if props.get('role') == 'legacy-ass-avatar-vector' else None
        drawings = props.get('assDrawings') if isinstance(props.get('assDrawings'), list) else None
        if drawings and LIBASS_TEXT:
            image = LIBASS_TEXT.render_drawings(drawings, width, height)
            source = ''
        elif isinstance(vector, dict):
            ring_inset = max(0, number(vector.get('ringInset'), 0))
            inner_size = max(1, width - ring_inset * 2)
            draw.ellipse((0, 0, width - 1, height - 1), fill=ass_rgba(vector.get('outer')))
            draw.ellipse((ring_inset, ring_inset, ring_inset + inner_size - 1, ring_inset + inner_size - 1), fill=ass_rgba(vector.get('inner')))
            head_size = max(1, number(vector.get('headSize'), width * 0.29))
            head_x, head_y = (width - head_size) / 2, height * 0.21
            draw.ellipse((head_x, head_y, head_x + head_size - 1, head_y + head_size - 1), fill=ass_rgba(vector.get('softWhite')))
            shoulders_width = max(1, number(vector.get('shouldersWidth'), width * 0.64))
            shoulders_height = max(1, number(vector.get('shouldersHeight'), height * 0.3))
            shoulders_x, shoulders_y = (width - shoulders_width) / 2, height * 0.58
            draw.rounded_rectangle((shoulders_x, shoulders_y, shoulders_x + shoulders_width - 1, shoulders_y + shoulders_height - 1), radius=shoulders_height / 2, fill=ass_rgba(vector.get('softWhite')))
            source = ''
        else:
            source = str((entry.get('asset') or {}).get('path') or '')
        if not vector:
            try:
                avatar = Image.open(source).convert('RGBA')
                edge = min(avatar.width, avatar.height)
                avatar = avatar.crop(((avatar.width - edge) // 2, (avatar.height - edge) // 2,
                                      (avatar.width + edge) // 2, (avatar.height + edge) // 2)).resize((width, height), Image.Resampling.LANCZOS)
                mask = Image.new('L', (width, height), 0)
                ImageDraw.Draw(mask).ellipse((0, 0, width - 1, height - 1), fill=255)
                image.alpha_composite(avatar)
                image.putalpha(mask)
            except Exception:
                draw.ellipse((0, 0, width - 1, height - 1), fill=rgba(style.get('fill') or '#707070', 1))
    else:
        drawing = str(props.get('assDrawing') or '').strip()
        if drawing and LIBASS_TEXT:
            image = LIBASS_TEXT.render_drawings([{'path': drawing, 'color': props.get('assColor')}], width, height)
        else:
            radius = max(0, min(min(width, height) // 2, round(number(style.get('cornerRadius'), 0))))
            draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=rgba(style.get('fill'), 1))
    shadow = style.get('shadow') if isinstance(style.get('shadow'), dict) else None
    if shadow and number(shadow.get('opacity'), 0) > 0:
        blur = max(0, number(shadow.get('blur'), 0))
        alpha = image.getchannel('A').filter(ImageFilter.GaussianBlur(blur))
        shadow_image = Image.new('RGBA', image.size, rgba(shadow.get('color') or '#000000', 1))
        shadow_image.putalpha(alpha.point(lambda value: int(value * number(shadow.get('opacity'), 0))))
        image = Image.alpha_composite(shadow_image, image)
    target = os.path.join(work_dir, 'scene-' + str(entry.get('id') or 'object').replace('/', '_') + '.png')
    image.save(target, 'PNG')
    return target, width, height


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def scene_state(entry, at, texture_width, texture_height):
    frame = entry.get('frame') or {}
    style = entry.get('style') or {}
    state = {
        'x': number(frame.get('x')), 'y': number(frame.get('y')),
        'width': texture_width, 'height': texture_height,
        'alpha': number(style.get('opacity'), 1)
    }
    for animation in sorted(entry.get('animations') or [], key=lambda item: number(item.get('start'))):
        start, end = number(animation.get('start')), max(number(animation.get('start')) + 0.0001, number(animation.get('end')))
        progress = clamp((at - start) / (end - start), 0, 1)
        kind = str(animation.get('type') or '')
        if kind == 'Move':
            # A Scene object may carry a long list of future reflow moves.
            # Treating a not-yet-started move as progress=0 incorrectly snaps
            # the object to that future move's `from` position.  With a busy
            # side stream that puts several cards on the same row.  Only the
            # active move, or a completed earlier move, may affect this state.
            if at < start:
                continue
            for axis in ('x', 'y'):
                begin = number((animation.get('from') or {}).get(axis), state[axis])
                finish = number((animation.get('to') or {}).get(axis), begin)
                state[axis] = begin + (finish - begin) * progress
        elif kind == 'Fade':
            begin = number(animation.get('from'), state['alpha'])
            finish = number(animation.get('to'), begin)
            state['alpha'] = begin + (finish - begin) * progress
        elif kind == 'Scale':
            if at < start:
                continue
            for axis, key, base in [('x', 'width', texture_width), ('y', 'height', texture_height)]:
                begin = number((animation.get('from') or {}).get(axis), 1)
                finish = number((animation.get('to') or {}).get(axis), begin)
                state[key] = base * (begin + (finish - begin) * progress)
    return state


def prepare_cuda_timeline(request, work_dir):
    """Pre-render Scene assets once and emit GPU-friendly linear time spans.

    The manifest is TSV rather than JSON so the private GStreamer element has
    no JSON parser dependency. Each row is a piecewise-linear interval:
    start/end, x/y/size/alpha at both ends, then a cached RGBA texture path.
    """
    rows = []
    timeline_offset = max(0, number(request.get('timelineOffsetSec'), 0))
    for entry in sorted(request['scene'].get('objects') or [], key=lambda item: number(item.get('zIndex'))):
        style = entry.get('style') or {}
        png, texture_width, texture_height = draw_texture(entry, work_dir)
        raw_path = os.path.splitext(png)[0] + '.rgba'
        Image.open(png).convert('RGBA').tobytes()
        with open(raw_path, 'wb') as handle:
            handle.write(Image.open(png).convert('RGBA').tobytes())
        scene_start, scene_end = number(entry.get('start')), max(number(entry.get('start')) + 0.0001, number(entry.get('end')))
        points = {scene_start, scene_end}
        for animation in entry.get('animations') or []:
            points.add(clamp(number(animation.get('start'), scene_start), scene_start, scene_end))
            points.add(clamp(number(animation.get('end'), scene_end), scene_start, scene_end))
        ordered = sorted(points)
        for left, right in zip(ordered, ordered[1:]):
            initial = scene_state(entry, left, texture_width, texture_height)
            final = scene_state(entry, right, texture_width, texture_height)
            clip = style.get('clip') if isinstance(style.get('clip'), dict) else {}
            clip_width = number(clip.get('width'), -1)
            clip_height = number(clip.get('height'), -1)
            rows.append([left + timeline_offset, right + timeline_offset, initial['x'], initial['y'], initial['width'], initial['height'], initial['alpha'],
                         final['x'], final['y'], final['width'], final['height'], final['alpha'], raw_path, texture_width, texture_height,
                         number(clip.get('x'), 0), number(clip.get('y'), 0), clip_width, clip_height])
    manifest = os.path.join(work_dir, 'scene-cuda.timeline.tsv')
    with open(manifest, 'w', encoding='utf-8') as handle:
        for row in rows:
            handle.write('\t'.join(str(item) for item in row) + '\n')
    return manifest


def animation_values(entry, field, base, start, end, scale=False):
    points = [(0, base), (max(0, start - 0.0001), base), (start, base), (end, base)]
    for animation in entry.get('animations') or []:
        if str(animation.get('type')) != field:
            continue
        at = number(animation.get('start'), start)
        until = max(at + 0.0001, number(animation.get('end'), at + 0.0001))
        if field == 'Fade':
            before = number(animation.get('from'), base)
            after = number(animation.get('to'), before)
        else:
            axis = 'x' if field in ('Move', 'Scale') else 'x'
            before = number((animation.get('from') or {}).get(axis), base)
            after = number((animation.get('to') or {}).get(axis), before)
        points.extend([(at, before), (until, after)])
    return sorted(points, key=lambda item: item[0])


def state_points(entry, key, base, start, end, dimension=False):
    points = [(0, base), (max(0, start - 0.0001), base), (start, base), (end, base)]
    for animation in entry.get('animations') or []:
        kind = str(animation.get('type') or '')
        if key == 'alpha' and kind == 'Fade':
            points.extend([(number(animation.get('start'), start), number(animation.get('from'), base)),
                           (number(animation.get('end'), end), number(animation.get('to'), base))])
        elif key in ('x', 'y') and kind == 'Move':
            points.extend([(number(animation.get('start'), start), number((animation.get('from') or {}).get(key), base)),
                           (number(animation.get('end'), end), number((animation.get('to') or {}).get(key), base))])
        elif key in ('width', 'height') and kind == 'Scale':
            axis = 'x' if key == 'width' else 'y'
            points.extend([(number(animation.get('start'), start), base * number((animation.get('from') or {}).get(axis), 1)),
                           (number(animation.get('end'), end), base * number((animation.get('to') or {}).get(axis), 1))])
    if key == 'alpha':
        points.extend([(max(0, start - 0.0001), 0), (start, base), (end, base), (end + 0.0001, 0)])
    return sorted(points, key=lambda item: item[0])


def bind_property(pad, name, points, integer=False):
    source = GstController.InterpolationControlSource.new()
    source.set_property('mode', GstController.InterpolationMode.LINEAR)
    for seconds, value in points:
        source.set(int(max(0, seconds) * Gst.SECOND), int(round(value)) if integer else float(value))
    binding = GstController.DirectControlBinding.new(pad, name, source)
    pad.add_control_binding(binding)


def make_element(factory, name):
    element = Gst.ElementFactory.make(factory, name)
    if not element:
        fail('缺少 GStreamer 元件：' + factory)
    return element


def link_many(*elements):
    return all(left.link(right) for left, right in zip(elements, elements[1:]))


def create_pipeline(request, work_dir):
    output = request['output']
    width, height, fps = int(output['width']), int(output['height']), number(output['fps'], 30)
    overlay_frames = max(1, math.ceil(number((request.get('input') or {}).get('duration'), 2) * fps) + 1)
    codec = str(output.get('codec') or '')
    encoder = 'nvv4l2h265enc' if 'hevc' in codec or 'h265' in codec else 'nvv4l2h264enc'
    parser = 'h265parse' if encoder == 'nvv4l2h265enc' else 'h264parse'
    pipeline = Gst.Pipeline.new('br2k-gpu-scene')
    base = make_element('appsrc', 'base')
    base.set_property('format', Gst.Format.TIME)
    base.set_property('is-live', True)
    base.set_property('block', True)
    base.set_property('caps', Gst.Caps.from_string('video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    upload = make_element('glupload', 'base-upload')
    mixer = make_element('glvideomixer', 'scene-mixer')
    download = make_element('gldownload', 'scene-download')
    convert = make_element('videoconvert', 'scene-convert')
    raw_caps = make_element('capsfilter', 'scene-i420')
    raw_caps.set_property('caps', Gst.Caps.from_string('video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    nvvidconv = make_element('nvvidconv', 'scene-nvvidconv')
    nv_caps = make_element('capsfilter', 'scene-nvmm')
    nv_caps.set_property('caps', Gst.Caps.from_string('video/x-raw(memory:NVMM),format=NV12,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    encode = make_element(encoder, 'scene-encode')
    encode.set_property('bitrate', max(1000000, int(number(output.get('bitrate'), 15000000))))
    parse = make_element(parser, 'scene-parse')
    sink = make_element('filesink', 'scene-output')
    sink.set_property('location', output['path'])
    for element in [base, upload, mixer, download, convert, raw_caps, nvvidconv, nv_caps, encode, parse, sink]:
        pipeline.add(element)
    if not link_many(base, upload): fail('无法连接 base 到 GL upload。')
    base_pad = mixer.get_request_pad('sink_%u')
    if not upload.get_static_pad('src').link(base_pad) == Gst.PadLinkReturn.OK: fail('无法连接 base 到 GL mixer。')
    if not link_many(mixer, download, convert, raw_caps, nvvidconv, nv_caps, encode, parse, sink): fail('无法连接 GL → NVMM → nvv4l2 管线。')

    for index, entry in enumerate(request['scene'].get('objects') or []):
        texture, texture_width, texture_height = draw_texture(entry, work_dir)
        source = make_element('filesrc', 'overlay-file-%d' % index)
        source.set_property('location', texture)
        png = make_element('pngdec', 'overlay-png-%d' % index)
        freeze = make_element('imagefreeze', 'overlay-freeze-%d' % index)
        # Each cached texture must finish with the base video.  Unlimited
        # imagefreeze sources keep glvideomixer alive forever after stdin EOF.
        freeze.set_property('num-buffers', overlay_frames)
        rate = make_element('videorate', 'overlay-rate-%d' % index)
        caps = make_element('capsfilter', 'overlay-caps-%d' % index)
        caps.set_property('caps', Gst.Caps.from_string('video/x-raw,format=RGBA,framerate=%d/1' % round(fps)))
        item_upload = make_element('glupload', 'overlay-upload-%d' % index)
        queue = make_element('queue', 'overlay-queue-%d' % index)
        for element in [source, png, freeze, rate, caps, item_upload, queue]: pipeline.add(element)
        if not link_many(source, png, freeze, rate, caps, item_upload, queue): fail('无法连接 Scene 对象纹理 ' + str(index))
        pad = mixer.get_request_pad('sink_%u')
        if queue.get_static_pad('src').link(pad) != Gst.PadLinkReturn.OK: fail('无法加入 Scene 对象纹理 ' + str(index))
        frame = entry.get('frame') or {}
        style = entry.get('style') or {}
        start, end = number(entry.get('start')), number(entry.get('end'))
        bind_property(pad, 'xpos', state_points(entry, 'x', number(frame.get('x')), start, end), True)
        bind_property(pad, 'ypos', state_points(entry, 'y', number(frame.get('y')), start, end), True)
        bind_property(pad, 'width', state_points(entry, 'width', texture_width, start, end, True), True)
        bind_property(pad, 'height', state_points(entry, 'height', texture_height, start, end, True), True)
        bind_property(pad, 'alpha', state_points(entry, 'alpha', number(style.get('opacity'), 1), start, end), False)
        pad.set_property('zorder', max(0, min(10000, int(number(entry.get('zIndex')) + 1))))
    return pipeline, base


def create_cuda_nvmm_pipeline(request, work_dir):
    output = request['output']
    width, height, fps = int(output['width']), int(output['height']), number(output['fps'], 30)
    codec = str(output.get('codec') or '')
    encoder = 'nvv4l2h265enc' if 'hevc' in codec or 'h265' in codec else 'nvv4l2h264enc'
    parser = 'h265parse' if encoder == 'nvv4l2h265enc' else 'h264parse'
    timeline = prepare_cuda_timeline(request, work_dir)
    if not os.path.isfile(CUDA_SCENE_CUSTOMER_LIBRARY):
        fail('缺少 Jetson CUDA Scene 客户端库：' + CUDA_SCENE_CUSTOMER_LIBRARY)
    # The callback ABI exposes EGLImage but not GstBuffer PTS. Raw I420 has
    # already lost source PTS at the FFmpeg boundary, so the helper's exact
    # frame-index/FPS time base is passed explicitly to the CUDA library.
    os.environ['BR2K_CUDA_SCENE_TIMELINE'] = timeline
    os.environ['BR2K_CUDA_SCENE_FPS'] = str(fps)
    pipeline = Gst.Pipeline.new('br2k-cuda-nvmm-scene')
    base = make_element('appsrc', 'base')
    base.set_property('format', Gst.Format.TIME)
    # File export is finite. A live appsrc can block Python in push-buffer
    # before nvv4l2 starts consuming its first queued frame.
    base.set_property('is-live', False)
    # The finite exporter controls completion with EOS. Never let a full
    # appsrc queue stall the Python producer before it can submit that EOS.
    base.set_property('block', False)
    base.set_property('caps', Gst.Caps.from_string('video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    convert = make_element('nvvidconv', 'scene-nvvidconv')
    nv_caps = make_element('capsfilter', 'scene-nvmm')
    nv_caps.set_property('caps', Gst.Caps.from_string('video/x-raw(memory:NVMM),format=NV12,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    composite = make_element('nvivafilter', 'scene-cuda-composite')
    composite.set_property('cuda-process', True)
    composite.set_property('customer-lib-name', CUDA_SCENE_CUSTOMER_LIBRARY)
    out_caps = make_element('capsfilter', 'scene-cuda-nvmm')
    out_caps.set_property('caps', Gst.Caps.from_string('video/x-raw(memory:NVMM),format=NV12,width=%d,height=%d,framerate=%d/1' % (width, height, round(fps))))
    encode = make_element(encoder, 'scene-encode')
    encode.set_property('bitrate', max(1000000, int(number(output.get('bitrate'), 15000000))))
    parse = make_element(parser, 'scene-parse')
    sink = make_element('filesink', 'scene-output')
    sink.set_property('location', output['path'])
    for element in [base, convert, nv_caps, composite, out_caps, encode, parse, sink]: pipeline.add(element)
    if not link_many(base, convert, nv_caps, composite, out_caps, encode, parse, sink): fail('无法连接 I420 → NVMM → nvivafilter CUDA Scene → nvv4l2 管线。')
    return pipeline, base


def check_request(request):
    if request.get('protocol') != PROTOCOL: fail('不支持的 GPU Scene 协议。')
    if request.get('backend') not in ('gl-gstreamer', 'cuda-gstreamer'): fail('此 helper 不支持所选 GPU 后端。')
    if not request.get('output', {}).get('path'): fail('缺少输出路径。')
    if not isinstance(request.get('scene', {}).get('objects'), list): fail('缺少 Scene 对象。')


def render(request, input_stream=None):
    check_request(request)
    output = request['output']
    frame_size = int(output['width']) * int(output['height']) * 3 // 2
    work_dir = tempfile.mkdtemp(prefix='br2k-scene-gpu-')
    try:
        pipeline, base = (create_cuda_nvmm_pipeline(request, work_dir) if request.get('backend') == 'cuda-gstreamer' else create_pipeline(request, work_dir))
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE: fail('无法启动 GPU Scene 管线。')
        frame_index = 0
        stream = input_stream or sys.stdin.buffer
        pending = b''
        while True:
            chunk = stream.read(frame_size - len(pending))
            if not chunk:
                if pending: fail('收到不完整 I420 帧。')
                break
            pending += chunk
            if len(pending) < frame_size:
                continue
            payload, pending = pending, b''
            buffer = Gst.Buffer.new_allocate(None, frame_size, None)
            buffer.fill(0, payload)
            buffer.pts = int(frame_index * Gst.SECOND / number(output.get('fps'), 30))
            buffer.duration = int(Gst.SECOND / number(output.get('fps'), 30))
            flow = base.emit('push-buffer', buffer)
            if flow != Gst.FlowReturn.OK: fail('GL Scene 输入被拒绝：' + str(flow))
            frame_index += 1
        expected_frames = max(1, int(math.ceil(number((request.get('input') or {}).get('duration'), 0) * number(output.get('fps'), 30))))
        if frame_index < expected_frames:
            fail('GPU Scene 仅收到 %d/%d 帧 I420 输入。' % (frame_index, expected_frames))
        base.emit('end-of-stream')
        bus = pipeline.get_bus()
        while True:
            message = bus.timed_pop_filtered(Gst.CLOCK_TIME_NONE, Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if message.type == Gst.MessageType.EOS: break
            error, debug = message.parse_error()
            fail('GPU Scene GStreamer：' + str(error) + ('；' + str(debug) if debug else ''))
        pipeline.set_state(Gst.State.NULL)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def decode_native(args):
    """Seek and decode one finite source range through Jetson NVDEC.

    gst-launch has no command-line equivalent for GstElement.seek_simple().
    Keeping this tiny helper beside the Scene renderer lets every 20-second
    export chunk begin at its real timeline position while retaining
    qtdemux -> parser -> nvv4l2decoder -> nvvidconv as the decoder path.
    Raw frames leave only via the inherited fd requested by Node; no raw file
    is ever materialised on disk.
    """
    input_path = str(args.input or '')
    if not os.path.isfile(input_path): fail('原生解码输入不存在：' + input_path)
    width, height = int(args.width), int(args.height)
    fps = max(1.0, number(args.fps, 30))
    start = max(0.0, number(args.start, 0))
    duration = max(0.001, number(args.duration, 0))
    parser_factory = 'h265parse' if str(args.codec).lower() == 'hevc' else 'h264parse'
    converter = str(args.converter or 'nvvidconv')
    if converter not in ('nvvidconv', 'nvvideoconvert'): fail('不支持的 Jetson 色彩转换：' + converter)
    output_fd = int(args.output_fd)
    pipeline = Gst.Pipeline.new('br2k-native-decode')
    source = make_element('filesrc', 'source')
    source.set_property('location', input_path)
    demux = make_element('qtdemux', 'demux')
    parser = make_element(parser_factory, 'parser')
    decoder = make_element('nvv4l2decoder', 'decoder')
    convert = make_element(converter, 'convert')
    caps = make_element('capsfilter', 'i420')
    caps.set_property('caps', Gst.Caps.from_string('video/x-raw,format=I420,width=%d,height=%d' % (width, height)))
    sink = make_element('appsink', 'sink')
    sink.set_property('sync', False)
    sink.set_property('max-buffers', 4)
    sink.set_property('drop', False)
    for element in [source, demux, parser, decoder, convert, caps, sink]: pipeline.add(element)
    if not source.link(demux) or not link_many(parser, decoder, convert, caps, sink): fail('无法连接原生 NVDEC 链路。')
    linked = {'value': False}
    def on_pad_added(_demux, pad):
        if linked['value'] or not pad.get_current_caps(): return
        name = pad.get_current_caps().get_structure(0).get_name()
        if not name.startswith('video/') or parser.get_static_pad('sink').is_linked(): return
        if pad.link(parser.get_static_pad('sink')) == Gst.PadLinkReturn.OK: linked['value'] = True
    demux.connect('pad-added', on_pad_added)
    # nvv4l2decoder can wait for a downstream NVMM allocation while PAUSED on
    # some H.264 JetPack builds. Start PLAYING first, then issue the flush
    # seek; appsink provides the allocation once samples are requested below.
    if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE: fail('无法启动原生 NVDEC 管线。')
    deadline = GLib.get_monotonic_time() + 8 * GLib.USEC_PER_SEC
    while not linked['value'] and GLib.get_monotonic_time() < deadline:
        pipeline.get_state(100 * Gst.MSECOND)
    if not linked['value']:
        pipeline.set_state(Gst.State.NULL)
        fail('原生 NVDEC 管线没有可用视频流。')
    if start > 0.0001 and not pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, int(start * Gst.SECOND)):
        pipeline.set_state(Gst.State.NULL)
        fail('qtdemux 无法定位到分段起点。')
    required_frames = max(1, int(math.ceil(duration * fps)))
    written = 0
    try:
        with os.fdopen(output_fd, 'wb', closefd=False) as output:
            while written < required_frames:
                sample = sink.emit('try-pull-sample', 5 * Gst.SECOND)
                if sample is None:
                    message = pipeline.get_bus().timed_pop_filtered(0, Gst.MessageType.ERROR | Gst.MessageType.EOS)
                    if message and message.type == Gst.MessageType.ERROR:
                        error, debug = message.parse_error()
                        fail('原生 NVDEC：' + str(error) + ('；' + str(debug) if debug else ''))
                    fail('原生 NVDEC 在 5 秒内未输出下一帧。')
                buffer = sample.get_buffer()
                ok, mapped = buffer.map(Gst.MapFlags.READ)
                if not ok: fail('无法读取 NVDEC 输出帧。')
                try:
                    expected = width * height * 3 // 2
                    if mapped.size < expected: fail('原生 NVDEC 输出帧尺寸不完整。')
                    output.write(mapped.data[:expected])
                    written += 1
                finally:
                    buffer.unmap(mapped)
            output.flush()
    finally:
        pipeline.send_event(Gst.Event.new_eos())
        pipeline.set_state(Gst.State.NULL)
    if written < required_frames:
        fail('原生 NVDEC 仅解出 %d/%d 帧。' % (written, required_frames))


def render_native_nvmm(request):
    """Decode, composite and encode entirely in NVMM for one finite request."""
    check_request(request)
    if request.get('backend') != 'cuda-gstreamer': fail('原生零拷贝仅支持 cuda-gstreamer。')
    source = request.get('input') or {}
    output = request.get('output') or {}
    input_path = str(source.get('path') or '')
    if not os.path.isfile(input_path): fail('原生零拷贝输入不存在：' + input_path)
    width, height, fps = int(output['width']), int(output['height']), number(output.get('fps'), 30)
    codec = str(source.get('codec') or '').lower()
    parser_factory = 'h265parse' if codec in ('hevc', 'h265') else 'h264parse'
    encoder = 'nvv4l2h265enc' if ('hevc' in str(output.get('codec') or '') or 'h265' in str(output.get('codec') or '')) else 'nvv4l2h264enc'
    parser_out = 'h265parse' if encoder == 'nvv4l2h265enc' else 'h264parse'
    start, duration = max(0, number(source.get('startTime'), 0)), max(0.001, number(source.get('duration'), 0.001))
    # `timelineOffsetSec` is the exact leading-video gap used by the canonical
    # Scene Graph path. It must be physical media here, not just a shift of
    # the CUDA texture timeline: the final audio mux starts at t=0 too.
    # Convert the already frame-aligned request value into a finite number of
    # black NVMM frames so the elementary H26x stream begins at PTS zero and
    # its first source frame begins at the same clock as the original audio.
    leading_video_sec = min(duration, max(0, number(request.get('timelineOffsetSec'), 0)))
    leading_video_frames = max(0, int(round(leading_video_sec * fps)))
    # A video stream can only represent the lead in whole frames. Make CUDA's
    # texture timeline use that exact materialized duration too; otherwise a
    # 1.019-second request at 30 fps would draw UI about 14 ms before the
    # first non-black video frame.
    materialized_lead_sec = leading_video_frames / fps if leading_video_frames else 0
    def launch_quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'
    work_dir = tempfile.mkdtemp(prefix='br2k-native-nvmm-')
    pipeline = None
    try:
        timeline_request = dict(request)
        timeline_request['timelineOffsetSec'] = materialized_lead_sec
        timeline = prepare_cuda_timeline(timeline_request, work_dir)
        os.environ['BR2K_CUDA_SCENE_TIMELINE'] = timeline
        os.environ['BR2K_CUDA_SCENE_FPS'] = str(fps)
        # Let GStreamer's delayed-link machinery bind qtdemux.video_0 before
        # streaming begins. This is the same graph syntax that succeeds under
        # gst-launch; hand-written pad-added linkage could admit one frame and
        # then stall the decoder on JetPack 6.2.
        # Do not force a rounded UI fps (for example 59.99) into the native
        # decoder caps.  qtdemux/nvv4l2decoder exposes the stream's own exact
        # rational rate; constraining it to a decimal approximation makes the
        # demux pad fail with "not-linked" before CUDA receives a frame.
        caps = 'video/x-raw(memory:NVMM),format=NV12,width=%d,height=%d' % (width, height)
        source_branch = (
            'filesrc name=source location=%s ! qtdemux name=demux demux.video_0 ! %s name=parser ! '
            'nvv4l2decoder name=decoder ! nvvidconv name=nvmm-rewrap ! %s'
        ) % (launch_quote(input_path), parser_factory, caps)
        encoder_branch = (
            'nvivafilter name=cuda-scene cuda-process=true customer-lib-name=%s ! %s ! '
            '%s name=encode bitrate=%d ! %s name=parse ! filesink name=output async=false location=%s'
        ) % (launch_quote(CUDA_SCENE_CUSTOMER_LIBRARY), caps, encoder,
             max(1000000, int(number(output.get('bitrate'), 15000000))), parser_out, launch_quote(output['path']))
        if leading_video_frames:
            # concat adjusts the source branch's segment base after the finite
            # black branch. Both inputs are NVMM/NV12 before nvivafilter, so
            # neither black frames nor decoded video are mapped through CPU.
            # This is intentionally one pipeline: appending a separate H26x
            # black stream would discard its timestamp continuity at remux.
            native_nvmm_trace('insert NVMM black lead frames=%d seconds=%.6f' % (leading_video_frames, leading_video_sec))
            launch = (
                'concat name=timeline_lead adjust-base=true ! queue ! %s '
                'videotestsrc name=black-lead pattern=black num-buffers=%d ! '
                'video/x-raw,format=I420,width=%d,height=%d,framerate=%s ! nvvidconv ! %s ! queue ! timeline_lead. '
                '%s ! queue ! timeline_lead.'
            ) % (encoder_branch, leading_video_frames, width, height, fps_caps(fps), caps, source_branch)
        else:
            launch = source_branch + ' ! ' + encoder_branch
        native_nvmm_trace('pipeline=' + launch)
        try:
            pipeline = Gst.parse_launch(launch)
        except GLib.Error as error:
            fail('无法组装 NVDEC → CUDA Scene → NVENC：' + str(error))
        decoder = pipeline.get_by_name('decoder')
        composite = pipeline.get_by_name('cuda-scene')
        encode = pipeline.get_by_name('encode')
        if not decoder or not composite or not encode:
            fail('原生 NVMM 管线缺少必需元件。')
        # For a non-zero chunk, hold the first Scene buffer long enough for
        # qtdemux to become seekable. Seeking the fully running NVENC graph
        # races the encoder; seeking while PAUSED never prerolls nvivafilter
        # on JetPack. A downstream block gives the demux a real segment while
        # preventing pre-seek media from reaching the output.
        startup_gate = {'reached': False}
        startup_pad = composite.get_static_pad('src')
        startup_probe = None
        if start > 0.0001:
            def hold_first_scene_buffer(_pad, _info):
                startup_gate['reached'] = True
                native_nvmm_trace('startup scene buffer held for seek')
                return Gst.PadProbeReturn.OK
            startup_probe = startup_pad.add_probe(Gst.PadProbeType.BLOCK_DOWNSTREAM, hold_first_scene_buffer)
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            fail('无法启动原生 NVMM 管线。')
        native_nvmm_trace('pipeline PLAYING')
        # A wall-clock timer cuts a fast NVMM pipeline short.  JetPack's
        # nvivafilter does not accept a pipeline-wide stop segment on every
        # release, so seek the media start and use the CUDA Scene output PTS
        # to inject EOS at the requested end instead.
        if start > 0.0001:
            deadline = GLib.get_monotonic_time() + 5 * GLib.USEC_PER_SEC
            while not startup_gate['reached'] and GLib.get_monotonic_time() < deadline:
                message = pipeline.get_bus().timed_pop_filtered(10 * Gst.MSECOND, Gst.MessageType.ERROR)
                if message:
                    error, debug = message.parse_error()
                    fail('原生 NVMM 分段定位预热失败：' + str(error) + ('；' + str(debug) if debug else ''))
            if not startup_gate['reached']:
                fail('原生 NVMM 分段定位预热超时。')
            if not pipeline.seek_simple(
                    Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT | Gst.SeekFlags.ACCURATE,
                    int(start * Gst.SECOND)):
                fail('原生 NVMM 无法定位到分段起点。')
            startup_pad.remove_probe(startup_probe)
        counters = {'decode': 0, 'scene': 0, 'encode': 0}
        negotiated_fps = {'value': ''}
        encoded_pts = {'first': None, 'end': None}
        eos_at_target = {'sent': False}
        scene_first_pts = {'value': None}
        def count_buffer(_pad, info, key):
            buffer = info.get_buffer()
            if not buffer:
                return Gst.PadProbeReturn.OK
            if key == 'decode' and not negotiated_fps['value']:
                # This probe executes before the buffer reaches nvivafilter.
                # The CUDA customer library reads this environment value on
                # its first callback, so it receives the negotiated rational
                # rate rather than the lossy decimal displayed by FFmpeg.
                caps = _pad.get_current_caps()
                caps_text = caps.to_string() if caps else ''
                match = __import__('re').search(r'framerate=\(fraction\)(\d+)/(\d+)', caps_text)
                if match and int(match.group(2)) > 0:
                    negotiated_fps['value'] = match.group(1) + '/' + match.group(2)
                    os.environ['BR2K_CUDA_SCENE_FPS'] = negotiated_fps['value']
                    native_nvmm_trace('negotiated source fps=' + negotiated_fps['value'])
                elif caps_text:
                    # Avoid re-querying once per decoded frame on unusual
                    # streams whose negotiated caps omit framerate.
                    negotiated_fps['value'] = 'unavailable'
                    native_nvmm_trace('decoder caps omit framerate: ' + caps_text)
            if counters[key] == 0:
                native_nvmm_trace('first ' + key + ' buffer pts=' + str(buffer.pts))
            # EOS is sent from the streaming thread when the scene output
            # reaches the requested media PTS. It is deliberately not a
            # GLib timeout: a 4x realtime pipeline still emits exactly the
            # same 20 seconds of media as a realtime one.
            if key == 'scene' and buffer.pts != Gst.CLOCK_TIME_NONE:
                # Container tracks need not begin at PTS 0 (the HEVC fixture
                # begins at 66.7ms). Anchor the finite chunk at the first
                # output scene PTS, rather than an assumed absolute zero, so
                # every chunk contains its requested media duration.
                if scene_first_pts['value'] is None:
                    scene_first_pts['value'] = buffer.pts
                target_pts = scene_first_pts['value'] + int(duration * Gst.SECOND)
                if buffer.pts >= target_pts:
                    if not eos_at_target['sent']:
                        eos_at_target['sent'] = True
                        native_nvmm_trace('send EOS at scene pts=' + str(buffer.pts))
                        pipeline.send_event(Gst.Event.new_eos())
                    return Gst.PadProbeReturn.DROP
            counters[key] += 1
            if key == 'encode' and buffer.pts != Gst.CLOCK_TIME_NONE:
                if encoded_pts['first'] is None:
                    encoded_pts['first'] = buffer.pts
                end = buffer.pts
                if buffer.duration != Gst.CLOCK_TIME_NONE:
                    end += buffer.duration
                encoded_pts['end'] = max(encoded_pts['end'] or end, end)
            return Gst.PadProbeReturn.OK
        for name, element in [('decode', decoder), ('scene', composite), ('encode', encode)]:
            element.get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, count_buffer, name)
        wall_started = GLib.get_monotonic_time()
        bus = pipeline.get_bus()
        try:
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                fail('无法运行原生 NVMM 管线。')
            native_nvmm_trace('waiting for EOS')
            while True:
                # Only the tiny bundled admission samples have a no-progress
                # deadline. Production chunks are terminated by Scene PTS,
                # never by wall clock, so a heavily loaded yet valid export is
                # not cut short.
                wait_time = 6 * Gst.SECOND if request.get('selfTest') else Gst.CLOCK_TIME_NONE
                message = bus.timed_pop_filtered(wait_time, Gst.MessageType.ERROR | Gst.MessageType.EOS)
                if message is None:
                    fail('原生 NVMM 自检在 6 秒内未完成媒体 EOS。')
                if message.type == Gst.MessageType.EOS: break
                error, debug = message.parse_error(); fail('原生 NVMM：' + str(error) + ('；' + str(debug) if debug else ''))
        finally:
            pipeline.set_state(Gst.State.NULL)
        wall_seconds = max(0.001, (GLib.get_monotonic_time() - wall_started) / GLib.USEC_PER_SEC)
        measured_media_seconds = 0.0
        if encoded_pts['first'] is not None and encoded_pts['end'] is not None:
            measured_media_seconds = max(0.0, (encoded_pts['end'] - encoded_pts['first']) / Gst.SECOND)
        # Some JetPack parser/encoder combinations do not retain a duration on
        # the final access unit.  Frame count at the negotiated rational fps
        # is still media time, never wall time.
        if measured_media_seconds <= 0:
            measured_media_seconds = counters['encode'] * Fraction(fps_caps(fps)) ** -1
            measured_media_seconds = float(measured_media_seconds)
        total = counters['encode'] / wall_seconds
        return {
            'frames': counters['encode'], 'mediaSeconds': measured_media_seconds, 'wallSeconds': wall_seconds,
            'decode': counters['decode'] / wall_seconds, 'scene': counters['scene'] / wall_seconds,
            'encode': total, 'total': total
        }
    finally:
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        shutil.rmtree(work_dir, ignore_errors=True)


def probe():
    Gst.init(None)
    cuda_available = [name for name in CUDA_NVMM_REQUIRED_ELEMENTS if Gst.ElementFactory.find(name)]
    cuda_ready = len(cuda_available) == len(CUDA_NVMM_REQUIRED_ELEMENTS) and os.path.isfile(CUDA_SCENE_CUSTOMER_LIBRARY)
    available = cuda_available if cuda_ready else [name for name in REQUIRED_ELEMENTS if Gst.ElementFactory.find(name)]
    payload = {
        'protocol': PROTOCOL,
        'backend': 'cuda-gstreamer' if cuda_ready else 'gl-gstreamer',
        'version': '0.1.0',
        'capabilities': CAPABILITIES,
        'gstreamerElements': available,
        'nativeNvmmScene': bool(cuda_ready and Gst.ElementFactory.find('nvv4l2decoder'))
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if cuda_ready or len(available) == len(REQUIRED_ELEMENTS) else 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe')
    parser.add_argument('--request')
    parser.add_argument('--native-scene-request')
    parser.add_argument('--native-nvmm-self-test', action='store_true')
    parser.add_argument('--decode-native', action='store_true')
    parser.add_argument('--input')
    parser.add_argument('--codec')
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    parser.add_argument('--fps')
    parser.add_argument('--start')
    parser.add_argument('--duration')
    parser.add_argument('--converter')
    parser.add_argument('--output-fd')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    Gst.init(None)
    if args.probe == 'json': return probe()
    if args.decode_native:
        decode_native(args)
        return 0
    if args.native_scene_request:
        with open(args.native_scene_request, 'r', encoding='utf-8') as handle:
            metrics = render_native_nvmm(json.load(handle))
        print(json.dumps({'nativeNvmmMetrics': metrics}, ensure_ascii=False))
        return 0
    if args.native_nvmm_self_test:
        reports, failures = {}, {}
        for source_codec, source_name in [('h264', 'h264-sample.mp4'), ('hevc', 'hevc-sample.mp4')]:
            source = '/usr/lib/bili-record-2k/assets/jetson-self-test/' + source_name
            target = '/tmp/br2k-native-nvmm-self-test-' + source_codec + '.h265'
            try: os.unlink(target)
            except FileNotFoundError: pass
            request = {
                'protocol': PROTOCOL, 'backend': 'cuda-gstreamer', 'selfTest': True,
                'input': {'path': source, 'codec': source_codec, 'startTime': 0, 'duration': 2},
                # The bundled samples are 30/1. Keep this matching their
                # native rational rate: nvvidconv preserves timing but is not
                # a framerate converter, so asking it for 30000/1001 would
                # test an impossible caps conversion rather than NVMM.
                'output': {'path': target, 'codec': 'hevc_nvv4l2', 'width': 320, 'height': 180, 'fps': 30, 'bitrate': 1000000},
                'scene': {'objects': [{'id': 'native-self-test-card-' + source_codec, 'type': 'Card', 'start': 0, 'end': 2,
                    'frame': {'x': 18, 'y': 18, 'width': 180, 'height': 72}, 'zIndex': 1,
                    'style': {'fill': '#3d70dd', 'opacity': 1, 'cornerRadius': 16}, 'props': {}}]}
            }
            try:
                metrics = render_native_nvmm(request)
                if not os.path.isfile(target) or os.path.getsize(target) < 1024:
                    fail('没有生成有效 H.265。')
                reports[source_codec] = metrics
            except Exception as error:
                # H.264 and HEVC are independent admission checks. Never hide
                # the second result merely because the first decoder path
                # failed; production still requires both to succeed.
                failures[source_codec] = str(error)
        payload = {'ok': not failures, 'nativeNvmmMetrics': reports}
        if failures: payload['nativeNvmmFailures'] = failures
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if not failures else 3
    if args.self_test:
        target = '/tmp/br2k-gpu-scene-self-test.h264'
        try: os.unlink(target)
        except FileNotFoundError: pass
        request = {
            'protocol': PROTOCOL, 'backend': 'cuda-gstreamer',
            'output': {'path': target, 'codec': 'h264_nvv4l2', 'width': 320, 'height': 180, 'fps': 30, 'bitrate': 1000000},
            'input': {'duration': 2}, 'scene': {'objects': [{
                'id': 'self-test-card', 'type': 'Card', 'start': 0, 'end': 2,
                'frame': {'x': 18, 'y': 18, 'width': 180, 'height': 72}, 'zIndex': 1,
                'style': {'fill': '#3d70dd', 'opacity': 1, 'cornerRadius': 16}, 'props': {},
                'animations': [{'type': 'Move', 'start': 0, 'end': 1, 'from': {'x': 18, 'y': 18}, 'to': {'x': 100, 'y': 18}}]
            }]}
        }
        render(request, io.BytesIO(bytes(320 * 180 * 3 // 2 * 60)))
        if not os.path.isfile(target) or os.path.getsize(target) < 1024: fail('GPU Scene 自检没有生成有效 H.264。')
        print(json.dumps({'ok': True, 'output': target}, ensure_ascii=False))
        return 0
    if not args.request: fail('需要 --request <scene-request.json>。')
    with open(args.request, 'r', encoding='utf-8') as handle: render(json.load(handle))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('GPU Scene renderer failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
