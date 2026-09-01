/**
 * 明文脚本条目的源码级编辑编排。
 *
 * 用户裁定(2026-08-08)给 SCOPE-BEHAVIOR-SCRIPT 开了
 * `source-level-edit-plaintext-script-entries`,范围严格限于**实测确认为明文**
 * 的条目；306 个字节码条目仍只许整文件替换（当前没有 HKS 重编译器）。
 *
 * ── 为什么不新建 writer ──
 *
 * 源码级编辑不是一条新的写路径,它是「读明文 → 改文本 → 编回字节 → 走既有
 * container_child_replace」。既有 ContainerChildReplaceWriter 已经带
 * expectedContainerHash / expectedChildHash 前置条件、只写暂存区、
 * 并在 staging 后经 Bridge 观测。另建一条写路径等于绕过那些保证,
 * 也违反硬约束「所有 Mod 资源写入必须经 Patch Engine」。
 *
 * 本模块只做三件事,一件都不落到磁盘:
 *   ① 拿真实字节判定目标条目是不是明文(拒绝字节码,不看文件名);
 *   ② 按声明的编辑动作产出新文本,并用同一编码编回字节;
 *   ③ 产出带哈希前置条件的 PatchIR 操作,交给 Patch Engine。
 *
 * 读取源字节的容器路径由调用方给出,本模块不写它;产出的操作只描述
 * 当前打开工作区里的目标。写入闸门由 Patch Engine 与 allowedRoots 强制,
 * 本模块不重复实现,也不提供任何绕过参数。
 */

import { createHash } from 'node:crypto';
import type { ContainerChildOp, StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import {
  classifyPlaintextBytes,
  decodePlaintext,
  encodePlaintext,
  type PlaintextEncoding,
  type PlaintextVerdict
} from './plaintextScriptEntry.js';

/* ------------------------------------------------------------------ */
/*  编辑动作                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次源码级编辑动作。
 *
 * `replace-once` 要求 `find` 在原文里**恰好出现一次**。不提供
 * 「替换全部」:一个在文件里出现 40 次的字符串,替换全部的后果无法在审批
 * 卡片上被看清,而看不清的改动不该被批准。要改多处就发多条动作,每条各自
 * 带上足以唯一定位的上下文。
 *
 * `set-whole-text` 是整条目文本替换。它仍然经明文判定与编码校验,
 * 与「整文件字节替换」的区别是:后者可用于字节码,前者只用于明文且保编码。
 */
export type PlaintextEditAction =
  | { kind: 'replace-once'; find: string; replace: string }
  | { kind: 'set-whole-text'; text: string }
  /**
   * 纯 ASCII 字节级替换:`find` 与 `replace` 都必须是纯 ASCII,替换在**字节**层
   * 完成,不做整篇解码-编码往返。
   *
   * 为什么需要这条路径:混合编码条目(既非 UTF-8 也非完整 Shift-JIS)此前被
   * 一律拒绝,理由是「任何单一编码的往返都会丢字节」。那个理由只对**整篇往返**
   * 成立 —— 实测 801000_battle.lua 有 2740 行纯 ASCII、仅 6 行含非 ASCII,
   * 在纯 ASCII 区域做字节替换后 52 个非 ASCII 字节**完全不变**。
   *
   * 也就是说文件本身可以无损编辑,是我的实现强制了往返。区别在于:解码是
   * 为了「按文本理解内容」,而改一处 `act[26] = 100` 并不需要理解那 6 行日文/中文
   * 注释 —— 不碰就不必解得开。
   */
  | { kind: 'replace-ascii-bytes'; find: string; replace: string };

export interface PlaintextScriptEditInput {
  /** 外层容器 URI(用于 PatchIR 溯源)。 */
  containerUri: string;
  /** 条目名(BND4 内层名的 basename)。 */
  childPath: string;
  /** 条目在 BND4 条目表里的索引。 */
  entryIndex: number;
  /** 条目当前的真实字节。必须由调用方经 Bridge 取得,不是猜的。 */
  currentBytes: Uint8Array;
  /** 外层容器文件当前 sha256,作为写入前置条件。 */
  expectedContainerHash: string;
  /** 容器格式标记(如 DCX-DFLT->BND4),透传给 writer。 */
  containerFormat?: string;
  actions: PlaintextEditAction[];
}

export type PlaintextScriptEditResult =
  | {
      ok: true;
      operation: ContainerChildOp;
      verdict: PlaintextVerdict;
      encoding: PlaintextEncoding;
      /** 编辑前后的字节数,供审批卡片显示改动规模。 */
      beforeBytes: number;
      afterBytes: number;
      /** 编辑前后的 sha256;afterHash 用于写后重读比对。 */
      beforeHash: string;
      afterHash: string;
      appliedActions: number;
      diagnostics: StructuredDiagnostic[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      /** 判定结果在失败时也返回:调用方需要知道「为什么不算明文」。 */
      verdict?: PlaintextVerdict;
      diagnostics: StructuredDiagnostic[];
    };

function fail(
  code: string,
  message: string,
  extra: { verdict?: PlaintextVerdict; diagnostics?: StructuredDiagnostic[] } = {}
): PlaintextScriptEditResult {
  return {
    ok: false,
    code,
    message,
    ...(extra.verdict ? { verdict: extra.verdict } : {}),
    diagnostics: [
      ...(extra.diagnostics ?? []),
      createDiagnostic({ severity: 'error', code, message })
    ]
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 产出一条源码级编辑的 PatchIR 操作。
 *
 * 不写任何文件。返回的操作要交给 Patch Engine 才会落到暂存区。
 */
export function buildPlaintextScriptEdit(
  input: PlaintextScriptEditInput
): PlaintextScriptEditResult {
  if (input.actions.length === 0) {
    return fail(
      'PLAINTEXT_EDIT_NO_ACTIONS',
      '没有提供任何编辑动作。空编辑不产出操作 —— 一个什么都不改的补丁'
        + '会占用审批与提交流程,却没有任何内容可供审查。'
    );
  }

  // ① 明文判定。用真实字节,不看文件名 —— 文件名可以对得上而内容是字节码
  // (mod 作者完全可能把编译产物塞成同名条目)。
  const verdict = classifyPlaintextBytes(input.currentBytes);
  if (!verdict.isPlaintext) {
    return fail(
      'PLAINTEXT_EDIT_TARGET_NOT_PLAINTEXT',
      `条目 ${input.childPath} 的真实字节不是明文(${verdict.code})。`
        + ' 源码级编辑只适用于明文条目;字节码条目请用整文件替换。',
      { verdict, diagnostics: verdict.diagnostics }
    );
  }

  // 全部动作都是纯 ASCII 字节替换时走字节级路径,完全不解码。
  //
  // 这条分支让混合编码条目也能改:解码只是为了「按文本理解内容」,而改一处
  // `act[26] = 100` 不需要理解那 6 行日文/中文注释。不碰就不必解得开。
  const allAsciiByteActions = input.actions.every(
    (action) => action.kind === 'replace-ascii-bytes'
  );
  if (allAsciiByteActions) {
    return buildAsciiByteEdit(input, verdict);
  }
  if (input.actions.some((action) => action.kind === 'replace-ascii-bytes')) {
    return fail(
      'PLAINTEXT_EDIT_MIXED_ACTION_KINDS',
      'replace-ascii-bytes 不能与文本级动作混用:前者在字节层工作、不解码,'
        + '后者需要整篇解码。混用会让「哪些字节被解码过」变得无法回答。'
        + ' 请拆成两次编辑。'
    );
  }

  const beforeHash = sha256(input.currentBytes);
  // 尾部 NUL 对齐填充不属于文本,解码前剥掉、编回后原样补上。
  // 实测三个 action/*nameid.txt 全都有(3 / 5 / 14 字节);把填充当文本解码
  // 会在文本末尾留下 NUL 字符,编回后判定立刻变成「含 NUL」——一个自己
  // 制造出来的失败。
  const paddingLength = verdict.trailingPaddingBytes;
  const contentBytes = paddingLength > 0
    ? input.currentBytes.subarray(0, input.currentBytes.length - paddingLength)
    : input.currentBytes;
  const originalText = decodePlaintext(contentBytes, verdict.detectedEncoding);

  // ② 应用动作。
  let text = originalText;
  for (const [position, action] of input.actions.entries()) {
    if (action.kind === 'set-whole-text') {
      text = action.text;
      continue;
    }
    if (action.find === '') {
      return fail(
        'PLAINTEXT_EDIT_EMPTY_FIND',
        `第 ${position + 1} 条动作的 find 为空串。空串会匹配任意位置,`
          + '定位不到具体内容。'
      );
    }
    const first = text.indexOf(action.find);
    if (first < 0) {
      return fail(
        'PLAINTEXT_EDIT_ANCHOR_NOT_FOUND',
        `第 ${position + 1} 条动作的 find 在当前内容里找不到:`
          + `${JSON.stringify(truncateForMessage(action.find))}。`
          + ' 锚点未命中必须失败,不能静默跳过 —— 静默跳过会让「改了但没生效」'
          + '看起来像成功。'
      );
    }
    const second = text.indexOf(action.find, first + action.find.length);
    if (second >= 0) {
      return fail(
        'PLAINTEXT_EDIT_ANCHOR_NOT_UNIQUE',
        `第 ${position + 1} 条动作的 find 出现多次(至少在偏移 ${first} 与 `
          + `${second} 各一次)。replace-once 要求唯一命中:替换多处的后果`
          + '无法在审批卡片上被看清,而看不清的改动不该被批准。'
          + ' 请补足上下文让锚点唯一,或对每一处各发一条动作。'
      );
    }
    text = `${text.slice(0, first)}${action.replace}${text.slice(first + action.find.length)}`;
  }

  if (text === originalText) {
    return fail(
      'PLAINTEXT_EDIT_NO_CHANGE',
      '编辑后内容与原文完全相同。空改动不产出操作 —— 它会走完审批与提交'
        + '流程却什么都没改,让审计里出现一条无内容的写入记录。',
      { verdict }
    );
  }

  // ③ 用**同一编码**编回。Shift-JIS 条目在结果含非 ASCII 时会在这里被拒,
  // Shift-JIS 走由解码器反推的 CP932 表;表里没有的字符会被拒而不是替换。
  const encoded = encodePlaintext(text, verdict.detectedEncoding);
  if (!encoded.ok) {
    return fail(encoded.code, encoded.message, {
      verdict,
      diagnostics: encoded.diagnostics
    });
  }

  // 补回尾部对齐填充,保持与原条目相同的收尾形态。
  const finalBytes = paddingLength > 0
    ? concatBytes(encoded.bytes, new Uint8Array(paddingLength))
    : encoded.bytes;

  // 编回后必须再验一次:编辑可能引入 NUL 或把内容变成看起来像字节码的东西。
  // 不复验等于让「写入的内容是否仍是明文」这件事只靠输入方自觉。
  const afterVerdict = classifyPlaintextBytes(finalBytes);
  if (!afterVerdict.isPlaintext) {
    return fail(
      'PLAINTEXT_EDIT_RESULT_NOT_PLAINTEXT',
      `编辑结果不再是明文(${afterVerdict.code})。写入会把一个明文条目`
        + '变成无法再被源码级编辑的东西。',
      { verdict: afterVerdict, diagnostics: afterVerdict.diagnostics }
    );
  }

  const afterHash = sha256(finalBytes);
  const childUri = `${input.containerUri}#bnd/child/${input.childPath}`;
  // 显式构造完整的 ContainerChildOp,不用 `as` 断言。
  // 第一版曾把 preconditions 写成字符串数组,而契约要的是结构化对象 ——
  // `as ContainerChildOp` 会让那个错误编译通过,写入时前置条件形同虚设。
  const operation: ContainerChildOp = {
    id: `plaintext-edit-${input.childPath}-${afterHash.slice(0, 12)}`,
    kind: 'container_child_replace',
    targetUri: childUri,
    resourceKind: 'other',
    containerUri: input.containerUri,
    childPath: input.childPath,
    childUri,
    childContentBase64: Buffer.from(finalBytes).toString('base64'),
    expectedContainerHash: input.expectedContainerHash,
    expectedChildHash: beforeHash,
    ...(input.containerFormat ? { containerFormat: input.containerFormat } : {}),
    preconditions: [
      {
        type: 'content_hash',
        description: '外层容器文件在写入前必须与计划时一致',
        expectedHash: input.expectedContainerHash,
        targetUri: input.containerUri
      },
      {
        type: 'content_hash',
        description: '目标条目字节在写入前必须与计划时一致',
        expectedHash: beforeHash,
        targetUri: childUri
      },
      {
        type: 'custom',
        description: '目标条目已按真实字节确认为明文(非 \\x1bLua 字节码、无 NUL、'
          + '可打印比例达标),且编辑结果仍为明文',
        details: {
          check: 'plaintext-verified',
          encoding: verdict.detectedEncoding,
          printableRatio: Number(verdict.printableRatio.toFixed(4)),
          resultPrintableRatio: Number(afterVerdict.printableRatio.toFixed(4))
        }
      }
    ],
    // after_commit 是这里的关键:容器写入要经 BND4 重打包与 DCX 压缩,
    // 「写进去的字节」与「再读出来的字节」中间隔着两层编解码。
    // 不要求提交后复验,等于把「重打包无损」当成假设。
    validatorRequirements: [
      { validatorId: 'container-round-trip', scope: 'after_commit', required: true },
      { validatorId: 'plaintext-writeback', scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'restore_backup',
      notes: '整个外层容器由 Patch Engine 备份;回滚恢复容器即可撤销本条编辑。'
    },
    // 高风险:目标是真实 Mod 资源里的脚本容器,写坏会让游戏加载失败。
    riskLevel: 'high',
    // 溯源:后续审计要能回答「这条写入凭什么被允许」。
    metadata: {
      sourceKind: 'plaintext-script-source-edit',
      entryIndex: input.entryIndex,
      encoding: verdict.detectedEncoding,
      printableRatio: Number(verdict.printableRatio.toFixed(4)),
      actionKinds: input.actions.map((action) => action.kind),
      expectedAfterHash: afterHash
    }
  };

  return {
    ok: true,
    operation,
    verdict,
    encoding: verdict.detectedEncoding,
    beforeBytes: input.currentBytes.length,
    afterBytes: finalBytes.length,
    beforeHash,
    afterHash,
    appliedActions: input.actions.length,
    diagnostics: [
      ...verdict.diagnostics,
      createDiagnostic({
        severity: 'info',
        code: 'PLAINTEXT_EDIT_PLANNED',
        message: `条目 ${input.childPath} 的源码级编辑已生成 PatchIR 操作:`
          + `${input.currentBytes.length} → ${finalBytes.length} 字节,`
          + `编码 ${verdict.detectedEncoding},${input.actions.length} 条动作。`
          + ' 尚未写入任何文件 —— 落盘由 Patch Engine 负责。'
      })
    ]
  };
}

function truncateForMessage(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

/** 纯 ASCII 判定:每个码位都 < 0x80。 */
function isPureAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) return false;
  }
  return true;
}

/**
 * 字节级 ASCII 替换。
 *
 * 不解码、不编码 —— 用 latin1 做字节↔字符的一一映射(latin1 是唯一保证
 * 每个字节映射到一个码位且可逆的编码),在其上做子串替换,再映射回字节。
 * 非 ASCII 字节全程只被复制,不被解释。
 *
 * 校验后置且强制:替换完必须确认所有 >= 0x80 的字节序列**逐个未变**。
 * 光靠「find/replace 是纯 ASCII」推不出这一点 —— 若 find 恰好跨越了某个
 * 多字节序列的一半,替换就会撕裂它。
 */
function buildAsciiByteEdit(
  input: PlaintextScriptEditInput,
  verdict: PlaintextVerdict
): PlaintextScriptEditResult {
  const beforeHash = sha256(input.currentBytes);
  const paddingLength = verdict.trailingPaddingBytes;
  const contentBytes = paddingLength > 0
    ? input.currentBytes.subarray(0, input.currentBytes.length - paddingLength)
    : input.currentBytes;
  // latin1:字节 n ↔ 码位 n,一一对应且可逆。用 utf8 会破坏 >= 0x80 的字节。
  let latin = Buffer.from(contentBytes).toString('latin1');
  const originalLatin = latin;

  for (const [position, action] of input.actions.entries()) {
    if (action.kind !== 'replace-ascii-bytes') {
      return fail('PLAINTEXT_EDIT_MIXED_ACTION_KINDS', '内部错误:非字节级动作进入字节级路径。');
    }
    if (action.find === '') {
      return fail('PLAINTEXT_EDIT_EMPTY_FIND', `第 ${position + 1} 条动作的 find 为空串。`);
    }
    if (!isPureAscii(action.find) || !isPureAscii(action.replace)) {
      return fail(
        'PLAINTEXT_EDIT_ASCII_ONLY',
        `第 ${position + 1} 条动作的 find/replace 必须是纯 ASCII —— 字节级路径`
          + '不解码,无法判断非 ASCII 字符该编成哪些字节。'
          + '要写入非 ASCII 内容请用文本级动作(需目标编码可解)。'
      );
    }
    const first = latin.indexOf(action.find);
    if (first < 0) {
      return fail(
        'PLAINTEXT_EDIT_ANCHOR_NOT_FOUND',
        `第 ${position + 1} 条动作的 find 在字节流里找不到:`
          + `${JSON.stringify(truncateForMessage(action.find))}。`
      );
    }
    const second = latin.indexOf(action.find, first + action.find.length);
    if (second >= 0) {
      return fail(
        'PLAINTEXT_EDIT_ANCHOR_NOT_UNIQUE',
        `第 ${position + 1} 条动作的 find 在字节流里出现多次(偏移 ${first} 与 ${second})。`
          + ' 字节级替换同样要求唯一命中。'
      );
    }
    latin = `${latin.slice(0, first)}${action.replace}${latin.slice(first + action.find.length)}`;
  }

  if (latin === originalLatin) {
    return fail('PLAINTEXT_EDIT_NO_CHANGE', '编辑后字节与原文完全相同。', { verdict });
  }

  const editedBytes = new Uint8Array(Buffer.from(latin, 'latin1'));
  const finalBytes = paddingLength > 0
    ? concatBytes(editedBytes, new Uint8Array(paddingLength))
    : editedBytes;

  // 非 ASCII 字节序列必须逐个未变。
  //
  // ── 这是纵深防御,当前无法从公开 API 触发(实测)──
  //
  // 上面的 isPureAscii 已保证 find/replace 全是 ASCII 码位,而在 latin1 字节流里
  // 纯 ASCII 的 find 只能匹配纯 ASCII 字节 —— 想撕裂某个多字节序列,find 就必须
  // 含 >= 0x80 的码位,那会先被 ASCII_ONLY 拦下。实测三种尝试(纯 ASCII find、
  // 跨换行的纯 ASCII find、含 latin1 高位字符的 find)都无法让这条校验报错。
  //
  // 保留它而不是删掉,理由是它防的是**未来的改动**:若日后放宽 isPureAscii、
  // 或把字节流改成别的编码取字符,撕裂就变得可能,而那时的症状是静默损坏。
  // 按「门禁必须能红」的口径,这条不算已验证的判据 —— 它没有专属负向用例,
  // 因为构造不出来。这一点如实记在这里,不假装它被测过。
  const originalHigh = [...contentBytes].filter((byte) => byte >= 0x80);
  const editedHigh = [...editedBytes].filter((byte) => byte >= 0x80);
  if (originalHigh.length !== editedHigh.length
    || originalHigh.some((byte, index) => byte !== editedHigh[index])) {
    return fail(
      'PLAINTEXT_EDIT_NON_ASCII_BYTES_CHANGED',
      `字节级替换改动了非 ASCII 字节(原 ${originalHigh.length} 个,`
        + `现 ${editedHigh.length} 个)。最可能的原因是 find 跨越了某个多字节`
        + '序列的一半,把它撕裂了。这条校验不能省:find 是纯 ASCII 并不保证'
        + '它落在字节边界上。'
    );
  }

  const afterHash = sha256(finalBytes);
  const childUri = `${input.containerUri}#bnd/child/${input.childPath}`;
  const operation: ContainerChildOp = {
    id: `plaintext-ascii-byte-edit-${input.childPath}-${afterHash.slice(0, 12)}`,
    kind: 'container_child_replace',
    targetUri: childUri,
    resourceKind: 'other',
    containerUri: input.containerUri,
    childPath: input.childPath,
    childUri,
    childContentBase64: Buffer.from(finalBytes).toString('base64'),
    expectedContainerHash: input.expectedContainerHash,
    expectedChildHash: beforeHash,
    ...(input.containerFormat ? { containerFormat: input.containerFormat } : {}),
    preconditions: [
      {
        type: 'content_hash',
        description: '外层容器文件在写入前必须与计划时一致',
        expectedHash: input.expectedContainerHash,
        targetUri: input.containerUri
      },
      {
        type: 'content_hash',
        description: '目标条目字节在写入前必须与计划时一致',
        expectedHash: beforeHash,
        targetUri: childUri
      },
      {
        type: 'custom',
        description: '纯 ASCII 字节级替换:不解码,非 ASCII 字节逐个未变',
        details: {
          check: 'ascii-byte-edit',
          detectedEncoding: verdict.detectedEncoding,
          nonAsciiByteCount: originalHigh.length,
          trailingPaddingBytes: paddingLength
        }
      }
    ],
    validatorRequirements: [
      { validatorId: 'container-round-trip', scope: 'after_commit', required: true },
      { validatorId: 'plaintext-writeback', scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'restore_backup',
      notes: '整个外层容器由 Patch Engine 备份;回滚恢复容器即可撤销本条编辑。'
    },
    riskLevel: 'high',
    metadata: {
      sourceKind: 'plaintext-script-ascii-byte-edit',
      entryIndex: input.entryIndex,
      encoding: verdict.detectedEncoding,
      nonAsciiByteCount: originalHigh.length,
      actionKinds: input.actions.map((action) => action.kind),
      expectedAfterHash: afterHash
    }
  };

  return {
    ok: true,
    operation,
    verdict,
    encoding: verdict.detectedEncoding,
    beforeBytes: input.currentBytes.length,
    afterBytes: finalBytes.length,
    beforeHash,
    afterHash,
    appliedActions: input.actions.length,
    diagnostics: [
      ...verdict.diagnostics,
      createDiagnostic({
        severity: 'info',
        code: 'PLAINTEXT_ASCII_BYTE_EDIT_PLANNED',
        message: `条目 ${input.childPath} 的纯 ASCII 字节级编辑已生成 PatchIR 操作:`
          + `${input.currentBytes.length} → ${finalBytes.length} 字节,`
          + `编码判定 ${verdict.detectedEncoding}(未解码),`
          + `${originalHigh.length} 个非 ASCII 字节逐个未变。`
      })
    ]
  };
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/* ------------------------------------------------------------------ */
/*  写后重读校验                                                      */
/* ------------------------------------------------------------------ */

export interface PlaintextWritebackCheckInput {
  /** 计划阶段算出的目标 sha256。 */
  expectedAfterHash: string;
  /** 提交后经 Bridge 重新读回的条目字节。 */
  reReadBytes: Uint8Array;
  /** 计划阶段判定的编码;重读结果的编码必须一致。 */
  expectedEncoding: PlaintextEncoding;
}

export type PlaintextWritebackCheckResult = {
  ok: boolean;
  code: string;
  message: string;
  actualHash: string;
  actualEncoding: PlaintextEncoding;
  diagnostics: StructuredDiagnostic[];
};

/**
 * 写后重读比对。
 *
 * 为什么必须重读而不是相信 writer 的返回值:容器写入要经过 BND4 重打包与
 * DCX 压缩,「我写进去的字节」和「再读出来的字节」中间隔着两层编解码。
 * 只信 writer 回报成功,等于把「重打包是否无损」这件事当成假设。
 *
 * 编码也要复验:一个把 Shift-JIS 写成 UTF-8 的缺陷不会改变字节数级别的
 * 校验结果(哈希会变,但如果哈希算的是同一份错字节就发现不了),
 * 独立判一次编码能抓到「哈希对得上但内容语义已变」。
 */
export function checkPlaintextWriteback(
  input: PlaintextWritebackCheckInput
): PlaintextWritebackCheckResult {
  const actualHash = sha256(input.reReadBytes);
  const verdict = classifyPlaintextBytes(input.reReadBytes);
  const actualEncoding = verdict.detectedEncoding;

  if (!verdict.isPlaintext) {
    const code = 'PLAINTEXT_WRITEBACK_NOT_PLAINTEXT';
    const message = `重读回来的条目不再是明文(${verdict.code})。`
      + ' 容器重打包或压缩环节破坏了内容。';
    return {
      ok: false, code, message, actualHash, actualEncoding,
      diagnostics: [...verdict.diagnostics, createDiagnostic({ severity: 'error', code, message })]
    };
  }
  if (actualHash !== input.expectedAfterHash) {
    const code = 'PLAINTEXT_WRITEBACK_HASH_MISMATCH';
    const message = `重读字节的 sha256 与计划值不一致:期望 `
      + `${input.expectedAfterHash.slice(0, 16)}…,实际 ${actualHash.slice(0, 16)}…。`
      + ' 容器写入不是无损的 —— 写进去的和读出来的不是同一份内容。';
    return {
      ok: false, code, message, actualHash, actualEncoding,
      diagnostics: [createDiagnostic({ severity: 'error', code, message })]
    };
  }
  if (actualEncoding !== input.expectedEncoding) {
    const code = 'PLAINTEXT_WRITEBACK_ENCODING_CHANGED';
    const message = `重读内容的编码判定为 ${actualEncoding},计划时是 `
      + `${input.expectedEncoding}。编码改变意味着文本语义已变,`
      + '即使字节校验通过也不能接受。';
    return {
      ok: false, code, message, actualHash, actualEncoding,
      diagnostics: [createDiagnostic({ severity: 'error', code, message })]
    };
  }
  const code = 'PLAINTEXT_WRITEBACK_VERIFIED';
  const message = `写后重读一致:${input.reReadBytes.length} 字节,`
    + `sha256 ${actualHash.slice(0, 16)}…,编码 ${actualEncoding}。`;
  return {
    ok: true, code, message, actualHash, actualEncoding,
    diagnostics: [createDiagnostic({ severity: 'info', code, message })]
  };
}
