/**
 * 模型服务凭据 vault 的**源码文本级**契约。
 *
 * ⚠️ 本文件的断言是源码文本级，不构成运行期证据。凭据安全的真实边界由
 * `npm run test:desktop-security-runtime`（scripts/verify-desktop-security-runtime.mjs）
 * 在运行期观测：它断言 preload 真实暴露的方法集不含 resolveApiKey 及其等价别名
 * （decryptApiKey / getApiKey / readCredential，:71）、main 未注册
 * modelService.resolveApiKey channel（:86），并用真实敏感载荷验证 apiKey 不跨进程
 * 泄漏（:189/:200）。别名列表是 grep 做不到的关键差异——把同一能力改个名字重新
 * 暴露，grep 式 `!includes(旧名)` 恒真报绿。
 *
 * 这里保留的是 must-exist 部分：vault 模块必须导出这批 safeStorage 相关符号。
 * must-exist 的失效方式是「改名即红」，属安全方向，故保留 grep 有意义。
 *
 * 本轮删掉两条判据（2026-08-08 实测）：
 *   - 原 :22 `if (source.includes('apps/desktop/src/renderer'))` 想断言「vault 不在
 *     renderer 下」，但它读的是 main 下那个文件的**内容**，而位置由**路径**决定。
 *     内容里本来就不会出现这个路径字面量，实测求值恒为 false——数学上不可能红。
 *     真搬走时 readFileSync 会 ENOENT 抛错（那是路径的功劳，不是该判据的）；
 *     被复制到 renderer 下而 main 下仍在时，它完全看不见。
 *   - 原 :26 `/interface StoredModelServiceConfig[\s\S]*apiKey\s*:/` 用 [\s\S]* 跨整个
 *     文件贪婪匹配，无法限定在同一个接口体内。实测构造样本（StoredModelServiceConfig
 *     无 apiKey、另一个写入输入接口有 apiKey）被误判命中——而那恰恰是原注释描述的
 *     合法形态。改为只截取该接口体到第一个 `}` 再判，误报面消除。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const vaultPath = resolve('../../apps/desktop/src/main/modelServiceCredentials.ts');
  const source = readFileSync(vaultPath, 'utf8');
  const required = [
    'safeStorage',
    'encryptString',
    'decryptString',
    'hasCredential',
    'resolveApiKey',
    'MODEL_SERVICE_SAFE_STORAGE_UNAVAILABLE'
  ];
  for (const token of required) {
    if (!source.includes(token)) throw new Error(`vault source missing ${token}`);
  }

  // apiKey 只允许作为写入输入，不得成为存储态 DTO 的字段。判据限定在
  // StoredModelServiceConfig 的接口体内（截到第一个 `}`），不跨接口贪婪匹配。
  // 提取失败必须失败关闭：接口改名或写法变化会让判据静默消失，而它守的是
  // 「明文 key 不落盘」这条实质约束。
  const declMatch = /(?:export\s+)?interface\s+StoredModelServiceConfig\s*\{/.exec(source);
  if (declMatch === null) {
    throw new Error(
      'STORED_CONFIG_INTERFACE_UNEXTRACTABLE: 未能在 vault 源码里定位 '
      + 'interface StoredModelServiceConfig。提取失败必须失败关闭——否则「存储态 DTO '
      + '不得含 apiKey」这条判据会静默消失。若该接口已改名或改写法，请同步本判据。'
    );
  }
  const bodyStart = declMatch.index + declMatch[0].length;
  const bodyEnd = source.indexOf('}', bodyStart);
  if (bodyEnd < 0) {
    throw new Error(
      'STORED_CONFIG_INTERFACE_UNTERMINATED: StoredModelServiceConfig 接口体未闭合。'
    );
  }
  const storedBody = source.slice(bodyStart, bodyEnd);
  if (/\bapiKey\s*[?:]/.test(storedBody)) {
    throw new Error(
      'StoredModelServiceConfig must not include apiKey field：存储态 DTO 含明文 key '
      + '字段意味着它会被写盘。apiKey 只允许作为写入输入出现在别的接口里。'
    );
  }

  console.log(JSON.stringify({
    ok: true,
    message: '模型服务凭据 vault 源码契约验证通过（must-exist + 存储态 DTO 无明文 key）',
    evidence: 'source-text-only',
    path: 'apps/desktop/src/main/modelServiceCredentials.ts',
    mustExistTokens: required.length,
    usesSafeStorage: true,
    storedConfigBodyScanned: storedBody.length,
    configDtoHasApiKey: false,
    delegatedTo: 'npm run test:desktop-security-runtime（preload 暴露面含等价别名、channel 黑名单、真实敏感载荷脱敏——运行期观测）',
    nonClaims: [
      '本套件只做源码文本匹配，不构成运行期证据；凭据不外泄由 test:desktop-security-runtime 承担。',
      '不声明 safeStorage 在本机真实可用（那取决于操作系统钥匙串状态，由运行期套件覆盖）。'
    ]
  }, null, 2));
}

main();
