/**
 * ACTION 编辑器共享模型。
 *
 * 这是对 TAE-DX/DSAnimStudio 信息架构的干净实现：动作目录按 native TAE
 * child 的动作族归组，事件图使用动画自己的事件下标，预览层只消费本模块
 * 产出的纯数据。这里不读文件、不创建 renderer 对象，也不猜测 native identity。
 */

import {
  taeAnimationIdentityKey,
  type TaeDiagnostic,
  type TaeAnimationWire,
  type TaeTimelineEventRow,
  type TaeDocument
} from './animation-editor.js';
import { buildTaeTimelineTracks, type TaeTimelineTrack } from './animation-playback.js';

export const ACTION_EDITOR_FRAME_RATE = 30;

export type ActionEditorSelection =
  | {
      kind: 'animation';
      animationId: number;
      taeEntryIndex?: number | undefined;
      taeEntryId?: number | undefined;
      taeEntryName?: string | undefined;
      taeGroup?: string | undefined;
    }
  | {
      kind: 'event';
      animationId: number;
      eventIndex: number;
      taeEntryIndex?: number | undefined;
      taeEntryId?: number | undefined;
      taeEntryName?: string | undefined;
      taeGroup?: string | undefined;
    };

export interface ActionAnimationGroup {
  /** Stable UI key. It is deliberately separate from the native animation identity. */
  key: string;
  /** Normalized family label such as a00, a50, or a200. */
  label: string;
  animations: TaeAnimationWire[];
}

export interface ActionAnimationCatalog {
  animations: TaeAnimationWire[];
  groups: ActionAnimationGroup[];
  animationCount: number;
}

export interface ActionAnimationFilter {
  bankKey?: string | undefined;
  query?: string | undefined;
}

export interface ActionAnimationView {
  animations: TaeAnimationWire[];
  groups: ActionAnimationGroup[];
  selectedGroup: ActionAnimationGroup | null;
}

function normalizeGroupDigits(value: string): string | null {
  const match = /^a(\d+)$/i.exec(value.trim());
  if (!match) return null;
  let digits = match[1]!;
  // Some old TAE child labels use a0000 for the a00 family. The final zero is
  // the legacy family padding, not a separate action family.
  if (digits.length === 4 && digits.endsWith('0')) digits = digits.slice(0, -1);
  const numeric = Number.parseInt(digits, 10);
  return Number.isSafeInteger(numeric) ? `a${numeric === 0 ? '00' : String(numeric)}`.toLowerCase() : null;
}

export function normalizeActionGroupLabel(value: string): string | null {
  return normalizeGroupDigits(value);
}

function fallbackActionGroupLabel(animation: Pick<TaeAnimationWire, 'taeGroup' | 'taeEntryName'>): string {
  const entry = (animation.taeGroup ?? animation.taeEntryName?.replace(/\.tae$/i, '') ?? '').trim();
  // 裸 TAE 或旧 wire 缺少 child 名称时，沿用动作编辑器的默认 a00 家族；
  // 这只是 UI 分类，不会成为 native identity 或写回定位依据。
  return normalizeGroupDigits(entry) ?? 'a00';
}

/**
 * UI family grouping follows the visible aXXX prefix, while native selection
 * continues to use taeAnimationIdentityKey. This lets a00/a50/a200 collapse
 * together without merging two animations during read/write operations.
 */
export function actionAnimationGroupLabel(animation: TaeAnimationWire): string {
  const entry = (animation.taeGroup ?? animation.taeEntryName?.replace(/\.tae$/i, '') ?? '').trim();
  const entryLabel = normalizeGroupDigits(entry);
  if (entryLabel) return entryLabel;

  const hkxBase = (animation.hkxName ?? '').replace(/\.(hkx|hkt)$/i, '');
  const hkxPrefix = /^(a\d{3,4})(?:_|$)/i.exec(hkxBase)?.[1];
  const hkxLabel = hkxPrefix ? normalizeGroupDigits(hkxPrefix) : null;
  return hkxLabel ?? fallbackActionGroupLabel(animation);
}

export function actionAnimationGroupKey(animation: TaeAnimationWire): string {
  return `family:${actionAnimationGroupLabel(animation).toLowerCase()}`;
}

export function groupActionAnimations(animations: readonly TaeAnimationWire[]): ActionAnimationGroup[] {
  const groups: ActionAnimationGroup[] = [];
  const byKey = new Map<string, ActionAnimationGroup>();
  for (const animation of animations) {
    const key = actionAnimationGroupKey(animation);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: actionAnimationGroupLabel(animation), animations: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.animations.push(animation);
  }
  return groups;
}

export function buildActionAnimationCatalog(document: TaeDocument | null | undefined): ActionAnimationCatalog {
  const animations = document?.animations ? [...document.animations] : [];
  return {
    animations,
    groups: groupActionAnimations(animations),
    animationCount: document?.animationCount ?? animations.length
  };
}

function animationMatchesQuery(animation: TaeAnimationWire, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const id = String(animation.animId).toLowerCase();
  const hkx = (animation.hkxName ?? '').toLowerCase();
  const group = actionAnimationGroupLabel(animation).toLowerCase();
  return id.includes(normalizedQuery) || hkx.includes(normalizedQuery) || group.includes(normalizedQuery);
}

export function filterActionAnimations(
  animations: readonly TaeAnimationWire[],
  filter: ActionAnimationFilter = {}
): ActionAnimationView {
  const groups = groupActionAnimations(animations);
  const bankKey = filter.bankKey ?? 'all';
  const selectedGroup = bankKey === 'all' ? null : groups.find((group) => group.key === bankKey) ?? null;
  const source = selectedGroup?.animations ?? (bankKey === 'all' ? [...animations] : []);
  const query = (filter.query ?? '').trim().toLowerCase();
  const filtered = source.filter((animation) => animationMatchesQuery(animation, query));
  return {
    animations: filtered,
    groups: groupActionAnimations(filtered),
    selectedGroup
  };
}

export function findActionAnimation(
  animations: readonly TaeAnimationWire[],
  selection: ActionEditorSelection | null | undefined
): TaeAnimationWire | undefined {
  if (!selection) return undefined;
  const candidates = animations.filter((animation) => animation.animId === selection.animationId);
  if (candidates.length === 0) return undefined;
  const matchesSelector = (animation: TaeAnimationWire): boolean => (
    (selection.taeEntryIndex === undefined || animation.taeEntryIndex === selection.taeEntryIndex)
    && (selection.taeEntryId === undefined || animation.taeEntryId === selection.taeEntryId)
    && (selection.taeEntryName === undefined || animation.taeEntryName === selection.taeEntryName)
    && (selection.taeGroup === undefined || animation.taeGroup === selection.taeGroup)
  );
  const selected = candidates.filter(matchesSelector);
  if (selected.length === 1) return selected[0];
  // A bare animId is safe only when it is unique across all TAE children.
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function actionTimelineRows(animation: TaeAnimationWire): TaeTimelineEventRow[] {
  return animation.events.map((event) => ({
    animId: animation.animId,
    ...event,
    ...(animation.taeEntryIndex === undefined ? {} : { taeEntryIndex: animation.taeEntryIndex }),
    ...(animation.taeEntryId === undefined ? {} : { taeEntryId: animation.taeEntryId }),
    ...(animation.taeEntryName === undefined ? {} : { taeEntryName: animation.taeEntryName }),
    ...(animation.taeGroup === undefined ? {} : { taeGroup: animation.taeGroup })
  }));
}

export function buildActionTimeline(
  animation: TaeAnimationWire | null | undefined,
  diagnostics?: readonly TaeDiagnostic[] | undefined,
  fps = ACTION_EDITOR_FRAME_RATE
): TaeTimelineTrack[] {
  if (!animation || animation.events.length === 0) return [];
  return buildTaeTimelineTracks(actionTimelineRows(animation), diagnostics, { fps });
}

export function actionDurationSeconds(
  animation: TaeAnimationWire | null | undefined,
  clipDuration?: number | undefined
): number {
  if (clipDuration !== undefined && Number.isFinite(clipDuration) && clipDuration > 0) return clipDuration;
  let maxEnd = 0;
  for (const event of animation?.events ?? []) {
    if (Number.isFinite(event.endTime) && event.endTime > maxEnd && event.endTime < 3600) maxEnd = event.endTime;
  }
  return maxEnd > 0 ? Math.max(0.5, maxEnd) : 2;
}

export function actionAnimationIdentity(animation: TaeAnimationWire): string {
  return taeAnimationIdentityKey(animation);
}
