import {createHash} from 'node:crypto';
import {formatActionAddress, type TaeExport, type TaeAnimSymbol, type TaeEventSymbol} from '@soulforge/shared';

export interface TaeActionSearchWindow {limit?:number;offset?:number;continuation?:string;eventLimit?:number}
type Rank = {score:number;ordinal:number};
type Candidate = Rank & {source:TaeExport;animation:TaeAnimSymbol};
const compare = (a:Rank,b:Rank) => b.score-a.score || a.ordinal-b.ordinal;
function retain<T>(items:T[],item:T,limit:number,compareItems:(a:T,b:T)=>number):void {
  if(items.length===limit && compareItems(item,items[items.length-1]!)>=0)return;
  const position=items.findIndex(current=>compareItems(item,current)<0);
  items.splice(position<0?items.length:position,0,item);
  if(items.length>limit)items.pop();
}
const invalid = ():never => {throw Object.assign(new Error('动作搜索窗口或续页位置无效。'),{code:'INVALID_SEARCH_WINDOW'});};

/** Scan cached symbols, but retain only a ranked page, never all hits/groups/events. */
export function searchTaeActionPage(sources:()=>Iterable<TaeExport>,scoreEvent:(event:TaeEventSymbol)=>number,
  window:TaeActionSearchWindow={}) {
  const limit=window.limit??6,eventLimit=window.eventLimit??16,offset=window.offset??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(eventLimit)||eventLimit<0||eventLimit>128
    ||!Number.isSafeInteger(offset)||offset<0)invalid();
  let after:Rank|undefined;
  if(window.continuation!==undefined){
    try{after=JSON.parse(window.continuation) as Rank;}catch{invalid();}
    if(!after || !Number.isFinite(after.score)||after.score<=0||!Number.isSafeInteger(after.ordinal)||after.ordinal<0)invalid();
  }
  const scan=(seek:Rank|undefined,count:number)=>{
    const hash=createHash('sha256'),candidates:Candidate[]=[];
    let ordinal=0,total=0,eligible=0;
    for(const source of sources()){
      const {animations,...sourceIdentity}=source;
      hash.update(JSON.stringify(sourceIdentity)).update('\0');
      for(const animation of animations){
        const {events,...identity}=animation;
        hash.update(JSON.stringify(identity)).update('\0');
        let score=0;
        for(const event of events){hash.update(JSON.stringify(event)).update('\0');score=Math.max(score,scoreEvent(event));}
        const rank={score,ordinal:ordinal++};
        if(score<=0)continue;
        total++;
        if(seek && compare(rank,seek)<=0)continue;
        eligible++;
        retain(candidates,{...rank,source,animation},count,compare);
      }
    }
    return {candidates,total,eligible,snapshotId:hash.digest('hex')};
  };
  // Legacy explicit offsets use bounded seek windows. Cursor callers take one
  // scan regardless of page number; offsets never allocate offset+limit hits.
  let remaining=after?0:offset;
  while(remaining>0){
    const skipped=scan(after,Math.min(128,remaining));
    if(skipped.candidates.length===0)break;
    const last=skipped.candidates.at(-1)!;
    after={score:last.score,ordinal:last.ordinal};remaining-=skipped.candidates.length;
  }
  const page=scan(after,limit);
  const matches=page.candidates.map(({source,animation,score})=>{
    const events:TaeEventSymbol[]=[],matchedEventIndices:number[]=[];
    let maximumBytes=1,matchedEventCount=0;
    for(const event of animation.events){
      maximumBytes=Math.max(maximumBytes,Buffer.byteLength(JSON.stringify(event),'utf8'));
      if(eventLimit>0)retain(events,event,eventLimit,(a,b)=>a.index-b.index);
      if(scoreEvent(event)>0){matchedEventCount++;if(matchedEventIndices.length<128)matchedEventIndices.push(event.index);}
    }
    const previewSize=Math.min(eventLimit,Math.floor(20_000/limit/maximumBytes));
    // An oversized individual event is not an exception to the preview bound.
    // Omit its preview and leave a one-event native continuation instead.
    const size=Math.max(1,previewSize);
    events.length=Math.min(events.length,previewSize);
    const selector=animation.taeEntryIndex!==undefined?{taeEntryIndex:animation.taeEntryIndex}
      :animation.taeEntryId!==undefined?{taeEntryId:animation.taeEntryId}
      :animation.taeEntryName!==undefined?{taeEntryName:animation.taeEntryName}
      :animation.taeGroup!==undefined?{taeGroup:animation.taeGroup}:{};
    return {score,matchedEventIndices,matchedEventCount,matchedEventIndicesTruncated:matchedEventIndices.length<matchedEventCount,
      item:{...animation,sourceUri:source.sourceUri,chrId:source.chrId,
        address:formatActionAddress({chr:source.chrId,animId:animation.animId,...selector}),
        sourceHash:source.outerFileHash??source.sourceHash,sourceRevision:source.sourceRevision,readerSchemaRevision:source.readerSchemaRevision,
        eventsComplete:animation.eventCount!==undefined && animation.events.length===animation.eventCount
          && animation.events.every((event,index)=>event.index===index),
        events,eventPageSize:size}};
  });
  const last=page.candidates.at(-1);
  return {matches,total:page.total,snapshotId:page.snapshotId,retainedCandidates:page.candidates.length,
    ...(last && page.eligible>page.candidates.length?{continuation:JSON.stringify({score:last.score,ordinal:last.ordinal})}:{} )};
}
