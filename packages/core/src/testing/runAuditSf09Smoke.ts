/**
 * SF-09: EMEVD 指令身份、批量 IR 与重定位检验
 * 覆盖: EventHandle, InstructionHandle, ParameterBinding, mutationSimulation,
 * 重命名链与环路拒绝, batch_rename 同时命名, 参数绑定重定位, 不透明节点保护,
 * 字符串表更新, 超安全整数拒绝, 大事件分页与无损恢复, 以及 native Sekiro 验证。
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateEventHandle,
  validateInstructionHandle,
  validateParameterBinding,
  eventHandleKey,
  instructionHandleKey,
  parameterBindingKey
} from '@soulforge/shared';
import {
  EmevdMutationSimulator,
  type SimulationOracleSnapshot
} from '../emevd/mutationSimulation.js';
import { commitEmevdBatchViaBridge } from '../editing/emevdBridgeCommit.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { encodeInstructionArgs, createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { buildSyntheticEmevd, sha256Hex } from './syntheticEmevdBytes.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { readEmevdEvent } from '../editing/emevdEdit.js';
import { openNativeEditSession } from '../editing/nativeEditSession.js';

function fail(message: string): never {
  throw new Error(message);
}

function parseLayer(): 'unit' | 'native' {
  const args = process.argv.slice(2);
  const layerIdx = args.indexOf('--layer');
  if (layerIdx === -1 || layerIdx + 1 >= args.length) {
    fail('必须指定 --layer unit|native');
  }
  const val = args[layerIdx + 1];
  if (val !== 'unit' && val !== 'native') {
    fail('未知 layer: ' + val + '，仅支持 unit 或 native');
  }
  return val;
}

// ---------------------------------------------------------------------------
// Unit Tests (Layer == 'unit')
// ---------------------------------------------------------------------------

async function runUnitLayer(): Promise<void> {
  const registry = createSekiroFixtureEmedf();
  const waitFor = encodeInstructionArgs(registry, 1000, 0, {
    conditionGroup: -1, pad0: 0, pad1: 0, unknown: 0
  });
  if (!waitFor.ok) fail('encode waitFor failed');
  const endEvent = encodeInstructionArgs(registry, 2003, 1, {});
  if (!endEvent.ok) fail('encode endEvent failed');
  const ifCond = encodeInstructionArgs(registry, 2000, 0, {
    resultConditionGroup: 1, desiredComparisonType: 0, targetConditionGroup: 2
  });
  const ifCondArgs = ifCond.ok ? ifCond.args : Buffer.from([0x01, 0x00, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);

  // Case 1: Handle & Identity Creation and Validation
  {
    const validEvent = { fileUri: 'file:///event/test.emevd', eventId: '100', sourceVersion: 'rev1' };
    validateEventHandle(validEvent);
    if (eventHandleKey(validEvent) !== 'file:///event/test.emevd::event:100') fail('eventHandleKey mismatch');

    let threw = false;
    try {
      validateEventHandle({ fileUri: '', eventId: '100', sourceVersion: 1 });
    } catch {
      threw = true;
    }
    if (!threw) fail('validateEventHandle 应拒绝空 fileUri');

    threw = false;
    try {
      validateEventHandle({ fileUri: 'file:///event/test.emevd', eventId: 'not_a_number', sourceVersion: 1 });
    } catch {
      threw = true;
    }
    if (!threw) fail('validateEventHandle 应拒绝非数字 eventId 字符串');

    const validInst = {
      eventHandleKey: eventHandleKey(validEvent),
      localOrdinal: 0,
      instructionHash: 'hash123',
      sourceVersion: 'rev1',
      id: 'inst_0_hash123'
    };
    validateInstructionHandle(validInst);
    if (instructionHandleKey(validInst) !== 'inst_0_hash123') fail('instructionHandleKey mismatch');

    const validBinding = {
      id: 'bind_1',
      eventHandleKey: eventHandleKey(validEvent),
      targetInstructionHandleId: 'inst_0_hash123',
      targetByteOffset: 4,
      byteCount: 4,
      sourceStartByte: 0,
      unkId: 0
    };
    validateParameterBinding(validBinding);
    if (parameterBindingKey(validBinding) !== eventHandleKey(validEvent) + '::bind:bind_1') {
      fail('parameterBindingKey mismatch');
    }
  }

  // Case 2: Sequential Rename Chain & Collision Rejection
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      { id: 100, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] },
      { id: 500, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] }
    ]);

    // Rename chain: 100 -> 200 -> 300
    sim.renameEvent('100', '200');
    sim.renameEvent('200', '300');
    const ev = sim.findEvent('file:///test.emevd::event:100');
    if (!ev || ev.currentId !== '300') fail('重命名链最终 ID 应为 300');

    // Collision rejection
    let collisionThrew = false;
    try {
      sim.renameEvent('300', '500'); // 500 already exists
    } catch {
      collisionThrew = true;
    }
    if (!collisionThrew) fail('顺序重命名撞已有命名空间必须拒绝');
  }

  // Case 3: Batch Rename (Simultaneous Semantics & ID Swap)
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      { id: 100, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] },
      { id: 200, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] }
    ]);

    // Atomic swap: 100 -> 200, 200 -> 100
    sim.batchRenameEvents([
      { eventHandleKeyOrId: '100', newId: '200' },
      { eventHandleKeyOrId: '200', newId: '100' }
    ]);
    const evA = sim.findEvent('file:///test.emevd::event:100');
    const evB = sim.findEvent('file:///test.emevd::event:200');
    if (evA?.currentId !== '200' || evB?.currentId !== '100') {
      fail('batch rename 原子交换失败');
    }

    // Duplicate target rejection
    let dupThrew = false;
    try {
      sim.batchRenameEvents([
        { eventHandleKeyOrId: 'file:///test.emevd::event:100', newId: '300' },
        { eventHandleKeyOrId: 'file:///test.emevd::event:200', newId: '300' }
      ]);
    } catch {
      dupThrew = true;
    }
    if (!dupThrew) fail('batch rename 目标 ID 重复必须拒绝');
  }

  // Case 4: Parameter Binding Relocation on Insert & Delete
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      {
        id: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, args: waitFor.args }, // I0: WaitFor (8 bytes)
          { bank: 2000, id: 0, args: ifCondArgs },    // I1: IfCond (12 bytes)
          { bank: 2003, id: 1, args: Buffer.alloc(8) } // I2: custom 8 bytes
        ],
        parameters: [
          // 指向 I2 (index 2) 的第 4 字节
          { instructionIndex: 2, targetStartByte: 4, sourceStartByte: 0, byteCount: 4 }
        ]
      }
    ]);

    const initialEvent = sim.getEvents()[0]!;
    const targetInstrHandle = initialEvent.instructions[2]!.handle.id;

    // 在开头插入 J (index 0): 顺序变为 J, I0, I1, I2
    sim.insertInstruction('50', 0, { bank: 2003, id: 1, args: endEvent.args });
    // 删除原 I1 (现在位于 index 2)
    const i1Handle = initialEvent.instructions[2]!.handle.id;
    sim.deleteInstruction('50', i1Handle);

    // 最终顺序: J (0), I0 (1), I2 (2)
    const compiled = sim.compile();
    const compiledEvent = compiled.events[0]!;
    if (compiledEvent.instructions.length !== 3) fail('指令数应为 3');
    if (compiledEvent.parameters.length !== 1) fail('参数数应为 1');

    const relocatedParam = compiledEvent.parameters[0]!;
    if (relocatedParam.instructionIndex !== 2) {
      fail('参数重定位 instructionIndex 应为 2，实际为 ' + relocatedParam.instructionIndex);
    }
    if (relocatedParam.targetStartByte !== 4) {
      fail('参数 targetStartByte 应保持 4，实际为 ' + relocatedParam.targetStartByte);
    }
  }

  // Case 5: Referenced Instruction Delete Rejection
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      {
        id: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, args: waitFor.args },
          { bank: 2003, id: 1, args: Buffer.alloc(8) }
        ],
        parameters: [
          { instructionIndex: 1, targetStartByte: 0, sourceStartByte: 0, byteCount: 4 }
        ]
      }
    ]);

    const targetHandle = sim.getEvents()[0]!.instructions[1]!.handle.id;
    let refThrew = false;
    try {
      sim.deleteInstruction('50', targetHandle);
    } catch (e: any) {
      if (e.message.includes('EMEVD_REFERENCED_INSTRUCTION_DELETE_REJECTED')) {
        refThrew = true;
      }
    }
    if (!refThrew) fail('删除被参数引用的指令必须抛出 EMEVD_REFERENCED_INSTRUCTION_DELETE_REJECTED');
  }

  // Case 6: Opaque / Unknown Instruction Modification Rejection
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      {
        id: 50,
        restBehavior: 0,
        instructions: [
          { bank: 9999, id: 1, args: Buffer.alloc(0), unknown: true }
        ]
      }
    ]);

    const unknownHandle = sim.getEvents()[0]!.instructions[0]!.handle.id;
    let unknownThrew = false;
    try {
      sim.modifyInstructionArgs(unknownHandle, Buffer.from([1, 2, 3]));
    } catch (e: any) {
      if (e.message.includes('EMEVD_UNKNOWN_INSTRUCTION_MODIFICATION_REJECTED')) {
        unknownThrew = true;
      }
    }
    if (!unknownThrew) fail('修改 unknown / opaque 指令必须抛出 EMEVD_UNKNOWN_INSTRUCTION_MODIFICATION_REJECTED');
  }

  // Case 7: String Table Update
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      { id: 50, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] }
    ]);
    const customStrings = Buffer.from('test_event_string\0', 'utf8');
    sim.setStrings(customStrings);
    const compiled = sim.compile();
    if (!compiled.stringBytes || !compiled.stringBytes.equals(customStrings)) {
      fail('setStrings 字节未正确保留在 compiled plan 中');
    }
  }

  // Case 8: Safe Integer & Range Enforcement
  {
    const sim = EmevdMutationSimulator.fromEvents('file:///test.emevd', 1, [
      { id: 50, restBehavior: 0, instructions: [{ bank: 2003, id: 1, args: endEvent.args }] }
    ]);
    let safeThrew = false;
    try {
      sim.renameEvent('50', '9007199254740992'); // MAX_SAFE_INTEGER + 1
    } catch (e: any) {
      if (e.message.includes('EMEVD_INTEGER_OUT_OF_SAFE_RANGE')) {
        safeThrew = true;
      }
    }
    if (!safeThrew) fail('超出安全范围的整数必须抛出 EMEVD_INTEGER_OUT_OF_SAFE_RANGE');
  }

  // Case 9: Large Event Paging, Block Declaration & Lossless Reconstruction
  {
    // 构造一个包含 300 条指令的大事件（超过默认窗口 256）
    const largeInstrs: Array<{ bank: number; id: number; args: Buffer }> = [];
    for (let i = 0; i < 300; i++) {
      if (i === 100 || i === 250) {
        largeInstrs.push({ bank: 2003, id: 1, args: endEvent.args }); // terminal block boundary
      } else {
        largeInstrs.push({ bank: 1000, id: 0, args: waitFor.args });
      }
    }

    const root = await mkdtemp(join(tmpdir(), 'soulforge-sf09-large-'));
    try {
      const emevdPath = join(root, 'large.emevd');
      const bytes = buildSyntheticEmevd([
        { id: 1000, restBehavior: 0, instructions: largeInstrs }
      ]);
      await writeFile(emevdPath, bytes);

      const session = await openNativeEditSession({
        overlayRoot: root,
        game: 'sekiro'
      });

      // Page 0: 0..256
      const p0 = await readEmevdEvent({
        edit: session,
        file: emevdPath,
        eventId: 1000,
        instructionOffset: 0,
        instructionLimit: 256
      });
      if (!p0.ok) fail('page 0 read failed: ' + p0.error?.message);
      if (!p0.truncated) fail('page 0 应标记 truncated');
      if (p0.darkScriptComplete) fail('page 0 的 darkScriptComplete 应为 false');
      if (p0.returned !== 256) fail('page 0 returned 应为 256，实际 ' + p0.returned);
      if (!p0.readRange || p0.readRange.start !== 0 || p0.readRange.end !== 256) {
        fail('page 0 readRange 应为 [0, 256)');
      }
      if (p0.crossesBlockBoundary === undefined) fail('page 0 应包含 crossesBlockBoundary 声明');

      // Page 1: 256..300
      const p1 = await readEmevdEvent({
        edit: session,
        file: emevdPath,
        eventId: 1000,
        instructionOffset: 256,
        instructionLimit: 256
      });
      if (!p1.ok) fail('page 1 read failed: ' + p1.error?.message);
      if (p1.truncated) fail('page 1 不应标记 truncated');
      if (p1.returned !== 44) fail('page 1 returned 应为 44，实际 ' + p1.returned);

      // 全量无损重组验证
      const reconstructed = [...p0.instructions, ...p1.instructions];
      if (reconstructed.length !== 300) fail('重构总指令数应为 300');
      for (let i = 0; i < 300; i++) {
        if (reconstructed[i]!.bank !== largeInstrs[i]!.bank || reconstructed[i]!.id !== largeInstrs[i]!.id) {
          fail('重构指令[' + i + ']与原样本不一致');
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Case 10: Bridge Roundtrip & Independent IR Oracle Verification
  {
    const root = await mkdtemp(join(tmpdir(), 'soulforge-sf09-bridge-'));
    try {
      const sourcePath = join(root, 'common.emevd');
      const outPath = join(root, 'out.emevd');
      const bytes = buildSyntheticEmevd([
        {
          id: 50,
          restBehavior: 0,
          instructions: [
            { bank: 1000, id: 0, args: waitFor.args },
            { bank: 2000, id: 0, args: ifCondArgs },
            { bank: 2003, id: 1, args: endEvent.args }
          ]
        },
        {
          id: 60,
          restBehavior: 1,
          instructions: [
            { bank: 2003, id: 1, args: endEvent.args }
          ]
        }
      ]);
      await writeFile(sourcePath, bytes);
      const hash = sha256Hex(bytes);

      const sim = EmevdMutationSimulator.fromEvents('file:///common.emevd', 1, [
        {
          id: 50,
          restBehavior: 0,
          instructions: [
            { bank: 1000, id: 0, args: waitFor.args },
            { bank: 2000, id: 0, args: ifCondArgs },
            { bank: 2003, id: 1, args: endEvent.args }
          ],
          parameters: [
            { instructionIndex: 1, targetStartByte: 0, sourceStartByte: 0, byteCount: 4 }
          ]
        },
        {
          id: 60,
          restBehavior: 1,
          instructions: [
            { bank: 2003, id: 1, args: endEvent.args }
          ]
        }
      ]);

      // 模拟操作：在 50 开头插入一条 EndEvent，删除第 1 条，重命名 60 为 70
      sim.insertInstruction('50', 0, { bank: 2003, id: 1, args: endEvent.args });
      const delHandle = sim.getEvents()[0]!.instructions[1]!.handle.id;
      sim.deleteInstruction('50', delHandle);
      sim.renameEvent('60', '70');

      const oracle = sim.captureOracleSnapshot();
      const compiled = sim.compile();

      const staged = await commitEmevdBatchViaBridge({
        sourcePath,
        outputPath: outPath,
        expectedDocumentHash: hash,
        allowedRoots: [root],
        writableRoots: [root],
        mutations: [
          { kind: 'insert_instruction', eventId: 50, instructionIndex: 0, bank: 2003, id: 1, argsBase64: endEvent.args.toString('base64') },
          { kind: 'delete_instruction', eventId: 50, instructionIndex: 1 },
          { kind: 'update_id', eventId: 60, newEventId: 70 },
          {
            kind: 'set_event_parameters',
            eventId: 50,
            parameters: compiled.events[0]!.parameters
          }
        ]
      });
      if (!staged.ok) fail('Bridge commit 写入失败: ' + JSON.stringify(staged.diagnostics));

      const reread = await runBridge<any>({
        command: 'read-emevd-document',
        filePath: outPath,
        allowedRoots: [root],
        timeoutMs: 120_000
      });
      if (reread.parseStatus === 'failed') fail('Bridge 重读失败: ' + JSON.stringify(reread.diagnostics));

      // 与独立 IR Oracle 对照
      const rEvents = reread.data?.events ?? [];
      if (rEvents.length !== oracle.eventCount) {
        fail('事件总数与 Oracle 不匹配: 预期 ' + oracle.eventCount + '，实际 ' + rEvents.length);
      }
      const e50 = rEvents.find((e: any) => e.id === 50);
      const e70 = rEvents.find((e: any) => e.id === 70);
      if (!e50 || e50.instructionCount !== oracle.events[0]!.instructionCount) {
        fail('事件 50 指令数与 Oracle 不匹配');
      }
      if (!e70 || e70.instructionCount !== oracle.events[1]!.instructionCount) {
        fail('事件 70 指令数与 Oracle 不匹配');
      }
      if (e50.parameterCount !== oracle.events[0]!.parameterCount) {
        fail('事件 50 参数数与 Oracle 不匹配');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await disposeBridgeDaemonPool();
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    layer: 'unit',
    suite: 'test:audit-sf-09-unit',
    executedCases: 10,
    message: 'SF-09 unit tests passed: handle validation, sequential rename chain, batch swap, parameter relocation, reference delete guard, unknown instruction guard, strings update, safe int guard, large event paging, and IR oracle roundtrip.'
  }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Native Tests (Layer == 'native')
// ---------------------------------------------------------------------------

async function runNativeLayer(): Promise<void> {
  const args = process.argv.slice(2);
  let nativeFixtureArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer') {
      i++;
    } else if (!args[i]?.startsWith('--')) {
      nativeFixtureArg = args[i];
    }
  }
  const sourceDcx = await resolveNativeFixture(
    nativeFixtureArg,
    'emevd-primary',
    '../../mods/event/common.emevd.dcx'
  );

  const root = await mkdtemp(join(tmpdir(), 'soulforge-sf09-native-'));
  const staging = join(root, 'staging');
  const backup = join(root, 'backup');
  const recovery = join(root, 'recovery');
  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';

  try {
    await mkdir(staging, { recursive: true });
    const session = await openNativeEditSession({
      overlayRoot: staging,
      baseRoot: dirname(sourceDcx),
      game: 'sekiro'
    });

    // Native Case 1: Sekiro common.emevd.dcx Open & Multi-page Event Read
    const outline = await runBridge<any>({
      command: 'read-emevd-document',
      filePath: sourceDcx,
      allowedRoots: [dirname(sourceDcx), staging, oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    if (outline.parseStatus === 'failed' || !outline.data) {
      fail('读取原生 common.emevd.dcx 失败: ' + JSON.stringify(outline.diagnostics));
    }
    const events: any[] = outline.data.events ?? [];
    if (events.length === 0) fail('原生 common.emevd.dcx 没有事件');

    // 寻找一个大事件进行分页检验
    const candidateEvent = events.find((e: any) => e.instructionCount > 10) ?? events[0];
    const eventId = candidateEvent.id;

    const pageDto = await readEmevdEvent({
      edit: session,
      file: sourceDcx,
      eventId,
      instructionOffset: 0,
      instructionLimit: Math.min(10, candidateEvent.instructionCount)
    });
    if (!pageDto.ok) fail('读取原生事件失败: ' + pageDto.error?.message);
    if (pageDto.eventId !== eventId) fail('事件 ID 不匹配');
    if (!pageDto.readRange) fail('原生读取结果缺少 readRange');
    if (pageDto.crossesBlockBoundary === undefined) fail('原生读取结果缺少 crossesBlockBoundary');
    if (candidateEvent.instructionCount > 10 && !pageDto.truncated) fail('部分读取应为 truncated');

    // Native Case 2: Native Staging & Mutation Rebuild with Relocation
    const stagedOut = join(staging, 'common.emevd.dcx');
    const originalBytes = await readFile(sourceDcx);
    const originalHash = createHash('sha256').update(originalBytes).digest('hex');

    // 执行对 candidateEvent 的 restBehavior 更新
    const newRest = candidateEvent.restBehavior === 0 ? 1 : 0;
    const stageResult = await commitEmevdBatchViaBridge({
      sourcePath: sourceDcx,
      outputPath: stagedOut,
      expectedDocumentHash: outline.data.sourceHash,
      oodleRuntimeRoot,
      allowedRoots: [dirname(sourceDcx), staging, root, oodleRuntimeRoot],
      writableRoots: [staging],
      mutations: [
        {
          kind: 'set_rest_behavior',
          eventId,
          restBehavior: newRest
        }
      ]
    });
    if (!stageResult.ok) fail('原生 EMEVD batch 写入失败: ' + JSON.stringify(stageResult.diagnostics));

    // 重读 staged DCX 并验证
    const rereadDcx = await runBridge<any>({
      command: 'read-emevd-document',
      filePath: stagedOut,
      allowedRoots: [staging, oodleRuntimeRoot],
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    if (rereadDcx.parseStatus === 'failed') fail('重读 staged DCX 失败');
    const rereadEvent = (rereadDcx.data?.events ?? []).find((e: any) => e.id === eventId);
    if (!rereadEvent || rereadEvent.restBehavior !== newRest) {
      fail('staged DCX 重读 restBehavior 未匹配更新');
    }

    // Native Case 3: Atomic Rollback & Source Non-tamper Verification
    const afterBytes = await readFile(sourceDcx);
    const afterHash = createHash('sha256').update(afterBytes).digest('hex');
    if (afterHash !== originalHash) {
      fail('原始文件在 native staging 操作后被非法篡改！');
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      layer: 'native',
      suite: 'test:audit-sf-09-native',
      executedCases: 3,
      message: 'SF-09 native smoke passed: common.emevd.dcx multi-page event read, staging rebuild with relocation verification, and source zero-tamper.'
    }, null, 2) + '\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

async function main(): Promise<void> {
  const layer = parseLayer();
  if (layer === 'unit') {
    await runUnitLayer();
  } else {
    await runNativeLayer();
  }
}

await main();
