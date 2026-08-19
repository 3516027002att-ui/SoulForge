/**
 * 列表截断说明与分页文案的单元测试。
 *
 * 这组断言存在的理由是一个实测缺陷：renderer 里十余处列表用静默
 * `slice(0, 24/32/40/60/80/100/200)` 截断，只靠容器 `overflow-y: auto` 挡住视觉，
 * **用户无从得知数据被砍**。anti-ai-design §4「状态优先于概念」要求界面必须能
 * 回答「已解析多少」；只显示前 N 条却不说总数，用户会把部分当成全部——这与硬
 * 约束 7「必须严格区分 partial 与完整」是同一条红线。
 *
 * 断言按「用户能否回答『我漏看了多少』」组织，而不是按「函数是否返回字符串」：
 * 返回一句「还有更多」在类型上合法，但仍然回答不了那个问题。
 *
 * 除了纯函数契约，这里还对真实源码做**渲染站点对账**：光测 helper 不够——
 * helper 全绿而调用方压根没接，症状与改动前完全一样。对账抓的正是这种形态。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  FILE_LIST_PAGE_SIZE,
  SEARCH_HIT_LIMIT,
  formatListTruncation,
  formatPageRange
} from './uiText.js';

/** renderer 源码根，由测试入口在编译期注入（不能用 import.meta.url：打包后指向缓存目录）。 */
declare const __SOULFORGE_RENDERER_ROOT__: string;

function readRendererSource(relativePath: string): string {
  return readFileSync(resolve(__SOULFORGE_RENDERER_ROOT__, relativePath), 'utf8');
}

describe('formatListTruncation', () => {
  it('没截断时返回 null（调用方据此不渲染说明）', () => {
    assert.equal(formatListTruncation({ total: 10, shown: 10, noun: '条' }), null);
    assert.equal(formatListTruncation({ total: 3, shown: 10, noun: '条' }), null);
    assert.equal(formatListTruncation({ total: 0, shown: 0, noun: '条' }), null);
  });

  it('截断时同时报出总数、显示数和未显示数', () => {
    const text = formatListTruncation({ total: 518, shown: 80, noun: '条' });
    assert.ok(text, '截断必须产出说明');
    assert.match(text, /518/, '必须报真实总数：用户要回答「已解析多少」');
    assert.match(text, /80/, '必须报实际显示数');
    assert.match(text, /438/, '必须报未显示数：只给总数与显示数要用户自己做减法');
  });

  it('文案是具体数字，不是「还有更多」这类回答不了问题的说法', () => {
    const text = formatListTruncation({ total: 9111, shown: 200, noun: '个资源' }) ?? '';
    assert.doesNotMatch(text, /更多|若干|部分数据|等等/, '模糊量词回答不了「漏看多少」');
  });

  it('给了 hint 时附上可用动作；没给时不编造动作', () => {
    const withHint = formatListTruncation({
      total: 100, shown: 10, noun: '条', hint: '用搜索框缩小范围'
    }) ?? '';
    assert.match(withHint, /用搜索框缩小范围/);

    const withoutHint = formatListTruncation({ total: 100, shown: 10, noun: '条' }) ?? '';
    assert.doesNotMatch(
      withoutHint,
      /搜索框|分页|翻页/,
      '面板没有该控件时提示「用搜索框」属于编造可用动作（anti-ai-design §2）'
    );
  });

  it('非有限数不产出说明（NaN 会渲染出「已解析 NaN 条」）', () => {
    assert.equal(formatListTruncation({ total: Number.NaN, shown: 10, noun: '条' }), null);
    assert.equal(formatListTruncation({ total: 10, shown: Number.NaN, noun: '条' }), null);
  });

  it('恰好等于上限时不报截断（边界：off-by-one 会让每个满页都误报）', () => {
    assert.equal(formatListTruncation({ total: 200, shown: 200, noun: '个资源' }), null);
    assert.ok(formatListTruncation({ total: 201, shown: 200, noun: '个资源' }));
  });
});

describe('formatPageRange', () => {
  it('报出本页覆盖区间、总数、页码与页大小', () => {
    const text = formatPageRange({ page: 2, pageSize: 200, total: 9111, noun: '资源' });
    assert.match(text, /401–600/, '必须报本页覆盖的区间，否则用户不知道漏看了哪一段');
    assert.match(text, /9111/, '必须报总数');
    assert.match(text, /第 3\/46 页/, '必须报当前页与总页数');
    assert.match(text, /每页 200/);
  });

  it('末页按真实总数收口，不报越界区间', () => {
    const text = formatPageRange({ page: 45, pageSize: 200, total: 9111, noun: '资源' });
    assert.match(text, /9001–9111/, '末页上界必须是 total，不是 (page+1)*pageSize');
  });

  it('空集合明说没有，不报「1–0 / 共 0」', () => {
    assert.equal(formatPageRange({ page: 0, pageSize: 200, total: 0, noun: '资源' }), '没有资源');
  });

  it('单页刚好整除时页数不多算一页', () => {
    const text = formatPageRange({ page: 0, pageSize: 200, total: 200, noun: '资源' });
    assert.match(text, /第 1\/1 页/);
    assert.match(text, /1–200/);
  });
});

/**
 * 每个曾经静默截断的渲染站点，登记「文件 → 必须出现的截断说明锚点」。
 *
 * 锚点用 data-testid 而不是文案字面量：文案会改，而 testid 是断言与 e2e 共用的
 * 稳定契约。用正则且不含裸换行——源文件是 CRLF，含 `\n` 的字面量匹配会静默失配，
 * 那会让本组断言恒绿。
 */
const TRUNCATION_RENDER_SITES: ReadonlyArray<{
  file: string;
  testId: string;
  why: string;
}> = [
  { file: 'App.tsx', testId: 'search-truncation', why: '搜索结果此前静默 slice(0, 60)' },
  { file: 'App.tsx', testId: 'welcome-draft-truncation', why: '欢迎页待审查摘要此前静默 slice(0, 5)' },
  { file: 'App.tsx', testId: 'cmdk-truncation', why: '命令面板资源命中此前静默 slice(0, 8)' },
  { file: 'components/PreviewCards.tsx', testId: 'preview-truncation', why: '预览卡片此前 8 处静默 slice' },
  { file: 'editors/EsdWorkbenchPanel.tsx', testId: 'esd-truncation', why: '状态组表此前静默 slice(0, 200)' },
  { file: 'editors/FlverWorkbenchPanel.tsx', testId: 'flver-truncation', why: '材质/骨骼/网格三表此前静默截断' },
  { file: 'editors/TpfWorkbenchPanel.tsx', testId: 'tpf-truncation', why: '纹理表截断说明须与其他面板同口径' }
];

describe('截断说明必须真的接进渲染站点', () => {
  for (const site of TRUNCATION_RENDER_SITES) {
    it(`${site.file} 渲染 ${site.testId}（${site.why}）`, () => {
      const source = readRendererSource(site.file);
      assert.match(
        source,
        new RegExp(`data-testid="${site.testId}"`),
        `${site.file} 必须渲染截断说明；helper 全绿而调用方没接，症状与改动前完全一样`
      );
    });
  }

  it('每个登记站点都调用统一 helper，不各写一份文案', () => {
    for (const site of TRUNCATION_RENDER_SITES) {
      const source = readRendererSource(site.file);
      assert.match(
        source,
        /formatListTruncation/,
        `${site.file} 必须走 formatListTruncation：手写文案会让各面板口径分叉`
      );
    }
  });

  it('这些文件里不得再出现静默的数字截断（负向靶标：裸 slice(0, 数字)）', () => {
    // 只查列表渲染用的 slice，不查字符串省略（那是正当的单值截断）。
    // 判据：`.slice(0, <字面数字>)` 紧跟 `.map(` —— 即「截断后直接渲染」。
    const offenders: string[] = [];
    for (const site of TRUNCATION_RENDER_SITES) {
      const source = readRendererSource(site.file);
      const pattern = /\.slice\(0,\s*\d+\)\s*\.map\(/g;
      for (const match of source.matchAll(pattern)) {
        offenders.push(`${site.file}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '截断上限必须是具名常量且配套说明；裸字面量 slice 后直接 map 正是本轮要消除的形态'
    );
  });

  it('对账能发现「说明被摘掉」（负向：抹掉 testid 后必须报红）', () => {
    const site = TRUNCATION_RENDER_SITES[0];
    assert.ok(site, '登记表为空，本组断言没有靶标');
    const source = readRendererSource(site.file);
    const stripped = source.replace(
      new RegExp(`data-testid="${site.testId}"`),
      'data-testid="renamed"'
    );
    assert.notEqual(stripped, source, '注入失败：靶标已变，请更新本用例');
    assert.doesNotMatch(
      stripped,
      new RegExp(`data-testid="${site.testId}"`),
      '判据必须在说明被摘掉后报红，否则上面每条站点断言形同虚设'
    );
  });
});

describe('问题4-D/4-A：TAE/MSB 不再静默截断（显示层取消条数上限）', () => {
  it('TaeWorkbenchPanel 源码不得再有 ANIMATION_RENDER_LIMIT / EVENT_RENDER_LIMIT', () => {
    const source = readRendererSource('editors/TaeWorkbenchPanel.tsx');
    assert.doesNotMatch(source, /const ANIMATION_RENDER_LIMIT\s*=/);
    assert.doesNotMatch(source, /const EVENT_RENDER_LIMIT\s*=/);
    assert.doesNotMatch(source, /animations\.slice\(0, 200\)/);
  });

  it('MsbScenePanel 源码不得再有 MAP_MESH_PREFETCH_LIMIT / GROUP_RENDER_LIMIT / 名字截断', () => {
    const source = readRendererSource('editors/MsbScenePanel.tsx');
    assert.doesNotMatch(source, /MAP_MESH_PREFETCH_LIMIT/);
    assert.doesNotMatch(source, /GROUP_RENDER_LIMIT/);
    assert.doesNotMatch(source, /\.slice\(0,\s*40\)/);
    assert.doesNotMatch(source, /slice\(0, GROUP_RENDER_LIMIT\)/);
  });
});

describe('资源浏览器分页必须真的接进 App.tsx', () => {
  const source = (): string => readRendererSource('App.tsx');

  it('文件列表渲染分页切片，不是全量 visibleFiles.map', () => {
    const text = source();
    assert.match(
      text,
      /\{pagedFiles\.map\(/,
      '必须渲染分页后的切片：visibleFiles 规模等于用户选的目录（实测整树 9111 文件）'
    );
    assert.doesNotMatch(
      text,
      /\{visibleFiles\.map\(/,
      'visibleFiles 全量 map 是本项要消除的形态——只靠 CSS overflow 挡住视觉，DOM 仍全量建出'
    );
  });

  it('渲染分页导航控件（截断而不给翻页入口等于砍掉数据）', () => {
    assert.match(source(), /data-testid="file-list-pager"/);
    assert.match(source(), /data-testid="file-list-page-range"/);
  });

  it('页码随过滤条件复位（否则改过滤词会停在越界空页，看起来与「没有匹配」一样）', () => {
    const text = source();
    const effect = /useEffect\(\(\) => \{\s*setFilePage\(0\);\s*\},\s*\[([^\]]*)\]\)/.exec(text);
    assert.ok(effect, '找不到页码复位 effect，靶标已失效');
    for (const dependency of ['resourceMode', 'query']) {
      assert.ok(
        effect[1]?.includes(dependency),
        `复位依赖必须含 ${dependency}：该值一变，原页码就可能越界`
      );
    }
  });

  it('页码越界被夹紧，不直接用裸 filePage 取切片', () => {
    const text = source();
    assert.match(text, /clampedFilePage/, '必须存在夹紧后的页码');
    // SHELL-09 把 visibleFiles 改名 physicalBrowseFiles（Files 独占物理浏览）；
    // 断言的是「切片用夹紧页码」这个形态，不是具体变量名。
    assert.match(
      text,
      /pagedFiles\s*=\s*useMemo\(\s*\(\)\s*=>\s*\w+\.slice\(\s*clampedFilePage/,
      '切片必须用夹紧后的页码：裸页码越界会渲染空列表，与「没有资源」无法区分'
    );
  });
});

describe('资源浏览器分页规模常量', () => {
  it('页大小是有限正整数，且远小于实测最大工作区规模（9111 文件）', () => {
    assert.ok(Number.isInteger(FILE_LIST_PAGE_SIZE) && FILE_LIST_PAGE_SIZE > 0);
    assert.ok(
      FILE_LIST_PAGE_SIZE < 9111,
      '页大小若不小于实测最大规模，分页等于没分页'
    );
  });

  it('搜索结果上限是有限正整数', () => {
    assert.ok(Number.isInteger(SEARCH_HIT_LIMIT) && SEARCH_HIT_LIMIT > 0);
  });

  it('9111 个文件按此页大小分页后，单页 DOM 规模等于页大小', () => {
    const total = 9111;
    const pageCount = Math.ceil(total / FILE_LIST_PAGE_SIZE);
    const lastPageSize = total - (pageCount - 1) * FILE_LIST_PAGE_SIZE;
    assert.ok(pageCount > 1, '实测规模必须真的跨页，否则本组断言没有靶标');
    assert.ok(lastPageSize > 0 && lastPageSize <= FILE_LIST_PAGE_SIZE);
  });
});
