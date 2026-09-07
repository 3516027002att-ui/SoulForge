import { check, nonempty, stableJson, cmpText } from './common.mjs';
/** Dependencies are evidential edges; ordinary Markdown links are not dependencies. */
export function validateClaimDag(claims) {
  const byId=new Map(claims.map(c=>[nonempty(c.id),c]));check(byId.size===claims.length,'DUPLICATE_CLAIM_ID');
  const done=new Set(),active=new Set();
  function visit(id){check(byId.has(id),'CLAIM_DEPENDENCY_UNKNOWN');check(!active.has(id),'CLAIM_DEPENDENCY_CYCLE');
    if(done.has(id))return;active.add(id);for(const dep of byId.get(id).dependencies)visit(dep);active.delete(id);done.add(id);}
  for(const c of claims)visit(c.id);return byId;
}
export function invalidateClaims(claims,rootIds,reason) {
  const byId=validateClaimDag(claims),reverse=new Map();
  for(const c of claims)for(const dependency of c.dependencies){if(!reverse.has(dependency))reverse.set(dependency,[]);reverse.get(dependency).push(c.id);}
  const dirty=new Set(),queue=[...rootIds];
  for(const id of queue)check(byId.has(id),'STALE_ROOT_UNKNOWN');
  for(let i=0;i<queue.length;i++) { const id=queue[i];if(dirty.has(id))continue;dirty.add(id);for(const next of reverse.get(id)??[])queue.push(next); }
  return claims.map(c=>dirty.has(c.id)?{...c,status:'stale',staleReason:reason}:{...c});
}
export function mergeGeneration(current,expectedRevision,patch) {
  check(current.revision===expectedRevision,'KNOWLEDGE_CAS_CONFLICT');
  const pages=new Map(current.pages.map(p=>[p.id,p]));
  check(pages.size===current.pages.length,'DUPLICATE_PAGE');
  for(const change of patch){
    const old=pages.get(change.id);
    check((old?.revision??null)===change.expectedPageRevision,'PAGE_CAS_CONFLICT');
    check(change.deleted!==true,'DELETE_NOT_SUPPORTED_IN_REFERENCE');
    pages.set(change.id,{id:change.id,revision:change.nextRevision,body:change.body});
  }
  return {pages:[...pages.values()].sort((a,b)=>cmpText(a.id,b.id)),parentRevision:current.revision};
}
export function sourceScopeKey(source) {
  return stableJson([source.scope,source.sourceId,source.contentHash,source.readerSchemaHash]);
}
