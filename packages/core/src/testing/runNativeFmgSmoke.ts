/**
 * Native FMG smoke: extract real msgbnd child → lossless read/roundtrip →
 * mutate via write-fmg staging → reread → restore via inverse mutation.
 * Also exercises BND4 child replace of rebuilt FMG bytes through PatchIR.
 */
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  analyzeFmgReferenceIntegrity,
  type FmgReferenceDocument
} from '../param/fmgReferenceIntegrity.js';

interface FmgEnvelope {
  sourceHash: string;
  entryCount: number;
  groupCount: number;
  entries: Array<{ id: number; text: string }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  contentHash: string;
  name: string;
  id: number;
  index: number;
}

const SEKIRO_OFFICIAL_FMG_LANGUAGES = [
  'deude',
  'engus',
  'frafr',
  'itait',
  'jpnjp',
  'korkr',
  'polpl',
  'porbr',
  'rusru',
  'spaar',
  'spaes',
  'thath',
  'zhocn',
  'zhotw'
] as const;

interface OfficialLanguageFmgVerification {
  language: string;
  itemMsgbnd: true;
  menuMsgbndPresent: true;
  itemContainerSha256: string;
  sourceFmgSha256: string;
  childIndex: number;
  childName: string;
  entryCount: number;
  mutatedId: number;
  semanticRoundTripVerified: true;
  stagedRereadVerified: true;
  originalContainerUntouched: true;
}

interface OfficialLanguageFmgMatrix {
  executed: boolean;
  corpusRoot: string | null;
  requiredLanguages: readonly string[];
  availableLanguages: string[];
  ignoredDirectories: string[];
  missingLanguages: string[];
  verified: OfficialLanguageFmgVerification[];
  reason?: string;
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-fmg', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const sourceMsgbnd = await resolveNativeFixture(
    process.argv[2],
    'fmg-primary',
    '../../mods/msg/zhocn/item.msgbnd.dcx'
  );
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'msg', 'zhocn'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const msgbndPath = join(overlay, 'msg', 'zhocn', 'item.msgbnd.dcx');
  await copyFile(sourceMsgbnd, msgbndPath);

  // 1) Snapshot first FMG child from real msgbnd
  const child = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: msgbndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: 1 } // 武器名.fmg — has real Chinese strings
  });
  if (!child.data?.contentBase64) throw new Error(`snapshot failed: ${JSON.stringify(child.diagnostics)}`);
  const fmgPath = join(overlay, 'msg', 'zhocn', 'weapon_names.fmg');
  const originalFmg = Buffer.from(child.data.contentBase64, 'base64');
  await writeFile(fmgPath, originalFmg);

  // 2) Read + semantic roundtrip
  const read = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: fmgPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    throw new Error(`FMG read failed: ${JSON.stringify(read.diagnostics)}`);
  }
  if (!read.data.roundTrip?.semanticIdentical) {
    throw new Error(`FMG semantic roundtrip failed: ${JSON.stringify(read.data.roundTrip)}`);
  }
  const editable = read.data.entries.find((e) => e.text && e.text !== '<?null?>' && e.text.length > 0);
  if (!editable) throw new Error('No editable FMG entry found.');

  // 3) write-fmg staging mutation
  const stagedFmg = join(staging, 'weapon_names.fmg');
  const newText = `${editable.text}·SoulForge`;
  const written = await runBridge<{ outputHash: string; rereadVerified: boolean }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: stagedFmg,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'upsert',
      id: editable.id,
      text: newText
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`FMG write failed: ${JSON.stringify(written.diagnostics)}`);
  }
  const stagedBytes = await readFile(stagedFmg);
  const stagedRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: stagedFmg,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const stagedEntry = stagedRead.data?.entries.find((e) => e.id === editable.id);
  if (stagedEntry?.text !== newText) {
    throw new Error(`Staged FMG text mismatch: ${JSON.stringify(stagedEntry)}`);
  }

  // 3b) add mutation: staged write of a brand-new entry (id 999999999) + independent reread + cleanup
  const ADD_ID = 999999999;
  const ADD_TEXT = 'SoulForge·新增条目验证';
  const stagedAddPath = join(staging, 'weapon_names_add.fmg');
  const added = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: stagedAddPath,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'add',
      id: ADD_ID,
      text: ADD_TEXT
    }
  });
  if (!added.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`FMG add staged write failed: ${JSON.stringify(added.diagnostics)}`);
  }
  const addedRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: stagedAddPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const addedEntry = addedRead.data?.entries.find((e) => e.id === ADD_ID);
  if (addedEntry?.text !== ADD_TEXT) {
    throw new Error(`FMG add staged reread mismatch: ${JSON.stringify(addedEntry)}`);
  }
  // Cleanup: staged write never rewrites the source — reread original to confirm the
  // new entry did not leak, then remove the staging file.
  const originalRecheck = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: fmgPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  if (originalRecheck.data?.entries.some((e) => e.id === ADD_ID)) {
    throw new Error('FMG add mutation leaked into source file.');
  }
  await unlink(stagedAddPath);

  // 3c) add 重复 id：Bridge 结构化拒绝（FMG_STAGING_WRITE_FAILED + 已存在诊断），
  //     且暂存输出文件不产生（writer 在写盘前失败关闭）。
  const dupPath = join(staging, 'weapon_names_dup.fmg');
  const duplicateAdd = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: dupPath,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'add',
      id: editable.id,
      text: 'SoulForge·重复ID拒绝'
    }
  });
  if (duplicateAdd.parseStatus !== 'failed'
    || !duplicateAdd.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_FAILED')
    || !duplicateAdd.diagnostics.some((d) => d.message.includes('已存在'))) {
    throw new Error(`FMG duplicate add must fail closed: ${JSON.stringify(duplicateAdd.diagnostics)}`);
  }
  await expectNoFile(dupPath, 'duplicate add');

  // 3d) add 非法 id（非整数被 JSON 序列化为 null → Bridge RequiredInt 拒绝），
  //     暂存输出文件同样不产生。
  const badIdPath = join(staging, 'weapon_names_badid.fmg');
  const badIdAdd = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: badIdPath,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'add',
      id: Number.NaN,
      text: 'SoulForge·非法ID'
    }
  });
  if (badIdAdd.parseStatus !== 'failed'
    || !badIdAdd.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_FAILED')) {
    throw new Error(`FMG non-integer add must fail closed: ${JSON.stringify(badIdAdd.diagnostics)}`);
  }
  await expectNoFile(badIdPath, 'invalid id add');

  // 3e) add 越界值（2^31 超出 int32 存储上限）：Bridge RequiredInt/GetInt32
  //     拒绝（BRIDGE_REQUEST_FAILED / FMG_STAGING_WRITE_FAILED），
  //     暂存输出文件不产生（fail-closed，不写盘）。
  const overflowPath = join(staging, 'weapon_names_overflow.fmg');
  const overflowAdd = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: overflowPath,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'add',
      id: 2_147_483_648,
      text: 'SoulForge·越界ID'
    }
  });
  if (overflowAdd.parseStatus !== 'failed'
    || overflowAdd.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`FMG out-of-range add must fail closed: ${JSON.stringify(overflowAdd.diagnostics)}`);
  }
  await expectNoFile(overflowPath, 'out-of-range add');

  // 3f) 多语言轴：从 zhocn weapon_names.fmg 派生第二语言（enus）样本。
  //     FMG v2 无语言字段（语言是目录级概念），writer 语言无关；本步用 native
  //     write-fmg 的 mutations 数组把 3 条真实中文条目改写为英文占位串（ASCII
  //     UTF-16，验证非 CJK 写路径），add 一个新 id、delete 一条真实 id —— 得到
  //     与 zhocn 布局结构不同的派生 enus 样本。样本只落 staging，绝不触原版只读目录。
  const ENUS_ADD_ID = 999000000;
  const enusSamplePath = join(staging, 'enus_weapon_names.fmg');
  const nonEmptyEntries = read.data.entries.filter(
    (e) => e.text && e.text !== '<?null?>' && e.text.length > 0
  );
  if (nonEmptyEntries.length < 4) throw new Error('FMG 样本条目不足以派生 enus 变体。');
  const enusUpserts = nonEmptyEntries.slice(0, 3);
  const enusDeleteTarget = nonEmptyEntries[3]!;
  const derived = await runBridge<{ outputHash: string; entryCount: number; groupCount: number }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: enusSamplePath,
      expectedDocumentHash: read.data.sourceHash,
      mutations: [
        ...enusUpserts.map((e) => ({ kind: 'upsert', id: e.id, text: `ENUS:${e.id}` })),
        { kind: 'add', id: ENUS_ADD_ID, text: 'ENUS:NEW_ENTRY' },
        { kind: 'delete', id: enusDeleteTarget.id }
      ]
    }
  });
  if (!derived.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`enus 派生 write-fmg 失败: ${JSON.stringify(derived.diagnostics)}`);
  }
  const enusRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: enusSamplePath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (!enusRead.data) throw new Error(`enus 样本重读失败: ${JSON.stringify(enusRead.diagnostics)}`);
  for (const upsert of enusUpserts) {
    if (enusRead.data.entries.find((e) => e.id === upsert.id)?.text !== `ENUS:${upsert.id}`) {
      throw new Error(`enus upsert 文本不匹配: id=${upsert.id}`);
    }
  }
  if (!enusRead.data.entries.some((e) => e.id === ENUS_ADD_ID && e.text === 'ENUS:NEW_ENTRY')) {
    throw new Error('enus add 条目缺失。');
  }
  if (enusRead.data.entries.some((e) => e.id === enusDeleteTarget.id)) {
    throw new Error('enus delete 目标仍存在。');
  }
  if (!enusRead.data.roundTrip?.semanticIdentical) {
    throw new Error('enus 样本语义往返失败。');
  }

  // 3g) 对派生 enus 样本再执行一次 write-fmg（第二语言布局上的二次写链验证）。
  const ENUS_RW_ID = enusUpserts[0]!.id;
  const enusSecondText = `ENUS:${ENUS_RW_ID}:RW`;
  const enusRwPath = join(staging, 'enus_weapon_names_rw.fmg');
  const enusRewrite = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: enusSamplePath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: enusRwPath,
      expectedDocumentHash: enusRead.data.sourceHash,
      mutation: 'upsert',
      id: ENUS_RW_ID,
      text: enusSecondText
    }
  });
  if (!enusRewrite.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`enus 二次写失败: ${JSON.stringify(enusRewrite.diagnostics)}`);
  }
  const enusRwRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: enusRwPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (enusRwRead.data?.entries.find((e) => e.id === ENUS_RW_ID)?.text !== enusSecondText) {
    throw new Error('enus 二次写重读不匹配。');
  }
  // 隔离：enus 派生与二次写都不得改写 zhocn 源文件。
  const zhocnAfterEnus = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: fmgPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  if (zhocnAfterEnus.data?.sourceHash !== read.data.sourceHash) {
    throw new Error('enus 写链污染了 zhocn 源文件。');
  }

  // 4) Commit rebuilt FMG back into msgbnd via native BND4 replace + resource-entry inverse
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const containerHash = sha256(await readFile(msgbndPath));
  const targetUri = 'file://msg/zhocn/item.msgbnd.dcx';
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: 'FMG 语义修改经 BND4 容器提交',
    author: 'user',
    operations: [{
      id: 'fmg-via-bnd4-replace',
      kind: 'container_child_replace',
      targetUri,
      targetPath: msgbndPath,
      resourceKind: 'msg',
      containerUri: targetUri,
      childPath: child.data.name,
      childContentBase64: stagedBytes.toString('base64'),
      expectedContainerHash: containerHash,
      expectedHash: containerHash,
      expectedChildHash: child.data.contentHash,
      containerFormat: 'BND4_DFLT',
      preconditions: [{
        type: 'content_hash',
        description: 'msgbnd hash',
        expectedHash: containerHash,
        targetUri
      }],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        nativeFormatAuthority: true,
        nativeEntryIndex: child.data.index,
        nativeEntryId: child.data.id,
        requiresConfirmation: true,
        confirmationReceiptId: 'fmg-bnd4-smoke',
        fmgEntryId: editable.id
      }
    }]
  });
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store,
    backupBaseDir: join(root, 'backups')
  });
  if (!committed.operation) {
    throw new Error(`BND4 FMG commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }

  // 5) Reread child FMG from committed msgbnd
  const afterChild = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: msgbndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: child.data.index }
  });
  const afterFmgPath = join(staging, 'after.fmg');
  await writeFile(afterFmgPath, Buffer.from(afterChild.data!.contentBase64, 'base64'));
  const afterRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: afterFmgPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (afterRead.data?.entries.find((e) => e.id === editable.id)?.text !== newText) {
    throw new Error('Committed msgbnd FMG child did not contain mutation.');
  }

  // 6) Operation rollback restores original msgbnd bytes
  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
      riskLevel: 'high',
      note: 'fmg native smoke'
    }),
    // 回滚会建还原点；不指定时落系统临时目录且有意保留，无人清理。
    backupBaseDir: join(root, 'backups')
  });
  if (!rolled.ok || !(await readFile(msgbndPath)).equals(await readFile(sourceMsgbnd))) {
    throw new Error(`FMG container rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  // 7) Corpus: all FMG children in item.msgbnd semantic roundtrip
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: sourceMsgbnd,
    allowedRoots: [dirname(sourceMsgbnd)],
    timeoutMs: 60_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  let fmgVerified = 0;
  const itemFmgDocuments: FmgReferenceDocument[] = [];
  for (let i = 0; i < count; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceMsgbnd,
      allowedRoots: [dirname(sourceMsgbnd)],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: i }
    });
    const bytes = Buffer.from(snap.data!.contentBase64, 'base64');
    // FMG v2 marker
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const tmp = join(staging, `corpus-${i}.fmg`);
    await writeFile(tmp, bytes);
    const doc = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!doc.data?.roundTrip?.semanticIdentical) {
      throw new Error(`Corpus FMG ${i} semantic roundtrip failed: ${JSON.stringify(doc.diagnostics)}`);
    }
    fmgVerified += 1;
    itemFmgDocuments.push({
      index: i,
      name: snap.data!.name,
      entries: (doc.data.entries ?? []).map((e) => ({ id: e.id, text: e.text }))
    });
  }

  // 8) menu.msgbnd (registry bnd4-primary, capabilities inspect/parse/read): FMG read chain
  //    on the second msgbnd — all FMG children semantic roundtrip, read-only.
  const menuMsgbnd = await resolveNativeFixture(
    process.argv[3],
    'bnd4-primary',
    '../../mods/msg/zhocn/menu.msgbnd.dcx'
  );
  const menuContainer = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: menuMsgbnd,
    allowedRoots: [dirname(menuMsgbnd)],
    timeoutMs: 60_000
  });
  const menuCount = menuContainer.data?.nested?.entryCount ?? 0;
  let menuFmgVerified = 0;
  let menuWriteTarget: { path: string; sourceHash: string; editableId: number; newText: string } | undefined;
  const menuFmgDocuments: FmgReferenceDocument[] = [];
  for (let i = 0; i < menuCount; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: menuMsgbnd,
      allowedRoots: [dirname(menuMsgbnd)],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: i }
    });
    const bytes = Buffer.from(snap.data!.contentBase64, 'base64');
    // FMG v2 marker
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const tmp = join(staging, `menu-corpus-${i}.fmg`);
    await writeFile(tmp, bytes);
    const doc = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!doc.data?.roundTrip?.semanticIdentical) {
      throw new Error(`Menu FMG ${i} semantic roundtrip failed: ${JSON.stringify(doc.diagnostics)}`);
    }
    menuFmgVerified += 1;
    menuFmgDocuments.push({
      index: i,
      name: snap.data!.name,
      entries: (doc.data.entries ?? []).map((e) => ({ id: e.id, text: e.text }))
    });
    // 捕获第一个含非空文本的 menu FMG child，供多 msgbnd 写验证（§3h）使用。
    if (!menuWriteTarget) {
      const editableMenuEntry = doc.data.entries.find(
        (e) => e.text && e.text !== '<?null?>' && e.text.length > 0
      );
      if (editableMenuEntry) {
        menuWriteTarget = {
          path: tmp,
          sourceHash: doc.data.sourceHash,
          editableId: editableMenuEntry.id,
          newText: `${editableMenuEntry.text}·SoulForge`
        };
      }
    }
  }

  // 3h) 多 msgbnd 轴：menu.msgbnd（bnd4-primary）补 FMG 写链验证。
  //     之前 menu 只有只读语义往返；本步对选中的 menu FMG child 执行 write-fmg
  //     staging 写 + 独立重读，并确认原 child 未被改写（写只落 staging，不泄漏）。
  if (!menuWriteTarget) throw new Error('menu.msgbnd 无可写 FMG 目标。');
  const menuStaged = join(staging, 'menu_staged.fmg');
  const menuWrite = await runBridge<{ outputHash: string }>({
    command: 'write-fmg',
    filePath: menuWriteTarget.path,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: menuStaged,
      expectedDocumentHash: menuWriteTarget.sourceHash,
      mutation: 'upsert',
      id: menuWriteTarget.editableId,
      text: menuWriteTarget.newText
    }
  });
  if (!menuWrite.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`menu write-fmg 失败: ${JSON.stringify(menuWrite.diagnostics)}`);
  }
  const menuStagedRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: menuStaged,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (menuStagedRead.data?.entries.find((e) => e.id === menuWriteTarget.editableId)?.text !== menuWriteTarget.newText) {
    throw new Error('menu staged 写重读不匹配。');
  }
  const menuOriginalRecheck = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: menuWriteTarget.path,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (menuOriginalRecheck.data?.entries.find((e) => e.id === menuWriteTarget.editableId)?.text === menuWriteTarget.newText) {
    throw new Error('menu 写泄漏进原 FMG child。');
  }

  // 9) 全官方语言矩阵：原版已解包 msg 只读，FMG 仅提取到 smoke staging 后写入。
  //    每种官方语言都执行真实 FMG v2 upsert → 独立重读，并复核原容器哈希不变。
  //    未提供已解包 msg 时保持结构化未执行，不把 zhocn/派生 enus 冒充全语言覆盖。
  const configuredGameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    || '';
  const expandedMsgRoot = configuredGameRoot ? join(configuredGameRoot, 'msg') : '';
  const officialLanguageMatrix = await verifyOfficialLanguageFmgMatrix(
    expandedMsgRoot,
    staging,
    configuredGameRoot
  );

  // 保留 fixture registry 的 mods/msg 可见性，避免把外部已解包 corpus 与登记 fixture 混为一谈。
  const fixtureMsgRoot = join(dirname(dirname(sourceMsgbnd)));
  let languageCorpus: string[] = [];
  try {
    languageCorpus = (await readdir(fixtureMsgRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    languageCorpus = [];
  }
  const itemReference = analyzeFmgReferenceIntegrity({ documents: itemFmgDocuments });
  const menuReference = analyzeFmgReferenceIntegrity({ documents: menuFmgDocuments });
  const sampleOf = (
    diagnostics: Array<{ severity: string; code: string; documentName: string; entryId: number; tag?: string; targetId?: number; message: string }>,
    severity: 'error' | 'warning',
    limit: number
  ): Array<Record<string, unknown>> => diagnostics
    .filter((d) => d.severity === severity)
    .slice(0, limit)
    .map((d) => severity === 'error'
      ? { code: d.code, documentName: d.documentName, entryId: d.entryId, message: d.message }
      : { code: d.code, documentName: d.documentName, entryId: d.entryId, tag: d.tag, targetId: d.targetId });

  console.log(JSON.stringify({
    ok: true,
    message: officialLanguageMatrix.executed
      ? '原生 FMG 全链与全部官方语言真实语料 staged 写入/重读验证通过'
      : '原生 FMG 全链通过；全部官方语言真实语料矩阵未执行',
    entryCount: read.data.entryCount,
    groupCount: read.data.groupCount,
    mutatedId: editable.id,
    byteIdenticalNoop: read.data.roundTrip?.byteIdentical ?? false,
    semanticIdenticalNoop: true,
    corpusFmgVerified: fmgVerified,
    containerEntries: count,
    addCase: {
      id: ADD_ID,
      text: ADD_TEXT,
      stagedRereadVerified: true,
      originalUntouched: true
    },
    addFailureCases: {
      duplicateId: 'FMG_STAGING_WRITE_FAILED + 已存在诊断，输出文件不产生',
      nonIntegerId: 'FMG_STAGING_WRITE_FAILED，输出文件不产生',
      outOfRangeId: 'Bridge 拒绝 2^31 越界 id（BRIDGE_REQUEST_FAILED/FMG_STAGING_WRITE_FAILED），输出文件不产生'
    },
    enusDerivedSample: {
      derivedFrom: 'zhocn item.msgbnd child 1（weapon_names.fmg）',
      mutations: ['upsert ×3', 'add', 'delete'],
      layout: '英文占位串（ASCII UTF-16）＋新增 id 999000000＋删除一条真实 id；结构布局与 zhocn 不同',
      readRoundTripVerified: enusRead.data.roundTrip?.semanticIdentical ?? false,
      entryCount: enusRead.data.entryCount,
      groupCount: enusRead.data.groupCount,
      rewriteVerified: true,
      zhocnSourceUntouched: true
    },
    menuMsgbnd: {
      containerEntries: menuCount,
      fmgVerified: menuFmgVerified,
      writeVerified: true,
      writeCase: {
        editableId: menuWriteTarget.editableId,
        stagedRereadVerified: true,
        originalChildUntouched: true
      }
    },
    referenceIntegrity: {
      itemMsgbnd: {
        fmgCount: itemFmgDocuments.length,
        ...itemReference.summary,
        errorSample: sampleOf(itemReference.diagnostics, 'error', 10),
        warningSample: sampleOf(itemReference.diagnostics, 'warning', 6)
      },
      menuMsgbnd: {
        fmgCount: menuFmgDocuments.length,
        ...menuReference.summary,
        errorSample: sampleOf(menuReference.diagnostics, 'error', 10),
        warningSample: sampleOf(menuReference.diagnostics, 'warning', 6)
      },
      note: '引用完整性为只读诊断；`<?tag@id?>` 目标不在容器条目集合时产 warning（kgiconKc/gdsparam 等 tag 可能引用外部资源，SoulForge 不声明其语义）；不在容器集合的悬空引用不开放任何写路径。'
    },
    languageMatrix: {
      fixtureCorpusRoot: fixtureMsgRoot.replaceAll('\\', '/'),
      fixtureLanguages: languageCorpus,
      official: officialLanguageMatrix,
      verified: {
        zhocn: {
          itemMsgbnd: true,
          menuMsgbnd: true,
          itemFmgVerified: fmgVerified,
          menuFmgVerified,
          itemWriteChainVerified: true,
          menuWriteVerified: true
        },
        enus: {
          derivedFmgSample: 'weapon_names.fmg（派生，非真实官方语料）',
          readRoundTripVerified: true,
          mutationVerified: ['upsert', 'add', 'delete'],
          rewriteVerified: true
        }
      },
      unverifiedLanguages: officialLanguageMatrix.executed
        ? []
        : officialLanguageMatrix.missingLanguages,
      note: officialLanguageMatrix.executed
        ? '14 个官方语言目录均使用真实 item.msgbnd 中的 FMG v2 子项执行 upsert staged 写入与独立重读；item/menu 容器存在性已核对，原版容器哈希逐项不变。zhocn 另保留完整 Patch Engine 容器提交/回滚与 menu 写验证；authority 仍只覆盖本次实际 corpus。'
        : '仅保留 zhocn 真实语料 + 派生 enus 样本的既有验证；全部官方语言矩阵缺少已解包 msg corpus，未执行且不构成完成声明。'
    }
  }, null, 2));
  await disposeBridgeDaemonPool();
}

async function verifyOfficialLanguageFmgMatrix(
  msgRoot: string,
  staging: string,
  gameRoot: string
): Promise<OfficialLanguageFmgMatrix> {
  const requiredLanguages = [...SEKIRO_OFFICIAL_FMG_LANGUAGES];
  if (!msgRoot || !(await pathReadable(msgRoot))) {
    return {
      executed: false,
      corpusRoot: null,
      requiredLanguages,
      availableLanguages: [],
      ignoredDirectories: [],
      missingLanguages: requiredLanguages,
      verified: [],
      reason: '未提供含已解包 msg 的 SOULFORGE_SEKIRO_GAME_ROOT/SOULFORGE_NATIVE_FIXTURE_ROOT。'
    };
  }

  const directories = (await readdir(msgRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.toLowerCase())
    .sort();
  const availableSet = new Set(directories);
  const missingLanguages: string[] = [];
  for (const language of requiredLanguages) {
    const item = join(msgRoot, language, 'item.msgbnd.dcx');
    const menu = join(msgRoot, language, 'menu.msgbnd.dcx');
    if (!availableSet.has(language) || !(await pathReadable(item)) || !(await pathReadable(menu))) {
      missingLanguages.push(language);
    }
  }
  const ignoredDirectories = directories.filter((language) => !requiredLanguages.includes(language as typeof requiredLanguages[number]));
  if (missingLanguages.length > 0) {
    return {
      executed: false,
      corpusRoot: 'configured-game-root/msg',
      requiredLanguages,
      availableLanguages: directories.filter((language) => requiredLanguages.includes(language as typeof requiredLanguages[number])),
      ignoredDirectories,
      missingLanguages,
      verified: [],
      reason: '已解包 msg corpus 未完整覆盖全部官方语言的 item/menu.msgbnd.dcx。'
    };
  }

  const verified: OfficialLanguageFmgVerification[] = [];
  for (const language of requiredLanguages) {
    const itemMsgbnd = join(msgRoot, language, 'item.msgbnd.dcx');
    const originalHash = sha256(await readFile(itemMsgbnd));
    const sample = await snapshotEditableFmg(itemMsgbnd, staging, language, gameRoot);
    const editable = sample.document.entries.find(
      (entry) => entry.text && entry.text !== '<?null?>' && entry.text.length > 0
    );
    if (!editable) throw new Error(`${language}: item.msgbnd 中没有可写 FMG 条目。`);

    const stagedPath = join(staging, `official-${language}-staged.fmg`);
    const newText = `${editable.text}·SoulForge:${language}`;
    const write = await runBridge<{ outputHash: string; rereadVerified: boolean }>({
      command: 'write-fmg',
      filePath: sample.path,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedPath,
        expectedDocumentHash: sample.document.sourceHash,
        mutation: 'upsert',
        id: editable.id,
        text: newText
      }
    });
    if (!write.diagnostics.some((diagnostic) => diagnostic.code === 'FMG_STAGING_WRITE_VERIFIED')) {
      throw new Error(`${language}: write-fmg 失败: ${JSON.stringify(write.diagnostics)}`);
    }
    const reread = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: stagedPath,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (reread.data?.entries.find((entry) => entry.id === editable.id)?.text !== newText
      || !reread.data.roundTrip?.semanticIdentical) {
      throw new Error(`${language}: staged FMG 独立重读不匹配。`);
    }
    if (sha256(await readFile(itemMsgbnd)) !== originalHash) {
      throw new Error(`${language}: 原版 item.msgbnd 哈希发生变化。`);
    }
    verified.push({
      language,
      itemMsgbnd: true,
      menuMsgbndPresent: true,
      itemContainerSha256: originalHash,
      sourceFmgSha256: sample.document.sourceHash,
      childIndex: sample.snapshot.index,
      childName: sample.snapshot.name,
      entryCount: sample.document.entryCount,
      mutatedId: editable.id,
      semanticRoundTripVerified: true,
      stagedRereadVerified: true,
      originalContainerUntouched: true
    });
  }

  return {
    executed: true,
    corpusRoot: 'configured-game-root/msg',
    requiredLanguages,
    availableLanguages: requiredLanguages,
    ignoredDirectories,
    missingLanguages: [],
    verified
  };
}

async function snapshotEditableFmg(
  msgbndPath: string,
  staging: string,
  language: string,
  gameRoot: string
): Promise<{ snapshot: Bnd4ChildSnapshot; path: string; document: FmgEnvelope }> {
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: msgbndPath,
    allowedRoots: [dirname(msgbndPath)],
    oodleRuntimeRoot: gameRoot,
    timeoutMs: 60_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  const preferredIndices = [1, ...Array.from({ length: count }, (_, index) => index).filter((index) => index !== 1)];
  for (const index of preferredIndices) {
    const snapshot = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: msgbndPath,
      allowedRoots: [dirname(msgbndPath)],
      oodleRuntimeRoot: gameRoot,
      timeoutMs: 60_000,
      commandOptions: { entryIndex: index }
    });
    if (!snapshot.data?.contentBase64) continue;
    const bytes = Buffer.from(snapshot.data.contentBase64, 'base64');
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const path = join(staging, `official-${language}-source-${index}.fmg`);
    await writeFile(path, bytes);
    const read = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: path,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (read.data?.roundTrip?.semanticIdentical
      && read.data.entries.some((entry) => entry.text && entry.text !== '<?null?>' && entry.text.length > 0)) {
      return { snapshot: snapshot.data, path, document: read.data };
    }
  }
  throw new Error(`${language}: item.msgbnd 未找到可写且语义往返一致的 FMG v2 子项。`);
}

async function pathReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Asserts a rejected mutation produced no staged output file. */
async function expectNoFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return; // ENOENT is the expected outcome.
  }
  throw new Error(`${label}: staged output must not exist after rejection`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
