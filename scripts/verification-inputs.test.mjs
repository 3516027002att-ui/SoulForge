import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingFile, missingConfiguration, oracleSourcePrerequisites, verificationSkipReason, parseVerificationSkipReason } from './verification-inputs.mjs';

test('private missing files are distinguished from unconfigured oracle/control inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-verification-inputs-'));
  try {
    const file = join(root, 'native.bin');
    const privateInput = { kind:'private-game-input', logicalResource:'chr/native.bin' };
    assert.equal(missingFile(file, privateInput)?.status, 'missing');
    const oracle = missingConfiguration('', {kind:'independent-oracle', sourceEnv:'EXPECTED_COUNT'});
    const reason = parseVerificationSkipReason(verificationSkipReason([missingFile(file, privateInput), oracle]));
    assert.equal(reason.code, 'PRIVATE_CORPUS_MISSING');
    assert.equal(reason.missingPrerequisites.length, 2);
    writeFileSync(file, 'native input');
    assert.equal(missingFile(file, privateInput), null);
    assert.equal(parseVerificationSkipReason(verificationSkipReason([oracle])).code, 'VERIFICATION_INPUT_MISSING');
    assert.equal(parseVerificationSkipReason(verificationSkipReason([missingConfiguration('',privateInput)])).code, 'VERIFICATION_INPUT_MISSING');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('invalid skip evidence cannot become private corpus permission', () => {
  assert.equal(parseVerificationSkipReason('missing GPU'), null);
  assert.equal(parseVerificationSkipReason('{"code":"PRIVATE_CORPUS_MISSING","missingPrerequisites":[]}'), null);
  assert.equal(parseVerificationSkipReason(JSON.stringify({code:'PRIVATE_CORPUS_MISSING',missingPrerequisites:[{kind:'published-control',sourceEnv:'CONTROL',status:'missing'}]})), null);
  assert.throws(() => missingFile('\u0000', {kind:'private-game-input',logicalResource:'invalid'}));
});

test('oracle parse and source hash failures never become private skip evidence', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-oracle-prerequisites-'));
  const originalGameRoot = process.env.SF_REAL_GAME_ROOT;
  try {
    process.env.SF_REAL_GAME_ROOT = root;
    const path=join(root,'oracle.json'), source=join(root,'source.bin');
    writeFileSync(path,'broken JSON');
    assert.throws(()=>oracleSourcePrerequisites(path,'ORACLE',o=>o.source,()=>{}),SyntaxError);
    writeFileSync(source,'real available bytes');
    writeFileSync(path,JSON.stringify({source:{path:source,sha256:'0'.repeat(64)}}));
    assert.throws(()=>oracleSourcePrerequisites(path,'ORACLE',o=>o.source,()=>{}),/SHA_MISMATCH/);
    const unavailable=oracleSourcePrerequisites(undefined,'ORACLE',o=>o.source,()=>{});
    assert.equal(parseVerificationSkipReason(verificationSkipReason(unavailable)).code,'VERIFICATION_INPUT_MISSING');
    process.env.SF_REAL_GAME_ROOT = join(root,'absent-game');
    assert.equal(parseVerificationSkipReason(verificationSkipReason(oracleSourcePrerequisites(undefined,'ORACLE',o=>o.source,()=>{}))).code,'PRIVATE_CORPUS_MISSING');
  } finally {
    if(originalGameRoot===undefined)delete process.env.SF_REAL_GAME_ROOT; else process.env.SF_REAL_GAME_ROOT=originalGameRoot;
    rmSync(root,{recursive:true,force:true});
  }
});
