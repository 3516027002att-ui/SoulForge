/**
 * MATERIAL-53B + 53C：MaterialWorkbenchPanel 的渲染结构 + 纯逻辑 + 负向清单。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect）。面板自驱动
 * 经 getRendererBridge 读 read-mtd-document（同 TpfWorkbenchPanel 模式），SSR 下
 * bridge 为 null → 读取 effect 全部短路，这里钉住「挂载即有的结构」；真实 live 链路
 * （Bridge → ipc → readMtdDocument / commitMtdPropertySet）由 e2e 覆盖。
 *
 * 三类契约：
 * 1. SSR 结构：三栏 File list | Material list | Properties / Values 挂载即存在，
 *    没有为凑四栏造 Preview 空栏（§2.5 MATERIAL 无 viewport）；文件列表由 props
 *    派生、显示名去 .mtd；未选文件时各栏给引导空态。
 * 2. 纯逻辑：materialPropertyRows 把 unknown 属性展开为独立只读行（不可丢弃），
 *    已知属性保留 name/type/value；mtdPropertySetPayload / reduceMtdCommitResult
 *    承载 53C 写回载荷与状态归约。
 * 3. Negative source：写出口只有 commitMtdPropertySet 一个 typed 出口（53C，
 *    无通用 XML 文本替换 fallback）；known 属性行有输入框、unknown 行保持只读
 *    标注；partial 必须把 unparsedGaps 暴露给用户；不引用 three/canvas/
 *    FlverViewer（无 Preview 第四栏）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MaterialWorkbenchPanel,
  materialPropertyRows,
  mtdPropertyCommitError,
  mtdPropertySetPayload,
  reduceMtdCommitResult,
  type MaterialFileView
} from './MaterialWorkbenchPanel.js';
import type { MtdDocument } from '@soulforge/shared';

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → 读取 effect 短路，SSR 输出纯初始结构（同 TpfWorkbenchPanel）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const files: MaterialFileView[] = [
  { sourceUri: 'fixture://material/materials.mtd', relativePath: 'material/materials.mtd' },
  { sourceUri: 'fixture://material/broken.mtd', relativePath: 'material/broken.mtd' }
];

function render(initialUri?: string): string {
  return renderToStaticMarkup(
    <MaterialWorkbenchPanel files={files} {...(initialUri ? { initialUri } : {})} />
  );
}

function makeDocument(overrides: Record<string, unknown> = {}): MtdDocument {
  return {
    format: 'MTD-XML',
    formatId: 'mtd',
    sourceSize: 2048,
    sourceHash: 'fixture-mtd-hash',
    rootElement: 'material',
    name: 'm_test_material',
    version: '1.0',
    header: null,
    shaderPath: 'shader/standard.mtdshader',
    materialCount: 1,
    properties: [
      { id: 'p1', type: 'float', name: 'DiffuseIntensity', value: '0.8' },
      { id: 'p2', type: 'texture', name: 'BaseColorMap', value: 'tex/base.dds' }
    ],
    propertiesTruncated: false,
    textureRefs: [{ path: 'tex/base.dds', type: 'g', name: 'BaseColorMap' }],
    textureRefsTruncated: false,
    unparsedGaps: [],
    layoutWarnings: [],
    roundTrip: {
      consistent: true,
      sourceHash: 'fixture-mtd-hash',
      reparsedHash: 'fixture-mtd-hash',
      paramCount: 2,
      textureRefCount: 1,
      note: null
    },
    authority: 'candidate',
    ...overrides
  } as MtdDocument;
}

describe('MaterialWorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「Material 工作台」', () => {
    assert.match(render(), /aria-label="Material 工作台"/);
  });

  it('三栏 File list | Material list | Properties / Values 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="File list"/);
    assert.match(html, /aria-label="Material list"/);
    assert.match(html, /aria-label="Properties \/ Values"/);
  });

  it('没有为凑四栏造 Preview 空栏（§2.5 MATERIAL 无 viewport）', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Preview"/);
    assert.doesNotMatch(html, /aria-label="Tools"/);
  });

  it('File list 栏列出全部文件，显示名去 .mtd，物理路径只在 title', () => {
    const html = render();
    assert.match(html, /materials/);
    assert.match(html, /broken/);
    assert.doesNotMatch(html, />materials\.mtd</);
    assert.match(html, /title="material\/materials\.mtd"/);
  });

  it('未选文件时各栏给出引导空态', () => {
    const html = render();
    assert.match(html, /先在最左栏选择一个 MTD 文件/);
    assert.match(html, /在中间选择一个材质查看属性/);
  });

  it('初始（未选中/读取失败）无任何 type=button 与编辑输入框', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
    assert.doesNotMatch(html, /type="number"/);
    assert.doesNotMatch(html, /<textarea/);
  });

  it('无 3D viewport：不渲染 canvas 或视图容器', () => {
    const html = render();
    assert.doesNotMatch(html, /<canvas/i);
  });
});

describe('materialPropertyRows（unknown 属性展开为只读行，不可丢弃）', () => {
  it('已知属性保留 name/type/value', () => {
    const rows = materialPropertyRows([
      { id: 'p1', type: 'float', name: 'DiffuseIntensity', value: '0.8' }
    ]);
    assert.deepEqual(rows, [
      { id: 'p1', name: 'DiffuseIntensity', value: '0.8', type: 'float' }
    ]);
  });

  it('unknown 属性展开为独立行并标记 unknown（可见但不可编辑）', () => {
    const rows = materialPropertyRows([
      { id: 'p3', type: 'float', name: 'UnknownParam', value: '1.0', unknown: { unkAttr: '0x2a' } }
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, 'UnknownParam');
    assert.equal(rows[1]?.name, 'unkAttr（未识别）');
    assert.equal(rows[1]?.value, '0x2a');
    assert.equal(rows[1]?.unknown, true);
  });

  it('无 name/id 的属性有可读退化名，不静默丢弃', () => {
    const rows = materialPropertyRows([{ value: '1' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, '未命名属性');
  });
});

describe('MTD 属性写回载荷与状态归约（MATERIAL-53C）', () => {
  it('mtdPropertySetPayload 构建 typed set 载荷 { paramId, newValue }', () => {
    assert.deepEqual(mtdPropertySetPayload('p1', '0.9'), { paramId: 'p1', newValue: '0.9' });
  });

  it('commit ok 归约：成功提示 + 触发重读（refresh=true），无诊断', () => {
    // 窄视图只读 ok/diagnostics（RendererSaveResult 的 renderer 投影子集）。
    const applied = reduceMtdCommitResult(
      { ok: true, diagnostics: [] },
      'DiffuseIntensity'
    );
    assert.equal(applied.refresh, true);
    assert.equal(applied.error, null);
    assert.match(applied.notice ?? '', /DiffuseIntensity/);
  });

  it('commit 失败归约：提取第一条诊断的 severity/code/message，不触发重读', () => {
    const applied = reduceMtdCommitResult(
      {
        ok: false,
        diagnostics: [{ severity: 'error', code: 'MTD_WRITE_BLOCKED_123', message: '目标 param 区间含 XML 标记' }]
      },
      'DiffuseIntensity'
    );
    assert.equal(applied.refresh, false);
    assert.equal(applied.notice, null);
    assert.deepEqual(applied.error, {
      severity: 'error',
      code: 'MTD_WRITE_BLOCKED_123',
      message: '目标 param 区间含 XML 标记'
    });
  });

  it('commit 失败且无诊断：fail-closed 默认 code/message，不吞失败', () => {
    assert.deepEqual(
      mtdPropertyCommitError({ ok: false, diagnostics: [] }),
      { code: 'MTD_COMMIT_FAILED', message: 'MTD 写入被拒绝。' }
    );
  });
});

describe('Negative source tests（MATERIAL-53B / 53C）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'MaterialWorkbenchPanel.tsx'),
    'utf8'
  );

  it('渲染侧桥接调用只有 read + commitMtdPropertySet 一个 typed 写出口（53C）', () => {
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（read 通道缺失）');
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read') || name === 'commitMtdPropertySet'),
      `发现非 typed 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read') && n !== 'commitMtdPropertySet').join(', ')}`
    );
  });

  it('无字节直写（不能有 contentBase64 / dataBase64 fallback）', () => {
    assert.doesNotMatch(panelSource, /contentBase64|dataBase64/);
  });

  it('写回已接通（53C）：known 属性有编辑输入框，unknown 行保持只读标注', () => {
    assert.doesNotMatch(panelSource, /MTD 写回链尚未接通/);
    assert.doesNotMatch(panelSource, /没有属性编辑入口/);
    assert.match(panelSource, /commitMtdPropertySet/);
    assert.match(panelSource, /<input/);
    assert.match(panelSource, /mtd-unknown-value/);
  });

  it('写回调用形状：commitMtdPropertySet(selectedUri, document.sourceHash, { paramId, newValue })', () => {
    // sourceUri/sourceHash 用 read 时选定拼接，typed set 只含 paramId + newValue。
    assert.match(panelSource, /bridge\.commitMtdPropertySet\s*\(\s*selectedUri\s*,\s*document\.sourceHash/);
    assert.match(panelSource, /mtdPropertySetPayload\(row\.id, newValue\)/);
    // 没有通用 XML 文本替换 fallback（不传整段新文本、不直写字节）。
    assert.doesNotMatch(panelSource, /newText:|contentBase64|dataBase64/);
  });

  it('commit ok 后触发重读：refreshKey 递增且 read effect deps 含 refreshKey', () => {
    assert.match(panelSource, /setRefreshKey\(\(key\) => key \+ 1\)/);
    assert.match(panelSource, /\[bridge, selectedUri, refreshKey\]/);
  });

  it('commit 失败走结构化诊断：setCommitError + 诊断区块渲染，失败不触发重读', () => {
    assert.match(panelSource, /setCommitError/);
    assert.match(panelSource, /data-testid="mtd-commit-error"/);
    // 失败由 reduceMtdCommitResult 归约出诊断（refresh=false），不清空 document。
    assert.match(panelSource, /reduceMtdCommitResult/);
    assert.match(panelSource, /applied\.refresh/);
    assert.match(panelSource, /写入失败已回滚，当前内容未清除/);
  });

  it('known 属性行渲染编辑输入框，unknown 行保持只读标注（53C 语义）', () => {
    assert.match(panelSource, /type="text"/);
    assert.match(panelSource, /aria-label=\{`\$\{row\.name\} 值`\}/);
    // unknown 分支不渲染输入框：只读 span + mtd-unknown-value + mtd-unknown-prop。
    assert.match(panelSource, /row\.unknown \? \(/);
    assert.match(panelSource, /wb-prop__value--readonly mtd-unknown-value/);
    assert.match(panelSource, /data-testid="mtd-unknown-prop"/);
  });

  it('partial 必须把 unparsedGaps 暴露给用户，不伪装成完整解析', () => {
    assert.match(panelSource, /data-testid="mtd-partial-gaps"/);
    assert.match(panelSource, /未识别结构/);
  });

  it('unknown 属性渲染行带 mtd-unknown-prop testid（e2e 共用锚点）', () => {
    assert.match(panelSource, /data-testid="mtd-unknown-prop"/);
  });

  it('无 3D viewport：不引用 three / canvas / FlverViewer', () => {
    assert.doesNotMatch(panelSource, /three|FlverViewer|<canvas/i);
  });

  it('投影来自 shared 的 projectMaterialDocumentPages，renderer 不扫字节、不猜格式', () => {
    assert.match(panelSource, /projectMaterialDocumentPages/);
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
  });

  it('截断说明走 formatListTruncation 且保留 mtd-truncation testId', () => {
    assert.match(panelSource, /formatListTruncation/);
    assert.match(panelSource, /data-testid="mtd-truncation"/);
  });
});
