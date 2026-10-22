import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import test from 'node:test';

test('the Windows Doctor publish command keeps Program.cs in actual MSBuild compile items', () => {
  const command=JSON.parse(readFileSync('package.json','utf8')).scripts['launcher:build'];
  const match=command.match(/\s-o\s+([^\s]+)\s*&&/);
  assert.ok(match,'launcher build must declare its owned publish directory');
  const local=process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'SoulForge','dotnet','dotnet.exe'):'';
  const dotnet=process.env.SOULFORGE_DOTNET||(local&&existsSync(local)?local:'dotnet');
  const run=spawnSync(dotnet,['msbuild','bridge/SoulForge.Doctor/SoulForge.Doctor.csproj','-getItem:Compile','-p:PublishDir='+resolve(match[1])+'/'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(run.status,0,run.stderr);
  const items=JSON.parse(run.stdout).Items.Compile;
  assert.ok(items.some(item=>item.Identity==='Program.cs'),'publishing must not exclude the Doctor entry point');
});
