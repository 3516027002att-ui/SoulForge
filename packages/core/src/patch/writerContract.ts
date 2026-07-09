import { randomUUID } from 'node:crypto';
import type {
  ConfirmationReceipt,
  Diagnostic,
  EditRiskAssessment,
  EditRiskLevel,
  IndexedFile,
  ResourceFormatKind,
  ResourceKind,
  WriterCapability,
  WriterContract
} from '@soulforge/shared';
import {
  resolveResourceCapabilities,
  type ResourceCapabilityMatrix
} from '../capabilities/resourceCapabilities.js';

const TEXT_FORMATS = new Set<ResourceFormatKind>(['text', 'hks']);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.lua',
  '.hks',
  '.js',
  '.ts',
  '.csv',
  '.ini',
  '.cfg',
  '.toml',
  '.log'
]);

const NATIVE_PACKED_FORMATS = new Set<ResourceFormatKind>([
  'dcx',
  'bnd',
  'emevd',
  'msb',
  'param',
  'fmg',
  'tpf',
  'gfx'
]);

/**
 * Resolve the primary (legacy) writer contract for text gate compatibility.
 * Semantic/native packed still has capability none for *text* path.
 * Raw path uses evaluateRawWriterGate / resolveWriterCapabilities instead.
 */
export function resolveWriterContract(file: IndexedFile): WriterContract {
  const matrix = resolveResourceCapabilities(file);

  if (matrix.textCapability === 'available' || matrix.textCapability === 'available_with_confirmation') {
    const caution = matrix.textCapability === 'available_with_confirmation'
      || isCautionText(file)
      || isTextLikeBackup(file);
    return {
      id: `writer:text:${file.formatKind}`,
      resourceKind: file.resourceKind,
      formatKind: file.formatKind,
      capability: 'text',
      inputSchemaId: 'soulforge.textContentEdit.v1',
      supportsStaging: true,
      supportsRollback: true,
      requiresConfirmation: caution,
      preconditions: [
        'target is overlay layer',
        'file is UTF-8 text',
        'Patch Engine staging + validation'
      ],
      validators: ['non_empty_unless_allowEmpty', 'session_writable', 'hash_conflict'],
      notes: caution
        ? 'Text path is available, but format confidence is reduced (backup / unknown / script edge).'
        : 'Direct text writer via Patch Engine.'
    };
  }

  if (matrix.isPackedOrNative) {
    return {
      id: `writer:text-blocked-raw-available:${file.formatKind}`,
      resourceKind: file.resourceKind,
      formatKind: file.formatKind,
      capability: 'none',
      inputSchemaId: '',
      supportsStaging: true,
      supportsRollback: true,
      requiresConfirmation: true,
      preconditions: ['raw path only with confirmation', 'hash precondition', 'Patch Engine'],
      validators: ['hash_conflict'],
      notes: 'Native packed format: text/semantic writers absent. High-risk raw replace/patch available with confirmation (not native roundtrip).'
    };
  }

  return {
    id: `writer:text-blocked-raw-available:unknown:${file.formatKind}`,
    resourceKind: file.resourceKind,
    formatKind: file.formatKind,
    capability: 'none',
    inputSchemaId: '',
    supportsStaging: true,
    supportsRollback: true,
    requiresConfirmation: true,
    preconditions: ['raw path only with confirmation'],
    validators: ['hash_conflict'],
    notes: 'Unknown/binary format: no text/semantic writer. Raw replace/patch available with confirmation.'
  };
}

export interface ResolvedWriterCapabilities {
  text: WriterContract;
  raw: WriterContract;
  semantic: WriterContract;
  matrix: ResourceCapabilityMatrix;
}

/** Split text / raw / semantic contracts — raw is never claimed as semantic/native. */
export function resolveWriterCapabilities(file: IndexedFile): ResolvedWriterCapabilities {
  const matrix = resolveResourceCapabilities(file);
  const text = resolveWriterContract(file);

  const raw: WriterContract = {
    id: `writer:raw:${file.formatKind}`,
    resourceKind: file.resourceKind,
    formatKind: file.formatKind,
    capability: matrix.rawCapability === 'none' ? 'none' : 'binary',
    inputSchemaId: 'soulforge.rawByteOrFileReplace.v1',
    supportsStaging: true,
    supportsRollback: true,
    requiresConfirmation: matrix.requiredConfirmation || matrix.rawCapability === 'available_with_confirmation',
    preconditions: [
      'expectedHash',
      'overlay writable',
      'Patch Engine staging + validation',
      ...(matrix.isPackedOrNative ? ['RAW_REPLACE_NATIVE_PACKED confirmation'] : [])
    ],
    validators: ['hash_conflict', 'range_bounds'],
    notes: matrix.isPackedOrNative
      ? 'High-risk raw-level write for native/packed file. Not a semantic/native writer.'
      : 'Raw-level whole-file replace or byte-range patch via Patch Engine.'
  };

  const semantic: WriterContract = {
    id: `writer:semantic-none:${file.formatKind}`,
    resourceKind: file.resourceKind,
    formatKind: file.formatKind,
    capability: 'none',
    inputSchemaId: '',
    supportsStaging: false,
    supportsRollback: false,
    requiresConfirmation: false,
    preconditions: ['fixture-confirmed native writer'],
    validators: [],
    notes: 'Semantic/native structured writer is not implemented for this format.'
  };

  return { text, raw, semantic, matrix };
}

/**
 * Gate raw writes (replace / byte range). Requires confirmation for caution/high.
 */
export function evaluateRawWriterGate(input: {
  file: IndexedFile;
  capabilities?: ResourceCapabilityMatrix;
  confirmation?: ConfirmationReceipt;
  operation: 'replace' | 'byte_range';
}): WriterGateResult {
  const caps = input.capabilities ?? resolveResourceCapabilities(input.file);
  const { raw } = resolveWriterCapabilities(input.file);
  const reasons: string[] = [...caps.reasonCodes];
  const diagnostics: Diagnostic[] = [...caps.diagnostics];

  if (!caps.rawWritable || raw.capability === 'none') {
    diagnostics.push({
      severity: 'error',
      code: 'RAW_WRITER_UNAVAILABLE',
      message: 'Raw writer is not available for this resource.',
      sourceUri: input.file.sourceUri
    });
    return {
      ok: false,
      risk: buildAssessment('blocked', reasons, raw, diagnostics, false),
      diagnostics
    };
  }

  const level: EditRiskLevel = caps.riskLevel;
  const risk = buildAssessment(
    level,
    reasons,
    { ...raw, requiresConfirmation: true },
    diagnostics,
    true,
    caps.isPackedOrNative
      ? 'High-risk raw write of native/packed format. Requires confirmation. Not native roundtrip safe.'
      : 'Raw write requires confirmation and hash precondition.'
  );

  const receiptOk = isValidConfirmation(input.confirmation, risk, input.file.sourceUri);
  if (!receiptOk) {
    diagnostics.push({
      severity: 'error',
      code: 'EDIT_CONFIRMATION_REQUIRED',
      message: 'Raw write requires an explicit risk confirmation receipt before Patch Engine commit.',
      sourceUri: input.file.sourceUri,
      details: {
        riskLevel: level,
        operation: input.operation,
        reasons
      }
    });
    return { ok: false, risk: { ...risk, allowWithConfirmation: true }, diagnostics };
  }

  return { ok: true, risk, diagnostics };
}

export interface AssessEditRiskOptions {
  /** Preview was truncated (partial read). */
  truncated?: boolean;
  /** Structured preview reported editable=false or unsupported. */
  structuredEditable?: boolean;
  parseStatus?: string;
}

/**
 * Files-mode risk assessment. Drives UI warnings and confirmation receipts.
 * Does not grant write permission by itself — Patch Engine + contract still apply.
 */
export function assessEditRisk(file: IndexedFile, options: AssessEditRiskOptions = {}): EditRiskAssessment {
  const contract = resolveWriterContract(file);
  const reasons: string[] = [];
  const diagnostics: Diagnostic[] = [];

  if (contract.capability === 'none') {
    reasons.push('UNSUPPORTED_WRITER');
    if (NATIVE_PACKED_FORMATS.has(file.formatKind)) {
      reasons.push('NATIVE_PACKED_FORMAT');
    }
    diagnostics.push({
      severity: 'error',
      code: 'WRITER_CONTRACT_ABSENT',
      message: contract.notes ?? 'No writer contract is available for this resource.',
      sourceUri: file.sourceUri,
      details: { contractId: contract.id, formatKind: file.formatKind, resourceKind: file.resourceKind }
    });
    return buildAssessment('blocked', reasons, contract, diagnostics, false);
  }

  if (options.truncated) {
    reasons.push('TRUNCATED_PREVIEW');
    diagnostics.push({
      severity: 'warning',
      code: 'EDIT_RISK_TRUNCATED_PREVIEW',
      message: 'Preview is truncated. Saving full-file text may be unsafe without reloading complete content.',
      sourceUri: file.sourceUri
    });
  }

  if (options.structuredEditable === false) {
    reasons.push('STRUCTURED_NOT_EDITABLE');
    diagnostics.push({
      severity: 'warning',
      code: 'EDIT_RISK_STRUCTURED_READONLY',
      message: 'Structured preview marks this resource non-editable.',
      sourceUri: file.sourceUri
    });
  }

  if (options.parseStatus === 'unsupported' || options.parseStatus === 'failed') {
    reasons.push(`PARSE_${(options.parseStatus ?? 'unknown').toUpperCase()}`);
    diagnostics.push({
      severity: 'warning',
      code: 'EDIT_RISK_PARSE_STATUS',
      message: `Parse status is ${options.parseStatus}; treat edits with elevated caution.`,
      sourceUri: file.sourceUri
    });
  }

  if (file.formatKind === 'backup' || file.extension.toLowerCase() === '.bak') {
    reasons.push('BACKUP_FILE');
    diagnostics.push({
      severity: 'warning',
      code: 'EDIT_RISK_BACKUP_FILE',
      message: 'Editing a backup file is unusual and requires explicit confirmation.',
      sourceUri: file.sourceUri
    });
  }

  if (contract.requiresConfirmation) {
    reasons.push('CONTRACT_REQUIRES_CONFIRMATION');
  }

  if (reasons.includes('TRUNCATED_PREVIEW')) {
    return buildAssessment(
      'blocked',
      reasons,
      contract,
      diagnostics,
      false,
      'Truncated preview cannot be safely written back as a full-file replace.'
    );
  }

  if (reasons.length > 0) {
    const level: EditRiskLevel = reasons.includes('BACKUP_FILE') ? 'high' : 'caution';
    return buildAssessment(
      level,
      reasons,
      { ...contract, requiresConfirmation: true },
      diagnostics,
      true
    );
  }

  return buildAssessment('safe', [], contract, [], false, 'Direct text edit via Patch Engine is allowed.');
}

export interface WriterGateInput {
  file: IndexedFile;
  changeKind: 'text' | 'structured' | 'binary';
  confirmation?: ConfirmationReceipt;
  riskOptions?: AssessEditRiskOptions;
}

export interface WriterGateResult {
  ok: boolean;
  risk: EditRiskAssessment;
  diagnostics: Diagnostic[];
}

/**
 * Gate a proposed write against the writer contract and optional confirmation receipt.
 * Structured / binary always fail until a real resource writer is registered.
 */
export function evaluateWriterGate(input: WriterGateInput): WriterGateResult {
  const risk = assessEditRisk(input.file, input.riskOptions ?? {});
  const diagnostics: Diagnostic[] = [...risk.diagnostics];

  if (input.changeKind === 'binary') {
    diagnostics.push({
      severity: 'error',
      code: 'BINARY_WRITER_DISABLED',
      message: 'Binary patch application is not enabled. Use a resource-specific writer contract.',
      sourceUri: input.file.sourceUri
    });
    return { ok: false, risk, diagnostics };
  }

  if (input.changeKind === 'structured') {
    diagnostics.push({
      severity: 'error',
      code: 'STRUCTURED_WRITER_NOT_IMPLEMENTED',
      message: 'Structured writer contract is declared as a gate only; no resource-specific writer is registered yet.',
      sourceUri: input.file.sourceUri,
      details: { contractId: risk.contract.id, capability: risk.contract.capability }
    });
    return { ok: false, risk, diagnostics };
  }

  if (risk.level === 'blocked' || risk.contract.capability !== 'text') {
    if (!diagnostics.some((item) => item.code === 'WRITER_CONTRACT_ABSENT')) {
      diagnostics.push({
        severity: 'error',
        code: 'WRITER_GATE_BLOCKED',
        message: risk.summary,
        sourceUri: input.file.sourceUri
      });
    }
    return { ok: false, risk, diagnostics };
  }

  if (risk.contract.requiresConfirmation || risk.level === 'caution' || risk.level === 'high') {
    const receiptOk = isValidConfirmation(input.confirmation, risk, input.file.sourceUri);
    if (!receiptOk) {
      diagnostics.push({
        severity: 'error',
        code: 'EDIT_CONFIRMATION_REQUIRED',
        message: 'This edit requires an explicit risk confirmation receipt before Patch Engine commit.',
        sourceUri: input.file.sourceUri,
        details: { riskLevel: risk.level, reasons: risk.reasons }
      });
      return { ok: false, risk: { ...risk, allowWithConfirmation: true }, diagnostics };
    }
  }

  return { ok: true, risk, diagnostics };
}

export function createConfirmationReceipt(input: {
  subjects: string[];
  riskLevel: EditRiskLevel;
  sourceUri?: string;
  note?: string;
  policyTags?: string[];
}): ConfirmationReceipt {
  return {
    id: randomUUID(),
    confirmedAt: new Date().toISOString(),
    subjects: [...input.subjects],
    riskLevel: input.riskLevel,
    ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.policyTags ? { policyTags: [...input.policyTags] } : {})
  };
}

export function isDirectTextEditable(file: IndexedFile): boolean {
  if (TEXT_FORMATS.has(file.formatKind)) return true;
  const ext = file.extension.toLowerCase();
  const compound = file.compoundExtension.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(compound);
}

/** SoulForge / editor backups of text resources — editable only with confirmation. */
function isTextLikeBackup(file: IndexedFile): boolean {
  if (file.formatKind === 'backup') return true;
  return file.extension.toLowerCase() === '.bak' || file.compoundExtension.toLowerCase().endsWith('.bak');
}

function isCautionText(file: IndexedFile): boolean {
  if (isTextLikeBackup(file)) return true;
  // .js event dumps and scripts are text-editable but higher residual risk.
  if (file.extension.toLowerCase() === '.js' && file.resourceKind === 'event') return true;
  return false;
}

function buildAssessment(
  level: EditRiskLevel,
  reasons: string[],
  contract: WriterContract,
  diagnostics: Diagnostic[],
  allowWithConfirmation: boolean,
  summaryOverride?: string
): EditRiskAssessment {
  const summary = summaryOverride ?? defaultSummary(level, reasons, contract);
  return {
    level,
    reasons,
    summary,
    allowWithConfirmation,
    contract,
    diagnostics
  };
}

function defaultSummary(level: EditRiskLevel, reasons: string[], contract: WriterContract): string {
  if (level === 'safe') return 'Direct text edit via Patch Engine is allowed.';
  if (level === 'blocked') {
    return contract.notes ?? `Write blocked (${reasons.join(', ') || 'no writer'}).`;
  }
  return `Edit risk ${level}: ${reasons.join(', ') || 'confirmation required'}. ${contract.notes ?? ''}`.trim();
}

function isValidConfirmation(
  receipt: ConfirmationReceipt | null | undefined,
  risk: EditRiskAssessment,
  sourceUri: string
): boolean {
  if (!receipt) return false;
  if (!receipt.id || !receipt.confirmedAt || !Array.isArray(receipt.subjects) || receipt.subjects.length === 0) {
    return false;
  }
  if (receipt.riskLevel !== risk.level && !(receipt.riskLevel === 'high' && risk.level === 'caution')) {
    // Allow a higher-severity receipt to cover a lower residual risk.
    const order: EditRiskLevel[] = ['safe', 'caution', 'high', 'blocked'];
    if (order.indexOf(receipt.riskLevel) < order.indexOf(risk.level)) return false;
  }
  if (receipt.sourceUri && receipt.sourceUri !== sourceUri) return false;
  const subjectSet = new Set(receipt.subjects);
  // Receipt must acknowledge the resource and at least one risk reason (or a blanket ACK).
  const acknowledgesResource = subjectSet.has(sourceUri) || subjectSet.has('resource');
  const acknowledgesRisk = risk.reasons.some((reason) => subjectSet.has(reason))
    || subjectSet.has('ALL_RISKS')
    || subjectSet.has(risk.level);
  return acknowledgesResource && acknowledgesRisk;
}

/** Placeholder structured writer registry — empty until real implementations land. */
export function listStructuredWriterKinds(): ResourceKind[] {
  return [];
}

export function hasStructuredWriter(_kind: ResourceKind): boolean {
  return false;
}
