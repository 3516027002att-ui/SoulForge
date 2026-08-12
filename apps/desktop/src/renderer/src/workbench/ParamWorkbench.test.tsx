/**
 * PARAM-10A：ParamWorkbench 的渲染结构 + 「backup 不读、失败非 empty」锁定。
 *
 * 三条主线：
 * 1. SSR 结构断言：真渲染 ParamWorkbench（react-dom/server），钉住工作台骨架
 *    —— 工具条面包屑、Param/Row/Field 三栏、各栏空态提示。SSR 不跑 effect，
 *    所以这里看到的是「挂载即有的结构」，异步加载结果由 e2e 负责。
 * 2. 行为测试：core 的 isParamBackupPath（ROUTE-06 后缀语义：.bak/.prev、
 *    大小写不敏感、反斜杠归一）。IPC 层用同一函数挡 backup，行为可测而不是
 *    只能对账。
 * 3. Negative source tests：ipc.ts 的两个 PARAM 读取通道都必须带
 *    BACKUP_READ_FORBIDDEN 拒绝（路由层挡住普通打开还不够，直接 invoke 的
 *    调用方也要被锁）；ParamWorkbench 的失败路径必须渲染非空诊断
 *    （diag-error），而不是把失败显示成空表；组件自身不得拼 backup 拒绝
 *    （拒绝只属于 IPC 层）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
// 深路径而不是包主入口：@soulforge/core 的主入口会把 sqlite 等 native 依赖
// 拉进 esbuild bundle（better-sqlite3 是 CJS native 模块，打进 ESM 后动态
// require 直接崩）。isParamBackupPath 定义在 paramBridgeCommit.ts，ipc.ts 经
// 包主入口 re-export 的同一导出，行为一致。
import { isParamBackupPath } from '@soulforge/core/dist/editing/paramBridgeCommit.js';
import { ParamWorkbench } from './ParamWorkbench.js';

// node 环境没有 window，而 getRendererRuntime 会读 window.soulforge —— 不设
// 会在渲染时 ReferenceError。设为空对象 → browser-preview 表面 → bridge 为
// null → 组件里的桥接 effect 全部短路，SSR 输出纯初始结构。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function render(containerLabel = 'gameparam.parambnd.dcx'): string {
  return renderToStaticMarkup(
    <ParamWorkbench
      containerUri="param/gameparam/gameparam.parambnd.dcx"
      containerLabel={containerLabel}
    />
  );
}

describe('ParamWorkbench 初始结构（挂载即有的骨架）', () => {
  it('工作台有可访问名', () => {
    const html = render();
    assert.match(html, /aria-label="PARAM 工作台"/);
  });

  it('标题是 §7.8 正确形态：Game Parameters · 1 library · N tables', () => {
    const html = render('gameparam.parambnd.dcx');
    assert.match(html, /class="crumb"/);
    // SSR 初始 params=[]，N 为 0；标题形态不含物理路径。
    assert.match(html, /Game Parameters · 1 library · 0 tables/);
  });

  it('四栏 Params/Rows/Fields/Tools 同时存在（§7.1，PARAM-10B）', () => {
    const html = render();
    assert.match(html, /aria-label="Params"/);
    assert.match(html, /aria-label="Rows"/);
    assert.match(html, /aria-label="Fields"/);
    assert.match(html, /aria-label="Tools"/);
  });

  it('四栏按 §7.1 固定比例与最小宽度渲染（20/29/35/16，180/260/320/200）', () => {
    const html = render();
    // React SSR 的 style 序列化无空格（flex:0.2 1 0;min-width:180px）。
    assert.match(html, /style="flex:0\.2 1 0;min-width:180px"/);
    assert.match(html, /style="flex:0\.29 1 0;min-width:260px"/);
    assert.match(html, /style="flex:0\.35 1 0;min-width:320px"/);
    assert.match(html, /style="flex:0\.16 1 0;min-width:200px"/);
  });

  it('左栏有容器内 param 筛选输入', () => {
    const html = render();
    assert.match(html, /aria-label="筛选容器内 param 名称"/);
  });

  it('未选中 param 时行栏与字段栏给出空态提示而不是空白', () => {
    const html = render();
    // 两处（Rows 栏与 Fields 栏）都应出现「先在左栏选择一个 param。」
    assert.equal(html.match(/先在左栏选择一个 param。/g)?.length ?? 0, 2);
  });

  it('Tools 栏只给诚实空态，不渲染 disabled 假按钮（§7.6）', () => {
    const html = render();
    assert.ok(html.includes('暂无已接通的工具'), 'Tools 栏必须说明工具未接通');
    assert.ok(!html.includes('disabled'), '未接通的工具不得以 disabled 假按钮出现');
  });

  it('容器物理路径/文件名不进可见 DOM（§7.3/§7.8 禁止列表）', () => {
    // containerLabel prop 传入真实形态的容器名，SSR 输出不得包含它。
    const html = render('param/gameparam/gameparam.parambnd.dcx');
    assert.ok(!html.includes('gameparam.parambnd.dcx'), '容器文件名不得出现在 DOM');
    assert.ok(!html.includes('.bak'), 'backup 后缀不得出现在 DOM');
    assert.ok(!html.includes('.gparam'), 'gparam 不得混入 PARAM 工作台');
  });
});

describe('isParamBackupPath（ROUTE-06 后缀语义）', () => {
  it('.bak 与 .prev 结尾都是 backup 路径', () => {
    assert.equal(isParamBackupPath('param/gameparam/gameparam.parambnd.dcx.bak'), true);
    assert.equal(isParamBackupPath('param/gameparam/gameparam.parambnd.dcx.prev'), true);
  });

  it('大小写不敏感，与 artifact matcher 一致', () => {
    assert.equal(isParamBackupPath('PARAM/GAMEPARAM/GAMEPARAM.PARAMBND.DCX.BAK'), true);
    assert.equal(isParamBackupPath('param/gameparam/gameparam.parambnd.dcx.PREV'), true);
  });

  it('反斜杠路径归一后同样判定', () => {
    assert.equal(isParamBackupPath('mod\\param\\gameparam\\gameparam.parambnd.dcx.bak'), true);
  });

  it('普通 PARAM 路径不是 backup', () => {
    assert.equal(isParamBackupPath('param/gameparam/gameparam.parambnd.dcx'), false);
    assert.equal(isParamBackupPath('param/gameparam/ActionGuideParam.param'), false);
  });

  it('中间出现 .bak 的路径不是 backup（只认结尾）', () => {
    assert.equal(isParamBackupPath('param/gameparam.bak.dir/gameparam.parambnd.dcx'), false);
  });
});

describe('PARAM-10A negative source tests（§18.14）', () => {
  const repoRoot = process.cwd();
  const ipcSource = stripComments(readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'main', 'ipc.ts'),
    'utf8'
  ));
  const workbenchSource = stripComments(readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'ParamWorkbench.tsx'),
    'utf8'
  ));

  it('backup 不读：两个 PARAM 读取通道都必须拒绝（readParamDocument + readParamPage）', () => {
    const matches = ipcSource.match(/BACKUP_READ_FORBIDDEN/g) ?? [];
    assert.equal(matches.length, 2,
      'BACKUP_READ_FORBIDDEN 应恰好出现在 readParamDocument 与 readParamPage 两个 handler');
    // 每个 handler 都调用同一判定函数（行为测试见上），拒绝不能只挂在一个通道。
    const doc = sliceHandler(ipcSource, 'resource.readParamDocument');
    const page = sliceHandler(ipcSource, 'resource.readParamPage');
    assert.ok(doc.includes('isParamBackupPath('), 'readParamDocument 未调用 isParamBackupPath');
    assert.ok(page.includes('isParamBackupPath('), 'readParamPage 未调用 isParamBackupPath');
  });

  it('backup 拒绝的诊断指向 History & Recovery（不冒充普通读取失败）', () => {
    const doc = sliceHandler(ipcSource, 'resource.readParamDocument');
    assert.match(doc, /History & Recovery/);
  });

  it('失败非 empty：组件失败路径渲染结构化诊断而不是空表', () => {
    // 左栏容器读取失败、行栏读取失败、选中 param 读取失败，三条路径都必须
    // 有非空诊断输出（diag-error 段落），不能静默清空成空表 —— 硬约束
    // 「unsupported/failed 必须返回结构化诊断」的渲染侧对应。
    assert.match(workbenchSource, /className="wb-empty diag-error">\{paramsError\}/);
    assert.match(workbenchSource, /className="wb-empty diag-error">\{rowsError\}/);
    assert.ok(workbenchSource.includes('这个 param 读不出来'), '选中失败的 param 必须给出明确失败文案');
    assert.ok(workbenchSource.includes('容器内其他 param 不受影响'), '失败说明不能夸大影响范围');
  });

  it('backup 拒绝只属于 IPC 层：组件不得自行拼拒绝逻辑', () => {
    assert.ok(!workbenchSource.includes('BACKUP_READ_FORBIDDEN'), 'ParamWorkbench 不应包含 backup 拒绝码');
    assert.ok(!workbenchSource.includes('isParamBackupPath'), 'ParamWorkbench 不应自行判定 backup 路径');
  });
});

/**
 * 按 channel 字符串切片出 handler 源码区域。
 *
 * 不能按 `handle('channel'` 定位：readParamPage 的 handle 调用是跨行的
 * （`handle(\n  'resource.readParamPage',`），stripComments 后同样保留换行，
 * 拼不出「handle('」开头的精确串。channel 名本身在 handle 注册块内只会出现
 * 一次（作为第一个参数），用它定位即可。
 */
function sliceHandler(source: string, channel: string): string {
  const start = source.indexOf(`'${channel}'`);
  assert.ok(start >= 0, `ipc.ts 中找不到 handler: ${channel}`);
  return source.slice(start);
}

/**
 * 对账前剥离注释：与 domainNavigation.test.ts 同一范式。注释里的历史叙述
 * （如引用 ROUTE-06 原文「.bak 只读打开于 History & Recovery」）不算代码
 * 引用，剥不干净会让对账对注释敏感。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
