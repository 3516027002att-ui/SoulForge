/**
 * safeStorage vault 实现级契约：加解密落点、明文不落盘、损坏失败关闭、原子发布。
 *
 * 「resolveApiKey 不得成为 IPC channel」已迁到真实执行观测门禁
 * `npm run test:desktop-ipc-contract`（观测 main 实际注册的 channel 集合，
 * 而不是源码里是否出现 `handle('modelService.resolveApiKey'` 这一种写法——
 * 换个引号或跨行就绕过了）。
 *
 * 真机 DPAPI 往返需 Electron app ready；本文件只锁 shipped 代码路径，不声称
 * 验证真实加解密。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const vault = readFileSync(
    resolve('../../apps/desktop/src/main/modelServiceCredentials.ts'),
    'utf8'
  );
  const ipc = readFileSync(resolve('../../apps/desktop/src/main/ipc.ts'), 'utf8');

  // 加密/解密/可用性探测三个落点必须都在。原先这段写成
  //   if (!vault.includes(token) && !vault.includes(<某个 base64 变体>)) { ... }
  // 外层条件里带一个与 token 无关的短路项，而内层又混用 && 与 || 且无括号，
  // 结果是 `vault.includes('toString("base64")')` 为真时整条 if 直接 continue，
  // 五个 token 一个都没真正检查过。这里改成逐项直查。
  for (const token of [
    'safeStorage.encryptString',
    'safeStorage.decryptString',
    'isEncryptionAvailable',
    'resolveApiKey'
  ]) {
    if (!vault.includes(token)) throw new Error(`vault 缺少 ${token}`);
  }
  // 密文必须以 base64 落盘（引号风格不限）。
  if (!vault.includes("toString('base64')") && !vault.includes('toString("base64")')) {
    throw new Error('vault 必须把密文编码为 base64 后落盘');
  }

  if (vault.includes('apiKey:') && /interface StoredModelServiceConfig[\s\S]*apiKey\s*:/.test(vault)) {
    throw new Error('持久化 DTO 不得存储 apiKey');
  }
  if (!ipc.includes('modelServiceVault.upsertConfig')) {
    throw new Error('main 必须经 vault upsertConfig 写入，不得旁路');
  }

  // Prove encrypt path writes ciphertext map, not raw key material field names into configs array.
  if (!vault.includes('vault.secrets[id]')) {
    throw new Error('secrets map missing');
  }
  if (!vault.includes("error.code === 'ENOENT'") || vault.includes('} catch {\n      const empty: VaultFile')) {
    throw new Error('vault must only initialize an empty store for ENOENT');
  }
  if (!vault.includes('MODEL_SERVICE_VAULT_CORRUPT')
    || !vault.includes('MODEL_SERVICE_VAULT_LOAD_FAILED')) {
    throw new Error('vault corruption and read failures must fail closed');
  }
  if (!vault.includes('await rename(temporaryPath, this.vaultPath)')) {
    throw new Error('vault writes must publish atomically');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'safeStorage 加密 vault 实现级契约验证通过',
    encrypt: true,
    decrypt: true,
    corruptVaultFailsClosed: true,
    atomicPublish: true,
    delegatedTo: 'npm run test:desktop-ipc-contract（resolveApiKey 不得成为 channel、不得暴露给渲染进程，真实执行观测）',
    note: '真机 DPAPI 往返需 Electron app ready；本测试锁定 shipped 代码路径'
  }, null, 2));
}

main();
