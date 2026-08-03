/**
 * 桌面编辑后端契约：IPC 通道、preload 桥接与 staging 写链。
 *
 * renderer UI 已从仓库移除，因此这里不再断言任何 React 组件接线；保留的
 * 全部断言针对仍存在的后端契约（ipc.ts / preload / bridgeStaging），它们
 * 是任何未来 renderer 都必须遵守的安全与分页边界。
 *
 * 分页 channel 是否注册、preload 是否暴露分页方法这两组断言已迁到真实执行
 * 观测门禁 `npm run test:desktop-ipc-contract`。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const bridgeStaging = readFileSync(
    resolve(root, 'packages/core/src/editing/bridgeStaging.ts'),
    'utf8'
  );

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

  console.log(JSON.stringify({
    ok: true,
    message: '桌面编辑后端契约验证通过（renderer UI 已移除，保留 IPC/preload/staging 边界）',
    paths: [
      'Sekiro-only native write gate',
      'stable LOCALAPPDATA staging root with cleanup',
      'shared normalizePageWindow windowing authority (no private copy)',
      'readParamPage: explicit empty commandOptions + payload-null-safe rows',
      'listContainerChildrenPage: native BND4 full enumeration fallback for real containers'
    ],
    rendererUi: 'removed',
    delegatedTo: 'npm run test:desktop-ipc-contract（分页 channel 注册 / preload 分页方法接线 / 双向对账，真实执行观测）'
  }, null, 2));
}

main();
