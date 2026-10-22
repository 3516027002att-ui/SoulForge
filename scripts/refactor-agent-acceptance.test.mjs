import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acceptanceTasks,evaluateAcceptanceLeg} from './testing/refactor-agent-acceptance.mjs';
const oracles=Object.fromEntries(['param','fmg','emevd','tae'].map(domain=>[domain,{target:{value:1}}]));
test('acceptance has 12 cross-domain tasks and excludes owner-deferred four-4',()=>{
 const tasks=acceptanceTasks(oracles);assert.equal(tasks.length,12);assert.equal(new Set(tasks.map(t=>t.id)).size,12);
 for(const domain of Object.keys(oracles))assert.equal(tasks.filter(t=>t.domain===domain).length,3);
 assert.equal(tasks.some(t=>t.id.includes('four-4')),false);
});
test('equal final bytes cannot erase a forbidden committed write, and a model stop is not verification',()=>{
 const task=acceptanceTasks(oracles)[0],before={target:{value:1},preservedSha256:'p',sourceSha256:'a'};
 const input={task,before,after:before,tools:[],operations:[],originalPreserved:true,sentinelPreserved:true,claim:{claimedStatus:'completed',observedValue:1}};
 assert.equal(evaluateAcceptanceLeg(input).status,'failed');
 const observed={...input,tools:[{call:{name:'read_param_fields'},result:{ok:true,content:JSON.stringify({evidence:{status:'native-verified'},data:{record:{fields:[{table:'NpcParam',rowId:50800000,fieldId:'ninsatuNum',value:1}]}}})}}]};
 assert.equal(evaluateAcceptanceLeg(observed).status,'passed');
 const wrong=evaluateAcceptanceLeg({...observed,operations:[{opId:'unexpected',status:'rolled_back'}]});
 assert.equal(wrong.wrongWrite,true);assert.equal(wrong.falseSuccess,true);
});
test('native-verified label with a wrong value is not independent read proof',()=>{
 const task={domain:'fmg',kind:'read',target:{table:'Title',id:1000}},before={target:{value:'Spirit Emblem'},sourceSha256:'s',preservedSha256:'p'};
 const tools=[{call:{name:'read_fmg_entries'},result:{ok:true,content:JSON.stringify({evidence:{status:'native-verified'},data:{record:{entries:[{table:'Title',id:1000,text:null}]}}})}}];
 const input={task,before,after:before,tools,operations:[],originalPreserved:true,sentinelPreserved:true,claim:{claimedStatus:'completed',observedValue:null}};
 assert.equal(evaluateAcceptanceLeg(input).falseSuccess,true);
 assert.equal(evaluateAcceptanceLeg(input).nativeReadObserved,false);
 tools[0].result.content=tools[0].result.content.replace('"text":null','"text":"Spirit Emblem"');
 const denied=evaluateAcceptanceLeg({...input,task:{...task,kind:'refusal'},claim:{state:'blocked',data:{claimedStatus:'blocked',observedValue:'Spirit Emblem'}}});
 assert.equal(denied.status,'passed');
 assert.equal(evaluateAcceptanceLeg({...input,after:undefined}).status,'failed');
});
test('an owned write without verified exact rollback fails acceptance',()=>{
 const task=acceptanceTasks(oracles).find(t=>t.id==='param-write-rollback');
 const value=evaluateAcceptanceLeg({task,before:{target:{value:3},preservedSha256:'p',sourceSha256:'a'},after:{target:{value:2},preservedSha256:'p',sourceSha256:'b'},
 tools:[{call:{name:'read_param_fields'},result:{ok:true,content:'{"evidence":{"status":"native-verified"}}'}}],operations:[{opId:'write',status:'committed'}],originalPreserved:true,sentinelPreserved:true});
 assert.equal(value.status,'failed');assert.equal(value.rollbackVerified,false);
});
