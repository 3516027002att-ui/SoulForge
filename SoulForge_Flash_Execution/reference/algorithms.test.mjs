import test from 'node:test';
import assert from 'node:assert/strict';
import {stableJson} from './common.mjs';
import {entityFieldAddress,patchEntityId,rejectRegionScale,remapReferences,queryMapIntersection,resolveAllTargets} from './native-layout.mjs';
import {simulateRows,verifyRows} from './rows.mjs';
import {BytePatchPlan} from './intervals.mjs';
import {normalizeScope,eligible,topK,compareRanked,cosine,fuseRrf,adjacency,expandWithinLimit} from './retrieval.mjs';
import {evidenceKey,evidenceResourceKey,utf8Prefix,chooseEvidence} from './evidence.mjs';
import {effectsConflict,runScheduled,classifyRecovery,completion} from './runtime.mjs';
import {validateClaimDag,invalidateClaims,mergeGeneration,sourceScopeKey} from './wiki.mjs';
import {ByteLru,SingleFlight} from './cache.mjs';
import {identity,multiply,inverse,changeBasis,point,normal,triangleAfterBasis,hasShear} from './scene.mjs';
import {BoundedLines} from './framing.mjs';
const bad=(fn,code)=>assert.throws(fn,e=>e.code===code||e.message===code);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(family){const bytes=Buffer.alloc(768),start=32,pointer=family==='part'?0x60:0x50,inner=family==='part'?0:4;
 bytes.writeInt32LE(7,start+12);bytes.writeBigInt64LE(320n, start+pointer);bytes.writeInt32LE(1000,start+320+inner);return{bytes,start,address:start+320+inner,pointer};}
for(const family of ['part','region']){
 test(`T01/T02 ${family}: independent address, internal ID and other bytes preserved`,()=>{
  const f=fixture(family),{result}=patchEntityId(f.bytes,f.start,family,2000);
  assert.equal(result.readInt32LE(f.address),2000);assert.equal(result.readInt32LE(f.start+12),7);
  for(let i=0;i<result.length;i++)if(i<f.address||i>=f.address+4)assert.equal(result[i],f.bytes[i]);
  assert.equal(f.bytes.readInt32LE(f.address),1000);
 });
 for(const relative of [0n,-1n,9007199254740993n,321n])test(`${family} rejects pointer ${relative}`,()=>{
  const f=fixture(family);f.bytes.writeBigInt64LE(relative,f.start+f.pointer);
  assert.throws(()=>entityFieldAddress(f.bytes,f.start,family));
 });
}
for(const field of ['scale','scaleX','scaleY','scaleZ','scaleMultiplier','scaleDelta'])test(`T03 rejects region ${field}, including null/identity values`,()=>bad(()=>rejectRegionScale({family:'region',[field]:null}),'MSB_REGION_SCALE_UNSUPPORTED'));
test('T03 part scale remains permitted',()=>rejectRegionScale({family:'part',scale:[1,1,1]}));
test('T05 remaps kept target identity after first deletion',()=>assert.deepEqual(remapReferences(3,[0],[{value:1}],{complete:true}).rewritten,[{value:0}]));
test('T06 referenced deletion default reject',()=>bad(()=>remapReferences(3,[1],[{value:1}],{complete:true}),'DELETE_REFERENCED_TARGET'));
test('T06 explicit nullable clearing',()=>assert.equal(remapReferences(3,[1],[{value:1,nullable:true,onDelete:'clear'}],{complete:true}).rewritten[0].value,-1));
test('T06 empty edge list is not coverage',()=>bad(()=>remapReferences(3,[1],[]),'REFERENCE_COVERAGE_INCOMPLETE'));
test('T06 duplicate deletion rejected',()=>bad(()=>remapReferences(3,[1,1],[],{complete:true}),'DUPLICATE_DELETE'));
test('T07 invalid target aborts before any work',()=>bad(()=>resolveAllTargets(['a','bad'],id=>id==='a'?{key:'a'}:null),'TARGET_NOT_FOUND_OR_AMBIGUOUS'));
test('T08 aliases resolving same target rejected',()=>bad(()=>resolveAllTargets(['name','handle'],()=>({key:'a'})),'TARGET_DUPLICATE'));
test('T09 query AND semantics',()=>assert.deepEqual(queryMapIntersection([{name:'a',modelName:'tree',entityId:1},{name:'b',modelName:'tree',entityId:2}],{modelName:'tree',entityId:2}).map(x=>x.name),['b']));
const rows=()=>[0,1,2].map(i=>({handle:`h${i}`,id:i===2?1:i,name:`n${i}`,data:Buffer.from([i])}));
const op=(kind,h,extra={})=>({kind,handle:`h${h}`,expectedId:h===2?1:h,expectedData:Buffer.from([h]),...extra});
test('T15 delete first, modify subsequent immutable handle',()=>{
 const s=rows(),x=simulateRows(s,[op('delete',0),op('update',2,{data:Buffer.from([9])})],1);
 assert.deepEqual(x.finalRows.map(r=>[r.handle,r.data[0]]),[['h1',1],['h2',9]]);assert.equal(s[2].data[0],2);
});
test('T16 two updates verify only final value',()=>{
 const x=simulateRows(rows(),[op('update',1,{data:Buffer.from([8])}),op('update',1,{data:Buffer.from([9])})],1);assert.equal(x.finalRows[1].data[0],9);
 assert.equal(verifyRows(x.finalRows,x.finalRows.map(r=>({...r,data:Buffer.from(r.data)}))),true);
});
test('T14 injected no-delete output is rejected',()=>bad(()=>verifyRows(simulateRows(rows(),[op('delete',1)],1).finalRows,rows()),'ROW_COUNT_POSTCONDITION'));
test('T17 injected old name is rejected',()=>bad(()=>verifyRows(simulateRows(rows(),[op('update',1,{name:'新名称'})],1).finalRows,rows()),'ROW_NAME_POSTCONDITION'));
test('T17 explicit null and empty are distinct',()=>{assert.equal(simulateRows(rows(),[op('update',1,{name:null})],1).finalRows[1].name,null);assert.equal(simulateRows(rows(),[op('update',1,{name:''})],1).finalRows[1].name,'');});
test('T15 update after delete is rejected',()=>bad(()=>simulateRows(rows(),[op('delete',1),op('update',1)],1),'TARGET_ALREADY_DELETED'));
test('T13 add occupied ID is rejected',()=>bad(()=>simulateRows(rows(),[{kind:'add',handle:'new',id:1,data:Buffer.from([3]),name:null}],1),'ADD_ID_OCCUPIED'));
test('T18 row width mismatch is rejected',()=>bad(()=>simulateRows(rows(),[op('update',1,{data:Buffer.from([1,2])})],1),'ROW_WIDTH'));
test('T29 interval storage grows by changed bytes, not m*B',()=>{
 const p=new BytePatchPlan(Buffer.alloc(1024*1024));for(let i=0;i<100;i++)p.write(i*4,Buffer.from([1,2,3,4]));
 assert.equal(p.retainedBytes(),1024*1024+400);p.verifyUntouched(p.materialize());
});
test('T29 overlapping writes use final operation',()=>{const p=new BytePatchPlan(Buffer.alloc(8));p.write(1,Buffer.from([1,2,3]));p.write(2,Buffer.from([9,9]));assert.deepEqual([...p.materialize()],[0,1,9,9,0,0,0,0]);});
test('T29 append can be updated without whole-file snapshot',()=>{const p=new BytePatchPlan(Buffer.from([1,2]));const offset=p.append(Buffer.from([3,4]));p.write(offset,Buffer.from([8]));assert.deepEqual([...p.materialize()],[1,2,8,4]);});
test('T29 unmodified range corruption detected',()=>{const p=new BytePatchPlan(Buffer.alloc(10));p.write(2,Buffer.from([1]));const out=p.materialize();out[8]=9;bad(()=>p.verifyUntouched(out),'UNTOUCHED_CHANGED');});
test('T29 out of range rejected before output',()=>bad(()=>new BytePatchPlan(Buffer.alloc(4)).write(3,Buffer.alloc(2)),'WRITE_OOB'));
let seed=43;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(const size of [0,1,2,7,64,1024])for(const k of [0,1,5,32])test(`TopK differential n=${size} k=${k}`,()=>{
 const items=Array.from({length:size},(_,i)=>({id:`id${i}`,score:Math.floor(random()*20)}));assert.deepEqual(topK(items,k),[...items].sort(compareRanked).slice(0,k));
});
test('vector dimension mismatch rejected',()=>bad(()=>cosine([1,0],[1]),'VECTOR_DIMENSION'));
test('vector zero norm rejected',()=>bad(()=>cosine([0,0],[1,0]),'VECTOR_NORM'));
test('cosine known basis',()=>{assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([1,0],[0,1]),0);});
const chunks=[{id:'p',workspaceId:'w',family:'param',revision:'r'},{id:'m',workspaceId:'w',family:'map',revision:'r'},{id:'foreign',workspaceId:'other',family:'param',revision:'r'}];
const scope=()=>normalizeScope({workspaceId:'w',families:['param'],revision:'r'},['param','map']);
test('T43 vector rank-one outsider does not enter RRF',()=>assert.deepEqual(fuseRrf(chunks,['p'],['m','foreign','p'],scope(),2).map(c=>c.id),['p']));
test('T43 explicit empty filter rejected, not broadened',()=>bad(()=>normalizeScope({workspaceId:'w',families:[]},['param']),'INVALID_FAMILY_FILTER'));
test('T43 stale chunk excluded',()=>assert.equal(eligible({...chunks[0],stale:true},scope()),false));
test('T44 full primary never gets limit+1',()=>assert.equal(expandWithinLimit([chunks[0]],new Map(chunks.map(c=>[c.id,c])),adjacency([{from:'p',to:'m',kind:'ref'}]),scope(),1).length,1));
test('T43 expansion respects hard scope',()=>assert.equal(expandWithinLimit([chunks[0]],new Map(chunks.map(c=>[c.id,c])),adjacency([{from:'p',to:'m',kind:'ref'}]),scope(),2).length,1));
const ident=(outer='a',workspace='w')=>({workspaceId:workspace,outerId:outer,childChain:['entry0'],domain:'param',namespace:'Table',objectKey:'row7',claimKey:'field1'});
test('T46 same object ID in different resources remains separate',()=>assert.notEqual(evidenceKey(ident('a')),evidenceKey(ident('b'))));
test('T46 workspace identity preserved',()=>assert.notEqual(evidenceKey(ident('a','w')),evidenceKey(ident('a','W'))));
test('T46 delimiter collision avoided',()=>assert.notEqual(evidenceKey({...ident(),objectKey:'a|b',claimKey:'c'}),evidenceKey({...ident(),objectKey:'a',claimKey:'b|c'})));
for(const bytes of [0,1,2,3,4,5,6,7,8,12,20])test(`T47 UTF8 prefix byte budget ${bytes}`,()=>{
 const out=utf8Prefix('中😀文abc',bytes);assert.ok(Buffer.byteLength(out)<=bytes);assert.ok(!out.includes('\uFFFD'));assert.ok('中😀文abc'.startsWith(out));
});
function evidence(i){return{identity:{...ident(),objectKey:`row${i}`},handle:`e${i}`,revision:'r',relevance:i===17?3:0,authority:3,sequence:i,text:'证据正文'};}
const brokerOptions=()=>({maxBytes:20000,maxEntries:16,currentRevisionByResource:new Map([[evidenceResourceKey(ident()),'r']])});
test('T45 seventeenth relevant evidence selected',()=>assert.ok(chooseEvidence(Array.from({length:17},(_,i)=>evidence(i+1)),brokerOptions()).selected.some(e=>e.handle==='e17')));
test('T47 serialized JSON, not just body, is budgeted',()=>{
 const o={...brokerOptions(),maxBytes:400};const x=chooseEvidence(Array.from({length:6},(_,i)=>evidence(i)),o);assert.equal(x.actualBytes,Buffer.byteLength(x.serialized));assert.ok(x.actualBytes<=400);
});
test('required evidence cannot silently vanish',()=>bad(()=>chooseEvidence([{...evidence(1),required:true,text:'中'.repeat(500)}],{...brokerOptions(),maxBytes:100}),'REQUIRED_EVIDENCE_EXCEEDS_BUDGET'));
test('T54 stale native tag cannot beat current snapshot',()=>assert.equal(chooseEvidence([{...evidence(1),revision:'old'}],brokerOptions()).selected.length,0));
test('effects use outer resource locks',()=>assert.equal(effectsConflict({reads:[],writes:['outer1']},{reads:['outer1'],writes:[]}),true));
test('independent outer resources can run together',()=>assert.equal(effectsConflict({reads:[],writes:['outer1']},{reads:[],writes:['outer2']}),false));
test('T49 thrown task does not lose sibling result',async()=>{
 const {results}=await runScheduled([{id:'a',reads:[],writes:[],run:()=>{throw new Error('bad');}},{id:'b',reads:[],writes:[],run:()=>({ok:true,value:2})}]);assert.equal(results[0].ok,false);assert.equal(results[1].value,2);
});
test('T49 explicit ok:false remains false',async()=>{const x=await runScheduled([{id:'a',reads:[],writes:[],run:()=>({ok:false,code:'DENIED'})}]);assert.equal(x.results[0].ok,false);});
test('T50 result order preserved but UI gets fast completion first',async()=>{
 const a=deferred(),b=deferred(),events=[];
 const run=runScheduled([{id:'slow',reads:[],writes:[],run:()=>a.promise},{id:'fast',reads:[],writes:[],run:()=>b.promise}],{onEnd:e=>events.push(e.id)});
 b.resolve({ok:true});await delay(0);assert.deepEqual(events,['fast']);a.resolve({ok:true});const x=await run;assert.equal(x.results.length,2);assert.deepEqual(events,['fast','slow']);
});
test('conflicting tasks serialize in emission order',async()=>{
 const a=deferred(),events=[];const run=runScheduled([{id:'a',reads:[],writes:['x'],run:()=>{events.push('a');return a.promise;}},{id:'b',reads:['x'],writes:[],run:()=>{events.push('b');return{ok:true};}}]);
 await delay(0);assert.deepEqual(events,['a']);a.resolve({ok:true});await run;assert.deepEqual(events,['a','b']);
});
test('cancelled uncooperative running task keeps slot until settlement',async()=>{
 const gate=deferred(),ctrl=new AbortController(),started=[];
 const run=runScheduled([{id:'a',reads:[],writes:[],run:()=>{started.push('a');return gate.promise;}},{id:'b',reads:[],writes:[],run:()=>{started.push('b');return{ok:true};}}],{concurrency:1,signal:ctrl.signal});
 await delay(0);ctrl.abort();await delay(0);assert.deepEqual(started,['a']);gate.resolve({ok:true});const x=await run;assert.equal(x.results[1].code,'CANCELLED_BEFORE_START');
});
test('dependency cycles rejected before side effects',async()=>{
 let started=0;await assert.rejects(()=>runScheduled([{id:'a',dependsOn:['b'],reads:[],writes:[],run:()=>started++},{id:'b',dependsOn:['a'],reads:[],writes:[],run:()=>started++}]),/DEPENDENCY_CYCLE/);assert.equal(started,0);
});
test('failed explicit dependency blocks its consumer',async()=>{const x=await runScheduled([{id:'a',reads:[],writes:[],run:()=>({ok:false})},{id:'b',dependsOn:['a'],reads:[],writes:[],run:()=>({ok:true})}]);assert.equal(x.results[1].code,'DEPENDENCY_FAILED');});
test('notification exception cannot erase tool outcome',async()=>{const x=await runScheduled([{id:'a',reads:[],writes:[],run:()=>({ok:true})}],{onEnd:()=>{throw Error('view');}});assert.equal(x.results[0].ok,true);assert.equal(x.notificationErrors.length,1);});
for(const [cur,status] of [['a','NOT_APPLIED'],['b','APPLIED'],['c','CONFLICT']])test(`T41 recovery current=${cur}`,()=>assert.equal(classifyRecovery('a','b',cur),status));
test('T52 mutation without verified transaction cannot be success',()=>assert.notEqual(completion([{id:'g',intent:'write',state:'verified',currentNativeProof:true,transactionId:'x'}],[]),'success'));
test('already-satisfied goal needs fresh proof but not dummy mutation',()=>assert.equal(completion([{id:'g',state:'already_satisfied',currentNativeProof:true}],[]),'success'));
test('T39 recovery_required dominates partial success',()=>assert.equal(completion([{id:'g',state:'already_satisfied',currentNativeProof:true}],[{id:'x',state:'recovery_required'}]),'recovery_required'));
const claims=()=>[{id:'a',dependencies:[],status:'accepted'},{id:'b',dependencies:['a'],status:'accepted'},{id:'c',dependencies:['b'],status:'accepted'},{id:'d',dependencies:[],status:'accepted'}];
test('T54 schema invalidation propagates only dependency closure',()=>assert.deepEqual(invalidateClaims(claims(),['a'],'schema'),claims().map(c=>c.id==='d'?c:{...c,status:'stale',staleReason:'schema'})));
test('claim dependency cycle rejected',()=>bad(()=>validateClaimDag([{id:'a',dependencies:['b']},{id:'b',dependencies:['a']}]),'CLAIM_DEPENDENCY_CYCLE'));
test('T56 stale generation cannot overwrite wiki',()=>bad(()=>mergeGeneration({revision:'g2',pages:[]},'g1',[]),'KNOWLEDGE_CAS_CONFLICT'));
test('T56 stale page revision rejected even in current generation',()=>bad(()=>mergeGeneration({revision:'g2',pages:[{id:'p',revision:'2'}]},'g2',[{id:'p',expectedPageRevision:'1'}]),'PAGE_CAS_CONFLICT'));
test('T54 same bytes different reader schema differ',()=>assert.notEqual(sourceScopeKey({scope:'w',sourceId:'x',contentHash:'h',readerSchemaHash:'1'}),sourceScopeKey({scope:'w',sourceId:'x',contentHash:'h',readerSchemaHash:'2'})));
test('cache evicts unpinned by bytes, not by count',()=>{const c=new ByteLru(10);c.insert('a','A',6);c.insert('b','B',6);assert.equal(c.acquire('a'),null);assert.equal(c.used,6);});
test('pinned lease is not evicted',()=>{const c=new ByteLru(10);c.insert('a','A',6);const l=c.acquire('a');bad(()=>c.insert('b','B',6),'CACHE_BUDGET_PINNED');l.release();l.release();c.insert('b','B',6);assert.equal(c.used,6);});
test('oversize cache entry rejected',()=>bad(()=>new ByteLru(10).insert('a','A',11),'CACHE_ITEM_TOO_LARGE'));
test('single-flight shares actual build',async()=>{const s=new SingleFlight(),g=deferred();let count=0;const builder=()=>{count++;return g.promise;};const a=s.join('x',builder),b=s.join('x',builder);g.resolve('done');assert.deepEqual(await Promise.all([a,b]),['done','done']);assert.equal(count,1);});
test('one subscriber cancellation preserves other build',async()=>{
 const s=new SingleFlight(),g=deferred(),c=new AbortController();let buildSignal;
 const a=s.join('x',signal=>{buildSignal=signal;return g.promise;},{signal:c.signal});const b=s.join('x',()=>{throw Error('must not start');});
 await delay(0);c.abort();await assert.rejects(a,/SUBSCRIBER_CANCELLED/);assert.equal(buildSignal.aborted,false);g.resolve(1);assert.equal(await b,1);
});
test('cancelled shared build cannot be replaced while still running',async()=>{
 const s=new SingleFlight(),g=deferred(),c=new AbortController();const a=s.join('x',()=>g.promise,{signal:c.signal});await delay(0);c.abort();await assert.rejects(a);
 await assert.rejects(s.join('x',()=>Promise.resolve('new')),/BUILD_CANCELLING/);g.resolve(1);await delay(0);assert.equal(await s.join('x',()=>2),2);
});
const close=(a,b)=>a.every((x,i)=>Math.abs(x-b[i])<1e-8);
const basis=[1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1];
const matrix=[0,-2,0,3,1,0,0,4,0,0,0.5,5,0,0,0,1];
test('scene basis round trip for nonuniform transform',()=>assert.ok(close(changeBasis(changeBasis(matrix,basis),inverse(basis)),matrix)));
test('scene transformed point commutes with basis',()=>assert.ok(close(point(changeBasis(matrix,basis),point(basis,[1,2,3])),point(basis,point(matrix,[1,2,3])))));
test('scene reflection changes winding once',()=>assert.deepEqual(triangleAfterBasis([0,1,2],basis),[0,2,1]));
test('scene inverse transpose handles nonuniform normal',()=>{const n=normal([2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],[1,1,0]);assert.ok(close(n,[1/Math.sqrt(5),2/Math.sqrt(5),0]));});
test('scene shear detected instead of silently discarded',()=>assert.equal(hasShear([1,0.5,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),true));
test('scene singular matrix rejected',()=>bad(()=>inverse(Array(16).fill(0)),'MATRIX_SINGULAR'));
for(const chunkSize of [1,2,3,4,7,100])test(`T35 fragmented UTF8 NDJSON chunks=${chunkSize}`,()=>{
 const parser=new BoundedLines(100),data=Buffer.from('中文😀\n{"x":1}\r\n'),lines=[];for(let i=0;i<data.length;i+=chunkSize)lines.push(...parser.push(data.subarray(i,i+chunkSize)));parser.end();assert.deepEqual(lines,['中文😀','{"x":1}']);assert.ok(parser.buffer.length<=100);
});
test('T35 no newline stream fails at byte budget',()=>{const p=new BoundedLines(5);p.push(Buffer.from('abcde'));bad(()=>p.push(Buffer.from('f')),'FRAME_TOO_LARGE');assert.equal(p.bytes,0);});
test('T35 incomplete EOF rejected',()=>{const p=new BoundedLines(5);p.push(Buffer.from('ab'));bad(()=>p.end(),'FRAME_MISSING_NEWLINE');});
test('T35 invalid UTF8 rejected',()=>assert.throws(()=>new BoundedLines(8).push(Buffer.from([0xff,10]))));
test('stable JSON rejects nonfinite and cycles',()=>{bad(()=>stableJson({v:Infinity}),'NONFINITE_JSON');const a={};a.self=a;bad(()=>stableJson(a),'CYCLIC_JSON');});

test('AR cache failed disposal keeps physical reservation charged',()=>{
 const c=new ByteLru(3);c.insert('a','A',3,()=>{throw new Error('dispose failed');});
 bad(()=>c.insert('b','B',3),'CACHE_DISPOSAL_INCOMPLETE');
 assert.equal(c.used,3);assert.equal(c.acquire('a'),null);assert.equal(c.acquire('b'),null);
 assert.equal(c.quarantined.size,1);assert.equal(c.disposalErrors.length,1);
});
test('AR cache can evict another resource without resurrecting quarantined one',()=>{
 const c=new ByteLru(6);c.insert('a','A',3,()=>{throw new Error('dispose');});c.insert('b','B',3);
 c.insert('c','C',3);assert.equal(c.used,6);assert.equal(c.quarantined.size,1);assert.equal(c.acquire('c').value,'C');
});
test('AR PARAM untouched rows share immutable data, updates copy',()=>{
 const s=rows(),x=simulateRows(s,[op('update',1,{data:Buffer.from([8])})],1);
 assert.equal(x.finalRows[0].data,s[0].data);assert.notEqual(x.finalRows[1].data,s[1].data);assert.equal(s[1].data[0],1);
});
test('AR ordinary add cannot disguise replacement of a deleted original ID',()=>bad(()=>simulateRows(rows(),[op('delete',0),{kind:'add',handle:'new',id:0,data:Buffer.from([8]),name:null}],1),'ADD_REQUIRES_REPLACE_ROW'));
test('AR required evidence survives authority promotion',()=>{
 const c={...evidence(1),authority:1,required:true,text:'candidate'};
 const n={...c,authority:3,required:false,sequence:100,text:'中'.repeat(1000)};
 bad(()=>chooseEvidence([c,n],{...brokerOptions(),maxBytes:400}),'REQUIRED_EVIDENCE_EXCEEDS_BUDGET');
});
test('AR conflicting current facts are not chosen by timestamp',()=>{
 const a=evidence(1),b={...a,sequence:a.sequence+1,text:'conflicting'};
 bad(()=>chooseEvidence([a,b],brokerOptions()),'CONFLICTING_CURRENT_EVIDENCE');
});
test('AR oversized tool batch rejected before side effects',async()=>{
 let executed=0;const tasks=Array.from({length:33},(_,i)=>({id:String(i),reads:[],writes:[],run:async()=>{executed++;return{ok:true};}}));
 await assert.rejects(runScheduled(tasks),e=>e.code==='TOOL_BATCH_TOO_LARGE');assert.equal(executed,0);
});

test('AR pointer cannot cross into next entry while still inside same PARAM',()=>{
 const f=fixture('part');assert.throws(()=>entityFieldAddress(f.bytes,f.start,'part',300),e=>e.code==='TARGET_OOB');
});
test('AR entity pointer cannot alias a header field',()=>{
 const f=fixture('part');f.bytes.writeBigInt64LE(12n,f.start+0x60);
 bad(()=>entityFieldAddress(f.bytes,f.start,'part'),'RELATIVE_POINTER_INVALID');
});
test('AR current versions distinguish two children of the same outer',()=>{
 const a=evidence(1),b={...evidence(2),identity:{...evidence(2).identity,childChain:['entry1']},revision:'other'};
 const currentRevisionByResource=new Map([[evidenceResourceKey(a.identity),'r'],[evidenceResourceKey(b.identity),'other']]);
 const r=chooseEvidence([a,b],{...brokerOptions(),currentRevisionByResource});assert.equal(r.selected.length,2);
});
