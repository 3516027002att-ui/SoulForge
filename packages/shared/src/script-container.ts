/**
 * Renderer-safe script container evidence projection.
 *
 * Pairs with `packages/core/src/script/scriptContainerEvidence.ts` (production
 * authority). The renderer never receives absolute paths: the preload strips
 * path-bearing fields before this DTO crosses the context bridge, so the
 * entries are identified by logical inner names only.
 *
 * SoulForge does not execute scripts. Inner `.lua` / `.hks` files that use the
 * current Sekiro HKS dialect are decompiled and recompiled by the first-party
 * Bridge; future or out-of-scope dialects remain structured failures rather
 * than being presented as fake source.
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
 * 单条脚本内层条目的源码级视图（SCRIPT-41）。
 *
 * 主进程用真实字节判定：不看文件名、不用证据采样的分类，逐个条目调用
 * `classifyPlaintextBytes`（阈值 0.99）。明文条目返回按真实 encoding 解码的
 * 文本；当前 Sekiro HKS 字节码由 Bridge 内置 first-party dialect 生成完整
 * 可写 Lua 源码，未来/范围外 dialect 才返回结构化失败诊断。
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

/**
 * 脚本源码视图（S16 脚本 IDE）。
 *
 * `resource.readScriptSource` 的结果：明文条目按真实 encoding 返回文本；
 * `Lua` 字节码由 Bridge 内置的 SoulForge HKS dialect 生成 Lua 文本。
 * 只有未来版本或不属于当前治理范围的 dialect 才会返回结构化
 * `not-attempted/failed` 诊断；当前范围的覆盖缺口不能被伪装成只读完成态。
 * renderer 只收文本，不接触任何绝对路径。
 */
export interface ScriptSemanticProvenance {
  origin: 'first-party';
  package: string;
  revision: string;
  contentDigest?: string;
}

export interface ScriptSourceView {
  ok: boolean;
  /** 显示用逻辑名：容器内为条目名，独立文件为 basename。 */
  logicalName: string;
  kind: 'plaintext' | 'decompiled' | 'failure';
  /** 可编辑源码文本（plaintext / decompiled 时存在）。 */
  sourceText?: string;
  /**
   * 打开时的字节编码（S34「按打开编码写回」）：
   * 明文条目为检测到的编码；反编译条目为 'utf8'（写回明文 Lua）。
   */
  encoding?: ScriptEntryEncoding | 'utf8' | 'decompiled';
  /** sourceText 是否为反编译器输出（非原文件文本）。 */
  decompiled?: boolean;
  /** 反编译器人类可读标识；生产实现固定为 SoulForge first-party。 */
  decompiler?: string;
  /** first-party 编译器来源与 revision。 */
  compiler?: ScriptSemanticProvenance;
  /** first-party 反编译器来源与 revision。 */
  decompilerProvenance?: ScriptSemanticProvenance;
  /** 当前脚本字节码 dialect。 */
  dialect?: string;
  /** schema/语义实现 revision。 */
  revision?: string;
  /** 打开时的原始字节 source hash，用于 CAS 与重读证明。 */
  sourceHash?: string;
  /** 容器内条目时为其容器 uri。 */
  containerUri?: string;
  /** 容器内条目名。 */
  entryName?: string;
  /**
   * 容器内条目的 BND4 entryIndex（13-A：读链以 index 为主键，不打码后的名字；
   * 保存后重读时回传这个索引，保持选中条目稳定）。
   */
  entryIndex?: number;
  /** 容器内条目替换所需的子项 hash（save 时回传做乐观并发校验）。 */
  childHash?: string;
  /** 容器根 hash（save 时回传做乐观并发校验）。 */
  containerHash?: string;
  /** 是否支持把 sourceText 写回（容器条目 / 独立脚本文件均可写）。 */
  writeSupported: boolean;
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
