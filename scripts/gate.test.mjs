import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { delimiter, dirname, join } from 'node:path';
import {
  CMD_PATH_LIMIT, GATE_STEPS, findLocalPathLeaks, findMissingDocumentedCommands, gateEnvironment, localPathNeedles,
  overlongCmdPath, parseAddedLines
} from './gate.mjs';
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

test('gate keeps dotnet first runs off the persistent user PATH', () => {
  assert.equal(gateEnvironment({ PATH: 'p' }, () => false).DOTNET_ADD_GLOBAL_TOOLS_TO_PATH, 'false');
  assert.equal(gateEnvironment({ LOCALAPPDATA: 'l', PATH: 'p' }, () => true).DOTNET_ADD_GLOBAL_TOOLS_TO_PATH, 'false');
});

test('a PATH cmd.exe cannot search is reported before any step runs', () => {
  const path = length => 'x'.repeat(length);
  assert.equal(overlongCmdPath({ Path: path(CMD_PATH_LIMIT) }, 'win32'), undefined);
  assert.equal(overlongCmdPath({ Path: path(CMD_PATH_LIMIT + 1) }, 'win32'), CMD_PATH_LIMIT + 1);
  assert.equal(overlongCmdPath({ PATH: path(20000) }, 'linux'), undefined);
  assert.equal(GATE_STEPS[0][0], 'PATH fits cmd.exe');
});

test('added diff lines keep their new-file line numbers; headers and removals are not added lines', () => {
  const diff = [
    'diff --git a/a.mjs b/a.mjs',
    '--- a/a.mjs',
    '+++ b/a.mjs',
    '@@ -3,0 +4,2 @@ context',
    '+first',
    '+++ starts like a header',
    '@@ -9 +10,0 @@',
    '-removed',
    '\\ No newline at end of file',
    'diff --git a/gone.mjs b/gone.mjs',
    '--- a/gone.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git "a/sp ace.md" "b/sp ace.md"',
    '+++ "b/sp ace.md"',
    '@@ -0,0 +1 @@',
    '+text\r'
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [
    { path: 'a.mjs', line: 4, text: 'first' },
    { path: 'a.mjs', line: 5, text: '++ starts like a header' },
    { path: 'sp ace.md', line: 1, text: 'text' }
  ]);
});

test('a machine path is found in every spelling source code gives it', () => {
  const needles = ['D:/Games/Sekiro Root', 'C:/Users/dev'];
  const added = [
    { path: 'a.mjs', line: 1, text: "const root = 'd:\\\\games\\\\sekiro root';" },
    { path: 'b.ts', line: 2, text: 'see D:\\Games\\Sekiro Root\\mods' },
    { path: 'c.json', line: 3, text: '"uri": "file:///D:/Games/Sekiro%20Root/x"' },
    { path: 'd.mjs', line: 4, text: "join('C:/Users/dev', 'x')" },
    { path: 'docs/ai-logs/s.md', line: 5, text: 'C:/Users/dev' },
    { path: 'e.mjs', line: 6, text: "process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? ''" },
    // JSON inside a JS string: four backslashes, then two, then a forward slash.
    { path: 'f.mjs', line: 7, text: String.raw`"D:\\\\Games\\Sekiro Root/mods"` },
    { path: 'g.mjs', line: 8, text: 'C:/Users/developer/x' }
  ];
  assert.deepEqual(findLocalPathLeaks(added, needles, { platform: 'win32' }).map(leak => `${leak.path}:${leak.line}`),
    ['a.mjs:1', 'b.ts:2', 'c.json:3', 'd.mjs:4', 'f.mjs:7']);
  // Case is significant off Windows: the lower-case spelling is a different path there.
  assert.deepEqual(findLocalPathLeaks(added, needles, { platform: 'linux' }).map(leak => leak.path),
    ['b.ts', 'c.json', 'd.mjs', 'f.mjs']);
});

test('needles are this machine\'s real paths, never a bare root or a non-path setting', () => {
  const env = {
    SOULFORGE_SEKIRO_GAME_ROOT: 'D:\\Games\\Sekiro\\',
    soulforge_refcli: 'D:\\Tools\\refcli.mjs',
    SOULFORGE_MODE: 'strict',
    SOULFORGE_GONE: 'D:\\Gone\\Path',
    SOULFORGE_DRIVE: 'D:\\',
    OTHER_ROOT: 'D:\\Other\\Root'
  };
  const present = new Set(['D:\\Games\\Sekiro\\', 'D:\\Tools\\refcli.mjs', 'D:\\', 'D:\\Other\\Root', '/home/dev', 'D:/Repo/X']);
  assert.deepEqual(localPathNeedles(env, { home: '/home/dev', roots: ['D:/Repo/X'], exists: path => present.has(path) }).sort(),
    ['/home/dev', 'D:/Games/Sekiro', 'D:/Repo/X', 'D:/Tools/refcli.mjs']);
  assert.deepEqual(GATE_STEPS.slice(2, 4).map(([name]) => name), ['trust-zone isolation', 'no added local paths']);
});

test('CI runs the gate and nothing weaker', () => {
  const workflow = readFileSync('.github/workflows/windows-ci.yml', 'utf8');
  assert.match(workflow, /run: node scripts\/gate\.mjs/u);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.gate, 'node scripts/gate.mjs');
});
