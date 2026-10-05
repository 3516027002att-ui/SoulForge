// Select the native probe's existing resource-free mode without importing its
// private-resource inputs into the public check's dependency classification.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('./verify-map-streaming-native.mjs', import.meta.url)), '--fixture', ...process.argv.slice(2)
], { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
