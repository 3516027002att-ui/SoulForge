import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distinctTaeFixture } from './tae-native-fixture-helpers.mjs';

test('a real replacement after native read cannot stamp old TAE events with the replacement file hash', async () => {
 const root=await mkdtemp(join(tmpdir(),'sf-tae-native-race-')); const source=join(root,'c0000.tae'); const {bytes,expected}=distinctTaeFixture();
 const originalHash=createHash('sha256').update(bytes).digest('hex');await writeFile(source,bytes);await mkdir(join(root,'.storage'));
 const callback=Symbol.for('sf.tae.native-race'); let replaced=false;
 globalThis[callback]=async(input,result)=>{if(!replaced&&input.filePath===source&&input.commandOptions?.animId===400000){replaced=true;const replacement=Buffer.from(bytes);replacement.writeFloatLE(99,expected[0].time);await writeFile(source,replacement);}return result;};
 const actual=new URL('../packages/core/dist/bridge/runBridge.js',import.meta.url).href;
 const hooks=registerHooks({resolve(specifier,context,next){return specifier==='../bridge/runBridge.js'&&context.parentURL?.includes('/editing/taeEdit.js')?{url:'sf:tae-native-race-transport',shortCircuit:true}:next(specifier,context);},load(url,context,next){return url==='sf:tae-native-race-transport'?{format:'module',shortCircuit:true,source:`import {runBridge as original} from ${JSON.stringify(actual)};export async function runBridge(input){return globalThis[Symbol.for('sf.tae.native-race')](input,await original(input));}`}:next(url,context);}});
 try {
  const {createDefaultToolRegistry}=await import('../packages/core/dist/ai/toolRegistry.js');const {openWorkspaceSession}=await import('../packages/core/dist/workspace/workspaceSession.js');const {WorkspaceIndex}=await import('../packages/core/dist/indexing/workspaceIndex.js');
  const session=await openWorkspaceSession({overlayRoot:root,game:'sekiro'});const index=new WorkspaceIndex(session.meta.workspaceId);
  const result=await createDefaultToolRegistry().run('read_tae_events',{file:source,addresses:['c0000#A400000'],pageSize:7},{workspaceIndex:index,mode:'plan',session,backupBaseDir:join(root,'.storage/backups')});
  assert.equal(replaced,true,'the replacement must occur between real native projection and index publication');
  if(result.ok){const published=index.toSymbolBundle().tae[0];assert.equal(published.outerFileHash,originalHash,'old events retain their native snapshot hash');assert.equal(published.animations[0].events[0].startTime,0);}
  else assert.equal(result.error.code,'TAE_SOURCE_VERSION_CHANGED');
 }finally{hooks.deregister();delete globalThis[callback];const{disposeBridgeDaemonPool}=await import(actual);await disposeBridgeDaemonPool();await rm(root,{recursive:true,force:true});}
});

test('an A-to-B-to-A replacement cannot authorize B event ordinals with an A continuation receipt', async () => {
 const root=await mkdtemp(join(tmpdir(),'sf-tae-aba-'));const source=join(root,'c0000.tae');const {bytes,expected}=distinctTaeFixture();
 const hashA=createHash('sha256').update(bytes).digest('hex');const bytesB=Buffer.from(bytes);bytesB.writeFloatLE(99,expected[0].time);await writeFile(source,bytesB);await mkdir(join(root,'.storage'));
 let restored=false;const callback=Symbol.for('sf.tae.native-race');globalThis[callback]=async(input,result)=>{if(input.filePath===source&&input.commandOptions?.animId===400000){restored=true;await writeFile(source,bytes);}return result;};
 const actual=new URL('../packages/core/dist/bridge/runBridge.js',import.meta.url).href;
 const hooks=registerHooks({resolve(specifier,context,next){return specifier==='../bridge/runBridge.js'&&context.parentURL?.includes('/editing/taeEdit.js')?{url:'sf:tae-native-race-transport',shortCircuit:true}:next(specifier,context);},load(url,context,next){return url==='sf:tae-native-race-transport'?{format:'module',shortCircuit:true,source:`import {runBridge as original} from ${JSON.stringify(actual)};export async function runBridge(input){return globalThis[Symbol.for('sf.tae.native-race')](input,await original(input));}`}:next(url,context);}});
 try {
  const {createDefaultToolRegistry}=await import('../packages/core/dist/ai/toolRegistry.js');const {openWorkspaceSession}=await import('../packages/core/dist/workspace/workspaceSession.js');const {WorkspaceIndex}=await import('../packages/core/dist/indexing/workspaceIndex.js');
  const session=await openWorkspaceSession({overlayRoot:root,game:'sekiro'});
  const result=await createDefaultToolRegistry().run('read_tae_events',{file:source,addresses:['c0000#A400000'],offset:0,pageSize:7,expectedSourceHash:hashA,expectedReaderSchemaRevision:2},{workspaceIndex:new WorkspaceIndex(session.meta.workspaceId),mode:'plan',session,backupBaseDir:join(root,'.storage/backups')});
  assert.equal(restored,true);assert.deepEqual(await readFile(source),bytes,'physical bytes are A when the continuation receipt is checked');
  assert.equal(result.ok,false,'native B projection cannot use an A continuation receipt');assert.equal(result.error.code,'TAE_SOURCE_VERSION_CHANGED');
 }finally{hooks.deregister();delete globalThis[callback];const{disposeBridgeDaemonPool}=await import(actual);await disposeBridgeDaemonPool();await rm(root,{recursive:true,force:true});}
});
