/**
 * Script container evidence smoke (W-BEHAVIOR-MAP-01 frozen inventory).
 * 1) Synthetic classification/magic assertions (always run, deterministic).
 * 2) Real container-level magic/reference inventory when a native fixture is
 *    injected (explicit arg 2, or registry env vars set): entry enumeration,
 *    extension distribution, `\x1bLua` compiled-bytecode identification from
 *    real header bytes, LUAGNL/LUAINFO/ESD/HKX classification, bounded hex
 *    evidence, sanitized entry names (no absolute paths).
 *
 * Real-corpus finding (Sekiro luabnd): inner `.lua` entries are a MIX of
 * `\x1bLuaP` compiled bytecode and plain-text list files (goal_list.lua /
 * logic_list.lua); BND4 inner names are absolute build-machine paths and are
 * sanitized to basenames in evidence.
 *
 * SoulForge does NOT decompile, recompile, or execute scripts.
 * Authority cap: candidate (container-level inventory only).
 */
import {
  classifyScriptEntry,
  isHavokScriptBytecode,
  magicLabel,
  sanitizeEntryName,
  buildScriptContainerEvidence,
  type ScriptContainerEvidence
} from '../script/scriptContainerEvidence.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { dirname } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/*  Synthetic classification/magic checks                             */
/* ------------------------------------------------------------------ */

function syntheticChecks(): void {
  // Lua bytecode classification
  assert(classifyScriptEntry('goal_list.lua') === 'lua-bytecode', '.lua → lua-bytecode');
  assert(classifyScriptEntry('c0000.hks') === 'lua-bytecode', '.hks → lua-bytecode');
  assert(classifyScriptEntry('ai/101000_logic.lua') === 'lua-bytecode', 'nested .lua → lua-bytecode');

  // Lua bytecode with magic confirmation
  const luaMagicP = [0x1b, 0x4c, 0x75, 0x61, 0x50, 0x01, 0x04, 0x08]; // \x1bLuaP (Sekiro/Havok)
  const luaMagicQ = [0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00, 0x01, 0x04]; // \x1bLuaQ (vanilla Lua 5.1)
  assert(classifyScriptEntry('test.lua', luaMagicP) === 'lua-bytecode', '.lua with \\x1bLuaP magic → lua-bytecode');
  assert(classifyScriptEntry('test.lua', luaMagicQ) === 'lua-bytecode', '.lua with \\x1bLuaQ magic → lua-bytecode');

  // isHavokScriptBytecode: \x1bLua family detection (P and Q)
  assert(isHavokScriptBytecode(luaMagicP) === true, '\\x1bLuaP (Sekiro corpus) detected');
  assert(isHavokScriptBytecode(luaMagicQ) === true, '\\x1bLuaQ (vanilla) detected');
  assert(isHavokScriptBytecode([0x1b, 0x4c, 0x75, 0x61, 0x50, 0x00]) === true, '\\x1bLuaP exactly five bytes');
  assert(isHavokScriptBytecode([0x1b, 0x4c, 0x75, 0x61, 0x52, 0x00]) === false, '\\x1bLuaR rejected');
  assert(isHavokScriptBytecode([0x00, 0x1b, 0x4c, 0x75, 0x61]) === false, 'magic must start at byte 0');
  assert(isHavokScriptBytecode([0x1b, 0x4c, 0x75, 0x61]) === false, 'short prefix rejected (length guard)');
  assert(isHavokScriptBytecode(new Uint8Array(luaMagicP)) === true, 'Uint8Array accepted');

  // Plain-text .lua (e.g. goal_list.lua) is NOT bytecode by real bytes
  const textLua = [0x47, 0x4f, 0x41, 0x4c, 0x5f, 0x43, 0x4f, 0x4d]; // "GOAL_COM..."
  assert(isHavokScriptBytecode(textLua) === false, 'text .lua header is not bytecode magic');
  assert(classifyScriptEntry('goal_list.lua', textLua) === 'lua-bytecode',
    'text .lua keeps extension classification (magicVerified carries the truth)');

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

  // Entry-name sanitization (Sekiro BND4 inner names are absolute build paths)
  const seenNames = new Set<string>();
  assert(sanitizeEntryName('N:\\NTC\\data\\Target\\INTERROOT_win64\\script\\ai\\out\\bin\\goal_list.lua', 0, seenNames) === 'goal_list.lua',
    'sanitize absolute path to basename');
  assert(sanitizeEntryName('script/ai/out/bin/101000_logic.lua', 1, seenNames) === '101000_logic.lua',
    'sanitize slash-path to basename');
  assert(sanitizeEntryName('aiCommon.luainfo', 2, seenNames) === 'aiCommon.luainfo',
    'sanitize luainfo basename');
  assert(sanitizeEntryName('goal_list.lua', 5, seenNames) === 'goal_list.lua#5',
    'basename collision disambiguated with index');
  assert(sanitizeEntryName('', 9, seenNames) === 'entry_9', 'empty name falls back to entry_<index>');

  console.log(JSON.stringify({
    ok: true,
    message: 'script container evidence synthetic smoke: ok (classification + \\x1bLua family magic detection + sanitization)',
    cases: 36
  }));
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

syntheticChecks();

// Real branch triggers on an explicit path (arg 2) OR on registry env
// presence (SOULFORGE_NATIVE_FIXTURE_REGISTRY + SOULFORGE_NATIVE_FIXTURE_ROOT,
// e.g. injected by scripts/with-local-has-game-env.mjs). Without either, the
// real leg is a structured skip — it is never a silent pass.
const explicitPath = process.argv[2]?.trim();
const registryConfigured = Boolean(
  process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
    && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
);

if (explicitPath || registryConfigured) {
  try {
    const path = await resolveNativeFixture(explicitPath, 'luabnd-primary', explicitPath ?? '');
    const evidence = await buildScriptContainerEvidence({
      containerPath: path,
      allowedRoots: [dirname(path)],
      timeoutMs: 60_000
    }) as ScriptContainerEvidence;

    /* Container-level inventory assertions (real luabnd fixture). */
    assert(evidence.ok === true, 'real luabnd evidence must build');
    assert(evidence.authority === 'candidate', 'authority cap = candidate');
    assert(evidence.containerFormat.includes('BND4'), `container format: ${evidence.containerFormat}`);
    assert(evidence.entryCount >= 200, `entryCount >= 200 (${evidence.entryCount})`);
    assert(evidence.entries.length > 0, 'entries must be enumerated');

    // Extension distribution across the whole container must be present and
    // dominated by script extensions (.lua for aicommon.luabnd).
    const extDist = evidence.extensionDistribution ?? {};
    const luaExtCount = extDist['lua'] ?? 0;
    assert(luaExtCount > 0, `extensionDistribution has .lua (${luaExtCount})`);
    assert(evidence.scriptEntryCount > 0, `scriptEntryCount > 0 (${evidence.scriptEntryCount})`);

    // Classification: script entries classified (no unknown for .lua).
    const luaCount = evidence.classificationSummary['lua-bytecode'];
    assert(luaCount > 0, `lua-bytecode classification present (${luaCount})`);
    const first = evidence.entries[0]!;
    assert(first.classification === 'lua-bytecode', `first entry classified as lua-bytecode (${first.name})`);

    // Real `\x1bLua` compiled-bytecode identification from actual header bytes:
    // at least one sampled .lua entry must carry the \x1bLuaP magic.
    assert(evidence.magicSampleCount > 0, `magic sample ran (${evidence.magicSampleCount})`);
    assert(evidence.magicVerifiedCount > 0,
      `real \\x1bLua magic verified (${evidence.magicVerifiedCount}/${evidence.magicSampleCount})`);

    // Bounded hex evidence: at least one verified entry carries headerHex,
    // and every headerHex is bounded (<= HEADER_PREVIEW_BYTES * 2 hex chars)
    // and starts with the \x1bLua signature.
    const verifiedHex = evidence.entries.find((entry) => entry.magicVerified === true);
    assert(Boolean(verifiedHex?.headerHex), 'verified entry has bounded headerHex');
    const hexBound = evidence.entries.reduce((max, entry) => Math.max(max, entry.headerHex?.length ?? 0), 0);
    assert(hexBound <= 64, `headerHex bounded (max ${hexBound} hex chars)`);
    assert(verifiedHex!.headerHex!.startsWith('1b4c7561'), 'headerHex starts with 1b4c7561 (\\x1bLua)');

    // Sanitization: evidence entry names must never contain drive-letter
    // absolute paths (Sekiro BND4 inner names are build-machine paths), and
    // printed output must not contain the containerPath or any absolute path.
    const printed = JSON.stringify({
      ok: true,
      message: 'real script container evidence: ok',
      containerFormat: evidence.containerFormat,
      entryCount: evidence.entryCount,
      entriesSampled: evidence.entries.length,
      truncated: evidence.truncated,
      classificationSummary: evidence.classificationSummary,
      extensionDistribution: evidence.extensionDistribution,
      magicVerifiedCount: evidence.magicVerifiedCount,
      magicSampleCount: evidence.magicSampleCount,
      scriptEntryCount: evidence.scriptEntryCount,
      authority: evidence.authority,
      firstEntry: evidence.entries[0]?.name
    });
    assert(!printed.includes(evidence.containerPath), 'printed evidence must not contain containerPath');
    assert(!/^[a-zA-Z]:[\\/]/m.test(printed), 'printed evidence must not contain drive-letter absolute paths');
    for (const entry of evidence.entries) {
      assert(!/^[a-zA-Z]:[\\/]/m.test(entry.name), `entry name sanitized (no drive path): ${entry.name}`);
      assert(!entry.name.includes('INTERROOT_win64'), `entry name sanitized (no build path): ${entry.name}`);
    }

    console.log(printed);
  } finally {
    await disposeBridgeDaemonPool();
  }
} else {
  console.log(JSON.stringify({
    ok: true,
    message: 'real container not provided (no arg / no native fixture registry env), skipping real inventory',
    skipped: true
  }));
}
