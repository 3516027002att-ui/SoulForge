#!/usr/bin/env node
/**
 * 编辑器布局门禁:编辑壳不得有底栏与证据折叠区（S12 卸底栏）。
 *
 * ── 守的问题 ──
 *
 * 用户报「不要下方任何东西（日志、已索引），工作区贯穿到底」。实测截图里挡在
 * 工作台下面/后面的有四层：64 KiB 预览条、「原始字节与证据」折叠区、
 * DiagnosticsLog 底部日志、status-bar 状态栏。S12 拍死四层全部从 App.tsx
 * 编辑壳卸载，不是折起来；64 KiB / hex / 诊断数据可留在 main 与 Agent 引用，
 * 但不得再占编辑壳。
 *
 * 这类缺陷没有任何自动信号：编译通过、测试全绿、功能"可用"，只是布局被
 * 底栏吃掉。而它极易被改回去——把某个 <footer> 或 <details> 加回 App.tsx
 * 就够。故用静态判据守住「编辑壳里没有这些东西」。
 *
 * ── 为什么是静态判据而不是 e2e ──
 *
 * 旧版门禁先写过 e2e，实测验不了：fixture 工作区里没有资源带 structuredPreview
 * 或 nativeInspection，证据区根本不渲染，用例只能恒红。S12 的形态（元素不存在）
 * 更适合静态判据：直接在源码里断言「渲染点不存在」。这里如实记下这个限制：
 * 本门禁读源码结构，不证明运行期视觉顺序，也不检查 CSS。
 *
 * 判据:
 *   ① App.tsx 编辑壳内不得出现 resource-evidence-details（证据折叠区已删）；
 *   ② 不得出现 <footer className="status-bar"（状态栏已删）；
 *   ③ 不得出现 <DiagnosticsLog（底部日志区已删）；
 *   ④ 证据卡（StructuredPreviewCard / NativeInspectionCard / HexEditorPanel）
 *      不得在 App.tsx 内渲染——它们是开发者/Agent 通道，编辑壳里不出现。
 *      若未来某个面板（如 Bnd4WorkbenchPanel）内部使用 HexEditorPanel，
 *      判据只约束 App.tsx，不约束面板内部。
 *   ⑤ 提取失败必须失败关闭：找不到 App.tsx 说明匹配规则坏了。
 *
 * ── 负向证明(2026-08-15 实测)──
 *   L1  把 <details className="resource-evidence-details"> 加回 App.tsx
 *       → EVIDENCE_DETAILS_PRESENT
 *   L2  把 <footer className="status-bar"> 加回 App.tsx → STATUS_BAR_PRESENT
 *   L3  把 <DiagnosticsLog 加回 App.tsx → DIAGNOSTICS_LOG_PRESENT
 *   L4  把 <StructuredPreviewCard 加回 App.tsx → EVIDENCE_CARD_PRESENT
 *
 * 本门禁自身也是先红后绿的产物：旧版守的是「证据卡收进折叠区、排在编辑器
 * 之后」；S12 的用户裁定比旧版更彻底（折叠区整个消失），故门禁从「位置」
 * 判据改为「存在性」判据，旧判据全部失效，不得复用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'editor-layout';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(APP)) {
  report({ ok: false, gate: LABEL, status: 'failed', code: 'APP_MISSING', message: `缺少 ${APP}` }, 1);
}

const rawSource = readFileSync(APP, 'utf8');

/** 剥掉注释后再定位：JSX 注释里可能提到这些类名（旧版实测命中过一次注释里的
 *  `resource-evidence-details`），把注释当代码会在代码正确时报红。 */
function stripComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') { out += ' '; index += 1; }
      continue;
    }
    if (current === '/' && next === '*') {
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        out += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += '  ';
      index += 2;
      continue;
    }
    out += current;
    index += 1;
  }
  return out;
}

const source = stripComments(rawSource);
const findings = [];

/** 取标签在源码中的首次出现位置；-1 表示不存在。 */
const at = (needle) => source.indexOf(needle);

// 判据①：证据折叠区不得出现在编辑壳。
const detailsAt = at('resource-evidence-details');
if (detailsAt >= 0) {
  findings.push({
    code: 'EVIDENCE_DETAILS_PRESENT',
    at: detailsAt,
    message: 'App.tsx 里出现了 resource-evidence-details —— S12 已把「原始字节与证据」'
      + '折叠区从编辑壳卸载；64 KiB/hex/证据数据只允许留在 main 与 Agent 引用，'
      + '不得再占编辑壳。'
  });
}

// 判据②：状态栏 footer 不得出现。
const statusBarAt = at('className="status-bar"');
if (statusBarAt >= 0) {
  findings.push({
    code: 'STATUS_BAR_PRESENT',
    at: statusBarAt,
    message: 'App.tsx 里出现了 status-bar footer —— S12 已删状态栏（已索引/备份/诊断'
      + '计数/时钟/键位套全部随它消失）。用户原话「不要下方任何东西」。'
  });
}

// 判据③：底部日志区不得出现。
const diagAt = at('<DiagnosticsLog');
if (diagAt >= 0) {
  findings.push({
    code: 'DIAGNOSTICS_LOG_PRESENT',
    at: diagAt,
    message: 'App.tsx 里渲染了 DiagnosticsLog —— S12 已把底部日志区从编辑壳卸载；'
      + '诊断输出走编辑区内结构化句与 Agent 通道。'
  });
}

// 判据④：三张证据卡不得在 App.tsx 渲染（它们是开发者/Agent 通道）。
for (const [name, needle] of [
  ['StructuredPreviewCard', '<StructuredPreviewCard'],
  ['NativeInspectionCard', '<NativeInspectionCard'],
  ['HexEditorPanel', '<HexEditorPanel']
]) {
  const position = at(needle);
  if (position >= 0) {
    findings.push({
      code: 'EVIDENCE_CARD_PRESENT',
      card: name,
      at: position,
      message: `App.tsx 里渲染了 ${name} —— S12 之后编辑壳不再承载原始字节证据。`
        + '该组件可留在其它面板（如 BND4 工作台）与开发者通道，但不得回到 App 编辑壳。'
    });
  }
}

// 判据⑤：提取失败必须失败关闭 —— 编辑壳锚点全部找不到说明匹配规则坏了。
if (at('<main') < 0 || at('</main>') < 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'APP_SHELL_UNPARSEABLE',
    message: '在 App.tsx 里找不到 <main> 锚点；提取失败必须失败关闭，'
      + '否则上述存在性判据会零样本恒真。'
  }, 1);
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EDITOR_SHELL_VIOLATION',
    message: '编辑壳里出现了 S12 已卸载的底栏/证据元素，或证据卡回到 App 渲染。',
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: 'App.tsx 编辑壳没有 status-bar / DiagnosticsLog / resource-evidence-details，'
    + '也没有证据卡渲染 —— 中央编辑区贴窗口底，诊断与证据留在面板内与 Agent 通道。',
  nonClaim: '本门禁读 App.tsx 的源码结构（元素存在性），不证明运行期视觉顺序、'
    + '不检查 CSS 高度、也不覆盖各编辑器面板内部的布局（面板内引用 HexEditorPanel '
    + '等证据组件是允许的）。旧版门禁守的是「证据卡在折叠区内、排在编辑器之后」，'
    + 'S12 用户裁定改为「折叠区整体消失」，判据已随裁定更新。'
}, 0);
