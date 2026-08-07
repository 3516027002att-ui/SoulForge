/**
 * 可选中行无障碍契约的单元测试。
 *
 * 这组断言的存在理由是一个实测缺陷：多个编辑器面板用
 * `<div role="row" onClick={...}>` 做行选择，键盘完全不可达。其中
 * FmgWorkbenchPanel 与 ParamDefPanel 两处**阻断整个编辑流程**——必须先选行才会
 * 出现编辑控件，键盘用户因此进不去编辑态。
 *
 * 断言按「键盘用户能否完成同一件事」组织，而不是按「属性是否存在」：
 * tabIndex=0 存在但 onKeyDown 不响应 Space，用户体验上仍然是不可用。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRowTabEntry, selectableRowAttributes } from './selectableRow.js';

function fakeEvent(key: string): { key: string; preventDefault: () => void; prevented: boolean } {
  const event = {
    key,
    prevented: false,
    preventDefault(): void { event.prevented = true; }
  };
  return event;
}

describe('selectableRowAttributes', () => {
  it('点击触发选择', () => {
    let selected = 0;
    const attributes = selectableRowAttributes({
      selected: false, isTabEntry: false, onSelect: () => { selected += 1; }
    });
    attributes.onClick();
    assert.equal(selected, 1);
  });

  it('Enter 与 Space 都触发选择（只认 Enter 会让习惯 Space 的用户以为行不可选）', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      let selected = 0;
      const attributes = selectableRowAttributes({
        selected: false, isTabEntry: false, onSelect: () => { selected += 1; }
      });
      attributes.onKeyDown(fakeEvent(key));
      assert.equal(selected, 1, `${key} 应触发选择`);
    }
  });

  it('Space 必须 preventDefault（否则页面滚动）', () => {
    const event = fakeEvent(' ');
    selectableRowAttributes({ selected: false, isTabEntry: false, onSelect: () => {} })
      .onKeyDown(event);
    assert.equal(event.prevented, true);
  });

  it('Enter 也 preventDefault（避免容器内触发表单提交）', () => {
    const event = fakeEvent('Enter');
    selectableRowAttributes({ selected: false, isTabEntry: false, onSelect: () => {} })
      .onKeyDown(event);
    assert.equal(event.prevented, true);
  });

  it('其他按键不触发选择、不拦默认行为（方向键必须留给容器导航）', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Escape', 'a', 'Home', 'End']) {
      let selected = 0;
      const event = fakeEvent(key);
      selectableRowAttributes({
        selected: false, isTabEntry: false, onSelect: () => { selected += 1; }
      }).onKeyDown(event);
      assert.equal(selected, 0, `${key} 不应触发选择`);
      assert.equal(event.prevented, false, `${key} 不应被 preventDefault`);
    }
  });

  it('roving tabindex：选中行进 Tab 序列', () => {
    const attributes = selectableRowAttributes({
      selected: true, isTabEntry: false, onSelect: () => {}
    });
    assert.equal(attributes.tabIndex, 0);
    assert.equal(attributes['aria-selected'], true);
  });

  it('roving tabindex：未选中且非入口行不进 Tab 序列', () => {
    const attributes = selectableRowAttributes({
      selected: false, isTabEntry: false, onSelect: () => {}
    });
    assert.equal(
      attributes.tabIndex,
      -1,
      '若每行都是 tabIndex=0，几百行会各占一个 Tab 停靠点，键盘导航不可用'
    );
    assert.equal(attributes['aria-selected'], false);
  });

  it('roving tabindex：无选中时入口行可 Tab 到（否则整表无法用键盘进入）', () => {
    const attributes = selectableRowAttributes({
      selected: false, isTabEntry: true, onSelect: () => {}
    });
    assert.equal(attributes.tabIndex, 0);
  });

  it('role 固定为 row', () => {
    assert.equal(
      selectableRowAttributes({ selected: false, isTabEntry: false, onSelect: () => {} }).role,
      'row'
    );
  });
});

describe('isRowTabEntry', () => {
  it('无选中项时第一行是入口', () => {
    assert.equal(isRowTabEntry(0, false), true);
    assert.equal(isRowTabEntry(1, false), false);
    assert.equal(isRowTabEntry(5, false), false);
  });

  it('有选中项时不再指定入口（入口由选中行本身承担）', () => {
    for (const index of [0, 1, 5]) {
      assert.equal(isRowTabEntry(index, true), false);
    }
  });

  it('整表恰好一个 Tab 停靠点（无选中场景）', () => {
    const rows = Array.from({ length: 200 }, (_unused, index) => index);
    const entries = rows.filter((index) => isRowTabEntry(index, false));
    assert.equal(entries.length, 1, '无选中时必须恰好一个入口');
  });

  it('整表恰好一个 Tab 停靠点（有选中场景）', () => {
    const rows = Array.from({ length: 200 }, (_unused, index) => index);
    const selectedIndex = 42;
    const stops = rows.filter((index) => {
      const attributes = selectableRowAttributes({
        selected: index === selectedIndex,
        isTabEntry: isRowTabEntry(index, true),
        onSelect: () => {}
      });
      return attributes.tabIndex === 0;
    });
    assert.deepEqual(stops, [selectedIndex], '有选中时唯一停靠点必须是选中行');
  });
});
