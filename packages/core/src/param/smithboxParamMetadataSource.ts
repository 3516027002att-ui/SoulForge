import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type {
  ParamDefDocument,
  ParamEnumDef,
  ParamFieldDef,
  ParamFieldScalarType,
  ParamMetadataDefinition,
  ParamMetadataDigest,
  ParamMetadataPackage
} from '@soulforge/shared';
import {
  computeParamMetadataDefinitionDigest,
  computeParamMetadataPackageDigest,
  validateParamMetadataPackage
} from './paramMetadata.js';

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SOURCE_TREE_ROOTS = [
  'win-x64/Assets/PARAM/SDT',
  'win-x64/Licenses/Smithbox/LICENSE.txt'
] as const;
const METADATA_RELATIVE_ROOT = 'source/win-x64/Assets/PARAM/SDT';
const LICENSE_RELATIVE_PATH = 'source/win-x64/Licenses/Smithbox/LICENSE.txt';
const FIELD_DEF = /^(u8|s8|u16|s16|u32|s32|f32|angle32|b32|dummy8|fixstr|fixstrW)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?(?::(\d+))?(?:\s*=\s*(.+))?$/u;
const INTEGER_RANGES: Partial<Record<ParamFieldScalarType, readonly [number, number]>> = {
  u8: [0, 0xff],
  s8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  s16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  s32: [-0x80000000, 0x7fffffff]
};

export interface SmithboxSdtSourcePolicy {
  policyId: string;
  release: string;
  sourceIdentity: string;
  sourceCommit: string;
  archiveFileName: string;
  archiveSize: number;
  archiveSha256: string;
  sourceTreeFileCount: number;
  sourceTreeSha256: string;
  smithboxLicenseSha256: string;
  expectedDefinitionCount: number;
  gameBuild: string;
}

export const SMITHBOX_SDT_2_2_4_POLICY: Readonly<SmithboxSdtSourcePolicy> = Object.freeze({
  policyId: 'smithbox-sdt-2.2.4',
  release: '2.2.4',
  sourceIdentity: 'https://github.com/vawser/Smithbox',
  sourceCommit: '1b46d2c9f82d1c3635ff7c12c526e05a8ba4208f',
  archiveFileName: 'Smithbox-2.2.4-2026-07-24-a.zip',
  archiveSize: 291_410_293,
  archiveSha256: '14a7fd735a9577249fa93655f63d1e9ac025a3b00d7c5bed8badc8a3a7fd489d',
  sourceTreeFileCount: 932,
  sourceTreeSha256: '328f9876252b0933b427cff9c7ca21445985aa81727628843667d4a3a5e501b2',
  smithboxLicenseSha256: '7f043d61cb4e325bfcd8f5046cc7e0f04aa7802da5d19e6bc9b4c1a25db8ca8e',
  expectedDefinitionCount: 160,
  gameBuild: '1.6'
});

export interface SmithboxSdtImportOptions {
  /** Exact release slot, normally .../SoulForge/tools/smithbox/2.2.4. */
  cacheRoot: string;
  /** Application-owned withdrawal list; renderer input must never populate it. */
  revokedArtifactDigests?: readonly string[];
}

export interface SmithboxSdtImportDiagnostic {
  severity: 'error';
  code: string;
  message: string;
}

export type SmithboxSdtImportResult =
  | {
      ok: true;
      status: 'imported';
      authority: 'partial';
      nativeFormatAuthority: false;
      package: ParamMetadataPackage;
      summary: {
        policyId: string;
        release: string;
        definitionCount: number;
        fieldCount: number;
        resolvedEnumCount: number;
        unresolvedEnumCount: number;
        annotationCount: number;
        /** 带跨表引用的字段数（实测本发布 450）。 */
        refFieldCount: number;
      };
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'rejected';
      authority: 'unverified';
      nativeFormatAuthority: false;
      diagnostics: SmithboxSdtImportDiagnostic[];
    };

interface ParsedField {
  def: string;
  displayName?: string;
  description?: string;
  minimum?: string;
  maximum?: string;
  enumRef?: string;
}

/**
 * 一个 param 的 `Param Meta`：字段 id → 该字段的 `Refs=` 原始字符串。
 *
 * 只取 `Refs`。同目录还有 `VRef`/`FmgRef`/`IsBool`/`SortID`/`AlternativeOrder`
 * 等属性，它们各自需要另一套解析与 UI，混在一起做会让这次改动无法单独验证。
 */
type ParamMetaRefIndex = ReadonlyMap<string, string>;

interface ParsedParamdef {
  typeName: string;
  dataVersion: number;
  fields: ParsedField[];
}

interface AnnotationField {
  Field?: unknown;
  Name?: unknown;
  Description?: unknown;
}

interface AnnotationFile {
  Type?: unknown;
  Fields?: unknown;
}

interface EnumFile {
  Key?: unknown;
  Names?: unknown;
  Options?: unknown;
}

interface FieldLayoutState {
  byteOffset: number;
  bitGroup: {
    baseBytes: number;
    startOffset: number;
    usedBits: number;
  } | undefined;
}

/** Production entrypoint. Its source identity and digests cannot be overridden. */
export async function importPinnedSmithboxSdtParamMetadata(
  options: SmithboxSdtImportOptions
): Promise<SmithboxSdtImportResult> {
  return await importSmithboxSdtParamMetadata(options, SMITHBOX_SDT_2_2_4_POLICY);
}

/**
 * Explicit policy boundary used by deterministic fixtures and future reviewed
 * upgrades. Production callers must use importPinnedSmithboxSdtParamMetadata.
 */
export async function importSmithboxSdtParamMetadata(
  options: SmithboxSdtImportOptions,
  policy: Readonly<SmithboxSdtSourcePolicy>
): Promise<SmithboxSdtImportResult> {
  try {
    validatePolicy(policy);
    const cacheRoot = await validateSourceBoundary(options.cacheRoot, policy);
    validateWithdrawal(options.revokedArtifactDigests, policy.archiveSha256);

    const archivePath = await resolveContainedFile(
      cacheRoot,
      join(cacheRoot, policy.archiveFileName),
      'SMITHBOX_ARCHIVE_MISSING'
    );
    const archiveStat = await stat(archivePath);
    if (archiveStat.size !== policy.archiveSize) {
      throw sourceError('SMITHBOX_ARCHIVE_SIZE_MISMATCH', 'Smithbox release archive size is not the pinned value.');
    }
    const archiveDigest = await sha256File(archivePath);
    if (archiveDigest !== policy.archiveSha256) {
      throw sourceError('SMITHBOX_ARCHIVE_DIGEST_MISMATCH', 'Smithbox release archive digest is not the pinned value.');
    }

    const extractedRoot = await resolveContainedDirectory(cacheRoot, join(cacheRoot, 'source'));
    const tree = await computeSourceTreeDigest(extractedRoot);
    if (tree.fileCount !== policy.sourceTreeFileCount || tree.sha256 !== policy.sourceTreeSha256) {
      throw sourceError('SMITHBOX_SOURCE_TREE_DIGEST_MISMATCH', 'Extracted Smithbox metadata tree does not match the pinned release.');
    }

    const metadataRoot = await resolveContainedDirectory(
      cacheRoot,
      join(cacheRoot, ...METADATA_RELATIVE_ROOT.split('/'))
    );
    const licensePath = await resolveContainedFile(
      cacheRoot,
      join(cacheRoot, ...LICENSE_RELATIVE_PATH.split('/')),
      'SMITHBOX_LICENSE_MISSING'
    );
    if (await sha256File(licensePath) !== policy.smithboxLicenseSha256) {
      throw sourceError('SMITHBOX_LICENSE_DIGEST_MISMATCH', 'Smithbox license text does not match the reviewed digest.');
    }

    const enumIndex = await loadEnumIndex(join(metadataRoot, 'Param Enums'));
    const annotations = await loadAnnotationIndex(join(metadataRoot, 'Param Annotations', 'English'));
    const refIndex = await loadParamMetaRefIndex(join(metadataRoot, 'Param Meta'));
    const definitionFiles = (await readdir(join(metadataRoot, 'Defs'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
      .map((entry) => entry.name)
      .sort(compareOrdinal);
    if (definitionFiles.length !== policy.expectedDefinitionCount) {
      throw sourceError('SMITHBOX_DEFINITION_COUNT_MISMATCH', 'Smithbox PARAM definition count is not the pinned value.');
    }

    const definitions: ParamMetadataDefinition[] = [];
    let fieldCount = 0;
    let resolvedEnumCount = 0;
    let unresolvedEnumCount = 0;
    let refFieldCount = 0;
    for (const fileName of definitionFiles) {
      const path = await resolveContainedFile(
        metadataRoot,
        join(metadataRoot, 'Defs', fileName),
        'SMITHBOX_DEFINITION_MISSING'
      );
      const xml = await readBoundedText(path, MAX_XML_BYTES, 'SMITHBOX_DEFINITION_TOO_LARGE');
      let parsed: ParsedParamdef;
      try {
        parsed = parseParamdefXml(xml);
      } catch (error) {
        if (error instanceof SmithboxSourceError) {
          throw sourceError(error.code, `Smithbox definition ${fileName} was rejected: ${error.message}`);
        }
        throw error;
      }
      /*
       * Refs 按 **Defs 文件名** 取，不按 ParamType。
       *
       * 实测依据：`Param Meta` 与 `Defs` 各 160 个文件，文件名双向一一对应（无差
       * 集），且 `Param Meta` 里 7028 个字段节点的 id **全部**能在同名 Defs 里找到
       * （漂移 0）。而 ParamType 虽然在本发布里也恰好唯一，却是文件**内容**，
       * 用它当连接键会让「换个发布出现两文件同 ParamType」变成静默错配。
       */
      const projected = projectParamdef(
        parsed,
        annotations.get(parsed.typeName),
        enumIndex,
        refIndex.get(fileName.slice(0, -4))
      );
      fieldCount += projected.document.fields.length;
      resolvedEnumCount += projected.resolvedEnumCount;
      unresolvedEnumCount += projected.unresolvedEnumCount;
      refFieldCount += projected.refFieldCount;
      const key = {
        game: 'sekiro',
        gameBuild: policy.gameBuild,
        typeName: projected.document.typeName,
        dataVersion: projected.document.version,
        rowDataSize: projected.document.rowDataSize
      };
      const payload = { key, document: projected.document };
      definitions.push({
        ...payload,
        definitionDigest: computeParamMetadataDefinitionDigest(payload)
      });
    }

    const packagePayload: Omit<ParamMetadataPackage, 'packageDigest'> = {
      schemaVersion: 1,
      packageId: 'smithbox-sdt-local',
      packageVersion: policy.release,
      source: {
        kind: 'paramdex-compatible',
        identity: policy.sourceIdentity,
        revision: `git:${policy.sourceCommit}`,
        contentDigest: asDigest(policy.archiveSha256)
      },
      license: {
        spdxExpression: 'MIT',
        textDigest: asDigest(policy.smithboxLicenseSha256),
        redistribution: 'external-only'
      },
      definitions
    };
    const metadataPackage: ParamMetadataPackage = {
      ...packagePayload,
      packageDigest: computeParamMetadataPackageDigest(packagePayload)
    };
    const validated = validateParamMetadataPackage(metadataPackage);
    if (!validated.ok) {
      throw sourceError(
        'SMITHBOX_PACKAGE_VALIDATION_FAILED',
        `Imported metadata package was rejected: ${validated.diagnostics[0]?.code ?? 'unknown'}.`
      );
    }

    return {
      ok: true,
      status: 'imported',
      authority: 'partial',
      nativeFormatAuthority: false,
      package: validated.package,
      summary: {
        policyId: policy.policyId,
        release: policy.release,
        definitionCount: definitions.length,
        fieldCount,
        resolvedEnumCount,
        unresolvedEnumCount,
        annotationCount: annotations.size,
        refFieldCount
      },
      diagnostics: []
    };
  } catch (error) {
    const diagnostic = error instanceof SmithboxSourceError
      ? { severity: 'error' as const, code: error.code, message: error.message }
      : {
          severity: 'error' as const,
          code: 'SMITHBOX_SOURCE_IMPORT_FAILED',
          message: error instanceof Error ? redactLocalDetails(error.message) : 'Smithbox metadata import failed.'
        };
    return {
      ok: false,
      status: 'rejected',
      authority: 'unverified',
      nativeFormatAuthority: false,
      diagnostics: [diagnostic]
    };
  }
}

function validatePolicy(policy: Readonly<SmithboxSdtSourcePolicy>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(policy.policyId)
    || !/^\d+\.\d+\.\d+$/u.test(policy.release)
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(policy.sourceIdentity)
    || !/^[a-f0-9]{40}$/u.test(policy.sourceCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]+\.zip$/u.test(policy.archiveFileName)
    || !Number.isSafeInteger(policy.archiveSize) || policy.archiveSize <= 0
    || !isSha256(policy.archiveSha256)
    || !Number.isSafeInteger(policy.sourceTreeFileCount) || policy.sourceTreeFileCount <= 0
    || !isSha256(policy.sourceTreeSha256)
    || !isSha256(policy.smithboxLicenseSha256)
    || !Number.isSafeInteger(policy.expectedDefinitionCount) || policy.expectedDefinitionCount <= 0
    || policy.gameBuild !== '1.6') {
    throw sourceError('SMITHBOX_SOURCE_POLICY_INVALID', 'Smithbox source policy is invalid.');
  }
}

async function validateSourceBoundary(
  configuredRoot: string,
  policy: Readonly<SmithboxSdtSourcePolicy>
): Promise<string> {
  if (!isAbsolute(configuredRoot) || basename(resolve(configuredRoot)) !== policy.release) {
    throw sourceError('SMITHBOX_RELEASE_SLOT_MISMATCH', 'Smithbox cache must use the exact pinned release slot.');
  }
  try {
    const root = await realpath(resolve(configuredRoot));
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error('not-directory');
    return root;
  } catch {
    throw sourceError('SMITHBOX_SOURCE_MISSING', 'Pinned Smithbox local source is missing.');
  }
}

function validateWithdrawal(revoked: readonly string[] | undefined, archiveDigest: string): void {
  if (revoked === undefined) return;
  if (!Array.isArray(revoked) || revoked.some((digest) => !isSha256(digest))) {
    throw sourceError('SMITHBOX_REVOCATION_LIST_INVALID', 'Smithbox withdrawal list is invalid.');
  }
  if (new Set(revoked).size !== revoked.length) {
    throw sourceError('SMITHBOX_REVOCATION_LIST_INVALID', 'Smithbox withdrawal list contains duplicates.');
  }
  if (revoked.includes(archiveDigest)) {
    throw sourceError('SMITHBOX_ARTIFACT_REVOKED', 'Pinned Smithbox metadata source has been withdrawn.');
  }
}

async function resolveContainedDirectory(root: string, candidate: string): Promise<string> {
  try {
    const path = await realpath(candidate);
    assertContained(root, path);
    if (!(await stat(path)).isDirectory()) throw new Error('not-directory');
    return path;
  } catch (error) {
    if (error instanceof SmithboxSourceError) throw error;
    throw sourceError('SMITHBOX_SOURCE_LAYOUT_INVALID', 'Smithbox metadata directory layout is invalid.');
  }
}

async function resolveContainedFile(
  root: string,
  candidate: string,
  missingCode: string
): Promise<string> {
  try {
    const path = await realpath(candidate);
    assertContained(root, path);
    if (!(await stat(path)).isFile()) throw new Error('not-file');
    return path;
  } catch (error) {
    if (error instanceof SmithboxSourceError) throw error;
    throw sourceError(missingCode, 'Required Smithbox source file is missing or invalid.');
  }
}

function assertContained(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw sourceError('SMITHBOX_SOURCE_BOUNDARY_VIOLATION', 'Smithbox source escaped its local cache boundary.');
  }
}

async function computeSourceTreeDigest(extractedRoot: string): Promise<{ fileCount: number; sha256: string }> {
  const files: string[] = [];
  for (const root of SOURCE_TREE_ROOTS) {
    await walkTree(extractedRoot, root, files);
  }
  files.sort(compareOrdinal);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const path = join(extractedRoot, ...relativePath.split('/'));
    const bytes = await readFile(path);
    hash.update(`${relativePath}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return { fileCount: files.length, sha256: hash.digest('hex') };
}

async function walkTree(root: string, relativePath: string, output: string[]): Promise<void> {
  const path = join(root, ...relativePath.split('/'));
  const entryStat = await lstat(path);
  if (entryStat.isSymbolicLink()) {
    throw sourceError('SMITHBOX_SOURCE_SYMLINK_FORBIDDEN', 'Smithbox source tree contains a symbolic link.');
  }
  if (entryStat.isFile()) {
    output.push(relativePath);
    return;
  }
  if (!entryStat.isDirectory()) {
    throw sourceError('SMITHBOX_SOURCE_ENTRY_INVALID', 'Smithbox source tree contains an unsupported entry type.');
  }
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    await walkTree(root, `${relativePath}/${entry.name}`, output);
  }
}

async function loadAnnotationIndex(directory: string): Promise<Map<string, Map<string, AnnotationField>>> {
  const index = new Map<string, Map<string, AnnotationField>>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const input = await readJson<AnnotationFile>(join(directory, entry.name));
    if (typeof input.Type !== 'string' || !Array.isArray(input.Fields)) continue;
    if (index.has(input.Type)) {
      throw sourceError('SMITHBOX_ANNOTATION_DUPLICATE', 'Smithbox annotations contain a duplicate PARAM type.');
    }
    const fields = new Map<string, AnnotationField>();
    for (const field of input.Fields) {
      if (!isRecord(field) || typeof field.Field !== 'string' || fields.has(field.Field)) continue;
      fields.set(field.Field, field as AnnotationField);
    }
    index.set(input.Type, fields);
  }
  return index;
}

/**
 * 读取 `Param Meta`：每个 param 的字段 → `Refs=` 原始字符串。
 *
 * ── 为什么单独一条读取路径 ──
 *
 * `Param Meta` 全部是 **UTF-16LE 带 BOM**（实测 160/160 首字节 FF FE），而 `Defs`
 * 是 UTF-8（159 个带 BOM + 2 个裸）。共用 `readBoundedText`（固定 utf8）会把
 * UTF-16 读成每字符夹一个 NUL 的乱码，XML 解析随即失败 —— 而且失败点离真正原因
 * 很远。所以这里显式按 BOM 分派编码。
 *
 * ── 为什么缺失不算错 ──
 *
 * 引用是**可选增强**：没有它 param 仍然可读可编辑，只是数字不能点。目录不存在或
 * 某个文件坏掉时返回空索引/跳过该文件，不让整个元数据包导入失败 —— 那会把
 * 「跳转不可用」升级成「PARAM 完全不可用」。
 * 但**已经存在且畸形**的 XML 不静默跳过 DTD 这类安全问题：与 Defs 同样禁 DTD。
 */
async function loadParamMetaRefIndex(directory: string): Promise<Map<string, ParamMetaRefIndex>> {
  const index = new Map<string, ParamMetaRefIndex>();
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) continue;
    const path = join(directory, entry.name);
    let xml: string;
    try {
      xml = await readBoundedBomText(path, MAX_XML_BYTES, 'SMITHBOX_PARAM_META_TOO_LARGE');
    } catch (error) {
      if (error instanceof SmithboxSourceError) throw error;
      continue;
    }
    const refs = parseParamMetaRefs(xml);
    if (refs.size > 0) index.set(entry.name.slice(0, -4), refs);
  }
  return index;
}

/**
 * 从一个 `Param Meta` XML 里取出 `<Field>` 下每个字段节点的 `Refs=`。
 *
 * 用 saxes 而不是正则：字段节点名是**动态的**（节点名就是字段 id），属性顺序也不
 * 固定，正则匹配 `<name ... Refs="...">` 会在属性换序或出现 `>` 转义时错配。
 * 只收 `<Field>` 的直接子节点 —— `<Self>` 上也有属性，但那是表级配置，不是字段。
 */
function parseParamMetaRefs(xml: string): ReadonlyMap<string, string> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw sourceError('SMITHBOX_XML_DTD_FORBIDDEN', 'DTD and entity declarations are forbidden in Smithbox metadata.');
  }
  const refs = new Map<string, string>();
  let depth = 0;
  let inFieldBlock = false;
  let failed = false;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { failed = true; });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    depth += 1;
    // <PARAMMETA>(1) → <Field>(2) → 字段节点(3)
    if (depth === 2 && tag.name === 'Field') {
      inFieldBlock = true;
      return;
    }
    if (depth !== 3 || !inFieldBlock) return;
    const value = attributeValue(tag, 'Refs');
    // 首次出现优先：同名字段节点重复是元数据缺陷，后者覆盖前者会让结果依赖
    // 文档顺序，而「第一条」至少是稳定的。
    if (value !== undefined && value.trim() !== '' && !refs.has(tag.name)) {
      refs.set(tag.name, value.trim());
    }
  });
  parser.on('closetag', (tag: SaxesTagPlain) => {
    if (depth === 2 && tag.name === 'Field') inFieldBlock = false;
    depth -= 1;
  });
  parser.on('error', () => { failed = true; });
  try {
    parser.write(xml).close();
  } catch {
    failed = true;
  }
  // 坏文件按「这个 param 没有引用」处理：引用是增强，不该让导入失败。
  return failed ? new Map() : refs;
}

/**
 * 按 BOM 分派编码读取文本。
 *
 * 只认 UTF-16LE（FF FE）与 UTF-8；UTF-16BE（FE FF）在本发布里不存在，遇到就当
 * 不支持而不是按 LE 硬读 —— 按错的字节序读出来是能用的字符串，但内容全错。
 */
async function readBoundedBomText(path: string, maxBytes: number, code: string): Promise<string> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxBytes) {
    throw sourceError(code, 'Smithbox metadata file exceeds its supported size boundary.');
  }
  const bytes = await readFile(path);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw sourceError('SMITHBOX_TEXT_ENCODING_UNSUPPORTED', 'UTF-16BE Smithbox metadata is unsupported.');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^﻿/u, '');
}

async function loadEnumIndex(directory: string): Promise<Map<string, ParamEnumDef>> {
  const index = new Map<string, ParamEnumDef>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const input = await readJson<EnumFile>(join(directory, entry.name));
    if (typeof input.Key !== 'string' || !Array.isArray(input.Options) || index.has(input.Key)) {
      throw sourceError('SMITHBOX_ENUM_INVALID', 'Smithbox enum metadata is malformed or duplicated.');
    }
    const values: ParamEnumDef['values'] = [];
    const seen = new Set<number>();
    for (const option of input.Options) {
      if (!isRecord(option) || typeof option.Key !== 'string') {
        throw sourceError('SMITHBOX_ENUM_INVALID', 'Smithbox enum option is malformed.');
      }
      const value = Number(option.Key);
      if (!Number.isSafeInteger(value) || seen.has(value)) {
        throw sourceError('SMITHBOX_ENUM_INVALID', 'Smithbox enum option key is invalid or duplicated.');
      }
      seen.add(value);
      values.push({ value, label: localizedName(option.Names) ?? option.Key });
    }
    index.set(input.Key, {
      id: input.Key,
      name: localizedName(input.Names) ?? input.Key,
      values
    });
  }
  return index;
}

async function readJson<T>(path: string): Promise<T> {
  const text = await readBoundedText(path, MAX_JSON_BYTES, 'SMITHBOX_JSON_TOO_LARGE');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw sourceError('SMITHBOX_JSON_INVALID', 'Smithbox JSON metadata is invalid.');
  }
}

async function readBoundedText(path: string, maxBytes: number, code: string): Promise<string> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxBytes) {
    throw sourceError(code, 'Smithbox metadata file exceeds its supported size boundary.');
  }
  return await readFile(path, 'utf8');
}

function parseParamdefXml(xml: string): ParsedParamdef {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw sourceError('SMITHBOX_XML_DTD_FORBIDDEN', 'DTD and entity declarations are forbidden in Smithbox metadata.');
  }
  let paramType = '';
  let dataVersion = '';
  const fields: ParsedField[] = [];
  let currentField: ParsedField | undefined;
  let textTarget: string | undefined;
  let text = '';
  let parseFailure: Error | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    parseFailure = sourceError('SMITHBOX_XML_DTD_FORBIDDEN', 'DTD is forbidden in Smithbox metadata.');
  });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    if (tag.name === 'PARAMDEF') {
      const xmlVersion = attributeValue(tag, 'XmlVersion');
      if (xmlVersion !== '1' && xmlVersion !== '3') {
        parseFailure = sourceError('SMITHBOX_XML_VERSION_UNSUPPORTED', 'Smithbox PARAMDEF XmlVersion is unsupported.');
      }
      return;
    }
    if (tag.name === 'Field') {
      const def = attributeValue(tag, 'Def');
      if (!def) {
        parseFailure = sourceError('SMITHBOX_FIELD_DEF_MISSING', 'Smithbox PARAMDEF field is missing Def.');
        return;
      }
      currentField = { def };
      return;
    }
    if (['ParamType', 'DataVersion', 'DisplayName', 'Description', 'Minimum', 'Maximum', 'Enum']
      .includes(tag.name)) {
      textTarget = tag.name;
      text = '';
    }
  });
  parser.on('text', (value: string) => {
    if (textTarget) text += value;
  });
  parser.on('closetag', (tag: SaxesTagPlain) => {
    const value = text.trim();
    if (tag.name === textTarget) {
      if (tag.name === 'ParamType') paramType = value;
      else if (tag.name === 'DataVersion') dataVersion = value;
      else if (currentField && tag.name === 'DisplayName') currentField.displayName = value;
      else if (currentField && tag.name === 'Description') currentField.description = value;
      else if (currentField && tag.name === 'Minimum') currentField.minimum = value;
      else if (currentField && tag.name === 'Maximum') currentField.maximum = value;
      else if (currentField && tag.name === 'Enum') currentField.enumRef = value;
      textTarget = undefined;
      text = '';
    }
    if (tag.name === 'Field' && currentField) {
      fields.push(currentField);
      currentField = undefined;
    }
  });
  parser.on('error', (error: Error) => {
    parseFailure = error;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    parseFailure = error instanceof Error ? error : new Error('invalid XML');
  }
  if (parseFailure || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(paramType)
    || !/^\d+$/u.test(dataVersion) || fields.length === 0) {
    throw sourceError('SMITHBOX_PARAMDEF_XML_INVALID', 'Smithbox PARAMDEF XML is malformed.');
  }
  const version = Number(dataVersion);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw sourceError('SMITHBOX_PARAMDEF_XML_INVALID', 'Smithbox PARAMDEF data version is invalid.');
  }
  return { typeName: paramType, dataVersion: version, fields };
}

function attributeValue(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function projectParamdef(
  parsed: ParsedParamdef,
  annotations: Map<string, AnnotationField> | undefined,
  enumIndex: ReadonlyMap<string, ParamEnumDef>,
  refs: ParamMetaRefIndex | undefined
): {
  document: ParamDefDocument;
  resolvedEnumCount: number;
  unresolvedEnumCount: number;
  refFieldCount: number;
} {
  const state: FieldLayoutState = { byteOffset: 0, bitGroup: undefined };
  const fields: ParamFieldDef[] = [];
  const referencedEnums = new Set<string>();
  let refFieldCount = 0;
  for (const source of parsed.fields) {
    const match = FIELD_DEF.exec(source.def);
    if (!match) throw sourceError('SMITHBOX_FIELD_DEF_INVALID', 'Smithbox field Def grammar is unsupported.');
    const sourceType = match[1]!;
    const fieldId = match[2]!;
    const arrayLength = match[3] === undefined ? undefined : Number(match[3]);
    const bitWidth = match[4] === undefined ? undefined : Number(match[4]);
    const defaultValue = match[5] === undefined ? undefined : parseFiniteNumber(match[5]);
    const annotation = annotations?.get(fieldId);
    const scalar = projectScalar(sourceType, arrayLength, bitWidth);
    const placement = placeField(state, sourceType, scalar.size, bitWidth);
    const description = preferredOptionalText(annotation?.Description, source.description);
    const field: ParamFieldDef = {
      id: fieldId,
      name: preferredText(annotation?.Name, source.displayName, fieldId),
      type: scalar.type,
      offset: placement.offset,
      size: scalar.size,
      ...(placement.bitfield ? { bitfield: placement.bitfield } : {}),
      ...(description ? { description } : {})
    };
    const minimum = parseOptionalFiniteNumber(source.minimum);
    const maximum = parseOptionalFiniteNumber(source.maximum);
    applyCompatibleConstraints(field, minimum, maximum, defaultValue);
    if (source.enumRef && isIntegerScalar(field.type)) {
      field.enumRef = source.enumRef;
      referencedEnums.add(source.enumRef);
    }
    /*
     * 引用只挂在整数标量上。
     *
     * 引用的语义是「这个值是另一张表的行 id」，而行 id 是整数。挂到 f32 或字节块
     * 上会给出一个点得动但一定跳不到的入口 —— 用户会以为目标表缺行，而真正的问题
     * 是这个字段根本不是 id。位域字段仍然算整数（值域小，但确实有指向 id 的用法）。
     */
    const rawRefs = refs?.get(fieldId);
    if (rawRefs !== undefined && isIntegerScalar(field.type)) {
      field.refs = rawRefs;
      refFieldCount += 1;
    }
    fields.push(field);
  }
  flushBitGroup(state);

  let resolvedEnumCount = 0;
  let unresolvedEnumCount = 0;
  const enums = [...referencedEnums].sort(compareOrdinal)
    .map((enumId): ParamEnumDef => {
      const resolved = enumIndex.get(enumId);
      if (resolved) {
        resolvedEnumCount += 1;
        return resolved;
      }
      unresolvedEnumCount += 1;
      return { id: enumId, name: enumId, values: [] };
    });
  return {
    document: {
      schemaVersion: 1,
      typeName: parsed.typeName,
      version: parsed.dataVersion,
      rowDataSize: state.byteOffset,
      fields,
      ...(enums.length > 0 ? { enums } : {}),
      origin: 'imported',
      notes: 'Pinned Smithbox SDT local import; unresolved enum names remain value-opaque.'
    },
    resolvedEnumCount,
    unresolvedEnumCount,
    refFieldCount
  };
}

function projectScalar(
  sourceType: string,
  arrayLength: number | undefined,
  bitWidth: number | undefined
): { type: ParamFieldScalarType; size: number } {
  if (arrayLength !== undefined && (!Number.isSafeInteger(arrayLength) || arrayLength <= 0 || arrayLength > 65_536)) {
    throw sourceError('SMITHBOX_FIELD_ARRAY_INVALID', 'Smithbox field array length is invalid.');
  }
  if (bitWidth !== undefined && (!Number.isSafeInteger(bitWidth) || bitWidth <= 0)) {
    throw sourceError('SMITHBOX_FIELD_BIT_WIDTH_INVALID', 'Smithbox field bit width is invalid.');
  }
  if (arrayLength !== undefined) {
    if (bitWidth !== undefined) throw sourceError('SMITHBOX_FIELD_LAYOUT_INVALID', 'Array bitfields are unsupported.');
    if (sourceType === 'dummy8') return { type: 'bytes', size: arrayLength };
    if (sourceType === 'fixstr') return { type: 'fix', size: arrayLength };
    if (sourceType === 'fixstrW') return { type: 'bytes', size: arrayLength * 2 };
    throw sourceError('SMITHBOX_FIELD_ARRAY_TYPE_UNSUPPORTED', 'Smithbox scalar array type is unsupported.');
  }
  if (sourceType === 'dummy8') return bitWidth === undefined
    ? { type: 'bytes', size: 1 }
    : { type: 'u8', size: 1 };
  if (sourceType === 'fixstr' || sourceType === 'fixstrW') {
    throw sourceError('SMITHBOX_FIXED_STRING_LENGTH_MISSING', 'Smithbox fixed string is missing its capacity.');
  }
  if (sourceType === 'angle32') return { type: 'f32', size: 4 };
  if (sourceType === 'b32') return { type: 'u32', size: 4 };
  const scalar = sourceType as ParamFieldScalarType;
  const size = sourceType.endsWith('8') ? 1 : sourceType.endsWith('16') ? 2 : 4;
  return { type: scalar, size };
}

function placeField(
  state: FieldLayoutState,
  _sourceType: string,
  size: number,
  bitWidth: number | undefined
): { offset: number; bitfield?: { bitOffset: number; bitWidth: number } } {
  if (bitWidth === undefined) {
    flushBitGroup(state);
    const offset = state.byteOffset;
    state.byteOffset += size;
    return { offset };
  }
  const baseBits = size * 8;
  if (bitWidth > baseBits) {
    throw sourceError('SMITHBOX_FIELD_BIT_WIDTH_INVALID', 'Smithbox bitfield exceeds its scalar storage.');
  }
  if (!state.bitGroup
    || state.bitGroup.baseBytes !== size
    || state.bitGroup.usedBits + bitWidth > baseBits) {
    flushBitGroup(state);
    state.bitGroup = {
      baseBytes: size,
      startOffset: state.byteOffset,
      usedBits: 0
    };
  }
  const group = state.bitGroup;
  const result = {
    offset: group.startOffset,
    bitfield: { bitOffset: group.usedBits, bitWidth }
  };
  group.usedBits += bitWidth;
  if (group.usedBits === baseBits) flushBitGroup(state);
  return result;
}

function flushBitGroup(state: FieldLayoutState): void {
  if (!state.bitGroup) return;
  state.byteOffset = state.bitGroup.startOffset + state.bitGroup.baseBytes;
  state.bitGroup = undefined;
}

function applyCompatibleConstraints(
  field: ParamFieldDef,
  minimum: number | undefined,
  maximum: number | undefined,
  defaultValue: number | undefined
): void {
  if (field.type !== 'f32' && field.type !== 'f64' && !isIntegerScalar(field.type)) return;
  const intrinsic = INTEGER_RANGES[field.type];
  const minOk = minimum !== undefined
    && (intrinsic === undefined || (minimum >= intrinsic[0] && minimum <= intrinsic[1]));
  const maxOk = maximum !== undefined
    && (intrinsic === undefined || (maximum >= intrinsic[0] && maximum <= intrinsic[1]));
  if (minOk && maxOk && minimum! <= maximum!) {
    field.min = minimum;
    field.max = maximum;
  } else {
    if (minOk) field.min = minimum;
    if (maxOk) field.max = maximum;
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      delete field.min;
      delete field.max;
    }
  }
  const integerCompatible = !isIntegerScalar(field.type) || Number.isSafeInteger(defaultValue);
  const intrinsicCompatible = defaultValue !== undefined
    && (intrinsic === undefined || (defaultValue >= intrinsic[0] && defaultValue <= intrinsic[1]));
  const constraintCompatible = defaultValue !== undefined
    && (field.min === undefined || defaultValue >= field.min)
    && (field.max === undefined || defaultValue <= field.max);
  if (defaultValue !== undefined && integerCompatible && intrinsicCompatible && constraintCompatible) {
    field.defaultValue = defaultValue;
  }
}

function localizedName(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  const records = input.filter(isRecord);
  const preferred = records.find((item) => item.Language === 'English' && isNonEmptyText(item.Text))
    ?? records.find((item) => isNonEmptyText(item.Text));
  return preferred && typeof preferred.Text === 'string' ? preferred.Text.trim() : undefined;
}

function preferredText(primary: unknown, secondary: unknown, fallback: string): string {
  return preferredOptionalText(primary, secondary) ?? fallback;
}

function preferredOptionalText(primary: unknown, secondary: unknown): string | undefined {
  if (isNonEmptyText(primary)) return primary.trim();
  if (isNonEmptyText(secondary)) return secondary.trim();
  return undefined;
}

function isNonEmptyText(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0 && input.length <= 8_192;
}

function parseOptionalFiniteNumber(input: string | undefined): number | undefined {
  return input === undefined || input.trim() === '' ? undefined : parseFiniteNumber(input);
}

function parseFiniteNumber(input: string): number {
  const normalized = input.replaceAll(',', '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(normalized)) {
    throw sourceError('SMITHBOX_FIELD_NUMBER_INVALID', 'Smithbox field numeric metadata is invalid.');
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    throw sourceError('SMITHBOX_FIELD_NUMBER_INVALID', 'Smithbox field numeric metadata is not finite.');
  }
  return value;
}

function isIntegerScalar(type: ParamFieldScalarType): boolean {
  return type === 'u8' || type === 's8' || type === 'u16' || type === 's16'
    || type === 'u32' || type === 's32';
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function asDigest(value: string): ParamMetadataDigest {
  if (!isSha256(value)) throw sourceError('SMITHBOX_DIGEST_INVALID', 'Smithbox digest is invalid.');
  return `sha256:${value}`;
}

function isSha256(input: unknown): input is string {
  return typeof input === 'string' && /^[a-f0-9]{64}$/u.test(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function redactLocalDetails(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\s"']+/gu, '[local-path]')
    .replace(/\\\\[^\s"']+/gu, '[local-path]')
    .slice(0, 512);
}

class SmithboxSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SmithboxSourceError';
  }
}

function sourceError(code: string, message: string): SmithboxSourceError {
  return new SmithboxSourceError(code, message);
}
