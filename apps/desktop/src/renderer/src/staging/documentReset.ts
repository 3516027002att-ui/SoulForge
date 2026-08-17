/**
 * 每种资源族的编辑态复位登记表（纯数据 + 纯函数，可单测）。
 *
 * 为什么需要它：App.tsx 里每个资源族（FMG / PARAM / EMEVD / MSB / TAE / ESD /
 * FLVER）各有一组 useState，而「切换工作区」与「切换选中文件」两处都需要把它们
 * 清空。此前这两处是手写 setter 列表，实测结果是：
 *
 *   openWorkspace  —— 8 个资源族**一个都没复位**
 *   selectFile     —— 只复位了 TAE/ESD/FLVER/TPF，漏掉 FMG/PARAM/EMEVD/MSB
 *
 * 症状是切换工作区或切换文件后，面板仍显示上一个资源的行/条目/场景。写入侧有
 * live+sourceHash 双重前置条件挡着（不会写错文件），但显示层会伪造「已解析」
 * 观感——而硬约束 7 要求严格区分 native-verified 与其他状态。
 *
 * TPF 不在此表：TEXTURE-52B 把 TpfWorkbenchPanel 改成自驱动四栏工作台（镜像
 * GparamWorkbench），选中容器/选中纹理/预览都自持在工作台内部，由 App 的
 * key={selectedFile.sourceUri} 重建清空，不再持有 App 级 useState —— 不需要
 * App 级复位。
 *
 * 手写列表的根本问题是**漏一项不会有任何信号**：没有编译错误、没有测试失败、
 * 没有诊断。新增一种资源族要同步改两处，而漏改只能靠肉眼发现。
 *
 * 所以这里把「一种资源族有哪些编辑态」变成一处显式登记，由
 * assertDocumentResetCoverage 在单测里对着真实 App.tsx 源码核对：登记表少了
 * 哪个 setter，门禁就报哪个。复位动作本身由 App 传入 setter 映射执行——本模块
 * 不持有 React 状态，只决定「该清哪些」。
 */

/** 资源族标识。新增族时在此扩展，登记表与覆盖门禁会同步要求补齐。 */
export type DocumentFamily =
  | 'fmg'
  | 'param'
  | 'emevd'
  | 'msb'
  | 'tae'
  | 'esd'
  | 'flver';

export const DOCUMENT_FAMILIES: readonly DocumentFamily[] = Object.freeze([
  'fmg',
  'param',
  'emevd',
  'msb',
  'tae',
  'esd',
  'flver'
]);

/**
 * 每个族在 App.tsx 里的 setter 名清单。
 *
 * 用 setter 名而不是直接持有函数引用：这样单测能对着 App.tsx 源码做双向对账
 * ——既能发现「登记表漏了某个 setter」，也能发现「App 里新增了 setter 但没
 * 登记」。只持有函数引用的话，第二种漏项永远发现不了。
 */
export const DOCUMENT_STATE_SETTERS: Readonly<Record<DocumentFamily, readonly string[]>> =
  Object.freeze({
    fmg: Object.freeze(['setFmgEntries', 'setFmgSourceHash', 'setFmgLive']),
    param: Object.freeze([
      'setParamRows',
      'setParamTypeName',
      'setParamSourceHash',
      'setParamLive',
      'setParamRowPayloads',
      // 字段定义与其缺失原因属于「当前这个 param 文档」的状态：切换资源后
      // 若不清，上一张表的字段列会残留在新表旁边——而两张表的行宽通常不同，
      // 那会让用户对着错误的字段名看新表的字节。
      'setParamFieldDefs',
      // 枚举表属于「当前这个 param 文档」的状态：不同 param 的 enum 集合不同，
      // 残留会让新表的字段配上上一张表的枚举标签 —— 那比不显示标签更糟，
      // 因为一个错的标签看起来完全合理。
      'setParamFieldEnums',
      'setParamFieldDefsDiagnostic',
      // 授信来源同样属于「当前这个 param 文档」的状态，必须随资源切换清掉：
      // 上一个 param 的 origin 若是 imported 而残留下来，新 param 的字段会被
      // 错误地显示为可写 —— 那正是授权门要挡住的形态（按未校验的字段偏移写入）。
      'setParamFieldDefsOrigin'
    ]),
    // EVENT-30B：EMEVD 编辑态收敛为单个 pendingTab（工作台内部自持 tabs/dirty/
    // draft/per-tab EditorState）。复位即清空 pendingTab；工作台收到 null 后回到
    // 空态，不会把上一个事件的源码残留到新资源旁边。
    emevd: Object.freeze(['setEventPendingTab']),
    msb: Object.freeze([
      'setMsbParts',
      'setMsbModels',
      'setMsbRegions',
      'setMsbEvents',
      'setMsbSourceCounts',
      'setMsbLive',
      'setMsbSourceHash',
      // S15/S19 失败面：跨资源族的「最近一次资源打开失败」记录。挂在 msb 族下
      // 只是登记槽位，复位动作会把它一并清空——切换工作区/文件后，旧资源的
      // 失败不得再进工作台显示或 Agent 元数据。
      'setLastOpenFailure'
    ]),
    tae: Object.freeze(['setTaeData']),
    esd: Object.freeze(['setEsdData']),
    flver: Object.freeze(['setFlverData'])
  });

/**
 * 复位动作表：族 → 一个无参函数，调用即把该族清空。
 * 由 App 组装（它持有真实 setter），本模块只负责按族调度。
 */
export type DocumentResetActions = Readonly<Record<DocumentFamily, () => void>>;

/**
 * 清空全部资源族的编辑态。
 *
 * 切换工作区、切换选中文件都必须调它。返回被清空的族列表，便于调用方在诊断里
 * 报出实际发生了什么（而不是「大概清了」）。
 */
export function resetAllDocuments(actions: DocumentResetActions): DocumentFamily[] {
  const cleared: DocumentFamily[] = [];
  for (const family of DOCUMENT_FAMILIES) {
    const reset = actions[family];
    // 缺项在类型层就该被 Record 拦住；运行期再兜一次，避免某个族被有意置空后
    // 静默跳过——那正是本模块要消除的失效形态。
    if (typeof reset !== 'function') {
      throw new Error(`DOCUMENT_RESET_MISSING: 资源族 ${family} 没有复位动作。`);
    }
    reset();
    cleared.push(family);
  }
  return cleared;
}

/**
 * 对着 App.tsx 源码核对登记表的双向覆盖。
 *
 * 供单测调用（传入源码文本），不在生产路径运行。判据是双向的：
 *   - 登记表里的每个 setter 必须真实存在于源码（防登记表写错名字或过期）；
 *   - 源码里每个 `setXxx` 形态的 per-document setter 必须已登记（防新增漏登记）。
 *
 * 第二个方向靠一份显式白名单排除非文档态 setter（视图、通知、AI 等）。白名单
 * 必须写理由：否则「往白名单里加一项」会变成绕过覆盖检查的后门。
 */
export interface ResetCoverageReport {
  ok: boolean;
  /** 登记了但源码里找不到的 setter。 */
  registeredButMissing: string[];
  /** 源码里存在、看起来是文档态、但未登记的 setter。 */
  presentButUnregistered: string[];
}

/** 非文档态 setter：不参与复位登记，附排除理由。 */
export const NON_DOCUMENT_SETTERS: Readonly<Record<string, string>> = Object.freeze({
  setWorkspace: '工作区扫描结果，由 openWorkspace 自己赋值',
  setSessionMeta: '会话元数据，同上',
  setBaseRootChoice: '目录选择，跨工作区保留是有意的',
  setOperationHistory: '写入历史，按工作区刷新而非清空',
  setAnalysis: '索引摘要，openWorkspace 自己赋值',
  setTools: 'AI 工具清单，与资源无关',
  setSelectedFile: '选中文件本身，不是文档态',
  setPreview: '通用预览，非资源族专属',
  setEditText: '文本编辑器内容，纯文本路径',
  setLastSavedText: '同上',
  setMsgRows: 'FMG 文本表行，由 extractMsgRows 从 preview 派生',
  setSaveDiagnostics: '保存诊断，随保存动作更新',
  setQuery: '搜索词，跨文件保留是有意的',
  setEventUri: '事件 URI 输入框',
  setToolOutput: 'AI 工具输出',
  setFiles: '文件列表',
  setAllFiles: '完整文件列表',
  setResourceMode: '资源族筛选视图状态',
  setActiveDomain: '顶层工作域导航状态；切换工作区时回到项目入口，不属于资源文档内容',
  setCenterView: '中央视图状态',
  setBnd4Forced: '强制以 BND4 打开的标记',
  setSidebarView: '侧栏视图状态',
  setAgentOpen: 'Agent 抽屉开关',
  setStatus: '状态栏文案',
  setParamRowDataSize: '行宽由 paramdef 决定，复位为 0 会让 UI 显示错误的 0 字节；保留上次值直到新文档赋值',
  setCiteSelecting: '引用框选暗幕激活态：一次框选的生命周期，与资源文档内容无关',
  setPendingCiteHits: '引用框选结算出的命中，交 AgentSidebar 消费即清空，非文档态',
  setAiProvider: 'AI 会话配置',
  setAiThinking: '同上',
  setAiPrompt: '同上',
  setAiDraft: 'AI 草稿，由 selectFile 单独清空',
  setAgentIdleNotice: 'T6 空闲说明（无模型等），非文档态，随任务生命周期清空',
  setAiBusy: 'AI 忙碌标记',
  setAgentGoal: 'Agent 目标',
  // ── AI agent 任务态（REL-G 的 renderer 入口）────────────────────────────
  //
  // 这一组刻意**不**参与资源族复位，理由不是「与资源无关」这么一句：任务在主
  // 进程异步跑，取消要靠 sessionId（ipc.ts:3027 的 activeAgentRuns.get）。切换
  // 工作区时把 setAgentTask 清回 idle，会让一个仍在跑的任务从界面上消失且再也
  // 取消不掉——那正违反硬约束 16（长任务必须可报告进度、可取消）。
  // 显示层的「陈旧」风险也不存在：任务态描述的是那次运行本身，不是当前资源。
  setAgentTask: 'AI 任务态；跨工作区保留是有意的——清空会让仍在跑的任务失去取消入口（硬约束 16）',
  setAgentServices: '模型服务清单，来自凭据 vault，与工作区无关',
  setAgentServiceId: '选中的模型服务，跨工作区保留是有意的',
  setAgentSessions: '会话历史列表，来自 userData/agent，与工作区无关',
  setAgentSessionsPage: '会话列表页码，随刷新自行复位',
  setAgentSessionsError: '会话读取的结构化诊断，随下次读取覆盖',
  setAgentSessionDetail: '已载入会话的详情，随下次载入覆盖',
  setAgentTools: 'AI 工具清单（来自 ai.tools），是权限阶梯的展示侧，与资源无关',
  // 与 setAgentTask 同一理由：审批属于那一次运行，不属于当前资源。切换工作区时
  // 清空「正在发送的审批」会让按钮重新变可点，用户可能对同一条请求点第二次；
  // 而主进程侧 pendingApprovals 是按 sessionId:callId 键的，与工作区无关。
  // 两者都随下一次审批动作覆盖，不会长期残留。
  setRespondingApprovalCallId: '正在发送的审批 callId；属于那次运行而非当前资源，随回答完成清空',
  setApprovalError: '审批回答失败的结构化原因，随下次回答覆盖',
  setSidebarCollapsed: '布局状态',
  setSidebarWidth: '布局状态',
  setAgentWidth: 'Agent 停靠栏布局状态，按 opaque workspace UI key 持久化',
  setAgentExpanded: 'Agent 停靠栏布局状态',
  setAgentOverlay: 'Agent 停靠栏响应式布局派生状态',
  setAgentInteractionMode: 'Agent composer 交互意图状态，与资源文档无关',
  // AGENT-60D 提交期消费：Agent 资源引用草稿由 AgentSidebar 内部 reducer 冒泡
  // （App 在 runAgentTask 里把 resources 随 runAiAgent 提交，main 按
  // agentReferenceRegistry 校验 token）。它是用户显式添加的 Agent 输入上下文，
  // 不随切换工作区/文件清空——清空会让进行中的 Agent 任务丢失已引用资源。
  setAgentResources: 'Agent 资源引用草稿；属于 Agent 那次运行的输入上下文，与当前资源文档无关，跨工作区保留',
  setCmdkOpen: '命令面板状态',
  setCmdkQuery: '命令面板状态',
  setCmdkIndex: '命令面板状态',
  setToasts: '通知',
  setOpenTabs: '标签页',
  setFilePage: '资源浏览器页码，由过滤条件变化的 effect 自行复位（跨资源族共用，不属于某一族的文档态）'
});

export function assertDocumentResetCoverage(appSource: string): ResetCoverageReport {
  const registered = new Set(
    DOCUMENT_FAMILIES.flatMap((family) => [...DOCUMENT_STATE_SETTERS[family]])
  );

  const registeredButMissing = [...registered]
    .filter((setter) => !new RegExp(`\\b${setter}\\b`).test(appSource))
    .sort();

  // 只看 useState 解构出来的 setter：那是 App 真实持有的状态集合。
  const declared = new Set<string>();
  for (const match of appSource.matchAll(/const \[\s*\w+\s*,\s*(set\w+)\s*\]\s*=\s*useState/g)) {
    declared.add(match[1]!);
  }
  const presentButUnregistered = [...declared]
    .filter((setter) => !registered.has(setter) && !(setter in NON_DOCUMENT_SETTERS))
    .sort();

  return {
    ok: registeredButMissing.length === 0 && presentButUnregistered.length === 0,
    registeredButMissing,
    presentButUnregistered
  };
}
