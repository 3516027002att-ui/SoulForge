/**
 * 前端「会不会真的去读」的纯函数。
 *
 * App.tsx 曾经用 resourceKind（顶层目录名）决定 loadFmg/loadParam/…
 * 后缀对、目录不对时 Bridge 能读、界面是空的。
 * 这里改成与 workspaceFormatFamily / selectEditor 同一套路径口径。
 */

import { classifyWorkspaceOpen, type WorkspaceOpenKind } from '@soulforge/shared';
import { selectEditor, type EditorId, type SelectEditorInput } from './selectEditor.js';

export type ResourceOpenIpcMethod =
  | 'openResourcePreview'
  | 'readParamPage'
  | 'readFmgDocument'
  | 'readEmevdDocument'
  | 'readEmevdFullDocument'
  | 'readMsbDocument'
  | 'readGparamDocument'
  | 'readTaeDocument'
  | 'readEsdDocument'
  | 'readFlverDocument'
  | 'readTpfDocument'
  | 'readFxrDocument'
  | 'scriptContainerEvidence'
  | 'listContainerChildrenPage';

export interface ResourceOpenPlan {
  editorId: EditorId;
  openKind: WorkspaceOpenKind;
  ipcMethods: readonly ResourceOpenIpcMethod[];
}

export interface LoadGateFile {
  relativePath: string;
  resourceKind: string;
  formatKind: string;
  compoundExtension: string;
}

export function shouldLoadParam(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'param-rows';
}

export function shouldLoadFmg(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'fmg';
}

export function shouldLoadEmevd(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'emevd';
}

export function shouldLoadMsb(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'msb';
}

export function shouldLoadGparam(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'gparam';
}

export function shouldLoadTae(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'tae';
}

export function shouldLoadEsd(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'esd';
}

export function shouldLoadFlver(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'flver';
}

export function shouldLoadTpf(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'tpf';
}

export function shouldLoadFxr(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'vfx';
}

export function shouldLoadScript(file: LoadGateFile): boolean {
  return classifyWorkspaceOpen(file.relativePath).openKind === 'script';
}

const IPC_BY_KIND: Record<WorkspaceOpenKind, readonly ResourceOpenIpcMethod[]> = {
  'param-container': ['openResourcePreview', 'listContainerChildrenPage'],
  'param-rows': ['openResourcePreview', 'readParamPage'],
  gparam: ['openResourcePreview', 'readGparamDocument'],
  fmg: ['openResourcePreview', 'readFmgDocument'],
  // 打开事件文档只发一次 readEmevdFullDocument：它自带 outline（事件计数 +
  // 每事件未知指令数）与 authority，renderer 不再为这些标量另发一次
  // readEmevdDocument。那个 channel/preload 方法仍然保留（契约门禁与 preload
  // 面探针都要它），只是不在打开路径上。
  emevd: ['openResourcePreview', 'readEmevdFullDocument'],
  msb: ['openResourcePreview', 'readMsbDocument'],
  script: ['openResourcePreview', 'scriptContainerEvidence'],
  'plain-text': ['openResourcePreview'],
  tae: ['openResourcePreview', 'readTaeDocument'],
  esd: ['openResourcePreview', 'readEsdDocument'],
  flver: ['openResourcePreview', 'readFlverDocument'],
  tpf: ['openResourcePreview', 'readTpfDocument'],
  vfx: ['openResourcePreview', 'readFxrDocument'],
  container: ['openResourcePreview', 'listContainerChildrenPage'],
  history: ['openResourcePreview'],
  'blocked-no-parser': ['openResourcePreview'],
  'blocked-scope': ['openResourcePreview'],
  binary: ['openResourcePreview']
};

export function planResourceOpen(
  file: LoadGateFile,
  options: { previewKind?: string; textEditable?: boolean; bnd4Forced?: boolean } = {}
): ResourceOpenPlan {
  const family = classifyWorkspaceOpen(file.relativePath);
  const editorInput: SelectEditorInput = {
    centerView: 'resource',
    resourceMode: 'all',
    selectedFile: {
      relativePath: file.relativePath,
      resourceKind: file.resourceKind,
      formatKind: file.formatKind,
      compoundExtension: file.compoundExtension
    },
    ...(options.previewKind !== undefined ? { previewKind: options.previewKind } : {}),
    ...(options.textEditable !== undefined ? { textEditable: options.textEditable } : {}),
    ...(options.bnd4Forced !== undefined ? { bnd4Forced: options.bnd4Forced } : {})
  };
  return {
    editorId: selectEditor(editorInput),
    openKind: family.openKind,
    ipcMethods: IPC_BY_KIND[family.openKind]
  };
}
