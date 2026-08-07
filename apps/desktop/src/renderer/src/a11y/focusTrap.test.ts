/**
 * 模态焦点管理的单元测试。
 *
 * 覆盖的缺陷：命令面板与 Agent 抽屉都是 role="dialog" 但都不拦 Tab，焦点可以
 * Tab 出模态落到背后的主界面上——对键盘/屏幕阅读器用户来说是「对话框开着，但我
 * 在操作被它遮住的东西」，且无任何提示。
 *
 * 环绕逻辑是这里最容易写错的部分（off-by-one、反向漏处理、空列表除零），因此
 * 断言按边界组织，而不是只测「正常 Tab 前进一格」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOCUSABLE_SELECTOR, isTrappableElement, nextTrappedFocusIndex } from './focusTrap.js';

describe('nextTrappedFocusIndex', () => {
  it('正向 Tab 前进一格', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 0, shift: false }), 1);
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 3, shift: false }), 4);
  });

  it('正向 Tab 到末尾环绕回第一个（否则焦点会 Tab 出模态）', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 4, shift: false }), 0);
  });

  it('反向 Tab 后退一格', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 4, shift: true }), 3);
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 1, shift: true }), 0);
  });

  it('反向 Tab 到开头环绕到最后一个', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 5, currentIndex: 0, shift: true }), 4);
  });

  it('焦点不在模态内时，正向进第一个、反向进最后一个', () => {
    // 对话框刚打开、焦点还在外面时按 Tab 也要正确进入，而不是先跳到外部元素
    // 再被拉回来（那会产生一次可见的焦点闪跳）。
    assert.equal(nextTrappedFocusIndex({ focusableCount: 3, currentIndex: -1, shift: false }), 0);
    assert.equal(nextTrappedFocusIndex({ focusableCount: 3, currentIndex: -1, shift: true }), 2);
  });

  it('单个可聚焦元素时 Tab 停在原地（不得越界，也不得离开模态）', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 1, currentIndex: 0, shift: false }), 0);
    assert.equal(nextTrappedFocusIndex({ focusableCount: 1, currentIndex: 0, shift: true }), 0);
  });

  it('无可聚焦元素时返回 -1，不得除零或返回越界索引', () => {
    assert.equal(nextTrappedFocusIndex({ focusableCount: 0, currentIndex: -1, shift: false }), -1);
    assert.equal(nextTrappedFocusIndex({ focusableCount: 0, currentIndex: 0, shift: true }), -1);
  });

  it('连续 Tab 一圈后回到起点（环绕闭合，不漏不重）', () => {
    const count = 4;
    let index = 0;
    const visited = [index];
    for (let step = 0; step < count; step += 1) {
      index = nextTrappedFocusIndex({ focusableCount: count, currentIndex: index, shift: false });
      visited.push(index);
    }
    assert.deepEqual(visited, [0, 1, 2, 3, 0], '一圈必须恰好覆盖每个元素一次并闭合');
  });

  it('连续 Shift+Tab 一圈同样闭合', () => {
    const count = 4;
    let index = 0;
    const visited = [index];
    for (let step = 0; step < count; step += 1) {
      index = nextTrappedFocusIndex({ focusableCount: count, currentIndex: index, shift: true });
      visited.push(index);
    }
    assert.deepEqual(visited, [0, 3, 2, 1, 0]);
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('排除 tabindex="-1"（否则 Tab 会在几百个表格行之间打转）', () => {
    assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
  });

  it('排除 disabled 控件', () => {
    for (const tag of ['button', 'input', 'select', 'textarea']) {
      assert.ok(
        FOCUSABLE_SELECTOR.includes(`${tag}:not([disabled])`),
        `${tag} 必须排除 disabled`
      );
    }
  });

  it('覆盖链接与全部表单控件', () => {
    for (const needle of ['a[href]', 'button', 'input', 'select', 'textarea']) {
      assert.ok(FOCUSABLE_SELECTOR.includes(needle));
    }
  });
});

describe('isTrappableElement', () => {
  function element(attributes: Record<string, string>, ariaHiddenAncestor = false): Parameters<typeof isTrappableElement>[0] {
    return {
      hasAttribute: (name) => name in attributes,
      getAttribute: (name) => attributes[name] ?? null,
      closest: (selector) => (selector === '[aria-hidden="true"]' && ariaHiddenAncestor ? {} : null)
    };
  }

  it('普通元素可参与循环', () => {
    assert.equal(isTrappableElement(element({})), true);
  });

  it('disabled 元素被排除', () => {
    assert.equal(isTrappableElement(element({ disabled: '' })), false);
  });

  it('aria-hidden 自身被排除', () => {
    assert.equal(isTrappableElement(element({ 'aria-hidden': 'true' })), false);
  });

  it('tabindex=-1 被排除（roving tabindex 的移出手段）', () => {
    assert.equal(isTrappableElement(element({ tabindex: '-1' })), false);
    assert.equal(isTrappableElement(element({ tabindex: '0' })), true);
  });

  it('aria-hidden 祖先下的元素被排除（焦点不得落在读不出来的位置）', () => {
    assert.equal(isTrappableElement(element({}, true)), false);
  });
});
