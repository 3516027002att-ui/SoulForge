import assert from 'node:assert/strict';
import test from 'node:test';
import {ownedInstallerIdentity,ownedInstallerConfig,prepareOwnedInstallers} from './prepare-owned-installers.mjs';

test('owned A/B configs override every official install identity and forbid publishing/elevation',()=>{
  const identity=ownedInstallerIdentity('a'.repeat(32));
  const base={appId:'official',productName:'SoulForge',executableName:'SoulForge',publish:{provider:'github'},
    npmRebuild:false,nsis:{shortcutName:'SoulForge',uninstallDisplayName:'SoulForge',perMachine:true,allowElevation:true},
    extraMetadata:{name:'soulforge',version:'0.9.2'},directories:{output:'release'}};
  const config=ownedInstallerConfig(base,identity,'0.9.2-validation.2','owned-output');
  assert.equal(config.appId,identity.appId);assert.equal(config.extraMetadata.name,identity.packageName);
  assert.equal(config.productName,identity.productName);assert.equal(config.executableName,identity.executableName);
  assert.equal(config.nsis.shortcutName,identity.productName);assert.equal(config.nsis.uninstallDisplayName,identity.productName);
  assert.equal(config.nsis.perMachine,false);assert.equal(config.nsis.allowElevation,false);
  assert.equal(config.publish,null);assert.equal(config.npmRebuild,false);
  assert.equal(base.nsis.perMachine,true,'the production config must not be mutated');
  assert.throws(()=>ownedInstallerConfig(base,{...identity,appId:'com.soulforge.app'},'1.0.0','x'),/forbidden/);
});

test('generating an executable installation manifest requires explicit isolated-install intent',async()=>{
  await assert.rejects(()=>prepareOwnedInstallers({repositoryRoot:process.cwd()}),/allow-owned-installation/);
});
