/**
 * Unified resource capability matrix for Files Mode honesty.
 * Raw-level support is universal; semantic/native is never claimed without real writers.
 * v0.6: container-level fields for DCX/BND synthetic + DFLT.
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

export type ContainerReadableLevel = 'none' | 'candidate' | 'partial' | 'authoritative';
export type ContainerWritableLevel =
  | 'none'
  | 'raw-replace'
  | 'child-replace'
  | 'authoritative-repack';

export type DecompressionStatus = 'none' | 'supported' | 'unsupported' | 'failed';
export type CompressionStatus = 'none' | 'supported' | 'unsupported' | 'failed';

export type SemanticAuthority =
  | 'none'
  | 'candidate'
  | 'partial'
  | 'fixture-confirmed'
  | 'authoritative';

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
  /** @deprecated prefer containerReadableLevel */
  containerReadable: boolean;
  /** @deprecated prefer containerWritableLevel */
  containerWritable: boolean;

  // v0.6 container-level
  containerReadableLevel: ContainerReadableLevel;
  containerWritableLevel: ContainerWritableLevel;
  containerRoundTripSafe: boolean;
  canListChildren: boolean;
  canReadChild: boolean;
  canReplaceChild: boolean;
  canRepackContainer: boolean;
  decompressionStatus: DecompressionStatus;
  compressionStatus: CompressionStatus;
  childEditWritable: boolean;
  childEditRequiresConfirmation: boolean;
  semanticAuthorityByFormat?: Record<string, SemanticAuthority>;

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
  if (file.formatKind === 'backup') return true;
  const ext = file.extension.toLowerCase();
  const compound = file.compoundExtension.toLowerCase();
  if (ext === '.bak' || compound.endsWith('.bak')) return true;
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(compound)) return true;
  if (ext === '.js' && file.resourceKind === 'event') return true;
  return false;
}

export function isPackedOrNativeIndexedFile(file: IndexedFile): boolean {
  if (NATIVE_PACKED.has(file.formatKind)) return true;
  const compound = file.compoundExtension.toLowerCase();
  return compound.includes('.dcx') || compound.includes('.bnd');
}

export interface ResolveCapabilitiesOptions {
  semanticReadTier?: SemanticReadTier;
  containerReadable?: boolean;
  /** When true, file is known synthetic SFBN BND (fixture-confirmed). */
  syntheticBnd?: boolean;
  /** When true, file is known DCX DFLT with full decompress. */
  dcxDfltSupported?: boolean;
  /** When true, nested DCX+BND synthetic roundtrip is safe. */
  nestedContainerRoundTripSafe?: boolean;
  /** FMG synthetic fixture confirmed. */
  syntheticFmg?: boolean;
}

/**
 * Compute honest capabilities for an indexed file.
 * Does not touch the filesystem unless caller passes probed options.
 */
export function resolveResourceCapabilities(
  file: IndexedFile,
  options?: ResolveCapabilitiesOptions
): ResourceCapabilityMatrix {
  const textLike = isTextLikeIndexedFile(file);
  const packed = isPackedOrNativeIndexedFile(file);
  const reasonCodes: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const compound = file.compoundExtension.toLowerCase();
  const looksDcx = file.formatKind === 'dcx' || compound.includes('.dcx');
  const looksBnd = file.formatKind === 'bnd' || compound.includes('.bnd');

  let semanticReadTier: SemanticReadTier = options?.semanticReadTier ?? 'none';
  if (semanticReadTier === 'none' && file.parseStatus === 'partial') {
    semanticReadTier = 'partial';
  }
  if (semanticReadTier === 'none' && file.parseStatus === 'parsed') {
    semanticReadTier = textLike ? 'partial' : 'candidate';
  }

  if (packed && (semanticReadTier === 'authoritative' || semanticReadTier === 'fixture-confirmed')) {
    // Caller may pass fixture-confirmed for synthetic fixtures only.
  } else if (packed) {
    if (semanticReadTier === 'authoritative') {
      semanticReadTier = 'candidate';
      reasonCodes.push('PACKED_NOT_AUTHORITATIVE');
    }
  }

  const openable = true;
  const rawReadable = true;
  const fullRawReadable = true;
  const previewReadable = true;
  const semanticReadable = semanticReadTier !== 'none';

  // --- Container levels (static defaults; probes can upgrade via options) ---
  let containerReadableLevel: ContainerReadableLevel = 'none';
  let containerWritableLevel: ContainerWritableLevel = 'none';
  let containerRoundTripSafe = false;
  let canListChildren = false;
  let canReadChild = false;
  let canReplaceChild = false;
  let canRepackContainer = false;
  let decompressionStatus: DecompressionStatus = 'none';
  let compressionStatus: CompressionStatus = 'none';
  let childEditWritable = false;
  let childEditRequiresConfirmation = true;

  if (looksDcx) {
    if (options?.dcxDfltSupported) {
      containerReadableLevel = options.nestedContainerRoundTripSafe ? 'authoritative' : 'partial';
      decompressionStatus = 'supported';
      compressionStatus = 'supported';
      if (options.nestedContainerRoundTripSafe || options.syntheticBnd) {
        canListChildren = true;
        canReadChild = true;
        canReplaceChild = true;
        canRepackContainer = true;
        containerWritableLevel = 'authoritative-repack';
        containerRoundTripSafe = true;
        childEditWritable = true;
        reasonCodes.push('CONTAINER_DCX_DFLT_BND_SYNTHETIC_REPACK');
      } else {
        containerWritableLevel = 'raw-replace';
        reasonCodes.push('CONTAINER_DCX_DFLT_PAYLOAD_ONLY');
      }
    } else {
      containerReadableLevel = 'candidate';
      containerWritableLevel = 'raw-replace';
      decompressionStatus = 'unsupported';
      compressionStatus = 'unsupported';
      reasonCodes.push('CONTAINER_DCX_VARIANT_UNKNOWN');
    }
  } else if (looksBnd || options?.syntheticBnd) {
    if (options?.syntheticBnd) {
      containerReadableLevel = 'authoritative';
      containerWritableLevel = 'authoritative-repack';
      containerRoundTripSafe = true;
      canListChildren = true;
      canReadChild = true;
      canReplaceChild = true;
      canRepackContainer = true;
      childEditWritable = true;
      reasonCodes.push('CONTAINER_BND_SYNTHETIC_SFBN');
    } else {
      containerReadableLevel = 'candidate';
      containerWritableLevel = 'raw-replace';
      reasonCodes.push('CONTAINER_BND_NATIVE_CANDIDATE');
    }
  } else if (packed) {
    containerReadableLevel = 'none';
    containerWritableLevel = 'raw-replace';
    reasonCodes.push('CONTAINER_NONE_RAW_ONLY');
  }

  const containerReadable = containerReadableLevel !== 'none';
  // child-replace and authoritative-repack both count as container-writable.
  const containerWritable = containerWritableLevel !== 'none'
    && containerWritableLevel !== 'raw-replace';

  // Writes
  let textWritable = false;
  let textCapability: CapabilityAvailability = 'none';
  let rawCapability: CapabilityAvailability = 'available_with_confirmation';
  let semanticCapability: CapabilityAvailability = 'none';
  let riskLevel: EditRiskLevel = 'high';
  let requiredConfirmation = true;
  let semanticWritable = false;
  let nativeRoundTripSafe = false;

  const semanticAuthorityByFormat: Record<string, SemanticAuthority> = {
    fmg: options?.syntheticFmg ? 'fixture-confirmed' : 'none',
    param: 'none',
    emevd: 'none',
    msb: 'none'
  };

  if (options?.syntheticFmg) {
    semanticReadTier = 'fixture-confirmed';
    semanticWritable = true;
    semanticCapability = 'available_with_confirmation';
    nativeRoundTripSafe = true;
    reasonCodes.push('FMG_SYNTHETIC_FIXTURE_CONFIRMED');
  }

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
    if (!semanticWritable) semanticCapability = 'none';
    riskLevel = 'high';
    requiredConfirmation = true;
    reasonCodes.push('RAW_REPLACE_NATIVE_PACKED');
    if (!semanticWritable) reasonCodes.push('SEMANTIC_WRITER_ABSENT');
    diagnostics.push({
      severity: 'warning',
      code: 'RAW_REPLACE_NATIVE_PACKED',
      message: 'Native/packed format allows high-risk raw-level write only unless container/semantic fixture path applies.',
      sourceUri: file.sourceUri,
      details: {
        formatKind: file.formatKind,
        nativeRoundTripSafe,
        containerWritableLevel,
        containerRoundTripSafe
      }
    });
  } else {
    textWritable = false;
    textCapability = 'none';
    rawCapability = 'available_with_confirmation';
    riskLevel = 'caution';
    requiredConfirmation = true;
    reasonCodes.push('UNKNOWN_BINARY_RAW_ONLY');
  }

  const rawWritable = true;
  const binaryPatchWritable = rawWritable;

  if (!semanticWritable) reasonCodes.push('SEMANTIC_WRITABLE_FALSE');
  if (!nativeRoundTripSafe) reasonCodes.push('NATIVE_ROUNDTRIP_NOT_SAFE');
  if (!containerWritable) reasonCodes.push('CONTAINER_WRITABLE_FALSE');

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
    containerReadableLevel,
    containerWritableLevel,
    containerRoundTripSafe,
    canListChildren,
    canReadChild,
    canReplaceChild,
    canRepackContainer,
    decompressionStatus,
    compressionStatus,
    childEditWritable,
    childEditRequiresConfirmation,
    semanticAuthorityByFormat,
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

/**
 * Probe file bytes and return capability options for resolveResourceCapabilities.
 */
export async function probeContainerCapabilityOptions(
  absolutePath: string
): Promise<ResolveCapabilitiesOptions> {
  const { readFile } = await import('node:fs/promises');
  const { isSyntheticBnd } = await import('../containers/bndSynthetic.js');
  const { decompressDcx } = await import('../containers/dcx.js');
  const { isSyntheticFmg } = await import('../containers/fmgSynthetic.js');

  const options: ResolveCapabilitiesOptions = {};
  try {
    const bytes = await readFile(absolutePath);
    if (isSyntheticFmg(bytes)) {
      options.syntheticFmg = true;
    }
    if (isSyntheticBnd(bytes)) {
      options.syntheticBnd = true;
    }
    if (bytes.subarray(0, 4).equals(Buffer.from('DCX\0', 'ascii'))) {
      const decomp = decompressDcx(bytes);
      if (decomp.ok && decomp.payload) {
        options.dcxDfltSupported = true;
        if (isSyntheticBnd(decomp.payload)) {
          options.syntheticBnd = true;
          options.nestedContainerRoundTripSafe = true;
        }
      }
    }
  } catch {
    // leave defaults
  }
  return options;
}
