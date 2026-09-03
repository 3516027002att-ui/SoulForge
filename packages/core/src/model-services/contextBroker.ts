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

import { createHash } from 'node:crypto';
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

const VOLATILE_EVIDENCE_KEYS = new Set([
  'callid',
  'createdat',
  'cursor',
  'nextcursor',
  'opid',
  'requestid',
  'searchid',
  'sourcehash',
  'sourcehashes',
  'sourcerevision',
  'sourcerevisions',
  'updatedat'
]);

/**
 * These are identifiers, not descriptive fields.  They are intentionally
 * narrower than "all numbers in a result": a score, row range, or byte count
 * must never make two evidence records look like the same native object.
 */
const STABLE_EVIDENCE_KEYS = new Set([
  'address',
  'animid',
  'animationid',
  'characterid',
  'entityid',
  'eventid',
  'fieldid',
  'id',
  'mapid',
  'nativeoffset',
  'npcparamid',
  'paramname',
  'refid',
  'rowid',
  'stableid',
  'symboluri',
  'table',
  'textid',
  'uri'
]);

const EVIDENCE_STATUS_RANK: Readonly<Record<string, number>> = Object.freeze({
  'native-verified': 3,
  'fixture-confirmed': 2,
  candidate: 1,
  insufficient_evidence: 0,
  not_applicable: 0
});
const NATIVE_EVIDENCE_RANK = 3;

export interface ContextEvidenceDescriptor {
  /** Stable identity used for de-duplicating one logical evidence object. */
  identity: string;
  /** Content fingerprint with volatile tickets/revisions removed. */
  fingerprint: string;
  /** Result envelope status, when the source is a structured tool result. */
  status?: string;
  /** Native evidence outranks a candidate for the same identity. */
  rank: number;
  /** Native source revision, when the result carries one. */
  sourceRevision?: number;
  /** Stable identifiers retained for diagnostics; search tickets are separate. */
  stableIds: string[];
  searchIds: string[];
}

interface ResolvedEvidenceSource {
  source: ContextEvidenceSource;
  raw: string;
  descriptor: ContextEvidenceDescriptor;
  order: number;
}

const contextEvidenceDescriptorCache = new WeakMap<
  ContextEvidenceSource,
  { raw: string; descriptor: ContextEvidenceDescriptor }
>();

function normalizeEvidenceKey(value: string): string {
  return value.replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase();
}

function normalizeEvidenceValue(value: string | number): string {
  return String(value)
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 512)
    .toLocaleLowerCase();
}

function digestEvidence(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseStructuredEvidence(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function sourceIdentityText(source: ContextEvidenceSource): string {
  if (source.text !== undefined && source.text.length > 0) return source.text;
  if (source.payload === undefined) return source.text ?? '';
  try {
    return JSON.stringify(source.payload) ?? String(source.payload);
  } catch {
    return String(source.payload);
  }
}

function addStableIdentifier(
  stableIds: Set<string>,
  key: string,
  value: string | number
): void {
  const normalizedKey = normalizeEvidenceKey(key);
  if (!STABLE_EVIDENCE_KEYS.has(normalizedKey)) return;
  const normalizedValue = normalizeEvidenceValue(value);
  if (normalizedValue.length === 0) return;
  stableIds.add(`${normalizedKey}=${normalizedValue}`);
}

function collectEvidenceIdentifiers(
  value: unknown,
  stableIds: Set<string>,
  searchIds: Set<string>,
  revisions: Set<number>,
  keyHint: string | undefined,
  depth = 0
): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) {
      if (keyHint && normalizeEvidenceKey(keyHint) === 'identifiers' && typeof item === 'string') {
        const separator = item.indexOf('=');
        if (separator > 0) {
          const identifierKey = item.slice(0, separator);
          const identifierValue = item.slice(separator + 1);
          if (normalizeEvidenceKey(identifierKey) === 'searchid') {
            if (identifierValue.trim() !== '') searchIds.add(identifierValue.trim().slice(0, 256));
          } else {
            addStableIdentifier(stableIds, identifierKey, identifierValue);
          }
        }
        continue;
      }
      collectEvidenceIdentifiers(item, stableIds, searchIds, revisions, keyHint, depth + 1);
    }
    return;
  }
  if (typeof value === 'string') {
    const normalizedKey = keyHint ? normalizeEvidenceKey(keyHint) : '';
    if (normalizedKey === 'searchid' && value.trim() !== '') searchIds.add(value.trim().slice(0, 256));
    if (normalizedKey === 'sourcerevision' || normalizedKey === 'sourcerevisions') {
      const revision = Number(value);
      if (Number.isFinite(revision)) revisions.add(revision);
    }
    if (keyHint) addStableIdentifier(stableIds, keyHint, value);
    return;
  }
  if (typeof value === 'number') {
    const normalizedKey = keyHint ? normalizeEvidenceKey(keyHint) : '';
    if ((normalizedKey === 'sourcerevision' || normalizedKey === 'sourcerevisions')
      && Number.isFinite(value)) revisions.add(value);
    if (keyHint) addStableIdentifier(stableIds, keyHint, value);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record).slice(0, 512)) {
    collectEvidenceIdentifiers(child, stableIds, searchIds, revisions, key, depth + 1);
  }
}

/** Stable serialization used only for a fallback duplicate fingerprint. */
function stableSerialize(value: unknown, keyHint?: string, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (keyHint && VOLATILE_EVIDENCE_KEYS.has(normalizeEvidenceKey(keyHint))) return '';
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 4_000));
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 256).map((item) => stableSerialize(item, keyHint, depth + 1)).join(',')}]`;
  }
  const record = asRecord(value);
  if (!record) return '';
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const serialized = stableSerialize(record[key], key, depth + 1);
    if (serialized !== '') parts.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${parts.join(',')}}`;
}

function evidenceStatusRank(status: string | undefined): number {
  if (!status) return 0;
  if (status.startsWith('native-verified')) return NATIVE_EVIDENCE_RANK;
  return EVIDENCE_STATUS_RANK[status] ?? 0;
}

function explicitMetaString(source: ContextEvidenceSource, key: string): string | undefined {
  const value = source.meta?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Describe one source without treating query text, scores, or search tickets
 * as identity.  Native records with the same real identifier therefore replace
 * a candidate, while unrelated records sharing only a file URI do not collide.
 */
export function describeContextEvidence(
  source: ContextEvidenceSource,
  rawText = sourceIdentityText(source)
): ContextEvidenceDescriptor {
  const parsed = parseStructuredEvidence(rawText);
  const stableIds = new Set<string>();
  const searchIds = new Set<string>();
  const revisions = new Set<number>();
  collectEvidenceIdentifiers(parsed, stableIds, searchIds, revisions, undefined);
  const metaEvidenceKey = explicitMetaString(source, 'evidenceKey');
  const metaStableId = explicitMetaString(source, 'stableId');
  if (metaStableId) stableIds.add(`stableid=${normalizeEvidenceValue(metaStableId)}`);

  const parsedRecord = asRecord(parsed);
  const dataRecord = asRecord(parsedRecord?.data);
  const evidenceRecord = asRecord(parsedRecord?.evidence) ?? asRecord(dataRecord?.evidence);
  const status = explicitMetaString(source, 'evidenceStatus')
    ?? (typeof evidenceRecord?.status === 'string' ? evidenceRecord.status : undefined);
  const metaRevision = source.meta?.sourceRevision;
  const sourceRevision = typeof metaRevision === 'number' && Number.isFinite(metaRevision)
    ? metaRevision
    : revisions.size > 0 ? Math.max(...revisions) : undefined;
  const identityParts = [...stableIds].sort();
  const fingerprint = digestEvidence(
    `${source.kind}\u0000${source.uri ?? ''}\u0000${stableSerialize(parsed ?? rawText)}`
  );
  const identity = metaEvidenceKey
    ? `explicit:${digestEvidence(normalizeEvidenceValue(metaEvidenceKey))}`
    : identityParts.length > 0
      ? `stable:${digestEvidence(identityParts.join('\u0000'))}`
      : `body:${digestEvidence(`${source.kind}\u0000${source.uri ?? ''}\u0000${stableSerialize(parsed ?? rawText)}`)}`;
  return {
    identity,
    fingerprint,
    ...(status ? { status } : {}),
    rank: evidenceStatusRank(status),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    stableIds: identityParts,
    searchIds: [...searchIds].sort()
  };
}

function describeCachedContextEvidence(
  source: ContextEvidenceSource,
  rawText = sourceIdentityText(source)
): ContextEvidenceDescriptor {
  const cached = contextEvidenceDescriptorCache.get(source);
  if (cached?.raw === rawText) return cached.descriptor;
  const descriptor = describeContextEvidence(source, rawText);
  contextEvidenceDescriptorCache.set(source, { raw: rawText, descriptor });
  return descriptor;
}

function shouldReplaceEvidence(
  previous: ResolvedEvidenceSource,
  next: ResolvedEvidenceSource
): boolean {
  if (next.descriptor.rank !== previous.descriptor.rank) {
    return next.descriptor.rank > previous.descriptor.rank;
  }
  if (next.descriptor.rank >= NATIVE_EVIDENCE_RANK) {
    const previousRevision = previous.descriptor.sourceRevision;
    const nextRevision = next.descriptor.sourceRevision;
    if (previousRevision !== undefined && nextRevision === undefined) return false;
    if (previousRevision === undefined && nextRevision !== undefined) return true;
    if (previousRevision !== undefined && nextRevision !== undefined
      && previousRevision !== nextRevision) {
      return nextRevision > previousRevision;
    }
  }
  if (next.descriptor.fingerprint === previous.descriptor.fingerprint) return false;
  return next.order > previous.order;
}

function deduplicateResolvedSources(
  sources: ResolvedEvidenceSource[]
): ResolvedEvidenceSource[] {
  const winners: ResolvedEvidenceSource[] = [];
  const positions = new Map<string, number>();
  for (const source of sources) {
    const position = positions.get(source.descriptor.identity);
    if (position === undefined) {
      positions.set(source.descriptor.identity, winners.length);
      winners.push(source);
      continue;
    }
    const previous = winners[position]!;
    if (shouldReplaceEvidence(previous, source)) winners[position] = source;
  }
  return winners;
}

/**
 * Upsert tool-result evidence in the Agent loop without allowing a later
 * candidate to displace a native read.  Returns whether the visible set
 * changed, so callers can skip a model-context rebuild for exact repeats.
 */
export function upsertContextEvidenceSources(
  target: ContextEvidenceSource[],
  additions: ContextEvidenceSource[]
): boolean {
  const existing = target.map((source, order) => {
    const raw = sourceIdentityText(source);
    return {
      source,
      raw,
      descriptor: describeCachedContextEvidence(source, raw),
      order
    };
  });
  const incoming = additions.map((source, offset) => {
    const raw = sourceIdentityText(source);
    return {
      source,
      raw,
      descriptor: describeCachedContextEvidence(source, raw),
      order: existing.length + offset
    };
  });
  const merged = deduplicateResolvedSources([...existing, ...incoming]);
  const changed = merged.length !== existing.length
    || merged.some((item, index) => item.source !== existing[index]?.source);
  target.length = 0;
  target.push(...merged.map((item) => item.source));
  return changed;
}

function failureResult(code: ContextBrokerFailureCode, message: string): ContextBrokerFailure {
  return {
    ok: false,
    code,
    message,
    diagnostics: [{ severity: 'error', code, message }]
  };
}

export function createContextBroker(): ContextBroker {
  let cachedAssembly: {
    sources: ContextEvidenceSource[];
    sourceTexts: string[];
    optionsKey: string;
    result: ContextBrokerResult;
  } | undefined;

  const canReuseAssembly = (
    sources: ContextEvidenceSource[],
    options: Required<Pick<ContextBrokerOptions, 'maxBytes' | 'maxEntries' | 'excerptLength'>>
  ): boolean => {
    if (sources.some((source) => source.readText !== undefined)) return false;
    if (!cachedAssembly || cachedAssembly.sources.length !== sources.length) return false;
    const optionsKey = `${options.maxBytes}|${options.maxEntries}|${options.excerptLength}`;
    return cachedAssembly.optionsKey === optionsKey
      && cachedAssembly.sources.every((source, index) => source === sources[index])
      && cachedAssembly.sourceTexts.every((raw, index) => raw === sourceIdentityText(sources[index]!));
  };

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

        if (options?.signal === undefined
          && canReuseAssembly(sources, { maxBytes, maxEntries, excerptLength })) {
          return cachedAssembly!.result;
        }

        const valid = sources.filter(hasContent);
        if (valid.length === 0) {
          return failureResult('insufficient_evidence', '没有可装配的工作区证据。');
        }

        const resolved: ResolvedEvidenceSource[] = [];
        let sourceOrder = 0;
        for (const source of valid) {
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
          if (raw.length === 0) continue;
          resolved.push({
            source,
            raw,
            descriptor: describeCachedContextEvidence(source, raw),
            order: sourceOrder
          });
          sourceOrder += 1;
        }

        const unique = deduplicateResolvedSources(resolved);
        if (unique.length === 0) {
          return failureResult('insufficient_evidence', '没有可装配的工作区证据。');
        }

        const parts: string[] = [];
        const sections: ContextSectionRecord[] = [];
        let totalBytes = 0;
        let usedEntries = 0;
        let omitted = 0;

        for (const resolvedSource of unique) {
          const source = resolvedSource.source;
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

          const raw = resolvedSource.raw;
          const redacted = redactSecrets(raw);
          const redactionHappened = redacted !== raw;
          // 先脱敏、再截取摘要，不能用完整 source 的大小提前拒绝。
          // 大文件仍然可以贡献 bounded evidence；只有摘要/头部本身无法放入
          // 总预算时，下面的统一 budget 分支才会 fail closed。
          const excerpt = redacted.slice(0, Math.min(excerptLength, maxBytes));
          const truncated = excerpt.length < redacted.length;
          const sourceBytes = source.sourceBytes ?? raw.length;
          const header = buildHeader(
            source, excerpt.length, sourceBytes, truncated, redactionHappened
          );
          const bytes = sectionBytes(header, excerpt);
          if (totalBytes + bytes > maxBytes) {
            omitted += 1;
            continue;
          }
          parts.push(header, excerpt);
          totalBytes += bytes;
          sections.push(makeSectionRecord(
            source, excerpt.length, sourceBytes, truncated, redactionHappened
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
        const result: ContextBrokerResult = { ok: true, context, sections, totalBytes, diagnostics: [] };
        if (options?.signal === undefined
          && unique.every((item) => item.source.readText === undefined)) {
          cachedAssembly = {
            sources: [...sources],
            sourceTexts: sources.map((source) => sourceIdentityText(source)),
            optionsKey: `${maxBytes}|${maxEntries}|${excerptLength}`,
            result
          };
        }
        return result;
      } finally {
        cleanup();
      }
    }
  };
}
