import {createHash} from 'node:crypto';
import {mkdir,open,rm} from 'node:fs/promises';
import {basename,join} from 'node:path';

/** Copy one manifest-sized input at a time. Native readers consume the exact
 * verified bytes; the mutable source never becomes execution authority. */
export async function materializeCorpusSnapshot(source,pin,directory){
 if(!Number.isSafeInteger(pin.size)||pin.size<1||!/^[a-f0-9]{64}$/u.test(pin.sha256))throw new Error('CORPUS_MANIFEST_INVALID: source pin');
 await mkdir(directory,{recursive:true});const path=join(directory,basename(source));
 let input;let output;let size=0;let verified=false;const hash=createHash('sha256');
 try{
  input=await open(source,'r');
  if((await input.stat()).size!==pin.size)return {status:'unavailable'};
  output=await open(path,'wx');
  // The last inclusive byte is deliberate: reject a source which grows after stat.
  for await(const chunk of input.createReadStream({autoClose:false,start:0,end:pin.size})){
   size+=chunk.length;if(size>pin.size)return {status:'unavailable'};
   hash.update(chunk);await output.writeFile(chunk);
  }
  if(size!==pin.size||hash.digest('hex')!==pin.sha256)return {status:'unavailable'};
  verified=true;return {status:'available',path};
 }catch(error){
  if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))return {status:'unavailable'};
  throw error;
 }finally{
  await output?.close();await input?.close();
  if(!verified)await rm(path,{force:true});
 }
}
