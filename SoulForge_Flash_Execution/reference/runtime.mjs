import { check, integer } from './common.mjs';
function overlap(a,b) { return a.some(x=>x==='*'||b.includes('*')||b.includes(x)); }
export function effectsConflict(a,b) {
  return overlap(a.writes,[...b.reads,...b.writes])||overlap(b.writes,[...a.reads,...a.writes]);
}
/**
 * Stable return order, immediate completion events, bounded active work.
 * A running uncooperative promise holds its slot until actual settlement; no unsafe Promise.race timeout.
 * Cancellation requires the passed signal to be honored by each production adapter.
 */
export async function runScheduled(tasks,{concurrency=4,signal,onEnd=()=>{}}={}) {
  integer(concurrency,1,8);check(Array.isArray(tasks)&&tasks.length<=32,'TOOL_BATCH_TOO_LARGE');
  const ids=new Map(tasks.map((t,i)=>[t.id,i]));check(ids.size===tasks.length,'DUPLICATE_CALL_ID');
  const deps=tasks.map((t,i)=>{
    const d=new Set((t.dependsOn??[]).map(id=>{check(ids.has(id),'DEPENDENCY_UNKNOWN');return ids.get(id);}));
    for(let j=0;j<i;j++)if(effectsConflict(tasks[j],t))d.add(j);
    return d;
  });
  // Validate the graph before starting any side effect.
  const visited=new Set(),visiting=new Set();
  function visit(i){check(!visiting.has(i),'DEPENDENCY_CYCLE');if(visited.has(i))return;
    visiting.add(i);for(const j of deps[i])visit(j);visiting.delete(i);visited.add(i);}
  tasks.forEach((_,i)=>visit(i));
  const pending=new Set(tasks.map((_,i)=>i)),active=new Set(),results=new Array(tasks.length);
  const notificationErrors=[];
  const notify=(i,result)=>{try{onEnd({id:tasks[i].id,index:i,result});}catch(e){notificationErrors.push(String(e));}};
  const settle=(i,result)=>{results[i]=result;notify(i,result);};
  while(pending.size||active.size){
    if(signal?.aborted)for(const i of pending){settle(i,{ok:false,code:'CANCELLED_BEFORE_START'});pending.delete(i);}
    for(const i of [...pending]){
      if(active.size>=concurrency)break;
      if([...deps[i]].some(j=>results[j]===undefined))continue;
      // Explicit data dependencies fail closed; ordering edges merely serialize effects.
      if((tasks[i].dependsOn??[]).some(id=>!results[ids.get(id)].ok)){
        pending.delete(i);settle(i,{ok:false,code:'DEPENDENCY_FAILED'});continue;
      }
      pending.delete(i);
      const job=Promise.resolve().then(()=>tasks[i].run({signal})).then(value=>{
        check(value !== null && typeof value === 'object' && typeof value.ok === 'boolean','INVALID_TOOL_RESULT');
        return value;
      }).catch(error=>({ok:false,code:error?.code??'TOOL_THROWN',message:String(error?.message??error)}))
      .then(result=>settle(i,result)).finally(()=>active.delete(job));
      active.add(job);
    }
    if(active.size)await Promise.race(active);
    else check(pending.size===0,'SCHEDULER_STUCK');
  }
  return {results,notificationErrors};
}
export function classifyRecovery(beforeHash,afterHash,currentHash) {
  check(typeof beforeHash==='string'&&typeof afterHash==='string'&&typeof currentHash==='string','HASH_REQUIRED');
  if(beforeHash===afterHash&&currentHash===beforeHash)return 'NOOP';
  if(currentHash===beforeHash)return 'NOT_APPLIED';
  if(currentHash===afterHash)return 'APPLIED';
  return 'CONFLICT';
}
export function completion(goals,transactionOutcomes) {
  check(goals.length>0,'GOALS_REQUIRED');
  const tx=new Map(transactionOutcomes.map(t=>[t.id,t]));
  if(transactionOutcomes.some(t=>t.state==='recovery_required'))return 'recovery_required';
  const valid=goals.every(g=>{
    if(g.state==='already_satisfied')return g.currentNativeProof===true;
    if(g.state!=='verified'||g.currentNativeProof!==true)return false;
    if(g.intent==='read')return true;
    const outcome=tx.get(g.transactionId);
    return outcome?.state==='verified'&&outcome.postconditions.includes(g.id);
  });
  if(valid)return 'success';
  return goals.some(g=>g.state==='verified'||g.state==='already_satisfied')?'partial':'blocked';
}
