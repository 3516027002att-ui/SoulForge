import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processSucceeded, runProcess } from './subprocess-control.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'scripts/owned-process-linux-guardian.c');
const artifactRoot = resolve(repositoryRoot, '.local-validation/owned-process-guardian');
const artifactDirectory = join(artifactRoot, 'linux-x64');
const binaryName = 'soulforge-owned-process-guardian';
const flags = ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
const protocol = 'soulforge.owned-process-guardian.v1';
const sourceHash = bytes => createHash('sha256').update(bytes).digest('hex');

async function ensurePrivateDirectory(relativeParts) {
  const rootInfo = await lstat(repositoryRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(repositoryRoot) !== repositoryRoot) {
    throw new Error('OWNED_PROCESS_GUARDIAN_BUILD_ROOT_NOT_CANONICAL');
  }
  let current = repositoryRoot;
  for (const part of relativeParts) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error('OWNED_PROCESS_GUARDIAN_BUILD_PATH_NOT_PRIVATE');
    }
  }
  return current;
}

async function main() {
  if (process.platform !== 'linux') {
    console.log('OWNED_PROCESS_GUARDIAN_PREPARE_NOT_REQUIRED: non-Linux runtime');
    return;
  }
  if (process.arch !== 'x64') throw new Error('OWNED_PROCESS_GUARDIAN_PLATFORM_UNSUPPORTED: currently Linux x64 only');
  const artifactInfo = await ensurePrivateDirectory(['.local-validation', 'owned-process-guardian', 'linux-x64']);
  const attemptsInfo = await ensurePrivateDirectory(['.local-validation', 'owned-process-guardian', 'attempts']);
  const attemptRoot = join(attemptsInfo, randomUUID());
  await mkdir(attemptRoot, { mode: 0o700 });
  const attemptInfo = await lstat(attemptRoot);
  if (!attemptInfo.isDirectory() || attemptInfo.isSymbolicLink() || await realpath(attemptRoot) !== attemptRoot) {
    throw new Error('OWNED_PROCESS_GUARDIAN_BUILD_ATTEMPT_NOT_PRIVATE');
  }
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1 || await realpath(source) !== source) {
    throw new Error('OWNED_PROCESS_GUARDIAN_SOURCE_NOT_PRIVATE');
  }
  const sourceBytes = await readFile(source);
  const sourceSnapshot = join(attemptRoot, 'owned-process-linux-guardian.c');
  await writeFile(sourceSnapshot, sourceBytes, { flag: 'wx', mode: 0o600 });
  const attemptBinary = join(attemptRoot, binaryName);
  const compiler = process.env.SOULFORGE_OWNED_PROCESS_GUARDIAN_CC || process.env.CC || 'cc';
  const saveFailure = async (stage, error, result) => {
    const report = { schema: 'soulforge.owned-process-guardian-build-failure.v1', stage,
      platform: process.platform, arch: process.arch, compiler, flags,
      error: error instanceof Error ? error.message : String(error),
      ...(result ? { code: result.code, signal: result.signal, timedOut: result.timedOut,
        cancelled: result.cancelled, stderr: result.stderr } : {}) };
    await writeFile(join(attemptRoot, 'failure.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  };

  let version;
  try {
    version = await runProcess({ command: compiler, args: ['--version'], cwd: repositoryRoot,
      timeoutMs: 15_000, outputLimitBytes: 8192 });
    if (!processSucceeded(version)) throw new Error(`compiler version probe failed (${version.code}): ${version.stderr}`);
  } catch (error) { await saveFailure('compiler-version', error, version); throw error; }

  let build;
  try {
    build = await runProcess({ command: compiler, args: [...flags, sourceSnapshot, '-o', attemptBinary], cwd: repositoryRoot,
      timeoutMs: 120_000, outputLimitBytes: 32 * 1024 });
    if (!processSucceeded(build)) throw new Error(`guardian compile failed (${build.code}): ${build.stderr}`);
    const binaryStat = await lstat(attemptBinary);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.nlink !== 1) throw new Error('guardian output is not a private regular file');
    await chmod(attemptBinary, 0o700);
    if (sourceHash(await readFile(source)) !== sourceHash(sourceBytes)) throw new Error('OWNED_PROCESS_GUARDIAN_SOURCE_CHANGED_DURING_PREPARE');
  } catch (error) { await saveFailure('compile', error, build); throw error; }

  const binaryBytes = await readFile(attemptBinary);
  const binarySha256 = sourceHash(binaryBytes);
  const binaryFile = `${binaryName}.${randomUUID()}`;
  const manifest = {
    schema: 'soulforge.owned-process-guardian-build.v2',
    protocol,
    protocolVersion: 1,
    platform: 'linux',
    arch: 'x64',
    binaryFile,
    sourceSha256: sourceHash(sourceBytes),
    binarySha256,
    compiler: { command: compiler, version: version.stdout.slice(0, 4096).trim(), flags }
  };
  const attemptManifest = join(attemptRoot, `${binaryName}.manifest.json`);
  await writeFile(attemptManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  // Keep all attempts as evidence. Publish an immutable binary version first;
  // replacing the manifest is the only commit point. Before that rename, the
  // old manifest still selects its unchanged binary and an orphan is ignored.
  const binaryPath = join(artifactDirectory, binaryFile);
  const manifestPath = join(artifactDirectory, `${binaryName}.manifest.json`);
  const manifestNext = `${manifestPath}.${randomUUID()}.next`;
  try {
    // Each build gets a fresh immutable filename. The existing manifest remains
    // the sole pointer to the live binary until its final atomic replacement.
    // A killed prepare can leave an orphan version, but cannot overwrite the
    // binary referenced by the previous successful manifest.
    await copyFile(attemptBinary, binaryPath, fsConstants.COPYFILE_EXCL);
    await chmod(binaryPath, 0o700);
    const publishedBinaryStat = await lstat(binaryPath);
    if (!publishedBinaryStat.isFile() || publishedBinaryStat.isSymbolicLink() || publishedBinaryStat.nlink !== 1) {
      throw new Error('OWNED_PROCESS_GUARDIAN_PUBLISHED_BINARY_NOT_PRIVATE');
    }
    if (sourceHash(await readFile(binaryPath)) !== binarySha256) {
      throw new Error('OWNED_PROCESS_GUARDIAN_PUBLISHED_BINARY_HASH_MISMATCH');
    }
    await writeFile(manifestNext, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Recheck the source and output chain immediately before publication; a
    // source edit or a link anywhere in the ignored artifact path fails closed.
    if (sourceHash(await readFile(source)) !== manifest.sourceSha256) throw new Error('OWNED_PROCESS_GUARDIAN_SOURCE_CHANGED_DURING_PREPARE');
    const latestArtifactDirectory = await ensurePrivateDirectory(['.local-validation', 'owned-process-guardian', 'linux-x64']);
    if (latestArtifactDirectory !== artifactInfo) throw new Error('OWNED_PROCESS_GUARDIAN_BUILD_PATH_CHANGED');
    await rename(manifestNext, join(latestArtifactDirectory, `${binaryName}.manifest.json`));
  } catch (error) { await saveFailure('publish', error); throw error; }
  console.log(JSON.stringify({ status: 'prepared', artifactDirectory, attemptRoot,
    protocolVersion: manifest.protocolVersion, platform: manifest.platform, arch: manifest.arch, binaryFile,
    sourceSha256: manifest.sourceSha256, binarySha256: manifest.binarySha256 }));
}

main().catch(error => {
  console.error(`OWNED_PROCESS_GUARDIAN_PREPARE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
