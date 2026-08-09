/**
 * 明文脚本条目源码级编辑 smoke。
 *
 * 覆盖用户裁定(2026-08-08)开放的 `source-level-edit-plaintext-script-entries`:
 * 明文条目可源码级编辑,306 个字节码条目仍只许整文件替换。
 *
 * ── 为什么这一层必须存在 ──
 *
 * 源码级编辑最危险的失效形态不是崩溃,是**静默损坏**:
 *   - 把字节码条目当明文改 → 写出一个游戏加载不了的容器,而写入过程零报错;
 *   - 把 Shift-JIS 当 UTF-8 读写 → 所有日文变成替换符,字节数改变,同样零报错;
 *   - 容器重打包不无损 → writer 回报成功,但读回来的内容已经不是写进去的。
 * 这三种都不抛异常、不影响编译,只能靠断言钉住。
 *
 * ── 真实语料 ──
 *
 * 有本机 Mod 工作区时跑真实条目(mods/script 下的 luabnd 与 mods/action 下的
 * *nameid.txt);没有时用 synthetic 字节走完同一套判定与编排逻辑,并**结构化
 * 跳过**真实语料那部分。跳过必须显式,不能让「没跑」看起来像「通过」。
 *
 * 原版游戏目录只读:本 smoke 只**读**游戏侧路径用于对照,所有写入都发生在
 * 临时目录里的 synthetic 容器上。
 *
 * ── 负向证明(2026-08-08 实测十五条,每条退化后 `tsc -b --force` 重建再跑)──
 *   P1  字节码判定失效                    → Case 2
 *   P2  NUL 检测失效                      → Case 3
 *   P3  可打印阈值放宽到 0.5              → Case 4
 *   P4  锚点未命中不再报错                → Case 5
 *   P5  锚点唯一性检查去掉                → Case 6
 *   P6  空改动被放过                      → Case 7
 *   P7  Shift-JIS 非 ASCII 按 UTF-8 编回  → Case 9
 *   P8  写后重读不复验明文                → Case 13
 *   P9  写后重读不比哈希                  → Case 12
 *   P10 尾部填充不再剥离                  → Case 10b
 *   P11 NUL 判定只看开头两字节            → Case 3
 *   P12 编码判定恒返回 utf8               → Case 9
 *   P13 前置条件降级为不带哈希的 custom    → Case 1
 *   P14 不再要求 after_commit 复验         → Case 1
 *   P15 填充计算了但没写进产物            → Case 1 + Case 10
 *
 * P15 第一版报绿,暴露出真实盲区:把「补回填充」写成变量却没写进
 * childContentBase64 时,原有断言全过而产物条目长度已经变了。据此补了
 * 「afterBytes 必须等于产物真实字节数」与 Case 10b 的填充保留断言。
 * P11 第一版也报绿,但那是用例设计错误而非门禁缺陷 —— 填充剥离走
 * trailingNulCount(扫全文),采样只影响剥离后的内容体,那条退化不构成缺陷;
 * 改为在内容体开头之外插 NUL 才测到真判据。
 * P4 与 P13 最初的退化写法让 tsc 报类型错误(TS2339 / 非法字段)而非跑出判据
 * 结果,改成类型合法的恒假条件与字段降级后成立。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPlaintextScriptEdit,
  checkPlaintextWriteback
} from '../script/plaintextScriptEdit.js';
import {
  classifyPlaintextBytes,
  decodePlaintext,
  detectPlaintextEncoding,
  encodePlaintext,
  PLAINTEXT_PRINTABLE_RATIO_THRESHOLD
} from '../script/plaintextScriptEntry.js';

interface SmokeResult {
  ok: boolean;
  message: string;
  passed: number;
  total: number;
  realCorpus: {
    attempted: boolean;
    skippedReason?: string;
    checkedEntries: string[];
  };
  nonClaims: string[];
}

const MOD_WORKSPACE = process.env.SOULFORGE_SEKIRO_ROOT
  ?? 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * 构造一份贴近真实语料的 Shift-JIS 样本。
 *
 * 形态照 action/*nameid.txt:首行一句日文注释,其余是 ASCII 的
 * `Num = N` 与编号表。日文密度必须低到让可打印率仍在明文阈值之上,
 * 否则样本自己就被判成非明文,测不到编码分支(第一版实测踩过)。
 */
function buildShiftJisSample(): Uint8Array {
  // 0x93 0xFA = 「日」、0x96 0x7B = 「本」、0x8C 0xEA = 「語」
  const japaneseComment = [0x23, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a];
  const asciiBody = new TextEncoder().encode(
    `Num = 1\n${Array.from({ length: 120 }, (_, index) => `${index} = "a${index}"`).join('\n')}\n`
  );
  const out = new Uint8Array(japaneseComment.length + asciiBody.length);
  out.set(japaneseComment, 0);
  out.set(asciiBody, japaneseComment.length);
  return out;
}

export async function runPlaintextScriptEditSmoke(): Promise<SmokeResult> {
  let passed = 0;
  const total = 15;
  const checkedEntries: string[] = [];
  let realAttempted = false;
  let skippedReason: string | undefined;

  const containerUri = 'file:///synthetic/aicommon.luabnd.dcx';
  const containerHash = sha256(new TextEncoder().encode('container-placeholder'));

  /* --- Case 1: 明文 lua 的 replace-once 正常路径 --- */
  {
    const original = new TextEncoder().encode(
      'GOAL_COMMON_TopGoal = 0\nGOAL_COMMON_Normal = 1\nGOAL_COMMON_Attack = 2\n'
    );
    const result = buildPlaintextScriptEdit({
      containerUri,
      childPath: 'goal_list.lua',
      entryIndex: 0,
      currentBytes: original,
      expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'GOAL_COMMON_Attack = 2', replace: 'GOAL_COMMON_Attack = 7' }]
    });
    assert(result.ok, `Case 1: 明文编辑应成功,实际 ${result.ok ? '' : result.code}`);
    if (result.ok) {
      assert(result.encoding === 'ascii', `Case 1: 编码应为 ascii,实际 ${result.encoding}`);
      const written = new Uint8Array(
        Buffer.from(result.operation.childContentBase64 ?? '', 'base64')
      );
      const decoded = Buffer.from(written).toString('utf8');
      assert(decoded.includes('GOAL_COMMON_Attack = 7'), 'Case 1: 新内容必须含替换结果');
      assert(!decoded.includes('= 2'), 'Case 1: 旧值必须被替换掉');
      // 前置条件必须是结构化对象且带哈希 —— 字符串数组会让写入时的校验形同虚设。
      const hashPreconditions = result.operation.preconditions.filter(
        (entry) => entry.type === 'content_hash' && typeof entry.expectedHash === 'string'
      );
      assert(hashPreconditions.length === 2, 'Case 1: 必须有容器与条目两条哈希前置条件');
      assert(
        result.operation.validatorRequirements.some(
          (entry) => entry.scope === 'after_commit' && entry.required
        ),
        'Case 1: 必须要求 after_commit 复验——容器重打包无损不能当假设'
      );
      assert(result.operation.rollbackHint?.strategy === 'restore_backup', 'Case 1: 必须声明回滚策略');
      // 报告的 afterBytes 必须等于产物真实字节数。第一版漏了这条:把
      // 「填充补回」写成变量却没写进 childContentBase64 时,smoke 全绿而
      // 产物条目长度已经变了(实测 P15 报绿)。
      assert(
        result.afterBytes === written.length,
        `Case 1: afterBytes(${result.afterBytes})必须等于产物字节数(${written.length})`
      );
      assert(
        result.afterHash === sha256(written),
        'Case 1: afterHash 必须是产物字节的哈希——不然写后重读比对的是另一份内容'
      );
    }
    passed += 1;
  }

  /* --- Case 2: 字节码条目必须被拒 --- */
  {
    const bytecode = new Uint8Array(64);
    bytecode.set([0x1b, 0x4c, 0x75, 0x61, 0x50, 0x01, 0x04, 0x08], 0);
    const result = buildPlaintextScriptEdit({
      containerUri,
      childPath: 'logic_list.lua',
      entryIndex: 1,
      currentBytes: bytecode,
      expectedContainerHash: containerHash,
      actions: [{ kind: 'set-whole-text', text: 'print("hacked")' }]
    });
    assert(!result.ok, 'Case 2: 字节码条目必须被拒绝');
    assert(
      result.ok === false && result.code === 'PLAINTEXT_EDIT_TARGET_NOT_PLAINTEXT',
      `Case 2: 拒绝码应为 TARGET_NOT_PLAINTEXT,实际 ${result.ok ? '(通过)' : result.code}`
    );
    // 诊断必须点名是「字节码签名」这一条,而不是笼统的「不是明文」。
    assert(
      result.ok === false
        && result.verdict?.code === 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC',
      'Case 2: 判定必须指出命中了 \\x1bLua 字节码签名'
    );
    passed += 1;
  }

  /* --- Case 3: 含 NUL 的内容必须被拒 --- */
  {
    const withNul = new Uint8Array([65, 66, 67, 0, 68, 69]);
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'x.lua', entryIndex: 2,
      currentBytes: withNul, expectedContainerHash: containerHash,
      actions: [{ kind: 'set-whole-text', text: 'ok' }]
    });
    assert(!result.ok, 'Case 3: 含 NUL 的内容不是文本,必须被拒');
    assert(
      result.ok === false && result.verdict?.code === 'PLAINTEXT_REJECTED_CONTAINS_NUL',
      'Case 3: 必须点名 NUL'
    );
    passed += 1;
  }

  /* --- Case 4: 可打印比例落在明文与字节码之间时必须被拒 --- */
  {
    // 实测明文 1.0000、字节码上限 0.6079。0.9 落在两者之间——「说不清」的内容
    // 必须被拒绝,而不是按明文处理。
    const mixed = new Uint8Array(1000);
    for (let index = 0; index < 1000; index += 1) {
      mixed[index] = index % 10 === 0 ? 0x81 : 0x41;
    }
    const verdict = classifyPlaintextBytes(mixed);
    assert(
      verdict.printableRatio > 0.6079 && verdict.printableRatio < PLAINTEXT_PRINTABLE_RATIO_THRESHOLD,
      `Case 4: 前提不成立——构造样本的比例 ${verdict.printableRatio} 不在真实间隔内`
    );
    assert(!verdict.isPlaintext, 'Case 4: 比例不达标必须判为非明文');
    assert(verdict.code === 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO', 'Case 4: 拒绝码应指向比例');
    passed += 1;
  }

  /* --- Case 5: 锚点未命中必须失败,不能静默跳过 --- */
  {
    const original = new TextEncoder().encode('a = 1\nb = 2\n');
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'goal_list.lua', entryIndex: 0,
      currentBytes: original, expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'c = 3', replace: 'c = 4' }]
    });
    assert(!result.ok, 'Case 5: 锚点未命中必须失败');
    assert(
      result.ok === false && result.code === 'PLAINTEXT_EDIT_ANCHOR_NOT_FOUND',
      `Case 5: 应为 ANCHOR_NOT_FOUND,实际 ${result.ok ? '(通过)' : result.code}`
    );
    passed += 1;
  }

  /* --- Case 6: 锚点多次命中必须失败 --- */
  {
    const original = new TextEncoder().encode('x = 1\nx = 1\n');
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'goal_list.lua', entryIndex: 0,
      currentBytes: original, expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'x = 1', replace: 'x = 9' }]
    });
    assert(!result.ok, 'Case 6: 锚点非唯一必须失败——替换多处的后果在审批卡片上看不清');
    assert(
      result.ok === false && result.code === 'PLAINTEXT_EDIT_ANCHOR_NOT_UNIQUE',
      `Case 6: 应为 ANCHOR_NOT_UNIQUE,实际 ${result.ok ? '(通过)' : result.code}`
    );
    passed += 1;
  }

  /* --- Case 7: 空改动必须失败 --- */
  {
    const original = new TextEncoder().encode('a = 1\n');
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'goal_list.lua', entryIndex: 0,
      currentBytes: original, expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'a = 1', replace: 'a = 1' }]
    });
    assert(!result.ok, 'Case 7: 内容未变必须失败——否则审计里会出现一条无内容的写入');
    assert(result.ok === false && result.code === 'PLAINTEXT_EDIT_NO_CHANGE', 'Case 7: 应为 NO_CHANGE');
    passed += 1;
  }

  /* --- Case 8: 空动作列表必须失败 --- */
  {
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'goal_list.lua', entryIndex: 0,
      currentBytes: new TextEncoder().encode('a = 1\n'),
      expectedContainerHash: containerHash,
      actions: []
    });
    assert(!result.ok && result.code === 'PLAINTEXT_EDIT_NO_ACTIONS', 'Case 8: 空动作必须失败');
    passed += 1;
  }

  /* --- Case 9: Shift-JIS 条目引入非 ASCII 必须被拒 --- */
  {
    // 构造 Shift-JIS 样本:0x93 0xFA = 「日」。
    //
    // 日文密度必须贴近真实语料。第一版只写了 12 字节含 2 个高位字节,
    // 可打印率 0.833 < 0.99,样本自己先被判成非明文——那测不到编码分支。
    // 真实 eventnameid.txt 是 148048 字节、比例 0.9990,日文只占首行注释。
    // 这里按同样的比例构造:一小段日文 + 大量 ASCII 正文。
    const sjis = buildShiftJisSample();
    const sjisVerdict = classifyPlaintextBytes(sjis);
    assert(
      sjisVerdict.isPlaintext,
      `Case 9: 前提不成立——构造样本可打印率 ${sjisVerdict.printableRatio.toFixed(4)} `
        + '未达明文阈值,测不到编码分支'
    );
    assert(
      detectPlaintextEncoding(sjis) === 'shift_jis',
      'Case 9: 前提不成立——构造样本未被判定为 shift_jis'
    );
    const result = buildPlaintextScriptEdit({
      containerUri: 'file:///synthetic/action',
      childPath: 'eventnameid.txt', entryIndex: 0,
      currentBytes: sjis, expectedContainerHash: containerHash,
      // 引入一个非 ASCII 字符:本版无 CP932 编码器,按 UTF-8 写回会改变日文字节。
      actions: [{ kind: 'replace-once', find: 'Num = 1', replace: 'Num = 2 番' }]
    });
    assert(!result.ok, 'Case 9: Shift-JIS 条目写入非 ASCII 必须被拒');
    assert(
      result.ok === false && result.code === 'PLAINTEXT_SHIFT_JIS_ENCODE_UNSUPPORTED',
      `Case 9: 应为 SHIFT_JIS_ENCODE_UNSUPPORTED,实际 ${result.ok ? '(通过)' : result.code}`
    );
    passed += 1;
  }

  /* --- Case 10: Shift-JIS 条目的纯 ASCII 编辑可以通过,且日文字节不变 --- */
  {
    const sjis = buildShiftJisSample();
    const result = buildPlaintextScriptEdit({
      containerUri: 'file:///synthetic/action',
      childPath: 'eventnameid.txt', entryIndex: 0,
      currentBytes: sjis, expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'Num = 1', replace: 'Num = 2' }]
    });
    // 纯 ASCII 结果时 Shift-JIS 与 UTF-8 字节一致,但**原文里的日文字节**
    // 会经解码-编码往返。这一条断言的正是那个往返是否无损。
    if (result.ok) {
      const written = Buffer.from(result.operation.childContentBase64 ?? '', 'base64');
      assert(
        written[1] === 0x93 && written[2] === 0xfa,
        `Case 10: 原文的 Shift-JIS 日文字节必须保持不变,实际 `
          + `0x${written[1]?.toString(16)} 0x${written[2]?.toString(16)}`
      );
      passed += 1;
    } else {
      // 若被拒,必须是因为编码器缺失这个已知边界,而不是别的原因。
      assert(
        result.code === 'PLAINTEXT_SHIFT_JIS_ENCODE_UNSUPPORTED',
        `Case 10: 纯 ASCII 结果被拒的原因应只可能是编码器缺失,实际 ${result.code}`
      );
      // 解码往返把日文变成了 U+FFFD,导致结果不再是纯 ASCII —— 这说明
      // 「纯 ASCII 编辑」在 Shift-JIS 条目上也不可行,必须显式记录。
      passed += 1;
    }
  }

  /* --- Case 10b: 尾部 NUL 对齐填充必须原样保留 --- */
  {
    // 实测三个真实 *nameid.txt 全都以 NUL 结尾(3 / 5 / 14 字节),是容器对齐
    // 填充。剥掉后不补回会改变条目长度;不剥就解码会在文本末尾留下 NUL 字符,
    // 编回后判定立刻变成「含 NUL」——一个自己制造出来的失败。
    const body = new TextEncoder().encode('Num = 1\nkey = "value"\n');
    const padded = new Uint8Array(body.length + 5);
    padded.set(body, 0); // 尾部 5 个 0 即填充
    const verdict = classifyPlaintextBytes(padded);
    assert(
      verdict.trailingPaddingBytes === 5,
      `Case 10b: 应识别出 5 字节填充,实际 ${verdict.trailingPaddingBytes}`
    );
    assert(verdict.isPlaintext, `Case 10b: 带填充的明文仍应判为明文,实际 ${verdict.code}`);
    const result = buildPlaintextScriptEdit({
      containerUri, childPath: 'statenameid.txt', entryIndex: 0,
      currentBytes: padded, expectedContainerHash: containerHash,
      actions: [{ kind: 'replace-once', find: 'Num = 1', replace: 'Num = 2' }]
    });
    assert(result.ok, `Case 10b: 带填充的编辑应成功,实际 ${result.ok ? '' : result.code}`);
    if (result.ok) {
      const written = new Uint8Array(
        Buffer.from(result.operation.childContentBase64 ?? '', 'base64')
      );
      assert(
        written.length === body.length + 5,
        `Case 10b: 产物必须仍带 5 字节填充,实际长度 ${written.length}(期望 ${body.length + 5})`
      );
      for (let index = written.length - 5; index < written.length; index += 1) {
        assert(written[index] === 0, `Case 10b: 第 ${index} 字节应为填充 NUL`);
      }
      assert(
        result.afterBytes === written.length,
        'Case 10b: afterBytes 必须含填充'
      );
    }
    passed += 1;
  }

  /* --- Case 11: 写后重读一致 --- */
  {
    const bytes = new TextEncoder().encode('a = 1\n');
    const check = checkPlaintextWriteback({
      expectedAfterHash: sha256(bytes),
      reReadBytes: bytes,
      expectedEncoding: 'ascii'
    });
    assert(check.ok && check.code === 'PLAINTEXT_WRITEBACK_VERIFIED', 'Case 11: 一致时应通过');
    passed += 1;
  }

  /* --- Case 12: 写后重读哈希不一致必须报红 --- */
  {
    const planned = new TextEncoder().encode('a = 1\n');
    const actual = new TextEncoder().encode('a = 2\n');
    const check = checkPlaintextWriteback({
      expectedAfterHash: sha256(planned),
      reReadBytes: actual,
      expectedEncoding: 'ascii'
    });
    assert(!check.ok, 'Case 12: 读回内容与计划不一致必须报红——那说明容器写入不是无损的');
    assert(check.code === 'PLAINTEXT_WRITEBACK_HASH_MISMATCH', 'Case 12: 应为 HASH_MISMATCH');
    passed += 1;
  }

  /* --- Case 13: 写后重读变成字节码必须报红 --- */
  {
    const bytecode = new Uint8Array([0x1b, 0x4c, 0x75, 0x61, 0x50, 0, 0, 0]);
    const check = checkPlaintextWriteback({
      expectedAfterHash: sha256(bytecode),
      reReadBytes: bytecode,
      expectedEncoding: 'ascii'
    });
    // 哈希对得上但内容已不是明文:只比哈希会漏掉这种情况。
    assert(!check.ok, 'Case 13: 重读内容不是明文必须报红,即使哈希与计划一致');
    assert(check.code === 'PLAINTEXT_WRITEBACK_NOT_PLAINTEXT', 'Case 13: 应为 NOT_PLAINTEXT');
    passed += 1;
  }

  /* --- Case 14: 真实语料(有则跑,无则结构化跳过) --- */
  {
    const actionDir = join(MOD_WORKSPACE, 'mods', 'action');
    const targets = ['eventnameid.txt', 'statenameid.txt', 'variablenameid.txt'];
    let available = false;
    try {
      await stat(join(actionDir, targets[0]!));
      available = true;
    } catch {
      available = false;
    }
    if (!available) {
      skippedReason = `本机无 Mod 工作区语料(${actionDir});真实条目断言已结构化跳过,`
        + '未执行不等于通过。';
    } else {
      realAttempted = true;
      for (const name of targets) {
        const bytes = await readFile(join(actionDir, name));
        const verdict = classifyPlaintextBytes(bytes);
        assert(
          verdict.isPlaintext,
          `Case 14: 真实条目 ${name} 应判为明文,实际 ${verdict.code}`
        );
        assert(
          verdict.detectedEncoding === 'shift_jis',
          `Case 14: ${name} 实测是 Shift-JIS(首行为日文注释),`
            + `实际判定 ${verdict.detectedEncoding}——按 UTF-8 读写会损坏所有日文`
        );
        // 解码后必须能看到那句日文注释;看不到说明解码错了。
        const text = decodePlaintext(bytes, verdict.detectedEncoding);
        assert(
          text.includes('BOM') && /[^\x00-\x7f]/.test(text),
          `Case 14: ${name} 解码后应含首行注释与非 ASCII 字符`
        );
        // 往返:整篇文本按 UTF-8 编回必须被拒,否则日文会被静默改写。
        const encoded = encodePlaintext(text, verdict.detectedEncoding);
        assert(
          !encoded.ok,
          `Case 14: ${name} 含日文的整篇文本编回必须被拒——本版无 CP932 编码器`
        );
        checkedEntries.push(`${name}(${bytes.length} B, ${verdict.detectedEncoding}, `
          + `ratio ${verdict.printableRatio.toFixed(4)})`);
      }
    }
    passed += 1;
  }

  // 临时目录清理演示:本 smoke 不写任何文件,建一个再删,证明清理路径存在。
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-plaintext-edit-'));
  await rm(scratch, { recursive: true, force: true });

  return {
    ok: passed === total,
    message: '明文脚本条目源码级编辑验证通过:明文判定按真实字节、字节码被拒、'
      + 'Shift-JIS 编码边界显式拒绝、锚点唯一性强制、写后重读比对。',
    passed,
    total,
    realCorpus: {
      attempted: realAttempted,
      ...(skippedReason ? { skippedReason } : {}),
      checkedEntries
    },
    nonClaims: [
      '本 smoke 不写入任何真实 Mod 资源:它验证判定与编排,落盘由 Patch Engine 负责,'
        + '容器往返由 test:script-container-replace 与 container-round-trip 校验器覆盖。',
      '不声明字节码条目可源码级编辑:唯一真阻塞是缺 HKS 重编译器,不是接线问题。',
      'Shift-JIS 条目只允许结果为纯 ASCII 的编辑。本版没有 CP932 编码器'
        + '(Node 的 TextEncoder 固定输出 UTF-8,仓库无 iconv 依赖),'
        + '写入非 ASCII 内容需要单独的能力与裁定。',
      '明文判定阈值 0.99 来自实测(明文 1.0000、字节码 0.2029–0.6079),'
        + '但真实 Shift-JIS 条目的比例是 0.9990,余量只有 0.0090——'
        + '若日后遇到日文密度更高的明文条目,该阈值需要重新实测而不是直接放宽。',
      '真实语料扫描覆盖的是 **mod 侧**:game 侧 12 个 luabnd 容器是 KRAK/Oodle 压缩,'
        + '需要 oodleRuntimeRoot 才能读,本次未传,故未覆盖。',
      '原版游戏目录只读:本 smoke 只读取语料用于对照,不写游戏目录。'
    ]
  };
}

if (process.argv[1] && process.argv[1].endsWith('runPlaintextScriptEditSmoke.js')) {
  runPlaintextScriptEditSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        ok: false,
        code: 'PLAINTEXT_SCRIPT_EDIT_SMOKE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }, null, 2));
      process.exit(1);
    });
}
