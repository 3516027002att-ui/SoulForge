import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public Windows/Linux builds produce this managed assembly before publishing
// the single-file apphost. An explicit producer overrides it for isolated work.
export function mapValidationProducer() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const runtime = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const explicit = process.env.SOULFORGE_BRIDGE_DLL;
  const dll = explicit || resolve(root, 'bridge/SoulForge.Bridge/bin/Release/net10.0', runtime, 'SoulForge.Bridge.dll');
  return { dll, dotnet: process.env.SOULFORGE_DOTNET_PATH || process.env.SOULFORGE_DOTNET || 'dotnet',
    skip: !explicit && !existsSync(dll) && 'Compiled production Bridge DLL is unavailable; build native producer or set SOULFORGE_BRIDGE_DLL' };
}
