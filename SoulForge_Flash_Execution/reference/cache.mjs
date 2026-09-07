import { check, integer } from './common.mjs';
/** Ready-value cache only. In-flight memory reservations belong to the host scheduler. */
export class ByteLru {
  constructor(budget) { integer(budget,1);this.budget=budget;this.used=0;this.clock=0;this.entries=new Map();this.quarantined=new Map();this.disposalErrors=[]; }
  insert(key,value,bytes,dispose=()=>{}) {
    integer(bytes,1);check(!this.entries.has(key)&&!this.quarantined.has(key),'CACHE_KEY_ALREADY_PRESENT');check(bytes<=this.budget,'CACHE_ITEM_TOO_LARGE');
    const evictable=[...this.entries].filter(([,e])=>e.leases===0).sort((a,b)=>a[1].tick-b[1].tick);
    let reclaim=0;
    for(const [,entry] of evictable){if(this.used+bytes-reclaim<=this.budget)break;reclaim+=entry.bytes;}
    check(this.used+bytes-reclaim<=this.budget,'CACHE_BUDGET_PINNED');
    for(const [oldKey,entry] of evictable){
      if(this.used+bytes<=this.budget)break;
      this.entries.delete(oldKey);
      try{entry.dispose(entry.value);this.used-=entry.bytes;}
      catch(error){this.quarantined.set(oldKey,entry);this.disposalErrors.push({key:oldKey,error:String(error)});}
    }
    check(this.used+bytes<=this.budget,'CACHE_DISPOSAL_INCOMPLETE');
    this.entries.set(key,{value,bytes,leases:0,tick:++this.clock,dispose});this.used+=bytes;
  }
  acquire(key) {
    const entry=this.entries.get(key);if(!entry)return null;entry.leases++;entry.tick=++this.clock;let released=false;
    return {value:entry.value,release:()=>{if(released)return;released=true;entry.leases--;entry.tick=++this.clock;}};
  }
}
/** One shared build per key. Cancellation of one subscriber does not cancel another. */
export class SingleFlight {
  constructor(){this.jobs=new Map();}
  join(key,builder,{signal}={}) {
    if(signal?.aborted)return Promise.reject(Object.assign(new Error('SUBSCRIBER_CANCELLED'),{code:'SUBSCRIBER_CANCELLED'}));
    let entry=this.jobs.get(key);
    if(entry?.controller.signal.aborted)return Promise.reject(Object.assign(new Error('BUILD_CANCELLING'),{code:'BUILD_CANCELLING'}));
    if(!entry){
      const controller=new AbortController();entry={controller,subscribers:0,settled:false,promise:null};
      this.jobs.set(key,entry);
      const current=entry;
      entry.promise=Promise.resolve().then(()=>builder(controller.signal)).finally(()=>{
        current.settled=true;
        if(this.jobs.get(key)===current)this.jobs.delete(key);
      });
    }
    entry.subscribers++;const current=entry;
    return new Promise((resolve,reject)=>{
      let done=false;
      const release=()=>{
        current.subscribers--;
        signal?.removeEventListener('abort',onAbort);
        if(current.subscribers===0&&!current.settled)current.controller.abort();
      };
      const finish=(fn,value)=>{if(done)return;done=true;release();fn(value);};
      const onAbort=()=>finish(reject,Object.assign(new Error('SUBSCRIBER_CANCELLED'),{code:'SUBSCRIBER_CANCELLED'}));
      signal?.addEventListener('abort',onAbort,{once:true});
      current.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
      if(signal?.aborted)onAbort();
    });
  }
}
