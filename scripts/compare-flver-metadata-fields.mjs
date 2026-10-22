import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905';
const tilingTypes = ['None', 'Repeat', 'MirrorRepeat', 'Clamp', 'Border', 'MirrorOnce'];
const equal = (expected, actual) => ({ status: isDeepStrictEqual(expected, actual) ? 'passed' : 'failed', expected, actual: actual ?? null });
const layer = (checks) => ({ status: Object.values(checks).every((check) => check.status === 'passed') ? 'passed' : 'failed', checks });

/** Expectations use independent NEXT public fields; physical references are read
 * from source headers because the exporter clears private textureIndex and emits
 * GXList as an array without its terminator properties. No shader is decoded. */
export function expectedFlverMetadata(fields, bytes) {
  if (bytes.toString('ascii', 0, 6) !== 'FLVER\0' || bytes[6] !== 0x4c || !bytes[0x49]) throw new Error('BOUNDED_METADATA_REQUIRES_LITTLE_ENDIAN_UNICODE_FLVER2');
  const materialCount = bytes.readInt32LE(0x18), textureCount = bytes.readInt32LE(0x58);
  if (fields.Materials.length !== materialCount || materialCount < 0 || materialCount > 10_000 || textureCount < 0 || textureCount > 500_000) throw new Error('ORACLE_METADATA_COUNTS_INVALID');
  const materialStart = 128 + bytes.readInt32LE(0x14) * 64;
  const textures = Array(textureCount), gxOffsets = new Map();
  const materials = fields.Materials.map((material, index) => {
    const at = materialStart + index * 32;
    const firstTextureIndex = bytes.readInt32LE(at + 12), count = bytes.readInt32LE(at + 8);
    const gxOffset = bytes.readInt32LE(at + 20), nativeIndex = bytes.readInt32LE(at + 24);
    // NEXT writes a calculated count, but modded source strings may have been
    // edited without updating this stored integer. Preserve the raw source value.
    const stringByteCount = bytes.readInt32LE(at + 16);
    if (count !== material.Textures.length || nativeIndex !== material.Index || bytes.readInt32LE(at + 28) !== 0) throw new Error('ORACLE_MATERIAL_HEADER_DIVERGENCE');
    if (gxOffset !== 0 && !gxOffsets.has(gxOffset)) gxOffsets.set(gxOffset, gxOffsets.size);
    const gxIndex = gxOffset === 0 ? -1 : gxOffsets.get(gxOffset);
    if (gxIndex !== material.GXIndex) throw new Error('ORACLE_GX_REFERENCE_DIVERGENCE');
    const items = gxIndex === -1 ? null : fields.GXLists[material.GXIndex]?.map((item) => ({ id: item.ID, unk04: item.Unk04, itemLength: item.Data.byteLength + 12, dataLength: item.Data.byteLength, dataSha256: item.Data.sha256 }));
    if (gxIndex !== -1 && !items) throw new Error('ORACLE_GX_LIST_MISSING');
    let gxList = null;
    if (items) {
      const itemBytes = items.reduce((sum, item) => sum + item.itemLength, 0), terminatorAt = gxOffset + itemBytes;
      const terminatorId = bytes.readInt32LE(terminatorAt), terminatorLength = bytes.readInt32LE(terminatorAt + 8) - 12;
      if (![2147483647, -1].includes(terminatorId) || bytes.readInt32LE(terminatorAt + 4) !== 100 || terminatorLength < 0 || terminatorAt + 12 + terminatorLength > bytes.length) throw new Error('ORACLE_GX_TERMINATOR_INVALID');
      gxList = { itemCount: items.length, byteLength: itemBytes + 12 + terminatorLength, terminatorId, terminatorLength, terminatorPaddingAllZero: bytes.subarray(terminatorAt + 12, terminatorAt + 12 + terminatorLength).every((value) => value === 0), items };
    }
    for (let localIndex = 0; localIndex < count; localIndex++) {
      const texture = material.Textures[localIndex], ordinal = firstTextureIndex + localIndex;
      if (ordinal < 0 || ordinal >= textureCount || textures[ordinal]) throw new Error('ORACLE_TEXTURE_RANGE_INVALID');
      const tilingTypeU = tilingTypes.indexOf(texture.TilingTypeU), tilingTypeV = tilingTypes.indexOf(texture.TilingTypeV);
      if (tilingTypeU < 0 || tilingTypeV < 0) throw new Error('ORACLE_TILING_TYPE_UNSUPPORTED');
      textures[ordinal] = { index: ordinal, materialIndex: index, type: texture.ParamName, path: texture.Path, tilingScale: texture.TilingScale, tilingTypeU, tilingTypeV, unk14: texture.Unk14, unk18: texture.Unk18, unk1C: texture.Unk1C };
    }
    return { index, name: material.Name, mtdPath: material.MTD, textureCount: count, firstTextureIndex, stringByteCount, nativeIndex, flags: stringByteCount, unk18: nativeIndex, gxOffset, gxIndex, gxList };
  });
  if (textures.filter(Boolean).length !== textureCount) throw new Error('ORACLE_TEXTURES_UNASSIGNED');
  return { materialCount, materials, textureCount, textures };
}

/** Localizes all metadata divergence to Bridge. Core/renderer shader behavior
 * is outside this comparison and is never implied by a Bridge pass. */
export function compareFlverMetadata(expected, actual, document) {
  const materials = expected.materials.map((value, ordinal) => {
    const actualMaterial = actual?.materials?.[ordinal];
    const checks = Object.fromEntries(['index', 'name', 'mtdPath', 'textureCount', 'firstTextureIndex', 'stringByteCount', 'nativeIndex', 'flags', 'unk18', 'gxOffset', 'gxIndex'].map((key) => [key, equal(value[key], actualMaterial?.[key])]));
    const gx = actualMaterial?.gxList;
    if (value.gxList === null) checks.gxList = equal(null, gx);
    else {
      for (const key of ['itemCount', 'byteLength', 'terminatorId', 'terminatorLength', 'terminatorPaddingAllZero']) checks[`gx.${key}`] = equal(value.gxList[key], gx?.[key]);
      checks['gx.itemsLength'] = equal(value.gxList.items.length, gx?.items?.length);
      value.gxList.items.forEach((item, itemIndex) => {
        for (const key of ['id', 'unk04', 'itemLength', 'dataLength', 'dataSha256']) checks[`gx.items[${itemIndex}].${key}`] = equal(item[key], gx?.items?.[itemIndex]?.[key]);
      });
    }
    return { ordinal, ...layer(checks) };
  });
  const textures = expected.textures.map((value, ordinal) => ({ ordinal, ...layer(Object.fromEntries(Object.keys(value).map((key) => [key, equal(value[key], actual?.textures?.[ordinal]?.[key])])) ) }));
  const coverage = layer({ materialCount: equal(expected.materialCount, actual?.materialCount), materialArrayLength: equal(expected.materialCount, actual?.materials?.length), textureCount: equal(expected.textureCount, actual?.textureCount), textureArrayLength: equal(expected.textureCount, actual?.textures?.length) });
  const documentChecks = document === undefined ? { status: 'unverified', reason: 'DOCUMENT_NOT_SUPPLIED' } : layer({
    materialCount: equal(expected.materialCount, document.materialCount), materialSampleLength: equal(Math.min(10, expected.materialCount), document.materials?.length), materialsTruncated: equal(expected.materialCount > 10, document.materialsTruncated),
    textureCount: equal(expected.textureCount, document.textureCount), textureSampleLength: equal(Math.min(10, expected.textureCount), document.textureSlots?.length), texturesTruncated: equal(expected.textureCount > 10, document.texturesTruncated),
    materialSampleFields: equal(expected.materials.slice(0, 10), document.materials), textureSampleFields: equal(expected.textures.slice(0, 10), document.textureSlots)
  });
  const bridge = { status: coverage.status === 'passed' && materials.every((row) => row.status === 'passed') && textures.every((row) => row.status === 'passed') && (document === undefined || documentChecks.status === 'passed') ? 'passed' : 'failed', coverage, materials, textures, documentSamples: documentChecks };
  return { status: bridge.status, firstDivergentLayer: bridge.status === 'failed' ? 'bridge' : null, layers: { bridge, core: { status: 'unverified', reason: 'METADATA_ONLY_SCOPE' }, renderer: { status: 'unverified', reason: 'NO_SHADER_INTERPRETATION_OR_RENDER_EQUIVALENCE_CLAIM' } } };
}

export function metadataNegativeControls(expected, actual, document) {
  const mutations = [
    ['wrong-material-mtd', (wire) => { wire.materials[0].mtdPath += '.wrong'; }],
    ['wrong-material-ordinal', (wire) => { wire.materials[0].index += 1; }],
    ['missing-final-material', (wire) => { wire.materials.pop(); }],
    ['wrong-texture-material', (wire) => { wire.textures[0].materialIndex += 1; }],
    ['wrong-tiling-scale', (wire) => { wire.textures[0].tilingScale[0] += 0.25; }],
    ['wrong-tiling-type', (wire) => { wire.textures[0].tilingTypeU = (wire.textures[0].tilingTypeU + 1) % 6; }],
    ['wrong-texture-unknown', (wire) => { wire.textures[0].unk1C += 0.5; }],
    ['wrong-gx-reference', (wire) => { wire.materials.find((value) => value.gxIndex >= 0).gxIndex += 1; }],
    ['wrong-gx-item-id', (wire) => { wire.materials.find((value) => value.gxList?.items.length).gxList.items[0].id = 'BAD!'; }],
    ['wrong-gx-payload', (wire) => { const item = wire.materials.find((value) => value.gxList?.items.length).gxList.items[0]; item.dataSha256 = item.dataSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64); }]
  ];
  return mutations.map(([kind, mutate]) => {
    const wire = structuredClone(actual); mutate(wire);
    const result = compareFlverMetadata(expected, wire, document);
    const changedChecks = [...result.layers.bridge.materials.map((row) => ['material', row]), ...result.layers.bridge.textures.map((row) => ['texture', row])].flatMap(([field, row]) => Object.entries(row.checks).filter(([, check]) => check.status === 'failed').map(([check]) => ({ field, ordinal: row.ordinal, check })));
    return { kind, detected: result.status === 'failed' && result.firstDivergentLayer === 'bridge', firstDivergentLayer: result.firstDivergentLayer, changedChecks, coverageStatus: result.layers.bridge.coverage.status };
  });
}

export async function compareFlverMetadataFields(productRoot, oracleRoot, observationsRoot, producerPath, outputRoot, sourceBuildReceiptPath) {
  productRoot = resolve(productRoot); oracleRoot = resolve(oracleRoot); observationsRoot = resolve(observationsRoot); producerPath = resolve(producerPath); outputRoot = resolve(outputRoot);
  if (!sourceBuildReceiptPath) throw new Error('BRIDGE_SOURCE_BUILD_RECEIPT_REQUIRED');
  const bindings = [], bind = async (path) => { const bytes = await readFile(path); bindings.push({ path, bytes: bytes.length, sha256: hash(bytes) }); return bytes; };
  await bind(fileURLToPath(import.meta.url));
  const producerSha256 = hash(await bind(producerPath));
  const sourceReceipt = JSON.parse(await bind(resolve(sourceBuildReceiptPath)));
  if (sourceReceipt.product?.sha256 !== producerSha256 || resolve(productRoot, sourceReceipt.product.path) !== producerPath) throw new Error('BRIDGE_SOURCE_BUILD_PRODUCER_MISMATCH');
  const requiredSources = ['bridge/SoulForge.Bridge/FlverNativeDocument.cs', 'bridge/SoulForge.Bridge/BridgeCommandService.cs', 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'];
  for (const path of requiredSources) if (!sourceReceipt.sourceFiles?.find((file) => file.path === path)) throw new Error(`BRIDGE_SOURCE_RECEIPT_MISSING:${path}`);
  for (const record of sourceReceipt.sourceFiles) if (hash(await bind(resolve(productRoot, record.path))) !== record.sha256) throw new Error(`BRIDGE_SOURCE_RECEIPT_MISMATCH:${record.path}`);
  let verifyCompleteScope = async () => {};
  let sourceScope = { mode: 'listed-framework-dependent-source-files', completeCompileInputScopeVerified: false };
  if (!producerPath.toLowerCase().endsWith('.dll')) {
    const nativeReceiptPath = join(dirname(producerPath), 'bridge-production-build.json');
    if (!sourceReceipt.derivedFromReceipt || resolve(sourceReceipt.derivedFromReceipt.path) !== nativeReceiptPath)
      throw new Error('BRIDGE_PUBLISHED_BUILD_RECEIPT_REQUIRED');
    const nativeReceiptBytes = await bind(nativeReceiptPath);
    if (hash(nativeReceiptBytes) !== sourceReceipt.derivedFromReceipt.sha256) throw new Error('BRIDGE_PUBLISHED_BUILD_RECEIPT_MISMATCH');
    const nativeReceipt = JSON.parse(nativeReceiptBytes);
    if (nativeReceipt.executable?.sha256 !== producerSha256 || nativeReceipt.helper?.path !== 'scripts/bridge-production-build.mjs')
      throw new Error('BRIDGE_PUBLISHED_BUILD_IDENTITY_MISMATCH');
    const helperPath = join(productRoot, nativeReceipt.helper.path);
    if (hash(await bind(helperPath)) !== nativeReceipt.helper.sha256) throw new Error('BRIDGE_BUILD_SCOPE_HELPER_MISMATCH');
    const { assertBridgeProductionBuildFresh } = await import(pathToFileURL(helperPath).href);
    const runtimeIdentifier = nativeReceipt.executable.path.replaceAll('\\', '/').includes('/linux-x64/') ? 'linux-x64' : 'win-x64';
    verifyCompleteScope = async () => {
      const fresh = await assertBridgeProductionBuildFresh(productRoot, { runtimeIdentifier });
      if (resolve(fresh.manifestPath) !== resolve(nativeReceiptPath) || !isDeepStrictEqual(fresh.receipt, nativeReceipt))
        throw new Error('BRIDGE_COMPLETE_BUILD_SCOPE_MISMATCH');
    };
    await verifyCompleteScope();
    sourceScope = { mode: 'published-production-build-receipt', completeCompileInputScopeVerified: true, runtimeIdentifier, sourceInputHash: nativeReceipt.source.sha256, sourceEntryCount: nativeReceipt.source.entries.length, scopeVerifier: helperPath };
  }
  await bind(join(productRoot, 'packages/shared/src/flver-editor.ts'));
  const oracleWorkspace = dirname(oracleRoot);
  const upstreamIdentity = JSON.parse(await bind(join(oracleWorkspace, 'upstream-source-identities.json')));
  if (upstreamIdentity.commit !== revision || upstreamIdentity.repository !== 'https://github.com/soulsmods/SoulsFormatsNEXT') throw new Error('ORACLE_UPSTREAM_IDENTITY_MISMATCH');
  const metadataSources = ['Material.cs', 'Texture.cs', 'GXList.cs'];
  for (const name of metadataSources) {
    const relative = `SoulsFormats/Formats/FLVER/FLVER2/${name}`;
    const bytes = await bind(join(oracleWorkspace, `SoulsFormatsNEXT-${revision}`, relative));
    const gitBlobHash = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if (upstreamIdentity.files?.find((record) => record.path === relative)?.sha !== gitBlobHash) throw new Error(`ORACLE_UPSTREAM_SOURCE_MISMATCH:${relative}`);
  }
  const oracleAssemblySha256 = hash(await bind(join(oracleWorkspace, 'exporter/bin/Release/net10.0/SoulsFormats.dll')));
  const exporterAssemblySha256 = hash(await bind(join(oracleWorkspace, 'exporter/bin/Release/net10.0/IndependentFields.dll')));
  await bind(join(oracleWorkspace, 'exporter/Program.cs'));
  const inventory = JSON.parse(await bind(join(oracleRoot, 'flver-per-mesh-inventory.json')));
  if (inventory.independentOfSoulForge !== true || inventory.provider !== 'SoulsFormatsNEXT' || inventory.revision !== revision || !inventory.license?.includes('GPL') || JSON.stringify(inventory.resources?.map((value) => value.id).sort()) !== JSON.stringify(['c4510', 'c5030'])) throw new Error('ORACLE_PROVENANCE_MISMATCH');
  const manifest = JSON.parse(await bind(join(observationsRoot, 'observation-manifest.json')));
  const captureScriptSha256 = hash(await bind(join(productRoot, 'scripts/capture-flver-bridge-observations.mjs')));
  if (manifest.schemaVersion !== 1 || manifest.bridgeDllSha256 !== producerSha256 || manifest.captureScriptSha256 !== captureScriptSha256 || manifest.producerKind !== (producerPath.endsWith('.dll') ? 'framework-dependent-dll' : 'native-executable')) throw new Error('CAPTURE_PRODUCER_OR_TOOL_RECEIPT_MISMATCH');
  const observation = async (resource, suffix, command) => {
    const name = `${resource.id}-${suffix}.json`, bytes = await bind(join(observationsRoot, name));
    const receipt = manifest.observations?.find((value) => value.name === name);
    if (!receipt || receipt.sha256 !== hash(bytes) || receipt.sourceSha256 !== resource.flverSha256 || resolve(receipt.sourcePath) !== resolve(resource.rawLeafPath) || receipt.command !== command || JSON.stringify(receipt.commandOptions) !== '{}') throw new Error(`OBSERVATION_RECEIPT_MISMATCH:${name}`);
    const parsed = JSON.parse(bytes);
    if (!['partial', 'parsed'].includes(parsed.parseStatus) || !Array.isArray(parsed.diagnostics) || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data) || resolve(parsed.sourcePath) !== resolve(resource.rawLeafPath) || parsed.data.sourceHash !== resource.flverSha256) throw new Error(`OBSERVATION_ENVELOPE_INVALID:${name}`);
    return parsed.data;
  };
  const resources = [], negatives = [];
  for (const resource of inventory.resources) {
    if (hash(await bind(resource.source.path)) !== resource.source.sha256) throw new Error('ORACLE_SOURCE_IDENTITY_MISMATCH');
    const source = await bind(resource.rawLeafPath);
    if (hash(source) !== resource.flverSha256) throw new Error('ORACLE_LEAF_IDENTITY_MISMATCH');
    const fieldReport = JSON.parse(await bind(join(oracleRoot, `${resource.id}.chrbnd.fields.json`)));
    if (fieldReport.ok !== true || fieldReport.oracle?.commit !== revision || fieldReport.source?.sha256 !== resource.source.sha256 || fieldReport.oracle.assemblySha256 !== oracleAssemblySha256 || fieldReport.oracle.exporterSha256 !== exporterAssemblySha256) throw new Error('ORACLE_FIELD_PROVENANCE_MISMATCH');
    const leaf = fieldReport.fields.files.find((value) => value.sha256 === resource.flverSha256 && value.decoded?.format === 'FLVER2');
    if (!leaf) throw new Error('ORACLE_FIELD_LEAF_MISSING');
    const expected = expectedFlverMetadata(leaf.decoded.fields, source);
    const actual = await observation(resource, 'texture-slots', 'read-flver-texture-slots');
    const document = await observation(resource, 'document', 'read-flver-document');
    const result = compareFlverMetadata(expected, actual, document);
    resources.push({ id: resource.id, flverSha256: resource.flverSha256, materialCount: expected.materialCount, textureCount: expected.textureCount, mtdReferences: [...new Set(expected.materials.map((value) => value.mtdPath))].sort(), gxItemCount: expected.materials.reduce((sum, value) => sum + (value.gxList?.items.length ?? 0), 0), ...result });
    if (result.status === 'passed') negatives.push(...metadataNegativeControls(expected, actual, document).map((value) => ({ resourceId: resource.id, ...value })));
  }
  await verifyCompleteScope();
  for (const record of bindings) if (hash(await readFile(record.path)) !== record.sha256) throw new Error(`INPUT_CHANGED_DURING_COMPARISON:${record.path}`);
  const report = {
    schema: 'soulforge-flver-metadata-fields-v1', generatedAt: new Date().toISOString(), status: resources.every((value) => value.status === 'passed') && negatives.length === inventory.resources.length * 10 && negatives.every((value) => value.detected) ? 'passed' : 'failed',
    productCommit: execFileSync('git', ['-C', productRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), productTreeDirty: !!execFileSync('git', ['-C', productRoot, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
    sourceScope,
    producerSha256, producerKind: manifest.producerKind, captureScriptSha256, sourceBuild: { sourceCommit: sourceReceipt.sourceCommit ?? null, sourceTreeDirty: sourceReceipt.sourceTreeDirty ?? null, sourceFilesVerified: sourceReceipt.sourceFiles.length, mode: sourceReceipt.mode ?? null }, sourceBuildReceiptSha256: bindings.find((record) => record.path === resolve(sourceBuildReceiptPath)).sha256,
    oracle: { provider: inventory.provider, revision, license: inventory.license, metadataSourcesVerifiedAgainstUpstreamGitBlobs: metadataSources.length, assemblySha256: oracleAssemblySha256, exporterSha256: exporterAssemblySha256, exporterSourceCompileAttestation: 'Source and assembly are separately hash-bound. This comparator does not independently attest exporter compilation.', lineageLimit: 'Independent external GPL execution; Bridge format documentation shares SoulsFormats lineage. No independent format discovery is claimed.' },
    resources, negatives, coverage: { materials: resources.reduce((sum, value) => sum + value.materialCount, 0), textures: resources.reduce((sum, value) => sum + value.textureCount, 0), gxItems: resources.reduce((sum, value) => sum + value.gxItemCount, 0), negativeControls: negatives.length }, bindings,
    nonClaims: ['MTD fields are reference strings only. No actual MTD file inputs were supplied; shader params and material evaluation are unverified.', 'GX item payloads are compared as opaque length/SHA-256 only; no GX shader semantics are interpreted.', 'Bridge metadata equality does not establish core/renderer metadata propagation or visual/render equivalence.', 'Bounded real corpus: c4510 and c5030 little-endian Unicode FLVER2; no whole-game or other-version coverage.']
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'flver-metadata-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 6) throw new Error('Usage: node compare-flver-metadata-fields.mjs <product-root> <oracle-results> <observations> <producer.dll-or-executable> <output-root> <source-build-receipt>');
  const result = await compareFlverMetadataFields(...args);
  console.log(JSON.stringify({ status: result.status, coverage: result.coverage, output: join(resolve(args[4]), 'flver-metadata-comparison.json') }));
  if (result.status !== 'passed') process.exitCode = 1;
}
