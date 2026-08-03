import { DEFERRED_PREVIEW_TARGET_RELEASE } from '@soulforge/shared';
import type {
  DeferredPreviewEditorKind,
  DeferredPreviewTargetRelease,
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
 * V0.5 冻结发布编辑器清单，与
 * `docs/V0_5_IMPLEMENTATION_HANDOFF.md` §18.2.1 `SCOPE-EDITORS.editorIds`
 * 逐项对应。msb/tae/esd/flver 已延期至 V0.6，只保留标记只读预览，
 * 因此不再出现在本联合类型中。
 */
export type ProposedReleaseEditorId =
  | 'bnd4'
  | 'fmg'
  | 'param'
  | 'emevd'
  | 'script';

/**
 * V0.5 延期为只读预览、目标里程碑 V0.6 的编辑器。
 * 清单本体在 `@soulforge/shared`，因为 renderer 也要在运行时读取它。
 */
export type DeferredPreviewEditorId = DeferredPreviewEditorKind;

export interface EditorDeferredPreviewContract {
  deferredToRelease: DeferredPreviewTargetRelease;
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
   * 已实现的 typed mutation 种类。保留实现事实，不代表本版放行：
   * 实际放行由 `releaseWriteEnabled` 决定。
   */
  mutationKinds: readonly EditorMutationKind[];
  /**
   * 本版是否允许该编辑器写入。延期为只读预览的编辑器必须为 false，
   * 使写路径在 store 层统一失败关闭，而不是靠 UI 自觉不调用。
   */
  releaseWriteEnabled: boolean;
  /** 非 null 表示该编辑器已延期，仅作标记只读预览。 */
  deferredPreview: EditorDeferredPreviewContract | null;
  revisionContract: 'monotonic-reject-stale';
  scalePrimitives: readonly EditorScaleAccess[];
  scaleAccess: EditorScaleAccess;
  scaleDimensions: readonly string[];
  contractSources: readonly string[];
}

const DEFERRED_TO_V06_READONLY_PREVIEW = {
  deferredToRelease: DEFERRED_PREVIEW_TARGET_RELEASE,
  readOnly: true,
  markedAsPreview: true,
  countedAsReleaseEditor: false
} as const satisfies EditorDeferredPreviewContract;

/**
 * Single source for the editor capabilities enforced by EditorDocumentStore and
 * projected into the release-acceptance inventory. Scale access describes the
 * current implementation, including known non-release-safe bounded/eager views.
 */
export const EDITOR_CAPABILITY_CONTRACTS = {
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
    // 已实现并经真实 MSB 验证过的 typed mutation。V0.5 延期为只读预览，
    // 因此 releaseWriteEnabled=false，写路径在 store 层失败关闭；
    // V0.6 恢复时只需把该标记翻回 true，无需重建写链。
    mutationKinds: ['msb_set_part_position', 'msb_set_part_transform'],
    releaseWriteEnabled: false,
    deferredPreview: DEFERRED_TO_V06_READONLY_PREVIEW,
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
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: DEFERRED_TO_V06_READONLY_PREVIEW,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['animations', 'events', 'event-groups'],
    contractSources: [
      'bridge/SoulForge.Bridge/TaeNativeDocument.cs'
    ]
  },
  esd: {
    editorKind: 'esd',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: DEFERRED_TO_V06_READONLY_PREVIEW,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['state-groups', 'states', 'conditions'],
    contractSources: [
      'bridge/SoulForge.Bridge/EsdNativeDocument.cs'
    ]
  },
  script: {
    editorKind: 'script',
    proposedReleaseEditorId: 'script',
    proposalOrder: 4,
    documentAuthority: 'bridge-native-document',
    // 脚本为 Havok Script 编译字节码（`\x1bLuaQ`），V0.5 不做 typed
    // mutation，只提供只读证据投影与经 Patch Engine 的整个内层文件替换，
    // 因此 mutationKinds 为空但 releaseWriteEnabled=true。
    // game-load 边界：整内层替换产物的结构/放位/magic 加载前置由
    // test:script-container-game-load 的 preflight 验证；真实游戏内加载需用户
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
    mutationKinds: [],
    releaseWriteEnabled: false,
    deferredPreview: DEFERRED_TO_V06_READONLY_PREVIEW,
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['chunking', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['bones', 'materials', 'meshes', 'vertices'],
    contractSources: [
      'bridge/SoulForge.Bridge/FlverNativeDocument.cs',
      'bridge/SoulForge.Bridge/TpfNativeDocument.cs'
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
} as const satisfies Record<EditorKind, EditorCapabilityContract>;

export function editorAllowsMutation(
  editorKind: EditorKind,
  mutationKind: EditorMutationKind
): boolean {
  const contract = EDITOR_CAPABILITY_CONTRACTS[editorKind];
  // 延期为只读预览的编辑器即使已实现 typed mutation 也不得在本版写入，
  // 否则会出现冻结清单外的可写编辑器（违反 REL-F 与硬约束 7）。
  if (!contract.releaseWriteEnabled) return false;
  const mutationKinds = contract.mutationKinds as readonly EditorMutationKind[];
  return mutationKinds.includes(mutationKind);
}

/**
 * 该编辑器是否已延期为标记只读预览（V0.6 交付）。
 * 以能力契约为准，是写入放行的权威判断；shared 的
 * `isDeferredPreviewEditorKind` 是给 renderer 的同源投影。
 */
export function isDeferredPreviewEditor(editorKind: EditorKind): boolean {
  return EDITOR_CAPABILITY_CONTRACTS[editorKind].deferredPreview !== null;
}

/**
 * 延期只读预览编辑器清单，供 UI 打标与 IPC 写路径拒绝时复用，
 * 避免各处各写一份硬编码列表。
 */
export function listDeferredPreviewEditors(): readonly EditorKind[] {
  return Object.values(EDITOR_CAPABILITY_CONTRACTS)
    .filter((contract) => contract.deferredPreview !== null)
    .map((contract) => contract.editorKind);
}
