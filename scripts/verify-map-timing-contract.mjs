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
const characterCollectorPath = resolve(ROOT, 'bridge/SoulForge.Bridge/CharacterTimingTelemetry.cs');
const transportCollectorPath = resolve(ROOT, 'packages/core/src/bridge/bridgeTransportTiming.ts');
const runBridgeSourcePath = resolve(ROOT, 'packages/core/src/bridge/runBridge.ts');
const [collectorSource, characterCollectorSource, transportCollectorSource, runBridgeSource, hostSource, serviceSource, geometrySource, mapSource, helperSource, characterHelperSource, characterAggregateSource, characterMainAggregateSource, transportAggregateSource, productionBuildSource] = await Promise.all([
  readFile(collectorPath, 'utf8'),
  readFile(characterCollectorPath, 'utf8'),
  readFile(transportCollectorPath, 'utf8'),
  readFile(runBridgeSourcePath, 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/BridgeDaemonHost.cs', import.meta.url), 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/BridgeCommandService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../bridge/SoulForge.Bridge/MapStaticGeometryService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/ipc/map.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/mapTimingTelemetry.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/desktop/src/main/characterTimingTelemetry.ts', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/character-native-timing-aggregate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/character-main-timing-aggregate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/bridge-transport-timing-aggregate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/agent-production-build-lib.mjs', import.meta.url), 'utf8')
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
for (const key of [
  'BRIDGE_TRANSPORT_TIMING_CODE',
  'createBridgeTransportTimingCollector',
  'poolAcquireMs',
  'daemonRequestMs',
  'artifactRequestMs',
  'base64DecodeMs',
  'concatJsonParseMs',
  'materializeTotalMs',
  'return materializeFileBackedResult'
]) assert.match(runBridgeSource, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `runBridge transport wiring missing ${key}`);
for (const key of [
  'BRIDGE_TRANSPORT_TIMING_CODE',
  'metricKinds',
  'artifactRequestCount',
  'markArtifactExpected',
  'recordArtifactRequest'
]) assert.match(transportCollectorSource, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `transport collector missing ${key}`);
for (const key of [
  'CharacterTimingCollector.TryCreate',
  'CHARACTER_NATIVE_TIMINGS',
  'characterTiming'
]) assert.match(hostSource, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `daemon role timing wiring missing ${key}`);
for (const key of [
  'resolveFlverLeavesMs',
  'flverReadMs',
  'texturePackageResolveMs',
  'texturePreviewMs',
  'materialResolveMs',
  'buildOutputMs'
]) assert.match(characterCollectorSource, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `character collector missing ${key}`);
assert.match(serviceSource, /characterTiming\?\.Measure\("resolveFlverLeavesMs"\)/);
assert.match(serviceSource, /characterTiming\?\.Measure\("texturePackageResolveMs"\)/);
assert.match(serviceSource, /characterTiming\?\.Measure\("texturePreviewMs"\)/);
assert.match(serviceSource, /characterTiming\?\.Measure\("materialResolveMs"\)/);
assert.match(serviceSource, /characterTiming\?\.Measure\("buildOutputMs"\)/);
assert.match(geometrySource, /using \(mapTiming\?\.Measure\("resourceAcquireMs"\)\)/);
assert.match(mapSource, /SF_MAP_NATIVE_TIMING/);
assert.match(mapSource, /MAP_NATIVE_TIMING_CODE/);
assert.match(mapSource, /MAP_NATIVE_TIMING_SUMMARY_CODE/);
assert.match(mapSource, /CHARACTER_NATIVE_TIMING_CODE/);
assert.match(mapSource, /summarizeCharacterNativeTiming/);
assert.match(mapSource, /createCharacterMainTimingCollector/);
assert.match(mapSource, /BRIDGE_TRANSPORT_TIMING_CODE/);
assert.match(mapSource, /item\.code !== BRIDGE_TRANSPORT_TIMING_CODE/);
assert.match(mapSource, /optionsPrepareMs/);
assert.match(mapSource, /bridgeAwaitMs/);
assert.match(mapSource, /pageFirstMs/);
assert.match(mapSource, /diagnosticTimings: true/);
assert.match(mapSource, /diagnostics: \[\.\.\.responseDiagnostics, \.\.\.compatibilityDiagnostics\]/);
assert.match(helperSource, /MAP_NATIVE_TIMING_PHASES = new Set/);
assert.match(helperSource, /MAP_NATIVE_TIMING_TOP_LIMIT = 16/);
assert.doesNotMatch(helperSource, /phase\.endsWith\('Ms'\)/, 'main aggregation must use fixed phase allowlist');
assert.match(characterHelperSource, /CHARACTER_NATIVE_TIMING_SUMMARY_CODE/);
assert.match(characterHelperSource, /texturePreviewMs/);
assert.match(characterAggregateSource, /nativeRequestCount/);
assert.match(characterAggregateSource, /characterMainWallTotalMs/);
assert.match(characterMainAggregateSource, /CHARACTER_MAIN_TIMING_PHASES/);
assert.match(characterMainAggregateSource, /phaseCoverage/);
assert.match(characterMainAggregateSource, /validateCharacterMainTimingSummary/);
assert.match(characterMainAggregateSource, /validateBridgeTransportTimingSummary/);
assert.match(characterMainAggregateSource, /snapshotBridgeTransportTimingAccumulator/);
assert.match(transportAggregateSource, /recordBridgeTransportTimingCall/);
assert.match(productionBuildSource, /scripts\/character-native-timing-aggregate\.mjs/,
  'production snapshot must carry the character timing aggregate helper');
assert.match(productionBuildSource, /scripts\/character-main-timing-aggregate\.mjs/,
  'production snapshot must carry the character main timing aggregate helper');
assert.match(productionBuildSource, /scripts\/bridge-transport-timing-aggregate\.mjs/,
  'production snapshot must carry the Bridge transport timing aggregate helper');

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

    static JsonElement Snapshot(CharacterTimingCollector collector)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(collector.Snapshot()));
        return document.RootElement.Clone();
    }

    static int Main()
    {
        Require(MapTimingCollector.TryCreate("read-map-static-geometry", default, Stopwatch.GetTimestamp()) is null,
            "default options must keep timings disabled");
        Require(CharacterTimingCollector.TryCreate("read-chrbnd-flver-preview", default, Stopwatch.GetTimestamp()) is null,
            "character default options must keep timings disabled");
        using var disabledDocument = JsonDocument.Parse("{\"diagnosticTimings\":false}");
        Require(MapTimingCollector.TryCreate("read-map-static-geometry", disabledDocument.RootElement.Clone(), Stopwatch.GetTimestamp()) is null,
            "false diagnosticTimings must keep timings disabled");
        Require(CharacterTimingCollector.TryCreate("read-chrbnd-flver-preview", disabledDocument.RootElement.Clone(), Stopwatch.GetTimestamp()) is null,
            "character false diagnosticTimings must keep timings disabled");
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
        var character = CharacterTimingCollector.TryCreate(
            "read-chrbnd-flver-preview",
            enabledDocument.RootElement.Clone(),
            Stopwatch.GetTimestamp()) ?? throw new InvalidOperationException("enabled character collector missing");
        foreach (var phase in new[] {
            "resolveFlverLeavesMs", "flverReadMs", "texturePackageResolveMs",
            "texturePreviewMs", "materialResolveMs", "buildOutputMs"
        })
        {
            using (character.Measure(phase)) Thread.Sleep(1);
        }
        using (character.Measure("unknownPhaseMs")) Thread.Sleep(1);
        var characterRoot = Snapshot(character);
        foreach (var phase in new[] {
            "queueWaitMs", "resolveFlverLeavesMs", "flverReadMs", "texturePackageResolveMs",
            "texturePreviewMs", "materialResolveMs", "buildOutputMs", "totalMs"
        })
        {
            Require(characterRoot.TryGetProperty(phase, out var value)
                && (value.ValueKind == JsonValueKind.Number || value.ValueKind == JsonValueKind.Null),
                $"character snapshot phase missing: {phase}");
            if (value.ValueKind == JsonValueKind.Number)
                Require(value.GetDouble() >= 0 && double.IsFinite(value.GetDouble()), $"invalid character timing: {phase}");
        }
        Require(!characterRoot.TryGetProperty("unknownPhaseMs", out _), "unknown character phase must not enter snapshot");
        Require(characterRoot.GetProperty("phaseCounts").GetProperty("texturePreviewMs").GetInt32() == 1,
            "character texturePreviewMs count missing");
        Require(!JsonSerializer.Serialize(characterRoot).Contains("D:\\private", StringComparison.OrdinalIgnoreCase),
            "character timing must not contain source paths");
        Console.WriteLine(JsonSerializer.Serialize(new {
            ok = true,
            fileReadMs = root.GetProperty("fileReadMs").GetDouble(),
            characterTexturePreviewMs = characterRoot.GetProperty("texturePreviewMs").GetDouble()
        }));
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
    <Compile Include="${characterCollectorPath.replaceAll('\\', '/')}" Link="CharacterTimingTelemetry.cs" />
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
  const characterHelperUrl = pathToFileURL(resolve(ROOT, 'apps/desktop/src/main/characterTimingTelemetry.ts')).href;
  const characterMainHelperUrl = pathToFileURL(resolve(ROOT, 'apps/desktop/src/main/characterMainTimingTelemetry.ts')).href;
  const transportCollectorUrl = pathToFileURL(resolve(ROOT, 'packages/core/src/bridge/bridgeTransportTiming.ts')).href;
  const characterAggregateUrl = pathToFileURL(resolve(ROOT, 'scripts/character-native-timing-aggregate.mjs')).href;
  const characterMainAggregateUrl = pathToFileURL(resolve(ROOT, 'scripts/character-main-timing-aggregate.mjs')).href;
  const transportAggregateUrl = pathToFileURL(resolve(ROOT, 'scripts/bridge-transport-timing-aggregate.mjs')).href;
  const childSource = String.raw`
import {
  MAP_NATIVE_TIMING_CODE,
  beginMapNativeTimingSession,
  bindNativeTimingSession,
  recordMapNativeTiming,
  timingSessionCountForTest,
  timingAliasCountForTest
} from ${JSON.stringify(helperUrl)};
import {
  CHARACTER_NATIVE_TIMING_CODE,
  summarizeCharacterNativeTiming
} from ${JSON.stringify(characterHelperUrl)};
import {
  createCharacterMainTimingCollector
} from ${JSON.stringify(characterMainHelperUrl)};
import {
  createBridgeTransportTimingCollector
} from ${JSON.stringify(transportCollectorUrl)};
import {
  createCharacterNativeTimingAccumulator,
  recordCharacterNativeTimingCall,
  snapshotCharacterNativeTimingAccumulator,
  validateCharacterNativeTimingSummary
} from ${JSON.stringify(characterAggregateUrl)};
import {
  createCharacterMainTimingAccumulator,
  recordCharacterMainTimingCall,
  snapshotCharacterMainTimingAccumulator,
  validateCharacterMainTimingSummary
} from ${JSON.stringify(characterMainAggregateUrl)};
import {
  validateBridgeTransportTimingSummary
} from ${JSON.stringify(transportAggregateUrl)};
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

const characterDiagnostic = (details) => [{ code: CHARACTER_NATIVE_TIMING_CODE, details }];
const characterDetails = {
  schemaVersion: 1,
  unit: 'ms',
  queueWaitMs: 2,
  resolveFlverLeavesMs: 10,
  flverReadMs: 12,
  texturePackageResolveMs: 8,
  texturePreviewMs: 14,
  materialResolveMs: 18,
  buildOutputMs: 20,
  totalMs: 84,
  // A phase can cover multiple native scopes while the diagnostic itself is
  // one request sample. The converter must preserve that distinction.
  phaseCounts: {
    resolveFlverLeavesMs: 2,
    flverReadMs: 3,
    texturePackageResolveMs: 2,
    texturePreviewMs: 4,
    materialResolveMs: 5,
    buildOutputMs: 6
  },
  unavailablePhases: []
};
const characterSummary = summarizeCharacterNativeTiming(characterDiagnostic(characterDetails));
if (!characterSummary?.details || characterSummary.details.requestCount !== 1) {
  throw new Error('character timing summary missing');
}
if (characterSummary.details.phases.resolveFlverLeavesMs.count !== 1
  || characterSummary.details.phases.resolveFlverLeavesMs.scopeCount !== 2
  || characterSummary.details.phases.buildOutputMs.scopeCount !== 6) {
  throw new Error('character scopeCount/sample count distinction lost');
}
const characterAccumulator = createCharacterNativeTimingAccumulator();
const characterRecorded = recordCharacterNativeTimingCall(
  characterAccumulator,
  'direct',
  characterSummary.details,
  123
);
const characterSnapshot = snapshotCharacterNativeTimingAccumulator(characterAccumulator);
if (!characterRecorded.accepted
  || characterSnapshot.buckets.direct.nativeRequestCount !== 1
  || characterSnapshot.buckets.direct.nativeTotalMs !== 84
  || characterSnapshot.buckets.direct.mainWallMs.totalMs !== 123
  || characterSnapshot.buckets.direct.phases.resolveFlverLeavesMs.count !== 1
  || characterSnapshot.buckets.direct.phases.resolveFlverLeavesMs.scopeCount !== 2) {
  throw new Error('character aggregate roundtrip failed');
}
if (!validateCharacterNativeTimingSummary(characterSummary.details).ok) {
  throw new Error('character aggregate validator rejected converter output');
}

const transportCollector = createBridgeTransportTimingCollector();
const poolScope = transportCollector.begin('poolAcquireMs');
transportCollector.end(poolScope);
const daemonScope = transportCollector.begin('daemonRequestMs');
transportCollector.end(daemonScope);
transportCollector.markArtifactExpected();
const materializeScope = transportCollector.begin('materializeTotalMs');
for (let index = 0; index < 3; index += 1) {
  const artifactScope = transportCollector.begin('artifactRequestMs');
  transportCollector.end(artifactScope);
  transportCollector.recordArtifactRequest();
  const decodeScope = transportCollector.begin('base64DecodeMs');
  transportCollector.end(decodeScope);
}
const concatScope = transportCollector.begin('concatJsonParseMs');
transportCollector.end(concatScope);
transportCollector.end(materializeScope);
const transportSummary = transportCollector.finish('ok');
if (!validateBridgeTransportTimingSummary(transportSummary).ok
  || transportSummary.metrics.artifactRequestCount.status !== 'measured'
  || transportSummary.metrics.artifactRequestCount.value !== 3
  || transportSummary.metrics.artifactRequestMs.status !== 'measured'
  || transportSummary.metrics.base64DecodeMs.status !== 'measured'
  || transportSummary.metrics.materializeTotalMs.status !== 'measured'
  || transportSummary.metrics.artifactRequestMs.value === null
  || transportSummary.metrics.base64DecodeMs.value === null) {
  throw new Error('transport nested/repeated timing summary invalid');
}
if (JSON.stringify(transportSummary).toLowerCase().includes('token')
  || JSON.stringify(transportSummary).toLowerCase().includes('private')) {
  throw new Error('transport timing leaked token or path');
}
const noArtifactCollector = createBridgeTransportTimingCollector();
const noArtifactPool = noArtifactCollector.begin('poolAcquireMs');
noArtifactCollector.end(noArtifactPool);
const noArtifactDaemon = noArtifactCollector.begin('daemonRequestMs');
noArtifactCollector.end(noArtifactDaemon);
const noArtifactSummary = noArtifactCollector.finish('ok');
if (noArtifactSummary.metrics.artifactRequestCount.status !== 'skipped'
  || noArtifactSummary.metrics.artifactRequestCount.value !== null
  || noArtifactSummary.metrics.materializeTotalMs.status !== 'skipped'
  || noArtifactSummary.metrics.materializeTotalMs.value !== null) {
  throw new Error('non-file-backed timing did not remain skipped/unavailable');
}
const cancelledCollector = createBridgeTransportTimingCollector();
const cancelledPool = cancelledCollector.begin('poolAcquireMs');
cancelledCollector.end(cancelledPool);
cancelledCollector.begin('daemonRequestMs');
const cancelledSummary = cancelledCollector.finish('cancelled');
if (cancelledSummary.metrics.daemonRequestMs.status !== 'unavailable'
  || cancelledSummary.metrics.daemonRequestMs.value !== null
  || cancelledSummary.metrics.totalMs.status !== 'measured') {
  throw new Error('cancelled timing did not carry unavailable daemon phase');
}

const mainCollector = createCharacterMainTimingCollector();
for (const phase of ['optionsPrepareMs', 'bridgeAwaitMs', 'bundleValidateMs', 'chunkBuildMs', 'pageFirstMs']) {
  const scope = mainCollector.begin(phase);
  mainCollector.end(scope);
}
mainCollector.skip('compatibilityMs');
const mainSummary = mainCollector.finish('ok', transportSummary);
if (mainSummary.details.requestCount !== 1
  || mainSummary.details.phaseStatus.compatibilityMs !== 'skipped'
  || mainSummary.details.phases.totalMs.count !== 1
  || mainSummary.details.phases.compatibilityMs.count !== 0
  || !mainSummary.details.transport) {
  throw new Error('main character timing collector summary invalid');
}
const mainAccumulator = createCharacterMainTimingAccumulator();
const mainRecorded = recordCharacterMainTimingCall(mainAccumulator, 'ui-load', mainSummary.details, 144);
const mainSnapshot = snapshotCharacterMainTimingAccumulator(mainAccumulator);
if (!mainRecorded.accepted
  || !validateCharacterMainTimingSummary(mainSummary.details).ok
  || mainSnapshot.buckets['ui-load'].requestCount !== 1
  || mainSnapshot.buckets['ui-load'].phases.totalMs.count !== 1
  || mainSnapshot.buckets['ui-load'].phaseCoverage.compatibilityMs.skippedSummaryCount !== 1
  || mainSnapshot.buckets['ui-load'].mainWallMs.totalMs !== 144
  || mainSnapshot.buckets['ui-load'].transport.summarySeenCount !== 1
  || mainSnapshot.buckets['ui-load'].transport.invalidSummaryCount !== 0
  || mainSnapshot.buckets['ui-load'].transport.metrics.artifactRequestCount.total !== 3
  || mainSnapshot.buckets['ui-load'].transport.metrics.artifactRequestCount.measuredCount !== 1) {
  throw new Error('main character timing aggregate roundtrip failed');
}
const earlyMainCollector = createCharacterMainTimingCollector();
const earlyMainSummary = earlyMainCollector.finish('failed');
if (earlyMainSummary.details.phaseStatus.optionsPrepareMs !== 'unavailable'
  || earlyMainSummary.details.phaseStatus.totalMs !== 'measured'
  || !validateCharacterMainTimingSummary(earlyMainSummary.details).ok) {
  throw new Error('early main character timing failure coverage invalid');
}
const characterMalformed = [
  { ...characterDetails, schemaVersion: 2 },
  { ...characterDetails, unit: 'seconds' },
  { ...characterDetails, totalMs: null },
  { ...characterDetails, phaseCounts: { ...characterDetails.phaseCounts, unknownMs: 1 } },
  { ...characterDetails, texturePreviewMs: Number.NaN },
  { ...characterDetails, materialResolveMs: -1 },
  { ...characterDetails, unavailablePhases: ['texturePreviewMs'] },
  { ...characterDetails, phases: {} }
];
// phases is not a raw Bridge field; this case deliberately exercises an
// empty raw object after removing all phase values and counts.
delete characterMalformed.at(-1).queueWaitMs;
delete characterMalformed.at(-1).resolveFlverLeavesMs;
delete characterMalformed.at(-1).flverReadMs;
delete characterMalformed.at(-1).texturePackageResolveMs;
delete characterMalformed.at(-1).texturePreviewMs;
delete characterMalformed.at(-1).materialResolveMs;
delete characterMalformed.at(-1).buildOutputMs;
delete characterMalformed.at(-1).totalMs;
delete characterMalformed.at(-1).phaseCounts;
delete characterMalformed.at(-1).phases;
const characterMalformedResults = characterMalformed.map((details) =>
  summarizeCharacterNativeTiming(characterDiagnostic(details))
);
if (characterMalformedResults.some((summary) => summary !== null)) {
  throw new Error('malformed character timing accepted');
}
console.log(JSON.stringify({
  ok: true,
  sessionCount: timingSessionCountForTest(),
  aliasCount: timingAliasCountForTest(),
  character: {
    requestCount: characterSummary.details.requestCount,
    resolveFlverLeavesScopeCount: characterSummary.details.phases.resolveFlverLeavesMs.scopeCount,
    buildOutputScopeCount: characterSummary.details.phases.buildOutputMs.scopeCount,
    nativeTotalMs: characterSnapshot.buckets.direct.nativeTotalMs,
    mainWallMs: characterSnapshot.buckets.direct.mainWallMs.totalMs,
    malformedRejected: characterMalformedResults.filter((summary) => summary === null).length
  },
  characterMain: {
    requestCount: mainSnapshot.buckets['ui-load'].requestCount,
    totalCount: mainSnapshot.buckets['ui-load'].phases.totalMs.count,
    compatibilitySkipped: mainSnapshot.buckets['ui-load'].phaseCoverage.compatibilityMs.skippedSummaryCount,
    earlyFailureUnavailable: earlyMainSummary.details.unavailablePhases.length
  }
}));
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
  assert.equal(output.character?.requestCount, 1);
  assert.equal(output.character?.resolveFlverLeavesScopeCount, 2);
  assert.equal(output.character?.buildOutputScopeCount, 6);
  assert.equal(output.character?.nativeTotalMs, 84);
  assert.equal(output.character?.mainWallMs, 123);
  assert.equal(output.character?.malformedRejected, 8);
  assert.equal(output.characterMain?.requestCount, 1);
  assert.equal(output.characterMain?.totalCount, 1);
  assert.equal(output.characterMain?.compatibilitySkipped, 1);
  assert.equal(output.characterMain?.earlyFailureUnavailable, 6);
}

function runBridgeTransportRuntimeConformance() {
  const build = spawnSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    '-b',
    'packages/shared',
    'packages/core',
    '--pretty',
    'false'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  });
  assert.equal(build.status, 0, `${build.stdout ?? ''}\n${build.stderr ?? ''}\n${build.error?.message ?? ''}`);

  const tempRoot = mkdtempSync(join(tmpdir(), 'soulforge-bridge-transport-'));
  try {
    const daemonEntryPath = join(tempRoot, 'daemon');
    const childPath = join(tempRoot, 'transport-runtime-check.mjs');
    const filePath = join(tempRoot, 'fixture.mapbnd.dcx');
    const runBridgeUrl = pathToFileURL(resolve(ROOT, 'packages/core/dist/bridge/runBridge.js')).href;
    const transportCodeUrl = pathToFileURL(resolve(ROOT, 'packages/core/dist/bridge/bridgeTransportTiming.js')).href;
    const daemonSource = String.raw`
const { createInterface } = require('node:readline');
const PROTOCOL = '1.0.0';
const TOKEN = 'fixture-artifact-token-0001';
const restored = {
  sourceUri: 'file://fixture/mapbnd',
  sourcePath: 'fixture.mapbnd.dcx',
  game: 'sekiro',
  resourceKind: 'map',
  parseStatus: 'parsed',
  diagnostics: [],
  data: { fixture: 'x'.repeat(70000) }
};
const bytes = Buffer.from(JSON.stringify(restored), 'utf8');
const chunkSize = 32768;
function asRecord(value) { return value && typeof value === 'object' ? value : {}; }
function write(kind, request, payload) {
  process.stdout.write(JSON.stringify({
    protocolVersion: PROTOCOL,
    kind,
    requestId: request.requestId,
    ...(request.workspaceSessionId ? { workspaceSessionId: request.workspaceSessionId } : {}),
    payload
  }) + '\n');
}
function resultEnvelope(data, parseStatus = 'parsed', diagnostics = []) {
  return {
    sourceUri: 'file://fixture/mapbnd',
    sourcePath: 'fixture.mapbnd.dcx',
    game: 'sekiro',
    resourceKind: 'map',
    parseStatus,
    diagnostics,
    data
  };
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.kind === 'handshake') {
    write('handshake', frame, { maxFrameBytes: 16 * 1024 * 1024, maxConcurrency: 2, syntheticFixture: true });
    return;
  }
  if (frame.kind === 'cancel') return;
  if (frame.kind !== 'request') return;
  const payload = asRecord(frame.payload);
  const options = asRecord(payload.options);
  if (payload.command === 'read-bridge-artifact') {
    const offset = Number(options.offset);
    const length = Number(options.length);
    const chunk = bytes.subarray(offset, offset + length);
    write('result', frame, {
      authority: 'candidate',
      nativeFormatAuthority: false,
      result: resultEnvelope({
        artifactToken: TOKEN,
        offset,
        length: chunk.length,
        totalLength: bytes.length,
        complete: offset + chunk.length >= bytes.length,
        dataBase64: chunk.toString('base64')
      })
    });
    return;
  }
  if (options.modelName === 'cancel') return;
  if (options.modelName === 'failed') {
    write('result', frame, {
      authority: 'candidate',
      nativeFormatAuthority: false,
      result: resultEnvelope(undefined, 'failed', [{ severity: 'error', code: 'FIXTURE_FAILED', message: 'fixture failure' }])
    });
    return;
  }
  if (options.modelName === 'no-file') {
    write('result', frame, {
      authority: 'candidate',
      nativeFormatAuthority: false,
      result: resultEnvelope({ fixture: 'small' })
    });
    return;
  }
  write('result', frame, {
    authority: 'candidate',
    nativeFormatAuthority: false,
    result: resultEnvelope({
      fileBacked: {
        artifactToken: TOKEN,
        payloadFormat: 'bridge-result-json',
        payloadVersion: 1,
        byteLength: bytes.length,
        chunkSize,
        sourceUri: 'file://fixture/mapbnd',
        sourceRevision: 'fixture-revision'
      }
    }, 'partial', [{
      severity: 'info',
      code: 'BRIDGE_RESULT_FILE_BACKED',
      message: 'fixture file-backed result',
      details: { artifactToken: TOKEN, artifactByteLength: bytes.length, artifactChunkSize: chunkSize }
    }])
  });
});
`;
    writeFileSync(daemonEntryPath, daemonSource, 'utf8');
    const childSource = String.raw`
import { strict as assert } from 'node:assert';
import { runBridge, disposeBridgeDaemonPool } from ${JSON.stringify(runBridgeUrl)};
import { BRIDGE_TRANSPORT_TIMING_CODE } from ${JSON.stringify(transportCodeUrl)};
const common = {
  command: 'read-map-static-geometry',
  filePath: ${JSON.stringify(filePath)},
  allowedRoots: [${JSON.stringify(tempRoot)}],
  bridgeExecutablePath: ${JSON.stringify(process.execPath)},
  cwd: ${JSON.stringify(tempRoot)},
  workspaceSessionId: 'bridge-transport-runtime',
  timeoutMs: 5000
};
try {
  const large = await runBridge({ ...common, commandOptions: { diagnosticTimings: true, modelName: 'large' } });
  const transport = large.diagnostics.find((item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE)?.details;
  assert.ok(transport, 'large result missing transport timing');
  assert.equal(transport.metrics.poolAcquireMs.status, 'measured', JSON.stringify(transport));
  assert.equal(transport.metrics.daemonRequestMs.status, 'measured', JSON.stringify(transport));
  assert.equal(transport.metrics.artifactRequestCount.status, 'measured');
  assert.equal(transport.metrics.artifactRequestCount.value, 3);
  assert.equal(transport.metrics.artifactRequestMs.status, 'measured');
  assert.equal(transport.metrics.base64DecodeMs.status, 'measured');
  assert.equal(transport.metrics.concatJsonParseMs.status, 'measured');
  assert.equal(transport.metrics.materializeTotalMs.status, 'measured');
  assert.equal(transport.metrics.totalMs.status, 'measured');
  assert.equal(large.data.fixture.length, 70000);
  assert.ok(!JSON.stringify(transport).toLowerCase().includes('token'));
  assert.ok(!JSON.stringify(transport).toLowerCase().includes('fixture/mapbnd'));
  assert.ok(!Object.prototype.hasOwnProperty.call(transport.metrics, 'startupMs'));

  const noFile = await runBridge({ ...common, commandOptions: { diagnosticTimings: true, modelName: 'no-file' } });
  const noFileTiming = noFile.diagnostics.find((item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE)?.details;
  assert.equal(noFileTiming.metrics.artifactRequestCount.status, 'skipped');
  assert.equal(noFileTiming.metrics.artifactRequestCount.value, null);
  assert.equal(noFileTiming.metrics.materializeTotalMs.status, 'skipped');
  assert.equal(noFileTiming.metrics.materializeTotalMs.value, null);

  const failed = await runBridge({ ...common, commandOptions: { diagnosticTimings: true, modelName: 'failed' } });
  const failedTiming = failed.diagnostics.find((item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE)?.details;
  assert.equal(failed.parseStatus, 'failed');
  assert.equal(failedTiming.outcome, 'failed');
  assert.equal(failedTiming.metrics.artifactRequestCount.status, 'skipped');
  assert.equal(failedTiming.metrics.artifactRequestCount.value, null);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const cancelled = await runBridge({ ...common, signal: controller.signal, commandOptions: { diagnosticTimings: true, modelName: 'cancel' } });
  const cancelledTiming = cancelled.diagnostics.find((item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE)?.details;
  assert.equal(cancelled.parseStatus, 'failed');
  assert.equal(cancelledTiming.outcome, 'cancelled');
  assert.equal(cancelledTiming.metrics.daemonRequestMs.status, 'unavailable');
  assert.equal(cancelledTiming.metrics.daemonRequestMs.value, null);

  const disabled = await runBridge({ ...common, commandOptions: { diagnosticTimings: false, modelName: 'no-file' } });
  assert.equal(disabled.diagnostics.some((item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE), false);
  console.log(JSON.stringify({
    ok: true,
    largeArtifactRequestCount: transport.metrics.artifactRequestCount.value,
    noFileArtifactStatus: noFileTiming.metrics.artifactRequestCount.status,
    failedOutcome: failedTiming.outcome,
    cancelledOutcome: cancelledTiming.outcome
  }));
} finally {
  await disposeBridgeDaemonPool();
}
`;
    writeFileSync(childPath, childSource, 'utf8');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', childPath], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000
    });
    assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const line = result.stdout.trim().split(/\r?\n/).findLast((item) => item.trim().startsWith('{'));
    assert.ok(line, 'runBridge transport runtime did not return JSON');
    const output = JSON.parse(line);
    assert.equal(output.ok, true);
    assert.equal(output.largeArtifactRequestCount, 3);
    assert.equal(output.noFileArtifactStatus, 'skipped');
    assert.equal(output.failedOutcome, 'failed');
    assert.equal(output.cancelledOutcome, 'cancelled');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

runCollectorConformance();
runTypeScriptAggregationConformance();
runBridgeTransportRuntimeConformance();

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
    'runBridge-file-backed-transport-runtime',
    'runBridge-no-file-backed-skip-runtime',
    'runBridge-failure-and-cancel-unavailable-runtime',
    'no-source-paths'
  ]
}, null, 2));
