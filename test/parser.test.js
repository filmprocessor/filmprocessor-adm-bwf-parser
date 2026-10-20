import test from 'node:test';
import assert from 'node:assert/strict';
import {parseADMBWF,probeADMBWF} from '../src/index.js';
import {wave,xml} from './fixtures.js';
for(const bits of [16,24,32]) for(const extensible of [false,true]) test(`PCM ${bits}, extensible=${extensible} preserves signed samples`,()=>{
 const result=parseADMBWF(wave({bits,extensible}));assert.deepEqual([...result.channelData[0]],[-1,0,0.5]);assert.equal(result.duration,3/48000);
});
test('IEEE float and RF64 decode without integer reinterpretation',()=>{
 assert.deepEqual([...parseADMBWF(wave({bits:32,format:3,extensible:true,rf64:true})).channelData[0]],[-1,0,0.5]);
});
test('interleaved stereo is separated into channels',()=>{
 const r=parseADMBWF(wave({channels:2,samples:[0.5,-0.5,0.25,-0.25]}));assert.deepEqual([...r.channelData[0]],[0.5,0.25]);assert.deepEqual([...r.channelData[1]],[-0.5,-0.25]);
});
test('truncated chunks and invalid formats are refused before PCM allocation',()=>{
 const good=wave();assert.throws(()=>parseADMBWF(good.slice(0,-2)),/Truncated/);
 assert.throws(()=>parseADMBWF(wave({channels:0})),/Unsupported/);
 assert.throws(()=>parseADMBWF(new ArrayBuffer(1)),/header/);
 assert.deepEqual(probeADMBWF(new ArrayBuffer(1)),{hasADM:false,channelCount:0,sampleRate:0,bitDepth:0});
});
test('ADM probing works without XML DOM and parsing requests an explicit implementation',()=>{
 const input=wave({xml});assert.equal(probeADMBWF(input).hasADM,true);
 assert.throws(()=>parseADMBWF(input,{DOMParser:null}),/DOMParser/);
});

test('an empty unknown chunk does not hide later PCM',()=>{
 const original=new Uint8Array(wave()),out=new Uint8Array(original.length+8);
 out.set(original.subarray(0,12));out.set(new TextEncoder().encode('JUNK'),12);out.set(original.subarray(12),20);
 new DataView(out.buffer).setUint32(4,out.length-8,true);
 assert.deepEqual([...parseADMBWF(out.buffer).channelData[0]],[-1,0,0.5]);
});
