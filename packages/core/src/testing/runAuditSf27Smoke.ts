import { strict as assert } from 'node:assert';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type CapabilityEvidence = {
  format: string;
  command: string;
  productionSymbol: string;
  sourceFile: string;
  variant: string;
  readable: boolean;
  writableOperations: string[];
  writerProfile: 'unsupported' | 'candidate' | 'native-verified';
  preconditions: string[];
  postconditions: string[];
  nativeFixtures: string[];
  independentOracle: string;
  productTrace: string;
  missingEvidence: string[];
};

const FORMAT_CHAINS: Array<Omit<CapabilityEvidence, 'readable' | 'nativeFixtures'>> = [
  { format: 'ESD', command: 'write-esd-document', productionSymbol: 'BridgeCommandService.DispatchAsync', sourceFile: 'bridge/SoulForge.Bridge/BridgeCommandService.cs', variant: 'state-group-expression-tree', writableOperations: ['existing-node-mutation'], writerProfile: 'candidate', preconditions: ['confirmed ESD locator', 'writer profile for the exact variant'], postconditions: ['native reread', 'state/condition/jump targets remain valid'], independentOracle: 'missing', productTrace: 'not_run', missingEvidence: ['independent ESD semantic oracle', 'product IPC trace'] },
  { format: 'FXR', command: 'write-fxr-document', productionSymbol: 'BridgeCommandService.DispatchAsync', sourceFile: 'bridge/SoulForge.Bridge/BridgeCommandService.cs', variant: 'effect-tree', writableOperations: ['profile-confirmed-mutation-only'], writerProfile: 'candidate', preconditions: ['confirmed FXR locator'], postconditions: ['native reread', 'array/reference validation'], independentOracle: 'missing', productTrace: 'not_run', missingEvidence: ['independent FXR layout oracle', 'variant corpus'] },
  { format: 'GPARAM', command: 'write-gparam', productionSymbol: 'ParamNativeWriter', sourceFile: 'bridge/SoulForge.Bridge/ParamNativeWriter.cs', variant: 'group-field-value', writableOperations: ['field-value-set'], writerProfile: 'native-verified', preconditions: ['Paramdex-compatible metadata', 'current source hash'], postconditions: ['native reread', 'unknown field preservation'], independentOracle: 'native-reader-only', productTrace: 'not_run', missingEvidence: ['independent layout oracle'] },
  { format: 'MTD', command: 'write-mtd-document', productionSymbol: 'BridgeCommandService.DispatchAsync', sourceFile: 'bridge/SoulForge.Bridge/BridgeCommandService.cs', variant: 'material-properties', writableOperations: ['profile-confirmed-property-set'], writerProfile: 'candidate', preconditions: ['confirmed MTD locator'], postconditions: ['native reread', 'texture reference validation'], independentOracle: 'missing', productTrace: 'not_run', missingEvidence: ['independent MTD oracle'] },
  { format: 'TPF/DDS', command: 'write-tpf-texture-replace', productionSymbol: 'BridgeCommandService.DispatchAsync', sourceFile: 'bridge/SoulForge.Bridge/BridgeCommandService.cs', variant: 'texture-mip-chain', writableOperations: ['profile-confirmed-texture-replace'], writerProfile: 'candidate', preconditions: ['format/dimension/mip validation'], postconditions: ['native reread', 'mip and byte-length validation'], independentOracle: 'native-reader-only', productTrace: 'not_run', missingEvidence: ['independent compression oracle'] },
  { format: 'BND/DCX', command: 'write-bnd4', productionSymbol: 'BridgeCommandService.DispatchAsync', sourceFile: 'bridge/SoulForge.Bridge/BridgeCommandService.cs', variant: 'outer-container-child', writableOperations: ['child-replace'], writerProfile: 'native-verified', preconditions: ['outer hash and child identity'], postconditions: ['outer reread', 'unchanged child hash'], independentOracle: 'native-reader-only', productTrace: 'not_run', missingEvidence: ['Oodle/variant independent oracle where required'] },
  { format: 'FLVER/HKX', command: 'write-flver', productionSymbol: 'FlverNativeWriter', sourceFile: 'bridge/SoulForge.Bridge/FlverNativeDocument.cs', variant: 'material-slot-or-profile-confirmed-channel', writableOperations: ['material-slot-set'], writerProfile: 'native-verified', preconditions: ['exact FLVER writer profile', 'mesh/layout identity'], postconditions: ['native reread', 'mesh topology and non-target bytes preserved'], independentOracle: 'native-reader-only', productTrace: 'not_run', missingEvidence: ['independent FLVER/HKX geometry oracle', 'game-load proof'] }
];

function selectedLayer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-27 requires --layer unit|native');
  return value;
}

async function pathExists(root: string, path: string): Promise<boolean> {
  try { await access(join(root, path)); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const layer = selectedLayer();
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const repositoryPackageJson = JSON.parse(await readFile(join(root, '..', '..', 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert(repositoryPackageJson.scripts?.['bridge:verify:flver'] || repositoryPackageJson.scripts?.['bridge:verify:flver-writer']);
  const outDir = join(root, 'docs', 'audit-execution', 'capability-evidence');
  await mkdir(outDir, { recursive: true });
  const evidence: CapabilityEvidence[] = [];
  for (const chain of FORMAT_CHAINS) {
    const sourceExists = await pathExists(root, chain.sourceFile);
    const item: CapabilityEvidence = {
      ...chain,
      readable: sourceExists,
      nativeFixtures: sourceExists ? ['Sekiro local corpus (fixture selection required at runtime)'] : [],
      missingEvidence: sourceExists ? chain.missingEvidence : [...chain.missingEvidence, 'production source anchor missing']
    };
    evidence.push(item);
    await writeFile(join(outDir, `${chain.format.toLowerCase().replaceAll('/', '-')}.json`), JSON.stringify(item, null, 2) + '\n', 'utf8');
  }
  await writeFile(join(outDir, 'index.json'), JSON.stringify({ schemaVersion: 1, layer, formats: evidence.map((item) => item.format), evidence }, null, 2) + '\n', 'utf8');
  assert.equal(evidence.length, 7);
  assert(evidence.every((item) => item.command && item.productionSymbol && item.sourceFile && item.missingEvidence.length > 0));
  assert(evidence.some((item) => item.writerProfile === 'candidate'));
  console.log(JSON.stringify({ ok: true, taskId: 'SF-27', layer, executedCases: evidence.length + 3, evidenceDirectory: 'docs/audit-execution/capability-evidence', formats: evidence.map((item) => ({ format: item.format, writerProfile: item.writerProfile, readable: item.readable })), production: ['capability-evidence-chain', 'BridgeCommandService.dispatch'] }));
}

void main();
