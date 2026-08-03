# Frontend Renovation 最终报告（生产化轮定稿）

分支：`agent/frontend-renovation`（自 f4ff359 创建）。日期：2026-08-03。
两轮工作：第一轮=原型界面反 AI 改造（方向/设计/文案/三轮审查）；第二轮=生产化（恢复正式 React/TS renderer 构建入口、真实 IPC 接线、变更状态机、Playwright e2e、CI 全绿、产物留存）。

## 1 最终结果概述

- 方向 A（资源优先工作台）落地为**正式 renderer**：从 git 历史（8ced97c~1）恢复模块化 React/TypeScript renderer 与 electron-vite 构建入口；Electron 开发版与安装包重新加载真实界面。
- 955 行全局 app.js 原型移出生产路径（064ee54 删除），其设计成果（状态机语义、文案原则、反 AI 规范）移植进正式 renderer。
- 新增显式变更状态机：候选（draft）→ 批准（staged）→ 校验（validating）→ 写入（writing）→ written/failed，含拒绝、撤回到候选、移除、失败重批；文本/FMG/PARAM 行/PARAM 字段四条写路径全部改道。
- 生产路径零 mock：DEMO_* 常量、demo-job、demo-v1、假 URI 全部移除，空态为真实空态；fixture 仅存在于 e2e（微小、合法构造、明确标记）。
- Playwright + Electron e2e 3/3 绿（本机与 CI 均通过）；windows-ci 全量门通过（见 §6 CI 结论）。
- 产物留存：入库截图 docs/frontend-renovation/shots/；CI 上传 renderer-e2e-report artifact。

## 2 修改前的问题

第一轮（原型）：宣传流程卡、聊天式 Agent、内部术语外露、强调色过载、无真实状态。
第二轮（生产化前）：
- renderer 构建入口缺失（electron.vite.config.ts 与 React 源码被整体删除），Electron dev/安装包无界面；
- 原型 app.js 为 955 行全局脚本 + 全部 mock 数据，不能成为产品核心；
- 无 DOM/端到端自动化测试；CI 无 renderer 验证；
- CI 治理门禁在 shallow clone 下恒失败（GATE_FRESHNESS_UNVERIFIABLE，环境性，见 §6）。

## 3 使用的 Skills

| Skill | 阶段 | 作用 |
|---|---|---|
| frontend-design-principles | 方向/设计系统 | app.md 工具型路由、四测试、反默认清单 |
| frontend-ui-engineering | 工程轮 | WCAG AA、键盘/焦点、状态要求、反 AI aesthetic 表 |
| frontend-design-review | 交叉审查 | 三支柱、severity 分级（仅 Mode 1） |
| ux-audit | 独立审查 | L1/L2 分层证据法 |
| de-slop | 文案 | product-slop 三族 catalog |

详见 skill-research.md。

## 4 主要结构变化

- 构建入口：恢复 electron.vite.config.ts / main.tsx / App.tsx / 14 个编辑器面板 / scene / utils；main/index.ts 生产 loadFile(out/renderer)、开发 ELECTRON_RENDERER_URL。
- 状态机：新增 `src/renderer/src/staging/changeControl.ts`（纯逻辑、可单测：转移表 TRANSITIONS、validateChange、commitAll 顺序执行）+ `ChangeQueuePanel.tsx`（审查队列 UI，无 pill，状态文本+边框色双通道）。
- 写路径改道：App.tsx 文本「生成变更候选」、FMG onMutation、PARAM 行 onMutation、ParamDefPanel onApplyFieldMutation 全部 propose→队列；applyStagedChange 按 kind 调 IPC（保留 hash 前置条件与重读）。
- 脏追踪/关闭确认：editDirty + draft/staged 触发 beforeunload；模式切换 confirm；「还原」恢复 lastSavedText；队列「撤回到候选」=撤销。
- 字段校验：validateChange 对 PARAM 字段按 definition 数值类型校验、FMG id/文本校验、PARAM 行载荷校验；ParamDefPanel 原有 definitionCanCommit 保留。
- 容错加固：analyzeWorkspace 结果缺字段不再整体崩溃（`?.` + 默认值）。
- 品牌化：调色板 token 化（forge/ink/ember/line 19 组 var，105 处替换）；count-chip/base-pill/provider-pill/mode-badge 去胶囊改纯文本；标语收敛为三条真实约束。

## 5 去 AI 味变化（具体）

删除：五节点数字圆圈流程卡、标语 pill、Agent 自我介绍气泡、gpt-5.2 标签、DEMO_* 全部演示数据、demo-job-1、demo-v1、file://param/demo.param、"继续工作"泛化标题、胶囊状态徽章。
变为面板/列表：欢迎摘要→真实统计+待审查+最近打开；聊天→任务/证据/日志/审查卡；状态徽章→纯文本。
真实状态替代概念：写入中…/写入失败（ORIGINAL_CHANGED_DURING_STAGING 诊断+可重批）/解析失败（diagnostic+重试+Hex 证据）/部分解析（512/518）/空态文案。

## 6 测试与 CI

本地：
- `npm run typecheck` / `npm test` / `npm run build`：全绿（final2-*.log）。
- `npm run test:renderer-playwright -w @soulforge/desktop`：3/3（空工作区无演示数据；状态机全流程写入并重读验证；失败诊断+重批+移除）。
- 对比度审计 scripts/_tmp_contrast.mjs：AA 标尺无回归。

CI（windows-ci，run 30824742532，head 7101685）：
- 步骤 38「Renderer e2e (Playwright + Electron fixture)」success；artifact「renderer-e2e-report」上传 success。
- 该 run 最终 failure，唯一失败步骤为「Release scope proposal / handoff governance」，诊断码 GATE_FRESHNESS_UNVERIFIABLE：门禁用 `git merge-base --is-ancestor` 验证交接书 Evidence 锚点祖先关系（scripts/governance/freshnessContext.mjs:61），而 actions/checkout 默认 shallow clone 使祖先不可见 → fail-closed。本地全仓库与基线/HEAD worktree 均通过，证明为 CI 环境性、非本次代码引入。
- 修复一：checkout fetch-depth 0（1084997）。
- 1084997 仍失败于同一 step，根因转为负例 fixture 过期：`gate-pass-masquerade` 用 REL-A 伪装 passed，但 REL-A 早已推进为 passed，伪装与现状一致不再构成负例 → 改以 §18.3 为 open 的 REL-C 作负例目标，保留「伪装 passed 必须被拒」意图（48d7b4b）。
- 随后 handoff-integrity 暴露 §13.4 validation-unfrozen 清单与切片 lifecycle 失同步（3 条 completed 切片仍列、2 条 ready 切片未列）→ 同步清单并重生成投影（48d7b4b）。
- 剩余 GATE_EVIDENCE_STALE / GATE_DEFERRAL_EVIDENCE_STALE（REL-SCOPE/REL-E/REL-I）：证据锚点停在 renderer 移除提交，renderer 恢复即主题域变化。按门禁自身指派「工程侧重跑验证并重封存」：实跑 typecheck/test/renderer-playwright(3/3)/release-editor-acceptance/desktop-live-editor-contract/desktop-ipc-contract/desktop-security/ui-localization 全绿后，`gov seal EV-REL-SCOPE-20260803-RENDERER-RESTORE` 挂 REL-SCOPE/REL-E/REL-I，追加后门禁 passed（2831f69 → 719e7d6）。
- **最终全绿：run 30834501948（head 719e7d6）conclusion=success**，全部 step 绿，含 Renderer e2e 与 artifact 上传。
- 基线/本次区分：治理门失败在基线提交即存在（负例过期、清单失同步、shallow 环境）；本次零新增失败，修复三处基线问题，并完成 renderer 恢复应做的工程侧重封存。

## 7 截图清单

入库：docs/frontend-renovation/shots/final-01-empty-workspace.png、final-02-change-written.png（capture-shots.mjs 生成）。
本机（不入库）：output/renovation/ baseline-01..07、r1-01..03、r2-01..02、r3-01..05、pw-fail3.png。
CI artifact：renderer-e2e-report（playwright-report + test-results）。

## 8 提交记录

| 提交 | 职责 |
|---|---|
| fb8da26 | docs: 基线记录 |
| d2b5022 | docs: 产品模型与设计方向 |
| 65129df | chore: gitignore 否定规则跟踪 app.js |
| 5cc10ad | refactor(ui): 工作区摘要+任务化 Agent |
| a84788c / e0eff05 | docs: 第一/二轮 anti-AI 审查 |
| a2bf265 | style(ui): 密度/强调预算/状态标记 |
| a17ec67 | feat(ui): 真实加载/错误/部分/失败状态 |
| 97a8f48 | refactor(copy): 移除合成术语 |
| 0da1864 | docs: 第一轮最终报告 |
| 064ee54 | feat(ui): 恢复 React renderer 入口+状态机接线+移除演示 fixture |
| d8185a7 | chore(deps): lockfile 同步 |
| b48d48a | test(ui): Playwright e2e 状态机套件 |
| 06666ff | chore: ignore playwright 临时产物 |
| e787985 | style(ui): token 化+去胶囊+标语收敛 |
| abb93f8 | docs: 入库最终截图 |
| 7101685 | ci: 接 renderer e2e+artifact 上传 |
| 1084997 | ci: full-depth checkout 修复治理门禁 |
| 291c9da | chore(gov): 提交待提交治理更新 |
| 48d7b4b | chore(gov): §13.4 清单同步+负例 fixture 改 REL-C |
| 2831f69 | chore(ui): 延期编辑器文案补提交+ignore |
| 719e7d6 | chore(gov): seal EV-REL-SCOPE-20260803-RENDERER-RESTORE |
| （本报告） | docs: 生产化轮最终报告 |

## 9 尚未解决的问题（按优先级）

1. EMEVD/MSB/容器替换等写路径仍为直连（未入状态机）；如需统一审查，按 staging 模块模式扩展。
2. 状态栏索引计数、审查卡影响范围接线后须来自 VFS/PatchIR 真实计算。
3. 「审计与回滚」面板名是否改「写入历史」待产品确认。
4. 亮色主题未移植到正式 renderer（原型期有过，恢复版仅暗色）。
5. L3 动态审查（CLS/INP/旅程）未执行。

## 10 后续建议

- 接线真实工作区后，用同一 Playwright 框架增加「真实语料只读巡检」用例（private gate 之外）。
- 为 changeControl 补纯逻辑单测（node:test 即可，无 DOM 依赖）。
- 亮色主题以 token 层移植（var 已就位）。
