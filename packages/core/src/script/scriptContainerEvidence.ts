/**
 * Production script container evidence projection (W-BEHAVIOR-MAP-01).
 *
 * Provides a readonly, structured container-level magic/reference inventory
 * for script containers (luabnd, talkesdbnd, action/*.hks) backing the
 * script editor:
 *   - entry enumeration (BND4 reference table: name / index / size / id);
 *   - extension distribution across the whole container;
 *   - `\x1bLua` compiled-bytecode identification from real header bytes
 *     (bounded magic sample);
 *   - LUAGNL / LUAINFO / ESD / HKX classification;
 *   - bounded hex evidence (first 32 bytes per sampled script entry).
 *
 * Real-corpus finding (W-BEHAVIOR-MAP-01 probe, Sekiro luabnd): inner `.lua`
 * entries are a MIX of Havok Script compiled bytecode with magic
 * `\x1bLuaP` (0x1b 0x4c 0x75 0x61 0x50) and plain-text list files
 * (e.g. goal_list.lua — but NOT logic_list.lua, which measured as `\x1bLuaP`
 * bytecode with a 0.6121 printable ratio; this comment previously cited it as
 * a plain-text example). The `\x1bLuaQ` magic is the vanilla
 * Lua 5.1 variant; both are recognized as the `\x1bLua` family. Whether a
 * specific entry's real bytes matched is reported via `magicVerified` and its
 * bounded `headerHex` — extension-based classification alone never claims
 * bytecode.
 *
 * Sekiro BND4 inner names are absolute paths from the original build machine
 * (e.g. `N:\NTC\data\Target\INTERROOT_win64\script\ai\out\bin\goal_list.lua`);
 * evidence entry names are therefore sanitized to their basename so no
 * absolute path ever reaches the editor/renderer.
 *
 * SoulForge does NOT decompile, recompile, or execute scripts. Disassembly is
 * never presented as editable source.
 *
 * Authority cap: `candidate`. This projection proves container-level
 * enumeration, bytecode format identification and bounded header evidence
 * only — never script semantics, decompilation, recompilation or writer
 * capability. Evidence output is sanitized: entries carry sanitized inner
 * names, bounded hex only, and no absolute paths beyond the documented
 * main-process `containerPath`.
 */

import { runBridge } from '../bridge/runBridge.js';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

/* ------------------------------------------------------------------ */
/*  Evidence types                                                    */
/* ------------------------------------------------------------------ */

export type ScriptEntryClassification =
  | 'lua-bytecode'      // \x1bLua family compiled Havok Script
  | 'luagnl'            // global name table (decompilation aid)
  | 'luainfo'           // function parameter metadata (decompilation aid)
  | 'esd-bytecode'      // ESD state machine bytecode
  | 'hkx-bytecode'      // HKX behavior bytecode
  | 'unknown';

export interface ScriptContainerEntryEvidence {
  /** Entry name sanitized to basename (Sekiro BND4 inner names are absolute
   *  build-machine paths; never surfaced here). */
  name: string;
  /** Entry index in the BND4 entry table (container reference slot). */
  index: number;
  /** Uncompressed size in bytes. */
  size: number;
  /** File extension (lowercase, without dot). */
  extension: string;
  /** Classified entry type (extension-based). */
  classification: ScriptEntryClassification;
  /** First N bytes as hex (readonly evidence, bounded). */
  headerHex?: string;
  /** Magic bytes identification string. */
  magicLabel?: string;
  /** True when the real header bytes of this entry matched the `\x1bLua`
   *  compiled-bytecode family via the bounded magic sample. */
  magicVerified?: boolean;
}

export interface ScriptContainerEvidence {
  ok: boolean;
  /** Container file path (absolute, main-process only). */
  containerPath: string;
  /** Container format: BND4, DCX-DFLT->BND4, BND4_KRAK, or unknown. */
  containerFormat: string;
  /** Total entry count. */
  entryCount: number;
  /** Per-entry evidence (bounded to MAX_EVIDENCE_ENTRIES). */
  entries: ScriptContainerEntryEvidence[];
  /** Whether the entry list was truncated. */
  truncated: boolean;
  /** Distribution of classifications. */
  classificationSummary: Record<ScriptEntryClassification, number>;
  /** Extension distribution across the whole container (lowercase, no dot). */
  extensionDistribution: Record<string, number>;
  /** Count of script entries whose real bytes matched the `\x1bLua` magic. */
  magicVerifiedCount: number;
  /** Count of script-classified entries (lua/luagnl/luainfo/esd/hkx). */
  scriptEntryCount: number;
  /** Number of script entries actually sampled for magic verification. */
  magicSampleCount: number;
  /** Authority marker: container-level inventory only (cap=candidate). */
  authority: 'candidate';
  diagnostics: StructuredDiagnostic[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MAX_EVIDENCE_ENTRIES = 256;
const HEADER_PREVIEW_BYTES = 32;
const MAGIC_SAMPLE_LIMIT = 12;

/** Havok Script / Lua 5.1 compiled bytecode signature: \x1bLua */
const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61];
/** Version/magic byte: 0x50 (`\x1bLuaP`, observed Sekiro/Havok corpus),
 *  0x51 (`\x1bLuaQ`, vanilla Lua 5.1). */
const LUA_VERSION_BYTES = new Set([0x50, 0x51]);

/* ------------------------------------------------------------------ */
/*  Classification                                                    */
/* ------------------------------------------------------------------ */

/**
 * True when `headerBytes` begins with the `\x1bLua` compiled-bytecode
 * signature (family `\x1bLuaP` / `\x1bLuaQ`). Readonly identification —
 * never decompiles or executes.
 */
export function isHavokScriptBytecode(headerBytes: number[] | Uint8Array): boolean {
  if (headerBytes.length < LUA_SIGNATURE.length + 1) return false;
  const familyMatch = LUA_SIGNATURE.every((byte, index) => headerBytes[index] === byte);
  if (!familyMatch) return false;
  return LUA_VERSION_BYTES.has(headerBytes[LUA_SIGNATURE.length]!);
}

export function classifyScriptEntry(name: string, headerBytes?: number[] | Uint8Array): ScriptEntryClassification {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'luagnl') return 'luagnl';
  if (ext === 'luainfo') return 'luainfo';
  if (ext === 'esd') return 'esd-bytecode';
  if (ext === 'hkx') return 'hkx-bytecode';

  if (ext === 'lua' || ext === 'hks') {
    if (headerBytes && headerBytes.length >= LUA_SIGNATURE.length + 1) {
      const matches = isHavokScriptBytecode(headerBytes);
      if (matches) return 'lua-bytecode';
    }
    // .lua/.hks in script containers belong to the compiled-bytecode family
    // per W-BEHAVIOR-MAP-01 probe evidence, but whether the real bytes matched
    // is reported separately via `magicVerified` on the evidence entry
    // (plain-text list files such as goal_list.lua carry magicVerified=false).
    return 'lua-bytecode';
  }

  return 'unknown';
}

/**
 * Fail-closed load-prerequisite check for a whole-inner-file replacement.
 *
 * Verifies the replaced entry still begins with the `\x1bLua` compiled-bytecode
 * signature (`\x1bLuaP` / `\x1bLuaQ`). A container whose inner script entries
 * lost their bytecode magic is not loadable by the game as a script container,
 * so an anomaly MUST produce an error diagnostic — never a silent pass.
 *
 * This is a structural prerequisite only: it proves the bytecode family magic
 * survived the replacement, never that the game can execute the bytes. Real
 * in-game load requires user confirmation (see the game-load smoke); authority
 * stays `candidate` until then. SoulForge never decompiles, recompiles or
 * generates bytecode.
 */
export function checkReplacedEntryMagic(
  entryLabel: string,
  headerBytes: number[] | Uint8Array
): { ok: boolean; diagnostics: StructuredDiagnostic[] } {
  const diagnostics: StructuredDiagnostic[] = [];
  const bytes = headerBytes instanceof Uint8Array ? headerBytes : new Uint8Array(headerBytes);
  if (bytes.length < LUA_SIGNATURE.length + 1) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_MAGIC_SHORT',
      message: `${entryLabel} 替换后头部不足 \x1bLua 字节码签名长度（${bytes.length} 字节），容器不能按脚本容器加载。`
    }));
    return { ok: false, diagnostics };
  }
  if (!isHavokScriptBytecode(bytes)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_MAGIC_LOST',
      message: `${entryLabel} 替换后 \x1bLua 编译字节码 magic 丢失，容器不能按脚本容器加载。`,
      details: {
        headerHex: [...bytes.subarray(0, HEADER_PREVIEW_BYTES)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }
    }));
    return { ok: false, diagnostics };
  }
  return { ok: true, diagnostics };
}

export function magicLabel(classification: ScriptEntryClassification): string {
  switch (classification) {
    case 'lua-bytecode': return '\\x1bLuaP/\\x1bLuaQ (Havok Script compiled bytecode)';
    case 'luagnl': return 'LUAGNL (global name table)';
    case 'luainfo': return 'LUAINFO (function parameter metadata)';
    case 'esd-bytecode': return 'ESD (state machine bytecode)';
    case 'hkx-bytecode': return 'HKX (behavior bytecode)';
    default: return 'unknown';
  }
}

function isScriptClassification(classification: ScriptEntryClassification): boolean {
  return classification === 'lua-bytecode'
    || classification === 'luagnl'
    || classification === 'luainfo'
    || classification === 'esd-bytecode'
    || classification === 'hkx-bytecode';
}

/**
 * Sanitize a BND4 entry name to its basename. Sekiro luabnd inner names are
 * absolute paths from the original build machine (e.g.
 * `N:\NTC\data\Target\INTERROOT_win64\script\ai\out\bin\goal_list.lua`);
 * surfacing them would leak absolute paths into the editor. On basename
 * collision the index is appended for uniqueness.
 */
export function sanitizeEntryName(rawName: string, index: number, seen: Set<string>): string {
  const separator = rawName.includes('\\') ? '\\' : '/';
  const base = rawName.split(separator).pop() ?? rawName;
  const candidate = base.trim() || `entry_${index}`;
  if (seen.has(candidate.toLowerCase())) return `${candidate}#${index}`;
  seen.add(candidate.toLowerCase());
  return candidate;
}

/* ------------------------------------------------------------------ */
/*  Evidence builder                                                  */
/* ------------------------------------------------------------------ */

export interface ScriptEvidenceOptions {
  containerPath: string;
  allowedRoots: string[];
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

interface Bnd4InventoryEntry {
  name?: string;
  index?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  flags?: number;
  id?: number;
}

interface Bnd4InventoryData {
  format?: string;
  containerType?: string;
  entryCount?: number;
  entries?: Bnd4InventoryEntry[];
  sampleEntries?: Bnd4InventoryEntry[];
  extensions?: Record<string, number>;
  resourceKinds?: Record<string, number>;
}

interface DcxReadEnvelope {
  compressionFormat?: string;
  nested?: {
    entryCount?: number;
    entries?: Bnd4InventoryEntry[];
  };
}

interface Bnd4ChildSnapshotEnvelope {
  contentBase64?: string;
}

function emptyClassificationSummary(): Record<ScriptEntryClassification, number> {
  return {
    'lua-bytecode': 0, 'luagnl': 0, 'luainfo': 0,
    'esd-bytecode': 0, 'hkx-bytecode': 0, 'unknown': 0
  };
}

function normalizeExtensionKey(key: string): string {
  if (key === '(none)') return '(none)';
  return key.toLowerCase().replace(/^\./, '');
}

/**
 * Build a readonly container-level magic/reference inventory for a script
 * container. Uses the Bridge `inventory-asset-resources` command for the
 * container anchor (format / entryCount / extension distribution), the
 * `read-dcx-document` command for the full BND4 reference table when the
 * container is DCX-wrapped, and `snapshot-bnd4-child` for a bounded magic
 * sample over real `.lua`/`.hks` header bytes.
 *
 * Never modifies any file. Never executes or decompiles scripts. Evidence
 * retains only sanitized inner names, bounded hex (first 32 bytes per sampled
 * script entry) and no absolute paths beyond the documented `containerPath`.
 */
export async function buildScriptContainerEvidence(
  options: ScriptEvidenceOptions
): Promise<ScriptContainerEvidence> {
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceUri = `file:///${options.containerPath.replace(/\\/g, '/')}`;

  // Step 1: Container anchor via Bridge inventory (format / entryCount /
  // extension distribution / bounded samples). Sanitized, container-level.
  const inventory = await runBridge<Bnd4InventoryData>({
    command: 'inventory-asset-resources',
    filePath: options.containerPath,
    resourceUri: sourceUri,
    allowedRoots: options.allowedRoots,
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    timeoutMs: options.timeoutMs ?? 60_000
  });

  if (inventory.parseStatus === 'failed') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_EVIDENCE_INVENTORY_FAILED',
      message: `Script container inventory failed: ${inventory.diagnostics.map(d => d.message).join('; ')}`,
      targetUri: sourceUri
    }));
    return {
      ok: false,
      containerPath: options.containerPath,
      containerFormat: 'unknown',
      entryCount: 0,
      entries: [],
      truncated: false,
      classificationSummary: emptyClassificationSummary(),
      extensionDistribution: {},
      magicVerifiedCount: 0,
      scriptEntryCount: 0,
      magicSampleCount: 0,
      authority: 'candidate',
      diagnostics
    };
  }

  const data = inventory.data ?? {};
  const extensionDistribution: Record<string, number> = {};
  for (const [key, count] of Object.entries(data.extensions ?? {})) {
    extensionDistribution[normalizeExtensionKey(key)] = count;
  }

  // Step 2: Full BND4 reference table (index / size / id per entry) via the
  // DCX document reader when the container is DCX-wrapped; otherwise fall back
  // to the inventory bounded sample set (name/id only).
  let rawEntries: Bnd4InventoryEntry[] = data.sampleEntries ?? data.entries ?? [];
  let containerFormat = data.format ?? 'BND4';
  let enumerationSource: 'read-dcx-document' | 'inventory-sample' = 'inventory-sample';
  const dcx = await runBridge<DcxReadEnvelope>({
    command: 'read-dcx-document',
    filePath: options.containerPath,
    resourceUri: sourceUri,
    allowedRoots: options.allowedRoots,
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    timeoutMs: options.timeoutMs ?? 60_000
  });
  const dcxEntries = dcx.data?.nested?.entries;
  if (dcx.parseStatus !== 'failed' && Array.isArray(dcxEntries) && dcxEntries.length > 0) {
    rawEntries = dcxEntries;
    if (dcx.data?.compressionFormat) {
      containerFormat = `DCX-${dcx.data.compressionFormat}->BND4`;
    }
    enumerationSource = 'read-dcx-document';
  }

  const truncated = rawEntries.length > MAX_EVIDENCE_ENTRIES;
  const boundedEntries = rawEntries.slice(0, MAX_EVIDENCE_ENTRIES);

  // Step 3: Per-entry classification with sanitized names (extension-based).
  const seenNames = new Set<string>();
  const entries: ScriptContainerEntryEvidence[] = boundedEntries.map((entry) => {
    const rawName = entry.name ?? `entry_${entry.index ?? 0}`;
    const name = sanitizeEntryName(rawName, entry.index ?? 0, seenNames);
    const classification = classifyScriptEntry(rawName);
    return {
      name,
      index: entry.index ?? 0,
      size: entry.uncompressedSize ?? 0,
      extension: rawName.split('.').pop()?.toLowerCase() ?? '',
      classification,
      magicLabel: magicLabel(classification)
    };
  });

  // Step 4: Bounded magic verification over real `.lua`/`.hks` header bytes.
  // Only entries classified as `lua-bytecode` are sampled (LUAGNL/LUAINFO/ESD/
  // HKX carry their own formats and are classified by extension). Each snapshot
  // is decoded and only the first 32 bytes are retained as hex evidence — full
  // content never leaves the daemon response into the evidence projection.
  const luaBytecodeIndices: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.classification === 'lua-bytecode') luaBytecodeIndices.push(index);
  });
  const magicSampleCount = Math.min(MAGIC_SAMPLE_LIMIT, luaBytecodeIndices.length);
  let magicVerifiedCount = 0;
  for (const entryIndex of luaBytecodeIndices.slice(0, MAGIC_SAMPLE_LIMIT)) {
    const entry = entries[entryIndex]!;
    const snapshot = await runBridge<Bnd4ChildSnapshotEnvelope>({
      command: 'snapshot-bnd4-child',
      filePath: options.containerPath,
      resourceUri: sourceUri,
      allowedRoots: options.allowedRoots,
      ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
      timeoutMs: options.timeoutMs ?? 60_000,
      commandOptions: { entryIndex: entry.index }
    });
    if (snapshot.parseStatus === 'failed' || !snapshot.data?.contentBase64) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'SCRIPT_EVIDENCE_MAGIC_SAMPLE_FAILED',
        message: `条目 ${entry.name} 头部快照失败；保留扩展名分类（magicVerified=false）。`,
        targetUri: sourceUri
      }));
      entry.magicVerified = false;
      continue;
    }
    const bytes = Buffer.from(snapshot.data.contentBase64, 'base64');
    const header = [...bytes.subarray(0, HEADER_PREVIEW_BYTES)];
    const verified = isHavokScriptBytecode(header);
    entry.headerHex = header.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    entry.magicVerified = verified;
    if (verified) magicVerifiedCount += 1;
  }

  // Step 5: Classification summary + script inventory counts.
  const classificationSummary = emptyClassificationSummary();
  for (const entry of entries) {
    classificationSummary[entry.classification] += 1;
  }
  const scriptEntryCount = entries.filter((entry) => isScriptClassification(entry.classification)).length;

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'SCRIPT_EVIDENCE_BUILT',
    message: `Script container evidence: ${entries.length} entries (${classificationSummary['lua-bytecode']} Lua bytecode, ${classificationSummary['luagnl']} LUAGNL, ${classificationSummary['luainfo']} LUAINFO); magic verified ${magicVerifiedCount}/${magicSampleCount} sampled; enumeration via ${enumerationSource}.`,
    targetUri: sourceUri
  }));

  return {
    ok: true,
    containerPath: options.containerPath,
    containerFormat,
    entryCount: data.entryCount ?? rawEntries.length,
    entries,
    truncated,
    classificationSummary,
    extensionDistribution,
    magicVerifiedCount,
    scriptEntryCount,
    magicSampleCount,
    authority: 'candidate',
    diagnostics
  };
}
