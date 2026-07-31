import type { EditorKind, EditorMutationKind } from '@soulforge/shared';

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

export type ProposedReleaseEditorId =
  | 'bnd4'
  | 'fmg'
  | 'param'
  | 'emevd'
  | 'msb'
  | 'tae'
  | 'esd'
  | 'script';

export interface EditorCapabilityContract {
  editorKind: EditorKind;
  proposedReleaseEditorId: ProposedReleaseEditorId | null;
  proposalOrder: number | null;
  documentAuthority: EditorDocumentAuthorityContract;
  mutationKinds: readonly EditorMutationKind[];
  revisionContract: 'monotonic-reject-stale';
  scalePrimitives: readonly EditorScaleAccess[];
  scaleAccess: EditorScaleAccess;
  scaleDimensions: readonly string[];
  contractSources: readonly string[];
}

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
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['pagination', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['bytes'],
    contractSources: [
      'packages/core/src/editing/hexDocument.ts',
      'packages/core/src/preview/openResourcePreview.ts',
      'apps/desktop/src/renderer/src/editors/HexEditorPanel.tsx'
    ]
  },
  bnd4: {
    editorKind: 'bnd4',
    proposedReleaseEditorId: 'bnd4',
    proposalOrder: 0,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['none'],
    scaleAccess: 'none',
    scaleDimensions: ['entries', 'nested-containers'],
    contractSources: [
      'bridge/SoulForge.Bridge/Bnd4NativeDocument.cs',
      'bridge/SoulForge.Bridge/Bnd4NativeWriter.cs',
      'packages/core/src/editing/saveContainerChild.ts'
    ]
  },
  fmg: {
    editorKind: 'fmg',
    proposedReleaseEditorId: 'fmg',
    proposalOrder: 1,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['fmg_entry_upsert', 'fmg_entry_delete'],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['entries'],
    contractSources: [
      'packages/core/src/editing/fmgBridgeCommit.ts',
      'apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.tsx'
    ]
  },
  param: {
    editorKind: 'param',
    proposedReleaseEditorId: 'param',
    proposalOrder: 2,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['param_row_upsert', 'param_row_delete'],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['pagination', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['rows'],
    contractSources: [
      'packages/core/src/editing/paramBridgeCommit.ts',
      'apps/desktop/src/renderer/src/editors/ParamTablePanel.tsx'
    ]
  },
  emevd: {
    editorKind: 'emevd',
    proposedReleaseEditorId: 'emevd',
    proposalOrder: 3,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['emevd_set_rest_behavior', 'emevd_update_id'],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['eager'],
    scaleAccess: 'eager',
    scaleDimensions: ['events', 'instructions'],
    contractSources: [
      'packages/core/src/editing/emevdFourViewController.ts',
      'packages/core/src/editing/emevdBridgeCommit.ts',
      'apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx'
    ]
  },
  msb: {
    editorKind: 'msb',
    proposedReleaseEditorId: 'msb',
    proposalOrder: 4,
    documentAuthority: 'bridge-native-document',
    mutationKinds: ['msb_set_part_position', 'msb_set_part_transform'],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['chunking', 'bounded-window'],
    scaleAccess: 'bounded-window',
    scaleDimensions: ['scene-entities', 'geometry-items', 'texture-items'],
    contractSources: [
      'packages/core/src/editing/msbBridgeRead.ts',
      'packages/core/src/editing/msbBridgeCommit.ts',
      'packages/shared/src/scene-ir.ts',
      'apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx'
    ]
  },
  tae: {
    editorKind: 'tae',
    proposedReleaseEditorId: 'tae',
    proposalOrder: 5,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
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
    proposedReleaseEditorId: 'esd',
    proposalOrder: 6,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
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
    proposalOrder: 7,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
    revisionContract: 'monotonic-reject-stale',
    scalePrimitives: ['none'],
    scaleAccess: 'none',
    scaleDimensions: ['source-lines', 'compiled-instructions'],
    contractSources: [
      'packages/core/src/editing/editorDocumentStore.ts',
      'packages/core/src/writers/textFileWriter.ts'
    ]
  },
  flver: {
    editorKind: 'flver',
    proposedReleaseEditorId: null,
    proposalOrder: null,
    documentAuthority: 'bridge-native-document',
    mutationKinds: [],
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
  const mutationKinds = EDITOR_CAPABILITY_CONTRACTS[editorKind]
    .mutationKinds as readonly EditorMutationKind[];
  return mutationKinds.includes(mutationKind);
}
