/**
 * 大份 DarkScript 源码的 CodeMirror 原子挂载。
 *
 * S18 曾用「首帧前缀 + 16ms 分片追加」避免 `EditorState.create(全文)` 把
 * renderer 主线程冻死。实测那是一个伪优化：CodeMirror 6 的 Text 树对 2MB /
 * 6.2 万行文本一次构建约 15 ms，分片反而把同一份工作拆成 175 次 dispatch +
 * 175 次让出，让滚动条比例、查找范围、跳到后半在数秒内都不是真实文件。
 *
 * 成熟编辑器的做法是原子提交：文本一旦到达 renderer，就在一次
 * `EditorState.create` 里提交成完整缓冲；视图绑定的是稳定 EditorState，
 * 之后的高亮 / 索引 / 折叠更新都不再替换文档对象。
 *
 * S35 之后的分工：本模块仍是**完整缓冲**的原子挂载（拉齐后 / 提交后重读回灌 /
 * 小文档首帧）。超长 EMEVD 的打开首帧只有 400 行前缀，按视口增量续载与
 * 「查找/提交/脏标记时拉齐」走 `incrementalSourceInjection.ts` —— 那份工作是
 * 对未加载部分的**末尾追加**，不替换文档对象，与本模块的原子挂载互不冲突。
 */

import { EditorState, type Extension } from '@codemirror/state';

/**
 * 创建一份完整源码的 EditorState。调用方必须传入完整 text —— 本模块刻意
 * 不提供 split / append / prefix 函数，避免「拼装过程画给用户看」回归。
 */
export function createCompleteSourceState(text: string, extensions: Extension): EditorState {
  return EditorState.create({ doc: text, extensions });
}

/**
 * 全文一致性断言：文档长度与内容都必须等于调用方提交的全文。
 * 用于单元测试钉住「不存在分片追加态」。
 */
export function isCompleteSourceState(state: EditorState, expectedText: string): boolean {
  return state.doc.length === expectedText.length && state.doc.toString() === expectedText;
}
