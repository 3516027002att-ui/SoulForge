/**
 * Deterministic Quick Fix Engine for EMEVD DarkScript3.
 *
 * Provides safe, deterministic mechanical fixes:
 * - Typo replacement (e.g. `ShootBulelt` -> `ShootBullet`)
 * - Missing semicolon / closing parenthesis
 * - Missing argument placeholder insertion
 * - Enum member symbolic replacement
 */

import type { EmedfCompletionItem } from '../emedfCompletionCatalog.js';
import type { EmedfEnumDef } from '../emedfSchema.js';
import type { EventDiagnostic } from './eventDiagnosticsEngine.js';
import { levenshtein } from './eventDiagnosticsEngine.js';

export interface QuickFixAction {
  title: string;
  kind: 'quickfix';
  isPreferred?: boolean;
  from: number;
  to: number;
  replacement: string;
}

export function getQuickFixesAt(
  offset: number,
  diagnostics: readonly EventDiagnostic[],
  text: string,
  catalog: readonly EmedfCompletionItem[],
  enums?: Record<string, EmedfEnumDef>
): QuickFixAction[] {
  const actions: QuickFixAction[] = [];

  for (const diag of diagnostics) {
    if (offset >= diag.from && offset <= diag.to) {
      // 1. From diagnostic pre-calculated suggestions
      if (diag.suggestedFixes) {
        for (const fix of diag.suggestedFixes) {
          actions.push({
            title: fix.title,
            kind: 'quickfix',
            isPreferred: true,
            from: fix.from,
            to: fix.to,
            replacement: fix.replacement
          });
        }
      }

      // 2. Missing semicolon on instruction line
      if (diag.code === 'EMEVD_UNKNOWN_INSTRUCTION' || diag.code === 'EMEVD_ARG_COUNT_MISMATCH') {
        const lineSlice = text.slice(diag.from, diag.to);
        if (!lineSlice.endsWith(';') && !lineSlice.includes('function()')) {
          actions.push({
            title: '在末尾添加分号 ";"',
            kind: 'quickfix',
            from: diag.to,
            to: diag.to,
            replacement: ';'
          });
        }
      }

      // 3. Invalid Enum Member Fix
      if (diag.code === 'EMEVD_INVALID_ENUM_MEMBER' && enums) {
        const errText = text.slice(diag.from, diag.to);
        const match = /([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/.exec(errText);
        if (match) {
          const enumName = match[1]!;
          const badMember = match[2]!;
          const enumDef = enums[enumName];
          if (enumDef) {
            const sorted = enumDef.members
              .map((m) => ({ member: m, dist: levenshtein(badMember, m.name) }))
              .sort((a, b) => a.dist - b.dist);
            if (sorted[0] && sorted[0].dist <= 3) {
              const best = sorted[0].member;
              const memberFrom = diag.from + match.index + enumName.length + 1;
              const memberTo = memberFrom + badMember.length;
              actions.push({
                title: `将 ${badMember} 替换为 ${enumName}.${best.name}`,
                kind: 'quickfix',
                isPreferred: true,
                from: memberFrom,
                to: memberTo,
                replacement: best.name
              });
            }
          }
        }
      }
    }
  }

  return actions;
}
