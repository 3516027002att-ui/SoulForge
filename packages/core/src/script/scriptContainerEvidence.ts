/**
 * Production script container evidence projection.
 *
 * Provides a readonly, structured view of script container entries
 * (luabnd, talkesdbnd, action/*.hks) for the script editor.
 *
 * SoulForge does NOT decompile, recompile, or execute scripts.
 * Inner `.lua` / `.hks` files are Havok Script compiled bytecode
 * (`\x1bLuaQ` magic), not editable source text.
 */

import { runBridge } from '../bridge/runBridge.js';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

/* ------------------------------------------------------------------ */
/*  Evidence types                                                    */
/* ------------------------------------------------------------------ */

export type ScriptEntryClassification =
  | 'lua-bytecode'      // \x1bLuaQ compiled Havok Script
  | 'luagnl'            // global name table (decompilation aid)
  | 'luainfo'           // function parameter metadata (decompilation aid)
  | 'esd-bytecode'      // ESD state machine bytecode
  | 'hkx-bytecode'      // HKX behavior bytecode
  | 'unknown';

export interface ScriptContainerEntryEvidence {
  /** Entry name (inner path within the container). */
  name: string;
  /** Entry index in the BND4 entry table. */
  index: number;
  /** Uncompressed size in bytes. */
  size: number;
  /** File extension (lowercase, without dot). */
  extension: string;
  /** Classified entry type. */
  classification: ScriptEntryClassification;
  /** First N bytes as hex (readonly evidence, bounded). */
  headerHex?: string;
  /** Magic bytes identification string. */
  magicLabel?: string;
}

export interface ScriptContainerEvidence {
  ok: boolean;
  /** Container file path (absolute, main-process only). */
  containerPath: string;
  /** Container format: BND4_DFLT, BND4_KRAK, or unknown. */
  containerFormat: string;
  /** Total entry count. */
  entryCount: number;
  /** Per-entry evidence (bounded to MAX_EVIDENCE_ENTRIES). */
  entries: ScriptContainerEntryEvidence[];
  /** Whether the entry list was truncated. */
  truncated: boolean;
  /** Distribution of classifications. */
  classificationSummary: Record<ScriptEntryClassification, number>;
  diagnostics: StructuredDiagnostic[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MAX_EVIDENCE_ENTRIES = 256;
const HEADER_PREVIEW_BYTES = 32;

/** Havok Script (Lua 5.1 family) compiled bytecode magic: \x1bLuaQ */
const LUA_BYTECODE_MAGIC = [0x1b, 0x4c, 0x75, 0x61, 0x51];

/* ------------------------------------------------------------------ */
/*  Classification                                                    */
/* ------------------------------------------------------------------ */

export function classifyScriptEntry(name: string, headerBytes?: number[]): ScriptEntryClassification {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'luagnl') return 'luagnl';
  if (ext === 'luainfo') return 'luainfo';
  if (ext === 'esd') return 'esd-bytecode';
  if (ext === 'hkx') return 'hkx-bytecode';

  if (ext === 'lua' || ext === 'hks') {
    if (headerBytes && headerBytes.length >= LUA_BYTECODE_MAGIC.length) {
      const matches = LUA_BYTECODE_MAGIC.every((b, i) => headerBytes[i] === b);
      if (matches) return 'lua-bytecode';
    }
    // Even without header confirmation, .lua/.hks in script containers
    // are compiled bytecode per W-BEHAVIOR-MAP-01 probe evidence.
    return 'lua-bytecode';
  }

  return 'unknown';
}

export function magicLabel(classification: ScriptEntryClassification): string {
  switch (classification) {
    case 'lua-bytecode': return '\\x1bLuaQ (Havok Script compiled bytecode)';
    case 'luagnl': return 'LUAGNL (global name table)';
    case 'luainfo': return 'LUAINFO (function parameter metadata)';
    case 'esd-bytecode': return 'ESD (state machine bytecode)';
    case 'hkx-bytecode': return 'HKX (behavior bytecode)';
    default: return 'unknown';
  }
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
  extensionDistribution?: Record<string, number>;
  resourceKindDistribution?: Record<string, number>;
}

/**
 * Build a readonly evidence projection for a script container.
 * Uses the Bridge `inventory-asset-resources` command for entry enumeration
 * and `snapshot-bnd4-child` for header bytes when needed.
 *
 * Never modifies any file. Never executes or decompiles scripts.
 */
export async function buildScriptContainerEvidence(
  options: ScriptEvidenceOptions
): Promise<ScriptContainerEvidence> {
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceUri = `file:///${options.containerPath.replace(/\\/g, '/')}`;

  // Step 1: Enumerate container entries via Bridge inventory
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
      classificationSummary: {
        'lua-bytecode': 0, 'luagnl': 0, 'luainfo': 0,
        'esd-bytecode': 0, 'hkx-bytecode': 0, 'unknown': 0
      },
      diagnostics
    };
  }

  const data = inventory.data ?? {};
  const rawEntries = data.entries ?? data.sampleEntries ?? [];
  const truncated = rawEntries.length > MAX_EVIDENCE_ENTRIES;
  const boundedEntries = rawEntries.slice(0, MAX_EVIDENCE_ENTRIES);

  // Step 2: Classify each entry
  const entries: ScriptContainerEntryEvidence[] = boundedEntries.map((entry) => {
    const name = entry.name ?? `entry_${entry.index ?? 0}`;
    const classification = classifyScriptEntry(name);
    return {
      name,
      index: entry.index ?? 0,
      size: entry.uncompressedSize ?? 0,
      extension: name.split('.').pop()?.toLowerCase() ?? '',
      classification,
      magicLabel: magicLabel(classification)
    };
  });

  // Step 3: Build classification summary
  const classificationSummary: Record<ScriptEntryClassification, number> = {
    'lua-bytecode': 0, 'luagnl': 0, 'luainfo': 0,
    'esd-bytecode': 0, 'hkx-bytecode': 0, 'unknown': 0
  };
  for (const entry of entries) {
    classificationSummary[entry.classification] += 1;
  }

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'SCRIPT_EVIDENCE_BUILT',
    message: `Script container evidence: ${entries.length} entries (${classificationSummary['lua-bytecode']} Lua bytecode, ${classificationSummary['luagnl']} LUAGNL, ${classificationSummary['luainfo']} LUAINFO).`,
    targetUri: sourceUri
  }));

  return {
    ok: true,
    containerPath: options.containerPath,
    containerFormat: data.format ?? 'BND4',
    entryCount: data.entryCount ?? rawEntries.length,
    entries,
    truncated,
    classificationSummary,
    diagnostics
  };
}