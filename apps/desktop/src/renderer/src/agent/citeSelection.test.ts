import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCiteHits, normalizeRect, rectsIntersect } from './citeSelection.js';
import type { CiteHit } from '@soulforge/shared';

test('normalizeRect：任意拖拽方向都规整为左上/右下', () => {
  assert.deepEqual(normalizeRect({ x: 10, y: 20 }, { x: 100, y: 80 }), {
    left: 10, top: 20, right: 100, bottom: 80
  });
  assert.deepEqual(normalizeRect({ x: 100, y: 80 }, { x: 10, y: 20 }), {
    left: 10, top: 20, right: 100, bottom: 80
  });
  assert.deepEqual(normalizeRect({ x: 100, y: 20 }, { x: 10, y: 80 }), {
    left: 10, top: 20, right: 100, bottom: 80
  });
});

test('rectsIntersect：相交面积 > 0 才算中', () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.equal(rectsIntersect(a, { left: 50, top: 50, right: 150, bottom: 150 }), true);
  assert.equal(rectsIntersect(a, { left: 101, top: 50, right: 150, bottom: 150 }), false);
  // 贴边不算中
  assert.equal(rectsIntersect(a, { left: 100, top: 50, right: 150, bottom: 150 }), false);
  assert.equal(rectsIntersect(a, { left: -50, top: -50, right: 0, bottom: 0 }), false);
});

/** 假 DOM 节点：只实现 collectCiteHits 用到的三个方法（node 无 DOM）。 */
function fakeCiteElement(raw: string, rect: { left: number; top: number; width: number; height: number }) {
  return {
    getAttribute: (name: string): string | null => (name === 'data-cite' ? raw : null),
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height
    })
  };
}

function fakeContainer(elements: Array<ReturnType<typeof fakeCiteElement>>): ParentNode {
  return {
    querySelectorAll: () => elements
  } as unknown as ParentNode;
}

const rowCite = JSON.stringify({
  kind: 'param-row', library: 'gameparam', table: 'ActionGuideParam', rowId: 100, name: '引导-基础'
});
const fieldCite = JSON.stringify({
  kind: 'param-field', library: 'gameparam', table: 'ActionGuideParam', rowId: 100,
  fieldId: 'f_atk', label: '攻击力', value: '0'
});

test('collectCiteHits：只收与框相交的 data-cite 节点，按 DOM 顺序', () => {
  const container = fakeContainer([
    fakeCiteElement(rowCite, { left: 0, top: 0, width: 400, height: 24 }),
    fakeCiteElement(fieldCite, { left: 0, top: 40, width: 400, height: 24 })
  ]);

  // 框住行 + 字段
  let hits = collectCiteHits(container, { left: 10, top: 5, right: 300, bottom: 60 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.kind, 'param-row');
  assert.equal((hits[0] as Extract<CiteHit, { kind: 'param-row' }> | undefined)?.rowId, 100);
  assert.equal(hits[1]?.kind, 'param-field');

  // 只框住行
  hits = collectCiteHits(container, { left: 10, top: 5, right: 300, bottom: 20 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, 'param-row');

  // 完全不相交 → 空
  hits = collectCiteHits(container, { left: 500, top: 500, right: 600, bottom: 600 });
  assert.deepEqual(hits, []);
});

test('collectCiteHits：坏 data-cite 静默跳过，不炸掉整次框选', () => {
  const container = fakeContainer([
    fakeCiteElement('{not json', { left: 0, top: 0, width: 100, height: 20 }),
    fakeCiteElement(rowCite, { left: 0, top: 30, width: 100, height: 20 })
  ]);
  const hits = collectCiteHits(container, { left: 0, top: 0, right: 100, bottom: 60 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, 'param-row');
});

test('collectCiteHits：null 容器返回空', () => {
  assert.deepEqual(collectCiteHits(null, { left: 0, top: 0, right: 10, bottom: 10 }), []);
});
