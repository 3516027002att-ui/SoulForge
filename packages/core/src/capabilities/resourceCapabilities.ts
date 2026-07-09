/**
 * Unified resource capability matrix for Files Mode honesty.
 * Raw-level support is universal; semantic/native is never claimed without real writers.
 */

import type {
  Diagnostic,
  EditRiskLevel,
  IndexedFile,
  ResourceFormatKind
} from '@soulforge/shared';

export type SemanticReadTier =
  | 'none'
  | 'candidate'
  | 'partial'
  | 'fixture-confirmed'
  | 'authoritative';

export type CapabilityAvailability =
  | 'available'
  | 'available_with_confirmation'
  | 'none';

export interface ResourceCapabilityMatrix {
  sourceUri: string;
  absolutePath: string;
  relativePath: string;
  formatKind: ResourceFormatKind;
  resourceKind: IndexedFile['resourceKind'];

  openable: boolean;
  rawReadable: boolean;
  fullRawReadable: boolean;
  previewReadable: boolean;
  semanticReadable: boolean;
  semanticReadTier: SemanticReadTier;

  rawWritable: boolean;
  textWritable: boolean;
  binaryPatchWritable: boolean;
  semanticWritable: boolean;
  nativeRoundTripSafe: boolean;
  containerReadable: boolean;
  containerWritable: boolean;

  textCapability: CapabilityAvailability;
  rawCapability: CapabilityAvailability;
  semanticCapability: CapabilityAvailability;

  reasonCodes: string[];
  diagnostics: Diagnostic[];
  requiredConfirmation: boolean;
  riskLevel: EditRiskLevel;
  isTextLike: boolean;
  isPackedOrNative: boolean;
  nativeFormatAuthority: false;
}

const TEXT_FORMATS = new Set<ResourceFormatKind>(['text', 'hks', 'lua']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.lua', '.hks',
  '.js', '.ts', '.csv', '.ini', '.cfg', '.toml', '.log', '.tsv', '.css', '.html'
]);

const NATIVE_PACKED = new Set<ResourceFormatKind>([
  'dcx', 'bnd', 'emevd', 'msb', 'param', 'fmg', 'tpf', 'gfx'
]);

export function isTextLikeIndexedFile(file: IndexedFile): boolean {
  if (TEXT_FORMATS.has(file.formatKind)) return true;
  // SoulForge text backups are still text-path editable (with confirmation).
  if (file.formatKind === 'backup') return true;
  const ext = file.extension.toLowerCase();
  const compound = file.compoundExtension.toLowerCase();
  if (ext === '.bak' || compound.endsWith('.bak')) return true;
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(compound)) return true;
  // event dumps
  if (ext === '.js' && file.resourceKind === 'event') return true;
  return false;
}

export function isPackedOrNativeIndexedFile(file: IndexedFile): boolean {
  if (NATIVE_PACKED.has(file.formatKind)) return true;
  const compound = file.compoundExtension.toLowerCase();
  return compound.includes('.dcx') || compound.includes('.bnd');
}

/**
 * Compute honest capabilities for an indexed file.
 * Does not touch the filesystem; openable assumes the file was already scanned.
 */
export function resolveResourceCapabilities(
  file: IndexedFile,
  options?: {
    semanticReadTier?: SemanticReadTier;
    containerReadable?: boolean;
  }
): ResourceCapabilityMatrix {
  const textLike = isTextLikeIndexedFile(file);
  const packed = isPackedOrNativeIndexedFile(file);
  const reasonCodes: string[] = [];
  const diagnostics: Diagnostic[] = [];

  let semanticReadTier: SemanticReadTier = options?.semanticReadTier ?? 'none';
  if (semanticReadTier === 'none' && file.parseStatus === 'partial') {
    semanticReadTier = 'partial';
  }
  if (semanticReadTier === 'none' && file.parseStatus === 'parsed') {
    // Scanned text parsers may set parsed, but that is still not native authority.
    semanticReadTier = textLike ? 'partial' : 'candidate';
  }

  // Universal raw-level open/read.
  const openable = true;
  const rawReadable = true;
  const fullRawReadable = true;
  const previewReadable = true;

  // Semantic read never authoritative for packed without real parsers.
  if (packed && (semanticReadTier === 'authoritative' || semanticReadTier === 'fixture-confirmed')) {
    // Caller may pass fixture-confirmed for synthetic fixtures only.
  } else if (packed) {
    semanticReadTier = semanticReadTier === 'none' ? 'none' : semanticReadTier;
    if (semanticReadTier === 'authoritative') {
      semanticReadTier = 'candidate';
      reasonCodes.push('PACKED_NOT_AUTHORITATIVE');
    }
  }

  const semanticReadable = semanticReadTier !== 'none';
  const containerReadable = options?.containerReadable ?? (
    packed && (file.formatKind === 'dcx' || file.formatKind === 'bnd' || file.compoundExtension.includes('.bnd'))
  );
  if (containerReadable && packed) {
    reasonCodes.push('CONTAINER_READ_CANDIDATE_OR_PARTIAL');
  }

  // Writes
  let textWritable = false;
  let textCapability: CapabilityAvailability = 'none';
  let rawCapability: CapabilityAvailability = 'available_with_confirmation';
  let semanticCapability: CapabilityAvailability = 'none';
  let riskLevel: EditRiskLevel = 'high';
  let requiredConfirmation = true;

  if (textLike && !packed) {
    const backup = file.formatKind === 'backup'
      || file.extension.toLowerCase() === '.bak'
      || file.compoundExtension.toLowerCase().endsWith('.bak');
    textWritable = true;
    textCapability = backup ? 'available_with_confirmation' : 'available';
    rawCapability = 'available_with_confirmation';
    riskLevel = backup ? 'high' : 'safe';
    requiredConfirmation = backup;
    reasonCodes.push(backup ? 'TEXT_BACKUP_CONFIRMATION' : 'TEXT_DIRECT_EDITABLE');
  } else if (packed) {
    textWritable = false;
    textCapability = 'none';
    rawCapability = 'available_with_confirmation';
    semanticCapability = 'none';
    riskLevel = 'high';
    requiredConfirmation = true;
    reasonCodes.push('RAW_REPLACE_NATIVE_PACKED');
    reasonCodes.push('SEMANTIC_WRITER_ABSENT');
    diagnostics.push({
      severity: 'warning',
      code: 'RAW_REPLACE_NATIVE_PACKED',
      message: 'Native/packed format allows high-risk raw-level write only. Semantic/native roundtrip is not safe.',
      sourceUri: file.sourceUri,
      details: { formatKind: file.formatKind, nativeRoundTripSafe: false }
    });
  } else {
    // unknown binary
    textWritable = false;
    textCapability = 'none';
    rawCapability = 'available_with_confirmation';
    riskLevel = 'caution';
    requiredConfirmation = true;
    reasonCodes.push('UNKNOWN_BINARY_RAW_ONLY');
  }

  const rawWritable = true; // rawCapability is always available_with_confirmation in this matrix
  const binaryPatchWritable = rawWritable;
  const semanticWritable = false; // never claim without real structured writer
  const nativeRoundTripSafe = false;
  const containerWritable = false;

  if (!semanticWritable) {
    reasonCodes.push('SEMANTIC_WRITABLE_FALSE');
  }
  if (!nativeRoundTripSafe) {
    reasonCodes.push('NATIVE_ROUNDTRIP_NOT_SAFE');
  }
  if (!containerWritable) {
    reasonCodes.push('CONTAINER_WRITABLE_FALSE');
  }

  return {
    sourceUri: file.sourceUri,
    absolutePath: file.absolutePath,
    relativePath: file.relativePath,
    formatKind: file.formatKind,
    resourceKind: file.resourceKind,
    openable,
    rawReadable,
    fullRawReadable,
    previewReadable,
    semanticReadable,
    semanticReadTier,
    rawWritable,
    textWritable,
    binaryPatchWritable,
    semanticWritable,
    nativeRoundTripSafe,
    containerReadable,
    containerWritable,
    textCapability,
    rawCapability,
    semanticCapability,
    reasonCodes,
    diagnostics,
    requiredConfirmation,
    riskLevel,
    isTextLike: textLike && !packed,
    isPackedOrNative: packed,
    nativeFormatAuthority: false
  };
}
