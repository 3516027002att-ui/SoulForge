/**
 * PARAM session IPC 协议（瘦路径，B3）。
 *
 * 权威不变量：
 *  - native authority 在 C# Bridge 的 `ParamDocumentSessionCache`（parse once →
 *    project many）；Electron main 只保存 opaque sessionToken 与轻量绑定元数据，
 *    不缓存完整 native PARAM document。
 *  - PARAM row 的物理身份是「rowIndex + id + dataHash」三元组：PARAM 的 row.id
 *    不保证全表唯一，任何按 id 单值定位行的 API 都是错误设计。
 *  - index 投影永不携带行字节（`ParamIndexRow` 禁止 dataBase64/rawBytes/fields
 *    等载荷字段）；行字节只经 `readRows` 按选中的物理身份返回。
 */

import type { ParamDefDocument, ParamEnumDef, ParamFieldDef } from './paramdef.js';
import type { Diagnostic } from './types.js';

/** Channel source of truth：main/preload 都从这里取，不得各自手写。 */
export const PARAM_SESSION_IPC_CHANNELS = {
  open: 'resource.openParamSession',
  readIndexPage: 'resource.readParamIndexPage',
  readRows: 'resource.readParamRows'
} as const;

/**
 * 单次 selected-row payload 请求的行数上限（B3.6）。仓库此前没有统一的
 * row-payload batch 上限，按施工图定义在此作为跨语言单一来源；C# 侧以行为
 * 验证契约对齐（同一数值）。
 */
export const PARAM_ROW_PAYLOAD_BATCH_MAX = 256;

/**
 * 物理行身份（B2.1）。读取/写入选中行时三者必须共同验证：
 *  - `rowIndex`：当前 native session 内的物理 row ordinal；
 *  - `id`：防止 rowIndex 对应行的语义已经改变；
 *  - `dataHash`：防止 session 数据过期、行被替换、duplicate ID 下选错行。
 */
export interface ParamPhysicalRowIdentity {
  rowIndex: number;
  id: number;
  dataHash: string;
}

/**
 * 轻量 index 行（B3.2）。性能不变量：不得包含 `dataBase64` / `rawBytes` /
 * `fields` / `decodedFields` / `payload` 等任何载荷字段。
 */
export interface ParamIndexRow {
  rowIndex: number;
  id: number;
  name: string | null;
  dataHash: string;
}

export interface OpenParamSessionRequest {
  sourceUri: string;
}

/**
 * 一次 open 返回的可信 schema 投影。它和 row index 同批返回，避免 renderer
 * 为了字段定义再发起一次「整表」读取。fieldDefs/fieldEnums 仍只是定义投影，
 * native PARAM 格式 authority 仍在 Bridge；fieldDefsTrusted 由 main 的信任链给出。
 */
export interface ParamSessionMetadata {
  typeName: string;
  rowDataSize: number;
  fieldDefs: ParamFieldDef[] | null;
  fieldEnums: ParamEnumDef[] | null;
  fieldDefsDiagnostic: { code: string; message: string } | null;
  fieldDefsOrigin: ParamDefDocument['origin'] | null;
  fieldDefsTrusted: boolean;
}

/** Bridge 已有 telemetry 的安全数值投影；计数是进程累计值，不是本地猜测。 */
export interface ParamNativeTelemetry {
  paramParse: number | null;
  paramDecodedRows: number | null;
  paramSessionOpen: number | null;
  paramStructuralValidation: number | null;
  paramSerializedRows: number | null;
}

export interface ParamSessionFailure {
  ok: false;
  diagnostics: Diagnostic[];
}

export interface OpenParamSessionSuccess {
  ok: true;
  sessionToken: string;
  workspaceSessionId: string;
  sourceHash: string;
  pathSourceGeneration: number;
  rowCount: number;
  metadata: ParamSessionMetadata;
  nativeTelemetry: ParamNativeTelemetry | null;
  firstPage: {
    page: number;
    pageSize: number;
    rows: ParamIndexRow[];
  };
  diagnostics: Diagnostic[];
}

export type OpenParamSessionResult = OpenParamSessionSuccess | ParamSessionFailure;

export interface ReadParamIndexPageRequest {
  sourceUri: string;
  sessionToken: string;
  page: number;
  pageSize: number;
}

export interface ParamIndexPage {
  ok: true;
  sessionToken: string;
  rowCount: number;
  page: number;
  pageSize: number;
  rows: ParamIndexRow[];
  nativeTelemetry: ParamNativeTelemetry | null;
  diagnostics: Diagnostic[];
}

export type ParamIndexPageResult = ParamIndexPage | ParamSessionFailure;

export interface ReadParamRowsRequest {
  sourceUri: string;
  sessionToken: string;
  rows: ParamPhysicalRowIdentity[];
}

export interface ParamRowPayload {
  identity: ParamPhysicalRowIdentity;
  dataBase64: string;
}

export interface ParamRowPayloadBatch {
  ok: true;
  sessionToken: string;
  rows: ParamRowPayload[];
  nativeTelemetry: ParamNativeTelemetry | null;
  diagnostics: Diagnostic[];
}

export type ParamRowPayloadBatchResult = ParamRowPayloadBatch | ParamSessionFailure;

/** Stable renderer/main key; PARAM id alone is intentionally insufficient. */
export function paramPhysicalRowKey(identity: ParamPhysicalRowIdentity): string {
  return JSON.stringify([identity.rowIndex, identity.id, identity.dataHash]);
}

/**
 * IPC-level materialization probe used by the renderer and regression smoke.
 * `selectedPayloadRowsObserved` counts payload rows actually returned by
 * readParamRows; it does not pretend to measure the native parser's internal
 * memory. That boundary is reported separately by ParamNativeTelemetry.
 */
export interface ParamSessionMaterializationSnapshot {
  rowCount: number;
  indexRowsObserved: number;
  selectedPayloadRowsObserved: number;
  unrequestedPayloadRows: number;
}

export interface ParamSessionMaterializationTracker {
  observeIndex(rows: readonly ParamIndexRow[]): void;
  observePayload(
    requested: readonly ParamPhysicalRowIdentity[],
    returned: readonly ParamRowPayload[]
  ): void;
  snapshot(): ParamSessionMaterializationSnapshot;
}

export function createParamSessionMaterializationTracker(
  rowCount: number
): ParamSessionMaterializationTracker {
  const normalizedRowCount = Number.isSafeInteger(rowCount) && rowCount >= 0 ? rowCount : 0;
  const indexRows = new Set<number>();
  const payloadRows = new Set<string>();
  let unrequestedPayloadRows = 0;
  return {
    observeIndex(rows) {
      for (const row of rows) indexRows.add(row.rowIndex);
    },
    observePayload(requested, returned) {
      const requestedKeys = new Set(requested.map(paramPhysicalRowKey));
      for (const row of returned) {
        const key = paramPhysicalRowKey(row.identity);
        if (!requestedKeys.has(key)) unrequestedPayloadRows += 1;
        payloadRows.add(key);
      }
    },
    snapshot() {
      return {
        rowCount: normalizedRowCount,
        indexRowsObserved: indexRows.size,
        selectedPayloadRowsObserved: payloadRows.size,
        unrequestedPayloadRows
      };
    }
  };
}

/**
 * selected-row 身份验证失败（rowIndex 越界 / id 不符 / dataHash 不符）。
 * 整批失败，禁止 partial success；错误负载只含 renderer-safe 字段。
 */
export const PARAM_ROW_IDENTITY_MISMATCH = 'PARAM_ROW_IDENTITY_MISMATCH';
