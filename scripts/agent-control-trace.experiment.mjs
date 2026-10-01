import {materializeLegacyAgentBaseline} from './testing/legacy-agent-baseline.mjs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runAgentSession} from '../packages/core/dist/index.js';
const config={id:'trace',displayName:'trace',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'deterministic-trace',hasCredential:false,createdAt:'',updatedAt:''};
const read={message:{role:'assistant',content:'',toolCalls:[{id:'read',name:'inspect_fixture',argumentsJson:'{}'}]},finishReason:'tool_use',diagnostics:[]};
const done={message:{role:'assistant',content:'The result is reported.'},finishReason:'stop',diagnostics:[]};
for(const [name,outputs,needle] of [
 ['forced-length',[read,{message:{role:'assistant',content:'Truncated report'},finishReason:'length',diagnostics:[]},done],'下一次模型调用禁止使用工具'],
 ['empty-conclusion',[read,{message:{role:'assistant',content:''},finishReason:'stop',diagnostics:[]},done],'请根据上述已执行的工具'],
 ['future-conclusion',[{message:{role:'assistant',content:'接下来我会继续读取参数并进行修改。'},finishReason:'stop',diagnostics:[]},done],'你刚才只描述了将要执行的动作']
])test(`legacy comparison baseline records the ${name} control instruction actually sent to the provider`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-control-trace-'));const requests=[];let turn=0;
 try{
  const adapter={protocol:'openai-compatible',complete:async request=>{requests.push(structuredClone(request.messages));return outputs[turn++]??done;},stream:async function*(){throw new Error('unused');},listModels:async()=>({ok:true,models:[]})};
  const baseline=await materializeLegacyAgentBaseline(fileURLToPath(new URL('..',import.meta.url)),join(root,'baseline'));
  const result=await baseline.runAgentSession({sessionsDir:root,adapter,config,apiKey:'',kernel:'legacy',prompt:'检查资源并报告',permissionMode:'plan',maxSteps:8,
   tools:[{name:'inspect_fixture',description:'Read only fixture',permissionLevel:'read',parametersJsonSchema:{}}],executeTool:async()=>({ok:true,content:'{"ok":true,"data":{"value":1}}'})});
  const actual=requests.flat().find(message=>message.content.includes(needle));assert.ok(actual,`${name} trigger must occur`);
  const records=(await readFile(result.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(record=>record.type==='message'&&record.message.role===actual.role&&record.message.content===actual.content),'durable trace must preserve the actual control instruction');
 }finally{await rm(root,{recursive:true,force:true});}
});
