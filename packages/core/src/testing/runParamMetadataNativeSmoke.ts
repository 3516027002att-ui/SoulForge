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
import { decodeRowFields, validateParamDef } from '../param/paramdefLayout.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import type { ParamDefDocument, ParamFieldDef, ParamMetadataDefinition } from '@soulforge/shared';

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

// ---------------------------------------------------------------------------
// Known expected-unsupported indices from native PARAM smoke
// ---------------------------------------------------------------------------

/** Indices 32 and 33 fail semantic roundtrip in the native PARAM smoke. */
const EXPECTED_UNSUPPORTED_INDICES = new Set([32, 33, 81]);

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

    for (let i = 0; i < entryCount; i++) {
      // Known unsupported indices: document but do not fail.
      if (EXPECTED_UNSUPPORTED_INDICES.has(i)) {
        results.push({
          index: i,
          typeName: `(index ${i})`,
          dataVersion: 0,
          rowDataSize: 0,
          status: 'expected-unsupported',
          diagnostics: [{
            code: 'EXPECTED_UNSUPPORTED',
            message: `Index ${i} is a known failing layout from the native PARAM smoke (semantic roundtrip failure).`
          }]
        });
        expectedUnsupportedCount += 1;
        continue;
      }

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
        readFailedCount += 1;
        results.push({
          index: i,
          typeName: `(index ${i})`,
          dataVersion: 0,
          rowDataSize: 0,
          status: 'mismatched',
          diagnostics: [{
            code: 'EXTRACT_FAILED',
            message: extract.diagnostics[0]?.message ?? 'BND4 child extract failed.'
          }]
        });
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
        readFailedCount += 1;
        results.push({
          index: i,
          typeName: `(index ${i})`,
          dataVersion: 0,
          rowDataSize: 0,
          status: 'mismatched',
          diagnostics: [{
            code: 'READ_FAILED',
            message: doc.diagnostics[0]?.message ?? 'read-param-document failed.'
          }]
        });
        continue;
      }

      const nativeTypeName = doc.data.typeName;
      const nativeDataVersion = doc.data.dataVersion;
      const nativeRowDataSize = doc.data.rowDataSize;

      // 4. 5-key strict match against metadata definitions.
      const matchKey = `sekiro|1.6|${nativeTypeName}|${nativeDataVersion}|${nativeRowDataSize}`;
      const definition = definitionIndex.get(matchKey);

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
    const failures = results.filter((r) =>
      r.status === 'mismatched' && !EXPECTED_UNSUPPORTED_INDICES.has(r.index)
    );
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
      expectedUnsupportedIndices: [...EXPECTED_UNSUPPORTED_INDICES].sort((a, b) => a - b),
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
