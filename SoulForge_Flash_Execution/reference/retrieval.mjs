import { check, integer, nonempty, cmpText } from './common.mjs';
export function normalizeScope(input, allFamilies) {
  nonempty(input.workspaceId);
  const families = input.families === undefined ? [...allFamilies] : [...input.families];
  check(families.length > 0 && families.every(f => allFamilies.includes(f)), 'INVALID_FAMILY_FILTER');
  return { workspaceId: input.workspaceId, families: new Set(families),
    ...(input.revision !== undefined ? { revision: input.revision } : {}) };
}
export function eligible(chunk, scope) {
  return chunk.workspaceId === scope.workspaceId && scope.families.has(chunk.family)
    && (scope.revision === undefined || chunk.revision === scope.revision)
    && chunk.stale !== true;
}
/** Comparator: best first; deterministic chunkId tie break. */
export const compareRanked = (a,b) => b.score-a.score || cmpText(a.id,b.id);
/** Heap root is the worst retained candidate. O(n log k), O(k). */
export function topK(iterable, k) {
  integer(k, 0); if (k === 0) return [];
  const heap = [];
  const worse = (a,b) => compareRanked(a,b) > 0;
  function up(index) {
    while(index > 0) { const parent=(index-1)>>1; if(!worse(heap[index],heap[parent])) break;
      [heap[index],heap[parent]]=[heap[parent],heap[index]]; index=parent; }
  }
  function down(index) {
    for(;;) { let target=index, left=index*2+1, right=left+1;
      if(left<heap.length && worse(heap[left],heap[target])) target=left;
      if(right<heap.length && worse(heap[right],heap[target])) target=right;
      if(target===index) break; [heap[index],heap[target]]=[heap[target],heap[index]]; index=target; }
  }
  for(const item of iterable) {
    nonempty(item.id); check(Number.isFinite(item.score),'INVALID_SCORE');
    if(heap.length < k) { heap.push(item); up(heap.length-1); }
    else if(compareRanked(item,heap[0])<0) { heap[0]=item; down(0); }
  }
  return heap.sort(compareRanked);
}
export function cosine(a,b) {
  check(a.length===b.length && a.length>0,'VECTOR_DIMENSION');
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++) { check(Number.isFinite(a[i])&&Number.isFinite(b[i]),'VECTOR_NONFINITE'); dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  check(aa>0&&bb>0&&Number.isFinite(dot)&&Number.isFinite(aa)&&Number.isFinite(bb),'VECTOR_NORM');
  return Math.max(-1,Math.min(1,dot/Math.sqrt(aa)/Math.sqrt(bb)));
}
/** Hard filters precede ranking. Lists are ranks, not arbitrary score magnitudes. */
export function fuseRrf(chunks, lexicalIds, vectorIds, scope, limit, exactIds=[]) {
  integer(limit,1,32);
  const byId=new Map(chunks.map(c=>[c.id,c])); check(byId.size===chunks.length,'DUPLICATE_CHUNK_ID');
  const allowed=id=>byId.has(id)&&eligible(byId.get(id),scope);
  const fused=new Map();
  for(const list of [lexicalIds,vectorIds]) {
    const ids=[...new Set(list)].filter(allowed);
    ids.forEach((id,rank)=>fused.set(id,(fused.get(id)??0)+1/(60+rank+1)));
  }
  const exact=[...new Set(exactIds)].filter(allowed);
  const pinned=new Set(exact);
  // Exact candidates must not silently disappear: excessive exact hits mean ambiguous scope.
  check(exact.length<=limit,'EXACT_MATCH_SET_EXCEEDS_LIMIT');
  const rest=topK([...fused].filter(([id])=>!pinned.has(id)).map(([id,score])=>({id,score})),limit-exact.length);
  return [...exact.map(id=>byId.get(id)),...rest.map(r=>byId.get(r.id))];
}
export function adjacency(edges) {
  const out=new Map();
  for(const edge of edges) for(const [from,to] of [[edge.from,edge.to],[edge.to,edge.from]]) {
    if(!out.has(from))out.set(from,[]); out.get(from).push({...edge,other:to});
  }
  for(const list of out.values())list.sort((a,b)=>cmpText(a.other,b.other)||cmpText(a.kind,b.kind));
  return out;
}
/** Insertion-before-limit check. Caller selects primary reserve policy; scope remains hard. */
export function expandWithinLimit(primary, byId, graph, scope, finalLimit) {
  integer(finalLimit,1,32); check(primary.length<=finalLimit,'PRIMARY_OVER_LIMIT');
  check(primary.every(c=>eligible(c,scope)),'PRIMARY_SCOPE_VIOLATION');
  const result=[...primary], seen=new Set(primary.map(c=>c.id));
  for(const hit of primary) for(const edge of graph.get(hit.id)??[]) {
    if(result.length>=finalLimit)return result;
    const next=byId.get(edge.other);
    if(!next||seen.has(next.id)||!eligible(next,scope))continue;
    seen.add(next.id); result.push(next);
  }
  return result;
}
