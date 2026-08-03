# Skill 调查记录

日期：2026-08-03。三轮调查，最终采用 5 个职责、6 个 skill（含 1 个交叉审查），克制安装。

## 第一轮：产品与信息架构

| Skill | 来源 | 决定 | 使用阶段 | 能解决 | 不能解决 | 冲突 |
|---|---|---|---|---|---|---|
| frontend-design-principles | joshuadavidthomas/agent-skills（112 installs，早前已装） | 采用 | 方向/设计系统 | 区分 app.md 与 marketing.md；四项前置输出（domain/色彩世界/signature/拒绝的默认）；swap/squint/signature/token 四测试；反默认清单 | 不做 WCAG 细节、不做文案目录 | 无 |
| frontend-ui-engineering | addyosmani/agent-skills（19K，早前已装） | 采用 | 工程轮/状态 | WCAG 2.1 AA 清单、键盘/焦点/ARIA、空/加载/错误状态、反"AI aesthetic"表、验证清单 | 不含产品级 IA 方法 | 与 design-principles 互补不冲突 |
| lobehub/lobe-chat@product-design、@ux | 同仓库列表可见 | 拒绝 | — | — | 与 ux-audit 同仓库且职责重叠；安装越多上下文越杂 | 与 ux-audit 重复 |

## 第二轮：去 AI 味与文案

| Skill | 来源 | 决定 | 使用阶段 | 能解决 | 不能解决 | 冲突/备注 |
|---|---|---|---|---|---|---|
| de-slop | shipshitdev/library（`npx skills find ui copywriting` 线索；仓库内实际名为 de-slop，非 skills.sh 显示的 copywriter/microcopy） | 采用 | 文案治理/产品 slop 轮 | product-slop 三族目录（营销填充文案、通用 AI 措辞、未接线按钮、无样式 loading/error）；UI pass 强制"从项目自身 token 推导规则"，正合本仓库设计系统 | 其 `disable-model-invocation: true`，不能自动调用 → 实际调用方式：人工参照其 catalog 执行并记录 | 无 |
| lobehub/lobe-chat@microcopy | skills.sh 显示 1.1K | 拒绝（安装失败：仓库无此 skill，skills.sh 索引与仓库实际不符） | — | — | — | 索引失真，记录为调查证据 |
| shipshitdev/library@copywriter | skills.sh 显示 422 | 拒绝（同上，仓库无此名；同仓库 de-slop 已覆盖职责） | — | — | — | 与 de-slop 重复 |

## 第三轮：验证、审查与浏览器

| Skill | 来源 | 决定 | 使用阶段 | 能解决 | 不能解决 | 冲突/备注 |
|---|---|---|---|---|---|---|
| ux-audit | lobehub/lobe-chat（`npx skills find design review critique` 线索） | 采用（主审查） | 每轮审查 | L1 静态/L2 截图/L3 旅程分层；"结论必须来自能看到它的层"；覆盖矩阵；severity rubric；要求同时报告亮点（防 bug-report 化）；class-norm 基准（防"只磨已有路径"） | L3 需要运行环境+自动化框架，本仓库原型阶段以 L1+L2 执行 | 无 |
| frontend-design-review | microsoft/skills（153） | 采用（交叉审查） | 第一轮审查交叉 | 三支柱（frictionless/craft/trustworthy）、blocking/major/minor 分级、quick-checklist | 其 Mode 2 创意模式主张渐变网格/噪点/非常规字体等张扬美学，与工具型克制冲突 → 仅用 Mode 1 审查流，创意指南明确排除 | 与 anti-ai-design.md 的冲突点已记录并裁决 |
| serkan-ozal/browser-devtools-skills@accessibility-audit | 52 installs | 拒绝 | — | — | 依赖其 devtools MCP 工具链；AA 规则 frontend-ui-engineering 已覆盖 | 工具链不兼容 |
| hack23/riksdagsmonitor@playwright-testing | 14 | 拒绝 | — | — | 仓库无 playwright；本机验证走 Edge headless（见下） | 依赖不成立 |
| educlopez/ui-craft@critique、kazdenc/builder-skills@critique | 105/14 | 拒绝 | — | — | 与 ux-audit 职责重复，体量更小 | 重复 |

## 浏览器验证（不安装 skill）

仓库无 playwright；早前已验证 Edge headless 可执行页面 JS 并截图（`--headless=new --screenshot --virtual-time-budget`）。本轮所有 L2 证据来自该流程，截图存 `output/renovation/`（不入库）。状态变体经预览目录 `extra.js` 钩子驱动（CSP `script-src 'self'` 禁止 inline，故用同目录外置脚本）。

## 最终职责映射

- 产品/IA 与视觉方向：frontend-design-principles
- 工程/可访问性/状态：frontend-ui-engineering
- 文案与产品 slop：de-slop（catalog 参照）
- 独立审查：ux-audit（主，L1+L2）+ frontend-design-review（交叉，Mode 1）
- 浏览器验证：Edge headless 工作流（记录于 memory 与 baseline.md）
