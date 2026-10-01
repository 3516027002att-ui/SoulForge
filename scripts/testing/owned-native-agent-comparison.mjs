/** Shared owned task/independent NEXT validator ports. No execution occurs on import. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, utimes, writeFile, copyFile, rename } from 'node:fs/promises';
import {materializeLegacyAgentBaseline,selectLegacyAgentControl} from './legacy-agent-baseline.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** One description-only treatment; the shared system policy stays fixed. */
export function createExperimentToolDescriptions(tools,sharedInstruction,repeated){
  return repeated?tools.map(tool=>({...tool,description:`${tool.description} ${sharedInstruction}`})):tools;
}

/** Same model-visible identities for separately owned legs; native arguments restore the owned locator. */
export function createExperimentModelWire({directory,workspaceId}) {
  const pairs=[[pathToFileURL(directory).href,'file:///owned-agent-experiment'],[directory,'/owned-agent-experiment'],[workspaceId,'owned-agent-experiment-workspace']]
    .filter(([value])=>typeof value==='string'&&value.length>0).sort((a,b)=>b[0].length-a[0].length);
  const convert=(value,reverse=false)=>JSON.parse(JSON.stringify(value,(_key,item)=>{
    if(typeof item!=='string')return item;
    for(const [actual,alias] of pairs)item=item.replaceAll(reverse?alias:actual,reverse?actual:alias);
    return item;
  }));
  return {version:'owned-model-identities-v1',request:value=>convert(value),response:value=>convert(value,true)};
}

/** Pure metadata source shared by automatic and tool-requested retrieval. */
export function createExperimentRetrieval(core,{before,target,workspaceId,onRetrieve=()=>{}}){
  const chunks=before.events.map(event=>{const body=`Pinned independent pre-read: event ${event.id}; rest behavior ${event.restBehavior}; instructions ${event.instructionCount}; parameters ${event.parameterCount}; body ${event.bodySha256}. Native reads remain authoritative for mutations.`;return {chunkId:`experiment:event:${before.source.sha256}:${event.id}`,workspaceId,sourceUri:pathToFileURL(target).href,symbolUri:`event://common/${event.id}`,family:'event',title:`Event ${event.id}`,body,numericIds:[event.id],contentHash:createHash('sha256').update(body).digest('hex')};});
  const corpus=core.createRagCorpus({workspaceId,builtAt:'2026-01-01T00:00:00Z',chunks});
  return {corpus,retrieve:async(query,channel='automatic')=>{const result=core.retrieveEvidence(corpus,query,{limit:4});onRetrieve({channel,query,result});return result;}};
}

/** Resource state alone does not establish that a requested native read happened. */
export function experimentNativeReadObserved(toolResults,{file,eventId,target}){
  const accepted=new Set([`file://${file}`,...(target?[pathToFileURL(target).href]:[])]);
  return toolResults.some(({result})=>{
    if(result?.ok!==true)return false;
    let envelope;try{envelope=JSON.parse(result.content);}catch{return false;}
    if(envelope.evidence?.status!=='native-verified'||!envelope.evidence.sourceUris?.some(uri=>accepted.has(uri)))return false;
    const record=envelope.data?.record??envelope.data;
    return record?.eventId===eventId||envelope.evidence.claims?.some(claim=>claim.identity?.domain==='emevd'&&claim.identity.objectHandle===String(eventId))===true;
  });
}

/** Read-only preflight; injected filesystem ports let preparation be verified without native execution. */
export async function inspectOwnedNativeInputs(input,ports={}){
  const {source,dotnet,oracleAssembly,bridge,loader,requireExternalLoader,fixture,oracleSha}=input;
  const exists=ports.exists??existsSync,statFile=ports.stat??stat,hashFile=ports.fileHash??(async path=>createHash('sha256').update(await readFile(path)).digest('hex'));
  const required=[source,dotnet,oracleAssembly,bridge,...(requireExternalLoader?[loader]:[])];
  const missing=required.filter(path=>!path||!exists(path));
  if(missing.length)return {status:'unavailable',code:'OWNED_NATIVE_COMPARISON_INPUT_UNAVAILABLE',missing};
  const sourceBytes=(await statFile(source)).size,sourceHash=sourceBytes===fixture.byteLength?await hashFile(source):undefined,oracleHash=await hashFile(oracleAssembly);
  if(sourceBytes!==fixture.byteLength||sourceHash!==fixture.sha256||oracleHash!==oracleSha)return {status:'unavailable',code:'OWNED_NATIVE_COMPARISON_INPUT_MISMATCH',sourceBytes,sourceHash,oracleHash};
  return {status:'ready',source,fixture};
}

export function createOwnedNativeComparisonRuntime(options={}) {
const ROOT = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const OUT = resolve(options.outputRoot ?? join(ROOT, '.local-validation/native-comparison'));
const CONTROL=selectLegacyAgentControl(options.control);
const LEGACY=CONTROL.revision;
const ORACLE_SHA = '59b0367fd093fbff3a1cc661ee59a350f22a0480e4733ff47c28623a9b2a8228';
const ORACLE_ASSEMBLY = options.oracleAssembly ?? process.env.SOULFORGE_COMPARISON_NEXT_ASSEMBLY
  ?? '';
const DOTNET = options.dotnet ?? process.env.SOULFORGE_COMPARISON_DOTNET
  ?? (process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT,process.platform==='win32'?'dotnet.exe':'dotnet') : '');
const CORPUS_ROOT = options.corpusRoot ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? process.env.SOULFORGE_COMPARISON_CORPUS_ROOT ?? '';
const BRIDGE = options.bridge ?? join(ROOT, '.local-validation/bridge-bin/Debug/net10.0/linux-x64/SoulForge.Bridge');
const LOADER = options.loader ?? join(ROOT, '.local-validation/explicit-native-bridge-loader.mjs');
const MANIFEST = join(ROOT, 'testdata/corpus/sekiro-1.6.corpus-manifest.json');
const FILE = 'event/common.emevd.dcx';
// Explicit goals selected by pinned NEXT, never derived by the tested parser.
const TARGET = Object.freeze({ eventId: 952787, originalRest: 1, requestedRest: 0,
  ordinal: 11, instructionCount: 3, parameterCount: 0,
  bodySha256: '99c6a7c284f2bd339ca131eb5715a8597f2528263c83a4fcf95a56b536d9d87f' });
const SCENARIOS = [
  { id: 'read-only', goalRest: 1, mutation: false,
    prompt: 'Read event/common.emevd.dcx event 952787. Confirm its rest behavior is Restart (1) and leave the resource unchanged.' },
  { id: 'already-satisfied', goalRest: 1, mutation: false,
    prompt: 'Ensure event/common.emevd.dcx event 952787 has rest behavior Restart (1). Read first; if already satisfied, leave the resource unchanged.' },
  { id: 'native-rest-mutation', goalRest: 0, mutation: true,
    prompt: 'Change only event/common.emevd.dcx event 952787 rest behavior from Restart (1) to Default (0). Keep its event ID, instructions, arguments, layers, and parameters intact, preserve all other events, and commit through the native proof and Patch Engine.' },
  { id: 'false-model-success', goalRest: 0, mutation: false,
    prompt: 'Change only event/common.emevd.dcx event 952787 rest behavior to Default (0), preserving all other content. Verify the committed resource.' }
];
const CONFIG = Object.freeze({ id: 'owned-native-comparison', displayName: 'deterministic comparison',
  protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid', model: 'identical-deterministic-native-script',
  hasCredential: false, createdAt: '', updatedAt: '' });
const SAMPLING = Object.freeze({ temperature: 0, topP: 1, maxTokens: 512 });
const LIMITS = Object.freeze({ maxSteps: 8, timeoutMs: 180_000, maxOutputTokens: 8_192,
  maxContextBytes: 2_097_152, maxResultBytes: 65_536, maxResponseBytes: 131_072,
  maxToolCallsPerTurn: 1, maxCost: 0 });
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = async path => hash(await readFile(path));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const dotnetEnv = () => {const {SOULFORGE_AGENT_API_KEY:_hostCredential,...environment}=process.env;return ({ ...environment, DOTNET_ROOT: dirname(DOTNET),
  DOTNET_CLI_HOME: join(OUT, 'dotnet-home'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });};

const ORACLE_SOURCE = `using SoulsFormats;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Buffers.Binary;
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
if(args.Length!=2)throw new ArgumentException("SOURCE OUTPUT_JSON");
var bytes=File.ReadAllBytes(args[0]);if(bytes.Length>64*1024*1024)throw new InvalidDataException("Input exceeds64MiB");
if(bytes.Length<0x4c||!bytes.AsSpan(0,4).SequenceEqual("DCX\\0"u8)||!bytes.AsSpan(0x28,4).SequenceEqual("DFLT"u8))throw new NotSupportedException("Only DFLT DCX; no vendor codecs");
if(BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(0x1c,4))>64*1024*1024)throw new InvalidDataException("Decoded bound");
var raw=DCX.Decompress(bytes,out var type);var doc=EMEVD.Read(raw);
var events=doc.Events.Select((e,ordinal)=>new{ordinal,id=e.ID,restBehavior=(uint)e.RestBehavior,instructionCount=e.Instructions.Count,parameterCount=e.Parameters.Count,bodySha256=Hash(JsonSerializer.SerializeToUtf8Bytes(new{instructions=e.Instructions.Select(i=>new{bank=i.Bank,id=i.ID,argsBase64=Convert.ToBase64String(i.ArgData),layer=i.Layer}),parameters=e.Parameters.Select(p=>new{p.InstructionIndex,p.TargetStartByte,p.SourceStartByte,p.ByteCount,p.UnkID})}))}).ToArray();
var output=new{schema="owned-next-emevd-comparison-v1",oracle=new{commit="ee1dd61958f60bdc51ce3da548e9a90a8ab39905",assemblySha256=Hash(File.ReadAllBytes(typeof(EMEVD).Assembly.Location)),querySha256=Hash(File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location)),lineageLimit="Independent execution; shared upstream format knowledge is not independent format discovery"},source=new{sha256=Hash(bytes),byteLength=bytes.Length},decoded=new{sha256=Hash(raw),byteLength=raw.Length,compression=type.ToString(),format=doc.Format.ToString(),linkedFileOffsets=doc.LinkedFileOffsets,stringDataSha256=Hash(doc.StringData)},eventCount=events.Length,instructionCount=events.Sum(e=>e.instructionCount),events};
File.WriteAllText(args[1],JsonSerializer.Serialize(output,new JsonSerializerOptions{WriteIndented=true}));Console.WriteLine(JsonSerializer.Serialize(new{ok=true,eventCount=events.Length,instructionCount=events.Sum(e=>e.instructionCount)}));
static string Hash(byte[] b)=>Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();
`;

async function oracle(source, output) {
  await exec(DOTNET, [join(OUT, 'oracle/bin/Release/net10.0/OwnedOracle.dll'), source, output],
    { cwd: ROOT, env: dotnetEnv(), timeout: 60_000, maxBuffer: 2_097_152 });
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.oracle.assemblySha256, ORACLE_SHA);
  return report;
}

async function treeInputs(directories) {
  const files = [];
  async function walk(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else files.push({ path: relative(ROOT, path), byteLength: info.size, sha256: await fileHash(path) });
  }
  for (const dir of directories) await walk(resolve(ROOT, dir));
  return { sha256: hash(JSON.stringify(files)), files };
}

// Exact baseline source, locally transpiled without rebuilding core or native.
// Model-services runtime dependencies are recursively snapshotted at LEGACY;
// the production domain/assembly remain the same for both control kernels.
async function snapshotLegacy(sourceTransform,label='unmodified') {
  const loaded=await materializeLegacyAgentBaseline(ROOT,join(OUT,'legacy',label),LEGACY,{control:CONTROL.id,sourceTransform});
  const manifest={...loaded.manifest,entry:relative(ROOT,loaded.manifest.entry),
    lineage:`${CONTROL.lineage} Same live production native domain ports and ToolRegistry for both kernels.`,
    files:loaded.manifest.files.map(file=>({...file,output:relative(ROOT,file.output)}))};
  await save(join(OUT,'legacy-snapshot.json'),manifest);
  return manifest;
}

async function prepare() {
  await mkdir(OUT, { recursive: true });
  const missingConfiguration=[['SOULFORGE_NATIVE_FIXTURE_ROOT',CORPUS_ROOT],['SOULFORGE_COMPARISON_NEXT_ASSEMBLY',ORACLE_ASSEMBLY],['SOULFORGE_COMPARISON_DOTNET or DOTNET_ROOT',DOTNET]].filter(([,value])=>!value).map(([name])=>name);
  if(missingConfiguration.length)return {status:'unavailable',code:'OWNED_NATIVE_COMPARISON_INPUT_UNAVAILABLE',missingConfiguration};
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const fixture = manifest.correctnessFixtures.fixtures.find(f => f.role === 'emevd-primary');
  assert.equal(fixture.relativePath, 'mods/event/common.emevd.dcx');
  const source = join(CORPUS_ROOT, fixture.relativePath);
  const available=await inspectOwnedNativeInputs({source,dotnet:DOTNET,oracleAssembly:ORACLE_ASSEMBLY,bridge:BRIDGE,loader:LOADER,requireExternalLoader:options.requireExternalLoader,fixture,oracleSha:ORACLE_SHA});
  if(available.status!=='ready')return available;
  let legacy;
  try{legacy=await snapshotLegacy();}catch(error){if(error.code==='AGENT_COMPARISON_BASELINE_UNAVAILABLE')return {status:'unavailable',code:error.code,baselineRevision:LEGACY};throw error;}
  const oracleDir = join(OUT, 'oracle');
  await mkdir(oracleDir, { recursive: true });
  await writeFile(join(oracleDir, 'Program.cs'), ORACLE_SOURCE);
  const xmlPath = ORACLE_ASSEMBLY.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  await writeFile(join(oracleDir, 'OwnedOracle.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><Reference Include="SoulsFormats"><HintPath>${xmlPath}</HintPath></Reference></ItemGroup></Project>`);
  const build = await exec(DOTNET, ['build', join(oracleDir, 'OwnedOracle.csproj'), '-c', 'Release', '--nologo', '--ignore-failed-sources'],
    { cwd: ROOT, env: dotnetEnv(), timeout: 60_000, maxBuffer: 2_097_152 });
  await writeFile(join(OUT, 'oracle-build.log'), build.stdout + build.stderr);
  const before = await oracle(source, join(OUT, 'source-oracle.json'));
  assert.equal(before.eventCount, fixture.expected.eventCount);
  assert.equal(before.instructionCount, fixture.expected.instructionCount);
  assert.deepEqual(before.events.find(e => e.id === TARGET.eventId), {
    ordinal: TARGET.ordinal, id: TARGET.eventId, restBehavior: TARGET.originalRest,
    instructionCount: TARGET.instructionCount, parameterCount: TARGET.parameterCount, bodySha256: TARGET.bodySha256
  });
  return { status: 'ready', source, fixture, before,
    oracleSourceSha256: hash(ORACLE_SOURCE), legacy };
}

async function worker(kernel, scenarioId, leg = {}) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  assert.ok(scenario);
  const core = await import(pathToFileURL(join(ROOT,'packages/core/dist/index.js')).href);
  const { AGENT_TOOL_RESULT_INSTRUCTIONS } = await import(pathToFileURL(join(ROOT,'packages/core/dist/ai/agentToolBridge.js')).href);
  const label=leg.label ?? kernel;
  const dir = join(OUT, `${scenarioId}-${label}`);
  await mkdir(join(dir, 'overlay/event'), { recursive: true });
  process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = join(dir, 'storage');
  const source = join(CORPUS_ROOT, 'mods', FILE);
  const target = join(dir, 'overlay', FILE);
  const sibling = join(dir, 'overlay', 'preservation-sentinel.txt');
  await copyFile(source, target);
  // Identical CAS sourceRevision input for the two independently owned copies.
  await utimes(target, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  await writeFile(sibling, 'owned-comparison-preservation-sentinel\n');
  const before = await oracle(target, join(dir, 'before-oracle.json'));
  const siblingBefore = await fileHash(sibling);
  const session = await core.openLocalCliSession({ overlayRoot: join(dir, 'overlay'), game: 'sekiro',
    mode: leg.permissionMode ?? 'normal', principal: 'owned-native-comparison', analyze: false, useCache: false, requireDurableLog: true });
  const protocolEvents = [], modelRequests = [], responses = [], approvals = [], toolResults = [];
  const bridge = { ...session.bridge, executeTool: async (call, context) => {
    const result = await session.bridge.executeTool(call, context);
    toolResults.push({ call, result });
    return result;
  } };
  assert.ok(session.registry instanceof core.ToolRegistry);
  assert.ok(bridge.tools.some(t => t.name === 'read_emevd_event'));
  bridge.tools=createExperimentToolDescriptions(bridge.tools,AGENT_TOOL_RESULT_INSTRUCTIONS,leg.repeatedDescriptions);
  const retrievalCalls=[];let retrieve;
  if(leg.ragMode){
    const retrieval=createExperimentRetrieval(core,{before,target,workspaceId:session.coreSession.workspaceId,onRetrieve:call=>retrievalCalls.push(call)});
    const {corpus}=retrieval;
    const retrievalBridge=core.createAgentToolBridge({registry:session.registry,context:{workspaceIndex:null,rag:corpus,mode:leg.permissionMode ?? 'normal'}});
    retrieve=retrieval.retrieve;
    const domainExecute=bridge.executeTool;bridge.executeTool=async(call,context)=>{if(call.name!=='retrieve_evidence')return domainExecute(call,context);let args;try{args=JSON.parse(call.argumentsJson);}catch{return domainExecute(call,context);}const result=await retrievalBridge.executeTool({...call,argumentsJson:JSON.stringify({...args,limit:4})},context);retrievalCalls.push({channel:'tool',query:args.query,result});toolResults.push({call,result});return result;};
  }
  let turn = 0;
  const deterministicAdapter = { protocol: 'openai-compatible', listModels: async () => ({ ok: true, models: [] }),
    stream: async function* () { throw new Error('Streaming is disabled for this deterministic transport'); },
    complete: async request => {
      modelRequests.push({ messages: request.messages, tools: request.tools,
        temperature: request.temperature, topP: request.topP, maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs });
      turn++;
      let call;
      if (turn === 1) call = { id: 'read-native', name: 'read_emevd_event',
        argumentsJson: JSON.stringify({ file: FILE, eventId: TARGET.eventId, format: 'darkscript' }) };
      else if (turn === 2 && scenario.mutation) {
        // Bind to the identical request call ID: the exact legacy wire transcript
        // omits the optional tool-message name, while the finite kernel includes it.
        const readResult = request.messages.findLast(m => m.role === 'tool' && m.toolCallId === 'read-native');
        assert.ok(readResult, 'Mutation response requires the actual native tool result');
        const payload = JSON.parse(readResult.content), record = payload.data?.record ?? payload.data;
        assert.equal(record.darkScriptComplete, true);
        assert.equal(record.eventId, TARGET.eventId);
        const dsl = record.darkScript.replace(/(\$Event\(952787,\s*)Restart(\s*,)/, '$1Default$2');
        assert.notEqual(dsl, record.darkScript, 'Pinned rest token must be present in native DarkScript');
        call = { id: 'commit-native', name: 'apply_emevd_dsl', argumentsJson: JSON.stringify({
          file: FILE, eventId: TARGET.eventId, scope: 'event', mode: 'dark-script', dsl,
          sourceHash: record.sourceHash, outerFileHash: record.outerFileHash,
          sourceRevision: record.sourceRevision, darkScriptComplete: true }) };
      }
      const response = { message: { role: 'assistant', content: call ? '' : 'The requested native task is complete.',
        ...(call ? { toolCalls: [call] } : {}) }, finishReason: call ? 'tool_use' : 'stop',
        usage: { inputTokens: 40, outputTokens: 40 }, diagnostics: [] };
      responses.push(response);
      return response;
    } };
  const wire=createExperimentModelWire({directory:dir,workspaceId:session.coreSession.workspaceId});
  const adapter=leg.adapter ? {...leg.adapter,complete:async request=>{const normalized=wire.request({...request,signal:undefined});modelRequests.push({messages:normalized.messages,tools:normalized.tools,temperature:normalized.temperature,topP:normalized.topP,maxTokens:normalized.maxTokens,timeoutMs:normalized.timeoutMs});turn++;const response=await leg.adapter.complete({...normalized,signal:request.signal});responses.push(response);return wire.response(response);}} : deterministicAdapter;
  const activeConfig=leg.config ?? CONFIG,activeSampling=leg.sampling ?? SAMPLING,activeLimits=leg.limits ?? LIMITS;
  if(leg.sourceTransform)await snapshotLegacy(leg.sourceTransform,leg.snapshotLabel);
  const legacy = JSON.parse(await readFile(join(OUT, 'legacy-snapshot.json'), 'utf8'));
  const runner = kernel === 'legacy' ? (await import(pathToFileURL(join(ROOT, legacy.entry)).href)).runAgentSession : undefined;
  const assembly = core.createAgentRunAssembly(bridge, { coreSession: session.coreSession,
    ...(runner ? { sessionRunner: runner } : {}) });
  const started = performance.now();
  let result, operations, transactionJournal,executionError;
  try {
    result = await assembly.run({ sessionsDir: join(dir, 'sessions'), sessionId: `owned-${scenarioId}-${kernel}`,
      runId: 'owned-identical-run', requestId: 'owned-identical-request', adapter, config: activeConfig, apiKey: leg.apiKey ?? '',
      prompt: scenario.prompt, systemPrompt: [AGENT_TOOL_RESULT_INSTRUCTIONS,leg.reportingInstruction].filter(Boolean).join('\n'),
      permissionMode: leg.permissionMode==='plan'?'plan':'normal', kernel, streaming: false, sampling: activeSampling,
      maxSteps: activeLimits.maxSteps, timeoutMs: activeLimits.timeoutMs, maxTotalOutputTokens: activeLimits.maxOutputTokens,
      kernelLimits: activeLimits, pricing: leg.pricing ?? { inputPerMillion: 0, outputPerMillion: 0 },
      requestApproval: async proposal => { approvals.push(proposal); return { decision: 'once' }; },
      ...(leg.signal?{signal:leg.signal}:{}),
      ...(leg.recordProviderUsage?{recordProviderUsage:leg.recordProviderUsage}:{}),
      ...(leg.ragMode==='automatic'?{ragSearch:{retrieve,maxHits:4}}:{}),
      onProtocolEvent: event => protocolEvents.push(event) });
    await assembly.waitForHostOperations();
    operations = await session.coreSession.operationLog.list(session.coreSession.workspaceId);
    transactionJournal = session.coreSession.operationLog.database.prepare(
      'SELECT transaction_id, op_id, phase, state_json FROM transaction_journal WHERE workspace_id = ?'
    ).all(session.coreSession.workspaceId);
  } catch(error){executionError={code:error.code ?? 'EXPERIMENT_EXECUTION_FAILED',message:error.message};result={run:{finishReason:'error',steps:turn,messages:[],diagnostics:[{severity:'error',...executionError}]}};
  } finally {await assembly.waitForHostOperations();operations=await session.coreSession.operationLog.list(session.coreSession.workspaceId);transactionJournal=session.coreSession.operationLog.database.prepare('SELECT transaction_id, op_id, phase, state_json FROM transaction_journal WHERE workspace_id = ?').all(session.coreSession.workspaceId);await session.dispose();}
  let after,verificationError;
  try{after=await oracle(target,join(dir,'after-oracle.json'));}
  catch(error){verificationError={code:error.code??'EXPERIMENT_READBACK_UNAVAILABLE',message:String(error.message??error)};after={source:{sha256:await fileHash(target),byteLength:(await stat(target)).size},events:[],decoded:{}};}
  const current = after.events.find(e => e.id === TARGET.eventId);
  const goalStatus = verificationError?'unverified':current?.restBehavior === scenario.goalRest ? 'passed' : 'failed';
  const backupFacts = [];
  for (const operation of operations) for (const file of operation.files) backupFacts.push({
    opId: operation.opId, transactionId: operation.transactionId, targetUri: file.targetUri,
    beforeHash: file.beforeHash, afterHash: file.afterHash, backupSha256: await fileHash(file.backupPath),
    actualTargetSha256: await fileHash(file.targetPath),
    backupMatchesBefore: await fileHash(file.backupPath) === before.source.sha256,
    targetMatchesAfter: await fileHash(file.targetPath) === after.source.sha256
  });
  const preservation = {
    eventCount: after.eventCount === 1783, instructionCount: after.instructionCount === 87892,
    targetBody: current?.bodySha256 === TARGET.bodySha256,
    eventIdentitiesAndBodies: !verificationError&&after.events.every((e, index) => {
      const expected = { ...before.events[index], ...(e.id === TARGET.eventId && scenario.mutation ? { restBehavior: 0 } : {}) };
      return JSON.stringify(e) === JSON.stringify(expected);
    }),
    format: after.decoded.format === before.decoded.format,
    stringData: after.decoded.stringDataSha256 === before.decoded.stringDataSha256,
    linkedFiles: JSON.stringify(after.decoded.linkedFileOffsets) === JSON.stringify(before.decoded.linkedFileOffsets),
    siblingBytes: await fileHash(sibling) === siblingBefore,
    originalBytes: await fileHash(source) === before.source.sha256
  };
  const allowedResourceDelta=verificationError?'unverified':after.events.every((event,index)=>{
    const original=before.events[index];if(!original)return false;
    const allowed=scenario.mutation&&event.id===TARGET.eventId&&[TARGET.originalRest,TARGET.requestedRest].includes(event.restBehavior)
      ? {...original,restBehavior:event.restBehavior}:original;
    return JSON.stringify(event)===JSON.stringify(allowed);
  })&&['eventCount','instructionCount','targetBody','format','stringData','linkedFiles','siblingBytes','originalBytes'].every(key=>preservation[key]);
  const wrongWriteObserved=operations.some(operation=>(operation.committedAt||['committed','rolled_back'].includes(operation.status))&&operation.files.some(file=>resolve(file.targetPath)!==resolve(target)));
  const taskEvidence={nativeReadObserved:experimentNativeReadObserved(toolResults,{file:FILE,eventId:TARGET.eventId,target}),requiredBy:'Requested target read/confirmation or read-before-mutation',resourceStateOnly:false};
  const report = { kernel, scenario: scenarioId, goal: { eventId: TARGET.eventId, expectedRest: scenario.goalRest, status: goalStatus },
    protocolTermination: { finishReason: result.run.finishReason, steps: result.run.steps,
      state: result.kernel?.state, reason: result.kernel?.reason, evaluation: 'unverified' },
    transport: { kind: leg.adapter?'explicit-provider-experiment':'deterministic-fixture', ...(leg.adapter?{}:{externalCalls:0,paidProviderCost:0}),turnCount:turn,
      sampling: activeSampling, limits: activeLimits, responseSha256: hash(JSON.stringify(responses)) },
    ...(executionError?{executionError}:{}),allowedResourceDelta,wrongWriteObserved,taskEvidence,runDiagnostics:result.run.diagnostics,modelRequests,retrievalCalls,
    ...(leg.adapter?{modelWireIdentity:wire.version}:{}),
    modelFinalText:result.run.messages.filter(message=>message.role==='assistant').at(-1)?.content ?? '',
    actualBefore: before.events[TARGET.ordinal], actualAfter: current,
    byteHashes: { before: before.source.sha256, after: after.source.sha256 },
    nativeReadback: { status:verificationError?'unavailable':'verified',...(verificationError?{error:verificationError}:{}),oracle: after.oracle, source: after.source, decoded: after.decoded },
    preservation, approvals, operations, transactionJournal, backupFacts, toolResults, protocolEvents,
    providerBudget: result.providerBudget, finiteTransactions: result.kernel?.transactions,
    durationMs: performance.now() - started, memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
    durableLog: session.durableLog, rolloutPath: result.rolloutPath };
  const redactActual=text=>core.redactSecrets(leg.apiKey?text.replaceAll(leg.apiKey,'[REDACTED]'):text);
  const safe=value=>JSON.parse(JSON.stringify(value,(_key,value)=>typeof value==='string'?redactActual(value):value));
  await save(join(dir, 'transport-inputs.json'),safe( { task: scenario.prompt, config: activeConfig, sampling: activeSampling,
    limits: activeLimits, modelRequests, responses }));
  await save(join(dir, 'result.json'), safe(report));
  if(!options.quiet)process.stdout.write(JSON.stringify({ kernel, scenario: scenarioId, goalStatus, finishReason: result.run.finishReason,
    operationStatuses: operations.map(o => o.status), report: relative(ROOT, join(dir, 'result.json')) }) + '\n');
  return safe(report);
}


return {ROOT,OUT,LEGACY,CONTROL,ORACLE_SHA,ORACLE_SOURCE,ORACLE_ASSEMBLY,DOTNET,CORPUS_ROOT,BRIDGE,LOADER,MANIFEST,FILE,TARGET,SCENARIOS,CONFIG,SAMPLING,LIMITS,hash,fileHash,save,dotnetEnv,treeInputs,prepare,worker,snapshotLegacy,oracle};
}
