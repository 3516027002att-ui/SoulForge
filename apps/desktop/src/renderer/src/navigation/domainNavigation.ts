/**
 * SHELL-09：领域导航只消费 EditorCatalogSummary 的 DomainSummary[]。
 *
 * §4.1 固定数据流：
 *
 * ```text
 * Physical scan → artifact-role filter → Bridge format confirmation
 * → container-child projection → EditorCatalog
 * → renderer-safe EditorCatalogSummary → DomainNavigationBar
 * → one WorkbenchRoute → mature editor workbench
 * ```
 *
 * 本模块不再根据 RendererIndexedFile.resourceKind、路径首段或 suffix 把物理
 * 文件分到领域（§16：若仍存在 domainForFile 则任务失败）。领域集合由 shared
 * EDITOR_DOMAIN_IDS 固定投影（§3.2：领域顺序和目标集合固定）；运行时只有
 * 真实 read contract 已注册且运行条件满足时才把对应入口标为可操作；project
 * 与 files 始终存在。
 *
 * 「真实 read contract 已注册」的 renderer 可观测形态是 preload bridge 上的
 * 对应 read 方法（方法存在 = 主进程已注册该通道）；调用方从 bridge 投影出
 * ReadonlySet<EditorDomainId> 传入，本模块不接触 bridge 与任何文件数据。
 */
import {
  EDITOR_DOMAIN_IDS,
  type DomainSummary,
  type EditorDomainId
} from '@soulforge/shared';

/** §3.2 固定顺序对应的中文标签（渲染侧文案；core 的英文 DOMAIN_LABELS 不参与）。 */
const DOMAIN_LABELS: Record<EditorDomainId, string> = {
  project: '项目',
  param: 'PARAM',
  gparam: 'GPARAM',
  text: '文本',
  event: '事件',
  map: '地图',
  script: '脚本',
  behavior: '行为',
  animation: '动画',
  model: '模型',
  texture: '纹理',
  material: '材质',
  vfx: 'VFX',
  container: '容器',
  files: '文件'
};

export function domainLabel(domain: EditorDomainId): string {
  return DOMAIN_LABELS[domain];
}

export interface BuildDomainSummariesInput {
  /**
   * 已注册 read contract 的领域集合。调用方从 preload bridge 的方法存在性
   * 投影：方法存在 = 主进程已注册该领域的 read 通道。project/files 不依赖它。
   */
  readonly readContract: ReadonlySet<EditorDomainId>;
  /**
   * 运行条件是否满足（非 browser-preview 且 bridge 可用）。条件不满足时
   * 已注册契约的领域标 runtime-blocked（§3.2「运行条件满足」）。
   */
  readonly runtimeReady: boolean;
}

/**
 * 构造领域栏的 DomainSummary[]。只做三件事：
 *
 * 1. 领域集合 = shared EDITOR_DOMAIN_IDS 的固定顺序（§3.2 领域顺序固定，
 *    不因文件内容增减而变）；
 * 2. capability 按「read contract 已注册 × 运行条件满足」判定（§3.2）；
 * 3. visibility 按用户裁定（R1，2026-08-14）投影：GPARAM 从领域顶栏移除，
 *    与 PARAM 合并进左侧「参数」逻辑库（见 front-end.md §3.2 的裁定投影）。
 *
 * defaultTarget 本卡恒为 null：SHELL-09 只完成外壳契约，逻辑库 document 句柄
 * 由后续 read 卡（PARAM-10A 等）经 IPC 提供；在拿到真实 EditorCatalogSummary
 * 之前不得伪造默认目标。
 */
export function buildDomainSummaries(input: BuildDomainSummariesInput): readonly DomainSummary[] {
  return EDITOR_DOMAIN_IDS.map((domain) => {
    const alwaysPresent = domain === 'project' || domain === 'files';
    const capability: DomainSummary['capability'] = alwaysPresent
      ? 'read-ready'
      : input.readContract.has(domain)
        ? (input.runtimeReady ? 'read-ready' : 'runtime-blocked')
        : 'deferred';
    return {
      domain,
      label: DOMAIN_LABELS[domain],
      // R1 裁定：顶栏删除独立「GPARAM」；PARAM 与 GPARAM 都进左侧「参数」逻辑库。
      // 域本身仍可路由（打开 gparam 文件时工作台照常），只是不在顶栏/命令面板
      // 提供一级入口。这不是 display:none 藏 UI —— 规范投影已同步（front-end.md）。
      visibility: domain === 'gparam' ? 'hidden' : 'visible',
      capability,
      defaultTarget: null
    };
  });
}
