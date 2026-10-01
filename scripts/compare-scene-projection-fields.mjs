import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { compareNumericField, expectedPreviewSkinning } from './compare-flver-independent-fields.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const flatten = (values) => values.flat();
const decode = (base64, kind = 'f32') => {
  const bytes = Buffer.from(base64, 'base64');
  const width = kind === 'u16' ? 2 : 4;
  if (bytes.length % width) throw new Error('ATTRIBUTE_ALIGNMENT_INVALID');
  return Array.from({ length: bytes.length / width }, (_, i) => kind === 'f32' ? bytes.readFloatLE(i * width) : kind === 'u16' ? bytes.readUInt16LE(i * width) : kind === 'i32' ? bytes.readInt32LE(i * width) : bytes.readUInt32LE(i * width));
};
const check = (expected, actual, tolerance = 1e-6) => compareNumericField(expected, actual == null ? null : Array.from(actual), tolerance);
const equal = (expected, actual) => ({ status: expected === actual ? 'passed' : 'failed', expected, actual });
const strings = (expected, actual) => {
  const differences = expected.flatMap((value, index) => value === actual?.[index] ? [] : [{ index, expected: value, actual: actual?.[index] ?? null }]);
  return { status: expected.length === actual?.length && differences.length === 0 ? 'passed' : 'failed', count: expected.length, mismatchCount: differences.length, differences: differences.slice(0, 16) };
};
const layer = (checks) => ({ status: Object.values(checks).every((value) => value.status === 'passed') ? 'passed' : 'failed', checks });
const verdict = (layers) => ({ status: Object.values(layers).every((value) => value.status === 'passed') ? 'passed' : 'failed', firstDivergentLayer: ['bridge', 'core', 'renderer'].find((name) => layers[name]?.status === 'failed') ?? null, layers });

/** Execute unchanged declarations from the compiled production renderer bundle, not a second implementation. */
function extractRenderer(ts, text) {
  const source = ts.createSourceFile('renderer.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map(source.statements.filter((node) => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)).map((node) => [node.name?.text, node]));
  const selected = new Map();
  const add = (name) => {
    if (selected.has(name)) return;
    const node = functions.get(name);
    if (!node) throw new Error(`COMPILED_RENDERER_FUNCTION_MISSING:${name}`);
    selected.set(name, node);
    const visit = (child) => { if (ts.isIdentifier(child) && child.text !== 'mountSceneCore' && functions.has(child.text)) add(child.text); ts.forEachChild(child, visit); };
    ts.forEachChild(node, visit);
  };
  for (const name of ['buildBundleSemanticScene', 'createFlverMesh', 'groupSceneDrawItems', 'mountFlverScene']) add(name);
  const binaryStart = text.indexOf('const BASE64_INVALID_MSG =');
  const binaryEnd = functions.get('decodeBase64ToUint8Array').getStart(source);
  if (binaryStart < 0 || binaryStart >= binaryEnd) throw new Error('COMPILED_BASE64_INITIALIZATION_MISSING');
  let batch;
  const findBatch = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'addInstanceBatch') {
      if (batch) throw new Error('COMPILED_INSTANCE_BATCH_AMBIGUOUS');
      batch = node.initializer;
    }
    ts.forEachChild(node, findBatch);
  };
  findBatch(functions.get('mountSceneCore'));
  if (!batch) throw new Error('COMPILED_INSTANCE_BATCH_MISSING');
  const declarations = [...selected.values()].sort((a, b) => a.pos - b.pos).map((node) => text.slice(node.getStart(source), node.end));
  const frameOptions = source.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(source) === 'FLVER_PREVIEW_FRAME_OPTIONS'));
  if (!frameOptions) throw new Error('COMPILED_FLVER_FRAME_OPTIONS_MISSING');
  declarations.unshift(text.slice(frameOptions.getStart(source), frameOptions.end));
  const batchText = text.slice(batch.getStart(source), batch.end);
  const code = `let runtimeCore; const mountSceneCore = async () => runtimeCore;\n${text.slice(binaryStart, binaryEnd)}\n${declarations.join('\n')}\nreturn {buildBundleSemanticScene,createFlverMesh,groupSceneDrawItems, mountRuntime: (core, input) => {runtimeCore = core; return mountFlverScene(input);}, createInstanceBatch: (scope) => { const {three, meshes, renderStates, instanceBindings, placementToAllChunkBindings, updateBindingBounds, indexPlacementBounds, root2, instanceBatches} = scope; return (${batchText}); }};`;
  return {
    api: new Function(code)(),
    extraction: { declarations: [...selected.keys()], declarationSha256: hash(declarations.join('\n')), instanceBatchSha256: hash(batchText), harnessSha256: hash(code), policy: 'Unchanged AST declaration slices; scope supplies Three/maps/root and inert spatial-index callbacks. No DOM/GPU startup or source recompilation.' }
  };
}

// Independent scalar matrix math: native MSB degrees -> T * Rx * Ry * Rz * S,
// serialized column-major float32 for Three InstancedMesh.instanceMatrix.
function expectedInstanceMatrix(position, rotation, scale) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const multiply = (a, b) => Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4), col = index % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[row * 4 + k] * b[k * 4 + col], 0);
  });
  const [x, y, z] = rotation.map((v) => v * Math.PI / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const t = [...identity]; [t[3], t[7], t[11]] = position;
  const s = [...identity]; [s[0], s[5], s[10]] = scale;
  const rx = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1];
  const ry = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1];
  const rz = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const m = [t, rx, ry, rz, s].reduce(multiply);
  return Array.from({ length: 16 }, (_, i) => Math.fround(m[(i % 4) * 4 + Math.floor(i / 4)]));
}

function rowMultiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((sum, k) => sum + a[Math.floor(i / 4) * 4 + k] * b[k * 4 + i % 4], 0));
}
const NATIVE_Z_MIRROR = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

function headlessRuntimeCore(three) {
  const root = new three.Group(); root.scale.z = -1; root.updateMatrixWorld(true);
  const resources = [], meshes = new Map();
  return {
    three, root, resources, meshes, markerGroup: new three.Group(), canvas: {}, rendererBackend: 'webgl2', createDiffuseBlendMaterial: null,
    track: (value) => { resources.push(value); return value; },
    addMesh: (id, mesh) => { meshes.set(id, mesh); root.add(mesh); },
    clearContent: () => {}, frameToBounds: () => {}, setSelected: () => {}, requestRender: () => {},
    disposeAll: () => { for (const value of resources) value.dispose(); root.clear(); meshes.clear(); }
  };
}

function independentHierarchyPaths(bones) {
  const paths = new Map(), visiting = new Set(), byIndex = new Map(bones.map((bone) => [bone.index, bone]));
  const build = (bone) => {
    if (paths.has(bone.index)) return paths.get(bone.index);
    if (visiting.has(bone.index)) throw new Error('ORACLE_BONE_HIERARCHY_CYCLE');
    visiting.add(bone.index);
    const parent = byIndex.get(bone.parentIndex);
    const occurrence = bones.filter((other) => other.index < bone.index && other.parentIndex === bone.parentIndex && other.name === bone.name).length;
    const path = `${parent ? build(parent) : 'root'}/${bone.name}#${occurrence}`;
    paths.set(bone.index, path); visiting.delete(bone.index); return path;
  };
  for (const bone of bones) build(bone);
  return paths;
}

function nativeDiagnosticMetadata(bytes, meshIndex, layouts) {
  const count = (offset) => bytes.readInt32LE(offset);
  const meshStart = 128 + count(0x14) * 64 + count(0x18) * 32 + count(0x1c) * 128;
  const bufferStart = meshStart + count(0x20) * 48 + count(0x50) * 32;
  const layoutStart = bufferStart + count(0x24) * 32;
  const groups = { nativePositions: [], nativeNormals: [], colors: [], tangents: [], bitangents: [] }, semantics = { 0: 'nativePositions', 3: 'nativeNormals', 10: 'colors', 6: 'tangents', 7: 'bitangents' };
  const atMesh = meshStart + meshIndex * 48, bufferCount = count(atMesh + 40), bufferIndices = count(atMesh + 44);
  for (let bufferOrdinal = 0; bufferOrdinal < bufferCount; bufferOrdinal++) {
    const bufferIndex = count(bufferIndices + bufferOrdinal * 4);
    const layoutIndex = count(bufferStart + bufferIndex * 32 + 4), header = layoutStart + layoutIndex * 16;
    const members = count(header), memberStart = count(header + 12);
    for (let ordinal = 0; ordinal < members; ordinal++) {
      const at = memberStart + ordinal * 20, kind = semantics[count(at + 12)];
      if (!kind) continue;
      groups[kind].push({ memberOrdinal: groups[kind].length, memberIndex: count(at + 16), layoutType: count(at + 8), layoutTypeName: layouts[layoutIndex][ordinal].Type, vertexBufferIndex: bufferIndex, bufferLayoutIndex: layoutIndex, structOffset: count(at + 4) });
    }
  }
  return groups;
}

export async function compareSceneProjectionFields(productRoot, oracleRoot, observationsRoot, bridgeDll, outputRoot, matrixExpectationsPath) {
  productRoot = resolve(productRoot); oracleRoot = resolve(oracleRoot); observationsRoot = resolve(observationsRoot); outputRoot = resolve(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const binding = [];
  const bind = async (path) => { const bytes = await readFile(path); binding.push({ path, bytes: bytes.length, sha256: hash(bytes) }); return bytes; };
  const runnerBytes = await bind(fileURLToPath(import.meta.url));
  await bind(fileURLToPath(new URL('./compare-flver-independent-fields.mjs', import.meta.url)));
  const commit = execFileSync('git', ['-C', productRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const receiptPath = join(productRoot, 'apps/desktop/out/agent-production-build.json');
  const receipt = JSON.parse(await bind(receiptPath));
  const verifiedReceiptEntries = [];
  for (const path of ['packages/shared/src/scene-ir.ts', 'packages/core/src/character/characterAssembly.ts', 'packages/core/src/editing/msbBridgeRead.ts', 'apps/desktop/src/renderer/src/editors/FlverViewer.tsx', 'apps/desktop/src/renderer/src/scene/threeSceneController.ts', 'apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts', 'apps/desktop/src/renderer/src/scene/flverNativeVertexDiagnostics.ts', 'apps/desktop/src/renderer/src/utils/binary.ts']) {
    const bytes = await bind(join(productRoot, path));
    const entry = receipt.source.entries.find((value) => value.path === path);
    if (!entry || entry.sha256 !== hash(bytes)) throw new Error(`PRODUCT_SOURCE_RECEIPT_MISMATCH:${path}`);
    verifiedReceiptEntries.push(path);
  }
  const assets = join(productRoot, 'apps/desktop/out/renderer/assets');
  const assetNames = await readdir(assets);
  const rendererName = assetNames.find((name) => /^index-.*\.js$/.test(name));
  const threeName = assetNames.find((name) => /^three\.module-.*\.js$/.test(name));
  if (!rendererName || !threeName) throw new Error('COMPILED_RENDERER_ASSETS_MISSING');
  let rendererText;
  for (const name of [rendererName, threeName, ...assetNames.filter((name) => /^three\.core-.*\.js$/.test(name))]) {
    const path = `apps/desktop/out/renderer/assets/${name}`;
    const bytes = await bind(join(productRoot, path));
    const entry = receipt.output.entries.find((value) => value.path === path);
    if (!entry || entry.sha256 !== hash(bytes)) throw new Error(`PRODUCT_OUTPUT_RECEIPT_MISMATCH:${path}`);
    if (name === rendererName) rendererText = bytes.toString('utf8');
    verifiedReceiptEntries.push(path);
  }
  for (const path of ['packages/core/dist/character/characterAssembly.js', 'packages/core/dist/scene/msbSceneManifest.js', 'packages/core/dist/scene/sceneDrawList.js', 'packages/shared/dist/scene-ir.js', 'packages/shared/dist/index.js', 'package-lock.json']) await bind(join(productRoot, path));
  const require = createRequire(join(productRoot, 'package.json'));
  const tsPath = require.resolve('typescript'); await bind(tsPath);
  const ts = require('typescript');
  const { api, extraction } = extractRenderer(ts, rendererText);
  const msbReadText = (await bind(join(productRoot, 'packages/core/dist/editing/msbBridgeRead.js'))).toString('utf8');
  const msbReadSource = ts.createSourceFile('msbBridgeRead.js', msbReadText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const msbReadNode = msbReadSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'readMsbDocumentViaBridge');
  if (!msbReadNode) throw new Error('COMPILED_MSB_READER_MISSING');
  const msbReadCode = msbReadText.slice(msbReadNode.getStart(msbReadSource), msbReadNode.end).replace(/^export /, '');
  const readMsbWithBoundCapture = new Function('runBridge', `${msbReadCode}\nreturn readMsbDocumentViaBridge;`);
  extraction.coreMsbReadSha256 = hash(msbReadCode);
  extraction.coreMsbReadPolicy = 'Unchanged compiled core mapper with runBridge returning the preserved bound capture, no native reread';
  const three = await import(pathToFileURL(join(assets, threeName)).href);
  const { remapCharacterBundleToLeader } = await import(pathToFileURL(join(productRoot, 'packages/core/dist/character/characterAssembly.js')).href);
  const { buildMsbSceneManifest } = await import(pathToFileURL(join(productRoot, 'packages/core/dist/scene/msbSceneManifest.js')).href);
  const { buildSceneDrawList } = await import(pathToFileURL(join(productRoot, 'packages/core/dist/scene/sceneDrawList.js')).href);
  const inventory = JSON.parse(await bind(join(oracleRoot, 'flver-per-mesh-inventory.json')));
  if (inventory.independentOfSoulForge !== true || inventory.revision !== 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905') throw new Error('ORACLE_PROVENANCE_MISMATCH');
  const manifest = JSON.parse(await bind(join(observationsRoot, 'observation-manifest.json')));
  const captureScript = fileURLToPath(new URL('./capture-flver-bridge-observations.mjs', import.meta.url));
  if (manifest.schemaVersion !== 1 || manifest.captureScriptSha256 !== hash(await bind(captureScript)) || manifest.producerKind !== (bridgeDll.toLowerCase().endsWith('.dll') ? 'framework-dependent-dll' : 'native-executable')) throw new Error('CAPTURE_TOOL_OR_LAUNCH_RECEIPT_MISMATCH');
  if (manifest.bridgeDllSha256 !== hash(await bind(resolve(bridgeDll)))) throw new Error('BRIDGE_PRODUCER_MISMATCH');
  let matrixExpectations;
  if (matrixExpectationsPath) {
    const matrixBytes = await bind(resolve(matrixExpectationsPath));
    matrixExpectations = JSON.parse(matrixBytes);
    const verification = JSON.parse(await bind(join(dirname(resolve(matrixExpectationsPath)), 'verification.json')));
    if (verification.ok !== true || verification.exportSha256 !== hash(matrixBytes)) throw new Error('MATRIX_ORACLE_EXPORT_RECEIPT_MISMATCH');
    if (matrixExpectations.oracle?.independentOfSoulForge !== true || matrixExpectations.oracle.revision !== inventory.revision) throw new Error('MATRIX_ORACLE_PROVENANCE_MISMATCH');
    for (const record of [...matrixExpectations.oracle.sourceFiles, ...matrixExpectations.tool.sourceFiles, matrixExpectations.tool.assembly]) {
      if (hash(await bind(record.path)) !== record.sha256) throw new Error('MATRIX_ORACLE_TOOL_RECEIPT_MISMATCH');
    }
    if (hash(await bind(matrixExpectations.oracle.assemblyPath)) !== matrixExpectations.oracle.assemblySha256) throw new Error('MATRIX_ORACLE_PROVIDER_RECEIPT_MISMATCH');
  }
  const observation = async (name, resource) => {
    const bytes = await bind(join(observationsRoot, name));
    const record = manifest.observations.find((value) => value.name === name);
    if (!record || record.sha256 !== hash(bytes) || record.sourceSha256 !== resource.flverSha256 || resolve(record.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`OBSERVATION_RECEIPT_MISMATCH:${name}`);
    const mesh = name.match(/-mesh(\d+)\.json$/);
    const command = mesh ? 'read-flver-mesh' : name.endsWith('-skeleton.json') ? 'read-flver-skeleton' : name.endsWith('-document.json') ? 'read-flver-document' : 'read-flver-texture-slots';
    const expectedOptions = mesh ? { maxVertices: 1_000_000, maxIndices: 3_000_000, meshIndex: Number(mesh[1]) } : {};
    if (record.command !== command || JSON.stringify(record.commandOptions) !== JSON.stringify(expectedOptions)) throw new Error(`OBSERVATION_COMMAND_RECEIPT_MISMATCH:${name}`);
    const parsed = JSON.parse(bytes);
    if (!['partial', 'parsed'].includes(parsed.parseStatus) || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data) || !Array.isArray(parsed.diagnostics) || resolve(parsed.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`OBSERVATION_ENVELOPE_INVALID:${name}`);
    return parsed.data;
  };
  const resources = [], negatives = [], runtimeSources = [];
  for (const resource of inventory.resources) {
    const leafBytes = await bind(resource.rawLeafPath);
    if (hash(await bind(resource.source.path)) !== resource.source.sha256 || hash(leafBytes) !== resource.flverSha256) throw new Error('SOURCE_IDENTITY_MISMATCH');
    const fieldReport = JSON.parse(await bind(join(oracleRoot, `${resource.id}.chrbnd.fields.json`)));
    const leaf = fieldReport.fields.files.find((value) => value.sha256 === resource.flverSha256);
    const fields = leaf.decoded.fields;
    const skeleton = await observation(`${resource.id}-skeleton.json`, resource);
    const document = await observation(`${resource.id}-document.json`, resource);
    const textureSlots = await observation(`${resource.id}-texture-slots.json`, resource);
    const expectedTextures = fields.Materials.flatMap((material, materialIndex) => material.Textures.map((texture) => ({ materialIndex, path: texture.Path, type: texture.ParamName })));
    const textureReferenceChecks = layer({ count: equal(expectedTextures.length, textureSlots.textureCount), paths: strings(expectedTextures.map((value) => value.path), textureSlots.textures.map((value) => value.path)), types: strings(expectedTextures.map((value) => value.type), textureSlots.textures.map((value) => value.type)), materialIndices: check(expectedTextures.map((value) => value.materialIndex), textureSlots.textures.map((value) => value.materialIndex), 0) });
    const meshReports = [];
    let firstDrawableWire;
    for (let ordinal = 0; ordinal < fields.Meshes.length; ordinal++) {
      const native = fields.Meshes[ordinal];
      const raw = await observation(`${resource.id}-mesh${ordinal}.json`, resource);
      const face = native.FaceSets.find((value) => value.Flags === 'None') ?? native.FaceSets[0];
      if (face?.TriangleStrip) throw new Error('BOUNDED_CORPUS_TRIANGLE_STRIP_UNSUPPORTED');
      const expectedIndices = [];
      for (let i = 0; i < (face?.Indices.length ?? 0); i += 3) {
        const triangle = face.Indices.slice(i, i + 3);
        if (triangle.length !== 3) throw new Error('ORACLE_TRIANGLE_LIST_TRUNCATED');
        if (new Set(triangle).size === 3) expectedIndices.push(...triangle);
      }
      const expectedEmpty = !face || native.Vertices.length === 0 || expectedIndices.length === 0;
      const classification = (wire) => layer({ geometryEmpty: equal(expectedEmpty, wire.geometryEmpty === true), meshIndex: equal(ordinal, wire.meshIndex), vertexCount: equal(native.Vertices.length, wire.vertexCount), ...(expectedEmpty ? { nativeIndexCount: equal(face?.Indices.length ?? 0, wire.indexCount) } : {}) });
      if (expectedEmpty) {
        const bridge = classification(raw);
        meshReports.push({ ordinal, classification: 'empty-topology', status: bridge.status, firstDivergentLayer: bridge.status === 'failed' ? 'bridge' : null, layers: { bridge }, excludedProjectionReason: 'Independent NEXT topology is empty; no drawable core/renderer projection is applicable' });
        continue;
      }
      if (raw.geometryEmpty === true) {
        meshReports.push({ ordinal, classification: 'drawable', status: 'failed', firstDivergentLayer: 'bridge', layers: { bridge: classification(raw) }, excludedProjectionReason: 'Wrong Bridge empty flag: independent NEXT topology is drawable' });
        continue;
      }
      firstDrawableWire ??= raw;
      const skin = expectedPreviewSkinning(native.Vertices, native, leaf.decoded.version, fields.Nodes.length);
      const expected = {
        positions: native.Vertices.flatMap((v) => v.Position.slice(0, 3)), normals: native.Vertices.flatMap((v) => v.Normal.slice(0, 3)), indices: expectedIndices,
        uvs: Array.from({ length: native.Vertices[0].UVs.length }, (_, set) => native.Vertices.flatMap((v) => v.UVs[set].slice(0, 2))),
        alpha: native.Vertices.map((v) => v.Colors[0].A), weights: skin.weights, boneIndices: skin.indices,
        nativePositions: Array.from({ length: native.Vertices[0].Positions.length }, (_, set) => native.Vertices.flatMap((v) => v.Positions[set])),
        nativeNormals: Array.from({ length: native.Vertices[0].Normals.length }, (_, set) => native.Vertices.flatMap((v) => v.Normals[set])),
        normalWs: Array.from({ length: native.Vertices[0].NormalWs.length }, (_, set) => native.Vertices.map((v) => v.NormalWs[set])),
        colors: Array.from({ length: native.Vertices[0].Colors.length }, (_, set) => native.Vertices.flatMap((v) => { const c = v.Colors[set]; return [c.R, c.G, c.B, c.A]; })),
        tangents: Array.from({ length: native.Vertices[0].Tangents.length }, (_, set) => native.Vertices.flatMap((v) => v.Tangents[set])),
        bitangents: native.VertexBuffers.some((vb) => fields.BufferLayouts[vb.LayoutIndex].some((m) => m.Semantic === 'Bitangent')) ? [native.Vertices.flatMap((v) => v.Bitangent)] : []
      };
      const compareMesh = (data, normalizedWeights = false) => {
        const weights = normalizedWeights ? expected.weights.map((v, i) => { const start = Math.floor(i / 4) * 4; const sum = expected.weights.slice(start, start + 4).reduce((a, b) => a + b, 0); return Math.fround(v / sum); }) : expected.weights;
        const checks = { positions: check(expected.positions, data.positions), normals: check(expected.normals, data.normals), indices: check(expected.indices, data.indices, 0), alpha: check(expected.alpha, data.alpha), weights: check(weights, data.weights), boneIndices: check(expected.boneIndices, data.boneIndices, 0), uvSetCount: equal(expected.uvs.length, data.uvs?.length), vertexCount: equal(native.Vertices.length, data.vertexCount), cullBackfaces: equal(face.CullBackfaces, data.cullBackfaces) };
        const metadata = nativeDiagnosticMetadata(leafBytes, ordinal, fields.BufferLayouts);
        for (let set = 0; set < expected.uvs.length; set++) checks[`uv${set}`] = check(expected.uvs[set], data.uvs?.[set]);
        for (const kind of ['nativePositions', 'nativeNormals', 'colors', 'tangents', 'bitangents']) {
          checks[`${kind}Count`] = equal(expected[kind].length, data[kind]?.length ?? 0);
          checks[`${kind}Status`] = equal(expected[kind].length ? 'decoded' : 'absent', data[`${kind}Status`]);
          for (let set = 0; set < expected[kind].length; set++) checks[`${kind}${set}`] = check(expected[kind][set], data[kind]?.[set]);
          checks[`${kind}Metadata`] = strings(metadata[kind].map((value) => JSON.stringify(value)), (data[`${kind}Metadata`] ?? []).map((value) => JSON.stringify(Object.fromEntries(Object.keys(metadata[kind][0] ?? {}).map((key) => [key, value[key]])))));
        }
        checks.normalWCount = equal(expected.normalWs.length, data.normalWs?.length ?? 0);
        for (let set = 0; set < expected.normalWs.length; set++) checks[`normalW${set}`] = check(expected.normalWs[set], data.normalWs?.[set], 0);
        return layer(checks);
      };
      const wireFields = (wire) => ({ positions: decode(wire.positionsBase64), normals: decode(wire.normalsBase64), indices: decode(wire.indicesBase64, wire.indexSize === 32 ? 'u32' : 'u16'), alpha: decode(wire.vertexAlphaBase64), weights: decode(wire.boneWeightsBase64), boneIndices: decode(wire.boneIndicesBase64, 'u16'), uvs: wire.uvSetsBase64.map((v) => decode(v)), vertexCount: wire.vertexCount, cullBackfaces: wire.cullBackfaces, colors: wire.vertexColorDiagnostics?.map((v) => decode(v.rgbaBase64)), tangents: wire.tangentDiagnostics?.map((v) => decode(v.xyzwBase64)), bitangents: wire.bitangentDiagnostics?.map((v) => decode(v.xyzwBase64)), nativePositions: wire.positionDiagnostics?.map((v) => decode(v.xyzBase64)), nativeNormals: wire.normalDiagnostics?.map((v) => decode(v.xyzBase64)), normalWs: wire.normalDiagnostics?.filter((v) => v.normalWBase64 !== undefined).map((v) => decode(v.normalWBase64, 'i32')), nativePositionsMetadata: wire.positionDiagnostics, nativeNormalsMetadata: wire.normalDiagnostics, colorsMetadata: wire.vertexColorDiagnostics, tangentsMetadata: wire.tangentDiagnostics, bitangentsMetadata: wire.bitangentDiagnostics });
      const diagnosticStatuses = (data, source) => Object.assign(data, { nativePositionsStatus: source.positionStatus, nativeNormalsStatus: source.normalStatus, colorsStatus: source.vertexColorStatus, tangentsStatus: source.tangentStatus, bitangentsStatus: source.bitangentStatus });
      const project = (wire) => {
        const classified = classification(wire);
        if (classified.status !== 'passed') return { status: 'failed', firstDivergentLayer: 'bridge', layers: { bridge: classified, core: { status: 'unverified', reason: 'WRONG_BRIDGE_CLASSIFICATION_BLOCKS_PROJECTION' }, renderer: { status: 'unverified', reason: 'WRONG_BRIDGE_CLASSIFICATION_BLOCKS_PROJECTION' } } };
        const model = { modelId: resource.id, entry: { name: resource.id }, meshes: [{ ...wire, skinningMode: 'weighted', boneIndexSpace: 'flver-global' }], meshCount: 1, bones: skeleton.bones, boneCount: skeleton.boneCount };
        const core = remapCharacterBundleToLeader(model, []);
        if (!core.ok) throw new Error('CORE_CHARACTER_PROJECTION_FAILED');
        const semantic = api.buildBundleSemanticScene(core.bundle, document.boundingBox);
        const item = semantic.meshes[0];
        const tracked = [];
        const mesh = api.createFlverMesh(three, (value) => { tracked.push(value); return value; }, item, null, undefined, 'webgl2', true);
        const geometry = mesh.geometry;
        const geometryFields = { positions: geometry.getAttribute('position')?.array, normals: geometry.getAttribute('normal')?.array, indices: geometry.index?.array, alpha: geometry.getAttribute('soulforgeVertexAlpha')?.array, weights: geometry.getAttribute('skinWeight')?.array, boneIndices: geometry.getAttribute('skinIndex')?.array, uvs: expected.uvs.map((_, i) => geometry.getAttribute(i === 0 ? 'uv' : `soulforgeUv${i}`)?.array), vertexCount: geometry.getAttribute('position').count, cullBackfaces: mesh.material.side === three.BackSide, nativePositions: expected.nativePositions.map((_, i) => geometry.getAttribute(`soulforgePosition${i}`)?.array), nativeNormals: expected.nativeNormals.map((_, i) => geometry.getAttribute(`soulforgeNormal${i}`)?.array), normalWs: expected.normalWs.map((_, i) => geometry.getAttribute(`soulforgeNormalW${i}`)?.array), colors: expected.colors.map((_, i) => geometry.getAttribute(`soulforgeVertexColor${i}`)?.array), tangents: expected.tangents.map((_, i) => geometry.getAttribute(`soulforgeTangent${i}`)?.array), bitangents: expected.bitangents.map((_, i) => geometry.getAttribute(`soulforgeBitangent${i}`)?.array) };
        geometryFields.nativePositionsMetadata = geometry.userData.positionDiagnostics;
        geometryFields.nativeNormalsMetadata = geometry.userData.normalDiagnostics;
        geometryFields.colorsMetadata = geometry.userData.vertexColorDiagnostics;
        geometryFields.tangentsMetadata = geometry.userData.tangentDiagnostics;
        geometryFields.bitangentsMetadata = geometry.userData.bitangentDiagnostics;
        diagnosticStatuses(geometryFields, geometry.userData);
        const result = verdict({ bridge: compareMesh(diagnosticStatuses(wireFields(wire), wire)), core: compareMesh(diagnosticStatuses(wireFields(core.bundle.models[0].meshes[0]), core.bundle.models[0].meshes[0])), renderer: compareMesh(geometryFields, true) });
        for (const [name, bones] of [['bridge', skeleton.bones], ['core', core.bundle.models[0].bones], ['renderer', semantic.skeletons[0].bones]]) {
          const checks = result.layers[name].checks;
          checks.boneCount = equal(fields.Nodes.length, bones.length);
          checks.boneParents = check(fields.Nodes.map((v) => v.ParentIndex), bones.map((v) => v.parentIndex), 0);
          checks.boneNames = strings(fields.Nodes.map((v) => v.Name), bones.map((v) => v.name));
          for (const [nativeKey, key] of [['Translation', 'translation'], ['Rotation', 'rotation'], ['Scale', 'scale']]) checks[`bone${nativeKey}`] = check(flatten(fields.Nodes.map((v) => v[nativeKey])), flatten(bones.map((v) => v[key])));
          if (matrixExpectations) {
            const reference = matrixExpectations.resources.find((v) => v.id === resource.id);
            if (reference.rawLeaf.sha256 !== resource.flverSha256 || reference.source.sha256 !== resource.source.sha256) throw new Error('MATRIX_ORACLE_CORPUS_MISMATCH');
            checks.referenceFK = check(flatten(reference.bones.map((v) => v.referenceFK)), flatten(bones.map((v) => v.referenceFkMatrix ?? [])), 0);
          }
          result.layers[name].status = Object.values(checks).every((v) => v.status === 'passed') ? 'passed' : 'failed';
        }
        result.layers.bridge.checks.materialIndex = equal(native.MaterialIndex, wire.materialIndex);
        result.layers.core.checks.materialIndex = equal(native.MaterialIndex, core.bundle.models[0].meshes[0].materialIndex);
        for (const name of ['bridge', 'core']) result.layers[name].status = Object.values(result.layers[name].checks).every((v) => v.status === 'passed') ? 'passed' : 'failed';
        result.status = Object.values(result.layers).every((v) => v.status === 'passed') ? 'passed' : 'failed';
        result.firstDivergentLayer = ['bridge', 'core', 'renderer'].find((name) => result.layers[name].status === 'failed') ?? null;
        result.rendererInput = { semantic: 'production buildBundleSemanticScene', geometry: 'production createFlverMesh -> Three BufferGeometry', skinWeightPolicy: 'four influences normalized independently from oracle raw weights', skeletonCount: semantic.skeletons[0].bones.length, materialType: mesh.material.type, side: mesh.material.side, zMirror: 'caller root transform; native cull policy inspected; reference world/bind matrices compared separately, sampled animation poses unverified' };
        for (const value of tracked) value.dispose();
        return result;
      };
      const result = project(raw);
      meshReports.push({ ordinal, classification: 'drawable', ...result });
      if (expected.nativePositions.length > 1) {
        const wrong = structuredClone(raw);
        const bytes = Buffer.from(wrong.positionDiagnostics[1].xyzBase64, 'base64');
        bytes.writeFloatLE(bytes.readFloatLE(0) + 0.25, 0); wrong.positionDiagnostics[1].xyzBase64 = bytes.toString('base64');
        const bad = project(wrong);
        negatives.push({ id: `${resource.id}:mesh${ordinal}:nativePosition1`, injection: 'Second native position member X +0.25 at Bridge, primary positions unchanged', expectedFirstDivergentLayer: 'bridge', ...bad, negativePassed: bad.firstDivergentLayer === 'bridge' && ['bridge', 'core', 'renderer'].every((name) => bad.layers[name].status === 'failed') });
      }
      if (!negatives.some((value) => value.id === `${resource.id}:positions`)) {
        const bytes = Buffer.from(raw.positionsBase64, 'base64'); bytes.writeFloatLE(bytes.readFloatLE(0) + 0.25, 0);
        const bad = project({ ...raw, positionsBase64: bytes.toString('base64') });
        negatives.push({ id: `${resource.id}:positions`, injection: 'Bound Bridge positionsBase64 first x +0.25 in memory; original capture and receipts unchanged', expectedFirstDivergentLayer: 'bridge', ...bad, negativePassed: bad.firstDivergentLayer === 'bridge' && ['bridge', 'core', 'renderer'].every((name) => bad.layers[name].status === 'failed') });
        const wrongEmpty = project({ ...raw, geometryEmpty: true });
        negatives.push({ id: `${resource.id}:false-empty`, injection: 'Drawable Bridge mesh marked geometryEmpty=true in memory', expectedFirstDivergentLayer: 'bridge', ...wrongEmpty, negativePassed: wrongEmpty.status === 'failed' && wrongEmpty.firstDivergentLayer === 'bridge' });
      }
    }
    let runtimeBinding;
    if (matrixExpectations && firstDrawableWire) {
      const reference = matrixExpectations.resources.find((v) => v.id === resource.id);
      const runtimeCheck = async (boneWire, follower = false) => {
        const leaderId = `${resource.id}:leader`, followerId = `${resource.id}:follower`;
        const model = { modelId: leaderId, entry: { name: resource.id }, meshes: [{ ...firstDrawableWire, skinningMode: 'weighted', boneIndexSpace: 'flver-global' }], meshCount: 1, bones: boneWire, boneCount: boneWire.length };
        // The same fixed native asset occupies two namespaces to exercise the
        // follower mechanism. This is a controlled assembly, not game equipment.
        const part = { ...model, modelId: followerId, sourceRole: 'part' };
        const core = remapCharacterBundleToLeader(model, follower ? [part] : []);
        if (!core.ok) throw new Error('CORE_FOLLOWER_PROJECTION_FAILED');
        const semantic = api.buildBundleSemanticScene(core.bundle, document.boundingBox);
        const runtimeCore = headlessRuntimeCore(three);
        const handle = await api.mountRuntime(runtimeCore, { scene: semantic });
        const meshId = `${follower ? followerId : leaderId}:mesh:${firstDrawableWire.meshIndex}`;
        const mesh = runtimeCore.meshes.get(meshId);
        if (!mesh?.isSkinnedMesh) throw new Error('RUNTIME_SKINNED_MESH_UNOBSERVED');
        const expectedWorld = reference.bones.flatMap((bone) => rowMultiply(bone.referenceFK, NATIVE_Z_MIRROR));
        const expectedInverse = reference.bones.flatMap((bone) => rowMultiply(NATIVE_Z_MIRROR, bone.inverseReferenceFK));
        const actualWorld = mesh.skeleton.bones.flatMap((bone) => [...bone.matrixWorld.elements]);
        const actualInverse = mesh.skeleton.boneInverses.flatMap((matrix) => [...matrix.elements]);
        const checks = {
          worldReferenceFK: check(expectedWorld, actualWorld, 1e-5), inverseReferenceBind: check(expectedInverse, actualInverse, 1e-5),
          meshBindMatrix: check(NATIVE_Z_MIRROR, mesh.bindMatrix.elements, 0),
          boneCount: equal(reference.bones.length, mesh.skeleton.bones.length),
          boneNames: strings(reference.bones.map((bone) => bone.name), mesh.skeleton.bones.map((bone) => bone.name))
        };
        const coreChecks = { referenceFK: check(reference.bones.flatMap((bone) => bone.referenceFK), core.bundle.models[0].bones.flatMap((bone) => bone.referenceFkMatrix ?? []), 0) };
        if (follower) {
          const projectedPart = core.bundle.models.find((value) => value.modelId === followerId);
          coreChecks.followerBoneMap = check(reference.bones.map((bone) => bone.index), projectedPart.bindingBoneMap, 0);
          coreChecks.followerReferenceFK = check(reference.bones.flatMap((bone) => bone.referenceFK), projectedPart.bindingBones.flatMap((bone) => bone.referenceFkMatrix ?? []), 0);
          coreChecks.sourceInfluences = strings([firstDrawableWire.boneIndicesBase64], [projectedPart.meshes[0].sourceBoneIndicesBase64]);
        }
        handle.dispose();
        return verdict({ bridge: layer({ referenceFK: check(reference.bones.flatMap((bone) => bone.referenceFK), boneWire.flatMap((bone) => bone.referenceFkMatrix ?? []), 0) }), core: layer(coreChecks), renderer: layer(checks) });
      };
      runtimeBinding = { standalone: await runtimeCheck(skeleton.bones), identityFollower: await runtimeCheck(skeleton.bones, true), scope: 'Actual compiled mountFlverScene and Three Skeleton/SkinnedMesh with headless mount core; independent official FK/inverse expectations and explicit Z mirror. Controlled same-asset follower namespaces, not game-confirmed equipment or sampled HKX pose.' };
      const badBones = skeleton.bones.map((bone, i) => i === 0 ? { ...bone, referenceFkMatrix: bone.referenceFkMatrix.map((value, k) => k === 12 ? value + 0.25 : value) } : bone);
      const badFk = await runtimeCheck(badBones);
      negatives.push({ id: `${resource.id}:referenceFK`, injection: 'Bound Bridge bone0 reference FK translation X +0.25 in memory', expectedFirstDivergentLayer: 'bridge', ...badFk, negativePassed: badFk.firstDivergentLayer === 'bridge' && ['bridge', 'core', 'renderer'].every((name) => badFk.layers[name].status === 'failed') });
    }
    resources.push({ id: resource.id, sourceSha256: resource.source.sha256, leafSha256: resource.flverSha256, meshes: meshReports, textureReferences: { bridge: textureReferenceChecks, downstream: 'Material/shader binding outside this leaf-based neutral preview comparison' }, runtimeBinding, projectionScope: 'compiled core DTO and actual renderer geometry/native reference binding; controlled identity-follower assembly when independent matrix expectations are supplied' });
    runtimeSources.push({ resource, skeleton, wire: firstDrawableWire, nativeMesh: fields.Meshes[firstDrawableWire?.meshIndex], version: leaf.decoded.version });
  }

  let crossSourceFollower;
  if (matrixExpectations && runtimeSources.length === 2) {
    const leader = runtimeSources.find((value) => value.resource.id === 'c4510');
    const follower = runtimeSources.find((value) => value.resource.id === 'c5030');
    const model = (source) => ({ modelId: source.resource.id, entry: { name: source.resource.id }, bones: source.skeleton.bones, boneCount: source.skeleton.bones.length, meshCount: 1, meshes: [{ ...source.wire, skinningMode: 'weighted', boneIndexSpace: 'flver-global' }] });
    const result = remapCharacterBundleToLeader(model(leader), [model(follower)]);
    if (!result.ok) throw new Error('CONTROLLED_CROSS_SOURCE_ASSEMBLY_FAILED');
    const projectedLeader = result.bundle.models[0], projectedFollower = result.bundle.models[1];
    const leaderReference = matrixExpectations.resources.find((value) => value.id === leader.resource.id).bones;
    const followerReference = matrixExpectations.resources.find((value) => value.id === follower.resource.id).bones;
    const leaderPaths = independentHierarchyPaths(leaderReference), followerPaths = independentHierarchyPaths(followerReference);
    const pathToIndex = new Map([...leaderPaths].map(([index, path]) => [path, index]));
    const originalByName = new Map();
    for (const bone of leaderReference) { const entries = originalByName.get(bone.name) ?? []; entries.push(bone.index); originalByName.set(bone.name, entries); }
    const mapping = projectedFollower.bindingBoneMap, mappingDifferences = [];
    const independentSkin = expectedPreviewSkinning(follower.nativeMesh.Vertices, follower.nativeMesh, follower.version, followerReference.length);
    const requiredMapped = new Set();
    for (let i = 0; i < independentSkin.weights.length; i++) if (independentSkin.weights[i] > 1e-6) {
      let index = independentSkin.indices[i];
      while (index >= 0 && !requiredMapped.has(index)) { requiredMapped.add(index); index = followerReference[index].parentIndex; }
    }
    const mapAdmission = (map) => {
      const errors = [];
      if (!Array.isArray(map) || map.length !== followerReference.length) errors.push({ reason: 'MAP_LENGTH' });
      for (const bone of followerReference) {
        const value = map?.[bone.index];
        if (!Number.isSafeInteger(value) || value < -1 || value >= projectedLeader.bones.length) errors.push({ index: bone.index, reason: 'MAP_VALUE_RANGE' });
        if (requiredMapped.has(bone.index) && !(Number.isSafeInteger(value) && value >= 0)) errors.push({ index: bone.index, reason: 'WEIGHTED_BONE_OR_PARENT_UNMAPPED' });
      }
      return errors;
    };
    mappingDifferences.push(...mapAdmission(mapping));
    const targetByIndex = new Map(projectedLeader.bones.map((bone) => [bone.index, bone]));
    for (const bone of followerReference) {
      const exact = pathToIndex.get(followerPaths.get(bone.index));
      const named = originalByName.get(bone.name) ?? [];
      const expectedOriginal = exact ?? (named.length === 1 ? named[0] : undefined);
      const target = targetByIndex.get(mapping[bone.index]);
      if (expectedOriginal !== undefined && mapping[bone.index] !== expectedOriginal) mappingDifferences.push({ index: bone.index, reason: 'ORIGINAL_NAMESPACE_MAP', expected: expectedOriginal, actual: mapping[bone.index] });
      else if (mapping[bone.index] >= 0 && expectedOriginal === undefined) {
        const parent = bone.parentIndex >= 0 ? mapping[bone.parentIndex] : -1;
        if (mapping[bone.index] < leaderReference.length || target?.name !== bone.name || target?.parentIndex !== parent || check(bone.referenceFK, target?.referenceFkMatrix, 0).status !== 'passed') mappingDifferences.push({ index: bone.index, reason: 'APPENDED_SOURCE_IDENTITY_OR_BIND' });
      }
    }
    const semantic = api.buildBundleSemanticScene(result.bundle);
    const runtimeCore = headlessRuntimeCore(three), handle = await api.mountRuntime(runtimeCore, { scene: semantic });
    const mesh = runtimeCore.meshes.get(`${follower.resource.id}:mesh:${follower.wire.meshIndex}`);
    if (!mesh?.isSkinnedMesh) throw new Error('CROSS_SOURCE_FOLLOWER_MESH_UNOBSERVED');
    const expectedCurrent = new Map(), byIndex = new Map(followerReference.map((bone) => [bone.index, bone]));
    const buildCurrent = (bone) => {
      if (expectedCurrent.has(bone.index)) return expectedCurrent.get(bone.index);
      const target = mapping[bone.index];
      const current = target >= 0
        ? rowMultiply(target < leaderReference.length ? leaderReference[target].referenceFK : bone.referenceFK, NATIVE_Z_MIRROR)
        : rowMultiply(bone.localMatrix, bone.parentIndex >= 0 ? buildCurrent(byIndex.get(bone.parentIndex)) : NATIVE_Z_MIRROR);
      expectedCurrent.set(bone.index, current); return current;
    };
    const checks = {
      worldDirectBoneMap: check(followerReference.flatMap(buildCurrent), mesh.skeleton.bones.flatMap((bone) => [...bone.matrixWorld.elements]), 1e-5),
      inverseSourceBind: check(followerReference.flatMap((bone) => rowMultiply(NATIVE_Z_MIRROR, bone.inverseReferenceFK)), mesh.skeleton.boneInverses.flatMap((matrix) => [...matrix.elements]), 1e-5),
      sourceInfluenceIndices: strings([follower.wire.boneIndicesBase64], [projectedFollower.meshes[0].sourceBoneIndicesBase64]),
      namespaceMap: { status: mappingDifferences.length ? 'failed' : 'passed', mismatchCount: mappingDifferences.length, differences: mappingDifferences.slice(0, 16) }
    };
    handle.dispose();
    crossSourceFollower = { ...layer(checks), leaderId: leader.resource.id, followerId: follower.resource.id, sourceHashes: [leader.resource.source.sha256, follower.resource.source.sha256], originalLeaderNodes: leaderReference.length, appendedSourceNodes: projectedLeader.bones.length - leaderReference.length, mappedFollowerNodes: mapping.filter((index) => index >= 0).length, unmappedFollowerNodes: mapping.filter((index) => index < 0).length, scope: 'Controlled c4510 leader/c5030 follower mechanism check, not game equipment. Original namespace matches derive from independent hierarchy/name fields; appended identities/binds are validated against independent source rows. Numeric append order is not independently attested.' };
    crossSourceFollower.requiredWeightedAndParentNodes = requiredMapped.size;
    const omitted = [...mapping], requiredIndex = [...requiredMapped].find((index) => mapping[index] >= leaderReference.length) ?? [...requiredMapped][0];
    omitted[requiredIndex] = -1;
    const omissionErrors = mapAdmission(omitted);
    negatives.push({ id: 'cross-source-follower:map-omission', injection: `Core mapping for required source bone ${requiredIndex} changed to -1 after projection`, expectedFirstDivergentLayer: 'core', firstDivergentLayer: omissionErrors.length ? 'core' : null, status: omissionErrors.length ? 'failed' : 'passed', errors: omissionErrors, negativePassed: omissionErrors.some((error) => error.index === requiredIndex && error.reason === 'WEIGHTED_BONE_OR_PARENT_UNMAPPED') });
  }

  const msbOracle = JSON.parse(await bind(join(oracleRoot, 'm13_00_00_00.msbs.fields.json')));
  const msbSource = await bind(msbOracle.source.path);
  if (hash(msbSource) !== msbOracle.source.sha256) throw new Error('MSB_SOURCE_IDENTITY_MISMATCH');
  // This existing source is DFLT. Validate the whole decoded hash before
  // inspecting names; do not strip suffixes or substitute Bridge labels.
  const dca = msbSource.subarray(0, 96).indexOf(Buffer.from('DCA\0'));
  if (msbSource.subarray(0, 4).toString('ascii') !== 'DCX\0' || !msbSource.subarray(0, 68).includes(Buffer.from('DFLT')) || dca < 0 || msbSource.readUInt32BE(dca + 4) !== 8) throw new Error('MSB_RAW_NAME_DFLT_INPUT_REQUIRED');
  const decodedMsb = inflateSync(msbSource.subarray(dca + 8), { maxOutputLength: 4_000_000 });
  if (hash(decodedMsb) !== msbOracle.decoded.sha256) throw new Error('MSB_RAW_NAME_DECODED_HASH_MISMATCH');
  const msbCaptureBytes = await bind(join(observationsRoot, 'msb.json'));
  const msbRecord = manifest.observations.find((value) => value.name === 'msb.json');
  if (!msbRecord || msbRecord.command !== 'read-msb-document' || JSON.stringify(msbRecord.commandOptions) !== '{}' || msbRecord.sha256 !== hash(msbCaptureBytes) || msbRecord.sourceSha256 !== msbOracle.source.sha256 || msbRecord.decodedSourceSha256 !== msbOracle.decoded.sha256 || resolve(msbRecord.sourcePath) !== resolve(msbOracle.source.path)) throw new Error('MSB_OBSERVATION_RECEIPT_MISMATCH');
  const msb = JSON.parse(msbCaptureBytes).data;
  if (msb.sourceHash !== msbOracle.decoded.sha256) throw new Error('MSB_DECODED_SOURCE_MISMATCH');
  const nativeParts = msbOracle.fields.parts.map((v) => v.entry), nativeRegions = msbOracle.fields.regions.map((v) => v.entry);
  const nameAdaptations = [], rawLabels = [];
  for (const [family, entries, captured] of [['parts', nativeParts, msb.parts], ['regions', nativeRegions, msb.regions]]) {
    const occurrences = new Map();
    for (let ordinal = 0; ordinal < entries.length; ordinal++) {
      const offset = captured[ordinal].nativeOffset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > decodedMsb.length) throw new Error('MSB_RAW_NAME_RECORD_OFFSET_INVALID');
      const relative = Number(decodedMsb.readBigInt64LE(offset));
      const start = offset + relative;
      if (!Number.isSafeInteger(start) || relative <= 0 || start < 0 || start + 2 > decodedMsb.length) throw new Error('MSB_RAW_NAME_OFFSET_INVALID');
      let end = start;
      while (end + 2 <= decodedMsb.length && end - start <= 1024 && decodedMsb.readUInt16LE(end) !== 0) end += 2;
      if (end + 2 > decodedMsb.length || end - start > 1024) throw new Error('MSB_RAW_NAME_UNTERMINATED');
      const rawBytes = decodedMsb.subarray(start, end), nativeName = rawBytes.toString('utf16le');
      const occurrence = (occurrences.get(nativeName) ?? 0) + 1; occurrences.set(nativeName, occurrence);
      if (entries[ordinal].Name !== nativeName) {
        if (occurrence < 2 || entries[ordinal].Name !== `${nativeName} {${occurrence}}`) throw new Error('ORACLE_NATIVE_NAME_MISMATCH');
        nameAdaptations.push({ family, ordinal, recordOffset: offset, nativeNameByteOffset: start, nativeName, oracleDisplayName: entries[ordinal].Name, occurrence, utf16leBytesSha256: hash(rawBytes), rationale: 'Pinned NEXT read-time duplicate-name disambiguation; exact native bytes independently checked, genuine native suffixes are retained' });
      }
      rawLabels.push(nativeName);
    }
  }
  const policySource = join(oracleRoot, `../SoulsFormatsNEXT-${inventory.revision}/SoulsFormats/Formats/MSB/MSB.cs`);
  const regionSource = join(oracleRoot, `../SoulsFormatsNEXT-${inventory.revision}/SoulsFormats/Formats/MSB/MSBS/PointParam.cs`);
  await bind(policySource); await bind(regionSource);
  const expectedNodes = [...nativeParts, ...nativeRegions].map((entry, i) => ({ label: rawLabels[i], kind: i < nativeParts.length ? 'msb-part' : 'msb-region', position: entry.Position, rotation: entry.Rotation, scale: entry.Scale ?? [1, 1, 1], ...(i < nativeParts.length ? { modelName: entry.ModelName } : {}) }));
  const projectMsb = async (wire) => {
    const metadata = { sourceUri: 'soul://sekiro/map/mapstudio/m13_00_00_00.msb.dcx', sourcePath: 'map/mapstudio/m13_00_00_00.msb.dcx', revision: msbOracle.decoded.sha256, game: 'sekiro', resourceKind: 'map' };
    const coreRead = await readMsbWithBoundCapture(async () => ({ parseStatus: 'partial', data: wire, diagnostics: [] }))({ sourcePath: msbOracle.source.path, allowedRoots: [resolve(msbOracle.source.path, '..')] });
    if (!coreRead.ok) throw new Error('CORE_MSB_READ_PROJECTION_FAILED');
    const projected = coreRead.data;
    const manifest = buildMsbSceneManifest({ ...metadata, models: projected.models, parts: projected.parts, regions: projected.regions, events: projected.events, routes: projected.routes });
    const draw = buildSceneDrawList(manifest);
    const checksForNodes = (nodes) => {
      const checks = { nodeCount: equal(expectedNodes.length, nodes.length), positions: check(flatten(expectedNodes.map((v) => v.position)), flatten(nodes.map((v) => v.position))), rotations: check(flatten(expectedNodes.map((v) => v.rotation)), flatten(nodes.map((v) => v.rotation))), scales: check(flatten(expectedNodes.map((v) => v.scale)), flatten(nodes.map((v) => v.scale))), labels: strings(expectedNodes.map((v) => v.label), nodes.map((v) => v.label)) };
      return layer(checks);
    };
    const rawNodes = [...wire.parts, ...wire.regions].map((v) => ({ label: v.name, position: [v.posX, v.posY, v.posZ], rotation: [v.rotX ?? 0, v.rotY ?? 0, v.rotZ ?? 0], scale: [v.scaleX ?? 1, v.scaleY ?? 1, v.scaleZ ?? 1] }));
    const scope = { three, root2: new three.Group(), meshes: new Map(), renderStates: new Map(), instanceBindings: new Map(), placementToAllChunkBindings: new Map(), instanceBatches: new Map(), updateBindingBounds: () => {}, indexPlacementBounds: () => {} };
    const addBatch = api.createInstanceBatch(scope);
    const geometry = new three.BoxGeometry(1, 1, 1), material = new three.MeshBasicMaterial();
    for (const batch of api.groupSceneDrawItems(draw.items)) addBatch(batch.key, batch.items, geometry, material);
    const observedMatrices = draw.items.flatMap((item) => { const binding = scope.instanceBindings.get(item.id); return Array.from(binding.mesh.instanceMatrix.array.slice(binding.instanceIndex * 16, binding.instanceIndex * 16 + 16)); });
    const expectedMatrices = expectedNodes.flatMap((item) => expectedInstanceMatrix(item.position, item.rotation, item.scale));
    const renderer = checksForNodes(draw.items);
    renderer.checks.instanceMatrices = check(expectedMatrices, observedMatrices, 1e-5);
    renderer.checks.modelNames = strings(expectedNodes.map((v) => v.modelName ?? null), draw.items.map((v) => v.modelName ?? null));
    renderer.status = Object.values(renderer.checks).every((v) => v.status === 'passed') ? 'passed' : 'failed';
    const coreLayer = checksForNodes(manifest.nodes);
    const expectedCounts = ['models', 'parts', 'regions', 'events', 'routes'].map((key) => msbOracle.fields[key].length);
    coreLayer.checks.sourceCounts = check(expectedCounts, ['models', 'parts', 'regions', 'events', 'routes'].map((key) => manifest.sourceCounts[key]), 0);
    coreLayer.checks.modelIndices = check(nativeParts.map((v) => v['native:ModelIndex']), manifest.nodes.filter((v) => v.kind === 'msb-part').map((v) => v.modelIndex), 0);
    coreLayer.status = Object.values(coreLayer.checks).every((v) => v.status === 'passed') ? 'passed' : 'failed';
    geometry.dispose(); material.dispose(); for (const batch of scope.instanceBatches.values()) batch.mesh.dispose();
    return verdict({ bridge: checksForNodes(rawNodes), core: coreLayer, renderer });
  };
  const mapReport = await projectMsb(msb);
  const badMsb = await projectMsb({ ...msb, parts: msb.parts.map((v, i) => i === 0 ? { ...v, posX: v.posX + 0.25 } : v) });
  negatives.push({ id: 'MSB:part0.posX', expectedFirstDivergentLayer: 'bridge', ...badMsb, negativePassed: badMsb.firstDivergentLayer === 'bridge' && ['bridge', 'core', 'renderer'].every((name) => badMsb.layers[name].status === 'failed') });
  const changed = [];
  for (const record of binding) if (hash(await readFile(record.path)) !== record.sha256) changed.push(record.path);
  if (execFileSync('git', ['-C', productRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) changed.push('PRODUCT_COMMIT_CHANGED');
  if (changed.length) throw new Error(`BOUND_INPUT_CHANGED:${changed.join(',')}`);
  const resourcePass = (resource) => resource.meshes.every((mesh) => mesh.status === 'passed')
    && resource.textureReferences.bridge.status === 'passed'
    && (!resource.runtimeBinding || (resource.runtimeBinding.standalone.status === 'passed' && resource.runtimeBinding.identityFollower.status === 'passed'));
  const report = {
    schemaVersion: 2,
    status: resources.every(resourcePass) && mapReport.status === 'passed' && (!crossSourceFollower || crossSourceFollower.status === 'passed') && negatives.every((negative) => negative.negativePassed) ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(), productCommit: commit,
    comparisonScriptSha256: hash(runnerBytes), bridgeProducerSha256: manifest.bridgeDllSha256,
    producerKind: manifest.producerKind, captureScriptSha256: manifest.captureScriptSha256,
    oracle: { provider: inventory.provider, revision: inventory.revision, license: inventory.license, independentOfSoulForge: true, lineageLimit: 'Independent pinned external execution, shared documented format lineage' },
    matrixOracle: matrixExpectations ? { source: resolve(matrixExpectationsPath), provider: matrixExpectations.oracle.provider, revision: matrixExpectations.oracle.revision, assemblySha256: matrixExpectations.oracle.assemblySha256, convention: matrixExpectations.matrixConvention } : { status: 'unverified', reason: 'MATRIX_EXPECTATIONS_NOT_SUPPLIED' },
    buildReceipt: { path: receiptPath, generatedAt: receipt.generatedAt, sourceHash: receipt.source.sha256, outputHash: receipt.output.sha256, verifiedReceiptEntries },
    rendererExecution: { input: 'Current compiled production renderer build output', execution: 'CPU execution of unchanged source declaration slices with actual Three geometry/runtime scene objects', packagedApp: 'Not bound by this comparison', gpu: 'No GPU execution or draw pixels' },
    rendererExtraction: { ...extraction, policy: 'Unchanged compiled production renderer AST declarations including mountFlverScene. Headless mount core supplies real Three/root/resources and omits DOM/GPU/camera/spatial-index startup; no source recompilation.' },
    inputs: binding, resources, crossSourceFollower,
    msb: { sourceSha256: msbOracle.source.sha256, decodedSha256: msbOracle.decoded.sha256, observationSha256: hash(msbCaptureBytes), captureProducer: 'Same receipt-bound native producer as FLVER observations', parts: nativeParts.length, regions: nativeRegions.length, models: msbOracle.fields.models.length, events: msbOracle.fields.events.length, ...mapReport },
    negatives,
    tolerances: { decodedFloatAttributes: 1e-6, integerIndicesAndMetadata: 0, serializedNativeReferenceFK: 0, rendererReferenceWorldAndInverseBind: 1e-5, msbInstanceMatrix: 1e-5, matrixRationale: 'Official expectations use float32 local/FK/inversion; Three hierarchy/inversion uses doubles. Absolute 1e-5 bounds conversion/rounding differences and is reported per field.' },
    unverifiedFields: {
      bridge: ['Full material names/MTD/tiling/GX metadata checked by the separate metadata report; this report compares complete texture slot refs', 'Native MTD/TPF shader semantics beyond raw pixels and references'],
      core: ['Game-confirmed equipment/attachment assembly; controlled follower mechanisms are compared', 'MSB subtype-specific event/region/route payloads outside scene-ir'],
      renderer: ['Sampled HKX/TAE-driven animation poses and full engine shader equivalence', 'Actual GPU upload/draw pixels and performance'],
      corpus: ['HKX independent format oracle unsupported', 'Game/mature-tool image confirmation']
    },
    nonClaims: [
      'No game execution, GPU/DOM launch, KRAK/vendor DLL, product rebuild, dependency restoration or native input-file copying',
      'MSB matrices cover proxy placements, not loaded map FLVER geometry or original halfway stall',
      'Runtime binding checks execute actual compiled CPU skeleton/mesh construction; controlled follower assemblies do not assert game equipment correctness',
      'Raw-zero rigid fallback, unused influence projection, normalized runtime weights and explicit root mirror are independent expectation contracts',
      'Diagnostic layout metadata is checked directly against hash-bound native header/member bytes; source format knowledge has the same documented lineage'
    ]
  };
  report.msb.nativeNameEvidence = { checkedRecordCount: rawLabels.length, rawNameEncoding: 'UTF-16LE at record-relative name pointer, existing Bridge record offsets; offsets are not independently certified', decodedSourceVerified: true, oracleDisplayNameAdaptations: nameAdaptations, pinnedPolicySource: policySource, pinnedPolicyLines: [48, 78], regionPointerSource: regionSource };
  report.buildReceipt.coreCompiledOutputAttestation = 'Core/shared dist modules are individually hash-bound and rechecked; the desktop receipt attests their selected source files, not their compilation/output hashes. No independent core build-producer attestation is claimed.';
  await writeFile(join(outputRoot, 'scene-projection-field-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [product, oracle, observations, bridgeDll, output, matrices] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/compare-scene-projection-fields.mjs <stable-product-root> <oracle-results> <bridge-observations> <bridge.dll-or-executable> <own-output-root> [independent-matrix-expectations.json]');
  const report = await compareSceneProjectionFields(product, oracle, observations, bridgeDll, output, matrices);
  console.log(JSON.stringify({ status: report.status, productCommit: report.productCommit, drawableMeshes: report.resources.flatMap((r) => r.meshes).filter((m) => m.classification === 'drawable').length, msbNodes: report.msb.parts + report.msb.regions, negativeCount: report.negatives.length }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
