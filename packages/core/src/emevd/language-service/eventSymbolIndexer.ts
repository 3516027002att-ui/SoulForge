/**
 * Deterministic Event Symbol & Outline Indexer for EMEVD DarkScript3.
 *
 * Fast linear indexing across 70,000+ line documents for:
 * - Outline symbols (eventId, restBehavior, instruction count, parameter slots, lines)
 * - Go to Event / Symbol fuzzy search (Ctrl+Shift+O)
 * - Event definition & references lookup (F12 / Shift+F12)
 */

import { scoreMatch } from './eventCompletionEngine.js';

export interface EventSymbol {
  eventId: number;
  restBehavior: string;
  line: number;
  from: number;
  to: number;
  parameterSlots: string[];
  instructionCount: number;
  warnings: number;
  errors: number;
}

export interface EventReference {
  targetEventId: number;
  callingEventId?: number;
  callerLine: number;
  from: number;
  to: number;
  instructionName: string;
}

export interface DocumentSymbolIndex {
  symbols: EventSymbol[];
  byEventId: Map<number, EventSymbol>;
  references: EventReference[];
}

/**
 * Perform a single-pass linear indexing of all events and references in document.
 */
export function indexDocumentSymbols(text: string): DocumentSymbolIndex {
  const symbols: EventSymbol[] = [];
  const byEventId = new Map<number, EventSymbol>();
  const references: EventReference[] = [];

  let currentSymbol: EventSymbol | null = null;
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();

    // 1. Event header
    const darkHeader = /^\$Event\s*\(\s*(-?\d+)\s*,\s*([A-Za-z0-9_]+)/.exec(trimmed);
    const dslHeader = /^event\s+@e:(-?\d+)\b/.exec(trimmed);
    const headerMatch = darkHeader || dslHeader;

    if (headerMatch) {
      if (currentSymbol) {
        currentSymbol.to = lineStart;
      }
      const eventId = Number(headerMatch[1]);
      const rest = darkHeader ? darkHeader[2]! : 'Default';
      const from = lineStart + line.indexOf(headerMatch[0]);

      currentSymbol = {
        eventId,
        restBehavior: rest,
        line: lineNumber,
        from,
        to: text.length,
        parameterSlots: [],
        instructionCount: 0,
        warnings: 0,
        errors: 0
      };
      symbols.push(currentSymbol);
      byEventId.set(eventId, currentSymbol);
    } else if (currentSymbol) {
      // 2. Count instructions & collect parameters inside current event
      if (/^\s*[A-Z][A-Za-z0-9_]*\s*\(/.test(line) && !trimmed.startsWith('//')) {
        currentSymbol.instructionCount++;

        // Collect Xn_size
        const paramMatches = line.matchAll(/\b(X\d+_\d+)\b/g);
        for (const pm of paramMatches) {
          const slot = pm[1]!;
          if (!currentSymbol.parameterSlots.includes(slot)) {
            currentSymbol.parameterSlots.push(slot);
          }
        }

        // Collect event references (e.g. InitializeEvent(0, 10000, ...))
        const refMatch = /\b(InitializeEvent|InitializeCommonEvent|GotoEvent|RunEvent)\s*\(\s*[^,]+,\s*(-?\d+)/.exec(line);
        if (refMatch) {
          const targetId = Number(refMatch[2]);
          const refFrom = lineStart + line.indexOf(refMatch[2]!);
          references.push({
            targetEventId: targetId,
            callingEventId: currentSymbol.eventId,
            callerLine: lineNumber,
            from: refFrom,
            to: refFrom + refMatch[2]!.length,
            instructionName: refMatch[1]!
          });
        }
      }

      // Check for event closing `});`
      if (/^\s*\}\s*\)\s*;/.test(trimmed)) {
        currentSymbol.to = lineEnd;
      }
    }

    if (nl < 0) break;
    lineStart = nl + 1;
    lineNumber++;
  }

  // Sort parameter slots
  for (const sym of symbols) {
    sym.parameterSlots.sort();
  }

  return { symbols, byEventId, references };
}

/**
 * Filter and rank event symbols by query (for Ctrl+Shift+O Go to Symbol).
 */
export function searchEventSymbols(query: string, symbols: readonly EventSymbol[]): EventSymbol[] {
  const trimmed = query.trim();
  if (!trimmed) return [...symbols];

  const scored: Array<{ symbol: EventSymbol; score: number }> = [];
  for (const sym of symbols) {
    const idStr = String(sym.eventId);
    const score = Math.max(
      scoreMatch(trimmed, idStr),
      scoreMatch(trimmed, sym.restBehavior),
      trimmed === idStr ? 120 : 0
    );
    if (score > 0) {
      scored.push({ symbol: sym, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.symbol);
}

/**
 * Find all references targeting a specific event ID.
 */
export function findEventReferences(
  eventId: number,
  index: DocumentSymbolIndex
): EventReference[] {
  return index.references.filter((ref) => ref.targetEventId === eventId);
}
