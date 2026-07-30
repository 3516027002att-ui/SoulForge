import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  EXECUTABLE_BUILDER_HOOK_FIELDS,
  validatePortableBuilderConfig
} from './portable-packaging-config.mjs';
import { processSucceeded } from './subprocess-control.mjs';
import { resolveSafeScratchRoot } from './scratch-boundary.mjs';

const root = resolve(import.meta.dirname, '..');
const configText = await readFile(resolve(root, 'apps/desktop/electron-builder.json'), 'utf8');
const policyText = await readFile(resolve(root, 'scripts/release-compliance-policy.json'), 'utf8');
const config = JSON.parse(configText);
const policy = JSON.parse(policyText);
const valid = validatePortableBuilderConfig(config, policy);
assert.deepEqual(valid.filter((item) => !item.ok), []);

const commentOnly = {
  appId: 'fixture.invalid',
  note: 'portable nsis mods oo2core better_sqlite3.node unsigned asar'
};
const commentFindings = validatePortableBuilderConfig(commentOnly, policy).filter((item) => !item.ok);
assert.ok(commentFindings.some((item) => item.name === 'win-x64-portable-and-nsis-only'));
assert.ok(commentFindings.some((item) => item.name === 'excludes-mods'));
assert.ok(commentFindings.some((item) => item.name === 'includes-only-final-sqlite-binding'));

const unsafe = structuredClone(config);
unsafe.files = unsafe.files.filter((item) => item !== '!mods/**/*');
unsafe.win.sign = 'fixture-sign-hook';
unsafe.extraResources.push({ from: '../../mods', to: 'mods', filter: ['**/*'] });
const unsafeFindings = validatePortableBuilderConfig(unsafe, policy).filter((item) => !item.ok);
assert.ok(unsafeFindings.some((item) => item.name === 'excludes-mods'));
assert.ok(unsafeFindings.some((item) => item.name === 'signing-unset'));
assert.ok(unsafeFindings.some((item) => item.name === 'package-inputs-closed'));

const extraFiles = structuredClone(config);
extraFiles.extraFiles = [{ from: '../../mods', to: 'unscanned-mods' }];
assert.ok(
  validatePortableBuilderConfig(extraFiles, policy).some(
    (item) => item.name === 'package-inputs-closed' && !item.ok
  )
);
assert.ok(
  validatePortableBuilderConfig(extraFiles, policy).some(
    (item) => item.name === 'config-schema-closed' && !item.ok
  )
);

const unknownTopLevel = structuredClone(config);
unknownTopLevel.unreviewedOption = true;
assert.ok(
  validatePortableBuilderConfig(unknownTopLevel, policy).some(
    (item) => item.name === 'config-schema-closed' && !item.ok
  )
);

const unknownNested = structuredClone(config);
unknownNested.extraResources[0].unreviewedOption = true;
assert.ok(
  validatePortableBuilderConfig(unknownNested, policy).some(
    (item) => item.name === 'config-schema-closed' && !item.ok
  )
);

for (const mutation of [
  { check: 'identity-values-approved', apply: (value) => { value.appId = 'com.example.drift'; } },
  { check: 'identity-values-approved', apply: (value) => { value.productName = 'SoulForge Drift'; } },
  { check: 'identity-values-approved', apply: (value) => { value.copyright = 'unapproved'; } },
  { check: 'nsis-values-approved', apply: (value) => { value.nsis.oneClick = true; } },
  { check: 'nsis-values-approved', apply: (value) => { value.nsis.allowToChangeInstallationDirectory = false; } },
  { check: 'nsis-values-approved', apply: (value) => { value.nsis.createDesktopShortcut = false; } },
  { check: 'nsis-values-approved', apply: (value) => { value.nsis.createStartMenuShortcut = false; } },
  { check: 'nsis-values-approved', apply: (value) => { value.nsis.shortcutName = 'Drift'; } },
  { check: 'archive-values-approved', apply: (value) => { value.asar = false; } },
  { check: 'archive-values-approved', apply: (value) => { value.compression = 'store'; } }
]) {
  const drifted = structuredClone(config);
  mutation.apply(drifted);
  assert.ok(
    validatePortableBuilderConfig(drifted, policy).some(
      (item) => item.name === mutation.check && !item.ok
    ),
    `${mutation.check} must reject approved-value drift`
  );
}

const fileSetInput = structuredClone(config);
fileSetInput.files.push({ from: '../../mods', to: 'unscanned-mods', filter: ['**/*'] });
assert.ok(
  validatePortableBuilderConfig(fileSetInput, policy).some(
    (item) => item.name === 'package-inputs-closed' && !item.ok
  )
);

for (const injectedPattern of [
  '!../../mods/**/*',
  '!!mods/**/*',
  '!!.native/**/*',
  '!!out/release-compliance.json',
  '../outside/**/*',
  'C:/outside/**/*'
]) {
  const injected = structuredClone(config);
  injected.files.push(injectedPattern);
  assert.ok(
    validatePortableBuilderConfig(injected, policy).some(
      (item) => item.name === 'package-inputs-closed' && !item.ok
    ),
    `unapproved file pattern must fail closed: ${injectedPattern}`
  );
}

for (const mutation of [
  { check: 'output-directory-approved', apply: (value) => { value.directories.output = '../../mods'; } },
  { check: 'output-directory-approved', apply: (value) => { value.directories.output = 'C:\\outside'; } },
  { check: 'output-directory-approved', apply: (value) => { value.directories.output = 'release-drift'; } },
  { check: 'build-resources-directory-approved', apply: (value) => { value.directories.buildResources = '../../mods'; } },
  { check: 'build-resources-directory-approved', apply: (value) => { value.directories.buildResources = 'C:\\outside'; } },
  { check: 'build-resources-directory-approved', apply: (value) => { value.directories.buildResources = 'resources-drift'; } },
  { check: 'win-artifact-name-approved', apply: (value) => { value.win.artifactName = '../../mods/payload.${ext}'; } },
  { check: 'win-artifact-name-approved', apply: (value) => { value.win.artifactName = 'C:\\outside\\payload.${ext}'; } },
  { check: 'win-artifact-name-approved', apply: (value) => { value.win.artifactName = 'SoulForge-drift.${ext}'; } },
  { check: 'portable-artifact-name-approved', apply: (value) => { value.portable.artifactName = '../../mods/payload.${ext}'; } },
  { check: 'portable-artifact-name-approved', apply: (value) => { value.portable.artifactName = 'C:\\outside\\payload.${ext}'; } },
  { check: 'portable-artifact-name-approved', apply: (value) => { value.portable.artifactName = 'SoulForge-portable-drift.${ext}'; } }
]) {
  const drifted = structuredClone(config);
  mutation.apply(drifted);
  assert.ok(
    validatePortableBuilderConfig(drifted, policy).some(
      (item) => item.name === mutation.check && !item.ok
    ),
    `${mutation.check} must reject traversal, absolute, and approved-value drift`
  );
}

assert.deepEqual(EXECUTABLE_BUILDER_HOOK_FIELDS, [
  'beforePack',
  'afterExtract',
  'afterPack',
  'afterSign',
  'artifactBuildStarted',
  'artifactBuildCompleted',
  'afterAllArtifactBuild',
  'msiProjectCreated',
  'appxManifestCreated',
  'onNodeModuleFile',
  'beforeBuild',
  'electronDist'
]);
for (const field of EXECUTABLE_BUILDER_HOOK_FIELDS) {
  const hooked = structuredClone(config);
  hooked[field] = `./scripts/${field}.mjs`;
  assert.ok(
    validatePortableBuilderConfig(hooked, policy).some(
      (item) => item.name === 'executable-hooks-unset' && !item.ok
    ),
    `${field} hook must fail closed`
  );
}

const driftedPolicy = structuredClone(policy);
driftedPolicy.artifactInputs.push({
  kind: 'file',
  source: 'README.md',
  target: 'unscanned-readme.md'
});
const policyFindings = validatePortableBuilderConfig(config, driftedPolicy).filter((item) => !item.ok);
assert.ok(policyFindings.some((item) => item.name === 'compliance-policy-aligned'));

const policyWithUnknownField = structuredClone(policy);
policyWithUnknownField.artifactInputs[0].unreviewed = true;
assert.ok(
  validatePortableBuilderConfig(config, policyWithUnknownField).some(
    (item) => item.name === 'compliance-policy-aligned' && !item.ok
  )
);

assert.equal(processSucceeded({ code: 0, timedOut: false, cancelled: false }), true);
assert.equal(processSucceeded({ code: 0, timedOut: true, cancelled: false }), false);
assert.equal(processSucceeded({ code: 0, timedOut: false, cancelled: true }), false);
assert.equal(processSucceeded({ code: 1, timedOut: false, cancelled: false }), false);

await verifyScratchBoundary();

assert.throws(
  () => JSON.parse('{"appId":"fixture" // comments cannot satisfy JSON config'),
  SyntaxError
);

console.log(JSON.stringify({
  ok: true,
  status: 'passed',
  cases: [
    'canonical-config-valid',
    'descriptive-text-cannot-satisfy-structure',
    'missing-exclusion-and-executable-hook-rejected',
    'unscanned-extra-resource-rejected',
    'extra-files-and-file-set-input-rejected',
    'unapproved-root-outside-and-double-negation-patterns-rejected',
    'output-build-resource-and-artifact-path-drift-rejected',
    'unknown-top-level-and-nested-builder-fields-rejected',
    'identity-nsis-and-archive-value-drift-rejected',
    'all-executable-builder-hooks-rejected',
    'builder-policy-drift-rejected',
    'policy-input-unknown-field-rejected',
    'portable-pack-timeout-and-cancel-rejected-even-with-zero-exit',
    'scratch-boundary-safe-sibling-accepted',
    'scratch-boundary-relative-root-and-protected-overlaps-rejected',
    'scratch-boundary-nearest-physical-ancestor-symlink-rejected',
    'commented-json-rejected'
  ]
}, null, 2));

async function verifyScratchBoundary() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-scratch-boundary-'));
  const repositoryRoot = join(fixtureRoot, 'repository');
  const gameRoot = join(fixtureRoot, 'game');
  const nativeFixtureRoot = join(fixtureRoot, 'native-fixtures');
  const modWorkspaceRoot = join(fixtureRoot, 'external-mod-workspace');
  const workspaceRoot = join(fixtureRoot, 'external-workspace');
  const safeScratch = join(fixtureRoot, 'scratch');
  const protectedRoots = [
    { label: 'game-root', path: gameRoot },
    { label: 'native-fixture-root', path: nativeFixtureRoot },
    { label: 'mod-workspace-root', path: modWorkspaceRoot },
    { label: 'workspace-root', path: workspaceRoot }
  ];
  try {
    await Promise.all([
      repositoryRoot,
      gameRoot,
      nativeFixtureRoot,
      modWorkspaceRoot,
      workspaceRoot
    ].map((path) => mkdir(path, { recursive: true })));

    assert.equal(
      await resolveSafeScratchRoot({ scratch: safeScratch, repositoryRoot, protectedRoots }),
      resolve(safeScratch)
    );

    await expectScratchFailure('relative-scratch', repositoryRoot, protectedRoots, 'SCRATCH_PATH_NOT_ABSOLUTE');
    await expectScratchFailure(
      parse(resolve(safeScratch)).root,
      repositoryRoot,
      protectedRoots,
      'SCRATCH_FILESYSTEM_ROOT_FORBIDDEN'
    );
    for (const unsafeScratch of [
      repositoryRoot,
      join(repositoryRoot, 'scratch'),
      fixtureRoot,
      gameRoot,
      join(nativeFixtureRoot, 'scratch'),
      modWorkspaceRoot,
      workspaceRoot
    ]) {
      await expectScratchFailure(
        unsafeScratch,
        repositoryRoot,
        protectedRoots,
        'SCRATCH_PROTECTED_ROOT_OVERLAP'
      );
    }

    const gameAlias = join(fixtureRoot, 'game-alias');
    await symlink(gameRoot, gameAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await expectScratchFailure(
      join(gameAlias, 'not-created-yet'),
      repositoryRoot,
      protectedRoots,
      'SCRATCH_PROTECTED_ROOT_OVERLAP'
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function expectScratchFailure(scratch, repositoryRoot, protectedRoots, expectedCode) {
  await assert.rejects(
    resolveSafeScratchRoot({ scratch, repositoryRoot, protectedRoots }),
    (error) => error?.code === expectedCode,
    `${scratch} must fail with ${expectedCode}`
  );
}
