'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { parseFfmpegInputProtocols } = require('../src/server/shared/helpers.cjs');

test('ARM64 bundled FFmpeg can ingest HTTPS live streams', async t => {
  if (process.env.BR2K_ARM64_FONT_TEST !== '1') return t.skip('需要实际 ARM64 打包 FFmpeg');
  const executable = process.env.BR2K_FONT_TEST_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-protocols'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk.toString(); });
    child.stderr.on('data', chunk => { text += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`FFmpeg 协议探测退出码 ${code}`)));
  });
  assert(parseFfmpegInputProtocols(output).has('https'), '打包 FFmpeg 缺少 HTTPS 输入协议');
});
test('ARM64 FFmpeg drawtext preserves complete UTF-8 Chinese and Latin text', async t => {
  if (process.env.BR2K_ARM64_FONT_TEST !== '1') return t.skip('需要实际 ARM64 打包 FFmpeg');
  const executable = process.env.BR2K_FONT_TEST_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const args = ['-hide_banner','-loglevel','debug','-f','lavfi','-i',
    "color=s=640x100:d=0.1,drawtext=font='Noto Sans CJK SC':fontfile='Noto Sans CJK SC\\:style=Bold':text='咕咕嘎嘎大笑ABCDEFG':fontsize=38",
    '-frames:v','1','-f','null','-'];
  const result = await new Promise((resolve,reject) => {
    const child=spawn(executable,args,{stdio:['ignore','ignore','pipe']});let stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),10000);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-128*1024);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stderr});});
  });
  assert.equal(result.code,0,result.stderr);
  const glyphCounts=[...result.stderr.matchAll(/glyphs count:\s*(\d+)/g)].map(match=>Number(match[1]));
  assert(glyphCounts.length && glyphCounts.every(count=>count===13),result.stderr);
  assert.match(result.stderr,/Using .*NotoSansCJK-Bold\.ttc/);
});
