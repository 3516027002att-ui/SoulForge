/**
 * S14 指令级增删 / 事件增删的 production 验证：
 * synthetic EMEVD → Bridge write-emevd（insert_instruction / delete_instruction /
 * add_event + 子指令 / delete_event）→ 重读核对指令数与内容。
 *
 * 合成 fixture 口径：不提升 native authority，只证明写链闭环可用。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitEmevdBatchViaBridge } from '../editing/emevdBridgeCommit.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { encodeInstructionArgs, createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { buildSyntheticEmevd, sha256Hex } from './syntheticEmevdBytes.js';

function fail(message: string): never {
  throw new Error(message);
}

interface EmevdReadEnvelope {
  parseStatus?: string;
  data?: {
    eventCount?: number;
    instructionCount?: number;
    events?: Array<{ id?: number; instructionCount?: number }>;
  };
  diagnostics?: Array<{ code: string; message: string }>;
}

async function main(): Promise<void> {
  const registry = createSekiroFixtureEmedf();
  const waitFor = encodeInstructionArgs(registry, 1000, 0, {
    conditionGroup: -1, pad0: 0, pad1: 0, unknown: 0
  });
  if (!waitFor.ok) fail('encode waitFor failed');
  const endEvent = encodeInstructionArgs(registry, 2003, 1, {});
  if (!endEvent.ok) fail('encode endEvent failed');

  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-structural-'));
  try {
    const sourcePath = join(root, 'common.emevd');
    // 事件 50：2 条 WaitFor(bank 1000 id 0)；事件 60：1 条 EndEvent。
    const bytes = buildSyntheticEmevd([
      { id: 50, restBehavior: 0, instructions: [
        { bank: 1000, id: 0, args: waitFor.args },
        { bank: 1000, id: 0, args: waitFor.args }
      ] },
      { id: 60, restBehavior: 1, instructions: [
        { bank: 2003, id: 1, args: endEvent.args }
      ] }
    ]);
    await writeFile(sourcePath, bytes);
    const hash = sha256Hex(bytes);
    const allowedRoots = [root];
    const writableRoots = [root];

    const outPath = join(root, 'out.emevd');
    const staged = await commitEmevdBatchViaBridge({
      sourcePath,
      outputPath: outPath,
      expectedDocumentHash: hash,
      allowedRoots,
      writableRoots,
      mutations: [
        // 事件 50：删掉第 0 条（剩 1 条），再在第 1 位插入一条 EndEvent。
        { kind: 'delete_instruction', eventId: 50, instructionIndex: 0 },
        { kind: 'insert_instruction', eventId: 50, instructionIndex: 1, bank: 2003, id: 1, argsBase64: endEvent.args.toString('base64') },
        // 新增事件 70：空事件 + 一条 WaitFor。
        { kind: 'add_event', newEventId: 70, restBehavior: 0 },
        { kind: 'insert_instruction', eventId: 70, instructionIndex: 0, bank: 1000, id: 0, argsBase64: waitFor.args.toString('base64') },
        // 删除事件 60。
        { kind: 'delete_event', eventId: 60 }
      ]
    });
    if (!staged.ok) fail(`batch 写入失败: ${JSON.stringify(staged.diagnostics)}`);

    const reread = await runBridge<EmevdReadEnvelope['data']>({
      command: 'read-emevd-document',
      filePath: outPath,
      allowedRoots,
      timeoutMs: 120_000
    });
    if (reread.parseStatus === 'failed') fail(`重读失败: ${JSON.stringify(reread.diagnostics)}`);
    const events = reread.data?.events ?? [];
    const byId = new Map(events.map((event) => [event.id, event]));
    const e50 = byId.get(50);
    const e70 = byId.get(70);
    if (byId.has(60)) fail('事件 60 应被删除');
    if (!e50 || e50.instructionCount !== 2) fail(`事件 50 应有 2 条指令，实际 ${e50?.instructionCount}`);
    if (!e70 || e70.instructionCount !== 1) fail(`事件 70 应有 1 条指令，实际 ${e70?.instructionCount}`);
    const total = reread.data?.instructionCount;
    if (total !== 3) fail(`总指令数应为 3，实际 ${total}`);

    process.stdout.write(JSON.stringify({
      ok: true,
      message: 'EMEVD 指令级增删 / 事件增删 production smoke: ok',
      cases: ['delete_instruction', 'insert_instruction', 'add_event+insert_instruction', 'delete_event'],
      nonClaims: ['synthetic fixture，不提升 native authority', '不覆盖 layer 变体与游戏内加载']
    }, null, 2) + '\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

await main();
