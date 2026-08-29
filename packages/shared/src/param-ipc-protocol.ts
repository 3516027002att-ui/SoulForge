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

export interface OpenParamSessionResult {
  sessionToken: string;
  workspaceSessionId: string;
  sourceHash: string;
  pathSourceGeneration: number;
  rowCount: number;
  firstPage: {
    page: number;
    pageSize: number;
    rows: ParamIndexRow[];
  };
}

export interface ReadParamIndexPageRequest {
  sourceUri: string;
  sessionToken: string;
  page: number;
  pageSize: number;
}

export interface ParamIndexPage {
  sessionToken: string;
  rowCount: number;
  page: number;
  pageSize: number;
  rows: ParamIndexRow[];
}

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
  sessionToken: string;
  rows: ParamRowPayload[];
}

/**
 * selected-row 身份验证失败（rowIndex 越界 / id 不符 / dataHash 不符）。
 * 整批失败，禁止 partial success；错误负载只含 renderer-safe 字段。
 */
export const PARAM_ROW_IDENTITY_MISMATCH = 'PARAM_ROW_IDENTITY_MISMATCH';
