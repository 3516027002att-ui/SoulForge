/**
 * 「诊断里不得泄漏绝对本机路径」这条判据的共享实现。
 *
 * 为什么需要它：仓库里有 4 处写成
 *   if (JSON.stringify(diagnostics).includes(root)) throw ...
 * 而在 Windows 上这个判据**恒假**——JSON.stringify 会把路径分隔符 `\` 转义成
 * `\\`，序列化结果里根本不存在与 `root` 字面相同的子串。实测：
 *   root = 'C:\\Users\\...\\sf-probe'
 *   诊断 message 确实包含 root                       → true
 *   JSON.stringify(diagnostics).includes(root)        → false   ← 判据失效
 * 也就是说：**真的泄漏了绝对路径，门禁照样报绿**。这是安全面的假判据
 * （脱敏是硬约束的一部分，泄漏绝对路径会把本机目录结构暴露给日志与审计产物）。
 *
 * 本实现不走序列化，直接在值上递归查，因此与转义规则无关：
 *  · 字符串逐个 includes；
 *  · 数组与对象递归下探（含 key，因为 key 也可能是路径）；
 *  · Error 单独取 message/stack；
 *  · 深度上限防御自引用。
 *
 * 同时比对**两种形态**：原始路径与它的正斜杠写法。Windows 上同一路径常以
 * `C:/x/y` 形式出现在 URI 或规范化后的字段里，只查反斜杠形态会漏。
 */

/** 递归下探深度上限。防御畸形或自引用结构，不是业务约束。 */
const MAX_DEPTH = 12;

function variantsOf(needle: string): string[] {
  const forward = needle.replaceAll('\\', '/');
  return forward === needle ? [needle] : [needle, forward];
}

/**
 * 在任意值里查找是否出现 needle（或其正斜杠变体）。
 * @returns 命中的路径描述（用于诊断），未命中返回 null。
 */
export function findPathLeak(value: unknown, needle: string, depth = 0, at = '$'): string | null {
  if (depth > MAX_DEPTH || needle.length === 0) return null;

  const forms = variantsOf(needle);

  if (typeof value === 'string') {
    return forms.some((form) => value.includes(form)) ? at : null;
  }
  if (value instanceof Error) {
    for (const [field, text] of [['message', value.message], ['stack', value.stack ?? '']] as const) {
      if (forms.some((form) => text.includes(form))) return `${at}.${field}`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findPathLeak(value[index], needle, depth + 1, `${at}[${index}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // key 本身也可能是路径（例如以路径为键的映射）。
      if (forms.some((form) => key.includes(form))) return `${at}.<key:${key}>`;
      const hit = findPathLeak(inner, needle, depth + 1, `${at}.${key}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * 断言 value 里不含 needle 这个绝对路径。命中即抛，错误消息指出命中位置。
 *
 * @param label 出错时的上下文标签（例如 `${capability}/${phase}`）
 */
export function assertNoPathLeak(label: string, value: unknown, needle: string): void {
  const hit = findPathLeak(value, needle);
  if (hit !== null) {
    throw new Error(
      `${label}: diagnostics leaked an absolute local path at ${hit}.`
      + ' 脱敏失效会把本机目录结构写进日志与审计产物。'
    );
  }
}
