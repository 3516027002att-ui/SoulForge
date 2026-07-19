import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Runtime file lives at packages/core/dist/testing/*.js.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const registryModuleUrl = pathToFileURL(
  resolve(repositoryRoot, 'scripts/native-fixture-registry.mjs')
).href;

const roleByEnvironment = {
  SOULFORGE_NATIVE_FIXTURE_BND4: 'bnd4-primary',
  SOULFORGE_NATIVE_FIXTURE_FMG: 'fmg-primary',
  SOULFORGE_NATIVE_FIXTURE_PARAM: 'param-primary',
  SOULFORGE_NATIVE_FIXTURE_EMEVD: 'emevd-primary',
  SOULFORGE_NATIVE_FIXTURE_MSB: 'msb-primary',
  /** CHRBND/DCX character container used by has-game FLVER nested probe. */
  SOULFORGE_NATIVE_FIXTURE_CHRBND: 'chrbnd-primary'
} as const;

export interface RegisteredNativeFixture {
  absolutePath: string;
  fixtureId: string;
  localPath: string;
  format: string;
  game: 'sekiro';
  testRole?: string;
}

export interface RegisteredNativeFixtureRegistry {
  root: string;
  fixtures: RegisteredNativeFixture[];
  roles: Record<string, RegisteredNativeFixture | undefined>;
}

interface NativeFixtureRegistryModule {
  loadNativeFixtureRegistry(options: {
    registryPath: string;
    fixtureRoot: string;
  }): Promise<RegisteredNativeFixtureRegistry>;
}

export class NativeFixtureResolutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NativeFixtureResolutionError';
  }
}

/**
 * Resolve a native runner input only after the private registry has validated
 * every declared file and its SHA-256. Explicit paths are accepted solely when
 * they identify an already registered fixture (needed by corpus runners).
 */
export async function resolveNativeFixturePath(
  _legacyRelativePath: string,
  argumentIndex = 2,
  registryRoleEnvironment?: keyof typeof roleByEnvironment
): Promise<string> {
  const registry = await loadRegisteredNativeFixtureRegistry();
  const explicitPath = process.argv[argumentIndex]?.trim();
  if (explicitPath) return resolveRegisteredPath(registry, explicitPath);

  if (!registryRoleEnvironment) {
    throw new NativeFixtureResolutionError(
      'NATIVE_FIXTURE_ROLE_REQUIRED',
      'native runner 未声明 registry testRole，不能自动选择输入。'
    );
  }

  const role = roleByEnvironment[registryRoleEnvironment];
  const roleFixture = registry.roles[role];
  if (!roleFixture) {
    throw new NativeFixtureResolutionError(
      'NATIVE_FIXTURE_ROLE_MISSING',
      `native registry 缺少必需 testRole：${role}。`
    );
  }

  const injectedPath = process.env[registryRoleEnvironment]?.trim();
  if (injectedPath) {
    const injectedFixture = await findRegisteredFixture(registry, injectedPath);
    if (injectedFixture.fixtureId !== roleFixture.fixtureId) {
      throw new NativeFixtureResolutionError(
        'NATIVE_FIXTURE_ROLE_PATH_MISMATCH',
        `环境变量 ${registryRoleEnvironment} 未指向其 registry testRole 绑定条目。`
      );
    }
  }
  return roleFixture.absolutePath;
}

export async function loadRegisteredNativeFixtureRegistry(): Promise<RegisteredNativeFixtureRegistry> {
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() ?? '';
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() ?? '';
  if (!fixtureRoot || !registryPath) {
    throw new NativeFixtureResolutionError(
      'NATIVE_FIXTURE_REGISTRY_ENVIRONMENT_REQUIRED',
      'native runner 要求同时设置 SOULFORGE_NATIVE_FIXTURE_ROOT 与 SOULFORGE_NATIVE_FIXTURE_REGISTRY。'
    );
  }
  const module = await import(registryModuleUrl) as NativeFixtureRegistryModule;
  return module.loadNativeFixtureRegistry({ registryPath, fixtureRoot });
}

async function resolveRegisteredPath(
  registry: RegisteredNativeFixtureRegistry,
  input: string
): Promise<string> {
  return (await findRegisteredFixture(registry, input)).absolutePath;
}

async function findRegisteredFixture(
  registry: RegisteredNativeFixtureRegistry,
  input: string
): Promise<RegisteredNativeFixture> {
  let canonicalInput: string;
  try {
    canonicalInput = await realpath(resolve(input));
  } catch {
    throw new NativeFixtureResolutionError(
      'NATIVE_FIXTURE_EXPLICIT_PATH_INVALID',
      '显式 native fixture 不存在或不可访问。'
    );
  }
  const fixture = registry.fixtures.find((candidate) => samePath(candidate.absolutePath, canonicalInput));
  if (!fixture) {
    throw new NativeFixtureResolutionError(
      'NATIVE_FIXTURE_NOT_REGISTERED',
      '显式 native fixture 未绑定到当前 registry 的已校验条目。'
    );
  }
  return fixture;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}
