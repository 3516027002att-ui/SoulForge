/**
 * Host-side automatic native-read proof store.
 *
 * Proofs are host facts derived from delivered native observations + final
 * envelopes. They are never model-supplied JSON, never imported from ledgers,
 * and never carry mutation counts.
 */
import type { NativeReadCompleteness } from '@soulforge/shared';
import { computeEvidenceKey, type NativeSourceIdentity } from '@soulforge/shared';
import { compareResourceVersion, type ResourceVersion } from '../runtime/resourceVersion.js';

export interface HostDeliveredNativeReadField {
  fieldId: string;
  value: unknown;
  /** True only when this exact value survived the final envelope projection. */
  delivered: boolean;
}

export interface HostDeliveredNativeRead {
  /** Host principal (agent run id / cli session id); not model-controlled. */
  principal: string;
  workspaceId: string;
  identity: NativeSourceIdentity;
  version: ResourceVersion;
  domain: NativeSourceIdentity['domain'];
  /**
   * Trusted reader observation produced by the host, not copied from tool input.
   */
  observation: {
    kind: 'param-fields' | 'emevd-full-dsl' | 'script-full-source' | 'fmg-entry' | 'msb-part' | 'tae-event' | 'window';
    fields?: HostDeliveredNativeReadField[];
    /** Canonical full text for whole-object reads. */
    fullText?: string;
    /** Half-open byte ranges of fullText actually delivered in the final envelope. */
    deliveredRanges?: Array<[number, number]>;
    completeness: NativeReadCompleteness;
    truncated: boolean;
    capabilityNotes?: string[];
  };
  /** Final envelope fragment that the caller can actually see. */
  finalVisible: {
    hasTargetRead: boolean;
    deliveredFieldIds: string[];
    projection?: string;
  };
}

export interface HostWriteFieldRequirement {
  fieldId: string;
  identity: NativeSourceIdentity;
  versionHint?: ResourceVersion;
  /** Whole-object write requires complete native text, not a window. */
  requiresWholeObject?: boolean;
  requiredCompleteness?: NativeReadCompleteness;
}

export interface HostWriteRequirement {
  toolName: string;
  principal: string;
  workspaceId: string;
  targets: HostWriteFieldRequirement[];
}

export interface ValidatedNativeReadProof {
  ok: true;
  proofId: string;
  identity: NativeSourceIdentity;
  version: ResourceVersion;
  coveredFieldIds: string[];
  wholeObject: boolean;
  completeness: NativeReadCompleteness;
}

export type NativeReadProofFailure =
  | { ok: false; code: 'NATIVE_READ_REQUIRED'; message: string; details?: unknown }
  | { ok: false; code: 'NATIVE_READ_COVERAGE_INCOMPLETE'; message: string; details?: unknown }
  | { ok: false; code: 'NATIVE_READ_STALE'; message: string; details?: unknown }
  | { ok: false; code: 'NATIVE_READ_PROOF_UNAVAILABLE'; message: string; details?: unknown };

export type NativeReadProofCheck = ValidatedNativeReadProof | NativeReadProofFailure;

interface StoredProof {
  proofId: string;
  principal: string;
  workspaceId: string;
  identity: NativeSourceIdentity;
  evidenceKey: string;
  version: ResourceVersion;
  fields: Map<string, unknown>;
  wholeObject: boolean;
  completeness: NativeReadCompleteness;
  generation: number;
  capabilityNotes: string[];
}

export interface NativeReadProofStoreOptions {
  /** Current host generation; proofs older than this for a source are stale. */
  generation?: number;
}

function fail(
  code: NativeReadProofFailure['code'],
  message: string,
  details?: unknown
): NativeReadProofFailure {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}

function fieldKey(identity: NativeSourceIdentity, fieldId: string): string {
  return `${computeEvidenceKey(identity)}::${fieldId}`;
}

/**
 * Confirms proofs only from host-resolved identity + delivered final content.
 * Model `verified` flags, ledgers and search tickets are ignored by design.
 */
export class NativeReadProofStore {
  private readonly byEvidence = new Map<string, StoredProof>();
  private readonly byPrincipalField = new Map<string, string>();
  private generation: number;
  private disposed = false;
  private seq = 0;

  constructor(options: NativeReadProofStoreOptions = {}) {
    this.generation = options.generation ?? 0;
  }

  setGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('NATIVE_READ_PROOF_GENERATION_INVALID');
    }
    this.generation = generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  /**
   * Record a proof only when the final envelope actually delivered native content.
   * Relation fragments and outlines never create whole-object proofs.
   */
  acceptDeliveredRead(input: HostDeliveredNativeRead): void {
    if (this.disposed) return;
    if (!input.principal || !input.workspaceId) {
      throw new Error('NATIVE_READ_PROOF_PRINCIPAL_REQUIRED');
    }
    if (input.workspaceId !== input.identity.workspaceId) {
      throw new Error('NATIVE_READ_PROOF_WORKSPACE_MISMATCH');
    }

    const fields = new Map<string, unknown>();
    let deliveredFieldCount = 0;
    if (input.observation.fields) {
      for (const field of input.observation.fields) {
        if (!field.delivered) continue;
        if (!input.finalVisible.deliveredFieldIds.includes(field.fieldId)) continue;
        fields.set(field.fieldId, field.value);
        deliveredFieldCount += 1;
      }
    }

    let wholeObject = false;
    let completeness = input.observation.completeness;
    if (input.observation.kind === 'emevd-full-dsl' || input.observation.kind === 'script-full-source') {
      const fullText = input.observation.fullText;
      const ranges = input.observation.deliveredRanges ?? [];
      const total = fullText === undefined ? 0 : Buffer.byteLength(fullText, 'utf8');
      if (
        typeof fullText === 'string'
        && !input.observation.truncated
        && input.observation.completeness === 'complete'
        && total > 0
        && rangesCover(ranges, total)
        && input.finalVisible.projection !== undefined
        && (input.finalVisible.projection === 'native_dsl_page'
          || input.finalVisible.projection === 'native_script_page'
          || input.finalVisible.projection === 'complete_native_dsl'
          || input.finalVisible.projection === 'complete_native_script')
      ) {
        wholeObject = true;
        completeness = 'complete';
      } else if (
        typeof fullText === 'string'
        && fullText.length === 0
        && input.observation.completeness === 'complete'
        && !input.observation.truncated
      ) {
        // Empty native object still requires trusted total length + identity.
        wholeObject = true;
        completeness = 'complete';
      }
    }

    if (fields.size === 0 && !wholeObject) {
      // Nothing survived final projection — no proof.
      return;
    }

    const evidenceKey = computeEvidenceKey(input.identity);
    const proofId = `nrp_${++this.seq}`;
    const stored: StoredProof = {
      proofId,
      principal: input.principal,
      workspaceId: input.workspaceId,
      identity: input.identity,
      evidenceKey,
      version: input.version,
      fields,
      wholeObject,
      completeness,
      generation: this.generation,
      capabilityNotes: input.observation.capabilityNotes ?? []
    };

    this.byEvidence.set(proofId, stored);
    for (const fieldId of fields.keys()) {
      this.byPrincipalField.set(`${input.principal}::${fieldKey(input.identity, fieldId)}`, proofId);
    }
    if (wholeObject) {
      this.byPrincipalField.set(`${input.principal}::${evidenceKey}::__whole__`, proofId);
    }
  }

  requireCoverage(input: HostWriteRequirement): NativeReadProofCheck {
    if (this.disposed) {
      return fail('NATIVE_READ_PROOF_UNAVAILABLE', '读取证明服务已关闭，写入失败关闭。');
    }
    if (!input.principal || !input.workspaceId) {
      return fail('NATIVE_READ_PROOF_UNAVAILABLE', '写入要求缺少执行主体或工作区。');
    }
    if (input.targets.length === 0) {
      return fail('NATIVE_READ_PROOF_UNAVAILABLE', `工具 ${input.toolName} 未声明任何写入目标，失败关闭。`);
    }

    const validated: ValidatedNativeReadProof[] = [];
    for (const target of input.targets) {
      if (target.identity.workspaceId !== input.workspaceId) {
        return fail('NATIVE_READ_REQUIRED', '写入目标工作区与当前主体不一致。', {
          toolName: input.toolName,
          objectKey: target.identity.objectKey
        });
      }

      const evidenceKey = computeEvidenceKey(target.identity);
      const wholeLookup = this.byPrincipalField.get(`${input.principal}::${evidenceKey}::__whole__`);
      const proof = wholeLookup
        ? this.byEvidence.get(wholeLookup)
        : this.findFieldProof(input.principal, target.identity, target.fieldId);

      if (!proof) {
        return fail(
          'NATIVE_READ_REQUIRED',
          `缺少 ${target.identity.objectKey} 字段 ${target.fieldId} 的当前原生读取证明。请使用对应原生读取工具重读。`,
          {
            toolName: input.toolName,
            fieldId: target.fieldId,
            objectKey: target.identity.objectKey,
            domain: target.identity.domain,
            sourceUri: target.identity.outerId
          }
        );
      }

      if (proof.principal !== input.principal || proof.workspaceId !== input.workspaceId) {
        return fail('NATIVE_READ_REQUIRED', '禁止跨执行主体复用读取证明。');
      }

      const requiredVersion = target.versionHint ?? proof.version;
      const cmp = compareResourceVersion(proof.version, requiredVersion);
      if (cmp.kind === 'different') {
        return fail('NATIVE_READ_STALE', `来源版本已变化（${cmp.reason}），旧证明不可用于写入。`, {
          fieldId: target.fieldId,
          reason: cmp.reason
        });
      }
      if (cmp.kind === 'unknown' && target.versionHint) {
        return fail('NATIVE_READ_STALE', '无法确认来源版本与证明一致，失败关闭。', {
          fieldId: target.fieldId
        });
      }

      if (target.requiresWholeObject && !proof.wholeObject) {
        return fail(
          'NATIVE_READ_COVERAGE_INCOMPLETE',
          '整对象修改需要完整原生读取证明；关联片段/大纲/指令窗口不够。'
        );
      }

      if (!target.requiresWholeObject) {
        if (!proof.wholeObject && !proof.fields.has(target.fieldId)) {
          return fail(
            'NATIVE_READ_COVERAGE_INCOMPLETE',
            `字段 ${target.fieldId} 未出现在最终可见原生读取结果中。`,
            { fieldId: target.fieldId, delivered: [...proof.fields.keys()] }
          );
        }
      }

      const required = target.requiredCompleteness;
      if (required === 'complete' && proof.completeness !== 'complete' && !proof.wholeObject) {
        return fail('NATIVE_READ_COVERAGE_INCOMPLETE', '所需 complete 读取未满足。');
      }

      if (proof.capabilityNotes.some((note) => /unsupported|blocked|readonly/i.test(note))) {
        // Capability gap does not grant write authority even with a read proof.
        if (target.requiresWholeObject) {
          return fail('NATIVE_READ_COVERAGE_INCOMPLETE', '当前 writer 能力不允许该整对象修改。', {
            notes: proof.capabilityNotes
          });
        }
      }

      validated.push({
        ok: true,
        proofId: proof.proofId,
        identity: proof.identity,
        version: proof.version,
        coveredFieldIds: [...proof.fields.keys()],
        wholeObject: proof.wholeObject,
        completeness: proof.completeness
      });
    }

    // Multi-target writes: every target must pass; no partial authorisation.
    const first = validated[0]!;
    return first;
  }

  invalidateSource(sourceKey: string, generation: number): void {
    for (const [proofId, proof] of [...this.byEvidence.entries()]) {
      const key = computeEvidenceKey(proof.identity);
      const matchesSource =
        key === sourceKey
        || proof.identity.outerId === sourceKey
        || fieldKey(proof.identity, '*').startsWith(sourceKey);
      if (!matchesSource && proof.version.generation === generation) continue;
      if (!matchesSource) continue;
      this.deleteProof(proofId);
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const [proofId, proof] of [...this.byEvidence.entries()]) {
      if (proof.workspaceId === workspaceId) this.deleteProof(proofId);
    }
  }

  invalidateAll(_reason: string): void {
    this.byEvidence.clear();
    this.byPrincipalField.clear();
  }

  dispose(): void {
    this.invalidateAll('dispose');
    this.disposed = true;
  }

  /** Test/host introspection only; not exposed as a model tool. */
  debugCount(principal?: string): number {
    let n = 0;
    for (const proof of this.byEvidence.values()) {
      if (!principal || proof.principal === principal) n += 1;
    }
    return n;
  }

  private findFieldProof(principal: string, identity: NativeSourceIdentity, fieldId: string): StoredProof | undefined {
    const proofId = this.byPrincipalField.get(`${principal}::${fieldKey(identity, fieldId)}`);
    if (!proofId) return undefined;
    return this.byEvidence.get(proofId);
  }

  private deleteProof(proofId: string): void {
    const proof = this.byEvidence.get(proofId);
    if (!proof) return;
    this.byEvidence.delete(proofId);
    for (const [key, id] of [...this.byPrincipalField.entries()]) {
      if (id === proofId) this.byPrincipalField.delete(key);
    }
  }
}

function rangesCover(ranges: Array<[number, number]>, total: number): boolean {
  if (total <= 0) return ranges.length === 0;
  if (ranges.length === 0) return false;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return false;
    if (start > cursor) return false;
    cursor = Math.max(cursor, end);
  }
  return cursor >= total;
}

export function createNativeReadProofStore(options?: NativeReadProofStoreOptions): NativeReadProofStore {
  return new NativeReadProofStore(options);
}

/** Failure-closed write gate used by mutating tools. */
export function buildWriteRequirement(
  toolName: string,
  input: unknown,
  hostContext: {
    principal: string;
    workspaceId: string;
    identityFor: (payload: unknown) => NativeSourceIdentity | null;
    versionHintFor?: (payload: unknown) => ResourceVersion | undefined;
  }
): HostWriteRequirement | { ok: false; code: string; message: string } {
  const targets: HostWriteFieldRequirement[] = [];
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  const pushTarget = (identity: NativeSourceIdentity, fieldId: string, requiresWholeObject = false): void => {
    const versionHint = hostContext.versionHintFor
      ? hostContext.versionHintFor({ identity, fieldId })
      : undefined;
    targets.push({
      fieldId,
      identity,
      requiresWholeObject,
      ...(versionHint !== undefined ? { versionHint } : {})
    });
  };

  if (toolName === 'mutate_param_fields') {
    const edits = Array.isArray(record.edits) ? record.edits : [];
    if (edits.length === 0) {
      return { ok: false, code: 'NATIVE_READ_REQUIRED', message: 'mutate_param_fields 需要非空 edits，且每个字段都要有读取证明。' };
    }
    for (const edit of edits) {
      const identity = hostContext.identityFor(edit);
      if (!identity) {
        return { ok: false, code: 'NATIVE_READ_REQUIRED', message: '无法从修改 payload 解析 PARAM 目标身份。' };
      }
      const fieldId = typeof (edit as { fieldId?: unknown }).fieldId === 'string'
        ? (edit as { fieldId: string }).fieldId
        : '';
      if (!fieldId) {
        return { ok: false, code: 'NATIVE_READ_REQUIRED', message: 'PARAM 修改缺少 fieldId。' };
      }
      pushTarget(identity, fieldId, false);
    }
  } else if (
    toolName === 'apply_emevd_dsl'
    || toolName === 'mutate_luabnd_script'
    || toolName === 'replace_script_source'
  ) {
    const identity = hostContext.identityFor(record);
    if (!identity) {
      return { ok: false, code: 'NATIVE_READ_REQUIRED', message: `工具 ${toolName} 无法解析整对象目标身份。` };
    }
    pushTarget(identity, '__whole__', true);
  } else if (toolName === 'mutate_fmg_entries' || toolName === 'mutate_tae_event_times'
    || toolName === 'mutate_msb_part_transform' || toolName === 'batch_transform_map_objects'
    || toolName === 'import_map_from_blender' || toolName === 'commit_patch') {
    // Domain-specific extraction: require at least one host-resolved target from payload.
    const identity = hostContext.identityFor(record);
    if (!identity) {
      return {
        ok: false,
        code: 'NATIVE_READ_REQUIRED',
        message: `工具 ${toolName} 的实际 payload 未能解析出可检查的原生目标；失败关闭，不得默认放行。`
      };
    }
    pushTarget(identity, '__payload__', false);
  } else {
    return {
      ok: false,
      code: 'NATIVE_READ_REQUIRED',
      message: `未分类的修改工具 ${toolName}，失败关闭。请在 buildWriteRequirement 中登记该工具的读取形状。`
    };
  }

  return {
    toolName,
    principal: hostContext.principal,
    workspaceId: hostContext.workspaceId,
    targets
  };
}
