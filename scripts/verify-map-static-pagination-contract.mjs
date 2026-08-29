import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const servicePath = new URL('../bridge/SoulForge.Bridge/MapStaticGeometryService.cs', import.meta.url);
const commandPath = new URL('../bridge/SoulForge.Bridge/BridgeCommandService.cs', import.meta.url);
const [serviceSource, commandSource] = await Promise.all([
  readFile(servicePath, 'utf8'),
  readFile(commandPath, 'utf8')
]);

const commandStart = commandSource.indexOf('if (command == "read-map-static-geometry")');
const commandEnd = commandSource.indexOf('if (command == ', commandStart + 1);
assert.ok(commandStart >= 0 && commandEnd > commandStart, 'read-map-static-geometry command block must exist');
const commandBlock = commandSource.slice(commandStart, commandEnd);

assert.match(serviceSource, /nextCursor = GenerateOpaqueCursor\(session,/,
  'static geometry pages must emit an opaque session-bound cursor');
assert.ok((commandBlock.match(/TryDecodeOpaqueCursor\(/g) ?? []).length >= 2,
  'resume validation and resume position must both decode against the active session');
assert.doesNotMatch(commandBlock, /MapStaticGeometryService\.TryDecodeCursor\(/,
  'production pagination must not decode opaque cursors with the legacy Base64 decoder');

console.log(JSON.stringify({
  ok: true,
  contract: 'map-static-opaque-cursor-resume',
  checks: ['opaque-emission', 'session-bound-validation', 'session-bound-position', 'legacy-decoder-negative']
}, null, 2));
