/**
 * me3 启动门槛的纯判定。
 *
 * 单独成模块而不是留在 Me3RuntimePanel 里，理由是它必须可单测：
 * scope.json 的 SCOPE-RUNTIME 把 `launch-with-missing-or-ambiguous-capability`
 * 列为 unsupportedOperations，而 launchMe3 会**真实启动零售游戏**——误启动的代价
 * 是用户存档与反作弊风险。这条判定是那道红线在 renderer 侧的唯一执行点，
 * 没有断言就等于没有红线。
 *
 * 判定顺序即优先级：先答「探测过没有」，再答「探测说能不能」，再答「前置齐没齐」。
 * 返回 null 表示可启动；返回字符串是**给用户看的禁用原因**——只把按钮变灰会让
 * 用户不知道差什么，那是 anti-ai-design 的状态优先原则要求回答的问题之一。
 */

export interface Me3LaunchGuardInput {
  /** detectMe3 的结论；null 表示尚未探测。 */
  capability: {
    state: string;
    canLaunch: boolean;
  } | null;
  /** prepareMe3Profile 产出的 profileId；null 表示尚未准备。 */
  profileId: string | null;
  /** 用户是否显式确认启动零售游戏。 */
  launchConfirmed: boolean;
  /** 是否有其他运行时操作正在进行。 */
  busy: boolean;
}

/**
 * @returns null 表示允许启动；否则返回禁用原因（面向用户的中文说明）。
 */
export function me3LaunchBlocker(input: Me3LaunchGuardInput): string | null {
  const { capability, profileId, launchConfirmed, busy } = input;

  // 未探测就禁——scope 明禁「能力探测缺失时启动」。这一条必须在 canLaunch 之前，
  // 因为 capability 为 null 时读不到 canLaunch，而「读不到」本身就是缺失。
  if (capability === null) return '尚未探测 me3 运行时';

  // 探测说不能启动就禁。刻意判 `!== true` 而不是 `=== false`：
  // 若上游因字段缺失把 canLaunch 传成 undefined，那是**含糊**而不是「可以」，
  // 同样落在 scope 禁止的 ambiguous-capability 里。
  if (capability.canLaunch !== true) {
    return `能力探测未确认可启动（state=${capability.state}，canLaunch=false）`;
  }

  if (profileId === null) return '尚未准备 profile';
  if (!launchConfirmed) return '需勾选确认后才能启动零售游戏';
  if (busy) return '有操作正在进行';
  return null;
}
