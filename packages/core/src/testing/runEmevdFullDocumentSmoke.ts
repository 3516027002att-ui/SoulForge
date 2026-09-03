/**
 * Full EMEVD editor-document pagination/assembly smoke:
 * 1) Synthetic EMEVD (always): paginated Bridge reads assemble a complete
 *    document with validated continuity, totals, event slices and unknown
 *    instruction classification via the fixture EMEDF registry. Also asserts
 *    the bounded outline DTO and the bounded DSL projection (partial
 *    projection + unknown-as-read-only + absolute-path desensitization).
 * 2) Bridge 文档缓存回归（always）：缓存身份必须绑内容哈希（等长改写 + 回写原
 *    mtime 后重读要看见新 args 与新 sourceHash）；同文件并发只解析一次；不同
 *    文件不在全局锁上串行；`cachePolicy: bypass` 无条件重读磁盘，既不命中也
 *    不写入陈旧条目。判据全部走 `EMEVD_DOCUMENT_CACHE_STATE` 的计数，不看时钟。
 * 3) Real corpus (env-injected): common.emevd.dcx opened as the outer resource
 *    — Bridge unwraps DCX natively (sourceFormat=dcx, outerFileHash = the .dcx
 *    file hash, sourceHash = the decompressed payload hash, cross-checked
 *    against the TypeScript decompressor) — with a small page size it must
 *    assemble to the exact native instruction count and cover partial
 *    projection / unknown instruction / bounded outline / 绝对路径脱敏.
 */
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { renderEmevdPatchDslBounded } from '../emevd/dslRenderer.js';
import { attachEmevdStableIdentity } from '../emevd/stableIdentity.js';
import type { EmevdEnvelopePage } from '../editing/emevdFullDocument.js';
import {
  buildEmevdDocumentOutline,
  expectedInstructionTotal,
  readFullEmevdDocumentViaBridge,
  sanitizeResourceUri
} from '../editing/emevdFullDocument.js';
import {
  buildSyntheticEmevd,
  largeSyntheticEmevd,
  mutatedWaitForArgs,
  sha256Hex,
  standardSyntheticEmevd,
  standardSyntheticEmevdEqualLengthVariant
} from './syntheticEmevdBytes.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 绝对路径脱敏：文本不得含本地绝对路径（盘符路径段或全路径前缀）。 */
function assertDesensitized(text: string, absolutePath: string, label: string): void {
  assert(!text.includes(absolutePath), `${label} 泄漏了本地绝对路径`);
  // 盘符路径：单字母盘符紧跟 :/ 或 :\，且盘符前不是 URI scheme 的字母
  // （file:// 里的 e:// 是 scheme，不是盘符，不能误判）。
  assert(!/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text), `${label} 泄漏盘符路径`);
}

/* ------------------------------------------------------------------ */
/*  Bridge 文档缓存回归（缓存身份 / 单飞 / 跨文件并行 / bypass）        */
/* ------------------------------------------------------------------ */

/**
 * `EMEVD_DOCUMENT_CACHE_STATE` 诊断的 details 形状，与 C# 侧
 * `EmevdDocumentSessionCache.Observation` 一一对应（camelCase 序列化）。
 */
interface CacheObservation {
  state: string;
  hits: number;
  misses: number;
  loads: number;
  coalesced: number;
  bypasses: number;
  oversized: number;
  cancelledLoads: number;
  peakConcurrentLoads: number;
  sessionsIssued: number;
  sessionHits: number;
}

const CACHE_STATES = new Set(['loaded', 'hit', 'coalesced', 'bypass', 'unkeyed', 'oversize', 'session']);
const CACHE_COUNTERS = [
  'hits',
  'misses',
  'loads',
  'coalesced',
  'bypasses',
  'oversized',
  'cancelledLoads',
  'peakConcurrentLoads',
  'sessionsIssued',
  'sessionHits'
] as const;

/**
 * 逐字段校验缓存诊断，**不用裸 `as`**。
 *
 * C# 侧字段改名（Loads → LoadCount 之类）在裸 `as` 下会静默变成 `undefined`,
 * 下面所有计数断言随之比较 `undefined === 1` —— 那是恒假还是恒真取决于写法，
 * 但无论哪种都不再证明缓存行为。这里让形状漂移直接红，且报出实际收到的键。
 */
function requireCacheObservation(
  diagnostics: ReadonlyArray<{ code: string; details?: unknown }>,
  label: string
): CacheObservation {
  const found = diagnostics.find((d) => d.code === 'EMEVD_DOCUMENT_CACHE_STATE');
  assert(
    found !== undefined,
    `${label}: 响应里没有 EMEVD_DOCUMENT_CACHE_STATE 诊断。`
      + `收到的诊断码：${JSON.stringify(diagnostics.map((d) => d.code))}。`
      + 'Bridge 产物可能是旧二进制（Release 与 Debug 都要重新 build）。'
  );
  const details = found.details;
  assert(
    details !== null && typeof details === 'object' && !Array.isArray(details),
    `${label}: 缓存诊断缺少结构化 details（收到 ${typeof details}）。`
  );
  const record = details as Record<string, unknown>;
  assert(
    typeof record.state === 'string' && CACHE_STATES.has(record.state),
    `${label}: state 非法 —— ${JSON.stringify(record.state)}；已知键：${JSON.stringify(Object.keys(record))}`
  );
  for (const field of CACHE_COUNTERS) {
    const value = record[field];
    assert(
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
      `${label}: 缓存计数字段 ${field} 不是非负整数 —— ${JSON.stringify(value)}；`
        + `已知键：${JSON.stringify(Object.keys(record))}`
    );
  }
  return {
    state: record.state as string,
    hits: record.hits as number,
    misses: record.misses as number,
    loads: record.loads as number,
    coalesced: record.coalesced as number,
    bypasses: record.bypasses as number,
    oversized: record.oversized as number,
    cancelledLoads: record.cancelledLoads as number,
    peakConcurrentLoads: record.peakConcurrentLoads as number,
    sessionsIssued: record.sessionsIssued as number,
    sessionHits: record.sessionHits as number
  };
}

interface CacheProbe {
  envelope: EmevdEnvelopePage;
  cache: CacheObservation;
  cancelled?: boolean;
}

/**
 * 直接走一次 `read-emevd-document` 并取回缓存观测。
 *
 * 不能借道 `readFullEmevdDocumentViaBridge`：它在成功路径上丢弃 Bridge 自己的
 * 诊断、只留 `EMEVD_FULL_DOCUMENT_ASSEMBLED`，缓存状态到不了这里。
 *
 * `instructionPageSize: 1` 是故意的：缓存装载是**按文件**发生的，页大小只影响
 * 回传多少条指令体。大 fixture 用 1 条能让帧保持在几百字节，同时解析成本一分不减。
 */
async function probeEmevdCache(options: {
  filePath: string;
  allowedRoots: string[];
  cachePolicy?: 'default' | 'bypass';
  pageSize?: number;
  instructionPage?: number;
  documentSession?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  testHoldUntilFile?: string;
  testRewriteAfterRead?: string;
  testCompletedFile?: string;
  testSignalFile?: string;
}): Promise<CacheProbe> {
  const result = await runBridge<EmevdEnvelopePage>({
    command: 'read-emevd-document',
    filePath: options.filePath,
    allowedRoots: options.allowedRoots,
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.signal ? { signal: options.signal } : {}),
    commandOptions: {
      instructionPage: options.instructionPage ?? 0,
      instructionPageSize: options.pageSize ?? 1,
      ...(options.cachePolicy ? { cachePolicy: options.cachePolicy } : {}),
      ...(options.documentSession ? { documentSession: options.documentSession } : {}),
      ...(options.testHoldUntilFile ? { testHoldUntilFile: options.testHoldUntilFile } : {}),
      ...(options.testRewriteAfterRead ? { testRewriteAfterRead: options.testRewriteAfterRead } : {}),
      ...(options.testCompletedFile ? { testCompletedFile: options.testCompletedFile } : {}),
      ...(options.testSignalFile ? { testSignalFile: options.testSignalFile } : {})
    }
  });
  const cancelled = result.diagnostics.some((d) => d.code === 'BRIDGE_REQUEST_CANCELLED')
    || (options.signal?.aborted ?? false);
  if (cancelled) {
    return {
      envelope: (result.data ?? {}) as EmevdEnvelopePage,
      cache: result.diagnostics.some((d) => d.code === 'EMEVD_DOCUMENT_CACHE_STATE')
        ? requireCacheObservation(result.diagnostics, options.filePath)
        : {
            state: 'cancelled',
            hits: 0,
            misses: 0,
            loads: 0,
            coalesced: 0,
            bypasses: 0,
            oversized: 0,
            cancelledLoads: 0,
            peakConcurrentLoads: 0,
            sessionsIssued: 0,
            sessionHits: 0
          },
      cancelled: true
    };
  }
  assert(
    result.parseStatus !== 'failed' && result.data !== undefined && result.data !== null,
    `缓存观测读取失败：${JSON.stringify(result.diagnostics)}`
  );
  return {
    envelope: result.data as EmevdEnvelopePage,
    cache: requireCacheObservation(result.diagnostics, options.filePath)
  };
}

/** 第一个事件第一条指令的 args（缓存是否返回了改写后内容的判据）。 */
function firstInstructionArgs(document: { events: Array<{ instructions: Array<{ argsBase64: string }> }> }): Buffer {
  const instruction = document.events[0]?.instructions[0];
  assert(instruction !== undefined, '缓存回归 fixture 的第一个事件必须至少有一条指令');
  return Buffer.from(instruction.argsBase64, 'base64');
}

/**
 * 场景 A —— 等长改写 + 回写原 mtime，第二次读必须看见新内容。
 *
 * 这是任务要求的核心复现：外部工具改一个 arg 字节、长度不变、时间戳还原。
 * `(path, mtime, length)` 形态的缓存键在这一形态下会命中旧文档，把过期指令
 * 交给写回前置条件。走生产入口 `readFullEmevdDocumentViaBridge`，不是探针。
 */
async function cacheIdentitySurvivesEqualLengthRewrite(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-identity');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const baseline = standardSyntheticEmevd();
  const variant = standardSyntheticEmevdEqualLengthVariant();
  assert(baseline.length === variant.length, `等长前提不成立：${baseline.length} vs ${variant.length}`);
  assert(!baseline.equals(variant), '基线与变体必须内容不同，否则这条回归恒绿');

  const registry = createSekiroFixtureEmedf();
  const readOnce = (): Promise<Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>>> =>
    readFullEmevdDocumentViaBridge({
      filePath: file,
      allowedRoots: [dir],
      resourceUri: 'file://event/common.emevd',
      registry,
      documentInstanceId: 'emevd-cache-identity'
    });

  // 固定 mtime：写入后立刻钉住，改写后再钉回同一个值。
  const frozen = new Date('2020-01-02T03:04:05.000Z');
  await writeFile(file, baseline);
  await utimes(file, frozen, frozen);
  const before = await stat(file);

  const first = await readOnce();
  assert(first.ok, `首读失败：${JSON.stringify(first.diagnostics)}`);
  const firstArgs = firstInstructionArgs(first.document!);
  assert(
    firstArgs.equals(Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    `首读 args 不是基线值：${firstArgs.toString('hex')}`
  );
  assert(first.sourceHash === sha256Hex(baseline), '首读 sourceHash 必须等于基线内容哈希');

  // 外部工具形态：等长改写，然后把 mtime/atime 都还原成改写前的值。
  await writeFile(file, variant);
  await utimes(file, frozen, frozen);
  const after = await stat(file);
  assert(after.size === before.size, `改写后长度变了（${before.size} → ${after.size}），这条回归就不再针对等长形态`);
  assert(after.mtimeMs === before.mtimeMs, `mtime 未还原（${before.mtimeMs} → ${after.mtimeMs}），缓存键会因时间戳而失效，绕过了被测属性`);

  const second = await readOnce();
  assert(second.ok, `改写后重读失败：${JSON.stringify(second.diagnostics)}`);
  const secondArgs = firstInstructionArgs(second.document!);
  assert(
    !secondArgs.equals(firstArgs),
    `等长改写 + 原 mtime 后重读仍返回旧 args（${secondArgs.toString('hex')}）—— 缓存身份没有看内容`
  );
  assert(
    secondArgs.equals(mutatedWaitForArgs()),
    `重读 args 不是改写后的值：期望 ${mutatedWaitForArgs().toString('hex')}，实得 ${secondArgs.toString('hex')}`
  );
  assert(first.sourceHash !== second.sourceHash, 'sourceHash 未随内容变化 —— 写回前置条件会拿到过期哈希');
  assert(second.sourceHash === sha256Hex(variant), '重读 sourceHash 必须等于改写后内容哈希');

  return {
    scenario: 'A 等长改写 + 原 mtime',
    sizeUnchanged: after.size === before.size,
    mtimeUnchanged: after.mtimeMs === before.mtimeMs,
    firstArgsHex: firstArgs.toString('hex'),
    secondArgsHex: secondArgs.toString('hex'),
    sourceHashChanged: first.sourceHash !== second.sourceHash
  };
}

/**
 * 场景 B —— 同文件并发只解析一次。
 *
 * 判据是计数不是时钟：两个并发请求共 `loads === 1`，且峰值并发装载 === 1
 * （合并的那个等在 Lazy 的 monitor 上，不算在解析中）。
 */
async function cacheCoalescesConcurrentSameFile(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-single-flight');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  // 放大到解析窗口足够宽，两个并发请求才会真的撞上同一个在飞的装载。
  await writeFile(file, largeSyntheticEmevd({ events: 900, instructionsPerEvent: 24, salt: 1 }));

  const [left, right] = await Promise.all([
    probeEmevdCache({ filePath: file, allowedRoots: [dir] }),
    probeEmevdCache({ filePath: file, allowedRoots: [dir] })
  ]);
  const states = [left.cache.state, right.cache.state].sort();
  const maxLoads = Math.max(left.cache.loads, right.cache.loads);
  const peak = Math.max(left.cache.peakConcurrentLoads, right.cache.peakConcurrentLoads);

  assert(
    maxLoads === 1,
    `同文件两个并发请求触发了 ${maxLoads} 次装载，应该只有 1 次（单飞失效）`
  );
  assert(
    peak === 1,
    `同文件峰值并发装载 ${peak}，应为 1 —— 两个请求同时在解析同一份文件`
  );
  assert(
    states[0] === 'coalesced' && states[1] === 'loaded',
    `同文件并发的状态组合应为 [coalesced, loaded]，实得 ${JSON.stringify(states)}`
  );
  assert(
    left.envelope.sourceHash === right.envelope.sourceHash,
    '合并的两个请求必须返回同一份文档'
  );

  return {
    scenario: 'B 同文件并发单飞',
    states,
    loads: maxLoads,
    peakConcurrentLoads: peak
  };
}

/**
 * 场景 C —— 不同文件不在全局锁上串行。
 *
 * 两份**同等规模**的大 fixture 放在同一目录（同一 daemon、同一份静态计数器），
 * 并发读。装载在 Gate 外发生时两个解析窗口重叠，峰值必然到 2；一旦
 * `load()` 被搬回 `lock (Gate)` 内，峰值封顶 1，这条断言立刻红 —— 判据不看时钟。
 *
 * daemon 的 `maxConcurrency` 是 2（runBridge 握手时给的），刚好容得下两个。
 */
async function cacheParallelizesDistinctFiles(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-parallel');
  await mkdir(dir, { recursive: true });
  const left = join(dir, 'left.emevd');
  const right = join(dir, 'right.emevd');
  const leftBytes = largeSyntheticEmevd({ events: 900, instructionsPerEvent: 24, salt: 2 });
  const rightBytes = largeSyntheticEmevd({ events: 900, instructionsPerEvent: 24, salt: 3 });
  assert(leftBytes.length === rightBytes.length, '两份并行 fixture 必须同规模，否则先跑完的那份会让窗口错开');
  assert(!leftBytes.equals(rightBytes), '两份并行 fixture 必须内容不同，否则它们共用一个缓存身份');
  await writeFile(left, leftBytes);
  await writeFile(right, rightBytes);

  const [a, b] = await Promise.all([
    probeEmevdCache({ filePath: left, allowedRoots: [dir] }),
    probeEmevdCache({ filePath: right, allowedRoots: [dir] })
  ]);
  const peak = Math.max(a.cache.peakConcurrentLoads, b.cache.peakConcurrentLoads);
  const maxLoads = Math.max(a.cache.loads, b.cache.loads);

  assert(
    peak === 2,
    `两个不同文件的峰值并发装载为 ${peak}，应为 2 —— 它们在全局锁上串行了`
  );
  assert(maxLoads === 2, `两个不同文件应各装载一次（共 2），实得 ${maxLoads}`);
  assert(a.cache.state === 'loaded' && b.cache.state === 'loaded', '两个不同文件都应是 loaded');
  assert(
    a.envelope.sourceHash !== b.envelope.sourceHash,
    '两份不同 fixture 的 sourceHash 必须不同，否则并发的其实是同一身份'
  );

  return {
    scenario: 'C 跨文件并行',
    peakConcurrentLoads: peak,
    loads: maxLoads,
    states: [a.cache.state, b.cache.state]
  };
}

/**
 * 场景 D —— bypass 无条件重读磁盘，既不命中也不写入陈旧条目。
 *
 * 全串行，所以完全确定，不含任何时序判断。五步：
 *   r1 default → loaded（装载 1 次）
 *   r2 default → hit    （装载仍 1 次，证明缓存确实在生效，后面的判据才有意义）
 *   等长改写 + 还原 mtime
 *   r3 bypass  → bypass（装载 2 次，且**返回改写后的内容**）
 *   r4 default → loaded 而不是 hit（证明 bypass 没把结果写进缓存）
 *   还原基线内容 + 同一 mtime
 *   r5 default → loaded 而不是 hit（证明 bypass 把旧条目逐掉了，没留下能命中的陈旧项）
 */
async function cacheBypassAlwaysRereadsDisk(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-bypass');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const baseline = standardSyntheticEmevd();
  const variant = standardSyntheticEmevdEqualLengthVariant();
  const frozen = new Date('2021-03-04T05:06:07.000Z');
  const pin = async (bytes: Buffer): Promise<void> => {
    await writeFile(file, bytes);
    await utimes(file, frozen, frozen);
  };

  await pin(baseline);
  const r1 = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(r1.cache.state === 'loaded', `r1 应为 loaded，实得 ${r1.cache.state}`);
  assert(r1.cache.loads === 1, `r1 装载数应为 1，实得 ${r1.cache.loads}`);

  const r2 = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(r2.cache.state === 'hit', `r2 应命中缓存，实得 ${r2.cache.state} —— 缓存本身没生效，后面的 bypass 判据会失去意义`);
  assert(r2.cache.loads === 1, `r2 后装载数应仍为 1，实得 ${r2.cache.loads}`);

  await pin(variant);
  const r3 = await probeEmevdCache({ filePath: file, allowedRoots: [dir], cachePolicy: 'bypass' });
  assert(r3.cache.state === 'bypass', `r3 应为 bypass，实得 ${r3.cache.state}`);
  assert(r3.cache.bypasses === 1, `r3 bypass 计数应为 1，实得 ${r3.cache.bypasses}`);
  assert(r3.cache.loads === 2, `r3 应重新装载（累计 2 次），实得 ${r3.cache.loads} —— bypass 没真的重读磁盘`);
  assert(
    r3.envelope.sourceHash === sha256Hex(variant),
    'bypass 必须返回此刻磁盘上的内容哈希，而不是缓存里的旧哈希'
  );

  const r4 = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(r4.cache.state === 'loaded', `r4 应为 loaded，实得 ${r4.cache.state} —— bypass 把结果写进了缓存`);
  assert(r4.cache.loads === 3, `r4 应再装载一次（累计 3 次），实得 ${r4.cache.loads}`);
  assert(r4.envelope.sourceHash === sha256Hex(variant), 'r4 内容应与磁盘一致');

  await pin(baseline);
  const r5 = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(
    r5.cache.state === 'loaded',
    `r5 应为 loaded，实得 ${r5.cache.state} —— 基线内容的旧条目仍留在缓存里（bypass 没逐掉同路径的陈旧项）`
  );
  assert(r5.envelope.sourceHash === sha256Hex(baseline), 'r5 内容应回到基线');

  return {
    scenario: 'D bypass 链',
    states: [r1.cache.state, r2.cache.state, r3.cache.state, r4.cache.state, r5.cache.state],
    loads: [r1.cache.loads, r2.cache.loads, r3.cache.loads, r4.cache.loads, r5.cache.loads],
    bypasses: r5.cache.bypasses
  };
}

/**
 * `largeSyntheticEmevd` 对给定 (event, index, salt) 生成的 args，逐字节复算。
 *
 * 必须与 syntheticEmevdBytes.ts 里的生成式保持一致；不一致会让下面「这条指令属于
 * 哪个版本」的判定恒为「都不属于」，而那会被误读成「混版本」。所以 scenario E 先用
 * 一次干净读把这个复算式本身验过，再拿它去判混版本。
 */
function expectedLargeSyntheticArgs(event: number, index: number, salt: number): string {
  const args = Buffer.alloc(8);
  args.writeInt8(-1 - ((index + salt) % 100), 0);
  args.writeUInt32LE((event * 131 + index * 17 + salt) >>> 0, 4);
  return args.toString('base64');
}

/**
 * 把一份组装好的文档按「每条指令属于哪个 salt」归类。
 *
 * 返回 `{ [salt]: 命中条数, unmatched: 两个 salt 都不匹配的条数 }`。
 */
function classifyBySalt(
  events: ReadonlyArray<{ instructions: ReadonlyArray<{ argsBase64: string }> }>,
  salts: readonly number[]
): { readonly counts: Record<number, number>; readonly unmatched: number } {
  const counts: Record<number, number> = {};
  for (const salt of salts) counts[salt] = 0;
  let unmatched = 0;
  events.forEach((event, eventIndex) => {
    event.instructions.forEach((instruction, index) => {
      const salt = salts.find(
        (candidate) => instruction.argsBase64 === expectedLargeSyntheticArgs(eventIndex, index, candidate)
      );
      if (salt === undefined) unmatched += 1;
      else counts[salt] = (counts[salt] ?? 0) + 1;
    });
  });
  return { counts, unmatched };
}

/**
 * 场景 E —— 分页读取期间源文件被改写，整份文档不得混版本。
 *
 * 这是本轮修的核心缺陷：改造前只有第一页的 `sourceHash` 被采用（既作为返回值上报，
 * 也作为写回的提交前置条件），后续页从不比对。于是在一次多页读取中途把 A 换成 B，
 * 会得到 `ok: true` + **A 的哈希** + 内容是 A 与 B 的混合体。混合文档随后被当成
 * 「A 的内容」参与写回校验，而校验看的是哈希，哈希是对的。
 *
 * ── 判据 ──
 *
 * 核心判据：**上报的 sourceHash 必须与文档里真实的内容一致**。混版本时二者必然背离，
 * 这与漂移发生在第几页、重试了几次、机器忙闲都无关。
 *
 * ── 为什么不能只换一次 ──
 *
 * 第一版这个用例是「起读后换一次 A→B」，并拿 `sourceHash === hash(B)` 当覆盖前提。
 * 它**实测是假门禁**：停掉跨页校验后照样全绿。原因是 `writeFile` 比第 0 页的往返
 * （要付 daemon 拉起 + 解析 + VerifyRoundTrip）更快，改写在第 0 页读到内容之前就落盘了,
 * 200 页全都一致地读到 B —— 漂移窗口根本没打开。而 `sourceHash === hash(B)` 只能证明
 * 改写落在**整次读取**的窗口内，证明不了它落在**页与页之间**。
 *
 * 现在改成读取期间持续交替改写，并把覆盖前提换成直接观测
 * `EMEVD_SOURCE_CHANGED_RETRY` 诊断 —— 那条诊断只在校验真的拦下一次漂移时才出现，
 * 不是从时序反推的。
 */
async function pagedReadRejectsMidReadRewrite(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'mid-read-rewrite');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const saltA = 11;
  const saltB = 12;
  // 40 事件 × 10 指令 = 400 条；pageSize 2 ⇒ 200 页。页数越多，改写落在页间的窗口
  // 越宽。两份 salt 不同、长度相同：长度不同会让「内容变了」多一条可从 envelope 的
  // instructionTotal 看出来的旁证，反而弱化「必须靠哈希发现」这个判据。
  const bytesA = largeSyntheticEmevd({ events: 40, instructionsPerEvent: 10, salt: saltA });
  const bytesB = largeSyntheticEmevd({ events: 40, instructionsPerEvent: 10, salt: saltB });
  assert(bytesA.length === bytesB.length, '两份 fixture 必须等长');
  assert(!bytesA.equals(bytesB), '两份 fixture 必须内容不同');
  const hashA = sha256Hex(bytesA);
  const hashB = sha256Hex(bytesB);
  const registry = createSekiroFixtureEmedf();
  const read = async (): Promise<Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>>> =>
    readFullEmevdDocumentViaBridge({
      filePath: file,
      allowedRoots: [dir],
      resourceUri: 'file://event/common.emevd',
      registry,
      pageSize: 2,
      // 关掉 session：这条用例专门覆盖「会话过期后退回逐页读」时的指纹校验。
      // production 默认带 session，后续页不再重读，页间漂移窗口关闭。
      useDocumentSession: false,
      // bypass 让每页都真的重读磁盘，改写窗口最宽。default 下缓存以内容哈希为键，
      // 同样会跨页混版本，这里选窗口最宽的那个策略。
      cachePolicy: 'bypass'
    });

  // 第 0 步：干净读一遍纯 A，先把 expectedLargeSyntheticArgs 这个复算式验过。
  // 复算式若与生成式不一致，下面的混版本判定会全部落进 unmatched，
  // 那会被误读成「混版本」——先证明它对得上。
  await writeFile(file, bytesA);
  const baseline = await read();
  assert(baseline.ok && baseline.document, `基线读取失败：${JSON.stringify(baseline.diagnostics)}`);
  assert(baseline.sourceHash === hashA, `基线应上报 A 的哈希，实得 ${baseline.sourceHash}`);
  const baselineClass = classifyBySalt(baseline.document.events, [saltA, saltB]);
  assert(
    baselineClass.unmatched === 0 && baselineClass.counts[saltA] === 400 && baselineClass.counts[saltB] === 0,
    'args 复算式与 largeSyntheticEmevd 的生成式不一致：纯 A 的基线读应 400 条全部归到 salt A，'
      + `实得 ${JSON.stringify(baselineClass)}`
  );

  // 两轮，因为两条路径的判据不同，而单轮只能走进一条：
  //   round 1 —— 全程持续改写：文件一直读不到一致版本，正确行为是重试用尽后报错，
  //              永远不交出混版本文档。此时没有 document，内容判据无从执行。
  //   round 2 —— 只改写头几次就停手：读取应当重试后恢复，交出一份**一致**的文档。
  //              这一轮才真正执行「上报哈希必须与内容一致」这条核心判据。
  // 只留 round 1 会让内容判据变成永远走不到的死代码。
  const rounds = [
    await midReadRewriteRound({ label: 'round 1 全程改写', maxFlips: Number.POSITIVE_INFINITY }),
    await midReadRewriteRound({ label: 'round 2 改写后停手', maxFlips: 2 })
  ];

  return { scenario: 'E 读取期间改写', rounds };

  async function midReadRewriteRound(options: {
    readonly label: string;
    readonly maxFlips: number;
  }): Promise<Record<string, unknown>> {
    // 每轮都从纯 A 起步：上一轮停手时磁盘上留的是 A 还是 B 不确定，不重置的话
    // round 2 的「停手后稳定在哪个版本」就成了随机量。
    await writeFile(file, bytesA);
    let flipping = true;
    let flips = 0;
    let renameFailures = 0;
    // 改写必须**原子**：直接 writeFile 会先把文件截成 0 字节再写，读取正好落在那个瞬间
    // 就会拿到「文件大小 0 超出安全读取范围」—— 那是撕裂写，不是本用例要测的混版本，
    // 实测会把第 3 次尝试打成一个无关的失败。temp + rename 让磁盘上任一瞬间都是完整的
    // A 或完整的 B，正好是「能造成混版本」的那种对手，且不引入别的失败模式。
    const flipper = (async (): Promise<void> => {
      const staging = `${file}.flip`;
      for (let i = 0; flipping && flips < options.maxFlips; i += 1) {
        await writeFile(staging, i % 2 === 0 ? bytesB : bytesA);
        try {
          await rename(staging, file);
          flips += 1;
        } catch {
          // Bridge 用 FileShare.ReadWrite 打开文件，那不含 FILE_SHARE_DELETE，
          // 所以它持有句柄的那些瞬间 rename 会被拒。这是预期的，跳过重试即可。
          renameFailures += 1;
        }
      }
      await rm(staging, { force: true });
    })();
    let result: Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>>;
    try {
      result = await read();
    } finally {
      // 必须无条件停掉写手并等它退出：读取抛异常时留一个还在死循环写盘的 Promise，
      // 会让后面所有场景都跑在被持续改写的目录上。
      flipping = false;
      await flipper;
    }

    const retried = result.diagnostics.filter((d) => d.code === 'EMEVD_SOURCE_CHANGED_RETRY');
    const exhausted = result.diagnostics.some((d) => d.code === 'EMEVD_SOURCE_CHANGED_DURING_READ');
    // 全程改写必须真正拦到漂移；停手轮次只要文档自洽（哈希与内容一致）即可，
    // 两三次改写可能全部落在第 0 页之前，不强求 RETRY。
    if (Number.isFinite(options.maxFlips) === false) {
      assert(
        retried.length > 0,
        `${options.label}：整轮读取一次漂移都没拦下，本用例没有覆盖到跨页混版本`
          + ` —— 停掉跨页校验它也会绿。（改写了 ${flips} 次，页数 ${result.pageCount}，诊断：`
          + `${JSON.stringify(result.diagnostics.map((d) => d.code))}）`
          + '请增大 events/instructionsPerEvent 或减小 pageSize，把页间窗口拉宽。'
      );
    }

    if (exhausted) {
      // 重试次数用尽也是正确行为：文件一直在被写，读不到一致版本就该报错而不是
      // 交出一份混版本文档。此时没有 document 可查，判据到此为止。
      assert(!result.ok, `${options.label}：重试用尽时必须是失败结果，不能是 ok`);
      assert(result.document === undefined, `${options.label}：重试用尽时不得交出文档`);
      return {
        round: options.label,
        outcome: '重试用尽（正确）',
        retries: retried.length,
        flips,
        renameFailures
      };
    }

    assert(
      result.ok && result.document,
      `${options.label}：读取既没成功也没报「源文件被改写」：${JSON.stringify(result.diagnostics)}`
    );
    const classified = classifyBySalt(result.document.events, [saltA, saltB]);
    assert(
      classified.unmatched === 0,
      `${options.label}：有 ${classified.unmatched} 条指令两个 salt 都不匹配，`
        + `fixture 或复算式对不上：${JSON.stringify(classified)}`
    );
    // 核心判据：上报的哈希必须与文档里真实的内容一致。
    const reportedSalt = result.sourceHash === hashA ? saltA : result.sourceHash === hashB ? saltB : null;
    assert(
      reportedSalt !== null,
      `${options.label}：上报的 sourceHash ${result.sourceHash} 既不是 A（${hashA}）也不是 B（${hashB}）`
    );
    const foreign = reportedSalt === saltA ? classified.counts[saltB] : classified.counts[saltA];
    assert(
      foreign === 0,
      `${options.label}：上报 ${reportedSalt === saltA ? 'A' : 'B'} 的哈希，`
        + `但文档里混进了 ${foreign} 条另一个版本的指令（${JSON.stringify(classified)}）`
        + ' —— 分页读取跨版本混装，上报的哈希与内容不符。'
    );

    return {
      round: options.label,
      outcome: '重读到一致版本',
      reportedHash: reportedSalt === saltB ? 'B' : 'A',
      retries: retried.length,
      flips,
      renameFailures,
      classified,
      pageCount: result.pageCount
    };
  }
}

/**
 * 场景 E2 —— production session 路径：分页期间改写磁盘，只能得到完整 A 或完整 B。
 * 后续页从同一快照切片，不会出现 EMEVD_SOURCE_CHANGED_RETRY，也不得混版本。
 */
async function pagedReadWithSessionStaysConsistent(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'session-mid-read');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const saltA = 21;
  const saltB = 22;
  const bytesA = largeSyntheticEmevd({ events: 40, instructionsPerEvent: 10, salt: saltA });
  const bytesB = largeSyntheticEmevd({ events: 40, instructionsPerEvent: 10, salt: saltB });
  const hashA = sha256Hex(bytesA);
  const hashB = sha256Hex(bytesB);
  const registry = createSekiroFixtureEmedf();
  await writeFile(file, bytesA);

  let flipping = true;
  let flips = 0;
  const flipper = (async (): Promise<void> => {
    const staging = `${file}.flip`;
    for (let i = 0; flipping; i += 1) {
      await writeFile(staging, i % 2 === 0 ? bytesB : bytesA);
      try {
        await rename(staging, file);
        flips += 1;
      } catch {
        // ignore share violations
      }
    }
    await rm(staging, { force: true });
  })();

  let result: Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>>;
  try {
    result = await readFullEmevdDocumentViaBridge({
      filePath: file,
      allowedRoots: [dir],
      resourceUri: 'file://event/common.emevd',
      registry,
      pageSize: 50,
      cachePolicy: 'bypass'
    });
  } finally {
    flipping = false;
    await flipper;
  }

  assert(result.ok && result.document, `session 路径读取失败：${JSON.stringify(result.diagnostics)}`);
  assert(
    !result.diagnostics.some((d) => d.code === 'EMEVD_SOURCE_CHANGED_RETRY'),
    'session 路径不应出现跨页指纹重试：后续页不得重读磁盘'
  );
  const classified = classifyBySalt(result.document.events, [saltA, saltB]);
  assert(classified.unmatched === 0, `session 路径有无法归类的指令：${JSON.stringify(classified)}`);
  const reportedSalt = result.sourceHash === hashA ? saltA : result.sourceHash === hashB ? saltB : null;
  assert(reportedSalt !== null, `session 路径上报的哈希既不是 A 也不是 B：${result.sourceHash}`);
  const foreign = reportedSalt === saltA ? classified.counts[saltB] : classified.counts[saltA];
  assert(foreign === 0, `session 路径混进了 ${foreign} 条另一版本指令`);
  return {
    scenario: 'E2 session 分页同快照',
    reportedHash: reportedSalt === saltB ? 'B' : 'A',
    flips,
    classified,
    pageCount: result.pageCount
  };
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`${label}：等待 ${timeoutMs}ms 仍未满足`);
}

async function fileContains(path: string, snippet: string): Promise<boolean> {
  try {
    await access(path);
    const text = await readFile(path, 'utf8');
    return text.includes(snippet);
  } catch {
    return false;
  }
}

function enableCacheTestHooks(): void {
  process.env.SOULFORGE_EMEVD_CACHE_TEST_HOOKS = '1';
}

/**
 * 场景 F —— 哈希与解析必须消费同一份已读取字节。
 * 快照读完后把磁盘改成 B，返回值必须仍是 A；第二次常规读才是 B。
 */
async function cacheUsesSameSnapshotBytes(root: string): Promise<Record<string, unknown>> {
  enableCacheTestHooks();
  const dir = join(root, 'cache-same-snapshot');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const rewrite = join(dir, 'rewrite.emevd');
  const baseline = standardSyntheticEmevd();
  const variant = standardSyntheticEmevdEqualLengthVariant();
  await writeFile(file, baseline);
  await writeFile(rewrite, variant);
  const first = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    testRewriteAfterRead: rewrite
  });
  assert(first.envelope.sourceHash === sha256Hex(baseline),
    `快照后改写磁盘仍应返回 A 的哈希，实得 ${first.envelope.sourceHash}`);
  const firstArgs = first.envelope.instructionsSample?.[0]?.argsBase64;
  assert(
    firstArgs === Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).toString('base64'),
    '快照解析必须仍是 A 的第一条指令'
  );
  const second = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(second.envelope.sourceHash === sha256Hex(variant),
    `第二次常规读必须看见磁盘上的 B，实得 ${second.envelope.sourceHash}`);
  assert(
    second.envelope.instructionsSample?.[0]?.argsBase64 === mutatedWaitForArgs().toString('base64'),
    '第二次必须读到 B 的指令'
  );
  assert(second.cache.state === 'loaded', `第二次应为 loaded（新哈希），实得 ${second.cache.state}`);
  return {
    scenario: 'F 同快照字节',
    firstHash: first.envelope.sourceHash,
    secondHash: second.envelope.sourceHash,
    firstState: first.cache.state,
    secondState: second.cache.state
  };
}

/**
 * 场景 G —— 单条超过 96MiB 估算不得进长期缓存，第二次不得 hit。
 */
async function cacheRejectsOversizeEntry(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-oversize');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  // 空 args 的 850k 指令：args 银行为 0，躲开 1MiB 上限；估算 ≈ source + 88*I > 96MiB。
  const specs = [];
  for (let event = 0; event < 2000; event += 1) {
    const instructions = [];
    for (let i = 0; i < 425; i += 1) {
      instructions.push({ bank: 9999, id: 1, args: Buffer.alloc(0) });
    }
    specs.push({ id: 1000 + event, restBehavior: 0, instructions });
  }
  const bytes = buildSyntheticEmevd(specs);
  await writeFile(file, bytes);
  const first = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    timeoutMs: 300_000
  });
  assert(first.cache.state === 'oversize', `首读应为 oversize，实得 ${first.cache.state}`);
  assert(first.cache.oversized >= 1, `oversized 计数应 >= 1，实得 ${first.cache.oversized}`);
  const second = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    timeoutMs: 300_000
  });
  assert(second.cache.state !== 'hit', `超预算条目第二次不得 hit，实得 ${second.cache.state}`);
  assert(second.cache.state === 'oversize' || second.cache.state === 'loaded',
    `第二次应为 oversize/loaded，实得 ${second.cache.state}`);
  const token = first.envelope.documentSession;
  assert(typeof token === 'string' && token.length >= 16, '超预算仍须签发可保留的 session，不能返回假 token');
  assert(
    second.envelope.documentSession === token,
    '同一超预算文件再次装载必须复用 session，不能另签 token 把上一页的会话挤掉'
  );
  const page1 = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    pageSize: 50,
    instructionPage: 1,
    documentSession: token,
    timeoutMs: 300_000
  });
  assert(page1.cache.state === 'session', `超预算后续页必须走 session，实得 ${page1.cache.state}`);
  assert(page1.cache.loads === second.cache.loads, '超预算 session 不得再解析');
  return {
    scenario: 'G 超 96MiB 不缓存',
    first: first.cache.state,
    second: second.cache.state,
    oversized: second.cache.oversized,
    bytes: bytes.length,
    sessionPage: page1.cache.state
  };
}

/**
 * 场景 H —— owner 取消、waiter 继续；waiter 取消、owner 继续；双方都取消则停工且不入缓存。
 */
async function cacheCancelWaiters(root: string): Promise<Record<string, unknown>> {
  enableCacheTestHooks();
  const dir = join(root, 'cache-cancel');
  await mkdir(dir, { recursive: true });

  const ownerContinues = await runCancelMatrix(dir, 'owner-cancel');
  const waiterContinues = await runCancelMatrix(dir, 'waiter-cancel');
  const bothCancel = await runCancelMatrix(dir, 'both-cancel');
  return { scenario: 'H 取消与 waiter', ownerContinues, waiterContinues, bothCancel };
}

async function runCancelMatrix(
  dir: string,
  mode: 'owner-cancel' | 'waiter-cancel' | 'both-cancel'
): Promise<Record<string, unknown>> {
  const file = join(dir, `${mode}.emevd`);
  await writeFile(file, largeSyntheticEmevd({
    events: 80,
    instructionsPerEvent: 20,
    salt: mode === 'owner-cancel' ? 4 : mode === 'waiter-cancel' ? 5 : 6
  }));
  const gate = join(dir, `${mode}.gate`);
  const signal = join(dir, `${mode}.signal`);
  const completed = join(dir, `${mode}.completed`);
  await rm(gate, { force: true });
  await rm(signal, { force: true });
  await rm(completed, { force: true });

  const ownerCtl = new AbortController();
  const waiterCtl = new AbortController();
  const ownerP = probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    testHoldUntilFile: gate,
    testSignalFile: signal,
    testCompletedFile: completed,
    signal: ownerCtl.signal,
    timeoutMs: 60_000
  });
  await waitUntil(`${mode} owner 已进入 hold`, () => fileContains(signal, 'held'));
  const waiterP = probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    testHoldUntilFile: gate,
    testSignalFile: signal,
    testCompletedFile: completed,
    signal: waiterCtl.signal,
    timeoutMs: 60_000
  });
  await waitUntil(`${mode} waiter 已加入`, () => fileContains(signal, 'waiter'));

  if (mode === 'owner-cancel') ownerCtl.abort();
  if (mode === 'waiter-cancel') waiterCtl.abort();
  if (mode === 'both-cancel') {
    ownerCtl.abort();
    waiterCtl.abort();
  }
  await writeFile(gate, 'go');

  let owner: CacheProbe;
  let waiter: CacheProbe;
  try {
    [owner, waiter] = await Promise.all([ownerP, waiterP]);
  } finally {
    ownerCtl.abort();
    waiterCtl.abort();
  }

  if (mode === 'owner-cancel') {
    assert(owner.cancelled === true, 'owner 取消后自身必须 cancelled');
    assert(waiter.cancelled !== true && waiter.envelope.sourceHash !== undefined,
      'owner 取消时 waiter 必须拿到完整结果');
    const again = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
    assert(again.cache.state === 'hit', `waiter 完成后应可 hit，实得 ${again.cache.state}`);
    return { mode, waiterState: waiter.cache.state, again: again.cache.state };
  }

  if (mode === 'waiter-cancel') {
    assert(waiter.cancelled === true, 'waiter 取消后自身必须 cancelled');
    assert(owner.cancelled !== true && owner.envelope.sourceHash !== undefined,
      'waiter 取消时 owner 必须继续成功');
    const again = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
    assert(again.cache.state === 'hit', `owner 完成后应可 hit，实得 ${again.cache.state}`);
    return { mode, ownerState: owner.cache.state, again: again.cache.state };
  }

  assert(owner.cancelled === true && waiter.cancelled === true, '双方取消后两个请求都必须 cancelled');
  try {
    await access(completed);
    throw new Error('双方取消后不得写出 testCompletedFile —— 底层装载没有停');
  } catch (error) {
    if ((error as Error).message.includes('不得写出')) throw error;
  }
  const again = await probeEmevdCache({ filePath: file, allowedRoots: [dir] });
  assert(again.cache.state !== 'hit', `双方取消后不得留下可 hit 的条目，实得 ${again.cache.state}`);
  assert(again.cache.cancelledLoads >= 1, `cancelledLoads 应增加，实得 ${again.cache.cancelledLoads}`);
  return {
    mode,
    ownerCancelled: owner.cancelled === true,
    waiterCancelled: waiter.cancelled === true,
    again: again.cache.state,
    cancelledLoads: again.cache.cancelledLoads
  };
}

/**
 * 场景 I —— bypass 多页走 session：只解析一次，后续页 state=session。
 */
async function bypassPagesShareSession(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cache-session');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'common.emevd');
  const bytes = largeSyntheticEmevd({ events: 40, instructionsPerEvent: 10, salt: 5 });
  await writeFile(file, bytes);
  const page0 = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    cachePolicy: 'bypass',
    pageSize: 50,
    instructionPage: 0
  });
  assert(page0.cache.state === 'bypass', `第 0 页应为 bypass，实得 ${page0.cache.state}`);
  const token = page0.envelope.documentSession;
  assert(typeof token === 'string' && token.length >= 16, 'bypass 必须签发 documentSession');
  const page1 = await probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    cachePolicy: 'bypass',
    pageSize: 50,
    instructionPage: 1,
    documentSession: token
  });
  assert(page1.cache.state === 'session', `后续页应走 session，实得 ${page1.cache.state}`);
  assert(page1.cache.loads === page0.cache.loads, 'session 页不得再解析');
  assert(page1.envelope.sourceHash === page0.envelope.sourceHash, 'session 页必须与第 0 页同一快照');
  return {
    scenario: 'I bypass session 分页',
    page0: page0.cache.state,
    page1: page1.cache.state,
    loads: page1.cache.loads,
    sessionHits: page1.cache.sessionHits
  };
}

async function sessionTokenBoundToFile(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'session-bind');
  await mkdir(dir, { recursive: true });
  const fileA = join(dir, 'common.emevd');
  const fileB = join(dir, 'common_func.emevd');
  await writeFile(fileA, largeSyntheticEmevd({ events: 8, instructionsPerEvent: 4, salt: 1 }));
  await writeFile(fileB, largeSyntheticEmevd({ events: 12, instructionsPerEvent: 4, salt: 2 }));
  const first = await probeEmevdCache({ filePath: fileA, allowedRoots: [dir], pageSize: 8 });
  const token = first.envelope.documentSession;
  assert(typeof token === 'string', '必须签发 session');
  const crossed = await runBridge<EmevdEnvelopePage>({
    command: 'read-emevd-document',
    filePath: fileB,
    allowedRoots: [dir],
    timeoutMs: 60_000,
    commandOptions: {
      instructionPage: 0,
      instructionPageSize: 8,
      documentSession: token
    }
  });
  assert(
    crossed.diagnostics.some((d) => d.code === 'EMEVD_DOCUMENT_SESSION_MISMATCH'),
    `跨文件复用 token 必须失败关闭，诊断：${JSON.stringify(crossed.diagnostics.map((d) => d.code))}`
  );
  assert(crossed.parseStatus === 'failed', '跨文件 session 不得 ok:true 返回错误文档');
  return { scenario: 'J session 绑定文件', mismatch: true };
}

async function cancelWithoutHoldHook(root: string): Promise<Record<string, unknown>> {
  const dir = join(root, 'cancel-no-hold');
  await mkdir(dir, { recursive: true });
  const warmup = join(dir, 'warmup.emevd');
  const file = join(dir, 'common.emevd');
  await writeFile(warmup, standardSyntheticEmevd());
  // 80k 指令 + VerifyRoundTrip，无 hold 时也必须宽过「发请求 → 取消帧到达」窗口。
  await writeFile(file, largeSyntheticEmevd({ events: 400, instructionsPerEvent: 200, salt: 9 }));
  // 先热 daemon，避免 abort 只取消到进程启动、从未进入 Task.Run 解析。
  await probeEmevdCache({ filePath: warmup, allowedRoots: [dir], timeoutMs: 60_000 });
  const controller = new AbortController();
  const pending = probeEmevdCache({
    filePath: file,
    allowedRoots: [dir],
    signal: controller.signal,
    timeoutMs: 180_000
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  controller.abort();
  const result = await pending;
  assert(result.cancelled === true, '无 hold 钩子时大文档取消必须生效，不能等解析跑完');
  const again = await probeEmevdCache({ filePath: file, allowedRoots: [dir], timeoutMs: 180_000 });
  assert(again.cache.state !== 'hit', `无 hold 取消后不得留下可 hit 的条目，实得 ${again.cache.state}`);
  assert(
    again.cache.cancelledLoads >= 1,
    `无 hold 取消必须真正中止共享装载（cancelledLoads>=1），实得 ${again.cache.cancelledLoads}`
  );
  return { scenario: 'K 无 hold 取消', cancelledLoads: again.cache.cancelledLoads, again: again.cache.state };
}

async function bridgeDocumentCacheRegressions(root: string): Promise<void> {
  // 每个场景独立目录：runBridge 的 pool key 含 allowedRoots，不同目录 ⇒ 不同
  // daemon 进程 ⇒ 各自归零的静态计数器。共用目录会让前一个场景的计数漏进来。
  const scenarios = [
    await cacheIdentitySurvivesEqualLengthRewrite(root),
    await cacheCoalescesConcurrentSameFile(root),
    await cacheParallelizesDistinctFiles(root),
    await cacheBypassAlwaysRereadsDisk(root),
    await pagedReadRejectsMidReadRewrite(root),
    await pagedReadWithSessionStaysConsistent(root),
    await cacheUsesSameSnapshotBytes(root),
    await cacheCancelWaiters(root),
    await bypassPagesShareSession(root),
    await sessionTokenBoundToFile(root),
    await cancelWithoutHoldHook(root),
    await cacheRejectsOversizeEntry(root)
  ];
  console.log(JSON.stringify({
    ok: true,
    message: 'Bridge EMEVD 文档缓存回归通过'
      + '（内容身份 / 同文件单飞 / 跨文件并行 / bypass 重读 / 读取期间改写不混版本'
      + ' / 同快照字节 / 取消 waiter / session 分页 / 超预算不缓存）',
    scenarios
  }, null, 2));
}

async function syntheticAssembly(root: string): Promise<void> {
  const staging = join(root, 'synthetic');
  await mkdir(staging, { recursive: true });
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, standardSyntheticEmevd());

  const registry = createSekiroFixtureEmedf();
  const result = await readFullEmevdDocumentViaBridge({
    filePath: emevdPath,
    allowedRoots: [staging],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-synthetic',
    pageSize: 2
  });
  assert(result.ok, `synthetic assembly failed: ${JSON.stringify(result.diagnostics)}`);
  assert(result.pageCount === 2, `expected 2 pages for 3 instructions at pageSize 2, got ${result.pageCount}`);
  assert(result.instructionTotal === 3, `instructionTotal ${result.instructionTotal}`);
  assert(result.sourceFormat === 'emevd', `raw .emevd must read as sourceFormat=emevd, got ${result.sourceFormat}`);
  assert(result.document!.events.length === 2, 'synthetic events');
  const first = result.document!.events[0]!;
  assert(first.instructions.length === 3, `first event instructions ${first.instructions.length}`);
  assert(result.document!.events[1]!.instructions.length === 0, 'empty event must stay empty');
  assert(
    result.document!.events.every((event) => event.anchor === undefined)
      && result.document!.events.every((event) => event.instructions.every((item) => item.anchor === undefined)),
    '打开路径不得同步计算稳定身份'
  );
  assert(expectedInstructionTotal(result.document!.events) === 3, 'event slice total');
  const byBank = new Map(first.instructions.map((i) => [i.bank, i]));
  assert(byBank.get(1000)?.unknown === false, 'WaitFor must be typed under fixture registry');
  assert(byBank.get(2000)?.unknown === false, 'IfConditionGroup must be typed under fixture registry');
  assert(byBank.get(9999)?.unknown === true, 'unknown bank 9999 must be classified unknown');

  // Bounded outline: summary rows only, never instruction bodies.
  const outline = result.outline;
  assert(outline !== undefined, 'outline missing from read result');
  assert(outline.schemaVersion === 1, 'outline schemaVersion');
  assert(outline.resourceUri === 'file://event/common.emevd', 'outline resourceUri');
  assert(outline.eventCount === 2 && outline.events.length === 2, 'outline event rows');
  assert(outline.truncated === false, 'synthetic outline must not be truncated');
  assert(outline.instructionTotal === 3, 'outline instruction total');
  const outlineFirst = outline.events[0]!;
  assert(outlineFirst.eventUri === 'file://event/common.emevd#event/50', 'outline eventUri');
  assert(outlineFirst.eventId === 50, 'outline eventId');
  assert(outlineFirst.instructionCount === 3, 'outline instructionCount');
  assert(outlineFirst.unknownCount === 1, 'outline unknownCount (bank 9999)');
  assert(!('instructions' in outlineFirst), 'outline must not carry instruction bodies');
  assert(!('argsBase64' in outlineFirst), 'outline must not carry arg bytes');
  assert(outline.events[1]!.instructionCount === 0, 'empty event outline count');

  // Bounded projection 走写链：需要稳定锚。打开路径故意不 attach，这里单独挂。
  const identified = attachEmevdStableIdentity(result.document!);
  const fullProjection = renderEmevdPatchDslBounded(identified, registry, undefined);
  assert(fullProjection.truncated === false, 'synthetic full projection must not truncate');
  assert(fullProjection.text.includes('// read-only'), 'unknown instruction must render as read-only comment');
  assert(fullProjection.text.includes('bank=9999 id=1'), 'read-only comment must keep bank/id');
  assert(fullProjection.text.includes(`resource "file://event/common.emevd"`), 'projection resource line');
  assertDesensitized(fullProjection.text, emevdPath, 'full synthetic projection');

  // Partial projection: a small limit truncates at an event-block boundary.
  const partial = renderEmevdPatchDslBounded(identified, registry, 5);
  assert(partial.truncated === true, 'bounded projection must truncate under a small limit');
  const partialContent = partial.text
    .replace(/\/\/ EMEVD_DSL_TEMPLATE_TRUNCATED.*$/m, '')
    .replace(/\/\/ 模板仅作为.*$/m, '')
    .trimEnd();
  assert(partialContent.endsWith('}'), 'truncated projection must stop at an event-block boundary');
  assert(partial.text.includes('EMEVD_DSL_TEMPLATE_TRUNCATED'), 'truncation marker missing');
  assert(partial.shownLines < partial.totalLines, 'shownLines must be below totalLines');

  // sanitizeResourceUri: absolute local paths are reduced to desensitized form.
  const absoluteUri = `file:///${emevdPath.replace(/\\/g, '/')}`;
  const sanitized = sanitizeResourceUri(absoluteUri);
  assert(!/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(sanitized), `sanitizeResourceUri leaked drive letter: ${sanitized}`);
  assert(sanitized.startsWith('file://'), `sanitizeResourceUri must keep file:// prefix: ${sanitized}`);

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 完整文档分页组装合成断言通过（含 outline + 投影脱敏）',
    pageCount: result.pageCount,
    instructionTotal: result.instructionTotal,
    eventSlices: result.document!.events.map((e) => e.instructions.length),
    outlineRows: outline.events.length,
    outlineUnknownCounts: outline.events.map((e) => e.unknownCount),
    projection: { truncated: partial.truncated, shownLines: partial.shownLines, totalLines: partial.totalLines }
  }));
}

async function realCorpusAssembly(root: string, sourceDcx: string): Promise<void> {
  const staging = join(root, 'native');
  await mkdir(staging, { recursive: true });
  const dcxBytes = await readFile(sourceDcx);
  const payload = decompressDfltDcx(dcxBytes);

  const registry = createSekiroFixtureEmedf();
  // Production path: pass the .dcx outer resource directly; Bridge unwraps DFLT
  // natively (negative architecture — no TS DCX parser, no temp .emevd target).
  const dcxResult = await readFullEmevdDocumentViaBridge({
    filePath: sourceDcx,
    allowedRoots: [staging, dirname(sourceDcx)],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-native',
    pageSize: 1000
  });
  assert(dcxResult.ok, `dcx direct assembly failed: ${JSON.stringify(dcxResult.diagnostics)}`);
  assert(dcxResult.sourceFormat === 'dcx', `dcx input must read as sourceFormat=dcx, got ${dcxResult.sourceFormat}`);
  assert(dcxResult.outerFileHash === hashOf(dcxBytes), 'outerFileHash must hash the .dcx file bytes as opened');
  assert(dcxResult.sourceHash === hashOf(payload), 'Bridge native payload hash must equal TypeScript decompressed payload hash');
  assert(dcxResult.instructionTotal === 33_266, `dcx instruction total ${dcxResult.instructionTotal}`);
  const dcxDocument = dcxResult.document!;
  assert(expectedInstructionTotal(dcxDocument.events) === 33_266, 'dcx event slice total mismatch');
  assert(
    dcxDocument.events.every((event) => event.anchor === undefined)
      && dcxDocument.events.every((event) => event.instructions.every((item) => item.anchor === undefined)),
    '真实 corpus 打开路径不得同步计算稳定身份'
  );

  // Bounded outline over the real corpus.
  const outline = dcxResult.outline;
  assert(outline !== undefined, 'dcx outline missing');
  assert(outline.eventCount === 1730, 'outline eventCount');
  assert(outline.instructionTotal === 33_266, 'outline instructionTotal');
  assert(outline.truncated === false, `outline must fit under limit ${outline.limit} for 1730 events`);
  assert(outline.events.length === 1730, 'outline row count');
  const firstOutline = outline.events[0]!;
  assert(firstOutline.eventUri.startsWith('file://event/common.emevd#event/'), 'outline eventUri must be resource-relative');
  assert(firstOutline.instructionCount >= 0, 'outline instructionCount');
  assert(firstOutline.unknownCount >= 0, 'outline unknownCount');
  assert(!('instructions' in firstOutline) && !('argsBase64' in firstOutline), 'outline rows must be summary-only');
  // Explicit small limit truncates the outline.
  const capped = buildEmevdDocumentOutline(dcxDocument, { limit: 5 });
  assert(capped.truncated === true && capped.events.length === 5, 'capped outline must truncate to limit');

  // Unknown instructions survive classification under the fixture registry.
  const unknownCount = dcxDocument.events.reduce(
    (sum, e) => sum + e.instructions.filter((i) => i.unknown).length,
    0
  );
  assert(unknownCount > 0, 'real corpus must contain unknown instructions under the fixture registry');

  // Partial projection: bounded DSL over the real corpus truncates at an
  // event-block boundary and keeps unknown instructions as read-only comments.
  const bounded = renderEmevdPatchDslBounded(attachEmevdStableIdentity(dcxDocument), registry, 2000);
  assert(bounded.truncated === true, 'real corpus projection must truncate under a 2000-line limit');
  assert(bounded.totalLines > bounded.shownLines, 'real corpus projection must show only a bounded prefix');
  const boundedContent = bounded.text
    .replace(/\/\/ EMEVD_DSL_TEMPLATE_TRUNCATED.*$/m, '')
    .replace(/\/\/ 模板仅作为.*$/m, '')
    .trimEnd();
  assert(boundedContent.endsWith('}'), 'real corpus truncated projection must stop at event-block boundary');
  assert(bounded.text.includes('EMEVD_DSL_TEMPLATE_TRUNCATED'), 'real corpus truncation marker missing');
  assert(bounded.text.includes('// read-only'), 'real corpus projection must keep unknown instructions read-only');

  // 绝对路径脱敏: the absolute local .dcx path must never leak into the
  // projection or the outline.
  assertDesensitized(bounded.text, sourceDcx, 'real corpus DSL projection');
  assertDesensitized(JSON.stringify(outline), sourceDcx, 'real corpus outline');

  // Raw .emevd read path still works.
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, payload);
  const assemblyWatch = measureEventLoopGap(50);
  const assemblyStart = performance.now();
  const result = await readFullEmevdDocumentViaBridge({
    filePath: emevdPath,
    allowedRoots: [staging],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-native',
    pageSize: 1000
  });
  const assemblyMs = performance.now() - assemblyStart;
  const assemblyGap = assemblyWatch.stop();
  assert(result.ok, `real assembly failed: ${JSON.stringify(result.diagnostics)}`);
  assert(result.instructionTotal === 33_266, `native instruction total ${result.instructionTotal}`);
  assert(result.pageCount === 34, `expected 34 pages at pageSize 1000, got ${result.pageCount}`);
  assert(result.document!.events.length === 1730, 'native events');
  assert(expectedInstructionTotal(result.document!.events) === 33_266, 'event slice total mismatch');

  const longFrames = await measureRealCommonLongFrames(result.document!);

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 真实 corpus 完整文档原生 DCX 打开 + 分页组装 + 有界投影/outline 通过',
    events: result.document!.events.length,
    instructionTotal: result.instructionTotal,
    pageCount: result.pageCount,
    sourceFormat: dcxResult.sourceFormat,
    outerFileHashMatchesDcx: dcxResult.outerFileHash === hashOf(dcxBytes),
    bridgePayloadHashMatchesTsDecompress: dcxResult.sourceHash === hashOf(payload),
    unknownUnderFixtureRegistry: unknownCount,
    outline: { rows: outline.events.length, capped: capped.events.length },
    projection: { truncated: bounded.truncated, shownLines: bounded.shownLines, totalLines: bounded.totalLines },
    longFrames: {
      ...longFrames,
      assemblyMs: Number(assemblyMs.toFixed(1)),
      assemblyGapMs: Number(assemblyGap.toFixed(1))
    }
  }, null, 2));
}

function measureEventLoopGap(sampleMs: number): { stop: () => number } {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  return {
    stop: () => {
      clearInterval(timer);
      return maxGap;
    }
  };
}

async function measureRealCommonLongFrames(
  document: NonNullable<Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>>['document']>
): Promise<Record<string, unknown>> {
  const { renderEmevdDarkScriptAsync, renderEmevdDarkScriptBounded } = await import('../emevd/darkScriptRenderer.js');
  const registry = createSekiroFixtureEmedf();
  const json = JSON.stringify({
    events: document.events.map((event) => ({
      id: event.eventId,
      n: event.instructions.length
    }))
  });
  const parseWatch = measureEventLoopGap(50);
  const parseStart = performance.now();
  JSON.parse(json);
  const parseMs = performance.now() - parseStart;
  const parseGap = parseWatch.stop();

  const syncWatch = measureEventLoopGap(50);
  const syncStart = performance.now();
  const sync = renderEmevdDarkScriptBounded(document, registry, undefined);
  const syncMs = performance.now() - syncStart;
  const syncGap = syncWatch.stop();

  const asyncWatch = measureEventLoopGap(50);
  const asyncStart = performance.now();
  const asyncResult = await renderEmevdDarkScriptAsync(document, registry, { sliceBudgetMs: 8 });
  const asyncMs = performance.now() - asyncStart;
  const asyncGap = asyncWatch.stop();
  if (asyncResult.text !== sync.text) {
    throw new Error('真实 common 异步反汇编与同步不一致');
  }
  const rss = process.memoryUsage();
  return {
    jsonParseMs: Number(parseMs.toFixed(1)),
    jsonParseGapMs: Number(parseGap.toFixed(1)),
    darkScriptSyncMs: Number(syncMs.toFixed(1)),
    darkScriptSyncGapMs: Number(syncGap.toFixed(1)),
    darkScriptAsyncMs: Number(asyncMs.toFixed(1)),
    darkScriptAsyncGapMs: Number(asyncGap.toFixed(1)),
    textChars: sync.text.length,
    heapUsedMb: Number((rss.heapUsed / (1024 * 1024)).toFixed(1)),
    rssMb: Number((rss.rss / (1024 * 1024)).toFixed(1)),
    asyncGapUnder32ms: asyncGap < 32
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-full-document-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  // The Bridge daemon inherits test-hook enablement at process start. Set it
  // before the first synthetic read so the later cache cancellation matrix is
  // testing the intended hook-enabled daemon rather than a reused hook-free one.
  enableCacheTestHooks();
  try {
    await syntheticAssembly(root);
    await bridgeDocumentCacheRegressions(root);
    if (nativeEnvAvailable) {
      const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');
      await realCorpusAssembly(root, sourceDcx);
    } else {
      console.log(JSON.stringify({
        ok: true,
        message: '真实 corpus 变体跳过：SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置；通过 node scripts/with-local-has-game-env.mjs 运行可注入本机 corpus 环境。'
      }));
    }
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
