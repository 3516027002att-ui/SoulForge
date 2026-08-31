/**
 * PARAM-10A：ParamWorkbench 的渲染结构 + 「backup 不读、失败非 empty」锁定。
 *
 * 三条主线：
 * 1. SSR 结构断言：真渲染 ParamWorkbench（react-dom/server），钉住工作台骨架
 *    —— 工具条 CSV 按钮、Param/Row/Field 三栏（T5-4 删第四栏 Tools）、各栏
 *    空态提示。SSR 不跑 effect，所以这里看到的是「挂载即有的结构」，
 *    异步加载结果由 e2e 负责。
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

  it('标题形态（T5-4）：不再有「Game Parameters · 1 library · N tables」crumb、类型名、行大小', () => {
    const html = render('gameparam.parambnd.dcx');
    // T5-4 删掉旧 crumb 与文档级信息；容器物理路径/文件名同样不出现。
    assert.ok(!html.includes('Game Parameters'), '旧 crumb 必须删除');
    assert.ok(!html.includes('1 library'), 'library 计数必须删除');
    assert.ok(!html.includes('行大小'), '行大小必须删除');
    assert.ok(!html.includes('gameparam.parambnd.dcx'), '容器文件名不得出现在 DOM');
    // 10-B：工具条左上角的授信句整段删除。
    assert.ok(!html.includes('字段元数据已自动授信'), '授信句必须删除');
  });

  it('10-B（source）：授信句不得存在于 ParamWorkbench 源码（负向扰动会红）', () => {
    // SSR 里 definition 恒为 null，授信句被「definition !== null」挡在渲染之外，
    // 光靠 html 断言无法感知把句子加回去。补一条源码断言：句子一回来就读得到。
    const source = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'ParamWorkbench.tsx'),
      'utf8'
    );
    assert.ok(!source.includes('字段元数据已自动授信'), '字段元数据已自动授信 必须从 ParamWorkbench.tsx 删除');
  });

  it('三栏 Params/Rows/Fields 同时存在（T5-4 删第四栏 Tools）', () => {
    const html = render();
    assert.match(html, /aria-label="Params"/);
    assert.match(html, /aria-label="Rows"/);
    assert.match(html, /aria-label="Fields"/);
    assert.ok(!html.includes('aria-label="Tools"'), '第四栏 Tools 必须删除');
  });

  it('三栏按 §7.1 固定比例与最小宽度渲染（20/29/35，180/260/240）', () => {
    const html = render();
    // React SSR 的 style 序列化无空格（flex:0.2 1 0;min-width:180px）。
    // Fields 下限 320→240（问题 3：Agent 拉宽后主区装不下 760，FIELDS 被挤
    // 出可视区；与 FMG 文本列同档，窄主区仍可横向滚动兜底）。
    assert.match(html, /style="flex:0\.2 1 0;min-width:180px"/);
    assert.match(html, /style="flex:0\.29 1 0;min-width:260px"/);
    assert.match(html, /style="flex:0\.35 1 0;min-width:240px"/);
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

  it('工具条（T5-4 + 问题 4）：新建行/复制当前行/删除当前行 + 导出行/导入行/导出备注/导入备注 七个真实按钮，未选表时禁用', () => {
    const html = render();
    // SSR 初始 selectedEntry=null，全部按钮 disabled（没有可操作的表格目标）。
    // 这是真实功能的禁用态，不是 §7.6 禁止的「未接通工具的假按钮」。
    assert.ok(html.includes('>新建行</button>'), '缺少新建行按钮');
    assert.ok(html.includes('>复制当前行</button>'), '缺少复制当前行按钮');
    assert.ok(html.includes('>删除当前行</button>'), '缺少删除当前行按钮');
    assert.ok(html.includes('>导出行</button>'), '缺少导出行按钮');
    assert.ok(html.includes('>导入行</button>'), '缺少导入行按钮');
    assert.ok(html.includes('>导出备注</button>'), '缺少导出备注按钮');
    assert.ok(html.includes('>导入备注</button>'), '缺少导入备注按钮');
    const buttons = html.match(/<button/g) ?? [];
    assert.equal(buttons.length, 7, '工具条应恰好 7 个按钮');
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
  const paramIpcSource = stripComments(readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'main', 'ipc', 'param.ts'),
    'utf8'
  ));
  const preloadSource = stripComments(readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'preload', 'index.ts'),
    'utf8'
  ));

  it('backup 不读：所有 param 读取通道都必须拒绝（PARAM 两个 + GPARAM 一个）', () => {
    // 3 个读取通道（readParamDocument / readParamPage / readGparamDocument）各带
    // 一处 BACKUP_READ_FORBIDDEN；五个写通道（GPARAM/MTD/ESD/TAE/FXR：
    // commitGparamMutations、commitMtdPropertySet、commitEsdTransition、
    // commitTaeEvent、commitFxrFieldSet）也各带一处（backup 是 History-only，
    // 写同样被拒）—— 所以非注释总数是 8。
    const matches = ipcSource.match(/BACKUP_READ_FORBIDDEN/g) ?? [];
    assert.equal(matches.length, 8,
      'BACKUP_READ_FORBIDDEN 应覆盖 3 个读取通道 + 5 个写通道（GPARAM/MTD/ESD/TAE/FXR）');
    // 每个 handler 都调用同一判定函数（行为测试见上），拒绝不能只挂在一个通道。
    // 新加读取/写入通道时必须同步扩展这里：少一个通道就少一处 backup 泄漏。
    const doc = sliceHandler(ipcSource, 'resource.readParamDocument');
    const page = sliceHandler(ipcSource, 'resource.readParamPage');
    const gparam = sliceHandler(ipcSource, 'resource.readGparamDocument');
    const gparamWrite = sliceHandler(ipcSource, 'resource.commitGparamMutations');
    const mtdWrite = sliceHandler(ipcSource, 'resource.commitMtdPropertySet');
    const esdWrite = sliceHandler(ipcSource, 'resource.commitEsdTransition');
    const taeWrite = sliceHandler(ipcSource, 'resource.commitTaeEvent');
    const fxrWrite = sliceHandler(ipcSource, 'resource.commitFxrFieldSet');
    assert.ok(doc.includes('isParamBackupPath('), 'readParamDocument 未调用 isParamBackupPath');
    assert.ok(page.includes('isParamBackupPath('), 'readParamPage 未调用 isParamBackupPath');
    assert.ok(gparam.includes('isParamBackupPath('), 'readGparamDocument 未调用 isParamBackupPath');
    assert.ok(gparamWrite.includes('isParamBackupPath('), 'commitGparamMutations 未调用 isParamBackupPath');
    assert.ok(mtdWrite.includes('isParamBackupPath('), 'commitMtdPropertySet 未调用 isParamBackupPath');
    assert.ok(esdWrite.includes('isParamBackupPath('), 'commitEsdTransition 未调用 isParamBackupPath');
    assert.ok(taeWrite.includes('isParamBackupPath('), 'commitTaeEvent 未调用 isParamBackupPath');
    assert.ok(fxrWrite.includes('isParamBackupPath('), 'commitFxrFieldSet 未调用 isParamBackupPath');
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

  it('加载指示器在虚拟容器外、无行数守卫（问题 5-A）', () => {
    // 首次打开大表时一行都没有，指示器被 visibleRows.length > 0 挡住就是
    // 永远不出现；且指示器必须和筛选框/空态同一层（虚拟容器外面），不能藏
    // 在数万像素的 sizer 后面。role=status 是 e2e 找节点的锚。
    assert.ok(workbenchSource.includes('读取行数据…'), '加载指示器必须用「读取行数据…」文案');
    assert.ok(workbenchSource.includes('role="status"'), '加载指示器必须带 role="status"');
    assert.doesNotMatch(workbenchSource, /rowsLoading && visibleRows\.length > 0/,
      '指示器不得带 visibleRows.length > 0 守卫');
    assert.doesNotMatch(workbenchSource, /style=\{\{ padding: '4px 10px' \}\}>加载中…/,
      '虚拟容器内的旧「加载中…」指示器必须删除');
  });

  it('PARAM First Bad：首屏走行索引，选中行才走非全量 payload', () => {
    assert.match(workbenchSource, /bridge\.readContainerParamRowIndex\(/,
      '首屏必须调用 readContainerParamRowIndex');
    assert.match(workbenchSource, /bridge\.readContainerParamPage\([\s\S]*?false\s*\)/,
      '选中行 payload 必须显式传 loadAll=false');
    assert.match(workbenchSource, /false,\s*documentSessionToken\s*\)/,
      '选中行 payload 必须复用行索引返回的 native session token');
    assert.doesNotMatch(
      workbenchSource,
      /readContainerParamPage\(\s*props\.containerUri,\s*selectedEntry,\s*0,\s*0,\s*'',\s*true\s*\)/,
      '首屏不得再调用 readContainerParamPage(..., true)'
    );

    const rowIndexHandler = sliceHandler(paramIpcSource, 'resource.readContainerParamRowIndex');
    assert.match(rowIndexHandler, /includeRowPayloads:\s*false/,
      '容器行索引必须显式关闭 payload');
    assert.match(rowIndexHandler, /includeRowHashes:\s*true/,
      '容器行索引必须返回 dataHash');
    assert.match(rowIndexHandler, /rowIndex:/,
      '容器行索引必须返回物理 rowIndex');
    assert.match(rowIndexHandler, /dataHash:/,
      '容器行索引必须返回物理 dataHash');
    assert.match(rowIndexHandler, /sessionToken/,
      '容器行索引必须把 native session token 带回 renderer');

    const pageHandler = sliceHandler(paramIpcSource, 'resource.readContainerParamPage');
    assert.match(pageHandler, /includeRowPayloads:\s*false/,
      '容器分页的首次 session 打开必须走 lazy index');
    assert.match(pageHandler, /documentSession:/,
      '容器分页 payload 必须复用 lazy session');
    assert.match(pageHandler, /rowSelections:/,
      '容器分页 payload 必须按物理身份选择行');
    assert.match(pageHandler, /requestedDocumentSessionToken|documentSessionToken/,
      '容器分页必须接收并复用 native session token');
    const preloadPage = preloadSource.slice(
      preloadSource.indexOf('readContainerParamPage:'),
      preloadSource.indexOf('readContainerParamRowIndex:')
    );
    assert.match(preloadPage, /documentSessionToken/,
      'preload 必须把 native session token 传给容器分页 IPC');
  });

  it('backup 拒绝只属于 IPC 层：组件不得自行拼拒绝逻辑', () => {
    assert.ok(!workbenchSource.includes('BACKUP_READ_FORBIDDEN'), 'ParamWorkbench 不应包含 backup 拒绝码');
    assert.ok(!workbenchSource.includes('isParamBackupPath'), 'ParamWorkbench 不应自行判定 backup 路径');
  });

  it('S29：bool / 1bit 走 checkbox，点一下 commitField，s32/f32 仍是文本框', () => {
    assert.match(workbenchSource, /isParamCheckboxField/);
    assert.match(workbenchSource, /type="checkbox"/);
    // bool 传 boolean（core 写器按 truthy 判定，字符串 'false' 会误写成 1）；
    // 1bit 传 '1'/'0' 字符串。
    assert.match(workbenchSource, /commitField\(field, field\.type === 'bool' \? checked : next\)/);
    assert.doesNotMatch(workbenchSource, /type === 's32'[\s\S]{0,40}checkbox/);
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

describe('S28 保存提示 + 枚举能关（010741）', () => {
  const source = stripComments(readFileSync(
    join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'ParamWorkbench.tsx'),
    'utf8'
  ));

  it('保存成功给短时提示「已保存」，失败走 error 提示（不自动消失）', () => {
    // 三条写入通道（字段、行名、CSV 导入）成功都走 showToast('已保存', 'ok')。
    assert.ok(source.includes("showToast('已保存', 'ok')"), '成功路径必须有「已保存」提示');
    // 失败一律 error 种类：toast 只在 kind==='ok' 时设消失计时器。
    assert.ok(source.includes("kind === 'ok'"), '只有成功提示才自动消失');
    assert.ok(source.includes('window.setTimeout(() => setToast(null), 2500)'), '成功提示几秒后自清');
    // 不再把提交结果写进常驻 footer。
    assert.ok(!source.includes('已提交到变更候选'), '旧的常驻「变更候选」文案必须移除');
    assert.ok(!source.includes('commitMessage'), 'commitMessage 状态已删除');
  });

  it('toast 渲染为工作台内浮条（role=status，成功/失败两种形态）', () => {
    assert.ok(source.includes('className={`wb-toast wb-toast--${toast.kind}`}'), 'toast 按种类着色');
    assert.ok(source.includes('role="status"'), 'toast 可被读屏播报');
  });

  it('枚举列表能关：Esc、点击外部、换行都收起', () => {
    assert.ok(source.includes("document.addEventListener('pointerdown', onPointerDown)"), '点击外部监听在场');
    assert.ok(source.includes("target.closest('.wb-enum-list, .wb-enum-toggle')"), '点击列表内部不误关');
    assert.ok(source.includes("if (event.key === 'Escape')"), 'Esc 关闭在场');
  });
});

describe('S29 能打开就能写（grok §1-9/§1-10）', () => {
  const workbenchSource = stripComments(readFileSync(
    join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'ParamWorkbench.tsx'),
    'utf8'
  ));
  const appSource = stripComments(readFileSync(
    join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx'),
    'utf8'
  ));
  const ipcSource = stripComments(readFileSync(
    join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'ipc.ts'),
    'utf8'
  ));

  it('bool 与 1bit 字段渲染为打勾（checkbox），不再用数字框', () => {
    // 判定唯一来源是共享 helper paramCheckboxField.ts（bool 整字段或 1bit 位域）。
    assert.ok(workbenchSource.includes('isParamCheckboxField'), '共享打勾判定在场');
    const helperSource = stripComments(readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'paramCheckboxField.ts'),
      'utf8'
    ));
    assert.ok(helperSource.includes("field.type === 'bool' || field.bitfield?.bitWidth === 1"), 'isParamCheckboxField 判定在场');
    assert.ok(workbenchSource.includes('type="checkbox"'), '打勾控件在场');
    assert.ok(workbenchSource.includes('onChange'), '打勾即提交');
  });

  it('bool 值归一成 boolean 提交（core 写器按 truthy 判定，字符串 false 会误写为 1）', () => {
    assert.ok(workbenchSource.includes("typeof raw === 'boolean'"), 'boolean 原样透传');
    assert.ok(workbenchSource.includes("raw.trim().toLowerCase() === 'true' || raw.trim() === '1'"), '文本 true/1 归一为 boolean');
  });

  it('renderer 不再拿「缺少容器或条目哈希」拒绝写入', () => {
    assert.ok(!appSource.includes('缺少容器或条目哈希'), '哈希拒写文案已删除');
  });

  it('main 侧缺哈希写时现算（sha256FileNow 兜底，不挡写入）', () => {
    assert.ok(ipcSource.includes('async function sha256FileNow'), '现算 helper 在场');
    assert.ok(ipcSource.includes('file.sha256 ?? await sha256FileNow(file.absolutePath)'), '容器哈希现算兜底');
    assert.ok(ipcSource.includes('|| await sha256FileNow(unpacked.child.absolutePath)'), '条目哈希现算兜底');
  });

  it('main 不再弹「确认高风险写入」（确认端口从 PARAM 链拆除）', () => {
    // 容器 PARAM 三条通道（字段/行名/批量导入）不再把 electronConfirmationPort
    // 接进 applyNativeMutation —— 那是「高风险写入」弹窗的唯一入口。
    const fieldChain = ipcSource.slice(ipcSource.indexOf('resource.applyContainerParamFieldMutation'));
    assert.ok(!fieldChain.includes('electronConfirmationPort'), '字段链无确认端口');
  });
});
