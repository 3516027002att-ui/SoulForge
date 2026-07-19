/**
 * User-derived PARAM field typed PatchIR commit + resource-entry rollback.
 * Uses real gameparam ActionGuideParam child; fixture-only field semantics.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndexedFile, ParamDefDocument } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { commitParamFieldThroughPatchIr } from '../editing/paramSemanticCommit.js';
import { readParamDocumentViaBridge } from '../editing/paramBridgeCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackResourceEntry } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface Bnd4ChildSnapshot {
  contentBase64: string;
  name: string;
  contentHash: string;
}

async function main(): Promise<void> {
  const sourceMsgbnd = await resolveNativeFixturePath(
    'param/gameparam/gameparam.parambnd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_PARAM'
  );
  const sourceContainerBytes = await readFile(sourceMsgbnd);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-param-semantic-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
  const target = join(overlay, 'param', 'gameparam', 'ActionGuideParam.param');

  try {
    const child = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceMsgbnd,
      allowedRoots: [dirname(sourceMsgbnd)],
      timeoutMs: 60_000,
      commandOptions: { childPath: 'ActionGuideParam.param' }
    });
    if (!child.data?.contentBase64) {
      // Fallback to first child by index if name lookup varies.
      const byIndex = await runBridge<Bnd4ChildSnapshot>({
        command: 'snapshot-bnd4-child',
        filePath: sourceMsgbnd,
        allowedRoots: [dirname(sourceMsgbnd)],
        timeoutMs: 60_000,
        commandOptions: { entryIndex: 0 }
      });
      if (!byIndex.data?.contentBase64) {
        throw new Error(`PARAM child snapshot failed: ${JSON.stringify(child.diagnostics)}`);
      }
      await writeFile(target, Buffer.from(byIndex.data.contentBase64, 'base64'));
    } else {
      await writeFile(target, Buffer.from(child.data.contentBase64, 'base64'));
    }

    const before = await readParamDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      rowLimit: 1,
      includePayloads: true
    });
    if (!before.ok || !before.data?.rows[0]?.dataBase64) {
      throw new Error(`PARAM semantic baseline failed: ${JSON.stringify(before.diagnostics)}`);
    }
    const first = before.data.rows[0]!;
    const definition: ParamDefDocument = {
      schemaVersion: 1,
      typeName: before.data.typeName,
      version: 1,
      rowDataSize: before.data.rowDataSize,
      origin: 'fixture',
      fields: [{
        id: 'fixture_byte_0',
        name: 'fixtureByte0',
        type: 'u8',
        offset: 0,
        size: 1,
        min: 0,
        max: 255,
        description: 'Fixture-only field; not official ParamDef semantics.'
      }]
    };
    const originalByte = Buffer.from(first.dataBase64!, 'base64')[0] ?? 0;
    const nextValue = (originalByte + 1) & 0xff;

    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const store = new MemoryOperationLogStore();
    const sourceUri = 'file://param/gameparam/ActionGuideParam.param';
    const file: IndexedFile = {
      id: sourceUri,
      workspaceId: session.meta.workspaceId,
      absolutePath: target,
      relativePath: 'param/gameparam/ActionGuideParam.param',
      sourceUri,
      sourcePath: target,
      game: 'sekiro',
      resourceKind: 'param',
      parseStatus: 'parsed',
      diagnostics: [],
      extension: '.param',
      compoundExtension: '.param',
      formatKind: 'param',
      formatLabel: 'PARAM',
      size: (await readFile(target)).length,
      mtimeMs: Date.now()
    };

    const denied = await commitParamFieldThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      rowId: first.id,
      expectedRowHash: first.dataHash,
      definition,
      fieldId: 'fixture_byte_0',
      value: nextValue,
      session,
      operationLog: store
    });
    if (denied.ok || !denied.requiresConfirmation) {
      throw new Error('PARAM semantic confirmation gate did not fail closed');
    }

    const committed = await commitParamFieldThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      rowId: first.id,
      expectedRowHash: first.dataHash,
      definition,
      fieldId: 'fixture_byte_0',
      value: nextValue,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'PARAM_SEMANTIC_FIELD'],
        riskLevel: 'high',
        sourceUri,
        note: 'PARAM semantic field transaction smoke'
      }),
      session,
      operationLog: store,
      title: 'PARAM field typed semantic transaction'
    });
    if (!committed.ok || !committed.opId) {
      throw new Error(`PARAM semantic commit failed: ${JSON.stringify(committed.diagnostics)}`);
    }
    const changes = await store.listResourceEntryChanges(committed.opId);
    if (changes.length !== 1 || changes[0]?.changeKind !== 'field_update') {
      throw new Error(`PARAM semantic inverse persistence failed: ${JSON.stringify(changes)}`);
    }
    const after = await readParamDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      rowId: first.id,
      rowLimit: 1,
      includePayloads: true
    });
    const afterRow = after.data?.rows[0];
    if (!after.ok || !afterRow?.dataBase64
      || afterRow.dataHash === first.dataHash
      || Buffer.from(afterRow.dataBase64, 'base64')[0] !== nextValue) {
      throw new Error('PARAM typed field commit did not survive reread');
    }

    const rolled = await rollbackResourceEntry({
      opId: committed.opId,
      entryUri: changes[0]!.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${committed.opId}:${changes[0]!.entryUri}`],
        riskLevel: 'high',
        note: 'PARAM semantic entry rollback smoke'
      })
    });
    const restored = await readParamDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      rowId: first.id,
      rowLimit: 1,
      includePayloads: true
    });
    const restoredRow = restored.data?.rows[0];
    if (!rolled.ok || !restored.ok || !restoredRow
      || restoredRow.dataHash !== first.dataHash
      || Buffer.from(restoredRow.dataBase64 ?? '', 'base64')[0] !== originalByte
      || !(await readFile(sourceMsgbnd)).equals(sourceContainerBytes)) {
      throw new Error(`PARAM resource-entry rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      message: 'PARAM 用户派生字段 typed PatchIR 提交与 resource-entry 回滚验证通过',
      rowId: first.id,
      fieldId: 'fixture_byte_0',
      semanticPatchIrFieldCommitVerified: true,
      resourceEntryRollbackVerified: true,
      originalFixtureUntouched: true,
      nativeParamdefSemanticsVerified: false
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
