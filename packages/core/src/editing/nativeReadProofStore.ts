/** T09 宿主读取证明：内部事实，不是台账表单；不暴露给模型。 */
export interface HostDeliveredNativeRead {
  principal: string;
  workspaceId: string;
  /** 精确对象稳定键（不丢失 child identity）。 */
  objectKey: string;
  outerSourceKey: string;
  version: {
    outerFileHash?: string;
    childHash?: string;
    sourceRevision?: number;
    generation?: number;
  };
  /** 最终 envelope 中实际保留的原生字段/范围。 */
  deliveredFields?: string[];
  deliveredTextRange?: { startByte: number; endByte: number; totalUtf8Bytes: number; fullTextHash: string };
  readShape: 'fields' | 'full-event' | 'full-script' | 'window' | 'fragment';
  capability?: string;
}

export interface HostWriteRequirement {
  principal: string;
  workspaceId: string;
  objectKey: string;
  outerSourceKey: string;
  version: {
    outerFileHash?: string;
    childHash?: string;
    sourceRevision?: number;
    generation?: number;
  };
  requiredFields?: string[];
  requiredShape?: 'fields' | 'full-event' | 'full-script';
  requiredTextRange?: { startByte: number; endByte: number };
}

export interface ValidatedNativeReadProof {
  objectKey: string;
  outerSourceKey: string;
  version: { outerFileHash?: string; childHash?: string; sourceRevision?: number; generation?: number };
  coveredFields: string[];
}

export class ProofError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface StoredProof extends ValidatedNativeReadProof {
  principal: string;
  workspaceId: string;
  readShape: HostDeliveredNativeRead['readShape'];
  deliveredTextRange?: HostDeliveredNativeRead['deliveredTextRange'];
  /** 全文分页账本：同版本同全文哈希的已送达页；跨版本/跨哈希不合并（P13/P14）。 */
  deliveredPages: Array<NonNullable<HostDeliveredNativeRead['deliveredTextRange']>>;
  capability?: string;
}

function isValidDeliveredPage(range: HostDeliveredNativeRead['deliveredTextRange']): boolean {
  if (!range) return false;
  const { startByte, endByte, totalUtf8Bytes, fullTextHash } = range;
  return Number.isSafeInteger(startByte) && Number.isSafeInteger(endByte) && Number.isSafeInteger(totalUtf8Bytes)
    && typeof fullTextHash === 'string' && fullTextHash.length > 0
    && startByte >= 0 && endByte >= startByte && endByte <= totalUtf8Bytes && totalUtf8Bytes >= 0;
}

/** 页并集是否恰好覆盖 [0, total)：缺一字节即不完整；重复页不增加覆盖。 */
function textPagesCoverFull(pages: StoredProof['deliveredPages']): boolean {
  if (pages.length === 0) return false;
  const total = pages[0]!.totalUtf8Bytes;
  const hash = pages[0]!.fullTextHash;
  if (!pages.every((page) => page.totalUtf8Bytes === total && page.fullTextHash === hash)) return false;
  const sorted = [...pages].sort((a, b) => a.startByte - b.startByte);
  let covered = 0;
  for (const page of sorted) {
    if (page.startByte > covered) return false;
    covered = Math.max(covered, page.endByte);
  }
  return covered === total;
}

/** [start,end) 是否被页并集完全包含。 */
function textPagesCoverRange(pages: StoredProof['deliveredPages'], startByte: number, endByte: number): boolean {
  if (pages.length === 0) return false;
  const sorted = [...pages].sort((a, b) => a.startByte - b.startByte);
  let cursor = startByte;
  for (const page of sorted) {
    if (page.startByte > cursor) return false;
    if (page.endByte > cursor) cursor = Math.min(page.endByte, endByte);
    if (cursor >= endByte) return true;
  }
  return cursor >= endByte;
}

function versionsMatch(stored: StoredProof['version'], required: HostWriteRequirement['version']): boolean {
  if (stored.generation !== undefined && required.generation !== undefined && stored.generation !== required.generation) return false;
  if (stored.outerFileHash !== undefined && required.outerFileHash !== undefined && stored.outerFileHash !== required.outerFileHash) return false;
  if (stored.childHash !== undefined && required.childHash !== undefined && stored.childHash !== required.childHash) return false;
  if (stored.sourceRevision !== undefined && required.sourceRevision !== undefined && stored.sourceRevision !== required.sourceRevision) return false;
  return true;
}

export interface NativeReadProofStore {
  acceptDeliveredRead(input: HostDeliveredNativeRead): void;
  requireCoverage(input: HostWriteRequirement): ValidatedNativeReadProof;
  invalidateSource(sourceKey: string, generation: number): void;
  invalidateAll(reason: string): void;
  dispose(): void;
}

export function createNativeReadProofStore(): NativeReadProofStore {
  const proofs = new Map<string, StoredProof>();
  let disposed = false;

  function keyFor(principal: string, workspaceId: string, objectKey: string): string {
    return `${principal}|${workspaceId}|${objectKey}`;
  }

  return {
    acceptDeliveredRead(input: HostDeliveredNativeRead): void {
      if (disposed) throw new ProofError('NATIVE_READ_REQUIRED', 'proof store disposed');
      // 存入防御性拷贝：调用方事后修改传入数组/范围不得污染存储。
      const coveredFields = [...(input.deliveredFields ?? [])];
      const page = input.deliveredTextRange === undefined ? undefined : { ...input.deliveredTextRange };
      if (page !== undefined && !isValidDeliveredPage(page)) {
        throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'invalid delivered text page range');
      }
      const key = keyFor(input.principal, input.workspaceId, input.objectKey);
      const fullShape = input.readShape === 'full-event' || input.readShape === 'full-script';
      const existing = proofs.get(key);
      // 全文分页合并：同形状、同版本、同总长度、同全文哈希的页记入同一账本；
      // 跨版本/跨哈希/跨形状另起账本，旧页不得参与新全文证明（P14）。
      if (fullShape && page !== undefined && existing !== undefined
        && existing.readShape === input.readShape
        && versionsMatch(existing.version, input.version)
        && existing.deliveredPages.length > 0
        && existing.deliveredPages[0]!.totalUtf8Bytes === page.totalUtf8Bytes
        && existing.deliveredPages[0]!.fullTextHash === page.fullTextHash) {
        const duplicate = existing.deliveredPages.some((known) =>
          known.startByte === page.startByte && known.endByte === page.endByte);
        if (!duplicate) existing.deliveredPages.push(page);
        existing.deliveredTextRange = { ...page };
        return;
      }
      const stored: StoredProof = {
        principal: input.principal,
        workspaceId: input.workspaceId,
        objectKey: input.objectKey,
        outerSourceKey: input.outerSourceKey,
        version: { ...input.version },
        coveredFields,
        readShape: input.readShape,
        deliveredPages: page === undefined ? [] : [page]
      };
      if (page !== undefined) stored.deliveredTextRange = { ...page };
      if (input.capability !== undefined) stored.capability = input.capability;
      proofs.set(key, stored);
    },
    requireCoverage(input: HostWriteRequirement): ValidatedNativeReadProof {
      if (disposed) throw new ProofError('NATIVE_READ_REQUIRED', 'proof store unavailable; fail closed');
      const stored = proofs.get(keyFor(input.principal, input.workspaceId, input.objectKey));
      if (!stored) throw new ProofError('NATIVE_READ_REQUIRED', `no delivered read for ${input.objectKey}`);
      if (stored.outerSourceKey !== input.outerSourceKey) {
        throw new ProofError('NATIVE_READ_REQUIRED', 'outer source mismatch');
      }
      if (!versionsMatch(stored.version, input.version)) {
        throw new ProofError('NATIVE_READ_STALE', 'source version changed since delivered read');
      }
      if (input.requiredShape === 'full-event' || input.requiredShape === 'full-script') {
        if (stored.readShape !== input.requiredShape) {
          throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'fragment/outline cannot authorize whole-object replacement');
        }
        // 账本优先：多页并集判定；无账本时回退单范围判定（兼容旧调用）。
        const pages = stored.deliveredPages.length > 0
          ? stored.deliveredPages
          : (stored.deliveredTextRange && isValidDeliveredPage(stored.deliveredTextRange) ? [stored.deliveredTextRange] : []);
        if (input.requiredTextRange) {
          const { startByte, endByte } = input.requiredTextRange;
          if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte < startByte
            || !textPagesCoverRange(pages, startByte, endByte)) {
            throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'required range exceeds delivered range');
          }
        } else if (!textPagesCoverFull(pages)) {
          throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', 'whole-object proof requires full delivered range');
        }
      }
      if (input.requiredFields) {
        const missing = input.requiredFields.filter((field) => !stored.coveredFields.includes(field));
        if (missing.length > 0) {
          throw new ProofError('NATIVE_READ_COVERAGE_INCOMPLETE', `payload fields not delivered: ${missing.join(',')}`);
        }
      }
      return { objectKey: stored.objectKey, outerSourceKey: stored.outerSourceKey, version: { ...stored.version }, coveredFields: [...stored.coveredFields] };
    },
    invalidateSource(sourceKey: string, generation: number): void {
      for (const [key, proof] of proofs) {
        if (proof.outerSourceKey === sourceKey) {
          proof.version.generation = generation;
          proofs.delete(key);
        }
      }
    },
    invalidateAll(_reason: string): void {
      proofs.clear();
    },
    dispose(): void {
      disposed = true;
      proofs.clear();
    }
  };
}

