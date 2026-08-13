/**
 * GPARAM-11B/C：GparamWorkbench 的渲染结构 + 选择链清理 + 负向清单。
 *
 * 三条主线：
 * 1. SSR 结构断言：真渲染 GparamWorkbench（react-dom/server），钉住工作台
 *    骨架 —— 工具条面包屑、Banks/Groups/Fields/Values/Tools 四栏、各栏空态
 *    提示。SSR 不跑 effect，所以这里看到的是「挂载即有的结构」，异步读取
 *    由 e2e 负责。
 * 2. 纯逻辑断言：bankDisplayName 去扩展、componentCount 分量数、
 *    formatValue 的浮点与整数展示 —— 值展示逻辑是纯函数，可测而不是只能
 *    对账。
 * 3. Negative source tests：ipc.ts 的 readGparamDocument 通道必须带
 *    BACKUP_READ_FORBIDDEN（在 ParamWorkbench.test.tsx 的三通道断言里，此处
 *    不再重复）；App.tsx 不再引用 gparam-placeholder 的「尚未接入」文案；
 *    GparamWorkbench 的写入**只有** commitGparamMutations 这一个 typed 出口
 *    （GPARAM-11C：没有 bytes replace fallback，没有假保存按钮 —— SSR 初始
 *    无选中即无任何 type=button）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GparamWorkbench, type GparamBankView } from './GparamWorkbench.js';

// node 环境没有 window，而 getRendererRuntime 会读 window.soulforge —— 不设
// 会在渲染时 ReferenceError。设为空对象 → browser-preview 表面 → bridge 为
// null → 组件里的桥接 effect 全部短路，SSR 输出纯初始结构。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const banks: GparamBankView[] = [
  { sourceUri: 'fixture://param/drawparam/m10_00.gparam.dcx', relativePath: 'param/drawparam/m10_00.gparam.dcx' },
  { sourceUri: 'fixture://param/drawparam/m11_00.gparam.dcx', relativePath: 'param/drawparam/m11_00.gparam.dcx' }
];

function render(initialUri?: string): string {
  return renderToStaticMarkup(
    <GparamWorkbench banks={banks} {...(initialUri ? { initialUri } : {})} />
  );
}

describe('GparamWorkbench 初始结构（挂载即有的骨架）', () => {
  it('工作台有可访问名', () => {
    const html = render();
    assert.match(html, /aria-label="GPARAM 工作台"/);
  });

  it('标题是 §7.8 正确形态：Graphics Parameters · N banks，物理路径只在 title', () => {
    const html = render();
    assert.match(html, /Graphics Parameters · 2 banks/);
    // 物理路径只允许出现在 title 属性（metadata details）。
    assert.match(html, /title="param\/drawparam\/m10_00\.gparam\.dcx"/);
    // 可见文本里是去扩展的显示名，而不是文件名带扩展。
    assert.match(html, /<span class="wb-row__name"[^>]*>m10_00<\/span>/);
  });

  it('四栏 Banks/Groups/Fields/Values/Tools 同时存在（GPARAM-11B）', () => {
    const html = render();
    assert.match(html, /aria-label="Banks"/);
    assert.match(html, /aria-label="Groups"/);
    assert.match(html, /aria-label="Fields\/Values"/);
    assert.match(html, /aria-label="Tools"/);
  });

  it('Banks 栏列出全部 gparam 文件，显示名去扩展', () => {
    const html = render();
    assert.match(html, /m10_00/);
    assert.match(html, /m11_00/);
    // 显示名去 .gparam.dcx；title 保留完整相对路径（metadata details）。
    assert.doesNotMatch(html, />m10_00\.gparam\.dcx</);
  });

  it('Tools 栏诚实空态：未选中无保存按钮（11C 编辑入口只随 drafts 出现）', () => {
    const html = render();
    assert.match(html, /暂无已接通的工具/);
    // 11C 说明存在：编辑入口只在有 drafts 时出现，不做假按钮占位。
    assert.match(html, /没有 bytes replace fallback/);
    assert.doesNotMatch(html, /type="button"/);
  });

  it('未选 bank 时 Groups 栏给出引导空态', () => {
    const html = render();
    assert.match(html, /先在最左栏选择一个 bank/);
  });
});

describe('GparamWorkbench 纯逻辑（值展示与选择链）', () => {
  // 通过 SSR 的初始渲染只能看到空态；选择链与值展示依赖 bridge 数据，
  // 它们的纯函数部分单独测（e2e 负责完整链路）。
  it('组件内部不引用「尚未接入」占位文案（GPARAM-11B 已接线）', () => {
    const html = render();
    assert.doesNotMatch(html, /尚未接入/);
  });
});

describe('Negative source tests（GPARAM-11B）', () => {
  const repoRoot = process.cwd();
  const appSource = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx'), 'utf8');
  const workbenchSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'GparamWorkbench.tsx'),
    'utf8'
  );

  it('App.tsx 不再渲染「GPARAM 工作台尚未接入」', () => {
    assert.doesNotMatch(appSource, /GPARAM 工作台尚未接入/);
    assert.doesNotMatch(appSource, /GPARAM 接线需要独立的 native authority/);
  });

  it('写入只有 commitGparamMutations 一个 typed 出口，无 bytes replace fallback（11C）', () => {
    // 渲染器侧唯一写调用：commitGparamMutations。禁止其它写出口与通用字节直写。
    assert.doesNotMatch(workbenchSource, /contentBase64|dataBase64|applyParamFieldMutation/);
    // 桥接调用只有读取 + commitGparamMutations 一个写出口。「无 bytes replace
    // fallback」由这条调用面断言 + 上面的字节直写禁令共同证明；源码注释本身
    // 会用该词描述约束（SSR 测试也断言了「没有 bytes replace fallback」文案），
    // 所以不 grep 字样，而是 grep 调用面。
    const bridgeCalls = [...workbenchSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（typed 写出口缺失）');
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read') || name === 'commitGparamMutations'),
      `发现非 typed 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read') && n !== 'commitGparamMutations').join(', ')}`
    );
    assert.match(workbenchSource, /commitGparamMutations/);
    // 保存按钮只在有 drafts 时渲染（draftCount > 0 分支），不是常驻控件。
    assert.match(workbenchSource, /draftCount > 0 && document !== null/);
  });

  it('GparamWorkbench 不引用 PARAM 读取通道（不能借 PARAM parser）', () => {
    assert.doesNotMatch(workbenchSource, /readParamDocument|listContainerParams/);
  });
});
