/**
 * T7 键位解析：把一次键盘事件（KeyEventLike）解析成命中的键位表条目。
 *
 * 归一化规则（与 keymapTable.ts 里各条目的 matchKeys 逐字对齐）：
 * - 空格键 `event.key === ' '`，统一成 'Space'；
 * - Escape 统一成 'Esc'（键位表展示串也是 'Esc'）；
 * - 单个字母统一小写（'W' → 'w'），使 WASD/Q/E 等匹配与大小写无关；
 * - 修饰键前缀顺序固定为 Ctrl → Shift → Alt → Meta，如 'Ctrl+K'、'Shift+Space'；
 * - 修饰键本体按下（`event.key` 为 'Shift'/'Control'/'Alt'/'Meta'）时直接返回
 *   该键名（'Shift'/'Ctrl'/'Alt'/'Meta'），不再叠加同名修饰前缀——否则 shiftKey
 *   在按下 Shift 那一刻也是 true，会错误产出 'Shift+Shift'。
 *
 * 命中门禁：
 * - 壳层三键（Ctrl+K / Ctrl+J / Ctrl+B）永远命中，无视 targetIsEditable 与
 *   viewportPointerActive；
 * - edit 与 domain 键在 `targetIsEditable === true` 时被抑制（返回
 *   'editable-target'），把按键让给输入框/文本域/Agent composer 的原生行为；
 * - 地图/模型视口键（WASD/Q/E/Shift 加速/Ctrl 减速/F/X/R/Esc/gizmo）仅在
 *   `viewportPointerActive === true` 且当前域是 map 或 model 时命中；指针在
 *   视口外返回 'viewport-pointer-outside'。非 map/model 域根本不在视口表里查，
 *   WASD 等绝不命中（返回 'no-match'）——没有视口的页不得抢 WASD。
 * - 域键优先于通用编辑键：动作域 Left/Right 逐帧会盖过通用方向键（两个表都
 *   能匹配 'ArrowLeft' 时，域键获胜）。
 */

import {
  matchShellKeybinding,
  matchEditKeybinding,
  matchDomainKeybinding,
  type KeybindingEntry
} from './keymapTable.js';

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ResolveContext {
  targetIsEditable: boolean; // 焦点在 input/textarea/contenteditable/Agent composer 内
  viewportPointerActive: boolean; // 指针在地图/模型视口内
}

export type ResolveOutcome =
  | { hit: true; entry: KeybindingEntry }
  | { hit: false; reason: 'no-match' | 'editable-target' | 'viewport-pointer-outside' };

const VIEWPORT_DOMAINS = new Set(['map', 'model']);

export function resolveKeybinding(
  e: KeyEventLike,
  domain: string,
  ctx: ResolveContext
): ResolveOutcome {
  const normalized = normalizeKeyEvent(e);

  // 1. 壳层三键永远命中（无视 editable / viewport）。
  const shellHit = matchShellKeybinding(normalized);
  if (shellHit !== undefined) return { hit: true, entry: shellHit };

  // 2. 可编辑目标内，edit/domain 键一律让给文本编辑。
  if (ctx.targetIsEditable) {
    const editHit = matchEditKeybinding(normalized);
    const domainHit = matchDomainKeybinding(domain, normalized);
    if (editHit !== undefined || domainHit !== undefined) {
      return { hit: false, reason: 'editable-target' };
    }
    return { hit: false, reason: 'no-match' };
  }

  // 3. 域键优先于通用编辑键。
  const domainHit = matchDomainKeybinding(domain, normalized);
  if (domainHit !== undefined) {
    // 视口门禁：命中条目属于 map/model 时，指针必须在视口内。
    if (domainHit.domain !== undefined && VIEWPORT_DOMAINS.has(domainHit.domain)) {
      if (!ctx.viewportPointerActive) {
        return { hit: false, reason: 'viewport-pointer-outside' };
      }
    }
    return { hit: true, entry: domainHit };
  }

  // 4. 通用编辑键。
  const editHit = matchEditKeybinding(normalized);
  if (editHit !== undefined) return { hit: true, entry: editHit };

  return { hit: false, reason: 'no-match' };
}

/**
 * 把一次键盘事件归一化成稳定匹配键。规则见文件头注释。
 */
export function normalizeKeyEvent(e: KeyEventLike): string {
  const raw = e.key;

  // 修饰键本体：DOM 里按下 Shift 时 key === 'Shift'。这类事件直接以键名匹配，
  // 不再叠加同名修饰前缀（shiftKey 此时也是 true，叠加会得到 'Shift+Shift'）。
  if (raw === 'Shift') return 'Shift';
  if (raw === 'Control') return 'Ctrl';
  if (raw === 'Alt') return 'Alt';
  if (raw === 'Meta') return 'Meta';

  let base: string;
  if (raw === ' ') {
    base = 'Space'; // 空格键 event.key 是 ' '，展示串用 'Space'
  } else if (raw === 'Escape') {
    base = 'Esc'; // 展示串用 'Esc'
  } else if (raw.length === 1 && /[A-Za-z]/.test(raw)) {
    base = raw.toLowerCase(); // 字母统一小写，'W' → 'w'
  } else {
    base = raw; // 'ArrowLeft'、'Enter'、'Delete'、'Insert'、'Tab'、'Home'、'End'…
  }

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Meta');
  if (mods.length === 0) return base;
  return `${mods.join('+')}+${base}`;
}
