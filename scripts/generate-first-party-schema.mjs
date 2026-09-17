#!/usr/bin/env node
/*
 * Developer/validation boundary only.
 *
 * This command consumes explicitly supplied local reference material and
 * writes SoulForge's own semantic projection.  It is never imported by the
 * desktop runtime and is not a release input.  The checked-in result contains
 * only the schema objects needed by SoulForge, with first-party provenance.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((value) => {
  const match = /^--([^=]+)=(.*)$/u.exec(value);
  return match ? [match[1], match[2]] : [value.replace(/^--/u, ''), ''];
}));
const paramRoot = args.get('param-root');
const emedfPath = args.get('emedf');
if (!paramRoot || !emedfPath) {
  console.error('用法：node scripts/generate-first-party-schema.mjs --param-root=<已审阅的本机参考目录> --emedf=<已审阅的本机参考文件>');
  process.exitCode = 2;
  process.exit();
}

const importModule = async (relativePath) => import(pathToFileURL(resolve(root, relativePath)).href);
const [smithbox, emedfAdapter, paramMetadata] = await Promise.all([
  importModule('packages/core/dist/testing/smithboxParamMetadataSource.js'),
  importModule('packages/core/dist/testing/emedfExternalAdapter.js'),
  importModule('packages/core/dist/param/paramMetadata.js')
]);

const importedParam = await smithbox.importPinnedSmithboxSdtParamMetadata({ cacheRoot: resolve(paramRoot) });
if (!importedParam.ok) {
  throw new Error(importedParam.diagnostics[0]?.message ?? '参考 PARAM schema 导入失败。');
}
const importedEmedf = emedfAdapter.importDs3EmedfFile(resolve(emedfPath));
if (!importedEmedf.ok) throw new Error(importedEmedf.message ?? '参考 EMEVD schema 导入失败。');

const digest = (value) => `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
const textDigest = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const schemaVersion = '1.0.0';
const sourceLicense = importedParam.package.license;
const sourceLicenseText = await readFile(
  resolve(paramRoot, 'source', 'win-x64', 'Licenses', 'Smithbox', 'LICENSE.txt'),
  'utf8'
);
if (sourceLicense.spdxExpression !== 'MIT'
  || sourceLicense.redistribution !== 'external-only'
  || sourceLicense.textDigest !== textDigest(sourceLicenseText)) {
  throw new Error('参考 PARAM schema 的许可证 provenance 不符合已审阅的 MIT 来源。');
}
// License text is distributed with canonical LF line endings so its digest is
// stable across Windows checkout settings while still matching the reviewed
// source text byte-for-byte after newline normalization.
const distributedLicenseTextDigest = textDigest(sourceLicenseText.replace(/\r\n?/gu, '\n'));

const definitions = importedParam.package.definitions
  .map(({ definitionDigest: _ignored, document, key }) => {
    // Do not carry adapter/source notes into the release payload. The
    // first-party document keeps the semantic layout and its opaque-value
    // policy, while provenance belongs to the package manifest/NOTICE rather
    // than to a third-party adapter's wording.
    const { notes: _sourceNotes, ...documentWithoutSourceNotes } = document;
    const firstPartyDocument = {
      ...documentWithoutSourceNotes,
      origin: 'first-party',
      notes: 'SoulForge first-party schema; unresolved enum names remain value-opaque.'
    };
    const payload = { key, document: firstPartyDocument };
    return {
      ...payload,
      definitionDigest: paramMetadata.computeParamMetadataDefinitionDigest(payload)
    };
  })
  .sort((left, right) => left.key.typeName.localeCompare(right.key.typeName));

const sourceContentDigest = digest({
  schemaVersion: 1,
  packageId: 'soulforge-sekiro-param',
  packageVersion: schemaVersion,
  definitions
});
const paramPayload = {
  schemaVersion: 1,
  packageId: 'soulforge-sekiro-param',
  packageVersion: schemaVersion,
  source: {
    kind: 'first-party',
    identity: 'soulforge://schema/sekiro/1.6.x/param',
    revision: sourceContentDigest,
    contentDigest: sourceContentDigest
  },
  license: {
    spdxExpression: sourceLicense.spdxExpression,
    textDigest: distributedLicenseTextDigest,
    redistribution: 'permitted'
  },
  definitions
};
const paramPackage = {
  ...paramPayload,
  packageDigest: paramMetadata.computeParamMetadataPackageDigest(paramPayload)
};

const emedfSemantics = {
  schemaVersion: 1,
  game: 'sekiro',
  banks: [...(importedEmedf.registry.banks ?? [])].sort((left, right) => left - right),
  instructions: [...importedEmedf.registry.instructions]
    .sort((left, right) => left.bank - right.bank || left.id - right.id || left.name.localeCompare(right.name))
    .map((instruction) => ({
      bank: instruction.bank,
      id: instruction.id,
      name: instruction.name,
      args: instruction.args.map((arg) => ({ ...arg }))
    })),
  enums: importedEmedf.registry.enums
    ? Object.fromEntries(Object.entries(importedEmedf.registry.enums)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => [name, {
          name: definition.name,
          members: definition.members.map((member) => ({ ...member }))
        }]))
    : undefined
};
const emedfRegistry = {
  ...emedfSemantics,
  origin: 'first-party',
  packageId: 'soulforge-sekiro-emedf',
  packageVersion: schemaVersion,
  contentDigest: digest(emedfSemantics)
};

const outputPath = resolve(root, 'packages/core/src/schema/sekiro/firstPartySchemaData.ts');
await mkdir(dirname(outputPath), { recursive: true });
const output = [
  '/* eslint-disable */',
  '/**',
  ' * Generated SoulForge semantic schema data.',
  ' *',
  ' * The generator is a developer/validation tool. This checked-in module is',
  ' * the first-party runtime package and contains no native binary assets.',
  ' */',
  "import type { ParamMetadataPackage } from '@soulforge/shared';",
  "import type { EmedfRegistry } from '../../emevd/emedfSchema.js';",
  '',
  `export const FIRST_PARTY_PARAM_METADATA_PACKAGE: ParamMetadataPackage = ${JSON.stringify(paramPackage, null, 2)};`,
  '',
  `export const FIRST_PARTY_EMEDF_REGISTRY: EmedfRegistry = ${JSON.stringify(emedfRegistry, null, 2)};`,
  ''
].join('\n');
await writeFile(outputPath, output, 'utf8');
console.log(JSON.stringify({
  ok: true,
  outputPath,
  paramDefinitions: definitions.length,
  paramPackageDigest: paramPackage.packageDigest,
  emedfInstructions: emedfRegistry.instructions.length,
  emedfBanks: emedfRegistry.banks.length,
  emedfContentDigest: emedfRegistry.contentDigest
}, null, 2));

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
