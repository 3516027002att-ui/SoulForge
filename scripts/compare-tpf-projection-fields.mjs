import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => hash(JSON.stringify(value) ?? 'undefined');
const NEXT = 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905';
const BCDEC = '80859ed3b7afb1c527a2a99d70c61457bea72d0c';
const equal = (expected, actual) => ({ status: isDeepStrictEqual(expected, actual) ? 'passed' : 'failed', expected, actual: actual ?? null });
const layer = (checks) => ({ status: Object.values(checks).every((v) => v.status === 'passed') ? 'passed' : 'failed', checks });
const verdict = (layers) => ({ status: Object.values(layers).every((v) => v.status === 'passed') ? 'passed' : 'failed', firstDivergentLayer: ['bridge', 'core', 'renderer'].find((name) => layers[name]?.status === 'failed') ?? null, layers });

export function compareRgba(reference, actual, tolerance) {
  if (![0, 1].includes(tolerance)) throw new Error('PIXEL_TOLERANCE_INVALID');
  if (!reference.length || reference.length % 4 || actual.length !== reference.length) return { status: 'failed', reason: 'RGBA_BYTE_LENGTH_MISMATCH' };
  let maximumChannelDelta = 0, differentChannels = 0, channelsOverTolerance = 0;
  for (let i = 0; i < reference.length; i++) {
    const d = Math.abs(reference[i] - actual[i]);
    maximumChannelDelta = Math.max(maximumChannelDelta, d); if (d) differentChannels++; if (d > tolerance) channelsOverTolerance++;
  }
  return { status: channelsOverTolerance ? 'failed' : 'passed', pixelCount: reference.length / 4, maximumChannelDelta, differentChannels, channelsOverTolerance, allowedChannelDelta: tolerance };
}

// Decode PNG sample bytes directly; no color conversion, display/GPU, or sharp defaults.
export function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG_SIGNATURE_INVALID');
  const chunks = [], idat = []; let width, height;
  for (let at = 8; at < png.length;) {
    const n = png.readUInt32BE(at), name = png.toString('ascii', at + 4, at + 8), bytes = png.subarray(at + 8, at + 8 + n);
    if (at + 12 + n > png.length) throw new Error('PNG_CHUNK_TRUNCATED');
    chunks.push(name); if (name === 'IDAT') idat.push(bytes);
    if (name === 'IHDR') { width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4); if (bytes[8] !== 8 || bytes[9] !== 6 || bytes[10] || bytes[11] || bytes[12]) throw new Error('PNG_REQUIRES_RGBA8_NONINTERLACED'); }
    at += n + 12;
  }
  if (!width || !height || width * height > 16_000_000) throw new Error('PNG_DIMENSIONS_INVALID');
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, rgba = Buffer.alloc(stride * height);
  if (raw.length !== (stride + 1) * height) throw new Error('PNG_SCANLINE_BYTES_INVALID');
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p-a), db = Math.abs(p-b), dc = Math.abs(p-c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const at = y * stride + x, filter = raw[y * (stride + 1)], a = x < 4 ? 0 : rgba[at - 4], b = y ? rgba[at - stride] : 0, c = y && x >= 4 ? rgba[at - stride - 4] : 0;
    if (filter > 4) throw new Error('PNG_FILTER_UNSUPPORTED');
    rgba[at] = (raw[y * (stride + 1) + 1 + x] + [0, a, b, Math.floor((a+b)/2), paeth(a,b,c)][filter]) & 255;
  }
  return { width, height, rgba, chunks };
}

// Independently specified integer source footprints and floor(channel sum/count).
export function boxReference(rgba, sw, sh, tw, th) {
  if (rgba.length !== sw * sh * 4 || tw < 1 || th < 1 || tw > sw || th > sh) throw new Error('BOX_REFERENCE_DIMENSIONS_INVALID');
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const x0 = Math.floor(x * sw / tw), x1 = Math.floor((x+1) * sw / tw), y0 = Math.floor(y * sh / th), y1 = Math.floor((y+1) * sh / th), count = (x1-x0)*(y1-y0), sums = [0,0,0,0];
    for (let sy=y0; sy<y1; sy++) for (let sx=x0; sx<x1; sx++) for (let c=0; c<4; c++) sums[c] += rgba[(sy*sw+sx)*4+c];
    for (let c=0; c<4; c++) out[(y*tw+x)*4+c] = Math.floor(sums[c]/count);
  }
  return out;
}

export function expectedTpf(fields, raw) {
  if (fields.platform !== 'PC' || raw.toString('ascii',0,4) !== 'TPF\0' || raw[12] !== 0 || raw[13] !== fields.Flag2 || raw[14] !== fields.Encoding) throw new Error('ORACLE_TPF_HEADER_INVALID');
  return {
    format: 'TPF', sourceSize: raw.length, sourceHash: hash(raw), textureCount: fields.textures.length,
    dataLength: raw.readUInt32LE(4), platform: 0, encoding: fields.Encoding, flags: fields.Flag2,
    textures: fields.textures.map((t) => ({ index: t.ordinal, name: t.Name, formatByte: t.Format, mipCount: t.Mipmaps, dataSize: t.payloadBytes, width: t.dds.width, height: t.dds.height, ddsFourCC: t.dds.fourCC }))
  };
}

export function compareTpfMetadata(expected, document, pages, rendererDocument, ipcDocument = document) {
  const checks = (doc) => Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, key === 'textures' ? equal(value, doc?.textures?.map((t) => Object.fromEntries(Object.keys(value[0]).map((k) => [k,t[k]])))) : equal(value,doc?.[key])]));
  const bridge = layer({...checks(document),roundTripByteIdentical:equal(true,document?.roundTrip?.byteIdentical),roundTripSemanticIdentical:equal(true,document?.roundTrip?.semanticIdentical),roundTripSourceHash:equal(expected.sourceHash,document?.roundTrip?.sourceHash),roundTripRebuiltHash:equal(expected.sourceHash,document?.roundTrip?.rebuiltHash)});
  const core = layer(checks(ipcDocument));
  const sharedPages = layer({ textures: equal(expected.textures, pages?.textures?.textures?.map((t) => Object.fromEntries(Object.keys(expected.textures[0]).map((k) => [k,t[k]])))), textureCount: equal(expected.textureCount,pages?.textures?.textureCount), ...Object.fromEntries(['sourceSize','sourceHash','dataLength','platform','encoding','flags'].map((k) => [k,equal(expected[k],pages?.summary?.[k])])) });
  return {...verdict({ bridge, core, renderer: layer(checks(rendererDocument)) }),supplemental:{sharedPages:{...sharedPages,role:'Separately executed shared pure API; not a hop in the actual TpfWorkbenchPanel DTO path'}}};
}

export function compareTpfPreview(expected, preview, pixels, reference, rendererState, imgSource) {
  const bridge = layer({ ...Object.fromEntries(Object.entries(expected).map(([k,v]) => [k,equal(v,preview?.[k])])),pngDataUri:equal(true,preview?.previewToken?.startsWith('data:image/png;base64,')), pngWidth: equal(expected.width,pixels.width), pngHeight: equal(expected.height,pixels.height), pixels: compareRgba(reference,pixels.rgba,expected.colorSpace === 'linear' ? 0 : 1), colorChunks: equal([],pixels.chunks.filter((n) => ['sRGB','gAMA','cHRM'].includes(n))) });
  const renderer = layer({ dataPreserved: equal(digest(preview),digest(rendererState.preview)), loading: equal(false,rendererState.loading), failure: equal(null,rendererState.failure), imgSrc: equal(hash(preview?.previewToken??''),hash(imgSource??'')) });
  return verdict({ bridge, core: layer({dtoPassThrough:equal(digest(preview),digest(rendererState.inputData))}), renderer });
}

export function assertProducerReceipt(receipt, producerSha256, helperSha256, sourceHashes) {
  if (receipt.executable?.sha256 !== producerSha256) throw new Error('BRIDGE_PUBLISHED_PRODUCER_MISMATCH');
  if (receipt.helper?.path !== 'scripts/bridge-production-build.mjs' || receipt.helper.sha256 !== helperSha256) throw new Error('BRIDGE_BUILD_HELPER_MISMATCH');
  for (const path of ['bridge/SoulForge.Bridge/TpfNativeDocument.cs','bridge/SoulForge.Bridge/DdsCodec.cs','bridge/SoulForge.Bridge/BridgeCommandService.cs']) {
    const item = receipt.source?.entries?.find((e) => e.path === path);
    if (!item || item.sha256 !== sourceHashes[path]) throw new Error(`BRIDGE_SOURCE_RECEIPT_MISMATCH:${path}`);
  }
}

function ast(ts,text,path) { const source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS); const nodes=[]; const visit=(node)=>{ nodes.push(node); ts.forEachChild(node,visit); }; visit(source); return {source,nodes,text}; }
function one(values,label) { if(values.length!==1) throw new Error(`COMPILED_SLICE_NOT_UNIQUE:${label}:${values.length}`); return values[0]; }
function slice(tree,node) { return tree.text.slice(node.getStart(tree.source),node.end); }
function callback(ts,tree,method) { return one(tree.nodes.filter((n)=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='then'&&ts.isCallExpression(n.expression.expression)&&ts.isPropertyAccessExpression(n.expression.expression.expression)&&n.expression.expression.expression.name.text===method),'then:'+method).arguments[0]; }
function handler(ts,tree,event) { return one(tree.nodes.filter((n)=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='handle'&&n.arguments[0]?.text===event),'ipc:'+event).arguments[1]; }
function imageSrc(ts,tree) { const panel=one(tree.source.statements.filter((n)=>ts.isFunctionDeclaration(n)&&n.name?.text==='TpfWorkbenchPanel'),'TpfWorkbenchPanel'); const panelTree=ast(ts,slice(tree,panel),'panel.js'); return one(panelTree.nodes.filter((n)=>ts.isPropertyAssignment(n)&&n.name.getText(panelTree.source)==='src'&&n.initializer.getText(panelTree.source)==='preview.previewToken'),'img.src').initializer.getText(panelTree.source); }

export function extractTpfSlices(ts,mainText,rendererText) {
  const main=ast(ts,mainText,'main.js'), renderer=ast(ts,rendererText,'renderer.js');
  const doc=callback(ts,renderer,'readTpfDocument'), preview=callback(ts,renderer,'readTpfTexturePreview'), img=imageSrc(ts,renderer);
  const handlers=['resource.readTpfDocument','resource.readTpfTexturePreview'].map((name)=>({name,code:slice(main,handler(ts,main,name))}));
  const sanitizerNames=['sanitizeRendererValue','sanitizeRendererString'];
  const sanitizerCode=sanitizerNames.map((name)=>slice(main,one(main.source.statements.filter((n)=>ts.isFunctionDeclaration(n)&&n.name?.text===name),name)));
  for(const name of ['SOURCE_TEXT_KEYS','SENSITIVE_PATH_KEYS']) sanitizerCode.unshift(slice(main,one(main.source.statements.filter((n)=>ts.isVariableStatement(n)&&n.declarationList.declarations.some((d)=>d.name.getText(main.source)===name)),name)));
  const documentCode=slice(renderer,doc), previewCode=slice(renderer,preview);
  return {
    createSanitizer: (maskPathFragments)=>new Function('maskPathFragments',sanitizerCode.join('\n')+'\nreturn sanitizeRendererValue;')(maskPathFragments),
    createHandler: (event,deps,runBridge,dirname,sanitizeRendererValue)=>new Function('deps','runBridge$5','dirname','sanitizeRendererValue',`return (${handlers.find((v)=>v.name===event).code});`)(deps,runBridge,dirname,sanitizeRendererValue),
    consumeDocument: (raw,cancelled=false)=> { let document=null, failures=new Map(),loading=true; new Function('cancelled','selectedContainerUri','setDocument','setContainerFailures','setLoading',`return (${documentCode});`)(cancelled,'file:///workspace/tpf',v=>{document=v;},v=>{failures=typeof v==='function'?v(failures):v;},v=>{loading=v;})(raw); return {document,failures:[...failures],loading}; },
    consumePreview: (raw,cancelled=false)=> { const state={preview:null,failure:null,loading:true,inputData:raw.data}; new Function('cancelled','setPreview','setPreviewFailure','setPreviewLoading',`return (${previewCode});`)(cancelled,v=>{state.preview=v;},v=>{state.failure=v;},v=>{state.loading=v;})(raw); return state; },
    imageSource: (preview)=>new Function('preview',`return (${img});`)(preview),
    extraction: {policy:'Unchanged AST arrow callback, IPC handler, sanitizer declaration and img.src expression slices from current compiled production main/renderer outputs. Main IPC runBridge boundary replays fresh hash-bound compiled-core/native-daemon envelopes; filesystem/index/verified roots are recorded harness inputs. Setters record values. No DOM, React mount, GPU, screenshot, packaged runtime or live Electron IPC claim.', slices:[...handlers,{name:'document.then',code:documentCode},{name:'preview.then',code:previewCode},{name:'img.src',code:img},{name:'sanitizer',code:sanitizerCode.join('\n')}].map(({name,code})=>({name,sha256:hash(code),bytes:Buffer.byteLength(code)})) }
  };
}

function extractCompiledMask(ts,text) {
  const tree=ast(ts,text,'main-dependency.js'),names=['MASKED_PATH_PLACEHOLDER','WINDOWS_DRIVE_PATH','UNC_OR_DEVICE_PATH','ABSOLUTE_FILE_URI'];
  const declarations=names.map(name=>slice(tree,one(tree.source.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree.source)===name)),name)));
  declarations.push(slice(tree,one(tree.source.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='maskPathFragments'),'compiled.maskPathFragments')));
  const code=declarations.join('\n');return {maskPathFragments:new Function(code+'\nreturn maskPathFragments;')(),receipt:{name:'compiled-main-dependency.maskPathFragments',bytes:Buffer.byteLength(code),sha256:hash(code)}};
}

function structuralAst(ts,node) {
  if(ts.isParenthesizedExpression(node))return structuralAst(ts,node.expression);
  const children=[];ts.forEachChild(node,n=>{children.push(structuralAst(ts,n));});
  const literalKinds=[ts.SyntaxKind.RegularExpressionLiteral,ts.SyntaxKind.NoSubstitutionTemplateLiteral,ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail,ts.SyntaxKind.BigIntLiteral];
  const value=ts.isIdentifier(node)?node.text.replace(/^runBridge\$5$/,'runBridge'):ts.isStringLiteral(node)?node.text:ts.isNumericLiteral(node)?Number(node.text):literalKinds.includes(node.kind)?node.text:null;
  return [node.kind,value,node.operator??null,ts.isVariableDeclarationList(node)?node.flags&ts.NodeFlags.BlockScoped:null,...children];
}

// Verify the narrow executed slices also match current source after type erasure.
export function verifyTpfSourceSlices(ts,mainText,rendererText,assetsSource,panelSource,sharedSource,sharedCompiled) {
  const compile=(source,filename)=>ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const main=ast(ts,mainText,'main.js'), renderer=ast(ts,rendererText,'renderer.js'), assets=ast(ts,compile(assetsSource,'assets.ts'),'assets.js'),panel=ast(ts,compile(panelSource,'panel.tsx'),'panel.js');
  const pairs=['resource.readTpfDocument','resource.readTpfTexturePreview'].map(n=>[n,handler(ts,assets,n),handler(ts,main,n)]);
  for(const method of ['readTpfDocument','readTpfTexturePreview'])pairs.push([method+'.then',callback(ts,panel,method),callback(ts,renderer,method)]);
  const shared=ast(ts,compile(sharedSource,'tpf-editor.ts'),'shared-source.js'), compiled=ast(ts,sharedCompiled,'shared-compiled.js');
  const project=(tree)=>one(tree.source.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='projectTpfDocumentPages'),'projectTpfDocumentPages');
  pairs.push(['projectTpfDocumentPages',project(shared),project(compiled)]);
  const checks=pairs.map(([name,a,b])=>({name,...equal(structuralAst(ts,a),structuralAst(ts,b))}));
  checks.push({name:'img.src',...equal(imageSrc(ts,panel),imageSrc(ts,renderer))});
  const failed=checks.filter(v=>v.status!=='passed');if(failed.length)throw new Error('SOURCE_COMPILED_SLICE_MISMATCH:'+failed.map(v=>v.name).join(','));
  return checks.map(({name,status,expected})=>({name,status,normalizedAstSha256:hash(JSON.stringify(expected))}));
}

export async function compareTpfProjectionFields(productRoot,oracleRoot,producerPath,outputRoot) {
  productRoot=resolve(productRoot); oracleRoot=resolve(oracleRoot); producerPath=resolve(producerPath); outputRoot=resolve(outputRoot);
  const bindings=[], bind=async(path)=>{path=resolve(path);const bytes=await readFile(path);bindings.push({path,bytes:bytes.length,sha256:hash(bytes)});return bytes;};
  await bind(fileURLToPath(import.meta.url));
  const producerSha256=hash(await bind(producerPath)), receiptPath=join(dirname(producerPath),'bridge-production-build.json'), receipt=JSON.parse(await bind(receiptPath));
  const helperPath=join(productRoot,'scripts/bridge-production-build.mjs'), helperSha256=hash(await bind(helperPath)), sourceHashes={};
  for(const path of ['bridge/SoulForge.Bridge/TpfNativeDocument.cs','bridge/SoulForge.Bridge/DdsCodec.cs','bridge/SoulForge.Bridge/BridgeCommandService.cs']) sourceHashes[path]=hash(await bind(join(productRoot,path)));
  assertProducerReceipt(receipt,producerSha256,helperSha256,sourceHashes);
  const {assertBridgeProductionBuildFresh}=await import(pathToFileURL(helperPath).href);
  const freshness=async()=> { const result=await assertBridgeProductionBuildFresh(productRoot,{runtimeIdentifier:'linux-x64'}); if(resolve(result.manifestPath)!==receiptPath||!isDeepStrictEqual(result.receipt,receipt))throw new Error('BRIDGE_COMPLETE_SCOPE_CHANGED'); };
  await freshness();
  const require=createRequire(join(productRoot,'package.json')), ts=require('typescript'); await bind(require.resolve('typescript'));
  const runtimeModules=new Set();
  const bindRuntimeModule=async(path)=>{
    path=resolve(path);if(runtimeModules.has(path))return;runtimeModules.add(path);
    const tree=ast(ts,(await bind(path)).toString(),path);
    for(const node of tree.source.statements)if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){const spec=node.moduleSpecifier.text;if(spec.startsWith('.'))await bindRuntimeModule(resolve(dirname(path),spec));else if(spec==='@soulforge/shared')await bindRuntimeModule(createRequire(path).resolve(spec));else if(!spec.startsWith('node:'))throw new Error('UNBOUND_BRIDGE_RUNTIME_IMPORT:'+spec);}
  };
  const bridgeRuntimePath=join(productRoot,'packages/core/dist/bridge/runBridge.js');await bindRuntimeModule(bridgeRuntimePath);
  const {createBridgeDaemonScope}=await import(pathToFileURL(bridgeRuntimePath).href),nativeScope=createBridgeDaemonScope();
  const mainPath=join(productRoot,'apps/desktop/out/main/index.js'), rendererDir=join(productRoot,'apps/desktop/out/renderer/assets');
  const rendererPath=join(rendererDir,one((await readdir(rendererDir)).filter((n)=>/^index-.*\.js$/.test(n)),'renderer.bundle'));
  const mainText=(await bind(mainPath)).toString(), rendererText=(await bind(rendererPath)).toString(),slices=extractTpfSlices(ts,mainText,rendererText);
  for(const path of ['apps/desktop/src/main/ipc/assets.ts','apps/desktop/src/main/rendererDto.ts','apps/desktop/src/renderer/src/editors/TpfWorkbenchPanel.tsx','packages/shared/src/tpf-editor.ts','packages/shared/dist/tpf-editor.js','packages/shared/dist/tpf-editor.js.map','packages/shared/src/path-sanitizer.ts','packages/shared/dist/path-sanitizer.js'])await bind(join(productRoot,path));
  slices.extraction.sourceMatchesCompiled=verifyTpfSourceSlices(ts,mainText,rendererText,await readFile(join(productRoot,'apps/desktop/src/main/ipc/assets.ts'),'utf8'),await readFile(join(productRoot,'apps/desktop/src/renderer/src/editors/TpfWorkbenchPanel.tsx'),'utf8'),await readFile(join(productRoot,'packages/shared/src/tpf-editor.ts'),'utf8'),await readFile(join(productRoot,'packages/shared/dist/tpf-editor.js'),'utf8'));
  const {projectTpfDocumentPages}=await import(pathToFileURL(join(productRoot,'packages/shared/dist/tpf-editor.js')).href);
  const mainAst=ast(ts,mainText,'main.js'),maskImport=one(mainAst.source.statements.filter(n=>ts.isImportDeclaration(n)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings)&&n.importClause.namedBindings.elements.some(e=>e.name.text==='maskPathFragments')),'main.mask.import');
  const maskDependencyPath=resolve(dirname(mainPath),maskImport.moduleSpecifier.text),compiledMask=extractCompiledMask(ts,(await bind(maskDependencyPath)).toString());
  slices.extraction.slices.push(compiledMask.receipt);
  const sanitize=slices.createSanitizer(compiledMask.maskPathFragments);
  const oracleWorkspace=dirname(oracleRoot), identity=JSON.parse(await bind(join(oracleWorkspace,'upstream-source-identities.json')));
  if(identity.commit!==NEXT||identity.repository!=='https://github.com/soulsmods/SoulsFormatsNEXT')throw new Error('ORACLE_IDENTITY_INVALID');
  for(const path of ['SoulsFormats/Formats/TPF/TPF.cs','SoulsFormats/Formats/TPF/DDS.cs']) {const bytes=await bind(join(oracleWorkspace,'SoulsFormatsNEXT-'+NEXT,path)), blob=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');if(identity.files.find((v)=>v.path===path)?.sha!==blob)throw new Error('ORACLE_SOURCE_HASH_INVALID');}
  const oracleAssembly=hash(await bind(join(oracleWorkspace,'exporter/bin/Release/net10.0/SoulsFormats.dll'))),exporterAssembly=hash(await bind(join(oracleWorkspace,'exporter/bin/Release/net10.0/IndependentFields.dll')));await bind(join(oracleWorkspace,'exporter/Program.cs'));
  const bcdec=JSON.parse(await bind(join(oracleRoot,'bcdec-top-mip-pixel-reference.json')));await bind(join(oracleRoot,'verification.json'));
  if(bcdec.provider!=='iOrange/bcdec'||bcdec.revision!==BCDEC||bcdec.independentOfSoulForge!==true||bcdec.license!=='MIT OR Unlicense'||bcdec.textures.length!==9)throw new Error('BCDEC_PROVENANCE_INVALID');
  for(const [name,key]of [['bcdec.h','headerSha256'],['decode-dds.cpp','cliSourceSha256'],['decode-dds','executableSha256']]){
    const bytes=await bind(join(oracleWorkspace,'bcdec',name));if(hash(bytes)!==bcdec[key])throw new Error('BCDEC_SOURCE_OR_PRODUCER_HASH_INVALID');
    if(name==='bcdec.h') {const blob=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');if(blob!=='553c3ec5a8b99082956f6b2118d508ae384feb23'||blob!==bcdec.headerGitBlobSha)throw new Error('BCDEC_PINNED_UPSTREAM_BLOB_MISMATCH');}
  }
  await mkdir(outputRoot,{recursive:true});
  const observations=[],resources=[],previewRows=[],negatives=[];
  const capture=async(command,source,name,options)=> {
    const args={bridgeExecutablePath:producerPath,cwd:productRoot,command,filePath:source.path,allowedRoots:[dirname(source.path)],...(command==='export-tpf-texture'?{writableRoots:[outputRoot]}:{}),commandOptions:options,timeoutMs:120_000};
    if(hash(await readFile(source.path))!==source.sha256)throw new Error('CAPTURE_SOURCE_CHANGED');
    const envelope=await nativeScope.run(args);
    if(!['partial','parsed','ok'].includes(envelope.parseStatus)||!Array.isArray(envelope.diagnostics)||!envelope.data||resolve(envelope.sourcePath)!==resolve(source.path))throw new Error('CAPTURE_ENVELOPE_INVALID:'+name+':'+JSON.stringify(envelope.diagnostics));
    if(hash(await readFile(source.path))!==source.sha256||hash(await readFile(producerPath))!==producerSha256)throw new Error('CAPTURE_INPUT_CHANGED');
    const bytes=JSON.stringify(envelope,null,2)+'\n';await writeFile(join(outputRoot,name+'.json'),bytes);if(hash(await bind(join(outputRoot,name+'.json')))!==hash(bytes))throw new Error('CAPTURE_OUTPUT_CHANGED');
    observations.push({name:name+'.json',sha256:hash(bytes),command,args,transport:'actual compiled core createBridgeDaemonScope/runBridge; native daemon with negotiated read/staging roots',commandOptions:options,sourcePath:source.path,sourceSha256:source.sha256});return envelope;
  };
  const replay=async(event,envelope,sourceUri,filePath,relativePath,textureIndex)=> {const calls=[];const deps={activeSession:null,indexedFiles:[{sourceUri,absolutePath:filePath,relativePath}],verifiedReadRoots:async()=>({diagnostics:[],allowedRoots:[dirname(filePath)]})};const handler=slices.createHandler(event,deps,async(args)=>{calls.push(args);return envelope;},dirname,sanitize);const dto=await handler(null,sourceUri,textureIndex);const expectedCall={command:event==='resource.readTpfDocument'?'read-tpf-document':'read-tpf-texture-preview',filePath,allowedRoots:[dirname(filePath)],timeoutMs:120_000,...(textureIndex===undefined?{}:{commandOptions:{textureIndex}})};return {dto,calls,checks:layer({request:equal([expectedCall],calls),sourceUri:equal(sourceUri,dto.sourceUri),relativePath:equal(relativePath,dto.relativePath),ok:equal(true,dto.ok),data:equal(digest(envelope.data),digest(dto.data))}),dtoSha256:digest(dto)};};
  try {
  for(const [id,filename]of [['boss','menu_boss_11140.tpf.fields.json'],['map','mapimage_00_0.tpf.fields.json']]) {
    const oracle=JSON.parse(await bind(join(oracleRoot,filename)));
    if(!oracle.ok||oracle.oracle.commit!==NEXT||oracle.oracle.assemblySha256!==oracleAssembly||oracle.oracle.exporterSha256!==exporterAssembly)throw new Error('ORACLE_FIELDS_PROVENANCE_INVALID');
    const sourceBytes=await bind(oracle.source.path);if(hash(sourceBytes)!==oracle.source.sha256||sourceBytes.length!==oracle.source.byteLength)throw new Error('ORACLE_ORIGINAL_HASH_INVALID');
    // Bounded DFLT wrapper inflation only; format semantics come from NEXT fields.
    if(sourceBytes.toString('ascii',0,4)!=='DCX\0'||sourceBytes.toString('ascii',40,44)!=='DFLT'||sourceBytes.toString('ascii',68,72)!=='DCA\0')throw new Error('BOUNDED_DFLT_WRAPPER_UNSUPPORTED');
    const raw=inflateSync(sourceBytes.subarray(76));if(hash(raw)!==oracle.decoded.sha256||raw.length!==oracle.decoded.byteLength)throw new Error('ORACLE_DECODED_HASH_INVALID');
    const expected=expectedTpf(oracle.fields,raw),wire=await capture('read-tpf-document',oracle.source,id+'-document',{}),uri=`file:///workspace/${id}.tpf.dcx`,documentReplay=await replay('resource.readTpfDocument',wire,uri,oracle.source.path,id+'.tpf.dcx'),pages=projectTpfDocumentPages(documentReplay.dto.data),rendered=slices.consumeDocument(documentReplay.dto);
    const result=compareTpfMetadata(expected,wire.data,pages,rendered.document,documentReplay.dto.data);
    result.layers.core.checks.ipcAdapter=documentReplay.checks;result.layers.core=layer(result.layers.core.checks);Object.assign(result,verdict(result.layers));
    resources.push({id,source:oracle.source,decoded:oracle.decoded,physicalHeader:{platformByte:raw[12],flag2Byte:raw[13],encodingByte:raw[14]},mapping:{platform:'NEXT PC -> 0',encoding:'NEXT Encoding at0x0E',flags:'NEXT Flag2 at0x0D',formatByte:'TPF entry byte, distinct from actual DDS pixel format',mipCount:'NEXT Mipmaps',dataSize:'NEXT payloadBytes',ddsFourCC:'NEXT DDS fourCC',width:'NEXT DDS width',height:'NEXT DDS height'},ipcCalls:documentReplay.calls,dtoSha256:documentReplay.dtoSha256,rendererDocumentSha256:hash(JSON.stringify(rendered.document)),...result});
    for(const t of oracle.fields.textures) {
      const ref=one(bcdec.textures.filter((v)=>v.sourceDdsSha256===t.payloadSha256&&v.textureName===t.Name),'bcdec.texture');
      if(ref.sourceTpf.sha256!==oracle.source.sha256||hash(await bind(t.rawDdsPath))!==t.payloadSha256)throw new Error('ORACLE_DDS_HASH_INVALID');const reference=await bind(ref.rgbaPath);if(hash(reference)!==ref.rgbaSha256||reference.length!==ref.rgbaBytes||ref.width!==t.dds.width||ref.height!==t.dds.height)throw new Error('ORACLE_PIXELS_HASH_INVALID');
      const base=`${id}-texture${t.ordinal}`,pngPath=join(outputRoot,base+'.png');
      const exportWire=await capture('export-tpf-texture',oracle.source,base+'-export',{textureIndex:t.ordinal,format:'png',outputPath:pngPath});const png=await bind(pngPath),full=decodePng(png),colorSpace=t.dds.fourCC==='DX10'?'linear':'unknown',tolerance=ref.bcType===7?0:1;
      const rawPixels=layer({name:equal(t.Name,exportWire.data.name),byteLength:equal(png.length,exportWire.data.byteLength),colorSpace:equal(colorSpace,exportWire.data.colorSpace),width:equal(ref.width,full.width),height:equal(ref.height,full.height),pixels:compareRgba(reference,full.rgba,tolerance),colorChunks:equal([],full.chunks.filter((n)=>['sRGB','gAMA','cHRM'].includes(n)))});
      const previewWire=await capture('read-tpf-texture-preview',oracle.source,base+'-preview',{textureIndex:t.ordinal}),preview=previewWire.data,previewPng=Buffer.from(preview.previewToken.slice('data:image/png;base64,'.length),'base64'),pixels=decodePng(previewPng),scale=Math.min(512/ref.width,512/ref.height,1),width=Math.round(ref.width*scale),height=Math.round(ref.height*scale),previewReference=boxReference(reference,ref.width,ref.height,width,height);
      const expectedPreview={textureIndex:t.ordinal,name:t.Name,width,height,sourceWidth:ref.width,sourceHeight:ref.height,colorSpace,mediaType:'image/png',byteLength:previewPng.length},previewReplay=await replay('resource.readTpfTexturePreview',previewWire,uri,oracle.source.path,id+'.tpf.dcx',t.ordinal),state=slices.consumePreview(previewReplay.dto),imgSource=slices.imageSource(state.preview);
      const comparison=compareTpfPreview(expectedPreview,preview,pixels,previewReference,state,imgSource);
      comparison.layers.bridge.checks.fullResolution=rawPixels;comparison.layers.bridge=layer(comparison.layers.bridge.checks);
      comparison.layers.core.checks.ipcAdapter=previewReplay.checks;comparison.layers.core=layer(comparison.layers.core.checks);Object.assign(comparison,verdict(comparison.layers));
      previewRows.push({resourceId:id,textureOrdinal:t.ordinal,name:t.Name,ddsFormat:ref.ddsFormat,rawPixels,sourceDdsSha256:t.payloadSha256,referenceRgbaSha256:ref.rgbaSha256,actualFullRgbaSha256:hash(full.rgba),fullPngSha256:hash(png),previewPngSha256:hash(previewPng),previewRgbaSha256:hash(pixels.rgba),previewReferenceRgbaSha256:hash(previewReference),imgSrcSha256:hash(imgSource),ipcCalls:previewReplay.calls,dtoSha256:previewReplay.dtoSha256,rendererStateSha256:hash(JSON.stringify({preview:state.preview,loading:state.loading,failure:state.failure})),...comparison});
      for(const [kind,mutate]of [['wrong-Bridge-name',p=>{p.name+='!';}],['wrong-Bridge-dimension',p=>{p.sourceWidth++;}],['wrong-Bridge-colorSpace',p=>{p.colorSpace=p.colorSpace==='linear'?'unknown':'linear';}]]){const bad=structuredClone(preview);mutate(bad);const r=compareTpfPreview(expectedPreview,bad,pixels,previewReference,state,imgSource);negatives.push({resourceId:id,textureOrdinal:t.ordinal,kind,detected:r.status==='failed'&&r.firstDivergentLayer==='bridge',firstDivergentLayer:r.firstDivergentLayer});}
      const badPixels={...pixels,rgba:Buffer.from(pixels.rgba)};badPixels.rgba[0]=badPixels.rgba[0]<128?255:0;const badPixelResult=compareTpfPreview(expectedPreview,preview,badPixels,previewReference,state,imgSource);negatives.push({resourceId:id,textureOrdinal:t.ordinal,kind:'wrong-Bridge-pixel',detected:badPixelResult.status==='failed'&&badPixelResult.firstDivergentLayer==='bridge',firstDivergentLayer:badPixelResult.firstDivergentLayer});
    }
  }
  for(const [kind,mutate]of [['producer-receipt-tamper',r=>{r.executable.sha256='0'.repeat(64);}],['source-receipt-tamper',r=>{r.source.entries.find(e=>e.path==='bridge/SoulForge.Bridge/DdsCodec.cs').sha256='0'.repeat(64);}]]){const bad=structuredClone(receipt);mutate(bad);let reason=null;try{assertProducerReceipt(bad,producerSha256,helperSha256,sourceHashes);}catch(error){reason=error.message;}negatives.push({kind,detected:!!reason,reason});}
  const failure=slices.consumePreview({ok:false,diagnostics:[{code:'NEGATIVE',message:'failed'}]}),cancel=slices.consumePreview({ok:true,data:{name:'should not propagate'}},true);negatives.push({kind:'renderer-failed-preview',detected:failure.preview===null&&failure.failure?.code==='NEGATIVE'&&failure.loading===false},{kind:'renderer-cancelled-preview',detected:cancel.preview===null&&cancel.loading===true});
  } finally { await nativeScope.dispose(); }
  await freshness();for(const record of bindings)if(hash(await readFile(record.path))!==record.sha256)throw new Error(`INPUT_CHANGED_DURING_COMPARISON:${record.path}`);
  const report={schema:'soulforge-tpf-projection-fields-v1',generatedAt:new Date().toISOString(),status:resources.every(r=>r.status==='passed'&&r.supplemental.sharedPages.status==='passed')&&previewRows.every(r=>r.status==='passed'&&r.rawPixels.status==='passed')&&negatives.every(n=>n.detected)?'passed':'failed',productCommit:execFileSync('git',['-C',productRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),producer:{path:producerPath,sha256:producerSha256,sourceInputHash:receipt.source.sha256,sourceEntryCount:receipt.source.entries.length,completeCompileInputScopeVerified:true,scopeVerifier:helperPath,receiptSha256:hash(await readFile(receiptPath))},oracle:{metadataProvider:'SoulsFormatsNEXT',revision:NEXT,license:'GPL-3.0 external research executable only',oracleAssembly,exporterAssembly,exporterSourceCompileAttestation:'Source and executable separately hash-bound; no independent exporter compilation attestation',lineageLimit:'Bridge documentation shares SoulsFormats lineage; independent execution is not independent format discovery',pixelProvider:bcdec.provider,pixelRevision:BCDEC,pixelLicense:bcdec.license},execution:slices.extraction,layerDefinitions:{bridge:'Fresh canonical native document, full-resolution PNG export and bounded preview pixels',core:'Actual compiled main IPC request adapter and renderer DTO sanitizer, replaying bound native envelopes',renderer:'Actual compiled TpfWorkbenchPanel callbacks and img.src input expression',supplemental:'Separately executed shared projectTpfDocumentPages pure API; not used by this panel path'},previewPolicy:{maxDimension:512,options:{textureIndex:'each preserved ordinal'},maxDimensionOptionSupported:false,resampling:'integer-aligned box footprints; floor(sum/channel sample count), no transfer-function conversion',rawPixels:'PNG decoded to raw RGBA8 without color conversion; independent bcdec raw top mip, BC7 tolerance0 and BC1 tolerance1'},resources,previews:previewRows,negatives,coverage:{packages:resources.length,textures:previewRows.length,bc1:previewRows.filter(r=>r.ddsFormat==='BC1_UNORM').length,bc7:previewRows.filter(r=>r.ddsFormat==='BC7_UNORM').length,negativeControls:negatives.length},observations,bindings,nonClaims:['No standalone TPF scene-ir path exists in this scope; shared projectTpfDocumentPages is executed, while TpfWorkbenchPanel consumes the document DTO directly.','Compiled output is current production build output, not the older packaged application or a live process. Source and outputs are bound separately; no full desktop build provenance is inferred.','No DOM/React mount, live Electron preload/main IPC transport, img decoding in a browser, CSS, GPU draw, display color management, screenshot or visual render-equivalence proof.','Two frozen packages and nine preserved DDS/top-mip references only; no new game input, DDS extraction, source copy, external dependency, vendor or publication.']};
  await writeFile(join(outputRoot,'tpf-projection-comparison.json'),JSON.stringify(report,null,2)+'\n');return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2);if(args.length!==4)throw new Error('Usage: node compare-tpf-projection-fields.mjs <product-root> <oracle-results> <published-producer> <output-root>');const report=await compareTpfProjectionFields(...args);console.log(JSON.stringify({status:report.status,coverage:report.coverage,metadata:report.resources.map(r=>({id:r.id,status:r.status,firstDivergentLayer:r.firstDivergentLayer,bridgeFailures:Object.entries(r.layers.bridge.checks).filter(([,v])=>v.status==='failed')})),output:join(resolve(args[3]),'tpf-projection-comparison.json')}));if(report.status!=='passed')process.exitCode=1;}
