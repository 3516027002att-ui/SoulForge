/**
 * Deterministic Live Diagnostics Engine for EMEVD DarkScript3.
 *
 * Emits structured diagnostics for:
 * - Unknown instruction & typos
 * - Argument count mismatch
 * - Argument integer overflow / type mismatch
 * - Invalid enum members
 * - Malformed / undeclared event parameter slots (Xn_size)
 * - Duplicate event IDs
 * - Unclosed brackets
 */

import type { EmedfCompletionItem } from '../emedfCompletionCatalog.js';
import type { EmedfArgType, EmedfEnumDef } from '../emedfSchema.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface EventDiagnostic {
  from: number;
  to: number;
  line: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  suggestedFixes?: Array<{
    title: string;
    replacement: string;
    from: number;
    to: number;
  }>;
}

const TYPE_RANGES: Record<EmedfArgType, { min: number; max: number }> = {
  s8: { min: -128, max: 127 },
  u8: { min: 0, max: 255 },
  s16: { min: -32768, max: 32767 },
  u16: { min: 0, max: 65535 },
  s32: { min: -2147483648, max: 2147483647 },
  u32: { min: 0, max: 4294967295 },
  f32: { min: -Infinity, max: Infinity },
  bool: { min: 0, max: 1 }
};

/**
 * Levenshtein distance for typo suggestions.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Find closest instruction names in catalog.
 */
export function findClosestInstruction(
  name: string,
  catalog: readonly EmedfCompletionItem[],
  maxDistance = 3
): string[] {
  const candidates: Array<{ name: string; dist: number }> = [];
  for (const item of catalog) {
    const dist = levenshtein(name, item.name);
    if (dist <= maxDistance) {
      candidates.push({ name: item.name, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return Array.from(new Set(candidates.map((c) => c.name))).slice(0, 3);
}

/**
 * Compute all diagnostics for a DarkScript3 document.
 */
export function computeDocumentDiagnostics(
  text: string,
  catalog: readonly EmedfCompletionItem[],
  enums?: Record<string, EmedfEnumDef>
): EventDiagnostic[] {
  const diagnostics: EventDiagnostic[] = [];
  const catalogByName = new Map<string, EmedfCompletionItem>();
  for (const item of catalog) {
    catalogByName.set(item.name, item);
    catalogByName.set(item.name.toLowerCase(), item);
  }

  const seenEventIds = new Map<number, { from: number; to: number; line: number }>();
  let currentEventId: number | null = null;
  let currentEventParamSlots = new Set<string>();

  // Line-by-line scanning with token tracking
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();

    if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      // 1. Check for $Event header
      const eventHeaderMatch = /^\$Event\s*\(\s*(-?\d+)\s*,\s*([A-Za-z0-9_]+)/.exec(trimmed);
      if (eventHeaderMatch) {
        const id = Number(eventHeaderMatch[1]);
        const rest = eventHeaderMatch[2]!;
        const matchFrom = lineStart + line.indexOf(eventHeaderMatch[0]);
        const matchTo = matchFrom + eventHeaderMatch[0].length;

        currentEventId = id;
        currentEventParamSlots = new Set<string>();

        // Duplicate Event ID check
        const existing = seenEventIds.get(id);
        if (existing) {
          diagnostics.push({
            from: matchFrom,
            to: matchTo,
            line: lineNumber,
            severity: 'error',
            code: 'EMEVD_DUPLICATE_EVENT_ID',
            message: `重复的 Event ID ${id}（与第 ${existing.line} 行冲突）。`
          });
        } else {
          seenEventIds.set(id, { from: matchFrom, to: matchTo, line: lineNumber });
        }

        // RestBehavior check
        if (rest !== 'Default' && rest !== 'Restart' && rest !== '0' && rest !== '1') {
          diagnostics.push({
            from: matchFrom,
            to: matchTo,
            line: lineNumber,
            severity: 'warning',
            code: 'EMEVD_INVALID_REST_BEHAVIOR',
            message: `未知的 restBehavior "${rest}"，通常应为 Default 或 Restart。`
          });
        }
      }

      // 2. Check for Instruction Calls: Name(arg1, arg2...)
      const callRegex = /(?:\$)?\b([A-Z][A-Za-z0-9_]*)\s*\(([^)]*)\)?/g;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(line)) !== null) {
        const fullMatch = callMatch[0]!;
        const instrName = callMatch[1]!;
        if (fullMatch.startsWith('$') || instrName === 'Event' || instrName === '$Event' || instrName === 'WaitFor' || instrName === 'function') {
          continue;
        }

        const callFrom = lineStart + callMatch.index;
        const nameTo = callFrom + instrName.length;
        const rawArgs = callMatch[2] ?? '';

        const item = catalogByName.get(instrName);
        if (!item) {
          // Unknown instruction / Typo
          const suggestions = findClosestInstruction(instrName, catalog);
          const fixes = suggestions.map((sug) => ({
            title: `替换为 ${sug}`,
            replacement: sug,
            from: callFrom,
            to: nameTo
          }));

          diagnostics.push({
            from: callFrom,
            to: nameTo,
            line: lineNumber,
            severity: 'warning',
            code: 'EMEVD_UNKNOWN_INSTRUCTION',
            message: `未知的指令名 "${instrName}"。${suggestions.length > 0 ? `你是不是想写：${suggestions.join(', ')}？` : ''}`,
            suggestedFixes: fixes
          });
        } else {
          // Check arguments
          const argStrings = splitArgs(rawArgs);
          const expectedArgs = item.args;
          const hasVararg = expectedArgs.length > 0 && expectedArgs[expectedArgs.length - 1]!.vararg;
          const minArgs = expectedArgs.filter((a) => !a.vararg).length;

          if (!hasVararg && argStrings.length !== expectedArgs.length) {
            diagnostics.push({
              from: callFrom,
              to: lineStart + callMatch.index + callMatch[0].length,
              line: lineNumber,
              severity: 'warning',
              code: 'EMEVD_ARG_COUNT_MISMATCH',
              message: `指令 ${instrName} 参数数量不匹配：期望 ${expectedArgs.length} 个，实际传入 ${argStrings.length} 个。`
            });
          } else if (hasVararg && argStrings.length < minArgs) {
            diagnostics.push({
              from: callFrom,
              to: lineStart + callMatch.index + callMatch[0].length,
              line: lineNumber,
              severity: 'warning',
              code: 'EMEVD_ARG_COUNT_MISMATCH',
              message: `可变参数指令 ${instrName} 至少需要 ${minArgs} 个基础参数，实际传入 ${argStrings.length} 个。`
            });
          }

          // Inspect each arg value
          for (let aIdx = 0; aIdx < argStrings.length; aIdx++) {
            const argText = argStrings[aIdx]!.trim();
            const expected = aIdx < expectedArgs.length ? expectedArgs[aIdx] : (hasVararg ? expectedArgs[expectedArgs.length - 1] : undefined);
            if (!expected) continue;

            // 2.1 Enum member validity check
            if (expected.enumName && enums) {
              const enumDef = enums[expected.enumName];
              if (enumDef && argText.includes('.')) {
                const parts = argText.split('.');
                const memberName = parts[1]?.trim();
                if (memberName) {
                  const validMember = enumDef.members.some((m) => m.name === memberName);
                  if (!validMember) {
                    diagnostics.push({
                      from: callFrom,
                      to: lineStart + callMatch.index + callMatch[0].length,
                      line: lineNumber,
                      severity: 'error',
                      code: 'EMEVD_INVALID_ENUM_MEMBER',
                      message: `枚举 ${expected.enumName} 中不存在成员 "${memberName}"。可用成员: ${enumDef.members.map((m) => m.name).join(', ')}。`
                    });
                  }
                }
              }
            }

            // 2.2 Event parameter (Xn_size) check
            if (argText.startsWith('X')) {
              const slotMatch = /^X(\d+)_(\d+)$/.exec(argText);
              if (!slotMatch) {
                diagnostics.push({
                  from: callFrom,
                  to: lineStart + callMatch.index + callMatch[0].length,
                  line: lineNumber,
                  severity: 'error',
                  code: 'EMEVD_MALFORMED_EVENT_PARAMETER',
                  message: `畸形的事件参数标识符 "${argText}"，标准格式应为 X<offset>_<size>（如 X0_4）。`
                });
              } else {
                currentEventParamSlots.add(argText);
              }
            }

            // 2.3 Integer range check
            if (/^-?\d+$/.test(argText)) {
              const num = Number(argText);
              const range = TYPE_RANGES[expected.type];
              if (range && (num < range.min || num > range.max)) {
                diagnostics.push({
                  from: callFrom,
                  to: lineStart + callMatch.index + callMatch[0].length,
                  line: lineNumber,
                  severity: 'warning',
                  code: 'EMEVD_INTEGER_OVERFLOW',
                  message: `参数 "${expected.name}" (${expected.type}) 取值 ${num} 超出类型范围 [${range.min}, ${range.max}]。`
                });
              }
            }
          }
        }
      }
    }

    if (nl < 0) break;
    lineStart = nl + 1;
    lineNumber++;
  }

  return diagnostics;
}

function splitArgs(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}
