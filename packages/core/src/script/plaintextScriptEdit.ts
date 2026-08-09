/**
 * 明文脚本条目的源码级编辑编排。
 *
 * 用户裁定(2026-08-08)给 SCOPE-BEHAVIOR-SCRIPT 开了
 * `source-level-edit-plaintext-script-entries`,范围严格限于**实测确认为明文**
 * 的条目;306 个字节码条目仍只许整文件替换(V0.5 无 HKS 重编译器)。
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
 * ── 游戏目录只读 ──
 *
 * 读取源字节的容器路径由调用方给出,本模块不写它;产出的操作只描述
 * Mod 侧目标。原版游戏目录永远只读这条硬约束由 Patch Engine 与
 * allowedRoots 共同强制,本模块不重复实现,也不提供任何绕过参数。
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
  | { kind: 'set-whole-text'; text: string };

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
  // 那是真实边界(本版无 CP932 编码器),不是可以绕过的检查。
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
