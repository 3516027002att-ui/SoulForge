import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolDeclarations } from './testing/tool-source-analysis.mjs';
test('write-path analysis inspects both factory and inline declarations instead of a single legacy file',()=>{
 const declarations=extractToolDeclarations("export function make(){return {name:'new_writer',permission:'commit',permissionLevel:'commit',run:async()=>writeFile('target','bad')}};registry.register({name:'old_writer',permission:'write',run:()=>commitPatchProposal()});",'fixture.ts');
 assert.deepEqual(declarations.map(d=>d.name),['new_writer','old_writer']);assert.equal(declarations[0].permission,'commit');assert.match(declarations[0].body,/writeFile/);
});
