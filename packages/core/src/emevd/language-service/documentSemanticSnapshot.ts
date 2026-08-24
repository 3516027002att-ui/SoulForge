/**
 * DarkScript3 Document Semantic Snapshot & Windowed Service
 *
 * Provides sub-millisecond incremental access, viewport windowing, and
 * monotonic sequence tokens with cooperative cancellation for 50k+ line documents.
 */

import { indexDocumentSymbols, type DocumentSymbolIndex, type EventSymbol } from "./eventSymbolIndexer.js";
import { computeDocumentDiagnostics, type EventDiagnostic } from "./eventDiagnosticsEngine.js";
import type { EmedfCompletionItem } from "../emedfCompletionCatalog.js";
import type { EmedfEnumDef } from "../emedfSchema.js";

export interface CancellationToken {
  readonly isCancelled: boolean;
}

export class SimpleCancellationTokenSource {
  private _isCancelled = false;

  public get token(): CancellationToken {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get isCancelled(): boolean {
        return self._isCancelled;
      }
    };
  }

  public cancel(): void {
    this._isCancelled = true;
  }
}

export interface EventRange {
  eventId: number;
  restBehavior: string;
  from: number;
  to: number;
  lineStart: number;
  lineEnd: number;
  symbol: EventSymbol;
}

export class DocumentSemanticSnapshot {
  public readonly version: number;
  public readonly text: string;
  public readonly lineCount: number;
  private readonly lineStarts: number[];
  private _symbolIndex: DocumentSymbolIndex | null = null;
  private _eventRanges: EventRange[] | null = null;

  constructor(text: string, version = 1) {
    this.text = text;
    this.version = version;

    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
    this.lineCount = starts.length;
  }

  public getLineOffset(line1Indexed: number): number {
    if (line1Indexed <= 1) return 0;
    if (line1Indexed > this.lineStarts.length) return this.text.length;
    return this.lineStarts[line1Indexed - 1] ?? 0;
  }

  public getLineNumber(offset: number): number {
    if (offset <= 0) return 1;
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.lineStarts[mid]!;
      if (start === offset) return mid + 1;
      if (start < offset) low = mid + 1;
      else high = mid - 1;
    }
    return high + 1;
  }

  public get symbolIndex(): DocumentSymbolIndex {
    if (!this._symbolIndex) {
      this._symbolIndex = indexDocumentSymbols(this.text);
    }
    return this._symbolIndex;
  }

  public get eventRanges(): readonly EventRange[] {
    if (!this._eventRanges) {
      const idx = this.symbolIndex;
      const ranges: EventRange[] = [];
      for (let i = 0; i < idx.symbols.length; i++) {
        const sym = idx.symbols[i]!;
        const nextSym = idx.symbols[i + 1];
        const to = nextSym ? nextSym.from : this.text.length;
        const lineStart = sym.line;
        const lineEnd = this.getLineNumber(to);
        ranges.push({
          eventId: sym.eventId,
          restBehavior: sym.restBehavior,
          from: sym.from,
          to,
          lineStart,
          lineEnd,
          symbol: sym
        });
      }
      this._eventRanges = ranges;
    }
    return this._eventRanges;
  }

  public getEventAt(offset: number): EventRange | null {
    const ranges = this.eventRanges;
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const r = ranges[mid]!;
      if (offset >= r.from && offset < r.to) return r;
      if (offset < r.from) high = mid - 1;
      else low = mid + 1;
    }
    return null;
  }

  public getEventsInWindow(startLine: number, endLine: number): EventRange[] {
    const startOffset = this.getLineOffset(startLine);
    const endOffset = this.getLineOffset(endLine + 1);
    return this.eventRanges.filter(
      (r) => (r.from < endOffset && r.to > startOffset)
    );
  }

  public computeWindowDiagnostics(
    window: { startLine: number; endLine: number },
    catalog: readonly EmedfCompletionItem[],
    enums?: Record<string, EmedfEnumDef>,
    cancellationToken?: CancellationToken
  ): EventDiagnostic[] {
    if (cancellationToken?.isCancelled) return [];

    const events = this.getEventsInWindow(window.startLine, window.endLine);
    if (events.length === 0) return [];

    const diagnostics: EventDiagnostic[] = [];
    for (const ev of events) {
      if (cancellationToken?.isCancelled) return [];
      const evText = this.text.slice(ev.from, ev.to);
      const evDiags = computeDocumentDiagnostics(evText, catalog, enums);
      for (const d of evDiags) {
        diagnostics.push({
          ...d,
          from: ev.from + d.from,
          to: ev.from + d.to,
          line: this.getLineNumber(ev.from + d.from),
          ...(d.suggestedFixes
            ? {
                suggestedFixes: d.suggestedFixes.map((f) => ({
                  ...f,
                  from: ev.from + f.from,
                  to: ev.from + f.to
                }))
              }
            : {})
        });
      }
    }

    return diagnostics;
  }
}
