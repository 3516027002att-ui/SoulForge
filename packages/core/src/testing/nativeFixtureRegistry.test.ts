import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {materializeFixedNativeFixture,fixedFixtureNumber,assertFixedInstructionDistribution} from './nativeFixtureRegistry.js';

test('fixed correctness input is copied from verified bytes and drift/missing data stay unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-fixed-corpus-'));const source=join(root,'input');const output=join(root,'owned');const manifestPath=join(root,'manifest.json');
 const bytes=Buffer.from('manual tiny corpus');
 const fixture={role:'tiny',relativePath:'input',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,expected:{instructionCount:3}};
 try{
  await writeFile(source,bytes);await writeFile(manifestPath,JSON.stringify({correctnessFixtures:{schemaVersion:'1.0.0',version:'manual-tiny-v1',fixtures:[fixture]}}));
  const initial=await materializeFixedNativeFixture('tiny',output,undefined,{manifestPath,fixtureRoot:root});
  assert.equal(initial.status,'available');if(initial.status!=='available')return;
  assert.equal(fixedFixtureNumber(initial.fixture,'instructionCount'),3);assert.deepEqual(await readFile(initial.path),bytes);
  const changed=Buffer.from(bytes);changed[0]=(changed[0]??0)^1;await writeFile(source,changed);
  const drift=await materializeFixedNativeFixture('tiny',output,undefined,{manifestPath,fixtureRoot:root});assert.equal(drift.status,'unavailable');if(drift.status==='unavailable')assert.equal(drift.code,'FIXED_CORPUS_HASH_MISMATCH');
  assert.deepEqual(await readFile(initial.path),bytes,'verified owned snapshot cannot drift with the live source');
  await writeFile(source,Buffer.alloc(1_000_000));assert.equal((await materializeFixedNativeFixture('tiny',output,undefined,{manifestPath,fixtureRoot:root})).status,'unavailable');
  await rm(source);assert.equal((await materializeFixedNativeFixture('tiny',output,undefined,{manifestPath,fixtureRoot:root})).status,'unavailable');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pinned external distributions reject dropped or relabelled instructions even with equal totals',()=>{
 const fixture={role:'manual',relativePath:'input',sha256:'0'.repeat(64),byteLength:1,expected:{distribution:[{bank:0,id:0,count:2},{bank:2000,id:0,count:3}]}};
 assert.doesNotThrow(()=>assertFixedInstructionDistribution(fixture,[{bank:2000,id:0,count:3},{bank:0,id:0,count:2}]));
 assert.throws(()=>assertFixedInstructionDistribution(fixture,[{bank:0,id:0,count:1},{bank:2000,id:0,count:4}]),/FIXED_CORPUS_DISTRIBUTION_MISMATCH/);
 assert.throws(()=>assertFixedInstructionDistribution(fixture,[{bank:0,id:0,count:2},{bank:2000,id:1,count:3}]),/FIXED_CORPUS_DISTRIBUTION_MISMATCH/);
});
