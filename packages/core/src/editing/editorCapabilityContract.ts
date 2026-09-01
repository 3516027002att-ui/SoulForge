import type {
  DeferredPreviewEditorKind,
  EditorKind,
  EditorMutationKind
} from '@soulforge/shared';

export type EditorDocumentAuthorityContract =
  | 'raw-byte-document'
  | 'bridge-native-document'
  | 'text-document';

export type EditorScaleAccess =
  | 'pagination'
  | 'virtualization'
  | 'chunking'
  | 'streaming'
  | 'bounded-window'
  | 'eager'
  | 'none';

/**
 * Clamp a requested page into [0, pageCount) and return the served window.
 * Shared by every paginated editor access channel in the desktop main process
 * (`apps/desktop/src/main/ipc.ts`) and by the bounded-access acceptance smoke
 * (`runEditorBoundedAccessSmoke.ts`) so both sides always apply the same
 * windowing semantics (hard constraint 17). Out-of-range navigation fails
 * safely to the nearest valid page instead of returning empty pages.
 */
export function normalizePageWindow(
  total: number,
  requestedPage: number,
  pageSize: number
): { page: number; pageCount: number; offset: number; size: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  return { page, pageCount, offset: page * size, size };
}

/**
 * 当前编辑器能力清单中的 editor id。该类型只描述能力契约投影，
 * 不等同于 release Gate 已通过；真实 native authority、revision 校验、
 * Patch Engine 提交和 release 验收仍由各自运行链路负责。
 */
export type ProposedReleaseEditorId =
  | 'bnd4'
  | 'fmg'
  | 'param'
  | 'emevd'
  | 'script'
  | 'tae'
  | 'esd';

/**
 * 旧版 deferred-preview 字段的兼容形状。
 *
 * 当前能力契约不再用它限制 TAE/ESD；所有当前编辑器均以
 * `deferredPreview: null` 表示正常能力路径。保留该结构只为兼容旧的
 * renderer/诊断读取方，不能替代 `releaseWriteEnabled`、native authority、
 * revision 或 Patch Engine 门槛。
 */
export type DeferredPreviewEditorId = DeferredPreviewEditorKind;

export interface EditorDeferredPreviewContract {
  /** 仅保留旧协议字段，当前能力契约不会创建此对象。 */
  deferredToRelease: string;
  readOnly: true;
  markedAsPreview: true;
  countedAsReleaseEditor: false;
}

export interface EditorCapabilityContract {
  editorKind: EditorKind;
  proposedReleaseEditorId: ProposedReleaseEditorId | null;
  proposalOrder: number | null;
  documentAuthority: EditorDocumentAuthorityContract;
  /**
   * 已接线的 typed mutation 种类。它们描述当前实现能力；是否允许执行
   * 仍由 `releaseWriteEnabled` 与 native authority、revision、Patch Engine
   * 写链共同决定。
   */
  mutationKinds: readonly EditorMutationKind[];
  /**
   * 当前能力契约是否允许该编辑器进入 typed write path。该标志不是绕过
   * Patch Engine、native writer、revision/fail-closed 或 release Gate 的授权。
   */
  releaseWriteEnabled: boolean;
  /** 旧版兼容字段；当前可开发编辑器必须为 null。 */
  deferredPreview: EditorDeferredPreviewContract | null;
  revisionContract: 'monotonic-reject-stale';
  scalePrimitives: readonly EditorScaleAccess[];
  scaleAccess: EditorScaleAccess;
  scaleDimensions: readonly string[];
  contractSources: readonly string[];
}

/**
 * Single source for the editor capabilities enforced by EditorDocumentStore and
 * projected into the editor inventory. Scale access describes the current
 * implementation, including known non-release-safe bounded/eager views; it does
 * not by itself assert native verification or release completion.
 */
export const EDITOR_CAPABILITY_CONTRACTS: Readonly<Record<EditorKind, EditorCapabilityContract>> = {
  hex: {
    editorKind: 'hex',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'raw-byte-document',
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['pagination', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['bytes'],
    contractSources: [
      'packages/core/src/editing/hexDocument.ts',
      'packages/core/src/preview/openResourcePreview.ts'
    ]
  },
  bnd4: {
    editorKind: 'bnd4',
    proposedReleaseEditorId: 'bnd4',
    proposalOrder: 0,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    // 容器条目表经主进程分页通道 `resource.listContainerChildrenPage`
    // 按页访问（renderer 只持有一页子项），bounded 导航可覆盖完整条目表。
    scalePrimitives: ['pagination'],
    scaleAccess: 'pagination',
    scaleDimensions: ['entries', 'nested-containers'],
    contractSources: [
      'bridge/SoulForge.Bridge/Bnd4NativeDocument.cs',
      'bridge/SoulForge.Bridge/Bnd4NativeWriter.cs',
      'packages/core/src/editing/saveContainerChild.ts',
      'apps/desktop/src/main/ipc.ts',
      'packages/shared/src/container-workbench.ts'
    ]
  },
  fmg: {
    editorKind: 'fmg',
    proposedReleaseEditorId: 'fmg',
    proposalOrder: 1,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['fmg_entry_upsert', 'fmg_entry_delete', 'fmg_entry_add'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    // 条目列表经主进程分页通道 `resource.readFmgPage` 按页访问，
    // 查询在 main 端作用于完整条目表，导航可覆盖全部条目。
    scalePrimitives: ['pagination'],
    scaleAccess: 'pagination',
    scaleDimensions: ['entries'],
    contractSources: [
      'packages/core/src/editing/fmgBridgeCommit.ts',
      'apps/desktop/src/main/ipc.ts'
    ]
  },
  param: {
    editorKind: 'param',
    proposedReleaseEditorId: 'param',
    proposalOrder: 2,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['param_row_upsert', 'param_row_delete', 'param_field_set'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    // 行表经主进程分页通道 `resource.readParamPage` 按页访问，
    // 查询在 main 端作用于完整行表，导航可覆盖全部行。
    scalePrimitives: ['pagination'],
    scaleAccess: 'pagination',
    scaleDimensions: ['rows'],
    contractSources: [
      'packages/core/src/editing/paramBridgeCommit.ts',
      'packages/core/src/param/containerParamEdit.ts',
      'apps/desktop/src/main/ipc.ts',
      'bridge/SoulForge.Bridge/ParamNativeDocument.cs'
    ]
  },
  emevd: {
    editorKind: 'emevd',
    proposedReleaseEditorId: 'emevd',
    proposalOrder: 3,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['emevd_set_rest_behavior', 'emevd_update_id'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['pagination'],
    scaleAccess: 'pagination',
    scaleDimensions: ['events', 'instructions'],
    contractSources: [
      'packages/core/src/editing/emevdFourViewController.ts',
      'packages/core/src/editing/emevdBridgeCommit.ts',
      'packages/core/src/editing/emevdFullDocument.ts',
      'packages/core/src/emevd/dslRenderer.ts',
      'apps/desktop/src/main/ipc.ts'
    ]
  },
  msb: {
    editorKind: 'msb',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'bridge-native-document',
    // 已实现并经真实 MSB 验证过的 typed mutation。S36 开闸：write-msb 写链
    // 恢复放行（releaseWriteEnabled=true、deferredPreview=null），写入口经
    // 主进程 resource.applyMsbMutation → Patch Engine 提交。
    mutationKinds: ['msb_set_part_position', 'msb_set_part_transform'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['chunking', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['scene-entities', 'geometry-items', 'texture-items'],
    contractSources: [
      'packages/core/src/editing/msbBridgeRead.ts',
      'packages/core/src/editing/msbBridgeCommit.ts',
      'packages/shared/src/scene-ir.ts'
    ]
  },
  tae: {
    editorKind: 'tae',
    proposedReleaseEditorId: 'tae',
    proposalOrder: 5,
    documentAuthority: 'bridge-native-document',
    // TAE 已有 typed event upsert 实现：Bridge writer 只写 staging，
    // 最终提交仍必须经过 Patch Engine，并由 native reread/revision 失败关闭。
    mutationKinds: ['tae-event-upsert'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['animations', 'events', 'event-groups'],
    contractSources: [
      'bridge/SoulForge.Bridge/TaeNativeDocument.cs',
      'bridge/SoulForge.Bridge/TaeNativeWriter.cs',
      'packages/core/src/editing/taeBridgeCommit.ts',
      'packages/core/src/editing/taeEdit.ts'
    ]
  },
  esd: {
    editorKind: 'esd',
    proposedReleaseEditorId: 'esd',
    proposalOrder: 6,
    documentAuthority: 'bridge-native-document',
    // ESD 已有 typed behavior transition upsert 实现：原生 writer 只负责
    // staging/验证，实际资源写入仍由 Patch Engine 的统一事务完成。
    mutationKinds: ['behavior-transition-upsert'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['state-groups', 'states', 'conditions'],
    contractSources: [
      'bridge/SoulForge.Bridge/EsdNativeDocument.cs',
      'bridge/SoulForge.Bridge/EsdNativeWriter.cs',
      'packages/core/src/editing/esdBridgeCommit.ts'
    ]
  },
  script: {
    editorKind: 'script',
    proposedReleaseEditorId: 'script',
    proposalOrder: 4,
    documentAuthority: 'bridge-native-document',
    // 脚本为 Havok Script 编译字节码（`\x1bLuaQ`），当前不做 typed
    // mutation，只提供只读证据投影与经 Patch Engine 的整个内层文件替换，
    // 因此 mutationKinds 为空但 releaseWriteEnabled=true。
    // game-load 边界：整内层替换产物的结构/放位/magic 加载前置由
    // test:script-container-load-preflight 的 preflight 验证；真实游戏内加载需用户
    // 游戏内确认（opt-in，validation-unfrozen，SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED）。
    // 仓库不 ship 游戏启动自动化；真实游戏加载被自动验证前，script 的 authority
    // 必须保持 candidate，不得提升。
    mutationKinds: [],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    // 条目表经主进程分页通道 `resource.listScriptContainerEntriesPage`
    // 按页访问：main 一次性物化完整分类条目表并逐页投递，renderer 只持有一页，
    // 导航可覆盖全部条目（如 301 条目的真实 luabnd），不再依赖 256 条证据截断。
    scalePrimitives: ['pagination'],
    scaleAccess: 'pagination',
    scaleDimensions: ['container-entries', 'compiled-instructions'],
    contractSources: [
      'packages/core/src/editing/editorDocumentStore.ts',
      'packages/core/src/editing/saveContainerChild.ts',
      'packages/core/src/script/scriptContainerEvidence.ts',
      'apps/desktop/src/main/ipc.ts',
      'apps/desktop/src/preload/index.ts',
      'packages/shared/src/script-container.ts'
    ]
  },
  flver: {
    editorKind: 'flver',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'bridge-native-document',
    // MODEL-51C 写链已实现并经真实 FLVER 验证（write-flver material-slot-set）。
    // S38 开闸：releaseWriteEnabled=true、deferredPreview=null，写入口经主进程
    // resource.applyFlverMutation → Patch Engine 提交。mesh 越界 / no-op /
    // layoutWarnings 非空由 C# 侧 fail-closed 拒绝；未接线的字段（骨骼权重等）
    // 不开放写入口，不假装能编。
    mutationKinds: ['flver_material_slot_set'],
    releaseWriteEnabled: true,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['chunking', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['bones', 'materials', 'meshes', 'vertices'],
    contractSources: [
      'bridge/SoulForge.Bridge/FlverNativeDocument.cs',
      'bridge/SoulForge.Bridge/FlverNativeWriter.cs',
      'bridge/SoulForge.Bridge/TpfNativeDocument.cs',
      'packages/core/src/editing/flverBridgeCommit.ts'
    ]
  },
  text: {
    editorKind: 'text',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'text-document',
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['none'],
    scaleAccess: 'none',
    scaleDimensions: ['characters'],
    contractSources: ['packages/core/src/editing/editorDocumentStore.ts']
  },
  raw: {
    editorKind: 'raw',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'raw-byte-document',
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: null,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['none'],
    scaleAccess: 'none',
    scaleDimensions: ['bytes'],
    contractSources: ['packages/core/src/editing/editorDocumentStore.ts']
  }
};

export function editorAllowsMutation(
  editorKind: EditorKind,
  mutationKind: EditorMutationKind
): boolean {
  const contract = EDITOR_CAPABILITY_CONTRACTS[editorKind];
  // releaseWriteEnabled 是能力契约的第一道门；后续 writer 仍必须通过
  // native authority、revision/fail-closed 与 Patch Engine 事务链。
  if (!contract.releaseWriteEnabled) return false;
  const mutationKinds = contract.mutationKinds as readonly EditorMutationKind[];
  return mutationKinds.includes(mutationKind);
}

/**
 * 兼容旧 renderer/IPC 的延期查询。当前契约不再登记 deferred editor，
 * 因此正常返回 false；它不是当前写入能力的权威判断。
 */
export function isDeferredPreviewEditor(editorKind: EditorKind): boolean {
  return EDITOR_CAPABILITY_CONTRACTS[editorKind].deferredPreview !== null;
}

/**
 * 兼容旧调用方的延期清单。过渡期没有被该投影屏蔽的 editor kind，
 * 所以当前结果为空；写入仍由能力契约和统一安全写链决定。
 */
export function listDeferredPreviewEditors(): readonly EditorKind[] {
  return Object.values(EDITOR_CAPABILITY_CONTRACTS)
    .filter((contract) => contract.deferredPreview !== null)
    .map((contract) => contract.editorKind);
}
