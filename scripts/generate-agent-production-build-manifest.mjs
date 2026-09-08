import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAgentProductionBuildManifest } from './agent-production-build-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const result = await writeAgentProductionBuildManifest(repoRoot);

console.log(JSON.stringify({
  ok: true,
  manifestPath: result.manifestPath,
  sourceHash: result.manifest.source.sha256,
  outputHash: result.manifest.output.sha256,
  sourceFiles: result.manifest.source.fileCount,
  outputFiles: result.manifest.output.fileCount
}));
