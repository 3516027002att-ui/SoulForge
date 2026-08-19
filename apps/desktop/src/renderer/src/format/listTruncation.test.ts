/**
 * 列表截断与分页文案的单元测试（问题 5 之后）。
 *
 * 旧版这组断言的立论是「截断必须说出来」：renderer 十余处列表静默
 * `slice(0, N)`，只靠容器 overflow 挡住视觉，用户无从得知数据被砍，所以界面
 * 必须报「已解析 N，显示前 M」。问题 5 推翻了这个决定：**正确行为是不再截断**
 * ——列表 `array.map` 全量进 DOM，栏自己滚动。因此这里不再锁「截断说明必须
 * 出现」，而是锁「源码不得再按条数砍显示」。
 *
 * - 纯函数契约（formatListTruncation）保留：该 helper 在 5a 面板收敛前仍被
 *   使用，测试保证其行为与文档一致；
 * - 渲染站点对账从「必须出现 *-truncation」改为「已全量渲染的站点不得再
 *   `slice(0, 数字)` 后直接 map」；
 * - 分页规模常量断言（FILE_LIST_PAGE_SIZE < 9111 之类）整组删除：资源浏览器
 *   已全量渲染，不再有页大小常量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { formatListTruncation } from './uiText.js';

/** renderer 源码根，由测试入口在编译期注入（不能用 import.meta.url：打包后指向缓存目录）。 */
declare const __SOULFORGE_RENDERER_ROOT__: string;

function readRendererSource(relativePath: string): string {
  return readFileSync(resolve(__SOULFORGE_RENDERER_ROOT__, relativePath), 'utf8');
}

describe('formatListTruncation（5a 面板收敛前仍在使用，保契约）', () => {
  it('没截断时返回 null（调用方据此不渲染说明）', () => {
    assert.equal(formatListTruncation({ total: 10, shown: 10, noun: '条' }), null);
    assert.equal(formatListTruncation({ total: 3, shown: 10, noun: '条' }), null);
    assert.equal(formatListTruncation({ total: 0, shown: 0, noun: '条' }), null);
  });

  it('截断时同时报出总数、显示数和未显示数（helper 仍按此契约产出）', () => {
    const text = formatListTruncation({ total: 518, shown: 80, noun: '条' });
    assert.ok(text, '截断必须产出说明');
    assert.match(text, /518/, '必须报真实总数');
    assert.match(text, /80/, '必须报实际显示数');
    assert.match(text, /438/, '必须报未显示数');
  });
});

describe('显示层不得再按条数砍列表（问题 5）', () => {
  /**
   * 已全量渲染的列表站点。判据：这些文件里不得再出现
   * `slice(0, <数字>)` 后紧跟 `.map(` 的「截断后直接渲染」形态。
   *
   * 刻意只登记本轮已改为全量渲染的站点；5a/问题 3/4 未合入前，ESD/FLVER/VFX/
   * 材质/TPF/FMG/TAE/MSB 场景等面板仍处收敛中，不在此表内（对账扫实际源码，
   * 不为绿假装它们已不截断）。
   */
  const NO_RENDER_SLICE_SITES: ReadonlyArray<{ file: string; why: string }> = [
    { file: 'App.tsx', why: '资源浏览器文件列表、搜索结果、命令面板命中、欢迎页待审查摘要全量渲染' },
    { file: 'components/PreviewCards.tsx', why: '预览卡片各列表全量 map' },
    { file: 'workbench/MsbDataWorkbench.tsx', why: 'MSB 条目列表不再 100 一页' },
    { file: 'workbench/ReadOnlyEntryWorkbench.tsx', why: '只读条目列表不再 100 一页' },
    { file: 'editors/Bnd4WorkbenchPanel.tsx', why: 'BND4 子项跨页累积后全量渲染' },
    { file: 'editors/ScriptContainerPanel.tsx', why: '脚本容器条目跨页累积后全量渲染' },
    { file: 'editors/ParamDefPanel.tsx', why: 'PARAM 行表不再 20 行翻页' },
    { file: 'editors/EmevdFourViewPanel.tsx', why: 'EMEVD 四视图事件表不再 200 一页' },
    { file: 'agent/AgentMessageList.tsx', why: 'Agent 消息全量渲染，不再窗口分页' },
    { file: 'agent/AgentTaskPanel.tsx', why: '会话历史与工具调用全量渲染' },
    { file: 'agent/AgentSecondaryDrawer.tsx', why: '会话历史全量渲染，不再每 10 条一页' }
  ];

  it('这些文件不得再「slice(0, 数字) 后直接 map」渲染列表（负向靶标）', () => {
    const offenders: string[] = [];
    for (const site of NO_RENDER_SLICE_SITES) {
      const source = readRendererSource(site.file);
      const pattern = /\.slice\(0,\s*\d+\)\s*\.map\(/g;
      for (const match of source.matchAll(pattern)) {
        offenders.push(`${site.file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些站点已改为全量渲染；重新引入 slice(0, N) 后直接 map 正是本条要消除的形态'
    );
  });

  it('这些文件不得声明 RENDER_LIMIT / LIST_PAGE_SIZE 之类渲染上限常量', () => {
    const offenders: string[] = [];
    for (const site of NO_RENDER_SLICE_SITES) {
      const source = readRendererSource(site.file);
      if (/render_limit|_PAGE_SIZE\s*=\s*\d+|_RENDER_LIMIT/i.test(source)) {
        // 允许运输契约常量（CONTAINER_PAGE_SIZE / SCRIPT_PAGE_SIZE 跨进程页大小）。
        const transport = /CONTAINER_PAGE_SIZE|SCRIPT_PAGE_SIZE|PARAM_PAGE_SIZE|FMG_PAGE_SIZE/.test(source);
        if (!transport) {
          offenders.push(site.file);
        }
      }
    }
    assert.deepEqual(offenders, [], '显示层不得再有按条数砍的渲染上限常量');
  });

  it('对账能发现重新引入的截断（负向扰动：注入 slice(0, 200).map 必须红）', () => {
    const site = NO_RENDER_SLICE_SITES[0];
    assert.ok(site, '登记表为空，本组断言没有靶标');
    const source = readRendererSource(site.file);
    const injected = `${source}\n{renderedList.slice(0, 200).map((row) => row)}\n`;
    const pattern = /\.slice\(0,\s*\d+\)\s*\.map\(/g;
    const matches = [...injected.matchAll(pattern)];
    assert.ok(matches.length > 0, '注入失败：判据没有抓到 slice(0, N).map，本用例形同虚设');
  });

  it('App.tsx 不再渲染截断说明 testid（search / cmdk / welcome-draft）', () => {
    const source = readRendererSource('App.tsx');
    for (const testid of ['search-truncation', 'cmdk-truncation', 'welcome-draft-truncation']) {
      assert.ok(
        !source.includes(`data-testid="${testid}"`),
        `App.tsx 不应再渲染 ${testid}；重新出现说明截断说明被利旧`
      );
    }
  });

  it('资源浏览器全量渲染：App.tsx 对过滤后的完整集合直接 map，且不再有页大小常量', () => {
    const source = readRendererSource('App.tsx');
    assert.match(
      source,
      /\{physicalBrowseFiles\.map\(/,
      '文件列表必须对完整集合全量 map（问题 5：显示不设限）'
    );
  });
});
