import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyGoalsThroughNativeTool } from './real-agent-evaluator.mjs';
import * as provenance from './testing/agent-run-provenance.mjs';
import * as harness from './real-agent-harness-lib.mjs';

const fieldGoal = { goalId: 'hp', kind: 'param-field', table: 'NpcParam', rowId: 1,
  fieldId: 'hp', expectedValue: 80, required: true, changedPath: 'sample.param' };
const tree = { root: '/overlay', before: { entries: [{type:'file',path:'sample.param', sha256:'same'}] },
  after: { entries: [{type:'file',path:'sample.param', sha256:'same'}] } };
const nativeValue = (value) => ({ ok: true, data: {sourceUri:'file://sample.param', fields: [{rowId:1, fieldId:'hp', value,
  sourceHash:'a'.repeat(64), sourceUri:'file://sample.param'}] } });

test('readback evaluates the actual isolated resource, not the model receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-independent-readback-'));
  try {
    await writeFile(join(root, 'sample.param'), '81', 'utf8');
    const result = await verifyGoalsThroughNativeTool(async () => {
      const bytes = await readFile(join(root, 'sample.param'));
      const response = nativeValue(Number(bytes.toString('utf8')));
      response.data.fields[0].sourceHash = createHash('sha256').update(bytes).digest('hex');
      return response;
    }, [fieldGoal], {...tree, root}, {intent:'ensure'});
    assert.equal(result.evaluations[0].status, 'failed');
    assert.equal(result.evaluations[0].observedValue, 81);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('unchanged ensure goal passes while explicitly required mutation fails', async () => {
  const result = await verifyGoalsThroughNativeTool(async () => nativeValue(80), [fieldGoal], tree, {intent:'ensure'});
  assert.equal(result.evaluations[0].status, 'verified');
  const modified = await verifyGoalsThroughNativeTool(async () => nativeValue(80),
    [{...fieldGoal, requireMutation:true}], tree, {intent:'modify'});
  assert.equal(modified.evaluations[0].status, 'failed');
});

test('nested PARAM goals each read all requested fields without cache aliasing', async () => {
  const reads = [];
  const goals = [{goalId:'both', kind:'composite', required:true, checks:[fieldGoal,
    {...fieldGoal, goalId:'guard', fieldId:'guard', expectedValue:12}]}];
  const result = await verifyGoalsThroughNativeTool(async (_tool, input) => {
    reads.push(input.fieldIds);
    return {ok:true,data:{sourceUri:'file://sample.param',fields: input.fieldIds.map(fieldId => ({rowId:1,fieldId,
      value: fieldId === 'hp' ? 80 : 12, sourceHash:'a'.repeat(64),sourceUri:'file://sample.param'}))}};
  }, goals, tree, {intent:'ensure'});
  assert.equal(result.evaluations[0].status, 'verified');
  assert.deepEqual(reads.flat().sort(), ['guard','hp']);
});

test('unavailable native verification stays unverified, actual native errors fail', async () => {
  const unavailable = await verifyGoalsThroughNativeTool(async () => ({ok:false,error:{code:'BRIDGE_RUNTIME_UNAVAILABLE'}}), [fieldGoal], tree);
  assert.equal(unavailable.evaluations[0].status, 'unverified');
  const bad = await verifyGoalsThroughNativeTool(async () => ({ok:false,error:{code:'PARAM_FIELD_NOT_FOUND'}}), [fieldGoal], tree);
  assert.equal(bad.evaluations[0].status, 'failed');
});

test('task acceptance does not require write and rollback for read or satisfied ensure', () => {
  const facts = {goalCoverage:{taskCompletionVerified:true,status:'verified'}, lifecycleOk:true,
    durableEvidenceOk:true,runtimeOk:true,treeRestoredExactly:true,rollbackStatus:'not_applicable',
    committedOperationOk:false,writeObserved:false,writeMode:false,executionMode:'observation-only'};
  assert.equal(harness.evaluateTaskOutcome({...facts,taskContract:{intent:'read'}}).status, 'passed');
  assert.equal(harness.evaluateTaskOutcome({...facts,writeMode:true,executionMode:'task-verification',taskContract:{intent:'ensure'}}).status, 'passed');
  assert.equal(harness.evaluateTaskOutcome({...facts,taskContract:{intent:'modify'}}).status, 'failed');
  assert.equal(harness.evaluateTaskOutcome({...facts,writeObserved:true,taskContract:{intent:'read'}}).status, 'failed');
  assert.equal(harness.evaluateTaskOutcome({...facts,goalCoverage:{taskCompletionVerified:false,status:'unverified'},taskContract:{intent:'read'}}).status, 'unverified');
});

test('UTF-8 task input keeps Chinese text and rejects corrupt bytes', () => {
  assert.equal(provenance.decodeTaskInput(Buffer.from('\ufeff把词条改为80', 'utf8')), '把词条改为80');
  assert.throws(() => provenance.decodeTaskInput(Buffer.from([0xff, 0xfe, 0x61])), /UTF-8/u);
});

test('required mutation without an independently checkable path or snapshots never verifies', async () => {
  const {changedPath: _removed, ...withoutPath} = fieldGoal;
  for (const [goal, evidence] of [[{...withoutPath,requireMutation:true},tree],[{...fieldGoal,requireMutation:true},undefined]]) {
    const result = await verifyGoalsThroughNativeTool(async()=>nativeValue(80),[goal],evidence,{intent:'ensure'});
    assert.equal(result.evaluations[0].verified,false);
    assert.equal(result.evaluations[0].status,'unverified');
  }
});

test('snapshot build identity retains its actual revision even when the live checkout differs',()=>{
  assert.equal(typeof provenance.bindTestedArtifact,'function');
  const bound=provenance.bindTestedArtifact({outputHash:'snapshot-bytes'},{mode:'immutable-snapshot',manifest:{sourceRevision:'a'.repeat(40),liveBuild:{sourceSha256:'source-bytes'}},liveSource:{commit:'b'.repeat(40)}});
  assert.equal(bound.commit,'a'.repeat(40));assert.equal(bound.liveCheckout.commit,'b'.repeat(40));assert.equal(bound.sourceHash,'source-bytes');
});
test('same provider ID with changed model or protocol has distinct non-secret identity',()=>{
  assert.equal(typeof provenance.bindProviderConfiguration,'function');
  const first=provenance.bindProviderConfiguration({id:'same',protocol:'openai-compatible',model:'old',baseUrl:'https://user:password@example.test/v1?api_key=hidden',apiKey:'must-not-record',headers:{Authorization:'must-not-record'},temperature:0});
  const second=provenance.bindProviderConfiguration({id:'same',protocol:'anthropic-compatible',model:'new',baseUrl:'https://example.test/v1',temperature:0});
  assert.notEqual(first.configSha256,second.configSha256);assert.equal(first.model,'old');assert.equal(first.protocol,'openai-compatible');
  assert.doesNotMatch(JSON.stringify(first),/password|hidden|must-not-record|Authorization/u);
});
test('independent verifier identity hashes its actual code/artifacts separately from the tested snapshot',async()=>{
  assert.equal(typeof provenance.captureVerifierArtifact,'function');const root=await mkdtemp(join(tmpdir(),'sf-verifier-binding-'));
  try{await writeFile(join(root,'verify.mjs'),'live verifier A');const before=await provenance.captureVerifierArtifact(root,['verify.mjs']);await writeFile(join(root,'verify.mjs'),'live verifier B');const after=await provenance.captureVerifierArtifact(root,['verify.mjs']);assert.notEqual(before.sha256,after.sha256);assert.equal(after.scope,'independent-verifier-artifact');}
  finally{await rm(root,{recursive:true,force:true});}
});
test('independently observed wrong values fail even when required mutation evidence is missing',async()=>{
 const {changedPath: _path,...goal}=fieldGoal;
 const wrong=await verifyGoalsThroughNativeTool(async()=>nativeValue(81),[{...goal,requireMutation:true}],tree,{intent:'ensure'});
 assert.equal(wrong.evaluations[0].status,'failed');assert.equal(wrong.evaluations[0].reason,'postcondition-failed');
 const composite=await verifyGoalsThroughNativeTool(async()=>nativeValue(81),[{goalId:'parent',kind:'composite',requireMutation:true,checks:[goal]}],tree);
 assert.equal(composite.evaluations[0].status,'failed');
});
