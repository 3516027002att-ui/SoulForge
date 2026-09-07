import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseGitLsFiles(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function classify(path) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = basename(normalized);
  if (/(^|\/)(dist|out|build|artifacts)\//u.test(normalized)) return 'generated_artifact';
  if (/(license|copying|notice)(\.|$)/u.test(name)) return 'license_required';
  if (/(^|\/)(test|tests|__tests__)\//u.test(normalized) || /\.(test|spec)\.[^.]+$/u.test(name)) return 'test_only';
  if (/(adapter|compat|legacy)/u.test(name)) return 'compatibility_adapter';
  if (/\.(json|md|ts|tsx|js|mjs|cs|py|css|html|yml|yaml)$/u.test(name)) return 'dynamic_unknown';
  return 'dynamic_unknown';
}

export async function inventoryRedundancy(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const listed = parseGitLsFiles(execFileSync('git', ['ls-files', '-z'], { cwd: absoluteRoot }));
  const files = [];
  const bySize = new Map();
  for (const relativePath of listed) {
    const fullPath = resolve(absoluteRoot, relativePath);
    const info = await stat(fullPath);
    if (!info.isFile()) continue;
    const item = { path: relativePath.replaceAll('\\', '/'), size: info.size, classification: classify(relativePath), hash: null, referencedBy: [], evidence: [] };
    files.push(item);
    const bucket = bySize.get(info.size) ?? [];
    bucket.push(item);
    bySize.set(info.size, bucket);
  }
  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue;
    const byHash = new Map();
    for (const item of bucket) {
      item.hash = await sha256(resolve(absoluteRoot, item.path));
      const sameHash = byHash.get(item.hash) ?? [];
      sameHash.push(item);
      byHash.set(item.hash, sameHash);
    }
  }
  const duplicateGroups = [];
  for (const bucket of bySize.values()) {
    const groups = new Map();
    for (const item of bucket.filter((candidate) => candidate.hash)) {
      const group = groups.get(item.hash) ?? [];
      group.push(item);
      groups.set(item.hash, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const canonical = await readFile(resolve(absoluteRoot, group[0].path));
      const confirmed = [];
      for (const item of group) {
        const bytes = await readFile(resolve(absoluteRoot, item.path));
        if (Buffer.compare(canonical, bytes) === 0) confirmed.push(item);
      }
      if (confirmed.length > 1) duplicateGroups.push({ hash: confirmed[0].hash, paths: confirmed.map((item) => item.path), classification: confirmed.some((item) => item.classification === 'license_required') ? 'license_required' : 'exact_duplicate', byteConfirmed: true });
    }
  }
  return {
    schemaVersion: 1,
    root: absoluteRoot,
    algorithm: 'git-ls-files-nul -> size buckets -> sha256 equal-size candidates -> byte-for-byte confirmation before exact_duplicate classification',
    files,
    duplicateGroups,
    counts: {
      trackedFiles: files.length,
      exactDuplicateCandidates: duplicateGroups.filter((group) => group.classification === 'exact_duplicate').length,
      provenRemovable: 0,
      actuallyDeleted: 0,
      dynamicUnknown: files.filter((item) => item.classification === 'dynamic_unknown').length,
      licenseRequired: files.filter((item) => item.classification === 'license_required').length
    },
    deletionPolicy: 'read-only inventory; no file is deleted and no dynamic_unknown item is marked dead'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd();
  console.log(JSON.stringify(await inventoryRedundancy(root)));
}
