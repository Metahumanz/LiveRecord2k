import gi, pathlib,json,subprocess,os,tempfile,shutil
gi.require_version('Gst', '1.0')
from gi.repository import Gst
Gst.init(None)
stage=pathlib.Path(tempfile.mkdtemp(prefix='br2k-pts-gap-regression-'));src=stage/'clock-gap-source.mp4';out=stage/'clock-gap-before.mkv'
pipeline=Gst.parse_launch('videotestsrc num-buffers=60 pattern=black ! video/x-raw,format=I420,width=640,height=360,framerate=30/1 ! identity name=gap ! nvvidconv ! video/x-raw(memory:NVMM),format=NV12 ! nvv4l2h264enc bitrate=2000000 ! h264parse ! qtmux ! filesink location='+str(src))
def gap(_pad,info):
    buffer=info.get_buffer()
    if buffer and buffer.pts>=Gst.SECOND:buffer.pts+=2*Gst.SECOND;buffer.dts=buffer.pts
    return Gst.PadProbeReturn.OK
pipeline.get_by_name('gap').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER,gap)
pipeline.set_state(Gst.State.PLAYING);message=pipeline.get_bus().timed_pop_filtered(30*Gst.SECOND,Gst.MessageType.ERROR|Gst.MessageType.EOS);pipeline.set_state(Gst.State.NULL)
assert message and message.type==Gst.MessageType.EOS
request={'protocol':'bili-record2k.gpu-scene-render/v1','backend':'cuda-gstreamer','input':{'path':str(src),'startTime':0,'duration':4,'decoder':'gstreamer-nvv4l2','sourceFrameRate':'30/1'},'output':{'path':str(out),'container':'mkv','codec':'hevc_nvv4l2','width':640,'height':360,'fps':30,'pixelFormat':'nv12'},'scene':{'canvas':{'width':640,'height':360,'fps':30},'duration':4,'objects':[{'id':'late-text','type':'Text','start':3.2,'end':3.5,'frame':{'x':20,'y':20,'width':400,'height':70},'props':{'text':'时间戳测试','fontSize':42,'fontFamily':'Noto Sans CJK SC'},'style':{'fill':'#ffffff'}}]}}
p=stage/'clock-gap-request.json';p.write_text(json.dumps(request));env=dict(os.environ)
result=subprocess.run(['python3',os.environ.get('BR2K_JETSON_NVMM_HELPER', '/usr/lib/bili-record-2k/bin/br2k-scene-gpu'),'--native-scene-request',str(p)],env=env,capture_output=True,text=True,timeout=90)
(stage/'clock-gap-before.log').write_text(result.stdout+'\n'+result.stderr);assert result.returncode==0,result.stderr[-2000:]
pixels=stage/'clock-gap-before.rgb';subprocess.run([os.environ.get('BR2K_SCENE_CONFORMANCE_FFMPEG', '/usr/lib/bili-record-2k/bin/ffmpeg-full'),'-hide_banner','-loglevel','error','-y','-c:v','hevc','-ss','3.3','-i',str(out),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',str(pixels)],check=True)
data=pixels.read_bytes();assert len(data)==640*360*3;white=sum(min(data[i:i+3])>180 for i in range(0,len(data),3));print(json.dumps({'whiteGlyphPixels':white,'shouldContainText':True,'ok':white>20}),flush=True)

assert white>20, 'Gap timeline lost the expected Chinese danmaku at PTS 3.3s'
shutil.rmtree(stage)
