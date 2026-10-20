import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { delimiter, dirname, join } from 'node:path';
import { findMissingDocumentedCommands, gateEnvironment } from './gate.mjs';
import { TRUST_ZONE } from './trust-zone-check.mjs';

test('documented commands that do not exist are reported', () => {
  const text = 'Run `npm run gate` and `npm run gone:script --x`, then `node scripts/missing.mjs`, `node compare/gone.mjs` and `node scripts/here.mjs`.';
  const missing = findMissingDocumentedCommands(text, { gate: 'node scripts/gate.mjs' }, path => path === 'scripts/here.mjs');
  assert.deepEqual(missing, ['npm run gone:script --x', 'node scripts/missing.mjs', 'node compare/gone.mjs']);
});

test('AGENTS.md names only commands that exist', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.deepEqual(findMissingDocumentedCommands(readFileSync('AGENTS.md', 'utf8'), scripts, existsSync), []);
});

test('CODEOWNERS and AGENTS.md list exactly the trust zone', () => {
  const owners = readFileSync('.github/CODEOWNERS', 'utf8').split(/\r?\n/u)
    .filter(line => line.trim() && !line.startsWith('#')).map(line => line.trim().split(/\s+/u)[0].replace(/^\//u, ''));
  assert.deepEqual([...owners].sort(), [...TRUST_ZONE].sort());
  const agents = readFileSync('AGENTS.md', 'utf8');
  const section = agents.slice(agents.indexOf('## Trust zone'), agents.indexOf('## Completion'));
  const listed = [...section.matchAll(/`([^`\s]+)`/gu)].map(match => match[1]).filter(path => !path.startsWith('node ') && path !== 'TRUST_ZONE');
  for (const entry of TRUST_ZONE) assert.ok(listed.includes(entry), `AGENTS.md trust zone section is missing ${entry}`);
  for (const path of listed.filter(path => path !== '.github/CODEOWNERS')) {
    assert.ok(TRUST_ZONE.includes(path), `AGENTS.md trust zone section lists ${path}, which TRUST_ZONE does not`);
  }
});

test('gate pins the repository-local .NET SDK ahead of PATH and leaves CI PATH alone', () => {
  const local = join('owned-local', 'SoulForge', 'dotnet', 'dotnet.exe');
  const pinned = gateEnvironment({ LOCALAPPDATA: 'owned-local', Path: 'machine-dotnet' }, path => path === local);
  assert.equal(pinned.Path, [dirname(local), 'machine-dotnet'].join(delimiter));
  assert.equal(Object.keys(pinned).filter(key => key.toUpperCase() === 'PATH').length, 1, 'no second PATH key');
  assert.equal(pinned.SOULFORGE_CONTRACT_REQUIRE_BUNDLES, '1');

  const explicit = join('owned-sdk', 'dotnet.exe');
  const chosen = gateEnvironment({ SOULFORGE_DOTNET: explicit, LOCALAPPDATA: 'owned-local', PATH: 'p' }, () => true);
  assert.equal(chosen.PATH, [dirname(explicit), 'p'].join(delimiter), 'SOULFORGE_DOTNET wins over the local SDK');

  // CI: no override exists, so the setup-dotnet SDK on PATH is used as is.
  const ci = gateEnvironment({ LOCALAPPDATA: 'runner-local', PATH: 'setup-dotnet' }, () => false);
  assert.equal(ci.PATH, 'setup-dotnet');
});

test('CI runs the gate and nothing weaker', () => {
  const workflow = readFileSync('.github/workflows/windows-ci.yml', 'utf8');
  assert.match(workflow, /run: node scripts\/gate\.mjs/u);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.gate, 'node scripts/gate.mjs');
});
