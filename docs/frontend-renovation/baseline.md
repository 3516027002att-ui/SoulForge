# Frontend Renovation Baseline

日期：2026-08-03
分支：`agent/frontend-renovation`（自 `agent/v05-release-corpus-native-ai` @ f4ff359 创建）
对象：`apps/desktop/src/renderer/`（index.html / styles.css / app.js，零依赖静态原型，未接入 Electron IPC；历史 React renderer 已于 8ced97c 移除）

## 当前架构

- 单页三栏工作台：标题栏（frameless）/ 活动栏 / 侧栏（资源树、搜索、暂存、审计、设置五面板）/ 中央（tab + 表格、DSL、Hex 三类编辑器）/ 右侧 Agent 面板 / 状态栏 / 命令面板。
- 数据全部为 app.js 内置 mock（RESOURCE_TREE / FMG_ROWS / PARAM_ROWS / EMEVD_SOURCE / HEX_ROWS / STAGING_ITEMS / AUDIT_ENTRIES），对接时替换为 `window.soulforge` IPC。
- 本原型在今天早些时候已做过两轮优化（设计系统 token、欢迎页写入链、形状体系、AA 对比度、APG 标签页、焦点管理），本轮在其基础上做产品级改造。

## 基线回归（改动前）

- `npm run typecheck`：通过，无输出错误。
- `npm test`：全部 smoke `ok:true`（含 `test:ui-localization`、`test:desktop-security`、`test:database-utility`）。
- `npm run build`：完成；release manifest `authority: partial` 为既有诚实口径，非本次引入。
- 日志：`output/renovation/baseline-{typecheck,test,build}.log`（output/ 未跟踪，不入库）。

## 基线截图

均在 `output/renovation/`（不入库）：

| 文件 | 状态 |
|---|---|
| baseline-01-default-dark.png | 默认欢迎页 + Agent 开启（暗色） |
| baseline-02-editor-fmg-staging.png | FMG 表格 + 暂存面板 |
| baseline-03-editor-emevd.png | EMEVD DSL 编辑器 |
| baseline-04-agent-closed.png | PARAM 表格 + Agent 关闭 |
| baseline-05-small-1024.png | 1024×768 |
| baseline-06-light.png | 亮色主题 |
| baseline-07-hex-audit.png | Hex 证据视图 + 审计面板 |

## 当前视觉问题（截图证据）

1. 右侧 Agent 面板默认开启且固定 372px，与中央工作区争夺主视觉；1024×768 下中央被压缩到约 400px（baseline-05）。
2. 强调色（余火橙）权重过高：活动栏激活块、tab 文件名、主按钮大面积填充、徽章、选中树项同时着橙，眯眼测试下橙色斑点过多。
3. tab 激活态文件名着橙，不符合编辑器惯例（文件名应保持墨色，位置/顶线表达激活）。
4. 表格密度低：行高偏大、文本列窄而右侧留白大（baseline-02）。
5. 欢迎页（baseline-01）为五节点数字圆圈流程卡 + 标语 pill + 姿态句，属任务书明确禁止的"教程式数字圆圈/宣传流程"模式。
6. 状态栏"审计 4f3a…c9e1"为 mock 哈希，无真实会话语义；"暂存 3 项"与侧栏重复。

## 当前信息架构问题

1. Agent 面板以聊天气泡为主体：自我介绍长气泡常驻，模型标签"gpt-5.2 · 证据驱动"为编造具体性；没有任务/证据/变更/日志的结构。
2. 暂存审查信息不足：条目只有单行描述（"伤药葫芦 → 伤药葫芦·改"），看不到目标记录、字段、原值、新值、证据来源、风险与可逆性；审查无法基于它做出决定（baseline-02）。
3. 中央表格缺少解析状态与记录数（"已解析 342 条" nowhere），表头无类型/revision 信息。
4. 资源树无解析失败/部分解析状态；所有条目默认"正常"，只有真实工具才有的异常态缺失。
5. "最近打开"不存在；欢迎页快速打开是硬编码四个文件，不随使用变化。

## 当前文案问题

1. 内部实现名暴露在主操作面：按钮"通过 Patch Engine 提交"、Agent 气泡"typed mutation / diff / Patch Engine / 暂存区"、欢迎页"Typed Mutation / PatchIR / 三层恢复"等。术语核验结论：均为真实核心概念（packages/shared/src/patch-ir.ts、core/src/patch/patchEngine.ts、README 安全写入链），但按用户语言原则应降级到详情层。
2. 标题栏"魂游 Mod 工作台"为 slogan 式 tag；设置项"安全写入链 mutation → staging → Patch Engine"为内部链描述。
3. 仓库先例：`scripts/verify-ui-localization.mjs` 禁止在 AI 侧栏文案暴露 Provider/Files mode/Evidence index/"在 staging 中" 等内部英文术语——renderer 应遵循同一口径。

## 无法确认的产品假设（记录后继续）

1. 原型未来接入 IPC 的 DTO 形状以 `packages/shared/src/editor-protocol.ts`、`apps/desktop/src/preload/index.ts` 为准；本轮 mock 层保持可替换，不假设额外字段。
2. "最近打开"持久化在原型阶段用 localStorage；真实产品应由工作区数据库提供（交接书 SQLite 任务/恢复点基础已存在）。
3. Agent 面板任务结构参照 `packages/core/src/ai/assistantSession.ts` 与 `evidencePackBuilder.ts` 的真实能力（证据包、patch proposal、dry-run），不编造能力。

## 后续不能破坏的功能

- 双主题、命令面板（Ctrl K）、侧栏/Agent 折叠（Ctrl B/J）、侧栏拖宽、tab 键盘导航与 APG 语义、AA 对比度标尺（scripts/_tmp_contrast.mjs）、reduced-motion、CSP（script-src 'self'，禁止 inline script）、`.gitignore` 否定例外 `!apps/desktop/src/renderer/app.js`。
- 仓库级回归：typecheck / test / build 保持基线全绿。
