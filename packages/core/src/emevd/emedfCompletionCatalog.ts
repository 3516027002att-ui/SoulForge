/**
 * Read-only projection of the resolved EMEDF registry for editor assistance.
 *
 * T4：EventSourceWorkbenchPanel 用本机 EMEDF 公开指令名做 CodeMirror
 * autocomplete（Ctrl+Space + 输入时）与悬停参数名列表。这里只从
 * `EmedfRegistry` 提取公开字段（name/bank/id/args），不触碰任何
 * DarkScript3 源码，也不携带 EMEDF 数据本身（数据留在用户本机）。
 *
 * 本文件只做纯数据投影，不读写文件系统。
 */

import type { EmedfArgType, EmedfEnumDef, EmedfRegistry } from './emedfSchema.js';

export interface EmedfCompletionArg {
  name: string;
  type: EmedfArgType;
  vararg?: boolean;
  enumName?: string;
  description?: string;
  default?: number;
  min?: number;
  max?: number;
  increment?: number;
  formatString?: string;
}

/** 单个可补全指令的公开投影（autocomplete/hover/signature help 消费）。 */
export interface EmedfCompletionItem {
  /** 指令名（PascalCase，EMEDF 公开字段）。 */
  name: string;
  bank: number;
  id: number;
  /** 参数名列表，按 schema 顺序；vararg 尾部由 vararg 标记。 */
  args: EmedfCompletionArg[];
  description?: string;
}

export interface EmedfCompletionCatalog {
  items: EmedfCompletionItem[];
  enums: Record<string, EmedfEnumDef>;
}

/**
 * 把解析好的 EMEDF registry 投影成补全目录。
 * 同名指令（不同 bank:id）全部保留，由 UI 决定去重/展示。
 */
export function listEmedfCompletionItems(registry: EmedfRegistry): EmedfCompletionItem[] {
  return registry.instructions.map((item) => ({
    name: item.name,
    bank: item.bank,
    id: item.id,
    args: item.args.map((arg) => ({
      name: arg.name,
      type: arg.type,
      ...(arg.vararg === true ? { vararg: true as const } : {}),
      ...(arg.enumName ? { enumName: arg.enumName } : {}),
      ...(arg.description ? { description: arg.description } : {}),
      ...(arg.default !== undefined ? { default: arg.default } : {}),
      ...(arg.min !== undefined ? { min: arg.min } : {}),
      ...(arg.max !== undefined ? { max: arg.max } : {}),
      ...(arg.increment !== undefined ? { increment: arg.increment } : {}),
      ...(arg.formatString ? { formatString: arg.formatString } : {})
    }))
  }));
}

export function buildEmedfCompletionCatalog(registry: EmedfRegistry): EmedfCompletionCatalog {
  return {
    items: listEmedfCompletionItems(registry),
    enums: registry.enums ?? {}
  };
}
