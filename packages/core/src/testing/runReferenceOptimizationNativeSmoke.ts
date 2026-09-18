/**
 * Reference-optimization native smoke.
 *
 * Contract:
 * - If Bridge/native env is unavailable → structured
 *   { ok:false, code:'NATIVE_ENV_BLOCKED', missing:[...] } and process.exitCode=2.
 *   Do NOT pretend pass.
 * - When env is present, exercise temp overlay copies only (never live game mods).
 * - Synthetic path still fails closed if proof/writer APIs are missing.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixtureNativePorts } from './referenceOptimizationFixtures.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

type DynamicModule = Record<string, unknown>;

async function loadModule(specifier: string): Promise<DynamicModule | null> {
  try {
    return (await import(specifier)) as DynamicModule;
  } catch {
    return null;
  }
}

interface NativeEnvProbe {
  available: boolean;
  missing: string[];
  notes: string[];
}

function probeNativeEnv(): NativeEnvProbe {
  const missing: string[] = [];
  const notes: string[] = [];

  const bridgeCandidates = [
    process.env.SOULFORGE_BRIDGE_EXECUTABLE,
    process.env.SOULFORGE_BRIDGE_EXE,
    resolve(process.cwd(), 'SoulForge.Bridge.exe'),
    resolve(process.cwd(), 'bridge/SoulForge.Bridge/bin/Release/net8.0/win-x64/SoulForge.Bridge.exe')
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');

  const bridgePath = bridgeCandidates.find((candidate) => existsSync(candidate));
  if (!bridgePath) {
    missing.push('SoulForge.Bridge.exe');
    notes.push('未找到 Bridge 可执行文件（SOULFORGE_BRIDGE_EXECUTABLE / SOULFORGE_BRIDGE_EXE / 仓库根 SoulForge.Bridge.exe）');
  }

  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!gameRoot) {
    missing.push('SOULFORGE_SEKIRO_GAME_ROOT|SOULFORGE_NATIVE_FIXTURE_ROOT');
    notes.push('未配置原生语料环境变量；本 smoke 不得把缺环境当成通过');
  } else if (!existsSync(resolve(gameRoot))) {
    missing.push(resolve(gameRoot));
    notes.push(`语料根不存在: ${gameRoot}`);
  } else {
    const modsDir = join(resolve(gameRoot), existsSync(join(resolve(gameRoot), 'mods')) ? 'mods' : '');
    if (modsDir && !existsSync(modsDir)) {
      notes.push(`语料根存在但无 mods 子目录: ${gameRoot}`);
    }
  }

  return {
    available: missing.length === 0,
    missing,
    notes
  };
}

function emitBlocked(probe: NativeEnvProbe): void {
  const syntheticNotes = checks.filter((c) => c.name.startsWith('synthetic_') || c.name.startsWith('fixture_'));
  console.log(JSON.stringify({
    ok: false,
    code: 'NATIVE_ENV_BLOCKED',
    missing: probe.missing,
    notes: probe.notes,
    syntheticChecks: syntheticNotes,
    message: 'Native/Bridge environment unavailable; refusing to claim native optimization authority.',
    hint: '配置 SOULFORGE_BRIDGE_EXECUTABLE 与 SOULFORGE_SEKIRO_GAME_ROOT（或 SOULFORGE_NATIVE_FIXTURE_ROOT）后重跑。写入仅允许临时 overlay 副本。'
  }, null, 2));
  process.exitCode = 2;
}

/**
 * Synthetic fail-closed path: even without native corpus, proof/writer APIs
 * must exist. Missing APIs → fail closed (exit 1), never green.
 */
async function runSyntheticFailClosedPath(): Promise<void> {
  const ports = createFixtureNativePorts();
  const proofMod = await loadModule('../editing/nativeReadProofStore.js');
  const cacheMod = await loadModule('../runtime/nativeSnapshotCache.js');
  const versionMod = await loadModule('../runtime/resourceVersion.js');

  const missing: string[] = [];
  if (!proofMod || typeof proofMod.NativeReadProofStore !== 'function') {
    missing.push('NativeReadProofStore');
  }
  if (!proofMod || typeof proofMod.buildWriteRequirement !== 'function') {
    missing.push('buildWriteRequirement');
  }
  if (!cacheMod || typeof cacheMod.createNativeSnapshotCache !== 'function') {
    missing.push('createNativeSnapshotCache');
  }
  if (!versionMod || typeof versionMod.createResourceVersion !== 'function') {
    missing.push('createResourceVersion');
  }
  // Writer surface: production PARAM commit + host write-proof gate.
  const writerMod = await loadModule('../editing/paramBridgeCommit.js');
  const paramEditMod = await loadModule('../param/containerParamEdit.js');
  const toolRegistryMod = await loadModule('../ai/toolRegistry.js');
  const hasWriterApi = Boolean(
    writerMod
    && (typeof writerMod.commitParamMutationsViaBridge === 'function'
      || typeof writerMod.readParamDocumentViaBridge === 'function')
  );
  const hasParamEditApi = Boolean(paramEditMod && typeof paramEditMod.setParamFields === 'function');
  const hasToolWriteBoundary = Boolean(
    toolRegistryMod
    && (typeof toolRegistryMod.createDefaultToolRegistry === 'function'
      || typeof toolRegistryMod.createToolRegistry === 'function')
  );
  if (!hasWriterApi && !hasParamEditApi) {
    missing.push('param_writer_proof_api');
  }
  if (!hasToolWriteBoundary) {
    missing.push('tool_registry_write_boundary');
  }
  // Host proof API is already required above; writer+registry complete the boundary.

  record(
    'synthetic_proof_and_writer_apis_present',
    missing.length === 0,
    missing.length === 0 ? 'proof/writer APIs loaded' : `missing=${missing.join(',')}`
  );

  // Port-owned counter sanity (no production hand-count).
  await ports.providerPorts.readParamFields({ table: 'FixtureNpcParam', rowIds: [1], fieldIds: ['hp'] });
  record(
    'fixture_port_counters_live_on_port',
    ports.counters.paramFieldReadCount === 1,
    JSON.stringify(ports.counters)
  );

  if (missing.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      code: 'behavior_not_implemented',
      missing,
      checks,
      message: `behavior_not_implemented: ${missing.join(', ')}`,
      ports: ports.counters
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  // APIs present + env present → still only overlay copies (documented; no live mods write).
  console.log(JSON.stringify({
    ok: true,
    code: 'SYNTHETIC_PATH_API_SURFACE_OK',
    checks,
    ports: ports.counters,
    note: 'Synthetic path only confirms API surface + fail-closed wiring. Native overlay exercise requires Bridge env; live game mods are never written by this smoke.'
  }, null, 2));
}

/**
 * When native env is present this would exercise temp overlay copies only.
 * Currently implemented as a structured readiness report — no live writes.
 */
function runNativeOverlayReadiness(probe: NativeEnvProbe): void {
  record('native_env_available_for_overlay', probe.available, JSON.stringify(probe));
  console.log(JSON.stringify({
    ok: true,
    code: 'NATIVE_ENV_PRESENT_OVERLAY_DEFERRED',
    probe,
    checks,
    message: 'Native env detected. Overlay-copy exercise is staged; this smoke does not write live game mods.',
    overlayPolicy: 'temp-overlay-copies-only'
  }, null, 2));
}

export async function runReferenceOptimizationNativeSmoke(): Promise<void> {
  const probe = probeNativeEnv();

  // Synthetic fail-closed API surface checks always run first.
  const syntheticExitBefore = process.exitCode;
  await runSyntheticFailClosedPath();
  const syntheticFailed = process.exitCode === 1;
  if (syntheticExitBefore !== 1 && process.exitCode === 1) {
    // keep synthetic failure visible
  }

  if (!probe.available) {
    // Environment blocked is the honesty gate for the native layer: exit 2.
    // Do not pretend pass. Include synthetic findings for diagnosis.
    process.exitCode = 2;
    emitBlocked(probe);
    return;
  }

  if (syntheticFailed) {
    // Env present but proof/writer APIs missing → already reported fail-closed.
    return;
  }

  runNativeOverlayReadiness(probe);
  if (checks.some((c) => !c.ok)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReferenceOptimizationNativeSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
