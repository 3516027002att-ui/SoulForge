import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  RELEASE_MANIFEST_RELATIVE_PATH,
  auditPackageTree,
  auditReleaseCompliance,
  createReleaseComplianceManifest,
  listAsarEntries,
  serializeReleaseManifest
} from './release-compliance-lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'soulforge-release-compliance-'));
try {
const policy = {
  schemaVersion: 1,
  target: 'win-x64',
  allowedLicenseExpressions: ['MIT'],
  artifactInputs: [
    { kind: 'directory', source: 'apps/desktop/out', target: 'out', exclude: ['release-compliance.json'] },
    { kind: 'file', source: 'apps/desktop/package.json', target: 'package.json' },
    { kind: 'file', source: 'apps/desktop/.native/better_sqlite3.node', target: 'native/better_sqlite3.node' },
    { kind: 'file', source: 'apps/desktop/.native/better_sqlite3.json', target: 'native/better_sqlite3.json' }
  ]
};

await write('package.json', JSON.stringify({
  name: 'fixture',
  version: '1.0.0',
  workspaces: ['packages/*']
}));
const validPackageLock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/good': { version: '1.2.3', license: 'MIT', integrity: 'sha512-fixture' },
    'node_modules/@soulforge/external': { version: '4.5.6', license: 'MIT', integrity: 'sha512-scoped-fixture' },
    'node_modules/@soulforge/workspace-link': { resolved: 'packages/workspace-link', link: true },
    'packages/workspace-link': { name: '@soulforge/workspace-link', version: '1.0.0' }
  }
};
await write('package-lock.json', JSON.stringify(validPackageLock));
await write('packages/workspace-link/package.json', JSON.stringify({
  name: '@soulforge/workspace-link',
  version: '1.0.0',
  private: true
}));
await write('node_modules/good/LICENSE', 'MIT fixture license\n');
await write('node_modules/@soulforge/external/LICENSE', 'MIT scoped fixture license\n');
await write('apps/desktop/package.json', JSON.stringify({ name: '@fixture/desktop', version: '1.0.0' }));
await write('apps/desktop/out/main/index.js', 'console.log("fixture");\n');
await write('apps/desktop/.native/better_sqlite3.node', 'synthetic-native-binding');
await write('apps/desktop/.native/better_sqlite3.json', '{"fixture":true}\n');
await write('README.md', 'fixture repository\n');

const first = await createReleaseComplianceManifest(root, policy);
assert(
  first.licenses.packages.some((item) => item.name === '@soulforge/external'),
  'non-link @soulforge package must remain in the production inventory'
);
assert(
  !first.licenses.packages.some((item) => item.name === '@soulforge/workspace-link'),
  'only an explicit link:true workspace package may be excluded from the production inventory'
);
await write('vendor/external-link/package.json', JSON.stringify({
  name: 'external-link',
  version: '9.9.9',
  license: 'GPL-3.0-only'
}));
await write('package-lock.json', JSON.stringify({
  ...validPackageLock,
  packages: {
    ...validPackageLock.packages,
    'node_modules/external-link': { resolved: 'vendor/external-link', link: true },
    'vendor/external-link': { name: 'external-link', version: '9.9.9', license: 'GPL-3.0-only' }
  }
}));
const externalLink = await createReleaseComplianceManifest(root, policy);
assert(
  hasDiagnostic(externalLink, 'DEPENDENCY_LINK_OUTSIDE_WORKSPACE'),
  'a production link outside declared repository workspaces must fail closed'
);
await write('package-lock.json', JSON.stringify({ ...validPackageLock, lockfileVersion: 2 }));
const lockfileV2 = await createReleaseComplianceManifest(root, policy);
assert(
  !hasDiagnostic(lockfileV2, 'PACKAGE_LOCK_VERSION_UNSUPPORTED')
    && lockfileV2.licenses.packageCount === first.licenses.packageCount,
  'lockfileVersion 2 must produce the same validated production inventory'
);
await write('package-lock.json', JSON.stringify(validPackageLock));
await write(RELEASE_MANIFEST_RELATIVE_PATH, serializeReleaseManifest(first));
const clean = await auditReleaseCompliance({ root, policy, trackedPaths: ['README.md'] });
assert(clean.ok, `clean fixture failed: ${JSON.stringify(clean.findings)}`);

for (const falsyManifest of [null, false, 0, '']) {
  await write(RELEASE_MANIFEST_RELATIVE_PATH, `${JSON.stringify(falsyManifest)}\n`);
  const falsyAudit = await auditReleaseCompliance({ root, policy, trackedPaths: ['README.md'] });
  assert(
    hasCode(falsyAudit, 'RELEASE_MANIFEST_STALE'),
    `valid falsy manifest JSON must fail stale: ${JSON.stringify(falsyManifest)}`
  );
}
await write(RELEASE_MANIFEST_RELATIVE_PATH, serializeReleaseManifest(first));

const artifactPath = join(root, 'apps/desktop/out/main/index.js');
await utimes(artifactPath, new Date(1000), new Date(2000));
const timestampOnly = await createReleaseComplianceManifest(root, policy);
assert(
  timestampOnly.artifacts.aggregateSha256 === first.artifacts.aggregateSha256,
  'mtime-only change must not alter build fingerprint'
);

await write('apps/desktop/out/main/index.js', 'console.log("tampered");\n');
const stale = await auditReleaseCompliance({ root, policy, trackedPaths: ['README.md'] });
assert(hasCode(stale, 'RELEASE_MANIFEST_STALE'), 'artifact mutation must stale the manifest');

await write('package-lock.json', JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/bad': { version: '9.9.9', license: 'GPL-3.0-only', integrity: 'sha512-bad' }
  }
}));
const disallowed = await createReleaseComplianceManifest(root, policy);
assert(
  disallowed.diagnostics.some((item) => item.code === 'DEPENDENCY_LICENSE_NOT_ALLOWED'),
  'disallowed license must fail closed'
);

await write('package-lock.json', JSON.stringify({ lockfileVersion: 1, packages: null }));
const malformedLock = await createReleaseComplianceManifest(root, policy);
assert(
  hasDiagnostic(malformedLock, 'PACKAGE_LOCK_VERSION_UNSUPPORTED'),
  'unsupported lockfileVersion must fail closed'
);
assert(
  hasDiagnostic(malformedLock, 'PACKAGE_LOCK_PACKAGES_MISSING'),
  'missing lockfile packages map must fail closed'
);

await write('package-lock.json', JSON.stringify({
  lockfileVersion: 3,
  packages: { '': { name: 'fixture', version: '1.0.0' } }
}));
const emptyInventory = await createReleaseComplianceManifest(root, policy);
assert(
  hasDiagnostic(emptyInventory, 'PRODUCTION_DEPENDENCY_INVENTORY_EMPTY'),
  'empty production inventory must fail closed'
);
await write('package-lock.json', JSON.stringify(validPackageLock));

await write('private/id_rsa', 'synthetic key file name only');
const secretPath = await auditReleaseCompliance({ root, policy, trackedPaths: ['private/id_rsa'] });
assert(hasCode(secretPath, 'CREDENTIAL_FILE_FORBIDDEN'), 'credential filename must fail closed');
const syntheticKey = `sk-${'A'.repeat(40)}`;
await write('src/leaked-token.txt', syntheticKey);
const secretContent = await auditReleaseCompliance({ root, policy, trackedPaths: ['src/leaked-token.txt'] });
assert(
  hasCode(secretContent, 'OPENAI_KEY_CONTENT'),
  'credential content must fail closed'
);

await write(
  'src/large-leaked-token.txt',
  Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 17, 0x78), Buffer.from(`\n${syntheticKey}\n`, 'utf8')])
);
const largeSecretContent = await auditReleaseCompliance({
  root,
  policy,
  trackedPaths: ['src/large-leaked-token.txt']
});
assert(
  hasCode(largeSecretContent, 'OPENAI_KEY_CONTENT'),
  'credential content beyond 2 MiB must fail closed'
);

await write('src/utf16le-leaked-token.txt', Buffer.from(`before\n${syntheticKey}\nafter`, 'utf16le'));
const utf16LeSecretContent = await auditReleaseCompliance({
  root,
  policy,
  trackedPaths: ['src/utf16le-leaked-token.txt']
});
assert(
  hasCode(utf16LeSecretContent, 'OPENAI_KEY_CONTENT'),
  'UTF-16LE credential content must fail closed'
);

await write('src/utf16be-leaked-token.txt', encodeUtf16Be(`before\n${syntheticKey}\nafter`));
const utf16BeSecretContent = await auditReleaseCompliance({
  root,
  policy,
  trackedPaths: ['src/utf16be-leaked-token.txt']
});
assert(
  hasCode(utf16BeSecretContent, 'OPENAI_KEY_CONTENT'),
  'UTF-16BE credential content must fail closed'
);

const unsafePathPolicy = {
  ...policy,
  artifactInputs: [
    ...policy.artifactInputs,
    { kind: 'file', source: '../outside.txt', target: 'safe/outside.txt' },
    { kind: 'file', source: 'README.md', target: '../escaped.txt' }
  ]
};
const unsafePaths = await createReleaseComplianceManifest(root, unsafePathPolicy);
assert(
  hasDiagnostic(unsafePaths, 'RELEASE_ARTIFACT_SOURCE_PATH_INVALID'),
  'artifact source traversal must fail closed'
);
assert(
  hasDiagnostic(unsafePaths, 'RELEASE_ARTIFACT_TARGET_PATH_INVALID'),
  'artifact target traversal must fail closed'
);

const conflictingTargetPolicy = {
  ...policy,
  artifactInputs: [
    ...policy.artifactInputs,
    { kind: 'file', source: 'README.md', target: 'collision/FILE.txt' },
    { kind: 'file', source: 'package.json', target: 'Collision/file.TXT' }
  ]
};
const conflictingTargets = await createReleaseComplianceManifest(root, conflictingTargetPolicy);
assert(
  hasDiagnostic(conflictingTargets, 'RELEASE_ARTIFACT_TARGET_CONFLICT'),
  'Windows case-insensitive artifact target collisions must fail closed'
);

const forbiddenTargetPolicy = {
  ...policy,
  artifactInputs: [
    ...policy.artifactInputs,
    { kind: 'file', source: 'README.md', target: 'config/.env' }
  ]
};
const forbiddenTargetManifest = await createReleaseComplianceManifest(root, forbiddenTargetPolicy);
assert(
  hasDiagnostic(forbiddenTargetManifest, 'CREDENTIAL_FILE_FORBIDDEN'),
  'manifest generation must reject a forbidden packaged target path'
);
await write(RELEASE_MANIFEST_RELATIVE_PATH, serializeReleaseManifest(forbiddenTargetManifest));
const forbiddenTarget = await auditReleaseCompliance({ root, policy: forbiddenTargetPolicy, trackedPaths: [] });
assert(
  hasCode(forbiddenTarget, 'CREDENTIAL_FILE_FORBIDDEN'),
  'forbidden packaged target path must fail closed even when its source path is benign'
);

const reservedTargetPolicy = {
  ...policy,
  artifactInputs: [
    ...policy.artifactInputs,
    { kind: 'file', source: 'README.md', target: 'devices/CON.txt' }
  ]
};
const reservedTarget = await createReleaseComplianceManifest(root, reservedTargetPolicy);
assert(
  reservedTarget.diagnostics.some((item) => (
    item.code === 'RELEASE_ARTIFACT_TARGET_PATH_INVALID' && item.path === 'devices/CON.txt'
  )),
  'Windows reserved device artifact target must fail closed'
);

// --- Package tree fixtures ---
const optionalPlatformLock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/@esbuild/win32-x64': {
      version: '0.25.0',
      license: 'MIT',
      optional: true,
      integrity: 'sha512-optional-platform'
    },
    'node_modules/@soulforge/core': { version: '1.0.0', license: 'MIT', integrity: 'sha512-core' }
  }
};
await write('package-lock.json', JSON.stringify(optionalPlatformLock));

await mkdir('apps/desktop/release/win-unpacked/resources', { recursive: true });
await mkdir('apps/desktop/release/win-unpacked/resources/native', { recursive: true });
await mkdir('apps/desktop/release/win-unpacked/locales', { recursive: true });

const cleanAsar = buildSyntheticAsar({
  files: {
    'out/main/index.js': { size: 10, offset: '0' },
    'package.json': { size: 5, offset: '0' }
  }
});
const optionalAsar = buildSyntheticAsar({
  files: {
    'out/main/index.js': { size: 10, offset: '0' },
    'node_modules/@esbuild/win32-x64/package.json': { size: 20, offset: '0' }
  }
});
for (const path of [
  'SoulForge.exe',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'resources.pak',
  'icudtl.dat',
  'ffmpeg.dll',
  'v8_context_snapshot.bin',
  'snapshot_blob.bin',
  'LICENSE.electron.txt',
  'resources/elevate.exe',
  'locales/en-US.pak'
]) {
  await write(`apps/desktop/release/win-unpacked/${path}`, `synthetic ${path}\n`);
}
await write('apps/desktop/release/win-unpacked/resources/native/better_sqlite3.node', 'synthetic-binding');
await write('apps/desktop/release/win-unpacked/resources/native/better_sqlite3.json', '{"fixture":true}\n');
await write('apps/desktop/release/win-unpacked/resources/app.asar', cleanAsar);

const asarEntries = listAsarEntries(resolve(root, 'apps/desktop/release/win-unpacked/resources/app.asar'));
assert(
  asarEntries.includes('out/main/index.js') && asarEntries.includes('package.json'),
  'listAsarEntries must return asar file entries'
);
let asarHeaderThrew = false;
try {
  listAsarEntries(join(root, 'package-lock.json'));
} catch {
  asarHeaderThrew = true;
}
assert(asarHeaderThrew, 'a non-asar file must fail asar header parsing');
const cleanTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/win-unpacked',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
assert(cleanTree.ok, `clean package tree must pass: ${JSON.stringify(cleanTree.diagnostics)}`);
assert(cleanTree.asarEntryCount === 2, 'clean asar entry count must match');
assert(cleanTree.status === 'passed', 'clean package tree status must be passed');

await write('apps/desktop/release/win-unpacked/resources/app.asar', optionalAsar);
const optionalPresentTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/win-unpacked',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
assert(
  optionalPresentTree.optionalNotInstalledPresent.includes('@esbuild/win32-x64'),
  'optional not-installed platform package present in asar must be detected'
);
assert(
  optionalPresentTree.diagnostics.some((item) => item.code === 'PACKAGE_TREE_OPTIONAL_PRESENT'),
  'optional not-installed platform package must fail closed'
);

await write('apps/desktop/release/win-unpacked/resources/app.asar', cleanAsar);
await write('apps/desktop/release/win-unpacked/mods/evil.txt', 'forbidden');
const forbiddenTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/win-unpacked',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
assert(
  forbiddenTree.diagnostics.some((item) => item.code === 'PACKAGE_TREE_FORBIDDEN'),
  'forbidden packaged path must fail closed'
);
await rm(join(root, 'apps/desktop/release/win-unpacked/mods'), { recursive: true, force: true });

const missingRequiredTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/win-unpacked',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
await rm(join(root, 'apps/desktop/release/win-unpacked/resources/native/better_sqlite3.node'));
const missingNativeTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/win-unpacked',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
assert(
  missingNativeTree.diagnostics.some((item) => item.code === 'PACKAGE_TREE_REQUIRED_MISSING'),
  'missing required native binding must fail closed'
);
assert(missingRequiredTree.ok, 'intact tree before mutation must still pass');

const skippedTree = auditPackageTree({
  root,
  unpackedDir: 'apps/desktop/release/not-built',
  lock: optionalPlatformLock,
  executableName: 'SoulForge.exe'
});
assert(skippedTree.status === 'skipped' && skippedTree.ok === null, 'missing unpacked dir must be a structured skip');

console.log(JSON.stringify({
  ok: true,
  message: 'release compliance negative fixtures passed',
  checks: [
    'clean manifest accepted',
    'mtime ignored by fingerprint',
    'artifact byte mutation detected',
    'disallowed license rejected',
    'lockfile v2/v3 accepted while malformed structure and empty production inventory fail closed',
    'only declared in-repository workspace links excluded while external links fail closed',
    'valid falsy manifest JSON rejected as stale',
    'credential path rejected',
    'credential content rejected',
    'large and UTF-16 credential content rejected',
    'unsafe artifact source and target rejected',
    'Windows case-insensitive artifact target collision rejected',
    'forbidden packaged target path rejected during manifest generation',
    'Windows reserved device artifact target rejected',
    'asar header parsed into deterministic entries and non-asar input fails closed',
    'clean package tree accepted',
    'optional not-installed platform package present in asar rejected',
    'forbidden packaged path in package tree rejected',
    'missing required native binding in package tree rejected',
    'missing unpacked dir produces structured skip'
  ],
  fingerprint: first.artifacts.aggregateSha256
}, null, 2));

function buildSyntheticAsar(filesTree) {
  const json = Buffer.from(JSON.stringify(filesTree), 'utf8');
  const header = Buffer.alloc(16 + json.length);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(16 + json.length, 4);
  header.writeUInt32LE(json.length + 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return header;
}

async function write(relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function hasCode(audit, code) {
  return audit.findings.some((item) => item.code === code);
}

function hasDiagnostic(manifest, code) {
  return manifest.diagnostics.some((item) => item.code === code);
}

function encodeUtf16Be(text) {
  const littleEndian = Buffer.from(text, 'utf16le');
  const bigEndian = Buffer.allocUnsafe(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bigEndian;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
} finally {
  await rm(root, { recursive: true, force: true });
}
