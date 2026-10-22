import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REVISION = 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905';
const MAX_BYTES = 64 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FAMILIES = ['models', 'parts', 'regions', 'events', 'routes'];
// Numeric values are the pinned oracle's MSBS enum contract, including gaps.
const TYPES = {
  models: { MapPiece: 0, Object: 1, Enemy: 2, Player: 4, Collision: 5 },
  parts: { MapPiece: 0, Object: 1, Enemy: 2, Player: 4, Collision: 5, DummyObject: 9, DummyEnemy: 10, ConnectCollision: 11 },
  regions: { InvasionPoint: 1, EnvironmentMapPoint: 2, Sound: 4, SFX: 5, WindSFX: 6, SpawnPoint: 8, PatrolRoute: 11, WarpPoint: 13, ActivationArea: 14, Event: 15, Logic: 0, EnvironmentMapEffectBox: 17, WindArea: 18, MufflingBox: 20, MufflingPortal: 21, SoundSpaceOverride: 23, MufflingPlane: 24, PartsGroupArea: 25, AutoDrawGroupPoint: 26, Other: -1 },
  events: { Treasure: 4, Generator: 5, ObjAct: 7, MapOffset: 9, PatrolInfo: 14, PlatoonInfo: 15, ResourceItemInfo: 17, GrassLodParam: 18, SkitInfo: 20, PlacementGroup: 21, PartsGroup: 22, Talk: 23, AutoDrawGroupCollision: 24, Other: -1 },
  routes: { MufflingPortalLink: 3, MufflingBoxLink: 4 }
};
const SHAPES = { Point: 0, Circle: 1, Sphere: 2, Cylinder: 3, Rectangle: 4, Box: 5, Composite: 6 };
const subtype = (entry) => entry.kind.split('+').at(-1);

function compare(expected, actual, tolerance = 0) {
  const expectedArray = Array.isArray(expected) ? expected : [expected];
  const actualArray = Array.isArray(actual) ? actual : [actual];
  let mismatchCount = 0, firstMismatch = null, maximumAbsoluteError = 0;
  for (let index = 0; index < Math.max(expectedArray.length, actualArray.length); index++) {
    const a = expectedArray[index], b = actualArray[index];
    const numeric = typeof a === 'number' && typeof b === 'number';
    const error = numeric ? Math.abs(a - b) : 0;
    if (numeric && Number.isFinite(error)) maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
    if (numeric ? !Number.isFinite(a) || !Number.isFinite(b) || error > tolerance : a !== b) {
      mismatchCount++; firstMismatch ??= { index, expected: a ?? null, actual: b ?? null };
    }
  }
  return { status: mismatchCount ? 'failed' : 'passed', count: expectedArray.length, mismatchCount, firstMismatch, ...(tolerance ? { tolerance, maximumAbsoluteError } : {}) };
}

function supported(family, entries, rawRecords, includeSibPath) {
  const columns = { name: rawRecords.map((entry) => entry.name), nativeOffset: rawRecords.map((entry) => entry.offset), typeId: entries.map((entry) => TYPES[family][subtype(entry)]) };
  if (columns.typeId.some((value) => value === undefined)) throw new Error(`ORACLE_SUBTYPE_UNREGISTERED:${family}`);
  if (family === 'models' && includeSibPath) columns.sibPath = entries.map((entry) => entry.SibPath);
  if (family === 'parts' || family === 'regions') {
    for (const [oracleName, names] of [['Position', ['posX', 'posY', 'posZ']], ['Rotation', ['rotX', 'rotY', 'rotZ']]]) {
      names.forEach((name, axis) => { columns[name] = entries.map((entry) => entry[oracleName][axis]); });
    }
    columns.internalEntryId = rawRecords.map((entry) => entry.internalEntryId);
    columns.entityId = entries.map((entry) => entry.EntityID);
  }
  if (family === 'parts') {
    ['scaleX', 'scaleY', 'scaleZ'].forEach((name, axis) => { columns[name] = entries.map((entry) => entry.Scale[axis]); });
    columns.modelIndex = entries.map((entry) => entry['native:ModelIndex']);
  }
  if (family === 'regions') {
    columns.shapeType = entries.map((entry) => SHAPES[subtype(entry.Shape)]);
    if (columns.shapeType.some((value) => value === undefined)) throw new Error('ORACLE_SHAPE_UNREGISTERED');
  }
  if (family === 'events') columns.eventId = entries.map((entry) => entry.EventID);
  if (family === 'routes') columns.id = rawRecords.map((entry) => entry.internalEntryId);
  return columns;
}

/** Pure comparison so receipt-valid value corruptions can test localization. */
export function compareMsbLayers(oracleFields, rawRecords, bridge, core) {
  const layers = {};
  for (const [name, data] of [['bridge', bridge], ['core', core]]) {
    const families = {};
    for (const family of FAMILIES) {
      const entries = oracleFields[family].map((value) => value.entry);
      const actual = data?.[family];
      const checks = { count: compare(entries.length, actual?.length), declaredCount: compare(entries.length, data?.[`${family.slice(0, -1)}Count`]) };
      if (entries.length) {
        for (const [field, values] of Object.entries(supported(family, entries, rawRecords[family], name === 'bridge'))) {
          checks[field] = compare(values, actual?.map((entry) => entry[field]), /^(pos|rot|scale)/.test(field) ? 1e-6 : 0);
        }
      }
      families[family] = {
        status: Object.values(checks).some((value) => value.status === 'failed') ? 'failed' : entries.length ? 'passed' : 'unverified',
        comparedFieldValues: Object.values(checks).reduce((sum, check) => sum + check.count, 0),
        ...(entries.length ? {} : { reason: 'NO_NATIVE_ENTRIES_FOR_SUBTYPE_FIELD_OBSERVATION' }), checks
      };
    }
    layers[name] = { status: Object.values(families).some((family) => family.status === 'failed') ? 'failed' : 'passed', families };
  }
  return { supportedFieldStatus: Object.values(layers).some((layer) => layer.status === 'failed') ? 'failed' : 'passed', firstDivergentLayer: ['bridge', 'core'].find((name) => layers[name].status === 'failed') ?? null, layers };
}

/** Every unrepresented oracle root is listed, never counted as a passed check. */
export function inventoryMsbOmissions(fields) {
  const represented = {
    models: new Set(['kind', 'Name', 'SibPath']),
    parts: new Set(['kind', 'Name', 'ModelName', 'native:ModelIndex', 'Position', 'Rotation', 'Scale', 'EntityID']),
    regions: new Set(['kind', 'Name', 'Position', 'Rotation', 'EntityID', 'Shape']),
    events: new Set(['kind', 'Name', 'EventID']), routes: new Set(['kind', 'Name'])
  };
  const inventory = {};
  for (const family of FAMILIES) {
    const groups = new Map();
    for (const { entry } of fields[family]) {
      const kind = subtype(entry);
      if (!groups.has(kind)) groups.set(kind, { subtype: kind, entries: 0, omittedRoots: new Set(), hashOnlyRoots: new Set() });
      const group = groups.get(kind); group.entries++;
      for (const [key, value] of Object.entries(entry)) {
        if (!represented[family].has(key)) group.omittedRoots.add(key);
        if (value?.sha256 && value?.byteLength !== undefined) group.hashOnlyRoots.add(key);
      }
      if (entry.Shape) for (const key of Object.keys(entry.Shape)) if (key !== 'kind') group.omittedRoots.add(`Shape.${key}`);
      if (entry.SceneGparam?.EventIDs?.sha256) group.hashOnlyRoots.add('SceneGparam.EventIDs');
    }
    inventory[family] = {
      coverage: 'partial', subtypes: [...groups.values()].map((group) => ({ ...group, omittedRoots: [...group.omittedRoots].sort(), hashOnlyRoots: [...group.hashOnlyRoots].sort() })),
      unobservedSubtypes: Object.keys(TYPES[family]).filter((kind) => !groups.has(kind))
    };
  }
  return inventory;
}

function readRawRecords(raw) {
  const result = {}, families = { MODEL_PARAM_ST: 'models', PARTS_PARAM_ST: 'parts', POINT_PARAM_ST: 'regions', EVENT_PARAM_ST: 'events', ROUTE_PARAM_ST: 'routes' };
  const utf16 = (start) => {
    if (!Number.isSafeInteger(start) || start < 0 || start >= raw.length) throw new Error('RAW_NAME_OFFSET_INVALID');
    let end = start; while (end + 2 <= raw.length && end - start <= 0x10000) { if (!raw.readUInt16LE(end)) return raw.toString('utf16le', start, end); end += 2; }
    throw new Error('RAW_NAME_UNTERMINATED');
  };
  let at = 0x10; const seen = new Set();
  while (at) {
    if (!Number.isSafeInteger(at) || at < 0 || at + 0x18 > raw.length || seen.has(at)) throw new Error('RAW_PARAM_CHAIN_INVALID');
    seen.add(at); const count = raw.readInt32LE(at + 4);
    if (count < 1 || count > 100000 || at + 0x10 + count * 8 > raw.length) throw new Error('RAW_ENTRY_COUNT_INVALID');
    const family = families[utf16(Number(raw.readBigInt64LE(at + 8)))];
    if (family) result[family] = Array.from({ length: count - 1 }, (_, ordinal) => {
      const offset = Number(raw.readBigInt64LE(at + 0x10 + ordinal * 8));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + 0x18 > raw.length) throw new Error('RAW_ENTRY_OFFSET_INVALID');
      const nameStringOffset = offset + Number(raw.readBigInt64LE(offset)), name = utf16(nameStringOffset);
      return { offset, name, nameStringOffset, nameUtf16Sha256: hash(raw.subarray(nameStringOffset, nameStringOffset + Buffer.byteLength(name, 'utf16le'))), internalEntryId: raw.readInt32LE(offset + (family === 'routes' ? 0x14 : family === 'events' ? 0x10 : 0x0c)) };
    });
    at = Number(raw.readBigInt64LE(at + 0x10 + (count - 1) * 8));
  }
  if (FAMILIES.some((family) => !result[family])) throw new Error('RAW_REQUIRED_FAMILY_MISSING');
  return result;
}

function mapperDeclaration(ts, text) {
  const source = ts.createSourceFile('msbBridgeRead.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = source.statements.find((value) => ts.isFunctionDeclaration(value) && value.name?.text === 'readMsbDocumentViaBridge');
  if (!node) throw new Error('CORE_MAPPER_DECLARATION_MISSING');
  return text.slice(node.getStart(source), node.end).replace(/^export /, '');
}

export async function compareMsbIndependentFields({ oraclePath, observationsRoot, producerPath, productRoot, localMapperPath }) {
  const bindings = [];
  const bind = async (path, maxBytes = MAX_BYTES) => {
    path = resolve(path); const info = await stat(path);
    if (info.size > maxBytes) throw new Error(`BOUNDED_INPUT_TOO_LARGE:${path}`);
    const bytes = await readFile(path); bindings.push({ path, bytes: bytes.length, sha256: hash(bytes) }); return bytes;
  };
  const oracleBytes = await bind(oraclePath), oracle = JSON.parse(oracleBytes);
  if (oracle.ok !== true || oracle.decoded.format !== 'MSBS' || oracle.oracle.commit !== REVISION) throw new Error('MSB_ORACLE_PROVENANCE_MISMATCH');
  const summary = JSON.parse(await bind(join(dirname(resolve(oraclePath)), 'independent-export-summary.json')));
  const exportReceipt = summary.exports.find((entry) => resolve(entry.file) === resolve(oraclePath));
  if (summary.independentOfSoulForge !== true || summary.revision !== REVISION || exportReceipt?.jsonSha256 !== hash(oracleBytes)) throw new Error('MSB_ORACLE_EXPORT_RECEIPT_MISMATCH');
  const namingPolicyPath = resolve(dirname(oraclePath), '..', `SoulsFormatsNEXT-${REVISION}`, 'SoulsFormats/Formats/MSB/MSB.cs');
  const namingPolicySha256 = hash(await bind(namingPolicyPath));
  if (namingPolicySha256 !== 'b19fa19c7448393fe9e3e799e5819b810dc88b566900178a0cc06d240517bd5e') throw new Error('MSB_PINNED_NAMING_POLICY_MISMATCH');
  const original = await bind(oracle.source.path);
  if (hash(original) !== oracle.source.sha256 || original.length !== oracle.source.byteLength) throw new Error('MSB_ORIGINAL_SOURCE_MISMATCH');
  let raw = original;
  if (original.subarray(0, 4).equals(Buffer.from('DCX\0'))) {
    if (original.length < 0x4c || original.toString('ascii', 0x28, 0x2c) !== 'DFLT') throw new Error('MSB_DFLT_ONLY_NO_VENDOR_CODEC');
    raw = inflateSync(original.subarray(0x4c), { maxOutputLength: MAX_BYTES });
    if (raw.length !== original.readUInt32BE(0x1c)) throw new Error('MSB_DECODED_LENGTH_MISMATCH');
  }
  if (hash(raw) !== oracle.decoded.sha256 || raw.length !== oracle.decoded.byteLength || raw.toString('ascii', 0, 4) !== 'MSB ') throw new Error('MSB_DECODED_SOURCE_MISMATCH');
  const manifest = JSON.parse(await bind(join(observationsRoot, 'observation-manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.bridgeDllSha256 !== hash(await bind(producerPath, 128 * 1024 * 1024))) throw new Error('MSB_CAPTURE_PRODUCER_MISMATCH');
  const captureScript = fileURLToPath(new URL('../capture-flver-bridge-observations.mjs', import.meta.url));
  if (manifest.captureScriptSha256 !== hash(await bind(captureScript)) || manifest.producerKind !== (producerPath.endsWith('.dll') ? 'framework-dependent-dll' : 'native-executable')) throw new Error('MSB_CAPTURE_TOOL_MISMATCH');
  const bytes = await bind(join(observationsRoot, 'msb.json')), receipt = manifest.observations.find((entry) => entry.name === 'msb.json');
  if (!receipt || receipt.command !== 'read-msb-document' || receipt.sha256 !== hash(bytes) || receipt.sourceSha256 !== oracle.source.sha256 || receipt.decodedSourceSha256 !== oracle.decoded.sha256 || resolve(receipt.sourcePath) !== resolve(oracle.source.path)) throw new Error('MSB_CAPTURE_RECEIPT_MISMATCH');
  const capture = JSON.parse(bytes);
  if (resolve(capture.sourcePath) !== resolve(oracle.source.path) || capture.data?.sourceHash !== oracle.decoded.sha256 || capture.parseStatus === 'failed') throw new Error('MSB_CAPTURE_SOURCE_MISMATCH');
  const require = createRequire(join(resolve(productRoot), 'package.json')), tsPath = require.resolve('typescript'); await bind(tsPath);
  const ts = require('typescript');
  const mapperPath = resolve(localMapperPath ?? join(productRoot, 'packages/core/src/editing/msbBridgeRead.ts'));
  const mapperSource = (await bind(mapperPath)).toString('utf8');
  const emitted = ts.transpileModule(mapperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  let declaration = mapperDeclaration(ts, emitted), coreMode = 'local-source-transpiled';
  if (!localMapperPath) {
    const productReceipt = JSON.parse(await bind(join(productRoot, 'apps/desktop/out/agent-production-build.json')));
    const sourceReceipt = productReceipt.source.entries.find((entry) => entry.path === 'packages/core/src/editing/msbBridgeRead.ts');
    if (sourceReceipt?.sha256 !== hash(mapperSource)) throw new Error('MSB_CORE_SOURCE_RECEIPT_MISMATCH');
    const compiled = (await bind(join(productRoot, 'packages/core/dist/editing/msbBridgeRead.js'))).toString('utf8');
    const compiledDeclaration = mapperDeclaration(ts, compiled);
    if (compiledDeclaration !== declaration) throw new Error('MSB_CORE_COMPILED_SOURCE_DIVERGENCE');
    declaration = compiledDeclaration; coreMode = 'compiled-product-receipt-bound-source';
  }
  const read = new Function('runBridge', `${declaration}\nreturn readMsbDocumentViaBridge;`)(async () => capture);
  const core = await read({ sourcePath: capture.sourcePath, allowedRoots: [dirname(capture.sourcePath)] });
  if (!core.ok) throw new Error('MSB_CORE_READ_FAILED');
  const rawRecords = readRawRecords(raw);
  const comparison = compareMsbLayers(oracle.fields, rawRecords, capture.data, core.data);
  const sourceVersion = compare(raw.readInt32LE(4), capture.data.version), sourceSize = compare(raw.length, capture.data.sourceSize);
  comparison.layers.bridge.sourceChecks = { sourceVersion, sourceSize };
  if ([sourceVersion, sourceSize].some((check) => check.status === 'failed')) {
    comparison.layers.bridge.status = comparison.supportedFieldStatus = 'failed';
    comparison.firstDivergentLayer = 'bridge';
  }
  const omissions = inventoryMsbOmissions(oracle.fields);
  const aliases = FAMILIES.flatMap((family) => oracle.fields[family].flatMap(({ entry }, ordinal) => {
    const record = rawRecords[family][ordinal];
    return entry.Name === record?.name ? [] : [{ family, ordinal, nativeOffset: record?.offset, nameStringOffset: record?.nameStringOffset, nameUtf16Sha256: record?.nameUtf16Sha256, rawName: record?.name, oracleDisplayName: entry.Name }];
  }));
  const scriptPath = fileURLToPath(import.meta.url); await bind(scriptPath);
  return {
    schemaVersion: 1, status: comparison.supportedFieldStatus === 'failed' ? 'failed' : 'partial', fullSubtypeCoverage: false,
    ...comparison, coreMode, coreMapperDeclarationSha256: hash(declaration),
    source: oracle.source, decoded: oracle.decoded,
    oracle: { provider: summary.provider, revision: REVISION, independentOfSoulForge: true, lineageLimit: oracle.oracle.lineageLimit },
    producer: { path: resolve(producerPath), sha256: manifest.bridgeDllSha256, capturedAt: manifest.capturedAt },
    rawNamePolicy: 'Original raw UTF-16 names; oracle display aliases are recorded separately. Real suffixes remain untouched.', oracleDisplayAliases: aliases,
    oracleNamingPolicy: { path: namingPolicyPath, sha256: namingPolicySha256, methods: ['DisambiguateNames', 'ReambiguateName'], sourceLines: [48, 78], use: 'Explain display aliases only; never strip native suffixes in comparisons.' },
    omissions, coreOnlyOmissions: [{ family: 'models', fields: ['SibPath'], reason: 'Bridge exposes this field; core read DTO omits it.' }],
    exporterLimitations: [
      { fields: ['parts.ConnectCollision.MapID', 'parts.Collision.SceneGparam.EventIDs'], status: 'hash-only', reason: 'Exporter serializes byte/sbyte arrays as length+SHA rather than numeric elements.' },
      { fields: ['parts.Object.ObjPartIndex1/2/3', 'parts.DummyObject.ObjPartIndex1/2/3'], status: 'unexported', reason: 'Private fields end in Index1/2/3 rather than Index/Indices. Public resolved names are exported.' },
      { fields: ['models/parts/regions/events native record IDs', 'routes native record ID'], status: 'raw-input-observation', reason: 'Pinned oracle discards record IDs. Bounded original-byte header observations bind comparisons.' }
    ],
    nativeShapeWrites: 'Native writer continues to reject set_region_shape; profile checks do not establish write support.',
    nonClaims: ['Unrepresented subtype roots are not passed comparisons', 'No route payload observation for an empty route family', 'Local source mode is not a shipped-core build receipt', 'No raw payload changes or oracle code copied into product', 'No renderer behavior claimed by this subtype report'],
    bindings
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [oraclePath, observationsRoot, producerPath, productRoot, reportPath, localMapperPath] = process.argv.slice(2);
  if (!reportPath) throw new Error('Usage: node scripts/scene/compare-msb-independent-fields.mjs <oracle.json> <capture-dir> <producer> <product-root> <report.json> [local-mapper.ts]');
  const report = await compareMsbIndependentFields({ oraclePath, observationsRoot, producerPath, productRoot, localMapperPath });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, supportedFieldStatus: report.supportedFieldStatus, firstDivergentLayer: report.firstDivergentLayer, coreMode: report.coreMode, reportPath }));
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
