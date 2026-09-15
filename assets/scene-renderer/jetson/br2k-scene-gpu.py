#!/usr/bin/python3
"""BiliRecord2K GPU Scene Graph renderer for Jetson.

The helper reads I420 frames from stdin, composes cached Scene Graph textures
with GStreamer's GL mixer, then hands I420 to nvvidconv/nvv4l2 for hardware
encoding.  It intentionally accepts a JSON request file rather than command
fragments.  The Node service stays responsible for downloading avatars and
for final audio muxing.
"""

import argparse
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

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


def fail(message):
    raise RuntimeError(message)


def number(value, default=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def rgba(value, opacity=1.0):
    text = str(value or '#ffffff').lstrip('#')
    if len(text) != 6 or any(char not in '0123456789abcdefABCDEF' for char in text):
        text = 'ffffff'
    alpha = max(0, min(255, round(number(opacity, 1) * 255)))
    return tuple(int(text[offset:offset + 2], 16) for offset in (0, 2, 4)) + (alpha,)


def font_for(props, size):
    family = str(props.get('fontFamily') or 'sans-serif').replace('\n', ' ').replace('\r', ' ').strip() or 'sans-serif'
    path = ''
    try:
        result = subprocess.run(['fc-match', '-f', '%{file}', family], capture_output=True, text=True, timeout=3, check=False)
        path = result.stdout.strip()
    except Exception:
        pass
    for candidate in [path, '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        try:
            if candidate and os.path.isfile(candidate):
                return ImageFont.truetype(candidate, max(1, round(size)))
        except Exception:
            pass
    return ImageFont.load_default()


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
        font = font_for(props, font_size)
        stroke = max(0, round(number(style.get('strokeWidth'), 0)))
        draw.multiline_text((0, 0), str(props.get('text') or ''), font=font, fill=rgba(style.get('fill'), 1),
                            stroke_width=stroke, stroke_fill=rgba(style.get('stroke'), 1), spacing=0)
    elif kind == 'Avatar':
        source = str((entry.get('asset') or {}).get('path') or '')
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
            draw.ellipse((0, 0, width - 1, height - 1), fill=rgba(style.get('fill') or '#707070', style.get('opacity', 1)))
    else:
        radius = max(0, min(min(width, height) // 2, round(number(style.get('cornerRadius'), 0))))
        draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=rgba(style.get('fill'), style.get('opacity', 1)))
    shadow = style.get('shadow') if isinstance(style.get('shadow'), dict) else None
    if shadow and number(shadow.get('opacity'), 0) > 0:
        blur = max(0, number(shadow.get('blur'), 0))
        alpha = image.getchannel('A').filter(ImageFilter.GaussianBlur(blur))
        shadow_image = Image.new('RGBA', image.size, rgba(shadow.get('color') or '#000000', shadow.get('opacity', 0)))
        shadow_image.putalpha(alpha.point(lambda value: int(value * number(shadow.get('opacity'), 0))))
        image = Image.alpha_composite(shadow_image, image)
    target = os.path.join(work_dir, 'scene-' + str(entry.get('id') or 'object').replace('/', '_') + '.png')
    image.save(target, 'PNG')
    return target, width, height


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


def check_request(request):
    if request.get('protocol') != PROTOCOL: fail('不支持的 GPU Scene 协议。')
    if request.get('backend') != 'gl-gstreamer': fail('此 helper 仅支持 gl-gstreamer。')
    if not request.get('output', {}).get('path'): fail('缺少输出路径。')
    if not isinstance(request.get('scene', {}).get('objects'), list): fail('缺少 Scene 对象。')


def render(request, input_stream=None):
    check_request(request)
    output = request['output']
    frame_size = int(output['width']) * int(output['height']) * 3 // 2
    work_dir = tempfile.mkdtemp(prefix='br2k-scene-gpu-')
    try:
        pipeline, base = create_pipeline(request, work_dir)
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE: fail('无法启动 GL Scene 管线。')
        frame_index = 0
        stream = input_stream or sys.stdin.buffer
        while True:
            payload = stream.read(frame_size)
            if not payload: break
            if len(payload) != frame_size: fail('收到不完整 I420 帧。')
            buffer = Gst.Buffer.new_allocate(None, frame_size, None)
            buffer.fill(0, payload)
            buffer.pts = int(frame_index * Gst.SECOND / number(output.get('fps'), 30))
            buffer.duration = int(Gst.SECOND / number(output.get('fps'), 30))
            flow = base.emit('push-buffer', buffer)
            if flow != Gst.FlowReturn.OK: fail('GL Scene 输入被拒绝：' + str(flow))
            frame_index += 1
        base.emit('end-of-stream')
        bus = pipeline.get_bus()
        while True:
            message = bus.timed_pop_filtered(Gst.CLOCK_TIME_NONE, Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if message.type == Gst.MessageType.EOS: break
            error, debug = message.parse_error()
            fail('GL Scene GStreamer：' + str(error) + ('；' + str(debug) if debug else ''))
        pipeline.set_state(Gst.State.NULL)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def probe():
    Gst.init(None)
    available = [name for name in REQUIRED_ELEMENTS if Gst.ElementFactory.find(name)]
    payload = {
        'protocol': PROTOCOL,
        'backend': 'gl-gstreamer',
        'version': '0.1.0',
        'capabilities': CAPABILITIES,
        'gstreamerElements': available
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if len(available) == len(REQUIRED_ELEMENTS) else 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe')
    parser.add_argument('--request')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    Gst.init(None)
    if args.probe == 'json': return probe()
    if args.self_test:
        target = '/tmp/br2k-gpu-scene-self-test.h264'
        try: os.unlink(target)
        except FileNotFoundError: pass
        request = {
            'protocol': PROTOCOL, 'backend': 'gl-gstreamer',
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
