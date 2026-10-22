import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function decodeTaskInput(bytes) {
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/u, ''); }
  catch { const error = new Error('Task input must be valid UTF-8.'); error.code = 'TASK_INPUT_ENCODING_INVALID'; throw error; }
}

export async function captureAgentRunProvenance(repoRoot, {task, goals, taskContract}) {
  const git = async (...args) => (await exec('git', args, {cwd:repoRoot,maxBuffer:32*1024*1024,encoding:'utf8'})).stdout;
  let source;
  try {
    const [commit, diff, status] = await Promise.all([git('rev-parse','HEAD'), git('diff','--binary','HEAD'), git('status','--porcelain')]);
    source = {commit:commit.trim(), trackedDiffSha256:hash(diff), dirty:status.trim() !== '',
      statusSha256:hash(status), identityScope:'git-head-and-tracked-working-diff'};
  } catch (error) { source = {commit:null,status:'unavailable',reason:error.code ?? 'GIT_SOURCE_IDENTITY_UNAVAILABLE'}; }
  return {source, input:{encoding:'UTF-8',taskSha256:hash(Buffer.from(task,'utf8')),
    goalsSha256:hash(JSON.stringify(goals)), contractSha256:hash(JSON.stringify(taskContract ?? null))}};
}

/** The live checkout is context, never a substitute for a pinned artifact's revision. */
export function bindTestedArtifact(summary, {mode,manifest,liveSource}) {
  const snapshot = mode === 'immutable-snapshot';
  return {...summary,commit:snapshot ? manifest?.sourceRevision ?? null : mode === 'live-build' ? liveSource?.commit ?? null : null,
    sourceHash:snapshot ? manifest?.liveBuild?.sourceSha256 ?? summary.sourceHash ?? null : summary.sourceHash ?? null,
    revisionSource:snapshot ? 'snapshot-manifest' : mode === 'live-build' ? 'live-checkout-bound-build' : 'unavailable',
    liveCheckout:liveSource ?? null};
}

/** Explicit non-secret allowlist. URL userinfo/query/fragment and headers never enter records. */
export function bindProviderConfiguration(config) {
  let endpoint=null;
  try { const url=new URL(config.baseUrl);endpoint=`${url.protocol}//${url.host}${url.pathname}`; } catch { /* Invalid config is separately rejected by the provider. */ }
  const configuration={};
  for(const key of ['id','protocol','model','temperature','topP','topK','maxTokens','thinkingLevel','contextWindowTokens']){
    if(['string','number','boolean'].includes(typeof config[key]))configuration[key]=config[key];
  }
  configuration.endpoint=endpoint;
  return {...configuration,configSha256:hash(JSON.stringify(configuration)),identityScope:'selected-non-secret-provider-configuration'};
}

export async function captureVerifierArtifact(repoRoot, inputs) {
  const {readdir,readFile,stat}=await import('node:fs/promises');
  const {resolve,relative}=await import('node:path');
  const digest=createHash('sha256');let fileCount=0;const missing=[];
  const walk=async input=>{
    const file=resolve(repoRoot,input);let metadata;
    try{metadata=await stat(file);}catch(error){if(error.code!=='ENOENT')throw error;missing.push(input);digest.update(`missing:${input}\n`);return;}
    if(metadata.isDirectory()){for(const entry of (await readdir(file)).sort())await walk(relative(repoRoot,resolve(file,entry)));return;}
    const bytes=await readFile(file);digest.update(relative(repoRoot,file).replaceAll('\\','/'));digest.update('\0');digest.update(bytes);fileCount++;
  };
  for(const input of [...inputs].sort())await walk(input);
  return {sha256:digest.digest('hex'),fileCount,inputs:[...inputs],missing,scope:'independent-verifier-artifact'};
}
