import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

interface NativeFixtureEntry {
  fixtureId: string;
  localPath: string;
  sha256: string;
  testRole?: string;
}

interface NativeFixtureRegistry {
  schemaVersion: string;
  fixtures: NativeFixtureEntry[];
}

export async function resolveNativeFixture(
  explicitPath: string | undefined,
  testRole: string,
  legacyRelativePath: string
): Promise<string> {
  if (explicitPath?.trim()) return resolve(explicitPath);

  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!registryPath || !fixtureRoot) return resolve(legacyRelativePath);

  let registry: NativeFixtureRegistry;
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8')) as NativeFixtureRegistry;
  } catch (error) {
    throw new Error(
      `NATIVE_FIXTURE_REGISTRY_INVALID: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (registry.schemaVersion !== '1.0.0' || !Array.isArray(registry.fixtures)) {
    throw new Error('NATIVE_FIXTURE_REGISTRY_INVALID: schemaVersion/fixtures 不符合 1.0.0 契约。');
  }

  const matches = registry.fixtures.filter((item) => item.testRole === testRole);
  if (matches.length === 0) {
    throw new Error(`NATIVE_FIXTURE_ROLE_MISSING: registry 中缺少 testRole=${testRole}。`);
  }
  if (matches.length > 1) {
    throw new Error(`NATIVE_FIXTURE_ROLE_AMBIGUOUS: registry 中 testRole=${testRole} 不唯一。`);
  }
  const fixture = matches[0]!;
  if (typeof fixture.fixtureId !== 'string' || !fixture.fixtureId.trim()
    || typeof fixture.localPath !== 'string' || !fixture.localPath.trim()) {
    throw new Error(`NATIVE_FIXTURE_ENTRY_INVALID: testRole=${testRole} 缺少 fixtureId/localPath。`);
  }
  if (!/^[a-f0-9]{64}$/i.test(fixture.sha256)) {
    throw new Error(`NATIVE_FIXTURE_HASH_INVALID: testRole=${testRole} 缺少合法 SHA-256。`);
  }

  const root = await realpath(resolve(fixtureRoot));
  const candidate = isAbsolute(fixture.localPath)
    ? resolve(fixture.localPath)
    : resolve(root, fixture.localPath);
  const path = await realpath(candidate);
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`NATIVE_FIXTURE_OUTSIDE_ROOT: testRole=${testRole} 越出 fixture root。`);
  }

  const actualHash = await sha256File(path);
  if (actualHash !== fixture.sha256.toLowerCase()) {
    throw new Error(`NATIVE_FIXTURE_HASH_MISMATCH: testRole=${testRole} 注册哈希与文件不一致。`);
  }
  return path;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
