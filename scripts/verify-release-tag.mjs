import { resolve } from 'node:path';
import {
  readProjectVersion,
  releaseTag,
  structuredError
} from './release-update-assets-lib.mjs';

const root = resolve(import.meta.dirname, '..');

try {
  const args = process.argv.slice(2);
  const project = await readProjectVersion(root);
  const tag = releaseTag(args, project.version, { required: true });
  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    tag,
    version: project.version,
    rootPackageVersion: project.rootPackage.version,
    desktopPackageVersion: project.desktopPackage.version,
    fixedRepository: '3516027002att-ui/SoulForge'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'failed', ...structuredError(error) }, null, 2));
  process.exitCode = 1;
}

