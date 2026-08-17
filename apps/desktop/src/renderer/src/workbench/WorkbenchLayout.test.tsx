/**
 * WorkbenchLayout 栏宽回归（S27）：像素模式守 minWidth、容器未量到宽不得
 * 把栏写成 0、点选不得重挂布局。
 *
 * SSR 无法执行拖拽交互，这里用源码级断言锁关键行为（与 FmgWorkbenchPanel
 * Negative source tests 同一范式）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

const layoutSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'workbench', 'WorkbenchLayout.tsx'),
  'utf8'
);

const columns: WorkbenchColumnSpec[] = [
  { id: 'rows', title: 'ROWS', initialWidth: 260, minWidth: 260, children: null },
  { id: 'fields', title: 'FIELDS', initialFlex: 1, children: null }
];

describe('S27 栏宽回归（WorkbenchLayout）', () => {
  it('SSR：两栏骨架渲染（初始像素栏 + 比例栏），分隔条在场', () => {
    const html = renderToStaticMarkup(
      <WorkbenchLayout label="PARAM 工作台" columns={columns} />
    );
    assert.match(html, /ROWS/);
    assert.match(html, /FIELDS/);
    assert.match(html, /role="separator"/);
    assert.match(html, /恢复默认栏宽/);
  });

  it('像素模式也必须守 minWidth：style 同时带 width 与 minWidth', () => {
    assert.match(layoutSource, /minWidth: `\$\{column\.minWidth \?\? DEFAULT_MIN_WIDTH\}px`/);
    assert.match(layoutSource, /flex: '0 0 auto'/);
    // 拖拽/键盘写入的值都被 Math.max(minWidth, …) 钳住。
    assert.match(layoutSource, /Math\.max\(drag\.minWidth, drag\.startWidth \+ delta\)/);
    assert.match(layoutSource, /Math\.max\(minWidth, measured - step\)/);
  });

  it('容器尚未量到宽（clientWidth ≤ 0）时 maxWidthFor 返回无穷大，不得把栏写成 0', () => {
    assert.match(layoutSource, /container\.clientWidth <= 0\) return Number\.POSITIVE_INFINITY/);
  });

  it('量出的起始宽度同样钳 minWidth（栏被其它栏挤窄时首拖不回弹到一条缝）', () => {
    assert.match(layoutSource, /量出的宽度同样不得低于该栏 minWidth/);
    assert.match(layoutSource, /Math\.max\(column\.minWidth \?\? DEFAULT_MIN_WIDTH, measured\)/);
  });
});
