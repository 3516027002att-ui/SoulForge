#!/usr/bin/env node
// Execute the real PARAM service/transport behavior and generated public
// facade. This source-bound suite does not claim native parsing or private
// corpus acceptance; those remain separate Bridge/platform checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const child = spawnSync(process.execPath, ['--test',
  'scripts/param-domain-service.fixture.mjs', 'scripts/public-ipc-contract.fixture.mjs'
], { cwd: root, stdio: 'inherit' });
if (child.error) throw child.error;
if (child.status !== 0 || child.signal) process.exit(child.status || 1);

// Retain these existing source checks as source checks, rather than treating
// marker presence as execution of the C# branches.
const shared = readFileSync(resolve(root, 'packages/shared/src/param-ipc-protocol.ts'), 'utf8');
assert.match(shared, /PARAM_ROW_PAYLOAD_BATCH_MAX = 256/);
const bridge = readFileSync(resolve(root, 'bridge/SoulForge.Bridge/BridgeCommandService.cs'), 'utf8');
for (const marker of ['PARAM_ROW_IDENTITY_MISMATCH', 'includeRowPayloads', 'rowSelections']) {
  assert.ok(bridge.includes(marker), `Native PARAM contract source marker missing: ${marker}`);
}
console.log(JSON.stringify({ label: 'param-slim-ipc', ok: true,
  verification: 'actual TypeScript service and public facade; C# markers checked statically', nativeExecution: 'not_run' }));
