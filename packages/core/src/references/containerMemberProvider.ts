/**
 * 容器 contains / 成员 member_of provider（T07，执行指令 §T07 步骤 10）。
 *
 * 只为原生 reader 已公开"完整子项身份"的容器发布成员关系：
 * - TAE：ANIBND 内原生 TAE 子项目录（`TaeExport.taeEntries` 的
 *   entryIndex/entryId/entryName/sourceHash）。动画 → 所属 TAE 子项用
 *   `taeEntryIndex` 寻址 —— animId 不能单独寻址，跨 section 同号必须可区分。
 * - FMG/MSGBND：文本条目按 `sourceUri` 分组，contains 只列出 reader 实际
 *   导出的条目；不猜测未导出的子项。
 * - LUABND/BND4 脚本容器由 `scriptReferenceProvider` 负责（目录完整性语义
 *   在那边统一处理），这里不重复发布。
 *
 * contains/member_of 只证明目录成员身份，不证明资源间语义引用；FLVER→材质、
 * 材质→贴图这类连接必须等现有原生 loader 公开精确字段后才登记，缺少唯一
 * 物理目标时返回 unresolved/候选，不在这里制造。
 */
import type {
  Diagnostic,
  MsgExport,
  ReferenceEdge,
  TaeExport
} from '@soulforge/shared';

export interface ContainerMemberBuildResult {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  stats: { contains: number; memberOf: number; missingChildIdentity: number };
}

const MAX_CONTAINER_DIAGNOSTICS = 200;

export function buildContainerMemberEdges(
  taeExports: readonly TaeExport[],
  msgExports: readonly MsgExport[]
): ContainerMemberBuildResult {
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const stats: ContainerMemberBuildResult['stats'] = {
    contains: 0,
    memberOf: 0,
    missingChildIdentity: 0
  };
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length >= MAX_CONTAINER_DIAGNOSTICS) return;
    diagnostics.push(diagnostic);
  };

  for (const tae of taeExports) {
    const entries = tae.taeEntries ?? [];
    if (tae.taeEntryCount !== undefined && entries.length === 0) {
      // The reader knows children exist but their identity was not exported:
      // a coverage gap, never a silent "no members".
      stats.missingChildIdentity += 1;
      pushDiagnostic({
        severity: 'warning',
        code: 'TAE_CHILD_IDENTITY_MISSING',
        message: `${tae.sourceUri} 报告 taeEntryCount=${tae.taeEntryCount} 但没有导出子项目录；成员覆盖为 partial，不宣称完整。`,
        sourceUri: tae.sourceUri
      });
      continue;
    }
    const entryByIndex = new Map<number, (typeof entries)[number]>();
    for (const entry of entries) {
      entryByIndex.set(entry.entryIndex, entry);
      const childUri = `${tae.sourceUri}#taeEntry/${entry.entryIndex}`;
      stats.contains += 1;
      edges.push({
        fromUri: tae.sourceUri,
        toUri: childUri,
        kind: 'contains',
        confidence: 'high',
        reason: `原生 ANIBND 目录列出 TAE 子项 entryIndex=${entry.entryIndex} entryId=${entry.entryId} ${entry.entryName}`,
        evidence: [{
          sourceUri: tae.sourceUri,
          fieldName: entry.entryName,
          excerpt: `taeGroup=${entry.taeGroup} animations=${entry.animationCount} sourceHash=${entry.sourceHash.slice(0, 12)}…`
        }]
      });
    }
    for (const animation of tae.animations) {
      if (animation.taeEntryIndex === undefined) {
        stats.missingChildIdentity += 1;
        pushDiagnostic({
          severity: 'warning',
          code: 'TAE_ANIM_CHILD_UNRESOLVED',
          message: `${tae.sourceUri} 的动作 ${animation.code}（animId=${animation.animId}）没有 taeEntryIndex 子项身份，不能落到确定的 TAE 成员。`,
          sourceUri: tae.sourceUri
        });
        continue;
      }
      const entry = entryByIndex.get(animation.taeEntryIndex);
      if (!entry) {
        stats.missingChildIdentity += 1;
        pushDiagnostic({
          severity: 'warning',
          code: 'TAE_ANIM_CHILD_UNRESOLVED',
          message: `动作 ${animation.code} 的 taeEntryIndex=${animation.taeEntryIndex} 不在导出的子项目录中，成员关系未解析。`,
          sourceUri: tae.sourceUri
        });
        continue;
      }
      stats.memberOf += 1;
      edges.push({
        fromUri: `${tae.sourceUri}#anim/${animation.animId}@${animation.taeEntryIndex}`,
        toUri: `${tae.sourceUri}#taeEntry/${entry.entryIndex}`,
        kind: 'member_of',
        confidence: 'high',
        reason: `动作 ${animation.code} 归属 TAE 子项 ${entry.entryName}（taeEntryIndex=${entry.entryIndex}，完整子项身份）`,
        evidence: [{
          sourceUri: tae.sourceUri,
          fieldName: 'taeEntryIndex',
          value: animation.taeEntryIndex,
          excerpt: `animId=${animation.animId}${animation.motionAnimId !== undefined ? ` motionAnimId=${animation.motionAnimId}` : ' motionAnimId=?（未解析，不猜测）'}`
        }]
      });
    }
  }

  // MSGBND/FMG: group exported entries by their physical source container.
  const msgBySource = new Map<string, MsgExport['entries']>();
  for (const msg of msgExports) {
    for (const entry of msg.entries) {
      const list = msgBySource.get(entry.sourceUri);
      if (list) list.push(entry);
      else msgBySource.set(entry.sourceUri, [entry]);
    }
  }
  for (const [sourceUri, entries] of msgBySource) {
    for (const entry of entries) {
      stats.contains += 1;
      edges.push({
        fromUri: sourceUri,
        toUri: entry.uri,
        kind: 'contains',
        confidence: 'high',
        reason: `原生 msgbnd 目录导出文本条目 ${entry.category ?? 'default'}/${entry.textId}`,
        evidence: [{ sourceUri, ...(entry.category ? { fieldName: entry.category } : {}), value: entry.textId, excerpt: entry.text.slice(0, 80) }]
      });
    }
  }

  return { edges, diagnostics, stats };
}


