/**
 * 模型服务 vault 实现级契约：DTO 脱敏字段 + 加密落点。
 *
 * 「四个 modelService channel 已注册」「preload 暴露四个管理方法」「渲染进程
 * 拿不到 resolveApiKey」这三组断言已迁到真实执行观测门禁
 * `npm run test:desktop-ipc-contract`：那里断言的是 preload 实际暴露的方法
 * 集合与它们真实 invoke 的 channel，而不是源码里是否出现某个子串。
 *
 * 保留项：rendererDto 的脱敏键清单与 vault 的 safeStorage 落点。真机 DPAPI
 * 往返需要 Electron app ready，仍由 Electron 内 e2e 覆盖，本文件不声称验证它。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const dto = readFileSync(resolve(root, 'apps/desktop/src/main/rendererDto.ts'), 'utf8');
  const vault = readFileSync(resolve(root, 'apps/desktop/src/main/modelServiceCredentials.ts'), 'utf8');
  // IPC 物理拆分后，modelService 域 handler 位于 ipc/modelServices.ts（upsert
  // 经注入的 vault 依赖写凭据），不再在组合根 ipc.ts 内。
  const modelServiceIpc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc/modelServices.ts'), 'utf8');

  if (!dto.includes("'apiKey'") || !dto.includes("'secret'")) {
    throw new Error('rendererDto 必须从发往渲染进程的载荷中剥离 apiKey/secret 键。');
  }
  if (!vault.includes('safeStorage.encryptString')) {
    throw new Error('vault 必须使用 safeStorage 加密凭据。');
  }
  if (!modelServiceIpc.includes('vault.upsertConfig')) {
    throw new Error('main 必须经 vault upsertConfig 写入凭据，不得旁路。');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '模型服务 vault 实现级契约验证通过（DTO 脱敏 + safeStorage 落点）',
    strippedKeys: ['apiKey', 'secret'],
    encryption: 'safeStorage.encryptString',
    delegatedTo: 'npm run test:desktop-ipc-contract（4 个 modelService channel / preload 接线 / resolveApiKey 不可达，真实执行观测）',
    note: '真机 DPAPI 往返需 Electron app ready，本文件不声称验证该项'
  }, null, 2));
}

main();
