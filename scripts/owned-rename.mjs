import {renameSync} from 'node:fs';
import {rename} from 'node:fs/promises';
const transient=error=>['EPERM','EACCES','EBUSY'].includes(error?.code);
const waits=[25,50,100,200,400];
/** Only retries the same already-authorized atomic rename; never deletes the destination. */
export async function renameOwnedFile(source,target,{move=rename,pause=ms=>new Promise(done=>setTimeout(done,ms)),platform=process.platform}={}){
 for(let attempt=0;;attempt++)try{return await move(source,target);}catch(error){
  if(platform!=='win32'||!transient(error)||attempt===waits.length)throw error;
  await pause(waits[attempt]);
 }
}
export function renameOwnedFileSync(source,target,{move=renameSync,pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms),platform=process.platform}={}){
 for(let attempt=0;;attempt++)try{return move(source,target);}catch(error){
  if(platform!=='win32'||!transient(error)||attempt===waits.length)throw error;
  pause(waits[attempt]);
 }
}
