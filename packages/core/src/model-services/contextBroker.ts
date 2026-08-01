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
  return header.length + excerpt.length + 1;
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
  return `-- evidence=${source.kind}${uriPart} (sourceBytes=${sourceBytes} excerpt=${excerptLength}${flagPart}) --`;
}

function makeSectionRecord(
  source: ContextEvidenceSource,
  excerptLength: number,
  sourceBytes: number,
  truncated: boolean,
  redacted: boolean
): ContextSectionRecord {
  const record: ContextSectionRecord = {
    kind: source.kind as ContextEvidenceKind,
    excerptLength,
    sourceBytes,
    truncated,
    redacted
  };
  if (source.uri !== undefined) record.uri = source.uri;
  return record;
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

        const valid = sources.filter(hasContent);
        if (valid.length === 0) {
          return failureResult('insufficient_evidence', '没有可装配的工作区证据。');
        }

        const parts: string[] = [];
        const sections: ContextSectionRecord[] = [];
        let totalBytes = 0;
        let usedEntries = 0;
        let omitted = 0;

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
          // A single oversized section cannot be honestly squeezed in — fail closed.
          if (redacted.length > maxBytes) {
            return failureResult(
              'CONTEXT_LIMIT_EXCEEDED',
              `证据片段 ${source.uri ?? source.kind} 原始 ${redacted.length} 字节超过 context 上限 ${maxBytes} 字节。`
            );
          }

          const excerpt = redacted.slice(0, excerptLength);
          const truncated = excerpt.length < redacted.length;
          const header = buildHeader(
            source, excerpt.length, raw.length, truncated, redactionHappened
          );
          const bytes = sectionBytes(header, excerpt);
          if (totalBytes + bytes > maxBytes) {
            omitted += 1;
            continue;
          }
          parts.push(header, excerpt);
          totalBytes += bytes;
          sections.push(makeSectionRecord(
            source, excerpt.length, raw.length, truncated, redactionHappened
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
