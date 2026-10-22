import assert from 'node:assert/strict';
import test from 'node:test';
import {dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {windowsCommandEnvironment} from './windows-command-environment.mjs';

test('child environment preserves useful tools but removes case duplicates and absent paths',()=>{
  const node=process.execPath,dir=dirname(node),input={PATH:`missing;${dir};kept`,Path:`${dir};missing`,OTHER:'unchanged'};
  const env=windowsCommandEnvironment(input,node,path=>path!== 'missing');
  assert.equal(env.PATH,`${dir};kept`);assert.equal(env.Path,undefined);
  assert.equal(env.OTHER,'unchanged');assert.ok(Object.hasOwn(input,'Path'));
});

test('actual cmd resolves Node after an overlong inherited PATH is compacted', {skip:process.platform!=='win32'},()=>{
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];
  env.PATH=[dirname(process.execPath),...Array.from({length:300},(_,i)=>`C:\\absent-soulforge-build-path-${i}\\not-a-tool`)].join(';');
  const run=input=>spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c','node --version'],{env:input,encoding:'utf8',windowsHide:true});
  assert.notEqual(run(env).status,0,'the unmodified environment reproduces cmd dropping PATH');
  const fixed=run(windowsCommandEnvironment(env));assert.equal(fixed.status,0,fixed.stderr);assert.match(fixed.stdout,/^v\d+/);
});
