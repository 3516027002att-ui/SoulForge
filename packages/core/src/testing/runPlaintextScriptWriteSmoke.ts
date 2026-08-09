/**
 * 明文脚本条目源码级写的**端到端** smoke:
 * 真实容器 → 明文判定 → 源码级编辑 → Patch Engine 提交 → Bridge 重读校验 → 回滚。
 *
 * ── 为什么必须单独有这一层 ──
 *
 * `runPlaintextScriptEditSmoke` 验的是判定与编排:它产出 PatchIR 操作就结束,
 * 自己的 nonClaim 写着「不写入任何真实 Mod 资源」。实测确认过那个文件里
 * `executePatchIrThroughTransaction` / `runBridge` 的出现次数是 **0**。
 *
 * 也就是说「走 Patch Engine、写后 Bridge 重读校验、可回滚」这条要求,此前
 * 每个零件都实现了、也都单独测过,但**没有一次真实写入走完整条链**。
 * `checkPlaintextWriteback` 的三个用例喂的是手工构造的字节,不是从容器里
 * 读回来的 —— 那证明不了「写进去的和读出来的是同一份内容」,而那正是
 * 容器重打包 + DCX 压缩这两层编解码之后最需要证明的事。
 *
 * ── 只读原版游戏目录 ──
 *
 * 真实容器**复制**到临时 overlay 再改,与 runNativeScriptContainerReplaceSmoke
 * 同形。原版游戏目录只被读取一次(复制源),全程不写。
 *
 * ── 无语料时 ──
 *
 * 结构化跳过并说明「未执行不等于通过」。这条 smoke 的价值全在真实语料上,
 * 用 synthetic 容器跑通不能替代它 —— 要证明的恰好是真实 BND4+DCX 的往返。
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { buildPlaintextScriptEdit, checkPlaintextWriteback } from '../script/plaintextScriptEdit.js';
import { classifyPlaintextBytes, type PlaintextEncoding } from '../script/plaintextScriptEntry.js';
import type { ContainerChildOp } from '@soulforge/shared';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';

interface ContainerEnvelope {
  sourceHash: string;
  nested?: {
    entryCount: number;
    entries: Array<{ id: number; name: string; contentHash: string; index: number }>;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 从容器里取一个条目的真实字节。 */
async function snapshotEntry(
  containerPath: string,
  targetUri: string,
  entryIndex: number
): Promise<Uint8Array> {
  const snapshot = await runBridge<{ contentBase64?: string }>({
    command: 'snapshot-bnd4-child',
    filePath: containerPath,
    resourceUri: targetUri,
    timeoutMs: 60_000,
    commandOptions: { entryIndex }
  });
  if (!snapshot.data?.contentBase64) {
    throw new Error(`取条目字节失败(index=${entryIndex}):${JSON.stringify(snapshot.diagnostics)}`);
  }
  return new Uint8Array(Buffer.from(snapshot.data.contentBase64, 'base64'));
}

export interface PlaintextEntryOutcome {
  target: string;
  kind: 'container-entry' | 'bare-file';
  encoding: string;
  beforeBytes: number;
  afterBytes: number;
  writebackCode: string;
  rollbackByteIdentical: boolean;
}

export interface PlaintextWriteSmokeResult {
  ok: boolean;
  message: string;
  skipped?: string;
  /** 每个被验证的明文条目一条。 */
  verified: PlaintextEntryOutcome[];
  /** 有语料但被跳过的条目及原因。 */
  unverified: Array<{ target: string; reason: string }>;
  nonClaims: string[];
}

/**
 * goal 点名的 6 个明文条目。
 *
 * 两类写路径**不同**,必须分别验证:
 *   - container-entry:BND4 容器内层条目,走 container_child_replace;
 *   - bare-file:mods/action 下的裸文件,走 file_replace。
 * 实测确认三个 *nameid.txt 不在任何容器里(mods/action 下只有它们与 script/
 * 子目录),所以「容器内条目验证通过」不能推出「裸文件也通过」。
 */
const PLAINTEXT_TARGETS = Object.freeze([
  { file: 'goal_list.lua', container: 'mods/script/aicommon.luabnd.dcx', kind: 'container-entry' as const },
  { file: '543000_battle.lua', container: 'mods/script/aicommon.luabnd.dcx', kind: 'container-entry' as const },
  { file: '801000_battle.lua', container: 'mods/script/m25_00_00_00.luabnd.dcx', kind: 'container-entry' as const },
  { file: 'eventnameid.txt', bare: 'mods/action/eventnameid.txt', kind: 'bare-file' as const },
  { file: 'statenameid.txt', bare: 'mods/action/statenameid.txt', kind: 'bare-file' as const },
  { file: 'variablenameid.txt', bare: 'mods/action/variablenameid.txt', kind: 'bare-file' as const }
]);

const NON_CLAIMS = [
  '不声明字节码条目可源码级编辑:唯一真阻塞是缺 HKS 重编译器。',
  '原版游戏目录只读:真实语料被复制到临时 overlay 后才改动,游戏目录全程只被读取。',
  'Shift-JIS 条目(三个 *nameid.txt)的写入用由解码器反推出的 CP932 表(见'
    + ' encodeShiftJis),已实测解码→编码往返逐字节一致。CP932 覆盖不到的字符'
    + '会以 PLAINTEXT_SHIFT_JIS_CHAR_UNMAPPABLE 拒绝而不是替换成 ?。'
    + '不声明该表覆盖 CP932 全集 —— 它由解码器枚举得到,与解码器一致,'
    + '但未逐码位与外部权威表对照。',
  '混合编码条目不接受源码级编辑:801000_battle.lua 混了原版日文与后加的 GBK'
    + '中文注释(字节 0xd7 0xf3 0xca 0xd6 在 GBK 里是「左手」),既不能按 UTF-8'
    + '也不能按 Shift-JIS 完整解码,任何单一编码的往返都会丢字节。'
    + '它以 PLAINTEXT_MIXED_ENCODING_UNSUPPORTED 被拒,需要改动时走整文件替换。',
  '每个条目只验证一次往返(一处赋值改动 → 提交 → 重读 → 回滚),不验证连续多次'
    + '编辑的累积效果,也不验证并发写同一容器。',
  '不声明游戏能加载改动后的资源:本 smoke 只证明字节层往返无损与回滚可用,'
    + '游戏内行为需要 me3 运行时验证(section28 那条,且它自身也不含 Mod 加载确认)。'
];

/**
 * 用于定位可改行的锚点:以 `= 数字` 结尾的赋值。
 *
 * 左侧允许标识符、表索引与字段访问 —— 实测两个 battle.lua 的可改赋值几乎
 * 全是 `local0[21] = 1` 这种表索引形态(543000 有 62 处唯一、801000 有 204 处),
 * 而 goal_list.lua 是 `GOAL_COMMON_Attack = 2` 的裸标识符形态。
 * 第一版正则只认后者,导致两个 battle.lua 报「找不到锚点」而被跳过 ——
 * 那是锚点写窄了,不是文件不可写。
 */
const ASSIGNMENT_ANCHOR = /^(\s*[A-Za-z_][\w.]*(?:\[\s*\d+\s*\])*)\s*=\s*(\d+)\s*$/;

/**
 * 在明文内容里找一处可安全改动的赋值,并给出改后的字符串。
 *
 * 必须是**唯一命中**:buildPlaintextScriptEdit 的 replace-once 要求锚点唯一,
 * 而 `Num  = 4381` 这类行在 *nameid.txt 里可能重复出现。找不到唯一锚点时返回
 * null,由调用方记为 unverified 而不是静默通过。
 */
function findUniqueAnchor(text: string): { anchor: string; replacement: string } | null {
  const lines = text.split('\n');
  /**
   * 唯一性必须按**子串**算,与 buildPlaintextScriptEdit 的 replace-once 同口径。
   *
   * 第一版按整行比对,实测 543000_battle.lua 报 ANCHOR_NOT_UNIQUE:
   * `local0[21] = 1` 整行只出现一次,但它是 `local0[21] = 100` 的**前缀**,
   * 作为子串出现多次。两套唯一性判定不一致,就会挑出一个编排层会拒绝的锚点。
   */
  const substringCount = (needle: string): number => {
    let count = 0;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
      if (count > 1) break;
    }
    return count;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const match = ASSIGNMENT_ANCHOR.exec(line);
    if (!match) continue;
    if (substringCount(line) !== 1) continue;
    // 保留原始缩进（match[1] 已含前导空白），只改数值。
    const bumped = `${match[1]} = ${Number(match[2]) + 1}`;
    if (bumped === line) continue;
    // 改后的内容不能与文件里已有的子串重复，否则重读断言
    // 「不含旧值」会因为别处也有同样文本而误判。
    if (text.includes(bumped)) continue;
    return { anchor: line, replacement: bumped };
  }
  return null;
}

/** 验证一个**容器内**明文条目的完整往返。 */
async function verifyContainerEntry(
  root: string,
  sourceContainer: string,
  entryFileName: string,
  relativeContainerPath: string
): Promise<PlaintextEntryOutcome | { unverified: string }> {
  const overlay = join(root, `mod-${entryFileName.replace(/[^\w.-]/g, '_')}`);
  const targetRelative = relativeContainerPath.replace(/^mods\//, '');
  await mkdir(join(overlay, dirname(targetRelative)), { recursive: true });
  const target = join(overlay, targetRelative);
  // 复制而非原地改：原版游戏目录只读。
  await copyFile(sourceContainer, target);
  const originalContainer = await readFile(target);
  const containerHash = sha256(originalContainer);
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const targetUri = `file://${targetRelative.replace(/\\/g, '/')}`;

  const baseline = await runBridge<ContainerEnvelope>({
    command: 'read-dcx-document',
    filePath: target,
    resourceUri: targetUri,
    timeoutMs: 60_000
  });
  const entries = baseline.data?.nested?.entries ?? [];
  if (entries.length === 0) {
    return { unverified: `容器条目枚举失败:${JSON.stringify(baseline.diagnostics)}` };
  }

  // 按 basename 匹配：BND4 内层名是构建机绝对路径
  // （实测形如 N:\NTC\data\Target\...\goal_list.lua）。
  const entry = entries.find((item) => item.name.replace(/\\/g, '/').endsWith(`/${entryFileName}`)
    || item.name === entryFileName);
  if (!entry) {
    return { unverified: `容器里没有条目 ${entryFileName}` };
  }

  const bytes = await snapshotEntry(target, targetUri, entry.index);
  const verdict = classifyPlaintextBytes(bytes);
  if (!verdict.isPlaintext) {
    return { unverified: `${entryFileName} 按真实字节判定不是明文（${verdict.code}）` };
  }

  const text = Buffer.from(bytes).toString('utf8');
  const anchor = findUniqueAnchor(text);
  if (!anchor) {
    return { unverified: `${entryFileName} 里找不到唯一的 NAME = 123 形态锚点` };
  }

  const edit = buildPlaintextScriptEdit({
    containerUri: targetUri,
    childPath: entryFileName,
    entryIndex: entry.index,
    currentBytes: bytes,
    expectedContainerHash: containerHash,
    containerFormat: 'BND4_DFLT',
    actions: [{ kind: 'replace-once', find: anchor.anchor, replace: anchor.replacement }]
  });
  if (!edit.ok) {
    return { unverified: `${entryFileName} 源码级编辑失败：${edit.code}` };
  }

  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: `明文脚本条目源码级编辑（${entryFileName}）`,
    author: 'user',
    operations: [{
      ...edit.operation,
      targetPath: target,
      expectedHash: containerHash,
      expectedChildHash: entry.contentHash,
      metadata: {
        ...edit.operation.metadata,
        nativeFormatAuthority: true,
        nativeEntryIndex: entry.index,
        requiresConfirmation: true,
        confirmationReceiptId: `plaintext-source-edit-${entryFileName}`
      }
    }]
  });

  const committed = await executePatchIrThroughTransaction(patch, {
    session,
    operationLog: store,
    backupBaseDir: join(root, 'backups', entryFileName)
  });
  assert(
    committed.operation !== undefined && committed.changedFiles.length === 1,
    `${entryFileName} 提交失败:${JSON.stringify(committed.diagnostics)}`
  );

  // Bridge 重读：容器写入经 BND4 重打包 + DCX 压缩两层编解码，
  // 「写进去的字节」与「读出来的字节」必须逐位一致。
  const reRead = await snapshotEntry(target, targetUri, entry.index);
  const writeback = checkPlaintextWriteback({
    expectedAfterHash: edit.afterHash,
    reReadBytes: reRead,
    expectedEncoding: edit.encoding
  });
  assert(writeback.ok, `${entryFileName} 写后重读失败(${writeback.code}):${writeback.message}`);
  const reReadText = Buffer.from(reRead).toString('utf8');
  assert(reReadText.includes(anchor.replacement), `${entryFileName} 重读内容里没有新值`);
  assert(!reReadText.includes(anchor.anchor), `${entryFileName} 重读内容里仍有旧值`);

  const rolled = await rollbackOperation({
    opId: committed.operation!.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.operation!.opId}`],
      riskLevel: 'high',
      note: `plaintext source-edit smoke (${entryFileName})`
    }),
    backupBaseDir: join(root, 'backups', entryFileName)
  });
  assert(rolled.ok, `${entryFileName} 回滚失败:${JSON.stringify(rolled.diagnostics)}`);
  const restored = await readFile(target);
  const rollbackByteIdentical = sha256(restored) === containerHash;
  assert(
    rollbackByteIdentical,
    `${entryFileName} 回滚后容器字节与原始不一致 —— 回滚必须逐字节还原。`
  );

  return {
    target: `${relativeContainerPath}#${entryFileName}`,
    kind: 'container-entry',
    encoding: edit.encoding,
    beforeBytes: edit.beforeBytes,
    afterBytes: edit.afterBytes,
    writebackCode: writeback.code,
    rollbackByteIdentical
  };
}

/**
 * 验证一个**裸文件**明文条目的完整往返。
 *
 * 写路径与容器条目不同：走 file_replace 而不是 container_child_replace。
 * 实测三个 *nameid.txt 就在 mods/action 下、不在任何 BND4 里，所以
 * 「容器条目验证通过」推不出「裸文件也通过」——两条路径各自要验。
 */
async function verifyBareFile(
  root: string,
  sourceFile: string,
  relativePath: string
): Promise<PlaintextEntryOutcome | { unverified: string }> {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const overlay = join(root, `mod-${fileName.replace(/[^\w.-]/g, '_')}`);
  const targetRelative = relativePath.replace(/^mods\//, '');
  await mkdir(join(overlay, dirname(targetRelative)), { recursive: true });
  const target = join(overlay, targetRelative);
  await copyFile(sourceFile, target);
  const originalBytes = new Uint8Array(await readFile(target));
  const originalHash = sha256(originalBytes);
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const targetUri = `file://${targetRelative.replace(/\\/g, '/')}`;

  const verdict = classifyPlaintextBytes(originalBytes);
  if (!verdict.isPlaintext) {
    return { unverified: `${fileName} 按真实字节判定不是明文（${verdict.code}）` };
  }

  // 复用同一编排层：明文判定、编码保持、尾部填充保留、写后哈希都由
  // buildPlaintextScriptEdit 负责；裸文件只是换了写 operation 的类型。
  const contentBytes = verdict.trailingPaddingBytes > 0
    ? originalBytes.subarray(0, originalBytes.length - verdict.trailingPaddingBytes)
    : originalBytes;
  const text = decodePlaintextForAnchor(contentBytes, verdict.detectedEncoding);
  const anchor = findUniqueAnchor(text);
  if (!anchor) {
    return { unverified: `${fileName} 里找不到唯一的 NAME = 123 形态锚点` };
  }

  const edit = buildPlaintextScriptEdit({
    containerUri: targetUri,
    childPath: fileName,
    entryIndex: 0,
    currentBytes: originalBytes,
    expectedContainerHash: originalHash,
    actions: [{ kind: 'replace-once', find: anchor.anchor, replace: anchor.replacement }]
  });
  if (!edit.ok) {
    return { unverified: `${fileName} 源码级编辑失败：${edit.code}` };
  }
  const newBytes = Buffer.from(edit.operation.childContentBase64 ?? '', 'base64');

  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: `明文裸文件源码级编辑（${fileName}）`,
    author: 'user',
    operations: [{
      id: `plaintext-bare-${fileName}`,
      kind: 'file_replace',
      targetUri,
      targetPath: target,
      resourceKind: 'other',
      newContentBase64: newBytes.toString('base64'),
      expectedHash: originalHash,
      preconditions: [{
        type: 'content_hash',
        description: '目标文件在写入前必须与计划时一致',
        expectedHash: originalHash,
        targetUri
      }],
      validatorRequirements: [
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        sourceKind: 'plaintext-script-source-edit',
        encoding: edit.encoding,
        requiresConfirmation: true,
        confirmationReceiptId: `plaintext-bare-${fileName}`
      }
    }]
  });

  const committed = await executePatchIrThroughTransaction(patch, {
    session,
    operationLog: store,
    backupBaseDir: join(root, 'backups', fileName)
  });
  assert(
    committed.operation !== undefined && committed.changedFiles.length === 1,
    `${fileName} 提交失败:${JSON.stringify(committed.diagnostics)}`
  );

  // 裸文件的「重读」是直接读回磁盘：没有容器重打包，但仍要证明写进去的与
  // 读出来的一致，且编码与尾部对齐填充都保住了。
  const reRead = new Uint8Array(await readFile(target));
  const writeback = checkPlaintextWriteback({
    expectedAfterHash: edit.afterHash,
    reReadBytes: reRead,
    expectedEncoding: edit.encoding
  });
  assert(writeback.ok, `${fileName} 写后重读失败(${writeback.code}):${writeback.message}`);
  const reReadVerdict = classifyPlaintextBytes(reRead);
  assert(
    reReadVerdict.trailingPaddingBytes === verdict.trailingPaddingBytes,
    `${fileName} 尾部对齐填充变了:原 ${verdict.trailingPaddingBytes} 字节,`
      + `现 ${reReadVerdict.trailingPaddingBytes} 字节`
  );

  const rolled = await rollbackOperation({
    opId: committed.operation!.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.operation!.opId}`],
      riskLevel: 'high',
      note: `plaintext bare-file smoke (${fileName})`
    }),
    backupBaseDir: join(root, 'backups', fileName)
  });
  assert(rolled.ok, `${fileName} 回滚失败:${JSON.stringify(rolled.diagnostics)}`);
  const restored = new Uint8Array(await readFile(target));
  const rollbackByteIdentical = sha256(restored) === originalHash;
  assert(rollbackByteIdentical, `${fileName} 回滚后字节与原始不一致 —— 必须逐字节还原。`);

  return {
    target: relativePath,
    kind: 'bare-file',
    encoding: edit.encoding,
    beforeBytes: edit.beforeBytes,
    afterBytes: edit.afterBytes,
    writebackCode: writeback.code,
    rollbackByteIdentical
  };
}

/** 解码用于找锚点；与 plaintextScriptEntry 的 decodePlaintext 同语义。 */
function decodePlaintextForAnchor(bytes: Uint8Array, encoding: string): string {
  if (encoding === 'shift_jis') return new TextDecoder('shift_jis').decode(bytes);
  if (encoding === 'utf8-bom') return new TextDecoder('utf-8').decode(bytes.subarray(3));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 验证 **AI 工具侧** 的同一条链:
 * 工具产出 PatchIR → Patch Engine 提交 → Bridge 重读 → 回滚。
 *
 * 为什么单独验一遍:上面两个函数直接调 buildPlaintextScriptEdit,证明的是
 * 编排层可用。而 goal 要求「文件和工具都要」—— 一个工具存在、schema 正确、
 * 甚至返回 ok:true,都不等于它产出的 operation 真能落盘。工具层多包了一层
 * 参数解析与 base64 解码,那一层出错的表现是「工具说成功了但提交失败」。
 */
async function verifyViaAiTool(
  root: string,
  sourceContainer: string,
  entryFileName: string,
  relativeContainerPath: string
): Promise<PlaintextEntryOutcome | { unverified: string }> {
  const overlay = join(root, 'mod-via-tool');
  const targetRelative = relativeContainerPath.replace(/^mods\//, '');
  await mkdir(join(overlay, dirname(targetRelative)), { recursive: true });
  const target = join(overlay, targetRelative);
  await copyFile(sourceContainer, target);
  const originalContainer = await readFile(target);
  const containerHash = sha256(originalContainer);
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const targetUri = `file://${targetRelative.replace(/\\/g, '/')}`;

  const baseline = await runBridge<ContainerEnvelope>({
    command: 'read-dcx-document',
    filePath: target,
    resourceUri: targetUri,
    timeoutMs: 60_000
  });
  const entry = (baseline.data?.nested?.entries ?? []).find((item) => item.name
    .replace(/\\/g, '/').endsWith(`/${entryFileName}`) || item.name === entryFileName);
  if (!entry) return { unverified: `容器里没有条目 ${entryFileName}` };

  const bytes = await snapshotEntry(target, targetUri, entry.index);
  const anchor = findUniqueAnchor(Buffer.from(bytes).toString('utf8'));
  if (!anchor) return { unverified: `${entryFileName} 找不到唯一锚点` };

  // 经生产 AI 工具注册表产出 operation。
  const registry = createDefaultToolRegistry();
  const toolResult = await registry.run('propose_plaintext_script_edit', {
    containerUri: targetUri,
    childPath: entryFileName,
    entryIndex: entry.index,
    currentBytesBase64: Buffer.from(bytes).toString('base64'),
    expectedContainerHash: containerHash,
    find: anchor.anchor,
    replace: anchor.replacement,
    containerFormat: 'BND4_DFLT'
  }, {
    workspaceIndex: { workspaceId: session.meta.workspaceId } as never,
    mode: 'fullPermission'
  });
  if (!toolResult.ok) {
    return { unverified: `AI 工具调用失败:${toolResult.error?.code} ${toolResult.error?.message}` };
  }
  // 用 ContainerChildOp 真实类型而不是 Record<string, unknown> 或 never:
  // 后两者会让字段名写错也编译通过（本仓库已记录的 as 断言掩盖字段漂移形态）。
  const data = toolResult.data as {
    operation: ContainerChildOp;
    encoding: PlaintextEncoding;
    beforeBytes: number;
    afterBytes: number;
    afterHash: string;
  };

  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: `AI 工具产出的明文脚本源码级编辑（${entryFileName}）`,
    author: 'ai',
    operations: [{
      ...data.operation,
      targetPath: target,
      expectedHash: containerHash,
      expectedChildHash: entry.contentHash,
      metadata: {
        ...(data.operation.metadata ?? {}),
        nativeFormatAuthority: true,
        nativeEntryIndex: entry.index,
        requiresConfirmation: true,
        confirmationReceiptId: `plaintext-via-tool-${entryFileName}`
      }
    }]
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    session,
    operationLog: store,
    backupBaseDir: join(root, 'backups', 'via-tool')
  });
  assert(
    committed.operation !== undefined && committed.changedFiles.length === 1,
    `AI 工具产出的 operation 提交失败:${JSON.stringify(committed.diagnostics)}`
  );

  const reRead = await snapshotEntry(target, targetUri, entry.index);
  const writeback = checkPlaintextWriteback({
    expectedAfterHash: data.afterHash,
    reReadBytes: reRead,
    expectedEncoding: data.encoding
  });
  assert(writeback.ok, `AI 工具路径写后重读失败(${writeback.code}):${writeback.message}`);
  assert(
    Buffer.from(reRead).toString('utf8').includes(anchor.replacement),
    'AI 工具路径重读内容里没有新值'
  );

  const rolled = await rollbackOperation({
    opId: committed.operation!.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.operation!.opId}`],
      riskLevel: 'high',
      note: 'plaintext source-edit via AI tool'
    }),
    backupBaseDir: join(root, 'backups', 'via-tool')
  });
  assert(rolled.ok, `AI 工具路径回滚失败:${JSON.stringify(rolled.diagnostics)}`);
  const rollbackByteIdentical = sha256(new Uint8Array(await readFile(target))) === containerHash;
  assert(rollbackByteIdentical, 'AI 工具路径回滚未逐字节还原');

  return {
    target: `${relativeContainerPath}#${entryFileName}（经 AI 工具）`,
    kind: 'container-entry',
    encoding: data.encoding,
    beforeBytes: data.beforeBytes,
    afterBytes: data.afterBytes,
    writebackCode: writeback.code,
    rollbackByteIdentical
  };
}

async function runInWorkspace(root: string): Promise<PlaintextWriteSmokeResult> {
  const corpusRoot = process.argv[2]?.trim()
    ?? process.env.SOULFORGE_SEKIRO_ROOT?.trim()
    ?? 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';

  try {
    await stat(corpusRoot);
  } catch {
    return {
      ok: true,
      message: '本机无 Sekiro Mod 语料,端到端写入验证已结构化跳过。',
      skipped: `未找到语料根:${corpusRoot}。未执行不等于通过 —— 这条 smoke 的价值`
        + '全在真实 BND4+DCX 与真实 Shift-JIS 文件的往返上,synthetic 替代不了。'
        + ' 传入语料根作为第一个参数,或设 SOULFORGE_SEKIRO_ROOT。',
      verified: [],
      unverified: PLAINTEXT_TARGETS.map((entry) => ({
        target: entry.container ? `${entry.container}#${entry.file}` : entry.bare ?? entry.file,
        reason: '无语料'
      })),
      nonClaims: NON_CLAIMS
    };
  }

  const verified: PlaintextEntryOutcome[] = [];
  const unverified: Array<{ target: string; reason: string }> = [];

  for (const item of PLAINTEXT_TARGETS) {
    const label = item.container ? `${item.container}#${item.file}` : item.bare ?? item.file;
    const sourcePath = join(corpusRoot, item.container ?? item.bare ?? '');
    try {
      await stat(sourcePath);
    } catch {
      unverified.push({ target: label, reason: `语料缺失:${sourcePath}` });
      continue;
    }
    const outcome = item.kind === 'container-entry'
      ? await verifyContainerEntry(root, sourcePath, item.file, item.container!)
      : await verifyBareFile(root, sourcePath, item.bare!);
    if ('unverified' in outcome) {
      unverified.push({ target: label, reason: outcome.unverified });
      continue;
    }
    verified.push(outcome);
  }

  // 工具侧同一条链:goal 要求「文件和工具都要」。
  const toolContainer = join(corpusRoot, 'mods/script/aicommon.luabnd.dcx');
  let toolPathAvailable = true;
  try {
    await stat(toolContainer);
  } catch {
    toolPathAvailable = false;
  }
  if (toolPathAvailable) {
    const viaTool = await verifyViaAiTool(
      root,
      toolContainer,
      'goal_list.lua',
      'mods/script/aicommon.luabnd.dcx'
    );
    if ('unverified' in viaTool) {
      unverified.push({ target: 'AI 工具路径（propose_plaintext_script_edit）', reason: viaTool.unverified });
    } else {
      verified.push(viaTool);
    }
  } else {
    unverified.push({
      target: 'AI 工具路径（propose_plaintext_script_edit）',
      reason: '语料缺失'
    });
  }

  // 前提断言:有语料却一个都没验成,说明判定或写路径坏了,不能报绿。
  assert(
    verified.length > 0,
    `有语料但零个条目验证成功。未验证原因:${JSON.stringify(unverified, null, 2)}`
  );
  // 工具侧必须真的验过:文件侧全绿而工具侧静默缺席,正是 goal 点名的
  // 「文件和工具都要」里最容易漏的一半。
  assert(
    !toolPathAvailable || verified.some((entry) => entry.target.includes('经 AI 工具')),
    `工具侧链路未验证成功:${JSON.stringify(unverified.filter((e) => e.target.includes('AI 工具')))}`
  );

  return {
    ok: true,
    message: `明文条目源码级写端到端验证 ${verified.length}/${PLAINTEXT_TARGETS.length} 通过:`
      + '真实语料 → 明文判定 → 源码级编辑 → Patch Engine 提交 → 重读一致 → 回滚逐字节还原。'
      + (unverified.length > 0 ? ` 另有 ${unverified.length} 条未验证(见 unverified)。` : ''),
    verified,
    unverified,
    nonClaims: NON_CLAIMS
  };
}
export async function runPlaintextScriptWriteSmoke(): Promise<PlaintextWriteSmokeResult> {
  try {
    return await withSmokeWorkspace(
      'plaintext-script-write',
      (workspace) => runInWorkspace(workspace.root)
    );
  } finally {
    await disposeBridgeDaemonPool();
  }
}

if (process.argv[1] && process.argv[1].endsWith('runPlaintextScriptWriteSmoke.js')) {
  runPlaintextScriptWriteSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        ok: false,
        code: 'PLAINTEXT_SCRIPT_WRITE_SMOKE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }, null, 2));
      process.exit(1);
    });
}
