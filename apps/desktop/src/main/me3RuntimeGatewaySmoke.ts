import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Me3RuntimeAdapter } from '@soulforge/core';
import { MainMe3RuntimeGateway } from './me3RuntimeGateway.js';

const policy = {
  policyId: 'soulforge.me3-v0_12_1',
  supportedVersions: ['0.12.1']
} as const;

const missingRoot = await mkdtemp(join(tmpdir(), 'soulforge-me3-missing-'));
const missing = await new Me3RuntimeAdapter({
  gateway: new MainMe3RuntimeGateway({ localDataRoot: missingRoot }),
  versionPolicy: policy
}).detect({ timeoutMs: 2_000 });
if (missing.state !== 'not-found' || missing.detected || missing.canLaunch) {
  throw new Error('Pinned main gateway did not fail closed for a missing installation.');
}

const appData = process.env.LOCALAPPDATA;
const localDataRoot = appData ? join(appData, 'SoulForge') : join(missingRoot, 'absent');
const detected = await new Me3RuntimeAdapter({
  gateway: new MainMe3RuntimeGateway({ localDataRoot }),
  versionPolicy: policy
}).detect({ timeoutMs: 5_000 });

if (detected.detected) {
  if (detected.state !== 'exit-zero-unverified'
    || detected.detectedVersion !== '0.12.1'
    || !detected.compatible
    || detected.authority !== 'unverified'
    || detected.nativeRuntimeAuthority
    || detected.canPrepareProfile
    || detected.canLaunch) {
    throw new Error('Real pinned me3 probe crossed its detection-only authority boundary.');
  }
} else if (detected.state !== 'not-found') {
  throw new Error(`Unexpected real pinned me3 probe state: ${detected.state}`);
}

const serialized = JSON.stringify(detected);
if (/[A-Za-z]:\\|\\\\|\/Users\/|executablePath|processId|argv|cwd|environment/u.test(serialized)) {
  throw new Error('Renderer-safe me3 capability leaked a privileged process or path value.');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  status: 'fixture-confirmed',
  fixedSource: 'well-known',
  missingState: missing.state,
  localProbeState: detected.state,
  detectedVersion: detected.detectedVersion ?? null,
  realMe3Executed: detected.detected,
  sekiroProcessLifecycleObserved: false,
  authority: detected.authority,
  nativeRuntimeAuthority: detected.nativeRuntimeAuthority
}, null, 2)}\n`);
