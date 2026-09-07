import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { buildSyntheticStripFlver, type SyntheticFlverFixture } from './audit/sf-14/flverFixture.js';

interface StaticChunk {
  positionsBase64?: string;
  normalsBase64?: string | null;
  uvsBase64?: string | null;
  indicesBase64?: string;
  sourceVertexIndicesBase64?: string;
  indexElementBytes?: number;
  sourceTriangleStart?: number;
  meshIndex?: number;
  sourceIndexStart?: number;
  sourceIndexCount?: number;
  sourceVertexCount?: number;
  emittedVertexCount?: number;
  emittedIndexCount?: number;
  triangleCount?: number;
  boundsStatus?: string;
  telemetry?: {
    flverParse?: number;
    flverBase64Encode?: number;
    flverBase64Decode?: number;
  };
}
interface StaticPage {
  sessionToken?: string;
  nextCursor?: string | null;
  complete?: boolean;
  chunks?: StaticChunk[];
  telemetry?: { skin?: number; skeleton?: number; parse?: number };
}
interface PageResult {
  data: StaticPage;
  diagnostics: Array<{ code?: string; message?: string }>;
  parseStatus: string;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function diagnosticCodes(result: { diagnostics?: Array<{ code?: string }> }): string[] {
  return (result.diagnostics ?? [])
    .map((item) => item.code)
    .filter((code): code is string => typeof code === 'string');
}
function decodeIndices(base64: string, elementBytes: number): number[] {
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes.length % elementBytes, 0);
  const output: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += elementBytes) {
    output.push(elementBytes === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset));
  }
  return output;
}
function decodeSourceIndices(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes.length % 4, 0);
  const output: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) output.push(bytes.readUInt32LE(offset));
  return output;
}
function assertChunkShape(chunk: StaticChunk): {
  sourceTriangles: Array<[number, number, number]>;
} {
  assert.equal(typeof chunk.positionsBase64, 'string');
  assert.equal(typeof chunk.indicesBase64, 'string');
  assert.equal(typeof chunk.sourceVertexIndicesBase64, 'string');
  const elementBytes = chunk.indexElementBytes;
  assert.ok(elementBytes === 2 || elementBytes === 4);
  const positions = Buffer.from(chunk.positionsBase64!, 'base64');
  const indices = decodeIndices(chunk.indicesBase64!, elementBytes);
  const sources = decodeSourceIndices(chunk.sourceVertexIndicesBase64!);
  assert.equal(chunk.emittedVertexCount, sources.length);
  assert.equal(chunk.emittedIndexCount, indices.length);
  assert.equal(positions.length, sources.length * 12);
  assert.equal(chunk.triangleCount! * 3, indices.length);
  assert.ok(chunk.sourceVertexCount! >= sources.length);
  assert.ok(chunk.sourceIndexCount! >= chunk.sourceIndexStart!);
  if (chunk.normalsBase64) assert.equal(Buffer.from(chunk.normalsBase64, 'base64').length, sources.length * 12);
  if (chunk.uvsBase64) assert.equal(Buffer.from(chunk.uvsBase64, 'base64').length, sources.length * 8);
  const triangles: Array<[number, number, number]> = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    assert.ok(a < sources.length && b < sources.length && c < sources.length);
    triangles.push([sources[a]!, sources[b]!, sources[c]!]);
  }
  return { sourceTriangles: triangles };
}
async function requestStaticPage(
  filePath: string,
  modelName: string,
  options: {
    workspaceSessionId: string;
    ownerLeaseId?: string;
    sessionToken?: string;
    cursor?: string;
    oodleRuntimeRoot?: string;
  }
): Promise<PageResult> {
  const result = await runBridge<StaticPage>({
    command: 'read-map-static-geometry',
    filePath,
    allowedRoots: [dirname(filePath)],
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    workspaceSessionId: options.workspaceSessionId,
    timeoutMs: 120_000,
    commandOptions: {
      modelName,
      ...(options.ownerLeaseId ? { ownerLeaseId: options.ownerLeaseId } : {}),
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      resourceCacheKey: 'sf14-smoke'
    }
  });
  return {
    data: (result.data ?? {}) as StaticPage,
    diagnostics: result.diagnostics,
    parseStatus: result.parseStatus
  };
}
async function collectPages(
  filePath: string,
  modelName: string,
  workspaceSessionId: string,
  ownerLeaseId: string,
  expected?: SyntheticFlverFixture,
  oodleRuntimeRoot?: string
): Promise<{ pages: StaticPage[]; triangles: Array<[number, number, number]> }> {
  const pages: StaticPage[] = [];
  const triangles: Array<[number, number, number]> = [];
  const trianglesByMesh = new Map<number, number>();
  let sessionToken: string | undefined;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
    const result = await requestStaticPage(filePath, modelName, {
      workspaceSessionId,
      ownerLeaseId,
      ...(sessionToken ? { sessionToken } : {}),
      ...(cursor ? { cursor } : {}),
      ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
    });
    assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result.diagnostics));
    assert.equal(result.data.complete === true || typeof result.data.nextCursor === 'string', true);
    const chunk = result.data.chunks?.[0];
    assert.ok((result.data.chunks?.length ?? 0) <= 1);
    if (!chunk) {
      assert.equal(result.data.complete, true);
      pages.push(result.data);
      break;
    }
    const shape = assertChunkShape(chunk);
    triangles.push(...shape.sourceTriangles);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data), 'utf8') < 8 * 1024 * 1024);
    if (expected) {
      assert.equal(chunk.sourceVertexCount, expected.vertexCount);
      assert.equal(chunk.sourceIndexCount, expected.indices.length);
      assert.equal(chunk.boundsStatus, 'native');
    }
    if (sessionToken) assert.equal(result.data.sessionToken, sessionToken);
    if (expected) {
      assert.equal(chunk.sourceTriangleStart, triangles.length - shape.sourceTriangles.length);
    } else {
      assert.equal(typeof chunk.meshIndex, 'number');
      const meshIndex = chunk.meshIndex!;
      const meshTriangleStart = trianglesByMesh.get(meshIndex) ?? 0;
      assert.equal(chunk.sourceTriangleStart, meshTriangleStart);
      trianglesByMesh.set(meshIndex, meshTriangleStart + shape.sourceTriangles.length);
    }
    if (result.data.complete) {
      pages.push(result.data);
      break;
    }
    sessionToken = result.data.sessionToken;
    assert.ok(sessionToken);
    cursor = result.data.nextCursor ?? undefined;
    assert.ok(cursor);
    pages.push(result.data);
  }
  assert.equal(pages.some((page) => page.complete === true), true, 'pagination did not terminate');
  if (expected) assert.deepEqual(triangles, expected.expectedTriangles);
  return { pages, triangles };
}
async function runUnit(): Promise<Record<string, unknown>> {
  const fixture = buildSyntheticStripFlver();
  const workspace = await createSmokeWorkspace('audit-sf14-unit');
  try {
    const filePath = join(workspace.root, 'sf14-strip.flver');
    const changedPath = join(workspace.root, 'sf14-strip-changed.flver');
    await writeFile(filePath, fixture.bytes);
    const workspaceSessionId = 'sf14-unit-workspace';
    const ownerA = 'sf14-owner-a';
    const ownerB = 'sf14-owner-b';
    const parserBefore = await runBridge<Record<string, unknown>>({
      command: 'read-flver-document',
      filePath,
      allowedRoots: [workspace.root],
      workspaceSessionId,
      timeoutMs: 120_000
    });
    assert.notEqual(parserBefore.parseStatus, 'failed', JSON.stringify(parserBefore.diagnostics));
    const parserBeforeTelemetry = parserBefore.data?.telemetry as {
      flverParse?: number;
      flverBase64Encode?: number;
      flverBase64Decode?: number;
    } | undefined;
    assert.ok((parserBeforeTelemetry?.flverParse ?? 0) >= 2);
    assert.equal(parserBeforeTelemetry?.flverBase64Decode, 0);
    const first = await requestStaticPage(filePath, 'sf14-strip.flver', {
      workspaceSessionId, ownerLeaseId: ownerA
    });
    assert.notEqual(first.parseStatus, 'failed', JSON.stringify(first.diagnostics));
    assert.equal(first.data.telemetry?.skin, 0);
    assert.equal(first.data.telemetry?.skeleton, 0);
    assert.equal(first.data.telemetry?.parse, 1);
    assert.equal(first.data.chunks?.[0]?.triangleCount, 8_000);
    const parserAfter = await runBridge<Record<string, unknown>>({
      command: 'read-flver-document',
      filePath,
      allowedRoots: [workspace.root],
      workspaceSessionId,
      timeoutMs: 120_000
    });
    assert.notEqual(parserAfter.parseStatus, 'failed', JSON.stringify(parserAfter.diagnostics));
    const parserAfterTelemetry = parserAfter.data?.telemetry as {
      flverParse?: number;
      flverBase64Encode?: number;
      flverBase64Decode?: number;
    } | undefined;
    assert.equal(
      (parserAfterTelemetry?.flverParse ?? 0) - (parserBeforeTelemetry?.flverParse ?? 0),
      3,
      'one map session parse plus two independent read-flver reparse calls expected'
    );
    assert.equal(
      (parserAfterTelemetry?.flverBase64Encode ?? 0)
        - (parserBeforeTelemetry?.flverBase64Encode ?? 0),
      1,
      'read-flver envelope authority performs its known one-mesh wire probe; map did not add one'
    );
    assert.equal(parserAfterTelemetry?.flverBase64Decode, 0);
    const firstCursor = first.data.nextCursor;
    const firstSession = first.data.sessionToken;
    assert.ok(firstCursor && firstSession);
    const oldCursor = Buffer.from('0:0', 'utf8').toString('base64');
    const oldCursorResult = await requestStaticPage(filePath, 'sf14-strip.flver', {
      workspaceSessionId, ownerLeaseId: ownerA, sessionToken: firstSession, cursor: oldCursor
    });
    assert.equal(oldCursorResult.parseStatus, 'failed');
    assert.ok(diagnosticCodes(oldCursorResult).includes('MAP_STATIC_CURSOR_INVALID'));
    const ownerBFirst = await requestStaticPage(filePath, 'sf14-strip.flver', {
      workspaceSessionId, ownerLeaseId: ownerB
    });
    assert.notEqual(ownerBFirst.parseStatus, 'failed');
    assert.ok(ownerBFirst.data.nextCursor);
    const wrongOwnerResult = await requestStaticPage(filePath, 'sf14-strip.flver', {
      workspaceSessionId, ownerLeaseId: ownerA, sessionToken: firstSession,
      cursor: ownerBFirst.data.nextCursor!
    });
    assert.equal(wrongOwnerResult.parseStatus, 'failed');
    assert.ok(diagnosticCodes(wrongOwnerResult).includes('MAP_STATIC_CURSOR_INVALID'));
    const changed = Buffer.from(fixture.bytes);
    changed[changed.length - 1]! ^= 0x01;
    await writeFile(changedPath, changed);
    const staleResult = await requestStaticPage(changedPath, 'sf14-strip.flver', {
      workspaceSessionId, ownerLeaseId: ownerA, sessionToken: firstSession, cursor: firstCursor
    });
    assert.equal(staleResult.parseStatus, 'failed');
    assert.ok(diagnosticCodes(staleResult).includes('MAP_STATIC_SESSION_EXPIRED'));
    const missingModel = await runBridge({
      command: 'read-map-static-geometry',
      filePath,
      allowedRoots: [workspace.root],
      workspaceSessionId,
      timeoutMs: 120_000,
      commandOptions: {}
    });
    assert.equal(missingModel.parseStatus, 'failed');
    assert.ok(diagnosticCodes(missingModel).includes('MAPBND_MODEL_NAME_MISSING'));
    const collected = await collectPages(
      filePath, 'sf14-strip.flver', workspaceSessionId, 'sf14-owner-pages', fixture
    );
    const chunks = collected.pages.filter((page) => (page.chunks?.length ?? 0) > 0);
    assert.equal(chunks[0]?.chunks?.[0]?.sourceTriangleStart, 0);
    assert.equal(chunks[1]?.chunks?.[0]?.sourceTriangleStart, 8_000);
    assert.equal(collected.triangles.length, fixture.expectedTriangles.length);
    assert.equal(chunks[0]?.telemetry?.parse, chunks[1]?.telemetry?.parse);
    assert.ok((chunks[0]?.telemetry?.parse ?? 0) >= 1);
    assert.equal(
      chunks[0]?.chunks?.[0]?.telemetry?.flverParse,
      chunks[1]?.chunks?.[0]?.telemetry?.flverParse,
      'page two must not re-enter the FLVER parser'
    );
    assert.equal(
      chunks[0]?.chunks?.[0]?.telemetry?.flverBase64Encode,
      chunks[1]?.chunks?.[0]?.telemetry?.flverBase64Encode
    );
    return {
      ok: true, status: 'passed', layer: 'unit', pages: chunks.length,
      triangles: collected.triangles.length,
      checks: [
        'typed lazy projection', 'strip parity across page boundary',
        'degenerate and primitive restart semantics', 'wire frame budget',
        'opaque old cursor rejection', 'cross-owner cursor rejection',
        'source hash/session expiry rejection', 'missing model rejection'
      ]
    };
  } finally {
    await workspace.dispose();
  }
}
async function resolveMapFixture(explicitPath: string | undefined): Promise<string | undefined> {
  try {
    const resolved = await resolveNativeFixture(
      explicitPath, 'map-primary',
      '../../mods/map/m10_00_00_00/m10_00_00_00_600050.mapbnd.dcx'
    );
    return existsSync(resolved) ? resolved : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!explicitPath && (message.includes('NATIVE_FIXTURE_ROLE_MISSING')
      || message.includes('ENOENT') || message.includes('cannot find'))) return undefined;
    throw error;
  }
}
async function runNative(): Promise<Record<string, unknown>> {
  const fixturePath = await resolveMapFixture(optionValue('--fixture'));
  if (!fixturePath) {
    return {
      ok: true, status: 'skipped', layer: 'native',
      code: 'SF14_NATIVE_FIXTURE_UNAVAILABLE',
      message: '未找到登记的 map-primary 或 legacy mapbnd 语料。'
    };
  }
  const root = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const inventory = await runBridge<{
    entries?: Array<{ name?: string; uncompressedSize?: number }>;
  }>({
    command: 'list-bnd4-entries',
    filePath: fixturePath,
    allowedRoots: [dirname(fixturePath)],
    ...(root ? { oodleRuntimeRoot: root } : {}),
    timeoutMs: 180_000,
    commandOptions: {}
  });
  if (inventory.parseStatus === 'failed' || !inventory.data) {
    const codes = diagnosticCodes(inventory);
    if (codes.some((code) => code.includes('OODLE') || code.includes('KRAK'))) {
      return {
        ok: true, status: 'skipped', layer: 'native',
        code: 'SF14_NATIVE_OODLE_UNAVAILABLE', diagnostics: inventory.diagnostics
      };
    }
    throw new Error('map-primary BND4 inventory failed: ' + JSON.stringify(inventory.diagnostics));
  }
  const entry = (inventory.data.entries ?? []).find((item: { name?: string }) => /\.flver$/i.test(item.name ?? ''));
  assert.ok(entry?.name, 'map-primary BND4 has no FLVER entry');
  const collected = await collectPages(
    fixturePath, entry.name, 'sf14-native-workspace', 'sf14-native-owner', undefined, root
  );
  const firstChunk = collected.pages.find((page) => page.complete !== true)?.chunks?.[0];
  assert.ok(firstChunk);
  assert.equal(firstChunk.boundsStatus, 'native');
  assert.equal(firstChunk.sourceVertexCount! > 0, true);
  assert.equal(firstChunk.sourceIndexCount! > 0, true);
  assert.equal(collected.triangles.length > 0, true);
  return {
    ok: true, status: 'passed', layer: 'native', filePath: fixturePath,
    modelName: entry.name, pages: collected.pages.length,
    triangles: collected.triangles.length,
    sourceVertexCount: firstChunk.sourceVertexCount,
    sourceIndexCount: firstChunk.sourceIndexCount
  };
}
async function main(): Promise<void> {
  const layer = optionValue('--layer');
  if (layer !== 'unit' && layer !== 'native') {
    throw new Error('SF14_LAYER_REQUIRED: 使用 --layer unit 或 --layer native。');
  }
  try {
    console.log(JSON.stringify(layer === 'unit' ? await runUnit() : await runNative(), null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
