/**
 * FMG reference-integrity smoke.
 *
 * Part 1 (unconditional, synthetic): deterministically verifies the read-only
 * diagnostic pass `analyzeFmgReferenceIntegrity` on constructed FMG documents:
 *   - duplicate entry id inside one document        -> error
 *   - reference target beyond signed 32-bit range   -> error
 *   - negative reference target                     -> warning
 *   - target missing from container id set          -> warning
 *   - target present in container id set            -> info (resolved)
 *   - marker reference without id (`<?bmsg?>`)      -> info
 *
 * Part 2 (native, honest-skip when env missing): runs the same pass over every
 * FMG v2 child of the real item.msgbnd and menu.msgbnd (zhocn corpus) and
 * reports container-wide resolution statistics and the language coverage
 * matrix. This is read-only: it never opens a write path.
 */
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  analyzeFmgReferenceIntegrity,
  extractFmgReferences,
  type FmgReferenceDocument,
  type FmgReferenceIntegrityResult
} from '../param/fmgReferenceIntegrity.js';

// ---------------------------------------------------------------------------
// Part 1: deterministic synthetic validation
// ---------------------------------------------------------------------------

function runSyntheticCases(): FmgReferenceIntegrityResult {
  // 1. Resolved + dangling + marker + invalid target + negative target in one pass.
  const docs: FmgReferenceDocument[] = [
    {
      index: 0,
      name: 'A.fmg',
      entries: [
        { id: 1000, text: '这里是<?placeName@1000?>的引用' },
        { id: 1001, text: '普通文本' }
      ]
    },
    {
      index: 1,
      name: 'B.fmg',
      entries: [
        { id: 2000, text: '悬空<?placeName@9999?>引用' },
        { id: 2001, text: '负目标<?icon@-7?>引用' },
        { id: 2002, text: '越界<?icon@9999999999?>引用' }
      ]
    },
    {
      index: 2,
      name: 'C.fmg',
      entries: [
        { id: 3000, text: '<?bmsg?>标记引用' },
        { id: 3000, text: '重复 id 条目' }
      ]
    }
  ];
  const result = analyzeFmgReferenceIntegrity({ documents: docs });

  const byCode = new Map<string, number>();
  for (const d of result.diagnostics) {
    byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  }
  const expect = (code: string, count: number, label: string): void => {
    const actual = byCode.get(code) ?? 0;
    if (actual !== count) {
      throw new Error(`synthetic ${label}: expected ${code} x${count}, got x${actual}`);
    }
  };
  expect('FMG_REF_RESOLVED', 1, 'resolved');
  expect('FMG_REF_DANGLING_TARGET', 1, 'dangling');
  expect('FMG_REF_NEGATIVE_TARGET', 1, 'negative');
  expect('FMG_REF_INVALID_TARGET', 1, 'invalid');
  expect('FMG_REF_MARKER', 1, 'marker');
  expect('FMG_REF_DUPLICATE_ENTRY_ID', 1, 'duplicate id');

  // ok must be false when hard errors are present.
  if (result.ok) throw new Error('synthetic: result.ok must be false with duplicate/invalid diagnostics');
  if (result.summary.referenceCount !== 5) {
    throw new Error(`synthetic: expected 5 references, got ${result.summary.referenceCount}`);
  }
  if (result.summary.resolvedCount !== 1 || result.summary.danglingCount !== 1
    || result.summary.negativeCount !== 1 || result.summary.invalidCount !== 1
    || result.summary.markerReferenceCount !== 1 || result.summary.duplicateIdCount !== 1) {
    throw new Error(`synthetic: summary mismatch ${JSON.stringify(result.summary)}`);
  }

  // 2. A clean container has ok=true and no error/warning diagnostics
  //    (resolved references legitimately produce info diagnostics).
  const clean = analyzeFmgReferenceIntegrity({
    documents: [{
      index: 0,
      name: 'clean.fmg',
      entries: [
        { id: 1, text: '甲<?tag@2?>乙' },
        { id: 2, text: '丙' }
      ]
    }]
  });
  if (!clean.ok || clean.diagnostics.some((d) => d.severity !== 'info')) {
    throw new Error(`synthetic: clean container must be ok with only info diagnostics, got ${JSON.stringify(clean)}`);
  }
  if (clean.summary.resolvedCount !== 1 || clean.summary.danglingCount !== 0) {
    throw new Error(`synthetic: clean container summary mismatch ${JSON.stringify(clean.summary)}`);
  }

  // 3. extractFmgReferences positions are deterministic and text is untouched.
  const text = '前<?kgiconKc@18?>后<?bmsg?>尾';
  const refs = extractFmgReferences(text);
  if (refs.length !== 2 || refs[0]?.targetId !== 18 || refs[0]?.textIndex !== 1
    || refs[1]?.targetId !== undefined || refs[1]?.tag !== 'bmsg') {
    throw new Error(`synthetic: extractFmgReferences mismatch ${JSON.stringify(refs)}`);
  }
  if (text !== '前<?kgiconKc@18?>后<?bmsg?>尾') {
    throw new Error('synthetic: extractFmgReferences mutated its input text');
  }

  return result;
}
// ---------------------------------------------------------------------------
// Part 2: native corpus (honest-skip when the local corpus is unavailable)
// ---------------------------------------------------------------------------

interface FmgEnvelope {
  entries: Array<{ id: number; text: string }>;
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  name: string;
}

async function fmgDocumentsFromMsgbnd(
  msgbndPath: string,
  staging: string,
  label: string
): Promise<{ documents: FmgReferenceDocument[]; containerEntries: number }> {
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: msgbndPath,
    allowedRoots: [dirname(msgbndPath)],
    timeoutMs: 120_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  const documents: FmgReferenceDocument[] = [];
  for (let i = 0; i < count; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: msgbndPath,
      allowedRoots: [dirname(msgbndPath)],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: i }
    });
    const bytes = Buffer.from(snap.data?.contentBase64 ?? '', 'base64');
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const tmp = join(staging, `${label}-${i}.fmg`);
    await writeFile(tmp, bytes);
    const doc = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 120_000
    });
    if (doc.parseStatus === 'failed' || !doc.data) {
      throw new Error(`${label} FMG child ${i} read failed: ${JSON.stringify(doc.diagnostics)}`);
    }
    documents.push({
      index: i,
      name: snap.data?.name ?? `${label}-${i}.fmg`,
      entries: (doc.data.entries ?? []).map((e) => ({ id: e.id, text: e.text }))
    });
  }
  return { documents, containerEntries: count };
}

async function nativeCorpusExists(itemPath: string, menuPath: string): Promise<boolean> {
  try {
    await access(itemPath);
    await access(menuPath);
    return true;
  } catch {
    return false;
  }
}

async function runRealCorpus(): Promise<void> {
  const itemMsgbnd = await resolveNativeFixture(
    process.argv[2],
    'fmg-primary',
    '../../mods/msg/zhocn/item.msgbnd.dcx'
  );
  const menuMsgbnd = await resolveNativeFixture(
    process.argv[3],
    'bnd4-primary',
    '../../mods/msg/zhocn/menu.msgbnd.dcx'
  );
  if (!(await nativeCorpusExists(itemMsgbnd, menuMsgbnd))) {
    console.log(JSON.stringify({
      ok: true,
      testId: 'W-EMEVD-FMG-PARAM-03-FMG-REF',
      status: 'skipped',
      authority: 'unverified',
      nativeFormatAuthority: false,
      syntheticVerified: true,
      reason: '本机 zhocn 语料不可用，真实 FMG 引用完整性扫描结构化跳过。',
      diagnostics: [{
        severity: 'info',
        code: 'FMG_REF_CORPUS_UNAVAILABLE',
        message: 'item.msgbnd / menu.msgbnd 未解析；引用完整性诊断未在真实 corpus 上运行。'
      }]
    }, null, 2));
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-fmg-ref-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    const item = await fmgDocumentsFromMsgbnd(itemMsgbnd, staging, 'item');
    const menu = await fmgDocumentsFromMsgbnd(menuMsgbnd, staging, 'menu');
    const itemResult = analyzeFmgReferenceIntegrity({ documents: item.documents });
    const menuResult = analyzeFmgReferenceIntegrity({ documents: menu.documents });

    const errorSample = [...itemResult.diagnostics, ...menuResult.diagnostics]
      .filter((d) => d.severity === 'error')
      .slice(0, 10)
      .map((d) => ({ code: d.code, documentName: d.documentName, entryId: d.entryId, message: d.message }));
    const warningSample = [...itemResult.diagnostics, ...menuResult.diagnostics]
      .filter((d) => d.severity === 'warning')
      .slice(0, 8)
      .map((d) => ({ code: d.code, documentName: d.documentName, entryId: d.entryId, tag: d.tag, targetId: d.targetId, message: d.message }));

    const languageMatrix = {
      corpusRoot: 'mods/msg',
      availableLanguages: ['zhocn'],
      verified: {
        zhocn: {
          itemMsgbnd: true,
          menuMsgbnd: true,
          itemFmgCount: item.documents.length,
          menuFmgCount: menu.documents.length
        }
      },
      unverified: ['全部其他语言（本机 corpus 仅 zhocn，未覆盖）'],
      note: '引用完整性为只读检查；未开放任何写路径。'
    };

    console.log(JSON.stringify({
      ok: true,
      testId: 'W-EMEVD-FMG-PARAM-03-FMG-REF',
      status: 'partial',
      authority: 'partial',
      nativeFormatAuthority: false,
      syntheticVerified: true,
      containers: {
        itemMsgbnd: { containerEntries: item.containerEntries, fmgCount: item.documents.length, ...itemResult.summary },
        menuMsgbnd: { containerEntries: menu.containerEntries, fmgCount: menu.documents.length, ...menuResult.summary }
      },
      diagnostics: {
        total: itemResult.diagnostics.length + menuResult.diagnostics.length,
        errorSample,
        warningSample
      },
      languageMatrix,
      nonClaims: [
        'SoulForge 不声明 `<?tag?>` 引用语法的外部语义（kgiconKc/gdsparam 等可能引用非 FMG 资源）；仅报告容器级解析状态。',
        '悬空引用为 warning 而非 error：真实 corpus 中 placeName/kgiconKc 等 tag 可指向容器外资源。',
        '未覆盖其他语言 msgbnd；多语言 mutation 未声明。'
      ]
    }, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  runSyntheticCases();
  await runRealCorpus();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
