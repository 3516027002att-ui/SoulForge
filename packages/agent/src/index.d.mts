export const AGENT_PROTOCOL_VERSION: 1;
export type KernelState = 'completed' | 'partial' | 'cancelled' | 'error' | 'waiting';
export interface KernelCall { id: string; name: string; argumentsJson: string }
export interface KernelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; toolCallId?: string; toolCalls?: KernelCall[]; images?: readonly {mediaType:string;dataBase64:string}[] }
export interface KernelTool { name: string; permissionLevel?: string; description?: string; parametersJsonSchema?: Record<string,unknown>; supportsParallel?: boolean }
export interface KernelDiagnostic { severity: 'info' | 'warning' | 'error'; code: string; message: string }
export interface KernelCompletion { message: KernelMessage; finishReason: 'stop' | 'tool_use' | 'length' | 'cancelled' | 'error'; diagnostics: KernelDiagnostic[]; usage?: {inputTokens?:number;outputTokens?:number} }
export interface KernelTransaction { opId?: string; state: 'not_committed' | 'committed' | 'unknown' | 'recovery_required' | 'rolled_back'; retryable?: boolean; [key: string]: unknown }
export interface KernelApprovalDiff { targetPath:string; unifiedDiff:string; addedLines:number; removedLines:number; newFile:boolean; truncatedNote?:string }
export interface KernelApproval { step: number; callId: string; toolName: string; permissionLevel: string; argumentsJson: string; proposalHash: string; diff?: KernelApprovalDiff }
export interface AgentProtocolEvent { protocolVersion: 1; sessionId: string; runId: string; requestId: string; eventSeq: number; event: {type: string; [key:string]:unknown} }
export interface KernelLimits { maxSteps?: number; timeoutMs?: number; maxOutputTokens?: number; maxContextBytes?: number; maxResultBytes?: number; maxResponseBytes?: number; maxToolCallsPerTurn?: number; maxCost?: number }
export interface FiniteAgentOptions {
 sessionId:string;runId:string;requestId:string;permissionMode:'plan'|'normal'|'full';messages:KernelMessage[];tools:KernelTool[];
 model(request:{messages:KernelMessage[];tools:KernelTool[];maxTokens:number;signal:AbortSignal;step:number;emitEvent(event:{type:string;[key:string]:unknown}):void}):Promise<KernelCompletion>;
 executeTool(call:KernelCall,context:{signal:AbortSignal}):Promise<{ok:boolean;content:string;code?:string;transaction?:KernelTransaction}>;
 allowTool(call:KernelCall,tool:KernelTool):{ok:true}|{ok:false;code:string;message:string};
 retryDecision?(diagnostics:KernelDiagnostic[],attempt:number):{retry:boolean;delayMs:number;code?:string;maxAttempts:number};
 requestApproval?(request:KernelApproval):Promise<{decision:string;note?:string}>;
 resolveApprovalDiff?(request:{toolName:string;argumentsJson:string}):Promise<KernelApprovalDiff|null>;
 prepareContext?(messages:KernelMessage[],signal:AbortSignal,emitEvent:(event:{type:string;[key:string]:unknown})=>void):Promise<void>;
 recordMessage?(message:KernelMessage,step:number):void;
 onEvent?(event:AgentProtocolEvent):void;redact?(text:string):string;signal?:AbortSignal;limits?:KernelLimits;maxTokens?:number;
 pricing?:{inputPerMillion:number;outputPerMillion:number};strategy?:'automatic'|'on-demand';
}
export interface FiniteAgentResult { state:KernelState;reason:string;finishReason:string;steps:number;messages:KernelMessage[];diagnostics:KernelDiagnostic[];toolCalls:{name:string;ok:boolean;code?:string}[];transactions:KernelTransaction[];unresolvedCalls:{callId:string;toolName:string;state:'unknown';retryable:false}[];outputTokens:number;cost:number;evaluation:'unverified';pendingApproval?:{call:KernelCall;proposalHash:string;step:number} }
export function runFiniteAgent(options:FiniteAgentOptions):Promise<FiniteAgentResult>;
