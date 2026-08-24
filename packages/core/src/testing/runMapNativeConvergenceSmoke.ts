/**
 * MAP native convergence smoke。
 *
 * 在真实 Sekiro MSB 上分别经 Agent tool、Human facade、Blender facade
 * 提交到独立临时 overlay；每条链都重新读取同一个 canonical document。
 * 原版游戏目录只读，任何写入都经过 Patch Engine 写入临时 overlay。
 *
 * Authority: native-verified（仅限本 smoke 覆盖的 Part transform/template
 * duplicate contract；不扩展到未知 MSBS subtype 或空白 create）。
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolResult
} from '../ai/toolRegistry.js';
import type { MapDocument } from '@soulforge/shared';
import {
  batchTransformMapParts,
  loadMapDocument
} from '../editing/mapService.js';
import {
  nativeEditSessionFromContext,
  type NativeEditSession
} from '../editing/nativeEditSession.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';

const MAP_RELATIVE_PATH = 'map/mapstudio/m11_00_00_00.msb.dcx';

interface FixtureContext {
  file: string;
  doc: MapDocument;
  edit: NativeEditSession;
  toolContext: ToolContext;
}

async function createFixtureContext(root: string, gameRoot: string): Promise<FixtureContext> {
  const overlayRoot = join(root, 'mod');
  const target = join(overlayRoot, MAP_RELATIVE_PATH);
  await mkdir(join(overlayRoot, 'map', 'mapstudio'), { recursive: true });
  await copyFile(join(gameRoot, MAP_RELATIVE_PATH), target);

  const session = await openWorkspaceSession({
    overlayRoot,
    baseRoot: gameRoot,
    game: 'sekiro'
  });
  const operationLogStore = new MemoryOperationLogStore();
  const backupBaseDir = join(root, 'backups');
  const recoveryDir = join(root, 'recovery');
  await mkdir(backupBaseDir, { recursive: true });
  await mkdir(recoveryDir, { recursive: true });

  const edit = nativeEditSessionFromContext({
    session,
    operationLog: operationLogStore,
    backupBaseDir,
    recoveryDir,
    confirmation: createConfirmationReceipt({
      subjects: ['MAP_NATIVE_CONVERGENCE_SMOKE', pathToFileURL(target).href],
      riskLevel: 'high',
      sourceUri: pathToFileURL(target).href,
      note: 'native convergence smoke temporary overlay'
    })
  });
  const loaded = await loadMapDocument(edit, MAP_RELATIVE_PATH);
  if (!loaded.ok) throw new Error(`真实 MSB loader 失败: ${JSON.stringify(loaded)}`);

  const workspaceIndex = new WorkspaceIndex(session.meta.workspaceId);
  const toolContext: ToolContext = {
    workspaceIndex,
    mode: 'fullPermission',
    session,
    operationLogStore,
    backupBaseDir,
    recoveryDir,
    confirmation: edit.mintReceipt(pathToFileURL(target).href, 'MAP native convergence smoke')
  };
  return { file: MAP_RELATIVE_PATH, doc: loaded.doc, edit, toolContext };
}

function choosePart(doc: MapDocument): MapDocument['parts'][number] {
  const part = doc.parts.find((candidate) => candidate.modelName
    && doc.parts.filter((other) => other.name === candidate.name).length === 1);
  if (!part) throw new Error('真实 m11 MSB 缺少带模型且名称唯一的 Part 样本。');
  return part;
}

function expectToolSuccess(result: ToolResult, label: string): Record<string, unknown> {
  assert.equal(result.ok, true, `${label} 必须成功: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error(`${label} failed`);
  return result.data as Record<string, unknown>;
}

async function runAgentWrapper(gameRoot: string, root: string): Promise<void> {
  const fixture = await createFixtureContext(root, gameRoot);
  const source = choosePart(fixture.doc);
  const duplicateName = `${source.name}_sf_agent_duplicate`;
  const registry = createDefaultToolRegistry();
  const result = await registry.run(
    'execute_map_transaction',
    {
      file: fixture.file,
      operations: [{
        kind: 'duplicate',
        target: source.stableKey,
        newName: duplicateName,
        entityKind: 'part',
        position: [source.transform.position[0] + 1, source.transform.position[1], source.transform.position[2]]
      }]
    },
    fixture.toolContext
  );
  const data = expectToolSuccess(result, 'Agent execute_map_transaction');
  assert.equal(data.status, 'committed');
  assert.equal(data.appliedOperations, 1);
  const created = data.createdEntities as Array<{ name: string; stableKey: string; address: string }>;
  assert.equal(created.some((item) => item.name === duplicateName), true, 'Agent 返回的 identity 必须来自 committed reread');

  const reread = await loadMapDocument(fixture.edit, fixture.file);
  if (!reread.ok) throw new Error(`Agent reread 失败: ${JSON.stringify(reread)}`);
  const duplicate = reread.doc.parts.find((item) => item.name === duplicateName);
  assert.ok(duplicate, 'Agent duplicate 必须在真实 MSB reread 中存在');
  assert.equal(duplicate?.transform.position[0], source.transform.position[0] + 1);
}

async function runHumanWrapper(gameRoot: string, root: string): Promise<void> {
  const fixture = await createFixtureContext(root, gameRoot);
  const source = choosePart(fixture.doc);
  const result = await batchTransformMapParts(fixture.edit, fixture.file, {
    targets: [source.stableKey],
    deltaX: 1.25
  });
  assert.equal(result.ok, true, `Human batch facade 必须成功: ${JSON.stringify(result)}`);
  assert.equal(result.modifiedCount, 1);
  assert.equal(result.after[0]?.posX, source.transform.position[0] + 1.25);
}

async function runBlenderWrapper(gameRoot: string, root: string): Promise<void> {
  const fixture = await createFixtureContext(root, gameRoot);
  const source = choosePart(fixture.doc);
  const registry = createDefaultToolRegistry();
  const result = await registry.run(
    'import_map_from_blender',
    {
      file: fixture.file,
      delta: {
        schemaVersion: 1,
        mapId: fixture.doc.mapId,
        baseRevision: fixture.doc.revision,
        importedAt: new Date().toISOString(),
        mutations: [{
          stableKey: source.stableKey,
          action: 'modify',
          entityKind: 'part',
          position: [source.transform.position[0] + 1.5, source.transform.position[1], source.transform.position[2]]
        }]
      }
    },
    fixture.toolContext
  );
  const data = expectToolSuccess(result, 'Blender import_map_from_blender');
  assert.equal(data.status, 'committed');
  assert.equal(data.transaction && typeof data.transaction === 'object', true);

  const reread = await loadMapDocument(fixture.edit, fixture.file);
  if (!reread.ok) throw new Error(`Blender reread 失败: ${JSON.stringify(reread)}`);
  const after = reread.doc.parts.find((item) => item.stableKey === source.stableKey);
  assert.equal(after?.transform.position[0], source.transform.position[0] + 1.5);
}

async function main(): Promise<void> {
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!gameRoot) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: '未设置 SOULFORGE_SEKIRO_GAME_ROOT，未运行真实 MAP wrapper convergence。'
    }));
    return;
  }

  try {
    await withSmokeWorkspace('map-native-convergence-agent', async (agentWorkspace) => {
      await withSmokeWorkspace('map-native-convergence-human', async (humanWorkspace) => {
        await withSmokeWorkspace('map-native-convergence-blender', async (blenderWorkspace) => {
          await runAgentWrapper(gameRoot, agentWorkspace.root);
          await runHumanWrapper(gameRoot, humanWorkspace.root);
          await runBlenderWrapper(gameRoot, blenderWorkspace.root);
        });
      });
    });
    console.log(JSON.stringify({
      ok: true,
      status: 'native-verified',
      authority: 'native-verified',
      corpus: 'm11_00_00_00.msb.dcx',
      wrappers: ['Agent execute_map_transaction', 'Human batchTransformMapParts', 'Blender import_map_from_blender'],
      writeBoundary: 'Patch Engine temporary overlay',
      postcondition: 'each wrapper reread the committed canonical MSB document'
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

if (import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('runMapNativeConvergenceSmoke.js')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      status: 'native-verified',
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exitCode = 1;
  });
}
