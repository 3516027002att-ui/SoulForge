import {
  loadNativeFixtureRegistry,
  NativeFixtureRegistryError,
  summarizeNativeFixtureRegistry
} from './native-fixture-registry.mjs';

const registryPath = process.argv[2]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
  ?? '';
const fixtureRoot = process.argv[3]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  ?? '';

try {
  const registry = await loadNativeFixtureRegistry({ registryPath, fixtureRoot });
  console.log(JSON.stringify(summarizeNativeFixtureRegistry(registry), null, 2));
} catch (error) {
  const known = error instanceof NativeFixtureRegistryError;
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code: known ? error.code : 'NATIVE_FIXTURE_REGISTRY_UNEXPECTED',
    message: known ? error.message : 'native fixture registry 校验发生未预期错误。',
    ...(known && error.fixtureId ? { fixtureId: error.fixtureId } : {})
  }, null, 2));
  process.exitCode = known && error.code === 'NATIVE_FIXTURE_REGISTRY_ENVIRONMENT_REQUIRED' ? 2 : 1;
}
