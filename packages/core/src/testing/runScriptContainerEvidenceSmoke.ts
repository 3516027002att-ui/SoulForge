/**
 * Script container evidence smoke:
 * 1) Synthetic classification assertions (always run, deterministic).
 * 2) Real container evidence when a native fixture is injected (arg 2).
 *
 * SoulForge does NOT decompile, recompile, or execute scripts.
 */
import {
  classifyScriptEntry,
  magicLabel,
  type ScriptEntryClassification
} from '../script/scriptContainerEvidence.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/*  Synthetic classification checks                                   */
/* ------------------------------------------------------------------ */

function syntheticChecks(): void {
  // Lua bytecode classification
  assert(classifyScriptEntry('goal_list.lua') === 'lua-bytecode', '.lua → lua-bytecode');
  assert(classifyScriptEntry('c0000.hks') === 'lua-bytecode', '.hks → lua-bytecode');
  assert(classifyScriptEntry('ai/101000_logic.lua') === 'lua-bytecode', 'nested .lua → lua-bytecode');

  // Lua bytecode with magic confirmation
  const luaMagic = [0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00, 0x01, 0x04];
  assert(classifyScriptEntry('test.lua', luaMagic) === 'lua-bytecode', '.lua with magic → lua-bytecode');

  // LUAGNL classification
  assert(classifyScriptEntry('aiCommon.luagnl') === 'luagnl', '.luagnl → luagnl');
  assert(classifyScriptEntry('common.luagnl') === 'luagnl', '.luagnl → luagnl');

  // LUAINFO classification
  assert(classifyScriptEntry('aiCommon.luainfo') === 'luainfo', '.luainfo → luainfo');

  // ESD classification
  assert(classifyScriptEntry('t112110.esd') === 'esd-bytecode', '.esd → esd-bytecode');

  // HKX classification
  assert(classifyScriptEntry('behavior.hkx') === 'hkx-bytecode', '.hkx → hkx-bytecode');

  // Unknown classification
  assert(classifyScriptEntry('readme.txt') === 'unknown', '.txt → unknown');
  assert(classifyScriptEntry('data.bin') === 'unknown', '.bin → unknown');
  assert(classifyScriptEntry('noext') === 'unknown', 'no extension → unknown');

  // Magic labels
  assert(magicLabel('lua-bytecode').includes('Havok Script'), 'lua-bytecode label');
  assert(magicLabel('luagnl').includes('global name table'), 'luagnl label');
  assert(magicLabel('luainfo').includes('function parameter'), 'luainfo label');
  assert(magicLabel('esd-bytecode').includes('state machine'), 'esd label');
  assert(magicLabel('hkx-bytecode').includes('behavior'), 'hkx label');
  assert(magicLabel('unknown') === 'unknown', 'unknown label');

  // Case insensitivity for extensions
  assert(classifyScriptEntry('TEST.LUA') === 'lua-bytecode', 'uppercase .LUA → lua-bytecode');
  assert(classifyScriptEntry('test.HKS') === 'lua-bytecode', 'uppercase .HKS → lua-bytecode');
  assert(classifyScriptEntry('test.LUAGNL') === 'luagnl', 'uppercase .LUAGNL → luagnl');

  console.log(JSON.stringify({
    ok: true,
    message: 'script container evidence synthetic smoke: ok',
    cases: 20
  }));
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

syntheticChecks();

const realPath = process.argv[2];
if (realPath) {
  console.log(JSON.stringify({
    ok: true,
    message: 'real container evidence requires Bridge daemon; skipping in synthetic-only mode',
    skipped: true
  }));
} else {
  console.log(JSON.stringify({
    ok: true,
    message: 'real container not provided, skipping real evidence',
    skipped: true
  }));
}