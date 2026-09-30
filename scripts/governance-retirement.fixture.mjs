import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
test('retired claim and seal workflow has no executable authority or CI startup audit',()=>{
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(Object.keys(pkg.scripts).some(name=>name==='gov'||name.startsWith('gov:')),false);
 for(const file of ['scripts/gov.mjs','scripts/gov/lock.mjs','scripts/gov/seal.mjs','scripts/verify-gov-cli-fixtures.mjs','scripts/verify-seal-cli-fixtures.mjs'])assert.equal(existsSync(file),false,file);
 const workflow=readFileSync('.github/workflows/windows-ci.yml','utf8');assert.doesNotMatch(workflow,/run: node scripts\/verify\.mjs --audit/);assert.match(workflow,/node scripts\/check\.mjs --tier/);
 assert.equal(existsSync('AGENTS.md'),true);assert.equal(existsSync('ARCHITECTURE.md'),true);assert.equal(existsSync('docs/DECISIONS.md'),true);
});
