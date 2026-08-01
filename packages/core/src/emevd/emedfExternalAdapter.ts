/**
 * External-only adapter for DarkScript3-format EMEDF JSON files.
 *
 * SoulForge does NOT bundle, commit, or redistribute EMEDF data.
 * DarkScript3 is "All Rights Reserved" by its copyright owners.
 * This adapter reads from a user-provided local file path (e.g. from
 * the user's own DarkScript3 installation) and converts to SoulForge's
 * internal EmedfRegistry format.
 *
 * Type code mapping (DarkScript3 → SoulForge):
 *   0 → u8, 1 → u16, 2 → u32, 3 → s8, 4 → s16, 5 → s32, 6 → f32, 8 → u32
 */

import { readFileSync } from 'node:fs';
import type {
  EmedfArgDef,
  EmedfArgType,
  EmedfInstructionDef,
  EmedfRegistry,
  EmedfRegistryValidationResult,
} from './emedfSchema.js';
import { validateEmedfRegistry } from './emedfSchema.js';

/* ------------------------------------------------------------------ */
/*  DarkScript3 JSON schema (subset we consume)                       */
/* ------------------------------------------------------------------ */

interface Ds3ArgDoc {
  name: string;
  type: number;
  enum_name?: string | null;
  default?: number;
  min?: number;
  max?: number;
  increment?: number;
  format_string?: string | null;
  vararg?: boolean;
}

interface Ds3InstrDoc {
  name: string;
  index: number;
  args?: Ds3ArgDoc[];
}

interface Ds3ClassDoc {
  name: string;
  index: number;
  instrs?: Ds3InstrDoc[];
}

interface Ds3EmedfJson {
  unknown?: number;
  main_classes?: Ds3ClassDoc[];
  enums?: unknown[];
  darkscript?: unknown;
}

/* ------------------------------------------------------------------ */
/*  Type mapping                                                      */
/* ------------------------------------------------------------------ */

const DS3_TYPE_MAP: Record<number, EmedfArgType> = {
  0: 'u8',
  1: 'u16',
  2: 'u32',
  3: 's8',
  4: 's16',
  5: 's32',
  6: 'f32',
  8: 'u32', // string position, treated as u32
};

/* ------------------------------------------------------------------ */
/*  Conversion result                                                 */
/* ------------------------------------------------------------------ */

export type EmedfImportResult =
  | { ok: true; registry: EmedfRegistry; instructionCount: number; bankCount: number }
  | { ok: false; code: string; message: string };

/* ------------------------------------------------------------------ */
/*  Adapter                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a DarkScript3 EMEDF JSON string into a SoulForge EmedfRegistry.
 * Does NOT touch the filesystem — callers provide the raw text.
 * Handles JSON with // and /* *​/ comments (Newtonsoft.Json compat).
 */
export function parseDs3EmedfJson(jsonText: string): EmedfImportResult {
  let raw: Ds3EmedfJson;
  try {
    raw = JSON.parse(stripJsonComments(jsonText)) as Ds3EmedfJson;
  } catch {
    return { ok: false, code: 'EMEDF_IMPORT_PARSE_FAILED', message: 'EMEDF JSON 解析失败。' };
  }

  if (!raw || !Array.isArray(raw.main_classes)) {
    return {
      ok: false,
      code: 'EMEDF_IMPORT_SCHEMA_INVALID',
      message: 'EMEDF JSON 缺少 main_classes 数组。',
    };
  }

  const instructions: EmedfInstructionDef[] = [];
  const bankSet = new Set<number>();

  for (const cls of raw.main_classes) {
    if (!cls || !Number.isSafeInteger(cls.index) || cls.index < 0) continue;
    const bank = cls.index;
    bankSet.add(bank);

    if (!Array.isArray(cls.instrs)) continue;
    for (const instr of cls.instrs) {
      if (!instr || !Number.isSafeInteger(instr.index) || instr.index < 0) continue;
      if (typeof instr.name !== 'string' || !instr.name.trim()) continue;

      const args: EmedfArgDef[] = [];
      if (Array.isArray(instr.args)) {
        const usedNames = new Set<string>();
        for (const arg of instr.args) {
          if (!arg || typeof arg.name !== 'string' || !arg.name.trim()) continue;
          const mappedType = DS3_TYPE_MAP[arg.type];
          if (!mappedType) continue; // unknown type code — skip arg

          let sanitizedName = sanitizeArgName(arg.name);
          // Deduplicate: append _2, _3, ... on collision
          if (usedNames.has(sanitizedName)) {
            let suffix = 2;
            while (usedNames.has(`${sanitizedName}_${suffix}`)) suffix++;
            sanitizedName = `${sanitizedName}_${suffix}`;
          }
          usedNames.add(sanitizedName);

          const def: EmedfArgDef = {
            name: sanitizedName,
            type: mappedType,
          };
          if (arg.enum_name) {
            def.description = `enum:${arg.enum_name}`;
          }
          if (arg.vararg === true) {
            def.vararg = true;
          }
          args.push(def);
        }
      }

      instructions.push({
        bank,
        id: instr.index,
        name: sanitizeInstructionName(instr.name),
        args,
      });
    }
  }

  const registry: EmedfRegistry = {
    schemaVersion: 1,
    game: 'sekiro',
    origin: 'imported',
    instructions,
  };

  const validation = validateEmedfRegistry(registry);
  if (!validation.ok) {
    return {
      ok: false,
      code: (validation as { code: string }).code,
      message: `EMEDF 导入验证失败：${(validation as { message: string }).message}`,
    };
  }

  return {
    ok: true,
    registry,
    instructionCount: instructions.length,
    bankCount: bankSet.size,
  };
}

/**
 * Read and parse a DarkScript3 EMEDF JSON file from a local path.
 * The caller is responsible for ensuring the path is safe and user-provided.
 */
export function importDs3EmedfFile(filePath: string): EmedfImportResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return {
      ok: false,
      code: 'EMEDF_IMPORT_READ_FAILED',
      message: `无法读取 EMEDF 文件：${filePath}`,
    };
  }
  return parseDs3EmedfJson(text);
}

/* ------------------------------------------------------------------ */
/*  Name sanitization                                                 */
/* ------------------------------------------------------------------ */

/** DarkScript3 uses "IF Condition Group" style; SoulForge uses camelCase identifiers. */
function sanitizeInstructionName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .split(/\s+/)
    .map((word, i) =>
      i === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join('');
}

/** DarkScript3 arg names like "Result Condition Group" → "resultConditionGroup". */
function sanitizeArgName(raw: string): string {
  const words = raw
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'unknown';
  return words
    .map((word, i) => {
      // All-caps acronyms (e.g. "ID") become title-case ("Id") so the camelCase
      // result is conventional ("eventId", "eventSlotId") and stable for DSL.
      if (word === word.toUpperCase() && /[A-Z]/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return i === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/*  JSON comment stripping (Newtonsoft.Json compat)                   */
/* ------------------------------------------------------------------ */

/**
 * Strip // line comments and /* block comments *​/ from JSON text,
 * respecting string literals. Also removes trailing commas before ] or }
 * (Newtonsoft.Json compat). DarkScript3 EMEDF JSON uses both features.
 */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      result += ch;
      if (ch === '\\') {
        // skip escaped char
        i++;
        if (i < text.length) result += text[i]!;
      } else if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '/') {
        // line comment — skip to end of line
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // block comment — skip to *​/
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before ] or } (Newtonsoft.Json compat)
  return result.replace(/,\s*([\]}])/g, '$1');
}