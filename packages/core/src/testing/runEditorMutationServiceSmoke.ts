/**
 * 统一原生 mutation 写链的确定性 smoke。
 *
 * 为什么必须有：写链把「取消」「需要确认后重试」「staging 失败」三条分支从
 * 五处 IPC handler 收敛到一处。收敛的风险是——某条分支静默丢失后，正常路径
 * 依旧通过，UI 上也看不出差别。例如确认取消若被当成失败，用户主动取消会显示
 * 成写入故障；确认重试若丢了 confirmation 参数，第二次提交会再次被门槛拦下
 * 而看起来像「确认不生效」。这些都只能由负向断言锁住。
 *
 * 本 smoke 不加载任何 native 资产，也不写 Mod 工作区：commit 端口是确定性桩，
 * staging 只写系统临时目录。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ConfirmationReceipt, IndexedFile } from '@soulforge/shared';
import {
  applyNativeMutation,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WriteConfirmationPort
} from '../editing/editorMutationService.js';
import type { SaveRawResourceResult } from '../editing/saveRawResource.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail: string): void {
  checks += 1;
  if (!condition) failures.push(`${name}: ${detail}`);
}

const file = {
  relativePath: 'msg/zhocn/item.msgbnd.dcx',
  absolutePath: '/synthetic/item.msgbnd.dcx',
  sourceUri: 'soulforge://synthetic/item',
  game: 'sekiro'
} as unknown as IndexedFile;

function fakeReceipt(marker: string): ConfirmationReceipt {
  return { subjects: [marker], riskLevel: 'high' } as unknown as ConfirmationReceipt;
}

/** 记录每次提交入参的 commit 桩，据此断言 confirmation 真的被透传。 */
function recordingCommit(
  responses: Array<Partial<SaveRawResourceResult>>
): RawReplaceCommitPort & { calls: Array<{ title: string; hasConfirmation: boolean; base64: string }> } {
  const calls: Array<{ title: string; hasConfirmation: boolean; base64: string }> = [];
  let index = 0;
  return {
    calls,
    commit: async (input) => {
      calls.push({
        title: input.title,
        hasConfirmation: input.confirmation !== undefined,
        base64: input.newContentBase64
      });
      const response = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [],
        ...response
      } as SaveRawResourceResult;
    }
  };
}

function confirmPort(receipt: ConfirmationReceipt | null): WriteConfirmationPort & {
  calls: Array<{ payloadHash: string; actionLabel: string }>;
} {
  const calls: Array<{ payloadHash: string; actionLabel: string }> = [];
  return {
    calls,
    requestConfirmation: async (input) => {
      calls.push({ payloadHash: input.payloadHash, actionLabel: input.actionLabel });
      return receipt;
    }
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-mutation-service-'));
  try {
    const payload = Buffer.from('staged-native-bytes');
    const expectedPayloadHash = createHash('sha256').update(payload).digest('hex');
    const stageOk = async ({ outputPath }: { outputPath: string }) => {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, payload);
      return { ok: true as const, diagnostics: [] };
    };

    const baseRequest = {
      file,
      sourceUri: file.sourceUri,
      expectedHash: 'expected-doc-hash',
      allowedRoots: (stagingRoot: string) => [stagingRoot],
      stagingPrefix: 'fmg',
      stagingFileName: 'output.bin',
      title: 'FMG mutation upsert 1',
      confirmActionLabel: '提交 FMG 变更'
    };

    // 1. 一次通过：不得触发确认。
    {
      const commit = recordingCommit([{ ok: true }]);
      const confirm = confirmPort(null);
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'direct'),
        stageWrite: stageOk
      }, { confirm, commit });
      check('direct/committed', outcome.status === 'committed',
        `期望 committed，实际 ${outcome.status}`);
      check('direct/no-confirm-prompt', confirm.calls.length === 0,
        `首次提交成功时不得弹确认，实际弹了 ${confirm.calls.length} 次`);
      check('direct/single-commit', commit.calls.length === 1,
        `期望提交一次，实际 ${commit.calls.length} 次`);
      check('direct/payload-hash',
        outcome.status === 'committed' && outcome.payloadHash === expectedPayloadHash,
        'payloadHash 必须是暂存字节的 sha256。');
    }

    // 2. 需要确认 → 用户同意 → 第二次必须带上凭据。
    {
      const commit = recordingCommit([
        { ok: false, requiresConfirmation: true },
        { ok: true }
      ]);
      const confirm = confirmPort(fakeReceipt('CONFIRMED'));
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'confirm-accept'),
        stageWrite: stageOk
      }, { confirm, commit });
      check('confirm/committed', outcome.status === 'committed' && outcome.result.ok === true,
        `确认后应提交成功，实际 ${JSON.stringify(outcome).slice(0, 200)}`);
      check('confirm/prompted-once', confirm.calls.length === 1,
        `应恰好弹一次确认，实际 ${confirm.calls.length} 次`);
      check('confirm/payload-hash-bound',
        confirm.calls[0]?.payloadHash === expectedPayloadHash,
        '确认必须绑定待写字节的 sha256，否则确认后内容可被替换。');
      check('confirm/retry-carries-receipt',
        commit.calls.length === 2
        && commit.calls[0]?.hasConfirmation === false
        && commit.calls[1]?.hasConfirmation === true,
        `重试必须带 confirmation，实际 ${JSON.stringify(commit.calls)}`);
      check('confirm/same-bytes-retried',
        commit.calls[0]?.base64 === commit.calls[1]?.base64,
        '重试必须提交同一份字节，不得重新暂存产生不同内容。');
    }

    // 3. 用户取消：必须是 cancelled，不能报成失败，且不得再次提交。
    {
      const commit = recordingCommit([{ ok: false, requiresConfirmation: true }]);
      const confirm = confirmPort(null);
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'confirm-cancel'),
        stageWrite: stageOk
      }, { confirm, commit });
      check('cancel/status', outcome.status === 'cancelled',
        `取消必须返回 cancelled 而不是 failed，实际 ${outcome.status}`);
      check('cancel/no-second-commit', commit.calls.length === 1,
        `取消后不得再次提交，实际提交 ${commit.calls.length} 次`);
      check('cancel/keeps-source-uri',
        outcome.status === 'cancelled' && outcome.sourceUri === file.sourceUri,
        '取消结果必须带回 sourceUri 供 UI 定位。');
    }

    // 4. 二次仍要求确认：如实返回，不得无限重试。
    {
      const commit = recordingCommit([
        { ok: false, requiresConfirmation: true },
        { ok: false, requiresConfirmation: true }
      ]);
      const confirm = confirmPort(fakeReceipt('CONFIRMED'));
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'confirm-twice'),
        stageWrite: stageOk
      }, { confirm, commit });
      check('retry-once/no-loop', commit.calls.length === 2 && confirm.calls.length === 1,
        `确认只重试一次，实际 commit=${commit.calls.length} confirm=${confirm.calls.length}`);
      check('retry-once/reports-honestly',
        outcome.status === 'committed' && outcome.result.ok === false,
        '二次仍被门槛拦下时必须如实返回该结果，不得伪装成成功或取消。');
    }

    // 5. staging 抛错：必须结构化诊断，且不得进入提交。
    {
      const commit = recordingCommit([{ ok: true }]);
      const confirm = confirmPort(fakeReceipt('CONFIRMED'));
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'stage-throw'),
        stageWrite: async () => { throw new Error('injected bridge failure'); }
      }, { confirm, commit });
      check('stage-throw/failed', outcome.status === 'failed',
        `staging 抛错必须失败关闭，实际 ${outcome.status}`);
      check('stage-throw/diagnostic-code',
        outcome.status === 'failed'
        && outcome.diagnostics.some((d) => d.code === 'BRIDGE_STAGING_WRITE_FAILED'),
        `必须返回结构化诊断而不是吞异常，实际 ${JSON.stringify(outcome).slice(0, 300)}`);
      check('stage-throw/no-commit', commit.calls.length === 0,
        'staging 失败后不得进入 Patch Engine 提交。');
      check('stage-throw/diagnostic-has-source-uri',
        outcome.status === 'failed' && outcome.diagnostics.every((d) => d.sourceUri === file.sourceUri),
        '每条诊断必须带 sourceUri。');
    }

    // 6. Bridge 返回 ok:false 且自带诊断：必须透出 Bridge 的诊断码，
    //    不能被兜底码覆盖——那会让真实失败原因丢失。
    {
      const commit = recordingCommit([{ ok: true }]);
      const confirm = confirmPort(null);
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'bridge-diag'),
        stageWrite: async () => ({
          ok: false as const,
          diagnostics: [{ severity: 'error', code: 'FMG_EXPECTED_HASH_MISMATCH', message: '文档哈希不匹配。' }]
        })
      }, { confirm, commit });
      check('bridge-diag/failed', outcome.status === 'failed',
        `Bridge 失败必须失败关闭，实际 ${outcome.status}`);
      check('bridge-diag/preserves-code',
        outcome.status === 'failed'
        && outcome.diagnostics.some((d) => d.code === 'FMG_EXPECTED_HASH_MISMATCH'),
        `必须保留 Bridge 自身诊断码，实际 ${JSON.stringify(outcome).slice(0, 300)}`);
      check('bridge-diag/no-commit', commit.calls.length === 0,
        'Bridge 失败后不得进入提交。');
    }

    // 7. Bridge 返回 ok:false 但没有任何诊断：必须给兜底码，
    //    否则会返回空诊断数组，等于静默失败。
    {
      const outcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'bridge-silent'),
        stageWrite: async () => ({ ok: false as const })
      }, { confirm: confirmPort(null), commit: recordingCommit([{ ok: true }]) });
      check('bridge-silent/no-empty-diagnostics',
        outcome.status === 'failed' && outcome.diagnostics.length > 0,
        '失败时诊断数组不得为空——空诊断就是静默失败。');
      check('bridge-silent/fallback-code',
        outcome.status === 'failed'
        && outcome.diagnostics.some((d) => d.code === 'BRIDGE_STAGING_FAILED'),
        '两个来源都没有诊断时必须给出兜底码。');
    }

    // 8. 暂存名不安全时必须在写出前拦下（bridgeStaging 的既有边界，
    //    这里确认统一写链没有绕开它）。
    {
      let staged = false;
      const outcome: NativeMutationOutcome = await applyNativeMutation({
        ...baseRequest,
        stagingRoot: join(root, 'unsafe-name'),
        stagingFileName: '../escape.bin',
        stageWrite: async ({ outputPath }) => {
          staged = true;
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, payload);
          return { ok: true as const, diagnostics: [] };
        }
      }, { confirm: confirmPort(null), commit: recordingCommit([{ ok: true }]) });
      check('unsafe-name/rejected',
        outcome.status === 'failed'
        && outcome.diagnostics.some((d) => d.code === 'BRIDGE_STAGING_PATH_INVALID'),
        `不安全暂存名必须被拦下，实际 ${JSON.stringify(outcome).slice(0, 300)}`);
      check('unsafe-name/never-wrote', staged === false,
        '不安全暂存名必须在调用 Bridge 之前拦下。');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      message: `统一 mutation 写链 smoke 失败 ${failures.length} 项`,
      checks,
      failures
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    message: `统一原生 mutation 写链 smoke 通过（${checks} 项断言）`,
    checks,
    lockedBehaviours: [
      '首次提交成功时不弹确认，只提交一次',
      'payloadHash 是暂存字节的 sha256，确认凭据绑定它',
      '需要确认时重试恰好一次且带上凭据，提交同一份字节',
      '用户取消返回 cancelled 而非 failed，且不再提交',
      '二次仍被门槛拦下时如实返回，不无限重试',
      'staging 抛错 / Bridge 失败一律结构化诊断且不进入提交',
      'Bridge 自身诊断码不被兜底码覆盖；两者皆空时仍给兜底码',
      '不安全暂存名在调用 Bridge 之前被拦下'
    ],
    authority: 'fixture-confirmed（确定性桩，不加载 native 资产，不构成 native writer 声明）'
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
