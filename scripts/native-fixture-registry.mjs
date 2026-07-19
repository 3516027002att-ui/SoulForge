import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const schemaVersion = '1.0.0';
const maxRegistryBytes = 4 * 1024 * 1024;
const maxFixtures = 20_000;
const fixtureKeys = new Set([
  'fixtureId', 'localPath', 'sha256', 'game', 'format', 'variant',
  'expectedAuthority', 'expectedCapabilities', 'expectedAssertions', 'testRole'
]);
const formats = new Set([
  'DCX-DFLT', 'DCX-KRAK', 'BND4', 'FMG', 'PARAM', 'PARAMDEF', 'EMEVD',
  'MSB', 'FLVER', 'TPF', 'DDS', 'GLTF', 'GLB', 'PNG', 'TGA'
]);
const authorities = new Set(['candidate', 'fixture-confirmed', 'native-verified']);
const capabilities = new Set([
  'inspect', 'parse', 'read', 'roundtrip-byte', 'roundtrip-semantic',
  'write-staging', 'crud', 'reorder', 'convert', 'rollback-operation',
  'rollback-resource-entry', 'game-smoke'
]);
const roles = new Set([
  'bnd4-primary', 'fmg-primary', 'param-primary', 'emevd-primary', 'msb-primary',
  'chrbnd-primary'
]);

export class NativeFixtureRegistryError extends Error {
  constructor(code, message, fixtureId = undefined) {
    super(message);
    this.name = 'NativeFixtureRegistryError';
    this.code = code;
    this.fixtureId = fixtureId;
  }
}

export async function loadNativeFixtureRegistry({ registryPath, fixtureRoot }) {
  if (!registryPath || !fixtureRoot) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_ENVIRONMENT_REQUIRED',
      '私有 native registry 校验要求同时提供 registry 文件和 fixture root。'
    );
  }
  const canonicalRoot = await safeRoot(fixtureRoot);
  const canonicalRegistry = await safeRegistryFile(registryPath);
  let registryBytes;
  try {
    registryBytes = await readFile(canonicalRegistry);
  } catch {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_READ_FAILED',
      'registry 文件在校验期间不可读取。'
    );
  }
  if (registryBytes.length <= 0 || registryBytes.length > maxRegistryBytes) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_SIZE_INVALID',
      `registry 大小必须在 1..${maxRegistryBytes} 字节范围内。`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(registryBytes.toString('utf8'));
  } catch (error) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_JSON_INVALID',
      `registry 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    );
  }
  validateRegistryShape(parsed);

  const seenIds = new Set();
  const seenRoles = new Set();
  const resolvedFixtures = [];
  for (const entry of parsed.fixtures) {
    validateFixtureShape(entry);
    const idKey = entry.fixtureId.toLowerCase();
    if (seenIds.has(idKey)) {
      throw fixtureError('NATIVE_FIXTURE_ID_DUPLICATE', 'fixtureId 必须忽略大小写后唯一。', entry);
    }
    seenIds.add(idKey);
    if (entry.testRole) {
      if (seenRoles.has(entry.testRole)) {
        throw fixtureError('NATIVE_FIXTURE_ROLE_DUPLICATE', '每个 testRole 只能绑定一个 fixture。', entry);
      }
      seenRoles.add(entry.testRole);
    }

    const absolutePath = await resolveFixtureFile(canonicalRoot, entry.localPath, entry.fixtureId);
    const actualSha256 = await sha256File(absolutePath, entry.fixtureId);
    if (actualSha256 !== entry.sha256) {
      throw fixtureError('NATIVE_FIXTURE_HASH_MISMATCH', 'fixture SHA-256 与 registry 不一致。', entry);
    }
    resolvedFixtures.push({ ...entry, absolutePath, actualSha256 });
  }

  return {
    schemaVersion: parsed.schemaVersion,
    root: canonicalRoot,
    fixtures: resolvedFixtures,
    roles: Object.fromEntries(
      resolvedFixtures.filter((fixture) => fixture.testRole).map((fixture) => [fixture.testRole, fixture])
    )
  };
}

export function summarizeNativeFixtureRegistry(registry, fixtureLimit = 200) {
  const boundedLimit = Math.max(0, Math.min(fixtureLimit, 1000));
  const registryDigest = createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: registry.schemaVersion,
      fixtures: registry.fixtures
        .map((fixture) => ({
          fixtureId: fixture.fixtureId,
          localPath: fixture.localPath,
          sha256: fixture.actualSha256,
          game: fixture.game,
          format: fixture.format,
          variant: fixture.variant,
          expectedAuthority: fixture.expectedAuthority,
          expectedCapabilities: [...fixture.expectedCapabilities].sort(),
          expectedAssertions: [...fixture.expectedAssertions].sort(),
          testRole: fixture.testRole ?? null
        }))
        .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId, 'en'))
    }))
    .digest('hex');
  return {
    ok: true,
    status: 'passed',
    schemaVersion: registry.schemaVersion,
    registryDigest,
    fixtureCount: registry.fixtures.length,
    fixtures: registry.fixtures.slice(0, boundedLimit).map((fixture) => ({
      fixtureId: fixture.fixtureId,
      sha256: fixture.actualSha256,
      variant: fixture.variant,
      assertions: fixture.expectedAssertions
    })),
    fixturesTruncated: registry.fixtures.length > boundedLimit
  };
}

function validateRegistryShape(value) {
  if (!isPlainObject(value)) {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_REGISTRY_SHAPE_INVALID', 'registry 根必须是对象。');
  }
  rejectUnknownKeys(value, new Set(['schemaVersion', 'fixtures']), 'registry 根');
  if (value.schemaVersion !== schemaVersion) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_VERSION_UNSUPPORTED',
      `registry schemaVersion 必须为 ${schemaVersion}。`
    );
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length < 1 || value.fixtures.length > maxFixtures) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_COUNT_INVALID',
      `fixtures 数量必须在 1..${maxFixtures} 范围内。`
    );
  }
}

function validateFixtureShape(entry) {
  if (!isPlainObject(entry)) {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_ENTRY_INVALID', 'fixture 条目必须是对象。');
  }
  rejectUnknownKeys(entry, fixtureKeys, 'fixture 条目');
  const id = entry.fixtureId;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(id)) {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_ID_INVALID', 'fixtureId 格式无效。');
  }
  if (typeof entry.localPath !== 'string' || !isSafeRelativePath(entry.localPath)) {
    throw fixtureError('NATIVE_FIXTURE_LOCAL_PATH_INVALID', 'localPath 必须是安全的正斜杠相对路径。', entry);
  }
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw fixtureError('NATIVE_FIXTURE_HASH_INVALID', 'sha256 必须是 64 位小写十六进制。', entry);
  }
  if (entry.game !== 'sekiro') {
    throw fixtureError('NATIVE_FIXTURE_GAME_UNSUPPORTED', 'V0.5 registry 的 game 必须是 sekiro。', entry);
  }
  if (!formats.has(entry.format)) {
    throw fixtureError('NATIVE_FIXTURE_FORMAT_UNSUPPORTED', 'fixture format 不在 V0.5 白名单。', entry);
  }
  if (typeof entry.variant !== 'string' || entry.variant.length < 1
    || entry.variant.length > 128 || /[\r\n]/.test(entry.variant)) {
    throw fixtureError('NATIVE_FIXTURE_VARIANT_INVALID', 'variant 必须是 1..128 字符的单行文本。', entry);
  }
  if (!authorities.has(entry.expectedAuthority)) {
    throw fixtureError('NATIVE_FIXTURE_AUTHORITY_INVALID', 'expectedAuthority 无效。', entry);
  }
  validateStringSet(entry.expectedCapabilities, capabilities, 'expectedCapabilities', entry);
  if (!Array.isArray(entry.expectedAssertions) || entry.expectedAssertions.length < 1
    || new Set(entry.expectedAssertions).size !== entry.expectedAssertions.length
    || entry.expectedAssertions.some((value) => typeof value !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value))) {
    throw fixtureError('NATIVE_FIXTURE_ASSERTIONS_INVALID', 'expectedAssertions 必须是非空、唯一的稳定标识数组。', entry);
  }
  if (entry.testRole !== undefined && !roles.has(entry.testRole)) {
    throw fixtureError('NATIVE_FIXTURE_ROLE_INVALID', 'testRole 无效。', entry);
  }
}

async function safeRoot(input) {
  const lexical = resolve(input);
  let stat;
  try {
    stat = await lstat(lexical);
  } catch {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_ROOT_UNSAFE', 'fixture root 不存在或不可访问。');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_ROOT_UNSAFE', 'fixture root 必须是真实目录且不能是符号链接。');
  }
  try {
    return await realpath(lexical);
  } catch {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_ROOT_UNSAFE', 'fixture root 在校验期间不可访问。');
  }
}

async function safeRegistryFile(input) {
  const lexical = resolve(input);
  let stat;
  try {
    stat = await lstat(lexical);
  } catch {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_REGISTRY_UNSAFE', 'registry 文件不存在或不可访问。');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NativeFixtureRegistryError('NATIVE_FIXTURE_REGISTRY_UNSAFE', 'registry 必须是真实普通文件且不能是符号链接。');
  }
  try {
    return await realpath(lexical);
  } catch {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_UNSAFE',
      'registry 文件在校验期间不可访问。'
    );
  }
}

async function resolveFixtureFile(root, localPath, fixtureId) {
  const lexical = resolve(root, ...localPath.split('/'));
  let canonical;
  let stat;
  try {
    const lexicalStat = await lstat(lexical);
    if (lexicalStat.isSymbolicLink()) throw new Error('symlink');
    canonical = await realpath(lexical);
    stat = await lstat(canonical);
  } catch {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_FILE_UNSAFE',
      'fixture 文件不存在、不可访问或经过符号链接。',
      fixtureId
    );
  }
  const rel = relative(root, canonical);
  if (!stat.isFile() || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_FILE_OUTSIDE_ROOT',
      'fixture 文件必须是 root 内的真实普通文件。',
      fixtureId
    );
  }
  return canonical;
}

async function sha256File(path, fixtureId) {
  const hash = createHash('sha256');
  try {
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolvePromise);
    });
  } catch {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_FILE_READ_FAILED',
      'fixture 文件在 hash 校验期间不可读取。',
      fixtureId
    );
  }
  return hash.digest('hex');
}

function isSafeRelativePath(value) {
  if (value.length < 1 || value.length > 1024 || value.includes('\\')
    || value.includes('\0') || value.includes(':') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateStringSet(value, allowed, field, entry) {
  if (!Array.isArray(value) || value.length < 1 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    throw fixtureError('NATIVE_FIXTURE_CAPABILITIES_INVALID', `${field} 含无效或重复值。`, entry);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_REGISTRY_UNKNOWN_FIELD',
      `${label} 含未知字段：${unknown.join(', ')}。`
    );
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureError(code, message, entry) {
  return new NativeFixtureRegistryError(code, message, entry.fixtureId);
}
