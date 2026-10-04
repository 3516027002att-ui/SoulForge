/** Build real, isolated A/B NSIS inputs. Never reuse the official app identity. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,mkdtemp,readdir,writeFile,appendFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess,processSucceeded} from '../subprocess-control.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
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

export async function prepareOwnedInstallers({repositoryRoot,allowOwnedInstallation=false}) {
  if(process.platform!=='win32'||!allowOwnedInstallation)throw new Error('Windows and --allow-owned-installation are required');
  const root=await realpath(repositoryRoot),toolsRoot=join(root,'.local-validation','update-tools');
  const require=createRequire(join(toolsRoot,'package.json'));
  const builder=require.resolve('electron-builder/cli.js'),asarModulePath=require.resolve('@electron/asar');
  const builderVersion=JSON.parse(await readFile(require.resolve('electron-builder/package.json'),'utf8')).version;
  if(builderVersion!=='26.16.1')throw new Error('Install the pinned electron-builder 26.16.1 in .local-validation/update-tools');
  const base=JSON.parse(await readFile(join(root,'apps/desktop/electron-builder.json'),'utf8'));
  const productionManifest=JSON.parse(await readFile(join(root,'apps/desktop/out/agent-production-build.json'),'utf8'));
  const parent=join(root,'.local-validation','owned-update-installers');await mkdir(parent,{recursive:true});
  const output=await mkdtemp(join(parent,'run-')),identity=ownedInstallerIdentity(),configs={},artifacts={};
  for(const [leg,version] of [['a','0.9.2-validation.1'],['b','0.9.2-validation.2']]){
    const legRoot=join(output,leg),config=ownedInstallerConfig(base,identity,version,legRoot);
    const configPath=join(output,`config-${leg}.json`),configBytes=Buffer.from(JSON.stringify(config,null,2));
    await writeFile(configPath,configBytes);configs[leg]={path:configPath,sha256:hash(configBytes)};
    const result=await runProcess({command:process.execPath,args:[builder,'--projectDir',join(root,'apps/desktop'),
      '--config',configPath,'--win','nsis','--x64','--publish','never'],cwd:join(root,'apps/desktop'),timeoutMs:25*60_000,
      env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false',ELECTRON_BUILDER_CACHE:join(root,'.local-validation','electron-builder-cache')}});
    await writeFile(join(output,`${leg}.stdout.log`),result.stdout);await writeFile(join(output,`${leg}.stderr.log`),result.stderr);
    if(!processSucceeded(result))throw new Error(`Owned ${leg} installer build failed; inspect ${output}`);
    const files=(await readdir(legRoot)).filter(name=>name.endsWith('.exe'));
    if(files.length!==1)throw new Error(`Expected one actual NSIS installer for ${leg}`);
    const path=join(legRoot,files[0]);artifacts[leg]={path,version,sha256:hash(await readFile(path))};
  }
  const head=await runProcess({command:'git',args:['rev-parse','HEAD'],cwd:root,timeoutMs:15_000});
  const diff=await runProcess({command:'git',args:['diff','HEAD','--binary'],cwd:root,timeoutMs:15_000,outputLimitBytes:16*1024*1024});
  if(!processSucceeded(head)||!processSucceeded(diff)||diff.stdoutTruncated||!/^[a-f0-9]{40}$/.test(head.stdout.trim()))throw new Error('Source identity unavailable');
  const receipt={schemaVersion:1,builderVersion,sourceHead:head.stdout.trim(),trackedDiffSha256:hash(diff.stdout),
    productionSourceHash:productionManifest.sourceHash,productionOutputHash:productionManifest.outputHash,identity,...artifacts,configs};
  const receiptPath=join(output,'build-receipt.json'),receiptBytes=Buffer.from(JSON.stringify(receipt,null,2));await writeFile(receiptPath,receiptBytes);
  const manifest={schemaVersion:1,execute:true,identity,...artifacts,scope:'unsigned-owned-identity-manual-nsis-a-to-b-same-source',
    asarModulePath,asarModuleSha256:hash(await readFile(asarModulePath)),buildReceiptPath:receiptPath,buildReceiptSha256:hash(receiptBytes)};
  const manifestPath=join(output,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,`SOULFORGE_UPDATE_INSTALLED_MANIFEST=${manifestPath}\n`);
  await writeFile(join(parent,'current-manifest-path.txt'),manifestPath);
  return {status:'built',manifestPath,sourceHead:receipt.sourceHead,scope:manifest.scope};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==1||args[0]!=='--allow-owned-installation')throw new Error('Usage: node scripts/update/prepare-owned-installers.mjs --allow-owned-installation');
  console.log(JSON.stringify(await prepareOwnedInstallers({repositoryRoot:resolve(dirname(fileURLToPath(import.meta.url)),'../..'),allowOwnedInstallation:true})));
}
