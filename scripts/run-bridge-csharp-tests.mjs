import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const cache = join(root, '.local-validation');
const result = spawnSync(process.execPath, [join(root, 'scripts/run-dotnet.mjs'), 'test',
  join(root, 'bridge/SoulForge.Bridge.Tests/SoulForge.Bridge.Tests.csproj'),
  `-p:RuntimeIdentifier=${runtime}`, '-p:SelfContained=false', '-p:PublishSingleFile=false', '--nologo'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DOTNET_CLI_HOME: join(cache, 'dotnet-home'),
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', NUGET_PACKAGES: join(cache, 'nuget'),
    NUGET_HTTP_CACHE_PATH: join(cache, 'nuget-http'), NUGET_PLUGINS_CACHE_PATH: join(cache, 'nuget-plugins') }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
