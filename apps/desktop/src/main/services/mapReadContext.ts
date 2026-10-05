import type { RunBridgeCancellationTerminalReceipt } from '@soulforge/core';
import type { CharacterPreviewBundle, Diagnostic } from '@soulforge/shared';

export const MAP_REQUEST_CANCELLED_CODE = 'MAP_REQUEST_CANCELLED';
/** The transport owns the controller and terminal receipt registry. */
export interface MapReadRequestContext {
  signal: AbortSignal | undefined;
  onCancellationTerminal?: (receipt: RunBridgeCancellationTerminalReceipt) => void;
}
/** Existing character support crosses domains as explicit read capabilities. */
export interface MapCharacterSupportPorts {
  characterTexturePackagePaths(modelPath: string, additionalPartsDirectories?: readonly string[]): string[];
  assembleC0000CompatibilityPreview(input: {
    leaderBundle: CharacterPreviewBundle;
    overlayPartsDirectory: string;
    basePartsDirectory: string | null;
    allowedRoots: string[];
    oodleRuntimeRoot: string | null;
    signal?: AbortSignal;
    onCancellationTerminal?: (receipt: RunBridgeCancellationTerminalReceipt) => void | Promise<void>;
  }): Promise<{ bundle: CharacterPreviewBundle | null; diagnostics: Diagnostic[] }>;
}
