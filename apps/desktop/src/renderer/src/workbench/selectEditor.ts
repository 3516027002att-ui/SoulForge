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
 */

/** 编辑器标识。每个值对应主视图里唯一一个占满区域的编辑器。 */
export type EditorId =
  | 'param-container'   // parambnd 容器：三栏 param 编辑器
  | 'param-rows'        // 裸 param 文件：行表 + 字段
  | 'text'              // FMG / msg 文本
  | 'map'               // MSB 地图数据 + 三维代理场景
  | 'event'             // EMEVD 事件
  | 'script'            // 脚本容器
  | 'container'         // 通用 BND4 容器
  | 'tae' | 'esd' | 'flver' | 'tpf'
  | 'plain-text'        // 可编辑纯文本资源
  | 'binary'            // 无专属编辑器的二进制：原始字节
  | 'operations'        // 任务与历史（非资源视图）
  | 'settings'          // 设置视图（非资源视图）
  | 'empty';            // 未选择资源

export interface SelectEditorInput {
  /**
   * 中央视图模式。
   *
   * 必须与 App.tsx 的 CenterView 一致（含 'settings'）—— 第一版只写了
   * resource/operations，typecheck 立刻指出漏了 settings。在调用处强转会把
   * 这个漏项藏起来：settings 视图会落进 'empty' 分支从而渲染资源空态文案。
   */
  centerView: 'resource' | 'operations' | 'settings';
  /** 顶部资源目录 tab（event/map/param/…）。 */
  resourceMode: string;
  /** 当前选中资源；未选择时为 null。 */
  selectedFile: {
    relativePath: string;
    resourceKind: string;
    formatKind: string;
    compoundExtension: string;
  } | null;
  /** 预览类型：text / hex / empty / failed 等。 */
  previewKind?: string | undefined;
  /** 该文本预览是否可编辑（结构化预览声明 editable 且未截断）。 */
  textEditable?: boolean;
  /** 命令面板强制「以 BND4 容器打开」。用户显式选择，优先于格式推断。 */
  bnd4Forced?: boolean;
}

/** parambnd 容器（含 .bak 备份：它的 formatLabel 是 Backup File 但仍是容器）。 */
function isParamContainer(relativePath: string, resourceKind: string): boolean {
  return resourceKind === 'param' && /\.parambnd(\.dcx)?(\.bak)?$/i.test(relativePath);
}

function isContainerLike(file: NonNullable<SelectEditorInput['selectedFile']>): boolean {
  return file.formatKind === 'bnd'
    || file.formatKind === 'dcx'
    || file.compoundExtension.includes('.bnd')
    || file.compoundExtension.includes('.dcx');
}

/**
 * 返回唯一编辑器。
 *
 * 顺序即优先级，且**必须**是全序：任何输入只落进一条分支。
 * 优先级依据：用户显式选择 > 格式专属编辑器 > 容器视图 > 通用回退。
 */
export function selectEditor(input: SelectEditorInput): EditorId {
  // 非资源视图先短路：它们有自己的面板，不该落进任何资源编辑器。
  if (input.centerView === 'operations') return 'operations';
  if (input.centerView === 'settings') return 'settings';
  const file = input.selectedFile;
  if (!file) return 'empty';

  // 用户显式要求以容器视角打开：优先于格式推断，因为那是主动选择。
  if (input.bnd4Forced === true) return 'container';

  // 格式专属编辑器。param 容器与裸 param 分开 —— 前者要先选容器内哪个 param，
  // 后者直接就是行表（read-param-document 不解 DCX/BND4）。
  if (isParamContainer(file.relativePath, file.resourceKind)) return 'param-container';
  if (file.resourceKind === 'param') return 'param-rows';
  if (file.resourceKind === 'msg' || file.resourceKind === 'menu') return 'text';
  if (file.resourceKind === 'map') return 'map';
  if (file.resourceKind === 'event') return 'event';
  if (file.resourceKind === 'script') return 'script';

  // 按扩展名判定的单文件格式（这些不是按目录分类的）。
  const path = file.relativePath.toLowerCase();
  if (path.endsWith('.tae')) return 'tae';
  if (path.endsWith('.esd')) return 'esd';
  if (path.endsWith('.flver')) return 'flver';
  if (path.endsWith('.tpf') || path.endsWith('.tpf.dcx')) return 'tpf';

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
