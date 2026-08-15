/**
 * T7 键位表模块：renderer 侧固定键位表。
 *
 * 表的权威依据是产品规格（固定键位表，逐条照抄），本文件不做「从源码反向量
 * 键位」的推导。条目、label、keys 展示串、optional 标记均来自规格，不要拿去
 * 量编辑器实现或抄源码里的监听器。
 *
 * 设计要点：
 * - 每个条目除公开展示串 `keys` 外，还带内部 `matchKeys`（归一化匹配键集合）。
 *   展示串与匹配键分离，因为同一行可能对应多个物理键：
 *     - 「WASD 移动」展示为 'WASD'，匹配键是 'w'/'a'/'s'/'d'；
 *     - 「Shift+W/E/G gizmo」展示为 'Shift+W/E/G'，匹配键是
 *       'Shift+w'/'Shift+e'/'Shift+g'；
 *     - 「Home/End 头尾」展示为 'Home/End'，匹配键是 'Home'/'End'。
 *   归一化口径与 applyKeybinding.ts 的 normalizeKeyEvent 保持一致。
 * - 公开 API 只暴露 KeybindingEntry（不含 matchKeys）；applyKeybinding.ts 通过
 *   matchShellKeybinding / matchEditKeybinding / matchDomainKeybinding 三个内部
 *   函数做精确匹配。
 * - 鼠标/滚轮条目（右键旋转、滚轮调速）没有键盘匹配键（matchKeys 为空），只在
 *   UI 展示；resolveKeybinding 只接收键盘事件，天然不会命中它们。
 * - animation 是 behavior 的隐藏路由（状态栏都显示「动作」），动作域键位表
 *   两者复用；gparam 同理无独立表。未列出的域返回空表，绝不抢视口键。
 */

import { type EditorDomainId } from '@soulforge/shared';

export type KeyScope = 'shell' | 'edit' | 'domain';

export interface KeybindingEntry {
  id: string;
  label: string;
  keys: string;      // 展示用，如 'Ctrl+K'
  scope: KeyScope;
  domain?: string;   // 仅 scope==='domain' 时给 EditorDomainId
  optional?: boolean; // Alt+D 等能力不存在的键：照常可命中，但 UI 不得造假按钮
}

/** 内部表条目：在公开字段之外额外携带归一化匹配键集合。 */
interface TableEntry extends KeybindingEntry {
  readonly matchKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// 壳层（永远生效）
// ---------------------------------------------------------------------------

const SHELL_ENTRIES: readonly TableEntry[] = [
  { id: 'shell.command-palette', label: '命令面板', keys: 'Ctrl+K', scope: 'shell', matchKeys: ['Ctrl+k'] },
  { id: 'shell.agent', label: 'Agent', keys: 'Ctrl+J', scope: 'shell', matchKeys: ['Ctrl+j'] },
  { id: 'shell.sidebar', label: '侧栏', keys: 'Ctrl+B', scope: 'shell', matchKeys: ['Ctrl+b'] }
];

// ---------------------------------------------------------------------------
// 共用编辑（非可编辑目标内命中）
// ---------------------------------------------------------------------------

const EDIT_ENTRIES: readonly TableEntry[] = [
  { id: 'edit.commit-review', label: '提交审查', keys: 'Ctrl+S', scope: 'edit', matchKeys: ['Ctrl+s'] },
  { id: 'edit.undo-redo', label: '撤销/重做', keys: 'Ctrl+Z/Ctrl+Y', scope: 'edit', matchKeys: ['Ctrl+z', 'Ctrl+y'] },
  { id: 'edit.copy-paste', label: '复制/粘贴', keys: 'Ctrl+C/Ctrl+V', scope: 'edit', matchKeys: ['Ctrl+c', 'Ctrl+v'] },
  { id: 'edit.duplicate-line', label: '复制行', keys: 'Ctrl+D', scope: 'edit', matchKeys: ['Ctrl+d'] },
  { id: 'edit.delete', label: '删除', keys: 'Delete', scope: 'edit', matchKeys: ['Delete'] },
  { id: 'edit.select-all', label: '全选', keys: 'Ctrl+A', scope: 'edit', matchKeys: ['Ctrl+a'] },
  { id: 'edit.arrows', label: '方向键移动', keys: '方向键', scope: 'edit', matchKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] }
];

// ---------------------------------------------------------------------------
// PARAM / 文本域
// ---------------------------------------------------------------------------

const PARAM_ENTRIES: readonly TableEntry[] = [
  { id: 'param.search-focus', label: '聚焦搜索', keys: 'Ctrl+F', scope: 'domain', domain: 'param', matchKeys: ['Ctrl+f'] }
];

const TEXT_ENTRIES: readonly TableEntry[] = [
  { id: 'text.search-focus', label: '聚焦搜索', keys: 'Ctrl+F', scope: 'domain', domain: 'text', matchKeys: ['Ctrl+f'] },
  { id: 'text.insert-entry', label: '新建条目', keys: 'Insert', scope: 'domain', domain: 'text', matchKeys: ['Insert'] },
  // Alt+D 可配置复制：能力不存在时 UI 不得造假按钮，表里标记 optional。
  { id: 'text.copy-configurable', label: '可配置复制', keys: 'Alt+D', scope: 'domain', domain: 'text', optional: true, matchKeys: ['Alt+d'] }
];

// ---------------------------------------------------------------------------
// 事件域
// ---------------------------------------------------------------------------

const EVENT_ENTRIES: readonly TableEntry[] = [
  { id: 'event.find', label: '查找（键盘）', keys: 'Ctrl+F', scope: 'domain', domain: 'event', matchKeys: ['Ctrl+f'] },
  { id: 'event.replace', label: '替换（键盘）', keys: 'Ctrl+H', scope: 'domain', domain: 'event', matchKeys: ['Ctrl+h'] },
  { id: 'event.complete', label: '补全', keys: 'Ctrl+Space', scope: 'domain', domain: 'event', matchKeys: ['Ctrl+Space'] },
  { id: 'event.close-tab', label: '关闭当前事件标签', keys: 'Ctrl+W', scope: 'domain', domain: 'event', matchKeys: ['Ctrl+w'] },
  { id: 'event.switch-tab', label: '切换事件标签', keys: 'Ctrl+Tab', scope: 'domain', domain: 'event', matchKeys: ['Ctrl+Tab'] }
];

// ---------------------------------------------------------------------------
// 地图 / 模型视口（仅指针在视口内才命中）
// ---------------------------------------------------------------------------

const VIEWPORT_TEMPLATE: readonly {
  id: string;
  label: string;
  keys: string;
  matchKeys: readonly string[];
}[] = [
  { id: 'move', label: '移动', keys: 'WASD', matchKeys: ['w', 'a', 's', 'd'] },
  { id: 'lift', label: '升降', keys: 'Q/E', matchKeys: ['q', 'e'] },
  // 右键旋转 / 滚轮调速是鼠标与滚轮动作，键盘事件不命中（matchKeys 为空），仅 UI 展示。
  { id: 'rotate', label: '旋转', keys: '右键拖拽', matchKeys: [] },
  { id: 'speed-up', label: '加速', keys: 'Shift', matchKeys: ['Shift'] },
  { id: 'speed-down', label: '减速', keys: 'Ctrl', matchKeys: ['Ctrl'] },
  { id: 'wheel-speed', label: '调速', keys: '滚轮', matchKeys: [] },
  { id: 'box-select', label: '框选', keys: 'F', matchKeys: ['f'] },
  { id: 'focus-camera', label: '拉到相机', keys: 'X', matchKeys: ['x'] },
  { id: 'reset-view', label: '重置视图', keys: 'R', matchKeys: ['r'] },
  { id: 'gizmo', label: 'Gizmo 切换', keys: 'Shift+W/E/G', matchKeys: ['Shift+w', 'Shift+e', 'Shift+g'] },
  { id: 'deselect', label: '取消选择', keys: 'Esc', matchKeys: ['Esc'] }
];

type ViewportDomain = 'map' | 'model';

function viewportEntries(domain: ViewportDomain): readonly TableEntry[] {
  return VIEWPORT_TEMPLATE.map((t) => ({
    id: `${domain}.${t.id}`,
    label: t.label,
    keys: t.keys,
    scope: 'domain',
    domain,
    matchKeys: t.matchKeys
  }));
}

const MAP_ENTRIES = viewportEntries('map');
const MODEL_ENTRIES = viewportEntries('model');

// ---------------------------------------------------------------------------
// 动作域（behavior；animation 是隐藏路由，复用同一张表）
// ---------------------------------------------------------------------------

const ACTION_TEMPLATE: readonly {
  id: string;
  label: string;
  keys: string;
  matchKeys: readonly string[];
}[] = [
  { id: 'play-pause', label: '播放/暂停', keys: 'Space', matchKeys: ['Space'] },
  { id: 'replay', label: '重播', keys: 'Shift+Space', matchKeys: ['Shift+Space'] },
  { id: 'goto-ends', label: '跳到头/尾', keys: 'Home/End', matchKeys: ['Home', 'End'] },
  { id: 'step-frame', label: '逐帧', keys: 'Left/Right', matchKeys: ['ArrowLeft', 'ArrowRight'] },
  { id: 'loop', label: '循环', keys: 'Ctrl+L', matchKeys: ['Ctrl+l'] }
];

type ActionDomain = 'behavior' | 'animation';

function actionEntries(domain: ActionDomain): readonly TableEntry[] {
  return ACTION_TEMPLATE.map((t) => ({
    id: `${domain}.${t.id}`,
    label: t.label,
    keys: t.keys,
    scope: 'domain',
    domain,
    matchKeys: t.matchKeys
  }));
}

const BEHAVIOR_ENTRIES = actionEntries('behavior');
const ANIMATION_ENTRIES = actionEntries('animation');

// ---------------------------------------------------------------------------
// 域 → 表
// ---------------------------------------------------------------------------

const DOMAIN_TABLES: Readonly<Partial<Record<EditorDomainId, readonly TableEntry[]>>> = {
  param: PARAM_ENTRIES,
  text: TEXT_ENTRIES,
  event: EVENT_ENTRIES,
  map: MAP_ENTRIES,
  model: MODEL_ENTRIES,
  behavior: BEHAVIOR_ENTRIES,
  animation: ANIMATION_ENTRIES
};

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 去掉内部 matchKeys，只留公开字段。 */
function publicize(entry: TableEntry): KeybindingEntry {
  const pub: KeybindingEntry = {
    id: entry.id,
    label: entry.label,
    keys: entry.keys,
    scope: entry.scope
  };
  if (entry.domain !== undefined) pub.domain = entry.domain;
  if (entry.optional === true) pub.optional = true;
  return pub;
}

const SHELL_PUBLIC: readonly KeybindingEntry[] = SHELL_ENTRIES.map(publicize);
const EDIT_PUBLIC: readonly KeybindingEntry[] = EDIT_ENTRIES.map(publicize);

export function shellKeybindings(): readonly KeybindingEntry[] {
  return SHELL_PUBLIC;
}

export function editKeybindings(): readonly KeybindingEntry[] {
  return EDIT_PUBLIC;
}

export function domainKeybindings(domain: string): readonly KeybindingEntry[] {
  const table = DOMAIN_TABLES[domain as EditorDomainId];
  if (table === undefined) return [];
  return table.map(publicize);
}

// ---------------------------------------------------------------------------
// 状态栏套名
// ---------------------------------------------------------------------------

/** 每个域的显示名；animation/gparam 是隐藏域，但仍取合理名（分别并入动作/GPARAM）。 */
const DOMAIN_SUIT_LABEL: Record<EditorDomainId, string> = {
  project: '开始',
  param: 'PARAM',
  gparam: 'GPARAM',
  text: '文本',
  event: '事件',
  map: '地图',
  script: '脚本',
  behavior: '动作',
  animation: '动作',
  model: '模型',
  texture: '纹理',
  material: '材质',
  vfx: 'VFX',
  container: '容器',
  files: '文件'
};

export function statusSuitLabel(domain: string): string {
  const label = DOMAIN_SUIT_LABEL[domain as EditorDomainId];
  return `壳层 · ${label ?? '通用'}`;
}

// ---------------------------------------------------------------------------
// 内部匹配入口（只给 applyKeybinding.ts 用）
// ---------------------------------------------------------------------------

export function matchShellKeybinding(normalizedKey: string): KeybindingEntry | undefined {
  const hit = SHELL_ENTRIES.find((entry) => entry.matchKeys.includes(normalizedKey));
  return hit === undefined ? undefined : publicize(hit);
}

export function matchEditKeybinding(normalizedKey: string): KeybindingEntry | undefined {
  const hit = EDIT_ENTRIES.find((entry) => entry.matchKeys.includes(normalizedKey));
  return hit === undefined ? undefined : publicize(hit);
}

export function matchDomainKeybinding(domain: string, normalizedKey: string): KeybindingEntry | undefined {
  const table = DOMAIN_TABLES[domain as EditorDomainId];
  if (table === undefined) return undefined;
  const hit = table.find((entry) => entry.matchKeys.includes(normalizedKey));
  return hit === undefined ? undefined : publicize(hit);
}
