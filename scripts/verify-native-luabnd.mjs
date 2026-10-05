import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBridgeProductionBuildFresh, bridgeBuildTarget } from './bridge-production-build.mjs';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const role = 'luabnd-primary';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function validationError(code, message, status = 'failed') {
  return Object.assign(new Error(message), { code, status });
}

async function readInput(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) {
      throw validationError('LUABND_INPUT_INVALID', 'Lua input must be a regular file of at most 64 MiB.');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw validationError('LUABND_INPUT_CHANGED', 'Lua input changed during its bounded read.');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

export async function selectNativeLuabndInput(explicitPath) {
  const explicit = explicitPath?.trim() || process.env.SOULFORGE_LUABND_PATH?.trim();
  if (explicit) return { path: await realpath(resolve(explicit)), selection: 'explicit-source' };
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const registry = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  if (!fixtureRoot) throw validationError('LUABND_INPUT_UNAVAILABLE',
    'Configure SOULFORGE_LUABND_PATH, a positional input, or the native fixture root/registry.', 'unavailable');
  const manifest = JSON.parse(await readFile(join(repoRoot, 'testdata/corpus/sekiro-1.6.corpus-manifest.json'), 'utf8'));
  const fixtures = manifest.correctnessFixtures?.fixtures?.filter(item => item.role === role);
  if (fixtures?.length !== 1) throw validationError('FIXED_CORPUS_MANIFEST_INVALID', 'Pinned Lua fixture must be unique.');
  const fixture = fixtures[0];
  const root = await realpath(resolve(fixtureRoot));
  let path;
  if (registry) {
    if (!process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()) {
      throw validationError('NATIVE_FIXTURE_ROOT_REQUIRED', 'The native registry requires SOULFORGE_NATIVE_FIXTURE_ROOT.');
    }
    const { resolveNativeFixture } = await import('../packages/core/dist/testing/nativeFixtureRegistry.js');
    try { path = await resolveNativeFixture(undefined, role, fixture.relativePath); }
    catch (error) {
      // The shared fixture resolver exposes its structured code as a message
      // prefix. Preserve it in this script's JSON report without changing it.
      const code = /^([A-Z][A-Z0-9_]+):/u.exec(error.message)?.[1];
      if (code) error.code = code;
      throw error;
    }
  } else {
    path = await realpath(resolve(root, fixture.relativePath));
  }
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw validationError('NATIVE_FIXTURE_OUTSIDE_ROOT', 'Pinned Lua input escaped its configured root.');
  }
  return { path, fixture, selection: registry ? 'registered-pinned-corpus' : 'pinned-corpus' };
}

export async function runNativeLuabndValidation(explicitPath) {
  const selected = await selectNativeLuabndInput(explicitPath);
  const bytes = await readInput(selected.path);
  const sourceHash = sha256(bytes);
  if (selected.fixture && (bytes.length !== selected.fixture.byteLength || sourceHash !== selected.fixture.sha256)) {
    throw validationError('FIXED_CORPUS_HASH_MISMATCH', 'Lua input differs from the pinned correctness corpus.');
  }
  // Never select an arbitrary binary or an implicit dotnet rebuild. The same
  // production receipt used by the app must match the current Bridge inputs.
  const buildOptions = { runtimeIdentifier: process.platform === 'linux' ? 'linux-x64' : 'win-x64' };
  const fresh = await assertBridgeProductionBuildFresh(repoRoot, buildOptions);
  const bridgeExecutablePath = join(repoRoot, bridgeBuildTarget(buildOptions).executable);
  const { createBridgeDaemonScope } = await import('../packages/core/dist/bridge/runBridge.js');
  const owned = await createOwnedTemporaryDirectory('native-luabnd-validation');
  const scope = createBridgeDaemonScope();
  try {
    const inputRoot = join(owned.root, 'input');
    const stageRoot = join(owned.root, 'staging');
    await mkdir(inputRoot);
    await mkdir(stageRoot);
    const source = join(inputRoot, 'original.luabnd.dcx');
    await writeFile(source, bytes, { flag: 'wx' });
    const run = (command, filePath = source, commandOptions) => scope.run({
      bridgeExecutablePath, command, filePath,
      allowedRoots: [inputRoot, stageRoot], writableRoots: [stageRoot],
      commandOptions, timeoutMs: 120_000, maxFrameBytes: 32 * 1024 * 1024,
      ...(process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
        ? { oodleRuntimeRoot: process.env.SOULFORGE_SEKIRO_GAME_ROOT.trim() } : {})
    });
    const document = requireData(await run('read-luabnd-document'), 'read-luabnd-document');
    assert.equal(document.format, 'LUABND');
    assert.equal(document.sourceHash, sourceHash);
    assert.equal(document.scriptCount, document.scripts.length);
    assert.ok(document.scriptCount > 0);
    if (selected.fixture) {
      assert.equal(document.entryCount, selected.fixture.expected.entryCount);
      assert.equal(document.scriptCount, selected.fixture.expected.luaEntryCount);
      // Retain the existing independent observations for this exact pinned
      // aicommon hash; arbitrary explicit inputs do not inherit these counts.
      assert.equal(document.hasLuagnl, true);
      assert.equal(document.hasLuainfo, true);
      assert.equal(document.luagnl.symbolCount, 1739);
      assert.equal(document.luagnl.symbolsSample[0], 'GOAL_COMMON_TopGoal');
      assert.equal(document.luainfo.goalCount, 96);
      assert.equal(document.luainfo.goalsSample[0].goalId, 2000);
      assert.equal(document.luainfo.goalsSample[0].name, 'Wait');
    }
    assert.equal(document.roundTrip?.byteIdentical, true);
    assert.equal(document.layoutGuard?.acceptsNoOp, true);
    requirePreservation(document.fieldPreservation);
    const baseline = requireData(await run('read-dcx-document'), 'read-dcx-document', ['ok', 'partial']);
    assert.equal(baseline.sourceHash, sourceHash);
    assert.equal(baseline.nested?.entryCount, document.entryCount);
    assert.equal(baseline.nested?.entries.length, document.entryCount);
    requirePreservation(baseline.nested.fieldPreservation);

    // Every script is read with both source and child CAS hashes. Bytecode is
    // inspected and preserved as bytes; only a plaintext entry is modified.
    let target;
    for (const script of document.scripts) {
      const detail = requireData(await run('read-luabnd-script', source, {
        entryIndex: script.index, expectedContainerHash: sourceHash, expectedChildHash: script.contentHash
      }), 'read-luabnd-script');
      assert.equal(detail.contentHash, script.contentHash);
      assert.equal(sha256(Buffer.from(detail.contentBase64, 'base64')), script.contentHash);
      assert.equal(detail.isBytecode, script.isBytecode);
      if (selected.fixture && script.sanitizedName === '000110_platoon.lua') {
        assert.equal(detail.isBytecode, true);
        assert.equal(detail.isPlainText, false);
        assert.equal(detail.magic, '\\x1bLuaP');
        assert.ok(detail.variant.includes('Havok Script / Sekiro variant'));
        assert.ok(detail.embeddedSymbols.includes('Platoon000110_Activate'));
        assert.ok(detail.embeddedSymbols.includes('SetEnablePlatoonMove'));
        assert.ok(detail.textPreview.includes('SoulForge Lua Bytecode Preview'));
      }
      if (selected.fixture && script.sanitizedName === 'goal_list.lua') {
        assert.equal(detail.isPlainText, true);
        assert.ok(detail.textContent.includes('GOAL_COMMON_TopGoal = 0'));
        assert.ok(detail.lineCount > 100);
      }
      if (!target && detail.isPlainText && Buffer.from(detail.contentBase64, 'base64').some(byte => byte >= 65 && byte <= 90)) target = detail;
    }
    if (!target) throw validationError('LUABND_PLAINTEXT_INPUT_UNAVAILABLE', 'A plaintext Lua script is required for the scoped staged write check.', 'unavailable');
    const replacement = Buffer.from(target.contentBase64, 'base64');
    const position = replacement.findIndex(byte => byte >= 65 && byte <= 90);
    replacement[position] += 32; // same-size owned test mutation
    const mutation = { entryIndex: target.index, expectedContainerHash: sourceHash,
      expectedChildHash: target.contentHash, contentBase64: replacement.toString('base64') };

    const blockedOutput = join(inputRoot, 'forbidden-output.luabnd.dcx');
    const outputBoundary = requireFailure(await run('write-luabnd-script', source, {
      ...mutation, outputPath: blockedOutput
    }), 'BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS');
    assert.equal(existsSync(blockedOutput), false);
    const containerHash = requireFailure(await run('read-luabnd-script', source, {
      entryIndex: target.index, expectedContainerHash: '0'.repeat(64)
    }), 'LUABND_CONTAINER_HASH_MISMATCH');
    const childHash = requireFailure(await run('read-luabnd-script', source, {
      entryIndex: target.index, expectedContainerHash: sourceHash, expectedChildHash: '0'.repeat(64)
    }), 'LUABND_CHILD_HASH_MISMATCH');
    const missingScript = requireFailure(await run('read-luabnd-script', source, {
      childPath: `__missing_${randomUUID()}.lua`
    }), 'LUABND_SCRIPT_READ_FAILED');

    const exportDirectory = join(stageRoot, 'export');
    const exported = requireData(await run('export-luabnd', source, {
      outputPath: exportDirectory, includeMetadataJson: true
    }), 'export-luabnd');
    assert.equal(exported.scriptCount, document.scriptCount);
    for (const file of exported.files) {
      const rel = relative(exportDirectory, file.path);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Export escaped owned staging.');
      const content = await readFile(file.path);
      if (file.hash) assert.equal(sha256(content), file.hash);
    }
    for (const script of document.scripts) {
      assert.equal(sha256(await readFile(join(exportDirectory, script.sanitizedName))), script.contentHash);
    }
    const manifest = JSON.parse((await readFile(join(exportDirectory, 'luabnd.manifest.json'), 'utf8')).replace(/^\uFEFF/u, ''));
    assert.equal(manifest.sourceHash, sourceHash);
    assert.equal(manifest.totalEntries, document.entryCount);
    assert.equal(manifest.scriptCount, document.scriptCount);
    for (const [metadata, filename, key] of [[document.luagnl, 'luagnl.symbols.json', 'symbolCount'],
      [document.luainfo, 'luainfo.goals.json', 'goalCount']]) {
      if (!metadata) continue;
      const json = JSON.parse((await readFile(join(exportDirectory, filename), 'utf8')).replace(/^\uFEFF/u, ''));
      assert.equal(json[key], metadata[key]);
    }

    const outputPath = join(stageRoot, 'modified.luabnd.dcx');
    const written = await run('write-luabnd-script', source, { ...mutation, outputPath });
    const proof = requireData(written, 'write-luabnd-script', ['partial']);
    assert.ok(written.diagnostics.some(item => item.code === 'BND4_STAGING_WRITE_VERIFIED'));
    assert.equal(proof.rereadVerified, true);
    const preservation = proof.bndWriteResult?.preservation;
    assert.equal(proof.bndWriteResult?.rereadVerified, true);
    assert.equal(preservation?.allPreserved, true);
    assert.equal(preservation.matchedEntryCount, document.entryCount);
    assert.equal(preservation.headerFieldsPreservedCount, document.entryCount);
    assert.equal(preservation.storedBytesCheckedCount, document.entryCount - 1);
    assert.equal(preservation.storedBytesPreservedCount, document.entryCount - 1);
    requirePreservation(proof.bndWriteResult.fieldPreservation);
    const outputHash = sha256(await readInput(outputPath));
    assert.notEqual(outputHash, sourceHash);
    const reread = requireData(await run('read-luabnd-script', outputPath, {
      entryIndex: target.index, expectedContainerHash: outputHash,
      expectedChildHash: sha256(replacement)
    }), 'read-luabnd-script');
    assert.deepEqual(Buffer.from(reread.contentBase64, 'base64'), replacement);
    const after = requireData(await run('read-dcx-document', outputPath), 'read-dcx-document', ['ok', 'partial']);
    assert.equal(after.sourceHash, outputHash);
    assert.equal(after.nested.entryCount, baseline.nested.entryCount);
    requirePreservation(after.nested.fieldPreservation);
    for (const entry of baseline.nested.entries) {
      const next = after.nested.entries[entry.index];
      assert.equal(next.index, entry.index);
      assert.equal(next.id, entry.id);
      assert.equal(next.name, entry.name);
      assert.equal(next.flags, entry.flags);
      assert.equal(next.unknown, entry.unknown);
      assert.equal(next.compressedSize, entry.compressedSize);
      assert.equal(next.uncompressedSize, entry.uncompressedSize);
      if (entry.index !== target.index) assert.equal(next.contentHash, entry.contentHash);
    }
    assert.equal(sha256(await readInput(source)), sourceHash);
    assert.equal(sha256(await readInput(selected.path)), sourceHash);
    return { ok: true, status: 'passed', scope: 'single-source Lua binder read/export/staged-write/readback',
      selection: selected.selection, sourceHash, outputHash,
      bridgeSourceHash: fresh.current.source.sha256, bridgeExecutableHash: fresh.current.executable.sha256,
      entryCount: document.entryCount, scriptCount: document.scriptCount,
      symbolCount: document.luagnl?.symbolCount ?? null, goalCount: document.luainfo?.goalCount ?? null,
      compression: document.dcxCompression, unchangedEntriesVerified: document.entryCount - 1,
      sourceUnchanged: true, stagedWriteVerified: true, nativeWriterPreservationVerified: true,
      exportVerified: true, unknownFieldsPreserved: true,
      negativeControls: { outputBoundary, containerHash, childHash, missingScript },
      fullCorpusAcceptance: false,
      notRun: ['other Lua binders', ...(document.dcxCompression !== 'KRAK' ? ['KRAK/Oodle corpus'] : []), 'Patch Engine commit/rollback', 'game execution'] };
  } finally {
    // Drain our daemon before deleting its source/stage root, including failures.
    try { await scope.dispose(); } finally { await owned.dispose(); }
  }
}

function requireData(result, command, statuses = ['ok']) {
  if (!statuses.includes(result.parseStatus) || !result.data || result.diagnostics?.some(item => item.severity === 'error')) {
    const diagnostic = result.diagnostics?.find(item => item.severity === 'error') ?? result.diagnostics?.[0];
    throw validationError(diagnostic?.code ?? 'LUABND_BRIDGE_PROOF_MISSING',
      `${command}: ${diagnostic?.message ?? 'Native result/proof missing.'}`,
      diagnostic?.code === 'LUABND_KRAK_OODLE_UNAVAILABLE' ? 'unavailable' : 'failed');
  }
  return result.data;
}

function requireFailure(result, code) {
  assert.equal(result.parseStatus, 'failed');
  assert.ok(result.diagnostics.some(item => item.code === code), `Expected ${code}, got ${JSON.stringify(result.diagnostics)}`);
  return code;
}

function requirePreservation(preservation) {
  for (const key of ['headerUnknownBytesPreserved', 'entryHeaderFieldsPreserved', 'storedBytesPreserved', 'namesPreserved']) {
    assert.equal(preservation?.[key], true, `Native field preservation missing: ${key}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/verify-native-luabnd.mjs [input.luabnd.dcx]\n'
      + 'Input: SOULFORGE_LUABND_PATH, or SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT\n'
      + 'with the pinned corpus and optional SOULFORGE_NATIVE_FIXTURE_REGISTRY. Writes use owned staging.');
    return;
  }
  try {
    if (args.length > 1 || args[0]?.startsWith('--')) throw validationError('LUABND_VALIDATION_USAGE', 'Expected one optional Lua input path.');
    const report = await runNativeLuabndValidation(args[0]);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code);
    console.error(JSON.stringify({ ok: false, status: missing ? 'unavailable' : error.status ?? 'failed',
      code: missing ? 'LUABND_INPUT_UNAVAILABLE' : error.code ?? 'LUABND_VALIDATION_FAILED',
      message: error.message, fullCorpusAcceptance: false }, null, 2));
    process.exitCode = missing || error.status === 'unavailable' ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
