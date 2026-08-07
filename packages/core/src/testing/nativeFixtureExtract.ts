import type { Diagnostic } from '@soulforge/shared';

/**
 * 判定「容器子项提取失败」属于缺语料还是环境/基础设施错误。
 *
 * 为什么需要它：TPF 与 TAE 两个 smoke 原先都写
 *   if (extract.parseStatus === 'failed' || !extract.data?.contentSize) → status: 'skipped'
 * 于是 allowedRoot 无效、writableRoots 拒写、daemon 握手失败这类**基础设施错误**
 * 也被算作「fixture 不可用」跳过，退出码与输出都与真正缺语料一模一样。
 * 实测：本机无 mods 目录时 TPF smoke 输出
 *   {"ok":true,"status":"skipped","diagnostics":["BRIDGE_ALLOWED_ROOT_INVALID"]}
 * ——把「环境根本不对」报成了「语料不在」。这违反硬约束 7（skipped / failed /
 * unsupported 必须严格区分），后果是环境坏掉时整条 native 链静默「通过」。
 *
 * 判定方式与它的局限：extract-bnd4-child 的**所有**失败在 C# 侧都归到同一个
 * 诊断码 BND4_CHILD_EXTRACT_FAILED（BridgeCommandService.cs:112），无法按码区分，
 * 因此只能按 message 判定。**默认失败关闭**——只有明确匹配到子项定位失败的那两句
 * 才当缺语料。方向选择的理由：错判成 failed 只是多一次人工排查；错判成 skipped
 * 会让环境错误静默通过，那是不可接受的一侧。
 *
 * 若将来 bridge 给「子项不存在」单独分配诊断码，应把这里换成按码判定。
 */
const MISSING_CHILD_MESSAGE = /childPath 必须唯一匹配|entryIndex 越界/;

export interface ExtractOutcome {
  parseStatus?: string;
  data?: { contentSize?: number } | undefined;
  diagnostics?: Diagnostic[] | undefined;
}

export type ExtractVerdict =
  | { kind: 'ok' }
  | { kind: 'missing-child'; codes: string[] }
  | { kind: 'infrastructure-failure'; parseStatus: string | undefined; diagnostics: Diagnostic[] };

export function classifyChildExtract(extract: ExtractOutcome): ExtractVerdict {
  const failed = extract.parseStatus === 'failed' || !extract.data?.contentSize;
  if (!failed) return { kind: 'ok' };

  const diagnostics = extract.diagnostics ?? [];
  const joined = diagnostics.map((d) => d.message ?? '').join(' | ');
  if (MISSING_CHILD_MESSAGE.test(joined)) {
    return { kind: 'missing-child', codes: diagnostics.map((d) => d.code) };
  }
  return { kind: 'infrastructure-failure', parseStatus: extract.parseStatus, diagnostics };
}

/**
 * 把 infrastructure-failure 判决写成结构化失败输出并设置退出码。
 * 调用方负责随后释放 bridge 资源并 return。
 */
export function reportInfrastructureFailure(
  label: string,
  code: string,
  verdict: Extract<ExtractVerdict, { kind: 'infrastructure-failure' }>
): void {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code,
    message: `${label} 子项提取失败，且诊断不是「容器内无此子项」——按环境/基础设施错误`
      + '失败关闭，不当成缺语料跳过（硬约束 7：skipped 与 failed 必须严格区分）。',
    parseStatus: verdict.parseStatus,
    diagnostics: verdict.diagnostics
  }, null, 2));
  process.exitCode = 1;
}
