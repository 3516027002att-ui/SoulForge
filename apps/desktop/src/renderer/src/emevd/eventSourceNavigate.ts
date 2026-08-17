/**
 * S31：事件源码跳转索引与词义投影。
 *
 * 只做两件能钉死的事：
 * 1. 一遍流式扫 `$Event(id` / `event @e:id` → 行号，禁止每次跳转线性扫全文；
 * 2. 实参角色只看 EMEDF 参数名，不靠「这个数字像事件 id」去猜。
 *
 * FMG / PARAM 逻辑名需要别的表。事件面板里没有那些表时返回
 * `insufficient_evidence`，不跳错、不挂假灯泡。
 */

import type { EmedfCompletionItem } from '@soulforge/core';

export type ArgRole = 'event-id' | 'fmg-id' | 'none';

export function classifyArgRole(argName: string): ArgRole {
  if (/eventid/i.test(argName)) return 'event-id';
  if (/(?:fmg|messageid|textid|itemnameid|placenameid)\b/i.test(argName)) return 'fmg-id';
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
  eventId?: number;
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

  const call = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  if (!call) return { kind: 'empty' };

  const name = call[1]!;
  const rawArgs = splitTopLevel(call[2] ?? '', ',').map((part) => part.trim()).filter(Boolean);
  const matches = catalog.filter((item) => item.name === name);
  if (matches.length === 0) {
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
  const item = matches[0]!;
  const args: InspectedArg[] = item.args.map((arg, index) => {
    const value = rawArgs[index] ?? '';
    const role = classifyArgRole(arg.name);
    const eventId = role === 'event-id' && /^-?\d+$/.test(value) ? Number(value) : undefined;
    return {
      name: arg.name,
      type: arg.type,
      value,
      role,
      ...(eventId !== undefined ? { eventId } : {})
    };
  });
  return {
    kind: 'instruction',
    name,
    bank: item.bank,
    id: item.id,
    args,
    unknown: false
  };
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
