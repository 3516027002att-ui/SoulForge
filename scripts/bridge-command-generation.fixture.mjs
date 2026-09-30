import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { generateBridgeCommands, checkOrWriteBridgeCommands } from './generate-bridge-commands.mjs';

test('C# and TS command projections match the one manifest', async () => {
  assert.equal((await checkOrWriteBridgeCommands({ check: true })).commands, 58);
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
