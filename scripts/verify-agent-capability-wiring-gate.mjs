#!/usr/bin/env node
// Compatibility entry for the actual public contract, desktop application
// admission and shared host composition. No retired loop/source-layout gate.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--test',
  'scripts/agent-host-composition.fixture.mjs',
  'scripts/agent-domain-service.fixture.mjs'
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) console.error(`Agent capability checks terminated by ${result.signal}.`);
process.exitCode = result.status ?? 1;
