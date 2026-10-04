import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
const {captureSourceBinding,verifiedSourceBinding}=await import('./source-binding.mjs').catch(()=>({}));

test('source binding rejects dirty inputs, new input files and HEAD changes during execution',()=>{
  assert.equal(typeof captureSourceBinding,'function');
  const root=mkdtempSync(join(tmpdir(),'sf-source-binding-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  try{
    mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/actual.mjs'),'export const value=1;\n');
    git('init');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture');
    const start=captureSourceBinding(root);assert.equal(start.clean,true);
    assert.equal(verifiedSourceBinding(start,captureSourceBinding(root)),true);
    writeFileSync(join(root,'scripts/actual.mjs'),'export const value=2;\n');
    assert.equal(verifiedSourceBinding(start,captureSourceBinding(root)),false);
    git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','second');
    assert.equal(verifiedSourceBinding(start,captureSourceBinding(root)),false);
    const clean=captureSourceBinding(root);writeFileSync(join(root,'scripts/new.mjs'),'new input');
    assert.equal(verifiedSourceBinding(clean,captureSourceBinding(root)),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
