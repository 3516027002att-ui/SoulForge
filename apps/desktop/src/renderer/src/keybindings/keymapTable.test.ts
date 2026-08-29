/**
 * T7 键位表模块的单元测试。
 *
 * 覆盖四块：
 * - 固定表完整性：壳层/共用编辑/各域表的条目与 keys 逐条对规格；
 * - resolveKeybinding：壳层永远命中、editable 抑制、视口门禁、归一化；
 * - normalizeKeyEvent：归一化规则锁定（空格/Space、Escape/Esc、字母小写、
 *   修饰键前缀、修饰键本体）；
 * - statusSuitLabel：对全部 EDITOR_DOMAIN_IDS 返回「壳层 · X」，隐藏域与
 *   未知域合理。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EDITOR_DOMAIN_IDS } from '@soulforge/shared';
import {
  domainKeybindings,
  editKeybindings,
  shellKeybindings,
  statusSuitLabel,
  type KeybindingEntry
} from './keymapTable.js';
import { normalizeKeyEvent, resolveKeybinding, type KeyEventLike } from './applyKeybinding.js';

function keyEvent(partial: { key: string } & Partial<Omit<KeyEventLike, 'key'>>): KeyEventLike {
  return {
    key: partial.key,
    ctrlKey: partial.ctrlKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
    metaKey: partial.metaKey ?? false
  };
}

const VIEWPORT = { targetIsEditable: false, viewportPointerActive: true };
const EDITABLE = { targetIsEditable: true, viewportPointerActive: false };

function keysOf(entries: readonly KeybindingEntry[]): string[] {
  return entries.map((entry) => entry.keys);
}

describe('固定键位表完整性', () => {
  it('壳层恰有 Ctrl+K / Ctrl+J / Ctrl+B 三键', () => {
    const table = shellKeybindings();
    assert.equal(table.length, 3, '壳层必须是恰好三键，不能多不能少');
    assert.deepEqual(
      table.map((entry) => entry.id).sort(),
      ['shell.agent', 'shell.command-palette', 'shell.sidebar']
    );
    for (const required of ['Ctrl+K', 'Ctrl+J', 'Ctrl+B']) {
      assert.ok(keysOf(table).includes(required), `壳层缺 ${required}`);
    }
    assert.ok(table.every((entry) => entry.scope === 'shell'), '壳层条目必须都是 shell 作用域');
  });

  it('共用编辑表含规格要求的键', () => {
    const table = editKeybindings();
    const keys = keysOf(table).join('|');
    for (const required of ['Ctrl+S', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+C', 'Ctrl+V', 'Ctrl+D', 'Ctrl+A', 'Delete']) {
      assert.ok(keys.includes(required), `共用编辑表缺 ${required}`);
    }
    assert.ok(table.some((entry) => entry.id === 'edit.arrows'), '共用编辑表缺方向键条目');
    assert.ok(table.every((entry) => entry.scope === 'edit'), '共用编辑条目必须都是 edit 作用域');
  });

  it('PARAM/文本域含规格要求的键', () => {
    assert.ok(keysOf(domainKeybindings('param')).includes('Ctrl+F'), 'PARAM 域缺 Ctrl+F');

    const textKeys = keysOf(domainKeybindings('text')).join('|');
    for (const required of ['Ctrl+F', 'Insert', 'Alt+D']) {
      assert.ok(textKeys.includes(required), `文本域缺 ${required}`);
    }
  });

  it('事件域含规格要求的键', () => {
    const keys = keysOf(domainKeybindings('event')).join('|');
    for (const required of ['Ctrl+S', 'Ctrl+F', 'Ctrl+H', 'Ctrl+Space', 'Ctrl+W', 'Ctrl+Tab']) {
      assert.ok(keys.includes(required), `事件域缺 ${required}`);
    }
  });

  it('地图/模型视口表含规格要求的键', () => {
    const VIEWPORT_IDS = [
      'move', 'lift', 'rotate', 'speed-up', 'speed-down', 'wheel-speed',
      'box-select', 'focus-camera', 'reset-view', 'gizmo', 'deselect'
    ];
    for (const domain of ['map', 'model'] as const) {
      const table = domainKeybindings(domain);
      const ids = new Set(table.map((entry) => entry.id));
      for (const id of VIEWPORT_IDS) {
        assert.ok(ids.has(`${domain}.${id}`), `${domain} 视口表缺 ${id}`);
      }
      const keys = keysOf(table).join('|');
      for (const required of ['WASD', 'Q/E', '右键', 'Shift+WASD', 'Ctrl', '滚轮', 'F', 'X', 'R', '工具栏按钮', 'Esc']) {
        assert.ok(keys.includes(required), `${domain} 视口表缺 ${required}`);
      }
      assert.ok(table.every((entry) => entry.scope === 'domain' && entry.domain === domain),
        `${domain} 视口条目必须 scope='domain' 且 domain=${domain}`);
    }
  });

  it('动作域含规格要求的键（behavior 与隐藏路由 animation 同表）', () => {
    const ACTION_IDS = ['play-pause', 'replay', 'goto-ends', 'step-frame', 'loop'];
    for (const domain of ['behavior', 'animation'] as const) {
      const table = domainKeybindings(domain);
      const ids = new Set(table.map((entry) => entry.id));
      for (const id of ACTION_IDS) {
        assert.ok(ids.has(`${domain}.${id}`), `${domain} 动作表缺 ${id}`);
      }
      const keys = keysOf(table).join('|');
      for (const required of ['Space', 'Shift+Space', 'Home/End', 'Left/Right', 'Ctrl+L']) {
        assert.ok(keys.includes(required), `${domain} 动作表缺 ${required}`);
      }
    }
  });

  it('未定义键位表的域返回空表', () => {
    for (const domain of ['project', 'script', 'texture', 'material', 'vfx', 'container', 'files', 'gparam']) {
      assert.deepEqual(domainKeybindings(domain), [], `${domain} 应无键位表`);
    }
    assert.deepEqual(domainKeybindings('no-such-domain'), [], '未知域返回空表');
  });
});

describe('normalizeKeyEvent 归一化', () => {
  it('空格键归一化为 Space，Shift+空格为 Shift+Space', () => {
    assert.equal(normalizeKeyEvent(keyEvent({ key: ' ' })), 'Space');
    assert.equal(normalizeKeyEvent(keyEvent({ key: ' ', shiftKey: true })), 'Shift+Space');
  });

  it('Escape 归一化为 Esc', () => {
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Escape' })), 'Esc');
  });

  it('字母统一小写，修饰键前缀 Ctrl → Shift → Alt → Meta', () => {
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'W' })), 'w');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'k', ctrlKey: true })), 'Ctrl+k');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'd', altKey: true })), 'Alt+d');
    assert.equal(
      normalizeKeyEvent(keyEvent({ key: 'w', ctrlKey: true, shiftKey: true, altKey: true, metaKey: true })),
      'Ctrl+Shift+Alt+Meta+w'
    );
  });

  it('修饰键本体直接返回键名，不叠加同名前缀', () => {
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Shift' })), 'Shift');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Control' })), 'Ctrl');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Alt' })), 'Alt');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Meta' })), 'Meta');
  });

  it('特殊键原样保留 event.key 值', () => {
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'ArrowLeft' })), 'ArrowLeft');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Enter' })), 'Enter');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Delete' })), 'Delete');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Insert' })), 'Insert');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Home' })), 'Home');
    assert.equal(normalizeKeyEvent(keyEvent({ key: 'Tab', ctrlKey: true })), 'Ctrl+Tab');
  });
});

describe('resolveKeybinding', () => {
  it('壳层键在 editable 目标下仍命中', () => {
    const out = resolveKeybinding(keyEvent({ key: 'k', ctrlKey: true }), 'param', EDITABLE);
    assert.ok(out.hit);
    if (out.hit) assert.equal(out.entry.id, 'shell.command-palette');
  });

  it('壳层键在视口内仍命中', () => {
    const out = resolveKeybinding(keyEvent({ key: 'b', ctrlKey: true }), 'map', VIEWPORT);
    assert.ok(out.hit);
    if (out.hit) assert.equal(out.entry.id, 'shell.sidebar');
  });

  it('edit 键在 editable 下被抑制', () => {
    const out = resolveKeybinding(keyEvent({ key: 's', ctrlKey: true }), 'param', EDITABLE);
    assert.deepEqual(out, { hit: false, reason: 'editable-target' });
  });

  it('domain 键在 editable 下被抑制', () => {
    const out = resolveKeybinding(keyEvent({ key: 'f', ctrlKey: true }), 'event', EDITABLE);
    assert.deepEqual(out, { hit: false, reason: 'editable-target' });
  });

  it('WASD 在 map 视口内命中，指针在外不命中', () => {
    const hit = resolveKeybinding(keyEvent({ key: 'w' }), 'map', VIEWPORT);
    assert.ok(hit.hit);
    if (hit.hit) assert.equal(hit.entry.id, 'map.move');

    const outside = resolveKeybinding(keyEvent({ key: 'w' }), 'map', {
      targetIsEditable: false,
      viewportPointerActive: false
    });
    assert.deepEqual(outside, { hit: false, reason: 'viewport-pointer-outside' });
  });

  it('WASD 在非 map/model 域绝不命中', () => {
    for (const domain of ['param', 'text', 'event', 'script', 'behavior', 'project']) {
      const out = resolveKeybinding(keyEvent({ key: 'w' }), domain, VIEWPORT);
      assert.deepEqual(out, { hit: false, reason: 'no-match' }, `域 ${domain} 不得抢 WASD`);
    }
  });

  it('视口键在各组合下按门禁命中', () => {
    // Q/E 升降
    const lift = resolveKeybinding(keyEvent({ key: 'e' }), 'map', VIEWPORT);
    assert.ok(lift.hit);
    if (lift.hit) assert.equal(lift.entry.id, 'map.lift');

    // Shift 加速 / Ctrl 减速（修饰键本体）
    const speedUp = resolveKeybinding(keyEvent({ key: 'Shift' }), 'map', VIEWPORT);
    assert.ok(speedUp.hit);
    if (speedUp.hit) assert.equal(speedUp.entry.id, 'map.speed-up');
    const speedDown = resolveKeybinding(keyEvent({ key: 'Control' }), 'map', VIEWPORT);
    assert.ok(speedDown.hit);
    if (speedDown.hit) assert.equal(speedDown.entry.id, 'map.speed-down');

    // F 框选 / X 拉到相机 / R 重置
    for (const [key, id] of [
      ['f', 'map.box-select'],
      ['x', 'map.focus-camera'],
      ['r', 'map.reset-view']
    ] as const) {
      const out = resolveKeybinding(keyEvent({ key }), 'map', VIEWPORT);
      assert.ok(out.hit);
      if (out.hit) assert.equal(out.entry.id, id);
    }

    // Esc 取消选（Escape 归一化为 Esc），model 域同一张视口表
    const deselect = resolveKeybinding(keyEvent({ key: 'Escape' }), 'model', VIEWPORT);
    assert.ok(deselect.hit);
    if (deselect.hit) assert.equal(deselect.entry.id, 'model.deselect');

    // Shift+WASD 属于漫游加速，不再与 Gizmo 工具栏冲突。
    for (const key of ['w', 'a', 's', 'd']) {
      const accelerated = resolveKeybinding(keyEvent({ key, shiftKey: true }), 'map', VIEWPORT);
      assert.ok(accelerated.hit);
      if (accelerated.hit) assert.equal(accelerated.entry.id, 'map.speed-up');
    }
  });

  it('事件域键盘键命中', () => {
    const complete = resolveKeybinding(keyEvent({ key: ' ', ctrlKey: true }), 'event', VIEWPORT);
    assert.ok(complete.hit);
    if (complete.hit) assert.equal(complete.entry.id, 'event.complete');

    const switchTab = resolveKeybinding(keyEvent({ key: 'Tab', ctrlKey: true }), 'event', VIEWPORT);
    assert.ok(switchTab.hit);
    if (switchTab.hit) assert.equal(switchTab.entry.id, 'event.switch-tab');

    const find = resolveKeybinding(keyEvent({ key: 'f', ctrlKey: true }), 'event', VIEWPORT);
    assert.ok(find.hit);
    if (find.hit) assert.equal(find.entry.id, 'event.find');
  });

  it('动作域键命中（域键盖过通用方向键）', () => {
    const play = resolveKeybinding(keyEvent({ key: ' ' }), 'behavior', VIEWPORT);
    assert.ok(play.hit);
    if (play.hit) assert.equal(play.entry.id, 'behavior.play-pause');

    const replay = resolveKeybinding(keyEvent({ key: ' ', shiftKey: true }), 'behavior', VIEWPORT);
    assert.ok(replay.hit);
    if (replay.hit) assert.equal(replay.entry.id, 'behavior.replay');

    const home = resolveKeybinding(keyEvent({ key: 'Home' }), 'behavior', VIEWPORT);
    assert.ok(home.hit);
    if (home.hit) assert.equal(home.entry.id, 'behavior.goto-ends');

    // Left/Right 逐帧必须盖过通用方向键（edit.arrows 也匹配 ArrowLeft）
    const step = resolveKeybinding(keyEvent({ key: 'ArrowLeft' }), 'behavior', VIEWPORT);
    assert.ok(step.hit);
    if (step.hit) assert.equal(step.entry.id, 'behavior.step-frame');

    const loop = resolveKeybinding(keyEvent({ key: 'l', ctrlKey: true }), 'behavior', VIEWPORT);
    assert.ok(loop.hit);
    if (loop.hit) assert.equal(loop.entry.id, 'behavior.loop');
  });

  it('Alt+D 在文本域照常命中且标记 optional', () => {
    const entry = domainKeybindings('text').find((item) => item.id === 'text.copy-configurable');
    assert.ok(entry, '文本域必须含 Alt+D 条目');
    assert.equal(entry!.optional, true, 'Alt+D 必须标记 optional');

    const out = resolveKeybinding(keyEvent({ key: 'd', altKey: true }), 'text', VIEWPORT);
    assert.ok(out.hit);
    if (out.hit) assert.equal(out.entry.id, 'text.copy-configurable');
  });

  it('方向键在无逐帧绑定的域走通用编辑键', () => {
    const out = resolveKeybinding(keyEvent({ key: 'ArrowLeft' }), 'param', VIEWPORT);
    assert.ok(out.hit);
    if (out.hit) assert.equal(out.entry.id, 'edit.arrows');
  });

  it('未绑定键返回 no-match', () => {
    const out = resolveKeybinding(keyEvent({ key: 'u', ctrlKey: true }), 'param', VIEWPORT);
    assert.deepEqual(out, { hit: false, reason: 'no-match' });
  });
});

describe('statusSuitLabel', () => {
  it('对所有 EDITOR_DOMAIN_IDS 返回「壳层 · X」', () => {
    const expected: Record<string, string> = {
      project: '壳层 · 开始',
      param: '壳层 · PARAM',
      gparam: '壳层 · GPARAM',
      text: '壳层 · 文本',
      event: '壳层 · 事件',
      map: '壳层 · 地图',
      script: '壳层 · 脚本',
      behavior: '壳层 · 动作',
      animation: '壳层 · 动作',
      model: '壳层 · 模型',
      texture: '壳层 · 纹理',
      material: '壳层 · 材质',
      vfx: '壳层 · VFX',
      container: '壳层 · 容器',
      files: '壳层 · 文件'
    };
    assert.equal(EDITOR_DOMAIN_IDS.length, Object.keys(expected).length, '期望表必须覆盖全部域 id');
    for (const domain of EDITOR_DOMAIN_IDS) {
      assert.equal(statusSuitLabel(domain), expected[domain], `域 ${domain} 的套名`);
    }
  });

  it('隐藏域返回合理值', () => {
    assert.equal(statusSuitLabel('animation'), '壳层 · 动作');
    assert.equal(statusSuitLabel('gparam'), '壳层 · GPARAM');
  });

  it('未知域返回「壳层 · 通用」', () => {
    assert.equal(statusSuitLabel('no-such-domain'), '壳层 · 通用');
    assert.equal(statusSuitLabel(''), '壳层 · 通用');
  });
});
