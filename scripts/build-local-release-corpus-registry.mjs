import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseCorpusRegistry } from '../packages/core/dist/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRegistryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
const fixtureRootInput = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
if (!fixtureRegistryPath || !fixtureRootInput || !gameRoot) {
  fail('LOCAL_RELEASE_CORPUS_INPUT_MISSING', 'Local native registry, fixture root, and Sekiro root are required.');
}

const bridgeExecutable = resolve(
  repositoryRoot,
  'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
);
const [fixtureRoot, registryText] = await Promise.all([
  realpath(resolve(fixtureRootInput)),
  readFile(resolve(fixtureRegistryPath), 'utf8')
]);
let fixtureRegistry;
try {
  fixtureRegistry = JSON.parse(registryText);
} catch {
  fail('LOCAL_RELEASE_CORPUS_REGISTRY_INVALID', 'Local native registry is not valid JSON.');
}
if (fixtureRegistry?.schemaVersion !== '1.0.0' || !Array.isArray(fixtureRegistry.fixtures)) {
  fail('LOCAL_RELEASE_CORPUS_REGISTRY_INVALID', 'Local native registry schema is unsupported.');
}

const registeredHashes = await buildRegisteredHashIndex(fixtureRegistry.fixtures, fixtureRoot);
const dcxFiles = await walkDcx(fixtureRoot);
if (dcxFiles.length === 0) {
  fail('LOCAL_RELEASE_CORPUS_EMPTY', 'No DCX files were found under the registered corpus root.');
}

const entriesByHash = new Map();
const observations = {
  filesClassified: 0,
  duplicateContentFiles: 0,
  dfltRoundTrips: 0,
  bnd4RoundTrips: 0,
  bnd4Entries: 0,
  krakReads: 0,
  nestedEntryExtensionCounts: {},
  resourceKindCounts: {}
};
for (const path of dcxFiles) {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    fail('LOCAL_RELEASE_CORPUS_FILE_INVALID', 'A corpus entry is not a readable file.');
  }
  const actualHash = await sha256File(path);
  const registeredHash = registeredHashes.get(path.toLowerCase());
  if (registeredHash && actualHash !== registeredHash) {
    fail('LOCAL_RELEASE_CORPUS_HASH_MISMATCH', 'A registered corpus entry hash does not match its local registry.');
  }
  const document = inspectDcx(path, gameRoot);
  let format;
  let observedVariant;
  if (document.compressionFormat === 'KRAK') {
    assertKrak(document);
    format = 'KRAK';
    observedVariant = `DCX_${document.variant}`;
    observations.krakReads += 1;
  } else {
    assertDflt(document);
    observations.dfltRoundTrips += 1;
    if (document.nested?.format === 'BND4') {
      assertBnd4(document);
      format = 'BND4';
      observedVariant = 'BND4_40_24';
      observations.bnd4RoundTrips += 1;
      observations.bnd4Entries += document.nested.entryCount;
      countNestedEntryExtensions(document.nested.entries, observations.nestedEntryExtensionCounts);
    } else {
      format = 'DFLT';
      observedVariant = `DCX_${document.variant}`;
    }
  }
  observations.filesClassified += 1;
  const relativePath = relative(fixtureRoot, path).replaceAll('\\', '/');
  const observed = {
    size: fileStat.size,
    sha256: actualHash,
    privateUserMod: relativePath.toLowerCase().startsWith('mods/'),
    resourceKind: classifyResourceKind(relativePath, document)
  };
  const existing = entriesByHash.get(actualHash);
  if (existing) {
    if (existing.format !== format || existing.observedVariant !== observedVariant) {
      fail('LOCAL_RELEASE_CORPUS_DUPLICATE_CLASSIFICATION_CONFLICT', 'Duplicate corpus content received conflicting classifications.');
    }
    observations.duplicateContentFiles += 1;
    continue;
  }
  entriesByHash.set(actualHash, releaseEntry(format, observed, observedVariant));
}

const entries = [...entriesByHash.values()]
  .sort((left, right) => left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0);
for (const entry of entries) increment(observations.resourceKindCounts, entry.resourceKind);

const registry = {
  registryId: 'sekiro-1-6-owner-corpus-v1',
  game: 'sekiro',
  gameBuild: '1.6',
  schemaVersion: '1.0.0',
  createdAt: new Date().toISOString(),
  entryCount: entries.length,
  entries
};
const validation = validateReleaseCorpusRegistry(registry);
if (!validation.ok) {
  fail(
    'LOCAL_RELEASE_CORPUS_SCHEMA_REJECTED',
    `Generated registry was rejected: ${validation.diagnostics.map((item) => item.code).join(',')}.`
  );
}

const localAppData = process.env.LOCALAPPDATA?.trim();
if (!localAppData) fail('LOCAL_RELEASE_CORPUS_OUTPUT_ROOT_MISSING', 'LOCALAPPDATA is required.');
const outputDirectory = resolve(localAppData, 'SoulForge', 'corpus-registries', 'v0.5');
const outputPath = join(outputDirectory, 'sekiro-1.6.release-corpus.json');
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(validation.registry, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'w'
});

console.log(JSON.stringify({
  ok: true,
  status: 'schema-valid',
  nativeFormatAuthority: false,
  registryId: validation.registry.registryId,
  gameBuild: validation.registry.gameBuild,
  entryCount: validation.registry.entryCount,
  classification: validation.classification,
  nativeObservations: {
    ...observations,
    uniqueContentEntries: entries.length,
    krakRepackAuthority: false
  },
  output: 'local-app-data/corpus-registries/v0.5/sekiro-1.6.release-corpus.json',
  nonClaims: [
    'Registry schema validity does not grant native format authority.',
    'KRAK repack/write remains unverified.',
    'The source assets and local locator registry remain outside Git.'
  ]
}, null, 2));

async function buildRegisteredHashIndex(fixtures, root) {
  const index = new Map();
  for (const entry of fixtures) {
    if (entry.game !== 'sekiro'
      || typeof entry.localPath !== 'string' || entry.localPath.trim() === ''
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      fail('LOCAL_RELEASE_CORPUS_ENTRY_INVALID', 'A local registry entry is invalid.');
    }
    const candidate = isAbsolute(entry.localPath)
      ? resolve(entry.localPath)
      : resolve(root, entry.localPath);
    const path = await realpath(candidate);
    const relativePath = relative(root, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      fail('LOCAL_RELEASE_CORPUS_BOUNDARY_VIOLATION', 'A local corpus entry escaped the registered root.');
    }
    const key = path.toLowerCase();
    const digest = entry.sha256.toLowerCase();
    if (index.has(key) && index.get(key) !== digest) {
      fail('LOCAL_RELEASE_CORPUS_HASH_CONFLICT', 'Local registry assigns conflicting hashes to one entry.');
    }
    index.set(key, digest);
  }
  return index;
}

async function walkDcx(directory) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail('LOCAL_RELEASE_CORPUS_SYMLINK_FORBIDDEN', 'Corpus scan encountered a symbolic link.');
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkDcx(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcx')) output.push(path);
  }
  return output;
}

function inspectDcx(path, configuredGameRoot) {
  const result = spawnSync(bridgeExecutable, ['read-dcx-document', path], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, SOULFORGE_SEKIRO_GAME_ROOT: configuredGameRoot }
  });
  if (result.error) fail('LOCAL_RELEASE_CORPUS_BRIDGE_FAILED', 'Bridge DCX inspection could not start.');
  if (result.status !== 0) fail('LOCAL_RELEASE_CORPUS_BRIDGE_FAILED', 'Bridge DCX inspection failed.');
  try {
    const envelope = JSON.parse(result.stdout);
    if (envelope.parseStatus === 'failed' || envelope.data?.format !== 'DCX') {
      fail('LOCAL_RELEASE_CORPUS_BRIDGE_REJECTED', 'Bridge rejected a registered DCX document.');
    }
    return envelope.data;
  } catch (error) {
    if (error?.code?.startsWith?.('LOCAL_RELEASE_CORPUS_')) throw error;
    fail('LOCAL_RELEASE_CORPUS_BRIDGE_RESPONSE_INVALID', 'Bridge returned an invalid DCX response.');
  }
}

function assertDflt(document) {
  if (document.compressionFormat !== 'DFLT'
    || typeof document.variant !== 'string'
    || document.roundTrip?.payloadIdentical !== true
    || document.roundTrip?.variantIdentical !== true) {
    fail('LOCAL_RELEASE_CORPUS_DFLT_UNVERIFIED', 'Registered DFLT document failed its read/round-trip assertions.');
  }
}

function assertBnd4(document) {
  if (document.compressionFormat !== 'DFLT'
    || document.nested?.format !== 'BND4'
    || document.nested?.fileHeaderSize !== 0x24
    || document.nested?.roundTrip?.entriesIdentical !== true
    || document.nested?.crud?.allPassed !== true) {
    fail('LOCAL_RELEASE_CORPUS_BND4_UNVERIFIED', 'Registered BND4 document failed its nested assertions.');
  }
}

function assertKrak(document) {
  if (document.compressionFormat !== 'KRAK'
    || typeof document.variant !== 'string'
    || typeof document.payloadHash !== 'string'
    || document.payloadHash.length !== 64) {
    fail('LOCAL_RELEASE_CORPUS_KRAK_UNVERIFIED', 'Registered KRAK document failed its legal-runtime read assertion.');
  }
}

function releaseEntry(format, observed, observedVariant) {
  const id = format.toLowerCase();
  const opaqueId = observed.sha256.slice(0, 24);
  return {
    logicalId: `sekiro-${id}-${opaqueId}`,
    sha256: observed.sha256,
    size: observed.size,
    containerChain: [`corpus/${id}/${opaqueId}`],
    resourceKind: observed.resourceKind,
    format,
    observedVariant,
    permittedOperations: [
      'classify',
      'read',
      'no-op-roundtrip',
      'mutate',
      'repack',
      'reread',
      'preserve-unknown-fields'
    ],
    expectedAuthority: 'native-verified',
    privacyClass: observed.privateUserMod
      ? 'private-user-mod'
      : 'private-game-asset'
  };
}

function classifyResourceKind(relativePath, document) {
  const normalized = relativePath.toLowerCase().replaceAll('\\', '/');
  const nestedNames = Array.isArray(document.nested?.entries)
    ? document.nested.entries
      .map((entry) => typeof entry.name === 'string' ? entry.name.toLowerCase() : '')
    : [];
  const contains = (suffix) => nestedNames.some((name) => name.endsWith(suffix));
  if (normalized.includes('/event/') || normalized.includes('.emevd')) return 'event';
  if (normalized.includes('/map/') || normalized.includes('.msb')) return 'map';
  if (normalized.includes('/param/') || normalized.includes('gameparam')) return 'param';
  if (normalized.includes('/msg/') || normalized.includes('.msgbnd')) return 'msg';
  if (normalized.includes('/menu/')) return 'menu';
  if (normalized.includes('/script/') || normalized.endsWith('.lua') || normalized.endsWith('.hks')) return 'script';
  if (normalized.includes('.anibnd') || contains('.tae')) return 'action';
  if (normalized.includes('.behbnd') || contains('.esd')) return 'ai';
  if (normalized.includes('/sfx/') || normalized.includes('.ffxbnd') || contains('.tpf')) return 'sfx';
  if (normalized.includes('/chr/') || normalized.includes('.chrbnd') || contains('.flver')) return 'chr';
  if (normalized.includes('/obj/') || normalized.includes('.objbnd')) return 'obj';
  return 'other';
}

function countNestedEntryExtensions(entries, counts) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (typeof entry.name !== 'string') continue;
    const match = /\.[a-z0-9_]{1,16}$/i.exec(entry.name);
    if (match) increment(counts, match[0].toLowerCase());
  }
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message }, null, 2));
  const error = new Error(message);
  error.code = code;
  throw error;
}
