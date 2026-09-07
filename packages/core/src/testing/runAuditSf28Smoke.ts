import { strict as assert } from 'node:assert';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

type Inventory = {
  schemaVersion: number;
  algorithm: string;
  files: Array<{ path: string; size: number; hash: string | null; classification: string }>;
  duplicateGroups: Array<{ paths: string[]; classification: string; byteConfirmed: boolean }>;
  counts: {
    trackedFiles: number;
    exactDuplicateCandidates: number;
    provenRemovable: number;
    actuallyDeleted: number;
    dynamicUnknown: number;
    licenseRequired: number;
  };
  deletionPolicy: string;
};

type InventoryModule = {
  parseGitLsFiles(buffer: Buffer): string[];
  inventoryRedundancy(root: string): Promise<Inventory>;
};

function selectedLayer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-28 requires --layer unit');
  return value;
}

async function main(): Promise<void> {
  const layer = selectedLayer();
  const sourceRoot = resolve(dirnameFromModule(), '..', '..', '..', '..');
  const modulePath = join(sourceRoot, 'scripts', 'audit-execution', 'inventory-redundancy.mjs');
  await access(modulePath);
  const module = await import(pathToFileURL(modulePath).href) as unknown as InventoryModule;

  const parsed = module.parseGitLsFiles(Buffer.from('plain path\0name with space\nline\0\0', 'utf8'));
  assert.deepEqual(parsed, ['plain path', 'name with space\nline'], 'NUL parsing must preserve special filenames');

  const inventory = await module.inventoryRedundancy(sourceRoot);
  assert.equal(inventory.schemaVersion, 1);
  assert(inventory.files.length > 0, 'tracked inventory must not be empty');
  assert(inventory.algorithm.includes('git-ls-files-nul'));
  assert(inventory.deletionPolicy.includes('no file is deleted'));
  assert.equal(inventory.counts.trackedFiles, inventory.files.length);
  assert.equal(inventory.counts.provenRemovable, 0);
  assert.equal(inventory.counts.actuallyDeleted, 0);
  assert(inventory.files.some((file) => file.classification === 'dynamic_unknown'), 'unknown/dynamic references must remain conservative');
  for (const group of inventory.duplicateGroups) {
    assert(group.paths.length > 1);
    assert.equal(group.byteConfirmed, true, 'hash equality requires byte confirmation');
    assert(group.classification === 'exact_duplicate' || group.classification === 'license_required');
  }

  const reportPath = join(sourceRoot, 'docs', 'audit-execution', 'redundancy-inventory.json');
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ...inventory, generatedBy: 'test:audit-sf-28-unit', generatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  const reportExists = await access(reportPath).then(() => true).catch(() => false);
  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-28',
    layer,
    executedCases: 8,
    trackedFiles: inventory.files.length,
    duplicateGroups: inventory.duplicateGroups.length,
    provenRemovable: inventory.counts.provenRemovable,
    actuallyDeleted: inventory.counts.actuallyDeleted,
    reportExists,
    production: ['inventoryRedundancy', 'parseGitLsFiles'],
    note: layer === 'native' ? 'SF-28 has no native required suite; inventory is repository-governance evidence only.' : undefined
  }));
}

function dirnameFromModule(): string {
  return dirname(fileURLToPath(import.meta.url));
}

void main();
