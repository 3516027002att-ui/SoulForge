import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkspaceIndex} from './workspaceIndex.js';
import {createSearchTaeEventsTool} from '../ai/tools/search_tae_events.js';
import type {TaeExport} from '@soulforge/shared';

function fixture(actions=35, events=160):TaeExport {
  return {sourceUri:'file://chr/c0000.anibnd.dcx',chrId:'c0000',sourceHash:'snapshot',readerSchemaRevision:2,
    animations:Array.from({length:actions},(_,animId)=>({animId,code:`A${animId}`,eventCount:events,
      events:Array.from({length:events},(_,index)=>({index,uri:`action://c0000/A${animId}/e${index}`,
        eventTypeId:10,typeName:index===77?'Needle':'Sibling',startTime:0,endTime:1,startFrame:0,endFrame:30}))}))};
}

test('TAE provider retains only a page of ranked actions and bounded native siblings',()=>{
  const ws=new WorkspaceIndex('paging');ws.upsertTaeExport(fixture());
  // The provider must not call the legacy full-result path, even for later pages.
  ws.searchTaeEvents=()=>{throw new Error('unbounded event materialization');};
  let continuation:string|undefined;
  const ids:number[]=[];
  do {
    const page=ws.searchTaeActionGroupsPage('Needle',{limit:3,eventLimit:7,...(continuation?{continuation}:{})});
    assert.equal(page.total,35);
    assert.ok(page.retainedCandidates<=3);
    for(const hit of page.matches){
      ids.push(hit.item.animId);
      assert.deepEqual(hit.item.events.map(e=>e.index),[0,1,2,3,4,5,6]);
      assert.equal(hit.item.eventCount,160);
    }
    continuation=page.continuation;
  } while(continuation);
  assert.deepEqual(ids,Array.from({length:35},(_,i)=>i));
  assert.equal(ws.searchTaeActionGroupsPage('Needle',{offset:31,limit:2}).matches[0]?.item.animId,31);
});

test('tool cursors bind provider, query, workspace, source content and delivery window',async()=>{
  const ws=new WorkspaceIndex('paging');const data=fixture(8,80);ws.upsertTaeExport(data);
  ws.searchTaeActionGroups=()=>{throw new Error('full-result path must not be used');};
  const tool=createSearchTaeEventsTool(),context={workspaceIndex:ws,mode:'plan' as const};
  const first=await tool.run({query:'Needle',limit:2,pageSize:3},context);
  assert.equal(first.ok,true);if(!first.ok)return;
  const result=first.data as any;
  assert.equal(result.matches.length,2);assert.equal(result.matches[0].item.events.length,3);
  assert.equal(result.matches[0].item.pagination.nextRead.args.offset,3);
  const next=await tool.run({cursor:result.nextCursor,limit:1},context);
  assert.equal(next.ok,true);if(next.ok)assert.equal((next.data as any).matches[0].item.animId,2);
  const changedQuery=await tool.run({cursor:result.nextCursor,query:'Sibling'},context);
  assert.equal(changedQuery.ok,false);
  data.animations[7]!.events[0]!.typeName='changed sibling';
  const stale=await tool.run({cursor:result.nextCursor},context);
  assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error?.code,'STALE_READ_CURSOR');
});

test('oversized single events are deferred to native reads rather than bypassing the preview budget',async()=>{
  const ws=new WorkspaceIndex('oversized'),data=fixture(1,1);
  data.animations[0]!.events[0]!.typeName='Needle '+ 'x'.repeat(100_000);
  ws.upsertTaeExport(data);
  const result=await createSearchTaeEventsTool().run({query:'Needle'}, {workspaceIndex:ws,mode:'plan'});
  assert.equal(result.ok,true);if(!result.ok)return;
  const page=result.data as any;
  assert.equal(page.matches[0].item.events.length,0);
  assert.equal(page.matches[0].item.pagination.hasMore,true);
  assert.equal(page.matches[0].item.pagination.nextRead.args.offset,0);
  assert.equal(page.matches[0].item.pagination.nextRead.args.pageSize,1);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<20_000);
});
