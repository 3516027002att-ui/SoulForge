/**
 * 原生语义 mutation 的统一写链。
 *
 * 为什么要它：FMG / PARAM / PARAM-field / EMEVD / MSB 五条 IPC handler 各自
 * 写了一遍同样的五步（Bridge 暂存 → 读回字节 → Patch Engine 提交 → 需要确认时
 * 取确认并重试 → 成功后刷新投影），共约 540 行，逐字重复的部分占绝大多数。
 * 真实差异只有四处：Bridge 提交函数、暂存文件名前缀、操作标题、成功后要失效
 * 哪个缓存。把这四处做成参数，其余全部收敛。
 *
 * 为什么放在 core 而不是 apps/desktop：写链属于编辑领域逻辑，不属于 Electron
 * 传输层。留在 IPC 里的后果已经能看到——同一处 staging 诊断归一逻辑被复制了
 * 五遍，任何一遍漏改都不会有测试发现。
 *
 * 为什么确认要注入而不是直接调 dialog：core 不能依赖 electron（否则 core 的
 * 单元测试要跑在 Electron 里，node 测试直接失败）。确认是**能力**而非实现，
 * 因此表达成 confirmPort：Electron 侧传原生对话框实现，测试侧传确定性桩。
 *
 * 边界：本服务不自己写文件。所有 Mod 资源写入仍然只经由注入的 commitWrite
 * （生产实现是 saveRawReplace → PatchIR → WorkspaceTransaction），暂存只写
 * 调用方给定的 stagingRoot。本服务不放宽任何 writer 门槛，也不吞异常：
 * 失败一律返回结构化诊断。
 */

import { createHash } from 'node:crypto';
import type {
  ConfirmationReceipt,
  Diagnostic,
  EditorPageQuery,
  IndexedFile,
  ReadOperationId,
  WriteOperationId
} from '@soulforge/shared';
import { stageBridgeOutput, type BridgeStagingDiagnostic } from './bridgeStaging.js';
import type { SaveRawResourceResult } from './saveRawResource.js';
import type { NativeDocumentLocator } from './nativeDocumentLocator.js';

// ---------------------------------------------------------------------------
// §14.4 locator → 编辑器能力（DOCSTORE-04）
//
// 把 Bridge-confirmed 格式栈投影成 renderer 可见的 read/write operation id。
// 读能力按 leafFormatId/containerRole 映射到分页查询；写能力映射到
// EditorMutation kind（WriteOperationId 与 kind 同名，一一对应）。这层判定
// 是 store.apply 的 capability-blocked 判据来源，也是 OpenEditorDocumentValue
// 里 readOperations/writeOperations 的声明点。
// ---------------------------------------------------------------------------

const READ_OPERATION_FOR_QUERY = {
  'param-tables': 'page-tables',
  'param-rows': 'page-rows',
  'param-fields': 'page-fields',
  'gparam-groups': 'page-banks',
  'gparam-fields': 'page-groups',
  'fmg-entries': 'page-entries',
  'event-outline': 'read-outline',
  'container-entries': 'page-entries',
  'script-symbols': 'read-metadata',
  'resource-tree': 'page-entries',
  'properties': 'read-properties'
} as const satisfies Record<EditorPageQuery['kind'], ReadOperationId>;

const WRITE_OPS_BY_LEAF: Record<string, readonly WriteOperationId[]> = {
  param: ['param-field-set', 'param-row-upsert', 'param-row-delete'],
  gparam: ['gparam-field-set'],
  fmg: ['fmg-entry-upsert', 'fmg-entry-delete'],
  emevd: ['emevd-source-change'],
  msb: ['map-entity-upsert', 'map-entity-delete'],
  flver: ['flver-material-slot-set'],
  tpf: ['tpf-texture-replace'],
  mtd: ['material-property-set'],
  matbin: ['material-property-set'],
  fxr: ['vfx-field-set'],
  esd: ['behavior-transition-upsert'],
  tae: ['tae-event-upsert']
} as const;

const READ_OPS_BY_LEAF: Record<string, readonly ReadOperationId[]> = {
  param: ['page-tables', 'page-rows', 'page-fields', 'read-properties'],
  gparam: ['page-banks', 'page-groups'],
  fmg: ['page-entries', 'read-source'],
  emevd: ['read-outline', 'read-source'],
  msb: ['page-entries', 'read-preview'],
  flver: ['read-preview'],
  tpf: ['read-preview'],
  mtd: ['read-properties'],
  matbin: ['read-properties'],
  fxr: ['read-preview'],
  esd: ['read-outline'],
  tae: ['read-source'],
  'lua-source': ['read-metadata', 'read-source'],
  'lua-bytecode': ['read-metadata', 'read-source'],
  'hks-bytecode': ['read-metadata', 'read-source']
} as const;

/** bnd4 容器按 containerRole 判定域（BND4 本身只有 bnd4-child-replace）。 */
const WRITE_OPS_BY_BND_ROLE: Record<string, readonly WriteOperationId[]> = {
  'gameparam-binder': ['param-field-set', 'param-row-upsert', 'param-row-delete'],
  'drawparam-binder': ['gparam-field-set'],
  'msg-binder': ['fmg-entry-upsert', 'fmg-entry-delete'],
  'script-binder': ['script-plaintext-change'],
  'generic-binder': ['bnd4-child-replace']
} as const;

const READ_OPS_BY_BND_ROLE: Record<string, readonly ReadOperationId[]> = {
  'gameparam-binder': ['page-tables', 'page-rows', 'page-fields', 'read-properties'],
  'drawparam-binder': ['page-banks', 'page-groups'],
  'msg-binder': ['page-entries', 'read-source'],
  'script-binder': ['read-metadata', 'read-source'],
  'generic-binder': ['page-entries', 'read-preview']
} as const;

/**
 * 由 Bridge-confirmed locator 派生编辑器读写能力（§14.4 OpenEditorDocumentValue
 * 的 readOperations/writeOperations）。bnd4 容器层的域由 containerRole 裁定；
 * 松散文件按 leafFormatId 裁定；未知组合返回空集合（capability-blocked）。
 */
export function mutationCapabilityForLocator(locator: NativeDocumentLocator): {
  readOperations: readonly ReadOperationId[];
  writeOperations: readonly WriteOperationId[];
} {
  // 容器 bnd4 文档的 leafDocumentStableId 是 'bnd4-root'（无 confirmed child）
  // 或 'bnd4:{index}:{hash}'（有 child）；loose 文件是 'loose:{format}'。
  const leaf = locator.leafDocumentStableId === 'bnd4-root'
    || locator.leafDocumentStableId.startsWith('bnd4:')
    ? 'bnd4'
    : locator.layers[locator.layers.length - 1]?.formatId ?? 'unknown';
  if (leaf === 'bnd4') {
    const role = locator.containerRole;
    return {
      readOperations: READ_OPS_BY_BND_ROLE[role] ?? [],
      writeOperations: WRITE_OPS_BY_BND_ROLE[role] ?? []
    };
  }
  return {
    readOperations: READ_OPS_BY_LEAF[leaf] ?? [],
    writeOperations: WRITE_OPS_BY_LEAF[leaf] ?? []
  };
}

export function readOperationForQuery(queryKind: EditorPageQuery['kind']): ReadOperationId {
  return READ_OPERATION_FOR_QUERY[queryKind];
}

/** decoder/数据源用：EditorMutation kind 是 WriteOperationId 的子集（同名）。 */
export function isWriteOperationEnabled(
  writeOperations: readonly WriteOperationId[],
  mutationKind: string
): boolean {
  return writeOperations.includes(mutationKind as WriteOperationId);
}

/**
 * 确认能力端口。
 *
 * 返回 null 表示用户取消——必须与「确认失败」区分：取消是正常结果，
 * 不能报成写入错误，否则 UI 会把用户主动取消显示成故障。
 */
export interface WriteConfirmationPort {
  requestConfirmation(input: {
    resourceLabel: string;
    sourceUri: string;
    actionLabel: string;
    /** 待写字节的 sha256。确认凭据绑定它，防止确认后内容被替换。 */
    payloadHash: string;
    extraSubjects?: string[];
  }): Promise<ConfirmationReceipt | null>;
}

/** Patch Engine 提交端口。生产实现包装 saveRawReplace。 */
export interface RawReplaceCommitPort {
  commit(input: {
    file: IndexedFile;
    expectedHash: string;
    newContentBase64: string;
    title: string;
    confirmation?: ConfirmationReceipt;
  }): Promise<SaveRawResourceResult>;
}

export interface NativeMutationStagingContext {
  outputPath: string;
  allowedRoots: string[];
  writableRoots: string[];
}

export interface NativeMutationRequest<T extends { ok: boolean }> {
  file: IndexedFile;
  sourceUri: string;
  expectedHash: string;
  /** 暂存目录前缀与文件名，会被 bridgeStaging 做安全段校验。 */
  stagingPrefix: string;
  stagingFileName: string;
  stagingRoot: string;
  allowedRoots: (stagingRoot: string) => string[];
  /** 真正调用 Bridge 写出 mutation 结果的函数。各格式唯一的实质差异。 */
  stageWrite: (context: NativeMutationStagingContext) => Promise<T>;
  /** 操作日志与备份标题，例如 `FMG mutation upsert 12345`。 */
  title: string;
  /** 确认对话框里显示的动作名，例如「提交 FMG 变更」。 */
  confirmActionLabel: string;
  confirmExtraSubjects?: string[];
}

export type NativeMutationOutcome =
  | { status: 'committed'; result: SaveRawResourceResult; payloadHash: string }
  | { status: 'cancelled'; sourceUri: string }
  | { status: 'failed'; diagnostics: Diagnostic[] };

/**
 * staging 失败诊断归一。
 *
 * 三个来源都必须覆盖，且顺序不能变：bridgeStaging 自身的阶段诊断优先，
 * 其次是 Bridge 命令结果里的诊断，最后才是兜底。缺最后一档会在两者都为空时
 * 返回空诊断数组——那等于静默失败，正是硬约束禁止的。
 */
function normalizeStagingDiagnostics(
  staged: { diagnostics: BridgeStagingDiagnostic[]; result?: unknown },
  sourceUri: string
): Diagnostic[] {
  const fromStaging = staged.diagnostics.length > 0 ? staged.diagnostics : null;
  const fromResult = !fromStaging
    && staged.result
    && typeof staged.result === 'object'
    && 'diagnostics' in staged.result
    && Array.isArray((staged.result as { diagnostics: unknown }).diagnostics)
    ? (staged.result as { diagnostics: Array<{ severity: string; code: string; message: string }> })
      .diagnostics
    : null;
  const source = fromStaging ?? fromResult ?? [{
    severity: 'error' as const,
    code: 'BRIDGE_STAGING_FAILED',
    message: 'Bridge 暂存失败。'
  }];
  return source.map((entry) => ({
    severity: entry.severity as Diagnostic['severity'],
    code: entry.code,
    message: entry.message,
    sourceUri
  }));
}

/**
 * 执行一次原生语义 mutation 的完整写链。
 *
 * 确认重试只做一次：`requiresConfirmation` 是门槛而非重试信号，循环重试会把
 * 「凭据不被接受」变成无限弹窗。第二次仍要求确认则如实返回该结果。
 */
export async function applyNativeMutation<T extends { ok: boolean }>(
  request: NativeMutationRequest<T>,
  ports: { confirm: WriteConfirmationPort; commit: RawReplaceCommitPort }
): Promise<NativeMutationOutcome> {
  const staged = await stageBridgeOutput({
    stagingRoot: request.stagingRoot,
    allowedRoots: request.allowedRoots,
    prefix: request.stagingPrefix,
    fileName: request.stagingFileName,
    write: request.stageWrite
  });
  if (!staged.ok) {
    return { status: 'failed', diagnostics: normalizeStagingDiagnostics(staged, request.sourceUri) };
  }

  const bytes = staged.bytes;
  const newContentBase64 = bytes.toString('base64');
  const payloadHash = createHash('sha256').update(bytes).digest('hex');

  let result = await ports.commit.commit({
    file: request.file,
    expectedHash: request.expectedHash,
    newContentBase64,
    title: request.title
  });

  if (!result.ok && result.requiresConfirmation) {
    const confirmation = await ports.confirm.requestConfirmation({
      resourceLabel: request.file.relativePath,
      sourceUri: request.sourceUri,
      actionLabel: request.confirmActionLabel,
      payloadHash,
      ...(request.confirmExtraSubjects ? { extraSubjects: request.confirmExtraSubjects } : {})
    });
    if (!confirmation) return { status: 'cancelled', sourceUri: request.sourceUri };
    result = await ports.commit.commit({
      file: request.file,
      expectedHash: request.expectedHash,
      newContentBase64,
      title: request.title,
      confirmation
    });
  }

  return { status: 'committed', result, payloadHash };
}
