/**
 * 资源族编辑态复位的单元测试。
 *
 * 这组断言存在的理由是一个实测过的真实缺陷：App.tsx 的两处复位站点是手写 setter
 * 列表，而 openWorkspace **8 个资源族一个都没复位**、selectFile 漏掉
 * FMG/PARAM/EMEVD/MSB。症状是切换工作区或文件后面板继续显示上一个资源的数据，
 * 而漏一项不会有编译错误、测试失败或诊断——只能靠肉眼发现。
 *
 * 因此这里做的是**双向对账**，不是「调一下看不报错」：
 *   - 登记表里的每个 setter 必须真实存在于 App.tsx（防登记表过期）；
 *   - App.tsx 里 useState 解构出的每个 setter 必须已登记或已显式排除并写明理由
 *     （防新增资源族时漏登记）；
 *   - 两处复位站点必须真的调用 resetAllDocuments（防有人改回手写列表）。
 * 只测「resetAllDocuments 会调用传入的函数」是不够的——那种测试挡不住漏登记。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  DOCUMENT_FAMILIES,
  DOCUMENT_STATE_SETTERS,
  NON_DOCUMENT_SETTERS,
  assertDocumentResetCoverage,
  resetAllDocuments,
  type DocumentFamily,
  type DocumentResetActions
} from './documentReset.js';

/**
 * renderer 源码根，由测试入口在编译期注入。
 *
 * 不能用 import.meta.url 推算：测试经 esbuild 打包到 node_modules/.cache 后，
 * import.meta.url 指向缓存目录，相对路径会 ENOENT。也不用 process.cwd()——它随
 * 调用目录漂移，表现是「只在别处复现的红」。
 */
declare const __SOULFORGE_RENDERER_ROOT__: string;

/**
 * 读真实 App.tsx 源码做对账。
 *
 * 用源码文本而不是 import App：App 依赖 React 渲染与 window.soulforge，在纯 Node
 * 环境里加载不了。而本组断言要抓的正是「源码里的 setter 集合与登记表分叉」——
 * 文本对账足够，且不需要 DOM。这一降级是有意的，且必须写明：它不验证复位在运行
 * 期真的生效，那部分由 e2e 覆盖。
 */
function readAppSource(): string {
  return readFileSync(resolve(__SOULFORGE_RENDERER_ROOT__, 'App.tsx'), 'utf8');
}

function makeActions(record: DocumentFamily[]): DocumentResetActions {
  return Object.fromEntries(
    DOCUMENT_FAMILIES.map((family) => [family, () => { record.push(family); }])
  ) as DocumentResetActions;
}

describe('resetAllDocuments', () => {
  it('清空全部登记的资源族，一个不漏', () => {
    const called: DocumentFamily[] = [];
    const cleared = resetAllDocuments(makeActions(called));
    assert.deepEqual(called, [...DOCUMENT_FAMILIES]);
    assert.deepEqual(cleared, [...DOCUMENT_FAMILIES]);
  });

  it('缺少某族的复位动作时抛错，不得静默跳过', () => {
    const called: DocumentFamily[] = [];
    const incomplete = { ...makeActions(called) } as Record<string, unknown>;
    delete incomplete.param;
    assert.throws(
      () => resetAllDocuments(incomplete as DocumentResetActions),
      /DOCUMENT_RESET_MISSING.*param/,
      '缺项必须失败关闭：静默跳过正是本模块要消除的形态'
    );
  });

  it('返回值可用于诊断（报出实际清空了什么，而不是「大概清了」）', () => {
    const cleared = resetAllDocuments(makeActions([]));
    assert.equal(cleared.length, DOCUMENT_FAMILIES.length);
    assert.ok(cleared.includes('fmg') && cleared.includes('msb'));
  });
});

describe('复位登记表与 App.tsx 的双向对账', () => {
  it('登记表里的每个 setter 都真实存在于 App.tsx', () => {
    const report = assertDocumentResetCoverage(readAppSource());
    assert.deepEqual(
      report.registeredButMissing,
      [],
      '登记了但源码里找不到的 setter：登记表已过期，复位会漏掉真实状态'
    );
  });

  it('App.tsx 里每个 useState setter 都已登记或已写明排除理由', () => {
    const report = assertDocumentResetCoverage(readAppSource());
    assert.deepEqual(
      report.presentButUnregistered,
      [],
      '源码里存在但未登记的 setter：新增资源族时漏登记，切换工作区/文件后会残留'
    );
  });

  it('整体覆盖判定为 ok', () => {
    assert.equal(assertDocumentResetCoverage(readAppSource()).ok, true);
  });

  it('每条排除都必须写明理由（否则排除表会变成绕过覆盖检查的后门）', () => {
    const empty = Object.entries(NON_DOCUMENT_SETTERS)
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length === 0)
      .map(([name]) => name);
    assert.deepEqual(empty, []);
  });

  it('排除表不得与登记表重叠（同一个 setter 不能既登记又排除）', () => {
    const registered = new Set(
      DOCUMENT_FAMILIES.flatMap((family) => [...DOCUMENT_STATE_SETTERS[family]])
    );
    const overlap = Object.keys(NON_DOCUMENT_SETTERS).filter((name) => registered.has(name));
    assert.deepEqual(overlap, [], '重叠会让读者无法判断该 setter 到底会不会被复位');
  });

  it('对账能发现登记表漏项（负向：构造一个缺登记的源码）', () => {
    // 源码里多出一个未登记的文档态 setter，对账必须报出来。
    const injected = `${readAppSource()}\n  const [ktxData, setKtxData] = useState(null);\n`;
    const report = assertDocumentResetCoverage(injected);
    assert.equal(report.ok, false);
    assert.ok(
      report.presentButUnregistered.includes('setKtxData'),
      '新增未登记的 setter 必须被报出，否则本组断言形同虚设'
    );
  });

  it('对账能发现登记表指向不存在的 setter（负向）', () => {
    // 从源码里抹掉一个已登记的 setter，对账必须报 registeredButMissing。
    // 用 setTaeData：TPF 已于 TEXTURE-52B 移出自驱动工作台（不再持有 App 级
    // useState），仍登记的 TAE 才是当前登记表的真实成员。
    const stripped = readAppSource().replaceAll('setTaeData', 'setRenamedTaeData');
    const report = assertDocumentResetCoverage(stripped);
    assert.equal(report.ok, false);
    assert.ok(report.registeredButMissing.includes('setTaeData'));
  });
});

describe('两处复位站点必须走统一调度', () => {
  const source = readAppSource();

  /*
   * 判据的意图是「打开工作区这条路径必须复位全部资源族」，不是「必须写在名为
   * openWorkspace 的函数体内」。
   *
   * 手动打开与启动自动挂载现在共用 mountWorkspace（两份挂载逻辑必然漂移，
   * 而漂移的表现是「手动打开清了编辑态、自动挂载没清」这种只在一条路径上出现的
   * 残留）。所以判据跟着真实结构走一跳：openWorkspace 要么自己复位，
   * 要么委派给一个**确实会复位**的函数。
   *
   * 仍然是真判据：委派目标里没有 resetAllDocuments 就会红（负向已实测）。
   * 只认「委派」而不检查目标，才是把判据放宽成装饰。
   */
  it('打开工作区路径复位全部资源族（自身或其委派目标）', () => {
    const match = /async function openWorkspace\(\)[\s\S]*?\n  \}/.exec(source);
    assert.ok(match, '找不到 openWorkspace，测试靶标已失效');
    const body = match[0];
    if (/resetAllDocuments\(documentResetActions\)/.test(body)) return;

    // 委派形态：await someFn(...)。取被调用者名字，再断言它复位。
    const delegated = [...body.matchAll(/await\s+(\w+)\s*\(/g)]
      .map((hit) => hit[1])
      .filter((name) => name !== 'bridge');
    assert.ok(
      delegated.length > 0,
      'openWorkspace 既不自己调用 resetAllDocuments，也没有委派给任何函数：'
      + '实测它此前 8 个族一个都没复位'
    );
    const delegateHasReset = delegated.some((name) => {
      const target = new RegExp(`async function ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
      return target !== null && /resetAllDocuments\(documentResetActions\)/.test(target[0]);
    });
    assert.ok(
      delegateHasReset,
      `openWorkspace 委派给了 ${delegated.join(' / ')}，但其中没有一个调用 `
      + 'resetAllDocuments —— 打开工作区不复位会让新工作区显示上一个工作区的'
      + 'FMG 条目 / PARAM 行 / EMEVD 事件 / MSB 场景'
    );
  });

  it('selectFile 调用 resetAllDocuments', () => {
    const match = /async function selectFile\([\s\S]*?\n  \}/.exec(source);
    assert.ok(match, '找不到 selectFile，测试靶标已失效');
    assert.match(
      match[0],
      /resetAllDocuments\(documentResetActions\)/,
      'selectFile 必须清空全部资源族：实测它此前漏掉 FMG/PARAM/EMEVD/MSB'
    );
  });

  it('复位站点不得退回手写清空列表', () => {
    // 抓「有人在复位站点里逐个手写 setTaeData(null) 之类」的回退。
    //
    // 判据只针对**清空**调用，不针对加载：selectFile 在复位之后会按扩展名读取
    // TAE/ESD/FLVER 并 setXxxData(result.data)，那是正当的加载。把两者一起
    // 禁掉会逼人把加载搬出这个函数，属于为过测试而改结构——测试该贴合真实约束，
    // 不该反过来拧代码。（TPF 已自驱动，不再走 App 级 setTpfData。）
    //
    // 清空形态的识别：setter 后面紧跟 null / 空数组 / 空 Map / EMPTY_ 常量 / false。
    const registered = DOCUMENT_FAMILIES.flatMap((family) => [...DOCUMENT_STATE_SETTERS[family]]);
    const clearingArgument = String.raw`\(\s*(?:null|false|\[\]|new Map\(\)|EMPTY_[A-Z_]+|\{\s*models:\s*0)`;
    /*
     * 靶标是**实际承载复位的函数**，不是入口函数名。
     *
     * openWorkspace 现在只负责弹目录对话框并委派给 mountWorkspace（手动打开与
     * 启动自动挂载共用后者）。继续扫 openWorkspace 等于扫一个空壳 —— 判据会
     * 恒真，而「有人在挂载流程里逐个手写 setTaeData(null)」正好逃掉。
     */
    for (const [label, pattern] of [
      ['mountWorkspace', /async function mountWorkspace\([\s\S]*?\n  \}/],
      ['selectFile', /async function selectFile\([\s\S]*?\n  \}/]
    ] as const) {
      const body = pattern.exec(source)?.[0] ?? '';
      assert.ok(body.length > 0, `找不到 ${label}，测试靶标已失效`);
      const handWritten = registered.filter(
        (setter) => new RegExp(`${setter}${clearingArgument}`).test(body)
      );
      assert.deepEqual(
        handWritten,
        [],
        `${label} 内不应手写清空资源族状态（发现：${handWritten.join('、')}）；`
          + '手写列表漏一项没有任何信号，必须经 resetAllDocuments 统一调度'
      );
    }
  });

  it('该判据能抓到手写清空的回退（负向）', () => {
    // 在 selectFile 体内注入一条手写清空，判据必须报出来。
    // 用正则而不是字面量匹配：源文件是 CRLF，字面量里的 \n 不会命中，注入会静默
    // 失败而本用例照样通过——那正是「负向 fixture 自己失效」的形态。
    const injected = source.replace(
      /resetAllDocuments\(documentResetActions\);(\r?\n\s*)setBnd4Forced\(false\);/,
      'setTaeData(null);$1setBnd4Forced(false);'
    );
    assert.notEqual(injected, source, '注入失败：靶标已变，请更新本用例');

    const body = /async function selectFile\([\s\S]*?\n  \}/.exec(injected)?.[0] ?? '';
    assert.ok(body.length > 0, '注入后仍需能定位 selectFile 函数体');

    // 复用生产判据的同一口径，确认它在注入后确实报出该 setter。
    const registered = DOCUMENT_FAMILIES.flatMap((family) => [...DOCUMENT_STATE_SETTERS[family]]);
    const clearingArgument = String.raw`\(\s*(?:null|false|\[\]|new Map\(\)|EMPTY_[A-Z_]+|\{\s*models:\s*0)`;
    const detected = registered.filter(
      (setter) => new RegExp(`${setter}${clearingArgument}`).test(body)
    );
    assert.deepEqual(
      detected,
      ['setTaeData'],
      '判据必须抓到注入的手写清空，否则上一条断言形同虚设'
    );
  });
});
