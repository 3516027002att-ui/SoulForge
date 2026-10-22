import assert from 'node:assert/strict';
import {it} from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentBudgetControls} from './AgentBudgetControls.js';
import {startAgentTask,reduceAgentTaskEvent} from './agentTaskState.js';

it('shows optional money controls separately from authoritative run budget',()=>{
  const budget={mode:'steps-time' as const,maxSteps:12,totalTimeoutMs:120_000,maxOutputTokens:1000};
  const state=reduceAgentTaskEvent(startAgentTask('owned'),{sessionId:'owned',event:{type:'run-budget',budget}});
  assert.deepEqual(state.budget,budget);
  assert.equal(reduceAgentTaskEvent(state,{sessionId:'other',event:{type:'run-budget',budget:{...budget,maxSteps:99}}}),state);
  const render=(value={})=>renderToStaticMarkup(<AgentBudgetControls value={value} onChange={()=>{}} disabled={true} effective={state.budget} />);
  assert.match(render(),/12 步 \/ 2 分钟/);
  assert.match(render(),/disabled=""/);
  assert.doesNotMatch(render(),/每百万输入 token 价格/);
  assert.match(render({maxCost:1}),/每百万输入 token 价格/);
});
