/**
 * Renderer-safe container workbench DTOs (BND4 工作台).
 *
 * Projection of `packages/core/src/containers/containerIr.ts` types for the
 * renderer. Absolute path fields (`rootPath`, ...) are stripped in the preload
 * before these cross the context bridge; URIs stay file:// logical URIs.
 *
 * `bytes` is a plain Uint8Array on the renderer side (Electron serializes
 * Node Buffer as Uint8Array over IPC); the renderer never touches Node Buffer.
 */

import type { Diagnostic } from './types.js';

export interface RendererContainerChild {
  childId: string;
  name?: string;
  offset: number;
  size: number;
  compressedSize?: number;
  hash: string;
  formatKind: string;
  sourceContainerUri: string;
  childUri: string;
  rawBytesAvailable: boolean;
  canReplace: boolean;
  nestedFormat?: string;
}

export interface RendererContainerNodeSummary {
  uri: string;
  format: string;
  authority: string;
  magic: string;
  size: number;
  hash: string;
  childCount: number;
  canListChildren: boolean;
  canReadChild: boolean;
  canReplaceChild: boolean;
  canRepackContainer: boolean;
  containerRoundTripSafe: boolean;
  decompressionStatus: string;
  compressionStatus: string;
}

export interface RendererContainerTreeSummary {
  ok: boolean;
  rootUri?: string;
  root?: RendererContainerNodeSummary;
  diagnostics: Diagnostic[];
}

export interface RendererContainerChildrenList {
  ok: boolean;
  children: RendererContainerChild[];
  diagnostics: Diagnostic[];
}

export interface RendererContainerChildBytes {
  ok: boolean;
  childUri: string;
  bytes?: Uint8Array;
  hash?: string;
  diagnostics: Diagnostic[];
}
