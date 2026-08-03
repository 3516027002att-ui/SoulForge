/**
 * Script-container game-load smoke (W-SCRIPT-READONLY-01 game-load leg).
 *
 * Covers SCOPE-BEHAVIOR-SCRIPT `game-load` honestly under the repository rule
 * "Real in-game launch automation is not shipped" (see
 * scripts/verify-section28-sekiro-gate.mjs). SoulForge never launches the game;
 * this smoke provides the script-side load-validation path/contract instead.
 *
 * Three legs:
 *
 *  Leg 1  synthetic (always runs): fail-closed proof of the load-prerequisite
 *         magic check. Preserved `\x1bLuaP` / `\x1bLuaQ` magic must pass;
 *         corrupted magic, non-Lua headers and too-short headers must each
 *         produce a structured error — never a silent pass. A check that has
 *         never been proven to fail is a rubber stamp, so this leg exists.
 *
 *  Leg 2  preflight / diagnostic (requires native fixture env): takes a real
 *         luabnd (`mods/script/aicommon.luabnd.dcx`), copies it into a temp
 *         overlay that mirrors the game mod layout (`<overlay>/mods/script/`),
 *         performs a whole-inner-file replacement through the SAME write trunk
 *         as test:script-container-replace (Bridge native write-bnd4 staging →
 *         PatchIR container_child_replace → WorkspaceTransaction commit →
 *         Bridge reread → operation rollback), then verifies the replaced
 *         container satisfies the game-load prerequisites that can be proven
 *         without launching the game:
 *           - placement: mod-relative path `script/<basename>` = game-root
 *             path `mods/script/<basename>`;
 *           - container integrity: re-readable, entry count unchanged, unknown
 *             fields preserved, same-length inner entry;
 *           - bytecode magic preserved: replaced inner entry still starts with
 *             `\x1bLua` (`\x1bLuaP` / `\x1bLuaQ`).
 *         The replacement bytes are the entry's own bytes ("保持原样"):
 *         SoulForge never generates bytecode and cannot prove a *mutated*
 *         compiled script is still loadable without actually loading it, so a
 *         kept-as-is replacement is the only load-preserving byte source the
 *         automated leg may use. The real "game loads the mutated script" claim
 *         is deferred to Leg 3 and stays an honest nonClaim here.
 *
 *  Leg 3  real-load confirmation (opt-in, validation-unfrozen): requires
 *         `SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED=<ISO timestamp>`. The user
 *         first commits a whole-inner-file replacement into the live
 *         `<gameRoot>/mods/script/aicommon.luabnd.dcx` (via the desktop script
 *         panel's Patch Engine path, or manually) and confirms the game boots
 *         to the script-read stage without crash. The smoke then verifies:
 *           (a) the live file actually differs from the registered pristine
 *               fixture hash — a real replacement is present, otherwise a
 *               confirmation would be a false claim (fail-closed);
 *           (b) the live file passes the same load-prerequisite preflight
 *               (container reread + entry sanity + `\x1bLua` magic preserved).
 *         This is a single-machine user confirmation, NOT automated
 *         game-launch evidence. Authority stays `candidate` — no slice or gate
 *         may be promoted on the strength of this leg alone.
 *
 *  Fail-closed contract: any magic/structure anomaly on a replaced entry yields
 *  a structured error diagnostic and exit 1. Missing env or a missing user
 *  confirmation is an honest structured skip (exit 0), never a fake pass.
 *
 *  Out of scope (documented, not implemented): action/script/*.hks are bare
 *  compiled scripts, not BND4 containers; replacing them is a whole-file
 *  `file_replace` on a different write trunk and is not part of this slice's
 *  container writer. luabnd / talkesdbnd containers are the replaceable units.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createDiagnostic, type StructuredDiagnostic } from '@soulforge/shared';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { checkReplacedEntryMagic, isHavokScriptBytecode } from '../script/scriptContainerEvidence.js';

interface DcxEnvelope {
  sourceHash: string;
  nested?: {
    entryCount: number;
    entries: Array<{ id: number; name: string; contentHash: string; index: number }>;
    fieldPreservation?: {
      headerUnknownBytesPreserved: boolean;
      entryHeaderFieldsPreserved: boolean;
      storedBytesPreserved: boolean;
      namesPreserved: boolean;
    };
  };
}

/** Structured fail-closed error carrying a machine-readable diagnostic. */
class StructuredError extends Error {
  constructor(readonly diagnostic: StructuredDiagnostic) {
    super(JSON.stringify(diagnostic));
    this.name = 'StructuredError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireFieldPreservation(label: string, envelope: DcxEnvelope | undefined): void {
  const fp = envelope?.nested?.fieldPreservation;
  if (!fp || !fp.headerUnknownBytesPreserved || !fp.entryHeaderFieldsPreserved
    || !fp.storedBytesPreserved || !fp.namesPreserved) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_FIELD_PRESERVATION_LOST',
      message: `${label} BND4 未知字段保持失败：${JSON.stringify(fp)}`
    }));
  }
}

function basenameOf(rawName: string): string {
  const separator = rawName.includes('\\') ? '\\' : '/';
  return rawName.split(separator).pop() ?? rawName;
}

/* ------------------------------------------------------------------ */
/*  Leg 1 — synthetic fail-closed proof of the magic prerequisite     */
/* ------------------------------------------------------------------ */

function runSyntheticMagicChecks(): void {
  // Preserved `\x1bLuaP` / `\x1bLuaQ` magic must pass the load prerequisite.
  const luaMagicP = [0x1b, 0x4c, 0x75, 0x61, 0x50, 0x01, 0x04, 0x08, 0x00, 0x00];
  const luaMagicQ = [0x1b, 0x4c, 0x75, 0x61, 0x51, 0x00, 0x01, 0x04, 0x08, 0x00];
  const okP = checkReplacedEntryMagic('c0000.lua', luaMagicP);
  assert(okP.ok === true, 'preserved \\x1bLuaP magic must pass load prerequisite');
  assert(okP.diagnostics.length === 0, 'preserved magic must produce no diagnostics');
  const okQ = checkReplacedEntryMagic('c0000.lua', luaMagicQ);
  assert(okQ.ok === true, 'preserved \\x1bLuaQ magic must pass load prerequisite');

  // Corrupted magic must FAIL closed (never a silent pass).
  const corrupted = luaMagicP.slice();
  corrupted[0] = 0x00;
  corrupted[1] = 0x00;
  corrupted[2] = 0x00;
  corrupted[3] = 0x00;
  const negCorrupt = checkReplacedEntryMagic('c0000.lua', corrupted);
  assert(negCorrupt.ok === false, 'corrupted magic must fail closed');
  assert(negCorrupt.diagnostics.some((d) => d.severity === 'error' && d.code === 'SCRIPT_LOAD_MAGIC_LOST'),
    'corrupted magic must raise SCRIPT_LOAD_MAGIC_LOST');

  // A non-Lua header (e.g. plain text) must FAIL closed.
  const textHeader = [0x47, 0x4f, 0x41, 0x4c, 0x5f, 0x43, 0x4f, 0x4d]; // "GOAL_COM"
  const negText = checkReplacedEntryMagic('goal_list.lua', textHeader);
  assert(negText.ok === false, 'non-Lua header must fail closed');
  assert(negText.diagnostics.some((d) => d.severity === 'error' && d.code === 'SCRIPT_LOAD_MAGIC_LOST'),
    'non-Lua header must raise SCRIPT_LOAD_MAGIC_LOST');

  // A too-short header must FAIL closed (length guard).
  const negShort = checkReplacedEntryMagic('c0000.lua', [0x1b, 0x4c, 0x75]);
  assert(negShort.ok === false, 'too-short header must fail closed');
  assert(negShort.diagnostics.some((d) => d.severity === 'error' && d.code === 'SCRIPT_LOAD_MAGIC_SHORT'),
    'too-short header must raise SCRIPT_LOAD_MAGIC_SHORT');

  console.log(JSON.stringify({
    ok: true,
    message: 'script container game-load synthetic leg: ok (preserved \\x1bLuaP/\\x1bLuaQ pass; corrupted / non-Lua / short fail closed)',
    cases: 7
  }));
}

/* ------------------------------------------------------------------ */
/*  Shared load-prerequisite preflight (fail-closed)                  */
/* ------------------------------------------------------------------ */

/**
 * Find the first real `\x1bLua` compiled-bytecode entry in a script container.
 *
 * Real Sekiro luabnd inner `.lua` entries are a MIX of Havok Script compiled
 * bytecode (`\x1bLuaP`) and plain-text list files (`goal_list.lua`,
 * `logic_list.lua`), so "first entry" is not a reliable bytecode target. Only
 * entries whose real header bytes actually carry the `\x1bLua` signature are
 * eligible — extension-based classification alone never claims bytecode.
 *
 * Bounded scan (MAX_SCAN_BYTECODE_ENTRIES entries) so a pathological container
 * cannot turn the preflight into an O(N) snapshot storm.
 */
const MAX_SCAN_BYTECODE_ENTRIES = 40;

async function findFirstBytecodeEntry(
  containerPath: string,
  allowedRoot: string,
  entries: Array<{ name: string; index: number; contentHash: string; id: number }>
): Promise<{ entry: { name: string; index: number; contentHash: string; id: number }; bytes: Buffer } | undefined> {
  const sourceUri = `file://${containerPath.replace(/\\/g, '/')}`;
  for (const entry of entries.slice(0, MAX_SCAN_BYTECODE_ENTRIES)) {
    const ext = entry.name.split('.').pop()?.toLowerCase();
    if (ext !== 'lua' && ext !== 'hks') continue;
    const snapshot = await runBridge<{ contentBase64?: string }>({
      command: 'snapshot-bnd4-child',
      filePath: containerPath,
      resourceUri: sourceUri,
      allowedRoots: [allowedRoot],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: entry.index }
    });
    if (!snapshot.data?.contentBase64) continue;
    const bytes = Buffer.from(snapshot.data.contentBase64, 'base64');
    if (isHavokScriptBytecode([...bytes.subarray(0, 6)])) {
      return { entry, bytes };
    }
  }
  return undefined;
}

/**
 * Fail-closed load-prerequisite validation for a script container at its
 * game-mod path. Verifies what can be proven without launching the game:
 *   - container re-reads as a BND4 with a sane entry count;
 *   - at least one inner script entry carries the `\x1bLua` compiled-bytecode
 *     magic (a script container with no surviving bytecode is not loadable);
 *   - that bytecode entry's real header bytes still pass the magic check.
 * Any anomaly returns an error diagnostic; callers must not downgrade it.
 */
async function validateContainerLoadPrerequisites(
  containerPath: string,
  allowedRoot: string
): Promise<{
  ok: boolean;
  diagnostics: StructuredDiagnostic[];
  entryCount?: number;
  replacedMagicOk?: boolean;
  bytecodeEntryName?: string;
}> {
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceUri = `file://${containerPath.replace(/\\/g, '/')}`;

  const read = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: containerPath,
    resourceUri: sourceUri,
    allowedRoots: [allowedRoot],
    timeoutMs: 60_000
  });
  if (read.parseStatus === 'failed' || !read.data?.nested) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONTAINER_UNREADABLE',
      message: `脚本容器重读失败：${read.diagnostics.map((d) => d.message).join('; ')}`,
      targetUri: sourceUri
    }));
    return { ok: false, diagnostics };
  }
  const entryCount = read.data.nested.entryCount;
  if (entryCount <= 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_EMPTY_CONTAINER',
      message: `脚本容器条目数为 ${entryCount}，结构异常，不能按脚本容器加载。`,
      targetUri: sourceUri
    }));
    return { ok: false, diagnostics };
  }

  const found = await findFirstBytecodeEntry(containerPath, allowedRoot, read.data.nested.entries);
  if (!found) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_NO_BYTECODE_ENTRY',
      message: `脚本容器前 ${MAX_SCAN_BYTECODE_ENTRIES} 个脚本条目中没有任何条目保留 \x1bLua 编译字节码 magic，容器不能按脚本容器加载。`,
      targetUri: sourceUri
    }));
    return { ok: false, diagnostics, entryCount };
  }

  const magicCheck = checkReplacedEntryMagic(
    basenameOf(found.entry.name),
    [...found.bytes.subarray(0, 32)]
  );
  diagnostics.push(...magicCheck.diagnostics);
  return {
    ok: magicCheck.ok && diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    entryCount,
    replacedMagicOk: magicCheck.ok,
    bytecodeEntryName: basenameOf(found.entry.name)
  };
}

/* ------------------------------------------------------------------ */
/*  Leg 2 — write-chain preflight on a real luabnd (temp overlay)     */
/* ------------------------------------------------------------------ */

const LUA_SCRIPT_CONTAINER_NAME = 'aicommon.luabnd.dcx';
const LUA_SCRIPT_CONTAINER_MOD_RELATIVE = `script/${LUA_SCRIPT_CONTAINER_NAME}`;
const LUA_SCRIPT_CONTAINER_GAME_RELATIVE = `mods/${LUA_SCRIPT_CONTAINER_MOD_RELATIVE}`;

async function runWriteChainPreflight(source: string): Promise<void> {
  await withSmokeWorkspace('script-game-load', async (workspace) => {
    // The overlay mirrors the real mod layout: `<gameRoot>/mods/script/<file>`.
    const modRoot = join(workspace.root, 'mods');
    const scriptDir = join(modRoot, 'script');
    await mkdir(scriptDir, { recursive: true });
    const target = join(scriptDir, LUA_SCRIPT_CONTAINER_NAME);
    await copyFile(source, target);
    const original = await readFile(target);
    const expectedHash = sha256(original);
    const session = await openWorkspaceSession({ overlayRoot: modRoot, game: 'sekiro' });
    const store = new MemoryOperationLogStore();
    const targetUri = `file://${LUA_SCRIPT_CONTAINER_MOD_RELATIVE}`;

    const baseline = await runBridge<DcxEnvelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [modRoot],
      timeoutMs: 60_000
    });
    requireFieldPreservation('luabnd game-load baseline', baseline.data);
    if (!baseline.data?.nested) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_BASELINE_MISSING',
        message: 'luabnd baseline 缺失。'
      }));
    }
    // The first inner entry of the real Sekiro luabnd is a plain-text list file
    // (goal_list.lua); a game-load preflight must target a real compiled
    // bytecode entry instead, or the magic-preservation check would reject the
    // container's legitimate text entries.
    const bytecode = await findFirstBytecodeEntry(target, modRoot, baseline.data.nested.entries);
    if (!bytecode) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_BASELINE_NO_BYTECODE',
        message: `luabnd baseline 前 ${MAX_SCAN_BYTECODE_ENTRIES} 个脚本条目中无 \x1bLua 编译字节码条目。`
      }));
    }
    const first = bytecode.entry;

    // Kept-as-is replacement ("保持原样"): the entry's own bytes. SoulForge
    // never generates bytecode, and only a load-preserving byte source is
    // eligible for the automated game-load preflight leg.
    const originalInner = await runBridge<{ contentBase64?: string }>({
      command: 'snapshot-bnd4-child',
      filePath: target,
      allowedRoots: [modRoot],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: first.index }
    });
    if (!originalInner.data?.contentBase64) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_BASELINE_SNAPSHOT_FAILED',
        message: `首条目 ${basenameOf(first.name)} 快照失败：${originalInner.diagnostics.map((d) => d.message).join('; ')}`
      }));
    }
    const replacement = Buffer.from(originalInner.data.contentBase64, 'base64');

    const patch = createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: '游戏加载预检：真实 luabnd 整内层保持原样替换（kept-as-is）',
      author: 'user',
      operations: [{
        id: 'game-load-inner-replace',
        kind: 'container_child_replace',
        targetUri,
        targetPath: target,
        resourceKind: 'other',
        containerUri: targetUri,
        childPath: first.name,
        childContentBase64: replacement.toString('base64'),
        expectedContainerHash: expectedHash,
        expectedHash,
        expectedChildHash: first.contentHash,
        containerFormat: 'BND4_DFLT',
        preconditions: [{
          type: 'content_hash',
          description: '容器哈希必须匹配',
          expectedHash,
          targetUri
        }],
        validatorRequirements: [
          { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
          { validatorId: 'file_risk', scope: 'before_staging', required: true }
        ],
        riskLevel: 'high',
        metadata: {
          nativeFormatAuthority: true,
          nativeEntryIndex: first.index,
          nativeEntryId: first.id,
          requiresConfirmation: true,
          confirmationReceiptId: 'script-game-load-preflight'
        }
      }]
    });

    const committed = await executePatchIrThroughTransaction(patch, {
      session,
      operationLog: store,
      backupBaseDir: join(workspace.root, 'backups')
    });
    if (!committed.operation || committed.changedFiles.length !== 1) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_REPLACE_COMMIT_FAILED',
        message: `整内层文件替换提交失败：${JSON.stringify(committed.diagnostics)}`
      }));
    }

    // Re-read the replaced container: entry count unchanged, unknown fields
    // preserved, kept-as-is content hash unchanged.
    const after = await runBridge<DcxEnvelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [modRoot],
      timeoutMs: 60_000
    });
    requireFieldPreservation('luabnd game-load after replace', after.data);
    if (after.data?.nested?.entryCount !== baseline.data.nested.entryCount) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_ENTRY_COUNT_CHANGED',
        message: `整内层替换后条目数由 ${baseline.data.nested.entryCount} 变为 ${after.data?.nested?.entryCount}，容器结构异常。`
      }));
    }
    // Re-read the replaced container and locate the replaced bytecode entry by
    // its stable index (not by position — the entry table order must hold).
    const replacedEntry = after.data?.nested?.entries.find((e) => e.index === first.index);
    if (!replacedEntry) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_ENTRY_MISSING_AFTER_REPLACE',
        message: `整内层替换重读后找不到索引 ${first.index} 的替换条目。`
      }));
    }
    if (replacedEntry.contentHash !== first.contentHash) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_KEPT_AS_IS_CHANGED',
        message: `保持原样的替换改变了内层条目内容（${basenameOf(first.name)}），写出链路非无损。`
      }));
    }

    // Load-prerequisite magic check against the actual replaced bytes.
    const afterInner = await runBridge<{ contentBase64?: string }>({
      command: 'snapshot-bnd4-child',
      filePath: target,
      allowedRoots: [modRoot],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: replacedEntry.index }
    });
    if (!afterInner.data?.contentBase64) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_REPLACED_SNAPSHOT_FAILED',
        message: `替换后条目 ${basenameOf(replacedEntry.name)} 快照失败：${afterInner.diagnostics.map((d) => d.message).join('; ')}`
      }));
    }
    const afterBytes = Buffer.from(afterInner.data.contentBase64, 'base64');
    if (afterBytes.length !== replacement.length) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_REPLACEMENT_LENGTH_CHANGED',
        message: `替换后条目长度由 ${replacement.length} 变为 ${afterBytes.length}，整内层替换契约被破坏。`
      }));
    }
    const magicCheck = checkReplacedEntryMagic(basenameOf(replacedEntry.name), [...afterBytes.subarray(0, 32)]);
    if (!magicCheck.ok) throw new StructuredError(magicCheck.diagnostics[0]!);

    // Placement: the staged output must land where the game reads it.
    const modRelative = relative(modRoot, target).replace(/\\/g, '/');
    if (modRelative !== LUA_SCRIPT_CONTAINER_MOD_RELATIVE) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_PLACEMENT_MISMATCH',
        message: `替换产物放位错误：期望 mod 相对路径 ${LUA_SCRIPT_CONTAINER_MOD_RELATIVE}，实际 ${modRelative}。`
      }));
    }
    const gameRelative = `mods/${modRelative}`;
    if (gameRelative !== LUA_SCRIPT_CONTAINER_GAME_RELATIVE) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_PLACEMENT_MISMATCH',
        message: `替换产物游戏路径错误：期望 ${LUA_SCRIPT_CONTAINER_GAME_RELATIVE}，实际 ${gameRelative}。`
      }));
    }

    // Rollback restores the overlay to byte-identical original.
    const rolled = await rollbackOperation({
      opId: committed.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
        riskLevel: 'high',
        note: 'script container game-load preflight'
      }),
      backupBaseDir: join(workspace.root, 'backups')
    });
    if (!rolled.ok || !(await readFile(target)).equals(original)) {
      throw new StructuredError(createDiagnostic({
        severity: 'error',
        code: 'SCRIPT_LOAD_PREFLIGHT_ROLLBACK_FAILED',
        message: `游戏加载预检回滚失败：${JSON.stringify(rolled.diagnostics)}`
      }));
    }

    console.log(JSON.stringify({
      ok: true,
      message: '游戏加载前置预检通过：真实 luabnd 整内层保持原样替换 → Bridge 重读 → 结构/放位/magic 前置 → 回滚字节一致',
      synthetic: 'passed',
      preflight: 'passed',
      realLoad: 'skipped',
      validationUnfrozen: true,
      authority: 'candidate',
      containerEntries: baseline.data.nested.entryCount,
      replacedEntry: basenameOf(replacedEntry.name),
      replacedMagicPreserved: true,
      entryCountUnchanged: true,
      unknownFieldsPreserved: true,
      placementGamePath: gameRelative,
      realLoadInstructions: '要在真实游戏内确认：通过桌面 script 面板（或手动）把整内层替换产物放入 <SOULFORGE_SEKIRO_GAME_ROOT>/mods/script/aicommon.luabnd.dcx，启动游戏确认能读到脚本阶段不崩溃，再设 SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED=<ISO时间戳> 重跑本套件。'
    }, null, 2));
  });
}

/* ------------------------------------------------------------------ */
/*  Leg 3 — real-load confirmation against the live mod container     */
/* ------------------------------------------------------------------ */

async function runLiveContainerConfirmation(): Promise<{ confirmedAt: string; message: string }> {
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
  const confirmation = process.env.SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED?.trim() || '';
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || '';
  if (!gameRoot || !confirmation) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_ENV_MISMATCH',
      message: '真实加载确认需要 SOULFORGE_SEKIRO_GAME_ROOT 与 SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED=<ISO时间戳>；缺少时确认不可记录。'
    }));
  }
  if (!registryPath) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_REGISTRY_MISSING',
      message: '真实加载确认需要 SOULFORGE_NATIVE_FIXTURE_REGISTRY 以核对原始样本哈希。'
    }));
  }

  // Pristine fixture hash, read from the registry directly — the live file is
  // expected to differ from it, so resolveNativeFixture (which fail-closes on
  // mismatch) is the wrong tool here.
  let registry: { fixtures?: Array<{ testRole?: string; sha256?: string }> };
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8')) as typeof registry;
  } catch (error) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_REGISTRY_INVALID',
      message: `原生 fixture registry 不可读：${error instanceof Error ? error.message : String(error)}`
    }));
  }
  const fixture = registry.fixtures?.find((f) => f.testRole === 'luabnd-primary');
  if (!fixture || typeof fixture.sha256 !== 'string') {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_PRistine_MISSING',
      message: 'registry 缺少 luabnd-primary 样本哈希，无法核对 live 替换产物。'
    }));
  }

  const gameRootResolved = resolve(gameRoot);
  const livePath = resolve(gameRootResolved, LUA_SCRIPT_CONTAINER_GAME_RELATIVE);
  const liveRel = relative(gameRootResolved, livePath);
  if (liveRel.startsWith('..') || isAbsolute(liveRel)) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_LIVE_OUTSIDE_GAME_ROOT',
      message: `live 容器路径越出游戏根：${livePath}。`
    }));
  }

  let liveBytes: Buffer;
  try {
    liveBytes = await readFile(livePath);
  } catch (error) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_LIVE_FILE_MISSING',
      message: `live ${LUA_SCRIPT_CONTAINER_GAME_RELATIVE} 不可读（${error instanceof Error ? error.message : String(error)}）；请先放置整内层替换产物。`
    }));
  }

  if (sha256(liveBytes) === fixture.sha256.toLowerCase()) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_NO_REPLACEMENT',
      message: `SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED 已设置，但 live ${LUA_SCRIPT_CONTAINER_GAME_RELATIVE} 与登记的原生样本哈希一致——替换产物未放置，游戏内确认不成立（fail-closed）。`
    }));
  }

  // The live file is a real replacement; it must still satisfy every load
  // prerequisite that can be proven without launching the game.
  const preflight = await validateContainerLoadPrerequisites(livePath, gameRootResolved);
  if (!preflight.ok || preflight.entryCount === undefined) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_CONFIRM_LIVE_PREFLIGHT_FAILED',
      message: `live 替换产物未通过加载前置预检：${preflight.diagnostics.map((d) => d.message).join('; ')}`
    }));
  }

  return {
    confirmedAt: confirmation,
    message: `游戏内加载已由用户确认（${confirmation}）：live ${LUA_SCRIPT_CONTAINER_GAME_RELATIVE} 与原始样本哈希不同（真实替换在位）且通过容器重读/条目/magic 加载前置预检`
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  runSyntheticMagicChecks();

  const explicitPath = process.argv[2]?.trim();
  const registryConfigured = Boolean(
    process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
      && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  );
  const confirmation = process.env.SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED?.trim() || '';

  if (!explicitPath && !registryConfigured) {
    console.log(JSON.stringify({
      ok: true,
      message: '未注入原生 fixture 环境（无 SOULFORGE_NATIVE_FIXTURE_REGISTRY/ROOT）：preflight 与 real-load 结构化跳过；synthetic 负向证明已执行',
      synthetic: 'passed',
      skipped: true,
      authority: 'candidate'
    }));
    return;
  }

  if (confirmation) {
    // Real-load confirmation run: the user already replaced the live file, so
    // the pristine sample is gone; write-chain preflight cannot re-run. The
    // live replaced container carries the load-prerequisite preflight instead.
    const result = await runLiveContainerConfirmation();
    console.log(JSON.stringify({
      ok: true,
      message: result.message,
      synthetic: 'passed',
      preflight: 'passed',
      realLoad: 'confirmed',
      confirmedAt: result.confirmedAt,
      validationUnfrozen: true,
      authority: 'candidate'
    }, null, 2));
    return;
  }

  // Preflight run against the pristine fixture (write chain + placement +
  // structure + magic prerequisites). Real-load stays an honest skip.
  let source: string;
  try {
    source = await resolveNativeFixture(
      explicitPath,
      'luabnd-primary',
      '../../mods/script/aicommon.luabnd.dcx'
    );
  } catch (error) {
    throw new StructuredError(createDiagnostic({
      severity: 'error',
      code: 'SCRIPT_LOAD_PRISTINE_FIXTURE_UNAVAILABLE',
      message: `无法解析原始 luabnd 样本（${error instanceof Error ? error.message : String(error)}）。若你已在真实 mods/script 放置替换产物，请改用真实加载确认：设 SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED=<ISO时间戳> 重跑。`
    }));
  }
  await runWriteChainPreflight(source);
}

main().catch(async (error) => {
  try {
    await disposeBridgeDaemonPool();
  } catch {
    // 清理失败不得掩盖主结论。
  }
  if (error instanceof StructuredError) {
    console.error(JSON.stringify({
      ok: false,
      diagnostics: [error.diagnostic]
    }, null, 2));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
