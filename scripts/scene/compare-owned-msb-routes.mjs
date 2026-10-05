import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { compareMsbIndependentFields, compareMsbLayers } from './compare-msb-independent-fields.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const families = { MODEL_PARAM_ST: 'models', PARTS_PARAM_ST: 'parts', POINT_PARAM_ST: 'regions', EVENT_PARAM_ST: 'events', ROUTE_PARAM_ST: 'routes' };
const routeKinds = { 3: 'MufflingPortalLink', 4: 'MufflingBoxLink' };

/** Reflection is authoritative only for the exact assembly in the producer. */
export function assertOwnedMsbRouteAssembly(receipt, producerBytes, assemblyBytes) {
  assert.equal(hash(producerBytes), receipt.executable.sha256, 'MSB_ROUTE_PRODUCER_RECEIPT_MISMATCH');
  assert(assemblyBytes.length > 0, 'MSB_ROUTE_ASSEMBLY_EMPTY');
  const embeddedOffset = producerBytes.indexOf(assemblyBytes);
  assert(embeddedOffset >= 0 && producerBytes.indexOf(assemblyBytes, embeddedOffset + 1) === -1, 'MSB_ROUTE_ASSEMBLY_NOT_UNIQUELY_EMBEDDED');
  return { assemblySha256: hash(assemblyBytes), assemblyByteLength: assemblyBytes.length, embeddedOffset, embeddedByteIdentity: true };
}

export function compareOwnedMsbRouteInternals(oracleRoutes, observedRoutes) {
  const mismatches = [];
  for (let ordinal = 0; ordinal < oracleRoutes.length; ordinal++) {
    for (const [oracleField, observedField] of [['Unk08', 'unk08'], ['Unk0C', 'unk0C']]) {
      const expected = oracleRoutes[ordinal].entry[oracleField], actual = observedRoutes?.[ordinal]?.[observedField];
      if (expected !== actual) mismatches.push({ path: `routes[${ordinal}].${observedField}`, expected, actual: actual ?? null });
    }
  }
  if (oracleRoutes.length !== observedRoutes?.length) mismatches.unshift({ path: 'routes.length', expected: oracleRoutes.length, actual: observedRoutes?.length ?? null });
  return { status: mismatches.length ? 'failed' : 'passed', comparedDecodedNativeValues: oracleRoutes.length * 2, mismatchCount: mismatches.length, firstMismatch: mismatches[0] ?? null };
}

async function observeRouteInternals(options, oracle, rawRecords, comparison) {
  const bindings = [];
  const bind = async path => {
    path = resolve(path);
    assert((await stat(path)).size <= 128 * 1024 * 1024, `INTERNAL_BINDING_TOO_LARGE:${path}`);
    const bytes = await readFile(path);
    bindings.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  };
  const receiptPath = join(dirname(options.producerPath), 'bridge-production-build.json');
  const receipt = JSON.parse(await bind(receiptPath));
  assert.equal(receipt.schemaVersion, 2);
  const productHelperPath = join(options.productRoot, 'scripts/bridge-production-build.mjs');
  assert.equal(hash(await bind(productHelperPath)), receipt.helper.sha256);
  const { assertBridgeProductionBuildFresh } = await import(pathToFileURL(resolve(productHelperPath)).href);
  const fresh = async () => {
    const value = await assertBridgeProductionBuildFresh(options.productRoot, { runtimeIdentifier: 'linux-x64' });
    assert.equal(resolve(value.manifestPath), resolve(receiptPath));
    assert.deepEqual(value.receipt, receipt);
  };
  await fresh();
  const producerBytes = await bind(options.producerPath), assemblyBytes = await bind(options.assemblyPath);
  const assembly = assertOwnedMsbRouteAssembly(receipt, producerBytes, assemblyBytes);
  assert.equal(hash(producerBytes), comparison.producer.sha256);
  const alteredAssembly = Buffer.from(assemblyBytes); alteredAssembly[0] ^= 1;
  assert.throws(() => assertOwnedMsbRouteAssembly(receipt, producerBytes, alteredAssembly), /MSB_ROUTE_ASSEMBLY_NOT_UNIQUELY_EMBEDDED/);
  await bind(oracle.source.path);
  await bind(options.dotnetPath);
  const outputRoot = resolve(options.internalOutputRoot);
  await mkdir(outputRoot, { recursive: false });
  const probeRoot = join(outputRoot, 'probe-source'), probeBin = join(outputRoot, 'probe-bin');
  await mkdir(probeRoot);
  const probeSourceRoot = fileURLToPath(new URL('./msb-route-internal-field-probe/', import.meta.url));
  for (const name of ['Program.cs', 'MSBRouteInternalFields.csproj', 'NuGet.Config']) {
    const bytes = await bind(join(probeSourceRoot, name));
    await writeFile(join(probeRoot, name), bytes);
    await bind(join(probeRoot, name));
  }
  const env = { ...process.env, DOTNET_CLI_HOME: join(outputRoot, 'dotnet-home'), NUGET_PACKAGES: join(outputRoot, 'nuget-packages'), DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
  const run = args => {
    const value = spawnSync(resolve(options.dotnetPath), args, { cwd: probeRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    if (value.error || value.status !== 0 || value.signal) throw value.error ?? new Error(`MSB_ROUTE_INTERNAL_PROBE_FAILED:${value.status}:${value.stderr || value.stdout}`);
    return value;
  };
  const build = run(['build', join(probeRoot, 'MSBRouteInternalFields.csproj'), '-c', 'Release', '-o', probeBin, '--configfile', join(probeRoot, 'NuGet.Config'), '-p:NuGetAudit=false', '-p:UseSharedCompilation=false']);
  await writeFile(join(outputRoot, 'probe-build.log'), build.stdout + build.stderr);
  const probePath = join(probeBin, 'MSBRouteInternalFields.dll');
  for (const name of ['MSBRouteInternalFields.dll', 'MSBRouteInternalFields.deps.json', 'MSBRouteInternalFields.runtimeconfig.json']) await bind(join(probeBin, name));
  const captured = run([probePath, resolve(options.assemblyPath), resolve(oracle.source.path), oracle.source.sha256, oracle.decoded.sha256]);
  const observation = JSON.parse(captured.stdout);
  assert.equal(observation.schema, 'soulforge.msb-route-internal-observations.v1');
  assert.equal(observation.producerAssemblySha256, assembly.assemblySha256);
  assert.equal(observation.originalSource.sha256, oracle.source.sha256);
  assert.equal(observation.decodedSource.sha256, oracle.decoded.sha256);
  assert.equal(observation.routeCount, rawRecords.length);
  for (const [ordinal, record] of rawRecords.entries()) {
    const actual = observation.routes[ordinal];
    for (const [field, expected] of Object.entries({ ordinal, offset: record.offset, name: record.name, typeId: record.typeId, id: record.internalEntryId }))
      assert.equal(actual[field], expected, `INTERNAL_NATIVE_IDENTITY:${ordinal}:${field}`);
  }
  const fieldComparison = compareOwnedMsbRouteInternals(oracle.fields.routes, observation.routes);
  assert.equal(fieldComparison.status, 'passed');
  const negatives = [{ field: 'assemblyBytes', status: 'passed', expectedError: 'MSB_ROUTE_ASSEMBLY_NOT_UNIQUELY_EMBEDDED' }];
  for (const field of ['unk08', 'unk0C']) {
    const altered = structuredClone(observation.routes); altered[0][field]++;
    const result = compareOwnedMsbRouteInternals(oracle.fields.routes, altered);
    assert.equal(result.status, 'failed'); assert.equal(result.mismatchCount, 1);
    assert.equal(result.firstMismatch.path, `routes[0].${field}`);
    negatives.push({ field, status: 'passed', detectedFirstMismatch: result.firstMismatch });
  }
  await writeFile(join(outputRoot, 'observations.json'), captured.stdout);
  await bind(join(outputRoot, 'observations.json'));
  await fresh();
  for (const binding of bindings) assert.equal(hash(await readFile(binding.path)), binding.sha256, `INTERNAL_BOUND_INPUT_CHANGED:${binding.path}`);
  const result = {
    status: 'passed', assembly, sourceInputHash: receipt.source.sha256, sourceFiles: receipt.source.fileCount,
    decodedNativeFields: ['Unk08', 'Unk0C'], comparison: fieldComparison, negatives,
    dtoOmissions: 'Both fields are retained by the native decoder but omitted from Bridge envelope and core DTO',
    externalDependencies: false, boundInputsUnchangedBeforeAfter: true, observationPath: join(outputRoot, 'observations.json'), bindings
  };
  await writeFile(join(outputRoot, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** Bounded original-byte observations, independent of the Bridge capture. */
export function readOwnedMsbRawRecords(raw) {
  assert(raw.length <= MAX_BYTES && raw.toString('ascii', 0, 4) === 'MSB ', 'RAW_MSB_BOUNDS_OR_MAGIC');
  const pointer = at => {
    assert(Number.isSafeInteger(at) && at >= 0 && at + 8 <= raw.length, 'RAW_POINTER_BOUNDS');
    const value = Number(raw.readBigInt64LE(at));
    assert(Number.isSafeInteger(value), 'RAW_POINTER_INTEGER');
    return value;
  };
  const utf16 = start => {
    assert(Number.isSafeInteger(start) && start >= 0 && start % 2 === 0 && start < raw.length, 'RAW_NAME_POINTER');
    let end = start;
    while (end + 2 <= raw.length && end - start <= 0x10000) {
      if (raw.readUInt16LE(end) === 0) return raw.toString('utf16le', start, end);
      end += 2;
    }
    throw new Error('RAW_NAME_UNTERMINATED');
  };
  const result = {}, seen = new Set();
  let at = 0x10;
  while (at) {
    assert(Number.isSafeInteger(at) && at >= 0 && at + 0x18 <= raw.length && !seen.has(at), 'RAW_PARAM_CHAIN');
    seen.add(at);
    const count = raw.readInt32LE(at + 4);
    assert(count >= 1 && count <= 100000 && at + 0x10 + count * 8 <= raw.length, 'RAW_PARAM_COUNT');
    const family = families[utf16(pointer(at + 8))];
    if (family) {
      assert(!result[family], 'RAW_DUPLICATE_FAMILY');
      result[family] = Array.from({ length: count - 1 }, (_, ordinal) => {
        const offset = pointer(at + 0x10 + ordinal * 8);
        assert(offset >= 0 && offset + (family === 'routes' ? 0x80 : 0x18) <= raw.length, 'RAW_ENTRY_BOUNDS');
        const nameRelativeOffset = pointer(offset), nameStringOffset = offset + nameRelativeOffset;
        assert(nameRelativeOffset !== 0, 'RAW_ZERO_NAME_OFFSET');
        const name = utf16(nameStringOffset);
        const record = {
          ordinal, offset, name, nameRelativeOffset, nameStringOffset,
          nameUtf16Sha256: hash(raw.subarray(nameStringOffset, nameStringOffset + Buffer.byteLength(name, 'utf16le'))),
          internalEntryId: raw.readInt32LE(offset + (family === 'routes' ? 0x14 : family === 'events' ? 0x10 : 0x0c))
        };
        if (family === 'routes') Object.assign(record, {
          typeId: raw.readInt32LE(offset + 0x10), unk08: raw.readInt32LE(offset + 8), unk0C: raw.readInt32LE(offset + 0x0c),
          reservedBytes: 0x68, reservedBytesAllZero: raw.subarray(offset + 0x18, offset + 0x80).every(byte => byte === 0)
        });
        return record;
      });
    }
    at = pointer(at + 0x10 + (count - 1) * 8);
  }
  for (const family of Object.values(families)) assert(result[family], `RAW_MISSING_FAMILY:${family}`);
  return result;
}

function compiledReadDeclaration(ts, compiled) {
  const source = ts.createSourceFile('msbBridgeRead.js', compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readMsbDocumentViaBridge');
  assert(declaration, 'COMPILED_MAPPER_DECLARATION_MISSING');
  return compiled.slice(declaration.getStart(source), declaration.end).replace(/^export /, '');
}

/** Extends the existing receipt-bound comparison with observed route evidence. */
export async function compareOwnedMsbRoutes(options) {
  const comparison = await compareMsbIndependentFields(options);
  assert.equal(comparison.supportedFieldStatus, 'passed', 'BASE_FIELDS_MUST_PASS_BEFORE_ROUTE_NEGATIVES');
  assert.equal(comparison.coreMode, 'compiled-product-receipt-bound-source', 'COMPILED_CORE_REQUIRED');
  const oracle = JSON.parse(await readFile(options.oraclePath));
  const originalInfo = await stat(oracle.source.path);
  assert(originalInfo.size <= MAX_BYTES, 'ORIGINAL_INPUT_TOO_LARGE');
  const original = await readFile(oracle.source.path);
  assert.equal(hash(original), oracle.source.sha256);
  let raw = original;
  if (raw.subarray(0, 4).equals(Buffer.from('DCX\0'))) {
    assert(raw.length >= 0x4c && raw.toString('ascii', 0x28, 0x2c) === 'DFLT', 'DFLT_ONLY');
    raw = inflateSync(raw.subarray(0x4c), { maxOutputLength: MAX_BYTES });
    assert.equal(raw.length, original.readUInt32BE(0x1c));
  }
  assert.equal(hash(raw), oracle.decoded.sha256);
  const records = readOwnedMsbRawRecords(raw);
  assert(records.routes.length > 0, 'NO_OWNED_ROUTE_OBSERVATIONS');
  assert.equal(records.routes.length, oracle.fields.routes.length);
  const routeRecords = records.routes.map((record, ordinal) => {
    const exported = oracle.fields.routes[ordinal].entry;
    const subtype = exported.kind.split('+').at(-1);
    assert.equal(subtype, routeKinds[record.typeId], `ROUTE_ORDER_OR_SUBTYPE:${ordinal}`);
    assert.equal(exported.Unk08, record.unk08, `ROUTE_UNK08:${ordinal}`);
    assert.equal(exported.Unk0C, record.unk0C, `ROUTE_UNK0C:${ordinal}`);
    assert(record.reservedBytesAllZero, `ROUTE_RESERVED_PATTERN:${ordinal}`);
    return { ...record, subtype, oracleDisplayName: exported.Name, oracleDisplayAlias: exported.Name !== record.name };
  });

  const observationBytes = await readFile(join(options.observationsRoot, 'msb.json'));
  const manifestBytes = await readFile(join(options.observationsRoot, 'observation-manifest.json'));
  const capture = JSON.parse(observationBytes);
  const require = createRequire(join(resolve(options.productRoot), 'package.json'));
  const compiled = await readFile(join(options.productRoot, 'packages/core/dist/editing/msbBridgeRead.js'), 'utf8');
  const declaration = compiledReadDeclaration(require('typescript'), compiled);
  assert.equal(hash(declaration), comparison.coreMapperDeclarationSha256);
  const read = new Function('runBridge', `${declaration}\nreturn readMsbDocumentViaBridge;`)(async () => capture);
  const core = await read({ sourcePath: capture.sourcePath, allowedRoots: [dirname(capture.sourcePath)] });
  assert(core.ok);
  const mutationValues = { typeId: routeRecords[0].typeId === 4 ? 3 : 4, id: routeRecords[0].internalEntryId + 100000, name: `${routeRecords[0].name}__negative` };
  const negatives = [];
  const temporary = await mkdtemp(join(tmpdir(), 'sf-owned-msb-routes-'));
  try {
    for (const [field, value] of Object.entries(mutationValues)) {
      const alteredCapture = structuredClone(capture);
      alteredCapture.data.routes[0][field] = value;
      const alteredBytes = Buffer.from(JSON.stringify(alteredCapture));
      const manifest = JSON.parse(manifestBytes);
      manifest.observations.find(entry => entry.name === 'msb.json').sha256 = hash(alteredBytes);
      await writeFile(join(temporary, 'msb.json'), alteredBytes);
      await writeFile(join(temporary, 'observation-manifest.json'), JSON.stringify(manifest));
      const result = await compareMsbIndependentFields({ ...options, observationsRoot: temporary });
      const check = result.layers.bridge.families.routes.checks[field];
      assert.equal(result.firstDivergentLayer, 'bridge');
      assert.equal(check.mismatchCount, 1);
      assert.equal(check.firstMismatch.index, 0);
      assert.equal(check.firstMismatch.actual, value);
      negatives.push({ layer: 'bridge', field, status: 'passed', detectedFirstMismatch: check.firstMismatch, receiptValid: true });
      const alteredCore = structuredClone(core.data);
      alteredCore.routes[0][field] = value;
      const coreResult = compareMsbLayers(oracle.fields, records, capture.data, alteredCore);
      const coreCheck = coreResult.layers.core.families.routes.checks[field];
      assert.equal(coreResult.firstDivergentLayer, 'core');
      assert.equal(coreCheck.mismatchCount, 1);
      assert.equal(coreCheck.firstMismatch.index, 0);
      assert.equal(coreCheck.firstMismatch.actual, value);
      negatives.push({ layer: 'core', field, status: 'passed', detectedFirstMismatch: coreCheck.firstMismatch, mode: 'pure-comparison-of-compiled-mapper-output' });
    }
    const wrongSource = JSON.parse(manifestBytes);
    wrongSource.observations.find(entry => entry.name === 'msb.json').sourceSha256 = '0'.repeat(64);
    await writeFile(join(temporary, 'msb.json'), observationBytes);
    await writeFile(join(temporary, 'observation-manifest.json'), JSON.stringify(wrongSource));
    await assert.rejects(() => compareMsbIndependentFields({ ...options, observationsRoot: temporary }), /MSB_CAPTURE_RECEIPT_MISMATCH/);
    negatives.push({ layer: 'source-receipt', field: 'sourceSha256', status: 'passed', expectedError: 'MSB_CAPTURE_RECEIPT_MISMATCH' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  for (const binding of comparison.bindings) {
    const current = await readFile(binding.path);
    assert.equal(current.length, binding.bytes, `BOUND_INPUT_SIZE_CHANGED:${binding.path}`);
    assert.equal(hash(current), binding.sha256, `BOUND_INPUT_CHANGED:${binding.path}`);
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const script = await readFile(scriptPath);
  const upstreamRoutePath = resolve(dirname(options.oraclePath), '..', `SoulsFormatsNEXT-${comparison.oracle.revision}`, 'SoulsFormats/Formats/MSB/MSBS/RouteParam.cs');
  const upstreamRouteBytes = await readFile(upstreamRoutePath);
  const internalOptions = [options.assemblyPath, options.dotnetPath, options.internalOutputRoot];
  assert(internalOptions.every(Boolean) || internalOptions.every(value => !value), 'ALL_INTERNAL_PROBE_OPTIONS_REQUIRED');
  const nativeInternal = internalOptions.every(Boolean) ? await observeRouteInternals(options, oracle, routeRecords, comparison) : null;
  return {
    schemaVersion: 1, status: 'partial', supportedFieldStatus: 'passed', fullSubtypeCoverage: false,
    exactOwnedSource: oracle.source, decodedSource: oracle.decoded, producer: comparison.producer,
    coreMode: comparison.coreMode, coreMapperDeclarationSha256: comparison.coreMapperDeclarationSha256,
    comparedFieldValues: Object.fromEntries(Object.entries(comparison.layers).map(([layer, data]) => [layer, Object.values(data.families).reduce((sum, family) => sum + family.comparedFieldValues, 0)])),
    routeChecks: Object.fromEntries(Object.entries(comparison.layers).map(([layer, data]) => [layer, data.families.routes])),
    routeNativeLayout: { nameRelativePointer: '0x00', unk08: '0x08', unk0C: '0x0c', typeId: '0x10', nativeId: '0x14', reservedPattern: '0x18..0x7f = zero', source: { path: upstreamRoutePath, bytes: upstreamRouteBytes.length, sha256: hash(upstreamRouteBytes), revision: comparison.oracle.revision }, nativeIdAuthority: 'Original bounded bytes; pinned oracle reads then discards the ID', orderingAuthority: 'Original param offset-table order matches pinned subtype GetEntries order for this input' },
    routeRecords, routeOmissions: comparison.omissions.routes,
    routeDisplayAliases: comparison.oracleDisplayAliases.filter(entry => entry.family === 'routes'),
    allDisplayAliasCount: comparison.oracleDisplayAliases.length,
    omittedSubtypeRootCount: Object.values(comparison.omissions).reduce((sum, family) => sum + family.subtypes.reduce((count, subtype) => count + subtype.omittedRoots.length, 0), 0),
    negatives, negativeStatus: 'passed', boundInputsUnchangedAfterNegatives: true, nativeInternal,
    tool: { path: scriptPath, bytes: script.length, sha256: hash(script) },
    nonClaims: ['MufflingPortalLink is unobserved when absent in this input', 'Route Unk08 and Unk0C are omitted Bridge envelope/core DTO fields; internal decoder coverage requires the separate reflection result', 'Native IDs are not oracle-exported fields', 'No full MSB subtype coverage, writes, renderer or GPU behavior established', 'Core dist declaration is bound to receipt-listed source by equality; core dist is not a desktop receipt output entry']
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [oraclePath, observationsRoot, producerPath, productRoot, reportPath, assemblyPath, dotnetPath, internalOutputRoot] = process.argv.slice(2);
  if (!reportPath) throw new Error('Usage: node scripts/scene/compare-owned-msb-routes.mjs <oracle.json> <capture-dir> <producer> <product-root> <report.json> [product-dll dotnet fresh-internal-output]');
  const report = await compareOwnedMsbRoutes({ oraclePath, observationsRoot, producerPath, productRoot, assemblyPath, dotnetPath, internalOutputRoot });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, supportedFieldStatus: report.supportedFieldStatus, coreMode: report.coreMode, routeRecords: report.routeRecords.length, negativeStatus: report.negativeStatus, negativeCount: report.negatives.length, comparedFieldValues: report.comparedFieldValues, reportPath }));
}
