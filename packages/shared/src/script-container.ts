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

/**
 * One page of classified script container entries served by the paginated
 * access channel (`resource.listScriptContainerEntriesPage`). The complete
 * entry table is materialized in main; the renderer only ever receives a
 * bounded page plus navigation metadata (hard constraint 17). Unlike
 * `ScriptContainerEvidence` (a bounded evidence snapshot), navigation can
 * cover every entry the Bridge inventory reports.
 */
export interface ScriptContainerEntryPage {
  ok: boolean;
  /** Container format: BND4_DFLT, BND4_KRAK, or unknown. */
  containerFormat: string;
  /** Total entry count reported by the container inventory. */
  entryCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  entries: ScriptContainerEntryEvidence[];
  /**
   * Classification distribution across ALL enumerated entries (not just the
   * current page), assembled in main so the renderer never materializes the
   * whole table.
   */
  classificationSummary: Record<ScriptEntryClassification, number>;
  /**
   * True when the complete entry table was enumerated (not a bounded sample),
   * so page navigation reaches every entry the container reports.
   */
  entriesComplete: boolean;
  diagnostics: Diagnostic[];
}

/**
 * 明文判定的编码标签（与 core `plaintextScriptEntry.ts` 的 PlaintextEncoding
 * 同构；shared 不依赖 core，故此处声明自己的 union）。
 */
export type ScriptEntryEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf8-bom'
  | 'shift_jis'
  | 'mixed-unknown';

/** 解码文本的换行统计（CRLF 优先匹配，不重复计数）。 */
export interface ScriptEntryNewlines {
  /** CRLF 成对换行数。 */
  crlf: number;
  /** 独立 LF（\n）换行数。 */
  lf: number;
  /** 独立 CR（\r）换行数。 */
  cr: number;
}

/**
 * 单条脚本内层条目的源码级只读视图（SCRIPT-41）。
 *
 * 主进程用真实字节判定：不看文件名、不用证据采样的分类，逐个条目调用
 * `classifyPlaintextBytes`（阈值 0.99）。明文条目返回按真实 encoding 解码的
 * 文本；字节码条目只返回判定证据，渲染器只展示明确的只读字节视图，
 * 绝不把字节码呈现为可编辑源码。
 */
export interface ScriptEntryPlaintextView {
  ok: boolean;
  /** Logical inner entry name. */
  name: string;
  /** 与 ScriptContainerEntryEvidence 同源的分类。 */
  classification: ScriptEntryClassification;
  /** 真实字节判定是否为明文。 */
  isPlaintext: boolean;
  /** 判定结论码，例如 PLAINTEXT_CONFIRMED / PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC。 */
  verdictCode: string;
  /** 可打印字节比例（基于采样）。 */
  printableRatio: number;
  /** 总字节数（含尾部填充）。 */
  totalBytes: number;
  /** 尾部 NUL 对齐填充字节数（容器对齐，不属于文本内容）。 */
  trailingPaddingBytes: number;
  /** 内容区（剥掉尾部填充后）是否含 NUL。 */
  containsNul: boolean;
  /** 是否命中 `\x1bLua` 字节码签名。 */
  luaBytecodeMagic: boolean;
  /** 判定出的真实编码。 */
  encoding: ScriptEntryEncoding;
  /** 是否带 UTF-8 BOM。 */
  hasBom: boolean;
  /** 换行统计（仅明文条目，字节码条目恒为全零）。 */
  newlines: ScriptEntryNewlines;
  /** 判定为明文时的解码文本（不含尾部填充字节）。 */
  text?: string;
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
