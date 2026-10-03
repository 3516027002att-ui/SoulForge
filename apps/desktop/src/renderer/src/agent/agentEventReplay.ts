/**
 * 合并 Agent 推送与回放时的会话内排序/去重。
 *
 * 实时 IPC 与 replay IPC 可能交错到达，不能用「当前最大 seq」作为水位：
 * 如果 seq=5 先到，随后回放的 seq=1..4 会被错误丢掉。这里显式维护已应用
 * 的序号集合，允许乱序补齐，同时限制集合大小，避免长会话在 renderer 中增长。
 */
export interface AgentEventEnvelopeLike {
  sessionId: string;
  seq: number;
}

export interface OrderedAgentEvents<T extends AgentEventEnvelopeLike> {
  events: T[];
  seen: Set<number>;
  droppedThrough: number;
}

/** Failed replay still exposes any receive-window loss to the conversation. */
export function combineAgentReplayWindow<T>(
  replay:{ok:boolean;events?:T[];truncated?:boolean}|undefined,
  queued:{events:T[];truncated:boolean}
):{events:T[];truncated:boolean} {
  return {events:replay?.ok?[...(replay.events??[]),...queued.events]:queued.events,
    truncated:queued.truncated||(replay?.ok===true&&replay.truncated===true)};
}

export function orderUnseenAgentEvents<T extends AgentEventEnvelopeLike>(
  envelopes: readonly T[],
  sessionId: string,
  seen: ReadonlySet<number> = new Set<number>(),
  limit = 4096,
  droppedThrough = 0
): OrderedAgentEvents<T> {
  const candidates = new Map<number, T>();
  for (const envelope of envelopes) {
    if (envelope.sessionId !== sessionId) continue;
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) continue;
    if (envelope.seq <= droppedThrough) continue;
    if (seen.has(envelope.seq) || candidates.has(envelope.seq)) continue;
    candidates.set(envelope.seq, envelope);
  }

  const events = [...candidates.values()].sort((left, right) => left.seq - right.seq);
  const nextSeen = new Set(seen);
  for (const event of events) nextSeen.add(event.seq);
  const safeLimit = Math.max(1, Math.trunc(limit));
  while (nextSeen.size > safeLimit) {
    const oldest = Math.min(...nextSeen);
    nextSeen.delete(oldest);
    droppedThrough = Math.max(droppedThrough,oldest);
  }
  return { events, seen: nextSeen, droppedThrough };
}

/** One renderer receive window, bounded across sessions as well as within one. */
export class BoundedAgentEventQueue<T extends AgentEventEnvelopeLike> {
  private sessions = new Map<string,{events:{event:T;bytes:number}[];droppedThrough:number}>();
  private bytes = 0;
  private entries = 0;
  private readonly encoder = new TextEncoder();

  constructor(private readonly limits:{maxBytes?:number;maxEntries?:number;maxSessions?:number}={}) {}

  append(event:T):void {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) return;
    const session=this.sessions.get(event.sessionId)??{events:[],droppedThrough:0};
    if(event.seq<=session.droppedThrough||session.events.some(entry=>entry.event.seq===event.seq))return;
    const bytes=this.encoder.encode(JSON.stringify(event)).byteLength;
    const maxBytes=this.limits.maxBytes??2_097_152;
    if(bytes>maxBytes)session.droppedThrough=Math.max(session.droppedThrough,event.seq);
    else{session.events.push({event,bytes});this.bytes+=bytes;this.entries++;}
    this.sessions.delete(event.sessionId);this.sessions.set(event.sessionId,session);
    while(this.sessions.size>(this.limits.maxSessions??4))this.removeSession(this.sessions.keys().next().value!);
    while(this.bytes>maxBytes||this.entries>(this.limits.maxEntries??4096)){
      const oldest=[...this.sessions.values()].find(value=>value.events.length);
      if(!oldest)break;
      const removed=oldest.events.shift()!;this.bytes-=removed.bytes;this.entries--;
      oldest.droppedThrough=Math.max(oldest.droppedThrough,removed.event.seq);
    }
  }

  private removeSession(id:string):void {
    const session=this.sessions.get(id);if(!session)return;
    for(const entry of session.events){this.bytes-=entry.bytes;this.entries--;}
    this.sessions.delete(id);
  }

  take(sessionId:string):{events:T[];truncated:boolean;droppedThrough:number} {
    const session=this.sessions.get(sessionId);this.removeSession(sessionId);
    return {events:session?.events.map(entry=>entry.event)??[],truncated:(session?.droppedThrough??0)>0,droppedThrough:session?.droppedThrough??0};
  }

  keepSession(sessionId:string):void {for(const id of this.sessions.keys())if(id!==sessionId)this.removeSession(id);}
  clear():void{this.sessions.clear();this.bytes=0;this.entries=0;}
  stats():{sessions:number;bytes:number;entries:number}{return{sessions:this.sessions.size,bytes:this.bytes,entries:this.entries};}
}
