import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renameOwnedFile,renameOwnedFileSync} from './owned-rename.mjs';
for(const rename of [renameOwnedFile,renameOwnedFileSync])test(`${rename.name} retries only transient Windows sharing failures with bounded attempts`,async()=>{
 let calls=0;const delays=[];
 const options={platform:'win32',pause:ms=>delays.push(ms),move:(a,b)=>{assert.equal(a,'owned.next');assert.equal(b,'owned.json');if(++calls<3)throw Object.assign(new Error('scanner lock'),{code:'EPERM'});}};
 await rename('owned.next','owned.json',options);assert.equal(calls,3);assert.deepEqual(delays,[25,50]);
 calls=0;options.move=()=>{calls++;throw Object.assign(new Error('missing'),{code:'ENOENT'});};
 await assert.rejects(async()=>rename('owned.next','owned.json',options),/missing/);assert.equal(calls,1);
 calls=0;options.move=()=>{calls++;throw Object.assign(new Error('persistent'),{code:'EPERM'});};
 await assert.rejects(async()=>rename('owned.next','owned.json',options),/persistent/);assert.equal(calls,6);
});
