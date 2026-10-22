import { rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const cache = join(root, '.local-validation');
// The tests build the referenced Bridge framework-dependent. Without an explicit output the Bridge build counts as
// a canonical build and is promoted over bin/Debug/<tfm>/<rid>/, which then fails with "No frameworks were found".
// A run-owned output keeps the canonical self-contained Bridge untouched; it is cleared so no earlier run leaks in.
// The trailing slash matters: -o becomes a global OutputPath that MSBuild cannot normalise, and the csproj appends
// "." to it, so without the slash the native build writes "...tests." and cannot find its own output.
const output = join(cache, 'bridge-csharp-tests');
rmSync(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [join(root, 'scripts/run-dotnet.mjs'), 'test',
  join(root, 'bridge/SoulForge.Bridge.Tests/SoulForge.Bridge.Tests.csproj'),
  `-p:RuntimeIdentifier=${runtime}`, '-p:SelfContained=false', '-p:PublishSingleFile=false', '-o', `${output}/`, '--nologo'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DOTNET_CLI_HOME: join(cache, 'dotnet-home'), DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', NUGET_PACKAGES: join(cache, 'nuget'),
    NUGET_HTTP_CACHE_PATH: join(cache, 'nuget-http'), NUGET_PLUGINS_CACHE_PATH: join(cache, 'nuget-plugins') }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
