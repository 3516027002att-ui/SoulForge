import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareRgba, decodePng, boxReference, expectedTpf, compareTpfMetadata, compareTpfPreview, assertProducerReceipt, extractTpfSlices, verifyTpfSourceSlices } from './compare-tpf-projection-fields.mjs';

test('raw pixel check permits only documented BC1 one-unit rounding',()=>{
  assert.equal(compareRgba(Buffer.from([10,20,30,255]),Buffer.from([11,20,30,255]),1).status,'passed');
  assert.equal(compareRgba(Buffer.from([10,20,30,255]),Buffer.from([11,20,30,255]),0).status,'failed');
  assert.equal(compareRgba(Buffer.from([10,20,30,255]),Buffer.from([12,20,30,255]),1).status,'failed');
  assert.throws(()=>compareRgba(Buffer.alloc(4),Buffer.alloc(4),2),/TOLERANCE/);
  assert.equal(compareRgba(Buffer.alloc(4),Buffer.alloc(8),1).status,'failed');
});
test('integer box reference keeps each source pixel in one footprint and floors averages',()=>{
  assert.deepEqual(boxReference(Buffer.from([0,0,0,255,10,20,30,255,20,40,60,255,31,61,91,255]),4,1,2,1),Buffer.from([5,10,15,255,25,50,75,255]));
  assert.throws(()=>boxReference(Buffer.alloc(4),1,1,2,1),/DIMENSIONS/);
});
test('PNG raw sample decode preserves values and rejects unsupported/truncated encoding',()=>{
  const chunk=(name,bytes)=>{const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);out.write(name,4);bytes.copy(out,8);return out;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,10,20,30,255]))),chunk('IEND',Buffer.alloc(0))]);
  assert.deepEqual(decodePng(png).rgba,Buffer.from([10,20,30,255]));
  assert.throws(()=>decodePng(png.subarray(0,png.length-2)),/TRUNCATED/);
});
const texture={ordinal:0,Name:'Texture',Format:0,Mipmaps:1,payloadBytes:128,dds:{width:4,height:4,fourCC:'DXT1'}};
function metadataFixture(){const raw=Buffer.alloc(16);raw.write('TPF\0');raw[13]=3;raw[14]=1;const expected=expectedTpf({platform:'PC',Flag2:3,Encoding:1,textures:[texture]},raw);expected.roundTrip={byteIdentical:true,semanticIdentical:true,sourceHash:expected.sourceHash,rebuiltHash:expected.sourceHash};const pages={textures:{textureCount:1,textures:expected.textures},summary:expected};return {expected,pages};}
test('distinct Flag2 and Encoding values detect historical native header swap at Bridge',()=>{
  const {expected,pages}=metadataFixture();assert.equal(expected.flags,3);assert.equal(expected.encoding,1);
  assert.equal(compareTpfMetadata(expected,expected,pages,expected).status,'passed');
  const wrong={...expected,encoding:3,flags:1};const r=compareTpfMetadata(expected,wrong,pages,expected);
  assert.equal(r.firstDivergentLayer,'bridge');assert.equal(r.layers.bridge.checks.encoding.status,'failed');assert.equal(r.layers.bridge.checks.flags.status,'failed');
});
test('source and producer receipt tampering fail before capture',()=>{
  const sourceHashes=Object.fromEntries(['TpfNativeDocument','DdsCodec','BridgeCommandService'].map(n=>['bridge/SoulForge.Bridge/'+n+'.cs','source']));
  const receipt={executable:{sha256:'producer'},helper:{path:'scripts/bridge-production-build.mjs',sha256:'helper'},source:{entries:Object.entries(sourceHashes).map(([path,sha256])=>({path,sha256}))}};
  assert.doesNotThrow(()=>assertProducerReceipt(receipt,'producer','helper',sourceHashes));
  assert.throws(()=>assertProducerReceipt(receipt,'wrong','helper',sourceHashes),/PRODUCER/);
  const bad=structuredClone(receipt);bad.source.entries[1].sha256='bad';assert.throws(()=>assertProducerReceipt(bad,'producer','helper',sourceHashes),/SOURCE_RECEIPT/);
});
test('preview field and pixel corruption localize to first Bridge boundary',()=>{
  const expected={name:'Texture',width:1,height:1,sourceWidth:4,sourceHeight:4,colorSpace:'linear'},reference=Buffer.from([10,20,30,255]),pixels={width:1,height:1,rgba:reference,chunks:['IHDR','IDAT','IEND']},preview={...expected,previewToken:'data:image/png;base64,eA=='},state={preview,inputData:preview,loading:false,failure:null};
  assert.equal(compareTpfPreview(expected,preview,pixels,reference,state,preview.previewToken).status,'passed');
  for(const [k,v]of [['name','Wrong'],['width',2],['colorSpace','unknown']])assert.equal(compareTpfPreview(expected,{...preview,[k]:v},pixels,reference,state,preview.previewToken).firstDivergentLayer,'bridge');
  assert.equal(compareTpfPreview(expected,preview,{...pixels,rgba:Buffer.from([50,20,30,255])},reference,state,preview.previewToken).firstDivergentLayer,'bridge');
});
test('actual compiled production input slices match source and honor failure/cancellation',{skip:!process.env.SOULFORGE_TPF_PRODUCT_ROOT},async()=>{
  const root=process.env.SOULFORGE_TPF_PRODUCT_ROOT,require=createRequire(join(root,'package.json')),ts=require('typescript'),main=await readFile(join(root,'apps/desktop/out/main/index.js'),'utf8'),dir=join(root,'apps/desktop/out/renderer/assets'),bundle=(await readdir(dir)).find(n=>/^index-.*\.js$/.test(n)),renderer=await readFile(join(dir,bundle),'utf8');
  const assetsSource=await readFile(join(root,'apps/desktop/src/main/ipc/assets.ts'),'utf8'),panelSource=await readFile(join(root,'apps/desktop/src/renderer/src/editors/TpfWorkbenchPanel.tsx'),'utf8'),sharedSource=await readFile(join(root,'packages/shared/src/tpf-editor.ts'),'utf8'),sharedCompiled=await readFile(join(root,'packages/shared/dist/tpf-editor.js'),'utf8');
  const verify=(assets=assetsSource,panel=panelSource)=>verifyTpfSourceSlices(ts,main,renderer,assets,panel,sharedSource,sharedCompiled);
  assert.equal(verify().length,6);
  assert.throws(()=>verify(assetsSource.replaceAll('if (!file)','if (+file)')),/SOURCE_COMPILED_SLICE_MISMATCH/);
  assert.throws(()=>verify(undefined,panelSource.replaceAll('if (cancelled) return','if (!cancelled) return')),/SOURCE_COMPILED_SLICE_MISMATCH/);
  const slices=extractTpfSlices(ts,main,renderer),raw={ok:true,data:{name:'Texture',previewToken:'data:image/png;base64,eA=='}};
  assert.equal(slices.consumePreview(raw).preview,raw.data);assert.equal(slices.imageSource(raw.data),raw.data.previewToken);
  assert.equal(slices.consumePreview(raw,true).preview,null);assert.equal(slices.consumePreview({ok:false,diagnostics:[{code:'FAIL',message:'failed'}]}).failure.code,'FAIL');
  const {projectTpfDocumentPages}=await import(pathToFileURL(join(root,'packages/shared/dist/tpf-editor.js')).href);const {expected}=metadataFixture();assert.equal(compareTpfMetadata(expected,expected,projectTpfDocumentPages(expected),slices.consumeDocument({ok:true,data:expected}).document).status,'passed');
});
