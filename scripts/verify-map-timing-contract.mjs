import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runDotnet = join(ROOT, 'scripts', 'run-dotnet.mjs');
const collectorPath = resolve(ROOT, 'bridge/SoulForge.Bridge/MapTimingTelemetry.cs');
const [collectorSource, hostSource, serviceSource, geometrySource, mapSource, helperSource] = await Promise.all([
  readFile(collectorPath, 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/BridgeDaemonHost.cs', import.meta.url), 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/BridgeCommandService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/MapStaticGeometryService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/ipc/map.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/mapTimingTelemetry.ts', import.meta.url), 'utf8')
]);

for (const key of [
  'diagnosticTimings',
  'queueWaitMs',
  'fileReadMs',
  'sourceHashMs',
  'sessionLookupMs',
  'bndResolveMs',
  'flverReadMs',
  'sessionCreateMs',
  'resourceAcquireMs',
  'textureResolveManyMs',
  'buildChunkMs',
  'serializeMs',
  'schemaVersion',
  'unit',
  'phaseCounts',
  'unavailablePhases'
]) {
  assert.match(collectorSource, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `计时 collector 缺少 ${key}`);
}
assert.match(hostSource, /MapTimingCollector\.TryCreate/);
assert.match(hostSource, /MAP_NATIVE_TIMINGS/);
assert.match(geometrySource, /using \(mapTiming\?\.Measure\("resourceAcquireMs"\)\)/);
assert.match(mapSource, /SF_MAP_NATIVE_TIMING/);
assert.match(mapSource, /MAP_NATIVE_TIMING_CODE/);
assert.match(mapSource, /MAP_NATIVE_TIMING_SUMMARY_CODE/);
assert.match(helperSource, /MAP_NATIVE_TIMING_PHASES = new Set/);
assert.match(helperSource, /MAP_NATIVE_TIMING_TOP_LIMIT = 16/);
assert.doesNotMatch(helperSource, /phase\.endsWith\('Ms'\)/, 'main aggregation must use fixed phase allowlist');

function runChecked(args, options = {}) {
  const result = spawnSync(process.execPath, [runDotnet, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  if (result.error || result.status !== 0) {
    throw new Error(`run-dotnet ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`);
  }
  return result.stdout.trim();
}

const CSHARP_HARNESS = String.raw`
using System.Diagnostics;
using System.Text.Json;

static class Program
{
    static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    static JsonElement Snapshot(MapTimingCollector collector)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot()));
        return document.RootElement.Clone();
    }

    static int Main()
    {
        Require(MapTimingCollector.TryCreate("read-map-static-geometry", default, Stopwatch.GetTimestamp()) is null,
            "default options must keep timings disabled");
        using var disabledDocument = JsonDocument.Parse("{\"diagnosticTimings\":false}");
        Require(MapTimingCollector.TryCreate("read-map-static-geometry", disabledDocument.RootElement.Clone(), Stopwatch.GetTimestamp()) is null,
            "false diagnosticTimings must keep timings disabled");
        using var enabledDocument = JsonDocument.Parse("{\"diagnosticTimings\":true}");
        var collector = MapTimingCollector.TryCreate(
            "read-map-static-geometry",
            enabledDocument.RootElement.Clone(),
            Stopwatch.GetTimestamp()) ?? throw new InvalidOperationException("enabled collector missing");

        for (var index = 0; index < 20; index++)
        {
            using var unknown = collector.Measure("unknownPhaseMs");
        }
        using (collector.Measure("fileReadMs")) Thread.Sleep(2);
        var firstFileReadMs = Snapshot(collector).GetProperty("fileReadMs").GetDouble();
        using (collector.Measure("fileReadMs")) Thread.Sleep(2);
        var secondFileReadMs = Snapshot(collector).GetProperty("fileReadMs").GetDouble();
        Require(secondFileReadMs > firstFileReadMs, "repeated phase duration must accumulate rather than overwrite");
        using (collector.Measure("resourceAcquireMs")) Thread.Sleep(1);
        using (collector.Measure("sourceHashMs")) Thread.Sleep(1);

        var root = Snapshot(collector);
        foreach (var phase in new[] {
            "queueWaitMs", "fileReadMs", "sourceHashMs", "sessionLookupMs", "bndResolveMs",
            "flverReadMs", "sessionCreateMs", "resourceAcquireMs", "textureResolveManyMs",
            "buildChunkMs", "serializeMs", "totalMs"
        })
        {
            Require(root.TryGetProperty(phase, out var value) && (value.ValueKind == JsonValueKind.Number || value.ValueKind == JsonValueKind.Null),
                $"snapshot phase missing: {phase}");
            if (value.ValueKind == JsonValueKind.Number)
                Require(value.GetDouble() >= 0 && double.IsFinite(value.GetDouble()), $"invalid timing: {phase}");
        }
        Require(!root.TryGetProperty("unknownPhaseMs", out _), "unknown phase must not enter snapshot");
        Require(root.GetProperty("resourceAcquireMs").GetDouble() > 0, "resourceAcquireMs missing");
        Require(root.GetProperty("fileReadMs").GetDouble() > 0, "fileReadMs missing");
        Require(root.GetProperty("phaseCounts").GetProperty("fileReadMs").GetInt32() == 2,
            "repeated phase count must accumulate");
        Require(root.GetProperty("unavailablePhases").EnumerateArray().Any(item => item.GetString() == "bndResolveMs"),
            "missing phase must be explicitly unavailable");
        var serialized = JsonSerializer.Serialize(root);
        Require(!serialized.Contains("D:\\private", StringComparison.OrdinalIgnoreCase), "timing must not contain source paths");
        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, fileReadMs = root.GetProperty("fileReadMs").GetDouble() }));
        return 0;
    }
}
`;

function runCollectorConformance() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'soulforge-map-timing-'));
  try {
    const projectPath = join(tempRoot, 'MapTimingContract.csproj');
    const harnessPath = join(tempRoot, 'Program.cs');
    const linkedCollectorPath = collectorPath.replaceAll('\\', '/');
    writeFileSync(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${linkedCollectorPath}" Link="MapTimingTelemetry.cs" />
  </ItemGroup>
</Project>
`, 'utf8');
    writeFileSync(harnessPath, CSHARP_HARNESS, 'utf8');
    runChecked(['restore', projectPath, '--nologo'], { timeout: 180_000 });
    const output = runChecked(['run', '--project', projectPath, '--no-restore', '--nologo'], { timeout: 60_000 });
    const line = output.split(/\r?\n/).findLast((item) => item.trim().startsWith('{'));
    assert.ok(line, 'collector conformance did not return JSON');
    const result = JSON.parse(line);
    assert.equal(result.ok, true);
    assert.ok(result.fileReadMs > 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runTypeScriptAggregationConformance() {
  const helperUrl = pathToFileURL(resolve(ROOT, 'apps/desktop/src/main/mapTimingTelemetry.ts')).href;
  const childSource = String.raw`
import {
  MAP_NATIVE_TIMING_CODE,
  beginMapNativeTimingSession,
  bindNativeTimingSession,
  recordMapNativeTiming,
  timingSessionCountForTest,
  timingAliasCountForTest
} from ${JSON.stringify(helperUrl)};
const diagnostic = (details) => [{ code: MAP_NATIVE_TIMING_CODE, details }];
if (recordMapNativeTiming('off-schema', diagnostic({ schemaVersion: 2, unit: 'ms', fileReadMs: 1 })) !== null) throw new Error('schema drift accepted');
if (recordMapNativeTiming('off-unit', diagnostic({ schemaVersion: 1, unit: 'seconds', fileReadMs: 1 })) !== null) throw new Error('unit drift accepted');
beginMapNativeTimingSession('interleaved-a');
beginMapNativeTimingSession('interleaved-b');
const a = recordMapNativeTiming('interleaved-a', diagnostic({ schemaVersion: 1, unit: 'ms', fileReadMs: 3 }));
const b = recordMapNativeTiming('interleaved-b', diagnostic({ schemaVersion: 1, unit: 'ms', fileReadMs: 7 }));
if (a.details.phases.fileReadMs.totalMs !== 3 || b.details.phases.fileReadMs.totalMs !== 7) throw new Error('interleaved sessions mixed');
beginMapNativeTimingSession('top');
const baseline = recordMapNativeTiming('top', diagnostic({ schemaVersion: 1, unit: 'ms', fileReadMs: 5, sourceHashMs: 6 }));
if (!baseline || baseline.details.phases.fileReadMs.totalMs !== 5 || baseline.details.phases.sourceHashMs.totalMs !== 6) throw new Error('baseline timing missing');
let top;
for (let index = 1; index <= 40; index += 1) {
  top = recordMapNativeTiming('top', diagnostic({ schemaVersion: 1, unit: 'ms', buildChunkMs: index, unknownMs: 999, fileReadMs: Number.NaN, sourceHashMs: Number.POSITIVE_INFINITY, serializeMs: -1 }));
}
if (top.details.phases.buildChunkMs.count !== 40 || top.details.phases.buildChunkMs.topSlowMs.length !== 16 || top.details.phases.buildChunkMs.topSlowMs[0] !== 40) throw new Error('top slow bound failed');
if (top.details.phases.fileReadMs.count !== 1 || top.details.phases.fileReadMs.totalMs !== 5) throw new Error('invalid fileReadMs changed count/total');
if (top.details.phases.sourceHashMs.count !== 1 || top.details.phases.sourceHashMs.totalMs !== 6) throw new Error('invalid sourceHashMs changed count/total');
if (top.details.phases.unknownMs || top.details.phases.serializeMs) throw new Error('unknown/invalid phase accepted');
if (JSON.stringify(top).includes('D:\\\\private')) throw new Error('path leaked');
for (let index = 0; index < 80; index += 1) {
  const key = 'bounded-' + index;
  beginMapNativeTimingSession(key);
  bindNativeTimingSession('token-' + index, key);
}
if (timingSessionCountForTest() > 64 || timingAliasCountForTest() > 64) throw new Error('timing bounds exceeded');
console.log(JSON.stringify({ ok: true, sessionCount: timingSessionCountForTest(), aliasCount: timingAliasCountForTest() }));
`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childSource], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split(/\r?\n/).findLast((item) => item.trim().startsWith('{'));
  assert.ok(line, 'TS aggregation conformance did not return JSON');
  const output = JSON.parse(line);
  assert.equal(output.ok, true);
  assert.ok(output.sessionCount <= 64 && output.aliasCount <= 64);
}

runCollectorConformance();
runTypeScriptAggregationConformance();

console.log(JSON.stringify({
  ok: true,
  contract: 'map-native-timing-opt-in-bounded-summary',
  checks: [
    'production-csharp-collector-default-off',
    'production-csharp-phase-accumulation',
    'production-csharp-unavailable-and-unknown-phase',
    'production-ts-schema-and-finite-validation',
    'production-ts-interleaved-session-isolation',
    'production-ts-top-slow-bounded-16',
    'production-ts-session-and-alias-bounded-64',
    'no-source-paths'
  ]
}, null, 2));
