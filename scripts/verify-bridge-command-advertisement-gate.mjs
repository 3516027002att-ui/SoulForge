#!/usr/bin/env node
/**
 * Bridge 命令广告面对账门禁（任务书 T4-4 ①②⑥）。
 *
 * 守的形态：TS 与 C# 各写一份命令集，手工同步，无 codegen、无共享 schema。
 * 三份清单必须一致，而此前一份都没被校验：
 *   ① 广告集   BridgeDaemonHost.AdvertisedCommands（capabilities 帧里报给调用方的）
 *   ② dispatch 集 BridgeCommandService.ExecuteAsync 实际受理的命令
 *   ③ TS 集    packages/shared 的 BridgeCommandName 与 core 的 runBridge 命令 union
 *
 * 实测漂移（改造前）：
 *   · 广告 24 条 / dispatch 26 条，**6 个已实现命令从未被广告**
 *     （inventory-asset-resources、export-tpf-texture、read-flver-skeleton /
 *      -texture-slots / -dummies、read-mtd-document）；
 *   · read-mtd-document 在 C# 已实现（253 行的 MtdNativeDocument），而 TS 两个
 *     union 都没有 —— 应用层结构上不可达。
 *
 * 漂移为什么长期无人发现：唯一的消费端 bridgeDaemonClient.capabilities()
 * **全仓零调用者**（实测）。广告没人读，就没人发现它错。
 *
 * 为什么本门禁是源码文本级而不是运行期观测：
 *   dispatch 是一串 `if (command == "...")` 与一个尾部 switch，没有运行期注册表
 *   可枚举；要运行期证明「命令 X 会被受理」就得对每条命令各备一份合法样本，
 *   那是 native 层的成本。故本门禁如实标注 evidence: 'source-text-only'，
 *   并对提取失败失败关闭 —— 提取不到集合就等于判据消失。
 *   运行期那一半由 test:bridge-write-boundary 覆盖（它对 7 条写盘命令真发请求）。
 *
 * 语义边界：命令被广告/受理**不表示**对应格式具备 native parser/writer
 * authority。本门禁不提升任何 authority。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'bridge-command-advertisement';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const findings = [];

function report(payload, exitCode) {
  const stream = exitCode === 0 ? console.log : console.error;
  stream(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

function check(name, condition, observed) {
  checks.push({ name, ok: Boolean(condition), observed });
  if (!condition) findings.push({ name, observed });
}

/**
 * 切出某个具名 TS union 的成员字面量。
 *
 * 只取 `type <名字> =` 到第一个 `;` 之间的部分——同文件里还有别的 union，
 * 全文扫 `| 'x'` 会混入无关成员并报出假漂移。
 */
function sliceUnion(source, typeName) {
  const start = source.search(new RegExp(`type\\s+${typeName}\\s*=`));
  if (start < 0) return null;
  const end = source.indexOf(';', start);
  if (end < 0) return null;
  return source.slice(start, end);
}

function extractUnion(source, typeName, code) {
  const body = sliceUnion(source, typeName);
  if (body === null) {
    throw new Error(`${code}: 无法定位 union ${typeName}。提取失败必须失败关闭。`);
  }
  const names = [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`${code}_EMPTY: ${typeName} 提取结果为空。`);
  return names;
}

/** runBridge 侧那份副本可能不存在（它可以直接 import shared 类型），故允许缺。 */
function extractUnionOptional(source, typeName) {
  const body = sliceUnion(source, typeName);
  if (body === null) return [];
  return [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

/** 提取失败必须抛，不能返回空集——空集会让后续所有差集判据恒真。 */
function extractOrThrow(source, pattern, code, what) {
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(`${code}: 无法从源码提取${what}。提取失败必须失败关闭，否则判据会静默消失。`);
  }
  const names = [...match[1].matchAll(/'([a-z0-9-]+)'|"([a-z0-9-]+)"/g)]
    .map((m) => m[1] ?? m[2]);
  if (names.length === 0) {
    throw new Error(`${code}_EMPTY: ${what}提取结果为空。`);
  }
  return names;
}

try {
  const hostSource = readFileSync(
    resolve(root, 'bridge', 'SoulForge.Bridge', 'BridgeDaemonHost.cs'), 'utf8'
  );
  const serviceSource = readFileSync(
    resolve(root, 'bridge', 'SoulForge.Bridge', 'BridgeCommandService.cs'), 'utf8'
  );
  const sharedSource = readFileSync(
    resolve(root, 'packages', 'shared', 'src', 'bridge-protocol.ts'), 'utf8'
  );
  const runBridgeSource = readFileSync(
    resolve(root, 'packages', 'core', 'src', 'bridge', 'runBridge.ts'), 'utf8'
  );

  // ① 广告集
  const advertised = extractOrThrow(
    hostSource,
    /AdvertisedCommands\s*=\s*\{([\s\S]*?)\};/,
    'ADVERTISEMENT_UNREADABLE',
    'AdvertisedCommands'
  );

  // ② dispatch 集：三种受理形态都要认——`command == "x"`、`command is "a" or "b"`、
  //    尾部 switch 的 `case`/switch-arm。少认一种就会把已实现命令误报成未实现。
  const dispatched = new Set([
    ...[...serviceSource.matchAll(/command\s*==\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
    ...[...serviceSource.matchAll(/command\s+is\s+"([a-z0-9-]+)"(?:\s+or\s+"([a-z0-9-]+)")*/g)]
      .flatMap((m) => m[0].match(/"([a-z0-9-]+)"/g).map((q) => q.slice(1, -1))),
    ...[...serviceSource.matchAll(/^\s*"([a-z0-9-]+)"\s*=>/gm)].map((m) => m[1])
  ]);
  if (dispatched.size === 0) {
    throw new Error('DISPATCH_UNREADABLE: 未能从 BridgeCommandService 提取任何受理命令。');
  }

  // ③ TS 两份 union。**必须先切出目标 union 再取字面量**：这两个文件里还有
  //    BridgeAuthorityLevel / BridgeDaemonFrameKind / BridgeFailureKind 等多个
  //    union，全文扫 `| 'x'` 会把 handshake、candidate、timeout 之类一并收进来，
  //    然后报出一堆与命令无关的假漂移（第一版实测就是这样）。
  const tsUnion = extractUnion(sharedSource, 'BridgeCommandName', 'TS_UNION_UNREADABLE');
  // 注意 union 名字两侧不同：shared 叫 BridgeCommandName，runBridge 叫 BridgeCommand。
  // 第一版这里按 BridgeCommandName 找 runBridge，切不到就返回空数组，于是那条判据
  // 被静默跳过——「提取失败等于判据消失」的形态，所以这里必须失败关闭而不是可选。
  const runBridgeUnion = extractUnion(runBridgeSource, 'BridgeCommand', 'RUNBRIDGE_UNION_UNREADABLE');

  // capabilities/health 是协议帧而非文件命令，不经 ExecuteAsync 分派。
  const PROTOCOL_ONLY = new Set(['capabilities', 'health']);
  const fileCommandsInTs = tsUnion.filter((c) => !PROTOCOL_ONLY.has(c));

  const advertisedSet = new Set(advertised);
  const implementedNotAdvertised = [...dispatched].filter((c) => !advertisedSet.has(c));
  const advertisedNotImplemented = advertised.filter((c) => !dispatched.has(c));

  check(
    '广告集必须与实际 dispatch 集一致（漏报=能力不可发现，虚报=调用方收到 UNKNOWN_COMMAND）',
    implementedNotAdvertised.length === 0 && advertisedNotImplemented.length === 0,
    {
      evidence: 'source-text-only',
      advertisedCount: advertised.length,
      dispatchedCount: dispatched.size,
      implementedNotAdvertised,
      advertisedNotImplemented
    }
  );

  const tsSet = new Set(fileCommandsInTs);
  const implementedNotInTs = [...dispatched].filter((c) => !tsSet.has(c));
  check(
    'C# 已实现的命令必须都在 TS BridgeCommandName 里（否则应用层结构上不可达）',
    implementedNotInTs.length === 0,
    { evidence: 'source-text-only', implementedNotInTs, tsCommandCount: fileCommandsInTs.length }
  );

  const tsNotImplemented = fileCommandsInTs.filter((c) => !dispatched.has(c));
  check(
    'TS 声明的命令必须都被 C# 受理（否则调用即 UNKNOWN_COMMAND，是死命令名）',
    tsNotImplemented.length === 0,
    { evidence: 'source-text-only', tsNotImplemented }
  );

  // runBridge 里那份 union 是第二份手写副本；两份 TS 清单自己也会漂移。
  const runBridgeSet = new Set(runBridgeUnion);
  const missingInRunBridge = fileCommandsInTs.filter((c) => !runBridgeSet.has(c));
  const extraInRunBridge = runBridgeUnion.filter(
    (c) => !tsSet.has(c) && !PROTOCOL_ONLY.has(c)
  );
  check(
    'TS 两份命令清单（shared BridgeCommandName 与 core BridgeCommand）必须一致',
    missingInRunBridge.length === 0 && extraInRunBridge.length === 0,
    { evidence: 'source-text-only', missingInRunBridge, extraInRunBridge }
  );

  if (findings.length > 0) {
    report({
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'BRIDGE_COMMAND_ADVERTISEMENT_DRIFT',
      message: 'Bridge 命令集在广告面 / dispatch / TS 声明之间漂移；'
        + '漏报使已实现能力不可发现，虚报使调用方收到 UNKNOWN_COMMAND。',
      passed: checks.length - findings.length,
      failed: findings.length,
      findings
    }, 1);
  }

  report({
    ok: true,
    gate: LABEL,
    status: 'passed',
    assertions: checks.length,
    advertisedCommands: advertised.length,
    dispatchedCommands: dispatched.size,
    tsFileCommands: fileCommandsInTs.length,
    evidence: 'source-text-only',
    message: '广告集、dispatch 集与 TS 命令声明三方一致。',
    nonClaim: '本门禁只对账命令集合；命令被广告或受理不表示对应格式具备'
      + ' native parser/writer authority，也不构成运行期证据'
      + '（运行期那一半由 test:bridge-write-boundary 对 7 条写盘命令覆盖）。'
  }, 0);
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'BRIDGE_COMMAND_ADVERTISEMENT_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error),
    checks
  }, 1);
}
