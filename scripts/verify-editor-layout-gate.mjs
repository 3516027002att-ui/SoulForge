#!/usr/bin/env node
/**
 * 编辑器布局门禁:证据投影不得占据主视图顶部。
 *
 * ── 守的问题 ──
 *
 * 用户报「打开这些页面全是证据卡，根本没法像编辑器一样用」。实测原因是
 * App.tsx 把 StructuredPreviewCard 与 NativeInspectionCard 渲染在**所有编辑器
 * 面板之前**且常驻展开：打开一个 param，先看到的是两张证据卡，行表被挤到滚动区
 * 外。那两张卡是给 AI 与排查用的证据投影，不是日常编辑要看的东西。
 *
 * 这类缺陷没有任何自动信号：编译通过、测试全绿、功能"可用"（滚下去就有），
 * 只是没人愿意用。而它极易被改回去——挪一行 JSX 就够。
 *
 * ── 为什么是静态判据而不是 e2e ──
 *
 * 先写过 e2e，实测**验不了**：当前 fixture 工作区里没有任何资源带
 * structuredPreview 或 nativeInspection（逐个资源模式试过 event/msg/other/all），
 * 证据区根本不渲染，用例只能恒红。留一条永远红的 e2e 比没有更糟，故删掉改成
 * 静态判据。这里如实记下这个限制：本门禁读源码结构，不证明运行期视觉顺序。
 *
 * 判据:
 *   ① 两张证据卡必须在折叠容器 resource-evidence-details 内；
 *   ② 该容器不得带 open（默认收起）；
 *   ③ 容器在源码里的位置必须晚于全部编辑器面板 —— JSX 顺序即渲染顺序；
 *   ④ 提取失败必须失败关闭：扫不到卡片或容器说明匹配规则坏了。
 *
 * ── 负向证明(2026-08-10 实测三条)──
 *   L1  折叠区加 open（等于回到原状）      → EVIDENCE_DETAILS_DEFAULT_OPEN
 *   L2  把证据卡挪回编辑器之前              → EVIDENCE_CARD_OUTSIDE_DETAILS
 *   L4  证据卡渲染点消失                    → EVIDENCE_CARDS_NOT_FOUND（失败关闭）
 *
 * L2 守的正是用户报告的形态：「打开这些页面全是证据卡」。它把两张卡搬回
 * PanelErrorBoundary 开头，门禁立刻报红。
 *
 * 本门禁自身也是先红后绿的产物：第一版不剥注释，命中的是一句 JSX 注释里提到的
 * `resource-evidence-details` 字符串，算出的位置比真实容器早一万多字符，
 * 于是在代码正确时报「证据排在编辑器之前」。那种假红会让人直接关掉门禁，
 * 故加了 stripComments。
 *
 * 另有一条 L3（删掉折叠容器让证据卡裸露）已移除：它的场景与 L2 重合
 * ——两者都是「卡片不在折叠区内」，而 L2 的锚点更贴近真实回退方式。
 * 保留一个冗余用例只会增加维护面。
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

/**
 * 剥掉注释后再定位。
 *
 * 实测必须这么做:第一版直接在原文里找 `resource-evidence-details`，命中的是
 * 一句 JSX 注释里提到的同名字符串（`{/* …见下方 resource-evidence-details *␑/}`），
 * 于是算出的位置比真实容器早一万多字符，门禁误报「证据排在编辑器之前」。
 * 判据把注释当代码，就会在代码正确时报红 —— 那种假红会让人直接关掉门禁。
 *
 * 用等长空格替换而不是删除：这样保留的偏移仍与原文一一对应，报告里的偏移
 * 和行号才有意义。
 */
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

const structuredAt = at('<StructuredPreviewCard');
const nativeAt = at('<NativeInspectionCard');
const detailsAt = at('resource-evidence-details');

// 判据④
if (structuredAt < 0 || nativeAt < 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EVIDENCE_CARDS_NOT_FOUND',
    message: '在 App.tsx 里找不到 StructuredPreviewCard / NativeInspectionCard 的渲染点。'
      + ' 提取失败必须失败关闭，否则判据①②③会零样本恒真。',
    structuredAt, nativeAt
  }, 1);
}
if (detailsAt < 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EVIDENCE_DETAILS_NOT_FOUND',
    message: '找不到 resource-evidence-details 折叠容器 —— 证据卡不在折叠区内。'
      + ' 它们此前常驻展开在主视图顶部，用户因此看不到编辑器。'
  }, 1);
}

// 判据①:两张卡都必须在容器之后（即容器内）。
for (const [name, position] of [['StructuredPreviewCard', structuredAt], ['NativeInspectionCard', nativeAt]]) {
  if (position < detailsAt) {
    findings.push({
      code: 'EVIDENCE_CARD_OUTSIDE_DETAILS',
      card: name,
      cardAt: position,
      detailsAt,
      message: `${name} 出现在折叠容器之前（偏移 ${position} < ${detailsAt}），`
        + '说明它不在折叠区内。证据卡必须收进 resource-evidence-details。'
    });
  }
}

// 判据②:容器不得默认展开。
const detailsTag = /<details className="resource-evidence-details"([^>]*)>/.exec(source);
if (!detailsTag) {
  findings.push({
    code: 'EVIDENCE_DETAILS_TAG_UNPARSEABLE',
    message: '未能解析 resource-evidence-details 的 details 标签，判据②无从校验。'
  });
} else if (/\bopen\b/.test(detailsTag[1])) {
  findings.push({
    code: 'EVIDENCE_DETAILS_DEFAULT_OPEN',
    attributes: detailsTag[1].trim(),
    message: '证据折叠区带了 open（默认展开）。默认展开等于回到原状：'
      + '打开资源先看到证据卡而不是编辑器。'
  });
}

// 判据③:容器必须晚于全部编辑器面板。
const EDITOR_PANELS = [
  '<ParamTablePanel',
  '<ParamDefPanel',
  '<FmgWorkbenchPanel',
  '<EmevdFourViewPanel',
  '<MsbScenePanel'
];
const panelPositions = EDITOR_PANELS
  .map((tag) => ({ tag, position: at(tag) }))
  .filter((entry) => entry.position >= 0);
if (panelPositions.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_EDITOR_PANELS_FOUND',
    message: '在 App.tsx 里找不到任何编辑器面板渲染点；判据③零样本恒真，失败关闭。',
    probed: EDITOR_PANELS
  }, 1);
}
for (const entry of panelPositions) {
  if (detailsAt < entry.position) {
    findings.push({
      code: 'EVIDENCE_BEFORE_EDITOR',
      panel: entry.tag,
      panelAt: entry.position,
      detailsAt,
      message: `证据折叠区（偏移 ${detailsAt}）排在 ${entry.tag}（偏移 ${entry.position}）之前。`
        + ' JSX 顺序即渲染顺序 —— 证据必须排在编辑器之后，否则编辑器又被挤到下面。'
    });
  }
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EDITOR_LAYOUT_VIOLATION',
    message: '证据投影的位置或默认展开状态回退了。',
    detailsAt,
    editorPanels: panelPositions,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: `证据投影收在折叠区内、默认收起，且排在 ${panelPositions.length} 个编辑器面板之后。`,
  detailsAt,
  editorPanels: panelPositions.map((entry) => ({ tag: entry.tag, at: entry.position })),
  nonClaim: '本门禁读 App.tsx 的源码结构（JSX 出现顺序与 details 属性），'
    + '不证明运行期视觉顺序、不检查 CSS 是否把元素移回顶部，也不覆盖各编辑器面板'
    + '内部的布局。先尝试过 e2e 验证，实测当前 fixture 工作区里没有任何资源带'
    + ' structuredPreview/nativeInspection，证据区不渲染因而用例只能恒红，'
    + '故改为静态判据 —— 这个限制是真实的，不是偷懒。'
}, 0);
