/**
 * Full EMEVD editor-document assembly via paginated Bridge reads.
 *
 * The Bridge `read-emevd-document` envelope is trimmed (256-instruction sample
 * by default); large real documents must be read page by page (hard constraint
 * 17) and assembled on the authoritative side (main/core), never on the
 * renderer. Assembly is validated: page indices must be continuous, the
 * collected instruction total must match the envelope total, and every event's
 * instruction slice must stay in range.
 *
 * EVENT-30A: the outer resource is opened as-is. DCX unwrap happens natively in
 * the C# Bridge (`DcxNativeDocument`), so production open never imports the
 * TypeScript DCX parser and never materializes a decompressed temp file that
 * could later be (mis)used as the Patch target. The read result therefore
 * carries `sourceFormat` / `outerFileHash` (the outer container identity) in
 * addition to the payload-level `sourceHash`, plus a bounded outline DTO for
 * the source IDE.
 */

import type {
  EmevdDocumentOutline,
  EmevdEditorDocument,
  EmevdEventIr,
  EmevdEventOutlineEntry
} from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { attachEmevdStableIdentityAsync } from '../emevd/stableIdentity.js';
import { findInstructionDef, type EmedfRegistry } from '../emevd/emedfSchema.js';

export interface EmevdInstructionPageEntry {
  index: number;
  bank: number;
  id: number;
  argsLength: number;
  argsBase64: string;
  layerOffset: number;
}

export interface EmevdEnvelopePage {
  sourceHash: string;
  /** "emevd" for raw input; "dcx" when Bridge unwrapped a .dcx wrapper. */
  sourceFormat?: string;
  /** SHA-256 of the file bytes as opened (the outer container, not the payload). */
  outerFileHash?: string;
  eventCount: number;
  instructionCount: number;
  instructionTotal?: number;
  instructionPage?: number;
  instructionPageSize?: number;
  instructionPageCount?: number;
  events?: Array<{
    id: number;
    instructionCount: number;
    instructionStartIndex?: number;
    restBehavior: number;
    layerCount?: number;
    parameters?: Array<{
      instructionIndex: number;
      targetStartByte: number;
      sourceStartByte: number;
      byteCount: number;
      unkId: number;
    }>;
  }>;
  instructionsSample?: EmevdInstructionPageEntry[];
  authority?: string;
  /**
   * Bridge 签发的短命文档会话。只允许留在 main/core；不得发给 renderer。
   * 后续页带上它，从同一份已解析快照切片，bypass 也不会每页重解析。
   */
  documentSession?: string;
}

export interface ReadFullEmevdDocumentInput {
  /** Path to the outer source resource: raw .emevd or DFLT/KRAK-wrapped .dcx. */
  filePath: string;
  allowedRoots: string[];
  resourceUri: string;
  registry?: EmedfRegistry;
  documentInstanceId?: string;
  pageSize?: number;
  timeoutMs?: number;
  /**
   * Oodle 运行时根。game-side 的 event 目录是 KRAK 压缩，缺它 Bridge 解不开;
   * mod-side 的 DFLT 不需要。S15 回归靶：新的读入口必须把它传到底。
   */
  oodleRuntimeRoot?: string;
  /**
   * Bridge 文档缓存策略。`default`（缺省）命中即复用，正常打开用它；`bypass`
   * 无条件重读磁盘、既不命中也不写缓存 —— 提交前的新鲜读与写回后的重读必须用它，
   * 那两处要的是「此刻磁盘上的真实内容」，不能依赖任何缓存判定。
   */
  cachePolicy?: 'default' | 'bypass';
  /**
   * 取消信号。传给第一页与**所有后续**分页请求，并在页装配与 outline 构建前复查。
   * 取消时返回 `cancelled: true` + `EMEVD_LOAD_CANCELLED`，不是解析失败 —— 调用方
   * 必须把它静默丢弃，不能渲染成「打开失败」。
   */
  signal?: AbortSignal;
  /**
   * 是否把第一页签发的 documentSession 传给后续页。缺省 true。
   * 测试可以关掉，以覆盖「会话过期后退回逐页读 + 指纹校验」这条路径。
   */
  useDocumentSession?: boolean;
  /**
   * 写链需要稳定锚。打开路径保持 false，避免 139ms SHA-256 长帧。
   */
  attachIdentity?: boolean;
}

export interface ReadFullEmevdDocumentResult {
  ok: boolean;
  /**
   * 调用方主动取消。与 `ok: false` 的解析失败是两回事：取消不代表文件有问题，
   * 不得渲染成打开失败，也不得写进主进程文档缓存。判定用它，不要去 grep 诊断码。
   */
  cancelled?: boolean;
  document?: EmevdEditorDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  pageCount: number;
  instructionTotal: number;
  /** SHA-256 of the decompressed EMEVD source bytes (Bridge commit precondition). */
  sourceHash?: string;
  /** "emevd" or "dcx" — how Bridge opened the outer source. */
  sourceFormat?: string;
  /** SHA-256 of the outer file bytes as opened (Patch target precondition). */
  outerFileHash?: string;
  /**
   * Bridge 的往返判定（`native-verified` = 语义且字节一致，`candidate` = 仅语义）。
   * 打开事件文档的调用方只发一次 read 就要拿到它，不再为一行状态另发一次
   * `read-emevd-document`。
   */
  authority?: string;
  /** Bounded event outline for the source IDE; never carries instruction bodies. */
  outline?: EmevdDocumentOutline;
}

// 真实 common.emevd 有 33266 条指令。单页 65536 把整份 envelope JSON.parse
// 压进一帧（热读实测 ~85 ms / gap ~63 ms）。8192 拆成 5 页：总耗时更短
// （~83 ms），最大 gap ~21 ms。旧默认 512 是 65 次往返 / ~430 ms，不要回去。
// 上限仍 65536：调用方若明确要一页可以指定，超大 EMEVD 继续分页。
const DEFAULT_PAGE_SIZE = 8192;
const MAX_PAGE_SIZE = 65536;
export const DEFAULT_OUTLINE_LIMIT = 4096;

/** 取消码。`ok: false` 但**不是**解析失败：调用方按 `cancelled` 分支静默丢弃。 */
export const EMEVD_LOAD_CANCELLED = 'EMEVD_LOAD_CANCELLED';

/**
 * 读取期间源文件被改写，且重试次数已用尽。
 *
 * 与解析失败区分开：文件本身可能完全合法，只是有别的进程正在写它。
 */
export const EMEVD_SOURCE_CHANGED_DURING_READ = 'EMEVD_SOURCE_CHANGED_DURING_READ';

/**
 * 某一次尝试因跨页指纹漂移被整份丢弃，正在重读。
 *
 * 这条诊断会跟着最终结果一起返回（成功时也带），它是「跨页校验真的执行过并拦下了
 * 一次漂移」在函数外部**唯一**的确定性观测口 —— 只看返回值分不出「文件没被改过」
 * 和「改过但校验没生效」：两者都是 `ok: true` 加一个自洽的哈希。
 */
export const EMEVD_SOURCE_CHANGED_RETRY = 'EMEVD_SOURCE_CHANGED_RETRY';

/**
 * 整次重读的尝试上限。
 *
 * 为什么要有上限：外部工具（DSMapStudio、脚本化批处理）可能在持续写同一个文件，
 * 无上限重试会活锁。用尽后报 `EMEVD_SOURCE_CHANGED_DURING_READ`，由调用方决定重试。
 */
const MAX_READ_ATTEMPTS = 3;

function cancelledResult(pageCount: number, instructionTotal: number): ReadFullEmevdDocumentResult {
  return {
    ok: false,
    cancelled: true,
    diagnostics: [{
      severity: 'info',
      code: EMEVD_LOAD_CANCELLED,
      message: '打开 EMEVD 文档的请求已被调用方取消。'
    }],
    pageCount,
    instructionTotal
  };
}

/**
 * 分页请求失败到底是「取消」还是「真失败」。
 *
 * 只有调用方给了 signal 时才认取消：runBridge 把中止翻成 `BRIDGE_REQUEST_CANCELLED`
 * 的失败结果，而超时路径也会走 sendCancel，没有 signal 的调用方拿到这个码是超时竞态，
 * 仍应报失败 —— 不能因为码相同就把超时说成取消。
 */
function isCancellation(
  signal: AbortSignal | undefined,
  diagnostics: ReadonlyArray<{ code: string }>
): boolean {
  if (!signal) return false;
  if (signal.aborted) return true;
  return diagnostics.some((d) => d.code === 'BRIDGE_REQUEST_CANCELLED');
}

/**
 * 读一份完整 EMEVD 文档（可能跨多页），并保证**整份来自同一个文件版本**。
 *
 * ── 为什么需要整次重试 ──
 *
 * 分页是多次独立的 Bridge 请求，页与页之间源文件可以被别的进程改写。改造前只有
 * 第一页的 `sourceHash` 被采用（作为返回值上报，也作为写回的提交前置条件），后续页
 * 从不比对：在一次 5000 指令的读取中途把文件 A 换成 B，最终会返回 `ok: true` + A 的
 * 哈希，而文档内容是 176 条 A + 4824 条 B。这份混合文档随后会被当成「A 的内容」参与
 * 写回校验 —— 提交前置条件看的是哈希，而哈希是对的。
 *
 * 这里改成每页都比对指纹（payload 的 `sourceHash` 与外层容器的 `outerFileHash`
 * 二者都比），任一页不一致就丢弃**整次**读取结果重来，而不是补读那一页 —— 已装配的
 * 页里同样可能混着旧版本。
 *
 * `cachePolicy: 'bypass'` 下每页都真的重读磁盘，这个窗口最宽；`default` 下缓存以内容
 * SHA-256 为键，文件改了就是另一条身份，同样会跨页混版本。两种策略都需要这道校验。
 */
export async function readFullEmevdDocumentViaBridge(
  input: ReadFullEmevdDocumentInput
): Promise<ReadFullEmevdDocumentResult> {
  const retries: ReadFullEmevdDocumentResult['diagnostics'] = [];
  let lastDrift: { readonly page: number; readonly detail: string } | null = null;
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
    const outcome = await attemptFullEmevdRead(input);
    if (outcome.kind === 'result') {
      // 重试诊断挂在最终结果上，成功也带：调用方（和门禁）要能看出这次读取期间
      // 文件被动过。丢掉它就等于把「校验生效」这件事变成不可观测。
      return retries.length > 0
        ? { ...outcome.result, diagnostics: [...retries, ...outcome.result.diagnostics] }
        : outcome.result;
    }
    lastDrift = { page: outcome.page, detail: outcome.detail };
    retries.push({
      severity: 'warning',
      code: EMEVD_SOURCE_CHANGED_RETRY,
      message: `第 ${attempt} 次读取在第 ${outcome.page} 页发现源文件指纹漂移（${outcome.detail}），`
        + '整次丢弃后重读。'
    });
    if (input.signal?.aborted) return cancelledResult(outcome.pageCount, outcome.instructionTotal);
  }
  return {
    ok: false,
    diagnostics: [
      ...retries,
      {
        severity: 'error',
        code: EMEVD_SOURCE_CHANGED_DURING_READ,
        message: `源文件在分页读取期间被改写，已重试 ${MAX_READ_ATTEMPTS} 次仍未读到一致的版本`
          + `（最后一次在第 ${lastDrift?.page ?? -1} 页失配：${lastDrift?.detail ?? '未知'}）。`
          + '通常意味着有别的进程正在写这个文件。'
      }
    ],
    pageCount: 0,
    instructionTotal: 0
  };
}

/**
 * 单次读取尝试。返回 `kind: 'stale'` 表示中途指纹漂移，调用方应整次重来。
 *
 * 拆成独立函数而不是在原函数里加 `attempt` 参数：重试的正确单位是「整次读取」，
 * 而所有跨页累加状态（slots / filled / minIndex / maxIndex）都是这个函数的局部变量,
 * 函数返回即天然弃置。留在原函数里就得手工重置每一个，漏一个就是跨版本残留。
 */
type FullEmevdReadAttempt =
  | { kind: 'result'; result: ReadFullEmevdDocumentResult }
  | { kind: 'stale'; page: number; detail: string; pageCount: number; instructionTotal: number };

async function attemptFullEmevdRead(
  input: ReadFullEmevdDocumentInput
): Promise<FullEmevdReadAttempt> {
  const pageSize = Math.min(Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const diagnostics: ReadFullEmevdDocumentResult['diagnostics'] = [];
  const resourceUri = sanitizeResourceUri(input.resourceUri);
  const signal = input.signal;
  const totalTimeoutMs = input.timeoutMs ?? 60_000;
  const deadline = Date.now() + totalTimeoutMs;
  const remainingTimeout = (): number => Math.max(1, deadline - Date.now());
  const commandOptionsBase: Record<string, unknown> = input.cachePolicy
    ? { cachePolicy: input.cachePolicy }
    : {};
  const done = (result: ReadFullEmevdDocumentResult): FullEmevdReadAttempt => ({ kind: 'result', result });
  if (signal?.aborted) return done(cancelledResult(0, 0));
  if (Date.now() >= deadline) return done(cancelledResult(0, 0));

  // Production open targets the outer resource path directly. DCX unwrap is the
  // C# Bridge's job (DcxNativeDocument); the TypeScript side never imports a
  // second DCX parser and never writes a decompressed temp file into the
  // write path (negative architecture: 不以 prepared temp path 作为 Patch target).
  const first = await runBridge<EmevdEnvelopePage>({
    command: 'read-emevd-document',
    filePath: input.filePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: remainingTimeout(),
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(signal ? { signal } : {}),
    commandOptions: { ...commandOptionsBase, instructionPage: 0, instructionPageSize: pageSize }
  });
  if (first.parseStatus === 'failed' || !first.data) {
    if (isCancellation(signal, first.diagnostics)) return done(cancelledResult(0, 0));
    return done({
      ok: false,
      diagnostics: first.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
      pageCount: 0,
      instructionTotal: 0
    });
  }
  const pageCount = Math.max(1, first.data.instructionPageCount ?? 1);
  const instructionTotal = first.data.instructionTotal ?? first.data.instructionCount;
  // 按 entry.index 直接落位。页是顺序请求的，旧实现却先进 Map、再 spread 成
  // 33266 个 [k,v]、再 sort、再 map —— 33266 条时这几步是纯开销。落位数组同样
  // 能检出重复（槽位已占）与不连续（filled 与 min..max 跨度不等）。
  const slots: EmevdInstructionPageEntry[] = [];
  let filled = 0;
  let minIndex = Number.POSITIVE_INFINITY;
  let maxIndex = -1;
  const addPage = async (envelope: EmevdEnvelopePage): Promise<void> => {
    let seen = 0;
    for (const entry of envelope.instructionsSample ?? []) {
      if (slots[entry.index] !== undefined) {
        throw new Error(`EMEVD 分页读取出现重复指令索引 ${entry.index}。`);
      }
      slots[entry.index] = entry;
      filled += 1;
      if (entry.index < minIndex) minIndex = entry.index;
      if (entry.index > maxIndex) maxIndex = entry.index;
      seen += 1;
      if (seen % 512 === 0) {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    }
  };
  await addPage(first.data);
  if (input.useDocumentSession !== false && first.data.documentSession) {
    commandOptionsBase.documentSession = first.data.documentSession;
  }
  // 页装配点复查：第一页可能在返回后才被取消，此时后续 64 页与整份组装都是白工。
  if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));

  for (let page = 1; page < pageCount; page += 1) {
    const envelope = await runBridge<EmevdEnvelopePage>({
      command: 'read-emevd-document',
      filePath: input.filePath,
      allowedRoots: input.allowedRoots,
      timeoutMs: remainingTimeout(),
      ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
      ...(signal ? { signal } : {}),
      commandOptions: { ...commandOptionsBase, instructionPage: page, instructionPageSize: pageSize }
    });
    if (envelope.parseStatus === 'failed' || !envelope.data) {
      if (isCancellation(signal, envelope.diagnostics)) return done(cancelledResult(pageCount, instructionTotal));
      return done({
        ok: false,
        diagnostics: envelope.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
        pageCount,
        instructionTotal
      });
    }
    // 指纹校验必须在 addPage **之前**：一旦落位，这一页的旧/新版本指令就混进了
    // slots，而 slots 是整次尝试共享的。先校验、后落位，失配时这次尝试的产物整份丢弃。
    const drift = fingerprintDrift(first.data, envelope.data);
    if (drift !== null) {
      return { kind: 'stale', page, detail: drift, pageCount, instructionTotal };
    }
    await addPage(envelope.data);
    if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));
  }

  if (filled !== instructionTotal) {
    throw new Error(`EMEVD 分页组装指令总数 ${filled} ≠ envelope 总数 ${instructionTotal}。`);
  }
  if (filled > 0 && maxIndex - minIndex + 1 !== filled) {
    // 有洞：定位第一个缺口，保持与旧实现同形的诊断。
    for (let i = minIndex; i <= maxIndex; i += 1) {
      if (slots[i] === undefined) {
        throw new Error(`EMEVD 分页组装指令索引不连续：${slots[i + 1]?.index ?? maxIndex} ≠ ${i}。`);
      }
    }
  }
  const allInstructions = filled > 0 ? slots.slice(minIndex, maxIndex + 1) : [];

  // 在让出循环里一次做成 EmevdEventIr + outline 行。不要再走
  // createEmevdEditorDocument：它会同步 remap 全部指令；打开路径再算
  // SHA-256 身份曾测到 139ms 长帧。
  const events: EmevdEventIr[] = [];
  const outlineRows: EmevdEventOutlineEntry[] = [];
  let hasUnknown = false;
  let assembledEvents = 0;
  let assembledInstructions = 0;
  for (const event of first.data.events ?? []) {
    const count = event.instructionCount;
    const start = count > 0 ? (event.instructionStartIndex ?? -1) : 0;
    const eventUri = `${resourceUri}#event/${event.id}`;
    const instructions: EmevdEventIr['instructions'] = [];
    let unknownCount = 0;
    if (count > 0) {
      if (start < 0 || start + count > allInstructions.length) {
        throw new Error(`EMEVD 事件 ${event.id} 的指令切片越界（start=${start}, count=${count}, total=${allInstructions.length}）。`);
      }
      for (let index = 0; index < count; index += 1) {
        const entry = allInstructions[start + index]!;
        const unknown = input.registry ? findInstructionDef(input.registry, entry.bank, entry.id) === undefined : true;
        if (unknown) {
          unknownCount += 1;
          hasUnknown = true;
        }
        instructions.push({
          instructionUri: `${eventUri}/instr/${index}`,
          bank: entry.bank,
          id: entry.id,
          argsBase64: entry.argsBase64,
          unknown
        });
        assembledInstructions += 1;
        if (assembledInstructions % 256 === 0) {
          if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));
          await new Promise<void>((resolve) => { setImmediate(resolve); });
        }
      }
    }
    events.push({
      eventUri,
      eventId: event.id,
      restBehavior: event.restBehavior,
      layer: -1,
      instructions,
      ...(event.parameters ? { parameters: event.parameters } : {})
    });
    outlineRows.push({
      eventUri,
      eventId: event.id,
      restBehavior: event.restBehavior,
      layer: -1,
      instructionCount: count,
      unknownCount
    });
    assembledEvents += 1;
    if (assembledEvents % 64 === 0) {
      if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  let document: EmevdEditorDocument = {
    schemaVersion: 1,
    resourceUri,
    revision: 0,
    events,
    bytesBase64: '',
    diagnostics: hasUnknown
      ? [{
          severity: 'info',
          code: 'EMEVD_UNKNOWN_INSTRUCTIONS_PRESERVED',
          message: '未知 instruction 已保留为不透明 payload，禁止无 schema 的结构化修改。'
        }]
      : [],
    ...(input.documentInstanceId !== undefined ? { documentInstanceId: input.documentInstanceId } : {})
  };
  if (input.attachIdentity) {
    if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));
    try {
      document = await attachEmevdStableIdentityAsync(document, {
        ...(input.documentInstanceId !== undefined ? { documentInstanceId: input.documentInstanceId } : {}),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === 'EMEVD_IDENTITY_CANCELLED')) {
        return done(cancelledResult(pageCount, instructionTotal));
      }
      throw error;
    }
  }
  if (signal?.aborted) return done(cancelledResult(pageCount, instructionTotal));
  diagnostics.push({
    severity: 'info',
    code: 'EMEVD_FULL_DOCUMENT_ASSEMBLED',
    message: `完整 EMEVD 文档组装完成：${events.length} 事件 / ${instructionTotal} 指令 / ${pageCount} 页。`
  });
  const outlineLimit = DEFAULT_OUTLINE_LIMIT;
  return done({
    ok: true,
    document,
    diagnostics,
    pageCount,
    instructionTotal,
    sourceHash: first.data.sourceHash,
    sourceFormat: first.data.sourceFormat ?? 'emevd',
    ...(first.data.outerFileHash !== undefined ? { outerFileHash: first.data.outerFileHash } : {}),
    ...(first.data.authority !== undefined ? { authority: first.data.authority } : {}),
    outline: {
      schemaVersion: 1,
      resourceUri,
      eventCount: events.length,
      instructionTotal,
      truncated: outlineRows.length > outlineLimit,
      limit: outlineLimit,
      events: outlineRows.length > outlineLimit ? outlineRows.slice(0, outlineLimit) : outlineRows
    }
  });
}

/**
 * 后续页与第一页的指纹是否漂移。返回 null = 一致；否则返回人读的失配描述。
 *
 * 两个哈希都要比：
 *   - `sourceHash` 是**解压后 payload** 的 SHA-256，也是写回的提交前置条件；
 *   - `outerFileHash` 是**外层容器文件**的 SHA-256。DCX 输入下二者不同，且存在
 *     「payload 相同但容器被重压缩」的情形（压缩级别/工具不同）—— 那时 sourceHash
 *     一致而 outerFileHash 变了，写回的 Patch target 前置条件仍然被破坏。
 *
 * `outerFileHash` 是可选字段：只在两侧都有时比。单侧缺失说明 Bridge 这一版没给这个
 * 字段，不能当成漂移（那会让每次读取都重试到耗尽）。
 */
function fingerprintDrift(first: EmevdEnvelopePage, page: EmevdEnvelopePage): string | null {
  if (page.sourceHash !== first.sourceHash) {
    return `sourceHash ${first.sourceHash} → ${page.sourceHash}`;
  }
  if (
    first.outerFileHash !== undefined
    && page.outerFileHash !== undefined
    && page.outerFileHash !== first.outerFileHash
  ) {
    return `outerFileHash ${first.outerFileHash} → ${page.outerFileHash}`;
  }
  return null;
}

/** Total instruction count a page set must cover for the given events table. */
export function expectedInstructionTotal(events: EmevdEventIr[]): number {
  return events.reduce((sum, event) => sum + event.instructions.length, 0);
}

/**
 * 绝对路径脱敏（EVENT-30A）：resourceUri 本应资源相对（如
 * `file://event/common.emevd`）。若调用方误传了本地绝对路径（`D:\...`、
 * `file:///D:/...`、UNC），收敛成无盘符的相对 `file://` 形式，避免把本地
 * 文件系统路径泄漏进 DSL 投影与 outline。已经是资源相对的 URI 原样返回。
 */
export function sanitizeResourceUri(uri: string): string {
  const relativeForm = /^file:\/\/[A-Za-z0-9_.-]+(?:\/|$)/;
  if (relativeForm.test(uri) || /^[A-Za-z0-9_.-]+(?:\/|$)/.test(uri)) {
    return uri;
  }
  const pathPart = uri
    .replace(/^file:\/\/\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^[A-Za-z]:[\\/]/, '')
    .replace(/\\/g, '/')
    .replace(/^[\\/]+/, '');
  const relative = pathPart.replace(/^[\\/]+/, '');
  return relative ? `file://${relative}` : 'file://resource';
}

export interface BuildEmevdDocumentOutlineOptions {
  /** Cap on outline rows; larger documents truncate with `truncated: true`. */
  limit?: number;
}

/**
 * Build the bounded event outline for the source IDE (EVENT-30A). Summary rows
 * only — event identity + counts, never instruction bodies/args/strings — so a
 * real corpus stays well inside IPC budgets. `truncated` is set when the event
 * count exceeds `limit`.
 */
export function buildEmevdDocumentOutline(
  document: EmevdEditorDocument,
  options: BuildEmevdDocumentOutlineOptions = {}
): EmevdDocumentOutline {
  const limit = Math.max(1, options.limit ?? DEFAULT_OUTLINE_LIMIT);
  const truncated = document.events.length > limit;
  const events = document.events.slice(0, limit).map((event) => ({
    eventUri: event.eventUri,
    eventId: event.eventId,
    restBehavior: event.restBehavior,
    layer: event.layer,
    instructionCount: event.instructions.length,
    unknownCount: event.instructions.reduce((n, instruction) => n + (instruction.unknown ? 1 : 0), 0)
  }));
  return {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    eventCount: document.events.length,
    instructionTotal: expectedInstructionTotal(document.events),
    truncated,
    limit,
    events
  };
}
