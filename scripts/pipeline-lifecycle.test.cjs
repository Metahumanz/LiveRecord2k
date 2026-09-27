const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const {BufferedJsonlWriter} = require('../src/server/recording/jsonl-writer.cjs');
const {LiveRecordService} = require('../src/server/app/service.cjs');
const {runCapturedProcess} = require('../src/server/shared/helpers.cjs');

function app() {
  const service = new LiveRecordService();
  service.log=()=>{}; service.emitState=()=>{}; service.saveStore=async()=>{};
  service.ffmpegPath=ffmpeg;
  service.rooms.set('1',{id:'1',realRoomId:'1',liveStatus:1,monitoring:true,autoRecord:true});
  service.fetchRoomInfo=async()=>service.rooms.get('1');
  return service;
}

test('closing a JSONL writer after an open error or an earlier close still completes', async () => {
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'br2k-writer-close-'));
  try {
    const writer=new BufferedJsonlWriter(path.join(directory,'missing','events.jsonl'));
    await new Promise(resolve=>writer.stream.once('close',resolve));
    assert(writer.failed);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('end callback hung')),500);
      writer.end(()=>{clearTimeout(timer);resolve();});
    });
  } finally {await fsp.rm(directory,{recursive:true,force:true});}
});

test('stop during delayed stream resolution prevents capture and suppresses auto-restart until offline', async () => {
  const service=app();let resolveStream;
  service.resolvePlayStream=()=>new Promise(resolve=>{resolveStream=resolve;});
  service.ensureRecordingOutputRootReady=()=>{throw new Error('cancelled start must not touch output');};
  const pending=service.startRecording('1');
  await service.stopRecording('1');
  resolveStream({url:'https://example.test/live.flv'});
  await pending;
  assert.equal(service.recordingSessions.size,0);
  assert.equal(service.recordingStartLocks.size,0);
  assert.equal(service.rooms.get('1').recordingState,'completed');
  let resolutions=0; service.resolvePlayStream=async()=>{resolutions++;throw new Error('not live fixture');};
  await service.startRecording('1',true);
  assert.equal(resolutions,0);
  await service.applyDetectedLiveStatus(service.rooms.get('1'),0,'test');
  assert.equal(service.rooms.get('1').recordingManuallyStopped,false);
});

test('next segment capture starts before waiting for old sidecar drain', async () => {
  const service=app(); const room=service.rooms.get('1'); let nextStarted=false;let drainStarted=false;
  let drain;
  const session={startedAt:Date.now()-5000,rotating:true,stopping:false,finished:false,cleanPath:'old.clean.mp4',
    eventStream:{end:callback=>{drainStarted=true;drain=callback;}},lastMediaOutTimeSec:5,firstMediaOutTimeSec:0};
  service.recordingSessions.set('1',session);
  service.startNextSegmentNow=async()=>{nextStarted=true;};
  service.flushAvatarCapture=async()=>{throw new Error('test drain boundary');};
  const finished=service.finishRecording('1',session,0,null);
  await new Promise(resolve=>setImmediate(resolve));
  assert(nextStarted);assert(drainStarted);
  const rejected=assert.rejects(finished,/test drain boundary/);drain();await rejected;
});

test('old export cancellation cannot affect a newer task, and idle cancel leaves no cancellation flag', async () => {
  const service=app();
  await service.cancelExportClip();assert.equal(service.exportCancelRequested,false);
  service.exportProgress={id:'new-export',status:'running'};
  await assert.rejects(service.cancelExportClip('old-export'),error=>error.code==='EXPORT_TASK_CHANGED');
  assert.equal(service.exportCancelRequested,false);
  await service.cancelExportClip('new-export');assert.equal(service.exportCancelRequested,true);
});

test('stopping between reconnect attempts releases the recording intent immediately', async () => {
  const service=app();const room=service.rooms.get('1');
  room.recordingState='reconnecting';service.reconnectPendingRooms.add('1');
  await service.stopRecording('1');
  assert.equal(service.reconnectPendingRooms.has('1'),false);
  assert.equal(service.isRoomRecording(room),false);
  assert.equal(room.recordingState,'completed');
  assert.equal(room.recordingManuallyStopped,true);
});

test('finishing an old recording retains its original title after the live room changes', () => {
  const service=app();
  service.rememberRecording({id:'1',title:'new live title',anchor:'new anchor'},
    {cleanPath:path.join(os.tmpdir(),'1_test_20260927_120000.clean.mp4'),roomTitle:'original title',anchor:'original anchor',startedAt:1});
  assert.equal(service.recordings[0].roomTitle,'original title');
  assert.equal(service.recordings[0].anchor,'original anchor');
});

test('initial capture refreshes stale title alongside stream selection, while metadata failure does not block capture', async () => {
  for (const failMetadata of [false,true]) {
    const service=app();const room=service.rooms.get('1');room.title='old title';
    service.fetchRoomInfo=async()=>{if(failMetadata)throw new Error('metadata unavailable');return {title:'new title',anchor:'current anchor'};};
    service.resolvePlayStream=async()=>({url:'https://example.test/stream'});
    service.ensureRecordingOutputRootReady=async()=>{throw new Error('test capture boundary');};
    await assert.rejects(service.startRecording('1'),/test capture boundary/);
    assert.equal(room.title,failMetadata?'old title':'new title');
  }
});

test('failed MP4 publish restores existing output and retains the source capture', async () => {
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'br2k-finalizer-'));
  const source=path.join(directory,'sample.recording.mkv');const output=path.join(directory,'sample.clean.mp4');
  const previous=Buffer.from('existing recording must survive failed publish');
  const service=app();const room=service.rooms.get('1');
  const session={capturePath:source,cleanPath:output,outputContainer:'mp4',videoInfo:{codec:'h264'}};
  const rename=fsp.rename;
  try {
    await runCapturedProcess(ffmpeg,['-hide_banner','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-t','2','-c:v','libx264','-f','matroska',source]);
    await fsp.writeFile(output,previous);const before=await fsp.readFile(source);
    fsp.rename=async(from,to)=>{
      if(String(from).endsWith('.finalizing.mp4')&&to===output)throw Object.assign(new Error('publish denied'),{code:'EACCES'});
      return rename(from,to);
    };
    assert.equal(await service.finalizeRecordingContainer(room,session),false);
    assert.deepEqual(await fsp.readFile(output),previous);
    assert.deepEqual(await fsp.readFile(source),before);
  } finally {fsp.rename=rename;await fsp.rm(directory,{recursive:true,force:true});}
});
