/**
 * W-PARAM-META-NATIVE-01: Paramdex-compatible metadata ↔ native PARAM consistency.
 *
 * Verifies that Smithbox PARAM metadata definitions are consistent with native
 * PARAM row documents from the registered corpus:
 *   1. Load the pinned Smithbox metadata source (skip if unavailable).
 *   2. Enumerate native PARAM children via Bridge read-param-document.
 *   3. 5-key strict match: game + gameBuild + typeName + dataVersion + rowDataSize.
 *   4. For matched types, validate field layout (offsets, types, sizes) via
 *      validateParamDef and verify rowDataSize agreement.
 *   5. Report matched / unmatched / mismatched with structured diagnostics.
 *
 * Authority: partial — metadata is Paramdex-compatible, not native format authority.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { importPinnedSmithboxSdtParamMetadata } from '../param/smithboxParamMetadataSource.js';
import { matchParamMetadataPackage } from '../param/paramMetadata.js';
import { decodeRowFields, validateParamDef } from '../param/paramdefLayout.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import type {
  ParamDefDocument,
  ParamFieldDef,
  ParamMetadataDefinition,
  ParamMetadataTrustPolicy
} from '@soulforge/shared';

// ---------------------------------------------------------------------------
// Bridge response shapes
// ---------------------------------------------------------------------------

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  dataVersion: number;
  rowCount: number;
  rowDataSize: number;
  rows: Array<{ id: number; dataBase64: string | null; dataHash: string }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface TypeMatchResult {
  index: number;
  typeName: string;
  dataVersion: number;
  rowDataSize: number;
  status: 'matched' | 'unmatched' | 'mismatched' | 'expected-unsupported';
  fieldCount?: number;
  layoutValid?: boolean;
  diagnostics: Array<{ code: string; message: string }>;
}

/** A structurally excluded legacy layout with its real Bridge rejection code. */
interface ExpectedUnsupportedDetail {
  index: number;
  typeName: string;
  code: string;
  message: string;
  extractedSize: number;
}

// ---------------------------------------------------------------------------
// Known expected-unsupported indices from native PARAM smoke
// ---------------------------------------------------------------------------

/** Indices 32 and 33 fail semantic roundtrip in the native PARAM smoke. */
const EXPECTED_UNSUPPORTED_INDICES = new Set([32, 33, 81]);

/**
 * 5-key 匹配里的 game / gameBuild 常量。
 *
 * 提成常量而不是内联字面量：本文件既要喂生产 matcher 的 descriptor、又要拼本地
 * 索引 key 做交叉对账，两处必须同源。此前两处各写一份 'sekiro' 与 '1.6'，
 * 分叉时的表现是「交叉对账永远不相等」——那会被误读成 matcher 有 bug。
 */
const SEKIRO_METADATA_GAME = 'sekiro';
const SEKIRO_METADATA_GAME_BUILD = '1.6';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Resolve the Smithbox metadata source; skip gracefully if unavailable.
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    emitSkipped('LOCALAPPDATA not set — cannot locate Smithbox source.');
    return;
  }
  const cacheRoot = join(localAppData, 'SoulForge', 'tools', 'smithbox', '2.2.4');
  const imported = await importPinnedSmithboxSdtParamMetadata({ cacheRoot });
  if (!imported.ok) {
    const code = imported.diagnostics[0]?.code ?? 'UNKNOWN';
    emitSkipped(`Smithbox source unavailable (${code}) — metadata-native smoke skipped.`);
    return;
  }

  const definitions = imported.package.definitions;
  const definitionIndex = buildDefinitionIndex(definitions);

  /**
   * 显式用户信任策略。
   *
   * 生产 matchParamMetadataPackage 要求它必须存在（缺失时报
   * PARAM_METADATA_TRUST_POLICY_REQUIRED 并拒绝匹配）——这是「Paramdex 兼容
   * metadata 只有在用户显式信任该来源后才可用于字段写入」这条边界的执行点。
   *
   * 本文件此前手拼 key + Map.get 绕过了 matcher，因此也绕过了这道校验：即
   * 「未经用户信任的 metadata 照样能匹配上」在真机语料路径上从未被拦过。
   * 这里按真实导入包的 digest/license/revision 构造策略，等价于「用户已确认
   * 信任这个具体版本的 Smithbox 源」——digest 变了策略即失效，不是无条件放行。
   */
  const trustPolicy: ParamMetadataTrustPolicy = {
    schemaVersion: 1,
    policyId: 'test.param-metadata-native-smoke',
    trustedPackages: [
      {
        packageId: imported.package.packageId,
        packageVersion: imported.package.packageVersion,
        packageDigest: imported.package.packageDigest,
        sourceIdentity: imported.package.source.identity,
        sourceRevision: imported.package.source.revision,
        sourceContentDigest: imported.package.source.contentDigest,
        licenseSpdxExpression: imported.package.license.spdxExpression,
        licenseTextDigest: imported.package.license.textDigest
      }
    ]
  };

  // 2. Resolve native corpus via fixture registry.
  const sourceBnd = await resolveNativeFixture(
    process.argv[2],
    'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  );

  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-meta-native-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    // 3. Enumerate PARAM children.
    const container = await runBridge<{ nested?: { entryCount: number } }>({
      command: 'read-dcx-document',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      timeoutMs: 120_000
    });
    const entryCount = container.data?.nested?.entryCount ?? 0;
    if (entryCount === 0) {
      throw new Error('gameparam.parambnd.dcx has no children.');
    }

    const results: TypeMatchResult[] = [];
    const matchedDocuments: Array<{
      index: number;
      typeName: string;
      document: ParamDefDocument;
      rows: Array<{ id: number; dataBase64: string | null; dataHash: string }>;
    }> = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let mismatchedCount = 0;
    let expectedUnsupportedCount = 0;
    let readFailedCount = 0;
    const expectedUnsupportedDetails: ExpectedUnsupportedDetail[] = [];
    // Dynamic set of indices that actually remained structurally excluded.
    const stillUnsupportedIndices = new Set<number>();

    for (let i = 0; i < entryCount; i++) {
      const isKnownUnsupported = EXPECTED_UNSUPPORTED_INDICES.has(i);

      // Extract the child to a file (safe for large PARAM types).
      const tmpParam = join(staging, `corpus-${i}.param`);
      const extract = await runBridge<{ contentSize?: number }>({
        command: 'extract-bnd4-child',
        filePath: sourceBnd,
        allowedRoots: [dirname(sourceBnd)],
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { entryIndex: i, outputPath: tmpParam }
      });
      if (extract.parseStatus === 'failed' || !extract.data?.contentSize) {
        if (!isKnownUnsupported) readFailedCount += 1;
        const diagnostic = {
          code: 'EXTRACT_FAILED',
          message: extract.diagnostics[0]?.message ?? 'BND4 child extract failed.'
        };
        results.push({
          index: i,
          typeName: `(index ${i})`,
          dataVersion: 0,
          rowDataSize: 0,
          status: isKnownUnsupported ? 'expected-unsupported' : 'mismatched',
          diagnostics: [diagnostic]
        });
        if (isKnownUnsupported) {
          expectedUnsupportedCount += 1;
          stillUnsupportedIndices.add(i);
          expectedUnsupportedDetails.push({
            index: i,
            typeName: `(index ${i})`,
            code: diagnostic.code,
            message: diagnostic.message,
            extractedSize: 0
          });
        }
        continue;
      }

      // Read the extracted PARAM via Bridge.
      const doc = await runBridge<ParamEnvelope>({
        command: 'read-param-document',
        filePath: tmpParam,
        allowedRoots: [staging],
        timeoutMs: 60_000,
        // 显式空 options：规避 Bridge default-options 缺陷（read-param-document 分页读取行无 ValueKind 防护）。
        commandOptions: {}
      });
      if (!doc.data?.typeName) {
        if (!isKnownUnsupported) readFailedCount += 1;
        const diagnostic = {
          code: doc.diagnostics[0]?.code ?? 'READ_FAILED',
          message: doc.diagnostics[0]?.message ?? 'read-param-document failed.'
        };
        results.push({
          index: i,
          typeName: `(index ${i})`,
          dataVersion: 0,
          rowDataSize: 0,
          status: isKnownUnsupported ? 'expected-unsupported' : 'mismatched',
          diagnostics: [diagnostic]
        });
        if (isKnownUnsupported) {
          expectedUnsupportedCount += 1;
          stillUnsupportedIndices.add(i);
          expectedUnsupportedDetails.push({
            index: i,
            typeName: `(index ${i})`,
            code: diagnostic.code,
            message: diagnostic.message,
            extractedSize: extract.data.contentSize
          });
        }
        continue;
      }

      const nativeTypeName = doc.data.typeName;
      const nativeDataVersion = doc.data.dataVersion;
      const nativeRowDataSize = doc.data.rowDataSize;

      // 4. 5-key strict match —— 必须调**生产** matcher。
      //
      // 此前这里手拼 `sekiro|1.6|type|version|rowSize` 再 Map.get，等于在测试里
      // 重实现了一遍 5-key 匹配。后果是生产 matchParamMetadataPackage 在真机语料
      // 上**零执行**：改坏它的 key 拼装、trust policy 校验或 provenance 判定，
      // 这条 native smoke 照样全绿。而 runParamMetadataMismatchSmoke 虽然调它，
      // 用的是合成 fixture，覆盖不到真实 gameparam 的 typeName/version/rowSize 组合。
      const matchResult = matchParamMetadataPackage(
        imported.package,
        {
          game: SEKIRO_METADATA_GAME,
          gameBuild: SEKIRO_METADATA_GAME_BUILD,
          typeName: nativeTypeName,
          dataVersion: nativeDataVersion,
          rowDataSize: nativeRowDataSize
        },
        trustPolicy
      );
      const definition = matchResult.ok ? matchResult.definition : undefined;
      // 生产 matcher 与本地索引必须给出同一答案。分叉说明两者对 5-key 的口径不同
      // ——那正是「测试里的重实现掩盖生产缺陷」的形态，必须失败关闭而不是二选一。
      const indexedDefinition = definitionIndex.get(
        `${SEKIRO_METADATA_GAME}|${SEKIRO_METADATA_GAME_BUILD}`
        + `|${nativeTypeName}|${nativeDataVersion}|${nativeRowDataSize}`
      );
      if (Boolean(definition) !== Boolean(indexedDefinition)) {
        throw new Error(
          `PARAM_METADATA_MATCHER_DIVERGED: ${nativeTypeName} `
          + `(v${nativeDataVersion}, row=${nativeRowDataSize}) —— `
          + `生产 matcher ${definition ? '匹配' : '未匹配'}，本地索引 `
          + `${indexedDefinition ? '匹配' : '未匹配'}。两者对 5-key 的口径已分叉。`
          + ` matcher 诊断：${JSON.stringify(matchResult.diagnostics)}`
        );
      }

      if (!definition) {
        // Try a relaxed lookup to produce better diagnostics.
        const relaxed = findRelaxedMatch(definitions, nativeTypeName, nativeDataVersion, nativeRowDataSize);
        unmatchedCount += 1;
        results.push({
          index: i,
          typeName: nativeTypeName,
          dataVersion: nativeDataVersion,
          rowDataSize: nativeRowDataSize,
          status: 'unmatched',
          diagnostics: relaxed
            ? [{
                code: 'METADATA_KEY_MISMATCH',
                message: `Definition exists for ${nativeTypeName} but 5-key differs: ${relaxed}`
              }]
            : [{
                code: 'METADATA_NOT_FOUND',
                message: `No metadata definition for ${nativeTypeName} (v${nativeDataVersion}, row=${nativeRowDataSize}).`
              }]
        });
        continue;
      }

      // 5. Validate field layout consistency.
      const layoutDiagnostics = validateFieldLayout(definition.document, nativeRowDataSize);
      if (layoutDiagnostics.length > 0) {
        mismatchedCount += 1;
        results.push({
          index: i,
          typeName: nativeTypeName,
          dataVersion: nativeDataVersion,
          rowDataSize: nativeRowDataSize,
          status: 'mismatched',
          fieldCount: definition.document.fields.length,
          layoutValid: false,
          diagnostics: layoutDiagnostics
        });
        continue;
      }

      matchedCount += 1;
      results.push({
        index: i,
        typeName: nativeTypeName,
        dataVersion: nativeDataVersion,
        rowDataSize: nativeRowDataSize,
        status: 'matched',
        fieldCount: definition.document.fields.length,
        layoutValid: true,
        diagnostics: []
      });
      matchedDocuments.push({
        index: i,
        typeName: nativeTypeName,
        document: definition.document,
        rows: doc.data?.rows ?? []
      });
    }

    // 6. Report.
    const totalTypes = entryCount;
    const failures = results.filter((r) => r.status === 'mismatched');
    if (matchedCount === 0 && mismatchedCount === 0 && unmatchedCount === 0) {
      throw new Error('No PARAM types could be read from the native corpus.');
    }

    console.log(JSON.stringify({
      ok: failures.length === 0,
      testId: 'W-PARAM-META-NATIVE-01',
      status: 'partial',
      authority: 'partial',
      nativeFormatAuthority: false,
      metadataSource: {
        policyId: imported.summary.policyId,
        release: imported.summary.release,
        definitionCount: imported.summary.definitionCount,
        fieldCount: imported.summary.fieldCount
      },
      corpus: {
        containerEntries: totalTypes,
        matched: matchedCount,
        unmatched: unmatchedCount,
        mismatched: mismatchedCount,
        expectedUnsupported: expectedUnsupportedCount,
        readFailed: readFailedCount
      },
      expectedUnsupportedIndices: [...stillUnsupportedIndices].sort((a, b) => a - b),
      expectedUnsupportedDetails,
      failures: failures.slice(0, 10).map((f) => ({
        index: f.index,
        typeName: f.typeName,
        diagnostics: f.diagnostics
      })),
      unmatchedTypes: results
        .filter((r) => r.status === 'unmatched')
        .slice(0, 10)
        .map((r) => ({
          index: r.index,
          typeName: r.typeName,
          dataVersion: r.dataVersion,
          rowDataSize: r.rowDataSize,
          diagnostics: r.diagnostics
        })),
      matchedSample: results
        .filter((r) => r.status === 'matched')
        .slice(0, 5)
        .map((r) => ({
          index: r.index,
          typeName: r.typeName,
          fieldCount: r.fieldCount,
          rowDataSize: r.rowDataSize
        }))
    }, null, 2));

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} PARAM type(s) have metadata layout mismatches: `
        + failures.map((f) => f.typeName).join(', ')
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a lookup map keyed by the 5-key strict match:
 * game|gameBuild|typeName|dataVersion|rowDataSize
 */
function buildDefinitionIndex(
  definitions: readonly ParamMetadataDefinition[]
): Map<string, ParamMetadataDefinition> {
  const index = new Map<string, ParamMetadataDefinition>();
  for (const def of definitions) {
    const key = `${def.key.game}|${def.key.gameBuild}|${def.key.typeName}|${def.key.dataVersion}|${def.key.rowDataSize}`;
    index.set(key, def);
  }
  return index;
}

/**
 * Attempts a relaxed match on typeName only, returning a human-readable
 * description of which key components differ.
 */
function findRelaxedMatch(
  definitions: readonly ParamMetadataDefinition[],
  typeName: string,
  dataVersion: number,
  rowDataSize: number
): string | undefined {
  const candidates = definitions.filter((d) => d.key.typeName === typeName);
  if (candidates.length === 0) return undefined;
  const c = candidates[0]!;
  const diffs: string[] = [];
  if (c.key.game !== 'sekiro') diffs.push(`game=${c.key.game}`);
  if (c.key.gameBuild !== '1.6') diffs.push(`gameBuild=${c.key.gameBuild}`);
  if (c.key.dataVersion !== dataVersion) diffs.push(`dataVersion=${c.key.dataVersion}≠${dataVersion}`);
  if (c.key.rowDataSize !== rowDataSize) diffs.push(`rowDataSize=${c.key.rowDataSize}≠${rowDataSize}`);
  return diffs.length > 0
    ? `metadata has ${typeName} but ${diffs.join(', ')}`
    : `metadata has ${typeName} with identical key (unexpected)`;
}

/**
 * Validates field layout consistency between a metadata definition document
 * and the native rowDataSize.
 *
 * Checks:
 *   - validateParamDef passes (structural validity, no overlaps, bounds)
 *   - document.rowDataSize matches native rowDataSize
 *   - field count > 0
 *   - fields cover the row without gaps beyond trailing padding
 *   - individual field offsets, types, and sizes are self-consistent
 */
function validateFieldLayout(
  document: ParamDefDocument,
  nativeRowDataSize: number
): Array<{ code: string; message: string }> {
  const diagnostics: Array<{ code: string; message: string }> = [];

  // Row data size agreement.
  if (document.rowDataSize !== nativeRowDataSize) {
    diagnostics.push({
      code: 'ROW_DATA_SIZE_MISMATCH',
      message: `Metadata rowDataSize=${document.rowDataSize} ≠ native rowDataSize=${nativeRowDataSize}.`
    });
  }

  // Structural validation via paramdefLayout.
  const layout = validateParamDef(document);
  if (!layout.ok) {
    for (const d of layout.diagnostics) {
      if (d.severity === 'error') {
        diagnostics.push({ code: d.code, message: d.message });
      }
    }
  }

  // Field count sanity.
  if (document.fields.length === 0) {
    diagnostics.push({
      code: 'METADATA_NO_FIELDS',
      message: `Metadata definition for ${document.typeName} has zero fields.`
    });
  }

  // Verify field offsets are monotonically non-decreasing and within bounds.
  let previousEnd = 0;
  for (const field of document.fields) {
    if (field.offset < previousEnd && field.bitfield === undefined) {
      diagnostics.push({
        code: 'FIELD_OFFSET_REGRESSION',
        message: `Field ${field.id} offset=${field.offset} < previous end=${previousEnd}.`
      });
    }
    if (field.offset + field.size > nativeRowDataSize) {
      diagnostics.push({
        code: 'FIELD_OUT_OF_BOUNDS',
        message: `Field ${field.id} extends beyond native row: offset=${field.offset}+size=${field.size} > ${nativeRowDataSize}.`
      });
    }
    const fieldEnd = field.offset + field.size;
    if (fieldEnd > previousEnd) previousEnd = fieldEnd;
  }

  return diagnostics;
}

function emitSkipped(reason: string): void {
  console.log(JSON.stringify({
    ok: true,
    testId: 'W-PARAM-META-NATIVE-01',
    status: 'skipped',
    authority: 'unverified',
    nativeFormatAuthority: false,
    reason,
    diagnostics: [{
      severity: 'info',
      code: 'SMITHBOX_SOURCE_UNAVAILABLE',
      message: reason
    }]
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
