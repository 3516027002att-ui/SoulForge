/**
 * CAT-05 smoke：EditorCatalog builder 与 Sekiro 固定规则（§4.3/§4.4/§4.5）。
 *
 * 覆盖：
 *   - primary gameparam.parambnd.dcx（Bridge-confirmed bnd4/gameparam-binder）
 *     → PARAM 1 个 Game Parameters library；
 *   - 每个实测 GParam（fixture 动态构造，§4.5 的「34 个」快照按实测样本替换）
 *     → 一个 bank；
 *   - gameparam.parambnd.dcx.bak → History 1，且经 recoveryOfResourceId 关联
 *     primary（绝不得到 PARAM 36）；
 *   - TPF → Texture（不进 Text）；
 *   - 未知格式 → Files（不成为文档）；
 *   - cache/audit/temporary → hidden（不进任何普通列表）；
 *   - sidecar projection：provenance 一致才关联，绝不形成第二个普通文档；
 *   - overlay/base 同一逻辑资源 → 一个文档，effective 为 overlay，
 *     alternateVariantIds 保留 base；
 *   - 同层同 precedence 不同 hash → conflict，禁止按扫描顺序取最后一个。
 *
 * 本 smoke 不加载 native 资产：confirmedStacks / projectionManifests /
 * capabilitySnapshot 全部是确定性 fixture，不构成 native authority 声明。
 */
import type {
  ConfirmedFormatStack,
  EditorCatalogSnapshot,
  IndexedFile,
  OperationCapability,
  ResourceKind
} from '@soulforge/shared';
import {
  buildEditorCatalog,
  buildEditorCatalogSummary,
  type ProjectionManifest
} from '../workspace/editorCatalog.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail: string): void {
  checks += 1;
  if (!condition) failures.push(`${name}: ${detail}`);
}

let fileCounter = 0;
function buildFile(
  relativePath: string,
  sha256: string,
  options: { resourceKind?: ResourceKind; sourceLayer?: 'overlay' | 'base'; artifactRole?: IndexedFile['artifactMarkers'] } = {}
): IndexedFile {
  fileCounter += 1;
  const pathValue = relativePath.replaceAll('\\', '/');
  return {
    id: `file-${fileCounter}`,
    workspaceId: 'ws:smoke',
    sourceUri: `file:///${pathValue}`,
    sourcePath: `/synthetic/${pathValue}`,
    absolutePath: `/synthetic/${pathValue}`,
    relativePath,
    game: 'sekiro',
    resourceKind: options.resourceKind ?? 'unknown',
    extension: pathValue.split('.').pop() ?? '',
    compoundExtension: pathValue.includes('.dcx') ? '.dcx' : `.${pathValue.split('.').pop() ?? ''}`,
    formatKind: 'unknown',
    formatLabel: 'unknown',
    size: 1024,
    mtimeMs: 1_700_000_000_000,
    parseStatus: 'unparsed',
    diagnostics: [],
    sha256,
    ...(options.artifactRole
      ? { artifactMarkers: { sourceLayer: options.sourceLayer ?? 'overlay', ...options.artifactRole } }
      : options.sourceLayer === 'base'
        ? { artifactMarkers: { artifactRole: 'base', sourceLayer: 'base' } }
        : {})
  };
}

function confirmedStack(leafFormatId: ConfirmedFormatStack['leafFormatId'], containerRole: ConfirmedFormatStack['containerRole'], childCount = 0): ConfirmedFormatStack {
  const layers: ConfirmedFormatStack['layers'] = [
    { layerIndex: 0, formatId: 'dcx-dflt', confirmedBy: 'bridge', childStableId: null },
    { layerIndex: 1, formatId: leafFormatId, confirmedBy: 'bridge', childStableId: null }
  ];
  return { stackId: `stack:${leafFormatId}:${containerRole}`, layers, leafFormatId, containerRole };
}

const readyCapability: OperationCapability = {
  read: { kind: 'ready', operationIds: ['page-tables'], verifiedStages: ['D3', 'D4', 'D5', 'D6'], resolverSnapshotId: 'smoke' },
  write: { kind: 'ready', operationIds: ['param-field-set'], verifiedStages: ['D7', 'D8', 'D9', 'D10'], resolverSnapshotId: 'smoke' }
};

function findDocument(snapshot: EditorCatalogSnapshot, domain: string, label: string) {
  return snapshot.documents.find((document) => document.ref.domain === domain && document.label === label);
}

function main(): void {
  const confirmedStacks = new Map<string, ConfirmedFormatStack>();
  const capabilities = new Map<string, OperationCapability>();

  // ── §4.5 样本：primary + N 个 GParam + backup（N 用 fixture 构造，验收时按实测替换）──
  const primary = buildFile('gameparam/GameParam.parambnd.dcx', 'aa'.repeat(32), { resourceKind: 'param' });
  confirmedStacks.set(primary.sourceUri, confirmedStack('bnd4', 'gameparam-binder'));
  capabilities.set(primary.sourceUri, readyCapability);

  const gparamCount = 3;
  const gparamFiles: IndexedFile[] = [];
  for (let i = 0; i < gparamCount; i += 1) {
    const gparam = buildFile(`param/drawparam/m${String(i).padStart(2, '0')}_00.gparam.dcx`, `g${String(i).padStart(2, '0')}`.repeat(32), { resourceKind: 'param' });
    confirmedStacks.set(gparam.sourceUri, confirmedStack('gparam', 'none'));
    capabilities.set(gparam.sourceUri, readyCapability);
    gparamFiles.push(gparam);
  }

  const backup = buildFile('gameparam/GameParam.parambnd.dcx.bak', 'bb'.repeat(32), {
    resourceKind: 'param',
    artifactRole: { artifactRole: 'backup' }
  });

  // ── TPF → Texture（不进 Text）──
  const tpf = buildFile('menu/hi/1000.tpf.dcx', 'cc'.repeat(32), { resourceKind: 'menu' });
  confirmedStacks.set(tpf.sourceUri, confirmedStack('tpf', 'none'));

  // ── 未知 → Files ──
  const unknown = buildFile('misc/unknown.bin', 'dd'.repeat(32), { resourceKind: 'other' });

  // ── hidden：cache/audit/temporary 不进普通列表 ──
  const cacheFile = buildFile('cache/tmp.bin', 'ee'.repeat(32), { artifactRole: { artifactRole: 'cache' } });
  const auditFile = buildFile('audit/log.json', 'ff'.repeat(32), { artifactRole: { artifactRole: 'audit' } });

  // ── projection：manifest 一致 → 关联；不一致 → 不成为文档 ──
  const matchedSidecar = buildFile('event/m10.emevd.dcx.js', '11'.repeat(32), {
    resourceKind: 'other',
    artifactRole: { artifactRole: 'projection', projectionProvenanceDigest: 'digest-a' }
  });
  const unmatchedSidecar = buildFile('event/m11.emevd.dcx.js', '22'.repeat(32), {
    resourceKind: 'other',
    artifactRole: { artifactRole: 'projection', projectionProvenanceDigest: 'digest-b' }
  });
  const manifests = new Map<string, ProjectionManifest>();
  manifests.set(matchedSidecar.sourceUri, {
    nativeResourceId: 'event/m10.emevd.dcx',
    nativeSourceRevision: 'rev-1',
    nativeSourceHash: 'aa'.repeat(32),
    provenanceDigest: 'digest-a'
  });
  manifests.set(unmatchedSidecar.sourceUri, {
    nativeResourceId: 'event/m11.emevd.dcx',
    nativeSourceRevision: 'rev-1',
    nativeSourceHash: 'aa'.repeat(32),
    provenanceDigest: 'OTHER-DIGEST' // 与 scanner 标记不一致 → 拒绝关联
  });

  // ── overlay/base 同一逻辑资源（仅相对路径不同，逻辑键相同）──
  const baseVariant = buildFile('gameparam/GameParam.parambnd.dcx', '99'.repeat(32), {
    resourceKind: 'param',
    sourceLayer: 'base'
  });
  confirmedStacks.set(baseVariant.sourceUri, confirmedStack('bnd4', 'gameparam-binder'));

  // ── conflict：同层同 precedence 不同 hash（相对路径不同但逻辑键相同）──
  const conflictA = buildFile('GameParam.parambnd.dcx', '77'.repeat(32), { resourceKind: 'param' });
  const conflictB = buildFile('gameparam.parambnd.dcx', '88'.repeat(32), { resourceKind: 'param' });
  confirmedStacks.set(conflictA.sourceUri, confirmedStack('bnd4', 'gameparam-binder'));
  confirmedStacks.set(conflictB.sourceUri, confirmedStack('bnd4', 'gameparam-binder'));

  const snapshot = buildEditorCatalog({
    files: [
      primary, ...gparamFiles, backup, tpf, unknown, cacheFile, auditFile,
      matchedSidecar, unmatchedSidecar, baseVariant, conflictA, conflictB
    ],
    confirmedStacks,
    projectionManifests: manifests,
    capabilitySnapshot: capabilities,
    catalogRevision: 'catalog:smoke'
  });

  // ── PARAM：1 个 Game Parameters library ──
  const paramLibrary = snapshot.libraries.find((library) => library.libraryId === 'param:game-parameters');
  check('param/library', paramLibrary !== undefined, '必须存在 param:game-parameters library');
  check('param/library-label', paramLibrary?.label === 'Game Parameters', `label 应为 Game Parameters，实际 ${paramLibrary?.label}`);
  // primary 组 1 个 + conflict 测试组 1 个 = 2；backup 只进 history，绝不计数。
  const paramDocs = snapshot.documents.filter((document) => document.ref.domain === 'param');
  check('param/not-36', paramDocs.length === 2, `绝不得得到 PARAM 36；primary+conflict 组应为 2，实际 ${paramDocs.length} 个 param 文档`);

  // ── GPARAM：每个实测 GParam 一个 bank ──
  const gparamBanks = snapshot.banks.filter((bank) => bank.libraryId === 'gparam:draw-graphics-parameters');
  check('gparam/banks', gparamBanks.length === gparamCount, `每个 GParam 一个 bank；期望 ${gparamCount}，实际 ${gparamBanks.length}`);
  const gparamDocs = snapshot.documents.filter((document) => document.ref.domain === 'gparam');
  check('gparam/docs', gparamDocs.length === gparamCount, `gparam 文档数应为 ${gparamCount}，实际 ${gparamDocs.length}`);

  // ── History：1 个 GameParam backup，且关联 primary ──
  check('history/count', snapshot.history.length === 1, `History 应为 1，实际 ${snapshot.history.length}`);
  const backupVariant = snapshot.history[0];
  check('history/role', backupVariant?.role === 'backup', `role 应为 backup，实际 ${backupVariant?.role}`);
  check('history/source-layer', backupVariant?.sourceLayer === 'history', 'history variant sourceLayer 必须是 history');
  check('history/recovery-of', backupVariant?.recoveryOfResourceId === 'gameparam/gameparam.parambnd.dcx',
    `recoveryOfResourceId 应关联 primary（逻辑键小写规范化），实际 ${backupVariant?.recoveryOfResourceId}`);

  // ── TPF → Texture ──
  const tpfDoc = findDocument(snapshot, 'texture', '1000.tpf.dcx');
  check('tpf/texture', tpfDoc !== undefined, 'TPF 必须进 texture 域');
  const tpfTextDoc = findDocument(snapshot, 'text', '1000.tpf.dcx');
  check('tpf/not-text', tpfTextDoc === undefined, 'TPF 不得进 Text');

  // ── 未知 → Files（不成为文档）──
  check('files/unknown', findDocument(snapshot, 'files', 'unknown.bin') === undefined
    && findDocument(snapshot, 'files', 'misc/unknown.bin') === undefined, '未知格式不得成为文档');

  // ── hidden 不进任何普通列表 ──
  check('hidden/cache', findDocument(snapshot, 'files', 'tmp.bin') === undefined, 'cache 文件不得成为文档');
  check('hidden/audit', findDocument(snapshot, 'files', 'log.json') === undefined, 'audit 文件不得成为文档');
  check('hidden/no-history', snapshot.history.some((item) => item.variantId.includes('tmp.bin')) === false, 'hidden 不得进入 history');

  // ── projection ──
  check('projection/matched', snapshot.projections.length === 1, `只有 provenance 一致的 sidecar 才关联；期望 1，实际 ${snapshot.projections.length}`);
  check('projection/no-document', findDocument(snapshot, 'files', 'm10.emevd.dcx.js') === undefined
    && findDocument(snapshot, 'event', 'm10.emevd.dcx.js') === undefined, 'projection 绝不能形成第二个普通文档');

  // ── overlay/base effective variant ──
  const effectiveDoc = findDocument(snapshot, 'param', 'GameParam.parambnd.dcx');
  check('variant/effective-overlay', effectiveDoc?.effectiveVariant.sourceLayer === 'overlay',
    `effective 应为 overlay，实际 ${effectiveDoc?.effectiveVariant.sourceLayer}`);
  check('variant/alternate-base', effectiveDoc?.alternateVariantIds.length === 1,
    `base 应保留为 alternate variant，实际 ${JSON.stringify(effectiveDoc?.alternateVariantIds)}`);

  // ── conflict：同层同 precedence 不同 hash ──
  const conflictDoc = findDocument(snapshot, 'param', 'gameparam.parambnd.dcx')
    ?? findDocument(snapshot, 'param', 'GameParam.parambnd.dcx');
  check('conflict/recognition', conflictDoc?.recognition.kind === 'conflict'
    || snapshot.documents.some((document) => document.recognition.kind === 'conflict'),
    `同层同 precedence 不同 hash 必须 conflict，实际 ${JSON.stringify(snapshot.documents.map((d) => ({ label: d.label, recognition: d.recognition })))}`);

  // ── summary ──
  const summary = buildEditorCatalogSummary(snapshot);
  check('summary/history-count', summary.historyCount === 1, `summary.historyCount 应为 1，实际 ${summary.historyCount}`);
  check('summary/domains', ['param', 'gparam', 'texture'].every((domain) => summary.domains.some((d) => d.domain === domain)),
    `summary 必须含 param/gparam/texture 域，实际 ${summary.domains.map((d) => d.domain)}`);

  if (failures.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      message: `editor catalog smoke 失败 ${failures.length} 项`,
      checks,
      failures,
      gparamFixtureCount: gparamCount
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    message: `EditorCatalog smoke 通过（${checks} 项断言；fixture GParam 样本 ${gparamCount} 个，验收时按当时挂载 workspace 实测数替换）`,
    checks,
    fixtureGParamCount: gparamCount,
    lockedBehaviours: [
      'primary gameparam.parambnd.dcx → PARAM 1 library（绝不得到 PARAM 36）',
      '每个实测 GParam → 一个 bank',
      'backup → History 1 且 recoveryOfResourceId 关联 primary',
      'TPF → Texture，不进 Text',
      '未知格式 → Files，不成为文档',
      'cache/audit → hidden，不进普通列表',
      'sidecar projection：provenance 一致才关联，绝不形成第二个普通文档',
      'overlay/base 同一逻辑资源 → effective overlay + alternate base',
      '同层同 precedence 不同 hash → conflict'
    ],
    authority: 'fixture-confirmed（确定性 fixture，不加载 native 资产，不构成 native authority 声明）'
  }, null, 2));
}

main();
