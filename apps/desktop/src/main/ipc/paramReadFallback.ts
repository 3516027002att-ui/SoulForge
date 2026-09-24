import type { BridgeResult } from '@soulforge/shared';
import {
  runBridge,
  type BridgeRunner,
  type RunBridgeOptions
} from '@soulforge/core';

export interface ParamNativeHeaderIdentity {
  sourceHash: string;
  typeName: string;
  dataVersion: number;
}

type ParamReadOptions = Omit<RunBridgeOptions, 'command'> & {
  commandOptions: Record<string, unknown>;
};

type ParamNativeHeader = Partial<ParamNativeHeaderIdentity>;
type ParamNativeDocumentIdentity = ParamNativeHeader & {
  rowDataSize?: number;
};

function hasNonEmptyIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Re-run a PARAM read when the native parser cannot prove a single-row data
 * boundary from adjacent rows.  The first-party metadata resolver is only a
 * width hint here; the Bridge still performs the authoritative structural
 * read and returns the final source identity.
 */
export async function readParamDocumentWithMetadataFallback<T>(
  input: ParamReadOptions,
  resolveRowDataSize: (header: ParamNativeHeaderIdentity) => Promise<number | undefined>,
  bridge: BridgeRunner = runBridge
): Promise<BridgeResult<T>> {
  const read = (commandOptions: Record<string, unknown>) => bridge<T>({
    ...input,
    command: 'read-param-document',
    commandOptions
  });

  let result = await read(input.commandOptions);
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_ROW_SIZE_REQUIRED')) {
    return result;
  }

  const headerResult = await read({ headerOnly: true });
  const header = headerResult.data as ParamNativeHeader | undefined;
  if (headerResult.parseStatus === 'failed'
    || !header
    || !hasNonEmptyIdentity(header.sourceHash)
    || !hasNonEmptyIdentity(header.typeName)
    || typeof header.dataVersion !== 'number'
    || !Number.isSafeInteger(header.dataVersion)) {
    return {
      ...result,
      diagnostics: [...result.diagnostics, ...headerResult.diagnostics]
    };
  }

  const width = await resolveRowDataSize({
    sourceHash: header.sourceHash,
    typeName: header.typeName,
    dataVersion: header.dataVersion
  });
  if (width === undefined || !Number.isSafeInteger(width) || width <= 0) {
    return {
      ...result,
      diagnostics: [
        ...result.diagnostics,
        {
          severity: 'error',
          code: 'PARAM_METADATA_ROW_WIDTH_UNRESOLVED',
          message: '原生 PARAM 头部未唯一匹配可信字段定义，不能推测单行数据边界。',
          sourceUri: result.sourceUri
        }
      ]
    };
  }

  result = await read({ ...input.commandOptions, expectedRowDataSize: width });
  if (result.parseStatus === 'failed') return result;

  const document = result.data as ParamNativeDocumentIdentity | undefined;
  if (!document
    || !hasNonEmptyIdentity(document.sourceHash)
    || !hasNonEmptyIdentity(document.typeName)
    || typeof document.dataVersion !== 'number'
    || !Number.isSafeInteger(document.dataVersion)
    || document.sourceHash !== header.sourceHash
    || document.typeName !== header.typeName
    || document.dataVersion !== header.dataVersion
    || document.rowDataSize !== width) {
    // Do not let a late read from a different source revision be consumed as
    // metadata-decoded PARAM data.  Drop the payload and mark the envelope
    // failed so every current caller's existing failure gate closes.
    const { data: _discarded, ...withoutData } = result;
    return {
      ...withoutData,
      parseStatus: 'failed',
      diagnostics: [
        ...result.diagnostics,
        {
          severity: 'error',
          code: 'PARAM_METADATA_READ_IDENTITY_MISMATCH',
          message: 'PARAM 完整读取与头部的来源、类型、版本或可信行宽不一致。',
          sourceUri: result.sourceUri
        }
      ]
    };
  }
  return result;
}
