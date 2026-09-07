import { check, integer, nonempty, stableJson, cmpText } from './common.mjs';
export function evidenceKey(identity) {
  const { workspaceId, outerId, childChain, domain, namespace, objectKey, claimKey } = identity;
  [workspaceId,outerId,domain,namespace,objectKey,claimKey].forEach(nonempty);
  check(Array.isArray(childChain)&&childChain.every(x=>typeof x==='string'&&x.length>0),'CHILD_CHAIN');
  // Do not lowercase identities, discard resource scope or concatenate with ambiguous delimiters.
  return stableJson([workspaceId,outerId,childChain,domain,namespace,objectKey,claimKey]);
}
export function evidenceResourceKey(identity) {
  evidenceKey(identity);
  return stableJson([identity.workspaceId,identity.outerId,identity.childChain,identity.domain,identity.namespace]);
}
export function utf8Prefix(text,maxBytes) {
  integer(maxBytes); let used=0,out='';
  for(const point of text) { const bytes=Buffer.byteLength(point,'utf8'); if(used+bytes>maxBytes)break; out+=point; used+=bytes; }
  return out;
}
/** Missing or revoked versions are excluded even when marked native-verified. */
export function chooseEvidence(candidates,{maxBytes,maxEntries,currentRevisionByResource}) {
  integer(maxBytes,2);integer(maxEntries,1);
  const winners=new Map(),requiredKeys=new Set();
  for(const c of candidates) {
    const key=evidenceKey(c.identity);
    const version=currentRevisionByResource.get(evidenceResourceKey(c.identity));
    if(version===undefined||c.revision!==version||c.revoked===true)continue;
    integer(c.relevance,0,3);integer(c.authority,0,3);integer(c.sequence);
    if(c.required===true)requiredKeys.add(key);
    const prior=winners.get(key);
    check(!prior||prior.authority!==c.authority||prior.text===c.text,'CONFLICTING_CURRENT_EVIDENCE');
    if(!prior||c.authority>prior.authority||(c.authority===prior.authority&&c.sequence>prior.sequence))winners.set(key,c);
  }
  const ordered=[...winners.entries()].map(([key,c])=>({...c,required:requiredKeys.has(key)})).sort((a,b)=>Number(b.required===true)-Number(a.required===true)
    || b.relevance-a.relevance || b.authority-a.authority || b.sequence-a.sequence
    ||cmpText(evidenceKey(a.identity),evidenceKey(b.identity)));
  const selected=[];let omitted=0;
  for(const c of ordered) {
    const section={handle:c.handle,key:evidenceKey(c.identity),revision:c.revision,text:c.text};
    const fitsCount=selected.length<maxEntries;
    const fitsBytes=Buffer.byteLength(JSON.stringify([...selected,section]),'utf8')<=maxBytes;
    if(!fitsCount||!fitsBytes) {
      check(c.required!==true,'REQUIRED_EVIDENCE_EXCEEDS_BUDGET'); omitted++;continue;
    }
    selected.push(section);
  }
  const serialized=JSON.stringify(selected), actualBytes=Buffer.byteLength(serialized,'utf8');
  check(actualBytes<=maxBytes,'BYTE_BUDGET_INTERNAL');
  return {selected,omitted,serialized,actualBytes};
}
