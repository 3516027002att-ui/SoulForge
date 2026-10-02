import {AsyncLocalStorage} from 'node:async_hooks';
import type {WorkspaceSession} from '@soulforge/core';
import type {TrustedIpcHandle} from './registration.js';
import type {IpcMainInvokeEvent} from 'electron';

class SupersededWorkspaceRead extends Error {
  constructor() {super('WORKSPACE_READ_SUPERSEDED');}
}

/** Each domain owns its lifetime. Session identity detects replacement; the
 * epoch also detects clear/remount of the same session object. Async context
 * keeps concurrent reads independent without threading tokens through writers. */
export class WorkspaceReadLifetime {
  private epoch = 0;
  private readonly reads = new AsyncLocalStorage<{
    epoch:number;
    session:WorkspaceSession|null;
    currentSession:()=>WorkspaceSession|null;
    readOnly:boolean;
  }>();

  invalidate():void {this.epoch += 1;}

  isCurrent():boolean {
    const read=this.reads.getStore();
    return !read||(read.epoch===this.epoch&&read.currentSession()===read.session);
  }

  capturedSession(fallback:()=>WorkspaceSession|null):WorkspaceSession|null {
    const scope=this.reads.getStore();return scope?scope.session:fallback();
  }

  assertCurrent():void {
    const read=this.reads.getStore();
    if(read&&!this.isCurrent())throw new SupersededWorkspaceRead();
  }

  /** Use only for read ports. A write has its own journal/settlement lifetime. */
  guardCall<Call extends (...args:any[])=>Promise<any>>(call:Call):Call {
    return (async (...args:Parameters<Call>)=>{
      if(this.reads.getStore()?.readOnly)this.assertCurrent();
      const result=await call(...args);
      if(this.reads.getStore()?.readOnly)this.assertCurrent();return result;
    }) as Call;
  }

  guardSync<Call extends (...args:any[])=>any>(call:Call):Call {
    return ((...args:Parameters<Call>)=>{this.assertCurrent();return call(...args);}) as Call;
  }

  guardProjection<Call extends (...args:any[])=>any>(call:Call):Call {
    return ((...args:Parameters<Call>)=>this.isCurrent()?call(...args):undefined) as Call;
  }

  /** Application entry without IPC channel or event authority. */
  run<Result, Superseded>(
    currentSession: () => WorkspaceSession | null,
    readOnly: boolean,
    operation: () => Result | Promise<Result>,
    onSuperseded: (error: Error) => Superseded
  ): Promise<Result | Superseded> {
    return this.reads.run({epoch:this.epoch,session:currentSession(),currentSession,readOnly},async()=>{
      try {
        if (readOnly) this.assertCurrent();
        const result = await operation();
        if (readOnly) this.assertCurrent();
        return result;
      }catch(error){
        if (!readOnly || !(error instanceof SupersededWorkspaceRead)) throw error;
        return onSuperseded(error);
      }
    });
  }

  register(handle:TrustedIpcHandle,currentSession:()=>WorkspaceSession|null):TrustedIpcHandle {
    return <Args extends unknown[],Result>(channel:string,listener:(event:IpcMainInvokeEvent,...args:Args)=>Result|Promise<Result>)=>{
      // These operations expose resource projections; mutation/commit handlers
      // continue to return their concrete transaction outcomes after settlement.
      const readOnly=/^resource\.(?:read|openParamSession|list|inspect|roundTrip|validate|probe|scriptContainerEvidence)/u.test(channel)
        || /^document\.(?:open|get|page|readContent)$/u.test(channel);
      handle(channel,(event:IpcMainInvokeEvent,...args:Args)=>this.run(currentSession,readOnly,()=>listener(event,...args),()=>
          ({ok:false,cancelled:true,...(channel.startsWith('document.')?{code:'runtime-blocked',retryable:true}:{}),diagnostics:[{
            severity:'info' as const,code:'WORKSPACE_READ_SUPERSEDED',
            message:'工作区已更换，旧读取结果已丢弃。'
          }]})));
    };
  }

  /** Stale operations cannot observe, overwrite or evict the new workspace's
   * cache. Native results are checked even when a handler has no cache. */
  createCache<Key,Value>():Map<Key,Value> {
    const lifetime=this;
    const writable=()=>{
      if(lifetime.isCurrent())return true;
      if(lifetime.reads.getStore()?.readOnly)lifetime.assertCurrent();
      return false;
    };
    return new class extends Map<Key,Value> {
      override get(key:Key):Value|undefined {return writable()?super.get(key):undefined;}
      override has(key:Key):boolean {return writable()&&super.has(key);}
      override set(key:Key,value:Value):this {return writable()?super.set(key,value):this;}
      override delete(key:Key):boolean {return writable()&&super.delete(key);}
      override clear():void {if(writable())super.clear();}
      override entries():MapIterator<[Key,Value]> {return writable()?super.entries():new Map<Key,Value>().entries();}
      override keys():MapIterator<Key> {return writable()?super.keys():new Map<Key,Value>().keys();}
      override values():MapIterator<Value> {return writable()?super.values():new Map<Key,Value>().values();}
      override [Symbol.iterator]():MapIterator<[Key,Value]> {return this.entries();}
    }();
  }
}
