import { useMemo } from 'react';
import { classifyWorkspaceOpen } from '@soulforge/shared';
import type { GparamBankView } from '../workbench/GparamWorkbench.js';
import type { TpfContainerView } from '../editors/TpfWorkbenchPanel.js';
import type { MaterialFileView } from '../editors/MaterialWorkbenchPanel.js';
import type { VfxFileView } from '../editors/VfxWorkbenchPanel.js';
import { selectEditor } from '../workbench/selectEditor.js';
import { shouldShowEditorWelcome } from '../theme/editorWelcome.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { NavigationController, NavigationOptions } from './useNavigationController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { TextDocumentController } from './useTextDocumentController.js';

export interface EditorProjectionOptions extends Pick<NavigationOptions, 'files' | 'allFiles'> {
  navigation: Pick<NavigationController,
    'activeDomain' | 'centerView' | 'resourceMode' | 'bnd4Forced' | 'preferredParamContainer'>;
  document: Pick<ResourceDocumentController, 'selectedFile' | 'preview' | 'canEditText' | 'openTabs'>;
  workspace: Pick<NonNullable<NavigationOptions['workspace']>, 'workspaceSessionId'> | null;
  fmgLive: TextDocumentController['fmgLive'];
  bridge: Partial<Pick<NonNullable<RendererRuntime['bridge']>, 'readTextCatalog' | 'readFmgTablePage'>> | null;
}

/** Pure display selection. Keep App's original bounded legacy input to selectEditor. */
export function projectEditorSelection(options: EditorProjectionOptions) {
  const { activeDomain, centerView, resourceMode, bnd4Forced, preferredParamContainer } = options.navigation;
  const { selectedFile, preview, canEditText, openTabs } = options.document;
  const { workspace, fmgLive, bridge } = options;
  const activeEditor = selectEditor({
    centerView,
    resourceMode,
    selectedFile: selectedFile
      ? {
          relativePath: selectedFile.relativePath,
          resourceKind: selectedFile.resourceKind,
          formatKind: selectedFile.formatKind,
          compoundExtension: selectedFile.compoundExtension
        }
      : null,
    previewKind: preview?.previewKind,
    textEditable: canEditText,
    bnd4Forced
  });
  const showBnd4Workbench = activeEditor === 'container';
  const isMaterialFile = selectedFile !== null && /\.mtd$/i.test(selectedFile.relativePath) === true;
  const isVfxFile = selectedFile !== null
    && classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'vfx';
  const paramWorkbenchFile = activeEditor === 'param-container' && selectedFile
    ? selectedFile
    : activeDomain === 'param' && activeEditor === 'empty'
      ? preferredParamContainer
      : null;
  const showTextWorkbench = activeEditor === 'text'
    || (activeDomain === 'text' && activeEditor === 'empty' && workspace !== null);
  const fmgPanelLive = fmgLive
    || (activeDomain === 'text' && activeEditor === 'empty'
      && typeof bridge?.readTextCatalog === 'function'
      && typeof bridge?.readFmgTablePage === 'function');
  const showEventWorkbench = activeEditor === 'event'
    || (activeDomain === 'event' && activeEditor === 'empty' && workspace !== null);
  const showEditorWelcome = activeDomain !== 'project' && shouldShowEditorWelcome({
    hasWorkspace: workspace !== null,
    openTabCount: openTabs.length
  });
  return { activeEditor, showBnd4Workbench, isMaterialFile, isVfxFile, paramWorkbenchFile,
    showTextWorkbench, fmgPanelLive, showEventWorkbench, showEditorWelcome };
}

/** Pure index projection; suffix/classifier rules, order and allFiles precedence match App. */
export function projectIndexedAssets({ allFiles, files }: Pick<EditorProjectionOptions, 'allFiles' | 'files'>) {
  const indexed = allFiles.length > 0 ? allFiles : files;
  const gparamBanks: GparamBankView[] = indexed
    .filter((file) => /\.gparam(\.dcx)?$/i.test(file.relativePath))
    .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  const textureContainers: TpfContainerView[] = indexed
    .filter((file) => classifyWorkspaceOpen(file.relativePath).openKind === 'tpf')
    .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  const materialFiles: MaterialFileView[] = indexed
    .filter((file) => /\.mtd$/i.test(file.relativePath))
    .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  const vfxFiles: VfxFileView[] = indexed
    .filter((file) => classifyWorkspaceOpen(file.relativePath).openKind === 'vfx')
    .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  return { gparamBanks, textureContainers, materialFiles, vfxFiles };
}

/** Memoizes display lists only; document owners retain state, effects and bridge requests. */
export function useEditorProjection(options: EditorProjectionOptions) {
  const { allFiles, files } = options;
  const assets = useMemo(() => projectIndexedAssets({ allFiles, files }), [allFiles, files]);
  return { ...projectEditorSelection(options), ...assets };
}

export type EditorProjection = ReturnType<typeof useEditorProjection>;
