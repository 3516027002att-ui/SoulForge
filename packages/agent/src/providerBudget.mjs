/** One request budget shared by ordinary calls, retries, streams and compaction. */
const failure=(code,message)=>Object.assign(new Error(message),{code});
const valid=value=>Number.isFinite(value)&&value>=0;
export function createProviderBudget(adapter,options) {
 const maxOutput=Number.isSafeInteger(options.maxOutputTokens)&&options.maxOutputTokens>0?options.maxOutputTokens:100_000;
 const pricing=options.pricing;const maxCost=options.maxCost;
 let outputUsed=0,outputReserved=0,costUpperBound=0,costReserved=0,requests=0,unreportedRequests=0;
 const reserve=request=>{
  if(maxCost!==undefined && (!valid(maxCost)||!pricing||!valid(pricing.inputPerMillion)||!valid(pricing.outputPerMillion)))throw failure('AGENT_PROVIDER_PRICING_REQUIRED','Configured per-million prices are required for a monetary request budget.');
  const remaining=maxOutput-outputUsed-outputReserved;
  const maxTokens=Math.min(Number.isSafeInteger(request.maxTokens)&&request.maxTokens>0?request.maxTokens:4096,remaining);
  if(maxTokens<1)throw failure('AGENT_PROVIDER_OUTPUT_BUDGET_EXCEEDED','Low-level provider output budget is exhausted.');
  const inputUpperBound=Buffer.byteLength(JSON.stringify([request.messages,request.tools]),'utf8');
  const cost=pricing?(inputUpperBound*pricing.inputPerMillion+maxTokens*pricing.outputPerMillion)/1e6:0;
  if(maxCost!==undefined && costUpperBound+costReserved+cost>maxCost)throw failure('AGENT_PROVIDER_COST_BUDGET_EXCEEDED','Next provider request exceeds its configured reservation.');
  requests++;outputReserved+=maxTokens;costReserved+=cost;
  return {request:{...request,maxTokens},maxTokens,inputUpperBound,cost};
 };
 const settle=(reservation,usage)=>{
  outputReserved-=reservation.maxTokens;costReserved-=reservation.cost;
  const outputKnown=valid(usage?.outputTokens),inputKnown=valid(usage?.inputTokens);
  const output=outputKnown?usage.outputTokens:reservation.maxTokens,input=inputKnown?usage.inputTokens:reservation.inputUpperBound;
  outputUsed+=output;if(!outputKnown||!inputKnown)unreportedRequests++;
  if(pricing)costUpperBound+=(input*pricing.inputPerMillion+output*pricing.outputPerMillion)/1e6;
  if(output>reservation.maxTokens || outputUsed>maxOutput)throw failure('AGENT_PROVIDER_OUTPUT_BUDGET_EXCEEDED','Provider reported output beyond its reserved ceiling; no further request is allowed.');
  if(maxCost!==undefined && costUpperBound>maxCost)throw failure('AGENT_PROVIDER_COST_BUDGET_EXCEEDED','Reported provider usage exceeded the configured ceiling; no further request is allowed.');
 };
 const budgeted={protocol:adapter.protocol,
  ...(adapter.listModels?{listModels:adapter.listModels.bind(adapter)}:{}),
  complete:async request=>{const reservation=reserve(request);let result;try{result=await adapter.complete(reservation.request);}catch(error){settle(reservation,undefined);throw error;}settle(reservation,result.usage);return result;},
  stream:async function*(request){const reservation=reserve(request);let usage;try{for await(const event of adapter.stream(reservation.request)){if(event.type==='usage')usage={...usage,...(valid(event.inputTokens)?{inputTokens:event.inputTokens}:{}),...(valid(event.outputTokens)?{outputTokens:event.outputTokens}:{})};yield event;}}finally{settle(reservation,usage);}}
 };
 return {adapter:budgeted,stats:()=>({maxOutputTokens:maxOutput,outputUsed,outputReserved,requests,unreportedRequests,...(maxCost!==undefined?{maxCost,costUpperBound,costReserved}:{}),accounting:'reported-usage-or-conservative-reservation'})};
}
