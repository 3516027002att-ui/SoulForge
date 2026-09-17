/**
 * 资源关联能力 registry（T07，执行指令 §T07 步骤 11/12）。
 *
 * 为每一种 `ResourceKind` 登记**关联语义**能力：supported / partial /
 * unsupported、支持的 relation kinds、原生 reader、未覆盖原因。
 *
 * 这不是编辑器读写能力矩阵（那是 `capabilities/resourceCapabilities.ts`，
 * 按文件/格式计算读写与容器级别）；本 registry 只回答"关联图能不能在该域
 * 产生有依据的边、边从哪里来"。两者互不改写。
 *
 * 穷举保证：`REFERENCE_CAPABILITIES` 以 `ALL_RESOURCE_KINDS` 为键做编译期
 * 穷举（Record 类型）+ 运行期 registry 测试；新增值缺登记即失败（步骤 12）。
 */
import { ALL_RESOURCE_KINDS, type ReferenceRelationKind, type ResourceKind } from '@soulforge/shared';

export type ReferenceCapabilityStatus = 'supported' | 'partial' | 'unsupported';

export interface ReferenceDomainCapability {
  kind: ResourceKind;
  status: ReferenceCapabilityStatus;
  /** Relation kinds this domain can currently produce with native evidence. */
  relationKinds: readonly ReferenceRelationKind[];
  /** Native reader / provider that produces the semantic projection. */
  reader: string;
  /** Provider module implementing the edges for this domain. */
  provider: string;
  /** Why coverage is partial/unsupported; empty only when supported. */
  uncoveredReasons: readonly string[];
}

/**
 * 按 `ResourceKind` 登记：param/event(emevd)/msg(fmg)/script/map 为核心支持域；
 * action(TAE/ANIBND)、ai、menu 为 partial；chr/obj/sfx/other/unknown 目前
 * 只有容器/文件级投影，关联语义登记为 unsupported 并写明缺口，不冒充
 * "已解析"。TAE 子项身份归入 action 域（ResourceKind 没有独立的 tae 值）。
 */
export const REFERENCE_CAPABILITIES: Readonly<Record<ResourceKind, ReferenceDomainCapability>> =
  Object.freeze({
    param: {
      kind: 'param',
      status: 'supported',
      relationKinds: ['references_param_row', 'references_text'],
      reader: 'Bridge read-param (semantic rows + trusted-metadata Refs)',
      provider: 'references/paramReferenceProvider.ts + references/paramTextReferences.ts',
      uncoveredReasons: []
    },
    event: {
      kind: 'event',
      status: 'supported',
      relationKinds: ['calls_event', 'reads_flag', 'writes_flag', 'references_map_entity', 'references_region', 'references_param_row', 'references_text'],
      reader: 'Bridge read-emevd full document + EMEDF registry decode',
      provider: 'references/eventReferenceProvider.ts + references/emevdRoleRules.ts',
      uncoveredReasons: []
    },
    msg: {
      kind: 'msg',
      status: 'supported',
      relationKinds: ['references_text', 'contains', 'member_of'],
      reader: 'Bridge read-msgbnd / FMG native entries (textId + category)',
      provider: 'references/paramTextReferences.ts + references/containerMemberProvider.ts',
      uncoveredReasons: []
    },
    script: {
      kind: 'script',
      status: 'supported',
      relationKinds: ['invokes_script', 'contains'],
      reader: 'LUABND/BND4 catalog via native container inventory + plaintext loader decode',
      provider: 'references/scriptReferenceProvider.ts + references/luaStaticSubset.ts',
      uncoveredReasons: []
    },
    ai: {
      kind: 'ai',
      status: 'partial',
      relationKinds: ['contains'],
      reader: 'LUABND container catalog (ai/*.luabnd.dcx)',
      provider: 'references/scriptReferenceProvider.ts',
      uncoveredReasons: [
        'AI 脚本子项多为 \\x1bLuaP 字节码；无原文时调用覆盖为 unknown，不宣称零引用',
        '游戏脚本 API 参数语义暂无受信任规则表，require 之外不生成 confirmed 边'
      ]
    },
    map: {
      kind: 'map',
      status: 'supported',
      relationKinds: ['references_param_row', 'references_region', 'contains'],
      reader: 'Bridge read-msb-document (entities/regions with nativeOffset/entityId/internalEntryId)',
      provider: 'references/mapReferenceProvider.ts',
      uncoveredReasons: []
    },
    action: {
      kind: 'action',
      status: 'partial',
      relationKinds: ['member_of', 'contains'],
      reader: 'TAE template decode (TaeExport.taeEntries) + resolveBinderMembership',
      provider: 'references/containerMemberProvider.ts',
      uncoveredReasons: [
        '未解码的 TAE 参数体不产生已确认语义边；动作→事件/特效的 typed 连接待 native 字段导出',
        'TAE 子项（taeEntries）只登记成员身份；UNIQUE 的 binder 成员关系还需输入目录自身的原生来源证明'
      ]
    },
    chr: {
      kind: 'chr',
      status: 'unsupported',
      relationKinds: [],
      reader: '（无独立原生 reader；chr 身份来自 NpcParam rowId 规则与模型命名）',
      provider: '（无 —— 旧 chrLinkageResolver 的名称前缀/拼接边已降级为假设通道）',
      uncoveredReasons: [
        '角色→地图/事件/AI 脚本的连接必须由 map 原生外键与事件 typed entity 参数证明，不采用目录扫描 + 名称拼接',
        'FLVER/纹理等角色资源成员关系待 native loader 精确字段公开后登记'
      ]
    },
    obj: {
      kind: 'obj',
      status: 'unsupported',
      relationKinds: [],
      reader: '（BND4 目录枚举只证明成员，不证明语义）',
      provider: 'references/containerMemberProvider.ts（仅 contains/member_of）',
      uncoveredReasons: ['obj 资源间的引用语义没有已验证的原生字段来源']
    },
    sfx: {
      kind: 'sfx',
      status: 'unsupported',
      relationKinds: [],
      reader: '（无原生 reader）',
      provider: '（无）',
      uncoveredReasons: ['SFX 语义连接未实现；能力状态按关联语义登记，不影响 editor 原有读写']
    },
    menu: {
      kind: 'menu',
      status: 'partial',
      relationKinds: ['references_text'],
      reader: 'menu.msgbnd FMG 文本条目（Bridge read-msgbnd）',
      provider: 'references/paramTextReferences.ts + references/containerMemberProvider.ts',
      uncoveredReasons: ['菜单项→文本的显式 mapping 之外的语义未登记']
    },
    other: {
      kind: 'other',
      status: 'unsupported',
      relationKinds: [],
      reader: '（无）',
      provider: '（无）',
      uncoveredReasons: ['未分类资源不声明任何关联语义']
    },
    unknown: {
      kind: 'unknown',
      status: 'unsupported',
      relationKinds: [],
      reader: '（无）',
      provider: '（无）',
      uncoveredReasons: ['未知资源类型只登记为未覆盖，不产生边']
    }
  });

/**
 * 穷举自检：`ALL_RESOURCE_KINDS` 的每一个值都必须有登记；反向，registry 里
 * 不得出现枚举外的键。测试入口调用它，新增 kind 缺登记即失败（步骤 12）。
 */
export function validateReferenceCapabilities(): { ok: true } | { ok: false; missing: string[]; extra: string[] } {
  const registered = new Set(Object.keys(REFERENCE_CAPABILITIES));
  const missing = ALL_RESOURCE_KINDS.filter((kind) => !registered.has(kind));
  const known = new Set<string>(ALL_RESOURCE_KINDS);
  const extra = [...registered].filter((kind) => !known.has(kind));
  if (missing.length === 0 && extra.length === 0) return { ok: true };
  return { ok: false, missing, extra };
}

export function referenceCapabilityFor(kind: ResourceKind): ReferenceDomainCapability {
  return REFERENCE_CAPABILITIES[kind];
}


