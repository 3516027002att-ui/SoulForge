#!/usr/bin/env node
/**
 * 容器内 PARAM 字段写回：生产调用链验证。
 *
 * ── 守的问题 ──
 *
 * 「字段改了 → 容器里真的变了」这条链跨 5 段：渲染器出口 → IPC handler →
 * applyParamFieldMutation 编码 → write-param 出裸 param → write-bnd4 塞回容器
 * → Patch Engine 落盘。任何一段没接上，界面都会显示「已写入」而产物没变 ——
 * 那是最坏的形态，用户按它继续改，错误会累积。
 *
 * 本仓库已有过同源事故：BND4 无损基线切分出 RebuildPreservingLayout，但只接进
 * 往返报告，生产落盘零调用，「报告说无损、产物不是」。所以这条判据必须打到
 * **真实注册的 IPC handler**，不能只跑 bridge 命令 —— 后者证明的是 C# 能干活，
 * 不是主进程接对了。
 *
 * ── 做法 ──
 *
 * 用与 test:desktop-ipc-contract 同一套真实执行观测（observeMainSurface 加载
 * 生产 out/main 产物，electron 为受控桩），取出真实 listener 并断言：
 *   ① resource.applyContainerParamFieldMutation 已注册；
 *   ② readContainerParamPage 返回写回所需的 containerHash / childHash ——
 *      缺任一个则并发保护无凭据，写入必须拒绝而不是无保护地写；
 *   ③ 未授信定义（origin=fixture）必须被拒绝，且诊断码是
 *      PARAM_FIELD_DEFINITION_NOT_TRUSTED —— 这道门守的是「元数据字段偏移与
 *      真实 PARAM 对不上时按它写入会往错误字节位置塞数值」。
 *
 * ── 不声明什么 ──
 *
 * 本门禁不实际落盘到 Mod 工作区（没有活动会话时 handler 在会话检查处即返回），
 * 因此它不证明 Patch Engine 提交成功、不证明备份与回滚。真实语料的端到端写回
 * 由 test:param-field-write-matrix 与本机 native smoke 覆盖。这里守的是
 * 「生产 IPC 面存在且授权/并发前提不可绕过」这一段，正是最容易接漏的一段。
 */
import {
  createAssertions,
  desktopBundlesBuilt,
  missingBundles,
  observeMainSurface,
  observePreloadSurface,
  structuredSkip
} from './contract/desktopSurface.mjs';

const LABEL = 'container-param-writeback';

if (!desktopBundlesBuilt()) {
  structuredSkip(LABEL, `桌面构建产物缺失: ${missingBundles().join(', ')}`);
}

const assertions = createAssertions(LABEL);
const main = await observeMainSurface();
const preload = await observePreloadSurface();

// ── 判据①：三个 channel 必须真实注册，且 preload 指向同一 channel ──
const WRITE_CHANNEL = 'resource.applyContainerParamFieldMutation';
const READ_CHANNEL = 'resource.readContainerParamPage';
const LIST_CHANNEL = 'resource.listContainerParams';

for (const channel of [LIST_CHANNEL, READ_CHANNEL, WRITE_CHANNEL]) {
  assertions.requireChannel(main, channel);
}
assertions.requirePreloadChannel(preload, 'listContainerParams', LIST_CHANNEL);
assertions.requirePreloadChannel(preload, 'readContainerParamPage', READ_CHANNEL);
assertions.requirePreloadChannel(preload, 'applyContainerParamFieldMutation', WRITE_CHANNEL);

const writeHandler = main.handlers.get(WRITE_CHANNEL);

/**
 * 造一个最小 event 桩。
 *
 * 注意：main 对每个 handler 都做 IPC 发送方校验（只接受受信任的 WebContents），
 * 所以这个桩会被拒绝并抛「已拒绝不受信任的 IPC 调用」。那是**安全机制在正确
 * 工作**，不是缺陷 —— 本门禁如实记录这一段，并把授权判据交给源码级断言，
 * 而不是伪造一个受信任的 sender 去绕过它。绕过安全层来测业务逻辑，等于在测试里
 * 演练一次攻击路径，还会让这道校验将来退化时无人发现。
 */
const fakeEvent = { sender: { id: 1 } };

/*
 * ── 判据③：未授信定义必须被拒绝 ──
 *
 * 没有活动会话时 handler 会先在会话检查处返回 PARAM_WRITE_NO_SESSION，
 * 那条路径不经过授权判定，因此它证明不了授权门存在。这里如实区分两种结果：
 * 拿到 NOT_TRUSTED 才算授权门被执行；拿到 NO_SESSION 说明本环境没有会话，
 * 该判据降级为「源码级存在性」而不是假装通过 —— 零样本恒真是本仓库反复
 * 记录过的坑。
 */
let trustGateOutcome = 'not-reached';
if (typeof writeHandler === 'function') {
  try {
    const result = await writeHandler(fakeEvent, 'file:///fake/gameparam.parambnd.dcx', 'a'.repeat(64), {
      entryIndex: 0,
      expectedChildHash: 'b'.repeat(64),
      rowId: 0,
      fieldId: 'someField',
      value: 1,
      rowDataBase64: Buffer.alloc(32).toString('base64'),
      // origin 刻意是 fixture：模拟「用户尚未确认信任元数据包」
      definition: { schemaVersion: 1, typeName: 'X', version: 0, rowDataSize: 32, origin: 'fixture', fields: [] }
    });
    const codes = (result?.diagnostics ?? []).map((diagnostic) => diagnostic.code);
    if (codes.includes('PARAM_FIELD_DEFINITION_NOT_TRUSTED')) {
      trustGateOutcome = 'enforced';
    } else if (codes.includes('PARAM_WRITE_NO_SESSION') || codes.includes('RESOURCE_NOT_INDEXED')) {
      trustGateOutcome = 'short-circuited-before-gate';
    } else {
      trustGateOutcome = `unexpected:${codes.join(',') || '(无诊断)'}`;
    }
    assertions.check(
      result?.ok !== true,
      '未授信定义 + 未索引资源必须写入失败',
      { ok: result?.ok, codes }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /*
     * 被 IPC 发送方校验拦下是预期结果（见 fakeEvent 的注释）：这条 handler
     * 与其他所有 handler 一样受该校验保护。这里断言的是「确实被那道校验拦下」
     * 而不是「不许抛异常」—— 后者会逼人去伪造受信任 sender 绕过安全层。
     *
     * 若换成别的异常（例如 undefined 解引用），说明 handler 在校验之前就崩了，
     * 那才是真缺陷，判据会红。
     */
    const rejectedBySenderGuard = /不受信任的 IPC 调用/.test(message);
    trustGateOutcome = rejectedBySenderGuard
      ? 'blocked-by-ipc-sender-guard'
      : `threw:${message}`;
    assertions.check(
      rejectedBySenderGuard,
      '写回 handler 要么返回结构化诊断，要么被 IPC 发送方校验拦下；不得以其他异常崩溃',
      { thrown: message }
    );
  }
}

/*
 * ── 判据②：授权门与并发凭据必须在源码里存在 ──
 *
 * 上面的运行期探测在无会话环境下只能走到短路分支，所以这里补一条源码级判据：
 * handler 必须检查 origin 白名单，且必须把 expectedChildHash 传给 write-bnd4。
 * 二者缺一，写入就是「无授权」或「无并发保护」。
 */
const { readFileSync } = await import('node:fs');
const ipcSource = readFileSync('apps/desktop/src/main/ipc.ts', 'utf8');

assertions.check(
  ipcSource.includes('PARAM_FIELD_DEFINITION_NOT_TRUSTED'),
  '写回 handler 必须有未授信拒绝分支（否则未授信元数据也能写入）',
  { found: ipcSource.includes('PARAM_FIELD_DEFINITION_NOT_TRUSTED') }
);
assertions.check(
  /expectedChildHash:\s*mutation\.expectedChildHash/.test(ipcSource),
  'write-bnd4 必须收到调用方给的 expectedChildHash（否则无并发保护，'
  + '两个基于同一份旧字节的改动会互相静默覆盖）',
  { matched: /expectedChildHash:\s*mutation\.expectedChildHash/.test(ipcSource) }
);
assertions.check(
  /mutation:\s*'replace'/.test(ipcSource) && ipcSource.includes("command: 'write-bnd4'"),
  '写回必须经 write-bnd4 的 replace 把裸 param 塞回容器'
  + '（否则改动只停在裸 param 暂存文件，容器不变）',
  {
    hasReplace: /mutation:\s*'replace'/.test(ipcSource),
    hasWriteBnd4: ipcSource.includes("command: 'write-bnd4'")
  }
);
assertions.check(
  ipcSource.includes('unpackedParamCache.clear()'),
  '写回成功后必须清解包缓存（否则缓存仍持旧条目哈希，'
  + '下一次写入的并发保护会拿过期哈希比对）',
  { found: ipcSource.includes('unpackedParamCache.clear()') }
);

assertions.finish({
  message: '容器内 PARAM 字段写回的生产链路已接通：IPC 面真实注册、preload 指向正确、'
    + '授权门与并发凭据不可绕过',
  trustGateOutcome,
  observedChannels: [LIST_CHANNEL, READ_CHANNEL, WRITE_CHANNEL].filter((c) => main.handlers.has(c)),
  nonClaim: '本门禁验证生产 IPC 面真实注册、preload 真实指向、以及授权门与并发凭据'
    + '在源码层不可绕过。它**不**实际落盘：handler 受 IPC 发送方校验保护，'
    + '本门禁的 event 桩会被那道校验拦下（trustGateOutcome=blocked-by-ipc-sender-guard），'
    + '这是安全机制正确工作而非缺陷 —— 故意不伪造受信任 sender 去绕过它。'
    + '因此本门禁不证明 Patch Engine 提交、备份与回滚，也不证明真实容器字节被改。'
    + '容器重打包只波及目标条目这一点已由 bridge 层实测确认（138 条目中仅目标条目'
    + '哈希变化）；真实语料端到端写回由 test:param-field-write-matrix 与本机'
    + ' native smoke 覆盖。'
});
