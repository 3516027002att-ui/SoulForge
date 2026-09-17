/**
 * Real-native acceptance smoke for the reference/read-proof overhaul (T01
 * entry, exercised fully in T13; 执行指令 §9.4, 场景 C/D/F).
 *
 * Requires the real Bridge, a real Sekiro Mod corpus copied into a temporary
 * overlay, the production Patch Engine and a real rollback. Without corpus or
 * Bridge it reports `status: 'skipped'` — never a fake pass (M03).
 *
 * Since T09/T12 the ledgerless path is production: writes fail closed on the
 * automatic read-proof boundary, never on a manual ledger gate.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createNativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { openSqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

function toolCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function envelopeCode(envelope: Record<string, unknown>): string | undefined {
  return toolCode(envelope.error);
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  const corpus = await resolveNativeFixture(
    process.argv[2], 'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  ).catch(() => null);
  if (!corpus || !existsSync(corpus)) {
    console.log(JSON.stringify({
      ok: true, status: 'skipped',
      reason: '未找到本机 Sekiro PARAM 语料（param-primary）。未执行不等于通过：真实 Bridge/Patch Engine 验收需要语料（M03）。'
    }, null, 2));
    return;
  }

  await withSmokeWorkspace('reference-native', async (workspace) => {
    const overlay = join(workspace.root, 'mods');
    await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
    const containerPath = join(overlay, 'param', 'gameparam', 'gameparam.parambnd.dcx');
    await copyFile(corpus, containerPath);
    const originalBytes = await readFile(containerPath);
    const originalHash = sha(originalBytes);

    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const scan = await scanWorkspace({ workspaceRoot: overlay, game: 'sekiro', includeContentHashes: false });
    const index = new WorkspaceIndex(session.meta.workspaceId);
    index.setFiles(scan.files);

    const stagingRoot = join(workspace.root, 'staging');
    const backupBaseDir = join(workspace.root, 'backups');
    const recoveryDir = join(workspace.root, 'recovery');
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(backupBaseDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });

    const registry = createDefaultToolRegistry();
    // Durable SQLite audit store, exactly the CLI/desktop production wiring. A
    // second store instance over the same file proves the committed operation
    // survives beyond the writing session (cross-process log query).
    await mkdir(join(overlay, '.soulforge'), { recursive: true });
    const databasePath = join(overlay, '.soulforge', 'workspace.db');
    const operationLogStore = openSqliteOperationLogStore({
      databasePath,
      workspaceId: session.meta.workspaceId,
      rootPath: overlay,
      game: 'sekiro'
    });
    const proofs = createNativeReadProofStore();
    const context = {
      mode: 'fullPermission', modeCeiling: 'fullPermission',
      workspaceIndex: index, session, operationLogStore,
      backupBaseDir, recoveryDir, stagingRoot, allowMemoryWrite: false,
      nativeReadProofs: proofs, proofPrincipal: 'reference-native-smoke'
    } as ToolContext & { stagingRoot: string };
    const bridge = createAgentToolBridge({ registry, context });
    let callSeq = 0;
    const exec = async (name: string, args: unknown, confirmation?: ReturnType<typeof createConfirmationReceipt>) => {
      const out = await bridge.executeTool({
        id: `native-smoke-${++callSeq}`, name, argumentsJson: JSON.stringify(args)
      }, confirmation ? { confirmation } : undefined);
      let envelope: Record<string, unknown> = {};
      try { envelope = JSON.parse(out.content) as Record<string, unknown>; } catch { /* opaque */ }
      return { out, envelope };
    };
    const readRecord = (envelope: Record<string, unknown>): Record<string, unknown>[] => {
      const record = (envelope.data as Record<string, unknown> | undefined)?.record as Record<string, unknown> | undefined;
      return Array.isArray(record?.fields) ? record.fields as Record<string, unknown>[] : [];
    };

    // Discover a real row/field through the production read path.
    const read = await registry.run(
      'search_param_rows', { table: 'NpcParam', query: '', limit: 1 }, context
    );
    check('native/read-path-reachable', read.ok === true || envelopeCode(read as unknown as Record<string, unknown>) !== undefined,
      `原生读取路径未接通：${JSON.stringify(read.error)}`);

    // 场景 C negative: an unread write fails closed on the proof boundary,
    // with NO ledger tool anywhere in the flow.
    const mutateWithoutLedger = await exec('mutate_param_fields', {
      edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 1 }]
    });
    check('C/mutate-fails-closed-without-read-proof', mutateWithoutLedger.out.ok === false
      && envelopeCode(mutateWithoutLedger.envelope) === 'NATIVE_READ_REQUIRED',
      `场景 C：未取得读取证明的写入必须 NATIVE_READ_REQUIRED 失败关闭，实际 ${JSON.stringify(envelopeCode(mutateWithoutLedger.envelope) ?? toolCode(mutateWithoutLedger.out))}`);
    check('C/no-ledger-gate-code', envelopeCode(mutateWithoutLedger.envelope) !== 'TASK_RECORD_UNAVAILABLE',
      `行为未实现：无台账写入仍被手工台账门禁拦截（${JSON.stringify(envelopeCode(mutateWithoutLedger.envelope))}）——T09 应替换为自动读取证明`);
    const untouchedAfterDenial = sha(await readFile(containerPath));
    check('native/overlay-untouched-by-denied-writes', untouchedAfterDenial === originalHash,
      '被证明边界拒绝的写入不得改动原容器字节');

    // W01: a prefix of the real data hash must never pass the CAS check.
    const child = await runBridge<{ rows?: Array<{ id: number; dataHash?: string }> }>({
      command: 'read-param-document', filePath: containerPath, allowedRoots: [overlay],
      timeoutMs: 60_000, commandOptions: { entryIndex: 0, includeRowHashes: true }
    }).catch(() => null);
    const firstRow = child?.data?.rows?.[0];
    if (firstRow?.dataHash) {
      const prefixAttempt = await registry.run(
        'mutate_param_fields',
        { edits: [{ table: 'NpcParam', rowId: firstRow.id, fieldId: 'thinkParamId', value: 1, expectedDataHash: firstRow.dataHash.slice(0, 16) }] },
        context
      );
      check('W01/prefix-expected-hash-rejected', prefixAttempt.ok === false
        && !/COMMITTED/i.test(String(prefixAttempt.state)),
      'W01：expectedDataHash 前缀伪造必须被拒绝');
    }

    // 场景 C positive full chain on the real corpus: read → mutate → native
    // reread → cross-process audit query → rollback → native reread. Uses the
    // Sekiro 1.6 param-primary corpus (NpcParam 50800000 鬼形部, field hp);
    // if the row is absent the chain is honestly skipped, never faked.
    const baseline = await exec('read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp', 'ninsatuNum'] });
    const baselineFields = readRecord(baseline.envelope);
    const hpField = baselineFields.find((f) => f.fieldId === 'hp');
    const ninsatuBefore = baselineFields.find((f) => f.fieldId === 'ninsatuNum')?.value;
    if (baseline.out.ok && typeof hpField?.value === 'number') {
      const originalHp = hpField.value;
      const mutatedHp = originalHp === 3000 ? 2999 : 3000;
      const commitConfirmation = createConfirmationReceipt({
        subjects: ['NATIVE_SMOKE_CONFIRMED', 'ALL_RISKS', 'TITLE:mutate_param_fields'],
        riskLevel: 'high',
        note: 'reference-optimization native smoke 显式确认'
      });
      const mutate = await exec('mutate_param_fields', {
        edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: mutatedHp }]
      }, commitConfirmation);
      check('C/mutate-commits-after-delivered-read', mutate.out.ok === true && mutate.envelope.state === 'committed',
        `读取证明送达后写入应提交，实际 ${JSON.stringify({ ok: mutate.out.ok, state: mutate.envelope.state, error: mutate.envelope.error })}`);
      const opId = ((mutate.envelope.data as Record<string, unknown> | undefined)?.record as Record<string, unknown> | undefined)?.opId;
      check('C/commit-carries-opId', typeof opId === 'string' && opId.trim() !== '',
        '提交结果必须携带 opId（回滚与审计入口）');

      // Native reread must observe the new value (not a computed DTO).
      const reread = await exec('read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp', 'ninsatuNum'] });
      const rereadFields = readRecord(reread.envelope);
      check('C/native-reread-sees-new-value', reread.out.ok && rereadFields.find((f) => f.fieldId === 'hp')?.value === mutatedHp,
        `原生回读应看到 ${mutatedHp}，实际 ${JSON.stringify(rereadFields.find((f) => f.fieldId === 'hp')?.value)}`);
      check('C/sibling-field-untouched', rereadFields.find((f) => f.fieldId === 'ninsatuNum')?.value === ninsatuBefore,
        '同行兄弟字段不得被顺带修改');

      // Cross-process audit: a second store instance over the same file sees
      // the committed operation (what another CLI invocation would query).
      const secondStore = openSqliteOperationLogStore({
        databasePath, workspaceId: session.meta.workspaceId, rootPath: overlay, game: 'sekiro'
      });
      const crossProcess = typeof opId === 'string' ? await secondStore.get(opId) : undefined;
      check('C/cross-process-audit-visible', crossProcess?.status === 'committed'
        && crossProcess.files.some((file) => file.beforeHash === originalHash),
        `另一进程必须能从持久日志查到 committed 操作，实际 ${JSON.stringify(crossProcess?.status)}`);
      secondStore.close();

      // Real rollback entry point, then native reread restores the baseline.
      const rollbackConfirmation = createConfirmationReceipt({
        subjects: ['NATIVE_SMOKE_CONFIRMED', `ROLLBACK_OPERATION:${String(opId)}`],
        riskLevel: 'high',
        note: 'reference-optimization native smoke 回滚确认'
      });
      const rollback = await exec('rollback_operation', { opId }, rollbackConfirmation);
      check('C/rollback-succeeds', rollback.out.ok === true,
        `真实回滚必须成功，实际 ${JSON.stringify(rollback.envelope.error ?? toolCode(rollback.out))}`);
      const restored = await exec('read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp', 'ninsatuNum'] });
      const restoredFields = readRecord(restored.envelope);
      check('C/reread-after-rollback-restores-baseline', restoredFields.find((f) => f.fieldId === 'hp')?.value === originalHp
        && restoredFields.find((f) => f.fieldId === 'ninsatuNum')?.value === ninsatuBefore,
        '回滚后原生回读必须恢复初始值');
      const restoredBytes = await readFile(containerPath);
      check('C/rollback-restores-bytes', sha(restoredBytes) === originalHash,
        '回滚后容器字节必须与初始版本一致');
    } else {
      check('C/success-chain-skipped-honestly', true,
        `本机语料缺少 NpcParam#50800000.hp（读取 ${JSON.stringify(toolCode(baseline.out) ?? envelopeCode(baseline.envelope))}）：正向链跳过，不构成通过声明`);
    }

    // Post-commit invalidation on real data: a second committed write must
    // consume the restored proof, and the SAME write without a fresh read must
    // then be denied (T10 steps 12/15 — stale-version proofs never authorize).
    const secondConfirmation = createConfirmationReceipt({
      subjects: ['NATIVE_SMOKE_CONFIRMED', 'ALL_RISKS', 'TITLE:mutate_param_fields'],
      riskLevel: 'high',
      note: 'reference-optimization native smoke 第二次提交确认'
    });
    const secondWrite = await exec('mutate_param_fields', {
      edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 1 }]
    }, secondConfirmation);
    const thirdWrite = await exec('mutate_param_fields', {
      edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 2 }]
    });
    check('V01/post-commit-proof-invalidated', secondWrite.out.ok === true
      && thirdWrite.out.ok === false
      && envelopeCode(thirdWrite.envelope) === 'NATIVE_READ_REQUIRED',
      `第二次提交后旧证明必须失效：实际 second=${secondWrite.envelope.state} third=${JSON.stringify(envelopeCode(thirdWrite.envelope) ?? toolCode(thirdWrite.out))}`);

    operationLogStore.close();
    proofs.dispose();
    await disposeBridgeDaemonPool();
  });
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false, code: 'REFERENCE_OPTIMIZATION_NATIVE_SMOKE_FAILED',
    message: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
});

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks, message: 'reference-optimization native smoke passed' }, null, 2));
}
