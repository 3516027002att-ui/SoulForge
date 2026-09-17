import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assetPath,
  hashFile,
  readProjectVersion,
  releaseAssetNames,
  releaseDirectory,
  releaseVersion,
  regularFile,
  structuredError
} from './release-update-assets-lib.mjs';

const root = resolve(import.meta.dirname, '..');

try {
  const args = process.argv.slice(2);
  const project = await readProjectVersion(root);
  const version = releaseVersion(args, project.version);
  const directory = await releaseDirectory(root, args);
  const names = releaseAssetNames(version);
  const namesToHash = [names.installer, names.blockmap, names.latest, names.compliance, names.source].sort((left, right) => left.localeCompare(right));
  const records = [];
  for (const name of namesToHash) {
    const path = await assetPath(root, directory, name);
    await regularFile(path, name);
    records.push({ name, sha256: await hashFile(path, 'sha256', 'hex') });
  }
  const sumsPath = await assetPath(root, directory, names.checksums);
  const content = `${records.map((item) => `${item.sha256}  ${item.name}`).join('\n')}\n`;
  await writeFile(sumsPath, content, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    version,
    output: names.checksums,
    assets: records
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'failed', ...structuredError(error) }, null, 2));
  process.exitCode = 1;
}
