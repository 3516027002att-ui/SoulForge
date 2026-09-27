import type { BridgeResult } from '@soulforge/shared';
import { runBridge, type RunBridgeOptions } from '../bridge/runBridge.js';

const MAX_ROW_SELECTIONS = 256;
const DEFAULT_INDEX_PAGE_SIZE = 512;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface ParamPagedReadOptions {
  sourcePath: string;
  allowedRoots: string[];
  workspaceSessionId?: string;
  /** Ephemeral refreshes use generation 0; the extracted child path is unique to the snapshot. */
  pathSourceGeneration?: number;
  /** Physical BND child identity, bound into the Bridge document-session cache key. */
  entryIdentity: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxFrameBytes?: number;
  expectedRowDataSize?: number;
  indexPageSize?: number;
  payloadBatchSize?: number;
  maxPayloadBytes?: number;
  maxRows?: number;
  onCancellationTerminal?: RunBridgeOptions['onCancellationTerminal'];
  resolveRowDataSize?: (header: {
    sourceHash: string;
    typeName: string;
    dataVersion: number;
  }) => Promise<number | undefined>;
  validateIdentity?: (identity: ParamPagedDocumentIdentity) => boolean | Promise<boolean>;
}

export interface ParamPagedDocumentIdentity {
  sourceHash: string;
  typeName: string;
  dataVersion: number;
  rowCount: number;
  rowDataSize: number;
  sessionToken: string;
  workspaceSessionId?: string;
  pathSourceGeneration: number;
}

export interface ParamPagedRowPayload {
  rowIndex: number;
  id: number;
  dataBase64: string;
  dataHash: string;
  name?: string;
}

export interface ParamPagedReadResult {
  ok: boolean;
  data?: ParamPagedDocumentIdentity;
  pagesRead: number;
  payloadBatchesRead: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

interface ParamReadEnvelope {
  sourceHash?: unknown;
  typeName?: unknown;
  dataVersion?: unknown;
  rowCount?: unknown;
  rowTotal?: unknown;
  rowDataSize?: unknown;
  rowPage?: unknown;
  rowPageSize?: unknown;
  rowPageCount?: unknown;
  returnedRowCount?: unknown;
  payloadsIncluded?: unknown;
  sessionToken?: unknown;
  workspaceSessionId?: unknown;
  pathSourceGeneration?: unknown;
  rows?: unknown;
}

interface ParamIndexRow {
  rowIndex: number;
  id: number;
  dataHash: string;
  name?: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bridgeDiagnostics<T>(result: BridgeResult<T>): Array<{ severity: string; code: string; message: string }> {
  return result.diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message
  }));
}

function isBridgeFailure<T>(result: BridgeResult<T>): boolean {
  return result.parseStatus === 'failed' || result.data === undefined || result.data === null;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error(typeof reason === 'string' ? reason : 'PARAM native read aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function resultFailure(
  code: string,
  message: string,
  pagesRead: number,
  payloadBatchesRead: number,
  causes: Array<{ severity: string; code: string; message: string }> = []
): ParamPagedReadResult {
  return {
    ok: false,
    pagesRead,
    payloadBatchesRead,
    diagnostics: causes.length > 0
      ? causes
      : [{ severity: 'error', code, message }]
  };
}

function validateDocumentIdentity(
  value: unknown,
  input: ParamPagedReadOptions,
  generation: number,
  expectedRowDataSize?: number
): { identity?: ParamPagedDocumentIdentity; code?: string; message?: string } {
  const data = readRecord(value) as ParamReadEnvelope | null;
  const sourceHash = nonEmptyString(data?.sourceHash);
  const typeName = nonEmptyString(data?.typeName);
  const dataVersion = safeInteger(data?.dataVersion);
  const rowCount = safeInteger(data?.rowCount);
  const rowTotal = safeInteger(data?.rowTotal);
  const rowDataSize = safeInteger(data?.rowDataSize);
  const sessionToken = nonEmptyString(data?.sessionToken);
  const workspaceSessionId = nonEmptyString(data?.workspaceSessionId);
  const pathSourceGeneration = safeInteger(data?.pathSourceGeneration);

  if (!sourceHash || !typeName || dataVersion === undefined || rowCount === undefined || rowCount < 0
    || rowTotal !== rowCount || rowDataSize === undefined || rowDataSize <= 0 || !sessionToken
    || pathSourceGeneration !== generation) {
    return {
      code: 'PARAM_PAGE_METADATA_INVALID',
      message: 'PARAM native index page 缺少合法来源、版本、行数、行宽或会话身份。'
    };
  }
  if (input.workspaceSessionId && workspaceSessionId !== input.workspaceSessionId) {
    return {
      code: 'PARAM_PAGE_WORKSPACE_MISMATCH',
      message: 'PARAM native index page 返回了不同的 workspace session。'
    };
  }
  if (expectedRowDataSize !== undefined && rowDataSize !== expectedRowDataSize) {
    return {
      code: 'PARAM_METADATA_ROW_WIDTH_MISMATCH',
      message: `PARAM native index row width ${rowDataSize} != trusted metadata width ${expectedRowDataSize}。`
    };
  }
  return {
    identity: {
      sourceHash,
      typeName,
      dataVersion,
      rowCount,
      rowDataSize,
      sessionToken,
      ...(workspaceSessionId ? { workspaceSessionId } : {}),
      pathSourceGeneration
    }
  };
}

function parseIndexRows(value: unknown, start: number, expectedCount: number): ParamIndexRow[] | null {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;
  const rows: ParamIndexRow[] = [];
  for (let offset = 0; offset < value.length; offset += 1) {
    const record = readRecord(value[offset]);
    const rowIndex = safeInteger(record?.rowIndex);
    const id = safeInteger(record?.id);
    const dataHash = nonEmptyString(record?.dataHash);
    const name = typeof record?.name === 'string' && record.name.length > 0 ? record.name : undefined;
    if (rowIndex !== start + offset || id === undefined || !dataHash) return null;
    rows.push({ rowIndex, id, dataHash, ...(name ? { name } : {}) });
  }
  return rows;
}

function consistentPageMetadata(
  data: unknown,
  identity: ParamPagedDocumentIdentity,
  requestedPage: number,
  pageSize: number,
  pageCount: number
): boolean {
  const record = readRecord(data) as ParamReadEnvelope | null;
  return safeInteger(record?.rowPage) === requestedPage
    && safeInteger(record?.rowPageSize) === pageSize
    && safeInteger(record?.rowPageCount) === pageCount
    && safeInteger(record?.rowCount) === identity.rowCount
    && safeInteger(record?.rowTotal) === identity.rowCount
    && safeInteger(record?.rowDataSize) === identity.rowDataSize
    && safeInteger(record?.dataVersion) === identity.dataVersion
    && nonEmptyString(record?.typeName) === identity.typeName
    && nonEmptyString(record?.sourceHash) === identity.sourceHash
    && nonEmptyString(record?.sessionToken) === identity.sessionToken
    && safeInteger(record?.pathSourceGeneration) === identity.pathSourceGeneration
    && (!identity.workspaceSessionId || nonEmptyString(record?.workspaceSessionId) === identity.workspaceSessionId);
}

function matchesIdentity(data: unknown, identity: ParamPagedDocumentIdentity): boolean {
  const record = readRecord(data) as ParamReadEnvelope | null;
  const rowTotal = safeInteger(record?.rowTotal);
  return safeInteger(record?.rowCount) === identity.rowCount
    && (rowTotal === undefined || rowTotal === identity.rowCount)
    && safeInteger(record?.rowDataSize) === identity.rowDataSize
    && safeInteger(record?.dataVersion) === identity.dataVersion
    && nonEmptyString(record?.typeName) === identity.typeName
    && nonEmptyString(record?.sourceHash) === identity.sourceHash
    && nonEmptyString(record?.sessionToken) === identity.sessionToken
    && safeInteger(record?.pathSourceGeneration) === identity.pathSourceGeneration
    && (!identity.workspaceSessionId || nonEmptyString(record?.workspaceSessionId) === identity.workspaceSessionId);
}

/**
 * Read one complete PARAM table through Bridge's lazy index and row-selection
 * API. The consumer receives only bounded payload batches; callers should hold
 * them only long enough to decode them and publish the export only after this
 * function returns `ok: true`.
 */
export async function readParamDocumentRowsPagedViaBridge(
  input: ParamPagedReadOptions,
  consumeBatch: (identity: ParamPagedDocumentIdentity, rows: readonly ParamPagedRowPayload[]) => void | Promise<void>,
  bridge: typeof runBridge = runBridge
): Promise<ParamPagedReadResult> {
  const pageSize = input.indexPageSize ?? DEFAULT_INDEX_PAGE_SIZE;
  const requestedPayloadBatchSize = input.payloadBatchSize ?? MAX_ROW_SELECTIONS;
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  const generation = input.pathSourceGeneration ?? 0;
  let pagesRead = 0;
  let payloadBatchesRead = 0;

  if (!Number.isSafeInteger(pageSize) || pageSize <= 0
    || !Number.isSafeInteger(requestedPayloadBatchSize) || requestedPayloadBatchSize <= 0
    || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0
    || !Number.isSafeInteger(maxRows) || maxRows <= 0
    || !Number.isSafeInteger(generation) || generation < 0
    || input.entryIdentity.trim() === '') {
    return resultFailure('PARAM_PAGED_READ_OPTIONS_INVALID', 'PARAM 分页读取参数无效。', pagesRead, payloadBatchesRead);
  }

  const read = async <T>(commandOptions: Record<string, unknown>): Promise<BridgeResult<T>> => bridge<T>({
    command: 'read-param-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    ...(input.workspaceSessionId ? { workspaceSessionId: input.workspaceSessionId } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
    maxConcurrency: 1,
    ...(input.onCancellationTerminal ? { onCancellationTerminal: input.onCancellationTerminal } : {}),
    commandOptions
  });

  const baseCommandOptions = {
    pathSourceGeneration: generation,
    entryIdentity: input.entryIdentity
  };
  const resolveTrustedWidth = input.resolveRowDataSize;
  let expectedRowDataSize = input.expectedRowDataSize;
  let firstPageResult: BridgeResult<ParamReadEnvelope>;
  try {
    abortIfRequested(input.signal);
    firstPageResult = await read<ParamReadEnvelope>({
      ...baseCommandOptions,
      ...(expectedRowDataSize !== undefined ? { expectedRowDataSize } : {}),
      includeRowPayloads: false,
      includeRowHashes: true,
      isPageRequest: true,
      rowPage: 0,
      rowPageSize: pageSize
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw error;
  }

  if (firstPageResult.parseStatus === 'failed'
    && firstPageResult.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_ROW_SIZE_REQUIRED')) {
    if (!resolveTrustedWidth) {
      return resultFailure(
        'PARAM_METADATA_ROW_WIDTH_UNRESOLVED',
        'PARAM 行宽需要可信 metadata；当前调用没有提供可信行宽解析器。',
        pagesRead,
        payloadBatchesRead,
        bridgeDiagnostics(firstPageResult)
      );
    }
    abortIfRequested(input.signal);
    const headerResult = await read<ParamReadEnvelope>({ ...baseCommandOptions, headerOnly: true });
    const header = readRecord(headerResult.data);
    const sourceHash = nonEmptyString(header?.sourceHash);
    const typeName = nonEmptyString(header?.typeName);
    const dataVersion = safeInteger(header?.dataVersion);
    if (isBridgeFailure(headerResult) || !sourceHash || !typeName || dataVersion === undefined) {
      return resultFailure(
        'PARAM_METADATA_HEADER_INVALID',
        'PARAM 头部没有足够的 native identity 来匹配可信行宽。',
        pagesRead,
        payloadBatchesRead,
        bridgeDiagnostics(headerResult)
      );
    }
    expectedRowDataSize = await resolveTrustedWidth({ sourceHash, typeName, dataVersion });
    if (!Number.isSafeInteger(expectedRowDataSize) || expectedRowDataSize! <= 0) {
      return resultFailure(
        'PARAM_METADATA_ROW_WIDTH_UNRESOLVED',
        'PARAM 头部未唯一匹配可信字段定义，拒绝推测单行数据边界。',
        pagesRead,
        payloadBatchesRead
      );
    }
    abortIfRequested(input.signal);
    firstPageResult = await read<ParamReadEnvelope>({
      ...baseCommandOptions,
      expectedRowDataSize,
      includeRowPayloads: false,
      includeRowHashes: true,
      isPageRequest: true,
      rowPage: 0,
      rowPageSize: pageSize
    });
    const retriedHeader = readRecord(firstPageResult.data);
    if (!isBridgeFailure(firstPageResult)
      && (nonEmptyString(retriedHeader?.sourceHash) !== sourceHash
        || nonEmptyString(retriedHeader?.typeName) !== typeName
        || safeInteger(retriedHeader?.dataVersion) !== dataVersion)) {
      return resultFailure(
        'PARAM_METADATA_READ_IDENTITY_MISMATCH',
        'PARAM lazy index 与 headerOnly 的 source hash、type name 或 data version 不一致。',
        pagesRead,
        payloadBatchesRead
      );
    }
  }

  if (isBridgeFailure(firstPageResult)) {
    const causes = bridgeDiagnostics(firstPageResult);
    return resultFailure(
      causes[0]?.code ?? 'PARAM_INDEX_PAGE_READ_FAILED',
      causes[0]?.message ?? 'PARAM native index page 读取失败。',
      pagesRead,
      payloadBatchesRead,
      causes
    );
  }

  const firstIdentity = validateDocumentIdentity(
    firstPageResult.data,
    input,
    generation,
    expectedRowDataSize
  );
  if (!firstIdentity.identity) {
    return resultFailure(
      firstIdentity.code ?? 'PARAM_PAGE_METADATA_INVALID',
      firstIdentity.message ?? 'PARAM native page identity 无效。',
      pagesRead,
      payloadBatchesRead
    );
  }
  const identity = firstIdentity.identity;
  if (identity.rowCount > maxRows) {
    return resultFailure(
      'PARAM_ROW_COUNT_LIMIT_EXCEEDED',
      `PARAM row count ${identity.rowCount} exceeds the native semantic limit ${maxRows}。`,
      pagesRead,
      payloadBatchesRead
    );
  }
  if (input.validateIdentity && !await input.validateIdentity(identity)) {
    return resultFailure(
      'PARAM_METADATA_DEFINITION_UNTRUSTED',
      `PARAM ${identity.typeName}/${identity.dataVersion}/${identity.rowDataSize} 没有严格匹配的可信字段定义。`,
      pagesRead,
      payloadBatchesRead
    );
  }
  const expectedPageCount = Math.max(1, Math.ceil(identity.rowCount / pageSize));
  const firstPage = readRecord(firstPageResult.data) as ParamReadEnvelope;
  const reportedPageCount = safeInteger(firstPage.rowPageCount);
  if (reportedPageCount !== expectedPageCount
    || safeInteger(firstPage.rowPage) !== 0
    || safeInteger(firstPage.rowPageSize) !== pageSize) {
    return resultFailure(
      'PARAM_PAGE_IDENTITY_MISMATCH',
      'PARAM native Bridge 返回页号、页大小或 page count 与请求不一致。',
      pagesRead,
      payloadBatchesRead
    );
  }

  const payloadBatchSize = Math.max(1, Math.min(
    MAX_ROW_SELECTIONS,
    requestedPayloadBatchSize,
    Math.floor((maxPayloadBytes * 3 / 4) / identity.rowDataSize) || 1
  ));
  let nextExpectedRowIndex = 0;

  for (let pageNumber = 0; pageNumber < expectedPageCount; pageNumber += 1) {
    abortIfRequested(input.signal);
    let pageResult = firstPageResult;
    if (pageNumber > 0) {
      pageResult = await read<ParamReadEnvelope>({
        ...baseCommandOptions,
        expectedRowDataSize: identity.rowDataSize,
        documentSession: identity.sessionToken,
        includeRowPayloads: false,
        includeRowHashes: true,
        isPageRequest: true,
        rowPage: pageNumber,
        rowPageSize: pageSize
      });
    }
    if (isBridgeFailure(pageResult)) {
      const causes = bridgeDiagnostics(pageResult);
      return resultFailure(
        causes[0]?.code ?? 'PARAM_INDEX_PAGE_READ_FAILED',
        causes[0]?.message ?? `PARAM native page ${pageNumber} 读取失败。`,
        pagesRead,
        payloadBatchesRead,
        causes
      );
    }
    if (!consistentPageMetadata(pageResult.data, identity, pageNumber, pageSize, expectedPageCount)) {
      return resultFailure(
        'PARAM_PAGE_IDENTITY_MISMATCH',
        `PARAM native page ${pageNumber} 与首���的 source/session/page metadata 不一致。`,
        pagesRead,
        payloadBatchesRead
      );
    }
    const start = pageNumber * pageSize;
    const expectedCount = Math.max(0, Math.min(pageSize, identity.rowCount - start));
    const envelope = readRecord(pageResult.data) as ParamReadEnvelope;
    if (safeInteger(envelope.returnedRowCount) !== expectedCount) {
      return resultFailure(
        'PARAM_PAGE_COVERAGE_MISMATCH',
        `PARAM native page ${pageNumber} 返回行数与预期覆盖范围不一致。`,
        pagesRead,
        payloadBatchesRead
      );
    }
    const indexRows = parseIndexRows(envelope.rows, start, expectedCount);
    if (!indexRows) {
      return resultFailure(
        'PARAM_PAGE_COVERAGE_MISMATCH',
        `PARAM native page ${pageNumber} 存在重复、缺失、跳号或无身份 hash 的物理行。`,
        pagesRead,
        payloadBatchesRead
      );
    }
    if (start !== nextExpectedRowIndex) {
      return resultFailure(
        'PARAM_PAGE_COVERAGE_MISMATCH',
        'PARAM native pages 没有从物理行 0 连续覆盖。',
        pagesRead,
        payloadBatchesRead
      );
    }

    for (let offset = 0; offset < indexRows.length; offset += payloadBatchSize) {
      abortIfRequested(input.signal);
      const indexBatch = indexRows.slice(offset, offset + payloadBatchSize);
      const rowSelections = indexBatch.map((row) => ({
        rowIndex: row.rowIndex,
        expectedId: row.id,
        expectedDataHash: row.dataHash
      }));
      const payloadResult = await read<ParamReadEnvelope>({
        ...baseCommandOptions,
        expectedRowDataSize: identity.rowDataSize,
        documentSession: identity.sessionToken,
        includeRowPayloads: true,
        includeRowHashes: true,
        rowSelections
      });
      if (isBridgeFailure(payloadResult)) {
        const causes = bridgeDiagnostics(payloadResult);
        return resultFailure(
          causes[0]?.code ?? 'PARAM_ROW_PAYLOAD_READ_FAILED',
          causes[0]?.message ?? 'PARAM native row payload batch 读取失败。',
          pagesRead,
          payloadBatchesRead,
          causes
        );
      }
      if (!matchesIdentity(payloadResult.data, identity)) {
        return resultFailure(
          'PARAM_ROW_IDENTITY_MISMATCH',
          'PARAM row payload batch 的来源、版本、行宽或 Bridge session 与 index page 不一致。',
          pagesRead,
          payloadBatchesRead
        );
      }
      const payloadEnvelope = readRecord(payloadResult.data) as ParamReadEnvelope;
      if (payloadEnvelope.payloadsIncluded !== true || !Array.isArray(payloadEnvelope.rows)
        || payloadEnvelope.rows.length !== indexBatch.length) {
        return resultFailure(
          'PARAM_ROW_IDENTITY_MISMATCH',
          'PARAM row payload batch 没有完整返回所选物理行。',
          pagesRead,
          payloadBatchesRead
        );
      }
      const payloadRows: ParamPagedRowPayload[] = [];
      for (let rowOffset = 0; rowOffset < indexBatch.length; rowOffset += 1) {
        const expected = indexBatch[rowOffset]!;
        const actual = readRecord(payloadEnvelope.rows[rowOffset]);
        const rowIndex = safeInteger(actual?.rowIndex);
        const id = safeInteger(actual?.id);
        const dataHash = nonEmptyString(actual?.dataHash);
        const dataBase64 = nonEmptyString(actual?.dataBase64);
        const name = typeof actual?.name === 'string' && actual.name.length > 0 ? actual.name : undefined;
        if (rowIndex !== expected.rowIndex || id !== expected.id
          || !dataHash || dataHash.toLowerCase() !== expected.dataHash.toLowerCase()
          || !dataBase64 || Buffer.from(dataBase64, 'base64').length !== identity.rowDataSize) {
          return resultFailure(
            'PARAM_ROW_IDENTITY_MISMATCH',
            `PARAM row payload physical identity 不匹配：rowIndex=${expected.rowIndex}。`,
            pagesRead,
            payloadBatchesRead
          );
        }
        payloadRows.push({
          rowIndex,
          id,
          dataBase64,
          dataHash,
          ...(name ? { name } : {})
        });
      }
      await consumeBatch(identity, payloadRows);
      payloadBatchesRead += 1;
      nextExpectedRowIndex += payloadRows.length;
      abortIfRequested(input.signal);
    }
    if (indexRows.length === 0) nextExpectedRowIndex = start;
    pagesRead += 1;
  }

  if (nextExpectedRowIndex !== identity.rowCount) {
    return resultFailure(
      'PARAM_PAGE_COVERAGE_MISMATCH',
      `PARAM native pages 覆盖 ${nextExpectedRowIndex}/${identity.rowCount} 行。`,
      pagesRead,
      payloadBatchesRead
    );
  }
  return { ok: true, data: identity, pagesRead, payloadBatchesRead, diagnostics: [] };
}
