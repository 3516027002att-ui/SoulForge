import type {AiAgentRunRequest} from '../../../ipc/publicTypes.js';
import type {AgentTaskState} from './agentTaskState.js';

export type AgentBudgetDraft = Pick<AiAgentRunRequest, 'maxSteps' | 'totalTimeoutMs' | 'maxCost' | 'pricing'>;

/** Only requests tighter resource settings; the trusted host owns effective limits. */
export function AgentBudgetControls({value, onChange, disabled, effective}: {
  value:AgentBudgetDraft; onChange(value:AgentBudgetDraft):void; disabled:boolean; effective:AgentTaskState['budget'];
}) {
  const priced = value.maxCost !== undefined;
  return <details className="agent-budget">
    <summary>运行预算{effective ? `：${effective.maxSteps} 步 / ${effective.totalTimeoutMs / 60_000} 分钟${effective.maxCost === undefined ? '' : ` / 额度 ${effective.maxCost}`}` : '：默认 200 步 / 30 分钟'}</summary>
    {effective && <p role="status">上次受理的实际预算如上；以下设置用于下一次运行。</p>}
    <fieldset disabled={disabled}>
      <legend>下一次运行</legend>
      <label>最大步数<input type="number" min="1" max="200" step="1" placeholder="200" value={value.maxSteps ?? ''}
        onChange={e=>{const {maxSteps:_, ...rest}=value;onChange(e.target.value===''?rest:{...rest,maxSteps:e.target.valueAsNumber});}} /></label>
      <label>总时限（分钟）<input type="number" min="1" max="35791" step="1" placeholder="30" value={value.totalTimeoutMs === undefined ? '' : value.totalTimeoutMs / 60_000}
        onChange={e=>{const {totalTimeoutMs:_, ...rest}=value;onChange(e.target.value===''?rest:{...rest,totalTimeoutMs:e.target.valueAsNumber*60_000});}} /></label>
      <label><input type="checkbox" checked={priced} onChange={e=>{
        const {maxCost:_, pricing:__, ...rest}=value;
        onChange(e.target.checked?{...rest,maxCost:0}:rest);
      }} />同时限制金额</label>
      {priced && <>
        <p>额度与价格使用同一币种；未填有效价格时拒绝运行。额度 0 不允许付费请求。</p>
        <label>金额上限<input type="number" min="0" step="any" value={Number.isFinite(value.maxCost) ? value.maxCost : ''}
          onChange={e=>onChange({...value,maxCost:e.target.valueAsNumber})} /></label>
        <label>每百万输入 token 价格<input type="number" min="0" step="any" value={Number.isFinite(value.pricing?.inputPerMillion) ? value.pricing!.inputPerMillion : ''}
          onChange={e=>onChange({...value,pricing:{inputPerMillion:e.target.valueAsNumber,outputPerMillion:value.pricing?.outputPerMillion ?? NaN}})} /></label>
        <label>每百万输出 token 价格<input type="number" min="0" step="any" value={Number.isFinite(value.pricing?.outputPerMillion) ? value.pricing!.outputPerMillion : ''}
          onChange={e=>onChange({...value,pricing:{inputPerMillion:value.pricing?.inputPerMillion ?? NaN,outputPerMillion:e.target.valueAsNumber}})} /></label>
      </>}
      <p>单次模型请求默认 180 秒；总时限包含工具执行和等待审批。金额估算不代表账单。</p>
    </fieldset>
  </details>;
}
