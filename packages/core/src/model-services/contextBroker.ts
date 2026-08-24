/**
 * Context Broker — evidence/context assembly layer for the agent loop (G-AGENT).
 *
 * Before each model call the broker assembles bounded, redacted context fragments
 * from workspace evidence (readFile content, resource graph, diagnostics, patch-plan
 * context, prior tool results). It enforces:
 *   - bounded size: maxBytes / maxEntries / per-section excerpt caps
 *   - redaction:  raw secrets never reach the injected context
 *   - cancellation / timeout: pending async evidence reads can be interrupted
 *   - insufficient_evidence: structured result when no evidence is available
 *
 * The broker performs no network I/O and never writes files. Offline smoke
 * coverage is provided by runAiFakeLoopSmoke.ts / runAiConformanceSmoke.ts.
 */

import { createRequestSignal } from './errorClassification.js';
import { redactSecrets } from './agentLoop.js';
import type {
  ContextBroker,
  ContextBrokerOptions,
  ContextBrokerResult,
  ContextEvidenceKind,
  ContextEvidenceSource,
  ContextSectionRecord
} from './types.js';

class ContextAbortedError extends Error {
  constructor() {
    super('evidence read aborted');
    this.name = 'ContextAbortedError';
  }
}

function defaultOptions(options: ContextBrokerOptions | undefined): Required<
  Pick<ContextBrokerOptions, 'maxBytes' | 'maxEntries' | 'excerptLength'>
> {
  return {
    maxBytes: options?.maxBytes ?? 12000,
    maxEntries: options?.maxEntries ?? 16,
    excerptLength: options?.excerptLength ?? 600
  };
}

function waitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Classify why assembly stopped. A caller signal means cancellation; a
 * TimeoutError reason on the combined signal means a timeout. Undefined means
 * no abort is active.
 */
function abortKind(
  callerSignal: AbortSignal | undefined,
  combinedSignal: AbortSignal | undefined
): 'cancelled' | 'timeout' | undefined {
  if (callerSignal?.aborted) return 'cancelled';
  if (combinedSignal?.aborted) {
    const reason = combinedSignal.reason as { name?: string } | undefined;
    return reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  }
  return undefined;
}

async function extractText(
  source: ContextEvidenceSource,
  signal: AbortSignal | undefined
): Promise<string> {
  const read = source.readText
    ? source.readText()
    : Promise.resolve(
        source.text ?? (source.payload !== undefined ? JSON.stringify(source.payload) : '')
      );
  if (!signal) return read;
  return Promise.race([
    read,
    waitAbort(signal).then(() => {
      throw new ContextAbortedError();
    })
  ]);
}

function hasContent(source: ContextEvidenceSource): boolean {
  if (source.readText) return true;
  if (source.text && source.text.length > 0) return true;
  return source.payload !== undefined;
}

function sectionBytes(header: string, excerpt: string): number {
  return Buffer.byteLength(header, 'utf8') + Buffer.byteLength(excerpt, 'utf8') + 1;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
}

function buildHeader(
  source: ContextEvidenceSource,
  excerptLength: number,
  sourceBytes: number,
  truncated: boolean,
  redacted: boolean
): string {
  const flags = [
    ...(truncated ? ['truncated'] : []),
    ...(redacted ? ['redacted'] : [])
  ].join(',');
  const flagPart = flags ? ` ${flags}` : '';
  const uriPart = source.uri ? ` uri=${source.uri}` : '';
  const identity = safeMetaString(source.meta?.identity ?? source.meta?.address);
  const revision = safeMetaString(source.meta?.sourceRevision ?? source.meta?.revision);
  const coverage = safeMetaString(source.meta?.coverageStatus ?? source.meta?.coverage);
  const facts = [
    identity ? ` identity=${identity}` : '',
    revision ? ` revision=${revision}` : '',
    coverage ? ` coverage=${coverage}` : ''
  ].join('');
  return `-- evidence=${source.kind}${uriPart}${facts} (sourceBytes=${sourceBytes} excerpt=${excerptLength}${flagPart}) --`;
}

function makeSectionRecord(
  source: ContextEvidenceSource,
  excerptLength: number,
  sourceBytes: number,
  truncated: boolean,
  redacted: boolean
): ContextSectionRecord {
  const identity = safeMetaString(source.meta?.identity ?? source.meta?.address);
  const sourceRevision = safeMetaString(source.meta?.sourceRevision ?? source.meta?.revision);
  const coverageStatus = safeMetaString(source.meta?.coverageStatus ?? source.meta?.coverage);
  const record: ContextSectionRecord = {
    kind: source.kind as ContextEvidenceKind,
    excerptLength,
    sourceBytes,
    truncated,
    redacted
  };
  if (source.uri !== undefined) record.uri = source.uri;
  if (identity) record.identity = identity;
  if (sourceRevision) record.sourceRevision = sourceRevision;
  if (coverageStatus) record.coverageStatus = coverageStatus;
  return record;
}

function safeMetaString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const text = String(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function ranking(source: ContextEvidenceSource, position: number): [number, string, number, number] {
  const authority = typeof source.meta?.authorityRank === 'number' && Number.isFinite(source.meta.authorityRank)
    ? source.meta.authorityRank : 0;
  const relevance = typeof source.meta?.relevanceScore === 'number' && Number.isFinite(source.meta.relevanceScore)
    ? source.meta.relevanceScore : 0;
  const updated = safeMetaString(source.meta?.updatedAt ?? source.meta?.recordedAt) ?? '';
  const kindRank = source.kind === 'readFile' || source.kind === 'resourceGraph' ? 3
    : source.kind === 'diagnostics' || source.kind === 'patchPlan' ? 2 : 1;
  return [authority + kindRank, updated, relevance, -position];
}

type ContextBrokerFailureCode = Extract<ContextBrokerResult, { ok: false }>['code'];
type ContextBrokerFailure = Extract<ContextBrokerResult, { ok: false }>;

function failureResult(code: ContextBrokerFailureCode, message: string): ContextBrokerFailure {
  return {
    ok: false,
    code,
    message,
    diagnostics: [{ severity: 'error', code, message }]
  };
}

export function createContextBroker(): ContextBroker {
  return {
    async assemble(
      sources: ContextEvidenceSource[],
      options: ContextBrokerOptions | undefined
    ): Promise<ContextBrokerResult> {
      const { maxBytes, maxEntries, excerptLength } = defaultOptions(options);
      const { signal, cleanup } = createRequestSignal(options?.signal, options?.timeoutMs);
      try {
        const early = abortKind(options?.signal, signal);
        if (early) {
          return failureResult(early === 'cancelled' ? 'CONTEXT_CANCELLED' : 'CONTEXT_TIMEOUT',
            early === 'cancelled'
              ? '上下文装配已取消。'
              : '上下文装配超时。');
        }

        let staleOmitted = 0;
        const valid = sources
          .filter(hasContent)
          .filter((source) => {
            const expected = options?.currentSourceRevision;
            const revision = source.meta?.sourceRevision;
            if (!expected || revision === undefined || String(revision) === expected) return true;
            staleOmitted += 1;
            return false;
          })
          .map((source, position) => ({ source, position }))
          .sort((left, right) => {
            const a = ranking(left.source, left.position);
            const b = ranking(right.source, right.position);
            return b[0] - a[0] || b[1].localeCompare(a[1]) || b[2] - a[2] || b[3] - a[3];
          })
          .map((entry) => entry.source);
        if (valid.length === 0) {
          return failureResult('insufficient_evidence', '没有可装配的工作区证据。');
        }

        const parts: string[] = [];
        const sections: ContextSectionRecord[] = [];
        let totalBytes = 0;
        let usedEntries = 0;
        let omitted = staleOmitted;

        for (const source of valid) {
          if (usedEntries >= maxEntries) {
            omitted += 1;
            continue;
          }
          const interrupted = abortKind(options?.signal, signal);
          if (interrupted) {
            return failureResult(
              interrupted === 'cancelled' ? 'CONTEXT_CANCELLED' : 'CONTEXT_TIMEOUT',
              interrupted === 'cancelled'
                ? '上下文装配已取消。'
                : '上下文装配超时。'
            );
          }

          let raw: string;
          try {
            raw = await extractText(source, signal);
          } catch (error) {
            if (error instanceof ContextAbortedError) {
              const kind = abortKind(options?.signal, signal) ?? 'cancelled';
              return failureResult(
                kind === 'cancelled' ? 'CONTEXT_CANCELLED' : 'CONTEXT_TIMEOUT',
                kind === 'cancelled'
                  ? '上下文装配已取消。'
                  : '上下文装配超时。'
              );
            }
            throw error;
          }

          const interruptedAfterRead = abortKind(options?.signal, signal);
          if (interruptedAfterRead) {
            return failureResult(
              interruptedAfterRead === 'cancelled' ? 'CONTEXT_CANCELLED' : 'CONTEXT_TIMEOUT',
              interruptedAfterRead === 'cancelled'
                ? '上下文装配已取消。'
                : '上下文装配超时。'
            );
          }

          const redacted = redactSecrets(raw);
          const redactionHappened = redacted !== raw;
          const rawBytes = source.sourceBytes ?? utf8Bytes(raw);
          const redactedBytes = utf8Bytes(redacted);
          // Large evidence is excerpted before the global budget is applied.
          // This preserves useful authoritative metadata for a large document
          // instead of turning the whole source into a hard failure.
          const requestedExcerpt = redacted.slice(0, Math.min(excerptLength, redacted.length));
          const remaining = Math.max(0, maxBytes - totalBytes);
          let excerpt = truncateUtf8(requestedExcerpt, remaining);
          let truncated = excerpt.length < redacted.length || utf8Bytes(excerpt) < redactedBytes;
          let header = buildHeader(
            source, utf8Bytes(excerpt), rawBytes, truncated, redactionHappened
          );
          let bytes = sectionBytes(header, excerpt);

          // Header metadata shares the same hard budget. Shrink the excerpt to
          // the largest valid UTF-8 prefix that still fits after the header.
          if (bytes > remaining && remaining > 0) {
            let low = 0;
            let high = utf8Bytes(excerpt);
            let best = '';
            while (low <= high) {
              const middle = Math.floor((low + high) / 2);
              const candidate = truncateUtf8(excerpt, middle);
              const candidateHeader = buildHeader(
                source, utf8Bytes(candidate), rawBytes, true, redactionHappened
              );
              const candidateBytes = sectionBytes(candidateHeader, candidate);
              if (candidateBytes <= remaining) {
                best = candidate;
                low = middle + 1;
              } else {
                high = middle - 1;
              }
            }
            excerpt = best;
            truncated = true;
            header = buildHeader(
              source, utf8Bytes(excerpt), rawBytes, truncated, redactionHappened
            );
            bytes = sectionBytes(header, excerpt);
          }

          if (bytes > remaining || excerpt.length === 0) {
            omitted += 1;
            continue;
          }
          parts.push(header, excerpt);
          totalBytes += bytes;
          sections.push(makeSectionRecord(
            source, utf8Bytes(excerpt), rawBytes, truncated, redactionHappened
          ));
          usedEntries += 1;
        }

        if (parts.length === 0) {
          if (omitted > 0) {
            return failureResult(
              'CONTEXT_LIMIT_EXCEEDED',
              `没有任何证据片段能放入 ${maxBytes} 字节的 context 预算。`
            );
          }
          return failureResult('insufficient_evidence', '没有可装配的工作区证据。');
        }

        const head = `[evidence-context sections=${sections.length} bytes=${totalBytes}]`;
        const tail = omitted > 0 ? `[context truncated: ${omitted} sections omitted]` : '';
        const context = [head, ...parts, ...(tail ? [tail] : [])].join('\n');
        return { ok: true, context, sections, totalBytes, diagnostics: [] };
      } finally {
        cleanup();
      }
    }
  };
}
