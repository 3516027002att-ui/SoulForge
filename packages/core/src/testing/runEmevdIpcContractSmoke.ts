/**
 * EMEVD 实现级契约：main 侧文档权威归属 + Bridge 命令名 + 分页模板报告字段。
 *
 * 四个 EMEVD channel 的注册与 preload 接线已迁到真实执行观测门禁
 * `npm run test:desktop-ipc-contract`。旧版本这段断言尤其无效：它写成
 * 「if (!ipc.includes(token) && token !== 'handle(') { if (token === X && !ipc.includes(X)) throw }」
 * 这类嵌套否定，实际等价于把同一个 includes 判断做了三遍，无论如何都不会
 * 因 channel 改名而失败。
 *
 * 保留项：
 *  - 硬约束 18（renderer 不得持有权威文档）在 main 侧的落点，是模块级私有
 *    状态，运行时表面观测不到；
 *  - Bridge 命令名；
 *  - 硬约束 17 的模板截断上报字段名。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const commit = readFileSync(resolve(root, 'packages/core/src/editing/emevdBridgeCommit.ts'), 'utf8');

  // 硬约束 18：完整 EMEVD 文档必须只存在于 main 的私有缓存里。
  if (!ipc.includes('emevdFullDocuments')) {
    throw new Error('main 必须持有权威完整 EMEVD 文档缓存（硬约束 18）。');
  }
  if (!ipc.includes('readFullEmevdDocumentViaBridge') || !ipc.includes('submitEmevdDslPlanViaFourView')) {
    throw new Error('main 必须分页组装完整文档并经 four-view 生产入口提交。');
  }
  // renderer 侧必须拿不到完整文档：preload 不得出现完整文档类型或缓存名。
  if (preload.includes('emevdFullDocuments')) {
    throw new Error('preload 不得触达 main 的权威完整文档缓存（硬约束 18）。');
  }

  // 硬约束 17：DSL 模板必须有界渲染，并把截断状态上报给 renderer。
  // R3/P4 裁定（2026-08-14）：production 反汇编入口改为 DarkScript3 式；旧 hash DSL
  // 渲染（renderEmevdPatchDslBounded）已从 ipc.ts 移除，底层 dslCompiler/typed 写链
  // 保留。没 EMEDF 必须失败关闭（EMEDF_MISSING + dslTemplate null），不能再发 hash
  // 伪源码。
  //
  // 反汇编入口另外钉住「分片异步」：同步入口那 75 ms 会让主进程事件循环整段停摆，
  // 取消信号只能排队，于是快速切换时旧请求取消不掉。两条断言分开写是必要的 ——
  // 异步入口若命名成 renderEmevdDarkScriptBoundedAsync，第一条会因子串关系恒真，
  // 门禁看着绿其实已经瞎了。
  if (!ipc.includes('renderEmevdDarkScriptAsync')) {
    throw new Error('main 必须走分片异步 DarkScript3 反汇编入口（不得在主进程同步反汇编）。');
  }
  if (!ipc.includes('readEmevdSourceSlice') || !ipc.includes('sourceToken')) {
    throw new Error('main 必须提供 sourceToken + readEmevdSourceSlice（3.1 不得一次回全文）。');
  }
  if (!ipc.includes('emevdDarkScriptWorkerHost') && !ipc.includes('worker_threads')) {
    throw new Error('main 必须把反汇编派到 worker（3.3），不得只在主线程拼 7 万行。');
  }
  if (ipc.includes('renderEmevdDarkScriptBounded')) {
    throw new Error('production 入口不得残留同步有界反汇编调用（会重新引入 75 ms 停摆）。');
  }
  if (!ipc.includes('EMEDF_MISSING')) {
    throw new Error('main 在未找到用户本机 EMEDF 时必须失败关闭（EMEDF_MISSING 诊断）。');
  }
  if (!ipc.includes('sourceStyle')) {
    throw new Error('main 必须上报源码形态 sourceStyle（dark-script/patch-dsl/none）。');
  }
  if (!ipc.includes('dslTemplateTruncated') || !ipc.includes('dslTemplateTotalLines')) {
    throw new Error('main 必须向 renderer 上报模板截断状态与总行数。');
  }
  if (!ipc.includes('loadFullDslTemplate')) {
    throw new Error('main 必须支持显式加载完整模板。');
  }

  if (!commit.includes('write-emevd')) {
    throw new Error('emevdBridgeCommit 必须使用 Bridge 命令 write-emevd。');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 实现级契约验证通过（main 文档权威 + 有界模板上报 + Bridge 命令名）',
    mainDocumentAuthority: 'emevdFullDocuments（renderer 不可达）',
    boundedTemplate: ['dslTemplateTruncated', 'dslTemplateTotalLines', 'loadFullDslTemplate'],
    bridgeCommands: ['write-emevd'],
    delegatedTo: 'npm run test:desktop-ipc-contract（4 个 EMEVD channel 注册 / preload 接线 / 双向对账，真实执行观测）'
  }, null, 2));
}

main();
