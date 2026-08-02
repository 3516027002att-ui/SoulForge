/**
 * Renderer 侧实时编辑接线契约：UI 组件与 App.tsx 的写回路径。
 *
 * 分页 channel 是否注册、preload 是否暴露分页方法这两组断言已迁到真实执行
 * 观测门禁 `npm run test:desktop-ipc-contract`（理由与实测证据见
 * runFmgMsbIpcContractSmoke.ts 顶部注释）。
 *
 * 这里保留的都是 renderer 侧断言：React 组件的 props 接线与 UI 文案在
 * 主进程运行时表面上不可观测，真实验证需要挂载渲染进程（Electron 内 e2e）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const app = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8');
  const msbPanel = readFileSync(
    resolve(root, 'apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx'),
    'utf8'
  );
  const paramPanel = readFileSync(
    resolve(root, 'apps/desktop/src/renderer/src/editors/ParamTablePanel.tsx'),
    'utf8'
  );
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const bridgeStaging = readFileSync(
    resolve(root, 'packages/core/src/editing/bridgeStaging.ts'),
    'utf8'
  );

  if (!msbPanel.includes('onPartPositionCommit') || !msbPanel.includes('提交 part 位置')) {
    throw new Error('MsbScenePanel missing part position commit UI');
  }
  if (!msbPanel.includes('onRegionPositionCommit') || !msbPanel.includes('提交 region 位置')) {
    throw new Error('MsbScenePanel missing region position commit UI');
  }
  if (!app.includes('onPartPositionCommit') || !app.includes('applyMsbMutation')) {
    throw new Error('App must wire MSB position commit to applyMsbMutation');
  }
  if (!app.includes('onRegionPositionCommit') || !app.includes('set_region_position')) {
    throw new Error('App must wire region position commit to set_region_position');
  }
  // writeEnabled 必须同时受"live 模式"和"非 V0.6 延期预览"两个条件约束。
  // 这里断言语义而非某一种换行格式：只要 writeEnabled 表达式里同时出现
  // msbLive 与延期判定，重排格式不会误报，去掉任一条件则立即失败关闭。
  const writeEnabledExpression = /writeEnabled=\{([\s\S]*?)\}\s*\n/.exec(app)?.[1] ?? '';
  if (!writeEnabledExpression.includes('msbLive')) {
    throw new Error('MSB write must only enable in live mode');
  }
  if (!writeEnabledExpression.includes("isDeferredPreviewEditorKind('msb')")) {
    throw new Error('MSB write must fail closed while msb is a V0.6 deferred read-only preview');
  }
  if (!paramPanel.includes('sourceId') || !app.includes('mutation.sourceId')) {
    throw new Error('PARAM duplicate must carry sourceId for full payload upsert');
  }
  // 分页 channel 注册与 preload 分页方法接线：见 test:desktop-ipc-contract
  // （真实观测 main 注册表与 preload invoke 目标，含双向对账）。
  // Bounded access must be one shared windowing authority (hard constraint 17):
  // ipc must consume the shared normalizePageWindow from core and not keep a
  // private copy that could drift from the acceptance smoke.
  if (!ipc.includes('normalizePageWindow')) throw new Error('ipc missing shared normalizePageWindow');
  if (ipc.includes('function normalizePageWindow')) {
    throw new Error('ipc must not define a private normalizePageWindow');
  }
  // Real-corpus PARAM reads must pass an explicit empty commandOptions (the C#
  // read-param-document handler throws InvalidOperationException on a missing
  // options element) and must not throw on payload-less rows.
  if (!ipc.includes('commandOptions: {}') || !ipc.includes('typeof row.dataBase64 === \'string\'')) {
    throw new Error('readParamPage must send empty commandOptions and stay payload-null-safe');
  }
  // Real (non-SFBN) BND4 containers must fall back to native full entry-table
  // enumeration so the bnd4 editor gets complete bounded access on real corpus.
  for (const token of ['isRealNativeBndContainer', 'enumerateNativeContainerEntries', 'BND_NATIVE_ENUMERATION_COMPLETE']) {
    if (!ipc.includes(token)) throw new Error(`ipc missing bnd4 native enumeration ${token}`);
  }
  if (!ipc.includes("game: 'sekiro'")
    || !ipc.includes('rejectNonSekiroNativeWrite(sourceUri, file)')) {
    throw new Error('native semantic writes must fail closed outside the Sekiro adaptation');
  }
  if (!ipc.includes('stageBridgeOutput')
    || !ipc.includes('stagingRoot: storage.stagingRoot')
    || !bridgeStaging.includes('writableRoots: [input.stagingRoot]')
    || !bridgeStaging.includes('rm(stagingDirectory, { recursive: true, force: true })')
    || ipc.includes('mkdtemp(join(tmpdir()')
    || bridgeStaging.includes('mkdtemp(join(tmpdir()')) {
    throw new Error('desktop native writers must reuse core staging with stable app-data roots and cleanup');
  }
  if (!ipc.includes("join(dirname(app.getPath('appData')), 'Local', 'SoulForge')")) {
    throw new Error('workspace databases and recovery data must use LOCALAPPDATA on Windows');
  }
  // Ensure demo mode does not claim silent success
  if (!app.includes('仅在演示模式') && !app.includes('演示模式')) {
    throw new Error('demo mode messaging missing');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'Renderer 实时编辑接线契约验证通过（MSB part/region 位置 + PARAM 复制 sourceId）',
    paths: [
      'MsbScenePanel.onPartPositionCommit → applyMsbMutation(set_part_position)',
      'MsbScenePanel.onRegionPositionCommit → applyMsbMutation(set_region_position)',
      'ParamTablePanel.duplicate sourceId → applyParamMutation upsert',
      'Sekiro-only native write gate',
      'stable LOCALAPPDATA staging root with cleanup',
      'shared normalizePageWindow windowing authority (no private copy)',
      'readParamPage: explicit empty commandOptions + payload-null-safe rows',
      'listContainerChildrenPage: native BND4 full enumeration fallback for real containers'
    ],
    delegatedTo: 'npm run test:desktop-ipc-contract（分页 channel 注册 / preload 分页方法接线 / 双向对账，真实执行观测）'
  }, null, 2));
}

main();
