import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  assetPath,
  hashFile,
  latestYmlText,
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
  const installerPath = await assetPath(root, directory, names.installer);
  const blockmapPath = await assetPath(root, directory, names.blockmap);
  await regularFile(installerPath, names.installer);
  await regularFile(blockmapPath, names.blockmap);
  const installerStats = await regularFile(installerPath, names.installer);
  const sha512 = await hashFile(installerPath, 'sha512', 'base64');
  const latestPath = await assetPath(root, directory, names.latest);
  await mkdir(directory, { recursive: true });
  await writeFile(latestPath, latestYmlText({
    version,
    installer: names.installer,
    sha512,
    size: installerStats.size
  }), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    version,
    output: names.latest,
    installer: {
      name: names.installer,
      size: installerStats.size,
      sha512
    },
    blockmap: names.blockmap,
    releaseDirectory: relative(root, directory)
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'failed', ...structuredError(error) }, null, 2));
  process.exitCode = 1;
}
