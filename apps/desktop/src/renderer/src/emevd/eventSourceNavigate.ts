/**
 * S31：事件源码跳转索引与词义投影。
 *
 * 只做两件能钉死的事：
 * 1. 一遍流式扫 `$Event(id` / `event @e:id` → 行号，禁止每次跳转线性扫全文；
 * 2. 实参角色只看 EMEDF 参数名，不靠「这个数字像事件 id」去猜。
 *
 * 文本 / PARAM 实参的跳转目标同样只看命名约定（与 packages/core
 * referenceBuilder 同一把尺子）：
 * - `itemNameId` → 已打开文本表里的「物品名」表条目；
 * - `placeNameId` → 「地名」表条目；
 * - `messageId` / `msgId` / `textId` / 其余 `fmg*` → 「Message」类文本表条目；
 * - `paramId` / `spEffect*` → 已打开的 PARAM 表行。
 * 事件面板里没有对应表时返回 `insufficient_evidence`，不跳错、不挂假灯泡。
 */

import type { EmedfCompletionItem } from '@soulforge/core';

export type ArgRole =
  | 'event-id'
  | 'fmg-id'
  | 'fmg-text-id'
  | 'fmg-item-name-id'
  | 'fmg-place-name-id'
  | 'param-id'
  | 'none';

/** fmg 系角色：可跳到已打开文本表条目。 */
export function isFmgRole(role: ArgRole): boolean {
  return role === 'fmg-id'
    || role === 'fmg-text-id'
    || role === 'fmg-item-name-id'
    || role === 'fmg-place-name-id';
}

export function classifyArgRole(argName: string): ArgRole {
  if (/eventid/i.test(argName)) return 'event-id';
  if (/itemnameid\b/i.test(argName)) return 'fmg-item-name-id';
  if (/placenameid\b/i.test(argName)) return 'fmg-place-name-id';
  if (/(?:messageid|msgid|textid)\b/i.test(argName)) return 'fmg-text-id';
  if (/fmg(?:id)?(?=_|$)/i.test(argName)) return 'fmg-id';
  if (/(?:paramid\b|speffect)/i.test(argName)) return 'param-id';
  return 'none';
}

/**
 * `$Event(id` / `event @e:decimalId` → 1-based 行号。
 * 重复 id 保留最后一次出现（后写覆盖），调用方可按 tab 再分桶。
 */
export function indexEventHeaders(text: string): Map<number, number> {
  const map = new Map<number, number>();
  let lineNumber = 1;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const line = nl < 0 ? text.slice(lineStart) : text.slice(lineStart, nl);
    const dark = /^\$Event\(\s*(-?\d+)\s*,/.exec(line);
    const dsl = /^event\s+@e:(-?\d+)\b/.exec(line);
    if (dark) map.set(Number(dark[1]), lineNumber);
    else if (dsl) map.set(Number(dsl[1]), lineNumber);
    if (nl < 0) break;
    lineStart = nl + 1;
    lineNumber += 1;
  }
  return map;
}

export interface OpenEventIndex {
  tabId: string;
  title: string;
  headers: Map<number, number>;
}

export type EventJump =
  | { kind: 'hit'; tabId: string; title: string; line: number }
  | { kind: 'insufficient_evidence'; code: 'insufficient_evidence'; message: string };

export function resolveEventJump(
  eventId: number,
  indexes: readonly OpenEventIndex[],
  preferTabId?: string
): EventJump {
  if (preferTabId) {
    const preferred = indexes.find((item) => item.tabId === preferTabId);
    const line = preferred?.headers.get(eventId);
    if (preferred && line !== undefined) {
      return { kind: 'hit', tabId: preferred.tabId, title: preferred.title, line };
    }
  }
  for (const item of indexes) {
    const line = item.headers.get(eventId);
    if (line !== undefined) {
      return { kind: 'hit', tabId: item.tabId, title: item.title, line };
    }
  }
  return {
    kind: 'insufficient_evidence',
    code: 'insufficient_evidence',
    message: `打开的事件文档里没有 $Event(${eventId})。`
  };
}

export interface InspectedArg {
  name: string;
  type: string;
  value: string;
  role: ArgRole;
  /** event-id 角色的整数 id。 */
  eventId?: number;
  /** fmg-id / param-id 角色的整数 id（文本条目 / PARAM 行）。 */
  resourceId?: number;
}

export type LineInspection =
  | { kind: 'empty' }
  | { kind: 'event-header'; eventId: number }
  | { kind: 'undecoded'; text: string }
  | {
      kind: 'instruction';
      name: string;
      bank?: number;
      id?: number;
      args: InspectedArg[];
      unknown: boolean;
    }
  | {
      kind: 'wait-for';
      predicates: Array<{ name: string; args: string[] }>;
    };

import { analyzeCursorContext } from '@soulforge/core/dist/emevd/language-service/index.js';

export function inspectAtCursor(
  text: string,
  pos: number,
  catalog: readonly EmedfCompletionItem[],
  enums?: Record<string, import('@soulforge/core').EmedfEnumDef>
): LineInspection {
  const ctx = analyzeCursorContext(text, pos);
  if (ctx.isInComment) {
    const line = text.slice(Math.max(0, pos - 50), Math.min(text.length, pos + 50)).split('\n')[0] ?? '';
    return { kind: 'undecoded', text: line.trim() };
  }

  if (ctx.activeCall) {
    const callName = ctx.activeCall.name;
    if (callName === '$Event') {
      return { kind: 'event-header', eventId: ctx.enclosingEvent?.eventId ?? 0 };
    }
    if (callName === 'WaitFor') {
      return { kind: 'wait-for', predicates: [] };
    }

    const item = catalog.find((candidate) => candidate.name === callName)
      ?? catalog.find((candidate) => candidate.name.toLowerCase() === callName.toLowerCase());

    const rawArgs = ctx.activeCall.arguments.map((a) => a.text);

    if (!item) {
      return {
        kind: 'instruction',
        name: callName,
        args: rawArgs.map((value, index) => ({
          name: `arg${index}`,
          type: 'unknown',
          value,
          role: 'none'
        })),
        unknown: true
      };
    }

    const args: InspectedArg[] = item.args.map((arg, index) => {
      const value = rawArgs[index] ?? '';
      const role = classifyArgRole(arg.name);
      const numeric = /^-?\d+$/.test(value);
      const eventId = role === 'event-id' && numeric ? Number(value) : undefined;
      const resourceId = (isFmgRole(role) || role === 'param-id') && numeric ? Number(value) : undefined;
      return {
        name: arg.name,
        type: arg.type,
        value,
        role,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(resourceId !== undefined ? { resourceId } : {})
      };
    });

    return {
      kind: 'instruction',
      name: item.name,
      bank: item.bank,
      id: item.id,
      args,
      unknown: false
    };
  }

  if (ctx.enclosingEvent) {
    return { kind: 'event-header', eventId: ctx.enclosingEvent.eventId };
  }

  return { kind: 'empty' };
}

export function inspectSourceLine(
  line: string,
  catalog: readonly EmedfCompletionItem[]
): LineInspection {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  const header = /^\$Event\(\s*(-?\d+)\s*,/.exec(trimmed);
  if (header) return { kind: 'event-header', eventId: Number(header[1]) };

  if (/^\/\/\s*(?:unknown|BASE64_INVALID|[A-Z][A-Z0-9_]{3,})\b/.test(trimmed)) {
    return { kind: 'undecoded', text: trimmed };
  }

  const wait = /^WaitFor\s*\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  if (wait) {
    return {
      kind: 'wait-for',
      predicates: parseWaitPredicates(wait[1] ?? '')
    };
  }

  // 允许单行谓词以 && 或 || 开头（如 WaitFor 块内的子行）
  const stripped = trimmed.replace(/^(?:&&|\|\|)\s*/, '');
  const call = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;?$/.exec(stripped);
  if (call) {
    const name = call[1]!;
    const rawArgs = splitTopLevel(call[2] ?? '', ',').map((part) => part.trim()).filter(Boolean);
    const item = catalog.find((candidate) => candidate.name === name)
      ?? catalog.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!item) {
      return {
        kind: 'instruction',
        name,
        args: rawArgs.map((value, index) => ({
          name: `arg${index}`,
          type: 'unknown',
          value,
          role: 'none'
        })),
        unknown: true
      };
    }
    const args: InspectedArg[] = item.args.map((arg, index) => {
      const value = rawArgs[index] ?? '';
      const role = classifyArgRole(arg.name);
      const numeric = /^-?\d+$/.test(value);
      const eventId = role === 'event-id' && numeric ? Number(value) : undefined;
      const resourceId = (isFmgRole(role) || role === 'param-id') && numeric ? Number(value) : undefined;
      return {
        name: arg.name,
        type: arg.type,
        value,
        role,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(resourceId !== undefined ? { resourceId } : {})
      };
    });
    return {
      kind: 'instruction',
      name: item.name,
      bank: item.bank,
      id: item.id,
      args,
      unknown: false
    };
  }

  // Fallback: Use analyzeCursorContext to tolerate unclosed and live editing calls
  const ctx = analyzeCursorContext(trimmed, trimmed.length);
  if (ctx.activeCall) {
    const callName = ctx.activeCall.name;
    const item = catalog.find((candidate) => candidate.name === callName)
      ?? catalog.find((candidate) => candidate.name.toLowerCase() === callName.toLowerCase());
    const rawArgs = ctx.activeCall.arguments.map((a) => a.text);

    if (!item) {
      return {
        kind: 'instruction',
        name: callName,
        args: rawArgs.map((value, index) => ({
          name: `arg${index}`,
          type: 'unknown',
          value,
          role: 'none'
        })),
        unknown: true
      };
    }

    const args: InspectedArg[] = item.args.map((arg, index) => {
      const value = rawArgs[index] ?? '';
      const role = classifyArgRole(arg.name);
      const numeric = /^-?\d+$/.test(value);
      const eventId = role === 'event-id' && numeric ? Number(value) : undefined;
      const resourceId = (isFmgRole(role) || role === 'param-id') && numeric ? Number(value) : undefined;
      return {
        name: arg.name,
        type: arg.type,
        value,
        role,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(resourceId !== undefined ? { resourceId } : {})
      };
    });

    return {
      kind: 'instruction',
      name: item.name,
      bank: item.bank,
      id: item.id,
      args,
      unknown: false
    };
  }

  return { kind: 'empty' };
}

function parseWaitPredicates(inner: string): Array<{ name: string; args: string[] }> {
  const chunks = splitTopLevel(inner, '&&').map((part) => part.trim()).filter(Boolean);
  const predicates: Array<{ name: string; args: string[] }> = [];
  for (const chunk of chunks) {
    const call = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;?$/.exec(chunk);
    if (!call) continue;
    predicates.push({
      name: call[1]!,
      args: splitTopLevel(call[2] ?? '', ',').map((part) => part.trim()).filter(Boolean)
    });
  }
  return predicates;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/* ------------------------------------------------------------------ */
/*  S31：文本 / PARAM 实参的跳转目标解析（纯逻辑，事件面板 → App 层）   */
/* ------------------------------------------------------------------ */

/** 文本语义类：由 EMEDF 参数名细分而来，用于在已打开文本表里挑目标表。 */
export type FmgSemantic = 'text' | 'item-name' | 'place-name';

/** 实参 → 跳转请求：事件面板词义列经 props 回调交给 App。 */
export type ResourceJumpRequest =
  | { kind: 'fmg'; semantic: FmgSemantic; id: number }
  | { kind: 'param'; id: number };

export type ResourceJumpResult =
  | {
      kind: 'hit';
      /** 命中的已打开资源 URI（App 按它匹配 openTabs）。 */
      resourceUri: string;
      /** 打开资源的逻辑名（tab 标题）。 */
      title: string;
      /** 命中目标的次要说明（文本表逻辑名 / 行号）。 */
      detail?: string;
      /** fmg 命中时的目标表 typed id（FmgWorkbenchPanel reveal 用）。 */
      tableId?: string;
    }
  | { kind: 'insufficient_evidence'; code: 'insufficient_evidence'; message: string };

export function insufficientEvidence(message: string): ResourceJumpResult {
  return { kind: 'insufficient_evidence', code: 'insufficient_evidence', message };
}

/** 实参角色 → 文本语义类（只有 fmg 系角色才调用；fmg-id 无更细命名，取通用 text）。 */
export function fmgSemanticOf(role: ArgRole): FmgSemantic {
  switch (role) {
    case 'fmg-item-name-id': return 'item-name';
    case 'fmg-place-name-id': return 'place-name';
    default: return 'text';
  }
}

export function fmgSemanticLabel(semantic: FmgSemantic): string {
  switch (semantic) {
    case 'item-name': return '物品名';
    case 'place-name': return '地名';
    default: return '文本（Message）';
  }
}

/** 语义类 → 表逻辑名匹配模式：只按表名给证据，不猜数字。 */
export function fmgTableNamePattern(semantic: FmgSemantic): RegExp {
  switch (semantic) {
    case 'item-name': return /item.*name/i;
    case 'place-name': return /place.*name/i;
    default: return /message/i;
  }
}

export interface TextTableRef {
  tableId: string;
  entryName: string;
}

export interface TextContainerRef {
  /** 与 openTabs sourceUri 匹配的容器资源 URI。 */
  sourceUri: string;
  /** 打开文件的逻辑名（tab 标题）。 */
  title: string;
  tables: readonly TextTableRef[];
}

/** 文本目录的最小结构投影（renderer 类型由主进程 TextCatalogResponse 满足）。 */
export interface TextCatalogLike {
  languages: ReadonlyArray<{
    containers: ReadonlyArray<{
      sourceUri: string;
      tables: readonly TextTableRef[];
    }>;
  }>;
}

/** 在文本目录里按容器 sourceUri 找表集合；找不到返回 null。 */
export function findCatalogContainer(
  catalog: TextCatalogLike,
  sourceUri: string
): { tables: readonly TextTableRef[] } | null {
  for (const language of catalog.languages) {
    for (const container of language.containers) {
      if (container.sourceUri === sourceUri) return { tables: container.tables };
    }
  }
  return null;
}

/**
 * 在已打开的文本容器里按语义找目标表。
 *
 * 零命中 / 多命中都返回 insufficient_evidence —— 多命中时不能猜哪一个是
 * 目标，否则就是「猜数字跳错表」。
 */
export function resolveFmgJump(
  semantic: FmgSemantic,
  id: number,
  containers: readonly TextContainerRef[]
): ResourceJumpResult {
  const pattern = fmgTableNamePattern(semantic);
  const label = fmgSemanticLabel(semantic);
  const matches: Array<{ container: TextContainerRef; table: TextTableRef }> = [];
  for (const container of containers) {
    for (const table of container.tables) {
      if (pattern.test(table.entryName)) matches.push({ container, table });
    }
  }
  if (matches.length === 0) {
    return insufficientEvidence(`已打开的文本文档里没有「${label}」表，文本条目 ${id} 无法定位。`);
  }
  if (matches.length > 1) {
    const names = matches.map((match) => `${match.container.title}/${match.table.entryName}`).join('、');
    return insufficientEvidence(
      `有 ${matches.length} 个已打开的文本表匹配「${label}」（${names}），无法确定目标。`
    );
  }
  const hit = matches[0]!;
  return {
    kind: 'hit',
    resourceUri: hit.container.sourceUri,
    title: hit.container.title,
    detail: hit.table.entryName,
    tableId: hit.table.tableId
  };
}

export interface OpenParamRef {
  sourceUri: string;
  title: string;
}

/**
 * PARAM 行实参 → 已打开的 PARAM 表。只允许「恰好一个」：零个没法跳，
 * 多个不能猜哪个表才是参数所指。
 */
export function resolveParamJump(
  id: number,
  openParams: readonly OpenParamRef[]
): ResourceJumpResult {
  if (openParams.length === 0) {
    return insufficientEvidence(`没有已打开的 PARAM 文档，PARAM 行 ${id} 无法定位。`);
  }
  if (openParams.length > 1) {
    const names = openParams.map((param) => param.title).join('、');
    return insufficientEvidence(
      `有 ${openParams.length} 个已打开的 PARAM 文档（${names}），无法确定目标。`
    );
  }
  const target = openParams[0]!;
  return {
    kind: 'hit',
    resourceUri: target.sourceUri,
    title: target.title,
    detail: `PARAM 行 ${id}`
  };
}
