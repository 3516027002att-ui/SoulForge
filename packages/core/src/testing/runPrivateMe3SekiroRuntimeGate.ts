import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { TrustedMe3RuntimeAdapter } from '../runtime/trustedMe3RuntimeAdapter.js';

const executablePath = requiredEnvironmentPath('SOULFORGE_ME3_EXECUTABLE');
const overlayRoot = requiredEnvironmentPath('SOULFORGE_SEKIRO_MOD_ROOT');
const applicationDataRoot = optionalEnvironmentPath('SOULFORGE_RUNTIME_GATE_DATA_ROOT')
  ?? resolve(dirname(overlayRoot), '.soulforge-runtime-gate');
const observationMs = parseObservationMs(process.env.SOULFORGE_RUNTIME_GATE_OBSERVE_MS);

async function main(): Promise<void> {
  if (process.env.SOULFORGE_PRIVATE_RUNTIME_GATE !== '1') {
    throw new Error(
      'Refusing to launch a real game without SOULFORGE_PRIVATE_RUNTIME_GATE=1.'
    );
  }
  await access(executablePath);
  await access(overlayRoot);
  await mkdir(applicationDataRoot, { recursive: true });

  const workspace = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const adapter = new TrustedMe3RuntimeAdapter({
    applicationDataRoot,
    executablePath,
    maxOutputBytes: 512 * 1024,
    terminateGraceMs: 10_000
  });
  const capability = await adapter.detect();
  if (capability.status !== 'available') {
    throw new Error(JSON.stringify({ stage: 'detect', capability }, null, 2));
  }

  const profile = await adapter.prepareProfile(workspace, {
    profileName: 'soulforge-private-sekiro-gate'
  });
  const session = await adapter.launch(profile);
  await delay(observationMs);
  const observed = session.snapshot();
  let final = observed;
  if (observed.state === 'starting' || observed.state === 'running') {
    await adapter.terminate(session);
    final = await session.waitForExit();
  }
  const diagnostics = await adapter.collectDiagnostics(session);
  const processGatePassed = final.state === 'terminated'
    || (final.state === 'exited' && final.exitCode === 0);

  process.stdout.write(`${JSON.stringify({
    ok: processGatePassed,
    authority: 'process-evidence-only',
    me3Version: capability.version ?? null,
    observationMs,
    observedState: observed.state,
    finalState: final.state,
    exitCode: final.exitCode ?? null,
    signal: final.signal ?? null,
    diagnostics: diagnostics.diagnostics,
    operatorActionRequired: [
      'Confirm that Sekiro opened.',
      'Confirm that a deliberately changed Mod resource was visible in-game.',
      'Record failure/crash evidence separately; this command never upgrades authority automatically.'
    ],
    nonClaims: [
      'A zero me3 exit code does not prove Sekiro loaded the Mod.',
      'A running process does not prove the expected resource override was active.',
      'This gate does not inspect or commit game assets.'
    ]
  }, null, 2)}\n`);
  if (!processGatePassed) process.exitCode = 1;
}

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the private runtime gate.`);
  if (value.includes('\0')) throw new Error(`${name} contains a NUL byte.`);
  return resolve(value);
}

function optionalEnvironmentPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : undefined;
}

function parseObservationMs(value: string | undefined): number {
  if (!value) return 15_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error('SOULFORGE_RUNTIME_GATE_OBSERVE_MS must be an integer from 1000 to 120000.');
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
