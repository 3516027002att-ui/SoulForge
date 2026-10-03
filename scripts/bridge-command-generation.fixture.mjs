import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateBridgeCommands, checkOrWriteBridgeCommands } from './generate-bridge-commands.mjs';

test('C# and TS command projections match the one manifest', async () => {
  assert.equal((await checkOrWriteBridgeCommands({ check: true })).commands, 59);
});

test('malformed and duplicate command definitions fail closed', async () => {
  const manifest = JSON.parse(await readFile('bridge/commands.json', 'utf8'));
  assert.throws(() => generateBridgeCommands({ ...manifest, commands: [...manifest.commands, manifest.commands[0]] }), /BRIDGE_COMMAND_MANIFEST_INVALID/);
  const write = manifest.commands.find(command => command.effect === 'write');
  assert.throws(() => generateBridgeCommands({ schemaVersion: 1, commands: [{ ...write, requiredInputFields: ['command', 'filePath'] }] }), /BRIDGE_COMMAND_MANIFEST_INVALID/);
});


test('write commands cannot disable staging-output admission', async () => {
  const manifest = JSON.parse(await readFile('bridge/commands.json', 'utf8'));
  const write = manifest.commands.find(command => command.effect === 'write');
  assert.throws(() => generateBridgeCommands({ schemaVersion: 1, commands: [{ ...write, requiresOutputPath: false }] }), /BRIDGE_COMMAND_MANIFEST_INVALID/);
});

test('Windows CRLF checkout keeps command projections valid while actual content drift still fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-command-checkout-'));
  try {
    const manifest = JSON.parse(await readFile('bridge/commands.json', 'utf8'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'bridge'), { recursive: true });
    await writeFile(join(root, 'scripts/generate-bridge-commands.mjs'), await readFile(new URL('./generate-bridge-commands.mjs', import.meta.url)));
    await writeFile(join(root, 'bridge/commands.json'), JSON.stringify(manifest));
    const outputs = generateBridgeCommands(manifest);
    for (const [file, text] of outputs) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text.replaceAll('\n', '\r\n'));
    }
    const run = () => spawnSync(process.execPath, [join(root, 'scripts/generate-bridge-commands.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    const cs = [...outputs.keys()][0];
    await writeFile(join(root, cs), outputs.get(cs).replace('read-tae-document', 'read-tae-wrong').replaceAll('\n', '\r\n'));
    const drift = run();
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /BRIDGE_COMMAND_GENERATED_STALE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
