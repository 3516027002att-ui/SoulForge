import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {materializeCorpusSnapshot} from './verify/fixedCorpusSnapshot.mjs';
const script=fileURLToPath(new URL('./verify-corpus-manifest.mjs',import.meta.url));

test('one changed fixed corpus byte and a missing corpus are unavailable before native parsing',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-corpus-pins-'));
 try{
  const corpus=join(root,'corpus');mkdirSync(corpus);const source=join(corpus,'tiny.dcx');const bytes=Buffer.from('independently specified tiny input');
  const manifest=join(root,'manifest.json');writeFileSync(manifest,JSON.stringify({schemaVersion:'1.0.0',manifestId:'manual-tiny-v1',entryCount:1,entries:[{logicalId:'tiny',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,format:'DFLT',observedVariant:'DCX_DFLT_10000_44_9_0'}]}));
  const changed=Buffer.from(bytes);changed[0]^=1;writeFileSync(source,changed);
  const run=directory=>spawnSync(process.execPath,[script,'--manifest',manifest,directory],{encoding:'utf8',env:{...process.env,SOULFORGE_BRIDGE_PATH:join(root,'missing-bridge')}});
  const drift=run(corpus);assert.equal(drift.status,0);const report=JSON.parse(drift.stdout);assert.equal(report.status,'skipped');assert.equal(report.availability,'unavailable');assert.equal(report.code,'CORPUS_MANIFEST_INPUT_UNAVAILABLE');
  const missing=run(join(root,'absent'));assert.equal(JSON.parse(missing.stdout).code,'CORPUS_MANIFEST_ROOT_UNAVAILABLE');
  writeFileSync(source,bytes);const bridgeMissing=run(corpus);assert.equal(JSON.parse(bridgeMissing.stdout).code,'CORPUS_MANIFEST_BRIDGE_UNAVAILABLE');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('native classification receives a bounded verified snapshot and later source drift cannot change it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-corpus-snapshot-'));
 try{
  const source=join(root,'tiny.dcx');const bytes=Buffer.from('manually pinned corpus snapshot');
  writeFileSync(source,bytes);const pin={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const snapshot=await materializeCorpusSnapshot(source,pin,join(root,'owned'));
  assert.equal(snapshot.status,'available');assert.notEqual(snapshot.path,source);
  writeFileSync(source,Buffer.from('source changed after verification'));
  assert.deepEqual(readFileSync(snapshot.path),bytes);
  assert.equal((await materializeCorpusSnapshot(source,pin,join(root,'next'))).status,'unavailable');
 }finally{rmSync(root,{recursive:true,force:true});}
});
