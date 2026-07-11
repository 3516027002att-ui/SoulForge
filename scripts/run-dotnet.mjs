import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const candidates = [
  process.env.SOULFORGE_DOTNET,
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'SoulForge', 'dotnet', 'dotnet.exe')
    : undefined
].filter(Boolean);
const executable = candidates.find(existsSync) ?? 'dotnet';
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
