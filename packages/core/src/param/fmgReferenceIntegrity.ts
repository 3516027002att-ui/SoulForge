/**
 * FMG reference-integrity diagnostics (read-only).
 *
 * Scans FMG v2 documents for the `<?tag@id?>` / `<?tag?>` reference grammar
 * observed in the real Sekiro zhocn corpus (menu.msgbnd / item.msgbnd —
 * e.g. `<?placeName@1000?>`, `<?kgiconKc@18?>`, `<?bmsg?>`, `<?null?>`),
 * and reports structured diagnostics:
 *
 *   - duplicate entry ids within one document             -> error
 *   - reference targets outside signed 32-bit range       -> error
 *   - negative reference targets                          -> warning
 *   - reference targets missing from the container-wide
 *     id set                                              -> warning
 *     (the tag may point at an external resource such as a
 *     key-guide icon or gdsparam rather than an FMG entry;
 *     SoulForge does not assert tag semantics — it only reports
 *     container-resolution status, so a miss is a warning, not
 *     a hard error)
 *   - reference targets present in the container id set   -> info
 *   - marker references without an id (`<?bmsg?>`)        -> info
 *
 * This is a read-only integrity pass. It never opens a write path.
 */

export interface FmgReferenceEntry {
  id: number;
  text: string;
}

export interface FmgReferenceDocument {
  index: number;
  name: string;
  entries: FmgReferenceEntry[];
}

export interface FmgReferenceMatch {
  tag: string;
  /** Numeric target when the `@id` form was used. */
  targetId: number | undefined;
  /** Character offset of the reference within the entry text. */
  textIndex: number;
}

export interface FmgReferenceIntegrityDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  documentIndex: number;
  documentName: string;
  entryId: number;
  tag?: string;
  targetId?: number;
  textIndex: number;
  message: string;
}

export interface FmgReferenceIntegrityInput {
  documents: FmgReferenceDocument[];
}

export interface FmgReferenceIntegritySummary {
  documentCount: number;
  entryCount: number;
  containerUniqueIdCount: number;
  referenceCount: number;
  withIdReferenceCount: number;
  markerReferenceCount: number;
  resolvedCount: number;
  danglingCount: number;
  invalidCount: number;
  negativeCount: number;
  duplicateIdCount: number;
  /** References counted per tag (sorted). */
  referencesByTag: Record<string, number>;
  truncatedDiagnostics: boolean;
}

export interface FmgReferenceIntegrityResult {
  ok: boolean;
  diagnostics: FmgReferenceIntegrityDiagnostic[];
  summary: FmgReferenceIntegritySummary;
}

/** Signed 32-bit FMG entry id storage ceiling. */
const FMG_ID_MAX = 0x7fffffff;
/** Read-only diagnostics are bounded so adversarial corpora cannot grow output unboundedly. */
const MAX_DIAGNOSTICS = 512;

/** `<?tag@id?>` / `<?tag?>` grammar observed on real Sekiro FMG texts. */
const FMG_REFERENCE_PATTERN = /<\?([A-Za-z][A-Za-z0-9_]*)(?:@(-?\d+))?\?>/g;

/**
 * Extracts all `<?tag...?>` references from a single FMG entry text.
 * Deterministic; never mutates its input.
 */
export function extractFmgReferences(text: string): FmgReferenceMatch[] {
  const matches: FmgReferenceMatch[] = [];
  FMG_REFERENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FMG_REFERENCE_PATTERN)) {
    const tag = match[1]!;
    matches.push({
      tag,
      targetId: match[2] === undefined ? undefined : Number(match[2]),
      textIndex: match.index
    });
  }
  return matches;
}

/**
 * Runs the read-only reference-integrity pass over a set of FMG documents
 * that belong to one container (a single msgbnd). The container-wide entry
 * id set is the resolution domain: a target id that exists anywhere in the
 * container counts as resolved, a missing target is a dangling/possibly
 * external-reference warning.
 */
export function analyzeFmgReferenceIntegrity(
  input: FmgReferenceIntegrityInput
): FmgReferenceIntegrityResult {
  const diagnostics: FmgReferenceIntegrityDiagnostic[] = [];
  let diagnosticTruncated = false;
  const push = (diagnostic: FmgReferenceIntegrityDiagnostic): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      diagnosticTruncated = true;
      return;
    }
    diagnostics.push(diagnostic);
  };

  const containerIds = new Set<number>();
  let entryCount = 0;
  for (const document of input.documents) {
    entryCount += document.entries.length;
    for (const entry of document.entries) containerIds.add(entry.id);
  }

  const referencesByTag: Record<string, number> = {};
  let referenceCount = 0;
  let withIdReferenceCount = 0;
  let markerReferenceCount = 0;
  let resolvedCount = 0;
  let danglingCount = 0;
  let invalidCount = 0;
  let negativeCount = 0;
  let duplicateIdCount = 0;

  for (const document of input.documents) {
    // Duplicate entry ids within one document are a hard integrity error.
    const seenIds = new Set<number>();
    for (const entry of document.entries) {
      if (seenIds.has(entry.id)) {
        duplicateIdCount += 1;
        push({
          severity: 'error',
          code: 'FMG_REF_DUPLICATE_ENTRY_ID',
          documentIndex: document.index,
          documentName: document.name,
          entryId: entry.id,
          textIndex: 0,
          message: `FMG 文档 ${document.name} 内条目 id ${entry.id} 重复。`
        });
      }
      seenIds.add(entry.id);
    }

    for (const entry of document.entries) {
      const references = extractFmgReferences(entry.text);
      for (const reference of references) {
        referenceCount += 1;
        referencesByTag[reference.tag] = (referencesByTag[reference.tag] ?? 0) + 1;
        const position: Pick<FmgReferenceIntegrityDiagnostic, 'documentIndex' | 'documentName' | 'entryId' | 'tag' | 'targetId' | 'textIndex'> = {
          documentIndex: document.index,
          documentName: document.name,
          entryId: entry.id,
          tag: reference.tag,
          textIndex: reference.textIndex
        };
        if (reference.targetId === undefined) {
          markerReferenceCount += 1;
          push({
            ...position,
            severity: 'info',
            code: 'FMG_REF_MARKER',
            message: `条目 ${entry.id} 包含无 id 的标记引用 <${reference.tag}?>(位置 ${reference.textIndex})。`
          });
          continue;
        }
        withIdReferenceCount += 1;
        const targetId = reference.targetId;
        if (targetId < 0) {
          negativeCount += 1;
          push({
            ...position,
            targetId,
            severity: 'warning',
            code: 'FMG_REF_NEGATIVE_TARGET',
            message: `条目 ${entry.id} 的引用目标 id ${targetId} 为负数（位置 ${reference.textIndex}）。`
          });
          continue;
        }
        if (targetId > FMG_ID_MAX) {
          invalidCount += 1;
          push({
            ...position,
            targetId,
            severity: 'error',
            code: 'FMG_REF_INVALID_TARGET',
            message: `条目 ${entry.id} 的引用目标 id ${targetId} 超出 FMG 有符号 32 位存储上限（位置 ${reference.textIndex}）。`
          });
          continue;
        }
        if (containerIds.has(targetId)) {
          resolvedCount += 1;
          push({
            ...position,
            targetId,
            severity: 'info',
            code: 'FMG_REF_RESOLVED',
            message: `条目 ${entry.id} 的引用 <${reference.tag}@${targetId}?> 在容器条目集合中解析成功（位置 ${reference.textIndex}）。`
          });
        } else {
          danglingCount += 1;
          push({
            ...position,
            targetId,
            severity: 'warning',
            code: 'FMG_REF_DANGLING_TARGET',
            message: `条目 ${entry.id} 的引用 <${reference.tag}@${targetId}?> 目标不在容器条目集合中（位置 ${reference.textIndex}）；该 tag 可能引用外部资源（如键位图标/gdsparam），SoulForge 不声明其语义。`
          });
        }
      }
    }
  }

  const sortedTags = Object.keys(referencesByTag).sort();
  const orderedReferencesByTag: Record<string, number> = {};
  for (const tag of sortedTags) orderedReferencesByTag[tag] = referencesByTag[tag]!;

  return {
    ok: invalidCount === 0 && duplicateIdCount === 0,
    diagnostics,
    summary: {
      documentCount: input.documents.length,
      entryCount,
      containerUniqueIdCount: containerIds.size,
      referenceCount,
      withIdReferenceCount,
      markerReferenceCount,
      resolvedCount,
      danglingCount,
      invalidCount,
      negativeCount,
      duplicateIdCount,
      referencesByTag: orderedReferencesByTag,
      truncatedDiagnostics: diagnosticTruncated
    }
  };
}
