/**
 * FMG/MSB 实现级契约：Bridge 命令名与 shared mutation union。
 *
 * channel 注册与 preload 接线已迁到真实执行观测门禁
 * `scripts/contract/verify-desktop-ipc-contract.mjs`（npm run test:desktop-ipc-contract）。
 * 迁移原因有实测证据：把 main 里的 `resource.applyFmgMutation` 改名为
 * `...V2`（preload 仍 invoke 老名字，运行时必然失败），本文件旧版仍退出 0 并
 * 打印「契约验证通过」，因为 `includes('applyFmgMutation')` 在 `applyFmgMutationV2`
 * 里同样成立。子串匹配无法表达「恰好是这个 channel」。
 *
 * 这里保留的是无法用运行时观测替代的部分：Bridge 命令名字符串与 TS 类型联合。
 * 前者只在真机 Bridge 调用时才会执行到，后者在编译期被擦除，两者都不出现在
 * 可观测的运行时表面上。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const fmg = readFileSync(resolve(root, 'packages/core/src/editing/fmgBridgeCommit.ts'), 'utf8');
  const msb = readFileSync(resolve(root, 'packages/core/src/editing/msbBridgeRead.ts'), 'utf8');
  const protocol = readFileSync(resolve(root, 'packages/shared/src/editor-protocol.ts'), 'utf8');

  // Bridge 命令名：C# Bridge 的 command 分派键，拼错只在真机调用时才失败。
  if (!fmg.includes('write-fmg') || !fmg.includes('read-fmg-document')) {
    throw new Error('fmgBridgeCommit 必须使用 Bridge FMG 命令 write-fmg / read-fmg-document。');
  }
  if (!msb.includes('read-msb-document')) {
    throw new Error('msbBridgeRead 必须使用 Bridge 命令 read-msb-document。');
  }

  // shared mutation union：编译期类型，运行时不可观测。
  if (!protocol.includes("'fmg_entry_add'")) {
    throw new Error('editor-protocol 的 EditorMutationKind 必须包含 fmg_entry_add。');
  }
  if (!fmg.includes("kind: 'add'")) {
    throw new Error('fmgBridgeCommit 必须接受 add mutation。');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'FMG/MSB 实现级契约验证通过（Bridge 命令名 + shared mutation union）',
    bridgeCommands: ['write-fmg', 'read-fmg-document', 'read-msb-document'],
    mutationKinds: ['fmg_entry_add'],
    delegatedTo: 'npm run test:desktop-ipc-contract（channel 注册 / preload 接线 / 双向对账，真实执行观测）'
  }, null, 2));
}

main();
