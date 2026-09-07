/**
 * Script loader profiles for SoulForge script editing.
 *
 * Enforces resource category, representation, encoding, and syntax/decompiler
 * tool bindings. Only resources explicitly verified to support plaintext source
 * editing are allowed to be modified as source.
 */

import type { PlaintextEncoding } from './plaintextScriptEntry.js';

export type ScriptResourceKind = 'ai-script' | 'action-hks' | 'text-nameid' | 'other';
export type ScriptRepresentation = 'plaintext' | 'bytecode' | 'unknown';

export interface ScriptSyntaxValidator {
  toolName: string;
  targetLuaVersion: string;
  validatorPath?: string;
  /**
   * Run syntax validation on script source.
   * If validator tool is missing or returns non-zero, this must fail.
   */
  validate?: (source: string) => { ok: boolean; error?: string };
}

export interface ScriptDecompilerTool {
  toolName: string;
  version: string;
  executablePath?: string;
}

export interface ScriptLoaderProfile {
  id: string;
  game: string;
  version?: string;
  resourceKind: ScriptResourceKind;
  containerPattern: RegExp | string;
  entryPattern?: RegExp | string;
  allowedRepresentations: ScriptRepresentation[];
  defaultEncoding: PlaintextEncoding;
  supportsPlaintextSourceEdit: boolean;
  bytecodeToSourceAllowed: boolean;
  matchingSyntaxValidator?: ScriptSyntaxValidator;
  decompilerTool?: ScriptDecompilerTool;
  verifiedSamples: string[];
}

export const REGISTERED_SCRIPT_LOADER_PROFILES: readonly ScriptLoaderProfile[] = Object.freeze([
  {
    id: 'sekiro-ai-luabnd',
    game: 'sekiro',
    version: '1.06',
    resourceKind: 'ai-script',
    containerPattern: /\.luabnd(\.dcx)?$/i,
    entryPattern: /\.lua$/i,
    allowedRepresentations: ['plaintext', 'bytecode'],
    defaultEncoding: 'shift_jis',
    supportsPlaintextSourceEdit: true, // Only for verified plaintext entries
    bytecodeToSourceAllowed: false, // Prohibit bytecode -> source writeback for production AI scripts
    matchingSyntaxValidator: {
      toolName: 'luac51-syntax',
      targetLuaVersion: 'Lua 5.1 / Havok Script'
    },
    decompilerTool: {
      toolName: 'DSLuaDecompiler',
      version: 'v1.1.5'
    },
    verifiedSamples: [
      'goal_list.lua',
      '543000_battle.lua',
      '801000_battle.lua',
      'logic_list.lua'
    ]
  },
  {
    id: 'sekiro-action-nameid',
    game: 'sekiro',
    version: '1.06',
    resourceKind: 'text-nameid',
    containerPattern: /nameid\.txt$/i,
    entryPattern: /nameid\.txt$/i,
    allowedRepresentations: ['plaintext'],
    defaultEncoding: 'shift_jis',
    supportsPlaintextSourceEdit: true,
    bytecodeToSourceAllowed: false,
    verifiedSamples: [
      'eventnameid.txt',
      'statenameid.txt',
      'variablenameid.txt'
    ]
  },
  {
    id: 'sekiro-action-hks',
    game: 'sekiro',
    version: '1.06',
    resourceKind: 'action-hks',
    containerPattern: /\.hks$/i,
    entryPattern: /\.hks$/i,
    allowedRepresentations: ['bytecode'],
    defaultEncoding: 'ascii',
    supportsPlaintextSourceEdit: false,
    bytecodeToSourceAllowed: false,
    decompilerTool: {
      toolName: 'DSLuaDecompiler',
      version: 'v1.1.5'
    },
    verifiedSamples: [
      'c0000_transition.hks'
    ]
  }
]);

export function resolveScriptLoaderProfile(context: {
  game?: string;
  containerPath?: string;
  entryName?: string;
  isBytecode?: boolean;
}): ScriptLoaderProfile | undefined {
  const game = context.game ?? 'sekiro';
  const container = context.containerPath ?? '';
  const entry = context.entryName ?? '';

  for (const profile of REGISTERED_SCRIPT_LOADER_PROFILES) {
    if (profile.game !== game) continue;
    const matchContainer = typeof profile.containerPattern === 'string'
      ? container.toLowerCase().includes(profile.containerPattern.toLowerCase())
      : profile.containerPattern.test(container);
    if (!matchContainer) continue;

    if (profile.entryPattern && entry) {
      const matchEntry = typeof profile.entryPattern === 'string'
        ? entry.toLowerCase().includes(profile.entryPattern.toLowerCase())
        : profile.entryPattern.test(entry);
      if (!matchEntry) continue;
    }
    return profile;
  }
  return undefined;
}

export function canEditScriptAsSource(
  profile: ScriptLoaderProfile | undefined,
  isBytecode: boolean
): { allowed: boolean; code?: string; message?: string } {
  if (!profile) {
    return {
      allowed: false,
      code: 'SCRIPT_PROFILE_NOT_REGISTERED',
      message: '该脚本资源未匹配任何已登记的 ScriptLoaderProfile，禁止作为源码编辑。'
    };
  }
  if (isBytecode) {
    if (!profile.bytecodeToSourceAllowed) {
      return {
        allowed: false,
        code: 'SCRIPT_BYTECODE_SOURCE_EDIT_PROHIBITED',
        message: `Profile '${profile.id}' 未开放字节码反编译源码编辑写回；仅支持只读或整文件字节替换。`
      };
    }
  } else {
    if (!profile.supportsPlaintextSourceEdit) {
      return {
        allowed: false,
        code: 'SCRIPT_PLAINTEXT_SOURCE_EDIT_PROHIBITED',
        message: `Profile '${profile.id}' 未开放明文源码编辑。`
      };
    }
  }
  return { allowed: true };
}
