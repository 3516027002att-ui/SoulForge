/**
 * PARAM/MSB 实现级契约：Bridge 命令名 + portable 打包门禁脚本自洽。
 *
 * channel 注册与 preload 接线（含 applyParamFieldMutation）已迁到真实执行
 * 观测门禁 `npm run test:desktop-ipc-contract`，理由与实测证据见
 * runFmgMsbIpcContractSmoke.ts 顶部注释。
 *
 * 保留项都是运行时表面上观测不到的：Bridge command 字符串只在真机调用时才
 * 执行到；portable 门禁脚本的内容不属于桌面 IPC 表面。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const param = readFileSync(resolve(root, 'packages/core/src/editing/paramBridgeCommit.ts'), 'utf8');
  const msb = readFileSync(resolve(root, 'packages/core/src/editing/msbBridgeCommit.ts'), 'utf8');
  const portable = readFileSync(resolve(root, 'scripts/verify-portable-packaging-gate.mjs'), 'utf8');

  if (!param.includes('write-param') || !param.includes('read-param-document')) {
    throw new Error('paramBridgeCommit 必须使用 Bridge 命令 write-param / read-param-document。');
  }
  if (!msb.includes('write-msb')) {
    throw new Error('msbBridgeCommit 必须使用 Bridge 命令 write-msb。');
  }
  if (!portable.includes('electron-builder.json') || !portable.includes('test:release-content')) {
    throw new Error('portable 打包门禁必须校验 electron-builder.json 并串联 test:release-content。');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM/MSB 实现级契约验证通过（Bridge 命令名 + portable 门禁自洽）',
    bridgeCommands: ['write-param', 'read-param-document', 'write-msb'],
    portableGate: 'scripts/verify-portable-packaging-gate.mjs',
    delegatedTo: 'npm run test:desktop-ipc-contract（channel 注册 / preload 接线 / 双向对账，真实执行观测）'
  }, null, 2));
}

main();
