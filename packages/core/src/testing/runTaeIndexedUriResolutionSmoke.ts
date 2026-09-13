/**
 * read_tae_events 的索引 URI 解析 smoke。
 *
 * 使用 native fixture registry 提供的真实 ANIBND，通过生产 ToolRegistry
 * 与 AgentToolBridge 验证：搜索返回的 file://chr/... 会解析到同一份 overlay
 * 物理文件；重复相对路径拒绝猜测；索引指向 overlay 外仍由 TAE 读门面拒绝；
 * 原有 relative / absolute / bare 文件输入继续可读。
 *
 * 本测试只读真实语料，任何落盘都发生在独立临时 overlay 的副本中；缺少
 * registry 时结构化跳过，不把本机没有语料误报成成功。
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { IndexedFile, ResourceKind } from '@soulforge/shared';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

interface TaeFixture {
  sourcePath: string;
  gameRoot: string;
}

interface BridgeEnvelope {
  ok?: boolean;
  data?: {
    items?: unknown[];
    record?: Record<string, unknown> | null;
  };
  error?: { code?: string; message?: string };
}

function makeIndexedFile(input: {
  workspaceId: string;
  sourceUri: string;
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}): IndexedFile {
  const lowerRelativePath = input.relativePath.toLowerCase();
  const anibnd = lowerRelativePath.endsWith('.anibnd.dcx') || lowerRelativePath.endsWith('.anibnd');
  return {
    id: input.sourceUri,
    workspaceId: input.workspaceId,
    sourceUri: input.sourceUri,
    sourcePath: input.relativePath,
    game: 'sekiro',
    resourceKind: 'chr',
    parseStatus: 'partial',
    diagnostics: [],
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    extension: anibnd ? '.dcx' : '.tae',
    compoundExtension: anibnd ? (lowerRelativePath.endsWith('.anibnd.dcx') ? '.anibnd.dcx' : '.anibnd') : '.tae',
    formatKind: anibnd ? 'bnd' : 'unknown',
    formatLabel: anibnd ? 'Animation BND DCX' : 'TAE',
    size: input.size,
    mtimeMs: input.mtimeMs
  };
}

function gameRootFromFixture(sourcePath: string): string {
  const normalized = sourcePath.replaceAll('\\', '/');
  const marker = '/mods/';
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(0, markerIndex);
  return process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    || dirname(dirname(dirname(sourcePath)));
}

async function resolveFixture(): Promise<TaeFixture | undefined> {
  const explicitPath = process.argv[2]?.trim();
  if (!explicitPath && !(await nativeFixtureRoleRegistered('tae-primary'))) {
    return undefined;
  }
  const sourcePath = await resolveNativeFixture(
    explicitPath,
    'tae-primary',
    '../../mods/chr/c0000.anibnd.dcx'
  );
  return { sourcePath, gameRoot: gameRootFromFixture(sourcePath) };
}

function toolCall(name: string, input: unknown) {
  return {
    id: `tae-indexed-uri-${name}`,
    name,
    argumentsJson: JSON.stringify(input)
  };
}

async function bridgeRun(
  registry: ReturnType<typeof createDefaultToolRegistry>,
  context: ToolContext,
  name: string,
  input: unknown
): Promise<BridgeEnvelope> {
  const bridge = createAgentToolBridge({ registry, context });
  const result = await bridge.executeTool(toolCall(name, input));
  const envelope = JSON.parse(result.content) as BridgeEnvelope;
  assert.equal(result.ok, envelope.ok === true, `${name} adapter envelope mismatch: ${result.content}`);
  return envelope;
}

async function registryRun(
  registry: ReturnType<typeof createDefaultToolRegistry>,
  context: ToolContext,
  input: unknown
): Promise<{ ok: boolean; error?: { code?: string; message?: string }; data?: unknown }> {
  return registry.run('read_tae_events', input, context);
}

async function run(): Promise<'skipped' | 'passed'> {
  const fixture = await resolveFixture();
  if (!fixture) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      code: 'TAE_INDEXED_URI_FIXTURE_UNAVAILABLE',
      message: '未配置 tae-primary native fixture registry；索引 URI 解析 smoke 结构化跳过。'
    }));
    return 'skipped';
  }

  await withSmokeWorkspace('tae-indexed-uri-resolution', async (workspace) => {
    const fileName = basename(fixture.sourcePath);
    assert.match(
      fileName,
      /^c\d{4}(?:_[a-z0-9_]+)?\.anibnd(?:\.dcx)?$/i,
      `tae-primary 必须登记真实 ANIBND，实际为 ${fileName}`
    );
    const overlayPath = join(workspace.root, 'chr', fileName);
    await mkdir(dirname(overlayPath), { recursive: true });
    // Keep the production catalog identity on the outer ANIBND container.
    // The read path must therefore exercise native aggregate TAE extraction,
    // not a test-only extracted `a00.tae` surrogate.
    await copyFile(fixture.sourcePath, overlayPath);
    const overlayInfo = await stat(overlayPath);
    const relativePath = relative(workspace.root, overlayPath).replaceAll('\\', '/');
    const sourceUri = `file://chr/${fileName}`;

    const session = await openWorkspaceSession({
      overlayRoot: workspace.root,
      baseRoot: fixture.gameRoot,
      game: 'sekiro'
    });
    const backupBaseDir = join(workspace.root, '.soulforge-staging', 'backups');
    const recoveryDir = join(workspace.root, '.soulforge-staging', 'recovery');
    await mkdir(backupBaseDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });
    const registry = createDefaultToolRegistry();
    const operationLogStore = new MemoryOperationLogStore();
    const index = new WorkspaceIndex(session.meta.workspaceId);
    index.setFiles([makeIndexedFile({
      workspaceId: session.meta.workspaceId,
      sourceUri,
      absolutePath: overlayPath,
      relativePath,
      mtimeMs: overlayInfo.mtimeMs,
      size: overlayInfo.size
    })]);
    const context: ToolContext = {
      workspaceIndex: index,
      mode: 'normal',
      session,
      operationLogStore,
      backupBaseDir,
      recoveryDir
    };

    // The model-facing adapter must return the same indexed source URI that
    // is then fed back into the native read, not a guessed physical path.
    const search = await bridgeRun(registry, context, 'search_resources', {
      query: fileName,
      kinds: ['chr'] satisfies ResourceKind[]
    });
    assert.equal(search.ok, true, JSON.stringify(search));
    const searchItems = search.data?.items ?? [];
    const searchItem = searchItems
      .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : undefined)
      .find((item) => item?.item && typeof item.item === 'object')?.item as Record<string, unknown> | undefined;
    assert.equal(searchItem?.sourceUri, sourceUri, `search_resources 未返回预期 sourceUri：${JSON.stringify(search)}`);
    assert.equal(searchItem?.resourceKind, 'chr');

    // Feed the exact search result back through the model-facing adapter. This
    // is the production search -> sourceUri -> native read loop.  Select one
    // real event by section and large native animId so the model-facing
    // bounded envelope does not need to carry the entire aggregate event list.
    const chrId = fileName.slice(0, 5).toLowerCase();
    const selected = chrId === 'c7100'
      ? { animId: 401050, entryName: 'c7100.tae' }
      : { animId: 100000, entryName: 'a00.tae' };
    const selectedAddress = `action://${chrId}/tae/1/A${selected.animId}/e0`;
    const indexedRead = await bridgeRun(registry, context, 'read_tae_events', {
      file: sourceUri,
      addresses: [selectedAddress]
    });
    assert.equal(indexedRead.ok, true, JSON.stringify(indexedRead));
    const indexedRecord = indexedRead.data?.record as Record<string, unknown> | undefined;
    assert.ok(indexedRecord, `read_tae_events adapter 未返回 record：${JSON.stringify(indexedRead)}`);
    assert.ok(Array.isArray(indexedRecord.events) && indexedRecord.events.length === 1,
      `indexed ANIBND read 未返回 native events：${JSON.stringify(indexedRead)}`);
    assert.equal((indexedRecord.events[0] as Record<string, unknown>).code, `A${selected.animId}`,
      `indexed ANIBND adapter read 返回错误 bounded code：${JSON.stringify(indexedRead)}`);
    const taeSource = index.toSymbolBundle().tae?.find((item) => item.sourceUri === sourceUri);
    assert.ok(taeSource, 'indexed URI read must publish TAE projection under the indexed source identity');
    assert.ok((taeSource.animations?.length ?? 0) > 0, 'indexed URI read must return native animations');
    assert.ok(taeSource.taeEntries?.some((entry) => entry.entryName.toLowerCase() === selected.entryName),
      `indexed URI read must preserve ${selected.entryName} inventory`);
    if (chrId === 'c0000') {
      assert.ok((taeSource.taeEntryCount ?? 0) > 1, 'c0000 ANIBND must preserve multi-section TAE inventory');
      assert.ok(taeSource.taeEntries?.some((entry) => entry.entryName.toLowerCase() === 'a00.tae'),
        'c0000 ANIBND inventory must include a00.tae');
    }

    // Duplicate relative aliases are not a reason to pick the first file.
    const duplicateIndex = new WorkspaceIndex(`${session.meta.workspaceId}-duplicate`);
    duplicateIndex.setFiles([
      makeIndexedFile({
        workspaceId: duplicateIndex.workspaceId,
        sourceUri,
        absolutePath: overlayPath,
        relativePath,
        mtimeMs: overlayInfo.mtimeMs,
        size: overlayInfo.size
      }),
      makeIndexedFile({
        workspaceId: duplicateIndex.workspaceId,
        sourceUri: 'file://base/chr/' + fileName,
        absolutePath: overlayPath,
        relativePath,
        mtimeMs: overlayInfo.mtimeMs,
        size: overlayInfo.size
      })
    ]);
    const duplicateResult = await registryRun(registry, { ...context, workspaceIndex: duplicateIndex }, { file: relativePath });
    assert.equal(duplicateResult.ok, false, JSON.stringify(duplicateResult));
    assert.equal(duplicateResult.error?.code, 'RESOURCE_SOURCE_AMBIGUOUS');

    // An indexed identity pointing outside the opened overlay must still be
    // rejected by the existing TAE resolver before Bridge reads it.
    const outsideRoot = await mkdtemp(join(tmpdir(), 'soulforge-tae-indexed-outside-'));
    try {
      const outsidePath = join(outsideRoot, 'chr', fileName);
      await mkdir(dirname(outsidePath), { recursive: true });
      await copyFile(fixture.sourcePath, outsidePath);
      const outsideIndex = new WorkspaceIndex(`${session.meta.workspaceId}-outside`);
      outsideIndex.setFiles([makeIndexedFile({
        workspaceId: outsideIndex.workspaceId,
        sourceUri: 'file://outside/chr/' + fileName,
        absolutePath: outsidePath,
        relativePath: 'outside/chr/' + fileName,
        mtimeMs: (await stat(outsidePath)).mtimeMs,
        size: (await stat(outsidePath)).size
      })]);
      const outsideResult = await registryRun(
        registry,
        { ...context, workspaceIndex: outsideIndex },
        { file: 'file://outside/chr/' + fileName }
      );
      assert.equal(outsideResult.ok, false, JSON.stringify(outsideResult));
      assert.equal(outsideResult.error?.code, 'TAE_FILE_NOT_FOUND');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }

    // Keep all pre-existing input forms working on the same overlay file.
    for (const token of [relativePath, overlayPath, fileName]) {
      const compatible = await registryRun(registry, context, { file: token });
      assert.equal(compatible.ok, true, `${token} compatibility read failed: ${JSON.stringify(compatible)}`);
    }
  });
  return 'passed';
}

run().then(
  async (status) => {
    await disposeBridgeDaemonPool();
    if (status === 'passed') console.log('runTaeIndexedUriResolutionSmoke: PASS');
  },
  async (error) => {
    await disposeBridgeDaemonPool();
    console.error(`runTaeIndexedUriResolutionSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
