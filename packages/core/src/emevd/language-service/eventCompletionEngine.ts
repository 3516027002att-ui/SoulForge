/**
 * Deterministic Ranking Completion Engine for EMEVD DarkScript3.
 *
 * Provides snippet skeletons, enum argument suggestions, event parameters (X0_4),
 * event ID lookups, and deterministic ranking:
 * 1. Exact match
 * 2. Prefix match
 * 3. CamelCase / token match (e.g. `ShtBul` -> `ShootBullet`)
 * 4. Subsequence / fuzzy match
 */

import type { EmedfCompletionItem } from '../emedfCompletionCatalog.js';
import type { EmedfEnumDef } from '../emedfSchema.js';
import type { EventCursorContext } from './eventCursorContext.js';
import { getSignatureHelp } from './eventSignatureHelp.js';

export type CompletionItemKind =
  | 'function'
  | 'enum'
  | 'enum-member'
  | 'parameter'
  | 'event-id'
  | 'keyword'
  | 'constant'
  | 'value';

export interface EventCompletionCandidate {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  info?: string;
  insertText?: string;
  snippet?: string;
  boost?: number;
  replacementSpan?: { from: number; to: number };
}

export interface CompletionQueryContext {
  context: EventCursorContext;
  catalog: readonly EmedfCompletionItem[];
  enums?: Record<string, EmedfEnumDef>;
  knownEventIds?: Array<{ eventId: number; title?: string; doc?: string }>;
  recentSelections?: readonly string[];
}

/**
 * Match score computation:
 * Returns score > 0 if pattern matches target, otherwise 0.
 */
export function scoreMatch(pattern: string, target: string): number {
  if (!pattern) return 10;
  if (pattern === target) return 100;
  if (target.startsWith(pattern)) return 80;
  if (target.toLowerCase().startsWith(pattern.toLowerCase())) return 70;

  // CamelCase match: e.g. "ShtBul" matches "ShootBullet", "CB" matches "CharacterDead"
  const upperPattern = pattern.replace(/[^A-Z]/g, '');
  const upperTarget = target.replace(/[^A-Z]/g, '');
  if (upperPattern.length >= 2 && upperTarget.startsWith(upperPattern)) {
    return 60;
  }

  // Token camel match: check if pattern matches initials of CamelWords
  const words = target.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  const patternLower = pattern.toLowerCase();
  let wordIndex = 0;
  let matches = 0;
  for (const char of patternLower) {
    while (wordIndex < words.length && !words[wordIndex]!.startsWith(char)) {
      wordIndex++;
    }
    if (wordIndex < words.length) {
      matches++;
      wordIndex++;
    }
  }
  if (matches === pattern.length) {
    return 50;
  }

  // Subsequence match
  let pIdx = 0;
  const targetLower = target.toLowerCase();
  for (let i = 0; i < targetLower.length && pIdx < patternLower.length; i++) {
    if (targetLower[i] === patternLower[pIdx]) {
      pIdx++;
    }
  }
  if (pIdx === patternLower.length) {
    return 30;
  }

  return 0;
}

/**
 * Build a snippet skeleton for an instruction call.
 * Format: `Name(${1:arg0}, ${2:arg1})`
 */
export function buildInstructionSnippet(item: EmedfCompletionItem): string {
  if (item.args.length === 0) {
    return `${item.name}()$0`;
  }
  const params = item.args.map((arg, idx) => `\${${idx + 1}:${arg.name}}`);
  return `${item.name}(${params.join(', ')})$0`;
}

/**
 * Main completion query entrypoint.
 */
export function getCompletions(query: CompletionQueryContext): EventCompletionCandidate[] {
  const { context, catalog, enums, knownEventIds, recentSelections } = query;

  if (context.isInComment || context.isInString) {
    return [];
  }

  const prefix = context.currentWord?.text ?? '';
  const candidates: EventCompletionCandidate[] = [];

  // Case 1: Cursor is inside an active function call's argument position
  if (context.activeCall && !context.activeCall.isClosed) {
    const signature = getSignatureHelp(context, catalog, enums);
    const activeParam = signature?.activeParameter;

    if (activeParam) {
      // 1.1 Enum member completion
      if (activeParam.enumMembers && activeParam.enumMembers.length > 0) {
        const enumPrefix = activeParam.enumName ? `${activeParam.enumName}.` : '';
        for (const member of activeParam.enumMembers) {
          const qualifiedLabel = `${enumPrefix}${member.name}`;
          const score = scoreMatch(prefix, qualifiedLabel) || scoreMatch(prefix, member.name);
          if (!prefix || score > 0) {
            candidates.push({
              label: qualifiedLabel,
              kind: 'enum-member',
              detail: `enum: ${activeParam.enumName ?? ''} = ${member.value}`,
              info: member.label ?? member.name,
              insertText: qualifiedLabel,
              boost: (score || 40) + 15
            });
          }
        }
      }

      // 1.2 Event formal parameters (X0_4, X4_4, etc.)
      if (context.enclosingEvent && context.enclosingEvent.parameterSlots.length > 0) {
        for (const slot of context.enclosingEvent.parameterSlots) {
          const score = scoreMatch(prefix, slot);
          if (!prefix || score > 0) {
            candidates.push({
              label: slot,
              kind: 'parameter',
              detail: `Event ${context.enclosingEvent.eventId} parameter`,
              info: `当前事件形参插槽 ${slot}`,
              insertText: slot,
              boost: (score || 40) + 10
            });
          }
        }
      }

      // 1.3 Event ID references
      if (/eventid|event_id|commoneventid/i.test(activeParam.name) && knownEventIds) {
        for (const ev of knownEventIds) {
          const evStr = String(ev.eventId);
          const label = `${ev.eventId}${ev.title ? ` — ${ev.title}` : ''}`;
          const score = scoreMatch(prefix, evStr) || scoreMatch(prefix, ev.title ?? '');
          if (!prefix || score > 0) {
            candidates.push({
              label,
              kind: 'event-id',
              detail: ev.title ?? 'Event ID',
              info: ev.doc ?? `Event ${ev.eventId}`,
              insertText: evStr,
              boost: (score || 35) + 5
            });
          }
        }
      }

      // 1.4 Boolean constants
      if (activeParam.type === 'bool' || activeParam.type === 'boolean') {
        candidates.push(
          { label: 'true', kind: 'constant', detail: 'bool: true', insertText: 'true', boost: 50 },
          { label: 'false', kind: 'constant', detail: 'bool: false', insertText: 'false', boost: 50 }
        );
      }
    }
  }

  // Case 2: General / Instruction name completion
  if (!context.activeCall || context.activeCall.isClosed || context.activeCall.openParenPos > context.offset) {
    // Built-in keywords
    const keywords = [
      { name: '$Event', snippet: '$Event(${1:0}, ${2:Default}, function() {\n    $0\n});', doc: '定义一个新事件块' },
      { name: 'WaitFor', snippet: 'WaitFor(\n    $0\n);', doc: '条件等待折叠块' },
      { name: 'Default', snippet: 'Default', doc: 'restBehavior: 0' },
      { name: 'Restart', snippet: 'Restart', doc: 'restBehavior: 1' }
    ];

    for (const kw of keywords) {
      const score = scoreMatch(prefix, kw.name);
      if (!prefix || score > 0) {
        candidates.push({
          label: kw.name,
          kind: 'keyword',
          detail: 'keyword',
          info: kw.doc,
          snippet: kw.snippet,
          boost: score + 5
        });
      }
    }

    // EMEDF instructions
    for (const item of catalog) {
      const score = scoreMatch(prefix, item.name);
      if (!prefix || score > 0) {
        const argSummary = item.args.length === 0
          ? '（无参数）'
          : item.args.map((a) => `${a.name}:${a.type}${a.vararg ? '…' : ''}`).join(', ');

        const isRecent = recentSelections?.includes(item.name);
        const tieBreaker = isRecent ? 2 : 0;

        candidates.push({
          label: item.name,
          kind: 'function',
          detail: `bank ${item.bank}:${item.id} (${item.args.length} args)`,
          info: `参数: ${argSummary}`,
          snippet: buildInstructionSnippet(item),
          boost: score + tieBreaker
        });
      }
    }

    // Enum names directly (e.g. ComparisonType)
    if (enums) {
      for (const [enumName, enumDef] of Object.entries(enums)) {
        const score = scoreMatch(prefix, enumName);
        if (!prefix || score > 0) {
          candidates.push({
            label: enumName,
            kind: 'enum',
            detail: `enum (${enumDef.members.length} members)`,
            info: enumDef.members.map((m) => `${m.name}=${m.value}`).join(', '),
            insertText: enumName,
            boost: score
          });
        }
      }
    }
  }

  // Sort deterministically by boost (descending), then alphabetically by label
  candidates.sort((a, b) => {
    const boostDiff = (b.boost ?? 0) - (a.boost ?? 0);
    if (boostDiff !== 0) return boostDiff;
    return a.label.localeCompare(b.label);
  });

  return candidates;
}
