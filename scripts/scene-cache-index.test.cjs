'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {writeGraph,readGraphLines}=require('../src/server/danmaku/scene-graph-io.cjs');
const {clipSceneGraph}=require('../src/server/danmaku/scene-graph.cjs');
test('indexed cache retains unsorted crossing objects, UTF-8 text and referenced assets while skipping unrelated blocks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'br2k-index-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'cache.jsonl');
 const graph={schema:'bili-record2k.scene/v1',version:1,canvas:{width:1920,height:1080},timeline:{start:0,end:3000},assets:[{id:'avatar',path:'头像.png'}],objects:Array.from({length:1537},(_,i)=>({id:'t'+i,type:'Text',start:i,end:i+2,frame:{x:10,y:10,width:100,height:30},props:{text:'中文😀\n第'+i+'行'},animations:[]}))};
 graph.objects[1023]={id:'cross',type:'Avatar',start:0,end:2000,frame:{x:10,y:10,width:30,height:30},props:{assetId:'avatar'},animations:[]};
 await writeGraph(file,graph,true);let stats;const selected=await readGraphLines(file,10,12,{onReadStats:value=>stats=value});
 assert.deepEqual(selected.objects,graph.objects.filter(o=>o.end>=10&&o.start<=12));
 assert.deepEqual(clipSceneGraph(selected,10,12),clipSceneGraph(graph,10,12));
 assert(stats.indexed);assert.equal(stats.selectedBlocks,2);assert(stats.readBytes<stats.totalBytes);
 const empty=await readGraphLines(file,4000,5000);assert.deepEqual(empty.objects,[]);
 assert.deepEqual(await readGraphLines(file),graph);
 const index=JSON.parse(await fs.readFile(file+'.index.json'));index.blocks[1].offset++;await fs.writeFile(file+'.index.json',JSON.stringify(index));
 const recovered=await readGraphLines(file,10,12,{onReadStats:value=>stats=value});assert.deepEqual(recovered,selected);assert.equal(stats.indexed,false);
 await writeGraph(file,graph,true);await fs.appendFile(file,'\n');await assert.rejects(readGraphLines(file,10,12),SyntaxError);
});
test('older caches without indexes remain readable and empty graphs retain their metadata',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'br2k-index-old-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'old.jsonl');const graph={canvas:{width:20,height:20},objects:[],metadata:{text:'中文😀'}};
 await writeGraph(file,graph,true);assert.deepEqual(await readGraphLines(file,0,2),graph);await fs.rm(file+'.index.json');assert.deepEqual(await readGraphLines(file,0,2),graph);
});
