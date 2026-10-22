import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkspaceIndex} from './workspaceIndex.js';
import {createSearchTaeEventsTool} from '../ai/tools/search_tae_events.js';
import {createAgentToolBridge, MAX_BOUNDED_TOOL_RESULT_BYTES} from '../ai/agentToolBridge.js';
import {createDefaultToolRegistry} from '../ai/toolRegistry.js';
import {TAE_COMPACT_PAGE_SIZE} from '../editing/taeCompactEvent.js';
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

test('a first page larger than the shared budget is deferred whole to a compact native read',async()=>{
  const ws=new WorkspaceIndex('oversized'),data=fixture(1,1);
  data.animations[0]!.events[0]!.typeName='Needle '+ 'x'.repeat(100_000);
  ws.upsertTaeExport(data);
  const result=await createSearchTaeEventsTool().run({query:'Needle'}, {workspaceIndex:ws,mode:'plan'});
  assert.equal(result.ok,true);if(!result.ok)return;
  const page=result.data as any;
  assert.equal(page.matches[0].item.events.length,0);
  assert.equal(page.matches[0].item.pagination.hasMore,true);
  const item=page.matches[0].item;
  assert.equal(item.pagination.pageNumber,null);
  assert.deepEqual(item.pagination.nextRead.args,{file:'file://chr/c0000.anibnd.dcx',addresses:[item.address],
    projection:'compact',offset:0,pageSize:TAE_COMPACT_PAGE_SIZE,expectedSourceHash:'snapshot',expectedReaderSchemaRevision:2});
  assert.ok(Buffer.byteLength(JSON.stringify(page))<20_000);
});

/** Matching actions, in rank (insertion) order, whose compact first page costs about `bytes`. */
function ranked(pages:Array<{bytes:number;events:number}>):TaeExport {
  return {sourceUri:'file://chr/c0000.anibnd.dcx',chrId:'c0000',sourceHash:'snapshot',readerSchemaRevision:2,
    animations:pages.map(({bytes,events},animId)=>({animId,code:`A${animId}`,taeEntryIndex:1,eventCount:events,
      events:Array.from({length:events},(_,index)=>({index,uri:`action://c0000/tae/1/A${animId}/e${index}`,eventTypeId:10,
        typeName:index===0?'Needle':'Sibling',startTime:0,endTime:1,startFrame:0,endFrame:30,
        fields:[{name:'Filler',value:'p'.repeat(Math.max(0,Math.floor(bytes/Math.min(events,TAE_COMPACT_PAGE_SIZE))-180))}]}))}))};
}

test('compact first pages go to the best-ranked actions, whole or not at all, while the shared budget lasts',async()=>{
  const ws=new WorkspaceIndex('budget');
  // ~18 KB pages: two fit in the 40,000-byte budget, the third does not; a small lower-ranked action still does.
  ws.upsertTaeExport(ranked([{bytes:18_000,events:70},{bytes:18_000,events:70},{bytes:18_000,events:70},{bytes:1_500,events:5}]));
  const result=await createSearchTaeEventsTool().run({query:'Needle'},{workspaceIndex:ws,mode:'plan'});
  assert.equal(result.ok,true);if(!result.ok)return;
  const items=(result.data as any).matches.map((match:any)=>match.item);
  assert.deepEqual(items.map((item:any)=>item.animId),[0,1,2,3],'rank order');
  assert.deepEqual(items.map((item:any)=>item.events.length),[64,64,0,5]);
  for(const item of items.slice(0,2)){
    assert.deepEqual(item.events.map((event:any)=>event.index),Array.from({length:64},(_,index)=>index));
    assert.equal(item.events[3].address,`action://c0000/tae/1/A${item.animId}/e3`);
    assert.deepEqual({pageNumber:item.pagination.pageNumber,totalPages:item.pagination.totalPages,
      offset:item.pagination.nextRead.args.offset,pageSize:item.pagination.nextRead.args.pageSize},
      {pageNumber:1,totalPages:2,offset:64,pageSize:64},'page 2 starts on the next fixed page boundary');
  }
  assert.equal(items[2].pagination.pageNumber,null);
  assert.equal(items[2].pagination.nextRead.args.offset,0,'a deferred page restarts at the first event');
  assert.equal(items[3].eventsComplete,true);
  assert.equal(items[3].pagination.hasMore,false);
  assert.equal(items[3].pagination.pageNumber,1);
  assert.equal(items[3].pagination.nextRead,undefined);
});

test('an indexed prefix shorter than a page is not delivered as a page',async()=>{
  const ws=new WorkspaceIndex('prefix'),data=ranked([{bytes:1_000,events:10}]);
  data.animations[0]!.eventCount=240;
  ws.upsertTaeExport(data);
  const result=await createSearchTaeEventsTool().run({query:'Needle'},{workspaceIndex:ws,mode:'plan'});
  assert.equal(result.ok,true);if(!result.ok)return;
  const item=(result.data as any).matches[0].item;
  assert.equal(item.events.length,0,'10 cached events of 240 are not the first 64-event page');
  assert.equal(item.pagination.nextRead.args.offset,0);
  assert.equal(item.pagination.totalPages,4);
  const small=await createSearchTaeEventsTool().run({query:'Needle',pageSize:10},{workspaceIndex:ws,mode:'plan'});
  assert.equal(small.ok,true);if(!small.ok)return;
  assert.equal((small.data as any).matches[0].item.events.length,10,'the same prefix is a whole 10-event page');
});

test('the worst-case compact search still fits the agent tool-result bound',async()=>{
  const ws=new WorkspaceIndex('envelope');
  // Six actions whose 64-event pages are each just under the shared budget: only the first is delivered.
  ws.upsertTaeExport(ranked(Array.from({length:6},()=>({bytes:39_000,events:64}))));
  const registry=createDefaultToolRegistry();
  const content=(await createAgentToolBridge({registry,context:{workspaceIndex:ws,mode:'plan'}})
    .executeTool({id:'worst',name:'search_tae_events',argumentsJson:JSON.stringify({query:'Needle'})}));
  assert.equal(content.ok,true,content.content.slice(0,400));
  assert.ok(Buffer.byteLength(content.content,'utf8')<=MAX_BOUNDED_TOOL_RESULT_BYTES);
  const items=JSON.parse(content.content).data.record.matches.map((match:any)=>match.item);
  assert.deepEqual(items.map((item:any)=>item.events.length),[64,0,0,0,0,0]);
});
