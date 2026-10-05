// Actual RAW/container/script read callbacks with owned synthetic native ports.
// No Electron, native process, game bytes or remote service is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..'),require=createRequire(import.meta.url);
const adapterPath=path.join(root,'apps/desktop/src/main/ipc/raw.ts'),servicePath=path.join(root,'apps/desktop/src/main/services/rawResourceService.ts');
const names=['readRawRange','readRawMetadata','inspectContainerTree','listContainerChildren','listContainerChildrenPage','readContainerChild','roundTripContainer','validateContainer','probeContainerCapabilities','scriptContainerEvidence','listScriptContainerEntriesPage','readScriptEntryPlaintext','readScriptSource'];
const channels=names.map(name=>`resource.${name}`),uri='resource://owned/script',hash='a'.repeat(64),childHash='b'.repeat(64);
const file={sourceUri:uri,absolutePath:'/owned/mod/script.luabnd.dcx',relativePath:'script.luabnd.dcx',compoundExtension:'.luabnd.dcx'};
const session={meta:{workspaceId:'owned'},layers:{overlayRoot:'/owned/mod',baseRoot:null}},text=Buffer.from('return 1\r\n');
const nativeEntries=[{index:0,name:'N:\\PRIVATE\\goal.lua',uncompressedSize:10,contentHash:childHash},{index:1,name:'N:\\PRIVATE\\goal.lua',uncompressedSize:10},{index:2,name:'other.hkx',uncompressedSize:5}];
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function harness(options={}){
 const calls=[],handlers=new Map(),modules=new Map();let files=options.files??[file],activeSession=options.session===undefined?session:options.session;
 const children=Array.from({length:205},(_,index)=>({childId:String(index),name:`child${index}`,offset:index,size:1,hash:childHash,formatKind:'lua',sourceContainerUri:uri,childUri:`${uri}#${index}`,rawBytesAvailable:true,canReplace:false,absolutePath:'PRIVATE'}));
 const core={
  runBridge:async input=>{calls.push(['bridge',plain(input)]);if(options.bridge)return options.bridge(input);if(input.command==='snapshot-bnd4-child')return {parseStatus:'confirmed',diagnostics:[],data:{contentBase64:(options.bytes??text).toString('base64')}};if(input.command==='read-hks-source')return {parseStatus:'confirmed',diagnostics:[],data:{sourceText:'return 2',dialect:'sekiro-hks-1.6.x',sourceHash:childHash,compiler:{package:'owned',revision:'owned'},decompiler:{package:'owned',revision:'owned'}}};return {parseStatus:'confirmed',diagnostics:[],data:{format:'DCX',nested:{format:'BND4',entryCount:3,entries:nativeEntries}}};},
  readRawResourceRange:async(readFile,offset,length)=>{calls.push(['rawRange',readFile,offset,length]);if(options.range)return options.range();return {ok:true,sourceUri:readFile.sourceUri,offset,length,fileSize:42};},
  readRawResourceMetadata:async()=>{calls.push(['metadata']);return {sourceUri:uri,absolutePath:'/owned/private',fileSize:42};},
  inspectContainerTree:async()=>{calls.push(['inspect']);return {ok:true,tree:{rootHash:hash}};},
  listContainerChildren:async()=>{calls.push(['list']);return options.fixtureListing??{ok:true,children:options.nativeFallback?[]:children,diagnostics:[]};},
  readContainerChild:async()=>{calls.push(['readChild']);return {ok:true,bytes:options.bytes??text,diagnostics:[]};},
  roundTripContainer:async()=>{calls.push(['roundTrip']);return {ok:true,byteIdentical:true,payloadEquivalent:true};},
  validateContainer:async()=>{calls.push(['validate']);return {ok:true,format:'BND4',diagnostics:[]};},
  probeContainerCapabilityOptions:async()=>{calls.push(['probe']);return {};},
  resolveResourceCapabilities:()=>({sourceUri:uri,absolutePath:'/owned/private',canRead:true}),
  buildScriptContainerEvidence:async input=>{calls.push(['evidence',plain(input)]);return {ok:true,entryCount:3};}
 };
 const shared={createDiagnostic:input=>input};
 const roots={prepareBridgeRoots:async()=>({ok:true,allowedRoots:['/owned/mod'],writableRoots:[]})};
 const diskBytes=()=>options.header??(options.nativeFallback?Buffer.from('DCX\0owned'):options.bytes??text);
 const filesystem={stat:async()=>({size:options.size??text.length}),readFile:async()=>{calls.push(['readFile']);return options.readFile?options.readFile():diskBytes();},open:async()=>{calls.push(['open']);if(options.openError)throw options.openError;return {read:async(buffer,offset,length,position)=>{const bytes=diskBytes(),bytesRead=Math.max(0,Math.min(length,options.shortRead??length,bytes.length-position));calls.push(['headerRead',length,position,bytesRead]);bytes.copy(buffer,offset,position,position+bytesRead);return {bytesRead,buffer};},close:async()=>{calls.push(['close']);}};}};
 function load(filename){if(modules.has(filename))return modules.get(filename);const built=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});assert.deepEqual((built.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error),[]);const exports={};modules.set(filename,exports);vm.runInNewContext(built.outputText,{exports,module:{exports},Error,Buffer,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder,console,require(name){if(name==='node:fs/promises')return filesystem;if(name.startsWith('node:'))return require(name);if(name==='electron')throw new Error('No Electron runtime in RAW services');if(name==='@soulforge/core')return core;if(name==='@soulforge/shared')return shared;if(name.endsWith('/bridgeRoots.js'))return roots;if(name.endsWith('/bridge/runBridge.js'))return {runBridge:core.runBridge};if(name.startsWith('.'))return load(path.resolve(path.dirname(filename),name.replace(/\.js$/,'.ts')));throw new Error(`Unexpected RAW import ${name}`);}},{filename});return exports;}
 Object.assign(shared,load(path.join(root,'packages/shared/src/path-sanitizer.ts')),load(path.join(root,'packages/shared/src/editor-pagination.ts')));
 Object.assign(core,load(path.join(root,'packages/core/src/script/plaintextScriptEntry.ts')),load(path.join(root,'packages/core/src/script/scriptContainerEvidence.ts')));
 core.buildScriptContainerEvidence=async input=>{calls.push(['evidence',plain(input)]);return {ok:true,entryCount:3};};
 core.normalizePageWindow=load(path.join(root,'packages/core/src/editing/editorCapabilityContract.ts')).normalizePageWindow;
 const deps={handle:(name,listener)=>handlers.set(name,(...args)=>{if(options.deny)throw new Error('IPC_UNTRUSTED_SENDER');return listener(...args);}),get indexedFiles(){return files;},get activeSession(){return activeSession;},durableStoragePaths:()=>({root:'/owned/storage',backupBaseDir:'/owned/backup',recoveryDir:'/owned/recovery',stagingRoot:'/owned/stage'}),bridgeRootSession:()=>({}),bridgeRootsDiagnostic:(code)=>({severity:'error',code,message:'owned'}),verifiedReadRoots:async()=>{calls.push(['roots']);return options.roots?options.roots():{allowedRoots:['/owned/mod'],diagnostics:options.rootDiagnostics??[]};},verifiedStageRoots:async()=>{calls.push(['stageRoots']);return {allowedRoots:['/owned/mod'],writableRoots:['/owned/stage'],diagnostics:options.stageDiagnostics??[]};}};
 const adapter=load(adapterPath);adapter.registerRawIpcHandlers(deps);
 return {calls,handlers,load,deps,adapter,invoke:(name,...args)=>handlers.get(`resource.${name}`)({},...args),switchSession(value){activeSession=value;},clear(){adapter.clearRawIpcCaches();}};
}

export { adapterPath, servicePath, names, channels, uri, hash, childHash, file, session, text, nativeEntries, plain, deferred, harness };
