import {createOpaqueCursor,parseOpaqueCursor} from '@soulforge/shared';
import {createHash} from 'node:crypto';
import {cursorIdentity} from '../workspace/cursorIdentity.js';

// v2: scope.workspaceId is cursorIdentity(workspaceId); v1 embedded the absolute
// workspace URL and is rejected by the existing "旧搜索游标" diagnostic below.
const BOUNDED_SESSION='bounded-content-search-v2';

function invalid(message:string,code='SEARCH_CURSOR_SCOPE_MISMATCH'):never {throw Object.assign(new Error(message),{code});}

/** Provider-owned paging: cursor identity includes its versioned ordering contract. */
export function boundedContentSearchPage<T>(options:{
  tool:'search_tae_events';workspaceId:string;provider:string;input:Record<string,unknown>;
  readPage(query:string,window:{offset:number;limit:number;continuation?:string}):{matches:T[];total:number;snapshotId:string;continuation?:string};
}) {
  const input=options.input;
  let query=typeof input.query==='string'?input.query:'',limit=input.limit??6,offset=input.offset??0;
  if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1)invalid('limit 必须是正整数。','INVALID_SEARCH_WINDOW');
  limit=Math.min(6,limit as number);
  let continuation:string|undefined,expectedHash:string|undefined;
  if(input.cursor!==undefined){
    if(typeof input.cursor!=='string'||input.offset!==undefined)invalid('续页只传 cursor，不同时传 offset。');
    const cursor=parseOpaqueCursor(input.cursor as string);
    if(cursor.sessionId!==BOUNDED_SESSION||cursor.domain!=='tae')invalid('旧搜索游标或其他工具游标不能用于当前提供方，请重新搜索。');
    let scope:{workspaceId:string;tool:string;provider:string;query:string;limit:number;continuation:string};
    try{scope=JSON.parse(cursor.scope);}catch{invalid('搜索游标范围无效。');}
    if(!scope||scope.workspaceId!==cursorIdentity(options.workspaceId)||scope.tool!==options.tool||scope.provider!==options.provider
      ||typeof scope.query!=='string'||typeof scope.continuation!=='string'
      ||!Number.isSafeInteger(scope.limit)||scope.limit<1||scope.limit>6)invalid('搜索游标与工作区或提供方不匹配。');
    if(input.query!==undefined&&input.query!==scope.query)invalid('续页不能改变查询。');
    if(input.limit!==undefined&&(limit as number)>scope.limit)invalid('续页只能缩小窗口。');
    query=scope.query;limit=input.limit===undefined?scope.limit:limit;offset=cursor.offset;
    continuation=scope.continuation;expectedHash=cursor.sourceHash;
  }
  if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0)invalid('offset 必须是非负整数。','INVALID_SEARCH_WINDOW');
  const window={offset:offset as number,limit:limit as number,...(continuation===undefined?{}:{continuation})};
  const page=options.readPage(query,window);
  const snapshotHash=createHash('sha256').update(JSON.stringify([options.workspaceId,options.tool,options.provider,query,page.snapshotId])).digest('hex');
  if(expectedHash!==undefined&&expectedHash!==snapshotHash)invalid('搜索快照已变化，请重新搜索。','STALE_READ_CURSOR');
  const end=window.offset+page.matches.length;
  const nextCursor=page.continuation===undefined?undefined:createOpaqueCursor({sessionId:BOUNDED_SESSION,domain:'tae',
    sourceHash:snapshotHash,offset:end,scope:JSON.stringify({workspaceId:cursorIdentity(options.workspaceId),tool:options.tool,
      provider:options.provider,query,limit,continuation:page.continuation})});
  return {query,matches:page.matches,total:page.total,totalCount:page.total,offset:window.offset,limit:window.limit,
    returned:page.matches.length,returnedCount:page.matches.length,truncated:nextCursor!==undefined,
    coverage:'indexed-snapshot' as const,...(nextCursor?{nextCursor}:{}),
    nextActions:nextCursor?[{tool:options.tool,args:{cursor:nextCursor},reason:'继续读取后续搜索结果'}]:[]};
}
