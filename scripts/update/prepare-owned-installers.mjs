/** Build real, isolated A/B NSIS inputs. Never reuse the official app identity. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,mkdtemp,readdir,writeFile,appendFile,realpath,lstat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess,processSucceeded} from '../subprocess-control.mjs';
import {assertAgentProductionBuildFresh} from '../agent-production-build-lib.mjs';
import {captureOwnedBuildInputs,captureOwnedFiles,resolveOwnedInstallerTools,regularOwnedFile} from './owned-build-inputs.mjs';
import {validateInstalledManifest,readInstallerVersionInfo,assertInstallerProductNames} from './installed-a-to-b.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>Object.assign(new Error(`${code}: ${message}`),{code});
const inside=(root,path)=>{const value=relative(resolve(root),resolve(path));return value!==''&&value!=='..'&&!value.startsWith(`..${sep}`)&&!isAbsolute(value);};
export function productionBuildIdentity(manifest) {
  const productionSourceHash=manifest?.source?.sha256,productionOutputHash=manifest?.output?.sha256;
  if(manifest?.schemaVersion!==1||![productionSourceHash,productionOutputHash].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Actual production source/output fingerprints are required');
  }
  return {productionSourceHash,productionOutputHash};
}
export function ownedInstallerIdentity(id=randomUUID().replaceAll('-','')) {
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('A fresh owned validation identity is required');
  const short=id.slice(0,12),productName=`SoulForge Validation ${short}`;
  return {appId:`com.soulforge.validation.${id}`,productName,shortcutName:productName,
    executableName:`SoulForgeValidation-${short}`,packageName:`soulforge-validation-${short}`};
}
export function ownedInstallerConfig(base,identity,version,output) {
  if(!/^com\.soulforge\.validation\.[a-f0-9]{32}$/.test(identity.appId))throw new Error('Official identities are forbidden');
  return {...base,appId:identity.appId,productName:identity.productName,executableName:identity.executableName,
    directories:{...base.directories,output},
    extraMetadata:{...base.extraMetadata,name:identity.packageName,productName:identity.productName,version},
    nsis:{...base.nsis,shortcutName:identity.shortcutName,uninstallDisplayName:identity.productName,
      perMachine:false,allowElevation:false},win:{...base.win,signAndEditExecutable:true},publish:null};
}

export async function inspectOwnedPackage(legRoot,identity,version,tools) {
  const asar=createRequire(import.meta.url)(tools.asarModulePath);
  const resourcesRoot=join(legRoot,'win-unpacked','resources'),asarPath=join(resourcesRoot,'app.asar');
  const archiveStat=await lstat(asarPath);
  if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||!inside(legRoot,await realpath(asarPath))) {
    throw fail('UPDATE_PREPARE_PACKAGE_INVALID','Packaged ASAR must be an unlinked file under this owned output.');
  }
  const rows=[];let packageMetadata;
  for(const name of asar.listPackage(asarPath).sort()) {
    const path=String(name).replaceAll('\\','/').replace(/^\/+/, '');
    if(!path||path.split('/').includes('..')||path.includes('\0'))throw fail('UPDATE_PREPARE_PACKAGE_INVALID','Invalid ASAR entry identity.');
    const nativePath=path.split('/').join(sep),stat=asar.statFile(asarPath,nativePath,false);
    if(stat.files)continue;
    if(stat.link)throw fail('UPDATE_PREPARE_PACKAGE_INVALID',`ASAR links cannot bind packaged payload: ${path}`);
    const bytes=asar.extractFile(asarPath,nativePath);
    if(path==='package.json') {
      packageMetadata=JSON.parse(bytes.toString('utf8'));
      const {version:_version,...unchanged}=packageMetadata;
      rows.push({path,sha256:hash(JSON.stringify(unchanged))});
    } else rows.push({path,sha256:hash(bytes)});
  }
  if(!packageMetadata||!rows.some(row=>row.path==='out/main/index.js')||!rows.some(row=>row.path.startsWith('out/preload/'))
    ||!rows.some(row=>row.path==='out/renderer/index.html'))throw fail('UPDATE_PREPARE_PACKAGE_INVALID','Packaged production main/preload/renderer are required.');
  if(packageMetadata.name!==identity.packageName||packageMetadata.productName!==identity.productName||packageMetadata.version!==version) {
    throw fail('UPDATE_PREPARE_PACKAGE_INVALID','Packaged ASAR identity/version differs from the owned A/B config.');
  }
  // Hash every other resource too, including app.asar.unpacked. app.asar itself
  // is represented by the per-entry hashes above; only package.json.version is normalized.
  const external=await captureOwnedFiles(resourcesRoot,legRoot,(path)=>path!==asarPath);
  for(const row of external)rows.push({path:`resources/${row.path}`,sha256:row.sha256});
  return {packageMetadata,payloadSha256:hash(JSON.stringify(rows)),fileCount:rows.length};
}

export async function prepareOwnedInstallers({repositoryRoot,allowOwnedInstallation=false},ports={}) {
  const platform=ports.platform??process.platform,arch=ports.arch??process.arch;
  if(platform!=='win32'||arch!=='x64'||!allowOwnedInstallation)throw fail('UPDATE_PREPARE_WINDOWS_REQUIRED','Windows x64 and --allow-owned-installation are required');
  const root=await realpath(repositoryRoot),project=join(root,'apps/desktop');
  const tools=await (ports.resolveOwnedInstallerTools??resolveOwnedInstallerTools)(root);
  const production=productionBuildIdentity((await (ports.assertAgentProductionBuildFresh??assertAgentProductionBuildFresh)(root)).manifest);
  const capture=ports.captureOwnedBuildInputs??captureOwnedBuildInputs;
  const capturePorts=ports.capturePorts??{};
  const before=await capture(root,tools,capturePorts);
  if(!/^[a-f0-9]{40}$/i.test(before.headSha??''))throw fail('UPDATE_PREPARE_HEAD_REQUIRED','Current HEAD must bind the installer build.');
  if(before.agentSourceSha256!==production.productionSourceHash||before.agentOutputSha256!==production.productionOutputHash) {
    throw fail('UPDATE_PREPARE_INPUT_CHANGED','Agent production input fingerprints changed during initial capture.');
  }
  const base=JSON.parse(await regularOwnedFile(join(project,'electron-builder.json')));
  const parent=join(root,'.local-validation','owned-update-installers');await mkdir(parent,{recursive:true});
  const output=await mkdtemp(join(parent,'run-')),identity=ownedInstallerIdentity(),configs={},artifacts={},payloads={},commands=[];
  const sameInputs=async()=>{
    let after;
    try { after=await capture(root,tools,capturePorts); }
    catch(captureError) {
      const error=fail('UPDATE_PREPARE_INPUT_CHANGED',`Could not revalidate HEAD/source/runtime/Bridge/packaging/tool inputs during the A/B build: ${captureError.message}`);
      error.cause=captureError;
      throw error;
    }
    if(JSON.stringify(before)!==JSON.stringify(after))throw fail('UPDATE_PREPARE_INPUT_CHANGED','HEAD/source/runtime/Bridge/packaging/tool inputs changed during the A/B build.');
  };
  const builderRun=ports.runProcess??runProcess,inspect=ports.inspectOwnedPackage??inspectOwnedPackage;
  const env={...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false',
    ELECTRON_BUILDER_CACHE:join(root,'.local-validation','electron-builder-cache')};
  try {
    for(const [index,leg] of ['a','b'].entries()) {
      await sameInputs();
      const version=`0.9.2-validation.${index+1}`,legRoot=join(output,leg);
      const config=ownedInstallerConfig(base,identity,version,legRoot);
      const configPath=join(output,`config-${leg}.json`),configBytes=Buffer.from(JSON.stringify(config,null,2));
      await writeFile(configPath,configBytes,{flag:'wx'});configs[leg]={path:configPath,sha256:hash(configBytes)};
      const args=[tools.builderCli,'--projectDir',project,'--config',configPath,'--win','nsis','--x64','--publish','never'];
      const result=await builderRun({command:process.execPath,args,cwd:project,timeoutMs:25*60_000,env});
      await writeFile(join(output,`${leg}.stdout.log`),result.stdout??'',{flag:'wx'});
      await writeFile(join(output,`${leg}.stderr.log`),result.stderr??'',{flag:'wx'});
      commands.push({argv:[process.execPath,...args],exitCode:result.code,timedOut:result.timedOut===true,cancelled:result.cancelled===true});
      if(!processSucceeded(result))throw fail('UPDATE_PREPARE_BUILD_FAILED',`Owned ${leg} installer build failed; inspect retained output ${output}.`);
      await sameInputs();
      const names=(await readdir(legRoot)).filter(name=>name.toLowerCase().endsWith('.exe'));
      if(names.length!==1)throw fail('UPDATE_PREPARE_ARTIFACT_INVALID',`Expected exactly one actual ${leg.toUpperCase()} NSIS installer.`);
      const path=join(legRoot,names[0]),stat=await lstat(path);
      if(!stat.isFile()||stat.isSymbolicLink()||!inside(output,await realpath(path)))throw fail('UPDATE_PREPARE_ARTIFACT_INVALID','Installer escaped its owned output.');
      artifacts[leg]={path,version,sha256:hash(await regularOwnedFile(path))};
      payloads[leg]=await inspect(legRoot,identity,version,tools);
      if(payloads[leg].packageMetadata?.name!==identity.packageName||payloads[leg].packageMetadata?.productName!==identity.productName
        ||payloads[leg].packageMetadata?.version!==version)throw fail('UPDATE_PREPARE_PACKAGE_INVALID','Packaged identity/version differs from its owned config.');
      await sameInputs();
    }
    if(payloads.a.payloadSha256!==payloads.b.payloadSha256||payloads.a.fileCount!==payloads.b.fileCount) {
      throw fail('UPDATE_PREPARE_PAYLOAD_CHANGED','A/B packaged payload differs beyond package.json.version.');
    }
    const manifest={schemaVersion:1,execute:true,identity,...artifacts,scope:'unsigned-owned-identity-manual-nsis-a-to-b-same-source',
      asarModulePath:tools.asarModulePath,asarModuleSha256:tools.asarModuleSha256,buildReceiptPath:join(output,'build-receipt.json')};
    const binaryInfo=await (ports.readInstallerVersionInfo??readInstallerVersionInfo)([artifacts.a.path,artifacts.b.path]);
    assertInstallerProductNames(manifest,binaryInfo);
    const receipt={schemaVersion:1,builderVersion:tools.builderVersion,sourceHead:before.headSha,trackedDiffSha256:before.trackedDiffSha256,
      ...production,identity,...artifacts,configs,buildInputs:before,tools,payloads,commands,binaryInfo,generatedAt:new Date().toISOString()};
    const receiptBytes=Buffer.from(JSON.stringify(receipt,null,2));
    await writeFile(manifest.buildReceiptPath,receiptBytes,{flag:'wx'});manifest.buildReceiptSha256=hash(receiptBytes);
    await sameInputs();
    await validateInstalledManifest(manifest,{expectedHeadSha:before.headSha});
    const manifestPath=join(output,'manifest.json');
    await writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx'});
    if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,`SOULFORGE_UPDATE_INSTALLED_MANIFEST=${manifestPath}\n`);
    await writeFile(join(parent,'current-manifest-path.txt'),manifestPath);
    return {status:'built',manifestPath,sourceHead:receipt.sourceHead,scope:manifest.scope};
  } catch(error) {
    try { await writeFile(join(output,'failure.json'),JSON.stringify({code:error.code??'UPDATE_PREPARE_FAILED',message:error.message,
      sourceHead:before.headSha,trackedDiffSha256:before.trackedDiffSha256,commands},null,2),{flag:'wx'}); }
    catch(recordError) { throw new AggregateError([error,recordError],`${error.message}\nUPDATE_PREPARE_FAILURE_EVIDENCE_FAILED: ${recordError.message}`); }
    throw error;
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==1||args[0]!=='--allow-owned-installation')throw new Error('Usage: node scripts/update/prepare-owned-installers.mjs --allow-owned-installation');
  console.log(JSON.stringify(await prepareOwnedInstallers({repositoryRoot:resolve(dirname(fileURLToPath(import.meta.url)),'../..'),allowOwnedInstallation:true})));
}
