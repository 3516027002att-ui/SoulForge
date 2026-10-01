/** Explicit experiment entry. Default/dry-run performs no provider or native execution. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {previewAgentExperiment,executeAgentExperiment,validateExperimentInputs} from './testing/agent-provider-experiment.mjs';
export function parseProviderExperimentArguments(argv){
 const options={repoRoot:resolve(dirname(fileURLToPath(import.meta.url)),'..'),experiment:'description-dedup',execute:false,budget:{},sampling:{temperature:0,topP:1,maxTokens:512}};
 const fields={'--experiment':'experiment','--provider-config':'providerConfig','--corpus-root':'corpusRoot','--dotnet':'dotnet','--oracle-assembly':'oracleAssembly','--bridge':'bridge','--output-root':'outputRoot','--report':'report','--repo-root':'repoRoot'};
 const budgets={'--max-cost':'maxCost','--max-leg-cost':'maxLegCost','--max-output-tokens':'maxOutputTokens','--max-leg-output-tokens':'maxLegOutputTokens','--timeout-ms':'timeoutMs','--leg-timeout-ms':'maxLegTimeoutMs','--max-steps':'maxSteps'};
 const sampling={'--temperature':'temperature','--top-p':'topP','--max-tokens':'maxTokens'};
 let selectedMode;
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];if(flag==='--execute'||flag==='--dry-run'){if(selectedMode&&selectedMode!==flag)throw Object.assign(new Error('Choose either dry-run or execution.'),{code:'AGENT_EXPERIMENT_MODE_CONFLICT'});selectedMode=flag;options.execute=flag==='--execute';continue;}
  const value=argv[++index];if(value===undefined||value.startsWith('--'))throw Object.assign(new Error('Every experiment argument requires its explicit value.'),{code:'AGENT_EXPERIMENT_ARGUMENT_INVALID'});
  if(fields[flag])options[fields[flag]]=value;else if(budgets[flag])options.budget[budgets[flag]]=Number(value);else if(sampling[flag])options.sampling[sampling[flag]]=Number(value);else throw Object.assign(new Error('Unknown experiment argument.'),{code:'AGENT_EXPERIMENT_ARGUMENT_INVALID'});
 }
 if(!options.providerConfig)throw Object.assign(new Error('An explicit provider configuration file is required, even in dry-run.'),{code:'AGENT_EXPERIMENT_PROVIDER_REQUIRED'});
 return options;
}
export async function runProviderExperimentCommand(argv){
 const input=parseProviderExperimentArguments(argv);input.provider=JSON.parse(await readFile(resolve(input.providerConfig),'utf8'));
 validateExperimentInputs(input);
 const plan=await previewAgentExperiment(input),report=input.execute?await executeAgentExperiment(input,plan):plan;
 if(input.report){const target=resolve(input.report);await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const report=await runProviderExperimentCommand(process.argv.slice(2));process.stdout.write(JSON.stringify(report,null,2)+'\n');if(report.status==='unavailable')process.exitCode=2;}
 catch(error){process.stderr.write(JSON.stringify({status:'unavailable',execution:'not_run',code:error.code??'AGENT_EXPERIMENT_INPUT_INVALID',message:error.code?error.message:'Experiment input could not be parsed or bound; no execution occurred.'})+'\n');process.exitCode=2;}
}
