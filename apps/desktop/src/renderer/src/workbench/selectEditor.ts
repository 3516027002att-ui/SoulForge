/**
 * 选定一个资源该用哪个编辑器（纯函数，可单测）。
 *
 * ── 守的问题 ──
 *
 * 用户报「工作页面重证据、无工作」，两轮改组件都没解决，因为病根在装配方式：
 * 主视图区曾有 15 个**互不排斥**的条件块（`resourceMode === 'param'`、
 * `selectedIsParamContainer`、`showBnd4Workbench`、若干 `previewKind` 分支…），
 * 打开一个 parambnd 会同时命中三四个，于是主区变成「一叠卡片竖着堆」——
 * 实测截图里 param 容器同时渲染出 param 工作台与 BND4 容器工作台两张条目表。
 *
 * 真实工具（Smithbox、Yabber、DSMapStudio）都是一次只显示一个编辑器。
 * 这里把「该用哪个」收敛成一个函数：调用方按返回值渲染唯一编辑器，
 * 新增格式只需在这里加一条分支，不会再出现「忘了排斥另一个分支」。
 *
 * ── 为什么是纯函数而不是组件 ──
 *
 * 选择逻辑要能被单测钉住。判据是「同一份输入只产出一个 editorId」——
 * 那正是此前缺失的约束，而它在 JSX 里无法断言（条件块散在 900 行里）。
 *
 * ── ROUTE-06：唯一 WorkbenchRoute（front-end.md §5）──
 *
 * 路由顺序（§5.1）：
 *   0. artifact-role prefilter（backup/previous/recovery → History-only；
 *      projection/cache/audit/temporary → hidden 无 route；primary/base → 继续）
 *   1. explicit Open With（仅 primary/base）
 *   2. Bridge-confirmed leaf format（只解释 RESOURCE_CLASSIFICATION_RULES，
 *      不另建自由分支）
 *   3. confirmed container-child semantic projection（child 由容器导航呈现，
 *      不独立路由）
 *   4. registered read capability and runtime availability
 *   5. content probe candidate
 *   6. suffix/path candidate
 *   7. Files fallback
 *
 * 输入的 `selectedFile` 带 catalog 语义投影（artifactRole /
 * recognizedLeafFormatId / containerRole / semanticSubtype / readReady /
 * document）时走上面的严格路由；缺省时走 legacy 推断路径——它只依据
 * workspace 扫描给出的 formatKind/compoundExtension（文件系统证据，不是目录
 * 名），产出的是 candidate，不会升级为 ready。两种路径都必须保证「每个输入
 * 恰好产出一个结果」。`selectWorkbenchRoute` 是 §5.2 的完整 route 表达，
 * `selectEditor` 是它的 EditorId 投影（App.tsx 按 EditorId 分派渲染）。
 */

import {
  EDITOR_INTEGRATIONS,
  resolveIntegrationForConfirmedLeaf,
  type ArtifactRole,
  type ContainerRole,
  type LogicalDocumentRef,
  type NativeFormatId,
  type WorkbenchRoute
} from '@soulforge/shared';

/** 编辑器标识。每个值对应主视图里唯一一个占满区域的编辑器。 */
export type EditorId =
  | 'param-container'   // parambnd 容器：三栏 param 编辑器
  | 'param-rows'        // 裸 param 文件：行表 + 字段
  | 'gparam'            // GPARAM 文件/容器：bank 工作台（ROUTE-06，非 Param）
  | 'text'              // FMG / msg 文本
  | 'map'               // MSB 地图数据 + 三维代理场景
  | 'event'             // EMEVD 事件
  | 'script'            // 脚本容器
  | 'container'         // 通用 BND4 容器
  | 'tae' | 'esd' | 'flver' | 'tpf'
  | 'plain-text'        // 可编辑纯文本资源
  | 'binary'            // 无专属编辑器的二进制：原始字节
  | 'project'            // 项目概览
  | 'operations'        // 任务与历史（非资源视图）
  | 'settings'          // 设置视图（非资源视图）
  | 'empty';            // 未选择资源（或不可路由：history-only / hidden）

export interface SelectEditorInput {
  /**
   * 中央视图模式。
   *
   * 必须与 App.tsx 的 CenterView 一致（含 'settings'）—— 第一版只写了
   * resource/operations，typecheck 立刻指出漏了 settings。在调用处强转会把
   * 这个漏项藏起来：settings 视图会落进 'empty' 分支从而渲染资源空态文案。
   */
  centerView: 'project' | 'resource' | 'operations' | 'settings';
  /** 顶部资源目录 tab（event/map/param/…）。 */
  resourceMode: string;
  /** 当前选中资源；未选择时为 null。 */
  selectedFile: {
    relativePath: string;
    resourceKind: string;
    formatKind: string;
    compoundExtension: string;
    /**
     * ROUTE-06：catalog 语义投影（§4.3/§4.4）。缺省时走 legacy 推断路径。
     * 只要任一语义字段存在，`resourceKind`/`formatKind` 目录分派即被禁用，
     * 严格按 §5.1 路由。
     */
    /** artifact-role（backup/previous/recovery → history；cache/audit/temporary → hidden）。 */
    artifactRole?: ArtifactRole;
    /** Bridge-confirmed leaf format（确认堆栈的 leaf；'unknown' 视为未确认）。 */
    recognizedLeafFormatId?: NativeFormatId;
    /** 容器角色（bnd4 容器时为对应 binder；非容器为 'none'）。 */
    containerRole?: ContainerRole;
    /** 语义子类型（gameparam-primary / map-bank / loose-table …）。 */
    semanticSubtype?: string;
    /** read capability 是否 ready（§5.1 第 4 级；缺省视为未提供，不拦）。 */
    readReady?: boolean;
    /** history 路由的恢复目标（backup/previous/recovery 时）。 */
    recoveryOfResourceId?: string | null;
    /** ready 路由需要逻辑文档引用（§5.2）。 */
    document?: LogicalDocumentRef;
  } | null;
  /** 预览类型：text / hex / empty / failed 等。 */
  previewKind?: string | undefined;
  /** 该文本预览是否可编辑（结构化预览声明 editable 且未截断）。 */
  textEditable?: boolean;
  /** 命令面板强制「以 BND4 容器打开」。用户显式选择，优先于格式推断（仅 primary/base）。 */
  bnd4Forced?: boolean;
}

function hasSemanticProjection(file: NonNullable<SelectEditorInput['selectedFile']>): boolean {
  return file.artifactRole !== undefined
    || file.recognizedLeafFormatId !== undefined
    || file.containerRole !== undefined
    || file.semanticSubtype !== undefined
    || file.readReady !== undefined;
}

function isContainerLike(file: NonNullable<SelectEditorInput['selectedFile']>): boolean {
  return file.formatKind === 'bnd'
    || file.formatKind === 'dcx'
    || file.compoundExtension.includes('.bnd')
    || file.compoundExtension.includes('.dcx');
}

/**
 * §5.2 完整 WorkbenchRoute。每次打开只能得到一个 route；不得同时渲染
 * Text、Hex、Evidence 或多个 preview。
 *
 * 无语义投影的 legacy 输入只产生 `files-candidate`——后缀/格式推断不是
 * Bridge 确认，绝不产生 ready（§5.3「suffix-only candidate 不能产生 ready」）。
 */
export function selectWorkbenchRoute(input: SelectEditorInput): WorkbenchRoute {
  if (input.centerView !== 'resource') return { kind: 'unsupported', reasonCode: 'non-resource-view' };
  const file = input.selectedFile;
  if (!file) return { kind: 'unsupported', reasonCode: 'no-selection' };
  if (!hasSemanticProjection(file)) {
    return { kind: 'files-candidate', reasonCode: 'suffix-candidate-without-confirmation' };
  }

  // 0. artifact-role prefilter：不可绕过，先于 Open With 与所有普通编辑器路由。
  const role = file.artifactRole;
  if (role === 'backup' || role === 'previous' || role === 'recovery') {
    return { kind: 'history', recoveryOfResourceId: file.recoveryOfResourceId ?? null };
  }
  if (role === 'projection' || role === 'cache' || role === 'audit' || role === 'temporary') {
    return { kind: 'unsupported', reasonCode: 'hidden-artifact' };
  }

  // 1. explicit Open With：仅 primary/base（role 缺失视为 primary；history/hidden
  //    已在 prefilter 拦截，不会到达这里）。
  if (input.bnd4Forced === true) {
    if (!file.document) return { kind: 'unsupported', reasonCode: 'missing-document-ref' };
    return { kind: 'ready', editorId: 'container', document: file.document, readOnly: false };
  }

  // 2. Bridge-confirmed leaf format：只解释 RESOURCE_CLASSIFICATION_RULES。
  const leaf = file.recognizedLeafFormatId;
  if (leaf !== undefined && leaf !== 'unknown') {
    const resolution = resolveIntegrationForConfirmedLeaf(
      leaf,
      file.containerRole ?? 'none',
      file.semanticSubtype ?? null
    );
    if (resolution) {
      const editorId = editorIdForIntegration(resolution.integrationId, leaf);
      // 4. registered read capability and runtime availability。
      if (file.readReady === false) {
        return { kind: 'runtime-blocked', editorId, reasonCode: 'read-capability-blocked' };
      }
      if (!file.document) return { kind: 'unsupported', reasonCode: 'missing-document-ref' };
      return { kind: 'ready', editorId, document: file.document, readOnly: false };
    }
  }

  // 5/6/7. candidate → Files fallback：未确认的格式不产生 ready。
  return { kind: 'files-candidate', reasonCode: 'unconfirmed-format' };
}

/**
 * 把 EditorIntegration 的 editorId 投影到主视图唯一工作台标识。
 *
 * 只解释 EDITOR_INTEGRATIONS（§4.4 固定注册表）。material/vfx 对应工作台
 * 尚未实施：不假装 ready，落原始字节（candidate 视图）。
 */
function editorIdForIntegration(integrationId: string, leafFormatId: Exclude<NativeFormatId, 'unknown'>): EditorId {
  const integration = EDITOR_INTEGRATIONS.find((item) => item.integrationId === integrationId);
  switch (integration?.editorId) {
    case 'param': return leafFormatId === 'bnd4' ? 'param-container' : 'param-rows';
    case 'gparam': return 'gparam';
    case 'fmg': return 'text';
    case 'emevd-source': return 'event';
    case 'msb': return 'map';
    case 'script': return 'script';
    case 'esd': return 'esd';
    case 'tae': return 'tae';
    case 'flver': return 'flver';
    case 'tpf': return 'tpf';
    case 'bnd4': return 'container';
    case 'material':
    case 'vfx':
    case 'files':
    default: return 'binary';
  }
}

/**
 * legacy 推断路径：未接 catalog 语义的输入（App.tsx 现状）。
 *
 * 只依据 workspace 扫描给出的 formatKind/compoundExtension（来自
 * COMPOUND_PATTERNS 的文件系统证据，见 resourceFileTypes.ts），不再按
 * resourceKind 目录名分派；`.bak`（formatKind 'backup'）绝不进入任何语义
 * 编辑器。产出是 candidate（§5.3），供旧 UI 继续工作；catalog 接线后由
 * 语义路径接管。
 */
function editorIdForLegacy(
  input: SelectEditorInput,
  file: NonNullable<SelectEditorInput['selectedFile']>
): EditorId {
  // 命令面板强制「以 BND4 容器打开」：用户显式选择，优先于格式推断。
  if (input.bnd4Forced === true) return 'container';

  switch (file.formatKind) {
    case 'param': return 'param-container';
    case 'fmg': return 'text';
    case 'msb': return 'map';
    case 'emevd': return 'event';
    case 'lua':
    case 'hks': return 'script';
    case 'tpf': return 'tpf';
    case 'gparam': return 'gparam';
    case 'bnd':
    case 'dcx': return 'container';
    // .bak/.prev：artifact-role 的 legacy 近似——备份不进入任何语义编辑器。
    case 'backup': return 'binary';
    default: break;
  }

  // 单文件格式后缀（未在 COMPOUND_PATTERNS，formatKind 为 unknown）。
  const path = file.relativePath.toLowerCase();
  if (path.endsWith('.parambnd.dcx') || path.endsWith('.parambnd')
    || path.endsWith('.gameparambnd.dcx') || path.endsWith('.gameparambnd')
    || path.endsWith('.drawparambnd.dcx') || path.endsWith('.drawparambnd')) return 'param-container';
  if (path.endsWith('.param')) return 'param-rows';
  if (path.endsWith('.gparam.dcx') || path.endsWith('.gparam')) return 'gparam';
  if (path.endsWith('.fmg')) return 'text';
  if (path.endsWith('.emevd')) return 'event';
  if (path.endsWith('.msb')) return 'map';
  if (path.endsWith('.lua') || path.endsWith('.hks') || path.endsWith('.luabnd.dcx')) return 'script';
  if (path.endsWith('.tae')) return 'tae';
  if (path.endsWith('.esd')) return 'esd';
  if (path.endsWith('.flver')) return 'flver';
  if (path.endsWith('.tpf.dcx') || path.endsWith('.tpf')) return 'tpf';

  // 容器：没有专属编辑器但能列条目树。
  if (isContainerLike(file)) return 'container';

  // 可编辑纯文本。
  if (input.previewKind === 'text' && input.textEditable === true) return 'plain-text';

  /*
   * 其余一律归到「原始字节」。
   *
   * 包括 previewKind 为 text 但不可编辑、empty、failed、hex ——
   * 它们的共同点是「没有语义编辑器」，而不是「读取出了问题」。
   * 失败原因归底部日志区，不在主区用一句「读取失败」占位：那句话既不说明
   * 问题也不给出动作，实测截图里正是它占着主区。
   */
  return 'binary';
}

/**
 * 返回唯一编辑器（App.tsx 分派渲染用）。
 *
 * 顺序即优先级，且**必须**是全序：任何输入只落进一条分支。
 * 语义投影存在时走 §5.1 严格路由（selectWorkbenchRoute 的投影）；否则走
 * legacy 推断路径。两者都不允许「目录名决定编辑器」或「.bak 进入 Param」。
 */
export function selectEditor(input: SelectEditorInput): EditorId {
  // 非资源视图先短路：它们有自己的面板，不该落进任何资源编辑器。
  if (input.centerView === 'project') return 'project';
  if (input.centerView === 'operations') return 'operations';
  if (input.centerView === 'settings') return 'settings';
  const file = input.selectedFile;
  if (!file) return 'empty';

  if (hasSemanticProjection(file)) {
    const route = selectWorkbenchRoute(input);
    switch (route.kind) {
      case 'ready': return route.editorId as EditorId;
      // history-only / hidden：不可路由，不假装可编辑。
      case 'history':
      case 'unsupported': return 'empty';
      // candidate / runtime-blocked：没有语义编辑器，落原始字节。
      case 'files-candidate':
      case 'runtime-blocked': return 'binary';
    }
  }
  return editorIdForLegacy(input, file);
}
