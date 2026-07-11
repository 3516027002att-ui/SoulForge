/**
 * Structural contract: live editor write paths for MSB/PARAM UI are wired
 * through apply*Mutation IPC (not local-only demo commits).
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
  if (!app.includes('writeEnabled={msbLive')) {
    throw new Error('MSB write must only enable in live mode');
  }
  if (!paramPanel.includes('sourceId') || !app.includes('mutation.sourceId')) {
    throw new Error('PARAM duplicate must carry sourceId for full payload upsert');
  }
  if (!preload.includes('applyMsbMutation') || !preload.includes('applyParamMutation')) {
    throw new Error('preload missing write APIs');
  }
  if (!ipc.includes("game: 'sekiro'")
    || !ipc.includes('rejectNonSekiroNativeWrite(sourceUri, file)')) {
    throw new Error('native semantic writes must fail closed outside the Sekiro adaptation');
  }
  if (!ipc.includes('stageBridgeOutput')
    || !ipc.includes('writableRoots: [input.storage.stagingRoot]')
    || !ipc.includes('rm(stagingDirectory, { recursive: true, force: true })')
    || ipc.includes('mkdtemp(join(tmpdir()')) {
    throw new Error('desktop native writers must reuse stable app-data staging roots and clean request directories');
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
    message: '桌面实时编辑写回路径契约验证通过（MSB part/region 位置 + PARAM 复制 sourceId）',
    paths: [
      'MsbScenePanel.onPartPositionCommit → applyMsbMutation(set_part_position)',
      'MsbScenePanel.onRegionPositionCommit → applyMsbMutation(set_region_position)',
      'ParamTablePanel.duplicate sourceId → applyParamMutation upsert',
      'Sekiro-only native write gate',
      'stable LOCALAPPDATA staging root with cleanup'
    ]
  }, null, 2));
}

main();
