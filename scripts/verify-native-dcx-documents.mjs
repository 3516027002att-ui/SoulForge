import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createBridgeDaemonScope } from '../packages/core/dist/bridge/runBridge.js';
import { classifyDcxRead, collectNativeReads, summarizeNativeReads, verifyFileCoverage } from './native-read-acceptance.mjs';

/**
 * 语料根解析。
 *
 * SOULFORGE_NATIVE_FIXTURE_ROOT 在本仓库有**两种语义**，混用会出错：
 *   · 用法 A（registry 基准）：has-game-registry.json 里的 localPath 全部以
 *     `mods/` 开头，所以它是**游戏根**。nativeFixtureRegistry.ts 按这个用。
 *     with-local-has-game-env.mjs:60 也把它设成游戏根。
 *   · 用法 B（遍历根）：本脚本与 verify-corpus-manifest 直接拿它当扫描起点。
 *
 * 本脚本原先按用法 B 直接用它，于是经 with-local-has-game-env 跑时扫的是
 * **整个游戏根 8065 个 .dcx**，而不是设计意图里的 mods/。实测后果：多出的
 * shader/font/parts/facegen 文件带来 12 条 UNRECOGNIZED_BRIDGE_VARIANT
 * （新变体 DFLT_10000_24_9_0，frozen schema 闭集里只有它的旧四段写法
 * DFLT_10000_24_9）、1 条 176 字节退化容器的 CRUD 失败、1 条读取失败，
 * 于是这条套件恒定 exit 1。而 EV-REL-B-CORPUS-02 记录它当初 exit 0、
 * dflt=144/krak=70/allRecognized=true —— 那次扫的正是 mods 下的 214 个。
 *
 * 修法：若给定根下存在 mods/ 子目录，就下沉到它——这与 registry localPath 的
 * `mods/` 前缀、以及 verify-private-native-gate 的 resolve(root, 'mods') 一致。
 * 显式传参（argv[2]）时不下沉，因为那是调用方明确指定的目录。
 *
 * 不改 frozen schema 去容纳新变体：那等于在没验证这些变体能否无损往返的前提下
 * 扩大 native authority 声明面，而 shader/font/parts 本就不在 V0.5「文本优先」
 * 五个编辑器范围内。游戏根语料的变体对账是独立议题，见交接书 §9.14。
 */
const explicitRoot = process.argv[2];
const root = (() => {
  if (explicitRoot) return resolve(explicitRoot);
  const envRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!envRoot) return resolve('mods');
  const base = resolve(envRoot);
  const modsUnder = join(base, 'mods');
  return existsSync(modsUnder) ? modsUnder : base;
})();

// frozen schema 对账：Bridge data.variant 输出必须属于 observedVariant 闭集
// 按 `DCX_` 前缀约定推导出的信封变体集合。schema 是机器可读权威，脚本不复制
// 第二份枚举——漂移会在这里失败关闭。
const schemaJson = JSON.parse(await readFile(
  resolve('packages/core/src/bridge/releaseCorpusRegistry.schema.json'),
  'utf8'
));
const observedVariantsByFormat = schemaJson?.['x-constants']?.observedVariantsByFormat;
if (!observedVariantsByFormat?.DFLT || !observedVariantsByFormat?.KRAK) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code: 'RELEASE_CORPUS_SCHEMA_MISSING',
    message: 'frozen schema x-constants 缺少 observedVariantsByFormat；无法对账 Bridge variant。'
  }, null, 2));
  process.exitCode = 1;
  process.exit();
}
const bridgeEnvelopeVariants = new Set([
  ...observedVariantsByFormat.DFLT.map((variant) => variant.slice('DCX_'.length)),
  ...observedVariantsByFormat.KRAK.map((variant) => variant.slice('DCX_'.length))
]);
const unrecognizedVariants = new Set();

// 语料根不存在时结构化跳过，而不是让 readdir 抛 ENOENT。
//
// 本条属 native 层，默认根是仓库外的 mods/（或 SOULFORGE_NATIVE_FIXTURE_ROOT）。
// 此前没有跳过分支：本机无语料时它以 ENOENT 崩溃，而 native 层缺环境的正确表现
// 是诚实跳过——崩溃会让「缺语料」与「解析真的坏了」在退出码上不可区分，正是
// 硬约束 7 要求区分的两种状态。同 runRealModOpenSmoke 的处置口径。
if (!existsSync(root)) {
  console.log(JSON.stringify({
    ...summarizeNativeReads([{ family: 'native corpus', status: 'not_run' }]),
    gate: 'native-dcx-documents',
    reason: `本机 native 语料根不存在：${root}`,
    remedy: 'npm run bridge:verify:dcx-documents -- <语料目录>，或设置 SOULFORGE_NATIVE_FIXTURE_ROOT',
    skipSemantics: '结构跳过：未声称通过，也不构成 native 完成声明。'
  }, null, 2));
  process.exit(0);
}

const files = (await walk(root)).filter((path) => extname(path).toLowerCase() === '.dcx');
const variants = new Map();
const failures = [];
const rows = [];
const processed = [];
const readOnlyCaches = [];
let dfltVerified = 0;
let krakReadVerified = 0;
let nestedBnd4Verified = 0;
let nestedBnd4Entries = 0;
let krakNestedBnd4Verified = 0;
let krakNestedBnd4Entries = 0;
// 保留原并发配置；生产 daemon 自身的并发边界不在此提高。
const CONCURRENCY = (() => {
  const raw = Number.parseInt(process.env.SOULFORGE_DCX_CONCURRENCY ?? '', 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return Math.min(8, Math.max(2, cpus().length));
})();

const bridge = createBridgeDaemonScope();
const oodleRuntimeRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || undefined;
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 使用生产 executable 选择、daemon 与 file-backed artifact 传输，不经 CLI stdout 缓冲。 */
async function readOne(file) {
  try {
    const sourceSize = (await stat(file)).size;
    // 只读大包分支必须绑定调用前独立观察的源版本，不能拿返回值充当 expected。
    const sourceHash = sourceSize > 64 * 1024 * 1024 ? await sha256(file) : undefined;
    const result = await bridge.run({
      command: 'read-dcx-document', filePath: file, allowedRoots: [root], timeoutMs: 60_000,
      ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
    });
    const sourceUnchanged = sourceHash !== undefined ? sourceHash === await sha256(file) : undefined;
    return { file, result, context: { file, sourceHash, sourceSize, sourceUnchanged, variants: bridgeEnvelopeVariants } };
  } catch (error) {
    return { file, error };
  }
}

try {
  for await (const outcome of collectNativeReads(files, CONCURRENCY, readOne)) {
    const file = outcome.file;
    processed.push(file);
    try {
      if (outcome.error !== undefined) throw outcome.error;
      const verdict = classifyDcxRead(outcome.result, outcome.context);
      rows.push({ file: relative(file), ...verdict });
      if (verdict.status === 'failed') {
        failures.push({ sample: redact(file), code: verdict.code });
        if (verdict.code === 'UNRECOGNIZED_BRIDGE_VARIANT') unrecognizedVariants.add(outcome.result.data?.variant ?? '<missing>');
        continue;
      }
      if (verdict.status !== 'passed') continue;
      const data = outcome.result.data;
      if (verdict.kind === 'read-only-cache') {
        readOnlyCaches.push({ file: relative(file), sourceHash: outcome.context.sourceHash,
          entryCount: verdict.entryCount, readOnly: true, containerWriteSupported: false, outerRoundTripVerified: false });
        continue;
      }
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);
      if (verdict.kind === 'dflt-roundtrip') {
        dfltVerified += 1;
        if (data.nested?.format === 'BND4' && data.nested?.roundTrip?.entriesIdentical === true) {
          nestedBnd4Verified += 1;
          nestedBnd4Entries += data.nested.entryCount;
        }
      } else if (verdict.kind === 'krak-native-read') {
        krakReadVerified += 1;
        if (data.nested?.format === 'BND4') {
          krakNestedBnd4Verified += 1;
          krakNestedBnd4Entries += data.nested.entryCount;
        }
      }
    } catch (error) {
      rows.push({ file: relative(file), status: 'failed', code: 'PROCESS_FAILED' });
      failures.push({ sample: redact(file), code: 'PROCESS_FAILED', message: String(error).slice(0, 300) });
    }
  }
} finally {
  await bridge.dispose();
}
const coverage = verifyFileCoverage(files.map(relative), processed.map(relative));
const roundTripCoverage = { family: 'DFLT payload roundtrip', status: dfltVerified > 0 ? 'passed' : 'not_run', verifiedFiles: dfltVerified };
const summary = summarizeNativeReads([
  ...rows,
  ...(dfltVerified === 0 ? [roundTripCoverage] : []),
  ...(!coverage.ok ? [{ family: 'input-output coverage', status: 'failed' }] : [])
]);
console.log(JSON.stringify({
    ...summary,
    gate: 'native-dcx-documents',
    message: 'DFLT 往返、KRAK 原生读取与大包只读缓存分别记账；只读缓存不证明外容器可写。',
    files: files.length,
    coverage,
    roundTripCoverage,
    concurrency: CONCURRENCY,
    dfltVerified,
    krakReadVerified,
    krakNestedBnd4Verified,
    krakNestedBnd4Entries,
    nestedBnd4Verified,
    nestedBnd4Entries,
    readOnlyCaches,
    variants: Object.fromEntries([...variants].sort()),
    reconciliation: {
      observedVariants: [...variants.keys()].sort(),
      allRecognized: unrecognizedVariants.size === 0,
      unrecognizedVariants: [...unrecognizedVariants],
      frozenEnvelopeVariants: [...bridgeEnvelopeVariants].sort()
    },
    failures,
    rows
  }, null, 2));
if (summary.status === 'failed') process.exitCode = 1;

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
function redact(path) {
  return `sample-${createHash('sha256').update(relative(path)).digest('hex').slice(0, 12)}`;
}
function relative(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }
