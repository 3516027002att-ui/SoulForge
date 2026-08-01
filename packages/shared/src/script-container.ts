/**
 * Renderer-safe script container evidence projection.
 *
 * Pairs with `packages/core/src/script/scriptContainerEvidence.ts` (production
 * authority). The renderer never receives absolute paths: the preload strips
 * path-bearing fields before this DTO crosses the context bridge, so the
 * entries are identified by logical inner names only.
 *
 * SoulForge does NOT decompile, recompile, or execute scripts. Inner `.lua` /
 * `.hks` files are Havok Script compiled bytecode (`\x1bLuaQ` magic), not
 * editable source text. The script panel is read-only evidence plus a
 * user-supplied whole inner-file replacement; it never presents bytecode as
 * editable source.
 */

import type { Diagnostic } from './types.js';

export type ScriptEntryClassification =
  | 'lua-bytecode'
  | 'luagnl'
  | 'luainfo'
  | 'esd-bytecode'
  | 'hkx-bytecode'
  | 'unknown';

export interface ScriptContainerEntryEvidence {
  /** Logical entry name (inner path within the container). */
  name: string;
  /** Entry index in the BND4 entry table. */
  index: number;
  /** Uncompressed size in bytes. */
  size: number;
  /** File extension (lowercase, without dot). */
  extension: string;
  /** Classified entry type. */
  classification: ScriptEntryClassification;
  /** First N bytes as hex (readonly evidence, bounded). */
  headerHex?: string;
  /** Magic bytes identification string. */
  magicLabel?: string;
}

export interface ScriptContainerEvidence {
  ok: boolean;
  /** Container format: BND4_DFLT, BND4_KRAK, or unknown. */
  containerFormat: string;
  /** Total entry count. */
  entryCount: number;
  /** Per-entry evidence (bounded to MAX_EVIDENCE_ENTRIES). */
  entries: ScriptContainerEntryEvidence[];
  /** Whether the entry list was truncated. */
  truncated: boolean;
  /** Distribution of classifications. */
  classificationSummary: Record<ScriptEntryClassification, number>;
  diagnostics: Diagnostic[];
}

/** Fixed display order for classification chips. */
export const SCRIPT_CLASSIFICATION_ORDER: readonly ScriptEntryClassification[] = [
  'lua-bytecode',
  'luagnl',
  'luainfo',
  'esd-bytecode',
  'hkx-bytecode',
  'unknown'
];

export function scriptClassificationLabel(classification: ScriptEntryClassification): string {
  switch (classification) {
    case 'lua-bytecode':
      return 'Lua 字节码';
    case 'luagnl':
      return 'LUAGNL 全局名表';
    case 'luainfo':
      return 'LUAINFO 参数元数据';
    case 'esd-bytecode':
      return 'ESD 状态机字节码';
    case 'hkx-bytecode':
      return 'HKX 行为字节码';
    default:
      return '未知';
  }
}
