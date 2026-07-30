import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importPinnedSmithboxSdtParamMetadata,
  importSmithboxSdtParamMetadata,
  type SmithboxSdtSourcePolicy
} from '../param/smithboxParamMetadataSource.js';

const scratch = await mkdtemp(join(tmpdir(), 'soulforge-smithbox-source-'));
try {
  const positive = await createFixture(join(scratch, 'positive'), '9.9.9');
  const imported = await importSmithboxSdtParamMetadata(
    { cacheRoot: positive.cacheRoot },
    positive.policy
  );
  if (!imported.ok
    || imported.status !== 'imported'
    || imported.authority !== 'partial'
    || imported.nativeFormatAuthority
    || imported.summary.definitionCount !== 1
    || imported.summary.fieldCount !== 5
    || imported.summary.resolvedEnumCount !== 1
    || imported.summary.unresolvedEnumCount !== 1
    || imported.summary.annotationCount !== 1) {
    throw new Error(`Pinned source fixture import failed: ${JSON.stringify(imported)}`);
  }
  const definition = imported.package.definitions[0];
  if (!definition
    || definition.document.typeName !== 'ACTION_GUIDE_PARAM_ST'
    || definition.document.rowDataSize !== 16
    || definition.document.fields[0]?.name !== 'Text ID'
    || definition.document.enums?.find((entry) => entry.id === 'MODE')?.values.length !== 2
    || definition.document.enums?.find((entry) => entry.id === 'UNKNOWN_BOOL')?.values.length !== 0
    || imported.package.license.redistribution !== 'external-only') {
    throw new Error('Imported fixture package lost structural, annotation, enum, or license metadata.');
  }

  const missing = await importSmithboxSdtParamMetadata(
    { cacheRoot: join(scratch, 'missing', positive.policy.release) },
    positive.policy
  );
  expectRejected(missing, 'SMITHBOX_SOURCE_MISSING');

  const wrongSlot = await createFixture(join(scratch, 'wrong-slot'), '9.9.8');
  expectRejected(
    await importSmithboxSdtParamMetadata({ cacheRoot: wrongSlot.cacheRoot }, positive.policy),
    'SMITHBOX_RELEASE_SLOT_MISMATCH'
  );

  const digestMismatch = await createFixture(join(scratch, 'bad-archive'), '9.9.9', {
    archive: 'fixture archivf'
  });
  expectRejected(
    await importSmithboxSdtParamMetadata({ cacheRoot: digestMismatch.cacheRoot }, positive.policy),
    'SMITHBOX_ARCHIVE_DIGEST_MISMATCH'
  );

  const changedLicense = await createFixture(join(scratch, 'bad-license'), '9.9.9', {
    license: 'Changed local license text.\n'
  });
  expectRejected(
    await importSmithboxSdtParamMetadata(
      { cacheRoot: changedLicense.cacheRoot },
      { ...changedLicense.policy, smithboxLicenseSha256: positive.policy.smithboxLicenseSha256 }
    ),
    'SMITHBOX_LICENSE_DIGEST_MISMATCH'
  );

  const upgradedSlot = await createFixture(join(scratch, 'unreviewed-upgrade'), '9.9.10');
  expectRejected(
    await importSmithboxSdtParamMetadata({ cacheRoot: upgradedSlot.cacheRoot }, positive.policy),
    'SMITHBOX_RELEASE_SLOT_MISMATCH'
  );

  expectRejected(
    await importSmithboxSdtParamMetadata({
      cacheRoot: positive.cacheRoot,
      revokedArtifactDigests: [positive.policy.archiveSha256]
    }, positive.policy),
    'SMITHBOX_ARTIFACT_REVOKED'
  );
  expectRejected(
    await importSmithboxSdtParamMetadata({
      cacheRoot: positive.cacheRoot,
      revokedArtifactDigests: ['not-a-digest']
    }, positive.policy),
    'SMITHBOX_REVOCATION_LIST_INVALID'
  );

  let realSourceExecuted = false;
  let realDefinitionCount: number | null = null;
  let realFieldCount: number | null = null;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const realRoot = join(localAppData, 'SoulForge', 'tools', 'smithbox', '2.2.4');
    if (await exists(join(realRoot, 'Smithbox-2.2.4-2026-07-24-a.zip'))) {
      const real = await importPinnedSmithboxSdtParamMetadata({ cacheRoot: realRoot });
      if (!real.ok) throw new Error(`Real pinned Smithbox source failed: ${JSON.stringify(real.diagnostics)}`);
      realSourceExecuted = true;
      realDefinitionCount = real.summary.definitionCount;
      realFieldCount = real.summary.fieldCount;
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'partial',
    authority: 'partial',
    nativeFormatAuthority: false,
    fixture: imported.summary,
    rejected: [
      'missing-source',
      'wrong-release-slot',
      'artifact-digest-mismatch',
      'license-digest-mismatch',
      'unreviewed-upgrade',
      'withdrawn-artifact',
      'invalid-withdrawal-list'
    ],
    realSourceExecuted,
    realDefinitionCount,
    realFieldCount,
    redistribution: 'external-only'
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function createFixture(
  parent: string,
  release: string,
  overrides: { archive?: string; license?: string } = {}
): Promise<{ cacheRoot: string; policy: SmithboxSdtSourcePolicy }> {
  const cacheRoot = join(parent, release);
  const sourceRoot = join(cacheRoot, 'source');
  const metadataRoot = join(sourceRoot, 'win-x64', 'Assets', 'PARAM', 'SDT');
  const defs = join(metadataRoot, 'Defs');
  const enums = join(metadataRoot, 'Param Enums');
  const annotations = join(metadataRoot, 'Param Annotations', 'English');
  const licenseDirectory = join(sourceRoot, 'win-x64', 'Licenses', 'Smithbox');
  await Promise.all([
    mkdir(defs, { recursive: true }),
    mkdir(enums, { recursive: true }),
    mkdir(annotations, { recursive: true }),
    mkdir(licenseDirectory, { recursive: true })
  ]);
  const archive = Buffer.from(overrides.archive ?? 'fixture archive', 'utf8');
  const license = Buffer.from(overrides.license ?? 'MIT fixture license.\n', 'utf8');
  const xml = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PARAMDEF XmlVersion="3">
  <ParamType>ACTION_GUIDE_PARAM_ST</ParamType>
  <DataVersion>1</DataVersion>
  <Fields>
    <Field Def="s32 textId = -1"><DisplayName>Text</DisplayName></Field>
    <Field Def="u8 mode"><Enum>MODE</Enum></Field>
    <Field Def="u8 enabled:1"><Enum>UNKNOWN_BOOL</Enum></Field>
    <Field Def="dummy8 pad:7" />
    <Field Def="dummy8 reserved[10]" />
  </Fields>
</PARAMDEF>
`, 'utf8');
  const enumJson = Buffer.from(JSON.stringify({
    Key: 'MODE',
    Names: [{ Language: 'English', Text: 'Mode' }],
    Options: [
      { Key: '0', Names: [{ Language: 'English', Text: 'Off' }] },
      { Key: '1', Names: [{ Language: 'English', Text: 'On' }] }
    ]
  }, null, 2), 'utf8');
  const annotationJson = Buffer.from(JSON.stringify({
    Type: 'ACTION_GUIDE_PARAM_ST',
    Fields: [{ Field: 'textId', Name: 'Text ID', Description: 'Text entry identifier.' }]
  }, null, 2), 'utf8');
  const archiveFileName = 'fixture-release.zip';
  const relativeFiles = new Map<string, Buffer>([
    ['win-x64/Assets/PARAM/SDT/Defs/ActionGuideParam.xml', xml],
    ['win-x64/Assets/PARAM/SDT/Param Annotations/English/ACTION_GUIDE_PARAM_ST.json', annotationJson],
    ['win-x64/Assets/PARAM/SDT/Param Enums/MODE.json', enumJson],
    ['win-x64/Licenses/Smithbox/LICENSE.txt', license]
  ]);
  await Promise.all([
    writeFile(join(cacheRoot, archiveFileName), archive),
    writeFile(join(defs, 'ActionGuideParam.xml'), xml),
    writeFile(join(enums, 'MODE.json'), enumJson),
    writeFile(join(annotations, 'ACTION_GUIDE_PARAM_ST.json'), annotationJson),
    writeFile(join(licenseDirectory, 'LICENSE.txt'), license)
  ]);
  return {
    cacheRoot,
    policy: {
      policyId: 'smithbox-sdt-fixture',
      release,
      sourceIdentity: 'https://github.com/example/smithbox-fixture',
      sourceCommit: 'a'.repeat(40),
      archiveFileName,
      archiveSize: archive.length,
      archiveSha256: sha256(archive),
      sourceTreeFileCount: relativeFiles.size,
      sourceTreeSha256: treeDigest(relativeFiles),
      smithboxLicenseSha256: sha256(license),
      expectedDefinitionCount: 1,
      gameBuild: '1.6'
    }
  };
}

function treeDigest(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const relativePath of [...files.keys()].sort()) {
    const bytes = files.get(relativePath)!;
    hash.update(`${relativePath}\0${bytes.length}\0${sha256(bytes)}\n`);
  }
  return hash.digest('hex');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectRejected(
  result: Awaited<ReturnType<typeof importSmithboxSdtParamMetadata>>,
  code: string
): void {
  if (result.ok || result.diagnostics[0]?.code !== code) {
    throw new Error(`Expected ${code}; got ${JSON.stringify(result)}`);
  }
  if (/[A-Za-z]:\\|\\\\|\/Users\//u.test(JSON.stringify(result))) {
    throw new Error(`${code} diagnostic leaked a local path.`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
