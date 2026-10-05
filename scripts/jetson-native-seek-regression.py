"""Device regression: a non-IDR I sync sample must not lose clip pictures/text."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

stage = pathlib.Path(tempfile.mkdtemp(prefix='br2k-native-seek-'))
helper = os.environ.get('BR2K_JETSON_NVMM_HELPER', '/usr/lib/bili-record-2k/bin/br2k-scene-gpu')
ffmpeg = os.environ.get('BR2K_JETSON_NVMM_FFMPEG', '/usr/lib/bili-record-2k/bin/ffmpeg-full')

def run(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    assert result.returncode == 0, result.stderr.decode(errors='replace')[-4000:]
    return result

try:
    source = stage / 'non-idr-sync.mp4'
    run(['gst-launch-1.0', '-q', 'videotestsrc', 'pattern=black', 'num-buffers=600', '!',
         'video/x-raw,format=I420,width=640,height=360,framerate=60/1', '!', 'nvvidconv', '!',
         'video/x-raw(memory:NVMM),format=NV12', '!', 'nvv4l2h264enc', 'iframeinterval=30',
         'idrinterval=256', 'bitrate=2000000', '!', 'h264parse', '!', 'mp4mux', '!', 'filesink',
         'location=' + str(source)])
    # Reproduce a container sync sample whose first picture is I, not IDR.
    bad_window = stage / 'sync-window.mp4'
    run([ffmpeg, '-v', 'error', '-y', '-ss', '3.2', '-i', str(source), '-t', '2',
         '-map', '0:v', '-c', 'copy', str(bad_window)])
    headers = run([ffmpeg, '-hide_banner', '-i', str(bad_window), '-frames:v', '1',
                   '-map', '0:v', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-']).stderr.decode()
    first_packet = headers.split('Packet:', 1)[1].split('Packet:', 1)[0]
    assert 'key frame' in first_packet and '00001 = 1' in first_packet, first_packet
    request = {
        'protocol': 'bili-record2k.gpu-scene-render/v1', 'backend': 'cuda-gstreamer',
        'input': {'path': str(source), 'codec': 'h264', 'sourceFrameRate': '60/1',
                  'startTime': 3.2, 'duration': 2},
        'output': {'path': str(stage / 'clip.mkv'), 'container': 'mkv', 'codec': 'hevc_nvv4l2',
                   'width': 640, 'height': 360, 'fps': 60, 'bitrate': 2000000},
        'scene': {'canvas': {'width': 640, 'height': 360, 'fps': 60}, 'duration': 2,
                  'objects': [{'id': 'seek-text', 'type': 'Text', 'start': 0.25, 'end': 0.75,
                               'frame': {'x': 20, 'y': 20, 'width': 450, 'height': 70},
                               'props': {'text': '定位弹幕测试', 'fontSize': 42, 'fontFamily': 'Noto Sans CJK SC'},
                               'style': {'fill': '#ffffff'}}]}}
    req = stage / 'request.json'
    req.write_text(json.dumps(request))
    reports = []
    for _ in range(3):
        result = run(['python3', helper, '--native-scene-request', str(req)])
        metrics = next(json.loads(line)['nativeNvmmMetrics'] for line in result.stdout.decode().splitlines()
                       if '"nativeNvmmMetrics"' in line)
        assert metrics['ptsBridge']['ok'], metrics
        assert abs(metrics['ptsBridge']['sourceFirstPts'] / 1e9 - 3.2) < 1 / 60 + .002, metrics
        assert metrics['frames'] == 120, metrics
        glyphs = []
        for at in [0.1, 0.5, 1.0]:
            pixels = run([ffmpeg, '-v', 'error', '-ss', str(at), '-i', request['output']['path'],
                          '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']).stdout
            assert len(pixels) == 640 * 360 * 3
            glyphs.append(sum(min(pixels[i:i+3]) > 180 for i in range(0, len(pixels), 3)))
        assert glyphs[0] < 20 and glyphs[1] > 100 and glyphs[2] < 20, glyphs
        reports.append({'frames': metrics['frames'], 'pts': metrics['ptsBridge'], 'glyphPixels': glyphs})
    print(json.dumps({'ok': True, 'nonIdrSyncSample': True, 'reports': reports}))
finally:
    shutil.rmtree(stage)
