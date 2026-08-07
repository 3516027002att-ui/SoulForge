import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? 'mods');
const executable = resolve('bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe');

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
    ok: null,
    status: 'skipped',
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
let dfltVerified = 0;
let krakBlocked = 0;
let krakReadVerified = 0;
let nestedBnd4Verified = 0;
let nestedBnd4Entries = 0;
let krakNestedBnd4Verified = 0;
let krakNestedBnd4Entries = 0;
/**
 * 并发度。
 *
 * 为什么必须并发：本脚本对语料根下**每个** .dcx 各 spawn 一次 Bridge。
 * 实测本机语料根是整个游戏目录，8065 个 .dcx，串行耗时 **1264 秒（21 分钟）**
 * ——而 scripts/verify.mjs 的 DEFAULT_TIMEOUT_MS 是 900 秒。也就是说这条套件
 * 经 verify 调度时**必然被判超时失败**，只有直接 npm run 才跑得完。
 * 一条只能绕过调度器才能跑的验证，等于不在验证体系里。
 *
 * 为什么并发是安全的：每次调用都是独立进程、纯只读解析（read-dcx-document），
 * 不写盘、不共享状态，累加全部发生在 await 之后的主循环里，因此结果与串行一致。
 *
 * 取 CPU 核数但夹在 [2,8]：上限压住是因为每个 Bridge 进程会解压 payload，
 * 内存与磁盘 I/O 都不便宜；下限保证单核机器也不退化成串行。
 * 可用 SOULFORGE_DCX_CONCURRENCY 覆盖（排查时设 1 可还原串行行为）。
 */
const CONCURRENCY = (() => {
  const raw = Number.parseInt(process.env.SOULFORGE_DCX_CONCURRENCY ?? '', 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return Math.min(8, Math.max(2, cpus().length));
})();

/** 读一个文件，返回 { file, stdout } 或 { file, error }。不做任何累加。 */
async function readOne(file) {
  try {
    const { stdout } = await execFileAsync(executable, ['read-dcx-document', file], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000
    });
    return { file, stdout };
  } catch (error) {
    return { file, error };
  }
}

/** 定容并发池：始终保持 CONCURRENCY 个在飞，按完成顺序产出。 */
async function* readConcurrently(paths, limit) {
  const queue = [...paths];
  const inFlight = new Set();
  const start = () => {
    const next = queue.shift();
    if (next === undefined) return;
    const p = readOne(next).then((value) => {
      inFlight.delete(p);
      return value;
    });
    inFlight.add(p);
  };
  for (let i = 0; i < limit; i += 1) start();
  while (inFlight.size > 0) {
    const done = await Promise.race(inFlight);
    start();
    yield done;
  }
}

for await (const outcome of readConcurrently(files, CONCURRENCY)) {
  const file = outcome.file;
  try {
    if (outcome.error !== undefined) throw outcome.error;
    const { stdout } = outcome;
    const result = JSON.parse(stdout);
    const data = result.data;
    if (data?.compressionFormat === 'DFLT' && data.roundTrip?.payloadIdentical === true
      && data.roundTrip?.variantIdentical === true) {
      if (!recognizeVariant(data, file)) continue;
      dfltVerified += 1;
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);
      if (data.nested?.format === 'BND4' && data.nested?.roundTrip?.entriesIdentical === true) {
        if (data.nested?.crud?.allPassed !== true || data.nestedDcxRebuildVerified !== true) {
          failures.push({ file: relative(file), code: 'BND4_CRUD_ROUNDTRIP_FAILED' });
          continue;
        }
        nestedBnd4Verified += 1;
        nestedBnd4Entries += data.nested.entryCount;
      }
    } else if (data?.compressionFormat === 'KRAK'
      && typeof data.payloadHash === 'string'
      && /^[a-f0-9]{64}$/u.test(data.payloadHash)) {
      if (!recognizeVariant(data, file)) continue;
      krakReadVerified += 1;
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);
      if (data.nested?.format === 'BND4') {
        const fieldPreservation = data.nested.fieldPreservation;
        if (data.nested?.crud?.allPassed !== true
          || !fieldPreservation
          || fieldPreservation.headerUnknownBytesPreserved !== true
          || fieldPreservation.entryHeaderFieldsPreserved !== true
          || fieldPreservation.storedBytesPreserved !== true) {
          failures.push({ file: relative(file), code: 'KRAK_BND4_PRESERVATION_OR_CRUD_FAILED' });
          continue;
        }
        krakNestedBnd4Verified += 1;
        krakNestedBnd4Entries += data.nested.entryCount;
      }
    } else failures.push({ sample: redact(file), code: result.diagnostics?.[0]?.code ?? 'UNEXPECTED_RESULT' });
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    let result;
    try { result = JSON.parse(stdout); } catch { result = undefined; }
    const message = result?.diagnostics?.[0]?.message ?? String(error);
    if (/Oodle|KRAK|运行库/.test(message)) krakBlocked += 1;
    else failures.push({ sample: redact(file), code: result?.diagnostics?.[0]?.code ?? 'PROCESS_FAILED' });
  }
}
if (dfltVerified === 0 || failures.length > 0) {
  console.error(JSON.stringify({ ok: false, files: files.length, concurrency: CONCURRENCY, dfltVerified, krakReadVerified, krakBlocked, krakNestedBnd4Verified, krakNestedBnd4Entries, variants: Object.fromEntries(variants), unrecognizedVariants: [...unrecognizedVariants], failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    message: '真实 DCX 文档完整读取与 DFLT payload roundtrip 验证通过',
    files: files.length,
    concurrency: CONCURRENCY,
    dfltVerified,
    krakReadVerified,
    krakBlocked,
    krakNestedBnd4Verified,
    krakNestedBnd4Entries,
    nestedBnd4Verified,
    nestedBnd4Entries,
    variants: Object.fromEntries([...variants].sort()),
    reconciliation: {
      observedVariants: [...variants.keys()].sort(),
      allRecognized: unrecognizedVariants.size === 0,
      unrecognizedVariants: [...unrecognizedVariants],
      frozenEnvelopeVariants: [...bridgeEnvelopeVariants].sort()
    },
    failures
  }, null, 2));
}

/**
 * 对账门禁：Bridge `data.variant` 必须属于 frozen schema 推导的信封变体闭集。
 * 未识别变体以 UNRECOGNIZED_BRIDGE_VARIANT 失败关闭，不计为 verified。
 */
function recognizeVariant(data, file) {
  if (typeof data.variant !== 'string' || !bridgeEnvelopeVariants.has(data.variant)) {
    unrecognizedVariants.add(data.variant ?? '<missing>');
    failures.push({
      file: relative(file),
      code: 'UNRECOGNIZED_BRIDGE_VARIANT',
      variant: data.variant ?? '<missing>'
    });
    return false;
  }
  return true;
}

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
