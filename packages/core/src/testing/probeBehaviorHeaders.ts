/**
 * Behavior-format header probe (W-BEHAVIOR-MAP-01 research tool).
 *
 * Extracts representative behavior/script children from the local Sekiro
 * mods tree via the Bridge daemon and dumps raw headers for magic observation:
 * anibnd (TAE/HKX), behbnd (HKX), luabnd (Lua/LuaInfo/LuaGnl), talkesdbnd (ESD).
 *
 * This is a research probe only:
 * - Requires SOULFORGE_SEKIRO_GAME_ROOT (the game root is always read-only);
 * - Child extraction goes to a scratch dir under the system temp root;
 * - Never commits outputs, never promotes authority, never executes scripts;
 * - Extension counting is container-level inventory, not a native document.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function gameRootOrFail(): string {
  const root = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!root) {
    throw new Error('SOULFORGE_SEKIRO_GAME_ROOT 未设置；探针拒绝运行（游戏目录必须只读访问）。');
  }
  return root;
}

const scratch = join(tmpdir(), 'soulforge-behavior-probe');

interface DcxEnvelope {
  nested?: { entryCount: number; entries?: Array<{ name: string; compressedSize: number; id: number }> };
  payloadPrefixHex?: string;
}

/** Identify the magic of a raw header prefix (readonly, never decompiles). */
function magicLabelFor(bytes: Uint8Array): string {
  if (bytes.length >= 5
    && bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x75 && bytes[3] === 0x61
    && (bytes[4] === 0x50 || bytes[4] === 0x51)) {
    return `\\x1bLua${String.fromCharCode(bytes[4])} (Havok Script compiled bytecode; Sekiro corpus \\x1bLuaP)`;
  }
  const ascii = [...bytes.subarray(0, 8)].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  if (bytes.length >= 8 && bytes[4] === 0x54 && bytes[5] === 0x41 && bytes[6] === 0x47 && bytes[7] === 0x30) {
    return 'HKX tagfile (TAG0 at offset 4)';
  }
  if (ascii.startsWith('hkxs')) return 'HKX binary (hkxs)';
  if (ascii.startsWith('Havok')) return 'HKX (Havok)';
  if (ascii.startsWith('TAE')) return 'TAE (animation events)';
  if (ascii.startsWith('fsSL')) return 'ESD (state machine bytecode)';
  if (ascii.startsWith('ESD0')) return 'ESD (state machine bytecode)';
  if (ascii.startsWith('BND4')) return 'BND4 container';
  if (ascii.startsWith('LUAI')) return 'LUAINFO (function parameter metadata)';
  return `unknown (${ascii})`;
}

interface ExtractEnvelope {
  contentSize?: number;
  outputPath?: string;
  name?: string;
  id?: number;
}

async function dumpContainer(rel: string, label: string): Promise<void> {
  const file = join(gameRootOrFail(), rel);
  const dcx = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: file,
    allowedRoots: [join(gameRootOrFail(), 'mods')],
    oodleRuntimeRoot: gameRootOrFail(),
    timeoutMs: 120_000
  });
  const entries: Array<{ name: string; compressedSize: number; id: number }> = dcx.data?.nested?.entries ?? [];
  console.log(`\n=== ${label}: ${rel} (${entries.length} entries) ===`);
  // extension distribution
  const extCount = new Map<string, number>();
  for (const entry of entries) {
    const match = /\.([a-z0-9]+)$/i.exec(entry.name);
    const ext = match ? match[1]!.toLowerCase() : '(none)';
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  console.log('extDistribution:', JSON.stringify(Object.fromEntries([...extCount].sort())));
  const interesting = entries.filter((e) => /\.(hkx|hks|lua|tae|esd|hkt)$/i.test(e.name));
  console.log('behaviorExtEntries:', interesting.map((e) => e.name.split('/').pop()).slice(0, 25));
  const others = entries.filter((e) => !/\.(hkx|hks|lua|tae|esd|hkt)$/i.test(e.name));
  console.log('nonBehaviorEntries:', others.map((e) => e.name.split('/').pop()).slice(0, 12));
  return;
}

async function extractHeader(rel: string, childPath: string, outName: string, label: string): Promise<void> {
  const file = join(gameRootOrFail(), rel);
  const out = join(scratch, outName);
  const r = await runBridge<ExtractEnvelope>({
    command: 'extract-bnd4-child',
    filePath: file,
    allowedRoots: [join(gameRootOrFail(), 'mods')],
    writableRoots: [scratch],
    oodleRuntimeRoot: gameRootOrFail(),
    commandOptions: { childPath, outputPath: out },
    timeoutMs: 120_000
  });
  if (r.parseStatus === 'failed' || !r.data?.outputPath) {
    console.log(`\n=== ${label} EXTRACT FAILED: ${JSON.stringify(r.diagnostics)}`);
    return;
  }
  const bytes = readFileSync(r.data.outputPath);
  const header = bytes.subarray(0, 32);
  const hex = [...header].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...bytes.subarray(0, 48)].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  console.log(`\n=== ${label}: ${r.data.name ?? childPath} (${bytes.length} B, id=${r.data.id}) ===`);
  console.log(`  magic: ${magicLabelFor(header)}`);
  console.log(`  hex:   ${hex}`);
  console.log(`  ascii: ${ascii}`);
}

async function main(): Promise<void> {
  mkdirSync(scratch, { recursive: true });
  try {
    await dumpContainer('mods/chr/c0000.anibnd.dcx', 'anibnd c0000');
    await dumpContainer('mods/chr/c4510.behbnd.dcx', 'behbnd c4510');
    await dumpContainer('mods/script/aicommon.luabnd.dcx', 'luabnd aicommon');
    await dumpContainer('mods/script/m11_00_00_00.luabnd.dcx', 'luabnd m11_00');
    await dumpContainer('mods/script/talk/m11_02_00_00.talkesdbnd.dcx', 'talkesdbnd');

    await extractHeader('mods/chr/c0000.anibnd.dcx', 'hkx/skeleton.hkx', 'skeleton.hkx', 'HKX skeleton');
    await extractHeader('mods/chr/c0000.anibnd.dcx', 'tae/a00.tae', 'a00.tae', 'TAE a00');
    await extractHeader('mods/chr/c4510.behbnd.dcx', 'Export/Behaviors/c9997.hkx', 'beh_c9997.hkx', 'HKX behavior');
    await extractHeader('mods/chr/c4510.behbnd.dcx', 'Export/Characters/c4510.hkx', 'beh_char.hkx', 'HKX characters');
    await extractHeader('mods/script/aicommon.luabnd.dcx', 'goal_list.lua', 'goal_list.lua', 'LUA goal_list');
    await extractHeader('mods/script/aicommon.luabnd.dcx', 'ai_define.lua', 'ai_define.lua', 'LUA ai_define');
    await extractHeader('mods/script/m11_00_00_00.luabnd.dcx', '101000_logic.lua', 'm11_logic.lua', 'LUA m11 logic');
    await extractHeader('mods/script/talk/m11_02_00_00.talkesdbnd.dcx', 't112110.esd', 'talk.esd', 'ESD talk');
    await extractHeader('mods/script/aicommon.luabnd.dcx', 'aiCommon.luainfo', 'ai.luainfo', 'LUAINFO sample');
    await extractHeader('mods/script/aicommon.luabnd.dcx', 'aiCommon.luagnl', 'ai.luagnl', 'LUAGNL sample');
    await extractHeader('mods/chr/c0000.anibnd.dcx', 'c0000_a000_hi.txt', 'anibnd_txt.bin', 'anibnd txt sample');
  } finally {
    await disposeBridgeDaemonPool();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  await disposeBridgeDaemonPool();
  process.exitCode = 1;
});
