import {relative,resolve} from 'node:path';
import {parseVerificationSkipReason} from '../verification-inputs.mjs';

export default async function* report(source){
  const cases=[],parents=new Map();let summary;
  const root=resolve(process.env.SOULFORGE_CHECK_ROOT??process.cwd());
  for await(const event of source){
    const data=event.data;
    if(event.type==='test:start'){
      const path=parents.get(data.file)??[];
      path[data.nesting]=data.name;path.length=data.nesting+1;parents.set(data.file,path);
    }
    if(event.type==='test:summary'&&!data.file) summary=data.counts;
    if(!['test:pass','test:fail'].includes(event.type))continue;
    let reason;
    if(typeof data.skip==='string')reason=parseVerificationSkipReason(data.skip);
    const titlePath=[...(parents.get(data.file)??[]).slice(0,data.nesting),data.name];
    cases.push({id:`${relative(root,data.file??root).replaceAll('\\','/')}:${data.line??0}:${data.column??0}:${titlePath.join(' > ')}`,titlePath,
      type:data.details?.type==='suite'?'suite':'test',
      status:data.skip||data.todo?'skipped':event.type==='test:fail'?'failed':'passed',
      reasonCode:data.todo?'TEST_TODO':reason?.code??'UNKNOWN',missingPrerequisites:reason?.missingPrerequisites??[]});
  }
  const leaves=cases.filter(row=>row.type==='test');
  const count=status=>leaves.filter(row=>row.status===status).length;
  const total=summary?.tests??-1,passed=count('passed'),failed=count('failed'),skipped=count('skipped');
  const complete=Boolean(summary)&&new Set(cases.map(row=>row.id)).size===cases.length
    &&total===leaves.length&&passed===summary.passed&&failed===summary.failed
    &&skipped===(summary.skipped+summary.todo)&&summary.cancelled===0;
  yield JSON.stringify({soulforgeCheckCases:{schemaVersion:1,runner:'node',complete,total,passed,failed,skipped,cases}})+'\n';
}
