/**
 * S18-A（event-common-load.md §9 顺序 1 / §5A）会话缓存验证。
 *
 * 断言对象：Bridge `read-emevd-document` 在**同一文件、同一内容**下连续多页
 * 只解压/解析一次——`DcxNativeDocument.Read` / `EmevdNativeDocument.Read` 的
 * 进程级累计计数（`reportReadCounts` 钩子）在 10 页循环后仍为 1。
 *
 * 步骤：
 *  1. synthetic EMEVD（10 条指令）写盘；
 *  2. `reportReadCounts: true` 连续读 10 页（pageSize=1）→ 每页 ok；
 *  3. 断言最后一页的 EMEVD_SESSION_READ_COUNTS：emevdReads=1（raw .emevd 无
 *     DCX 解压，dcxReads=0）；
 *  4. write-emevd 写回暂存（成功）→ 缓存按路径失效 → 再读 1 页：
 *     emevdReads=2（「写回后的重读另计」，完成标准第 4 条）；
 *  5. 第二份文件（同内容不同路径）→ 计数 +1（按 realpath+mtime+length 键，
 *     不同文件不共享缓存，但同一文件后续页共享）。
 *
 * 这是算法级断言，不是「感觉快了」：读计数来自 Bridge 进程内静态钩子，
 * 通过 diagnostics 回传，TypeScript 侧不猜测。
 */
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { buildSyntheticEmevd } from './syntheticEmevdBytes.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface ReadCounts {
  dcxReads: number;
  emevdReads: number;
  invalidations: number;
}

function readCountsOf(diagnostics: Array<{ code: string; message: string }>): ReadCounts | null {
  const diagnostic = diagnostics.find((d) => d.code === 'EMEVD_SESSION_READ_COUNTS');
  if (!diagnostic) return null;
  const dcx = /dcxReads=(\d+)/.exec(diagnostic.message);
  const emevd = /emevdReads=(\d+)/.exec(diagnostic.message);
  const invalidations = /invalidations=(\d+)/.exec(diagnostic.message);
  if (!dcx || !emevd || !invalidations) return null;
  return {
    dcxReads: Number(dcx[1]),
    emevdReads: Number(emevd[1]),
    invalidations: Number(invalidations[1])
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-cache-'));
  try {
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });
    const emevdPath = join(staging, 'common.emevd');
    // 10 条指令 → pageSize=1 正好 10 页（文档「连续 10 页」口径）。
    const bytes = buildSyntheticEmevd([
      {
        id: 50,
        restBehavior: 0,
        instructions: Array.from({ length: 10 }, (_unused, i) => ({
          bank: 1000 + i,
          id: 0,
          args: Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        }))
      }
    ]);
    await writeFile(emevdPath, bytes);

    const allowedRoots = [staging];
    let lastSourceHash = '';
    const readPage = async (page: number): Promise<{ ok: boolean; counts: ReadCounts | null }> => {
      const result = await runBridge<{ instructionPageCount?: number; sourceHash?: string }>({
        command: 'read-emevd-document',
        filePath: emevdPath,
        allowedRoots,
        timeoutMs: 60_000,
        commandOptions: { instructionPage: page, instructionPageSize: 1, reportReadCounts: true }
      });
      if (typeof result.data?.sourceHash === 'string' && result.data.sourceHash !== '') {
        lastSourceHash = result.data.sourceHash;
      }
      return {
        ok: result.parseStatus !== 'failed' && result.data !== undefined,
        counts: readCountsOf(result.diagnostics)
      };
    };

    // 10 页循环：每页必须 ok，且第 10 页的计数 emevdReads 仍为 1。
    let lastCounts: ReadCounts | null = null;
    for (let page = 0; page < 10; page += 1) {
      const pageResult = await readPage(page);
      assert(pageResult.ok, `第 ${page + 1} 页读取失败。`);
      assert(pageResult.counts !== null, `第 ${page + 1} 页缺少 EMEVD_SESSION_READ_COUNTS 诊断（reportReadCounts 未生效？）。`);
      lastCounts = pageResult.counts;
    }
    assert(lastCounts !== null, '无计数结果。');
    assert(
      lastCounts.emevdReads === 1,
      `同一文件连续 10 页后 EmevdNativeDocument.Read 次数应为 1，实际 ${lastCounts.emevdReads}（缓存未命中？）。`
    );
    assert(
      lastCounts.dcxReads === 0,
      `raw .emevd 不应触发 DCX 解压，实际 dcxReads=${lastCounts.dcxReads}。`
    );

    // 写回（staging 副本，不改源文件）后重读：源 mtime/长度未变 → 缓存仍命中
    // （Read 次数不涨）。「写回后的重读另计」指的是写回**改动了源**的场景——
    // 那会走下面的 mtime 键失效路径（文档 §5A「写回成功 / 文件变更：丢缓存」）。
    // 写回本身带 writableRoots → runBridge 按 writableRoots 分池（不同 daemon
    // 进程），因此写回侧的 Invalidate 不会影响读侧缓存；读侧失效靠 mtime 键。
    const outputPath = join(staging, 'staged-common.emevd');
    assert(lastSourceHash !== '', '读取未返回 sourceHash（写回校验需要）。');
    const writeResult = await runBridge<unknown>({
      command: 'write-emevd',
      filePath: emevdPath,
      allowedRoots,
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        sourceFormat: 'emevd',
        outputPath,
        expectedDocumentHash: lastSourceHash,
        // 一条真实 mutation（首条指令 args 全 0）：让写回校验真跑，而不是空写。
        mutations: [{
          kind: 'set_instruction_args',
          instructionIndex: 0,
          eventId: 50,
          argsBase64: Buffer.alloc(8).toString('base64')
        }]
      }
    });
    assert(
      writeResult.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED'),
      `写回失败：${JSON.stringify(writeResult.diagnostics)}`
    );
    const afterWrite = await readPage(0);
    assert(afterWrite.counts !== null, '写回后重读缺少计数诊断。');
    assert(
      afterWrite.counts.emevdReads === 1,
      `写回（不改源）后重读应命中缓存，emevdReads 应保持 1，实际 ${afterWrite.counts.emevdReads}。`
    );

    // 文件变更（mtime 变化）→ 缓存键失效 → 重读重新解析。
    await utimes(emevdPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const afterTouch = await readPage(0);
    assert(afterTouch.counts !== null, 'touch 后重读缺少计数诊断。');
    assert(
      afterTouch.counts.emevdReads === 2,
      `文件变更后重读应重新解析，emevdReads 应为 2，实际 ${afterTouch.counts.emevdReads}。`
    );

    // 第二份文件（同内容不同路径）：独立键，读计数 +1（不共享缓存）。
    const secondPath = join(staging, 'common_func.emevd');
    await writeFile(secondPath, bytes);
    const secondResult = await runBridge<unknown>({
      command: 'read-emevd-document',
      filePath: secondPath,
      allowedRoots,
      timeoutMs: 60_000,
      commandOptions: { instructionPage: 0, instructionPageSize: 1, reportReadCounts: true }
    });
    const secondCounts = readCountsOf(secondResult.diagnostics);
    assert(secondCounts !== null, '第二份文件缺少计数诊断。');
    assert(
      secondCounts.emevdReads === 3,
      `第二份文件应重新解析（独立缓存键），emevdReads 应为 3，实际 ${secondCounts.emevdReads}。`
    );
    // 第二份文件连续再读：仍不触发新解析。
    const secondAgain = await readPage(0);
    assert(secondAgain.counts !== null, '第二份文件重读缺少计数诊断。');
    assert(
      secondAgain.counts.emevdReads === 3,
      `第二份文件同键重读不应再解析，emevdReads 应保持 3，实际 ${secondAgain.counts.emevdReads}。`
    );

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD 会话缓存：同一文件连续 10 页 Read=1；写回失效重读另计；第二份独立键',
      pagesRead: 10,
      emevdReadsAfter10Pages: lastCounts.emevdReads,
      emevdReadsAfterWrite: afterWrite.counts.emevdReads,
      emevdReadsSecondFile: secondCounts.emevdReads
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
