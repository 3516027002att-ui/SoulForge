import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseVerificationSkipReason} from '../verification-inputs.mjs';

export function validCaseEvidence(evidence){
  if(!evidence||evidence.schemaVersion!==1||evidence.complete!==true||!Array.isArray(evidence.cases))return false;
  if(!['node','playwright','diagnostic'].includes(evidence.runner))return false;
  if(!['total','passed','failed','skipped'].every(key=>Number.isSafeInteger(evidence[key])&&evidence[key]>=0))return false;
  if(evidence.total!==evidence.passed+evidence.failed+evidence.skipped)return false;
  const rows=evidence.cases;
  if(rows.some(row=>typeof row.id!=='string'||!row.id||!['test','suite'].includes(row.type)||!['passed','failed','skipped'].includes(row.status)))return false;
  if(new Set(rows.map(row=>row.id)).size!==rows.length)return false;
  const leaves=rows.filter(row=>row.type==='test');
  return leaves.length===evidence.total&&['passed','failed','skipped'].every(status=>leaves.filter(row=>row.status===status).length===evidence[status]);
}

export function missingPrivateCorpus(row){
  return parseVerificationSkipReason(JSON.stringify({code:row.reasonCode,missingPrerequisites:row.missingPrerequisites}))?.code==='PRIVATE_CORPUS_MISSING';
}

function privateUnavailable(row){
  const steps=(row.steps??[]).filter(step=>step.validation&&step.outcome!=='passed');
  return steps.length>0&&steps.every(step=>{
    if(!['executed','reused'].includes(step.execution)||!validCaseEvidence(step.caseEvidence)||step.caseEvidence.failed)return false;
    const skipped=step.caseEvidence.cases.filter(item=>item.status==='skipped');
    return skipped.length>0&&skipped.every(missingPrivateCorpus);
  });
}

export function mergeCheckReports(reports,{allowMissingPrivateCorpus=false}={}){
  const blockers=[],resolutions=[],resolved=new Set();
  const key=(report,row)=>`${report.context?.platform}:${row.scriptName}`;
  const finish=()=>({ok:blockers.length===0,completionVerified:blockers.length===0&&!resolutions.some(row=>row.reason==='missing-private-corpus')
      &&!reports.some(report=>report.results?.some(row=>row.status==='unavailable'&&!resolved.has(key(report,row)))),
    sourceHead:reports[0]?.context?.sourceHead??null,sourceTree:reports[0]?.context?.sourceTree??null,
    allowMissingPrivateCorpus,blockers,resolutions,scope:'Source reports and their unavailable counts are preserved; only actually executed counterpart cases or explicit missing private inputs resolve required unavailable legs.'});
  if(!reports.length){blockers.push({reason:'no-reports'});return finish();}
  const first=reports[0];
  if(!/^[a-f0-9]{40}$/i.test(first.context?.sourceHead??'')||!/^[a-f0-9]{40}$/i.test(first.context?.sourceTree??''))blockers.push({reason:'source-binding-missing'});
  for(const report of reports){
    if(report.mode!=='run'||typeof report.ok!=='boolean'||!Array.isArray(report.results)||!report.results.length
      ||!Array.isArray(report.requirements?.tiers)||!Array.isArray(report.requirements?.suites)
      ||typeof report.requirements.requireExecuted!=='boolean'||!Array.isArray(report.auditFindings)
      ||report.context?.sourceVerified!==true||!['linux','win32'].includes(report.context?.platform)
      ||report.context.sourceHead!==first.context?.sourceHead||report.context.sourceTree!==first.context?.sourceTree){blockers.push({reason:'report-source-or-contract-mismatch'});continue;}
    if(report.results.some(row=>!['passed','failed','unavailable','not_run'].includes(row.status)))blockers.push({reason:'invalid-check-status'});
    const counts=Object.fromEntries(['passed','failed','unavailable','not_run'].map(status=>[status,report.results.filter(row=>row.status===status).length]));
    if(Object.entries(counts).some(([status,count])=>report.counts?.[status]!==count))blockers.push({reason:'report-counts-mismatch'});
    if(new Set(report.results.map(row=>row.scriptName)).size!==report.results.length)blockers.push({reason:'duplicate-check-results'});
    if(report.auditFindings.some(row=>row.severity==='error'))blockers.push({reason:'reported-audit-failure'});
    for(const tier of report.requirements.tiers)if(!['governance','unit','synthetic','native','release','e2e'].includes(tier)||!report.results.some(row=>row.tier===tier))blockers.push({reason:'required-tier-missing',tier});
    for(const suite of report.requirements.suites)if(typeof suite!=='string'||!report.results.some(row=>row.scriptName===suite))blockers.push({reason:'required-suite-missing',suite});
    const required=row=>report.requirements.requireExecuted||report.requirements.tiers.includes(row.tier)||report.requirements.suites.includes(row.scriptName);
    const originalBlocking=report.results.some(row=>row.status==='failed'||row.status==='not_run'
      ||row.status==='unavailable'&&required(row)&&!(report.requirements.allowMissingPrivateCorpus&&privateUnavailable(row)));
    const expectedOk=!originalBlocking&&!report.auditFindings.some(row=>row.severity==='error')
      &&report.results.some(row=>row.status==='passed'||report.requirements.allowMissingPrivateCorpus&&privateUnavailable(row));
    if(expectedOk!==report.ok)blockers.push({reason:'contradictory-check-verdict'});
    for(const row of report.results)for(const step of row.steps??[])if(step.caseEvidence
      &&(!validCaseEvidence(step.caseEvidence)||step.caseEvidence.failed>0))blockers.push({suite:row.scriptName,reason:'damaged-or-failed-case-evidence'});
    for(const row of report.results)if(row.status==='failed'||row.status==='not_run'||(row.exitCode!=null&&row.exitCode!==0))blockers.push({suite:row.scriptName,platform:report.context.platform,reason:row.status});
  }
  if(blockers.length)return finish();
  const executed=new Map();
  for(const report of reports)for(const row of report.results)for(const step of row.steps??[]){
    if(!['executed','reused'].includes(step.execution)||!validCaseEvidence(step.caseEvidence))continue;
    if(step.caseEvidence.failed>0){blockers.push({suite:row.scriptName,reason:'failed-case-evidence'});continue;}
    for(const item of step.caseEvidence.cases)if(item.status==='passed'){
      if(item.type==='suite'){
        const descendants=step.caseEvidence.cases.filter(child=>child.type==='test'&&Array.isArray(child.titlePath)
          &&Array.isArray(item.titlePath)&&child.titlePath.length>item.titlePath.length
          &&item.titlePath.every((name,index)=>child.titlePath[index]===name));
        if(!descendants.length||descendants.some(child=>child.status!=='passed'))continue;
      }
      const id=`${item.type}:${item.id}`;
      const platforms=executed.get(id)??new Set();platforms.add(report.context.platform);executed.set(id,platforms);
    }
  }
  for(const report of reports)for(const row of report.results){
    const required=report.requirements.requireExecuted||report.requirements.tiers?.includes(row.tier)||report.requirements.suites?.includes(row.scriptName);
    if(row.status!=='unavailable'||!required)continue;
    let unresolved=false,privateLimit=false,covered=false;
    const unavailable=(row.steps??[]).filter(step=>step.validation&&step.outcome!=='passed');
    if(!unavailable.length)unresolved=true;
    for(const step of unavailable){
      const evidence=step.caseEvidence;
      if(!['executed','reused'].includes(step.execution)||!validCaseEvidence(evidence)){unresolved=true;continue;}
      const skipped=evidence.cases.filter(item=>item.status==='skipped');
      if(!skipped.length){unresolved=true;continue;}
      for(const item of skipped){
        if(item.reasonCode==='TEST_TODO'){unresolved=true;continue;}
        if(allowMissingPrivateCorpus&&missingPrivateCorpus(item)){privateLimit=true;continue;}
        if([...executed.get(`${item.type}:${item.id}`)??[]].some(platform=>platform!==report.context.platform)){covered=true;continue;}
        unresolved=true;
      }
    }
    if(unresolved)blockers.push({suite:row.scriptName,platform:report.context.platform,reason:'required-unavailable-case-not-covered'});
    else{resolved.add(key(report,row));resolutions.push({suite:row.scriptName,platform:report.context.platform,reason:privateLimit?'missing-private-corpus':'executed-on-another-platform',...(privateLimit&&covered?{alsoCoveredOnAnotherPlatform:true}:{})});}
  }
  return finish();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),paths=[];let output,allowMissingPrivateCorpus=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--allow-missing-private-corpus')allowMissingPrivateCorpus=true;
    else if(args[i]==='--json-out')output=args[++i];
    else paths.push(args[i]);
  }
  const result=mergeCheckReports(paths.map(path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))),{allowMissingPrivateCorpus});
  if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
}
