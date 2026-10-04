import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

// Exercise the real facade and receipt projection, substituting only native
// I/O and Patch Engine commit. Only owned temporary fixture files are written.
const key = Symbol.for('sf.tae.field-readback.fixture');
let fixture;
globalThis[key] = {
  read: async input => {
    assert.equal(input.command, 'read-tae-document');
    const isAfter = fixture.commits.length > 0;
    if (isAfter && fixture.readFailure) return {parseStatus:'failed', diagnostics:[{severity:'error', code:'OWNED_READBACK_FAILURE', message:'owned readback failure'}]};
    return {parseStatus:'parsed', diagnostics:[], data:{sourceHash:'owned-hash', identityProjectionVersion:2,
      animations:[{animId:10, events:[{eventTypeId:100, startTime:0, endTime:1, parameterDecoded:isAfter ? fixture.decoded : true,
        templateFields:isAfter ? fixture.after : fixture.before}]}]}};
  },
  commit: async input => {
    fixture.commits.push(input);
    return {status:'committed', result:{ok:true, diagnostics:[], opId:'owned-op', backupRoot:'owned-backup'}};
  }
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/editing/taeEdit.js')) {
      if (specifier === '../bridge/runBridge.js') return {url:'sf:tae-readback-bridge', shortCircuit:true};
      if (specifier === './editorMutationService.js') return {url:'sf:tae-readback-commit', shortCircuit:true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'sf:tae-readback-bridge') return {format:'module', shortCircuit:true,
      source:`export const runBridge = input => globalThis[Symbol.for('sf.tae.field-readback.fixture')].read(input);`};
    if (url === 'sf:tae-readback-commit') return {format:'module', shortCircuit:true,
      source:`export const applyNativeMutation = input => globalThis[Symbol.for('sf.tae.field-readback.fixture')].commit(input);`};
    return next(url, context);
  }
});
const {setTaeEventFields} = await import('../packages/core/dist/editing/taeEdit.js?field-readback');
hooks.deregister();
const sizes = {b:1, u8:1, s8:1, u16:2, s16:2, u32:4, s32:4, s64:8, f32:4};
const field = (type, value, extra = {}) => ({index:0, name:'OwnedField', type, size:sizes[type], offset:0, value, ...extra});
async function verify({type='s32', requested, observed, expected, beforeExtra, afterExtra, decoded=true, readFailure=false, rejected=false}) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-field-readback-'));
  const file = join(root, 'c0000.anibnd.dcx');
  await writeFile(file, 'owned fixture');
  fixture = {before:[field(type, 0, beforeExtra)], after:[field(type, observed, afterExtra)], decoded, readFailure, commits:[]};
  const edit = {session:{layers:{overlayRoot:root}, meta:{workspaceId:'owned'}, resolveWritablePath:absolutePath=>({ok:true, absolutePath, diagnostics:[]})},
    allowedRoots:()=>[root], indexFile:async()=>({sha256:'owned-hash', sourceUri:pathToFileURL(file).href}), stagingRoot:join(root,'stage'),
    commitPort:{}};
  try {
    const result = await setTaeEventFields({edit, file, edits:[{address:'c0000#A0010.e0', fieldName:'OwnedField', value:requested}]});
    if (rejected) {
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error.code, 'TAE_SCHEMA_COVERAGE_GAP');
      assert.equal(fixture.commits.length, 0, 'invalid input schema must be rejected before commit');
      return result;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.nativeVerified, expected, `${type}: requested ${String(requested)}, observed ${String(observed)}`);
    assert.equal(result.opId, 'owned-op'); assert.equal(result.backupRoot, 'owned-backup');
    assert.equal(fixture.commits.length, 1, 'failed verification must not replay the commit');
    assert.equal(await readFile(file, 'utf8'), 'owned fixture', 'fixture must never write native bytes');
    return result;
  } finally { await rm(root, {recursive:true, force:true}); }
}

test('TAE integer readback uses exact schema values, including native numeric strings', async () => {
  for (const type of ['u8','s8','u16','s16','u32','s32','s64']) {
    await verify({type, requested:' +80 ', observed:80, expected:true});
    await verify({type, requested:80, observed:79, expected:false});
  }
  await verify({requested:1_000_000, observed:999_999, expected:false});
  await verify({requested:'80.0', observed:80, expected:false});
  await verify({type:'u8', requested:256, observed:256, expected:false});
  await verify({type:'u32', requested:-1, observed:-1, expected:false});
  await verify({type:'s64', requested:'9007199254740993', observed:9007199254740992, expected:false});
});
test('TAE boolean and enum inputs normalize only the existing native encoding forms', async () => {
  for (const [requested, observed] of [[1,true],[0,false],[' True ',true],['FALSE',false]])
    await verify({type:'b', requested, observed, expected:true});
  await verify({type:'b', requested:'1', observed:true, expected:false});
  const enumEntries = [{name:'Enabled', value:80}];
  await verify({requested:'eNaBlEd', observed:80, expected:true, beforeExtra:{enumEntries}, afterExtra:{enumEntries}});
  await verify({requested:'Enabled', observed:79, expected:false, beforeExtra:{enumEntries}, afterExtra:{enumEntries}});
});
test('TAE f32 comparison allows only its representable precision, not a generic relative epsilon', async () => {
  await verify({type:'f32', requested:0.1, observed:Math.fround(0.1), expected:true});
  await verify({type:'f32', requested:' 1e-1 ', observed:0.1, expected:true});
  await verify({type:'f32', requested:1, observed:1 + 2 ** -23, expected:false});
  await verify({type:'f32', requested:1_000_000, observed:999_999, expected:false});
  await verify({type:'f32', requested:'0x10', observed:16, expected:false});
  await verify({type:'f32', requested:Infinity, observed:Infinity, expected:false});
  await verify({type:'f32', requested:-0, observed:0, expected:true});
  await verify({type:'f32', requested:'-0', observed:-0, expected:true});
  await verify({type:'f32', requested:'-0', observed:0, expected:false});
});
test('TAE native verification fails closed for unknown, changed or undecoded schema', async () => {
  await verify({requested:80, observed:80, rejected:true, beforeExtra:{enumEntries:{name:'invalid'}}});
  await verify({requested:80, observed:80, expected:false, afterExtra:{enumEntries:'invalid'}});
  await verify({type:'unknown', requested:80, observed:80, expected:false});
  await verify({requested:80, observed:80, expected:false, beforeExtra:{type:undefined}, afterExtra:{type:undefined}});
  await verify({requested:80, observed:80, expected:false, beforeExtra:{size:undefined}, afterExtra:{size:undefined}});
  await verify({requested:80, observed:80, expected:false, afterExtra:{type:'f32'}});
  await verify({requested:80, observed:80, expected:false, afterExtra:{offset:4}});
  await verify({requested:80, observed:80, expected:false, decoded:false});
  await verify({requested:80, observed:80, rejected:true, beforeExtra:{enumEntries:[null]}});
  await verify({requested:80, observed:80, expected:false, afterExtra:{enumEntries:[null]}});
  await verify({requested:'Enabled', observed:80, expected:false,
    beforeExtra:{enumEntries:[{name:'Enabled', value:80}]}, afterExtra:{enumEntries:[{name:'Enabled', value:81}]}});
});
test('TAE readback failure preserves a committed receipt without claiming native verification', async () => {
  const result = await verify({requested:80, observed:80, expected:false, readFailure:true});
  assert.deepEqual(result.after, []);
  assert.ok(result.diagnostics.some(item=>item.code==='OWNED_READBACK_FAILURE'));
});
