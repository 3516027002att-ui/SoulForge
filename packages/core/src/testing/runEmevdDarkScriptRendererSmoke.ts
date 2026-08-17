/**
 * DarkScript3-style EMEVD source renderer smoke.
 *
 * Covers: $Event header (Default/Restart/unknown), instruction call rendering
 * with EMEDF-derived PascalCase names, condition folding into `WaitFor(A && B)`,
 * unknown-instruction comments, decode-failure comments, empty event bodies,
 * and truncation at event-block boundaries.
 *
 * All EMEDF data here is synthetic and self-authored; the registry is built
 * through parseDs3EmedfJson so the real sanitization rules (space-cased
 * instruction names → PascalCase, arg names → camelCase) are exercised.
 */
import { createEmevdEditorDocument } from '../editing/emevdFourViewController.js';
import { parseDs3EmedfJson } from '../emevd/emedfExternalAdapter.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import {
  renderEmevdDarkScript,
  renderEmevdDarkScriptAsync,
  renderEmevdDarkScriptBounded
} from '../emevd/darkScriptRenderer.js';
import type { EmevdEditorDocument } from '@soulforge/shared';

/**
 * Synthetic DarkScript3-format EMEDF JSON covering the instructions this smoke
 * needs. Layouts are self-authored; lengths are chosen to be decodable.
 *   - 0:0      IF Condition Group             {s8 result, u8 state, s8 target}
 *   - 1000:0   WAIT For Condition Group State  {u8 state, s8 target}
 *   - 2000:0   Initialize Event                {s32 slot, u32 eventId, u32 vararg}
 *   - 4:10     IF Player Has Item              {s8 result, u32 itemType, u32 itemId}
 *   - 4:11     IF Character Has SpEffect       {s8 result, u32 chr, u32 spEffect}
 * All explicitly synthetic — never a dump of any real EMEDF file.
 */
function createSyntheticRegistry(): EmedfRegistry {
  const json = JSON.stringify({
    unknown: 0,
    main_classes: [
      {
        name: 'Condition - System',
        index: 0,
        instrs: [
          {
            name: 'IF Condition Group',
            index: 0,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'Control Flow - System',
        index: 1000,
        instrs: [
          {
            name: 'WAIT For Condition Group State',
            index: 0,
            args: [
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'System',
        index: 2000,
        instrs: [
          {
            name: 'Initialize Event',
            index: 0,
            args: [
              { name: 'Event Slot ID', type: 5 },
              { name: 'Event ID', type: 2 },
              { name: 'Parameters', type: 2, vararg: true }
            ]
          }
        ]
      },
      {
        name: 'Condition - Character',
        index: 4,
        instrs: [
          {
            name: 'IF Player Has Item',
            index: 10,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Item Type', type: 2 },
              { name: 'Item ID', type: 2 }
            ]
          },
          {
            name: 'IF Character Has SpEffect',
            index: 11,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Character', type: 2 },
              { name: 'SpEffect ID', type: 2 }
            ]
          }
        ]
      }
    ],
    enums: [],
    darkscript: {}
  });
  const result = parseDs3EmedfJson(json);
  if (!result.ok) throw new Error(`synthetic registry import failed: ${result.message}`);
  return result.registry;
}

/** Encode an IfConditionGroup / WaitFor payload (3 args, 4 bytes, s8/u8/s8). */
function condGroupArgs(result: number, state: number, target: number): string {
  const buf = Buffer.alloc(4);
  buf.writeInt8(result, 0);
  buf.writeUInt8(state, 1);
  buf.writeInt8(target, 2);
  buf.writeUInt8(0, 3); // alignment padding
  return buf.toString('base64');
}

/** Encode a WAIT payload (2 args, 4 bytes, u8/s8). */
function waitArgs(state: number, target: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt8(state, 0);
  buf.writeInt8(target, 1);
  return buf.toString('base64');
}

/** InitializeEvent payload: s32 slot + u32 eventId + one u32 parameter. */
function initEventArgs(slot: number, eventId: number, param: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt32LE(slot, 0);
  buf.writeUInt32LE(eventId, 4);
  buf.writeUInt32LE(param, 8);
  return buf.toString('base64');
}

/** Predicate payload: s8 result + u32 a + u32 b (4-byte aligned → 12 bytes). */
function predicateArgs(result: number, a: number, b: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt8(result, 0);
  buf.writeUInt32LE(a, 4);
  buf.writeUInt32LE(b, 8);
  return buf.toString('base64');
}

/* ------------------------------------------------------------------ */
/*  分片异步反汇编（Part 3）                                           */
/* ------------------------------------------------------------------ */

/**
 * 大体积文档：每个事件都轮换四种形态，让异步路径的切片边界必然落在各种事件之间。
 *
 * 四种形态是刻意混进去的：只有 InitializeEvent 那种最简单的事件，切片边界永远
 * 落在结构完全相同的块之间，「切在事件中间会不会改变输出」这件事就没被测到。
 * 混入折叠块（WaitFor）、unknown 注释、空事件之后，字节相等才真的覆盖了
 * 失败注释 / unknown 指令 / WaitFor 折叠 / 空块 这几条输出规则。
 */
function createLargeDocument(events: number): EmevdEditorDocument {
  const specs: Parameters<typeof createEmevdEditorDocument>[0]['events'] = [];
  for (let index = 0; index < events; index += 1) {
    switch (index % 4) {
      case 0:
        specs.push({
          eventId: 1000 + index,
          restBehavior: 0,
          instructions: [
            { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770000 + index, 0), unknown: false },
            { bank: 2000, id: 0, argsBase64: initEventArgs(1, 77780000 + index, 0), unknown: false }
          ]
        });
        break;
      case 1:
        // 折叠形态：三个谓词汇入 MAIN 组，渲染成 WaitFor(A && B && C)。
        specs.push({
          eventId: 1000 + index,
          restBehavior: 1,
          instructions: [
            { bank: 4, id: 10, argsBase64: predicateArgs(1, 6, 2400 + index), unknown: false },
            { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 127800 + index), unknown: false },
            { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 110140 + index), unknown: false },
            { bank: 0, id: 0, argsBase64: condGroupArgs(0, 1, 1), unknown: false }
          ]
        });
        break;
      case 2:
        // unknown 注释 + 解码失败注释（0:0 只吃 4 字节，这里给 5 字节）。
        specs.push({
          eventId: 1000 + index,
          restBehavior: 0,
          instructions: [
            { bank: 9999, id: index % 97, argsBase64: '', unknown: true },
            { bank: 0, id: 0, argsBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), unknown: false }
          ]
        });
        break;
      default:
        // 空事件：header 紧跟 `});`，切片边界最容易在这里出偏差。
        specs.push({ eventId: 1000 + index, restBehavior: 2, instructions: [] });
        break;
    }
  }
  return createEmevdEditorDocument({
    resourceUri: 'file://event/large.emevd',
    documentInstanceId: 'darkscript-async-large',
    events: specs
  });
}

/**
 * 异步与同步必须逐字节相同。
 *
 * 比的是完整字符串相等（含行数与尾换行），不是「都包含某几个片段」——
 * 后者对切片边界处多一个 / 少一个换行完全无感，而那正是分片最容易错的地方。
 */
async function asyncMatchesSyncByteForByte(registry: EmedfRegistry): Promise<Record<string, unknown>> {
  const cases: Array<{ label: string; document: EmevdEditorDocument }> = [
    { label: '空文档', document: createEmevdEditorDocument({ resourceUri: 'file://event/empty.emevd', events: [] }) },
    { label: '单空事件', document: createLargeDocument(1) },
    { label: '四形态各一', document: createLargeDocument(4) },
    { label: '大文档 1200 事件', document: createLargeDocument(1200) }
  ];
  const shapes: Array<Record<string, unknown>> = [];
  for (const { label, document } of cases) {
    const sync = renderEmevdDarkScriptBounded(document, registry, undefined);
    // sliceBudgetMs=0 → 每个事件都让出一次：切片边界密到每个事件之间都被切过一遍。
    const perEvent = await renderEmevdDarkScriptAsync(document, registry, {
      sliceBudgetMs: 0,
      eventsPerClockCheck: 1
    });
    // 缺省预算：production 实际走的那条路径。
    const defaults = await renderEmevdDarkScriptAsync(document, registry);

    for (const [variant, actual] of [['逐事件让出', perEvent], ['缺省预算', defaults]] as const) {
      if (actual.cancelled) throw new Error(`${label} / ${variant}: 未取消却返回 cancelled`);
      if (actual.text !== sync.text) {
        const at = firstDifferenceIndex(sync.text, actual.text);
        throw new Error(
          `${label} / ${variant}: 异步输出与同步不逐字节相同，首个差异在偏移 ${at}。`
            + `\n同步 : ${JSON.stringify(sync.text.slice(Math.max(0, at - 40), at + 40))}`
            + `\n异步 : ${JSON.stringify(actual.text.slice(Math.max(0, at - 40), at + 40))}`
        );
      }
      if (actual.totalLines !== sync.totalLines) {
        throw new Error(`${label} / ${variant}: totalLines ${actual.totalLines} ≠ 同步 ${sync.totalLines}`);
      }
      if (actual.shownLines !== sync.shownLines) {
        throw new Error(`${label} / ${variant}: shownLines ${actual.shownLines} ≠ 同步 ${sync.shownLines}`);
      }
      if (actual.truncated !== sync.truncated) {
        throw new Error(`${label} / ${variant}: truncated ${actual.truncated} ≠ 同步 ${sync.truncated}`);
      }
    }
    // 大文档必须真的覆盖到四种输出规则，否则「字节相等」是在一份贫瘠样本上成立的。
    if (label === '大文档 1200 事件') {
      for (const marker of ['WaitFor(', '// unknown bank=9999', '// EMEDF_ARGS_LENGTH_MISMATCH', 'InitializeEvent(']) {
        if (!sync.text.includes(marker)) throw new Error(`大文档样本没有覆盖输出规则 ${marker}`);
      }
      if (!/\n\}\);\n\$Event\(\d+, 2 \/\* unknown restBehavior \*\/, function\(\) \{\n\}\);/.test(sync.text)) {
        throw new Error('大文档样本没有覆盖「空事件块」形态');
      }
    }
    shapes.push({ case: label, chars: sync.text.length, totalLines: sync.totalLines });
  }
  return { byteIdentical: true, cases: shapes };
}

function firstDifferenceIndex(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    if (left[i] !== right[i]) return i;
  }
  return limit;
}

/**
 * 定时器在大文档渲染期间必须拿到执行机会。
 *
 * 这是 Part 3 的全部动机：同步反汇编期间事件循环停摆，排队的取消信号要等它跑完
 * 才被看见。判据用 `setInterval` 的实际触发次数 —— 同步渲染期间必然是 0（单线程，
 * 循环没有回到 timer 阶段的机会），异步渲染期间必须 > 0。
 *
 * 正负两条各自独立测量、各自独立断言，不共用 if/else：同步那次证明「样本足够大,
 * 大到同步渲染真的会饿死定时器」，异步那次证明「分片让出确实喂到了定时器」。
 * 少了前者，后者可能只是因为文档太小、根本没触发过任何让出。
 */
async function timersRunDuringAsyncRender(registry: EmedfRegistry): Promise<Record<string, unknown>> {
  // 20000 事件 ≈ 80 ms 同步渲染：对 20 ms 下限有 4 倍余量，缺省 8 ms 预算下约 10 个
  // 切片。6000 事件时实测同步 24 ms / 定时器 2 次，两侧余量都太薄，快一点的机器上
  // 会翻成「样本太小」的假红。
  const document = createLargeDocument(20_000);

  // 前提测量：同步渲染期间定时器一次都轮不到。
  let syncTicks = 0;
  const syncTimer = setInterval(() => { syncTicks += 1; }, 1);
  const syncStart = performance.now();
  const syncText = renderEmevdDarkScriptBounded(document, registry, undefined).text;
  const syncMs = performance.now() - syncStart;
  clearInterval(syncTimer);
  if (syncMs < 20) {
    throw new Error(
      `同步渲染只花了 ${syncMs.toFixed(1)} ms，样本太小，「定时器被饿死」这件事无法成立 —— `
        + '请加大 createLargeDocument 的事件数。'
    );
  }
  if (syncTicks !== 0) {
    throw new Error(`同步渲染期间定时器竟触发了 ${syncTicks} 次：这个前提不成立，异步侧的判据也就失去了对照。`);
  }

  // 被测量：异步渲染期间定时器必须拿到时间。
  let asyncTicks = 0;
  const asyncTimer = setInterval(() => { asyncTicks += 1; }, 1);
  const asyncStart = performance.now();
  const asyncResult = await renderEmevdDarkScriptAsync(document, registry);
  const asyncMs = performance.now() - asyncStart;
  clearInterval(asyncTimer);
  if (asyncResult.text !== syncText) throw new Error('大文档异步输出与同步不一致');
  if (asyncTicks === 0) {
    throw new Error(
      `异步渲染 ${asyncMs.toFixed(1)} ms 期间定时器一次都没触发：没有真的让出事件循环。`
    );
  }
  return {
    syncMs: Number(syncMs.toFixed(1)),
    syncTicks,
    asyncMs: Number(asyncMs.toFixed(1)),
    asyncTicks,
    totalLines: asyncResult.totalLines
  };
}

/**
 * 取消不返回半成品源码。
 *
 * 在第一次让出时中止，然后断言 `text` 是空串。半成品最危险的地方在于它看起来
 * 像一份完整文档：编辑器会把它当成文件全文渲染，用户看到的是一份被静默截断的源码。
 */
async function cancellationYieldsNoPartialSource(registry: EmedfRegistry): Promise<Record<string, unknown>> {
  // 与 timersRunDuringAsyncRender 同规格：20_000 事件同步渲染约 80 ms，缺省
  // 8 ms 预算下达 10 个切片，第一次让出必然落在渲染中途。4000 事件在快机器上
  // 同步渲染不足 8 ms，异步侧一次让出都不会发生，「让出期间被取消」测不到。
  const document = createLargeDocument(20_000);
  const full = renderEmevdDarkScriptBounded(document, registry, undefined);
  if (full.text.length < 10_000) throw new Error('取消回归的样本太小，中途中止不一定发生在渲染过程中');

  // 中途取消：第一次让出后立刻 abort。
  const midway = new AbortController();
  let yields = 0;
  const originalSetImmediate = globalThis.setImmediate;
  // 测试期临时替身：只为在「确实发生了让出」的那一刻触发取消。
  globalThis.setImmediate = ((callback: () => void, ...rest: unknown[]) => {
    yields += 1;
    if (yields === 1) midway.abort();
    return originalSetImmediate(callback as never, ...(rest as never[]));
  }) as typeof globalThis.setImmediate;
  let midwayResult;
  try {
    midwayResult = await renderEmevdDarkScriptAsync(document, registry, { signal: midway.signal });
  } finally {
    globalThis.setImmediate = originalSetImmediate;
  }
  if (yields === 0) throw new Error('渲染期间没有发生任何让出，「让出期间被取消」这一形态没被测到');
  if (!midwayResult.cancelled) throw new Error('让出期间取消后必须返回 cancelled: true');
  if (midwayResult.text !== '') {
    throw new Error(`取消返回了半成品源码（${midwayResult.text.length} 字符），必须是空串`);
  }
  if (midwayResult.totalLines !== 0 || midwayResult.shownLines !== 0) {
    throw new Error('取消结果的行数必须归零，否则调用方会以为拿到了一份完整文档');
  }

  // 起手即取消：一次让出都不该付。
  const upfront = new AbortController();
  upfront.abort();
  const upfrontResult = await renderEmevdDarkScriptAsync(document, registry, { signal: upfront.signal });
  if (!upfrontResult.cancelled || upfrontResult.text !== '') {
    throw new Error('已中止的 signal 必须立刻返回空串 + cancelled');
  }

  // 未取消的对照：同一份文档、同一个入口，signal 没被触发时必须给出完整源码。
  const untouched = new AbortController();
  const untouchedResult = await renderEmevdDarkScriptAsync(document, registry, { signal: untouched.signal });
  if (untouchedResult.cancelled) throw new Error('未触发的 signal 不得被当作取消');
  if (untouchedResult.text !== full.text) throw new Error('带未触发 signal 的渲染必须与同步逐字节相同');

  return {
    yieldsBeforeAbort: yields,
    midwayTextLength: midwayResult.text.length,
    upfrontTextLength: upfrontResult.text.length,
    untouchedChars: untouchedResult.text.length
  };
}

async function main(): Promise<void> {
  const registry = createSyntheticRegistry();

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'darkscript-smoke-document',
    events: [
      {
        eventId: 0,
        restBehavior: 0,
        instructions: [
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770001, 0), unknown: false },
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770002, 0), unknown: false }
        ]
      },
      {
        eventId: 965672,
        restBehavior: 1,
        instructions: [
          // Predicates sharing result group 1 (AND), terminating in an
          // IF Condition Group join whose result group is MAIN (0).
          { bank: 4, id: 10, argsBase64: predicateArgs(1, 6, 2498), unknown: false },
          { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 127800), unknown: false },
          { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 110140), unknown: false },
          { bank: 0, id: 0, argsBase64: condGroupArgs(0, 1, 1), unknown: false },
          // Ordinary instruction after the wait block.
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770003, 0), unknown: false },
          // Unknown instruction → comment.
          { bank: 9999, id: 7, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 42, restBehavior: 2, instructions: [] }
    ]
  });

  const text = renderEmevdDarkScript(document, registry);

  // Event headers.
  if (!text.includes('$Event(0, Default, function() {')) throw new Error('event 0 header missing');
  if (!text.includes('$Event(965672, Restart, function() {')) throw new Error('event 965672 header missing');
  if (!text.includes('$Event(42, 2 /* unknown restBehavior */, function() {')) {
    throw new Error('unknown restBehavior must be rendered verbatim with a comment');
  }

  // Instruction names come from EMEDF, PascalCased.
  if (!text.includes('InitializeEvent(0, 77770001, 0);')) throw new Error('InitializeEvent call missing');
  if (!text.includes('InitializeEvent(0, 77770002, 0);')) throw new Error('second InitializeEvent call missing');

  // Condition folding → WaitFor(A && B && C), 8-space inner indent, hidden group args.
  if (!/WaitFor\(\n        IfPlayerHasItem\(6, 2498\)\n        && IfCharacterHasSpEffect\(10000, 127800\)\n        && IfCharacterHasSpEffect\(10000, 110140\)\);/.test(text)) {
    throw new Error(`WaitFor && fold mismatch:\n${text}`);
  }

  // Unknown instruction → honest comment.
  if (!text.includes('// unknown bank=9999 id=7')) throw new Error('unknown comment missing');

  // Empty event body → `$Event(id, ...) { ... });` on its own, nothing inside.
  if (!text.includes('$Event(42, 2 /* unknown restBehavior */, function() {\n});')) {
    throw new Error('empty event body must render as header + });');
  }

  // No hash-DSL leakage: the forbidden shape must never appear.
  if (text.includes('instruction @') || text.includes('set arg')) {
    throw new Error('hash DSL leaked into DarkScript output');
  }

  // Decode failure → `// <code> bank=... id=...` comment.
  const badDecode = createEmevdEditorDocument({
    resourceUri: 'file://event/bad.emevd',
    events: [
      {
        eventId: 7,
        restBehavior: 0,
        instructions: [
          // 0:0 IfConditionGroup expects 4 bytes; give it a wrong-length payload.
          { bank: 0, id: 0, argsBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), unknown: false }
        ]
      }
    ]
  });
  const badText = renderEmevdDarkScript(badDecode, registry);
  if (!badText.includes('// EMEDF_ARGS_LENGTH_MISMATCH bank=0 id=0')) {
    throw new Error(`decode failure must render as comment:\n${badText}`);
  }

  // Truncation must end at an event-block boundary, not mid-block.
  const bounded = renderEmevdDarkScriptBounded(document, registry, 8);
  if (!bounded.truncated) throw new Error('bounded render must truncate under the cap');
  if (!bounded.text.includes('$Event(0, Default, function() {\n    InitializeEvent(0, 77770001, 0);\n    InitializeEvent(0, 77770002, 0);\n});')) {
    throw new Error('truncation must keep whole event blocks intact:\n' + bounded.text);
  }
  if (bounded.text.includes('$Event(965672')) {
    throw new Error('truncated text must not include a partially-rendered later event');
  }
  if (!bounded.text.includes('// DARKSCRIPT_TRUNCATED')) {
    throw new Error('truncation marker comment missing');
  }

  const unbounded = renderEmevdDarkScriptBounded(document, registry, 1_000_000);
  if (unbounded.truncated || unbounded.totalLines !== unbounded.shownLines) {
    throw new Error('unbounded-cap render must not truncate');
  }

  const equivalence = await asyncMatchesSyncByteForByte(registry);
  const timers = await timersRunDuringAsyncRender(registry);
  const cancellation = await cancellationYieldsNoPartialSource(registry);

  console.log(JSON.stringify({
    ok: true,
    message: 'DarkScript3 源码渲染器验证通过（含分片异步等价 / 让出 / 取消）',
    eventHeaders: ['Default', 'Restart', 'unknown'],
    conditionFold: 'WaitFor(A && B && C)',
    unknownComment: true,
    decodeFailureComment: true,
    truncationAtEventBoundary: true,
    totalLines: unbounded.totalLines,
    asyncEquivalence: equivalence,
    asyncYieldsToTimers: timers,
    asyncCancellation: cancellation
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
