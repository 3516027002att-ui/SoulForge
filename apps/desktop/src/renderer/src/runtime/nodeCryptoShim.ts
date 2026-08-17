/**
 * renderer 浏览器环境没有 node:crypto。
 *
 * core 的 EMEVD DSL 模块（darkScriptCompiler / dslCompiler / emedfSchema /
 * stableIdentity）顶层 import createHash/randomUUID（锚定/指纹计算），但
 * renderer 只调用其中的纯解析函数（parseDarkScriptCall），不触发哈希。
 * 这里提供显式失败 stub 让打包通过；万一未来渲染路径真调用哈希，抛可读
 * 错误而不是静默返回假摘要（假 sha256 会让锚定语义失真）。
 */
export function createHash(): never {
  throw new Error('node:crypto（createHash）在 renderer 不可用。');
}

export function randomUUID(): never {
  throw new Error('node:crypto（randomUUID）在 renderer 不可用。');
}
