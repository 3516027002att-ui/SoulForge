import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGAL_FILES = [
  ['LICENSE.TXT', 'LICENSE.txt'],
  ['THIRD-PARTY-NOTICES.TXT', 'THIRD-PARTY-NOTICES.txt']
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Copy the notices of the runtime actually embedded by this target's publish. */
export async function prepareRuntimeNotices(repoRoot, {
  runtimeIdentifier = process.platform === 'win32' ? 'win-x64' : 'linux-x64',
  packageFolders = process.env.NUGET_PACKAGES ? [process.env.NUGET_PACKAGES] : []
} = {}) {
  if (!['win-x64', 'linux-x64'].includes(runtimeIdentifier)) throw new Error('Unsupported runtime notice target');
  const project = join(resolve(repoRoot), 'bridge/SoulForge.Bridge');
  const build = join(project, 'bin/Release/net10.0', runtimeIdentifier);
  const dependencies = JSON.parse(await readFile(join(build, 'SoulForge.Bridge.deps.json'), 'utf8'));
  const prefix = `runtimepack.Microsoft.NETCore.App.Runtime.${runtimeIdentifier}/`;
  const matches = Object.keys(dependencies.libraries ?? {}).filter(key => key.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`Expected one ${runtimeIdentifier} runtime package in published dependencies`);
  const packageVersion = matches[0].slice(prefix.length);
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(packageVersion)) throw new Error('Invalid published runtime package version');
  const packageId = `Microsoft.NETCore.App.Runtime.${runtimeIdentifier}`;
  let assets;
  try { assets = JSON.parse(await readFile(join(project, 'obj/project.assets.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const folders = [...new Set([...packageFolders, ...Object.keys(assets?.packageFolders ?? {})])];
  let legal;
  for (const folder of folders) {
    const pack = join(folder, packageId.toLowerCase(), packageVersion);
    try {
      legal = await Promise.all(LEGAL_FILES.map(async ([sourceName, name]) => {
        const bytes = await readFile(join(pack, sourceName));
        if (bytes.length === 0) throw new Error(`Empty runtime notice: ${sourceName}`);
        return { name, bytes, sha256: sha256(bytes) };
      }));
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!legal) throw new Error(`Exact runtime license/notices are unavailable: ${packageId}/${packageVersion}`);
  const result = {
    schemaVersion: 1, runtimeIdentifier, packageId, packageVersion,
    files: legal.map(({ name, bytes, sha256: digest }) => ({ name, bytes: bytes.length, sha256: digest }))
  };
  const output = join(build, 'publish/runtime-notices');
  await mkdir(output, { recursive: true });
  for (const { name, bytes } of legal) await writeFile(join(output, name), bytes);
  await writeFile(join(output, 'runtime-notices.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--runtime') throw new Error('Usage: node scripts/dotnet-runtime-notices.mjs --runtime win-x64|linux-x64');
  prepareRuntimeNotices(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { runtimeIdentifier: args[1] })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
