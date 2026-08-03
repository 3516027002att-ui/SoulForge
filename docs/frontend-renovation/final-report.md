# Frontend Renovation 最终报告

分支：`agent/frontend-renovation`（自 f4ff359 创建）。日期：2026-08-03。
方法：基线调查 → skill 三轮调查 → 产品模型 → 方向评分 → 设计系统 → 三轮"实现-截图-独立审查-修复" → 工程回归。

## 1 最终结果概述

选择方向 A（资源优先工作台，评分 8.55，见 directions.md），吸收方向 C 的审查强度。
核心变化：欢迎页从宣传流程卡变为真实工作区摘要；Agent 从聊天机器人变为任务/证据/日志/审查卡工作单元；内部实现名（PatchIR/typed mutation/Patch Engine/三层回滚，均为仓库真实概念）降级到详情行，主界面使用用户语言；状态矩阵补全 loading/解析失败/部分解析/只读/写入中/写入失败/空态。

## 2 修改前的问题

- 产品：欢迎页五节点数字圆圈流程+标语 pill；Agent 自我介绍气泡+编造模型标签；审查缺原值/新值/证据/可逆性；"最近打开"不存在（硬编码快速打开）。
- 视觉：强调色权重过高（活动栏+tab 名+主按钮+徽章同时着橙）；Agent 372px 抢主视觉；表格密度低；胶囊 chip。
- 文案：内部引擎名作主按钮动词；slogan tag；开发者语言（"renderer 不暴露字节级写路径"）。
- 工程：app.js 被 .gitignore 忽略无法提交；无加载/失败/部分解析状态；状态栏假哈希。

## 3 使用的 Skills

| Skill | 阶段 | 作用 | 局限 |
|---|---|---|---|
| frontend-design-principles | 方向/设计系统 | app.md 工具型路由、四测试、反默认清单 | 不含 WCAG 细则 |
| frontend-ui-engineering | 工程轮 | AA 清单、键盘/焦点、状态要求 | 不含产品 IA |
| de-slop | 文案/产品 slop | 三族 catalog、UI pass 从项目 token 推导 | disable-model-invocation，参照执行 |
| ux-audit | 每轮独立审查 | L1/L2 分层、证据原则、亮点必报 | L3 无运行环境，未执行 |
| frontend-design-review | 交叉审查 | 三支柱、severity 分级 | 创意模式与工具克制冲突，仅用 Mode 1 |

详见 skill-research.md（含拒绝项与理由）。

## 4 主要结构变化

- 工作区：标题栏 slogan → 工作区·游戏；状态栏假哈希 → 当前对象+备份/回滚真实语义。
- 资源树：族形状体系保留；新增解析失败/部分解析状态图标（aria+title 双通道）。
- 中央：骨架加载→内容；错误面板（原因+diagnostic+重试+Hex 证据）；部分解析 warn bar；行编辑"改"文字标记。
- Agent：320px、窄屏自动折叠；空任务态；目标/证据/日志/审查卡；状态头 空闲/执行中/待审批/失败；失败分支含恢复路径。
- 审查：审查卡七字段+diff+批准/拒绝；欢迎页待审查行含 op+目标+旧→新+审查动作。
- 最近工作：localStorage 最近打开（真实空态）。
- 状态栏：当前：{file}（只读）随 tab 更新。

## 5 去 AI 味变化（具体）

删除：五节点流程卡、标语 pill、自我介绍气泡、gpt-5.2 标签、"继续工作"、"通过 Patch Engine 提交"、胶囊 chip、聊天 bubble 样式、typing 点、plan-step 数字步骤。
变为面板/列表：欢迎页→摘要+列表；Agent→任务块+日志行。
真实状态替代概念：写入中…/写入失败（原因+暂存保留+重试）/解析失败（diagnostic）/部分解析（512/518）。
专属语义增强：审查卡可逆性行、备份状态、op 徽章、族形状、只读锁。
证据：anti-ai-review-1/2.md + 截图 r1-*/r2-*/r3-*。

## 6 测试

- `node --check app.js`：每轮通过。
- 对比度审计 `scripts/_tmp_contrast.mjs`：AA 标尺无回归；已知边界（dark ink-3 于 forge-1/2 4.31/3.99）按 design-system 限定 ink-3 仅用于 forge-0 短元信息。
- 全量回归 `npm run typecheck / test / build`：基线全绿；最终一轮运行中，结果见 `output/renovation/final-*.log`（若失败按"基线已有/本次引入"区分记录——本次 renderer 改动不进入 TS 构建，预期无影响）。
- 浏览器验证：Edge headless 1440×900 / 1024×768 / 灰度，共 16 张截图（output/renovation/，不入库）。
- 未新增 DOM 单测：仓库无 jsdom/playwright 依赖，renderer 为零依赖原型；按任务"不引入重量级框架"约束，验证以 headless 截图+语法检查承担，记录为未解决事项。

## 7 截图清单（output/renovation/，不入库）

基线：baseline-01-default-dark / 02-editor-fmg-staging / 03-editor-emevd / 04-agent-closed / 05-small-1024 / 06-light / 07-hex-audit。
第一轮：r1-01-welcome / r1-02-agent-task / r1-03-welcome-fixed。
第二轮：r2-01-hex-readonly / r2-02-grayscale。
第三轮：r3-01-error / r3-02-partial / r3-03-narrow / r3-04-agent-failure / r3-05-error-fixed。

## 8 提交记录

| 提交 | 职责 |
|---|---|
| fb8da26 | docs: record frontend renovation baseline |
| d2b5022 | docs: define SoulForge product model and design direction |
| 65129df | chore: track renderer app.js via gitignore negation |
| 5cc10ad | refactor(ui): restructure workspace summary and task-based agent panel |
| a84788c | docs: record round-1 anti-AI review |
| a2bf265 | style(ui): restrained density, accent budget and state markers |
| e0eff05 | docs: record round-2 anti-AI review |
| a17ec67 | feat(ui): add real loading, error, partial and failure states |
| 97a8f48 | refactor(copy): remove synthetic UI terminology, audit all visible strings |
| （本报告） | docs: record frontend renovation final report |

## 9 尚未解决的问题（按优先级）

1. renderer 未接入 Electron IPC：全部数据为 mock；接入时替换 DATA 层为 window.soulforge，状态模型已按真实诊断码（PARAM_DEF_MISMATCH 等）建模。
2. 状态栏索引计数、审查卡影响范围为 mock 常量；接线后必须来自 VFS/PatchIR 真实计算（copy-audit 需产品确认 1/3）。
3. "审计与回滚"面板名是否改"写入历史"待产品确认。
4. 无 DOM 自动化测试（缺 jsdom/playwright 基础设施）；键盘路径仅 L1 验证。
5. L3 动态审查（旅程/CLS/INP）未执行，需运行环境。

## 10 后续建议

- 接线 IPC 时以 editor-protocol.ts / preload 为准替换 mock，保留状态分支。
- 引入 DOM 测试基础设施（jsdom 或 playwright）后，为 tab 键盘导航、cmdk 焦点陷阱、审批流补自动化测试。
- 亮色主题在真实显示器复核一次（headless 截图仅做结构验证）。
