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
  project: '开始',
  param: 'PARAM',
  gparam: 'GPARAM',
  text: '文本',
  event: '事件',
  map: '地图',
  script: '脚本',
  behavior: '动作',
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
  /**
   * 是否已挂载工作区。有工作区后「开始」不再是页（问题 1）：project 与
   * GPARAM / 动画 / 文件同口径从领域顶栏隐藏，换文件夹改走标题栏
   * workspace-switcher。缺省 false（无工作区时 project 仍 visible，首次
   * 打开应用没有选择工作区时中央仍显示开始页）。
   */
  readonly hasWorkspace?: boolean;
}

/**
 * 构造领域栏的 DomainSummary[]。只做三件事：
 *
 * 1. 领域集合 = shared EDITOR_DOMAIN_IDS 的固定顺序（§3.2 领域顺序固定，
 *    不因文件内容增减而变）；
 * 2. capability 按「read contract 已注册 × 运行条件满足」判定（§3.2）；
 * 3. visibility 按用户裁定投影：
 *    - R1（2026-08-14）：GPARAM 从领域顶栏移除，与 PARAM 合并进左侧
 *      「参数」逻辑库（见 front-end.md §3.2 的裁定投影）。
 *    - T3（2026-08-15）：行为 + 动画合并为「动作」。顶栏只保留「动作」
 *      （behavior 标签即「动作」，侧栏列 anibnd/tae）；animation 从顶栏隐藏，
 *      与 GPARAM 同口径（域仍可路由，只是不在顶栏/命令面板提供一级入口）。
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
      // R1 + T3 + 14 裁定：顶栏删除独立「GPARAM」「动画」与「文件」。GPARAM 并入
      // 左侧「参数」逻辑库，动画并入「动作」（行为标签）。文件仍可路由（resourceMode
      // 物理浏览 / Ctrl+K 命令面板搜路径 / 开始页资源树照常），只是不在顶栏/命令
      // 面板提供一级入口。这不是 display:none 藏 UI —— 规范投影已同步（front-end.md）。
      // 问题 1：有工作区后「开始」不再是页，project 与它们同口径隐藏——换 Mod 工作区
      // / 原版目录改走标题栏 workspace-switcher（任何领域都在），不再把换文件夹锁在
      // 开始态侧栏。无工作区（首次打开）时 project 保持 visible，中央仍渲染开始页。
      visibility: domain === 'gparam' || domain === 'animation' || domain === 'files'
        || (domain === 'project' && input.hasWorkspace === true)
        ? 'hidden'
        : 'visible',
      capability,
      defaultTarget: null
    };
  });
}
