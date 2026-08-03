# SoulForge 产品模型（基于仓库证据）

证据来源：README.md、docs/V0_5_IMPLEMENTATION_HANDOFF.md、package.json scripts、
packages/shared/src/{patch-ir,editor-protocol,writer-contract}.ts、
packages/core/src/{patch/patchEngine,editing/editorCapabilityContract,editing/scriptContainerEvidence,ai/toolRegistry,ai/evidencePackBuilder}.ts、
scripts/verify-ui-localization.mjs。

## 1 核心对象

| 对象 | 数据来源 | 对用户的意义 | 可执行动作 | 状态 | 关系 | 主界面位置 |
|---|---|---|---|---|---|---|
| 工作区 Workspace | main IPC / SQLite（workspaceId；overlay 可写、base 只读） | 当前 Mod 工作的容器与边界 | 打开、索引 | 已索引 N 项资源 | 含全部资源 | 状态栏、标题 |
| 游戏 Game | 工作区配置（V0.5 = Sekiro） | 决定格式家族与语料 | — | 固定 | 工作区属性 | 工作区标签 |
| 资源容器/文件 | VFS 索引 + Bridge 分页枚举（listContainerChildrenPage） | 浏览与修改的入口 | 打开、只读查看 | 已解析 / 部分解析 / 解析失败 / 延期只读预览 | 含记录 | 资源树 |
| 记录 Record | readFmgPage / readParamPage / readEmevdDocument（分页） | 修改的最小可见单元 | 编辑、过滤、定位 | 未修改 / 已修改未暂存 | 属于资源；含字段 | 中央表格 / DSL |
| 字段 Field | Smithbox 固定 ParamDef metadata（135/138 严格匹配） | 一次修改的目标 | 字段级 mutation（applyParamFieldMutation） | 可编辑 / 只读 / metadata 缺失 fail-closed | 属于记录 | 表格单元格 |
| 证据 Evidence | renderer-safe 投影（sourceUri、source revision、diagnostics；无绝对路径）；Hex 只读视图 | 判断"改得对不对"的依据 | 查看 | 只读 | 支撑变更 | Hex 面板、Agent 证据列表 |
| 变更（内部：typed mutation / PatchIR） | editor-protocol / createPatchProposal / dryRunPatchProposal | 一次待审查的修改 | 审查、批准、拒绝 | 待审查 / 已批准入暂存 / 已拒绝 | 指向记录+字段，含原值/新值 | 审查卡（用户语言"变更"，内部名在详情行） |
| 暂存区 Staging | Bridge staging | 写入前的最后集合 | 移除单项、放弃全部、提交 | N 项待提交 / 空 | 含已批准变更 | 侧栏面板 + 活动栏计数 |
| 备份与恢复点 | WorkspaceTransaction / journal（写入前自动创建） | "写坏了能回去" | 回滚 | 已创建备份 / 可回滚 | 每次提交伴随 | 审查卡可逆性行、审计 |
| 提交（写入） | Patch Engine commit（hash 前置条件、原子替换、重读） | 变更真正落到 Mod | 提交 | 写入成功 / 写入失败（原因） | 产生审计条目 | 暂存主按钮、toast、审计 |
| 审计条目 | operation log | 历史与回滚入口 | 回滚到此版本 | 可回滚 / 已回滚 / 回滚失败（原因） | 属于提交 | 审计面板 |
| Agent 任务 | assistantSession / toolRegistry（证据包、patch proposal、dry-run） | 协助定位与生成变更的工作单元 | 发起、补充指令、批准/拒绝产物 | 空闲 / 执行中 / 待审批 / 失败（原因） | 产出证据与变更 | 右侧任务面板 |
| 延期预览编辑器 | DEFERRED_PREVIEW_EDITOR_KINDS + releaseWriteEnabled=false（三层失败关闭） | 能力边界透明 | 只读查看 | 只读预览（V0.6） | MSB/TAE/ESD/FLVER | 树标记 + 只读 pill |

内部实现名裁决：PatchIR / typed mutation / Patch Engine / 三层回滚均为真实核心概念（patch-ir.ts 450 处引用、patchEngine.ts、README 安全写入链），但主界面用用户语言（变更/差异/批准/写入/备份/回滚），内部名仅出现在审查卡详情行与设置高级信息中。先例：verify-ui-localization.mjs 禁止 AI 侧栏暴露内部英文术语。

## 2 核心用户任务（目标 + 完成条件）

1. 浏览与定位资源：树/搜索 → 打开记录。完成条件：目标记录在中央可见且选中。
2. 修改字段或文本：编辑单元格 → 行标记未暂存 → 生成变更。完成条件：变更进入暂存或审查流。
3. 让 Agent 定位并生成变更：描述目标 → 证据列表 → 变更卡。完成条件：用户批准或拒绝，产物状态明确。
4. 审查变更：看目标记录/字段、原值、新值、证据来源、风险、可逆性。完成条件：批准入暂存或拒绝。
5. 提交写入：暂存提交 → 自动备份 → 原子写入 → 重读。完成条件：成功 toast + 审计条目；失败时给出原因与重试路径。
6. 回滚：审计条目 → 回滚到此版本。完成条件：状态恢复且重读验证；失败给出原因。

## 3 风险模型与确认层级

| 操作 | 类别 | 可逆性 | 确认层级 | 视觉 |
|---|---|---|---|---|
| 浏览/搜索/Hex 查看 | 只读 | — | 无 | 无强调 |
| 字段编辑、批准入暂存 | 改暂存区 | 可撤销（移除/放弃） | 无对话框，状态可见 | warn（未暂存/待审查） |
| 放弃全部 | 改暂存区（批量丢失） | 不可恢复已移除项 | 需明确范围文案 | danger 文本按钮 |
| 提交写入 | 改文件 | 可回滚（自动备份） | 单主按钮 + 明确结果反馈 | 主按钮唯一强调 |
| 回滚 | 改文件 | 可再次回滚 | 按钮即动作，结果入审计 | warn→ok |
| 延期编辑器写入 | 不存在 | 写路径三层关闭 | — | 只读 pill（danger 文本） |

强调色只来自风险与状态：ember=当前焦点/唯一主操作；warn=未保存/待审查/回滚；ok=成功/可回滚；danger=拒绝/放弃/写路径关闭/失败。
